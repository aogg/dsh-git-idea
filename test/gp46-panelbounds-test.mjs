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
/* ── 面板与悬停卡片在会话滚动体里的真实上界（hero 相位显示不全的回归）──
 *
 * 根因（见 src/client/14-geometry.js 头注释）：面板和 chip 悬停卡片都 absolute 挂在
 * 输入框卡片上沿、向上生长，而输入框整棵子树住在会话滚动体（overflow-y:auto）里；
 * 滚动容器只会向下扩展可滚动区域，超出滚动体上沿的部分永远滚不回来。15ab5a3 按
 * 「视口上沿」钳高，hero 相位（新会话输入框垂直居中）面板顶被推到视口顶附近，整条
 * 头部恰好落在滚动体上沿之上被裁 —— 显示不全。
 *
 * 这一套用假的祖先链（有 rect、有 computedStyle.overflowY 的纯对象）把官方那几层
 * 结构摆出来，断言三件事：
 *   1. hero：钳制的上界是滚动体的可见上沿，不是视口上沿 —— 面板顶必须落在它之下；
 *   2. 跟随：rAF 循环里锚点和上界一起量，相位切换（居中→落底）、滚动体位移、多道
 *      裁剪祖先（取最靠下的一道）都实时跟着变；
 *   3. 退路：上界一环都量不到（没有 getComputedStyle）时退回视口上沿 —— 即 15ab5a3
 *      的旧边界，不比它更差。
 * 悬停卡片同款：钳出来的空间写成 maxHeight（列表自己滚），空间小到会压碎卡片就不钳。
 * 乘法口诀：availH = 锚点上沿 − 8(间距) − 1(余量) − 上界。 */

const fakeView = fakeDoc.defaultView
fakeView.getComputedStyle = function (node) {
  return {
    overflowY: node.__overflowY !== undefined ? node.__overflowY : 'visible',
    borderTopWidth: (node.__borderTop != null ? node.__borderTop : 0) + 'px',
  }
}
let rafQueue = []
fakeView.requestAnimationFrame = function (cb) { rafQueue.push(cb); return rafQueue.length }
fakeView.cancelAnimationFrame = function (id) { rafQueue[id - 1] = null }
const fireFrame = function () {
  const queue = rafQueue
  rafQueue = []
  for (const cb of queue) if (typeof cb === 'function') cb()
}
const fireTimers = function (delay) {
  for (const t of timers) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}

/* 假的祖先链：面板 ← 0×0 的 auto 层（display:contents 那类，必须被跳过）
   ← visible 行 ← 会话滚动体（auto，可见上沿 scrollTop）← 根（visible/hidden）。
   元素都带 ownerDocument —— clipCeiling 靠它找到 getComputedStyle 的 window。 */
let anchorTop = 400
let scrollTop = 76
let rootTop = 0
let rootClip = 'visible'
const anchorObj = { ownerDocument: fakeDoc, getBoundingClientRect: () => ({ top: anchorTop, left: 100, width: 760, height: 0 }) }
const zeroBox = { ownerDocument: fakeDoc, __overflowY: 'auto', getBoundingClientRect: () => ({ top: 0, width: 0, height: 0 }) }
const rowBox = { ownerDocument: fakeDoc, __overflowY: 'visible', getBoundingClientRect: () => ({ top: 60, width: 1000, height: 700 }) }
const scrollBody = { ownerDocument: fakeDoc, __overflowY: 'auto', getBoundingClientRect: () => ({ top: scrollTop, width: 1000, height: 824 }) }
const rootBox = { ownerDocument: fakeDoc, get __overflowY() { return rootClip }, getBoundingClientRect: () => ({ top: rootTop, width: 1400, height: 900 }) }
zeroBox.parentElement = rowBox
rowBox.parentElement = scrollBody
scrollBody.parentElement = rootBox
/* 生产里：面板的定位祖先是卡片顶的零高锚点；chip 的定位祖先是输入框卡片（同一个
   上沿）。测试里两者共用 anchorObj —— 钳制只读它的 top。chip 自己也在滚动体里，
   parentElement 接同一条祖先链。 */
panelNodeObj.offsetParent = anchorObj
panelNodeObj.parentElement = zeroBox
chipNodeObj.offsetParent = anchorObj
chipNodeObj.parentElement = rowBox

const popOf = (tree) => byClass(tree, 'dsh-git-pop')[0]
const heightOf = (tree) => {
  const pop = popOf(tree)
  const style = pop !== undefined ? pop.props.style : undefined
  return style != null && style.height !== undefined ? parseFloat(style.height) : null
}
async function closePanel() {
  const t = await chipTree()
  if (t.props.className.indexOf('dsh-git-chip-open') >= 0) { t.props.onClick(); await wait(10) }
  return await chipTree()
}

