import fs from 'node:fs'

/* ── the miniature React again (the restart emptied /tmp) ── */

const store = {}
const fakeDoc = {
  defaultView: {
    innerWidth: 1400, innerHeight: 900,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
    },
  },
  _listeners: {},
  addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f) },
  removeEventListener(t, f) { this._listeners[t] = (this._listeners[t] || []).filter((x) => x !== f) },
  fire(t, e) { (this._listeners[t] || []).slice().forEach((f) => f(e)) },
}
const INSIDE = { nodeType: 1, name: 'inside-panel' }
const IN_CARD = { nodeType: 1, name: 'inside-switcher-card' }
const IN_CHIP = { nodeType: 1, name: 'inside-composer-chip' }
const OUTSIDE = { nodeType: 1, name: 'outside' }
const fakeNode = { ownerDocument: fakeDoc, offsetWidth: 900, offsetHeight: 600, contains: () => false }
/* 每个容器一个独立节点，才能区分「点在面板里」和「点在浮层卡片里」 */
const panelNodeObj = { ownerDocument: fakeDoc, offsetWidth: 900, offsetHeight: 600, contains: (t) => t === INSIDE || t === IN_CARD }
const cardNodeObj = { ownerDocument: fakeDoc, offsetWidth: 340, offsetHeight: 300, contains: (t) => t === IN_CARD }
const chipNodeObj = { ownerDocument: fakeDoc, contains: (t) => t === IN_CHIP }
const timers = []
const fibers = new Map()
let currentFiber = null
let dirty = false

function makeElement(type, props, ...children) {
  const flat = []
  const push = (c) => {
    if (c === null || c === undefined || c === false || c === true) return
    if (Array.isArray(c)) { c.forEach(push); return }
    flat.push(c)
  }
  children.forEach(push)
  const merged = Object.assign({}, props)
  merged.children = flat
  return { type: type, key: merged.key === undefined ? null : merged.key, props: merged }
}
/* memo：真实 React 会跳过 props 没变的子树，基准与断言都应该能看到这件事 */
const memoCache = new Map()
let memoSkips = 0
function shallowSame(a, b) {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) { if (k === 'children') continue; if (a[k] !== b[k]) return false }
  return true
}
const React = {
  createElement: makeElement,
  memo(component) { return { $$memo: true, render: component } },
  /* useCallback 按依赖记忆，和真实 React 一样：否则 memo 永远命中不了，
     基准和断言也就看不到「行级记忆」到底有没有生效 */
  useCallback(fn, deps) {
    const fiber = currentFiber
    const index = fiber.cursor
    fiber.cursor += 1
    const previous = fiber.memos === undefined ? undefined : fiber.memos[index]
    if (previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps)
      && deps.length === previous.deps.length && deps.every((d, i) => d === previous.deps[i])) return previous.fn
    if (fiber.memos === undefined) fiber.memos = []
    fiber.memos[index] = { deps: deps, fn: fn }
    return fn
  },
  useMemo(factory) { return factory() },
  useState(initial) {
    const fiber = currentFiber
    const index = fiber.cursor
    fiber.cursor += 1
    if (fiber.hooks.length <= index) fiber.hooks[index] = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      const value = typeof next === 'function' ? next(fiber.hooks[index]) : next
      if (fiber.hooks[index] !== value) { fiber.hooks[index] = value; dirty = true }
    }
    return [fiber.hooks[index], setter]
  },
  useEffect(effect, deps) {
    const fiber = currentFiber
    const index = fiber.cursor
    fiber.cursor += 1
    const previous = fiber.effects[index]
    const same = previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps)
      && deps.length === previous.deps.length && deps.every((d, i) => d === previous.deps[i])
    if (same) return
    if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
    fiber.effects[index] = { deps: deps, cleanup: undefined }
    fiber.pending.push(() => {
      const cleanup = effect()
      fiber.effects[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined
    })
  },
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.props === undefined) return ''
  return textOf(node.props.children)
}
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((c) => walk(c, visit)); return }
  visit(node)
  const kids = node.props !== undefined && Array.isArray(node.props.children) ? node.props.children : []
  kids.forEach((c) => walk(c, visit))
}
function collect(node, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((c) => collect(c, out)); return out }
  out.push(node)
  const k = node.props && node.props.children
  if (Array.isArray(k)) k.forEach((c) => collect(c, out))
  return out
}
const buttons = (t) => collect(t).filter((n) => n.type === 'button')
const inputs = (t) => collect(t).filter((n) => n.type === 'input')
const byClass = (t, s) => collect(t).filter((n) => typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(s) >= 0)
const rows = (t) => byClass(t, 'dsh-git-bs-row')
/* 操作行与分支行共用 .dsh-git-bs-row，取分支行时要排掉操作行 */
const branchRows = (t) => rows(t).filter((r) => String(r.props.className).indexOf('dsh-git-bs-action') < 0)
const rowWith = (t, label) => branchRows(t).find((r) => textOf(r).indexOf(label) >= 0)
const groups = (t) => byClass(t, 'dsh-git-bs-group')

