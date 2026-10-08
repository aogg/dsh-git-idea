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
/* ── 变更页：冲突文件单独成组置顶（红色双码），提交区先提醒冲突未解决 ──
 *
 * 盯五件事：
 *   1. work 快照里 unmerged 的条目（porcelain v2 的 u 行，双码 UU/AA/DU…，mergeChanges
 *      给它们打了 conflict 标）在 scopeRows 里单独分桶成「冲突」组（key @conflict），
 *      排在「默认变更列表」之前；组内按 path 排序 —— git 回答的顺序不作数。没有冲突
 *      时这组整个不出现：组头、指引行、CF 格一样都不留，树和从前一字不差；
 *   2. 冲突组展开时组头之下有一行 dsh-git-dim 指引，文字说 <<<<<<< ======= >>>>>>>
 *      标记和「git add 标记已解决」；
 *   3. fileRow 对冲突行：状态格画完整双码（class dsh-git-st dsh-git-st-CF，title 说
 *      未解决的冲突），勾选框的措辞换成「标记已解决，普通修改行（单字母 M）与
 *      未跟踪行（?）照旧；
 *   4. 组头勾选框：冲突组说「把这一组全部标记已解决（git add）」，默认变更列表组
 *      仍是「把这一组全部暂存」—— 同一个框，两种动作，话不能混；
 *   5. 右栏提交区：conflictCount > 0 时出现 dsh-git-hint dsh-git-warn 警告（N 正确），
 *      无冲突时不出现；多选视图里警告只数生效仓库的冲突，别的仓库不进这个数。
 *
 * 多仓库那一段是顺手覆盖：现有 harness（gp45 的 reposReply + ctrl 点选）撑得起，
 * 就断一条「指引行按仓库各来一行」—— 键带 repo，两个仓库不会撞。 */

let reply = {
  ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0,
  sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [],
}
/* 多仓库那一段：每个仓库一份自己的答复（按 args.repo 分发），生效仓库走 reply。 */
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
  return realCall(method, args)
}

const clickText = async function (tree, label) {
  const hit = buttons(tree).find((b) => textOf(b).indexOf(label) >= 0)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
}
/* 变更树里的行（组头、指引行、文件行共用 dsh-git-trow），collect 的先后就是画的先后。 */
const listRows = function (tree) {
  return collect(tree).filter((n) => typeof n.props.className === 'string'
    && n.props.className.split(' ').indexOf('dsh-git-trow') >= 0)
}
const groupRows = function (tree) {
  return listRows(tree).filter((r) => String(r.props.className).indexOf('dsh-git-cgroup') >= 0)
}
const rowOf = function (tree, key) {
  return collect(tree).find((n) => n.key === key)
}
const segmentHas = function (rows, path) {
  return rows.some((r) => textOf(r).indexOf(path) >= 0)
}

const conflictReply = function () {
  return {
    ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0,
    sequencer: null,
    staged: [],
    unstaged: [{ path: 'mod.txt', code: ' M' }],
    untracked: [{ path: 'brand-new.txt', code: '??' }],
    /* 故意按 git 回答的顺序给（b 在前 a 在后）：组内顺序必须是 path 的，不是列表的。 */
    unmerged: [{ path: 'b-conflict.txt', code: 'DU' }, { path: 'a-conflict.txt', code: 'UU' }],
  }
}
const cleanReply = function (repo) {
  return {
    ok: true, repo: repo, branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0,
    sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [],
  }
}

console.log('')
console.log('== 冲突快照：冲突组成组、置顶、组内按 path 排序 ==')
reply = conflictReply()
let tree = await openPanel()
await clickText(tree, '变更')
tree = await settle()
let allRows = listRows(tree)
let titles = groupRows(tree)
let keys = allRows.map((r) => r.key)
let ci = keys.indexOf('@conflict:title')
ok('冲突组出现了：key @conflict:title、组头样式 dsh-git-cgroup、label「冲突」、计数 2 个文件',
  ci >= 0 && titles.some((t) => t.key === '@conflict:title')
  && String(allRows[ci].props.className).indexOf('dsh-git-cgroup') >= 0
  && textOf(allRows[ci]).indexOf('冲突') >= 0 && textOf(allRows[ci]).indexOf('2 个文件') >= 0)
