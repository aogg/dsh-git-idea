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
/* ═══ gp40：重构之后新增的能力 ═══
   1. 存储层：旧键迁移、页面拒绝存储时不出事
   2. 历史列表窗口化：只画视口内的行、占位块补足高度、没有高度信息时回退
   3. 行级记忆：只重画该动的行，而且不会把数据冻住
   4. 分支列表：高亮跟着鼠标走，记忆照样如实反映新状态 */

/* ── 1. 存储层 ── */

/* 重写过之后不再兼容旧名字：只认 dsh.git-idea.*，老键放着也不会被读 */
store['dsh.gitops.settings'] = JSON.stringify({ watchEnabled: false, watchFastSec: 7, watchSlowSec: 30, hoverSwitch: true })
store['dsh.gitops.mru'] = JSON.stringify(['legacy-branch'])
store['dsh.git-idea.stars'] = JSON.stringify(['already-new'])

await openPanel()

console.log('')
console.log('== 存储层 ==')
ok('老 settings 键不再被读取', String(store['dsh.git-idea.settings'] || '').indexOf('7') < 0)
ok('老 mru 键不再被读取', String(store['dsh.git-idea.mru'] || '').indexOf('legacy-branch') < 0)
ok('老键没有被改写（也不再被复制）', store['dsh.gitops.mru'] === JSON.stringify(['legacy-branch']))
ok('新键里的既有内容原样保留', JSON.parse(store['dsh.git-idea.stars'])[0] === 'already-new')

/* 改一个设置：写进的就是新键，而且写的是默认值而不是老键里的 7 秒 */
const settingsTree = await renderUntilStable(makeElement(section, {}), 'gp40-store')
/* 第一个勾选框属于「插件配置」（写进 Host 的配置文件），本浏览器的设置从第二个开始。
   挑最后一个（悬停切换）来拨：它不影响后面的用例，而 watchEnabled 关掉的话
   整个套件后半段都不会再有轮询了。 */
const localBoxes = inputs(settingsTree).filter((n) => n.props.type === 'checkbox')
localBoxes[localBoxes.length - 1].props.onChange({ target: { checked: false } })
await wait(10)
const savedSettings = JSON.parse(store['dsh.git-idea.settings'])
ok('设置写进 dsh.git-idea.settings', savedSettings.hoverSwitch === false)
ok('写进去的是默认值，不是老键里的 7 秒', savedSettings.watchFastSec === 3)

/* 页面拒绝存储时：设置页照样渲染，写入不抛错 */
const realStorage = fakeDoc.defaultView.localStorage
fakeDoc.defaultView.localStorage = {
  getItem() { throw new Error('storage disabled') },
  setItem() { throw new Error('storage disabled') },
}
let refused = false
try {
  const tree = await renderUntilStable(makeElement(section, {}), 'gp40-nostore')
  refused = byClass(tree, 'dsh-git-set').length === 1
  const check = inputs(tree).find((n) => n.props.type === 'checkbox')
  if (check !== undefined) check.props.onChange({ target: { checked: false } })
  const reset = buttons(tree).find((b) => textOf(b) === '恢复默认尺寸')
  if (reset !== undefined) reset.props.onClick()
} catch (failure) {
  refused = false
}
ok('存储被拒绝时设置页仍渲染、改写不抛错', refused === true)
fakeDoc.defaultView.localStorage = realStorage

/* ── 2. 历史列表窗口化 ── */

const ROW_H = 26
const COUNT = 200
const many = []
for (let i = 0; i < COUNT; i += 1) {
  many.push({ hash: 'h' + String(i).padStart(6, '0'), subject: 'commit ' + String(i), author: 'mays', date: '2026-09-16', committedAt: nowSec - i * 60, refs: [] })
}
const graphRows = (commits) => commits.map((c, i) => ({ lane: 0, edges: i + 1 < commits.length ? [{ hash: commits[i + 1].hash, lane: 0 }] : [] }))
graphCommits = many
const plainCall = host.call
host.call = function (method, args) {
  if (method !== 'git/graph') return plainCall.call(host, method, args)
  calls.push({ method, args })
  return Promise.resolve({ ok: true, repo: '/tmp/ws', ref: (args && args.ref) || 'main', currentBranch: 'main', commits: graphCommits, rows: graphRows(graphCommits), lanes: 1 })
}

/* 装上 200 个提交的假历史之后要触发一次重读：历史读取是靠筛选条件驱动的 */
byClass(await settle(), 'dsh-git-lf-select')[1].props.onChange({ target: { value: 'mays@example.com' } })
await wait(20)
await settle()

