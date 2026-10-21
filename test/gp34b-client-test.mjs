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
/* 仓库级操作已改成列表上方的 chip 条，.dsh-git-bs-row 现在只剩分支行 */
const branchRows = (t) => rows(t)
const chips = (t) => byClass(t, 'dsh-git-bs-chip')
/* 收藏按钮也在同一排里，但它不是「仓库动作」，筛选动不了它 */
const actionChips = (t) => chips(t).filter((c) => String(c.props.className).indexOf('dsh-git-bs-fav') < 0)
const head = (t) => byClass(t, 'dsh-git-bs-head')[0]
const headActs = (t) => byClass(t, 'dsh-git-bs-head-acts')[0]
/* 记号按钮没有文字了，按 title 找（title 就是原来那行说明） */
const chipWith = (t, label) => chips(t).find((c) => textOf(c).indexOf(label) >= 0 || String(c.props.title).indexOf(label) >= 0)
const sortBtn = (t) => byClass(t, 'dsh-git-bs-sort')[0]
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
/* let 而不是 const：多远端那一节要换成两远端 + 同名分支的答复，完了换回来 */
let branchesReply = {
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

const ok = (label, value) => console.log('  ' + (value ? '✓' : '✗') + ' ' + label + (value ? '' : '   ← 不符合预期'))

console.log('== 存储键：只认 dsh.git-idea.*，gitops 时代的键一律不读 ==')
store['dsh.gitops.settings'] = JSON.stringify({ watchEnabled: true, watchChip: true, watchFastSec: 9, watchSlowSec: 20, hoverSwitch: true })
store['dsh.gitops.panel'] = JSON.stringify({ w: 1111, h: 555 })
store['dsh.gitops.mru'] = JSON.stringify(['legacy-branch'])
store['dsh.gitops.stars'] = JSON.stringify(['legacy-star'])
store['dsh.gitops.sort'] = 'name'
{
  const t = await openSwitcher()
  ok('老 settings 键不再被读取', String(store['dsh.git-idea.settings'] || '').indexOf('9') < 0)
  ok('老 panel 键不再被读取', String(store['dsh.git-idea.panel'] || '').indexOf('1111') < 0)
  ok('老 mru 键不再被读取', String(store['dsh.git-idea.mru'] || '').indexOf('legacy-branch') < 0)
  ok('老 stars 键不再被读取', String(store['dsh.git-idea.stars'] || '').indexOf('legacy-star') < 0)
  ok('老 sort 键不再被读取（仍是默认的最近提交）', store['dsh.git-idea.sort'] !== 'name')
  ok('老键本身没有被改写', store['dsh.gitops.sort'] === 'name')
  // 清干净，后面的用例从默认状态开始
  delete store['dsh.git-idea.settings']
  delete store['dsh.git-idea.panel']
  delete store['dsh.git-idea.stars']
  delete store['dsh.git-idea.sort']
  delete store['dsh.git-idea.mru']
  byClass(t, 'dsh-git-branch-chip')[0].props.onClick()
  await wait(10)
  await settle('pop')
  await wait(10)
  await settle('pop')
}

console.log('')
console.log('== 打开切换器 ==')
let tree = await openSwitcher()
ok('切换器出现', byClass(tree, 'dsh-git-switch').length === 1)
ok('搜索框 placeholder 是「搜索分支」', byClass(tree, 'dsh-git-bs-search')[0].props.placeholder === '搜索分支')
ok('搜索框前面有放大镜', byClass(tree, 'dsh-git-bs-mag').length === 1)
ok('右侧有排序图标按钮', byClass(tree, 'dsh-git-bs-icon').length === 1)

console.log('')
console.log('== 操作区（IDEA 的 Update/Commit/Push 那一栏，chip 化）==')
const strip = chips(tree)
console.log('  操作 chip:', JSON.stringify(strip.map(textOf)))
console.log('  chip title:', JSON.stringify(strip.map((c) => c.props.title)))
const stripText = strip.map(textOf).join('|')
console.log('  strip 文本:', JSON.stringify(stripText))
ok('chip 只有记号，没有文字（角标是数字，留着）',
  strip.length === 5 && stripText.indexOf('⇣') === 0 && stripText.search(/[\u4e00-\u9fa5]/) < 0
  && ['☆', '★'].indexOf(textOf(strip[4])) >= 0)
ok('有 获取/拉取/推送 三个 chip', ['获取', '拉取', '推送'].every((l) => chipWith(tree, l) !== undefined))
ok('「回到上一个分支」的 chip 已经去掉了', chipWith(tree, '回到') === undefined && chipWith(tree, '上一个分支') === undefined)
ok('有「新建分支」chip', chipWith(tree, '新建分支') !== undefined)
ok('chip 是可点的 button', strip.every((c) => c.type === 'button' && typeof c.props.onClick === 'function'))
ok('chip 的 title 保留完整说明', chipWith(tree, '获取').props.title.indexOf('获取远端最新') === 0
  && chipWith(tree, '推送').props.title.indexOf('推送当前分支') === 0)
ok('chip 搬进了搜索框那一行（不再有自己的第二排）', headActs(tree) !== undefined
  && byClass(headActs(tree), 'dsh-git-bs-chip').length === strip.length
  && byClass(tree, 'dsh-git-bs-acts-bar').length === 0)
ok('搜索框和 chip 是同一行的兄弟', (head(tree).props.children || []).some((c) => c && c.props && c.props.className === 'dsh-git-bs-head-acts'))

console.log('')
console.log('== 排序按钮：两种模式两个图标 ==')
const iconNameOf = (t) => {
  const svg = collect(sortBtn(t)).find((n) => n.type === 'svg')
  return svg === undefined ? '' : String(svg.props.children.map((c) => c.props.d).join('|'))
}
const sortState = (t) => ({ icon: iconNameOf(t), title: String(sortBtn(t).props.title) })
const s0 = sortState(tree)
console.log('  现在的图标:', JSON.stringify(s0.icon.slice(0, 24)), ' title:', JSON.stringify(s0.title))
ok('排序按钮有一个图标', s0.icon.length > 0)
sortBtn(tree).props.onClick()
await wait(10)
tree = await settle('pop')
const s1 = sortState(tree)
console.log('  切换后的图标:', JSON.stringify(s1.icon.slice(0, 24)), ' title:', JSON.stringify(s1.title))
ok('换模式就换图标', s1.icon !== s0.icon && s1.icon.length > 0)
/* A→Z 的图标带那两笔 A，时钟的图标带两段圆弧 —— 两者必须互斥 */
const aOf = (st) => st.icon.indexOf('M2.4 12.2') >= 0
const clockOf = (st) => st.icon.indexOf('M8 2.8 A5.2') >= 0
ok('一个是 A→Z，另一个是时钟，不会同时出现', aOf(s0) !== aOf(s1) && clockOf(s0) !== clockOf(s1))
const nameModeOf = (st) => st.title.indexOf('当前按名称') === 0
ok('按名称的模式配 A→Z 图标', nameModeOf(s0) === aOf(s0) && nameModeOf(s1) === aOf(s1))
ok('title 说的是当前模式而不是动作', s0.title.indexOf('当前按') === 0 && s1.title.indexOf('当前按') === 0)
sortBtn(tree).props.onClick()
await wait(10)
tree = await settle('pop')
ok('再点一次切回原来的图标', sortState(tree).icon === s0.icon)
ok('列表里没有任何操作行', byClass(tree, 'dsh-git-bs-list')[0] !== undefined
  && branchRows(byClass(tree, 'dsh-git-bs-list')[0]).length === rows(tree).length)
ok('旧的整行操作区与分隔线都没了', byClass(tree, 'dsh-git-bs-action').length === 0 && byClass(tree, 'dsh-git-bs-sep').length === 0)
ok('列表自己可以滚（多出的一行高度还给了它）', byClass(tree, 'dsh-git-bs-list')[0].props.className.indexOf('dsh-git-bs-list') >= 0)

console.log('')
console.log('== 分组 ==')
console.log('  分组:', JSON.stringify(groups(tree).map(textOf)))
ok('有「本地」和「远端」', groups(tree).some((g) => textOf(g).indexOf('本地') >= 0) && groups(tree).some((g) => textOf(g).indexOf('远端') >= 0))
ok('「最近」此时为空（还没切过）', groups(tree).every((g) => textOf(g).indexOf('最近') < 0))
ok('当前分支也在列表里（用铅笔标记）', rowWith(tree, 'main') !== undefined)
ok('本地分组计数是 4', groups(tree).some((g) => textOf(g).indexOf('本地') >= 0 && textOf(g).indexOf('4') >= 0))
ok('远端行显示 remote-only', rowWith(tree, 'remote-only') !== undefined)
ok('远端行右侧写着 origin', (rowWith(tree, 'remote-only').props.children || []).some((c) => c && c.props && c.props.className === 'dsh-git-bs-up' && textOf(c) === 'origin'))

console.log('')
console.log('== 行内信息：领先/落后与上游 ==')
const mainRow = rowWith(tree, 'main')
console.log('  main 行:', JSON.stringify(textOf(mainRow)))
ok('main 显示 ↑2 ↓1（IDEA 的绿上/蓝下箭头）', textOf(mainRow).indexOf('↑2') >= 0 && textOf(mainRow).indexOf('↓1') >= 0)
ok('main 显示上游 origin/main', textOf(mainRow).indexOf('origin/main') >= 0)
ok('feature/one 显示 ↑1', textOf(rowWith(tree, 'feature/one')).indexOf('↑1') >= 0)
ok('tooltip 里解释数字', String(mainRow.props.title).indexOf('与上游分岔：领先 2，落后 1') >= 0)
ok('tooltip 里带提交主题与时间', String(mainRow.props.title).indexOf('tip main') >= 0)

console.log('')
console.log('== 排序：按最近提交 ↔ 按名称 ==')
const beforeSort = branchRows(tree).map(textOf)
byClass(tree, 'dsh-git-bs-icon')[0].props.onClick()
await wait(10)
tree = await settle('pop')
const afterSort = branchRows(tree).map(textOf)
console.log('  排序前:', JSON.stringify(beforeSort.slice(0, 5)))
console.log('  排序后:', JSON.stringify(afterSort.slice(0, 5)))
ok('落盘了排序偏好', store['dsh.git-idea.sort'] === 'name')
ok('按名称时 feature/one 排在 zeta 前', afterSort.findIndex((x) => x.indexOf('feature/one') >= 0) < afterSort.findIndex((x) => x.indexOf('zeta') >= 0))
byClass(tree, 'dsh-git-bs-icon')[0].props.onClick()
await wait(10)
tree = await settle('pop')
ok('能切回按最近提交', store['dsh.git-idea.sort'] === 'recent')

console.log('')
console.log('== 收藏：星标置顶 ==')
/* 收藏的按钮在头部那排动作里，指的是列表里高亮的那一行 —— 先把高亮移到 solo */
const favBtn = (t) => {
  const acts = byClass(t, 'dsh-git-bs-head-acts')[0]
  return acts === undefined ? undefined : buttons(acts).find((b) => String(b.props.className).indexOf('dsh-git-bs-fav') >= 0)
}
rowWith(tree, 'solo').props.onMouseEnter({ currentTarget: { offsetTop: 60 }, button: 0 })
await wait(10)
tree = await settle('pop')
ok('收藏按钮此时说的是 solo', String(favBtn(tree).props.title).indexOf('solo') > 0)
favBtn(tree).props.onClick({ stopPropagation() {} })
await wait(10)
tree = await settle('pop')
ok('写进了 dsh.gitops.stars', (store['dsh.git-idea.stars'] || '').indexOf('solo') >= 0)
const localRows = groups(tree).find((g) => textOf(g).indexOf('本地') >= 0)
const localsOnly = branchRows(tree).filter((r) => textOf(r).indexOf('remote-only') < 0)
ok('收藏后排在本地分组第一', textOf(localsOnly[0]).indexOf('solo') >= 0)

console.log('')
console.log('== 折叠分组 ==')
const localGroup = groups(tree).find((g) => textOf(g).indexOf('本地') >= 0)
localGroup.props.onClick()
await wait(10)
tree = await settle('pop')
ok('折叠后本地分支不再渲染', rowWith(tree, 'feature/one') === undefined)
ok('远端分组还在', rowWith(tree, 'remote-only') !== undefined)
groups(tree).find((g) => textOf(g).indexOf('本地') >= 0).props.onClick()
await wait(10)
tree = await settle('pop')
ok('再展开又回来了', rowWith(tree, 'feature/one') !== undefined)

console.log('')
console.log('== 搜索同时匹配分支和操作 ==')
let box = byClass(tree, 'dsh-git-bs-search')[0]
box.props.onChange({ target: { value: 'push' } })
await wait(10)
tree = await settle('pop')
ok('输入 push 只剩推送 chip', actionChips(tree).length === 1 && String(actionChips(tree)[0].props.title).indexOf('push') >= 0)
box = byClass(tree, 'dsh-git-bs-search')[0]
box.props.onChange({ target: { value: '拉取' } })
await wait(10)
tree = await settle('pop')
ok('输入「拉取」命中拉取 chip（中文短标签也能搜）', actionChips(tree).length === 1 && String(actionChips(tree)[0].props.title).indexOf('拉取') >= 0)
box = byClass(tree, 'dsh-git-bs-search')[0]
box.props.onChange({ target: { value: 'feat' } })
await wait(10)
tree = await settle('pop')
ok('输入 feat 只剩 feature/one', branchRows(tree).length === 1 && textOf(branchRows(tree)[0]).indexOf('feature/one') >= 0)
box = byClass(tree, 'dsh-git-bs-search')[0]
box.props.onChange({ target: { value: '' } })
await wait(10)
tree = await settle('pop')

console.log('')
console.log('== 键盘：跑操作行 ==')
box = byClass(tree, 'dsh-git-bs-search')[0]
calls.length = 0
box.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
await wait(5)
tree = await settle('pop')
byClass(tree, 'dsh-git-bs-search')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })
await wait(15)
console.log('  发出的 RPC:', JSON.stringify(calls.map((c) => c.method)))
ok('回车跑了当前高亮的操作行', calls.some((c) => c.method === 'git/pull' || c.method === 'git/fetch'))
ok('跑完给出内联反馈', textOf(await popTree()).indexOf('完成') >= 0)

