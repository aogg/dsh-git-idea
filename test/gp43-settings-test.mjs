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
/* ═══ gp43：机器上的 git，和它在网上做的事 ═══
   配置页的「全局配置」档（原先自己占 DSH 设置面板的一页，2026-10 起搬进面板）一直
   只有几样东西：插件自己的开关、本浏览器的外观，和读者真正会去那里找的三件事 ——
   我是谁（提交身份）、我用的是哪个 git（装在 PATH 之外时怎么办）、以及
   fetch / pull / push 到底带不带那几个参数。这个套件盯的就是这三块，加上它们唯一
   一处会动手的地方：推送没有上游的分支时，面板会不会自己把那一步走完。

   1. 提交身份：此刻生效的那一份（连来源一起）、缺哪一半、预填、写入固定落 --global
   2. 空框不写：`git config user.name ''` 正是那个错误的来路，面板不制造它
   3. 落点只剩 global：写本地那条路整个拆掉，会话只跟着选沙箱
   4. git 位置：PATH 上的 / 设置里写的 / 写错了 / 一个都没有，四种话各不相同
   5. 远程同步：三个开关，以及「也就是」那行照着实参说
   6. 推送没有上游：↑ 先弹确认框问一句（git/push 一次都不发），框里的
   「推送并设为上游（origin）」点了才真推（带 -u、远端与分支），推成关框不再问

   两条关于这个骨架的注意（踩过）：同一个组件的两次渲染要用**同一个 label**，否则
   fiber 是新的、组件等于重新挂载（状态和 effect 都会重来）；而 `timer.timeout` 在这
   里只是被记下来，不会自己到点 —— 去抖的保存要手动推一下。 */

const configReply = function (over) {
  return Object.assign({
    ok: true, path: '/home/u/.dsh/dsh-git-idea.json',
    config: { initBranch: 'main', cherryPickRecord: false, gitPath: '', fetchPrune: true, pullRebase: false, pushSetUpstream: false },
  }, over)
}

const baseCall = host.call
const identityCalls = []
const identitySaves = []
const toolCalls = []
const configSaves = []
let configNow = configReply().config
let identityReply = {
  ok: true, repo: '/tmp/ws', insideRepo: true,
  name: 'Ada Lovelace', email: 'ada@example.com',
  nameOrigin: '/home/u/.gitconfig', emailOrigin: '/home/u/.gitconfig',
  globalName: 'Ada Lovelace', globalEmail: 'ada@example.com',
  needsIdentity: false, nameMissing: false, emailMissing: false,
}
let toolReply = { ok: true, configured: '', fromPath: true, path: '/usr/bin/git', version: 'git version 2.43.0', found: true, reason: '', platform: 'ok' }

host.call = function (method, args) {
  if (method === 'git/identity') { identityCalls.push(args); return Promise.resolve(identityReply) }
  if (method === 'git/identity-save') {
    identitySaves.push(args)
    return Promise.resolve({
      ok: true, scope: args.scope, written: ['user.name', 'user.email'],
      repo: args.scope === 'local' ? '/tmp/ws' : null,
      name: args.name, email: args.email,
      nameOrigin: args.scope === 'local' ? '.git/config' : '/home/u/.gitconfig', emailOrigin: '/home/u/.gitconfig',
      globalName: args.name, globalEmail: args.email, needsIdentity: false,
    })
  }
  if (method === 'git/toolchain') { toolCalls.push(args); return Promise.resolve(toolReply) }
  if (method === 'git/config') return Promise.resolve(configReply({ config: configNow }))
  if (method === 'git/config-save') { configSaves.push(args.config); configNow = args.config; return Promise.resolve(configReply({ config: args.config })) }
  return baseCall(method, args)
}

/* 全局配置这一档住在面板「配置」页里（80-panel.js 的作用域切换），进页走 harness
   的 openConfig；label 只留给渲染 trace，fiber 由它统一按 'pop' 管。 */
const sectionTree = async function (label) { return await openConfig('global', label) }
/* 去抖的保存靠这个推一下：骨架里的 timer 只被记下来。 */
const fireTimers = function () {
  timers.filter(function (t) { return t.kind === 'timeout' && t.dead !== true }).forEach(function (t) { t.cb() })
}
const rowTexts = function (t) { return byClass(t, 'dsh-git-set-row').map(function (r) { return textOf(r) }) }
const setRow = function (t, label) { return byClass(t, 'dsh-git-set-row').filter(function (r) { return textOf(r).indexOf(label) >= 0 })[0] }
const inputFor = function (t, label) {
  const row = setRow(t, label)
  return row === undefined ? undefined : collect(row).filter(function (n) { return n.type === 'input' })[0]
}
const inputByPlaceholder = function (t, placeholder) {
  return collect(t).filter(function (n) { return n.type === 'input' && n.props.placeholder === placeholder })[0]
}
const btnWith = function (t, label) { return buttons(t).filter(function (b) { return textOf(b) === label })[0] }
const warnText = function (t) { return byClass(t, 'dsh-git-warn').map(function (n) { return textOf(n) }).join(' | ') }
const effectiveRow = function (t) { return rowTexts(t).filter(function (x) { return x.indexOf('此刻生效') >= 0 })[0] || '' }