function renderRoot(element, label) {
  const pending = []
  const render = (node, path) => {
    if (node === null || node === undefined) return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((c, i) => render(c, path + '.' + i))
    const type = node.type
    if (type != null && typeof type === 'object' && type.$$memo === true) {
      const memoKey = path + '#' + (type.render.name || 'memo')
      const previous = memoCache.get(memoKey)
      if (previous !== undefined && shallowSame(previous.props, node.props)) {
        memoSkips += 1
        return previous.tree
      }
      const tree = render({ type: type.render, props: node.props, key: node.key, props2: null }, path)
      memoCache.set(memoKey, { props: node.props, tree: tree })
      return tree
    }
    if (typeof type !== 'function') {
      const kids = (node.props.children || []).map((c, i) => render(c, path + '/' + i))
      const out = { type: type, key: node.key, props: Object.assign({}, node.props, { children: kids }) }
      if (typeof node.props.ref === 'function') {
        const cls = String(node.props.className || '')
        let target = fakeNode
        if (cls.indexOf('dsh-git-switch') >= 0) target = cardNodeObj
        else if (cls.indexOf('dsh-git-pop') >= 0) target = panelNodeObj
        else if (cls.indexOf('dsh-git-chip') >= 0) target = chipNodeObj
        if (target !== fakeNode && !globalThis.__seen) globalThis.__seen = new Set()
        if (target !== fakeNode && !globalThis.__seen.has(cls)) { globalThis.__seen.add(cls); console.log('  [ref→' + (target === panelNodeObj ? 'panel' : target === cardNodeObj ? 'card' : 'chip') + '] className=' + JSON.stringify(cls)) }
        node.props.ref(target)
      }
      return out
    }
    const fiberKey = path + '#' + (type.name || 'anon') + '#' + (node.key === null ? '' : node.key)
    let fiber = fibers.get(fiberKey)
    if (fiber === undefined) { fiber = { hooks: [], memos: [], effects: [], cursor: 0, pending: [] }; fibers.set(fiberKey, fiber) }
    fiber.cursor = 0
    fiber.pending = []
    const previous = currentFiber
    currentFiber = fiber
    let out
    try { out = type(node.props) } finally { currentFiber = previous }
    pending.push(fiber)
    return render(out, path + '/' + (type.name || 'anon'))
  }
  const tree = render(element, label)
  for (const fiber of pending) for (const job of fiber.pending.splice(0)) job()
  return tree
}
async function renderUntilStable(element, label) {
  let tree = null
  for (let i = 0; i < 40; i += 1) {
    dirty = false
    tree = renderRoot(element, label)
    await new Promise((r) => setTimeout(r, 0))
    if (!dirty) return tree
  }
  throw new Error('render did not settle for ' + label)
}

/* ── mocks ── */

