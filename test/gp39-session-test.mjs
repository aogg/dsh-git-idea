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

/* ── 切换工作区：chip 不能还显示上一个工作区的分支 ── */

/* 芯片现在分两段读：先便宜的「哪个仓库哪个分支」，再补工作区状态。
   这个套件要观察的是**第一段还没回来**时的中间态，所以第一段挂住由测试
   逐个放行，第二段（完整读）立刻用该会话已知的答案回掉 —— 它的时序不是
   这里要考的东西。 */
const realCall = host.call
const panelArgs = []
let panelResolvers = []
const settled = {}
host.call = function (method, args) {
  if (method === 'git/panel') {
    panelArgs.push(args)
    const sid = args == null ? undefined : args.sessionId
    if (args != null && args.quick === true) {
      return new Promise(function (resolve) { panelResolvers.push({ sid: sid, resolve: resolve }) })
    }
    return Promise.resolve(settled[sid] !== undefined ? settled[sid] : { ok: false, repo: null, reason: '' })
  }
  return realCall(method, args)
}
const panelPending = () => panelResolvers.length
const answerPanel = async (reply) => {
  const next = panelResolvers.shift()
  if (next === undefined) throw new Error('没有待决的 git/panel 请求')
  settled[next.sid] = reply
  next.resolve(reply)
  await new Promise((r) => setTimeout(r, 5))
}
/* 同一个 fiber 换 props —— 这才是真实的「切换工作区」；label 必须稳定，
   否则每次都是一个全新挂载的组件，测的就成了挂载而不是切换。 */
const chipFor = (sessionId) => renderUntilStable(makeElement(chip, { sessionId: sessionId }), 'chip')
const fireTimers = () => {
  timers.filter((t) => t.kind === 'timeout' && !t.dead).forEach((t) => { t.dead = true; t.cb() })
}
const branchesFor = (repo) => calls.filter((c) => c.method === 'git/branches' && c.args != null && c.args.repo === repo)
/* 每条改动一个**不同的**路径：同一份快照里同一个 path 出现两次不是 git 会给出的东西，
   而「有几个改动」现在是那份列表的行数（mergeChanges，面板标签上那个数字），同一个
   路径只会是一行。 */
const panelOf = (repo, branch, pending) => ({
  ok: true, repo: repo, branch: branch, detached: false, upstream: 'origin/' + branch,
  ahead: 0, behind: 0, sequencer: null,
  staged: [], unstaged: new Array(pending || 0).fill(0).map((_x, i) => 'f' + i), untracked: [], unmerged: [],
})

console.log('== 先在那个工作区里待一会儿 ==')
calls.length = 0
let chipTree1 = await chipFor('s-1')
ok('chip 先要求读这个工作区', panelArgs.length === 1 && panelArgs[0].sessionId === 's-1')
await answerPanel(panelOf('/tmp/ws', 'main', 2))
chipTree1 = await chipFor('s-1')
console.log('  s-1 的按钮:', JSON.stringify(textOf(chipTree1)))
ok('读到分支后按钮写 main', textOf(chipTree1).indexOf('main') >= 0)
ok('带来改动数徽标', textOf(chipTree1).indexOf('2') >= 0)
ok('顺手预热了这个仓库的分支列表（不用等打开弹层）', branchesFor('/tmp/ws').length === 1)

console.log('')
console.log('== 切到另一个工作区：不能还挂着上一个的分支 ==')
panelArgs.length = 0
let chipTree2 = await chipFor('s-2')
await new Promise((r) => setTimeout(r, 5))
chipTree2 = await chipFor('s-2')
console.log('  s-2 还没读回来时的按钮:', JSON.stringify(textOf(chipTree2)))
ok('切过去后马上就不再显示上个工作区的 main', textOf(chipTree2).indexOf('main') < 0)
ok('也不再挂着上个工作区的改动数', textOf(chipTree2).indexOf('2') < 0)
ok('为 s-2 发了新的一次读', panelArgs.length >= 1 && panelArgs[panelArgs.length - 1].sessionId === 's-2')
await answerPanel(panelOf('/tmp/ws2', 'dev', 1))
chipTree2 = await chipFor('s-2')
console.log('  s-2 读回来后的按钮:', JSON.stringify(textOf(chipTree2)))
ok('读到后按钮写 dev', textOf(chipTree2).indexOf('dev') >= 0)
ok('预热了 s-2 自己的仓库', branchesFor('/tmp/ws2').length === 1)