/* ── 1. 缺一半的时候说什么 ── */

console.log('')
console.log('== 配置页 · 全局配置 · 提交身份：缺哪一半 ==')
identityReply = Object.assign({}, identityReply, { needsIdentity: true, nameMissing: true, name: '', email: '', nameOrigin: '', emailOrigin: '', globalName: '', globalEmail: '' })
let st = await sectionTree('gp43-ident-missing')
console.log('  缺一半:', JSON.stringify(warnText(st)))
ok('缺名字时明说原因是它，并且说清后果',
  warnText(st).indexOf('还缺：名字') >= 0 && warnText(st).indexOf('提交会被 git 拒绝') >= 0)
ok('这一行是警告色', byClass(st, 'dsh-git-warn').length > 0)
ok('读的时候只把 session id 交给 Host（路径由它从会话解出来，仓库路径不归客户端猜）',
  identityCalls.length >= 1 && identityCalls[0].repo === undefined && identityCalls[0].sessionId === 's-1')

/* ── 2. 有身份时：值 + 来源、预填、写入 ── */

console.log('')
console.log('== 配置页 · 全局配置 · 提交身份：写进去 ==')
identityReply = {
  ok: true, repo: '/tmp/ws', insideRepo: true,
  name: 'Ada Lovelace', email: 'ada@example.com',
  nameOrigin: '/home/u/.gitconfig', emailOrigin: '.git/config',
  globalName: 'Ada Lovelace', globalEmail: 'ada@example.com',
  needsIdentity: false, nameMissing: false, emailMissing: false,
}
st = await sectionTree('gp43-ident')
console.log('  此刻生效:', JSON.stringify(effectiveRow(st)))
ok('「此刻生效」把值连来源一起说（来自哪个文件才有意义）',
  effectiveRow(st).indexOf('Ada Lovelace（来自 /home/u/.gitconfig）') >= 0
  && effectiveRow(st).indexOf('ada@example.com（来自 .git/config）') >= 0)
ok('两个输入框预填了此刻生效的那一份',
  String(inputFor(st, '名字').props.value) === 'Ada Lovelace'
  && String(inputFor(st, '邮箱').props.value) === 'ada@example.com')
ok('有身份时没有警告', byClass(st, 'dsh-git-warn').length === 0)
const radios = collect(st).filter(function (n) { return n.type === 'input' && n.props.type === 'radio' })
ok('写进哪里不再挑：radio 一个都没有，一行静态说明落点（--global）',
  radios.length === 0 && rowTexts(st).join(' | ').indexOf('写进这台机器的 git 配置（--global）') >= 0)

inputFor(st, '邮箱').props.onChange({ target: { value: 'new@example.com' } })
await wait(5)
/* 同一次挂载里继续：草稿活在 fiber 上，重新开一页就会把它弄丢 —— 页内的重渲染
   走 settle（同一 fiber），只有换场景才用 sectionTree 的新挂载。 */
st = await settle('pop')
console.log('  改了邮箱，再点写入')
btnWith(st, '写入 git 配置').props.onClick()
await wait(20)
st = await settle('pop')
console.log('  写出去的:', JSON.stringify(identitySaves[0]))
ok('点一下就把两个值写出去，scope 是 global',
  identitySaves.length === 1 && identitySaves[0].scope === 'global'
  && identitySaves[0].name === 'Ada Lovelace' && identitySaves[0].email === 'new@example.com')
ok('写完之后页面把结果说出来（写到哪、写了哪两个字段）',
  rowTexts(st).join(' | ').indexOf('已写进这台机器的 git 配置') >= 0
  && rowTexts(st).join(' | ').indexOf('user.name') >= 0)

/* ── 3. 落点只剩 global：会话只是让沙箱策略跟对人 ── */

console.log('')
console.log('== 只剩 global：落点固定这台机器，会话只跟着走 ==')
/* 面板本来就带着会话：sessionId 是 props 一路递进「全局配置」的提交身份组的，
   不必再借 chip 的记忆；写本地的那条路（连 radio 一起）已经整个拆掉。 */
