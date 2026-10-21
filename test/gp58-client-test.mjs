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
/* ═══ gp58：历史页右键与多选（客户端这一半）═══
 *
 * 盯三片：
 *   1. 新外置的纯函数（80-panel.js 组件外那四个，从产物 client.js 里整段抽出来
 *      单独求值 —— gp50 对 53-merge3 的抽法）：ctxTargetHashes（右键动作的目标集：
 *      右键行在多选里且多选>1 = 整份 multiSel，否则右键那一条；返回的是拷贝）；
 *      graphSliceBetween（Shift 范围：锚点↔点击行按图序整段含两端，谁新谁旧都行，
 *      任一行不在眼前列表 = null 不猜）；selectionSpan（选区的「段」：图序 targets、
 *      连续与否看 parents 链、base=最旧一条的第一父、head=最新；选区有行不在图上
 *      或不足两条 = null）；hashShort（7 位短写）。
 *   2. Shift+点击范围多选（面板世界）：锚点→点击行整段含两端、selected 跟点击行、
 *      浏览器默认行为被拦下（preventDefault）；锚点不动 —— 连续两次扩选都从同一
 *      锚点算起；shift+ctrl 仍是 Ctrl 的逐条加减；无锚点（新挂的面板）与锚点行
 *      已不在图上（重读历史换段）都退化为普通单选，且把这一行立成新锚点。
 *   3. 菜单按选区收放：右键行在多选里 = 体检问整份选区、拣选/还原标「（n 条）」、
 *      发参按最旧→最新交出去；右键行不在多选 = 单条；「编辑提交消息…」要等体检
 *      （git/edit-check）答复落定才解禁 —— 右键后不落 await 的同步帧里必须还是
 *      置灰、title 说「正在检查」；答复 reachable=false 的那一行保持置灰并说出
 *      原因。 */

/* ── mock：图与体检答复都按段落给 ── */
const realCall58 = host.call
let editCheckReply58 = null
const editCheckCalls58 = []
host.call = function (method, args) {
  if (method === 'git/edit-check') {
    calls.push({ method: method, args: args })
    editCheckCalls58.push(args)
    const hashes = args != null && Array.isArray(args.hashes) ? args.hashes : []
    if (editCheckReply58 !== null) return Promise.resolve(editCheckReply58)
    return Promise.resolve({
      ok: true, repo: '/tmp/ws', head: 'h111111',
      checks: hashes.map((hash) => ({ hash: hash, reachable: true, pushed: false, isHead: hash === 'h111111', isRoot: hash === 'h444444' })),
    })
  }
  return realCall58(method, args)
}

/* graphCommits 是 harness 里 let 声明的模块变量：这里铺一条四提交的链，parents
 * 与真实图同形（新→旧：h1 是 HEAD，h1 的父是 h2 ……）。 */
graphCommits = [
  { hash: 'h111111', subject: 'tip one', author: 'mays', date: '2026-10-16', committedAt: nowSec - 60, refs: ['HEAD -> main'], parents: ['h222222'] },
  { hash: 'h222222', subject: 'two', author: 'mays', date: '2026-10-15', committedAt: nowSec - 3600, refs: [], parents: ['h333333'] },
  { hash: 'h333333', subject: 'three', author: 'mays', date: '2026-10-14', committedAt: nowSec - 7200, refs: [], parents: ['h444444'] },
  { hash: 'h444444', subject: 'root four', author: 'mays', date: '2026-10-13', committedAt: nowSec - 10800, refs: [], parents: [] },
]

console.log('')
console.log('== 产物里抽出来的纯函数：目标集 / 范围 / 选区段 ==')
const sourceText58 = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
const pureSource58 = sourceText58.slice(sourceText58.indexOf('function ctxTargetHashes'), sourceText58.indexOf('const panelAnchorBox'))
const pure58 = new Function('text', pureSource58
  + '; return { ctxTargetHashes: ctxTargetHashes, graphSliceBetween: graphSliceBetween, selectionSpan: selectionSpan, hashShort: hashShort }')(
  (value) => (value == null ? '' : String(value)))
const CHAIN = graphCommits

ok('四个函数都在产物里，且组件外只有这一份定义',
  typeof pure58.ctxTargetHashes === 'function' && typeof pure58.graphSliceBetween === 'function'
  && typeof pure58.selectionSpan === 'function' && typeof pure58.hashShort === 'function'
  && (sourceText58.match(/function ctxTargetHashes/g) || []).length === 1)