ok('组顺序：冲突 → 默认变更列表 → 新增的文件（置顶，不插在中间）',
  ci < keys.indexOf('@tracked:title') && keys.indexOf('@tracked:title') < keys.indexOf('@new:title'))
const guide = allRows[ci + 1]
ok('指引行紧跟冲突组头：key 带 repo（单仓库是 guide:）、dim 行，文字说 <<<<<<< ======= >>>>>>> 与「git add 标记已解决」',
  guide !== undefined && guide.key === 'guide:'
  && String(guide.props.className).indexOf('dsh-git-dim') >= 0
  && textOf(guide).indexOf('<<<<<<< ======= >>>>>>>') >= 0
  && textOf(guide).indexOf('git add 标记已解决') >= 0)
const ti = keys.indexOf('@tracked:title')
const ni = keys.indexOf('@new:title')
const segConflict = allRows.slice(ci + 2, ti)
const segTracked = allRows.slice(ti + 1, ni)
const segNew = allRows.slice(ni + 1)
ok('冲突组里只有那两条冲突文件，且按 path 排序（列表里 b 在前，画出来 a 在前）',
  segConflict.length === 2 && segmentHas(segConflict, 'a-conflict.txt') && segmentHas(segConflict, 'b-conflict.txt')
  && textOf(segConflict[0]).indexOf('a-conflict.txt') >= 0 && textOf(segConflict[1]).indexOf('b-conflict.txt') >= 0)
ok('分桶不串组：mod.txt 归默认变更列表，brand-new.txt 归新增的文件，谁也没被冲突组领走',
  segmentHas(segTracked, 'mod.txt') && segmentHas(segNew, 'brand-new.txt')
  && !segmentHas(segTracked, 'a-conflict.txt') && !segmentHas(segTracked, 'b-conflict.txt')
  && !segmentHas(segConflict, 'mod.txt') && !segmentHas(segConflict, 'brand-new.txt'))

console.log('')
console.log('== 冲突行的状态格与勾选框：红色双码，措辞换成「标记已解决」 ==')
const cfCells = byClass(tree, 'dsh-git-st-CF')
ok('两条冲突行都画 CF 状态格（别的行一个都没有）', cfCells.length === 2)
const uuCell = cfCells.find((c) => textOf(c) === 'UU')
ok('UU 格：class 完整是「dsh-git-st dsh-git-st-CF」、文字是完整双码 UU、title 说未解决的冲突（带双码）',
  uuCell !== undefined && uuCell.props.className === 'dsh-git-st dsh-git-st-CF'
  && String(uuCell.props.title).indexOf('未解决的冲突') >= 0 && String(uuCell.props.title).indexOf('UU') >= 0)
const duCell = cfCells.find((c) => textOf(c) === 'DU')
ok('DU 格：同款双码（不是 statusClass 落进去的黄色 M）',
  duCell !== undefined && duCell.props.className === 'dsh-git-st dsh-git-st-CF' && textOf(duCell) === 'DU')
const rowA = segConflict.find((r) => textOf(r).indexOf('a-conflict.txt') >= 0)
const boxA = byClass(rowA, 'dsh-git-cbox')[0]
const markBoxTitle = '标记已解决（git add）'
ok('冲突行勾选框的措辞是「标记已解决（git add）」，不再是普通的「暂存」',
  boxA !== undefined && boxA.props.title === markBoxTitle)