const calls = []
const nowSec = Math.floor(Date.now() / 1000)
const OK_PANEL = { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 1, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] }
const branchesReply = {
  ok: true, repo: '/tmp/ws', current: 'main', previous: 'solo',
  branches: [
    { name: 'main', current: true, committedAt: nowSec - 5, upstream: 'origin/main', track: '=', ahead: 2, behind: 1, head: 'aaa', subject: 'tip main' },
    { name: 'solo', current: false, committedAt: nowSec - 3600, upstream: '', track: '', ahead: 0, behind: 0, head: 'bbb', subject: 'solo tip' },
    { name: 'feature/one', current: false, committedAt: nowSec - 90000, upstream: 'origin/feature/one', track: '>', ahead: 1, behind: 0, head: 'ccc', subject: 'one tip' },
    { name: 'zeta', current: false, committedAt: nowSec - 9000, upstream: '', track: '', ahead: 0, behind: 0, head: 'ddd', subject: 'z' },
  ],
  remotes: [{ name: 'remote-only', remote: 'origin', ref: 'origin/remote-only', committedAt: nowSec - 500, head: 'eee', subject: 'r' }],
}
let checkoutReply = { ok: true, repo: '/tmp/ws', stashed: false, dirty: 0, popConflict: false, stdout: '', stderr: '', exitCode: 0 }
const host = {
  call(method, args) {
    calls.push({ method, args })
    if (method === 'git/panel') return Promise.resolve(OK_PANEL)
    if (method === 'git/branches') return Promise.resolve(branchesReply)
    if (method === 'git/refs') return Promise.resolve({ ok: true, repo: '/tmp/ws', current: ['main'], local: [{ segments: ['main'], data: 'main' }, { segments: ['feature'], data: 'feature' }, { segments: ['stable'], data: 'stable' }], remote: [] })
    if (method === 'git/authors') return Promise.resolve({
      ok: true, repo: '/tmp/ws',
      authors: [
        { name: 'mays', email: 'mays@example.com', count: 12 },
        { name: 'jiangzx', email: 'jiangzx@example.com', count: 30 },
      ],
    })
    /* the graph echoes the ref it was asked for, so the scope is visible in the
       reply as well as in the request the test records */
    if (method === 'git/graph') return Promise.resolve({ ok: true, repo: '/tmp/ws', ref: (args && args.ref) || (args && args.allRefs === true ? '' : 'main'), currentBranch: 'main', commits: graphCommits, rows: [], lanes: 1 })
    if (method === 'git/watch') return Promise.resolve({ ok: true, repo: '/tmp/ws', sig: 'SIG' })
    if (method === 'git/commit-detail') return Promise.resolve({ ok: true, repo: '/tmp/ws', hash: (args && args.hash) || 'a', subject: 'detail subject', body: '', author: 'mays', date: '2026-09-16', files: [], branches: [] })
    if (method === 'git/flush') return Promise.resolve({ ok: true })
    if (method === 'git/config') return Promise.resolve({ ok: true, path: '/home/u/.dsh/dsh-git-idea.json', config: { initBranch: 'main', cherryPickRecord: false } })
    if (method === 'git/checkout') return Promise.resolve(checkoutReply)
    /* 生效仓库的后端账：中性应答「这个工作区没记过」（repo 空串）。不能落进下面的
       兜底 —— 那份应答带着 repo:'/tmp/ws'，收养路径（adoptHostRepo）会把它当成
       别处记下的账接回本页，此后每个请求都多出 repo 字段，与这些套件「单仓库不带
       repo」的既有口径整批打架。 */
    if (method === 'git/repo-applied') return Promise.resolve({ ok: true, workspace: '/tmp/ws', repo: '' })
    if (method === 'git/repo-applied-save') return Promise.resolve({ ok: true, workspace: '/tmp/ws', repo: '', unchanged: true })
    return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
  },
}
/* the history the mock hands back; a test may swap it to simulate a re-read */
let graphCommits = [
  { hash: 'aaa111', subject: 'tip commit', author: 'mays', date: '2026-09-16', committedAt: nowSec - 60, refs: ['HEAD -> dev'] },
  { hash: 'bbb222', subject: 'second commit', author: 'mays', date: '2026-09-15', committedAt: nowSec - 3600, refs: [] },
  { hash: 'ccc333', subject: 'third commit', author: 'jiangzx', date: '2026-09-14', committedAt: nowSec - 7200, refs: [] },
]
/* ── 假 liveBus（真包由 client-pre.js 提供）──
   98-register.js 的推送订阅在插件加载时就发生，所以它必须在加载前就位：watcher 的
   「变化核对」已推送化（再无定时器轮询），测试用 livePush(...) 模拟宿主的推送
   （repo-changed / session-complete / cmdlog-start/exit / live-open）。 */
