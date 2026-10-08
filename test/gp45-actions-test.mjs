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
/* ── 变更页「默认变更列表」的工具条：客户端这一半 ──
 *
 * 盯五件事：
 *   1. 无勾选：三个按钮都在、都禁用、title 说「先勾选」，计数行说「已勾选 0 项」；
 *   2. 有勾选：可用，计数跟着勾选数走；「新增的文件」那组没有这排按钮；
 *   3. 添加：走的是勾框那同一条 git/stage 路，路径就是勾选的那几项；
 *   4. 还原：两段式 —— 第一次点只换红色「确认还原 n 项」，第二次才发 git/restore；
 *      武装之后勾选数变了，确认态自己退回；
 *   5. 多仓库：按钮长在哪个仓库的组里，请求就落在哪个仓库（repo 字段）。 */

let reply = {
  ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0,
  sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [],
}
const withWork = function (staged, unstaged, untracked) {
  return Object.assign({}, reply, { staged: staged, unstaged: unstaged, untracked: untracked })
}
/* 多仓库那一段：每个仓库一份自己的答复（按 args.repo 分发）。 */
let repoReplies = null
let reposReply = null
const realCall = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    if (repoReplies != null && args != null && repoReplies[args.repo] !== undefined) {
      return Promise.resolve(repoReplies[args.repo])
    }
    return Promise.resolve(reply)
  }
  if (method === 'git/repos') return Promise.resolve(reposReply)
  if (method === 'git/restore' || method === 'git/stash') {
    calls.push({ method: method, args: args })
    return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
  }
  return realCall(method, args)
}

const clickText = async function (tree, label) {
  const hit = buttons(tree).find((b) => textOf(b).indexOf(label) >= 0)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
}
const callsOf = function (mark, method) { return calls.slice(mark).filter((c) => c.method === method) }
const noteText = function (tree) {
  const one = byClass(tree, 'dsh-git-oknote')[0]
  return one === undefined ? '' : textOf(one)
}

console.log('')
console.log('=== 无勾选：工具条在，三个按钮都禁用 ===')
reply = withWork([], [{ path: 'w.txt', code: ' M' }], [{ path: 'new.txt', code: '??' }])
let tree = await openPanel()
await clickText(tree, '变更')
tree = await settle()
let bars = byClass(tree, 'dsh-git-ctools')
ok('工具条只挂在「默认变更列表」组下（「新增的文件」组没有第二排按钮）', bars.length === 1)
let barButtons = bars.length === 1 ? buttons(bars[0]) : []
ok('三个按钮：添加 / 还原 / 暂存',
  barButtons.length === 3 && textOf(barButtons[0]) === '添加' && textOf(barButtons[1]) === '还原' && textOf(barButtons[2]) === '暂存')
ok('一个都没勾时全部禁用', barButtons.length === 3 && barButtons.every((b) => b.props.disabled === true))
ok('禁用的原因写在 title 里（先勾选…）', barButtons.length === 3 && barButtons.every((b) => String(b.props.title).indexOf('先勾选') === 0))
ok('计数行说「已勾选 0 项」', bars.length === 1 && textOf(bars[0]).indexOf('已勾选 0 项') >= 0)

console.log('')
console.log('=== 勾了两项：按钮可用，计数跟着走 ===')
reply = withWork(
  [{ path: 'gone.txt', code: 'M ' }, { path: 'kept.txt', code: 'M ' }],
  [{ path: 'w.txt', code: ' M' }],
  [{ path: 'new.txt', code: '??' }])
await clickText(tree, '⟳')
tree = await settle()
bars = byClass(tree, 'dsh-git-ctools')
barButtons = bars.length === 1 ? buttons(bars[0]) : []
ok('三个按钮都可用', barButtons.length === 3 && barButtons.every((b) => b.props.disabled !== true))
ok('计数行说「已勾选 2 项」', bars.length === 1 && textOf(bars[0]).indexOf('已勾选 2 项') >= 0)
ok('还原的 title 带着命令和「再点一次确认」', barButtons.length === 3
  && String(barButtons[1].props.title).indexOf('git restore --source=HEAD --staged --worktree') >= 0
  && String(barButtons[1].props.title).indexOf('确认') >= 0)

console.log('')
console.log('=== 添加：走勾框那同一条 git/stage 路 ===')
let mark = calls.length
await clickText(bars[0], '添加')
tree = await settle()
const stageCalls = callsOf(mark, 'git/stage')
ok('发出一条 git/stage，路径就是勾选的那两项（按路径排序）',
  stageCalls.length === 1 && JSON.stringify(stageCalls[0].args.paths) === '["gone.txt","kept.txt"]')

