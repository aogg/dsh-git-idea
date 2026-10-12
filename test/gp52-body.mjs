/* ── 会话完成 → ↑ 待推送角标（客户端这一半）──
 *
 * 用户报的场景：agent 在仓库里提交了但没推，会话完成时面板「推送」按钮旁的待推送
 * 角标（ahead）没有刷新出来。这条链在 fixture 里一共五环：
 *
 *   chip 听 running 的 true→false 边沿（92-chip.js）→ 2 秒稳定窗 → completeRefresh：
 *   git/flush + markTreePartial + ringTreeReload + bumpData → 面板的 reloadAt 追上
 *   （开着当场追，关着等再打开那一帧追，80-panel.js 的 freshAt）→ loadWork 重发
 *   quick:true 的身份读 → 答复里的 ahead 写进 work → 工具条 ↑ 的 dsh-git-tool-badge
 *   与分支 chip 的 dsh-git-ab（'↑'+ahead）两处一起换数。
 *
 * 两节各钉一遍：面板开着（历史页）当场刷；面板关着→完成→再打开补刷。旧答复
 * ahead=0（角标不画）、新答复换数（两处都画出新值）。换答复的时机在完成之前 ——
 * 「agent 先提交、后会话完成」，重读拿到的就该是新答案。推送策略不动：
 * pushOnAllComplete 缺省 false，全程一个 git/push 都不许发。
 *
 * 会话状态 hook 用 gp49 那套假 props（真环境是 DSH 注入的 useSession /
 * useSessionStatus，桩按真契约「选择器进、选择器的返回值出」长牙）。 */

let quickAhead = 0
let workAhead = 0
const quickReply = function () {
  return { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: quickAhead, behind: 0, sequencer: null, partial: true, staged: [], unstaged: [], untracked: [], unmerged: [] }
}
const workReply = function () {
  return { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: workAhead, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] }
}
const pushCalls52 = []
const realCall52 = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    if (args != null && args.quick === true) return Promise.resolve(quickReply())
    return Promise.resolve(workReply())
  }
  if (method === 'git/push') { calls.push({ method: method, args: args }); pushCalls52.push(args); return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 }) }
  if (method === 'git/command-log') {
    calls.push({ method: method, args: args })
    return Promise.resolve({ ok: true, sessionId: args != null ? args.sessionId : '', commands: [], truncated: false, warning: '' })
  }
  return realCall52(method, args)
}

const callsOf52 = function (mark, method) { return calls.slice(mark).filter((c) => c.method === method) }
const quickReadsAfter = function (mark) { return callsOf52(mark, 'git/panel').filter((c) => c.args != null && c.args.quick === true) }
const fireTimers52 = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}
/* 「待推送」三处里在面板上的两处：工具条 ↑ 的角标、分支 chip 的 ↑N。 */
const pushToolBadges = (t) => byClass(t, 'dsh-git-tool-badge')
const branchChipMarks = (t) => byClass(t, 'dsh-git-ab')
const chipClose52 = async function () {
  const t = await chipTree()
  if (String(t.props.className).indexOf('dsh-git-chip-open') >= 0) { t.props.onClick(); await wait(20) }
  return await settle()
}

console.log('')
console.log('=== 会话完成 → ↑ 角标：面板开着（历史页）当场刷 ===')
let running52 = false
const status52 = new Map([['s-1', { running: false }]])
const hooks52 = {
  useSession: function (sel) { return sel({ running: running52 }) },
  useSessionStatus: function (sel) { return sel(status52) },
}
const renderChip52 = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-1' }, hooks52)), 'chip-52')
await renderChip52()
let tree = await openPanel()
tree = await settle()
/* 旧答复 ahead=0：两处都不画角标（负对照 —— 角标的出现必须是新答复带出来的）。 */
ok('完成前（旧答复 ahead=0）：工具条 ↑ 没有角标，分支 chip 没有 ↑N',
  pushToolBadges(tree).length === 0 && branchChipMarks(tree).length === 0)

/* agent 提交落地：仓库 ahead 变 2（会话还在跑，此刻谁都没 bump）。 */
quickAhead = 2
workAhead = 2
running52 = true
await renderChip52()
running52 = false
let mark52 = calls.length
await renderChip52()
ok('边沿后先不发：2 秒稳定窗没走完，quick 读一次都没重发', quickReadsAfter(mark52).length === 0)
fireTimers52(2000)
await wait(30)
tree = await settle()
ok('完成那一刷：git/flush 重发了（会话本身 + 工作区仓库）',
  callsOf52(mark52, 'git/flush').length >= 2)
ok('面板重发了 quick:true 的身份读（完成触发的重读，不是别的刷新时机）',
  quickReadsAfter(mark52).length >= 1)
ok('工具条 ↑ 的角标显示新答复的 ahead=2', pushToolBadges(tree).some((n) => textOf(n) === '2'))
ok('分支 chip 显示 ↑2', branchChipMarks(tree).some((n) => textOf(n) === '↑2'))
ok('完成刷新不推送：一个 git/push 都没发（pushOnAllComplete 缺省 false）', pushCalls52.length === 0)

console.log('')
console.log('=== 会话完成 → ↑ 角标：面板关着时完成，再打开补刷 ===')
await chipClose52()
tree = await settle()
/* 关着时面板读一个不发（freshAt 冻结的既有规矩）。 */
mark52 = calls.length
await chipClose52()
await settle()
ok('面板关着：完成前这一停不发任何面板读', callsOf52(mark52, 'git/panel').length === 0)

quickAhead = 0
workAhead = 0
/* 换一把新 chip（新边沿）：上一节的 running 边沿已经烧掉了。 */
let running53 = false
const hooks53 = {
  useSession: function (sel) { return sel({ running: running53 }) },
  useSessionStatus: function (sel) { return sel(status52) },
}
const renderChip53 = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-1' }, hooks53)), 'chip-53')
await renderChip53()
/* agent 又提交了（ahead 0 → 5），会话在面板关着时完成。 */
quickAhead = 5
workAhead = 5
running53 = true
await renderChip53()
running53 = false
mark52 = calls.length
await renderChip53()
fireTimers52(2000)
await wait(30)
ok('面板关着的那一刷：flush 照发，但面板读一个不发（freshAt 冻结）',
  callsOf52(mark52, 'git/flush').length >= 2 && callsOf52(mark52, 'git/panel').length === 0)
mark52 = calls.length
tree = await openPanel()
tree = await settle()
ok('再打开：面板补发了 quick:true 的身份读', quickReadsAfter(mark52).length >= 1)
ok('工具条 ↑ 的角标显示新答复的 ahead=5', pushToolBadges(tree).some((n) => textOf(n) === '5'))
ok('分支 chip 显示 ↑5', branchChipMarks(tree).some((n) => textOf(n) === '↑5'))
ok('完成补刷也不推送', pushCalls52.length === 0)