console.log('')
console.log('== hero 相位：钳制的上界是滚动体上沿，不是视口上沿 ==')
let tree = await openPanel()
ok('面板打开着', popOf(tree) !== undefined && String(popOf(tree).props.className).indexOf('dsh-git-hidden') < 0)
ok('高度 = 400−8−1−76 = 315（15ab5a3 的旧边界给 391，头部会整体越过滚动体上沿）', heightOf(tree) === 315)
ok('面板顶（锚点−8−高）落在滚动体上沿之下：400−8−315=77 ≥ 76', 400 - 8 - 315 >= 76)

console.log('')
console.log('== 相位切换（居中→落底）：rAF 一帧内跟上，且空间够时不再钳 ==')
anchorTop = 760
fireFrame()
tree = await settle()
ok('锚点落到 760 后，余量 675 ≥ 期望 666，高度交还 CSS（不写 inline）', heightOf(tree) === null)

console.log('')
console.log('== 滚动体自己的位移：上界跟着量 ==')
scrollTop = 120
anchorTop = 700
fireFrame()
tree = await settle()
ok('高度 = 700−8−1−120 = 571', heightOf(tree) === 571)
ok('面板顶 700−8−571=121 ≥ 120，仍在滚动体内', 700 - 8 - 571 >= 120)

console.log('')
console.log('== 多道裁剪祖先：取最靠下的一道 ==')
rootClip = 'hidden'
rootTop = 200
fireFrame()
tree = await settle()
ok('根（hidden，top 200）比滚动体（120）更靠下，上界取 200：高度 = 700−9−200 = 491', heightOf(tree) === 491)

console.log('')
console.log('== 上界一环都量不到：退回视口上沿（15ab5a3 的行为，不更差）==')
delete fakeView.getComputedStyle
anchorTop = 400
fireFrame()
tree = await settle()
ok('没有 getComputedStyle 时按视口上沿（0）钳：高度 = 400−9 = 391', heightOf(tree) === 391)
fakeView.getComputedStyle = function (node) {
  return {
    overflowY: node.__overflowY !== undefined ? node.__overflowY : 'visible',
    borderTopWidth: (node.__borderTop != null ? node.__borderTop : 0) + 'px',
  }
}
rootClip = 'visible'
rootTop = 0
scrollTop = 76

console.log('')
console.log('== 悬停卡片：同一套上界，钳出来的空间写成 maxHeight ==')
await closePanel()
let chipTreeNow = await chipTree()
chipTreeNow.props.onPointerEnter()
fireTimers(180)
let hover = await settle('pop')
let card = byClass(hover, 'dsh-git-switch-hover')[0]
ok('悬浮 chip 后出现 hover 卡片', card !== undefined)
ok('卡片带着钳制类（.dsh-git-switch-cap）', card !== undefined && String(card.props.className).indexOf('dsh-git-switch-cap') >= 0)
ok('maxHeight = 同一个可见空间 315', card !== undefined && card.props.style != null && card.props.style.maxHeight === '315px')

console.log('')
console.log('== 悬停卡片：收起再悬停按新几何重量 ==')
card.props.onPointerLeave()
fireTimers(200)
/* 收起也要让 popover 看见（mode=null → 钳制松开）：真实 React 里 signal 一通知就
   重画，这个迷你 React 得显式渲染一轮。 */
await settle('pop')
anchorTop = 500
chipTreeNow = await chipTree()
chipTreeNow.props.onPointerEnter()
fireTimers(180)
hover = await settle('pop')
card = byClass(hover, 'dsh-git-switch-hover')[0]
ok('锚点落到 500 后重新量：maxHeight = 500−8−1−76 = 415', card !== undefined && card.props.style != null && card.props.style.maxHeight === '415px')

console.log('')
console.log('== 悬停卡片：空间小到会压碎卡片就不钳 ==')
card.props.onPointerLeave()
fireTimers(200)
await settle('pop')
anchorTop = 250
chipTreeNow = await chipTree()
chipTreeNow.props.onPointerEnter()
fireTimers(180)
hover = await settle('pop')
card = byClass(hover, 'dsh-git-switch-hover')[0]
ok('可见空间只剩 165（< 200）时不钳：没有 cap 类、没有 maxHeight', card !== undefined
  && String(card.props.className).indexOf('dsh-git-switch-cap') < 0
  && (card.props.style == null || card.props.style.maxHeight === undefined))

console.log('')
console.log('== 量不到锚点的环境（无 rect 的测试环境、面板未量过）维持原样 ==')
panelNodeObj.offsetParent = null
panelNodeObj.parentElement = null
chipNodeObj.offsetParent = null
chipNodeObj.parentElement = null
anchorTop = 400
await closePanel()
let chipTreeFresh = await chipTree()
chipTreeFresh.props.onClick()
/* 换个 fiber（label 变了）= 一块全新挂载的面板，等价于其它套件所处的无布局环境：
   锚点从没量到过，state 里的 anchor 保持 null，不写 inline 高度。同一块 fiber 里
   残留的上一次量测是另一回事 —— 真机上打开面板的那一刻必然量得到锚点。 */
tree = await settle('pop-fresh')
ok('锚点量不到 → 不钳制、不写 inline 高度（既有套件依赖的这一路）', heightOf(tree) === null)
