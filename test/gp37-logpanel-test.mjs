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

/* ── 左侧分支树：单击只选中，双击才联动中间的历史 ── */

/* 样式由 styles.insert 注入，测试里拿不到，预算要用的数字直接从源文件读 */
const sourceCss = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')

const treeRows = (t) => collect(t).filter((n) => typeof n.props.className === 'string' && n.props.className.split(' ').indexOf('dsh-git-trow') >= 0)
/* 分支行不再是名字独占一行：名字与「跟踪的上游」小字包在同一个纵列里（tmain/tsub），
   整行的 textOf 因此是「名字 + 上游小字」，不再等于分支名 —— 按名字那一格（tname）
   比对；HEAD 组的行名字前带 ★ 记号（在 tname 外面），比对前先剥掉。 */
const tnameOf = (row) => { const n = byClass(row, 'dsh-git-tname')[0]; return n === undefined ? '' : textOf(n) }
const trowWith = (t, label) => {
  const bare = label.charAt(0) === '★' ? label.slice(1) : label
  return treeRows(t).find((n) => tnameOf(n) === bare)
}
const graphCalls = () => calls.filter((c) => c.method === 'git/graph')
const lastGraph = () => graphCalls()[graphCalls().length - 1]

async function openLog() {
  const t = await openPanel()
  /* 面板默认在「历史」页 */
  return t
}

console.log('== 中间栏：IDEA 式一行筛选（不再有第二排输入框）==')
let t = await openLog()
console.log('  工具栏文本:', JSON.stringify(textOf(byClass(t, 'dsh-git-tools')[0])))
ok('工具栏只有一行', byClass(t, 'dsh-git-tools').length === 1)
ok('旧的第二排筛选框没了', byClass(t, 'dsh-git-filters').length === 0)
ok('旧的「筛选」开关按钮没了', buttons(byClass(t, 'dsh-git-tools')[0]).every((b) => textOf(b).indexOf('筛选') < 0))
ok('搜索框带放大镜', byClass(t, 'dsh-git-logsearch').length === 1 && byClass(t, 'dsh-git-logsearch-ico').length === 1)
ok('搜索框 placeholder 是「搜索提交信息…」', byClass(t, 'dsh-git-logsearch-input')[0].props.placeholder === '搜索提交信息…')
ok('四个筛选触发器都在（分支/作者/时间/路径）', byClass(t, 'dsh-git-lf').length === 4)
ok('分支筛选一直显示「分支：」', textOf(byClass(t, 'dsh-git-lf')[0]).indexOf('分支：') === 0)
ok('未设置时只显示字段名（作者/时间/路径）', byClass(t, 'dsh-git-lf').slice(1).map(textOf).join('|').indexOf('：') < 0)
ok('分支触发器用短标签（当前 main）', textOf(byClass(t, 'dsh-git-lf')[0]).indexOf('当前 main') > 0
  && textOf(byClass(t, 'dsh-git-lf')[0]).indexOf('当前分支（') < 0)
ok('筛选用的是无边框 select/input', byClass(t, 'dsh-git-lf-select').length === 3 && byClass(t, 'dsh-git-lf-input').length === 1)
/* 只看中间栏这条工具栏：面板头部那组同步按钮也是 .dsh-git-tool */
const toolBar = byClass(t, 'dsh-git-tools')[0]
console.log('  这条工具栏里的 .dsh-git-tool:', JSON.stringify(byClass(toolBar, 'dsh-git-tool').map((b) => b.props.title)))
ok('拣选/还原/标签/分支四个图标键没了（对选中提交的动作搬进了提交行右键菜单）',
  byClass(toolBar, 'dsh-git-tool-ico').length === 0 && byClass(toolBar, 'dsh-git-tool').length === 0)
const actBtns = byClass(toolBar, 'dsh-git-acts-btn')
ok('⚡ 还在，仍是那个「开一个菜单」的按钮（⋯ 更多操作已整个下掉）', byClass(toolBar, 'dsh-git-acts').length === 1 && actBtns.length === 1)
ok('⚡ 的说明照旧（快捷命令的命令模板代值）', String(actBtns[0].props.title).indexOf('快捷命令') === 0)

console.log('')
console.log('== 中间这条工具栏：一行装得下，且筛选一多也不乱 ==')
const pxNum = (re) => {
  const m = sourceCss.match(re)
  return m === null ? -1 : Number(m[1])
}
const padRight = pxNum(/\.dsh-git-tools\{[^}]*padding:\d+px (\d+)px \d+px \d+px/)
const searchMax = pxNum(/\.dsh-git-logsearch\{[^}]*max-width:(\d+)px/)
const selectRule = (sourceCss.match(/\.dsh-git-lf-select\{[^}]*\}/) || [''])[0]
ok('工具条给右上角的条数留出了位置', padRight >= 44)
ok('条数绝对定位在右端（不会自己换到第二行）', /\.dsh-git-count\{[^}]*position:absolute/.test(sourceCss))
ok('这条工具栏不再换行（分支名再长也挤不散）', /\.dsh-git-tools\{[^}]*flex-wrap:nowrap/.test(sourceCss))
ok('分组/目录的条数跟在名字后面（不再顶到最右）', /\.dsh-git-tdim\{[^}]*\}/.test(sourceCss) && /\.dsh-git-tdim\{[^}]*margin-left:auto/.test(sourceCss) === false)
ok('筛选触发器可以让位（flex:0 1 auto + min-width:0）', /\.dsh-git-lf\{[^}]*flex:0 1 auto[^}]*min-width:0/.test(sourceCss))
ok('26px 图标键的画法还在，但主人换了（差异头部的返回/⟳/☰，不再是提交操作）', /\.dsh-git-tool-ico\{[^}]*width:26px/.test(sourceCss))
ok('⚡ 这个开菜单的按钮照旧是 26px 方块', /\.dsh-git-acts-btn\{[^}]*width:26px/.test(sourceCss))
ok('搜索框不再是越大越好（上限收到 260 以内）', searchMax > 0 && searchMax <= 260)
ok('下拉不再写死宽度（改为按当前显示的值量宽）', selectRule.indexOf('max-width') < 0)
ok('下拉关着时长名以省略号收尾（cap 放宽后靠它兜住）', selectRule.indexOf('text-overflow:ellipsis') >= 0)