const crow = (tree) => byClass(tree, 'dsh-git-crow')
const padBlocks = (tree) => collect(tree).filter((n) => n.type === 'div' && n.props.className === undefined && n.props.style !== undefined && typeof n.props.style.height === 'string')
const padHeights = (tree) => padBlocks(tree).map((n) => n.props.style.height)

console.log('')
console.log('== 历史列表窗口化 ==')

/* 页面不肯说高度：和窗口化之前完全一样，全都画出来 */
fakeNode.clientHeight = 0
await settle()
const allTree = await settle()
ok('没有高度信息时仍然画满整个历史', crow(allTree).length === COUNT)
ok('没有高度信息时不放占位块', padBlocks(allTree).length === 0)

/* 600px 视口：只画视口 + overscan 圈得住的行 */
fakeNode.clientHeight = 600
fakeNode.scrollTop = 0
const winTree = await settle()
const winRows = crow(winTree)
ok('600px 视口只画 600/26 + 两圈 overscan = 32 行', winRows.length === 32)
ok('首行是第 0 个提交', textOf(winRows[0]).indexOf('commit 0') >= 0)
ok('DOM 节点比全量少一个数量级', collect(winTree).length < collect(allTree).length / 3)
ok('svg 只画窗口内的路径', collect(winTree).filter((n) => n.type === 'path').length < 60)
ok('底部占位块补足剩余高度', padHeights(winTree).join(',') === String((COUNT - 32) * ROW_H) + 'px')

/* 滚到 2600px：窗口跟着走，首行 = floor(2600/26) - 8 = 92 */
fakeNode.scrollTop = 2600
const deepTree = await settle()
const deepRows = crow(deepTree)
ok('滚动后首行是第 92 个提交', textOf(deepRows[0]).indexOf('commit 92') >= 0)
ok('滚动后仍是 40 行（视口 24 + 两圈 16）', deepRows.length === 40)
ok('上下两个占位块对齐：[92, 200-132] 行', padHeights(deepTree).join(',') === String(92 * ROW_H) + 'px,' + String((COUNT - 132) * ROW_H) + 'px')

/* 滚回顶部 */
fakeNode.scrollTop = 0
const backTree = await settle()
ok('滚回顶部又是第 0 行', textOf(crow(backTree)[0]).indexOf('commit 0') >= 0)

/* 窗口里的行照样能点，而且只读这一个提交 */
calls.length = 0
crow(backTree)[3].props.onClick()
await wait(20)
const picked = await settle()
const detailCalls = calls.filter((c) => c.method === 'git/commit-detail')
ok('点窗口内的行只读这一个提交', detailCalls.length === 1 && detailCalls[0].args.hash === 'h000003')
ok('被点的行带上选中样式', byClass(picked, 'dsh-git-crow-sel').length === 1 && textOf(byClass(picked, 'dsh-git-crow-sel')[0]).indexOf('commit 3') >= 0)

/* ── 3. 行级记忆 ── */

console.log('')
console.log('== 行级记忆（提交列表）==')
const skipsBefore = memoSkips
calls.length = 0
crow(picked)[5].props.onClick()
await wait(20)
const picked2 = await settle()
ok('再点一行：memo 跳过了没变的行', memoSkips > skipsBefore)
ok('选中样式只跟着新的那一行走', byClass(picked2, 'dsh-git-crow-sel').length === 1 && textOf(byClass(picked2, 'dsh-git-crow-sel')[0]).indexOf('commit 5') >= 0)
ok('选中时不为别的行读详情', calls.filter((c) => c.method === 'git/commit-detail').length === 1)

/* 记忆不能把数据冻住：换一份历史，行的内容必须跟着变 */
graphCommits = many.map((c, i) => (i === 5 ? Object.assign({}, c, { subject: '改写过的标题' }) : c))
byClass(picked2, 'dsh-git-lf-select')[1].props.onChange({ target: { value: '' } })
await wait(20)
const rewritten = await settle()
ok('历史变了，被记忆的行仍然如实更新', textOf(rewritten).indexOf('改写过的标题') >= 0)
ok('改写后仍然只有 32 行（窗口没有因为重读而失效）', crow(rewritten).length === 32)

/* ── 4. 分支列表 ── */

console.log('')
console.log('== 行级记忆（分支列表）==')
graphCommits = [
  { hash: 'aaa111', subject: 'tip commit', author: 'mays', date: '2026-09-16', committedAt: nowSec - 60, refs: ['HEAD -> dev'] },
]
fakeNode.clientHeight = 0
const swTree = await openSwitcher()
ok('分支行都渲染出来了', branchRows(swTree).length >= 4)