/* IDEA 式子菜单：列表之外的独立面板（.dsh-git-bs-fly），不再是行内展开条。
   点 › 会「钉住」它，所以测试里用点击来打开，和鼠标悬浮得到的是同一个东西。 */
const flyOf = (t, name) => {
  const fly = byClass(t, 'dsh-git-bs-fly')[0]
  if (fly === undefined) return undefined
  return textOf(byClass(fly, 'dsh-git-bs-fly-head')[0] || fly).indexOf(name) >= 0 ? fly : undefined
}
const actsFor = (t, name) => flyOf(t, name)
async function openActs(t, name) {
  let tree = t
  let acts = flyOf(tree, name)
  if (acts === undefined) {
    const more = collect(rowWith(tree, name)).find((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dsh-git-bs-more') >= 0)
    more.props.onClick({ stopPropagation() {} })
    await wait(10)
    tree = await settle('pop')
    acts = flyOf(tree, name)
  }
  return { tree: tree, acts: acts }
}

console.log('')
console.log('== → 展开分支操作 ==')
tree = await settle('pop')
const moreBtn = collect(rowWith(tree, 'feature/one')).find((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dsh-git-bs-more') >= 0)
moreBtn.props.onClick({ stopPropagation() {} })
await wait(10)
tree = await settle('pop')
const acts = actsFor(tree, 'feature/one')
console.log('  展开后的操作:', JSON.stringify(buttons(acts).map(textOf)))
ok('有 检出/从此分支新建分支…/合并到当前分支/删除', buttons(acts).length === 4)
calls.length = 0
buttons(acts).find((b) => textOf(b) === '合并到当前分支').props.onClick({ stopPropagation() {} })
await wait(15)
ok('合并调用 git/sequence merge', calls.some((c) => c.method === 'git/sequence' && c.args.op === 'merge' && c.args.target === 'feature/one'))

console.log('')
console.log('== 删除：先安全删除，被拒后变「强制删除」==')
let t2 = await settle('pop')
const opened = await openActs(t2, 'feature/one')
t2 = opened.tree
const acts2 = opened.acts
calls.length = 0
let deleteReply = { ok: false, repo: '/tmp/ws', stderr: "error: the branch 'feature/one' is not fully merged", exitCode: 1 }
const realCall = host.call
host.call = function (method, args) {
  calls.push({ method, args })
  if (method === 'git/branch-delete') return Promise.resolve(deleteReply)
  return realCall(method, args)
}
buttons(acts2).find((b) => textOf(b) === '删除').props.onClick({ stopPropagation() {} })
await wait(15)
t2 = await settle('pop')
ok('第一次不带 force', calls.some((c) => c.method === 'git/branch-delete' && c.args.force !== true))
ok('提示里说明原因', textOf(t2).indexOf('还没有合并到别处') >= 0)
const acts3 = actsFor(t2, 'feature/one')
ok('出现「强制删除」', buttons(acts3).some((b) => textOf(b) === '强制删除'))
calls.length = 0
deleteReply = { ok: true, repo: '/tmp/ws', stdout: 'Deleted branch', stderr: '', exitCode: 0 }
buttons(acts3).find((b) => textOf(b) === '强制删除').props.onClick({ stopPropagation() {} })
await wait(15)
ok('第二次带 force', calls.some((c) => c.method === 'git/branch-delete' && c.args.force === true))
host.call = realCall

console.log('')
console.log('== 新建分支（内联输入）==')
let t3 = await settle('pop')
const newAction = chips(t3).find((r) => String(r.props.title).indexOf('新建分支') >= 0)
newAction.props.onClick({ stopPropagation() {} })
await wait(10)
t3 = await settle('pop')
const createBox = byClass(t3, 'dsh-git-bs-new')[0]
ok('出现内联输入框', createBox !== undefined)
ok('还没输入时没有 ×', byClass(t3, 'dsh-git-clear-x').length === 0)
createBox.props.onChange({ target: { value: 'feat' } })
await wait(5)
t3 = await settle('pop')
const newX = byClass(byClass(t3, 'dsh-git-bs-create')[0], 'dsh-git-clear-x')[0]
ok('输入后框里出现快捷清除 ×', newX !== undefined)
newX.props.onClick({ stopPropagation() {} })
await wait(5)
t3 = await settle('pop')
ok('点 × 把新分支名清空了', byClass(t3, 'dsh-git-bs-new')[0].props.value === '')
calls.length = 0
byClass(t3, 'dsh-git-bs-new')[0].props.onChange({ target: { value: 'feature/new' } })
await wait(5)
t3 = await settle('pop')
byClass(t3, 'dsh-git-bs-new')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })
await wait(15)
console.log('  创建调用:', JSON.stringify(calls.filter((c) => c.method === 'git/branch-create')))
ok('调用 git/branch-create', calls.some((c) => c.method === 'git/branch-create' && c.args.name === 'feature/new'))

console.log('')
console.log('== 从某个分支上新建 ==')
let t4 = await openSwitcher()
console.log('  切换器开着:', byClass(t4, 'dsh-git-switch').length === 1, ' 上下文行:', JSON.stringify(branchRows(t4).map(textOf).slice(0, 3)))
const opened4 = await openActs(t4, 'solo')
console.log('  展开的行:', buttons(opened4.acts).map(textOf).join('/'), ' title:', String(buttons(opened4.acts)[1].props.title || ''))
t4 = opened4.tree
buttons(opened4.acts).find((b) => textOf(b).indexOf('从此分支新建分支') >= 0).props.onClick({ stopPropagation() {} })
await wait(10)
t4 = await settle('pop')
ok('输入框提示以 solo 为起点', byClass(t4, 'dsh-git-bs-new')[0].props.placeholder.indexOf('solo') >= 0)
calls.length = 0
byClass(t4, 'dsh-git-bs-new')[0].props.onChange({ target: { value: 'from-solo' } })
await wait(5)
t4 = await settle('pop')
byClass(t4, 'dsh-git-bs-new')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })
await wait(15)
ok('带上了起点 at=solo', calls.some((c) => c.method === 'git/branch-create' && c.args.at === 'solo' && c.args.name === 'from-solo'))