st = await sectionTree('gp43-ident')
const globalBtn = btnWith(st, '写入 git 配置')
ok('radio 一个都没有（写本地的那条路拆掉了）',
  collect(st).filter(function (n) { return n.type === 'input' && n.props.type === 'radio' }).length === 0)
ok('「这个仓库 = …」那行不再出现（落点与仓库无关）',
  rowTexts(st).join(' | ').indexOf('这个仓库 = ') < 0)
ok('按钮不再看仓库脸色（global 不需要仓库）', globalBtn !== undefined && globalBtn.props.disabled !== true)
globalBtn.props.onClick()
await wait(20)
st = await settle('pop')
console.log('  第二次写出去的:', JSON.stringify(identitySaves[1]))
ok('scope 固定 global、session id 照带（Host 靠它选沙箱）',
  identitySaves.length === 2 && identitySaves[1].scope === 'global' && identitySaves[1].sessionId === 's-1')
ok('落点还是这台机器的 git 配置', rowTexts(st).join(' | ').indexOf('已写进这台机器的 git 配置') >= 0)

/* 不知道是哪个仓库时也一样：global 从来不需要仓库。 */
identityReply = Object.assign({}, identityReply, { repo: null, insideRepo: false })
st = await sectionTree('gp43-ident-nowhere')
ok('不知道仓库时按钮照旧可按（global 不需要仓库）',
  btnWith(st, '写入 git 配置').props.disabled !== true)
ok('「还解不出仓库路径」那行也一并拆掉了',
  rowTexts(st).join(' | ').indexOf('还解不出仓库路径') < 0)
identityReply = Object.assign({}, identityReply, { repo: '/tmp/ws', insideRepo: true })

/* ── 4. git 位置 ── */

console.log('')
console.log('== 配置页 · 全局配置 · git 位置 ==')
const toolRow = function (t) {
  return rowTexts(t).filter(function (x) {
    return x.indexOf('现在用的是') >= 0 || x.indexOf('不可用') >= 0 || x.indexOf('PATH 上没有 git') >= 0
  })[0] || ''
}
st = await sectionTree('gp43-tool')
console.log('  PATH 上:', JSON.stringify(toolRow(st)))
ok('默认说的是「用的是 PATH 上的那一个」，并带版本',
  toolRow(st).indexOf('现在用的是 /usr/bin/git（来自 PATH）') >= 0 && toolRow(st).indexOf('git version 2.43.0') >= 0)
ok('默认这一行不是警告色', byClass(st, 'dsh-git-warn').length === 0)

toolReply = { ok: true, configured: '', fromPath: true, path: '', version: '', found: false, reason: 'not-on-path', platform: 'ok' }
st = await sectionTree('gp43-tool-none')
console.log('  机器上没有:', JSON.stringify(toolRow(st)))
ok('PATH 上找不到 git 时说的是「装上它，或写一个绝对路径」',
  toolRow(st).indexOf('PATH 上没有 git') >= 0 && toolRow(st).indexOf('绝对路径') >= 0)
ok('这一行是警告色（读者要动手）', byClass(st, 'dsh-git-warn').length > 0)

toolReply = { ok: true, configured: '/opt/nope/git', fromPath: false, path: '', version: '', found: false, reason: 'configured-missing', platform: 'ok' }
st = await sectionTree('gp43-tool-bad')
console.log('  写错了:', JSON.stringify(toolRow(st)))
ok('写进去的路径不可用时，说的是「设置里写的这个路径不可用」，而不是「这台机器没有 git」',
  toolRow(st).indexOf('设置里写的这个路径不可用') >= 0 && toolRow(st).indexOf('PATH 上没有 git') < 0)

/* 改路径：去抖之后写进插件配置，同时立刻再检查一次「它到底能不能跑」。 */
toolReply = { ok: true, configured: '/usr/local/bin/git', fromPath: false, path: '/usr/local/bin/git', version: 'git version 2.44.0', found: true, reason: '', platform: 'ok' }
const pathBox = inputByPlaceholder(st, '留空 = 用 PATH 里的 git')
ok('有一个写路径的输入框', pathBox !== undefined)
const toolCallsBefore = toolCalls.length
pathBox.props.onChange({ target: { value: '/usr/local/bin/git' } })
await wait(5)
fireTimers()
await wait(20)
st = await sectionTree('gp43-tool-bad')
console.log('  存下来的 gitPath:', JSON.stringify(configSaves.length > 0 ? configSaves[configSaves.length - 1].gitPath : null))
ok('路径写进插件配置（跟着插件走，换浏览器也一致）',
  configSaves.length >= 1 && configSaves[configSaves.length - 1].gitPath === '/usr/local/bin/git')
