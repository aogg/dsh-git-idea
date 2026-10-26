/* ═══ gp67：会话完成 → 提交历史列表跟着刷新（客户端这一半）═══
 *
 * 用户报的场景：会话完成后，历史页的 git/graph 提交列表没有跟着刷新。宿主那一半
 * （gp67-host）钉「重发的读拿到的必须是失效缓存后的新账」；这里钉客户端这四环：
 *
 *   1. 面板开着停在历史页，宿主推 session-complete → 完成那一刷先发 flush 再让
 *      freshAt 追上（先失效再读），面板重发 git/graph，屏上的提交列表换上新顶端；
 *      且 flush 的 repo 与 graph 请求的 repo 逐字节同形（缓存键前缀匹配的客户端
 *      半边），生效仓库必须算进完成那一刷的清单（completionReposOf）。
 *   2. 面板关着时完成（chip 边沿那一路）：flush 照发、面板一个读都不发（freshAt
 *      冻结的既有规矩）；再打开时历史页重发 git/graph，读到的是新账。
 *   3. 5 秒护栏：chip 边沿刚刷过，同一次完成的推送迟到 —— 让路，graph 不重发
 *      （不重复整树读的既有语义在历史页这一侧同样成立）。
 *   4. refreshOnComplete=false：推送到了也不 flush、不重读（开关语义不被破坏）。
 *
 * 与 gp52 同一套会话状态假 props；git/repos 桩答一份真清单，仓库行单击把 /tmp/ws
 * 应用成生效仓库 —— 让「flush 清单覆盖面板当前生效仓库」这条真正有据可断。 */

const realCall67 = host.call
host.call = function (method, args) {
  if (method === 'git/repos') {
    calls.push({ method: method, args: args })
    return Promise.resolve({ ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws'], manual: [], missing: [], links: [] })
  }
  return realCall67(method, args)
}

const callsOf67 = (mark, method) => calls.slice(mark).filter((c) => c.method === method)
const subjects67 = (t) => byClass(t, 'dsh-git-subject').map(textOf)
const fireTimers67 = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}
const status67 = new Map([['s-1', { running: false }]])
const chipWith67 = function (state) {
  return renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-1' }, {
    useSession: function (sel) { return sel({ running: state.running === true }) },
    useSessionStatus: function (sel) { return sel(status67) },
  })), 'chip-67-' + state.label)
}
const chipClose67 = async function () {
  const t = await chipTree()
  if (String(t.props.className).indexOf('dsh-git-chip-open') >= 0) { t.props.onClick(); await wait(20) }
  return await settle()
}
const APPLIED = '/tmp/ws'
const repoRow67 = (t) => byClass(t, 'dsh-git-repo-row').filter((r) => textOf(r).indexOf('全部') < 0)[0]

console.log('')
console.log('=== 铺场：面板开着停在历史页，/tmp/ws 应用成生效仓库 ===')
fibers.clear()
await chipWith67({ running: false, label: 'setup' })
let tree67 = await openPanel()
tree67 = await settle()
ok('历史页首读：旧顶端在屏上', subjects67(tree67).indexOf('tip commit') === 0)
const row67 = repoRow67(tree67)
if (row67 === undefined) throw new Error('gp67: 仓库行没渲染出来')
let markApplied67 = calls.length
row67.props.onClick({ ctrlKey: false })
tree67 = await settle()
ok('仓库行单击后，历史页的 git/graph 请求带上生效仓库 /tmp/ws',
  callsOf67(markApplied67, 'git/graph').length > 0
  && callsOf67(markApplied67, 'git/graph').every((c) => c.args != null && c.args.repo === APPLIED))

console.log('')
console.log('=== 1｜面板开着（历史页）+ 推送路径：先失效再读，列表换新顶端 ===')
graphCommits = [
  { hash: 'd111111', subject: '完成刷新带来的新顶端', author: 'mays', date: '2026-10-25', committedAt: nowSec - 30, refs: ['HEAD -> main'] },
  { hash: 'aaa111', subject: 'tip commit', author: 'mays', date: '2026-09-16', committedAt: nowSec - 60, refs: [] },
]
let mark67 = calls.length
livePush({ kind: 'session-complete', sessionId: 's-1' })
await wait(30)
tree67 = await settle()
const flushes67 = callsOf67(mark67, 'git/flush')
const graphs67 = callsOf67(mark67, 'git/graph')
ok('完成那一刷重发了 git/flush（会话级 + 生效仓库各一条）',
  flushes67.some((c) => c.args != null && c.args.repo === undefined && c.args.tags === undefined)
  && flushes67.some((c) => c.args != null && c.args.repo === APPLIED && c.args.tags === undefined))
ok('flush 排在面板重发的 git/graph 前面（先失效缓存再读，读到的才不是旧账）',
  flushes67.length > 0 && graphs67.length > 0
  && calls.indexOf(flushes67[0]) < calls.indexOf(graphs67[0]))
ok('面板重发的 git/graph 带的还是同一个生效仓库路径（与 flush 的 repo 逐字节同形）',
  graphs67.length > 0 && graphs67[0].args != null && graphs67[0].args.repo === APPLIED)