const liveSubs = []
globalThis.liveBus = {
  open() {},
  close() {},
  subscribe(cb) { liveSubs.push(cb); return function () { const i = liveSubs.indexOf(cb); if (i >= 0) liveSubs.splice(i, 1) } },
}
const livePush = function (message) { liveSubs.slice().forEach(function (cb) { cb(message) }) }
const registered = []
const slots = { inject: (k, cb) => cb(), register: (o, c) => { registered.push({ options: o, component: c }); return () => {} } }
const ctx = {
  get(n) {
    if (n === 'slots') return slots
    if (n === 'timer') return {
      interval(cb, delay) { const t = { kind: 'interval', cb, delay, dead: false }; timers.push(t); return () => { t.dead = true } },
      timeout(cb, delay) { const t = { kind: 'timeout', cb, delay, dead: false }; timers.push(t); return () => { t.dead = true } },
    }
    return undefined
  },
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const styles = { insert: () => () => {} }
new Function('ctx', 'React', 'host', 'styles', 'console', fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8'))(
  ctx, React, host, styles, console).apply(ctx)

const chip = registered.find((r) => r.options.id === 'dsh-git-idea-chip').component
const popover = registered.find((r) => r.options.id === 'dsh-git-idea-panel').component

const wait = (ms) => new Promise((r) => setTimeout(r, ms || 10))
const popTree = (l) => renderUntilStable(makeElement(popover, { sessionId: 's-1' }), l || 'pop')
const chipTree = (l) => renderUntilStable(makeElement(chip, { sessionId: 's-1' }), l || 'chip')
async function settle(l) { let t = null; for (let i = 0; i < 4; i += 1) { t = await popTree(l); await wait(10) } return t }
async function openPanel() {
  let t = await chipTree()
  if (t.props.className.indexOf('dsh-git-chip-open') < 0) { t.props.onClick(); await wait(10) }
  return await settle()
}
async function openSwitcher() {
  const t = await openPanel()
  const chipBtn = byClass(t, 'dsh-git-branch-chip')[0]
  chipBtn.props.onClick()
  await wait(10)
  return await settle()
}
/* 面板的「配置」页分两档作用域（80-panel.js）：先点开面板，再点「配置」页签；
   scope === 'global' 时接着点「全局配置」。原先挂在 DSH 设置面板里的那一页
   （设置 → dsh-git-idea配置）2026-10 起就是这里的全局档。

   每回都 fibers.clear() 后重新挂载：设置页时代「换个 label 就是新 fiber」的干净
   状态语义，搬进面板后由这一句来保 —— fiber 一律走 openPanel 的 'pop'，参数里的
   label 只留给渲染 trace。 */
async function openConfig(scope, label) {
  fibers.clear()
  const open = await openPanel()
  const tabBtn = buttons(open).find((b) => textOf(b) === '配置')
  if (tabBtn === undefined) throw new Error('openConfig: 配置 tab not found')
  tabBtn.props.onClick()
  let t = await settle('pop')
  const want = scope === 'global' ? '全局配置' : '项目配置'
  const wantBtn = buttons(t).find((b) => textOf(b) === want)
  if (wantBtn === undefined) throw new Error('openConfig: ' + want + ' tab not found')
  if (String(wantBtn.props.className).indexOf('dsh-git-cview-on') < 0) {
    wantBtn.props.onClick()
    t = await settle('pop')
  }
  return t
}

const ok = (label, value) => console.log('  ' + (value ? '✓' : '✗') + ' ' + label + (value ? '' : '   ← 不符合预期'))
/* ── 会话完成 → ↑ 待推送角标（客户端这一半）──
 *
 * 用户报的场景：agent 在仓库里提交了但没推，会话完成时面板「推送」按钮旁的待推送
 * 角标（ahead）没有刷新出来。这条链在 fixture 里一共五环：
 *
 *   chip 听 running 的 true→false 边沿（92-chip.js）→ 2 秒稳定窗 → completeRefresh：
 *   git/flush + markTreePartial + ringTreeReload + bumpData → 面板的 reloadAt 追上
 *   （开着当场追，关着等再打开那一帧追，80-panel.js 的 freshAt）→ loadWork 重发
 *   quick:true 的身份读 → 答复里的 ahead 写进 work → 工具条 ↑ 的 dsh-git-tool-badge
 *   与分支 chip 的 dsh-git-ab（'↑'+ahead）两处一起换数。
 *
 * 两节各钉一遍：面板开着（历史页）当场刷；面板关着→完成→再打开补刷。旧答复
 * ahead=0（角标不画）、新答复换数（两处都画出新值）。换答复的时机在完成之前 ——
 * 「agent 先提交、后会话完成」，重读拿到的就该是新答案。推送策略不动：
 * pushOnAllComplete 缺省 false，全程一个 git/push 都不许发。
 *
 * 后三节钉的是真机上把这条链整条打断的三个断点（真机现场：agent 连提十来个提交，
 * 面板的 ↑ 一个数都不动；Host 缓存里的 panel-ident 停在几个提交之前，一次 flush
 * 才回真）：
 *   3. 前端组合没有 timer 服务（部署的 dsh-web-frontend 只 mixin 了 reflect/fiber/
 *      registry/events，ctx.get('timer') 永远 undefined），bridge 版更连 WS 都没有 ——
 *      推送化之后核对只由 live-open 与页面回可见驱动，定时器一条都不排：无 timer +
 *      无 WS 的现场把假时钟摇光也是 0 次 git/watch（故意不设轮询兜底），手动刷新
 *      那条路照旧能用（第 5 节守着）。
 *   4. 页面藏着时会话完成：那一刷记成欠账，回可见（或 live-open 重连）先补那一刷
 *      （flush+bump），面板当场换数。
 *   5. 就算上面全断了，重开面板也不能把 Host 缓存里的旧 ahead 当新的画：开面板
 *      边界只作废 panel-ident/branches 两格缓存并补一次身份读，↑ 校正回来，重开
 *      照旧接近零成本。
 *
 * 会话状态 hook 用 gp49 那套假 props（真环境是 DSH 注入的 useSession /
 * useSessionStatus，桩按真契约「选择器进、选择器的返回值出」长牙）。 */

let quickAhead = 0
let workAhead = 0
const quickReply = function () {
  return { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: quickAhead, behind: 0, sequencer: null, partial: true, staged: [], unstaged: [], untracked: [], unmerged: [] }
}
const workReply = function () {
  return { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: workAhead, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] }
}
const pushCalls52 = []
let watchSig52 = 'SIG'
const realCall52 = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    if (args != null && args.quick === true) return Promise.resolve(quickReply())
    return Promise.resolve(workReply())
  }
  if (method === 'git/push') { calls.push({ method: method, args: args }); pushCalls52.push(args); return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 }) }
  if (method === 'git/watch') { calls.push({ method: method, args: args }); return Promise.resolve({ ok: true, repo: '/tmp/ws', sig: watchSig52 }) }
  if (method === 'git/command-log') {
    calls.push({ method: method, args: args })
    return Promise.resolve({ ok: true, sessionId: args != null ? args.sessionId : '', commands: [], truncated: false, warning: '' })
  }
  return realCall52(method, args)
}