const enterRow = (tree, name, top) => rowWith(tree, name).props.onMouseEnter({ currentTarget: { offsetTop: top }, button: 0 })
enterRow(swTree, 'solo', 60)
await wait(20)
const hoverA = await settle()
ok('鼠标停在 solo 上时只有它高亮', byClass(hoverA, 'dsh-git-bs-row-on').length === 1 && textOf(byClass(hoverA, 'dsh-git-bs-row-on')[0]).indexOf('solo') >= 0)

const skipsBeforeHover = memoSkips
enterRow(hoverA, 'zeta', 120)
await wait(20)
const hoverB = await settle()
ok('高亮跟着鼠标换到 zeta', byClass(hoverB, 'dsh-git-bs-row-on').length === 1 && textOf(byClass(hoverB, 'dsh-git-bs-row-on')[0]).indexOf('zeta') >= 0)
ok('换行时 memo 跳过了其余分支行', memoSkips > skipsBeforeHover)

/* 收藏的按钮现在只有一个，在头部那排动作里，指的是高亮那一行 */
const favIn = (t) => {
  const acts = byClass(t, 'dsh-git-bs-head-acts')[0]
  return acts === undefined ? undefined : buttons(acts).find((b) => String(b.props.className).indexOf('dsh-git-bs-fav') >= 0)
}
const favBefore = favIn(hoverB)
console.log('  收藏按钮 title:', JSON.stringify(favBefore.props.title))
ok('收藏按钮说的是高亮那一行', String(favBefore.props.title).indexOf('zeta') > 0 && favBefore.props.disabled !== true)
favBefore.props.onClick({ stopPropagation() {}, preventDefault() {} })
await wait(20)
const starred = await settle()
const favAfter = favIn(starred)
ok('点一下就收藏了那一行（按钮自己变成已收藏）', String(favAfter.props.className).indexOf('dsh-git-bs-fav-on') >= 0)
ok('收藏之后高亮还在同一个分支上（按钮的主语没有跟着排序跑）',
  String(favAfter.props.title).indexOf('zeta') > 0 && byClass(starred, 'dsh-git-bs-row-on').length === 1
  && textOf(byClass(starred, 'dsh-git-bs-row-on')[0]).indexOf('zeta') >= 0)

/* ── 弹层里的记号要和面板左栏同一套 ──

   同一个含义在两个列表里必须长得一样：分组的折叠是文本 ▼/▶（面板的 twisty），
   当前分支是 ★（面板 HEAD 行那个），每一行的分支标记都一样（不再只有当前行换成
   铅笔），动作 chip 用面板头部那几个字符（⇣ ↓ ↑ +）而不是另画一套 SVG。 */

console.log('')
console.log('== 弹层与面板：同一套记号 ==')
ok('弹层里也有一列专门放「当前分支」的记号', byClass(starred, 'dsh-git-bs-cur').length === branchRows(starred).length)
const curRow = branchRows(starred).find((r) => String(r.props.className).indexOf('dsh-git-bs-row-cur') >= 0)
console.log('  当前分支行:', textOf(byClass(curRow, 'dsh-git-bs-name')[0]), JSON.stringify(textOf(byClass(curRow, 'dsh-git-bs-cur')[0])))
ok('当前分支用面板那个 ★，不是铅笔', textOf(byClass(curRow, 'dsh-git-bs-cur')[0]) === '★')
ok('别的行那一列是空的（只是占位，和面板的 twisty 槽一样宽）',
  branchRows(starred).filter((r) => textOf(byClass(r, 'dsh-git-bs-cur')[0]) === '').length === branchRows(starred).length - 1)
ok('每一行画的分支标记都一样（同一套，没有例外）',
  branchRows(starred).every((r) => byClass(r, 'dsh-git-bs-ico').length === 1))

const group = byClass(starred, 'dsh-git-bs-group')[0]
ok('分组折叠用的是面板的 twisty（文本 ▼/▶）',
  group !== undefined && byClass(group, 'dsh-git-tw').length === 1 && ['▼', '▶'].indexOf(textOf(byClass(group, 'dsh-git-tw')[0])) >= 0)
ok('分组头里不再有自画的 SVG 箭头', group !== undefined && collect(group).filter((n) => n.type === 'svg').length === 0)

const chipsRow = byClass(starred, 'dsh-git-bs-head-acts')[0]
const chipTexts = (chipsRow === undefined ? [] : buttons(chipsRow)).map((b) => textOf(b))
console.log('  动作 chip:', JSON.stringify(chipTexts))
ok('动作 chip 只有记号，没有文字（文字在 title 里；角标是数字，留着）',
  chipTexts.length === 5 && chipTexts[0] === '⇣' && chipTexts[1].indexOf('↓') === 0 && chipTexts[2].indexOf('↑') === 0
  && chipTexts[3] === '+' && ['☆', '★'].indexOf(chipTexts[4]) >= 0
  && chipTexts.join('').search(/[\u4e00-\u9fa5]/) < 0)
