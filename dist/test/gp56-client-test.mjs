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
/* ═══ gp56：配置页项目档的多仓库（客户端这一半）═══
 *
 * 盯四片：
 *   1. 页首「仓库」组（24-repos.js RepoSwitcher 的受控单选变体，pane='config'）：
 *      清单与历史/变更页是同一份（扫描 + 生效仓库兜底）；受控模式没有「全部」行；
 *      行上的 ● 仍是生效仓库，底色选中行 = 本页正在编辑的仓库。
 *   2. 编辑目标（repoViews 按会话 + 'config' 格）：默认 = 生效仓库；单击行（连
 *      Ctrl+单击也是单击语义，不进多选）只换本页编辑目标 —— 快照与远端表立即重读，
 *      请求里明说 repo: <路径>（宿主 repoFrom 显式路径优先，缺省才回退会话工作区），
 *      sessionId 照旧带上；绝不改生效仓库：没有 git/repos-save 之外的写，历史页的
 *      ● 还在生效仓库上；名字/邮箱草稿切目标即清 —— 对着上一个仓库打的半截话不能
 *      被写进下一个；写答复落地时目标已切走的一个字节不上屏（targetBox 守着，
 *      10-state.js repoEpoch 同一个问题）。目标选择跨页签保留（按会话记的）。
 *   3. 「＋ 添加目录」与历史页同一份持久清单、同一套报错话术（saveManualRepo /
 *      repoSaveProblem）；加成功自动把新仓库选为本页目标；移除的正好是目标时退回
 *      生效仓库；missing 行只可移除、点它不发生任何事。
 *   4. 会话完成组保持插件级：自动推送仍作用于当前生效仓库，提示语照实说一句
 *      （不随本页正在编辑的仓库走）。
 *   5. 排版：受切换仓库影响的三个组收进「仓库」外框做下级（缩进 + 左侧竖线），
 *      组头点名目标仓库短名；切换器折叠标题行在配置页记本页编辑目标（✎），
 *      不再是生效仓库（●）。 */

/* ── mock：清单按用例给；身份/远端的答复按请求里的 repo 现做，才分得清「答的是谁」── */
let reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/lab', '/tmp/ws'], manual: [], missing: [], truncated: false }
let reposSaveReply = null
const reposSaveCalls = []
const projectSaveCalls = []
const remoteSaveCalls = []

