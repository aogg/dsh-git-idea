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
const section = registered.find((r) => r.options.id === 'dsh-git-idea').component

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

const ok = (label, value) => console.log('  ' + (value ? '✓' : '✗') + ' ' + label + (value ? '' : '   ← 不符合预期'))
/* ═══ gp50：三方合并冲突解决界面（客户端这一半）═══
 *
 * 盯四片：
 *   1. 变更页冲突行的点击分流（54-changes.js）：conflict 行触发 onOpenConflict 且
 *      不触发 onOpenDiff（正文变成合并界面、git/diff 一个都不发）；普通行照旧走
 *      onOpenDiff；宿主没传 onOpenConflict 时点行不炸——typeof 守卫落回 onOpenDiff；
 *   2. diff3 纯函数（53-merge3.js，零外部引用、单独求值）：单侧改动 / 两侧同改 /
 *      冲突分块（相邻改动贴着也算冲突——git xdl_merge 口径；中间隔一整行未动才
 *      各自干净落地）、prefill 标记形状、标记行识别（带侧标签、尾随空格、CRLF 的
 *      \r；正文里以 < 开头的行不误判）、scanBlocks 数块（未闭合块在列、块内嵌套
 *      开标记按正文）、blockHalves / blockSides / replaceBlock（缺侧=空数组=整块
 *      删除）、applyNonConflicts 不覆盖已改内容、sideRows 的行模型与着色标；
 *   3. 界面（59-merge.js，用 fixture 答复）：标题「合并 <仓库> 的 <路径> 的修订」、
 *      三栏只读 + 侧标签、右上计数三态、工具栏按钮文案与禁用态、<< 左侧 / 右侧 >>
 *      / 所有款点击后结果区与计数、撤销栈（只动结果区）、「应用更改」发
 *      git/conflict-save 且 content 是结果区全文（有未解决块先确认）、「取消」零
 *      调用、AA/DU/UD 的空态文案、CRLF 按 ours 侧口径写回；
 *   4. 接线（80-panel.js）：mergeTarget 占正文、切页签/切仓库清掉、多仓库冲突行
 *      落回文件自己的仓库、应用成功走 refresh() 的整树重读。 */

/* ── mock：git/panel 按阶段给快照，git/conflict / git/conflict-save 按用例给答复 ── */
let panelReply = {
  ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0,
  sequencer: null, staged: [], unstaged: [{ path: 'mod.txt', code: ' M' }], untracked: [],
  unmerged: [{ path: 'a-conflict.txt', code: 'UU' }],
}
let conflictReply = null
let conflictSaveReply = { ok: true, repo: '/tmp/ws', path: '', exitCode: 0, command: 'git add -- x', stdout: '', stderr: '', sandboxDenied: false, noGit: false }
let reposReply = null
const mergeCalls = []
const saveCalls = []
const realCall = host.call
host.call = function (method, args) {
  if (method === 'git/panel') { calls.push({ method: method, args: args }); return Promise.resolve(panelReply) }
  if (method === 'git/repos') { calls.push({ method: method, args: args }); return Promise.resolve(reposReply) }
  if (method === 'git/conflict') { calls.push({ method: method, args: args }); mergeCalls.push(args); return Promise.resolve(conflictReply) }
  if (method === 'git/conflict-save') { calls.push({ method: method, args: args }); saveCalls.push(args); return Promise.resolve(conflictSaveReply) }
  if (method === 'git/diff') { calls.push({ method: method, args: args }); return Promise.resolve({ ok: true, mode: args && args.mode, path: args && args.path, text: '', added: 0, removed: 0, binary: false, truncated: false, empty: false }) }
  if (method === 'git/project-config') { calls.push({ method: method, args: args }); return Promise.resolve({ ok: true, repo: '/tmp/ws', insideRepo: true, config: {} }) }
  if (method === 'git/command-log') { calls.push({ method: method, args: args }); return Promise.resolve({ ok: true, sessionId: args != null ? args.sessionId : '', commands: [], truncated: false, warning: '' }) }
  return realCall(method, args)
}

const clickText = async function (tree, label) {
  const hit = buttons(tree).find((b) => textOf(b).indexOf(label) >= 0)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
}
const callsOf = function (mark, method) { return calls.slice(mark).filter((c) => c.method === method) }
const mergeView = (t) => byClass(t, 'dsh-git-mrg')[0]
const mergeTitle = (t) => { const one = byClass(t, 'dsh-git-mrg-title')[0]; return one === undefined ? '' : textOf(one) }
const mergeCount = (t) => { const one = byClass(t, 'dsh-git-mrg-count')[0]; return one === undefined ? '' : textOf(one) }
const resultText = (t) => { const ta = collect(t).find((n) => n.type === 'textarea'); return ta === undefined ? null : ta.props.value }
const textareas = (t) => collect(t).filter((n) => n.type === 'textarea')
const typeResult = async function (t, value) {
  const ta = textareas(t)[0]
  ta.props.onChange({ target: { value: value } })
  return await settle()
}
const paneHeads = (t) => byClass(t, 'dsh-git-mrg-panehead').map(textOf)
const paneRows = (t) => byClass(t, 'dsh-git-mrg-lrow')
const paneEmpty = (t) => byClass(t, 'dsh-git-mrg-emptyp').map(textOf)
const toolBtn = (t, title) => collect(t).find((n) => n.type === 'button' && n.props.title === title)
const btnByGlyph = (t, glyph) => buttons(t).find((b) => textOf(b) === glyph)
/* 合并工具栏的 ↓↑ 与面板顶栏的 ↓↑（拉取/推送）同名：合并视图里的键一律先钻进
   dsh-git-mrg 再找，免得点到顶栏的按钮上。 */
