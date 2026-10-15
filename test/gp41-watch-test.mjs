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

/* ── 在终端/IDEA 里自己切了分支，对话框上的 chip 会跟着变吗？──

   主机侧「签名里必须能看出换了分支」由 gp34a 用真 git 证明（外部 `git switch`
   之后 `git/watch` 的签名确实不同）。这一节接上后半段：签名变了以后，chip 到底
   有没有重读、有没有换名字，以及什么时候它根本不该读。 */

const realCall = host.call
let watchSig = 'SIG-A'
host.call = function (method, args) {
  if (method === 'git/watch') {
    calls.push({ method: method, args: args })
    return Promise.resolve({ ok: true, repo: '/tmp/ws', sig: watchSig })
  }
  return realCall(method, args)
}

const labelOf = (tree) => {
  const span = byClass(tree, 'dsh-git-chip-label')[0]
  return span === undefined ? '' : textOf(span)
}
const lanes = () => timers.filter((t) => t.kind === 'interval' && t.dead !== true)
const tick = () => lanes().forEach((t) => t.cb())
const since = (mark) => calls.slice(mark)
const methodsSince = (mark) => since(mark).map((c) => c.method)

console.log('')
console.log('=== 手动切分支之前：chip 的轮询长什么样 ===')
const first = await chipTree()
ok('chip 显示当前分支 main', labelOf(first) === 'main')
ok('chip 自己注册了一个轮询', lanes().length === 1)
/* 5 秒是慢车道的默认值（20-prefs.js）：它只发一次便宜签名（真机上 0.12s），
   所以问得比过去勤 —— 15 秒的话，终端里提交完要过十几秒 chip 才改口。 */
ok('没有面板时走慢车道（5 秒）', lanes()[0].delay === 5000)

let mark = calls.length
tick()
await wait(30)
const watchArgs = since(mark).filter((c) => c.method === 'git/watch').map((c) => c.args)
ok('第一次轮询只记下签名，不白读一遍数据', methodsSince(mark).indexOf('git/panel') < 0)
ok('轮询问的是廉价签名，不带 deep（慢盘上 deep 是秒级）',
  watchArgs.length === 1 && watchArgs[0].deep === undefined && watchArgs[0].sessionId === 's-1')

console.log('')
console.log('=== 外面切了分支：签名变了 ===')
mark = calls.length
watchSig = 'SIG-B'
OK_PANEL.branch = 'release/2.0'
tick()
await wait(30)
const moved = await chipTree()
ok('签名变了 → chip 换成新分支 release/2.0', labelOf(moved) === 'release/2.0')
const seq = methodsSince(mark)
ok('先 flush 主机缓存，再重读（否则读到的还是缓存里的旧分支）',
  seq.indexOf('git/flush') >= 0 && seq.indexOf('git/flush') < seq.indexOf('git/panel'))
/* 一次 bump 之后最多两次读：先身份（0.15s），再只问上次那些脏路径（0.2s）。
   整棵树那一次不在这条路上 —— 它在这台机器上 8–10s，而且占住整条通道。
   （这份快照在这个套件里是「干净的」，所以第二次是全树读；见下一节。） */
ok('重读走的是先便宜、再只问那些路径那两段，不是一整条状态读',
  seq.filter((m) => m === 'git/panel').length === 2)

console.log('')
console.log('=== 签名没变：一次都不该读 ===')
mark = calls.length
tick()
await wait(30)
tick()
await wait(30)
ok('仓库没动就不重读（不会每 15 秒白读一次）', methodsSince(mark).indexOf('git/panel') < 0)
ok('没动的时候 flush 也不会发', methodsSince(mark).indexOf('git/flush') < 0)

console.log('')
console.log('=== 面板打开之后：同一个仓库改成快车道 ===')
await openPanel()
const after = lanes().map((t) => t.delay).sort((a, b) => a - b)
console.log('  活跃轮询间隔：', after.join('ms, ') + 'ms')
ok('面板一开，这个仓库上就多出一条 3 秒的快车道', after.indexOf(3000) >= 0)
mark = calls.length
watchSig = 'SIG-C'
OK_PANEL.branch = 'main'
tick()
await wait(40)
const back = await settle()
ok('面板开着时切回去，chip 与面板同时跟上', labelOf(await chipTree()) === 'main' && textOf(back).indexOf('main') >= 0)
ok('快车道那一次也仍然先 flush', methodsSince(mark).indexOf('git/flush') >= 0)