/* 具体到数字：把四个筛选都设上，量几个控件自己的宽度之和 */
const setFilter = async (i, value) => {
  byClass(t, 'dsh-git-lf-select')[i].props.onChange({ target: { value: value } })
  await wait(10)
  t = await settle('pop')
}
await setFilter(1, 'mays@example.com')
await setFilter(2, 'week')
byClass(t, 'dsh-git-lf-input')[0].props.onChange({ target: { value: 'src/main/java' } })
await wait(5)
t = await settle('pop')
byClass(t, 'dsh-git-lf-input')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })
await wait(10)
t = await settle('pop')
const trigW = byClass(t, 'dsh-git-lf-select').map((s) => Number(String(s.props.style.width).replace('px', '')))
const pathW = Number(String(byClass(t, 'dsh-git-lf-input')[0].props.style.width).replace('px', ''))
console.log('  触发器宽度:', JSON.stringify(trigW), ' 路径框:', pathW, ' 合计:', trigW.reduce((a, b) => a + b, 0) + pathW)
ok('四个筛选控件宽度之和 < 320px（选了条件也不会把行撑爆）', trigW.reduce((a, b) => a + b, 0) + pathW < 320)
ok('短值的下拉会缩到贴合文字（mays 不再是 112px 空框）', (function () {
  const authorSel = byClass(t, 'dsh-git-lf-select')[1]
  return Number(String(authorSel.props.style.width).replace('px', '')) < 60
})())
ok('作者/时间的下拉仍以 132 封顶（放宽只属于分支范围）', trigW[1] <= 132 && trigW[2] <= 132)
ok('分支范围这一格在分支自己的 cap（300）之内', trigW[0] <= 300)
/* 工具栏一行要装下的东西：⚡ 一个 26px 键 + 分隔线 + 搜索框最小宽
   + 四个触发器的标签前缀 + 它们各自的控件 + 条数预留的位置 + 间距 */
const chrome = 1 * 26 + 3 + 7 + 80 + (22 * 4) + 80 + 12 * 3
console.log('  固定部分:', chrome, 'px  控件:', trigW.reduce((a, b) => a + b, 0) + pathW, 'px')
ok('筛选全设上也只要 ~600px 出头（常见宽度下仍是一行）', chrome + trigW.reduce((a, b) => a + b, 0) + pathW < 660)

/* 收工：把筛选清掉，后面的用例假设没有筛选 */
await setFilter(1, '')
await setFilter(2, 'all')
byClass(t, 'dsh-git-lf-input')[0].props.onChange({ target: { value: '' } })
await wait(5)
t = await settle('pop')
byClass(t, 'dsh-git-lf-input')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })
await wait(10)
t = await settle('pop')
ok('收工后「全部清除」也跟着消失', byClass(t, 'dsh-git-lclear').length === 0)
ok('没有筛选时不显示「全部清除」', byClass(t, 'dsh-git-lclear').length === 0)

console.log('')
console.log('== 单击分支：只选中，不改中间的历史 ==')
t = await openLog()
const before = graphCalls().length
const featureRow = trowWith(t, 'feature')
ok('左侧树里有 feature 分支行', featureRow !== undefined)
featureRow.props.onClick()
await wait(15)
t = await settle('pop')
const afterClick = graphCalls().slice(before)
console.log('  单击后新增的 git/graph:', JSON.stringify(afterClick.map((c) => c.args.ref || (c.args.allRefs ? '@all' : 'main'))))
ok('单击没有重新读历史', afterClick.length === 0)
ok('单击选中了那一行', String(trowWith(t, 'feature').props.className).indexOf('dsh-git-trow-sel') >= 0)
ok('单击没有把它标成筛选范围', String(trowWith(t, 'feature').props.className).indexOf('dsh-git-trow-scope') < 0)
ok('单击给了「双击」提示', String(trowWith(t, 'feature').props.title).indexOf('双击') > 0)

console.log('')
console.log('== 双击分支：这才把历史切到它 ==')
trowWith(t, 'feature').props.onDoubleClick()
await wait(15)
t = await settle('pop')
console.log('  双击后的 git/graph:', JSON.stringify(graphCalls().slice(before).map((c) => c.args.ref || (c.args.allRefs ? '@all' : 'main'))))
ok('双击重新读了历史', graphCalls().length > before + 0 && lastGraph().args.ref === 'feature')
ok('双击后那一行标成筛选范围', String(trowWith(t, 'feature').props.className).indexOf('dsh-git-trow-scope') >= 0)
ok('双击后分支筛选触发器显示该分支', textOf(byClass(t, 'dsh-git-lf')[0]).indexOf('feature') > 0)
ok('别的分支没有被标成范围', String(trowWith(t, 'stable').props.className).indexOf('dsh-git-trow-scope') < 0)

console.log('')
console.log('== 分组标题也是一行：单击只选中，双击或点三角才折叠 ==')
/* 分组标题（HEAD / 本地 / 远程）原来是这一棵树里唯一单击就折叠的行：点一下树就动，
   选中却没动，看起来像点错了东西。它现在和目录行同一条规矩。 */
const groupRow = (tree, label) => byClass(tree, 'dsh-git-trow').filter((r) => textOf(r).indexOf(label) >= 0)[0]
const localTitle = groupRow(t, '本地')
ok('本地分组有一行标题，带自己的三角',
  localTitle !== undefined && byClass(localTitle, 'dsh-git-tw').length === 1)
ok('标题行也给了「双击」提示', String(localTitle.props.title).indexOf('双击') > 0)
const beforeTitleClick = graphCalls().length
localTitle.props.onClick()
await wait(15)
t = await settle('pop')
ok('单击标题：这一组的分支行都还在（树没有折）',
  trowWith(t, 'stable') !== undefined && trowWith(t, 'feature') !== undefined)
ok('单击标题：变成这一行选中', String(groupRow(t, '本地').props.className).indexOf('dsh-git-trow-sel') >= 0)
ok('单击标题没有重新读历史', graphCalls().length === beforeTitleClick)
ok('同时只有一行是选中的（分支行让位给标题行）', byClass(t, 'dsh-git-trow-sel').length === 1)

console.log('')
console.log('== 双击标题 / 点三角：这才折叠 ==')
/* 手势要是退回「单击就折叠」，这里不该抛异常，只该是一排 ✗：抛出去会把后面
   所有段落一起带走，回归信号就只剩一个栈。 */
const titleAgain = groupRow(t, '本地')
if (titleAgain !== undefined && typeof titleAgain.props.onDoubleClick === 'function') titleAgain.props.onDoubleClick()
await wait(15)
t = await settle('pop')
ok('双击标题：本地这一组折起来了', trowWith(t, 'stable') === undefined)
ok('折起来之后标题行还在，而且照样是选中的',
  groupRow(t, '本地') !== undefined
  && String(groupRow(t, '本地').props.className).indexOf('dsh-git-trow-sel') >= 0)
let titleTwistyStopped = false
const titleTwisty = byClass(groupRow(t, '本地'), 'dsh-git-tw')[0]
if (titleTwisty !== undefined && typeof titleTwisty.props.onClick === 'function') {
  titleTwisty.props.onClick({ stopPropagation: function () { titleTwistyStopped = true } })
}
await wait(15)
t = await settle('pop')
ok('点三角会拦住冒泡（所以它顺手改不了选中）', titleTwistyStopped)
ok('点三角：这一组又展开了', trowWith(t, 'stable') !== undefined)
ok('点三角之后选中的还是标题行', String(groupRow(t, '本地').props.className).indexOf('dsh-git-trow-sel') >= 0)

console.log('')
console.log('== 每个筛选自己带 × 清除 ==')
const clearBranch = byClass(t, 'dsh-git-lf')[0].props.children.filter((c) => c != null && c.type === 'button')[0]
ok('分支筛选上有 ×', clearBranch !== undefined)
if (clearBranch !== undefined) {
  clearBranch.props.onClick({ stopPropagation() {} })
  await wait(15)
  t = await settle('pop')
  console.log('  清除分支范围后:', JSON.stringify(lastGraph().args))
  ok('× 之后回到默认范围（当前分支）', lastGraph().args.allRefs === undefined && lastGraph().args.ref === undefined)
}