const callsOf52 = function (mark, method) { return calls.slice(mark).filter((c) => c.method === method) }
const quickReadsAfter = function (mark) { return callsOf52(mark, 'git/panel').filter((c) => c.args != null && c.args.quick === true) }
const fireTimers52 = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}
/* interval 定时器（推送化之后 watcher 一条都不排；这套桩留着当「假时钟」，
 * 用来证没有定时器触发的 git/watch）。 */
const fireIntervals52 = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'interval' && !t.dead && (delay === undefined || t.delay === delay)) t.cb()
  }
}
/* 「待推送」三处里在面板上的两处：工具条 ↑ 的角标、分支 chip 的 ↑N。 */
const pushToolBadges = (t) => byClass(t, 'dsh-git-tool-badge')
const branchChipMarks = (t) => byClass(t, 'dsh-git-ab')
const chipClose52 = async function () {
  const t = await chipTree()
  if (String(t.props.className).indexOf('dsh-git-chip-open') >= 0) { t.props.onClick(); await wait(20) }
  return await settle()
}

console.log('')
console.log('=== 会话完成 → ↑ 角标：面板开着（历史页）当场刷 ===')
let running52 = false
const status52 = new Map([['s-1', { running: false }]])
const hooks52 = {
  useSession: function (sel) { return sel({ running: running52 }) },
  useSessionStatus: function (sel) { return sel(status52) },
}
const renderChip52 = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-1' }, hooks52)), 'chip-52')
await renderChip52()
let tree = await openPanel()
tree = await settle()
/* 旧答复 ahead=0：两处都不画角标（负对照 —— 角标的出现必须是新答复带出来的）。 */
ok('完成前（旧答复 ahead=0）：工具条 ↑ 没有角标，分支 chip 没有 ↑N',
  pushToolBadges(tree).length === 0 && branchChipMarks(tree).length === 0)