ok('提交历史列表换上新顶端', subjects67(tree67).indexOf('完成刷新带来的新顶端') === 0)

console.log('')
console.log('=== 2｜面板关着时完成（chip 边沿）：flush 照发、读全冻；重开读到新账 ===')
await chipClose67()
tree67 = await settle()
graphCommits = [
  { hash: 'e222222', subject: '重开历史页读到的新账', author: 'mays', date: '2026-10-25', committedAt: nowSec - 20, refs: ['HEAD -> main'] },
  { hash: 'd111111', subject: '完成刷新带来的新顶端', author: 'mays', date: '2026-10-25', committedAt: nowSec - 30, refs: [] },
]
/* 换一把新 chip（新 fiber，边沿重新武装）：上一节的推送没有烧边沿，但干净起见
   按 gp52 的做法新挂一只，running true→false 走 chip 自己的那一路。 */
const state67b = { running: false, label: 'closed' }
await chipWith67(state67b)
state67b.running = true
await chipWith67(state67b)
state67b.running = false
mark67 = calls.length
await chipWith67(state67b)
fireTimers67(2000)
await wait(30)
tree67 = await settle()
ok('关着的那一刷：flush 重发了，面板一个读都不发（freshAt 冻结）',
  callsOf67(mark67, 'git/flush').length >= 2 && callsOf67(mark67, 'git/graph').length === 0)
mark67 = calls.length
tree67 = await openPanel()
tree67 = await settle()
ok('再打开：历史页重发了 git/graph', callsOf67(mark67, 'git/graph').length >= 1)
ok('重开读到的列表是新账', subjects67(tree67).indexOf('重开历史页读到的新账') === 0)

console.log('')
console.log('=== 3｜5 秒护栏：chip 边沿刚刷过，同一次完成的推送让路 ===')
graphCommits = [
  { hash: 'f333333', subject: '护栏后不重读的第三次', author: 'mays', date: '2026-10-25', committedAt: nowSec - 10, refs: ['HEAD -> main'] },
  { hash: 'e222222', subject: '重开历史页读到的新账', author: 'mays', date: '2026-10-25', committedAt: nowSec - 20, refs: [] },
]
const state67c = { running: false, label: 'guard' }
await chipWith67(state67c)
state67c.running = true
await chipWith67(state67c)
state67c.running = false
mark67 = calls.length
await chipWith67(state67c)
fireTimers67(2000)
await wait(30)
tree67 = await settle()
const edgeFlushes67 = callsOf67(mark67, 'git/flush').length
const edgeGraphs67 = callsOf67(mark67, 'git/graph').length
ok('chip 边沿那一刷照常：flush 与 graph 都发了（边沿永远照跑）', edgeFlushes67 >= 2 && edgeGraphs67 >= 1)
livePush({ kind: 'session-complete', sessionId: 's-1' })
await wait(30)
tree67 = await settle()
ok('5 秒内迟到的推送被护栏让路：flush 与 graph 都没有第二遍',
  callsOf67(mark67, 'git/flush').length === edgeFlushes67
  && callsOf67(mark67, 'git/graph').length === edgeGraphs67)
ok('屏上列表就是边沿那一刷换上的（不需要也不再有第二遍）',
  subjects67(tree67).indexOf('护栏后不重读的第三次') === 0)

console.log('')
console.log('=== 4｜refreshOnComplete=false：推送到了也不刷（开关语义不被破坏）===')
const registeredF67 = []
const callsF67 = []
const ctxF67 = {
  get(n) {
    if (n === 'slots') return { inject: (k, cb) => cb(), register: (o, c) => { registeredF67.push({ options: o, component: c }); return () => {} } }
    return undefined
  },
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const hostF67 = { call(method, args) {
  callsF67.push({ method: method, args: args })
  if (method === 'git/config') return Promise.resolve({ ok: true, path: '/tmp/gp67.json', config: { refreshOnComplete: false } })
  if (method === 'git/repos') return Promise.resolve({ ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws'], manual: [], missing: [], links: [] })
  if (method === 'git/panel') return Promise.resolve({ ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] })
  if (method === 'git/repo-applied') return Promise.resolve({ ok: true, workspace: '/tmp/ws', repo: '' })
  if (method === 'git/graph') return Promise.resolve({ ok: true, repo: '/tmp/ws', ref: 'main', currentBranch: 'main', commits: graphCommits, rows: [], lanes: 1 })
  return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
} }
new Function('ctx', 'React', 'host', 'styles', 'console', fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8'))(
  ctxF67, React, hostF67, { insert: () => () => {} }, console).apply(ctxF67)
const chipF67 = registeredF67.find((r) => r.options.id === 'dsh-git-idea-chip').component
await renderUntilStable(makeElement(chipF67, { sessionId: 's-1' }), 'chip-67-off')
mark67 = callsF67.length
livePush({ kind: 'session-complete', sessionId: 's-1' })
await wait(30)
ok('开关关着：推送到了一个 flush 都不发', callsF67.slice(mark67).every((c) => c.method !== 'git/flush'))
ok('开关关着：也不重读历史（graph 一次都不加）', callsF67.slice(mark67).every((c) => c.method !== 'git/graph'))