console.log('')
console.log('== 作者 / 时间 / 路径三个触发器都会进 history 查询 ==')
const authorSelect = byClass(t, 'dsh-git-lf-select')[1]
authorSelect.props.onChange({ target: { value: 'mays@example.com' } })
await wait(15)
t = await settle('pop')
ok('选作者后 history 带上 author', lastGraph().args.author === 'mays@example.com')
ok('作者触发器变成「作者：」前缀', textOf(byClass(t, 'dsh-git-lf')[1]).indexOf('作者：') === 0)

const dateSelect = byClass(t, 'dsh-git-lf-select')[2]
dateSelect.props.onChange({ target: { value: 'week' } })
await wait(15)
t = await settle('pop')
ok('选时间后 history 带上 since', typeof lastGraph().args.since === 'string' && lastGraph().args.since.length > 0)
ok('时间触发器显示所选预设', textOf(byClass(t, 'dsh-git-lf')[2]).indexOf('最近 7 天') > 0)

const pathInput = byClass(t, 'dsh-git-lf-input')[0]
pathInput.props.onChange({ target: { value: 'src/main' } })
await wait(10)
t = await settle('pop')
byClass(t, 'dsh-git-lf-input')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })
await wait(15)
t = await settle('pop')
ok('路径回车后 history 带上 path', lastGraph().args.path === 'src/main')
ok('路径触发器加了「路径：」前缀', textOf(byClass(t, 'dsh-git-lf')[3]).indexOf('路径：') === 0)
ok('路径输入框里就是那个路径', byClass(t, 'dsh-git-lf-input')[0].props.value === 'src/main')
ok('此时才出现「全部清除」', byClass(t, 'dsh-git-lclear').length === 1)

const allClear = byClass(t, 'dsh-git-lclear')[0]
allClear.props.onClick()
await wait(15)
t = await settle('pop')
const after = lastGraph().args
console.log('  全部清除后的 git/graph:', JSON.stringify(after))
ok('全部清除撤掉 author/since/path', after.author === undefined && after.since === undefined && after.path === undefined)
ok('全部清除后回到当前分支范围', after.allRefs === undefined && after.ref === undefined)

console.log('')
console.log('== 搜索框自带的 × ==')
const box = byClass(t, 'dsh-git-logsearch-input')[0]
box.props.onChange({ target: { value: 'AS2' } })
await wait(10)
t = await settle('pop')
ok('有草稿时搜索框出现 ×', byClass(t, 'dsh-git-logsearch-x').length === 1)
byClass(t, 'dsh-git-logsearch-input')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })
await wait(15)
t = await settle('pop')
ok('回车把搜索交给 history 查询', lastGraph().args.search === 'AS2')
byClass(t, 'dsh-git-logsearch-x')[0].props.onClick({ stopPropagation() {} })
await wait(15)
t = await settle('pop')
ok('× 之后 history 不再带 search', lastGraph().args.search === undefined)
ok('× 之后搜索框空了', byClass(t, 'dsh-git-logsearch-input')[0].props.value === '')

console.log('')
console.log('== 分支范围筛选单独放宽：cap 300，关着时 title 给全名 ==')
/* 分支名动辄二十几个字符，132px 只装得下一个省略号，原生下拉的弹层宽度还跟着
   select 走。分支筛选的上限单独放宽到 300，作者/时间仍以 132 封顶 —— 用一个长
   中文名把「破得了 132、破不了 300」和 title 全名一起钉住。 */
const wideSavedCall = host.call
const longBranch = '这是个相当长的中文分支名字用例'
host.call = function (method, args) {
  if (method === 'git/refs') {
    return Promise.resolve({ ok: true, repo: '/tmp/ws', current: [longBranch],
      local: [{ segments: [longBranch], data: longBranch }], remote: [] })
  }
  if (method === 'git/graph') {
    return Promise.resolve({ ok: true, repo: '/tmp/ws', ref: (args && args.ref) || (args && args.allRefs === true ? '' : longBranch), currentBranch: longBranch, commits: graphCommits, rows: [], lanes: 1 })
  }
  return wideSavedCall(method, args)
}
fibers.clear()
const wideTree = await openPanel()
await wait(15)
const wideSettled = await settle('pop')
host.call = wideSavedCall
const wideSelects = byClass(wideSettled, 'dsh-git-lf-select')
const wideW = Number(String(wideSelects[0].props.style.width).replace('px', ''))
console.log('  长分支名下:', wideW + 'px  title:', JSON.stringify(wideSelects[0].props.title))
ok('长分支名撑破 132（旧上限装不下它）', wideW > 132)
ok('但仍在分支自己的 300 之内', wideW <= 300)
ok('select 的 title 是完整分支名（关着也能悬停读全名）', wideSelects[0].props.title === longBranch)
ok('作者/时间在这里仍是 132 封顶', wideSelects.slice(1)
  .every((s) => Number(String(s.props.style.width).replace('px', '')) <= 132))
/* 重挂过后 t 必须跟着换新树：旧树上的 handler 还攥着旧 fiber 的 setter，
   对它触发事件只会把状态写进一棵已经没人渲染的死树。 */
fibers.clear()
t = await openLog()

console.log('')
console.log('== 面板头部：不再有第二个「仓库路径」输入框 ==')
/* 看哪个仓库不是面板的偏好设置，而是会话工作区本身，Host 从会话里取。
   头部再放一个预填着同一个路径的框 + 「应用」，就是把同一件事问两遍。 */
const panelTop = byClass(t, 'dsh-git-top')[0]
console.log('  头部文本:', JSON.stringify(textOf(panelTop)))
ok('头部没有仓库路径框了', byClass(t, 'dsh-git-repo-path').length === 0)
ok('可清除框的那个变体类也一起没了', byClass(t, 'dsh-git-clearable-path').length === 0)
ok('头部一个输入框都不剩', inputs(panelTop).length === 0)
ok('也没有那个「应用」按钮', buttons(panelTop).every((b) => textOf(b) !== '应用'))

console.log('')
console.log('== 提交信息框：也能一键清空 ==')
byClass(t, 'dsh-git-tab')[0].props.onClick()
await wait(15)
t = await settle('pop')
const msgArea = () => collect(byClass(t, 'dsh-git-commitpane')[0]).find((n) => n.type === 'textarea')
ok('提交信息是多行的可清除框', byClass(t, 'dsh-git-clearable-area').length === 1)
ok('空的时候没有 ×', byClass(byClass(t, 'dsh-git-clearable-area')[0], 'dsh-git-clear-x').length === 0)
msgArea().props.onChange({ target: { value: 'fix: something' } })
await wait(5)
t = await settle('pop')
const msgX = byClass(byClass(t, 'dsh-git-clearable-area')[0], 'dsh-git-clear-x')[0]
ok('写了提交信息就出现 ×', msgX !== undefined)
msgX.props.onClick({ stopPropagation() {} })
await wait(5)
t = await settle('pop')
ok('点 × 清空了提交信息', msgArea().props.value === '')