console.log('')
console.log('=== 还原：第一次点只武装，第二次才动手 ===')
mark = calls.length
await clickText(bars[0], '还原')
ok('第一次点不发 git/restore', callsOf(mark, 'git/restore').length === 0)
tree = await settle()
bars = byClass(tree, 'dsh-git-ctools')
const armedButton = bars.length === 1 ? buttons(bars[0])[1] : undefined
ok('按钮换成了红色「确认还原 2 项」', armedButton !== undefined
  && textOf(armedButton) === '确认还原 2 项'
  && String(armedButton.props.className).indexOf('dsh-git-ctool-danger') >= 0)
mark = calls.length
await clickText(bars[0], '确认还原 2 项')
tree = await settle()
const restoreCalls = callsOf(mark, 'git/restore')
ok('第二次点发 git/restore，路径还是那两项', restoreCalls.length === 1
  && JSON.stringify(restoreCalls[0].args.paths) === '["gone.txt","kept.txt"]')
ok('成功条说了做了什么（回到 HEAD）', noteText(tree).indexOf('已还原 2 项') >= 0 && noteText(tree).indexOf('HEAD') >= 0)

console.log('')
console.log('=== 武装之后勾选变了：确认态自己退回 ===')
reply = withWork([{ path: 'kept.txt', code: 'M ' }], [{ path: 'w.txt', code: ' M' }], [{ path: 'new.txt', code: '??' }])
await clickText(tree, '⟳')
tree = await settle()
bars = byClass(tree, 'dsh-git-ctools')
const backButton = bars.length === 1 ? buttons(bars[0])[1] : undefined
ok('按钮退回普通的「还原」（确认的永远是读者正看着的那一组）',
  backButton !== undefined && textOf(backButton) === '还原'
  && String(backButton.props.className).indexOf('dsh-git-ctool-danger') < 0)

console.log('')
console.log('=== 暂存（stash）：单击即发，成功条说怎么找回 ===')
mark = calls.length
await clickText(bars[0], '暂存')
tree = await settle()
const stashCalls = callsOf(mark, 'git/stash')
ok('发出 git/stash，说明带着个数', stashCalls.length === 1
  && stashCalls[0].args.message === 'dsh-git-idea：暂存 1 个文件'
  && JSON.stringify(stashCalls[0].args.paths) === '["kept.txt"]')
ok('成功条说了用 git stash pop 找回', noteText(tree).indexOf('git stash pop') >= 0)

console.log('')
console.log('=== 多仓库：按钮长在哪个组里，就动哪个仓库 ===')
/* 换一个新会话：仓库扫描按会话只发一次（24-repos.js），s-1 已经问过了。 */
reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws/alpha', '/tmp/ws/beta'], manual: [], missing: [] }
repoReplies = {
  '/tmp/ws/alpha': {
    ok: true, repo: '/tmp/ws/alpha', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0,
    sequencer: null, staged: [{ path: 'alpha-one.txt', code: 'M ' }], unstaged: [], untracked: [], unmerged: [],
  },
  '/tmp/ws/beta': {
    ok: true, repo: '/tmp/ws/beta', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0,
    sequencer: null, staged: [{ path: 'beta-one.txt', code: 'M ' }, { path: 'beta-two.txt', code: 'M ' }],
    unstaged: [], untracked: [], unmerged: [],
  },
}
const pop2 = async () => renderUntilStable(makeElement(popover, { sessionId: 's-2' }), 'pop2')
let multi = await pop2()
await wait(20)
multi = await pop2()
await clickText(multi, '变更')
multi = await pop2()
const pickRow = (t, path) => byClass(t, 'dsh-git-repo-row').find((r) => String(r.props.key) === 'repo:' + path)
pickRow(multi, '/tmp/ws/alpha').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
pickRow(multi, '/tmp/ws/beta').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
await wait(30)
multi = await pop2()
bars = byClass(multi, 'dsh-git-ctools')
ok('两个仓库的组各有一排工具条', bars.length === 2)
ok('生效仓库自己（ws）没有第三排', byClass(multi, 'dsh-git-reposide').length === 1)
/* 分组顺序 = 挑选顺序（alpha 先、beta 后），第二排属于 beta。 */
const betaButtons = bars.length === 2 ? buttons(bars[1]) : []
ok('beta 组里勾了两项', bars.length === 2 && textOf(bars[1]).indexOf('已勾选 2 项') >= 0)
mark = calls.length
await clickText(bars[1], '添加')
multi = await pop2()
const betaStage = callsOf(mark, 'git/stage')
ok('添加落在 repo-b 自己的仓库上（不是生效仓库）', betaStage.length === 1
  && betaStage[0].args.repo === '/tmp/ws/beta'
  && JSON.stringify(betaStage[0].args.paths) === '["beta-one.txt","beta-two.txt"]')
mark = calls.length
await clickText(bars[1], '还原')
multi = await pop2()
await clickText(byClass(multi, 'dsh-git-ctools')[1], '确认还原 2 项')
multi = await pop2()
const betaRestore = callsOf(mark, 'git/restore')
ok('还原同样落在 beta 上', betaRestore.length === 1 && betaRestore[0].args.repo === '/tmp/ws/beta')
