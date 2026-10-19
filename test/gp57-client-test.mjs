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
    return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
  },
}
/* the history the mock hands back; a test may swap it to simulate a re-read */
let graphCommits = [
  { hash: 'aaa111', subject: 'tip commit', author: 'mays', date: '2026-09-16', committedAt: nowSec - 60, refs: ['HEAD -> dev'] },
  { hash: 'bbb222', subject: 'second commit', author: 'mays', date: '2026-09-15', committedAt: nowSec - 3600, refs: [] },
  { hash: 'ccc333', subject: 'third commit', author: 'jiangzx', date: '2026-09-14', committedAt: nowSec - 7200, refs: [] },
]
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
/* ═══ gp57：历史页工作树块（客户端这一半）═══
 *
 * 盯五片：
 *   1. 挂载与读数：面板打开就发一条 git/worktrees（80-panel.js 那条跟
 *      [appliedRepo, repoOk, freshAt, props.ready] 的 effect），单仓库请求不带
 *      repo（base(appliedRepo) 的老口径）；标题行「工作树 N」，N = 记录数 ——
 *      detached / bare 的记录也计数（它们是真实存在的工作树，只是不可选）；
 *   2. 行模型：目录短名（tname）+ 它站着的分支（tsub）两段式；↑↓ 徽章从面板
 *      已读的 refs 按分支名免费查，查不到就不画（不为徽章多发一次读数）；
 *      分支 == activeRef 的行首亮 ●——与分支树 scope 高亮同一个值；
 *   3. 灰行语义：detached / bare / prunable 都压暗，其中 detached 与 bare 没有
 *      分支可选、onClick 干脆不挂；prunable 仍可点（单击只是过滤历史，目录丢了
 *      不影响这件事）；locked 不灰、行尾 🔒、tooltip 带原因；tooltip 三件事
 *      （完整路径 / 归属仓库 / 只读点击语义）一条不少；
 *   4. 折叠与退化：标题行是折叠开关，折叠后标题行仍记当前选中项；data==null
 *      一行「正在读取工作树…」；ok:false 与运输层失败都退化成灰说明行、不抛错
 *      （工作树是辅助信息，不上错误横幅）；
 *   5. 点击语义与跟随：单仓库单击行 = onPickBranch('', branch) —— 只 setActiveRef，
 *      git/graph 的 ref 跟上、请求不带 repo，也不为它重发工作树读数；多选分组里
 *      repo 传生效仓库（logSel.length > 0 ? effectiveRepo : ''）—— 单击即收拢回
 *      单仓库并按该分支过滤；切生效仓库（单击仓库行）后 git/worktrees 重发且
 *      请求参数跟着换，块的数据整份换新。侧栏位置：仓库块正下方、分支树行之前。 */

/* ── mock：工作树罐头按请求里的 repo 给（答的是谁要看得出），refs 自带 ahead/behind ── */
const WS_WORKTREES = {
  ok: true, repo: '/tmp/ws',
  worktrees: [
    { path: '/tmp/ws', head: 'aaa', branch: 'main', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/feature one', head: 'bbb', branch: 'feature/one', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/detached one', head: 'ccc', branch: '', detached: true, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/bare main', head: '', branch: '', detached: false, bare: true, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/pruned one', head: 'ddd', branch: 'solo', detached: false, bare: false, locked: false, lockReason: '', prunable: true, pruneReason: 'gitdir 文件指向不存在的地方' },
    { path: '/tmp/lab/locked one', head: 'eee', branch: 'stable', detached: false, bare: false, locked: true, lockReason: '变更多，暂不动', prunable: false, pruneReason: '' },
  ],
}
const ALPHA_WORKTREES = {
  ok: true, repo: '/tmp/ws/alpha',
  worktrees: [
    { path: '/tmp/ws/alpha', head: 'aaa', branch: 'main', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/ws/alpha-wt x', head: 'hhh', branch: 'solo', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
  ],
}
let wtReply = null /* 设了就原样答（ok:false 等固定答复用） */
let hangWorktrees = false
let failWorktrees = false
const reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws/alpha', '/tmp/ws/beta'], manual: [], missing: [], truncated: false }
const refsReply = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [
    { segments: ['main'], data: 'main', upstream: 'origin/main', ahead: 2, behind: 1, at: 0 },
    { segments: ['solo'], data: 'solo', upstream: '', ahead: 0, behind: 0, at: 0 },
  ],
  remote: [],
}
const wtCalls = []
const realCall57 = host.call
host.call = function (method, args) {
  if (method === 'git/worktrees') {
    calls.push({ method: method, args: args })
    wtCalls.push(args)
    if (hangWorktrees === true) return new Promise(function () {})
    if (failWorktrees === true) return Promise.reject(new Error('bridge down'))
    if (wtReply !== null) return Promise.resolve(wtReply)
    return Promise.resolve(args != null && args.repo === '/tmp/ws/alpha' ? ALPHA_WORKTREES : WS_WORKTREES)
  }
  if (method === 'git/repos') { calls.push({ method: method, args: args }); return Promise.resolve(reposReply) }
  if (method === 'git/refs') { calls.push({ method: method, args: args }); return Promise.resolve(refsReply) }
  return realCall57(method, args)
}