{
  const multi = ['h111111', 'h333333']
  const picked = pure58.ctxTargetHashes('h333333', multi)
  ok('右键行在多选里且多选>1：目标集 = 整份 multiSel（原序拷贝，不是同一个数组）',
    JSON.stringify(picked) === JSON.stringify(['h111111', 'h333333']) && picked !== multi)
  picked.push('x')
  ok('改返回值不动调用方的 multiSel（slice 出去的）', JSON.stringify(multi) === JSON.stringify(['h111111', 'h333333']))
  ok('右键行不在多选里：目标集就是右键那一条',
    JSON.stringify(pure58.ctxTargetHashes('h222222', multi)) === JSON.stringify(['h222222']))
  ok('multiSel 为空 / 只有一条：都是单条',
    JSON.stringify(pure58.ctxTargetHashes('h111111', [])) === JSON.stringify(['h111111'])
    && JSON.stringify(pure58.ctxTargetHashes('h111111', ['h111111'])) === JSON.stringify(['h111111'])
    && JSON.stringify(pure58.ctxTargetHashes('h111111', undefined)) === JSON.stringify(['h111111']))
}

{
  ok('范围按图序整段含两端：锚点新、点击旧（h2→h4 = [h2,h3,h4]）',
    JSON.stringify(pure58.graphSliceBetween(CHAIN, 'h222222', 'h444444')) === JSON.stringify(['h222222', 'h333333', 'h444444']))
  ok('反着点也一样：锚点旧、点击新（h3→h1 = [h1,h2,h3]）',
    JSON.stringify(pure58.graphSliceBetween(CHAIN, 'h333333', 'h111111')) === JSON.stringify(['h111111', 'h222222', 'h333333']))
  ok('点在锚点自己身上：单元素段', JSON.stringify(pure58.graphSliceBetween(CHAIN, 'h222222', 'h222222')) === JSON.stringify(['h222222']))
  ok('任一行不在眼前列表：null（调用方退化单选，不猜）',
    pure58.graphSliceBetween(CHAIN, 'gone', 'h111111') === null
    && pure58.graphSliceBetween(CHAIN, 'h111111', 'gone') === null)
  ok('列表本身不是数组：null', pure58.graphSliceBetween(null, 'h111111', 'h222222') === null)
}

{
  const span = pure58.selectionSpan(CHAIN, ['h222222', 'h333333'])
  ok('连续两跳：targets 按图序、contiguous=true、base=最旧一条的第一父、head=最新',
    JSON.stringify(span.targets) === JSON.stringify(['h222222', 'h333333'])
    && span.contiguous === true && span.base === 'h444444' && span.head === 'h222222')
  ok('乱序的 multiSel 也按图序整理（targets 只含选中的，不含中间未选的）',
    JSON.stringify(pure58.selectionSpan(CHAIN, ['h333333', 'h111111']).targets) === JSON.stringify(['h111111', 'h333333']))
  ok('中间隔一条未选：contiguous=false（parents 链断在没选的那条上）',
    pure58.selectionSpan(CHAIN, ['h111111', 'h333333']).contiguous === false)
  ok('选区里混着图上没有的行：null（合并查看与整段改写都不开）',
    pure58.selectionSpan(CHAIN, ['h111111', 'gone']) === null)
  ok('不足两条 / commits 不是数组：null',
    pure58.selectionSpan(CHAIN, ['h111111']) === null && pure58.selectionSpan(CHAIN, []) === null
    && pure58.selectionSpan(null, ['h111111', 'h222222']) === null)
  ok('最旧一条是根提交：base 为空串（整段改写无从谈起的信号）',
    pure58.selectionSpan(CHAIN, ['h333333', 'h444444']).base === '')
  ok('图上缺 parents 字段：按不连续算（不猜）',
    pure58.selectionSpan([{ hash: 'a' }, { hash: 'b' }], ['a', 'b']).contiguous === false)
}

ok('hashShort：7 位短写、短的照抄、空值归空串',
  pure58.hashShort('abc1234567') === 'abc1234' && pure58.hashShort('abc123') === 'abc123'
  && pure58.hashShort(null) === '' && pure58.hashShort(undefined) === '')

console.log('')
console.log('== Shift+点击范围多选：锚点、整段、退化 ==')
fibers.clear()
let t58 = await openPanel()
const crow58 = () => byClass(t58, 'dsh-git-crow')
const multi58 = () => byClass(t58, 'dsh-git-crow-multi')
const sel58 = () => byClass(t58, 'dsh-git-crow-sel')
const prevent = () => { let hit = false; return { event: { shiftKey: true, preventDefault() { hit = true } }, fired: () => hit } }

