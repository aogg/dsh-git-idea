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
const fakeNode = { ownerDocument: fakeDoc, offsetWidth: 900, offsetHeight: 600, contains: () => false }
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
const React = {
  createElement: makeElement,
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

let currentLabel = ''
function renderRoot(element, label) {
  currentLabel = label
  const pending = []
  const render = (node, path) => {
    if (node === null || node === undefined) return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((c, i) => render(c, path + '.' + i))
    const type = node.type
    if (typeof type !== 'function') {
      const kids = (node.props.children || []).map((c, i) => render(c, path + '/' + i))
      const out = { type: type, key: node.key, props: Object.assign({}, node.props, { children: kids }) }
      if (typeof node.props.ref === 'function') node.props.ref(fakeNode)
      return out
    }
    const fiberKey = path + '#' + (type.name || 'anon') + '#' + (node.key === null ? '' : node.key)
    let fiber = fibers.get(fiberKey)
    if (fiber === undefined) { fiber = { hooks: [], effects: [], cursor: 0, pending: [] }; fibers.set(fiberKey, fiber) }
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
    calls.push({ method, args, tree: currentLabel })
    if (method === 'git/panel') return Promise.resolve(OK_PANEL)
    if (method === 'git/branches') return Promise.resolve(branchesReply)
    if (method === 'git/refs') return Promise.resolve({ ok: true, repo: '/tmp/ws', current: ['main'], local: [{ segments: ['main'], data: 'main' }], remote: [] })
    if (method === 'git/authors') return Promise.resolve({ ok: true, repo: '/tmp/ws', authors: [] })
    if (method === 'git/graph') return Promise.resolve({ ok: true, repo: '/tmp/ws', ref: 'main', currentBranch: 'main', commits: [], rows: [], lanes: 0 })
    if (method === 'git/watch') return Promise.resolve({ ok: true, repo: '/tmp/ws', sig: 'SIG' })
    if (method === 'git/commit-detail') return Promise.resolve({ ok: true, hash: 'a', files: [], branches: [] })
    if (method === 'git/flush') return Promise.resolve({ ok: true })
    if (method === 'git/config') return Promise.resolve({ ok: true, path: '/home/u/.dsh/dsh-git-idea.json', config: { initBranch: 'main', cherryPickRecord: false } })
    if (method === 'git/checkout') return Promise.resolve(checkoutReply)
    return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
  },
}
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

/* ── 「打开面板要不要等」专用用例 ── */

let watchSig = 'SIG-1'
const baseCall = host.call
host.call = function (method, args) {
  if (method === 'git/watch') { calls.push({ method, args, tree: currentLabel }); return Promise.resolve({ ok: true, repo: '/tmp/ws', sig: watchSig }) }
  return baseCall(method, args)
}
/* 「面板的重读」= 不是芯片发的那次状态读 */
const heavy = () => calls.filter((c) => c.tree !== 'chip' && ['git/panel', 'git/refs', 'git/authors', 'git/graph', 'git/commit-detail'].indexOf(c.method) >= 0).map((c) => c.method)
const chipClose = async () => {
  const t = await chipTree()
  if (t.props.className.indexOf('dsh-git-chip-open') >= 0) { t.props.onClick(); await wait(10) }
  await settle('pop')
}
const tick = async () => {
  const iv = timers.filter((t) => t.kind === 'interval' && !t.dead)[0]
  iv.cb()
  await wait(25)
}

console.log('== 打开面板：第一次要读全，之后不该再读 ==')
fibers.clear()
calls.length = 0
let tree = await openPanel()
await wait(20)
console.log('  首次打开读了:', JSON.stringify(Array.from(new Set(calls.map((c) => c.method)))))
ok('首次打开拉了面板与历史', heavy().length >= 4)
ok('芯片顺带预取了分支列表（首帧就有数据）', calls.some((c) => c.method === 'git/branches'))
calls.length = 0
await settle('pop')
await wait(20)
ok('不动它时不再重读', calls.length === 0)

console.log('')
console.log('== 关掉面板后，仓库变化不再让隐藏面板重读 ==')
await chipClose()
await tick()
calls.length = 0
watchSig = 'SIG-2'
await tick()
console.log('  变化后发出的 RPC:', JSON.stringify(calls.map((c) => c.method)))
ok('确实发现了变化（问了 watch）', calls.some((c) => c.method === 'git/watch'))
ok('也把缓存清了', calls.some((c) => c.method === 'git/flush'))
ok('但隐藏面板没有重读历史', heavy().length === 0)

console.log('')
console.log('== 再打开：补一次，而且只补一次 ==')
calls.length = 0
tree = await openPanel()
await wait(30)
console.log('  打开时读了:', JSON.stringify(Array.from(new Set(calls.map((c) => c.method)))))
ok('打开时把欠的那次补上', heavy().length >= 4)
calls.length = 0
await settle('pop')
await wait(20)
ok('补完之后不再重复读', calls.length === 0)

console.log('')
console.log('== 没有任何变化时，关掉再打开：历史照旧零读，只多打开即预读的那一次命令记录 ==')
await chipClose()
calls.length = 0
tree = await openPanel()
await wait(30)
console.log('  无变化重开的 RPC:', JSON.stringify(calls.map((c) => c.method + ' @' + c.tree)))
ok('没有重读历史/分支/作者', heavy().length === 0)
/* 芯片发两次：先便宜的「哪个仓库哪个分支」，再补工作区状态（走缓存，0ms）。
   6aede2c 起「每次打开」算一次刷新时机：重开还多发一次后台 git/command-log 预读
   （open 即发，不等切页）—— 这一次是规格内的代价，历史/分支/作者照旧一个不发。 */
const panelCalls = calls.filter((c) => c.method === 'git/panel')
const cmdlogCalls = calls.filter((c) => c.method === 'git/command-log')
ok('芯片两次状态读（走缓存，0ms）+ 面板打开即发的那一次后台命令预读',
  calls.length === 3 && panelCalls.length === 2 && cmdlogCalls.length === 1
  && calls.every((c) => c.tree === 'chip' || c.method === 'git/command-log')
  && cmdlogCalls.every((c) => c.tree === 'pop')
  && panelCalls.filter((c) => c.args.quick === true).length === 1)
ok('面板内容还在（标签页没丢）', textOf(tree).indexOf('历史') >= 0)

console.log('')
console.log('== 悬停卡片：先用记下来的列表画出来，同时在后台刷新 ==')
await chipClose()
fibers.clear()
calls.length = 0
const ct = await chipTree()
ct.props.onPointerEnter()
timers.filter((t) => t.kind === 'timeout' && !t.dead).forEach((t) => { t.dead = true; t.cb() })
await wait(15)
const card = await popTree()
ok('卡片出现', byClass(card, 'dsh-git-switch-hover').length === 1)
ok('首帧就有分支行（不是空列表）', branchRows(card).length > 0)
console.log('  卡片自己发的 RPC:', JSON.stringify(calls.map((c) => c.method)))
ok('同时还在后台刷新', calls.some((c) => c.method === 'git/branches'))

console.log('')
console.log('== 已经有缓存时，芯片不再重复预取 ==')
fibers.clear()
calls.length = 0
await chipTree()
await wait(40)
console.log('  芯片重挂载发出的 RPC:', JSON.stringify(calls.map((c) => c.method + ' ' + JSON.stringify(c.args))))
ok('不再重复预取分支列表', calls.filter((c) => c.method === 'git/branches').length === 0)