/* agent 提交落地：仓库 ahead 变 2（会话还在跑，此刻谁都没 bump）。 */
quickAhead = 2
workAhead = 2
running52 = true
await renderChip52()
running52 = false
let mark52 = calls.length
await renderChip52()
ok('边沿后先不发：2 秒稳定窗没走完，quick 读一次都没重发', quickReadsAfter(mark52).length === 0)
fireTimers52(2000)
await wait(30)
tree = await settle()
ok('完成那一刷：git/flush 重发了（会话本身 + 工作区仓库）',
  callsOf52(mark52, 'git/flush').length >= 2)
ok('面板重发了 quick:true 的身份读（完成触发的重读，不是别的刷新时机）',
  quickReadsAfter(mark52).length >= 1)
ok('工具条 ↑ 的角标显示新答复的 ahead=2', pushToolBadges(tree).some((n) => textOf(n) === '2'))
ok('分支 chip 显示 ↑2', branchChipMarks(tree).some((n) => textOf(n) === '↑2'))
ok('完成刷新不推送：一个 git/push 都没发（pushOnAllComplete 缺省 false）', pushCalls52.length === 0)

console.log('')
console.log('=== 会话完成 → ↑ 角标：面板关着时完成，再打开补刷 ===')
await chipClose52()
tree = await settle()
/* 关着时面板读一个不发（freshAt 冻结的既有规矩）。refs/graph 只有没有藏起来的面板
   才会问（chip 只发 panel/branches），所以「冻结」拿这两个读者钉最准。 */
mark52 = calls.length
await chipClose52()
await settle()
ok('面板关着：完成前这一停不发 refs/graph（面板读者全冻在旧版本上）',
  callsOf52(mark52, 'git/refs').length === 0 && callsOf52(mark52, 'git/graph').length === 0)

