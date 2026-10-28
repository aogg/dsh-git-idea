/* ═══ gp80：命令页耗时列（40-format 的 durationText + 57 行内徽标 + 80 的实时并轨）═══
 *
 * 两个数据源、一条画法：
 *   a. 会话扫描的行：Host 用 tool/call 与 tool/result 两端 time 算好 durationMs
 *      随行来（宿主侧 gp76 已钉）；这里钉画法与格式。
 *   b. 面板执行的行：cmdlog-start 推送来时还没有耗时 → 画「运行中」；
 *      cmdlog-exit 带 ms → 就地换成真数字；老宿主的推送没有 ms → 画 —（向后兼容）。
 *   c. 格式三刻度：820ms / 3.2s（10s 以上取整）/ 1m24s；拿不到画 —。
 *   d. 账本后台刷新的 cmdlog-refresh（80-panel.js 的 live 订阅）：workspace 对上
 *      才并、对不上整包不理（别的账本刷的）；答复随行的 workspace 是认领的凭据。
 *
 * 跑法：node test/run-all.mjs 里跑（胶合套件，源 = gp37-harness.part + 本文件）。 */

const CMD_T0 = 1793000000000
/* 一次性换掉下一份 git/command-log 答复；workspace 字段是 cmdlog-refresh 认领的凭据。 */
let reply77 = null
const realCall77 = host.call
host.call = function (method, args) {
  if (method === 'git/command-log') {
    if (reply77 !== null) { const r = reply77; reply77 = null; return Promise.resolve(r) }
    return Promise.resolve({ ok: true, sessionId: args != null ? args.sessionId : '', commands: [{ id: 'keep', time: CMD_T0, command: 'git status', description: '', source: 'panel', exitCode: 0, durationMs: null }], truncated: false, warning: '', workspace: '/tmp/ws' })
  }
  return realCall77(method, args)
}

const durCells = (t) => byClass(t, 'dsh-git-cmddur').map(textOf)
const cmdRows = (t) => byClass(t, 'dsh-git-cmdline')
const cmdTextCount = (t, label) => collect(t).filter((n) => n.props.className === 'dsh-git-cmdtext' && textOf(n) === label).length
const cmdOpenOf = (t, label) => collect(t).find((n) => n.props.className === 'dsh-git-cmdopen' && textOf(n).indexOf(label) >= 0)
/* harness 的 rowWith 找的是分支行；命令行另起一名。 */
const cmdRow77 = (t, label) => cmdRows(t).find((r) => textOf(r).indexOf(label) >= 0)
/* 行内某格的下标（children 里有 null，别让别的孩子形状绊倒）。 */
const cellIdx = (row, cls) => row.props.children.findIndex((c) => c != null && typeof c === 'object' && c.props != null && c.props.className === cls)
/* gp49 同款：点页签按钮（harness 里没有这一手，各 body 自己长）。 */
const clickText77 = async function (tree, label) {
  const hit = buttons(tree).find((b) => textOf(b).indexOf(label) >= 0)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
}

console.log('=== 1｜耗时列的格式：三刻度 + 未知 ===')
fibers.clear()
reply77 = { ok: true, sessionId: 's-1', truncated: false, warning: '', workspace: '/tmp/ws', commands: [
  { sessionId: 'sa', time: CMD_T0 + 5000, command: 'git a', description: '', source: 'session', exitCode: 0, durationMs: 820 },
  { sessionId: 'sb', time: CMD_T0 + 4000, command: 'git b', description: '', source: 'session', exitCode: 0, durationMs: 3200 },
  { sessionId: 'sc', time: CMD_T0 + 3000, command: 'git c', description: '', source: 'session', exitCode: 0, durationMs: 10400 },
  { sessionId: 'sd', time: CMD_T0 + 2000, command: 'git d', description: '', source: 'session', exitCode: 0, durationMs: 84000 },
  { sessionId: 'se', time: CMD_T0 + 1000, command: 'git e', description: '', source: 'session', exitCode: 0, durationMs: null },
  { sessionId: 'sf', time: CMD_T0, command: 'git f', description: '', source: 'session', exitCode: 0 },
] }
let tree = await openPanel()
await clickText77(tree, '命令')
tree = await settle()
const durs = durCells(tree)
ok('六个命令行各有一格耗时',
  /* 吸顶表头（c03c2f8 的 dsh-git-cmdhead）有意复用数据行的格类共用列宽：手里有
     数据行时表头在渲染，格数 = 6 行 + 1 表头。行数断言只数 dsh-git-cmdline，
     不受影响。 */
  cmdRows(tree).length === 6 && byClass(tree, 'dsh-git-cmddur').length === 7)
ok('<1s 画毫秒：820ms', durs.indexOf('820ms') >= 0)
ok('1s–1min 画秒一位小数：3.2s', durs.indexOf('3.2s') >= 0)
ok('10s 以上小数位是噪音，取整：10s', durs.indexOf('10s') >= 0)
ok('超 1min 画分秒：1m24s', durs.indexOf('1m24s') >= 0)
ok('durationMs 为 null（记录里缺一端时间戳）画 —，不冒充 0',
  durs.filter((d) => d === '—').length === 2)
ok('耗时格紧跟时间格（行内顺序：time → dur → text）',
  cmdRow77(tree, 'git a') !== undefined
  && cellIdx(cmdRow77(tree, 'git a'), 'dsh-git-cmdtime') < cellIdx(cmdRow77(tree, 'git a'), 'dsh-git-cmddur')
  && cellIdx(cmdRow77(tree, 'git a'), 'dsh-git-cmddur') < cellIdx(cmdRow77(tree, 'git a'), 'dsh-git-cmdtext'))