console.log('')
console.log('=== 页面被切到后台，再切回来 ===')
fakeDoc.hidden = true
mark = calls.length
tick()
await wait(30)
ok('页面在后台时不轮询', methodsSince(mark).indexOf('git/watch') < 0)
watchSig = 'SIG-D'
OK_PANEL.branch = 'release/3.1'
fakeDoc.hidden = false
mark = calls.length
fakeDoc.fire('visibilitychange')
await wait(40)
ok('切回页面立刻对一次签名，不用等下一个间隔', methodsSince(mark).indexOf('git/watch') >= 0)
ok('对完发现仓库动了，chip 立刻跟上', labelOf(await chipTree()) === 'release/3.1')
mark = calls.length
fakeDoc.fire('visibilitychange')
await wait(40)
ok('仓库没动时切回来也不会白读一遍', methodsSince(mark).indexOf('git/panel') < 0)

/* ── chip 上的未提交数量：便宜的第一次读回来时不能消失 ──

   面板与 chip 都是两段读：先 0.15 秒的身份读（`partial`，**不带工作区**），
   再 7 秒的完整读。把 `partial` 的「没有改动列表」当成「没有改动」，就会在
   每次仓库动过之后把徽标抹掉，几秒后才补回来 —— 用户看到的就是「数量消失，
   过一会才出来」。这一节盯住那个瞬间。 */

console.log('')
console.log('=== 轮询之后，未提交数量不许先消失 ===')
const beforePanel = host.call
let fullPending = 3
let fullGate = null
const panelCalls = []
host.call = function (method, args) {
  if (method === 'git/panel') {
    panelCalls.push(args)
    const head = { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, sequencer: null }
    if (args != null && args.quick === true) {
      return Promise.resolve(Object.assign({ partial: true, staged: [], unstaged: [], untracked: [], unmerged: [] }, head))
    }
    const items = []
    for (let i = 0; i < fullPending; i += 1) items.push({ path: 'f' + i + '.txt', code: ' M' })
    const reply = Object.assign({ staged: [], unstaged: items, untracked: [], unmerged: [] }, head)
    if (fullGate !== null) return new Promise(function (resolve) { fullGate = resolve.bind(null, reply) })
    return Promise.resolve(reply)
  }
  return beforePanel(method, args)
}
const badgeOf = (tree) => byClass(tree, 'dsh-git-badge')
const badgeText = (tree) => (badgeOf(tree)[0] === undefined ? '' : textOf(badgeOf(tree)[0]))
const badgeClass = (tree) => (badgeOf(tree)[0] === undefined ? '' : String(badgeOf(tree)[0].props.className))

const s2 = await renderUntilStable(makeElement(chip, { sessionId: 's-2' }), 'chip-s2')
ok('第一次完整读之后徽标显示 3', badgeText(s2) === '3' && !/stale/.test(badgeClass(s2)))

watchSig = 'SIG-E'
/* 把完整读按住，才看得见中间那一刻 —— 在真机上那一段是 7 秒，在测试里是 0 微秒 */
fullGate = true
tick()
await wait(40)
const during = await renderUntilStable(makeElement(chip, { sessionId: 's-2' }), 'chip-s2')
ok('便宜的第一次读回来后徽标还在，没有先掉到 0', badgeText(during) === '3')
ok('但它被标成「还没核对」（半透明）', /dsh-git-badge-stale/.test(badgeClass(during)))
ok('tooltip 说的是正在核对，不会谎称工作区干净',
  String(during.props.title).indexOf('正在核对') >= 0)

const release2 = fullGate
fullGate = null
release2()
await wait(40)
const settled3 = await renderUntilStable(makeElement(chip, { sessionId: 's-2' }), 'chip-s2')
ok('完整读回来之后同一个数字转正（去掉半透明）', badgeText(settled3) === '3' && !/stale/.test(badgeClass(settled3)))