quickAhead = 0
workAhead = 0
/* 换一把新 chip（新边沿）：上一节的 running 边沿已经烧掉了。 */
let running53 = false
const hooks53 = {
  useSession: function (sel) { return sel({ running: running53 }) },
  useSessionStatus: function (sel) { return sel(status52) },
}
const renderChip53 = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-1' }, hooks53)), 'chip-53')
await renderChip53()
/* agent 又提交了（ahead 0 → 5），会话在面板关着时完成。 */
quickAhead = 5
workAhead = 5
running53 = true
await renderChip53()
running53 = false
mark52 = calls.length
await renderChip53()
fireTimers52(2000)
await wait(30)
ok('面板关着的那一刷：flush 照发，但面板读一个不发（freshAt 冻结）',
  callsOf52(mark52, 'git/flush').length >= 2 && callsOf52(mark52, 'git/panel').length === 0)
mark52 = calls.length
tree = await openPanel()
tree = await settle()
ok('再打开：面板补发了 quick:true 的身份读', quickReadsAfter(mark52).length >= 1)
ok('工具条 ↑ 的角标显示新答复的 ahead=5', pushToolBadges(tree).some((n) => textOf(n) === '5'))
ok('分支 chip 显示 ↑5', branchChipMarks(tree).some((n) => textOf(n) === '↑5'))
ok('完成补刷也不推送', pushCalls52.length === 0)

console.log('')
console.log('=== 无 timer 服务的前端 + bridge 版没有 WS：也不许有轮询兜底 ===')
/* 部署的 dsh-web-frontend 组合里没有 timer 服务（ctx.get('timer') 永远 undefined），
 * bridge 版更连 liveBus 都没有。推送化之后核对只由 live-open 与回可见驱动 —— 故意
 * 不设轮询兜底：WS 断着，屏幕就让它停着，手动刷新照旧。把 ctx 的 timer 摘掉、
 * window 的定时器换成「进 harness 那张表」的桩、liveBus 摘掉，再求值一份插件
 * （gp50 同款「刷新页面」模拟 = 真正的 bridge 加载现场），摇光时钟钉住 0 次
 * git/watch。 */