console.log('')
console.log('=== 2｜面板行：运行中 → 推送补上耗时（老的推送没 ms 画 —）===')
fibers.clear()
reply77 = { ok: true, sessionId: 's-1', truncated: false, warning: '', workspace: '/tmp/ws', commands: [
  { id: 'run1', time: CMD_T0 + 9000, command: 'git push', description: '', source: 'panel', exitCode: null },
  { id: 'done1', time: CMD_T0 + 8000, command: 'git commit -m x', description: '', source: 'panel', exitCode: 0, durationMs: 2400 },
] }
tree = await settle()
await clickText77(tree, '命令')
tree = await settle()
ok('运行中的面板行：耗时格画「运行中」，运行徽标（…）也还在',
  durCells(tree).indexOf('运行中') >= 0 && byClass(tree, 'dsh-git-cmdrun').length >= 1)
ok('已完成的面板行：cmdlog-exit 之前答复带的 durationMs 照画 2.4s',
  durCells(tree).indexOf('2.4s') >= 0)
livePush({ kind: 'cmdlog-exit', id: 'run1', exitCode: 0, ms: 1234 })
tree = await settle()
ok('cmdlog-exit 带 ms：运行中就地换成 1.2s，行数不变',
  durCells(tree).indexOf('1.2s') >= 0 && durCells(tree).indexOf('运行中') < 0 && cmdRows(tree).length === 2)
livePush({ kind: 'cmdlog-start', entry: { id: 'run2', time: CMD_T0 + 9500, command: 'git fetch --all', description: '', source: 'panel', exitCode: null } })
tree = await settle()
ok('cmdlog-start 新开的命令：一行「运行中」，不把已完成的挤掉',
  cmdRows(tree).length === 3 && durCells(tree).filter((d) => d === '运行中').length === 1)
/* 老宿主（部署副本还没更到这版）的推送没有 ms：退出码照改，耗时退回 —。 */
livePush({ kind: 'cmdlog-exit', id: 'run2', exitCode: 3 })
tree = await settle()
ok('老推送没有 ms：失败徽标（叉号 3）照上，耗时画 —（向后兼容）',
  collect(tree).some((n) => n.props.className === 'dsh-git-cmdfail' && textOf(n) === '✗3')
  && durCells(tree).filter((d) => d === '—').length >= 1)

console.log('')
console.log('=== 3｜账本后台刷新的 cmdlog-refresh：workspace 对上才并 ===')
fibers.clear()
reply77 = { ok: true, sessionId: 's-1', truncated: false, warning: '', workspace: '/tmp/ws', commands: [
  { sessionId: 'sa', time: CMD_T0 + 1000, command: 'git status', description: '', source: 'session', exitCode: 0, durationMs: 820 },
] }
tree = await settle()
await clickText77(tree, '命令')
tree = await settle()
ok('手里的列表 1 行（答复随行带了 workspace=/tmp/ws）', cmdRows(tree).length === 1)
livePush({ kind: 'cmdlog-refresh', workspace: '/other-ws', commands: [
  { sessionId: 'sx', time: CMD_T0 + 9000, command: 'git push', description: '', source: 'session', exitCode: 0, durationMs: 5000 },
] })
tree = await settle()
ok('别的工作区的账本刷新：整包不理（还是 1 行）', cmdRows(tree).length === 1)
livePush({ kind: 'cmdlog-refresh', workspace: '/tmp/ws', commands: [
  { sessionId: 'sa', time: CMD_T0 + 1000, command: 'git status', description: '', source: 'session', exitCode: 0, durationMs: 820 },
  { sessionId: 'sy', time: CMD_T0 + 8000, command: 'git rebase main', description: '', source: 'session', exitCode: 0, durationMs: 4400 },
] })
tree = await settle()
ok('本工作区的账本刷新：增量并进来（2 行），同 key 的旧行不重出',
  cmdRows(tree).length === 2 && cmdTextCount(tree, 'git status') === 1
  && cmdRow77(tree, 'git rebase main') !== undefined)
livePush({ kind: 'cmdlog-refresh', workspace: '/tmp/ws', commands: [] })
tree = await settle()
ok('commands 不是数组的坏推送：安静不理（列表原样）', cmdRows(tree).length === 2)

console.log('')
console.log('=== 4｜行身份与展开不受耗时列影响 ===')
fibers.clear()
reply77 = { ok: true, sessionId: 's-1', truncated: false, warning: '', workspace: '/tmp/ws', commands: [
  { sessionId: 'sa', time: CMD_T0 + 1000, command: 'git status', description: '', source: 'session', exitCode: 0, durationMs: 820 },
] }
tree = await settle()
await clickText77(tree, '命令')
tree = await settle()
cmdRow77(tree, 'git status').props.onClick()
tree = await settle()
ok('点开详情：展开块在（含复制按钮）',
  cmdOpenOf(tree, 'git status') !== undefined && textOf(cmdOpenOf(tree, 'git status')).indexOf('复制') >= 0)
reply77 = { ok: true, sessionId: 's-1', truncated: false, warning: '', workspace: '/tmp/ws', commands: [
  { sessionId: 'sa', time: CMD_T0 + 1000, command: 'git status', description: '', source: 'session', exitCode: 0, durationMs: 830 },
] }
await clickText77(tree, '重新读取')
tree = await settle()
ok('重读换新（820→830ms 同一行）：耗时更新、展开还开着',
  durCells(tree).indexOf('830ms') >= 0 && cmdOpenOf(tree, 'git status') !== undefined)

console.log('')
console.log('（gp80 跑完）')