console.log('')
console.log('== 初次打开：不预选任何提交 ==')
/* 全新挂载一次，模拟「刚打开弹层」 */
fibers.clear()
calls.length = 0
let fresh = await openPanel()
fresh = await settle('pop')
const crowSel = () => byClass(fresh, 'dsh-git-crow-sel')
ok('打开后一行提交都没有被选中', crowSel().length === 0)
ok('也没有替用户去读提交详情', calls.filter((c) => c.method === 'git/commit-detail').length === 0)
ok('右栏是空态「选择一个提交」', textOf(byClass(fresh, 'dsh-git-detail')[0]).indexOf('选择一个提交') >= 0)
ok('没有选中时也没有任何常驻的提交操作键（它们住进了右键菜单，菜单要右键才开）',
  byClass(fresh, 'dsh-git-tool-ico').length === 0 && byClass(fresh, 'dsh-git-menu').length === 0)
ok('列表本身有内容（不是没读到）', byClass(fresh, 'dsh-git-crow').length === 3)

console.log('')
console.log('== 点一行才选中，并去读它的详情 ==')
calls.length = 0
byClass(fresh, 'dsh-git-crow')[1].props.onClick()
await wait(15)
fresh = await settle('pop')
ok('点的那一行被选中', crowSel().length === 1 && textOf(crowSel()[0]).indexOf('second commit') >= 0)
ok('只为点的那一行读详情', calls.filter((c) => c.method === 'git/commit-detail').map((c) => c.args.hash).join(',') === 'bbb222')
ok('右栏换成了那个提交', textOf(byClass(fresh, 'dsh-git-detail')[0]).indexOf('detail subject') >= 0)
/* 解禁的判定跟着选中走：对刚选中的那行右键，菜单四项就是可用的 */
byClass(fresh, 'dsh-git-crow')[1].props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 11, clientY: 12 })
await wait(15)
fresh = await settle('pop')
const selMenuItems = buttons(byClass(fresh, 'dsh-git-menu')[0])
ok('选中后右键：菜单四项全部可用', selMenuItems.length === 4 && selMenuItems.every((b) => b.props.disabled !== true))
fakeDoc.fire('keydown', { key: 'Escape', target: OUTSIDE })
await wait(15)
fresh = await settle('pop')

console.log('')
console.log('== 重新读历史：选中的还在就保留，不在了就清空 ==')
byClass(fresh, 'dsh-git-lf-select')[1].props.onChange({ target: { value: 'mays@example.com' } })
await wait(15)
fresh = await settle('pop')
ok('筛选导致重读后，选中的提交还在', crowSel().length === 1 && textOf(crowSel()[0]).indexOf('second commit') >= 0)
graphCommits = graphCommits.filter((c) => c.hash !== 'bbb222')
byClass(fresh, 'dsh-git-lf-select')[1].props.onChange({ target: { value: '' } })
await wait(15)
fresh = await settle('pop')
ok('选中那行被筛掉后，没有自动改选别的', crowSel().length === 0)
ok('右栏回到空态', textOf(byClass(fresh, 'dsh-git-detail')[0]).indexOf('选择一个提交') >= 0)

console.log('')
console.log('== 悬浮与选中：谁的底色说了算 ==')

/* 行是同一个元素：`.dsh-git-crow` 管悬停、`.dsh-git-crow-sel` 管选中，两条规则的
   权重一样（一个类 + 一个伪类），所以谁写在后面谁赢。选中之后再悬浮上去，选中色
   被悬停色顶掉，看起来就像「选中没了」。这里按级联规则算出真正的胜者，而不是只
   看某条规则在不在 —— 写反了顺序也算得出来。 */
const cssFrom = sourceCss.indexOf('.dsh-git-chip{')
const cssText = cssFrom < 0 ? '' : sourceCss.slice(cssFrom, sourceCss.indexOf('`', cssFrom))
ok('拿到了样式表本身', cssText.indexOf('.dsh-git-crow{') > 0)

function cssRules(raw) {
  /* 注释先去掉：它夹在两条规则之间，会被当成选择器的一部分（浏览器不会，
     这里会），结果就是把规则整条跳过 —— 那正是「假绿」的来源。 */
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css)) !== null) out.push({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] })
  return out
}
function cssTokens(selector) {
  return selector.match(/^[a-z]+|\.[A-Za-z0-9_-]+|::?[a-z-]+/g) || []
}
function cssApplies(selector, classes, hovered) {
  if (/[\s>+~]/.test(selector)) return false
  const tokens = cssTokens(selector)
  if (tokens.length === 0) return false
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.charAt(0) === '.') { if (classes.indexOf(token.slice(1)) < 0) return false }
    else if (token === ':hover') { if (hovered !== true) return false }
    else if (token.charAt(0) === ':') return false
  }
  return true
}
/* 同级里后面的赢，和浏览器一样 */
function cssWinner(css, classes, hovered, property) {
  const rules = cssRules(css)
  let best = null
  for (let i = 0; i < rules.length; i += 1) {
    for (let k = 0; k < rules[i].selectors.length; k += 1) {
      const selector = rules[i].selectors[k]
      if (cssApplies(selector, classes, hovered) !== true) continue
      const decl = rules[i].body.split(';').map((d) => d.trim()).find((d) => d.indexOf(property + ':') === 0)
      if (decl === undefined) continue
      /* 一个类 = 一个伪类 = 一级权重（元素名不算）：所以 hover 那条本来就比
         单纯的 `-sel` 权重高 —— 必须如实算，否则两条都算成 1，靠「后面的赢」
         也能碰巧算对，测出来的就是假的。 */
      const weight = cssTokens(selector).filter((t) => t.charAt(0) === '.' || t.charAt(0) === ':').length
      if (best === null || weight >= best.weight) best = { weight: weight, value: decl.slice(property.length + 1), selector: selector }
    }
  }
  return best
}
const CROW = ['dsh-git-crow']
const CROW_SEL = ['dsh-git-crow', 'dsh-git-crow-sel']
const bg = (classes, hovered) => { const w = cssWinner(cssText, classes, hovered, 'background'); return w === null ? '' : w.value + '   ← ' + w.selector }
console.log('  选中行悬浮:', bg(CROW_SEL, true))
console.log('  选中行静止:', bg(CROW_SEL, false))
console.log('  普通行悬浮:', bg(CROW, true))
ok('选中的行悬浮上去仍然是选中色（悬停色顶不掉它）',
  bg(CROW_SEL, true).indexOf('--dsw-alias-interactive-bg-hover') >= 0)
ok('没悬浮的时候选中行也是选中色', bg(CROW_SEL, false).indexOf('--dsw-alias-interactive-bg-hover') >= 0)
ok('没选中的行悬浮上去还是有悬停色', bg(CROW, true).indexOf('--dsw-alias-bg-layer-2') >= 0)
ok('左侧分支树的行一直是这个规矩（对照）',
  bg(['dsh-git-trow', 'dsh-git-trow-sel'], true).indexOf('--dsw-alias-interactive-bg-hover') >= 0)