/* ── 取景工具 ── */
const hasClass57 = (n, s) => n.props != null && typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(s) >= 0
const wtBox57 = (t) => byClass(t, 'dsh-git-wt-box')[0]
const wtRows57 = (t) => byClass(wtBox57(t) || t, 'dsh-git-wt-row')
const wtRowOf57 = (t, path) => wtRows57(t).find((r) => String(r.props.key) === 'wt:' + path)
const wtHead57 = (t) => byClass(t, 'dsh-git-wt-head')[0]
const markOf57 = (row) => { const m = byClass(row, 'dsh-git-repo-mark')[0]; return m === undefined ? null : textOf(m) }
const badgesOf57 = (row) => byClass(row, 'dsh-git-ab').map(textOf)
const subOf57 = (row) => { const s = byClass(row, 'dsh-git-tsub')[0]; return s === undefined ? '' : textOf(s) }
const nameOf57 = (row) => { const s = byClass(row, 'dsh-git-tname')[0]; return s === undefined ? '' : textOf(s) }
const marksOf57 = (row) => byClass(row, 'dsh-git-wt-mark').map(textOf)
const callsOf57 = (mark, method) => calls.slice(mark).filter((c) => c.method === method)
const lastCall57 = (mark, method) => { const list = callsOf57(mark, method); return list.length > 0 ? list[list.length - 1].args : undefined }
const repoRow57 = (t, path) => byClass(t, 'dsh-git-repo-row').find((r) => String(r.props.key) === 'repo:' + path)
/* 换场景 = 清掉 fiber 再换会话挂：hooks（worktrees 读数、activeRef）跟着归零，
   生效仓库的盘账按会话分格、新会话自然是空（openConfig 的同一条老规矩）。 */
const pop57 = (sid) => renderUntilStable(makeElement(popover, { sessionId: sid }), sid)
async function settle57(sid) { let t = null; for (let i = 0; i < 4; i += 1) { t = await pop57(sid); await wait(10) } return t }

/* 面板得先「开」一次：everOpened 是模块级的，此后直接挂 popover 就是就绪态。 */
fibers.clear()
let chipT = await renderUntilStable(makeElement(chip, { sessionId: 's-57a' }), 'chip-57a')
if (chipT.props.className.indexOf('dsh-git-chip-open') < 0) { chipT.props.onClick(); await wait(10) }
let tree = await settle57('s-57a')

console.log('')
console.log('== 挂载与读数：一条 git/worktrees、标题行「工作树 N」、● 只亮当前分支 ==')
ok('面板打开就问 git/worktrees，恰好一次；单仓库请求只带会话不带 repo（生效仓库由 Host 解）',
  wtCalls.length === 1 && wtCalls[0].sessionId === 's-57a' && wtCalls[0].repo === undefined)
ok('标题行「工作树 6」：六份记录（含 detached / bare）都计数',
  wtHead57(tree) !== undefined && textOf(wtHead57(tree)).indexOf('工作树 6') >= 0)
ok('六行，没有混进读取中 / 失败的说明行',
  wtRows57(tree).length === 6)
ok('行首 ● 只亮分支 == 当前分支（main）的那一行，其余行的记号位是空的',
  wtRows57(tree).map(markOf57).join('|') === '●|||||')
ok('名字与小字两段式：目录短名 + 它站着的分支（带空格的目录名整段保留）',
  nameOf57(wtRowOf57(tree, '/tmp/ws')) === 'ws' && subOf57(wtRowOf57(tree, '/tmp/ws')) === 'main'
  && nameOf57(wtRowOf57(tree, '/tmp/lab/feature one')) === 'feature one'
  && subOf57(wtRowOf57(tree, '/tmp/lab/feature one')) === 'feature/one')

console.log('')
console.log('== 行模型：↑↓ 徽章免费查 refs、tooltip 三件事 ==')
const wsRow = wtRowOf57(tree, '/tmp/ws')
ok('徽章从面板已读的 refs 按分支名免费查：main ↑2 ↓1（进/出的类各就位）',
  badgesOf57(wsRow).join('') === '↓1↑2'
  && byClass(wsRow, 'dsh-git-ab-in').length === 1 && byClass(wsRow, 'dsh-git-ab-out').length === 1)