ok('动作 chip 用的是面板那几个字符，不是另画一套 SVG',
  chipsRow !== undefined && collect(chipsRow).filter((n) => n.type === 'svg').length === 0)
ok('收藏按钮就在这排动作里', favIn(starred) !== undefined)

const zetaRow = rowWith(starred, 'zeta')
const kids = zetaRow.props.children
const nameAt = kids.findIndex((c) => String(c.props.className || '').indexOf('dsh-git-bs-name') >= 0)
const moreAt = kids.findIndex((c) => String(c.props.className || '').indexOf('dsh-git-bs-more') >= 0)
ok('行里不再有星标按钮（收藏已经搬到上面那排）',
  buttons(zetaRow).every((b) => String(b.props.className).indexOf('dsh-git-bs-star') < 0))
ok('行尾那一个按钮是「这个分支能做的事」，在名字后面', moreAt > nameAt)

/* 记忆的行也要跟着筛选走：列表变了，内容必须跟着变 */
const filter = inputs(starred).find((n) => n.props.className !== undefined && String(n.props.className).indexOf('dsh-git-bs-search') >= 0)
filter.props.onChange({ target: { value: 'feature' } })
await wait(20)
const filtered = await settle()
ok('筛选后只剩匹配的分支', branchRows(filtered).length === 1 && textOf(branchRows(filtered)[0]).indexOf('feature/one') >= 0)

/* ── 5. Host 还没注册好时自动重试 ── */

console.log('')
console.log('== Host 未就绪时的重试 ==')

/* 只有「is not registered」值得重试：那是 Host 半侧还没读完自己的源码，
   调用根本没到处理器。别的错误一次就结束。 */
const firePendingTimeouts = async function () {
  const pending = timers.filter((t) => t.kind === 'timeout' && t.dead !== true)
  for (const t of pending) { t.dead = true; t.cb() }
  await wait(5)
}

/* 回到「200 个提交 + 有视口」的状态：这时行数才有意义 */
graphCommits = many
fakeNode.clientHeight = 600
fakeNode.scrollTop = 0

const plainCall2 = host.call
let refusals = 0
host.call = function (method, args) {
  if (method === 'git/graph' && refusals < 2) {
    refusals += 1
    calls.push({ method, args })
    return Promise.reject(new Error('host.call("git/graph") on dshgit-3 is not registered: the host half must declare it with harness.handle("git/graph", fn).'))
  }
  return plainCall2.call(host, method, args)
}

byClass(filtered, 'dsh-git-lf-select')[1].props.onChange({ target: { value: 'mays@example.com' } })
await wait(10)
await settle()                                   /* 效果跑起来，第一次被拒 */
for (let i = 0; i < 3; i += 1) await firePendingTimeouts()   /* 重试定时器：第二次被拒，第三次成功 */
await wait(20)
const retried = await settle()
ok('Host 尚未注册时被拒绝，随后自动重试成功', refusals === 2)
ok('重试之后拿到的是这一轮的数据', crow(retried).length === 32 && textOf(retried).indexOf('commit 5') >= 0)

/* 别的错误不重试：一次就报错，不拖满 24 次 */
const plainCall3 = host.call
let hardFailures = 0
host.call = function (method, args) {
  if (method === 'git/graph') {
    hardFailures += 1
    return Promise.reject(new Error('boom'))
  }
  return plainCall3.call(host, method, args)
}
byClass(retried, 'dsh-git-lf-select')[1].props.onChange({ target: { value: '' } })
await wait(30)
await settle()
ok('普通错误一次就结束，不会反复重试', hardFailures === 1)
host.call = plainCall3

/* ── 6. IDEA 式布局 ── */

console.log('')
console.log('== IDEA 式布局 ==')

/* 回到干净状态：200 个提交、没有筛选 */
host.call = plainCall2
byClass(await settle(), 'dsh-git-lf-select')[1].props.onChange({ target: { value: '' } })
await wait(20)
let idea = await settle()

const pick = (tree, cls) => collect(tree).filter((n) => typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(cls) >= 0)
const sideSearch = inputs(idea).find((n) => String(n.props.className).indexOf('dsh-git-sidehead-input') >= 0)
ok('左栏顶上多了一个搜索框', sideSearch !== undefined && sideSearch.props.placeholder === '搜索分支')
ok('左栏默认列出全部分支', pick(idea, 'dsh-git-tname').map(textOf).join(',').indexOf('feature') >= 0)

sideSearch.props.onChange({ target: { value: 'fea' } })
await wait(10)
const filteredTree = await settle()
const namesNow = pick(filteredTree, 'dsh-git-tname').map(textOf)
ok('搜分支后只剩匹配的行', namesNow.join(',').indexOf('feature') >= 0 && namesNow.join(',').indexOf('stable') < 0)
ok('分组标题仍然在，条数是过滤后的', pick(filteredTree, 'dsh-git-tdim').map(textOf).indexOf('1') >= 0)