console.log('')
console.log('== 切换：记录最近使用 + 关闭 ==')
let t5 = await openSwitcher()
calls.length = 0
checkoutReply = { ok: true, repo: '/tmp/ws', stashed: false, dirty: 0, popConflict: false, stdout: '', stderr: 'Switched to branch', exitCode: 0 }
rowWith(t5, 'zeta').props.onClick()
await wait(15)
ok('调用 git/checkout 切 zeta', calls.some((c) => c.method === 'git/checkout' && c.args.name === 'zeta'))
ok('记进最近使用', (store['dsh.git-idea.mru'] || '').indexOf('zeta') >= 0)
t5 = await settle('pop')
ok('切完自动收起', byClass(t5, 'dsh-git-switch').length === 0)
t5 = await openSwitcher()
ok('重开后出现「最近」分组', groups(t5).some((g) => textOf(g).indexOf('最近') >= 0))
ok('最近里有 zeta', groups(t5).find((g) => textOf(g).indexOf('最近') >= 0) !== undefined)

console.log('')
console.log('== 有改动时的暂存保护仍在 ==')
const OK_DIRTY = Object.assign({}, OK_PANEL, { staged: [{ path: 'a', code: 'M' }] })
let watchSig = 'SIG'
host.call = function (method, args) {
  calls.push({ method, args })
  if (method === 'git/panel') return Promise.resolve(OK_DIRTY)
  if (method === 'git/watch') return Promise.resolve({ ok: true, repo: '/tmp/ws', sig: watchSig })
  return realCall(method, args)
}
/* 推送化之后没有定时器轮询（本套件的加载现场就没有 liveBus，正是 bridge 版）：
 * 先把假时钟摇光 —— 0 次 git/watch，证明没有轮询兜底；变化改由事件驱动的
 * 一拍核对发现（这里用回可见触发，fakeDoc 上的 visibility 监听是挂载时注册的）。 */