const mRow = segTracked.find((r) => textOf(r).indexOf('mod.txt') >= 0)
const mCell = byClass(mRow, 'dsh-git-st')[0]
ok('普通修改行照旧：单字母 M、class「dsh-git-st dsh-git-st-M」、勾选框还是「暂存」',
  mCell !== undefined && mCell.props.className === 'dsh-git-st dsh-git-st-M' && textOf(mCell) === 'M'
  && byClass(mRow, 'dsh-git-cbox')[0].props.title === '暂存')
const nRow = segNew.find((r) => textOf(r).indexOf('brand-new.txt') >= 0)
const nCell = byClass(nRow, 'dsh-git-st')[0]
ok('未跟踪行照旧：单字 ?、class「dsh-git-st dsh-git-st-U」',
  nCell !== undefined && nCell.props.className === 'dsh-git-st dsh-git-st-U' && textOf(nCell) === '?')

console.log('')
console.log('== 组头的框：冲突组说「标记已解决」，默认变更列表组说「暂存」 ==')
const markGroupTitle = '把这一组全部标记已解决（git add）'
ok('冲突组头的框：「把这一组全部标记已解决（git add）」',
  byClass(allRows[ci], 'dsh-git-cbox')[0].props.title === markGroupTitle)
ok('默认变更列表组头的框：仍是「把这一组全部暂存」',
  byClass(allRows[ti], 'dsh-git-cbox')[0].props.title === '把这一组全部暂存')

console.log('')
console.log('== 提交区：conflictCount > 0 先警告，N 说得对 ==')
const warns = byClass(tree, 'dsh-git-warn')
ok('出现 dsh-git-hint dsh-git-warn 警告，文字含「2 个冲突未解决」（两条 unmerged 就是 2）',
  warns.length === 1 && warns[0].props.className === 'dsh-git-hint dsh-git-warn'
  && textOf(warns[0]).indexOf('2 个冲突未解决') >= 0)

console.log('')
console.log('== 无冲突快照：这组整个不出现，树和从前一字不差 ==')
reply = cleanReply('/tmp/ws')
reply.staged = []
reply.unstaged = [{ path: 'mod.txt', code: ' M' }]
reply.untracked = [{ path: 'brand-new.txt', code: '??' }]
await clickText(tree, '⟳')
tree = await settle()
titles = groupRows(tree)
ok('组头只剩两个：@tracked 与 @new，没有 @conflict',
  titles.length === 2 && titles[0].key === '@tracked:title' && titles[1].key === '@new:title')
ok('指引行也没有了', rowOf(tree, 'guide:') === undefined
  && collect(tree).every((n) => String(n.key).indexOf('guide:') !== 0))
ok('没有任何 CF 状态格', byClass(tree, 'dsh-git-st-CF').length === 0)
ok('提交区没有警告节点', byClass(tree, 'dsh-git-warn').length === 0)

console.log('')
console.log('== 多仓库（顺手）：指引行每个仓库各一行；警告只数生效仓库 ==')
reply = cleanReply('/tmp/ws')
reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws/alpha', '/tmp/ws/beta'], manual: [], missing: [] }
repoReplies = {
  '/tmp/ws/alpha': Object.assign(cleanReply('/tmp/ws/alpha'), { unmerged: [{ path: 'a-conflict.txt', code: 'UU' }] }),
  '/tmp/ws/beta': Object.assign(cleanReply('/tmp/ws/beta'), { unmerged: [{ path: 'b-conflict.txt', code: 'DU' }, { path: 'c-conflict.txt', code: 'AA' }] }),
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
ok('两个仓库的冲突组各带一行指引（key 带各自的 repo，不会撞）',
  collect(multi).filter((n) => n.key === 'guide:/tmp/ws/alpha' || n.key === 'guide:/tmp/ws/beta').length === 2)
ok('生效仓库（ws）自己没有冲突 → 提交区不出现警告（别的仓库的不进这个数）',
  byClass(multi, 'dsh-git-warn').length === 0)