/* 切换时图标转圈：只转不改尺寸，所以没有任何布局位移 */
console.log('  转圈的规则:', (cssText.match(/@keyframes dsh-git-spin\{[^}]*\}/) || [''])[0])
ok('转圈是一条 @keyframes 动画，不是靠改尺寸或位置',
  /@keyframes dsh-git-spin\{/.test(cssText) && /\.dsh-git-spin\{[^}]*animation:dsh-git-spin/.test(cssText))

console.log('')
console.log('== 提交行右键：先按单选同一条路选中，再开光标处的菜单 ==')
/* 前面的「重新读历史」段把 graphCommits 永久筛掉过一条（模块级变量）；这里恢复
   原始三条再挂，crow 的下标（bbb222 在第二行）才是段落里写死的那些。 */
graphCommits = [
  { hash: 'aaa111', subject: 'tip commit', author: 'mays', date: '2026-09-16', committedAt: nowSec - 60, refs: ['HEAD -> dev'] },
  { hash: 'bbb222', subject: 'second commit', author: 'mays', date: '2026-09-15', committedAt: nowSec - 3600, refs: [] },
  { hash: 'ccc333', subject: 'third commit', author: 'jiangzx', date: '2026-09-14', committedAt: nowSec - 7200, refs: [] },
]
fibers.clear()
t = await openLog()
const ctxMenus = () => byClass(t, 'dsh-git-menu')
const ctxItems = () => { const m = ctxMenus()[0]; return m === undefined ? [] : buttons(m) }
const rightClickCrow = async (i, x, y) => {
  byClass(t, 'dsh-git-crow')[i].props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: x, clientY: y })
  await wait(15)
  t = await settle('pop')
}
calls.length = 0
await rightClickCrow(1, 123, 45)
console.log('  菜单项:', JSON.stringify(ctxItems().map((b) => textOf(b))))
ok('右键先选中那一行（左键单选同一条 openCommit 路）', byClass(t, 'dsh-git-crow-sel').length === 1
  && textOf(byClass(t, 'dsh-git-crow-sel')[0]).indexOf('second commit') >= 0)
ok('只为它读了一次详情', calls.filter((c) => c.method === 'git/commit-detail').map((c) => c.args.hash).join(',') === 'bbb222')
ok('菜单开在光标坐标（position:fixed，left/top = clientX/clientY）', ctxMenus().length === 1
  && ctxMenus()[0].props.style.position === 'fixed'
  && ctxMenus()[0].props.style.left === '123px' && ctxMenus()[0].props.style.top === '45px')
ok('四项：拣选 / 还原 / 打标签… / 从这个提交新建分支…', ctxItems().length === 4
  && textOf(ctxItems()[0]) === '拣选' && textOf(ctxItems()[1]) === '还原'
  && textOf(ctxItems()[2]) === '打标签…' && textOf(ctxItems()[3]) === '从这个提交新建分支…')
ok('title 沿用原工具条四个键的文案',
  ['拣选：cherry-pick，把这个提交应用到当前分支', '还原：revert，生成一个反向提交来撤销它',
    '标签：在这个提交上打标签', '分支：从这个提交新建分支并切过去']
    .every((l, i) => String(ctxItems()[i].props.title) === l))
ok('四项都可用（右键即选中，!canAct 的置灰不出现）', ctxItems().every((b) => b.props.disabled !== true))

/* 菜单开着时仓库忙起来：!canAct 的另一条腿（busy）在这里才看得见 —— 头部 ⌛ fetch
   走 runOp 同步置忙，菜单不受影响地开着，四项跟着全部置灰。 */
const fetchBtn = byClass(t, 'dsh-git-tool').find((b) => String(b.props.title).indexOf('fetch：') === 0)
fetchBtn.props.onClick()
/* renderRoot 的第二个参数是 fiber 的路径前缀：必须照 popTree 用 'pop'，
   才会落在挂着的同一批 fiber 上读到 busy 帧；换个名字等于新挂一套。 */
const busyFrame = renderRoot(makeElement(popover, { sessionId: 's-1' }), 'pop')
const busyItems = buttons(byClass(busyFrame, 'dsh-git-menu')[0])
ok('busy 帧里四项全部置灰', busyItems.length === 4 && busyItems.every((b) => b.props.disabled === true))
await wait(15)
t = await settle('pop')

/* 动作目标 = 右键那一条（与多选无关） */
calls.length = 0
ctxItems()[0].props.onClick({ stopPropagation() {} })
await wait(15)
t = await settle('pop')
const pickCalls = calls.filter((c) => c.method === 'git/sequence')
ok('拣选把 cherry-pick 发给右键那一条（record 沿用插件配置）', pickCalls.length === 1
  && pickCalls[0].args.op === 'cherry-pick' && pickCalls[0].args.action === 'start'
  && pickCalls[0].args.target === 'bbb222' && pickCalls[0].args.record === false)
ok('点完动作菜单收起', ctxMenus().length === 0)
await rightClickCrow(1, 3, 4)
calls.length = 0
ctxItems()[1].props.onClick({ stopPropagation() {} })
await wait(15)
t = await settle('pop')
const revCalls = calls.filter((c) => c.method === 'git/sequence')
ok('还原把 revert 发给右键那一条', revCalls.length === 1
  && revCalls[0].args.op === 'revert' && revCalls[0].args.target === 'bbb222')

/* 打标签…：开的就是原来的内联输入行，可清除框的手感照旧 */
await rightClickCrow(0, 5, 6)
ctxItems()[2].props.onClick({ stopPropagation() {} })
await wait(15)
t = await settle('pop')
const promptInput = () => collect(byClass(t, 'dsh-git-prompt')[0]).find((n) => n.type === 'input')
ok('打标签… 打开了内联输入行', byClass(t, 'dsh-git-prompt').length === 1)
ok('空的时候没有 ×', byClass(byClass(t, 'dsh-git-prompt')[0], 'dsh-git-clear-x').length === 0)
promptInput().props.onChange({ target: { value: 'v1.0.0' } })
await wait(5)
t = await settle('pop')
const promptX = byClass(byClass(t, 'dsh-git-prompt')[0], 'dsh-git-clear-x')[0]
ok('输入后出现 ×', promptX !== undefined)
promptX.props.onClick({ stopPropagation() {} })
await wait(5)
t = await settle('pop')
ok('点 × 清空了标签名', promptInput().props.value === '')

/* 从这个提交新建分支…：同一扇门，输入行换成分支的 */
await rightClickCrow(0, 5, 6)
ctxItems()[3].props.onClick({ stopPropagation() {} })
await wait(15)
t = await settle('pop')
ok('从这个提交新建分支… 打开的是分支的输入行', byClass(t, 'dsh-git-prompt').length === 1
  && promptInput().props.placeholder === '例如 feature/login')
promptInput().props.onKeyDown({ key: 'Escape', preventDefault() {} })
await wait(10)
t = await settle('pop')
ok('Escape 收起输入行', byClass(t, 'dsh-git-prompt').length === 0)