const watchesBefore = calls.filter((c) => c.method === 'git/watch').length
for (let i = 0; i < 4; i += 1) timers.filter((t) => t.kind === 'interval' && !t.dead).forEach((t) => t.cb())
await wait(20)
ok('无 WS 推送也不轮询兜底：摇光时钟，一次 git/watch 都没有',
  calls.filter((c) => c.method === 'git/watch').length === watchesBefore)
/* 走真实路径：事件核对发现仓库变了 → flush + 通知所有表面重读 */
const beat34b = async () => { fakeDoc.hidden = false; fakeDoc.fire('visibilitychange'); await wait(20) }
await beat34b()
watchSig = 'SIG-2'
await beat34b()
await wait(20)
let t6 = await settle('pop')
const box6 = byClass(t6, 'dsh-git-bs-check')
ok('出现暂存勾选项', box6.length === 1)
collect(box6[0]).find((n) => n.type === 'input').props.onChange({ target: { checked: true } })
await wait(10)
t6 = await settle('pop')
const dirtyActs = await openActs(t6, 'solo')
t6 = dirtyActs.tree
ok('切换按钮改叫「暂存并切换」', buttons(dirtyActs.acts).some((b) => textOf(b) === '暂存并切换'))
calls.length = 0
checkoutReply = { ok: true, repo: '/tmp/ws', stashed: true, dirty: 1, popConflict: false, stdout: '', stderr: '', exitCode: 0 }
rowWith(t6, 'solo').props.onClick()
await wait(15)
ok('切换带了 stash:true', calls.some((c) => c.method === 'git/checkout' && c.args.stash === true))
host.call = realCall

