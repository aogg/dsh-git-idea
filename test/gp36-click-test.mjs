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

function renderRoot(element, label) {
  const pending = []
  const render = (node, path) => {
    if (node === null || node === undefined) return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((c, i) => render(c, path + '.' + i))
    const type = node.type
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
    calls.push({ method, args })
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
new Function('ctx', 'React', 'host', 'styles', 'console', fs.readFileSync(process.env.GP_SRC || new URL('../dist/client.js', import.meta.url).pathname, 'utf8'))(
  ctx, React, host, styles, console).apply(ctx)

const chip = registered.find((r) => r.options.id === 'dsh-git-idea-chip').component
const popover = registered.find((r) => r.options.id === 'dsh-git-idea-panel').component
/* 全局设置页已搬进面板「配置」页的全局档（79-globalconfig.js），不再单独注册 ——
   这里没有要渲染它的用例，原本那行按 id 找组件的定义随之摘掉。 */

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

/* ── 点击面板内部不能把面板关掉（这是一个真实回归） ── */

console.log('== 点面板内部：必须留下 ==')
let tree = await openPanel()
console.log('  开面板后:', (await chipTree()).props.className, ' 监听器:', (fakeDoc._listeners['pointerdown'] || []).length)
ok('面板已打开', (await chipTree()).props.className.indexOf('dsh-git-chip-open') >= 0)
fakeDoc.fire('pointerdown', { target: INSIDE })
await wait(15)
console.log('  点内部后:', (await chipTree()).props.className, ' 监听器:', (fakeDoc._listeners['pointerdown'] || []).length)
tree = await settle('pop')
console.log('  settle 之后:', (await chipTree()).props.className, ' 监听器:', (fakeDoc._listeners['pointerdown'] || []).length)
ok('点内部后仍然打开', (await chipTree()).props.className.indexOf('dsh-git-chip-open') >= 0)
ok('面板内容还在（标签页在）', textOf(tree).indexOf('历史') >= 0)

console.log('')
console.log('== 连续点内部多次也不能关 ==')
console.log('  pointerdown 监听器数:', (fakeDoc._listeners['pointerdown'] || []).length)
console.log('  panelNode.contains(INSIDE):', panelNodeObj.contains(INSIDE), ' 是否同一个对象:', panelNodeObj === panelNodeObj)
for (let i = 0; i < 3; i += 1) {
  fakeDoc.fire('pointerdown', { target: INSIDE })
  await wait(10)
  console.log('  第 ' + (i + 1) + ' 次点击后 chip class:', (await chipTree()).props.className)
}
await settle('pop')
ok('点三次内部还是开着', (await chipTree()).props.className.indexOf('dsh-git-chip-open') >= 0)

console.log('')
console.log('== 点外面：应该关掉 ==')
fakeDoc.fire('pointerdown', { target: OUTSIDE })
await wait(15)
await settle('pop')
ok('点外面关掉了', (await chipTree()).props.className.indexOf('dsh-git-chip-open') < 0)

console.log('')
console.log('== Esc 也能关 ==')
await openPanel()
ok('重新打开', (await chipTree()).props.className.indexOf('dsh-git-chip-open') >= 0)
fakeDoc.fire('keydown', { key: 'Escape' })
await wait(15)
await settle('pop')
ok('Esc 关掉了', (await chipTree()).props.className.indexOf('dsh-git-chip-open') < 0)

console.log('')
console.log('== 切换器开着时，点面板内部也不该关面板 ==')
await openPanel()
tree = await settle('pop')
byClass(tree, 'dsh-git-branch-chip')[0].props.onClick()
await wait(10)
tree = await settle('pop')
ok('切换器开着', byClass(tree, 'dsh-git-switch').length === 1)
fakeDoc.fire('pointerdown', { target: INSIDE })
await wait(15)
tree = await settle('pop')
ok('面板还开着', (await chipTree()).props.className.indexOf('dsh-git-chip-open') >= 0)
ok('切换器收起了', byClass(tree, 'dsh-git-switch').length === 0)

console.log('')
console.log('== 点浮层卡片内部：谁都不该关 ==')
byClass(tree, 'dsh-git-branch-chip')[0].props.onClick()
await wait(10)
tree = await settle('pop')
ok('切换器又开了', byClass(tree, 'dsh-git-switch').length === 1)
fakeDoc.fire('pointerdown', { target: IN_CARD })
await wait(15)
tree = await settle('pop')
ok('卡片还在', byClass(tree, 'dsh-git-switch').length === 1)
ok('面板还在', (await chipTree()).props.className.indexOf('dsh-git-chip-open') >= 0)

console.log('')
console.log('== 点输入框旁边的按钮：不该关面板 ==')
fakeDoc.fire('pointerdown', { target: IN_CHIP })
await wait(15)
await settle('pop')
ok('面板还在（按钮自己决定开合）', (await chipTree()).props.className.indexOf('dsh-git-chip-open') >= 0)

console.log('')
console.log('== 选中分支不再冒出操作条 ==')
let t8 = await openPanel()
t8 = await settle('pop')
const localRow = collect(t8).find((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dsh-git-trow') >= 0 && textOf(n) === 'feature')
if (localRow === undefined) {
  console.log('  分支树里没有名为 feature 的行，改用第一行分支行')
} else {
  localRow.props.onClick()
  await wait(15)
  t8 = await settle('pop')
}
ok('没有 side-actions 条了', byClass(t8, 'dsh-git-side-actions').length === 0)
ok('工具栏本身还在', byClass(t8, 'dsh-git-tools').length === 1)
console.log('  工具栏按钮:', JSON.stringify(buttons(byClass(t8, 'dsh-git-tools')[0]).map(textOf)))
ok('工具栏里不再混入分支名', buttons(byClass(t8, 'dsh-git-tools')[0]).every((b) => textOf(b) !== '切换' && textOf(b) !== '合并' && textOf(b) !== '删除'))
ok('左栏仍只有分支树', byClass(t8, 'dsh-git-left').length === 1 && byClass(t8, 'dsh-git-side').length >= 1)
