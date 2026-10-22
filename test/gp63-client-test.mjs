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
/* ═══ gp63：worktree 的目录映射（客户端这一半）═══
 *
 * 宿主半侧在 gp63-host-test.mjs（清洗矩阵、识别链路的前缀替换）。这里钉浏览器
 * 这一半的三个面：
 *   1. 配置页「全局配置」多出的 worktree 组：组头、说明文案（虚拟机挂载的类比、
 *      前缀匹配替换、D:/ 与 D:\ 两种写法）与「目录映射」编辑器都在；初始两条
 *      映射画成「原目录 → 替换目录」两列行（类名 dsh-git-wdm-*，不进 qc 的账）。
 *   2. 编辑器交互（QuickCommandsEditor 同一副骨架）：编辑一条（两个输入框预填、
 *      保存走整份插件配置、id 保留）、新增（空着保存被拦「原目录和替换目录都要
 *      填」、填齐才落）、删除两段式（第一次换成「确认删除」不写、第二次才写），
 *      每次保存经 400ms 去抖发 git/config-save、答复 adopt 后列表换新账。
 *   3. 20-prefs.js：整份插件配置归一化原样搬运 worktreeDirMappings —— 配置页改
 *      一个开关触发的整份保存必须把它一字不改地送回（worktreeMains/gp61、
 *      appliedRepos/gp62 同一批对照）。
 * mock：git/config 带两条初始映射；git/config-save 记账并原样回声（与宿主的
 * 「答复带清洗后的整份配置」同一形状）。 */

/* ── mock：git/config 罐头；config-save 记账 + 回声 ── */
const MAPPINGS63 = [
  { id: 'wdm-a', from: 'D:/code/www/gs/zuodian', to: '/code/www/gs/zuodian' },
  { id: 'wdm-b', from: 'E:\\work\\lab', to: '/code/www/lab' },
]
const CONFIG63 = {
  ok: true, path: '/home/u/.dsh/dsh-git-idea.json',
  config: {
    initBranch: 'main', cherryPickRecord: false,
    worktreeDirMappings: MAPPINGS63.slice(),
    drafts: { '/tmp/ws': '写到一半' },
  },
}
const configSaves63 = []
const realCall63 = host.call
host.call = function (method, args) {
  if (method === 'git/config') return Promise.resolve(CONFIG63)
  if (method === 'git/config-save') {
    const saved = args != null && args.config != null ? args.config : {}
    configSaves63.push(saved)
    return Promise.resolve({ ok: true, path: CONFIG63.path, config: saved })
  }
  return realCall63(method, args)
}

/* ── 取景工具 ── */
const saveConfig63 = function () { return configSaves63.length > 0 ? configSaves63[configSaves63.length - 1] : undefined }
const fireTimers63 = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}
const pop63 = () => renderUntilStable(makeElement(popover, { sessionId: 's-63' }), 'pop')
const wdmEditor63 = (t) => byClass(t, 'dsh-git-qc-box').find(function (box) {
  /* 列表态的标题是「目录映射（n/50）」、编辑态是「新建/编辑目录映射」—— 都认。 */
  const head = byClass(box, 'dsh-git-qc-head')[0]
  return head != null && textOf(head).indexOf('目录映射') >= 0
})
const wdmRows63 = (t) => { const box = wdmEditor63(t); return box == null ? [] : byClass(box, 'dsh-git-wdm-row') }
const wdmInputs63 = (box) => collect(box).filter(function (n) { return n.type === 'input' })
const btnIn63 = function (node, label) {
  return buttons(node).find(function (b) { return textOf(b) === label })
}

/* ── 1. 全局配置页的 worktree 组与编辑器 ── */
console.log('')
console.log('== 全局配置：worktree 组、说明文案与目录映射编辑器 ==')
let t63 = await openConfig('global', 'cfg-63')
const wdmGroup63 = collect(t63).find(function (n) {
  return n.props.className === 'dsh-git-set-group' && textOf(n) === 'worktree'
})
ok('「worktree」分组在（快捷命令之后、git 位置之前）', wdmGroup63 !== undefined)
const wdmHint63 = collect(t63).find(function (n) {
  return String(n.props.className).indexOf('dsh-git-set-hint') >= 0 && textOf(n).indexOf('虚拟机挂载的目录映射') >= 0
})
ok('说明文案讲到点子上：虚拟机挂载的类比、前缀匹配替换、D:/ 与 D:\\ 两种写法',
  wdmHint63 !== undefined && textOf(wdmHint63).indexOf('前缀匹配替换') >= 0
  && textOf(wdmHint63).indexOf('D:\\…') >= 0)