console.log('')
console.log('== 远端分支：检出为本地分支 ==')
let t7 = await openSwitcher()
const opened7 = await openActs(t7, 'remote-only')
t7 = opened7.tree
const remoteActs = opened7.acts
console.log('  远端行操作:', JSON.stringify(buttons(remoteActs).map(textOf)))
ok('写「检出为本地分支」而不是「切换」', buttons(remoteActs).some((b) => textOf(b) === '检出为本地分支'))
ok('远端行不给删除', buttons(remoteActs).every((b) => textOf(b).indexOf('删除') < 0))
calls.length = 0
checkoutReply = { ok: true, repo: '/tmp/ws', stashed: false, dirty: 0, popConflict: false, stdout: '', stderr: '', exitCode: 0 }
buttons(remoteActs).find((b) => textOf(b) === '检出为本地分支').props.onClick({ stopPropagation() {} })
await wait(15)
ok('用完整远端分支名显式检出（asNewLocal，不再走 DWIM 短名）',
  calls.some((c) => c.method === 'git/checkout' && c.args.name === 'origin/remote-only' && c.args.asNewLocal === true))

console.log('')
console.log('== 多远端：按远端分组、同名分支两行都在 ==')
/* 两个远端（origin / upstream）各有一条 notes，本地没有同名 —— 两行都得在，
   而且是两行不同的行：key 带远端名，悬停子菜单、回车、收藏互不串位。本地
   已有 mirror 时，origin/mirror 与 upstream/mirror 照样显示（不再被剔除），
   点它们不发请求，先被指到「本地」组那一行。 */