crow58()[1].props.onClick()
await wait(10)
t58 = await settle('pop')
ok('先普通点击 h2：单选（它同时是锚点）', sel58().length === 1 && multi58().length === 0)
const shiftEv = prevent()
crow58()[3].props.onClick(Object.assign({ shiftKey: true }, shiftEv.event, {}))
await wait(10)
t58 = await settle('pop')
ok('Shift+点击 h4：h2..h4 整段进多选（含两端，三行都带强调条）', multi58().length === 3)
ok('selected 跟点击行（h4），详情也跟着它走',
  sel58().length === 1 && textOf(sel58()[0]).indexOf('root four') >= 0
  && calls.filter((c) => c.method === 'git/commit-detail').slice(-1)[0].args.hash === 'h444444')
ok('浏览器的「扩展文字选区」被拦下（preventDefault 真的被调了）', shiftEv.fired() === true)

const shiftEv2 = prevent()
crow58()[0].props.onClick(Object.assign({ shiftKey: true }, shiftEv2.event, {}))
await wait(10)
t58 = await settle('pop')
ok('锚点不动：再 Shift+点击 h1，段是从 h2 算起的 [h1,h2]（不是从 h4）',
  multi58().length === 2 && textOf(crow58()[0]).indexOf('tip one') >= 0 && textOf(crow58()[1]).indexOf('two') >= 0
  && byClass(crow58()[2], 'dsh-git-crow-multi').length === 0)

crow58()[2].props.onClick({ shiftKey: true, ctrlKey: true })
await wait(10)
t58 = await settle('pop')
ok('shift+ctrl 还是 Ctrl 的语义：h3 单条进出多选，不拉一段',
  multi58().length === 3)

/* 无锚点的退化：新挂的面板第一下 Shift+点击就是普通单选。 */
fibers.clear()
graphCommits = [
  { hash: 'h111111', subject: 'tip one', author: 'mays', date: '2026-10-16', committedAt: nowSec - 60, refs: ['HEAD -> main'], parents: ['h222222'] },
  { hash: 'h222222', subject: 'two', author: 'mays', date: '2026-10-15', committedAt: nowSec - 3600, refs: [], parents: [] },
]
t58 = await openPanel()
crow58()[1].props.onClick({ shiftKey: true })
await wait(10)
t58 = await settle('pop')
ok('无锚点的新面板：Shift+点击退化为单选（还把这一行立成锚点）',
  multi58().length === 0 && sel58().length === 1 && textOf(sel58()[0]).indexOf('two') >= 0)

/* 锚点行不在图上了：重读历史换段之后，Shift 扩选不猜，退化为普通单选。 */
crow58()[0].props.onClick()
await wait(10)
t58 = await settle('pop')
graphCommits = [
  { hash: 'h111111', subject: 'tip one', author: 'mays', date: '2026-10-16', committedAt: nowSec - 60, refs: ['HEAD -> main'], parents: [] },
]
const refresh58 = byClass(t58, 'dsh-git-tool').find((b) => String(b.props.title).indexOf('重新读取仓库') === 0)
refresh58.props.onClick()
await wait(15)
t58 = await settle('pop')
ok('（铺垫）重读后图上只剩 h1，锚点 h2 已不在', crow58().length === 1 && multi58().length === 0)
crow58()[0].props.onClick({ shiftKey: true })
await wait(10)
t58 = await settle('pop')
ok('锚点行不在图上：Shift+点击退化单选（锚点挪到这一行，不猜一段）',
  multi58().length === 0 && sel58().length === 1)

console.log('')
console.log('== 菜单按选区收放：目标集、体检与置灰 ==')
fibers.clear()
graphCommits = [
  { hash: 'h111111', subject: 'tip one', author: 'mays', date: '2026-10-16', committedAt: nowSec - 60, refs: ['HEAD -> main'], parents: ['h222222'] },
  { hash: 'h222222', subject: 'two', author: 'mays', date: '2026-10-15', committedAt: nowSec - 3600, refs: [], parents: ['h333333'] },
  { hash: 'h333333', subject: 'three', author: 'mays', date: '2026-10-14', committedAt: nowSec - 7200, refs: [], parents: ['h444444'] },
  { hash: 'h444444', subject: 'root four', author: 'mays', date: '2026-10-13', committedAt: nowSec - 10800, refs: [], parents: [] },
]
t58 = await openPanel()
const ctxMenus58 = () => byClass(t58, 'dsh-git-menu')
const ctxItems58 = () => { const m = ctxMenus58()[0]; return m === undefined ? [] : buttons(m) }
const item58 = (label) => ctxItems58().find((b) => textOf(b) === label)
const rightClick58 = async (i) => {
  byClass(t58, 'dsh-git-crow')[i].props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 30, clientY: 40 })
  await wait(15)
  t58 = await settle('pop')
}