const editor63 = wdmEditor63(t63)
ok('「目录映射」编辑器在（qc-box 家族的盒子，计数的行是 wdm 自己的类名）',
  editor63 !== undefined && wdmRows63(t63).length === 2)
ok('标题带条数（2/50），行画成「原目录 → 替换目录」',
  textOf(byClass(editor63, 'dsh-git-qc-head')[0]).indexOf('目录映射（2/50）') === 0
  && textOf(wdmRows63(t63)[0]).indexOf('D:/code/www/gs/zuodian') >= 0
  && textOf(wdmRows63(t63)[0]).indexOf('→') >= 0
  && textOf(wdmRows63(t63)[0]).indexOf('/code/www/gs/zuodian') >= 0
  && textOf(wdmRows63(t63)[1]).indexOf('E:\\work\\lab') >= 0)
ok('快捷命令编辑器还在、各画各的行（qc 的行没被 wdm 混进来）',
  byClass(t63, 'dsh-git-qc-row').length === 0 && byClass(t63, 'dsh-git-wdm-row').length === 2)

/* ── 2. 编辑器交互：编辑 / 新增（含被拦）/ 删除两段式 ── */
console.log('')
console.log('== 编辑器：编辑一条（id 保留）→ 整份保存 → adopt 换新账 ==')
btnIn63(wdmRows63(t63)[0], '编辑').props.onClick()
t63 = await pop63()
let editing63 = wdmEditor63(t63)
let fields63 = wdmInputs63(editing63)
ok('编辑态：两个输入框预填这条映射的 from / to',
  fields63.length === 2 && fields63[0].props.value === 'D:/code/www/gs/zuodian'
  && fields63[1].props.value === '/code/www/gs/zuodian')
fields63[0].props.onChange({ target: { value: 'D:/code/www/gs/zuodian2' } })
t63 = await pop63()
btnIn63(wdmEditor63(t63), '保存').props.onClick()
t63 = await pop63()
await wait(10)
fireTimers63(400)
await wait(10)
t63 = await pop63()
const savedEdit63 = saveConfig63()
ok('保存走整份插件配置（400ms 去抖后 git/config-save）：改过的 from 落盘、id 保留、另一条不动',
  savedEdit63 != null && Array.isArray(savedEdit63.worktreeDirMappings)
  && savedEdit63.worktreeDirMappings[0].id === 'wdm-a'
  && savedEdit63.worktreeDirMappings[0].from === 'D:/code/www/gs/zuodian2'
  && JSON.stringify(savedEdit63.worktreeDirMappings[1]) === JSON.stringify(MAPPINGS63[1]))
ok('答复 adopt 后列表是新账（第一行的 from 已换）',
  wdmRows63(t63).length === 2 && textOf(wdmRows63(t63)[0]).indexOf('D:/code/www/gs/zuodian2') >= 0)
ok('同一次保存里草稿也还在（整份保存不抹别的键的既有先例不回归）',
  savedEdit63.drafts != null && savedEdit63.drafts['/tmp/ws'] === '写到一半')

console.log('')
console.log('== 编辑器：新增 —— 空着保存被拦，填齐才落；id 是新造的稳定串 ==')
const markSave63 = configSaves63.length
btnIn63(wdmEditor63(t63), '新增').props.onClick()
t63 = await pop63()
let creating63 = wdmEditor63(t63)
let newFields63 = wdmInputs63(creating63)
ok('新增态：两个输入框都是空的', newFields63.length === 2
  && newFields63[0].props.value === '' && newFields63[1].props.value === '')
newFields63[0].props.onChange({ target: { value: 'D:/x' } })
t63 = await pop63()
btnIn63(wdmEditor63(t63), '保存').props.onClick()
t63 = await pop63()
ok('只填了原目录：保存被拦（「原目录和替换目录都要填」），一次 git/config-save 都没发',
  wdmEditor63(t63) !== undefined
  && textOf(collect(wdmEditor63(t63)).find(function (n) { return String(n.props.className).indexOf('dsh-git-error') >= 0 })).indexOf('原目录和替换目录都要填') >= 0
  && configSaves63.length === markSave63)