console.log('')
console.log('== 切回去：记忆里的分支立刻出现，不等往返 ==')
ok('切到 s-2 之前没有遗留的未决读', panelPending() === 0)
let chipTree3 = await chipFor('s-1')
await new Promise((r) => setTimeout(r, 5))
chipTree3 = await chipFor('s-1')
console.log('  s-1 重新读回来之前的按钮:', JSON.stringify(textOf(chipTree3)), ' 未决读:', panelPending())
ok('切回 s-1 立刻又显示 main（用的是记住的标签）', textOf(chipTree3).indexOf('main') >= 0)
ok('这次读还没回来就已经显示了', panelPending() > 0)
await answerPanel(panelOf('/tmp/ws', 'main', 0))
chipTree3 = await chipFor('s-1')
ok('读回来之后仍然是 main', textOf(chipTree3).indexOf('main') >= 0)

console.log('')
console.log('== 预热过的仓库：hover 卡片第一次渲染就有分支 ==')
host.call = realCall
calls.length = 0
const chipTree4 = await chipFor('s-1')
chipTree4.props.onPointerEnter()
fireTimers()
await wait(15)
/* renderRoot 只渲染一遍、不等待 promise，所以「第一帧」是可观察的：
   预热过的仓库这一帧就有分支行，没预热就只有「正在读取分支…」。 */
const firstFrame = renderRoot(makeElement(popover, { sessionId: 's-2' }), 'pop')
const firstCard = byClass(firstFrame, 'dsh-git-switch-hover')[0]
ok('s-2 的 hover 卡片已经在了', firstCard !== undefined)
const firstRows = firstCard === undefined ? [] : byClass(firstCard, 'dsh-git-bs-row')
console.log('  第一帧里的行:', JSON.stringify(firstRows.map(textOf).slice(0, 5)))
ok('预热过：第一帧就列出了分支（不是「正在读取分支…」）', firstRows.length > 0)
ok('读的是 s-2 自己的仓库 /tmp/ws2', calls.filter((c) => c.method === 'git/branches').every((c) => c.args.repo === '/tmp/ws2'))
console.log('')
console.log('== 同一个工作区里换会话：面板第一帧就用记忆里那份，不闪「正在读取仓库…」 ==')

/* DSH 换会话时整棵 session 作用域的 slot 子树会重挂，组件 state 全部从头来。但
   s-2 的 chip 已经读过它的工作区（/tmp/ws2，1 个改动），那份快照按仓库记在全局读数
   里 —— 所以重挂出来的面板第一帧就该是它，而不是先空一帧「正在读取仓库…」。 */
const seededFrame = renderRoot(makeElement(popover, { sessionId: 's-2' }), 'pop-seeded')
const seededText = textOf(seededFrame)
const seededBadge = byClass(seededFrame, 'dsh-git-tool-badge')[0]
console.log('  重挂后的第一帧:', JSON.stringify(seededText.slice(0, 130)))
console.log('  第一帧上的变更数:', seededBadge === undefined ? '(没有)' : JSON.stringify(textOf(seededBadge)))
ok('第一帧不再是「正在读取仓库…」', seededText.indexOf('正在读取仓库') < 0)
ok('第一帧就带着记忆里那份改动数', seededBadge !== undefined && textOf(seededBadge) === '1')

/* 没有记忆的会话（这个工作区从来没读过）必须照旧先空一帧，不能凭空编一个仓库出来。 */
const coldFrame = renderRoot(makeElement(popover, { sessionId: 's-cold' }), 'pop-cold')
console.log('  没见过的会话第一帧:', JSON.stringify(textOf(coldFrame).slice(0, 130)))
ok('没见过的会话仍从「正在读取仓库…」开始', textOf(coldFrame).indexOf('正在读取仓库') >= 0)