ok('refs 查不到的分支不画徽章（feature/one 不在本地账里），不为它多发一次读数',
  badgesOf57(wtRowOf57(tree, '/tmp/lab/feature one')).length === 0 && wtCalls.length === 1)
ok('tooltip 三件事：完整路径、归属仓库、只读点击语义（只改历史视图，不 checkout）',
  String(wsRow.props.title).indexOf('/tmp/ws') === 0
  && String(wsRow.props.title).indexOf('归属仓库：/tmp/ws') >= 0
  && String(wtRowOf57(tree, '/tmp/lab/feature one').props.title).indexOf('单击 = 历史按分支 feature/one 过滤') >= 0
  && String(wtRowOf57(tree, '/tmp/lab/feature one').props.title).indexOf('不 checkout、不切换分支、不动任何工作区') >= 0)
ok('徽章的 tooltip 与分支树同一句：分岔（领先 2 落后 1）+ 上游名',
  String(wsRow.props.title).indexOf('与上游分岔：领先 2，落后 1') >= 0
  && String(wsRow.props.title).indexOf('origin/main') >= 0)

console.log('')
console.log('== 灰行语义：detached/bare 不可点、prunable 灰但可点、locked 🔒 带原因 ==')
const detRow = wtRowOf57(tree, '/tmp/lab/detached one')
const bareRow = wtRowOf57(tree, '/tmp/lab/bare main')
const pruneRow = wtRowOf57(tree, '/tmp/lab/pruned one')
const lockRow = wtRowOf57(tree, '/tmp/lab/locked one')
ok('detached 灰行、小字「游离 HEAD」、没有 onClick（没有分支可选，点了也不该有反应）',
  hasClass57(detRow, 'dsh-git-wt-gone') && subOf57(detRow) === '游离 HEAD' && detRow.props.onClick === undefined)
ok('bare 灰行、小字 bare、同样没有 onClick',
  hasClass57(bareRow, 'dsh-git-wt-gone') && subOf57(bareRow) === 'bare' && bareRow.props.onClick === undefined)
ok('prunable 灰行但仍可点：onClick 在，行尾 ⚠，tooltip 说明目录已丢失且本版没有 prune',
  hasClass57(pruneRow, 'dsh-git-wt-gone') && typeof pruneRow.props.onClick === 'function'
  && marksOf57(pruneRow).join('') === '⚠'
  && String(pruneRow.props.title).indexOf('目录已丢失，可 prune 清理') >= 0
  && String(pruneRow.props.title).indexOf('本版没有 prune 动作') >= 0)
ok('locked 不灰（分支还在、可选），行尾 🔒 且 tooltip 带原因原文',
  hasClass57(lockRow, 'dsh-git-wt-gone') === false && typeof lockRow.props.onClick === 'function'
  && marksOf57(lockRow).join('') === '🔒'
  && String(lockRow.props.title).indexOf('已锁定：变更多，暂不动') >= 0)

console.log('')
console.log('== 折叠：标题行是开关，折叠后仍记当前选中项 ==')
wtHead57(tree).props.onClick()
tree = await settle57('s-57a')
ok('点标题行收起：行全没了，标题行记着当前选中的那棵（● ws）',
  wtRows57(tree).length === 0 && textOf(wtHead57(tree)).indexOf('● ws') >= 0)
wtHead57(tree).props.onClick()
tree = await settle57('s-57a')
ok('再点展开：六行原样回来', wtRows57(tree).length === 6 && wtRowOf57(tree, '/tmp/ws') !== undefined)

console.log('')
console.log('== 退化：正在读取 / ok:false / 运输层失败，都不抛错、都是灰说明行 ==')
fibers.clear()
hangWorktrees = true
tree = await settle57('s-57b')
ok('data==null：标题行「正在读取…」+ 一行灰「正在读取工作树…」',
  textOf(wtHead57(tree)).indexOf('正在读取…') >= 0 && wtRows57(tree).length === 1
  && textOf(wtRows57(tree)[0]).indexOf('正在读取工作树…') >= 0
  && hasClass57(wtRows57(tree)[0], 'dsh-git-wt-gone'))
fibers.clear()
hangWorktrees = false
wtReply = { ok: false, repo: '/tmp/ws', error: 'not-a-repository', worktrees: [] }
tree = await settle57('s-57c')
ok('ok:false：标题行退成「工作树」+「读取失败」，一行灰说明「这里可能不是 git 仓库」',
  textOf(wtHead57(tree)).indexOf('工作树') >= 0 && textOf(wtHead57(tree)).indexOf('读取失败') >= 0
  && textOf(wtHead57(tree)).indexOf('工作树 6') < 0
  && wtRows57(tree).length === 1
  && textOf(wtRows57(tree)[0]).indexOf('无法读取工作树（这里可能不是 git 仓库）') >= 0)