const sideClear = buttons(filteredTree).find((b) => String(b.props.className).indexOf('dsh-git-sidehead-x') >= 0)
ok('搜索框带清除按钮', sideClear !== undefined)
sideClear.props.onClick()
await wait(10)
const cleared = await settle()
ok('清除后分支又都回来了', pick(cleared, 'dsh-git-tname').map(textOf).join(',').indexOf('stable') >= 0)

/* 工具栏：筛选在左、开菜单的 ⋯/⚡ 在右，中间夹着 IDEA 的 .* 和 Cc */
const bar = byClass(cleared, 'dsh-git-tools')[0]
const nodes = collect(bar)
const indexOfClass = (cls) => nodes.findIndex((n) => typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(cls) >= 0)
ok('搜索框在最前，开菜单的 ⋯/⚡ 最后（IDEA 的顺序）', indexOfClass('dsh-git-logsearch') < indexOfClass('dsh-git-lf') && indexOfClass('dsh-git-lf') < indexOfClass('dsh-git-acts'))
const flags = pick(bar, 'dsh-git-lf-flag')
const flagOn = (b) => String(b.props.className).indexOf('dsh-git-lf-on') >= 0
ok('搜索框旁边是 .* 和 Cc 两个开关', flags.length === 2 && textOf(flags[0]) === '.*' && textOf(flags[1]) === 'Cc')
ok('两个开关默认都是关的（搜索行为不变）', flagOn(flags[0]) === false && flagOn(flags[1]) === false)

/* 先给搜索框一个词：没有搜索词的时候这两个开关没有意义，请求里也就不带 */
inputs(cleared).find((n) => String(n.props.className).indexOf('dsh-git-logsearch-input') >= 0)
  .props.onKeyDown({ key: 'Enter', preventDefault() {} })
await wait(10)
byClass(await settle(), 'dsh-git-logsearch-input')[0].props.onChange({ target: { value: 'tip' } })
byClass(await settle(), 'dsh-git-logsearch-input')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })
await wait(20)
const searched = await settle()

const graphCalls = () => calls.filter((c) => c.method === 'git/graph')
calls.length = 0
pick(searched, 'dsh-git-lf-flag')[0].props.onClick()
await wait(20)
const withRegex = await settle()
const lastAsk = graphCalls().pop()
ok('打开 .* 之后请求带上 regex，而且搜索词还在', lastAsk !== undefined && lastAsk.args.regex === true && lastAsk.args.search === 'tip' && lastAsk.args.caseSensitive === undefined)

calls.length = 0
pick(withRegex, 'dsh-git-lf-flag')[1].props.onClick()
await wait(20)
await settle()
const lastAsk2 = graphCalls().pop()
ok('再打开 Cc 之后请求带上 caseSensitive', lastAsk2 !== undefined && lastAsk2.args.caseSensitive === true && lastAsk2.args.regex === true)

/* 选中那个提交在新的一份历史里不存在：重读之后选中被清掉，右栏回到空态 */
graphCommits = many.slice(0, 3)
pick(await settle(), 'dsh-git-lf-flag')[0].props.onClick()
await wait(20)
const noSelection = await settle()
const emptyPane = byClass(noSelection, 'dsh-git-detail-empty')
ok('右栏空态有自己的版式', emptyPane.length === 1 && textOf(emptyPane[0]).indexOf('选择一个提交') >= 0 && textOf(emptyPane[0]).indexOf('未选择提交') >= 0)

/* ── 7. 加载更多 + 面板分两段读 + 轮询按需加深 ── */

console.log('')
console.log('== 加载更多 / 分两段读 ==')

/* 比一页多的历史：260 条，第一页只能给 200 */
graphCommits = many.concat(many.slice(0, 60).map((c, i) => Object.assign({}, c, { hash: 'x' + String(i).padStart(6, '0') })))
const graphPage = function (args) {
  const want = args != null && typeof args.maxCount === 'number' ? args.maxCount : 200
  const slice = graphCommits.slice(0, want)
  return {
    ok: true, repo: '/tmp/ws', ref: 'main', currentBranch: 'main',
    commits: slice, rows: graphRows(slice), lanes: 1,
    hasMore: graphCommits.length > want, maxCount: want,
  }
}
host.call = function (method, args) {
  if (method !== 'git/graph') return plainCall2.call(host, method, args)
  calls.push({ method, args })
  return Promise.resolve(graphPage(args))
}
/* 触发一次重读：换个开关 */
pick(await settle(), 'dsh-git-lf-flag')[0].props.onClick()
await wait(20)
let paged = await settle()
ok('历史读到一页时列表底部给出「加载更多」', byClass(paged, 'dsh-git-more').length === 1 && textOf(byClass(paged, 'dsh-git-more')[0]).indexOf('已显示 200 条') >= 0)