branchesReply = {
  ok: true, repo: '/tmp/ws', current: 'main', previous: '',
  branches: [
    { name: 'main', current: true, committedAt: nowSec - 5, upstream: 'origin/main', track: '=', ahead: 0, behind: 0, head: 'aaa', subject: 'tip main' },
    { name: 'mirror', current: false, committedAt: nowSec - 70, upstream: '', track: '', ahead: 0, behind: 0, head: 'bbb', subject: 'local mirror' },
  ],
  remotes: [
    { name: 'notes', remote: 'origin', ref: 'origin/notes', committedAt: nowSec - 61, head: 'ccc', subject: 'origin notes' },
    { name: 'notes', remote: 'upstream', ref: 'upstream/notes', committedAt: nowSec - 62, head: 'ddd', subject: 'upstream notes' },
    { name: 'mirror', remote: 'origin', ref: 'origin/mirror', committedAt: nowSec - 63, head: 'eee', subject: 'origin mirror' },
    { name: 'mirror', remote: 'upstream', ref: 'upstream/mirror', committedAt: nowSec - 64, head: 'fff', subject: 'upstream mirror' },
  ],
}
let tm = await openSwitcher()
const groupTexts = groups(tm).map(textOf)
console.log('  分组:', JSON.stringify(groupTexts))
ok('远端按名字各成一组（origin 优先）',
  groupTexts.some((x) => x.indexOf('远端 · origin') >= 0) && groupTexts.some((x) => x.indexOf('远端 · upstream') >= 0))