fibers.clear()
wtReply = null
failWorktrees = true
tree = await settle57('s-57d')
ok('运输层失败走 catch 的占位：同样的灰说明行，面板照常画（分支树还在），不抛错',
  wtRows57(tree).length === 1
  && textOf(wtRows57(tree)[0]).indexOf('无法读取工作树（这里可能不是 git 仓库）') >= 0
  && byClass(tree, 'dsh-git-trow').length > 0)
failWorktrees = false

console.log('')
console.log('== 点击语义（单仓库）：onPickBranch(\'\', branch) —— 只过滤历史 ==')
fibers.clear()
tree = await settle57('s-57e')
const markPick = calls.length
wtRowOf57(tree, '/tmp/lab/feature one').props.onClick()
tree = await settle57('s-57e')
ok('单击行：git/graph 的 ref 跟到 feature/one，请求仍不带 repo（pickBranch(\'\') 那支）',
  lastCall57(markPick, 'git/graph') != null
  && lastCall57(markPick, 'git/graph').ref === 'feature/one'
  && lastCall57(markPick, 'git/graph').repo === undefined)
ok('单击只是过滤历史：工作树读数一次都没多发',
  callsOf57(markPick, 'git/worktrees').length === 0)
ok('● 跟着选择走：feature one 行亮、ws 行灭（activeRef 与分支树同一个值）',
  markOf57(wtRowOf57(tree, '/tmp/lab/feature one')) === '●' && markOf57(wtRowOf57(tree, '/tmp/ws')) === '')

console.log('')
console.log('== 点击语义（多选分组）：repo 传生效仓库，单击即收拢回单仓库 ==')
fibers.clear()
tree = await settle57('s-57f')
repoRow57(tree, '/tmp/ws/alpha').props.onClick({ ctrlKey: true })
await wait(10)
tree = await settle57('s-57f')
repoRow57(tree, '/tmp/ws/beta').props.onClick({ ctrlKey: true })
await wait(10)
tree = await settle57('s-57f')
ok('多选分组里工作树块仍在、行仍可点（它跟的是生效仓库，不进分组账）',
  wtBox57(tree) !== undefined && wtRows57(tree).length === 6
  && typeof wtRowOf57(tree, '/tmp/lab/feature one').props.onClick === 'function')
const markGroup = calls.length
wtRowOf57(tree, '/tmp/lab/feature one').props.onClick()
tree = await settle57('s-57f')
ok('单击行：git/graph 带生效仓库 /tmp/ws + ref feature/one（先 applyRepo 再选分支的那支）',
  lastCall57(markGroup, 'git/graph') != null
  && lastCall57(markGroup, 'git/graph').repo === '/tmp/ws'
  && lastCall57(markGroup, 'git/graph').ref === 'feature/one')

console.log('')
console.log('== 跟随生效仓库：切仓库后 git/worktrees 重发，参数与数据整份换 ==')
fibers.clear()
tree = await settle57('s-57g')
const markFollow = wtCalls.length
ok('切换前：行是 ws 罐头里的（feature one 在）', wtRowOf57(tree, '/tmp/lab/feature one') !== undefined)
repoRow57(tree, '/tmp/ws/alpha').props.onClick({})
await wait(10)
tree = await settle57('s-57g')
tree = await settle57('s-57g')
ok('单击 alpha 仓库行后 git/worktrees 恰好重发一次，请求 repo 跟着换成 /tmp/ws/alpha',
  wtCalls.length === markFollow + 1 && wtCalls[wtCalls.length - 1].repo === '/tmp/ws/alpha'
  && wtCalls[wtCalls.length - 1].sessionId === 's-57g')
ok('块的数据整份换新：alpha 罐头的行在（alpha-wt x），ws 罐头的行（feature one）不在了',
  wtRowOf57(tree, '/tmp/ws/alpha-wt x') !== undefined && wtRowOf57(tree, '/tmp/lab/feature one') === undefined
  && wtRows57(tree).length === 2)

console.log('')
console.log('== 侧栏位置：仓库块正下方、分支树行之前 ==')
fibers.clear()
tree = await settle57('s-57h')
const sideKids = (byClass(tree, 'dsh-git-side')[0].props.children || []).map((k) => String((k.props && k.props.className) || ''))
const atRepo = sideKids.findIndex((c) => c.indexOf('dsh-git-repo-box') >= 0)
const atWt = sideKids.findIndex((c) => c.indexOf('dsh-git-wt-box') >= 0)
const atBranch = sideKids.findIndex((c) => c.indexOf('dsh-git-trow') >= 0)
ok('从粗到细一列读完：仓库块 → 工作树块（紧贴其下）→ 分支树行',
  atRepo >= 0 && atWt === atRepo + 1 && atBranch > atWt)