calls.length = 0
buttons(byClass(paged, 'dsh-git-more')[0]).find((b) => textOf(b) === '加载更多').props.onClick()
await wait(20)
paged = await settle()
const asks = calls.filter((c) => c.method === 'git/graph')
ok('点它就去要更大的一页', asks.length >= 1 && asks[asks.length - 1].args.maxCount === 400)
ok('第二页把剩下的也要来了（列表长到 260 行），底部收起来',
  byClass(paged, 'dsh-git-more').length === 0
  && byClass(paged, 'dsh-git-logwrap')[0].props.style.minHeight === String(260 * ROW_H) + 'px')

/* 面板读工作区也是两段：先身份、后工作区 */
calls.length = 0
buttons(paged).find((b) => textOf(b) === '变更').props.onClick()
await wait(20)
const changesTab = await settle()
const panelAsks = calls.filter((c) => c.method === 'git/panel')
ok('切到变更页时先发便宜的身份读', panelAsks.length >= 1 && panelAsks[0].args.quick === true)

/* ── 轮询：历史页用便宜的签名；变更页的深读只问屏幕上那些路径 ──

   整棵树的 `git status` 在慢挂载上是 7.4s（README 里那组数字），而这个 tick 隔
   几秒就跑一次：探针比间隔还长，挂载就没有休息的时候，旁边的分支列表和日志都
   在排队。所以深读带的是 pathspec，路径来自面板正在显示的那份快照；一份什么都
   没有的快照没有可看的路径，深读就交给面板自己的整树时钟（见「深读问哪些路径」）。 */
buttons(changesTab).find((b) => textOf(b) === '历史').props.onClick()
await wait(20)
let logTab = await settle()
const tickIntervals = async () => {
  timers.filter((t) => t.kind === 'interval' && t.dead !== true).forEach((t) => t.cb())
  await wait(10)
}
const lastWatch = () => calls.filter((c) => c.method === 'git/watch').pop()
calls.length = 0
await tickIntervals()
const watchLog = lastWatch()
ok('历史页的轮询不带 deep', watchLog !== undefined && watchLog.args.deep === undefined)

/* 让面板看到一处改动，它才有路径可交给深读 */
const panelBeforePaths = host.call
host.call = function (method, args) {
  if (method === 'git/panel' && args != null && args.quick !== true) {
    calls.push({ method: method, args: args })
    return Promise.resolve({
      ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0, sequencer: null,
      staged: [], unstaged: [{ path: 'src/app.js', code: 'M' }], untracked: [], unmerged: [],
    })
  }
  return panelBeforePaths(method, args)
}
calls.length = 0
buttons(logTab).find((b) => textOf(b) === '变更').props.onClick()
await wait(20)
const backToChanges = await settle()
await tickIntervals()
const watchChanges = lastWatch()
ok('变更页的轮询带 deep（要看工作区）', watchChanges !== undefined && watchChanges.args.deep === true)
ok('深读带着屏幕上那些路径（整棵树 7.4s，这些路径 0.5s）',
  Array.isArray(watchChanges.args.paths) && watchChanges.args.paths.indexOf('src/app.js') >= 0)
ok('路径里还有它所在的目录（旁边新出现的文件同样被看见）',
  watchChanges.args.paths.indexOf('src') >= 0 && watchChanges.args.paths.length === 2)
host.call = panelBeforePaths
buttons(backToChanges).find((b) => textOf(b) === '历史').props.onClick()
await wait(20)
await settle()

/* ── 8. 分支树上的提交差异 ── */

console.log('')
console.log('== 分支树上的领先/落后与未提交改动 ==')

const beforeRefs = host.call
host.call = function (method, args) {
  if (method === 'git/refs') {
    calls.push({ method, args })
    return Promise.resolve({
      ok: true, repo: '/tmp/ws', current: ['main'],
      local: [
        { segments: ['main'], data: 'main', upstream: 'origin/main', ahead: 2, behind: 1, at: nowSec - 60 },
        { segments: ['feature'], data: 'feature', upstream: 'origin/feature', ahead: 0, behind: 3, at: nowSec - 900 },
        { segments: ['stable'], data: 'stable', upstream: 'origin/stable', ahead: 4, behind: 0, at: nowSec - 90000 },
        { segments: ['lone'], data: 'lone', upstream: '', ahead: 0, behind: 0, at: 0 },
      ],
      remote: [],
    })
  }
  if (method === 'git/panel') {
    calls.push({ method, args })
    const base = { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 1, sequencer: null }
    if (args != null && args.quick === true) {
      return Promise.resolve(Object.assign({ partial: true, staged: [], unstaged: [], untracked: [], unmerged: [] }, base))
    }
    /* 3 个未提交改动：1 已暂存、1 已改未暂存、1 未跟踪 */
    return Promise.resolve(Object.assign({
      staged: [{ path: 'a.txt', code: 'M.', label: 'M/ ' }],
      unstaged: [{ path: 'b.txt', code: '.M', label: ' /M' }],
      untracked: [{ path: 'c.txt', code: '??' }],
      unmerged: [],
    }, base))
  }
  return beforeRefs.call(host, method, args)
}