/* 换会话：这个会话是第一次来，自己的完整读还没回来 */
fullGate = true
watchSig = 'SIG-F'
const s3 = await renderUntilStable(makeElement(chip, { sessionId: 's-3' }), 'chip-s3')
ok('新会话的第一眼就带着这个仓库上次的数字（不空着）', badgeText(s3) === '3')
ok('而且是「还没核对」的样子', /dsh-git-badge-stale/.test(badgeClass(s3)))
const release = fullGate
fullGate = null
release()
await wait(40)
const s3done = await renderUntilStable(makeElement(chip, { sessionId: 's-3' }), 'chip-s3')
ok('它自己的完整读回来后就转正了', badgeText(s3done) === '3' && !/stale/.test(badgeClass(s3done)))

/* 提交干净之后：数字该变成「没有徽标」，而且不再是核对中的样子 */
fullPending = 0
watchSig = 'SIG-G'
tick()
await wait(60)
const clean = await renderUntilStable(makeElement(chip, { sessionId: 's-3' }), 'chip-s3')
ok('改动清零后徽标消失', badgeOf(clean).length === 0)
ok('tooltip 这时才说工作区干净', String(clean.props.title).indexOf('工作区干净') >= 0)

console.log('')
console.log('=== 一个页面里的两个会话：各自轮询自己的工作区 ===')
/* 没有应用过仓库时，轮询问的是「这个会话自己的工作区」，而每个面板和 chip 都是
   从这个状态开始的。按仓库路径当键的时候，这个状态只有一个条目：两个会话先后
   把自己的 id 写进去，最后一个赢 —— 另一个会话于是去轮询别人的工作区，自己改
   了看不见，别人改了自己重读。键里带上会话，一个 tick 就该问出两个 id。 */
const beforeTwo = calls.length
await renderUntilStable(makeElement('div', null,
  makeElement(chip, { sessionId: 's-A', key: 'a' }),
  makeElement(chip, { sessionId: 's-B', key: 'b' })), 'two-chips')
tick()
await wait(40)
const askedSessions = since(beforeTwo).filter((c) => c.method === 'git/watch').map((c) => c.args.sessionId)
console.log('  这一轮问过的会话:', JSON.stringify(askedSessions))
ok('两个会话各问各的（不是同一个 id 问两遍）',
  askedSessions.indexOf('s-A') >= 0 && askedSessions.indexOf('s-B') >= 0)

console.log('')
console.log('=== 轮询的监听者按「注册」记，不按「回调函数」记 ===')
/* chip 和面板要的是同一个回调（bumpData），而以回调为键的 Set 会把两次注册并成
   一条：先注销的那个把另一个的通知、以及以「还有没有人在看」为准的定时器一起带走。
   面板不再认为这是仓库时必然如此；只是关掉面板时，谁先谁后取决于浏览器里两个 slot
   root 的清理顺序，所以在真实使用里是「有时候」——面板反应过来了，对话框上的图标
   一直不动。两个 root 的清理顺序在 mock-React 里复现不出来，所以这条守源码。 */
const CLIENT_SRC = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
ok('每个注册有自己的键（token），注销只注销自己那一个',
  CLIENT_SRC.indexOf('entry.listeners.set(token, listener)') >= 0
  && CLIENT_SRC.indexOf('entry.listeners.delete(token)') >= 0
  && CLIENT_SRC.indexOf('entry.listeners.add(listener)') < 0
  && CLIENT_SRC.indexOf('entry.listeners.delete(listener)') < 0)
ok('通知时把每个注册的回调都调一遍',
  CLIENT_SRC.indexOf('entry.listeners.forEach(function (listener) { listener() })') >= 0)

console.log('')
console.log('=== 面板里打开另一个目录之后，chip 要看的是那个目录 ===')
/* chip 的读和轮询都拿「会话自己的工作区」当入参，而这个入参以前不随面板里应用的
   目录变化：面板已经在新仓库上按 3 秒轮询，chip 还在问一个不是仓库的目录，签名
   永远不变 —— 面板反应过来了，对话框上的图标一直不动。 */