ok('改完立刻又问了一次「它到底能不能跑」', toolCalls.length > toolCallsBefore)
ok('结果就显示在下面（写的就是它、版本是新的那个）',
  toolRow(st).indexOf('git version 2.44.0') >= 0 && toolRow(st).indexOf('设置里写的就是它') >= 0)

/* ── 5. 远程同步 ── */

console.log('')
console.log('== 配置页 · 全局配置 · 远程同步 ==')
const boxNamed = function (t, label) {
  const row = setRow(t, label)
  return row === undefined ? undefined : collect(row).filter(function (n) { return n.type === 'input' && n.props.type === 'checkbox' })[0]
}
const commandLine = function (t) { return rowTexts(t).filter(function (x) { return x.indexOf('也就是') >= 0 })[0] || '' }
st = await sectionTree('gp43-net')
const fetchBox = boxNamed(st, 'fetch 时删掉远端已经删了的远程分支')
const pullBox = boxNamed(st, 'pull 用 rebase')
const pushBox = boxNamed(st, '推送没有上游的分支时直接推上去')
ok('三个开关都在，而且默认值就是原来的行为',
  fetchBox !== undefined && fetchBox.props.checked === true
  && pullBox !== undefined && pullBox.props.checked === false
  && pushBox !== undefined && pushBox.props.checked === false)
console.log('  也就是:', JSON.stringify(commandLine(st)))
ok('「也就是」那行照着实参说：--prune、不加 --rebase、推送先问一句',
  commandLine(st).indexOf('git fetch --all --prune') >= 0 && commandLine(st).indexOf('git pull ·') >= 0
  && commandLine(st).indexOf('git push（没有上游时由面板问一句）') >= 0)

fetchBox.props.onChange({ target: { checked: false } })
await wait(5)
fireTimers()
await wait(20)
st = await sectionTree('gp43-net')
console.log('  关掉 prune:', JSON.stringify(commandLine(st)))
ok('关掉 prune：fetch 那行就不带它了', commandLine(st).indexOf('git fetch --all ·') >= 0)
ok('同一个插件配置里存下了 false', configSaves[configSaves.length - 1].fetchPrune === false)

boxNamed(st, 'pull 用 rebase').props.onChange({ target: { checked: true } })
await wait(5)
fireTimers()
await wait(20)
st = await sectionTree('gp43-net')
ok('打开 rebase：pull 那行带上 --rebase', commandLine(st).indexOf('git pull --rebase') >= 0)
ok('存下了 true', configSaves[configSaves.length - 1].pullRebase === true)

boxNamed(st, '推送没有上游的分支时直接推上去').props.onChange({ target: { checked: true } })
await wait(5)
fireTimers()
await wait(20)
st = await sectionTree('gp43-net')
console.log('  开了自动上游:', JSON.stringify(commandLine(st)))
ok('打开自动上游：那行说的是 push -u，而不是「由面板问一句」',
  commandLine(st).indexOf('git push -u <remote> <branch>') >= 0 && commandLine(st).indexOf('问一句') < 0)
ok('三个开关都进了同一个配置文件', configSaves[configSaves.length - 1].pushSetUpstream === true)

/* ── 6. 推送没有上游：↑ 先弹确认框问一句，点了框里的按钮才真推 ── */

console.log('')
console.log('== 面板 · 推送没有上游 ==')
const pushCalls = []
let pushSetUpstream = false
const panelSaved = host.call
host.call = function (method, args) {
  if (method === 'git/push-preview') {
    /* 这个分支还没有上游：ok:true + upstream:null —— 弹窗自己翻「设置上游并推送」
       那一态，远端由面板按 guessPushRemote 现猜（mock 的 git/refs 里只有 origin）。 */
    return Promise.resolve({ ok: true, repo: '/tmp/ws', branch: 'main', upstream: null, ahead: 0, behind: 0, hasMore: false, maxCount: 200, commits: [] })
  }
  if (method === 'git/push') {
    pushCalls.push(args)
    /* 确认框里点「推送并设为上游」的那一次成功；不带 -u 的直推在 git 自己那句话上失败。 */
    if (args != null && args.setUpstream === true) return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
    return Promise.resolve({ ok: false, repo: '/tmp/ws', stdout: '', stderr: 'fatal: The current branch main has no upstream branch', exitCode: 128 })
  }
  if (method === 'git/refs') {
    return Promise.resolve({
      ok: true, repo: '/tmp/ws', current: ['main'], previous: '',
      local: [{ segments: ['main'], data: 'main' }],
      remote: [{ name: 'origin', remote: 'origin', refs: [{ segments: ['origin', 'main'], data: 'origin/main' }] }],
    })
  }
  if (method === 'git/config') return Promise.resolve(configReply({ config: Object.assign({}, configNow, { pushSetUpstream: pushSetUpstream }) }))
  return panelSaved(method, args)
}
/* 面板读的是内存里那份插件配置（usePluginConfig 只从 Host 拉一次），所以要改它得走
   全局配置自己那扇门：勾一下那个开关。这样「设了之后面板怎么做」测的就是真路径，而不是
   测试往内存里塞一个值。 */