/* 全新挂载一次，让 refs 与 panel 都用上面这份数据读一遍 */
fibers.clear()
await openPanel()
await wait(30)
const withCounts = await settle()
const trows = collect(withCounts).filter((n) => typeof n.props.className === 'string' && n.props.className.split(' ').indexOf('dsh-git-trow') >= 0)
const rowNamed = (name) => trows.find((n) => textOf(n).indexOf(name) >= 0)
ok('落后 3 的分支显示 ↓3，而且是「需要拉取」的蓝色一档',
  textOf(rowNamed('feature')).indexOf('↓3') >= 0
  && /dsh-git-ab-in/.test(String(pick(rowNamed('feature'), 'dsh-git-ab')[0].props.className)))
ok('领先 4 的分支显示 ↑4，而且是「需要推送」的绿色一档',
  textOf(rowNamed('stable')).indexOf('↑4') >= 0
  && /dsh-git-ab-out/.test(String(pick(rowNamed('stable'), 'dsh-git-ab')[0].props.className)))
ok('领先又落后的两个都显示', textOf(rowNamed('main')).indexOf('↑2') >= 0 && textOf(rowNamed('main')).indexOf('↓1') >= 0)
ok('没有上游的分支两个都不显示', textOf(rowNamed('lone')).indexOf('↑') < 0 && textOf(rowNamed('lone')).indexOf('↓') < 0)
ok('当前分支顶上显示未提交改动数（●3）', textOf(rowNamed('main')).indexOf('●3') >= 0)
const headRow = rowNamed('main')
ok('当前分支加粗（IDEA 的写法）',
  /dsh-git-trow-head/.test(String(headRow.props.className))
  && /dsh-git-trow-head/.test(String(rowNamed('feature').props.className)) === false)
ok('tooltip 说明了箭头与未提交的含义',
  String(rowNamed('feature').props.title).indexOf('落后上游 3 个提交') >= 0
  && String(rowNamed('main').props.title).indexOf('未提交改动') >= 0)

host.call = beforeRefs
fibers.clear()
await openPanel()
await wait(20)
await settle()

/* ── 6. 设置页在左栏里的名字 ──

   图标那一项外壳没提供（注册选项只有 id/order/label），所以不绕路去改它：
   这里只盯名字 —— 左栏显示的那行文案和页面上自己的标题必须是同一个。 */

console.log('')
console.log('== 设置页的名字 ==')
const sectionReg = registered.find((r) => r.options.id === 'dsh-git-idea')
ok('左栏里的名字就是页面上那行标题',
  sectionReg.options.label === 'dsh-git-idea配置'
  && textOf(byClass(await renderUntilStable(makeElement(section, {}), 'gp40-label'), 'dsh-git-set-h')[0]) === 'dsh-git-idea配置')

/* ── 7. 工作区不是仓库时：只认这个目录 ── */

console.log('')
console.log('== 工作区不是仓库时的说明页 ==')
/* 面板只说「这个目录不是仓库」：不声称查过上级目录，也不偷看里面有什么。
   指路和初始化仍然留着 —— 那是人的决定，不是插件自己去探索。 */
const beforeSetup = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    return Promise.resolve({
      ok: false, repo: '/home/u/work/plain', error: 'not-a-repository', reason: 'not-a-repo',
      stderr: '', exitCode: 1, staged: [], unstaged: [], untracked: [], unmerged: [],
    })
  }
  return beforeSetup(method, args)
}
let setupTree = null
for (let i = 0; i < 4; i += 1) {
  setupTree = await renderUntilStable(makeElement(popover, { sessionId: 's-setup' }), 'gp40-setup')
  await wait(10)
}
const setupTitle = textOf(byClass(setupTree, 'dsh-git-setup-h')[0])
/* 面板头部的提示也用 .dsh-git-hint，这里只看说明页自己那一块 */
const setupBox = byClass(setupTree, 'dsh-git-setup')[0]
const setupHints = byClass(setupBox, 'dsh-git-hint').map((n) => textOf(n)).join(' | ')
const setupButtons = buttons(setupTree).filter((b) => String(b.props.className).indexOf('dsh-git-btn') >= 0).map((b) => textOf(b))
console.log('  标题:', setupTitle)
console.log('  说明:', setupHints.length > 0 ? setupHints : '（没有）')
console.log('  按钮:', setupButtons.join(' / '))
console.log('  展示的路径:', textOf(byClass(setupTree, 'dsh-git-setup-path')[0]))
ok('标题只说这个目录不是仓库', setupTitle === '这个目录不是 Git 仓库')
ok('不再声称「所有上级目录都没有 .git」',
  setupHints.indexOf('所有上级目录') < 0 && setupHints.indexOf('都没有') < 0)