/* 上面那一段把 host.call 换成了它自己的 git/panel 回答（都是「是仓库」）。这里
   再套一层：这个会话自己的工作区不是仓库，而面板里打开的目录是 —— 这正是用户在
   引导页上「打开这个目录」之后的状态。 */
const beforeSetup = host.call
const SETUP_REPLY = { ok: false, repo: '/tmp/applied', error: 'not-a-repository', reason: 'not-a-repo', stderr: '', staged: [], unstaged: [], untracked: [], unmerged: [] }
host.call = function (method, args) {
  if (method !== 'git/panel') return beforeSetup(method, args)
  if (args != null && args.repo === '/tmp/applied') return Promise.resolve(Object.assign({}, OK_PANEL, { repo: '/tmp/applied' }))
  if (args != null && args.repo !== undefined) return beforeSetup(method, args)
  return Promise.resolve(SETUP_REPLY)
}
const forSetup = await chipTree()
if (forSetup.props.className.indexOf('dsh-git-chip-open') < 0) { forSetup.props.onClick(); await wait(20) }
const notRepo = await settle('setup-again')
const openHere = byClass(notRepo, 'dsh-git-btn').find((b) => textOf(b) === '打开这个目录')
/* chip 是面板之外唯一会说这句话的地方。同一个「读不动」的状态有两种原因，而它们
   在屏幕上必须分开：目录里没有仓库，和这台机器上没有 git（见 92-chip 的那一串
   理由）。中文只在这里验一遍 —— 面板那一页在 gp40。 */
ok('（对照）reason 还是 not-a-repo 时，chip 说的是「这个目录不是 Git 仓库」',
  String(forSetup.props.title).indexOf('不是 Git 仓库') >= 0)
SETUP_REPLY.reason = 'no-git'
forSetup.props.onClick()
await wait(30)
const chipNoGitClosed = await chipTree()
chipNoGitClosed.props.onClick()
await wait(30)
const chipNoGit = await chipTree()
console.log('  没有 git 时 chip 的 tooltip:', JSON.stringify(String(chipNoGit.props.title).slice(0, 90)))
ok('机器上没有 git 时，chip 说的是找不到 git',
  String(chipNoGit.props.title).indexOf('这台机器上找不到 git') >= 0)
ok('chip 不再跟着首帧说「这个目录不是 Git 仓库」',
  String(chipNoGit.props.title).indexOf('不是 Git 仓库') < 0)

/* 「这个目录不是 Git 仓库」那一页是没有路径框的（路径不是问题，没什么可填的），
   所以 chip 也不能承诺「点击选择路径」—— 承诺一个点不到的东西比不承诺更坏。 */
ok('（对照）not-a-repo 时 chip 不再承诺「点击选择路径」',
  String(forSetup.props.title).indexOf('选择路径') < 0
  && String(forSetup.props.title).indexOf('点击查看') >= 0)

/* 第三种状态：连看哪个目录都还不知道（no-path，刚切会话那一瞬间就是这样）。
   那时要人填一个目录，说法也就得是「填」，不能说「这个目录不是仓库」。 */
SETUP_REPLY.reason = 'no-path'
chipNoGit.props.onClick()
await wait(30)
const chipNoPathOpen = await chipTree()
chipNoPathOpen.props.onClick()
await wait(30)
const chipNoPath = await chipTree()
console.log('  路径没定时 chip 的 tooltip:', JSON.stringify(String(chipNoPath.props.title).slice(0, 60)))
ok('路径没定时 chip 说的是「还没确定看哪个目录」',
  String(chipNoPath.props.title).indexOf('还没确定看哪个目录') >= 0)
ok('也不再说成「这个目录不是 Git 仓库」',
  String(chipNoPath.props.title).indexOf('不是 Git 仓库') < 0)
console.log('  引导页上有「打开这个目录」:', openHere !== undefined)
openHere.props.onClick()
await wait(30)
await chipTree()
mark = calls.length
tick()
await wait(40)
const askedAfterApply = since(mark).filter((c) => c.method === 'git/watch').map((c) => c.args)
console.log('  chip 这一轮问的入参:', JSON.stringify(askedAfterApply))
ok('chip 轮询的是面板里打开的那个目录', askedAfterApply.some((a) => a.repo === '/tmp/applied'))
