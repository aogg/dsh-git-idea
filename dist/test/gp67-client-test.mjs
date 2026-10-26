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
/* ═══ gp67：会话完成 → 提交历史列表跟着刷新（客户端这一半）═══
 *
 * 用户报的场景：会话完成后，历史页的 git/graph 提交列表没有跟着刷新。宿主那一半
 * （gp67-host）钉「重发的读拿到的必须是失效缓存后的新账」；这里钉客户端这四环：
 *
 *   1. 面板开着停在历史页，宿主推 session-complete → 完成那一刷先发 flush 再让
 *      freshAt 追上（先失效再读），面板重发 git/graph，屏上的提交列表换上新顶端；
 *      且 flush 的 repo 与 graph 请求的 repo 逐字节同形（缓存键前缀匹配的客户端
 *      半边），生效仓库必须算进完成那一刷的清单（completionReposOf）。
 *   2. 面板关着时完成（chip 边沿那一路）：flush 照发、面板一个读都不发（freshAt
 *      冻结的既有规矩）；再打开时历史页重发 git/graph，读到的是新账。
 *   3. 5 秒护栏：chip 边沿刚刷过，同一次完成的推送迟到 —— 让路，graph 不重发
 *      （不重复整树读的既有语义在历史页这一侧同样成立）。
 *   4. refreshOnComplete=false：推送到了也不 flush、不重读（开关语义不被破坏）。
 *
 * 与 gp52 同一套会话状态假 props；git/repos 桩答一份真清单，仓库行单击把 /tmp/ws
 * 应用成生效仓库 —— 让「flush 清单覆盖面板当前生效仓库」这条真正有据可断。 */

const realCall67 = host.call
host.call = function (method, args) {
  if (method === 'git/repos') {
    calls.push({ method: method, args: args })
    return Promise.resolve({ ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws'], manual: [], missing: [], links: [] })
  }
  return realCall67(method, args)
}

const callsOf67 = (mark, method) => calls.slice(mark).filter((c) => c.method === method)
const subjects67 = (t) => byClass(t, 'dsh-git-subject').map(textOf)
const fireTimers67 = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}
const status67 = new Map([['s-1', { running: false }]])
const chipWith67 = function (state) {
  return renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-1' }, {
    useSession: function (sel) { return sel({ running: state.running === true }) },
    useSessionStatus: function (sel) { return sel(status67) },
  })), 'chip-67-' + state.label)
}
const chipClose67 = async function () {
  const t = await chipTree()
  if (String(t.props.className).indexOf('dsh-git-chip-open') >= 0) { t.props.onClick(); await wait(20) }
  return await settle()
}
const APPLIED = '/tmp/ws'
const repoRow67 = (t) => byClass(t, 'dsh-git-repo-row').filter((r) => textOf(r).indexOf('全部') < 0)[0]

console.log('')
console.log('=== 铺场：面板开着停在历史页，/tmp/ws 应用成生效仓库 ===')
fibers.clear()
await chipWith67({ running: false, label: 'setup' })
let tree67 = await openPanel()
tree67 = await settle()
ok('历史页首读：旧顶端在屏上', subjects67(tree67).indexOf('tip commit') === 0)
const row67 = repoRow67(tree67)
if (row67 === undefined) throw new Error('gp67: 仓库行没渲染出来')
let markApplied67 = calls.length
row67.props.onClick({ ctrlKey: false })
tree67 = await settle()
ok('仓库行单击后，历史页的 git/graph 请求带上生效仓库 /tmp/ws',
  callsOf67(markApplied67, 'git/graph').length > 0
  && callsOf67(markApplied67, 'git/graph').every((c) => c.args != null && c.args.repo === APPLIED))

console.log('')
console.log('=== 1｜面板开着（历史页）+ 推送路径：先失效再读，列表换新顶端 ===')
graphCommits = [
  { hash: 'd111111', subject: '完成刷新带来的新顶端', author: 'mays', date: '2026-10-25', committedAt: nowSec - 30, refs: ['HEAD -> main'] },
  { hash: 'aaa111', subject: 'tip commit', author: 'mays', date: '2026-09-16', committedAt: nowSec - 60, refs: [] },
]
let mark67 = calls.length
livePush({ kind: 'session-complete', sessionId: 's-1' })
await wait(30)
tree67 = await settle()
const flushes67 = callsOf67(mark67, 'git/flush')
const graphs67 = callsOf67(mark67, 'git/graph')
ok('完成那一刷重发了 git/flush（会话级 + 生效仓库各一条）',
  flushes67.some((c) => c.args != null && c.args.repo === undefined && c.args.tags === undefined)
  && flushes67.some((c) => c.args != null && c.args.repo === APPLIED && c.args.tags === undefined))
ok('flush 排在面板重发的 git/graph 前面（先失效缓存再读，读到的才不是旧账）',
  flushes67.length > 0 && graphs67.length > 0
  && calls.indexOf(flushes67[0]) < calls.indexOf(graphs67[0]))
ok('面板重发的 git/graph 带的还是同一个生效仓库路径（与 flush 的 repo 逐字节同形）',
  graphs67.length > 0 && graphs67[0].args != null && graphs67[0].args.repo === APPLIED)