ok('也不再声称看过目录里有什么', setupHints.indexOf('空目录') < 0 && setupHints.indexOf('没有任何文件') < 0)
/* 要看的路径已经显示在上面了：没有要解释的规则，也没有要填的东西。 */
ok('整页一句说明都没有', setupHints.length === 0)
ok('不再让人把同一个路径再抄一遍（没有输入框）', inputs(setupBox).length === 0)
ok('要看的目录本身仍然写着', textOf(byClass(setupTree, 'dsh-git-setup-path')[0]) === '/home/u/work/plain')
ok('指路与初始化仍然在（不替用户做决定，也不挡着）',
  setupButtons.indexOf('打开这个目录') >= 0 && setupButtons.indexOf('在此初始化仓库') >= 0)
host.call = beforeSetup

/* 只有「这里没有仓库」才不需要人填路径；路径没定或有问题时输入框得留着。 */
const beforeNoPath = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    return Promise.resolve({
      ok: false, repo: '/home/u/work/other', error: 'no-session-repo', reason: 'no-path',
      stderr: '', exitCode: 1, staged: [], unstaged: [], untracked: [], unmerged: [],
    })
  }
  return beforeNoPath(method, args)
}
let noPathTree = null
for (let i = 0; i < 4; i += 1) {
  noPathTree = await renderUntilStable(makeElement(popover, { sessionId: 's-setup-nopath' }), 'gp40-nopath')
  await wait(10)
}
const noPathBox = byClass(noPathTree, 'dsh-git-setup')[0]
const noPathHints = byClass(noPathBox, 'dsh-git-hint').map((n) => textOf(n)).join(' | ')
ok('路径没定时说明还在', noPathHints.indexOf('手动填写') >= 0)
ok('路径没定时输入框也还在', inputs(noPathBox).length === 1)
host.call = beforeNoPath

/* 目录是对的，机器上少了 git。这时改路径没有用，`git init` 也只会再失败一次 ——
   两件都别留，只留「打开这个目录」当作装好之后的重试（面板不知道用户什么时候装）。 */
const beforeNoGit = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    return Promise.resolve({
      ok: false, repo: '/home/u/work/repo', error: 'not-a-repository', reason: 'no-git',
      stderr: '', exitCode: null, staged: [], unstaged: [], untracked: [], unmerged: [],
    })
  }
  return beforeNoGit(method, args)
}
let noGitTree = null
for (let i = 0; i < 4; i += 1) {
  noGitTree = await renderUntilStable(makeElement(popover, { sessionId: 's-setup-nogit' }), 'gp40-nogit')
  await wait(10)
}
const noGitBox = byClass(noGitTree, 'dsh-git-setup')[0]
const noGitTitle = textOf(byClass(noGitTree, 'dsh-git-setup-h')[0])
const noGitHints = byClass(noGitBox, 'dsh-git-hint').map((n) => textOf(n)).join(' | ')
const noGitButtons = buttons(noGitTree).filter((b) => String(b.props.className).indexOf('dsh-git-btn') >= 0).map((b) => textOf(b))
console.log('  没有 git 时:', JSON.stringify({ 标题: noGitTitle, 说明: noGitHints, 按钮: noGitButtons }))
ok('说的是「找不到 git」，不是「这不是一个仓库」', noGitTitle === '这台机器上找不到 git')
ok('说明里指出了出路（装 git，或让它在 dsh 进程的 PATH 里）',
  noGitHints.indexOf('git') >= 0 && noGitHints.indexOf('PATH') >= 0)
ok('（对照）这句话没有和 not-a-repo 共用一套文案', noGitTitle !== '这个目录不是 Git 仓库')
ok('不留输入框：路径不是问题，再抄一遍也没用', inputs(noGitBox).length === 0)
ok('不留初始化按钮：git init 在这里只会再失败一次', noGitButtons.indexOf('在此初始化仓库') < 0)
ok('留一个重试，装好之后点它', noGitButtons.indexOf('打开这个目录') >= 0)
host.call = beforeNoGit