crow58()[1].props.onClick({ ctrlKey: true })
await wait(10)
t58 = await settle('pop')
crow58()[2].props.onClick({ ctrlKey: true })
await wait(10)
t58 = await settle('pop')
ok('铺垫：Ctrl 两行进多选（h2 + h3，图上连续的一段）', multi58().length === 2)
editCheckCalls58.length = 0
await rightClick58(2)
ok('右键行在多选里：体检问的是整份选区（[h222222, h333333]）',
  JSON.stringify(editCheckCalls58[editCheckCalls58.length - 1].hashes) === JSON.stringify(['h222222', 'h333333']))
ok('拣选/还原标出「（2 条）」；发参把选区按最旧→最新交出去（h333333 在前）',
  item58('拣选（2 条）') !== undefined && item58('还原（2 条）') !== undefined
  && item58('打标签…') !== undefined)
calls.length = 0
item58('拣选（2 条）').props.onClick({ stopPropagation() {} })
await wait(15)
t58 = await settle('pop')
const seqCalls58 = calls.filter((c) => c.method === 'git/sequence')
ok('拣选（2 条）发 targets 数组：[h333333, h222222]（图序反过来，最旧的先落）',
  seqCalls58.length === 1 && seqCalls58[0].args.op === 'cherry-pick'
  && JSON.stringify(seqCalls58[0].args.targets) === JSON.stringify(['h333333', 'h222222'])
  && seqCalls58[0].args.target === undefined)

crow58()[3].props.onClick({ ctrlKey: true })
await wait(10)
t58 = await settle('pop')
crow58()[2].props.onClick({ ctrlKey: true })
await wait(10)
t58 = await settle('pop')
ok('铺垫：多选换成 h2 + h4（中间隔着 h3，不连续）—— Ctrl 加 h4、移出 h3',
  multi58().length === 2 && byClass(crow58()[2], 'dsh-git-crow-multi').length === 0
  && byClass(crow58()[3], 'dsh-git-crow-multi').length === 1)
editCheckCalls58.length = 0
await rightClick58(3)
ok('右键行在多选里：体检照旧问整份（不连续也算选区）',
  JSON.stringify(editCheckCalls58[editCheckCalls58.length - 1].hashes) === JSON.stringify(['h222222', 'h444444']))

/* 体检答复没回来时的那一帧：右键后一个 await 都不落，同步渲一帧。 */
editCheckReply58 = { ok: false, stderr: 'boom' }
byClass(t58, 'dsh-git-crow')[1].props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 50, clientY: 60 })
const pendingFrame58 = renderRoot(makeElement(popover, { sessionId: 's-1' }), 'pop')
const pendingItem58 = buttons(byClass(pendingFrame58, 'dsh-git-menu')[0]).find((b) => textOf(b) === '编辑提交消息…')
ok('体检没回来：「编辑提交消息…」置灰，title 说正在检查',
  pendingItem58 !== undefined && pendingItem58.props.disabled === true
  && String(pendingItem58.props.title).indexOf('正在检查这个提交能不能改写') > 0)
editCheckReply58 = null
await wait(15)
t58 = await settle('pop')

/* reachable=false 的行：答复落定后这一项仍置灰，title 把原因说出来。 */
editCheckReply58 = {
  ok: true, repo: '/tmp/ws', head: 'h111111',
  checks: [
    { hash: 'h222222', reachable: false, pushed: false, isHead: false, isRoot: false },
  ],
}
await rightClick58(1)
ok('体检说不在当前分支历史上：「编辑提交消息…」保持置灰并说出原因',
  item58('编辑提交消息…') !== undefined && item58('编辑提交消息…').props.disabled === true
  && String(item58('编辑提交消息…').props.title).indexOf('不在当前分支历史上') > 0)
editCheckReply58 = null

/* 这一段收工：把体检的桩换回默认，后面的段落不受影响。 */
host.call = realCall58
fibers.clear()