const projectSnapshot = function (repo) {
  const lab = repo === '/tmp/lab'
  return { ok: true, repo: repo, insideRepo: true, config: {
    'user.name': { local: lab ? 'Lab' : '', global: 'Ada', effective: lab ? 'Lab' : 'Ada',
      localOrigin: lab ? '.git/config' : '', globalOrigin: '~/.gitconfig', effectiveOrigin: lab ? '.git/config' : '~/.gitconfig' },
    'user.email': { local: '', global: 'ada@example.com', effective: 'ada@example.com',
      localOrigin: '', globalOrigin: '~/.gitconfig', effectiveOrigin: '~/.gitconfig' },
    'core.autocrlf': { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' },
    'core.safecrlf': { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' },
  } }
}
/* 与 host 侧 projectConfigSave 同一条「写后回读」的约定：答复 = 新快照 + written/unset。 */
const projectSaveReply = function (args) {
  const snap = projectSnapshot(args != null ? args.repo : undefined)
  const set = args != null && args.set != null && typeof args.set === 'object' ? args.set : {}
  const keys = Object.keys(set)
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    if (snap.config[key] === undefined) continue
    snap.config[key] = Object.assign({}, snap.config[key],
      { local: set[key], effective: set[key], localOrigin: '.git/config', effectiveOrigin: '.git/config' })
  }
  return Object.assign({ written: keys, unset: [] }, snap)
}
const remotesFor = function (repo) {
  const lab = repo === '/tmp/lab'
  return { ok: true, repo: repo, insideRepo: true, remotes: lab
    ? [{ name: 'up', url: 'https://example.com/lab.git', pushUrl: '' }]
    : [{ name: 'origin', url: 'https://example.com/ws.git', pushUrl: '' }] }
}
/* 「git 忽略项」组只扫编辑目标这一个仓库（请求的 repos 只有一个元素）；应答按
   请求现做 —— 报告自报仓库路径，组件靠它认「眼前这份扫描是谁的」。 */
const ignoredScanReply = function (args) {
  const repo = args != null && Array.isArray(args.repos) && args.repos.length > 0 ? args.repos[0] : ''
  return { ok: true, repos: [{ path: repo, ok: true, reason: '', worktrees: [
    { path: repo, main: true, branch: 'main', ok: true, reason: '', truncated: false,
      items: [{ path: 'build/cache/', dir: true }, { path: 'tmp.log', dir: false }] },
  ] }], truncated: false, timedOut: false }
}
const realCall56 = host.call
host.call = function (method, args) {
  if (method === 'git/repos') { calls.push({ method: method, args: args }); return Promise.resolve(reposReply) }
  if (method === 'git/repos-save') { calls.push({ method: method, args: args }); reposSaveCalls.push(args); return Promise.resolve(reposSaveReply) }
  if (method === 'git/project-config') { calls.push({ method: method, args: args }); return Promise.resolve(projectSnapshot(args != null ? args.repo : undefined)) }
  if (method === 'git/project-config-save') { calls.push({ method: method, args: args }); projectSaveCalls.push(args); return Promise.resolve(projectSaveReply(args)) }
  if (method === 'git/remotes') { calls.push({ method: method, args: args }); return Promise.resolve(remotesFor(args != null ? args.repo : undefined)) }
  if (method === 'git/remotes-save') { calls.push({ method: method, args: args }); remoteSaveCalls.push(args); return Promise.resolve(remotesFor(args != null ? args.repo : undefined)) }
  if (method === 'git/ignored-scan') { calls.push({ method: method, args: args }); return Promise.resolve(ignoredScanReply(args)) }
  return realCall56(method, args)
}

/* ── 取景工具 ── */
const hasClass56 = (n, s) => n.props != null && typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(s) >= 0
const saysOn = (t, s) => collect(t).some((n) => hasClass56(n, 'dsh-git-set-hint') && textOf(n).indexOf(s) >= 0)
const repoRows = (t) => byClass(t, 'dsh-git-repo-row')
const repoRowOf = (t, path) => repoRows(t).find((r) => typeof r.props.title === 'string' && r.props.title.indexOf(path) === 0)
const callsOf56 = (mark, method) => calls.slice(mark).filter((c) => c.method === method)
const lastArgs = (method) => { const list = calls.filter((c) => c.method === method); return list.length > 0 ? list[list.length - 1].args : undefined }
const rowInput56 = (t, label) => {
  const row = collect(t).find((n) => hasClass56(n, 'dsh-git-set-row') && textOf(n).indexOf(label) >= 0)
  return row === undefined ? undefined : collect(row).find((n) => n.type === 'input')
}
const clickText56 = async function (t, label) {
  const hit = buttons(t).find((b) => textOf(b) === label)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
  return await settle()
}
const openConfigOn56 = async function (label, sid) {
  let t = null
  for (let i = 0; i < 4; i += 1) { t = await renderUntilStable(makeElement(popover, { sessionId: sid }), label); await wait(10) }
  const cfg = buttons(t).find((b) => textOf(b) === '配置')
  if (cfg === undefined) throw new Error('点不到「配置」页签')
  cfg.props.onClick()
  for (let i = 0; i < 4; i += 1) { t = await renderUntilStable(makeElement(popover, { sessionId: sid }), label); await wait(10) }
  return t
}

console.log('')
console.log('== 页首「仓库」组：同一份清单，受控单选，没有「全部」 ==')
let tree = await openPanel()
let mark56 = calls.length
tree = await clickText56(tree, '配置')
ok('组头在：「仓库（这一页在编辑哪个仓库）」',
  collect(tree).some((n) => hasClass56(n, 'dsh-git-set-group') && textOf(n) === '仓库（这一页在编辑哪个仓库）'))
ok('说明行把规矩说全：编辑目标是这里选中的仓库、默认生效仓库、加目录的出路',
  saysOn(tree, '默认是当前生效仓库') && saysOn(tree, '不跟着换') && saysOn(tree, '＋ 添加目录'))
ok('扫描到的两个仓库各一行（生效仓库已扫到，不重复种）',
  repoRowOf(tree, '/tmp/lab') !== undefined && repoRowOf(tree, '/tmp/ws') !== undefined && repoRows(tree).length === 2)
ok('受控单选没有「全部」行（配置一次只写得了一个仓库）',
  repoRows(tree).every((r) => typeof r.props.title !== 'string' || r.props.title.indexOf('一起显示') !== 0))
ok('默认编辑目标 = 生效仓库：选中行与 ● 都在 /tmp/ws 上',
  hasClass56(repoRowOf(tree, '/tmp/ws'), 'dsh-git-repo-sel') && hasClass56(repoRowOf(tree, '/tmp/ws'), 'dsh-git-repo-cur')
  && hasClass56(repoRowOf(tree, '/tmp/lab'), 'dsh-git-repo-sel') !== true)
ok('进页读快照与远端表都明说 repo:/tmp/ws + 会话',
  callsOf56(mark56, 'git/project-config').length === 1 && lastArgs('git/project-config').repo === '/tmp/ws'
  && lastArgs('git/project-config').sessionId === 's-1'
  && callsOf56(mark56, 'git/remotes').length === 1 && lastArgs('git/remotes').repo === '/tmp/ws')

console.log('')
console.log('== 新排版：「仓库」外框内收四个下级组，组头点名目标短名 ==')
const scopeBox56 = () => byClass(tree, 'dsh-git-set-scope')[0]
const scopeBody56 = () => byClass(tree, 'dsh-git-set-scope-body')[0]
const subGroups56 = () => (scopeBody56() === undefined ? [] : byClass(scopeBody56(), 'dsh-git-set-group').map(textOf))
const subJoin56 = () => subGroups56().join('|')
ok('外框在：仓库切换器与下级容器都收在它里面',
  scopeBox56() !== undefined && byClass(scopeBox56(), 'dsh-git-repo-box').length === 1
  && byClass(scopeBox56(), 'dsh-git-set-scope-body').length === 1)
ok('四个下级组（提交身份/远端/换行符/git 忽略项）都在 scope-body 里；会话完成组留在外框外',
  subGroups56().length === 4
  && subGroups56().some((s) => s.indexOf('提交身份') === 0)
  && subGroups56().some((s) => s.indexOf('远端') === 0)
  && subGroups56().some((s) => s.indexOf('换行符') === 0)
  && subGroups56().some((s) => s.indexOf('git 忽略项') === 0)
  && collect(tree).some((n) => hasClass56(n, 'dsh-git-set-group') && textOf(n) === '会话完成')
  && byClass(scopeBox56(), 'dsh-git-set-group').every((g) => textOf(g) !== '会话完成'))
ok('四个组头都点名当前目标短名（/tmp/ws → ws），只读的忽略项组也点名',
  subJoin56().indexOf('提交身份（只写 ws 的 .git/config）') >= 0
  && subJoin56().indexOf('远端（ws 的 remote 清单）') >= 0
  && subJoin56().indexOf('换行符（ws 的 git 换行配置）') >= 0
  && subJoin56().indexOf('git 忽略项（只读 ws）') >= 0)
mark56 = calls.length
tree = await clickText56(tree, '扫描忽略项')
ok('扫描只发编辑目标这一个仓库（repos=[/tmp/ws]，不再是整份清单）',
  callsOf56(mark56, 'git/ignored-scan').length === 1 && Array.isArray(lastArgs('git/ignored-scan').repos)
  && lastArgs('git/ignored-scan').repos.length === 1 && lastArgs('git/ignored-scan').repos[0] === '/tmp/ws')
ok('扫完不再有仓库层折叠头：工作树一行直接上屏报 2 项',
  collect(tree).filter((n) => hasClass56(n, 'dsh-git-ign-repo-head')).length === 0
  && collect(tree).some((n) => hasClass56(n, 'dsh-git-ign-wt') && textOf(n).indexOf('2 项') >= 0))
const wtRow56 = collect(tree).find((n) => hasClass56(n, 'dsh-git-ign-wt'))
wtRow56.props.onClick()
tree = await settle()
ok('点开工作树行：2 条忽略项上屏（默认收起，条目要点开看）',
  collect(tree).filter((n) => hasClass56(n, 'dsh-git-ign-item')).length === 2)

console.log('')
console.log('== 单击行只换本页编辑目标：Ctrl+单击也是单击，生效仓库不动，草稿清空 ==')
const nameBox56 = () => rowInput56(tree, '名字（user.name）')
nameBox56().props.onChange({ target: { value: 'Draft' } })
tree = await settle()
mark56 = calls.length
repoRowOf(tree, '/tmp/lab').props.onClick({ ctrlKey: true, metaKey: false })
tree = await settle()
ok('Ctrl+单击 /tmp/lab：快照与远端表都改问 /tmp/lab（多选模式才会只改高亮不发读）',
  callsOf56(mark56, 'git/project-config').length === 1 && lastArgs('git/project-config').repo === '/tmp/lab'
  && callsOf56(mark56, 'git/remotes').length === 1 && lastArgs('git/remotes').repo === '/tmp/lab')
ok('选中行换到 /tmp/lab，● 仍在生效仓库 /tmp/ws 上',
  hasClass56(repoRowOf(tree, '/tmp/lab'), 'dsh-git-repo-sel')
  && hasClass56(repoRowOf(tree, '/tmp/ws'), 'dsh-git-repo-cur')
  && hasClass56(repoRowOf(tree, '/tmp/ws'), 'dsh-git-repo-sel') !== true)
ok('「此刻生效」跟着换了仓库：Lab（来自 .git/config）', saysOn(tree, 'Lab（来自 .git/config）'))
ok('对着上一个仓库打的草稿被清空（不留给下一个仓库误写）',
  nameBox56() !== undefined && nameBox56().props.value === '')
ok('远端表也换了仓库：lab 的远端是 up', saysOn(tree, 'https://example.com/lab.git'))
ok('组头跟着换目标：四个组头改点名 lab（忽略项组也在内）',
  subJoin56().indexOf('提交身份（只写 lab 的 .git/config）') >= 0
  && subJoin56().indexOf('远端（lab 的 remote 清单）') >= 0
  && subJoin56().indexOf('换行符（lab 的 git 换行配置）') >= 0
  && subJoin56().indexOf('git 忽略项（只读 lab）') >= 0)
ok('换了目标旧扫描作废：ws 的忽略项不再上屏，回到「还没扫描过」',
  collect(tree).some((n) => hasClass56(n, 'dsh-git-ign-item')) !== true
  && saysOn(tree, '还没扫描过'))
mark56 = calls.length
tree = await clickText56(tree, '扫描忽略项')
ok('再扫只发新目标（repos=[/tmp/lab]）',
  callsOf56(mark56, 'git/ignored-scan').length === 1 && Array.isArray(lastArgs('git/ignored-scan').repos)
  && lastArgs('git/ignored-scan').repos.length === 1 && lastArgs('git/ignored-scan').repos[0] === '/tmp/lab')
ok('没碰任何持久化（清单的 add/remove 一次都没发）', reposSaveCalls.length === 0)

console.log('')
console.log('== 折叠标题行（pick 模式）：记本页编辑目标 ✎，不是生效仓库 ==')
byClass(tree, 'dsh-git-repo-head')[0].props.onClick()
tree = await settle()
const foldNow56 = byClass(tree, 'dsh-git-repo-now')[0]
ok('收起后标题是 ✎ lab（本页编辑目标），不是 ● ws（生效仓库）',
  foldNow56 !== undefined && textOf(foldNow56) === '✎ lab'
  && String(foldNow56.props.title).indexOf('/tmp/lab') === 0)
byClass(tree, 'dsh-git-repo-head')[0].props.onClick()
tree = await settle()
ok('再点展开，仓库行都回来（后面的用例不受影响）', repoRows(tree).length === 2)

console.log('')
console.log('== 写入落到编辑目标：请求带 repo，答复回读为准 ==')
nameBox56().props.onChange({ target: { value: 'LabName' } })
tree = await settle()
const writeBtn = () => buttons(tree).find((b) => textOf(b) === '写入本项目')
ok('按钮 title 明说写进哪个仓库', String(writeBtn().props.title).indexOf('/tmp/lab') >= 0)
writeBtn().props.onClick()
tree = await settle()
ok('发的是 git/project-config-save + repo:/tmp/lab + 会话',
  projectSaveCalls.length === 1 && projectSaveCalls[0].repo === '/tmp/lab'
  && projectSaveCalls[0].sessionId === 's-1'
  && JSON.stringify(projectSaveCalls[0].set) === JSON.stringify({ 'user.name': 'LabName' }))
ok('提示行带 Host 回读的落点：已写进 /tmp/lab 的 .git/config', saysOn(tree, '已写进 /tmp/lab 的 .git/config'))
ok('框里是答复的 local 值（写后回读，不回显输入）', nameBox56().props.value === 'LabName')

console.log('')
console.log('== ＋ 添加目录：同一份持久清单、同一套话术，加完自动选中 ==')
const addRow56 = () => byClass(tree, 'dsh-git-repo-add')[0]
addRow56().props.onClick()
tree = await settle()
const addInput = () => byClass(tree, 'dsh-git-repo-input')[0]
const addOk = () => buttons(tree).find((b) => textOf(b) === '添加')
ok('输入行出现了，空框时「添加」禁用', addInput() !== undefined && addOk().props.disabled === true)
addInput().props.onChange({ target: { value: '/tmp/third' } })
tree = await settle()
reposSaveReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/lab', '/tmp/third', '/tmp/ws'], manual: ['/tmp/third'], missing: [], truncated: false }
addOk().props.onClick()
tree = await settle()
ok('走的是 git/repos-save：{sessionId, add}，不带 repo（清单跟随项目，不由编辑目标决定）',
  reposSaveCalls.length === 1 && reposSaveCalls[0].sessionId === 's-1' && reposSaveCalls[0].add === '/tmp/third'
  && reposSaveCalls[0].repo === undefined && reposSaveCalls[0].remove === undefined)
ok('新行出现了，并且自动成为本页编辑目标（快照改问 /tmp/third）',
  repoRowOf(tree, '/tmp/third') !== undefined && hasClass56(repoRowOf(tree, '/tmp/third'), 'dsh-git-repo-sel')
  && lastArgs('git/project-config').repo === '/tmp/third' && lastArgs('git/remotes').repo === '/tmp/third')

console.log('')
console.log('== ＋ 添加目录：失败走 repoSaveProblem 的同一套话术 ==')
addRow56().props.onClick()
tree = await settle()
addInput().props.onChange({ target: { value: '/tmp/plain' } })
tree = await settle()
reposSaveReply = { ok: false, error: 'not-a-repository' }
addOk().props.onClick()
tree = await settle()
ok('输入框下面一句人话：这个目录不是 git 仓库（与历史页同一套 repoSaveProblem）',
  byClass(tree, 'dsh-git-repo-problem').length === 1
  && textOf(byClass(tree, 'dsh-git-repo-problem')[0]).indexOf('这个目录不是 git 仓库') >= 0)

console.log('')
console.log('== 写答复落地时目标已切走：一个字节不上屏 ==')
repoRowOf(tree, '/tmp/ws').props.onClick({})
tree = await settle()
nameBox56().props.onChange({ target: { value: 'Stale' } })
tree = await settle()
writeBtn().props.onClick()
repoRowOf(tree, '/tmp/lab').props.onClick({})
tree = await settle()
ok('写确实发出去了（repo 是点击时的 /tmp/ws）',
  projectSaveCalls.length === 2 && projectSaveCalls[1].repo === '/tmp/ws')
ok('答复落地时目标已是 /tmp/lab：草稿保持清空、提示与错误一个字都没有',
  nameBox56().props.value === '' && saysOn(tree, '已写进 /tmp/ws') !== true
  && byClass(tree, 'dsh-git-error').length === 0)
ok('屏上是新目标的快照：Lab（来自 .git/config）', saysOn(tree, 'Lab（来自 .git/config）'))

console.log('')
console.log('== 生效仓库不动：历史页的 ● 还在 /tmp/ws 上 ==')
tree = await clickText56(tree, '历史')
const curRows = byClass(tree, 'dsh-git-repo-cur')
ok('历史页侧栏的 ● 仍是 /tmp/ws（配置页的单击不换生效仓库）',
  curRows.length === 1 && String(curRows[0].props.title).indexOf('/tmp/ws') === 0)
ok('历史页侧栏仍是多选模式：「全部」行在（受控单选只属于配置页那一格）',
  byClass(tree, 'dsh-git-repo-row').some((r) => textOf(r).indexOf('全部') === 0))
tree = await clickText56(tree, '配置')
ok('切回配置页：编辑目标还是 /tmp/lab（按会话记的，跨页签保留）',
  hasClass56(repoRowOf(tree, '/tmp/lab'), 'dsh-git-repo-sel') && lastArgs('git/project-config').repo === '/tmp/lab')

console.log('')
console.log('== 新会话：missing 行只可移除、不可选中；移除的正是目标时退回生效仓库 ==')
/* 独立会话另给一份清单：手动登记的 /tmp/lab（行上才有 ×）+ 一个已不存在的路径。 */
reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/lab', '/tmp/ws'], manual: ['/tmp/lab'], missing: ['/tmp/gone'], truncated: false }
let treeB = await openConfigOn56('gp56-b', 's-56b')
const goneRow = repoRowOf(treeB, '/tmp/gone')
ok('「已不存在」行压暗、不带单击（点了也不会发任何读）',
  goneRow !== undefined && hasClass56(goneRow, 'dsh-git-repo-gone')
  && textOf(goneRow).indexOf('已不存在') >= 0 && goneRow.props.onClick === undefined)
treeB = await openConfigOn56('gp56-b2', 's-56b')
repoRowOf(treeB, '/tmp/lab').props.onClick({})
treeB = await openConfigOn56('gp56-b3', 's-56b')
ok('手动登记的 /tmp/lab 选中为本页目标（快照改问它）', lastArgs('git/project-config').repo === '/tmp/lab')
const labX = collect(repoRowOf(treeB, '/tmp/lab')).find((n) => n.type === 'button' && textOf(n) === '×')
ok('手动仓库行上有 ×（扫描来的行没有）',
  labX !== undefined && collect(repoRowOf(treeB, '/tmp/ws')).every((n) => !(n.type === 'button' && textOf(n) === '×')))
reposSaveReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws'], manual: [], missing: ['/tmp/gone'], truncated: false }
const markSaveB = reposSaveCalls.length
labX.props.onClick({})
treeB = await openConfigOn56('gp56-b4', 's-56b')
ok('移除发的是 remove，答复把行拿掉',
  reposSaveCalls.length === markSaveB + 1 && reposSaveCalls[markSaveB].sessionId === 's-56b'
  && reposSaveCalls[markSaveB].remove === '/tmp/lab'
  && repoRowOf(treeB, '/tmp/lab') === undefined)
ok('移除的正好是本页目标：编辑目标退回生效仓库 /tmp/ws（快照与远端跟着改问）',
  lastArgs('git/project-config').repo === '/tmp/ws' && lastArgs('git/remotes').repo === '/tmp/ws'
  && hasClass56(repoRowOf(treeB, '/tmp/ws'), 'dsh-git-repo-sel'))

console.log('')
console.log('== 会话完成组保持插件级：自动推送仍作用于生效仓库，照实说 ==')
ok('推送提示带那句「不随本页正在编辑的仓库走」', saysOn(treeB, '不随本页正在编辑的仓库走'))
ok('推送提示仍旧说清生效仓库与只推条件', saysOn(treeB, '对当前生效仓库执行一次 push') && saysOn(treeB, '领先远端且没有未解决冲突'))
const refreshRow56 = collect(treeB).find((n) => hasClass56(n, 'dsh-git-set-row') && textOf(n).indexOf('会话完成时刷新') >= 0)
ok('开关还是插件级那对：会话完成刷新的勾选框原样在', refreshRow56 !== undefined
  && collect(refreshRow56).some((n) => n.type === 'input' && n.props.type === 'checkbox'))