console.log('')
console.log('== 右键菜单的开合与多选 ==')
/* Ctrl+点击两行进多选（行左缘出强调条），再右键第三行：单选切过去，多选一个不动，
   菜单的动作也只对右键那一条。 */
byClass(t, 'dsh-git-crow')[0].props.onClick({ ctrlKey: true })
await wait(10)
t = await settle('pop')
byClass(t, 'dsh-git-crow')[1].props.onClick({ ctrlKey: true })
await wait(10)
t = await settle('pop')
const multiRows = (tree) => byClass(tree, 'dsh-git-crow-multi')
ok('Ctrl+点击两行进了多选（两行都带多选强调条）', multiRows(t).length === 2)
await rightClickCrow(2, 9, 9)
ok('右键第三行：单选切到它', byClass(t, 'dsh-git-crow-sel').length === 1
  && textOf(byClass(t, 'dsh-git-crow-sel')[0]).indexOf('third commit') >= 0)
ok('多选还是两行（Ctrl 多选不被右键清掉）', multiRows(t).length === 2)
calls.length = 0
ctxItems()[0].props.onClick({ stopPropagation() {} })
await wait(15)
t = await settle('pop')
const thirdPick = calls.filter((c) => c.method === 'git/sequence')
ok('拣选的目标是右键那一条（ccc333），不是多选里的任何一条', thirdPick.length === 1
  && thirdPick[0].args.target === 'ccc333')

/* Escape 与滚动都收走菜单 */
await rightClickCrow(0, 3, 4)
ok('菜单又开了', ctxMenus().length === 1)
fakeDoc.fire('keydown', { key: 'Escape', target: OUTSIDE })
await wait(15)
t = await settle('pop')
ok('Escape 收走菜单', ctxMenus().length === 0)
await rightClickCrow(0, 3, 4)
fakeDoc.fire('scroll', { target: OUTSIDE })
await wait(15)
t = await settle('pop')
ok('滚动收走菜单（菜单自己内部的滚动不算）', ctxMenus().length === 0)

/* ── 分支行的右键菜单 ──

   本地 = 签出 → 新建分支… → 推送 → 重命名分支… → 分隔线 → 复制分支名称 →
   修改跟踪分支… → 分隔线 → 删除分支（两段式确认，-d 被拒才给 -D）；远程 = 签出
   （检出为本地分支）+ 分隔线 + 复制（远端分支没有「跟踪谁 / 重命名」这些本地才有
   的事，新项与删除都不给）；HEAD 组的行也是分支行，它就是当前分支，删除项与签出
   都由面板置灰。菜单项一律按文案找：按钮下标会随菜单加项漂移，按文字定位才钉得住
   「点的是删除」。夹具里放一个 release/one，顺手看一眼含 / 的分支按目录折叠。 */
console.log('')
console.log('== 分支行右键：本地=签出/新建/推送/重命名+复制+删除（两段式），远程=签出+复制 ==')
const brSavedCall = host.call
const branchRefs = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [{ segments: ['stable'], data: 'stable' }, { segments: ['main'], data: 'main' }, { segments: ['feature'], data: 'feature' }, { segments: ['release', 'one'], data: 'release/one' }],
  remote: [{ name: 'origin', refs: [{ segments: ['origin', 'ro'], data: 'origin/ro' }] }],
}
host.call = function (method, args) {
  if (method === 'git/refs') return Promise.resolve(branchRefs)
  return brSavedCall(method, args)
}
fibers.clear()
let brTree = await openPanel()
await wait(15)
brTree = await settle('pop')
/* 分组折叠：release/one 归到目录行 release 底下，叶子行只显示末段名，全名在
   title 里（treeDirRow / 叶子行的画法见 50-log.js 的 section）。 */
const brDirRow = trowWith(brTree, 'release')
const brLeafRow = trowWith(brTree, 'one')
ok('含 / 的分支按目录折叠：release/one 挂在 release 目录行下，叶子行只显示末段名',
  brDirRow !== undefined && brLeafRow !== undefined
  && byClass(brDirRow, 'dsh-git-tdim')[0] !== undefined
  && textOf(byClass(brDirRow, 'dsh-git-tdim')[0]) === '1'
  && String(brLeafRow.props.title).indexOf('release/one（双击只看这个分支的历史）') === 0)
const openBranchCtx = async (label) => {
  /* squeeze 过的远程行（origin/ro）文本只剩末段 'ro'，全名在 title 里 —— 文本找
     不到就按 title 的「全名（双击…」前缀找。 */
  let row = trowWith(brTree, label)
  if (row === undefined) {
    row = byClass(brTree, 'dsh-git-trow').find((r) => String(r.props.title).indexOf(label + '（') === 0)
  }
  if (row === undefined) throw new Error('找不到分支行 ' + label)
  row.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 20, clientY: 30 })
  await wait(15)
  brTree = await settle('pop')
}
/* HEAD 组的行（★main）：当前分支 —— 动作四件套在前，复制/跟踪居中，删除在最后但置灰 */
await openBranchCtx('★main')
let brMenu = byClass(brTree, 'dsh-git-menu')[0]
let brItems = brMenu === undefined ? [] : buttons(brMenu)
const brItem = (label) => brItems.find((b) => textOf(b) === label)
ok('HEAD 组的行也是分支行：签出/新建分支…/推送/重命名分支…/复制分支名称/修改跟踪分支…/删除分支 依序都在',
  brItems.length === 7
  && brItems.map(textOf).join('|') === '签出|新建分支…|推送|重命名分支…|复制分支名称|修改跟踪分支…|删除分支')
ok('本地菜单的动作四件套都在，当前分支的「签出」置灰（title 说已经在这个分支上）',
  ['签出', '新建分支…', '推送', '重命名分支…'].every((l) => brItem(l) !== undefined)
  && brItem('签出').props.disabled === true
  && String(brItem('签出').props.title).indexOf('已经在这个分支上') >= 0)
ok('当前分支的删除项置灰（title 说 git 不删除自己）', brItem('删除分支') !== undefined
  && brItem('删除分支').props.disabled === true
  && String(brItem('删除分支').props.title).indexOf('不删除自己') >= 0)
/* 新项的位置仍用子元素顺序钉死，但下标按文案找（菜单加项下标会漂）：动作组之后
   一条分隔线 → 复制分支名称 → 修改跟踪分支… 紧挨着 → 再一条分隔线隔开删除。 */
const brKids = brMenu === undefined ? [] : (Array.isArray(brMenu.props.children) ? brMenu.props.children : [brMenu.props.children])
const brKidIndex = (label) => brKids.findIndex((k) => k != null && k.props !== undefined && textOf(k) === label)
const brKidClass = (i) => (brKids[i] == null || brKids[i].props === undefined || typeof brKids[i].props.className !== 'string' ? '' : brKids[i].props.className)
const brCopyIdx = brKidIndex('复制分支名称')
const brUpIdx = brKidIndex('修改跟踪分支…')
ok('修改跟踪分支… 在「复制分支名称」之后、分隔线之前',
  brCopyIdx >= 0 && brUpIdx === brCopyIdx + 1
  && brKidClass(brUpIdx + 1).indexOf('dsh-git-menu-sep') >= 0)