ok('提交历史列表换上新顶端', subjects67(tree67).indexOf('完成刷新带来的新顶端') === 0)

console.log('')
console.log('=== 2｜面板关着时完成（chip 边沿）：flush 照发、读全冻；重开读到新账 ===')
await chipClose67()
tree67 = await settle()
graphCommits = [
  { hash: 'e222222', subject: '重开历史页读到的新账', author: 'mays', date: '2026-10-25', committedAt: nowSec - 20, refs: ['HEAD -> main'] },
  { hash: 'd111111', subject: '完成刷新带来的新顶端', author: 'mays', date: '2026-10-25', committedAt: nowSec - 30, refs: [] },
]
/* 换一把新 chip（新 fiber，边沿重新武装）：上一节的推送没有烧边沿，但干净起见
   按 gp52 的做法新挂一只，running true→false 走 chip 自己的那一路。 */
const state67b = { running: false, label: 'closed' }
await chipWith67(state67b)
state67b.running = true
await chipWith67(state67b)
state67b.running = false
mark67 = calls.length
await chipWith67(state67b)
fireTimers67(2000)
await wait(30)
tree67 = await settle()
ok('关着的那一刷：flush 重发了，面板一个读都不发（freshAt 冻结）',
  callsOf67(mark67, 'git/flush').length >= 2 && callsOf67(mark67, 'git/graph').length === 0)
mark67 = calls.length
tree67 = await openPanel()
tree67 = await settle()
ok('再打开：历史页重发了 git/graph', callsOf67(mark67, 'git/graph').length >= 1)
ok('重开读到的列表是新账', subjects67(tree67).indexOf('重开历史页读到的新账') === 0)

console.log('')
console.log('=== 3｜5 秒护栏：chip 边沿刚刷过，同一次完成的推送让路 ===')
graphCommits = [
  { hash: 'f333333', subject: '护栏后不重读的第三次', author: 'mays', date: '2026-10-25', committedAt: nowSec - 10, refs: ['HEAD -> main'] },
  { hash: 'e222222', subject: '重开历史页读到的新账', author: 'mays', date: '2026-10-25', committedAt: nowSec - 20, refs: [] },
]
const state67c = { running: false, label: 'guard' }
await chipWith67(state67c)
state67c.running = true
await chipWith67(state67c)
state67c.running = false
mark67 = calls.length
await chipWith67(state67c)
fireTimers67(2000)
await wait(30)
tree67 = await settle()
const edgeFlushes67 = callsOf67(mark67, 'git/flush').length
const edgeGraphs67 = callsOf67(mark67, 'git/graph').length
ok('chip 边沿那一刷照常：flush 与 graph 都发了（边沿永远照跑）', edgeFlushes67 >= 2 && edgeGraphs67 >= 1)
livePush({ kind: 'session-complete', sessionId: 's-1' })
await wait(30)
tree67 = await settle()
ok('5 秒内迟到的推送被护栏让路：flush 与 graph 都没有第二遍',
  callsOf67(mark67, 'git/flush').length === edgeFlushes67
  && callsOf67(mark67, 'git/graph').length === edgeGraphs67)
ok('屏上列表就是边沿那一刷换上的（不需要也不再有第二遍）',
  subjects67(tree67).indexOf('护栏后不重读的第三次') === 0)

console.log('')
console.log('=== 4｜refreshOnComplete=false：推送到了也不刷（开关语义不被破坏）===')
const registeredF67 = []
const callsF67 = []
const ctxF67 = {
  get(n) {
    if (n === 'slots') return { inject: (k, cb) => cb(), register: (o, c) => { registeredF67.push({ options: o, component: c }); return () => {} } }
    return undefined
  },
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const hostF67 = { call(method, args) {
  callsF67.push({ method: method, args: args })
  if (method === 'git/config') return Promise.resolve({ ok: true, path: '/tmp/gp67.json', config: { refreshOnComplete: false } })
  if (method === 'git/repos') return Promise.resolve({ ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws'], manual: [], missing: [], links: [] })
  if (method === 'git/panel') return Promise.resolve({ ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] })
  if (method === 'git/repo-applied') return Promise.resolve({ ok: true, workspace: '/tmp/ws', repo: '' })
  if (method === 'git/graph') return Promise.resolve({ ok: true, repo: '/tmp/ws', ref: 'main', currentBranch: 'main', commits: graphCommits, rows: [], lanes: 1 })
  return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
} }
new Function('ctx', 'React', 'host', 'styles', 'console', fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8'))(
  ctxF67, React, hostF67, { insert: () => () => {} }, console).apply(ctxF67)
const chipF67 = registeredF67.find((r) => r.options.id === 'dsh-git-idea-chip').component
await renderUntilStable(makeElement(chipF67, { sessionId: 's-1' }), 'chip-67-off')
mark67 = callsF67.length
livePush({ kind: 'session-complete', sessionId: 's-1' })
await wait(30)
ok('开关关着：推送到了一个 flush 都不发', callsF67.slice(mark67).every((c) => c.method !== 'git/flush'))
ok('开关关着：也不重读历史（graph 一次都不加）', callsF67.slice(mark67).every((c) => c.method !== 'git/graph'))