const mBtn = (t, glyph) => btnByGlyph(mergeView(t) || t, glyph)
const changeRowOf = (t, path) => byClass(t, 'dsh-git-trow').find((r) => textOf(r).indexOf(path) >= 0)
const activeBand = (t) => collect(t).find((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dsh-git-mrg-band-block-on') >= 0)
const openConflictOf = async function (path) {
  const row = changeRowOf(tree, path)
  if (row === undefined) throw new Error('变更树里没有「' + path + '」')
  row.props.onClick()
  return await settle()
}
/* 上一节把合并界面留在屏上时（写回失败、只解决未应用都开着），先按「取消」关掉
   —— 它一个字节不写，正好也是被钉住的行为之一。 */
const closeMergeIfOpen = async function () {
  if (mergeView(tree) === undefined) return
  const cancel = buttons(mergeView(tree)).find((b) => textOf(b) === '取消')
  cancel.props.onClick()
  tree = await settle()
}
/* 换一条冲突路径 = 换快照 + ⟳ + 点那一行（合并界面的读只认 repo+path 的 shape，
   不换路径它就不会重新读 —— 这也是接线事实，不是绕弯）。 */
const openFixture = async function (path, reply) {
  await closeMergeIfOpen()
  panelReply = Object.assign({}, panelReply, { unmerged: [{ path: path, code: 'UU' }] })
  conflictReply = reply
  await clickText(tree, '⟳')
  tree = await settle()
  return await openConflictOf(path)
}

/* ── fixture 答复 ──
   ONE：base 的第 1 行两侧各改各的 → 一块冲突 + 两段 same。
   TWO：第 1、3 行各撞一处（中间隔一整行未动的 b）→ 两块冲突。
   AA：base 缺席（两侧各自新增）；DU：ours 删除；UD：theirs 删除。
   CRLF：三侧都带 \r\n，写回按 ours 侧口径还原。 */
const sideOf = function (content) {
  return {
    present: content !== null,
    text: content === null ? '' : content,
    truncated: false,
    crlf: content != null && content.indexOf('\r\n') >= 0,
    endsWithNewline: content != null && content.length > 0 && content.charAt(content.length - 1) === '\n',
  }
}
const replyOf = function (repo, path, base, ours, theirs, over) {
  return Object.assign({
    ok: true, repo: repo, path: path,
    base: sideOf(base), ours: sideOf(ours), theirs: sideOf(theirs),
    oursLabel: 'main', theirsLabel: 'feature', merging: true, cherryPicking: false,
  }, over || {})
}
const ONE = { path: 'app.txt', base: 'a\nb\nc\n', ours: 'ours-a\nb\nc\n', theirs: 'theirs-a\nb\nc\n' }
const ONE_INITIAL = '<<<<<<<\nours-a\n=======\ntheirs-a\n>>>>>>>\nb\nc\n'
const ONE_ALL_OURS = 'ours-a\nb\nc\n'
const TWO = { path: 'app2.txt', base: 'a\nb\nc\nd\ne\n', ours: 'A1\nb\nC1\nd\ne\n', theirs: 'A2\nb\nC2\nd\ne\n' }
const TWO_INITIAL = '<<<<<<<\nA1\n=======\nA2\n>>>>>>>\nb\n<<<<<<<\nC1\n=======\nC2\n>>>>>>>\nd\ne\n'
const replyOne = () => replyOf('/tmp/ws', ONE.path, ONE.base, ONE.ours, ONE.theirs)
const replyTwo = () => replyOf('/tmp/ws', TWO.path, TWO.base, TWO.ours, TWO.theirs)

console.log('')
console.log('== 冲突行点击分流：合并界面 vs 普通 diff ==')
conflictReply = replyOne()
let tree = await openPanel()
await clickText(tree, '变更')
tree = await settle()
const markClick = calls.length
tree = await openConflictOf('a-conflict.txt')
ok('冲突行点开的是合并界面（dsh-git-mrg 占正文），diff 一行代码都没问',
  mergeView(tree) !== undefined && callsOf(markClick, 'git/diff').length === 0)
ok('git/conflict 只问了一次：带会话与路径、单仓库不带 repo（仓库由 Host 从会话解出）',
  callsOf(markClick, 'git/conflict').length === 1 && mergeCalls[0].path === 'a-conflict.txt'
  && mergeCalls[0].sessionId === 's-1' && mergeCalls[0].repo === undefined)
ok('标题是「合并 ws 的 a-conflict.txt 的修订」——仓库名取 Host 解析出的那份（target.repo 是空）',
  mergeTitle(tree) === '合并 ws 的 a-conflict.txt 的修订')
ok('头上带着红色双码 UU（变更页那个 workCode 跟进来了）',
  byClass(tree, 'dsh-git-st-CF').some((n) => textOf(n) === 'UU'))
const backBtn = toolBtn(tree, '返回变更列表（不写任何字节）')
backBtn.props.onClick()
tree = await settle()
ok('← 回到变更列表：合并界面没了，文件行还在',
  mergeView(tree) === undefined && changeRowOf(tree, 'a-conflict.txt') !== undefined)
const markDiff = calls.length
const modRow = changeRowOf(tree, 'mod.txt')
modRow.props.onClick()
tree = await settle()
ok('普通行照旧走 onOpenDiff：diff 页打开、git/diff 问的是这一行',
  byClass(tree, 'dsh-git-diffview').length === 1
  && callsOf(markDiff, 'git/diff').some((c) => c.args.path === 'mod.txt'))
const backDiff = collect(tree).find((n) => n.type === 'button' && n.props.title === '返回文件列表')
backDiff.props.onClick()
tree = await settle()
ok('diff 返回后正文又是变更树', changeRowOf(tree, 'mod.txt') !== undefined && byClass(tree, 'dsh-git-diffview').length === 0)

console.log('')
console.log('== typeof 守卫：宿主没传 onOpenConflict 时点冲突行不炸 ==')
/* 真面板永远传 onOpenConflict；守卫的那条 false 路要把 ChangesPane 的 props 摘掉
   一个键才走得进去。这里对 client.js 再求值一份独立实例（各自的 slots / host /
   fibers 互不相干，label 前缀隔开 fiber 键），在它的 createElement 处把
   onOpenConflict 从 ChangesPane 的 props 里删掉 —— 整条点击路还是真代码。 */
const CLIENT_SRC = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
const registered2 = []
const guardCalls = []
const makeElementGuard = function (type, props) {
  const kids = Array.prototype.slice.call(arguments, 2)
  if (typeof type === 'function' && type.name === 'ChangesPane') {
    const less = Object.assign({}, props)
    delete less.onOpenConflict
    return makeElement.apply(null, [type, less].concat(kids))
  }
  return makeElement.apply(null, [type, props].concat(kids))
}
const ReactGuard = Object.assign({}, React, { createElement: makeElementGuard })
const ctxGuard = {
  get(n) {
    if (n === 'slots') return { inject: (k, cb) => cb(), register: (o, c) => { registered2.push({ options: o, component: c }); return () => {} } }
    if (n === 'timer') return ctx.get('timer')
    return undefined
  },
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const hostGuard = {
  call(method, args) {
    guardCalls.push({ method: method, args: args })
    if (method === 'git/panel') return Promise.resolve(panelReply)
    if (method === 'git/repos') return Promise.resolve({ ok: true, workspace: '/tmp/ws', repos: [], manual: [], missing: [] })
    if (method === 'git/diff') return Promise.resolve({ ok: true, mode: args && args.mode, path: args && args.path, text: '', added: 0, removed: 0, binary: false, truncated: false, empty: false })
    /* 其余读走共享 harness 那份形状齐全的 mock：GitPanel 要 refs/branches/graph 的
       数组结构，泛泛的 ok 答复会让它在一棵没人测的树上摔跤。 */
    return realCall(method, args)
  },
}
new Function('ctx', 'React', 'host', 'styles', 'console', CLIENT_SRC)(
  ctxGuard, ReactGuard, hostGuard, { insert: () => () => {} }, console).apply(ctxGuard)
const popGuard = registered2.find((r) => r.options.id === 'dsh-git-idea-panel').component
const chipGuard = registered2.find((r) => r.options.id === 'dsh-git-idea-chip').component
const popTreeG = () => renderUntilStable(makeElement(popGuard, { sessionId: 's-g' }), 'gp50g')
const settleG = async function () { let t = null; for (let i = 0; i < 4; i += 1) { t = await popTreeG(); await wait(10) } return t }
let treeG = await renderUntilStable(makeElement(chipGuard, { sessionId: 's-g' }), 'gp50g-chip')
if (treeG.props.className.indexOf('dsh-git-chip-open') < 0) { treeG.props.onClick(); await wait(10) }
treeG = await settleG()
await clickText(treeG, '变更')
treeG = await settleG()
const guardRow = changeRowOf(treeG, 'a-conflict.txt')
let guardThrew = null
try { guardRow.props.onClick() } catch (error) { guardThrew = error }
treeG = await settleG()
ok('点冲突行不抛错、合并界面也不出现、git/conflict 一个都没发',
  guardThrew === null && byClass(treeG, 'dsh-git-mrg').length === 0
  && guardCalls.every((c) => c.method !== 'git/conflict'))
ok('守卫落回 onOpenDiff：diff 页照常打开（行没有因为缺回调而变成死的）',
  byClass(treeG, 'dsh-git-diffview').length === 1
  && guardCalls.some((c) => c.method === 'git/diff' && c.args.path === 'a-conflict.txt'))

console.log('')
console.log('== 53-merge3.js 单独求值：分块、标记、块操作 ==')
const M3 = new Function(fs.readFileSync(new URL('../src/client/53-merge3.js', import.meta.url).pathname, 'utf8')
  + '; return { merge3SplitLines, merge3JoinLines, merge3Chunks, merge3Markers, merge3PrefillLines, merge3IsOpen, merge3IsSep, merge3IsClose, merge3ScanBlocks, merge3BlockHalves, merge3BlockSides, merge3ReplaceBlock, merge3ApplyNonConflicts, merge3SideRows }')()
ok('切行/拼行逐字节还原：结尾换行就是末尾那个空串，不用额外状态；空文本是零行',
  JSON.stringify(M3.merge3SplitLines('a\nb\n')) === JSON.stringify(['a', 'b', ''])
  && M3.merge3JoinLines(['a', 'b', '']) === 'a\nb\n'
  && M3.merge3JoinLines(M3.merge3SplitLines('a\n')) === 'a\n'
  && M3.merge3SplitLines('').length === 0)
const chunksOne = M3.merge3Chunks(['a', 'b', 'c'], ['A', 'b', 'c'], ['a', 'b', 'c'])
ok('单侧改动：那一侧的块 type=ours、merged 是合并结果，其余是 same',
  chunksOne.length === 2 && chunksOne[0].type === 'ours' && JSON.stringify(chunksOne[0].merged) === JSON.stringify(['A'])
  && chunksOne[1].type === 'same')
const chunksMirror = M3.merge3Chunks(['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'X'])
ok('只有 theirs 改：未动的 ab 是 same，改动的 c 一块 type=theirs、merged 取 theirs',
  chunksMirror.length === 2 && chunksMirror[0].type === 'same'
  && chunksMirror[1].type === 'theirs' && JSON.stringify(chunksMirror[1].merged) === JSON.stringify(['X']))
const chunksBoth = M3.merge3Chunks(['a', 'b', 'c'], ['A', 'b', 'c'], ['A', 'b', 'c'])
ok('两侧改得一样：type=both，merged 就是那一份（不是冲突）',
  chunksBoth[0].type === 'both' && JSON.stringify(chunksBoth[0].merged) === JSON.stringify(['A']))
const chunksAdj = M3.merge3Chunks(['a', 'b', 'c', 'd'], ['A', 'b', 'c', 'd'], ['a', 'X', 'c', 'd'])
ok('相邻改动贴着也算冲突（git xdl_merge 口径）：合并成一块 conflict、merged 为 null',
  chunksAdj.length === 2 && chunksAdj[0].type === 'conflict' && chunksAdj[0].merged === null
  && JSON.stringify(chunksAdj[0].ours) === JSON.stringify(['A', 'b'])
  && JSON.stringify(chunksAdj[0].theirs) === JSON.stringify(['a', 'X']))
const chunksSep = M3.merge3Chunks(['a', 'b', 'c', 'd', 'e'], ['A', 'b', 'c', 'd', 'e'], ['a', 'b', 'C', 'd', 'e'])
ok('中间隔一整行未动才各自干净落地：ours、same、theirs、same',
  JSON.stringify(chunksSep.map((c) => c.type)) === JSON.stringify(['ours', 'same', 'theirs', 'same']))
const chunksAA = M3.merge3Chunks([], ['from-main'], ['from-feature'])
const chunksAABoth = M3.merge3Chunks([], ['same'], ['same'])
ok('AA（base 为空）：整个文件一块冲突；两侧内容相同时退成 both',
  chunksAA.length === 1 && chunksAA[0].type === 'conflict' && chunksAA[0].base.length === 0
  && chunksAABoth.length === 1 && chunksAABoth[0].type === 'both')
const chunksTwo = M3.merge3Chunks(['a', 'b', 'c', 'd', 'e', ''], ['A1', 'b', 'C1', 'd', 'e', ''], ['A2', 'b', 'C2', 'd', 'e', ''])
const markersLf = M3.merge3Markers(false)
const prefillTwo = M3.merge3PrefillLines(chunksTwo, markersLf)
ok('prefill：冲突块以 <<<<<<< / ======= / >>>>>>> 夹住两侧，非冲突块给 merged',
  JSON.stringify(prefillTwo) === JSON.stringify(['<<<<<<<', 'A1', '=======', 'A2', '>>>>>>>', 'b', '<<<<<<<', 'C1', '=======', 'C2', '>>>>>>>', 'd', 'e', '']))
ok('CRLF 口径的标记带 \\r（跟 ours 侧的换行走，不混出第三种）',
  M3.merge3Markers(true).open === '<<<<<<<\r' && M3.merge3Markers(true).sep === '=======\r' && M3.merge3Markers(true).close === '>>>>>>>\r')
ok('标记行识别：裸七个字、空格侧标签、CRLF 的 \\r 都认；正文里恰好以 < 开头的不误判',
  M3.merge3IsOpen('<<<<<<< HEAD') === true && M3.merge3IsOpen('<<<<<<<') === true && M3.merge3IsOpen('<<<<<<<\r') === true
  && M3.merge3IsClose('>>>>>>> feature/x') === true
  && M3.merge3IsOpen('<<<<<<<x') === false && M3.merge3IsOpen('<<<<<<') === false && M3.merge3IsOpen('<<<<<<<<') === false
  && M3.merge3IsSep('=======') === true && M3.merge3IsSep('=======  ') === true && M3.merge3IsSep('=======\r') === true
  && M3.merge3IsSep('======= text') === false)
const blocksTwo = M3.merge3ScanBlocks(prefillTwo)
ok('scanBlocks 数块：两块各自带 start/mid/close',
  blocksTwo.length === 2 && blocksTwo[0].start === 0 && blocksTwo[0].mid === 2 && blocksTwo[0].close === 4
  && blocksTwo[1].start === 6 && blocksTwo[1].close === 10)
ok('未闭合的块照样在列（close=-1、end 兜到最后一行）——它最需要被数进「未解决」',
  JSON.stringify(M3.merge3ScanBlocks(['<<<<<<<', 'x', '=======', 'y'])) === JSON.stringify([{ start: 0, mid: 2, close: -1, end: 3 }]))
ok('块里再出现开标记按正文处理（git 不产嵌套块）：还是一块',
  JSON.stringify(M3.merge3ScanBlocks(['<<<<<<<', 'x', '<<<<<<< y', '=======', 'z', '>>>>>>>']))
    === JSON.stringify([{ start: 0, mid: 3, close: 5, end: 5 }]))
ok('块的两半：标记之间夹着的就是；分隔缺失那一侧算空',
  JSON.stringify(M3.merge3BlockHalves(['<<<<<<<', 'o1', '=======', 't1', 't2', '>>>>>>>'], { start: 0, mid: 2, close: 5, end: 5 }))
    === JSON.stringify({ ours: ['o1'], theirs: ['t1', 't2'] })
  && JSON.stringify(M3.merge3BlockHalves(['<<<<<<<', 'o1', '>>>>>>>'], { start: 0, mid: -1, close: 2, end: 2 }))
    === JSON.stringify({ ours: [], theirs: [] }))
const sidesTwo = M3.merge3BlockSides(prefillTwo, blocksTwo, chunksTwo)
ok('blockSides 按顺序把块对回冲突块：左右两半就是分块里的 ours/theirs',
  JSON.stringify(sidesTwo) === JSON.stringify([{ ours: ['A1'], theirs: ['A2'] }, { ours: ['C1'], theirs: ['C2'] }]))
const linesForReplace = ['head', '<<<<<<<', 'o', '=======', 't', '>>>>>>>', 'tail']
const blockMid = M3.merge3ScanBlocks(linesForReplace)[0]
const replaced = M3.merge3ReplaceBlock(linesForReplace, blockMid, ['new-1', 'new-2'])
ok('replaceBlock 换块：整块（含三行标记）换成 replacement，两头原样，入参数组不被改',
  JSON.stringify(replaced) === JSON.stringify(['head', 'new-1', 'new-2', 'tail'])
  && linesForReplace.length === 7)
ok('replacement 是空数组 = 整块删除（接受删除的一侧就是这个形状）',
  JSON.stringify(M3.merge3ReplaceBlock(linesForReplace, blockMid, [])) === JSON.stringify(['head', 'tail']))
const intactEdited = ['<<<<<<<', 'A1-手改', '=======', 'A2', '>>>>>>>', 'b', '<<<<<<<', 'C1', '=======', 'C2', '>>>>>>>', 'd', 'e', '']
const appliedIntact = M3.merge3ApplyNonConflicts(chunksTwo, intactEdited, markersLf)
ok('applyNonConflicts：排版还对得上时原样返回 —— 读者手改过的内容一字不覆盖',
  JSON.stringify(appliedIntact) === JSON.stringify(intactEdited))
const editedBroken = ['A1', 'b', '<<<<<<<', 'C1', '=======', 'C2', '>>>>>>>', 'd', 'e', '']
const appliedBroken = M3.merge3ApplyNonConflicts(chunksTwo, editedBroken, markersLf)
ok('排版碎了才重排：非冲突区按重新合并给全、留下的块内容保留、缺位补新鲜标记预填（内容只会回来，不会被丢）',
  appliedBroken.join('\n').indexOf('<<<<<<<') === 0
  && appliedBroken.indexOf('A1') < 0 && appliedBroken.indexOf('b') >= 0
  && appliedBroken.join('|').indexOf('C1|=======|C2|>>>>>>>') >= 0
  && appliedBroken.slice(-3).join('|') === 'd|e|')
const rowsOurs = M3.merge3SideRows(chunksTwo, 'ours')
const rowsBase = M3.merge3SideRows(chunksTwo, 'base')
ok('sideRows：行号各侧自己的 1 起头坐标系；ours 侧改动区着色、base 侧只有冲突区着色',
  JSON.stringify(rowsOurs.slice(0, 3)) === JSON.stringify([{ line: 1, text: 'A1', mark: true }, { line: 2, text: 'b', mark: false }, { line: 3, text: 'C1', mark: true }])
  && JSON.stringify(rowsBase.slice(0, 3)) === JSON.stringify([{ line: 1, text: 'a', mark: true }, { line: 2, text: 'b', mark: false }, { line: 3, text: 'c', mark: true }]))

console.log('')
console.log('== 界面：三栏、计数三态、工具栏 ==')
tree = await settle()
tree = await openFixture(ONE.path, replyOne())
ok('三栏只读对比：panehead 是「来自 main 的更改 / 基准版本 / 来自 feature 的更改」（侧标签取答复）',
  JSON.stringify(paneHeads(tree)) === JSON.stringify(['来自 main 的更改', '基准版本', '来自 feature 的更改']))
ok('全视图只有结果区一支 textarea，三栏的行都是不可编辑的 div（只读）',
  textareas(tree).length === 1 && paneRows(tree).length === 12)
const firstOursRow = paneRows(tree)[0]
ok('栏内行带着行号与文本（ours 侧第 1 行就是 ours-a）',
  String(firstOursRow.props.key) === 'r0' && textOf(firstOursRow).indexOf('1') === 0 && textOf(firstOursRow).indexOf('ours-a') >= 0)
ok('着色跟分块走：ours 栏改动行带 dsh-git-mrg-m-ours，未动行不着色',
  String(firstOursRow.props.className).indexOf('dsh-git-mrg-m-ours') >= 0
  && String(paneRows(tree)[1].props.className).indexOf('dsh-git-mrg-m-ours') < 0)
ok('进入时预填是「应用不冲突的更改」的初始形态，计数是第一态「没有更改，1 个冲突」',
  resultText(tree) === ONE_INITIAL && mergeCount(tree) === '没有更改，1 个冲突')
const glyphs = ['↓', '↑', '↶', '⚙']
ok('工具栏四枚图标键 + 五枚文字键都在，文案一字不差',
  glyphs.every((g) => btnByGlyph(tree, g) !== undefined)
  && ['应用不冲突的更改', '<< 左侧', '所有 << 左侧', '右侧 >>', '所有 >> 右侧'].every((s) => buttons(tree).some((b) => textOf(b) === s)))
ok('禁用态：有一块冲突时 ↓↑ 可用，↶ 没有历史可用',
  mBtn(tree, '↓').props.disabled !== true && mBtn(tree, '↑').props.disabled !== true
  && mBtn(tree, '↶').props.disabled === true)
mBtn(tree, '<< 左侧').props.onClick()
tree = await settle()
ok('<< 左侧：当前块整块换成 ours 内容并去掉标记，计数落到「全部已解决（0 个冲突）」',
  resultText(tree) === ONE_ALL_OURS && mergeCount(tree) === '全部已解决（0 个冲突）')
ok('没有冲突了：↓↑ 禁用（无冲突时跳转无处可跳），↶ 有了历史可用',
  mBtn(tree, '↓').props.disabled === true && mBtn(tree, '↑').props.disabled === true
  && mBtn(tree, '↶').props.disabled !== true)
const panesBeforeUndo = JSON.stringify(paneHeads(tree)) + JSON.stringify(paneRows(tree).map(textOf))
mBtn(tree, '↶').props.onClick()
tree = await settle()
ok('↶ 回上一态：结果区回预填、计数回「没有更改，1 个冲突」，三栏不受撤销影响（只读本就没有可撤销的东西）',
  resultText(tree) === ONE_INITIAL && mergeCount(tree) === '没有更改，1 个冲突'
  && JSON.stringify(paneHeads(tree)) + JSON.stringify(paneRows(tree).map(textOf)) === panesBeforeUndo)
mBtn(tree, '↶').props.onClick()
tree = await settle()
ok('撤销栈空了 ↶ 再点无效（禁用）', mBtn(tree, '↶').props.disabled === true && resultText(tree) === ONE_INITIAL)
const editedWithin = ONE_INITIAL.replace('ours-a', 'ours-a-手改')
tree = await typeResult(tree, editedWithin)
ok('手动编辑后计数进第二态：动过结果区 = 「1 个冲突」（不再说「没有更改」）',
  mergeCount(tree) === '1 个冲突' && resultText(tree) === editedWithin)
tree = await typeResult(tree, ONE_INITIAL.replace('ours-a', 'x1'))
tree = await typeResult(tree, ONE_INITIAL.replace('ours-a', 'x2'))
mBtn(tree, '↶').props.onClick()
tree = await settle()
ok('连续键入合一步撤销：两步编辑 ↶ 一次直接回到编辑前的预填',
  resultText(tree) === ONE_INITIAL && mergeCount(tree) === '没有更改，1 个冲突')
mBtn(tree, '应用不冲突的更改').props.onClick()
tree = await settle()
ok('「应用不冲突的更改」在排版完好时就是原样：文本不动、也不产生一步看不见的撤销（↶ 仍禁用）',
  resultText(tree) === ONE_INITIAL && mBtn(tree, '↶').props.disabled === true)
const cancelBefore = saveCalls.length
await clickText(tree, '取消')
tree = await settle()
ok('「取消」只关界面：合并界面没了，conflict-save 一个字节都没发过',
  mergeView(tree) === undefined && saveCalls.length === cancelBefore)

console.log('')
console.log('== 界面：跳转、单块/全部采用、应用更改 ==')
tree = await settle()
tree = await openFixture(TWO.path, replyTwo())
ok('两块冲突的预填与计数：' + mergeCount(tree),
  resultText(tree) === TWO_INITIAL && mergeCount(tree) === '没有更改，2 个冲突')
ok('打开就落在第一块上：加重色的 band 画在第一块的位置（内边距 4px + 行号 × 18px 行高）',
  activeBand(tree) !== undefined && activeBand(tree).props.style.top === '4px')
mBtn(tree, '↑').props.onClick()
tree = await settle()
ok('↑ 跳到下一块（结果区的高亮 band 跟着挪）', activeBand(tree).props.style.top === (4 + 6 * 18) + 'px')
mBtn(tree, '↑').props.onClick()
tree = await settle()
ok('再 ↑ 循环绕回第一块', activeBand(tree).props.style.top === '4px')
mBtn(tree, '↓').props.onClick()
tree = await settle()
ok('↓ 往回跳一块', activeBand(tree).props.style.top === (4 + 6 * 18) + 'px')
mBtn(tree, '右侧 >>').props.onClick()
tree = await settle()
ok('右侧 >> 只换当前块：第二块换成 theirs，第一块原样，剩 1 块',
  resultText(tree) === '<<<<<<<\nA1\n=======\nA2\n>>>>>>>\nb\nC2\nd\ne\n' && mergeCount(tree) === '1 个冲突')
mBtn(tree, '↶').props.onClick()
tree = await settle()
mBtn(tree, '所有 << 左侧').props.onClick()
tree = await settle()
ok('所有 << 左侧：全部块采用 ours，预填的冲突标记一个不剩',
  resultText(tree) === 'A1\nb\nC1\nd\ne\n' && mergeCount(tree) === '全部已解决（0 个冲突）')
const markApply = saveCalls.length
const markApplyCalls = calls.length
mBtn(tree, '应用更改').props.onClick()
tree = await settle()
ok('零未解决块时「应用更改」直接发 git/conflict-save（不弹确认）：content 就是结果区全文',
  saveCalls.length === markApply + 1 && saveCalls[markApply].content === 'A1\nb\nC1\nd\ne\n'
  && saveCalls[markApply].path === TWO.path && saveCalls[markApply].sessionId === 's-1'
  && saveCalls[markApply].repo === undefined)
ok('答复 ok：界面关闭、成功条说人话、刷新走了整树重读（git/flush + 不带 quick 的 git/panel）',
  mergeView(tree) === undefined && byClass(tree, 'dsh-git-oknote').some((n) => textOf(n).indexOf('已解决 app2.txt 的冲突并标记已解决') >= 0)
  && callsOf(markApplyCalls, 'git/flush').length === 1
  && callsOf(markApplyCalls, 'git/panel').some((c) => c.args.quick !== true && !Array.isArray(c.args.paths)))

console.log('')
console.log('== 界面：有未解决块时先确认，失败不上屏不关界面 ==')
conflictSaveReply = { ok: true, repo: '/tmp/ws', path: 'app3.txt', exitCode: 0, command: 'git add -- app3.txt', stdout: '', stderr: '', sandboxDenied: false, noGit: false }
tree = await settle()
tree = await openFixture('app3.txt', replyOf('/tmp/ws', 'app3.txt', ONE.base, ONE.ours, ONE.theirs))
let markApply2 = saveCalls.length
mBtn(tree, '应用更改').props.onClick()
tree = await settle()
let overlay = byClass(tree, 'dsh-git-qc-overlay')[0]
ok('还有未解决块：先弹确认框（说清那些块会以标记原样写回），conflict-save 还没发',
  overlay !== undefined && textOf(overlay).indexOf('还有 1 处未解决的冲突') >= 0
  && textOf(overlay).indexOf('<<<<<<< ======= >>>>>>>') >= 0 && saveCalls.length === markApply2)
const overlayCancel = buttons(byClass(tree, 'dsh-git-qc-overlay')[0]).find((b) => textOf(b) === '取消')
overlayCancel.props.onClick()
tree = await settle()
ok('确认框的「取消」：框关了、请求还是没发、界面还开着',
  byClass(tree, 'dsh-git-qc-overlay').length === 0 && saveCalls.length === markApply2 && mergeView(tree) !== undefined)
mBtn(tree, '应用更改').props.onClick()
tree = await settle()
await clickText(tree, '确认写入')
tree = await settle()
ok('确认写入：发出的 content 是结果区全文（带着未解决块原样）',
  saveCalls.length === markApply2 + 1 && saveCalls[markApply2].content === ONE_INITIAL && mergeView(tree) === undefined)
conflictSaveReply = { ok: false, repo: '/tmp/ws', path: 'app4.txt', exitCode: 1, command: 'git add -- app4.txt', stdout: '', stderr: 'error: failed to write app4.txt', sandboxDenied: false, noGit: false }
tree = await settle()
tree = await openFixture('app4.txt', replyOf('/tmp/ws', 'app4.txt', ONE.base, ONE.ours, ONE.theirs))
markApply2 = saveCalls.length
mBtn(tree, '所有 << 左侧').props.onClick()
tree = await settle()
mBtn(tree, '应用更改').props.onClick()
tree = await settle()
ok('写回失败：stderr 原话上屏成 note，界面不关（失败的话必须留在现场）',
  byClass(tree, 'dsh-git-mrg-note').some((n) => textOf(n).indexOf('error: failed to write app4.txt') >= 0)
  && mergeView(tree) !== undefined && saveCalls.length === markApply2 + 1)
const noteNode = byClass(tree, 'dsh-git-mrg-note')[0]
noteNode.props.onClick()
tree = await settle()
ok('点一下 note 清掉', noteNode.props.title.indexOf('清掉') >= 0 && byClass(tree, 'dsh-git-mrg-note').length === 0)

console.log('')
console.log('== 界面：CRLF 按 ours 侧口径写回；AA/DU/UD 的空态 ==')
conflictSaveReply = { ok: true, repo: '/tmp/ws', path: 'crlf.txt', exitCode: 0, command: 'git add -- crlf.txt', stdout: '', stderr: '', sandboxDenied: false, noGit: false }
tree = await settle()
tree = await openFixture('crlf.txt', replyOf('/tmp/ws', 'crlf.txt', 'a\r\nb\r\n', 'A\r\nb\r\n', 'X\r\nb\r\n'))
ok('编辑器里按 LF 显示（\\r 在 mergeBuild 过闸剥掉），计数照常',
  resultText(tree) === '<<<<<<<\nA\n=======\nX\n>>>>>>>\nb\n' && mergeCount(tree) === '没有更改，1 个冲突')
mBtn(tree, '所有 << 左侧').props.onClick()
tree = await settle()
mBtn(tree, '应用更改').props.onClick()
tree = await settle()
ok('写回按 ours 侧口径把 \\n 整体还原成 \\r\n：整文件统一，不混出第三种换行',
  saveCalls[saveCalls.length - 1].content === 'A\r\nb\r\n')
tree = await settle()
tree = await openFixture('aa.txt', replyOf('/tmp/ws', 'aa.txt', null, 'from-main\n', 'from-feature\n'))
ok('AA：中栏明说「两侧各自新增，无基准版本」，提示行说整个文件就是一块冲突',
  paneEmpty(tree).indexOf('（两侧各自新增，无基准版本）') >= 0
  && byClass(tree, 'dsh-git-diffwarn').some((n) => textOf(n).indexOf('两侧各自新增，没有基准版本：整个文件就是一块冲突') >= 0))
ok('AA 的整文件就是一块：预填全是标记夹的两侧原文（两侧结尾的空行是内容的一部分，在块里）',
  resultText(tree) === '<<<<<<<\nfrom-main\n\n=======\nfrom-feature\n\n>>>>>>>' && mergeCount(tree) === '没有更改，1 个冲突')
tree = await settle()
tree = await openFixture('du.txt', replyOf('/tmp/ws', 'du.txt', 'a\nb\n', null, 'A\nb\n'))
ok('DU：ours 一侧已删除 —— 左栏明说、提示行说接受这一侧＝整块删除',
  paneEmpty(tree).indexOf('（该侧已删除此文件）') >= 0
  && byClass(tree, 'dsh-git-diffwarn').some((n) => textOf(n).indexOf('main 一侧已删除此文件：接受这一侧＝整块删除') >= 0))
mBtn(tree, '<< 左侧').props.onClick()
tree = await settle()
ok('DU 接受删除的一侧：本侧删的是整个文件，接受它＝空文件（整块连标记一起抹掉）',
  resultText(tree) === '' && mergeCount(tree) === '全部已解决（0 个冲突）')
tree = await settle()
tree = await openFixture('ud.txt', replyOf('/tmp/ws', 'ud.txt', 'a\nb\n', 'A\nb\n', null))
ok('UD：theirs 一侧已删除 —— 右栏明说，提示带 theirs 的标签',
  paneEmpty(tree).indexOf('（该侧已删除此文件）') >= 0
  && byClass(tree, 'dsh-git-diffwarn').some((n) => textOf(n).indexOf('feature 一侧已删除此文件：接受这一侧＝整块删除') >= 0))
mBtn(tree, '右侧 >>').props.onClick()
tree = await settle()
ok('UD 接受删除的一侧：对侧删的是整个文件，接受它＝空文件', resultText(tree) === '' && mergeCount(tree) === '全部已解决（0 个冲突）')
tree = await settle()
tree = await openFixture('bad.txt', { ok: false, error: 'not-unmerged', path: 'bad.txt', stderr: '这个路径已经不在冲突列表里（ls-files -u 没有它）：它可能已经被解决，或者仓库已经变过。' })
ok('答复 not-ok：错误 pane 把 stderr 原话给出（不是一片空白）',
  byClass(tree, 'dsh-git-error').some((n) => textOf(n).indexOf('这个路径已经不在冲突列表里') >= 0) && textareas(tree).length === 0)

console.log('')
console.log('== 接线：mergeTarget 的开与关 ==')
tree = await settle()
tree = await openFixture('app5.txt', replyOf('/tmp/ws', 'app5.txt', ONE.base, ONE.ours, ONE.theirs))
ok('合并界面占正文（正文不再有变更树）',
  mergeView(tree) !== undefined && byClass(tree, 'dsh-git-trow').length === 0)
await clickText(tree, '历史')
tree = await settle()
ok('切到历史页签：合并界面被清掉（历史页带着自己的正文与分支树侧栏）',
  mergeView(tree) === undefined && buttons(tree).some((b) => textOf(b).indexOf('历史') >= 0))
await clickText(tree, '变更')
tree = await settle()
ok('切回变更：直接是变更树（不是又回到合并界面）',
  changeRowOf(tree, 'app5.txt') !== undefined && mergeView(tree) === undefined)
tree = await openConflictOf('app5.txt')
ok('再点冲突行界面又开（开与关都走 mergeTarget）', mergeView(tree) !== undefined)
await clickText(tree, '⚙')
tree = await settle()
ok('⚙ 关掉本界面、切到面板自己的「配置」页',
  mergeView(tree) === undefined && byClass(tree, 'dsh-git-set-group').length > 0)
await clickText(tree, '变更')
tree = await settle()
tree = await openConflictOf('app5.txt')
reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws/alpha', '/tmp/ws/beta'], manual: [], missing: [] }
const pop2 = async () => renderUntilStable(makeElement(popover, { sessionId: 's-2' }), 'pop2')
let multi = await pop2()
await wait(20)
multi = await pop2()
await clickText(multi, '变更')
multi = await pop2()
const pickRow = (t, path) => byClass(t, 'dsh-git-repo-row').find((r) => String(r.props.key) === 'repo:' + path)
pickRow(multi, '/tmp/ws/alpha').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
pickRow(multi, '/tmp/ws/beta').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
await wait(30)
multi = await pop2()
/* 此刻的快照里冲突路径是 app5.txt（上一节 openFixture 留下的），多仓库分组里每个
   仓库各有一行它；点 alpha 组里那一行，请求必须带上 alpha 自己的仓库。 */
conflictReply = replyOf('/tmp/ws/alpha', 'app5.txt', ONE.base, ONE.ours, ONE.theirs)
const markMulti = mergeCalls.length
const alphaRow = changeRowOf(multi, 'app5.txt')
alphaRow.props.onClick()
multi = await pop2()
multi = await pop2()
ok('多仓库分组里 alpha 的冲突行点开：git/conflict 带上它自己那个仓库（落回文件自己的仓库）',
  mergeCalls.length === markMulti + 1
  && mergeCalls[markMulti].repo === '/tmp/ws/alpha' && mergeCalls[markMulti].path === 'app5.txt')
ok('标题的仓库名也跟着这个仓库（答复里解析出的 repo）',
  mergeTitle(multi) === '合并 alpha 的 app5.txt 的修订' && mergeView(multi) !== undefined)
/* 合并界面与 diff 同一个「下钻占满正文」的形状：它开着的时候侧栏（仓库行所在）
   不在屏上，真正的切仓手势是先回去 —— applyRepo 清 mergeTarget 的那一行与四个
   页签的清掉是同一条路，页签的已在上面钉过；这里钉可达的那一半：← 回列表后多
   仓库侧栏原样回来，单击 beta 的仓库行照旧切生效仓库。 */
const backFromMerge = toolBtn(multi, '返回变更列表（不写任何字节）')
backFromMerge.props.onClick()
await wait(10)
multi = await pop2()
multi = await pop2()
const betaRepoRow = byClass(multi, 'dsh-git-repo-row').find((r) => String(r.props.key) === 'repo:/tmp/ws/beta')
betaRepoRow.props.onClick({})
await wait(10)
multi = await pop2()
multi = await pop2()
ok('← 回列表：多仓库侧栏原样回来，单击 beta 的仓库行照旧切生效仓库（applyRepo 的老路）',
  mergeView(multi) === undefined
  && byClass(multi, 'dsh-git-repo-row').some((r) => String(r.props.key) === 'repo:/tmp/ws/beta'
    && String(r.props.className).indexOf('dsh-git-repo-cur') >= 0))