const fillTo63 = wdmInputs63(wdmEditor63(t63))
fillTo63[1].props.onChange({ target: { value: '/code/x' } })
t63 = await pop63()
btnIn63(wdmEditor63(t63), '保存').props.onClick()
t63 = await pop63()
await wait(10)
fireTimers63(400)
await wait(10)
t63 = await pop63()
const savedNew63 = saveConfig63()
ok('填齐了才落：第三条进配置，新 id 是补造的稳定串（不是 undefined、不与旧 id 撞）',
  savedNew63 != null && savedNew63.worktreeDirMappings.length === 3
  && savedNew63.worktreeDirMappings[2].from === 'D:/x' && savedNew63.worktreeDirMappings[2].to === '/code/x'
  && typeof savedNew63.worktreeDirMappings[2].id === 'string' && savedNew63.worktreeDirMappings[2].id.length > 0
  && savedNew63.worktreeDirMappings[2].id !== 'wdm-a' && savedNew63.worktreeDirMappings[2].id !== 'wdm-b')
ok('列表跟着换新账（3/50，第三行是 D:/x → /code/x）',
  wdmRows63(t63).length === 3
  && textOf(byClass(wdmEditor63(t63), 'dsh-git-qc-head')[0]).indexOf('目录映射（3/50）') === 0
  && textOf(wdmRows63(t63)[2]).indexOf('D:/x') >= 0 && textOf(wdmRows63(t63)[2]).indexOf('/code/x') >= 0)

console.log('')
console.log('== 编辑器：删除两段式 —— 第一次只亮「确认删除」，第二次才写 ==')
const markDel63 = configSaves63.length
btnIn63(wdmRows63(t63)[1], '删除').props.onClick()
t63 = await pop63()
ok('第一次点：按钮换成「确认删除」，配置一个字节没写',
  textOf(btnIn63(wdmRows63(t63)[1], '确认删除')) === '确认删除' && configSaves63.length === markDel63)
btnIn63(wdmRows63(t63)[1], '确认删除').props.onClick()
t63 = await pop63()
await wait(10)
fireTimers63(400)
await wait(10)
t63 = await pop63()
const savedDel63 = saveConfig63()
ok('第二次点才写：那条没了（剩下 2 条，wdm-a 与新造的那条），去抖后落盘',
  savedDel63 != null && savedDel63.worktreeDirMappings.length === 2
  && savedDel63.worktreeDirMappings.some(function (m) { return m.id === 'wdm-a' })
  && savedDel63.worktreeDirMappings.some(function (m) { return m.from === 'D:/x' })
  && savedDel63.worktreeDirMappings.some(function (m) { return m.id === 'wdm-b' }) === false)
ok('列表同步（2 行）', wdmRows63(t63).length === 2)

/* ── 3. 20-prefs：整份归一化原样搬运 worktreeDirMappings ── */
console.log('')
console.log('== 20-prefs：整份归一化把 worktreeDirMappings 原样送回（一次整份保存）==')
const beforeFlip63 = saveConfig63().worktreeDirMappings
const cherryRow63 = collect(t63).find(function (n) {
  return n.type === 'label' && textOf(n).indexOf('cherry-pick 时记录来源') >= 0
})
const flip63 = cherryRow63 !== undefined ? collect(cherryRow63).find(function (n) {
  return n.type === 'input' && n.props.type === 'checkbox'
}) : undefined
ok('插件行为的开关找到了（cherry-pick 记录来源，初值来自 mock 配置的 false）',
  flip63 !== undefined && flip63.props.checked === false)
flip63.props.onChange({ target: { checked: true } })
await wait(10)
fireTimers63(400)
await wait(10)
const savedFlip63 = saveConfig63()
ok('开关触发的整份保存：worktreeDirMappings 一字不改地送回（「手工映射不再被抹」的口子）',
  savedFlip63 != null && JSON.stringify(savedFlip63.worktreeDirMappings) === JSON.stringify(beforeFlip63))
ok('同一次保存里草稿也还在、开关的值真的翻了',
  savedFlip63.drafts != null && savedFlip63.drafts['/tmp/ws'] === '写到一半'
  && savedFlip63.cherryPickRecord === true)