ok('复制和删除之间有分隔线（动作组后一条、删除前一条，共 2 条）', byClass(brMenu, 'dsh-git-menu-sep').length === 2
  && brKidClass(brCopyIdx - 1).indexOf('dsh-git-menu-sep') >= 0)
brItem('复制分支名称').props.onClick({ stopPropagation() {} })
await wait(15)
brTree = await settle('pop')
ok('右键复制同样落到提示条（菜单收起）', textOf(byClass(brTree, 'dsh-git-oknote')[0]).indexOf('请手动复制分支名：main') >= 0
  && byClass(brTree, 'dsh-git-menu').length === 0)

/* 普通本地分支：两段式删除，第二段才发 -d */
await openBranchCtx('stable')
brItems = buttons(byClass(brTree, 'dsh-git-menu')[0])
ok('普通本地分支的删除项可用', brItems.length === 7 && brItem('删除分支') !== undefined
  && brItem('删除分支').props.disabled !== true)
const armMark = calls.length
brItem('删除分支').props.onClick({ stopPropagation() {} })
await wait(15)
brTree = await settle('pop')
const armItems = buttons(byClass(brTree, 'dsh-git-menu')[0])
ok('第一段只武装：按钮换成「确认删除 stable」，rpc 还没发', armItems.length === 7
  && armItems.find((b) => textOf(b) === '确认删除 stable') !== undefined
  && calls.slice(armMark).every((c) => c.method !== 'git/branch-delete'))
const delMark = calls.length
armItems.find((b) => textOf(b) === '确认删除 stable').props.onClick({ stopPropagation() {} })
await wait(20)
brTree = await settle('pop')
const delCalls = calls.slice(delMark).filter((c) => c.method === 'git/branch-delete')
ok('第二段才发 git/branch-delete（-d，不带 force）', delCalls.length === 1
  && delCalls[0].args.name === 'stable' && delCalls[0].args.force !== true)
ok('删完菜单收起，提示条说了删了哪个', byClass(brTree, 'dsh-git-menu').length === 0
  && textOf(byClass(brTree, 'dsh-git-oknote')[0]).indexOf('已删除分支 stable') >= 0)

/* -d 被拒（not fully merged）才给 -D，-D 自己也要再确认一次 */
host.call = function (method, args) {
  if (method === 'git/branch-delete') {
    calls.push({ method: method, args: args })
    /* git 的原话在 stderr 里（commandDetail 只读 stderr/stdout），-d 的拒绝是这句 */
    if (args.force !== true) return Promise.resolve({ ok: false, stderr: "error: Unable to delete branch 'feature': not fully merged", exitCode: 1 })
    return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
  }
  if (method === 'git/refs') return Promise.resolve(branchRefs)
  return brSavedCall(method, args)
}
await openBranchCtx('feature')
brItems = buttons(byClass(brTree, 'dsh-git-menu')[0])
brItem('删除分支').props.onClick({ stopPropagation() {} })
await wait(15)
brTree = await settle('pop')
buttons(byClass(brTree, 'dsh-git-menu')[0]).find((b) => textOf(b) === '确认删除 feature').props.onClick({ stopPropagation() {} })
await wait(20)
brTree = await settle('pop')
const forceItems = buttons(byClass(brTree, 'dsh-git-menu')[0])
ok('-d 被拒（not fully merged）：菜单里出现「强制删除（-D）」，错误条说了原因',
  forceItems.length === 7 && forceItems.find((b) => textOf(b) === '强制删除（-D）') !== undefined
  && textOf(byClass(brTree, 'dsh-git-error')[0]).indexOf('还没有合并到别处') >= 0)
forceItems.find((b) => textOf(b) === '强制删除（-D）').props.onClick({ stopPropagation() {} })
await wait(15)
brTree = await settle('pop')
const armForceItems = buttons(byClass(brTree, 'dsh-git-menu')[0])
ok('-D 也要再确认一次（按钮换成「确认强制删除 feature」）', armForceItems.length === 7
  && armForceItems.find((b) => textOf(b) === '确认强制删除 feature') !== undefined)
armForceItems.find((b) => textOf(b) === '确认强制删除 feature').props.onClick({ stopPropagation() {} })
await wait(20)
brTree = await settle('pop')
const forceCalls = calls.filter((c) => c.method === 'git/branch-delete' && c.args.force === true)
ok('第二段发的是 -D（force:true），成功条带「强制 -D」', forceCalls.length === 1
  && forceCalls[0].args.name === 'feature'
  && textOf(byClass(brTree, 'dsh-git-oknote')[0]).indexOf('强制 -D') >= 0
  && byClass(brTree, 'dsh-git-menu').length === 0)
/* 远程段还要 branchRefs 这份 refs（branch-delete 恢复成放行），测完再整体还原 */
host.call = function (method, args) {
  if (method === 'git/refs') return Promise.resolve(branchRefs)
  return brSavedCall(method, args)
}

/* 远程分支行：只有「签出（检出为本地分支）」+ 分隔线 + 「复制分支名称」—— 没有修
   改跟踪分支…，也没有删除（远端分支没有「跟踪谁 / 重命名」这些本地才有的事） */
fibers.clear()
brTree = await openPanel()
await wait(15)
brTree = await settle('pop')
await openBranchCtx('origin/ro')
const roMenu = byClass(brTree, 'dsh-git-menu')[0]
const roItems = roMenu === undefined ? [] : buttons(roMenu)
ok('远程分支行只有「签出（检出为本地分支）」+分隔线+「复制分支名称」（没有修改跟踪分支…、没有删除）',
  roItems.length === 2 && roItems.map(textOf).join('|') === '签出（检出为本地分支）|复制分支名称'
  && byClass(roMenu, 'dsh-git-menu-sep').length === 1
  && roItems.every((b) => textOf(b).indexOf('修改跟踪分支') < 0 && textOf(b).indexOf('删除') < 0))
roItems.find((b) => textOf(b) === '复制分支名称').props.onClick({ stopPropagation() {} })
await wait(15)
brTree = await settle('pop')
ok('远程行的复制也落提示条', textOf(byClass(brTree, 'dsh-git-oknote')[0]).indexOf('请手动复制分支名：origin/ro') >= 0)
host.call = brSavedCall
/* 同样把 t 换回活树（fibers 被这几段重挂过），说明页那一段还接着用 t */
fibers.clear()
t = await openLog()

/* ── 清空按钮还活着，只是搬到了唯一还需要它的地方 ──

   头部那个路径框删掉之后，「一个框 + 里面的 ×」只剩说明页在用：路径没能确定
   的时候才需要人填，填错了要能一键清掉。这一段单独放在最后，因为它会把面板
   换成「路径没定」的说明页，后面的段落不能再借用这棵树。 */