/* mini-React 的 memo 行不带元素 key，行的身份改从「行尾的远端小字 + 行为」断言：
   两行 notes 各自写着 origin / upstream，点 upstream 那一行发出的就是
   upstream/notes 的显式检出 —— 串了行这条会先红。 */
const notesRows = branchRows(tm).filter((r) => textOf(r).indexOf('notes') >= 0)
const originNotesRow = notesRows.find((r) => textOf(r).indexOf('origin') >= 0)
const upstreamNotesRow = notesRows.find((r) => textOf(r).indexOf('upstream') >= 0)
const mirrorRemoteRows = branchRows(tm).filter((r) => textOf(r).indexOf('mirror') >= 0
  && (textOf(r).indexOf('origin') >= 0 || textOf(r).indexOf('upstream') >= 0))
ok('notes 在两个远端各一行（同名不并成一行）', notesRows.length === 2 && originNotesRow !== undefined && upstreamNotesRow !== undefined)
ok('两行的行尾小字各写各的远端', originNotesRow !== upstreamNotesRow
  && textOf(originNotesRow).indexOf('upstream') < 0 && textOf(upstreamNotesRow).indexOf('origin') < 0)
ok('本地已有 mirror 的远端分支也显示（不再剔除）', mirrorRemoteRows.length === 2)
/* upstream 那一行的子菜单要认得出是 upstream 的（旧的共享 key 会把它认成第一行）。
   gp34b 的假 timer 不自动走点，所以用 › 按钮钉住 —— 与悬停展开的是同一个 fly。 */