const setPushSetting = async function (on) {
  const t = await sectionTree('gp43-net')
  const box = boxNamed(t, '推送没有上游的分支时直接推上去')
  box.props.onChange({ target: { checked: on } })
  await wait(5)
  fireTimers()
  await wait(20)
  await sectionTree('gp43-net')
}
/* 注意 label：`ready` 是弹层自己「开过一次」之后才为真的，而 fiber 是按 label 认的 ——
   换个 label 渲染就等于重新挂载，`git/refs` 不会发出去，弹窗也就永远画不出来（旧横幅
   那一版就是这么错的）。所以整段都留在 `openPanel` 用的那个 label 上。 */
const clickPush = async function () {
  const t = await openPanel()
  /* 前面的用例把面板留在了「配置」页；确认弹窗盖在历史页的正文上 —— 先切回历史再按 ↑。 */
  const logTab = buttons(t).find(function (b) { return textOf(b) === '历史' })
  if (logTab !== undefined && String(logTab.props.className).indexOf('dsh-git-tab-on') < 0) {
    logTab.props.onClick()
    await wait(10)
  }
  const t2 = await settle('pop')
  const btn = buttons(t2).filter(function (b) { return String(b.props.title).indexOf('push：推送当前分支') === 0 })[0]
  if (btn !== undefined) btn.props.onClick()
  await wait(30)
  return await settle('pop')
}
/* 点确认弹窗里那颗「推送并设为上游（origin）」：这才是真正发 git/push 的那一下。 */
const clickDialogPush = async function () {
  const t = await settle('pop')
  const btn = buttons(t).filter(function (b) { return textOf(b).indexOf('推送并设为上游（') === 0 })[0]
  if (btn === undefined) throw new Error('推送确认弹窗里没有「推送并设为上游」按钮')
  btn.props.onClick()
  await wait(30)
  return await settle('pop')
}

await setPushSetting(false)
let pushTree = await clickPush()
console.log('  关着:', JSON.stringify({
  次数: pushCalls.length,
  弹窗: textOf(pushTree).indexOf('还没有上游') >= 0,
  按钮: buttons(pushTree).filter(function (b) { return textOf(b).indexOf('推送并设为上游（') === 0 }).length,
}))
ok('关着的时候只问不推：↑ 弹出确认框，git/push 一次都没发',
  pushCalls.length === 0 && textOf(pushTree).indexOf('还没有上游') >= 0)
ok('框里给的是「推送并设为上游（origin）」，等读者确认',
  buttons(pushTree).filter(function (b) { return textOf(b).indexOf('推送并设为上游（') === 0 }).length === 1)

pushCalls.length = 0
pushSetUpstream = true
await setPushSetting(true)
pushTree = await clickPush()
const askedWithSettingOn = pushCalls.length === 0
pushTree = await clickDialogPush()
console.log('  开着:', JSON.stringify({
  次数: pushCalls.length,
  参数: pushCalls.map(function (a) { return a.setUpstream === true ? 'setUpstream' : 'plain' }),
  弹窗还开着: textOf(pushTree).indexOf('还没有上游') >= 0,
}))
ok('开关开着也不自己推：自动设上游不越过确认框', askedWithSettingOn)
ok('框里点「推送并设为上游」才真推：一次、带 -u、远端和分支',
  pushCalls.length === 1 && pushCalls[0].setUpstream === true
  && pushCalls[0].remote === 'origin' && pushCalls[0].branch === 'main')
ok('推成了弹窗就关，不再问一句',
  textOf(pushTree).indexOf('还没有上游') < 0
  && buttons(pushTree).filter(function (b) { return textOf(b).indexOf('推送并设为上游（') === 0 }).length === 0)
ok('没有第二次重试（-u 那次失败也不会再套一层）', pushCalls.filter(function (a) { return a.setUpstream === true }).length === 1)

host.call = panelSaved