const realGet52 = ctx.get
const realInterval52 = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
let fallbackSeq52 = 0
const fallbackTimers52 = new Map()
ctx.get = function (n) { if (n === 'timer') return undefined; return realGet52(n) }
globalThis.setInterval = function (cb, delay) {
  const t = { kind: 'interval', cb: cb, delay: delay, dead: false }
  timers.push(t)
  fallbackSeq52 += 1
  fallbackTimers52.set(fallbackSeq52, t)
  return fallbackSeq52
}
globalThis.clearInterval = function (id) {
  const t = fallbackTimers52.get(id)
  if (t != null) t.dead = true
}
const realLiveBus52 = globalThis.liveBus
globalThis.liveBus = undefined
const registeredF = []
const ctxF = {
  get(n) {
    if (n === 'slots') return { inject: (k, cb) => cb(), register: (o, c) => { registeredF.push({ options: o, component: c }); return () => {} } }
    return undefined
  },
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
new Function('ctx', 'React', 'host', 'styles', 'console', fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8'))(
  ctxF, React, host, { insert: () => () => {} }, console).apply(ctxF)
const chipF = registeredF.find((r) => r.options.id === 'dsh-git-idea-chip').component
const timersMarkF = timers.length
await renderUntilStable(makeElement(chipF, { sessionId: 's-1' }), 'chip-fallback')
ok('无 timer + 无 WS 的现场：挂载不排任何轮询定时器（一条 interval 都不加）',
  timers.slice(timersMarkF).every((t) => t.kind !== 'interval'))
mark52 = calls.length
for (let i = 0; i < 8; i += 1) fireIntervals52()
await wait(40)
ok('兜底不轮询：假时钟摇了 8 拍，0 次 git/watch（WS 断着就让它断着）',
  callsOf52(mark52, 'git/watch').length === 0)
ok('时钟空转也没有 flush（旧断言「兜底的轮询对了一次签名」就此反转）',
  callsOf52(mark52, 'git/flush').length === 0)
/* 摘掉桩：别把这套假定时器带进后面的节。 */
ctx.get = realGet52
globalThis.setInterval = realInterval52.setInterval
globalThis.clearInterval = realInterval52.clearInterval
globalThis.liveBus = realLiveBus52
watchSig52 = 'SIG'

console.log('')
console.log('=== 页面藏着时会话完成：那一刷记成欠账，回可见先补 ===')
/* 面板开着（此刻 ↑=7）。页面藏起来，agent 提交（7 → 8），会话完成。 */
quickAhead = 8
workAhead = 8
fakeDoc.hidden = true
let running55 = false
const hooks55 = {
  useSession: function (sel) { return sel({ running: running55 }) },
  useSessionStatus: function (sel) { return sel(status52) },
}
const renderChip55 = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-1' }, hooks55)), 'chip-55')
await renderChip55()
running55 = true
await renderChip55()
running55 = false
mark52 = calls.length
await renderChip55()
fireTimers52(2000)
await wait(30)
tree = await settle()
ok('藏着的那一刷不发（欠着）：一个 flush 都没发', callsOf52(mark52, 'git/flush').length === 0)
ok('藏在期间面板也不换数：↑ 还是旧答案 7', pushToolBadges(tree).some((n) => textOf(n) === '8') === false)
/* 回可见：先补欠的那一刷，再对签名。 */
mark52 = calls.length
fakeDoc.hidden = false
fakeDoc.fire('visibilitychange')
await wait(30)
tree = await settle()
ok('回可见先把欠的一刷补上（flush 重发）', callsOf52(mark52, 'git/flush').length >= 2)
ok('补的这刷带着面板的重读：↑ 换成新答复的 8', pushToolBadges(tree).some((n) => textOf(n) === '8') === true)
ok('分支 chip 显示 ↑8', branchChipMarks(tree).some((n) => textOf(n) === '↑8'))

console.log('')
console.log('=== 就算 watcher 与完成都断了：重开面板也不画缓存里的旧 ahead ===')
/* 全断现场：关面板 → agent 提交（8 → 9）→ 没有任何 bump（不渲染 chip、不 tick）。
 * 过去重开重发的身份读命中 Host 那份没人 flush 过的缓存，↑ 照旧画旧数 —— 真机
 * 现场。现在开面板边界先作废 panel-ident/branches 两格、再补一次身份读。 */
await chipClose52()
tree = await settle()
quickAhead = 9
workAhead = 9
mark52 = calls.length
tree = await openPanel()
tree = await settle()
const flushWithTags = callsOf52(mark52, 'git/flush').filter((c) => JSON.stringify(c.args.tags) === JSON.stringify(['panel-ident', 'branches']))
ok('开面板边界：带 tags 的 flush 发出去了（只作废身份与分支两格）', flushWithTags.length === 1)
/* 面板自己的那对「先作废、再读」：中间不许夹别的面板读（openPanel 顺带的重渲染
 * 会带来 chip 自己的读，那不属于这个边界）。 */
const flushAt52 = calls.indexOf(flushWithTags[0])
const quickAfterFlush = calls.slice(flushAt52 + 1).filter((c) => c.method === 'git/panel' && c.args != null && c.args.quick === true)
const betweenFlushAndRead = calls.slice(flushAt52 + 1, calls.indexOf(quickAfterFlush[0]))
ok('这个 flush 排在补的身份读前面（先作废再读，读到的才不是缓存）',
  flushWithTags.length === 1 && quickAfterFlush.length >= 1)
ok('作废与补读之间不夹别的面板读（重开照旧接近零成本）',
  betweenFlushAndRead.every((c) => c.method !== 'git/panel'))
ok('补读把 ↑ 校正到 9', pushToolBadges(tree).some((n) => textOf(n) === '9') === true)
ok('分支 chip 显示 ↑9', branchChipMarks(tree).some((n) => textOf(n) === '↑9'))
ok('全程一个 git/push 都没发', pushCalls52.length === 0)