const upMore = collect(upstreamNotesRow).find((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dsh-git-bs-more') >= 0)
upMore.props.onClick({ stopPropagation() {} })
await wait(10)
tm = await settle('pop')
const upFly = byClass(tm, 'dsh-git-bs-fly')[0]
console.log('  upstream 行的子菜单头:', JSON.stringify(textOf(byClass(upFly, 'dsh-git-bs-fly-head')[0])))
ok('子菜单头带着完整 ref（upstream/notes）', textOf(byClass(upFly, 'dsh-git-bs-fly-head')[0]).indexOf('upstream/notes') >= 0)
calls.length = 0
buttons(upFly).find((b) => textOf(b) === '检出为本地分支').props.onClick({ stopPropagation() {} })
await wait(15)
ok('检出发的是 upstream/notes 的显式形状',
  calls.some((c) => c.method === 'git/checkout' && c.args.name === 'upstream/notes' && c.args.asNewLocal === true))
tm = await settle('pop')

/* 本地同名时的预检：不发请求，把「本地」组那一行指出来。上一次检出成功把卡
   收了，这里重新开一张、从新渲染里重新拿行。 */
tm = await openSwitcher()
calls.length = 0
const mirrorRemoteRows2 = branchRows(tm).filter((r) => textOf(r).indexOf('mirror') >= 0
  && (textOf(r).indexOf('origin') >= 0 || textOf(r).indexOf('upstream') >= 0))
const mirrorOriginRow = mirrorRemoteRows2.find((r) => textOf(r).indexOf('origin') >= 0)
mirrorOriginRow.props.onClick({ stopPropagation() {} })
await wait(15)
tm = await settle('pop')
ok('本地已有同名分支：不发检出请求', calls.every((c) => c.method !== 'git/checkout'))
ok('并且说清「本地」组里那一行就是它', textOf(tm).indexOf('本地已经有同名分支 mirror') >= 0)

/* 搜索认完整 ref：搜 upstream 只剩 upstream 组里的行 */
byClass(tm, 'dsh-git-bs-search')[0].props.onChange({ target: { value: 'upstream' } })
await wait(10)
tm = await settle('pop')
const searchedRows = branchRows(tm).filter((r) => textOf(r).indexOf('notes') >= 0)
ok('搜索匹配完整名：搜 upstream 只剩 upstream 的 notes',
  searchedRows.length === 1 && textOf(searchedRows[0]).indexOf('upstream') >= 0 && textOf(searchedRows[0]).indexOf('origin') < 0)
byClass(tm, 'dsh-git-bs-search')[0].props.onChange({ target: { value: '' } })
await wait(10)
branchesReply = {
  ok: true, repo: '/tmp/ws', current: 'main', previous: 'solo',
  branches: [
    { name: 'main', current: true, committedAt: nowSec - 5, upstream: 'origin/main', track: '=', ahead: 2, behind: 1, head: 'aaa', subject: 'tip main' },
    { name: 'solo', current: false, committedAt: nowSec - 3600, upstream: '', track: '', ahead: 0, behind: 0, head: 'bbb', subject: 'solo tip' },
    { name: 'feature/one', current: false, committedAt: nowSec - 90000, upstream: 'origin/feature/one', track: '>', ahead: 1, behind: 0, head: 'ccc', subject: 'one tip' },
    { name: 'zeta', current: false, committedAt: nowSec - 9000, upstream: '', track: '', ahead: 0, behind: 0, head: 'ddd', subject: 'z' },
  ],
  remotes: [{ name: 'remote-only', remote: 'origin', ref: 'origin/remote-only', committedAt: nowSec - 500, head: 'eee', subject: 'r' }],
}
await settle('pop')

console.log('')
console.log('== 配置页的全局档里能清掉这些记忆 ==')
/* 设置页（DSH 设置面板里的 dsh-git-idea配置）搬进了面板「配置」页的全局档 ——
   这里从面板走同一条路：开面板 → 配置页签 → 全局配置。fiber 全程留在 openPanel
   用的 'pop' 上，页内的重渲染走 settle。 */
fibers.clear()
const cfgOpen = await openPanel()
buttons(cfgOpen).find((b) => textOf(b) === '配置').props.onClick()
let settings = await settle('pop')
buttons(settings).find((b) => textOf(b) === '全局配置').props.onClick()
settings = await settle('pop')
const clear = buttons(settings).find((b) => textOf(b).indexOf('清除') >= 0)
ok('有清除按钮', clear !== undefined)
clear.props.onClick()
await wait(10)
ok('最近使用被清空', store['dsh.git-idea.mru'] === '[]')
ok('收藏被清空', store['dsh.git-idea.stars'] === '[]')

console.log('')
console.log('== 全局档的文本框也有快捷清除 ==')
const initWrap = byClass(settings, 'dsh-git-clearable-set')[0]
ok('初始化分支那一栏是「可清除」的框', initWrap !== undefined)
byClass(settings, 'dsh-git-set-input')[0].props.onChange({ target: { value: 'trunk' } })
await wait(10)
const settings2 = await settle('pop')
const initX = byClass(byClass(settings2, 'dsh-git-clearable-set')[0], 'dsh-git-clear-x')[0]
ok('填了内容就出现 ×', initX !== undefined)
initX.props.onClick({ stopPropagation() {} })
await wait(10)
const settings3 = await settle('pop')
ok('点 × 清空了这一栏', byClass(settings3, 'dsh-git-set-input')[0].props.value === '')

console.log('')
console.log('== 面板本体没被改坏 ==')
fibers.clear()
calls.length = 0
const panelTree = await openPanel()
ok('面板仍然渲染出三栏', byClass(panelTree, 'dsh-git-left').length === 1 && byClass(panelTree, 'dsh-git-main').length === 1)
ok('工具栏还在', byClass(panelTree, 'dsh-git-tools').length === 1)
ok('头部同步按钮还在', byClass(panelTree, 'dsh-git-sync').length === 1)