console.log('')
console.log('== 说明页上的框仍然一键清空 ==')
const beforeSetupRead = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    return Promise.resolve({
      ok: false, repo: '', error: 'no-session-repo', reason: 'no-path',
      stderr: '', exitCode: 1, staged: [], unstaged: [], untracked: [], unmerged: [],
    })
  }
  return beforeSetupRead(method, args)
}
/* 标签必须和别的段落一样是 'pop'：harness 把根路径也算进 fiber 的键，
   换个标签等于整棵树重新挂载，框里的草稿就没了。面板已经在读一个正常仓库，
   所以先按一下「重新读取」（它会忽略缓存重读，于是读到下面这个 stub）。 */
const refreshBtn = byClass(t, 'dsh-git-tool').filter((b) => String(b.props.title).indexOf('重新读取仓库') === 0)[0]
refreshBtn.props.onClick()
await wait(15)
const setupTree = await settle('pop')
const setupBox = byClass(setupTree, 'dsh-git-clearable')[0]
console.log('  说明页标题:', textOf(byClass(setupTree, 'dsh-git-setup-h')[0]))
ok('路径没定时用的是可清除的框', setupBox !== undefined && inputs(setupBox).length === 1)
ok('空的时候不显示 ×', byClass(setupBox, 'dsh-git-clear-x').length === 0)
inputs(setupBox)[0].props.onChange({ target: { value: '/tmp/other' } })
await wait(5)
const filledTree = await settle('pop')
const filledX = byClass(byClass(filledTree, 'dsh-git-clearable')[0], 'dsh-git-clear-x')[0]
ok('填了内容就出现 ×', filledX !== undefined)
filledX.props.onClick({ stopPropagation() {} })
await wait(5)
const clearedTree = await settle('pop')
ok('点 × 清空了框', inputs(byClass(clearedTree, 'dsh-git-clearable')[0])[0].props.value === '')
host.call = beforeSetupRead


/* ── 图形：虚线，和画到页外的那条线 ──

   过滤后的图形由 Host 按真实 DAG 排（见 Host 那一半的 layoutVisible）：边连到最近
   的**可见**祖先，中间隔着被筛掉的提交时标成虚线；连不到可见祖先的边，画面要把它
   画到**画出来的最后一行底下**，而不是在圆点下面一行就断（以前就是那样，一整屏
   匹配看过去像一排棒棒糖）。这一节把三件事钉在线的形状上：实线没有 dash、虚线有
   dash、离开这一页的线一直画到底。 */
console.log('')
console.log('== 图形：虚线 = 中间有看不见的提交 ==')
const graphSavedCall = host.call
const dashCommits = [
  { hash: 'd1', subject: 'newest match', author: 'mays', date: '2026-09-16', committedAt: nowSec - 10, refs: [] },
  { hash: 'd2', subject: 'second match', author: 'mays', date: '2026-09-15', committedAt: nowSec - 20, refs: [] },
  { hash: 'd3', subject: 'third match', author: 'mays', date: '2026-09-14', committedAt: nowSec - 30, refs: [] },
  { hash: 'd4', subject: 'fourth match', author: 'mays', date: '2026-09-13', committedAt: nowSec - 40, refs: [] },
]
const dashRows = [
  { lane: 0, edges: [{ hash: 'd2', lane: 0 }] },
  { lane: 0, edges: [{ hash: 'd4', lane: 1, dashed: true }] },
  { lane: 1, edges: [{ hash: 'gone', lane: 1, dashed: true }] },
  { lane: 1, edges: [] },
]
host.call = function (method, args) {
  if (method === 'git/graph') {
    return Promise.resolve({ ok: true, repo: '/tmp/ws', ref: 'main', currentBranch: 'main', commits: dashCommits, rows: dashRows, lanes: 2, hasMore: false })
  }
  return graphSavedCall(method, args)
}
graphCommits = dashCommits
/* 上一节把面板留在了「不是仓库」的说明页上，所以这里重新挂载一次；mock 先装好，
   挂载时那一次读拿到的就是上面这份带 rows 的回答。 */
fibers.clear()
fresh = await openPanel()
await wait(15)
fresh = await settle('pop')
host.call = graphSavedCall

const graphSvg = byClass(fresh, 'dsh-git-graph')[0]
const gpaths = graphSvg === undefined ? [] : graphSvg.props.children.filter((n) => n.type === 'path')
const gcircles = graphSvg === undefined ? [] : graphSvg.props.children.filter((n) => n.type === 'circle')
const dOf = (i) => (gpaths[i] === undefined ? '' : String(gpaths[i].props.d))
ok('四条匹配画四个点', gcircles.length === 4)
ok('三条边画三条线', gpaths.length === 3)
ok('相邻的可见父提交：实线（没有 dash）', gpaths[0] !== undefined && gpaths[0].props.strokeDasharray === undefined)
ok('中间藏着看不见的提交：虚线', gpaths[1] !== undefined && gpaths[1].props.strokeDasharray === '3 3')
ok('虚线的弯从自己的道走到父提交那条道（x 10 → 24）',
  dOf(1).indexOf('M 10 ') === 0 && dOf(1).indexOf('24 ') > 0)
ok('连不到可见祖先的边也是虚线', gpaths[2] !== undefined && gpaths[2].props.strokeDasharray === '3 3')
/* 行高 26：最后一行的圆心在 y=91，行底是 117。老写法会停在 91（自己下面一行）。 */
ok('离开这一页的线一直画到画出来的最后一行底下（y=117，而不是 91）',
  dOf(2).indexOf('M 24 65') === 0 && dOf(2).slice(-4) === ' 117')

/* ── 一个提交都还没有的仓库（刚 init） ──
   `git log <branch>` 在这里必然失败，但历史是空的，不是读不动 —— 宿主现在直接回
   `ok:true, unborn:true, commits:[]`（见 gp34a 那段）。客户端要是把它说成「没有匹配的
   提交」，人就会去清筛选，而屏幕上一个筛选都没开。 */
const unbornSaved = host.call
const unbornPanel = async (graph) => {
  host.call = function (method, args) {
    if (method === 'git/graph') return Promise.resolve(Object.assign({ ok: true, repo: '/tmp/ws', ref: 'main', currentBranch: 'main', rows: [], lanes: 1, hasMore: false }, graph))
    return unbornSaved(method, args)
  }
  fibers.clear()
  fresh = await openPanel()
  await wait(15)
  const tree = await settle('pop')
  host.call = unbornSaved
  return byClass(tree, 'dsh-git-pane').map(textOf).join(' | ')
}
const unbornText = await unbornPanel({ unborn: true, commits: [] })
console.log('  还没有提交时:', JSON.stringify(unbornText))
ok('还没有提交时说的是「这个仓库还没有提交」', unbornText.indexOf('这个仓库还没有提交') >= 0)
ok('不说成「没有匹配的提交」（那会让人去清一个没开的筛选）', unbornText.indexOf('没有匹配') < 0)
/* 负对照：真的是筛选没匹配到时，句子还得是原来那句 */
const filteredText = await unbornPanel({ commits: [] })
console.log('  筛完没匹配时:', JSON.stringify(filteredText))
ok('（对照）筛选没匹配到仍然是「没有匹配的提交」',
  filteredText.indexOf('没有匹配的提交') >= 0 && filteredText.indexOf('还没有提交') < 0)
