/* ── 一次「仓库动过了」之后，插件还要花多久才把队列排空 ──

   这条 RPC 通道一次只跑一个处理函数：一次全树 `git status` 在飞的时候，屏幕上每一次
   点击、另一块屏幕的每一次读，全都排在它后面。真机上量到的是（读者那个 /mnt/d 工作区、
   5093 个文件，全树 status 8.1s 冷）：

     面板开着，终端里提交一次 → 16 条请求，队列 21.3s 才排空，其中 13s 是**两次**全树读
     面板关着，同样一次           →  4 条请求，排空 11.1s，其中 10.6s 是 chip 那一次全树读

   屏幕上的样子就是「面板反应过来了，chip 还没」：面板那条 0.2s 的路径读排在 chip 那
   条 8–10s 的全树读后面。这个套件盯住四件事：

     1. 「工作区有几个改动」全局只有一份读数，面板量的和 chip 用的必须是同一份；
     2. 一次 bump 之后只问屏上那些路径（0.2s），整棵树不在那条路上；
     3. 整棵树有自己的时钟，间隔按上一次实测的代价来定（慢挂载上不再每 30 秒冻 8 秒）；
     4. 还没核对出来的时候，chip 说的是「正在核对」，不谎称「工作区干净」。

   时间在这里是可控的：`Date.now` 被换成一个由测试推的钟，所以「一次 8 秒的读」不用
   真的等 8 秒，「读数过期了」也不用真的等一分钟。读也一样 —— 组件重画才会跑 effect，
   所以每节都是「bump → 重画两块屏幕 → 再看它们发了什么」。 */

let clock = Date.now()
Date.now = function () { return clock }
const advance = function (ms) { clock += ms }

const realCall = host.call
let watchSig = 'SIG-1'
/* 一次全树读要花多久（毫秒，记在虚拟钟上）：0 表示立刻答复。 */
let slowFullMs = 0
/* 一次「只问几条路径」的读要花多久。真机上这个数会从 0.3s 跳到 6s —— 父目录那一层把
   旁边整棵大树扫进去的时候。 */
let slowPathsMs = 0
/* 把「不带头部快读」的答复按住，才看得见中间那一刻：面板和 chip 可能各按住一次。 */
let holdAll = false
const held = []
const releaseAll = function () {
  holdAll = false
  const list = held.splice(0)
  list.forEach((resolve) => resolve())
}
const head = { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, sequencer: null }
let work = { staged: [], unstaged: [], untracked: [], unmerged: [] }
const workWith = function (n) {
  const out = []
  for (let i = 0; i < n; i += 1) out.push({ path: 'f' + i + '.txt', code: ' M' })
  return { staged: [], unstaged: out, untracked: [], unmerged: [] }
}
const cleanWork = function () { return { staged: [], unstaged: [], untracked: [], unmerged: [] } }

host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    if (args != null && args.quick === true) {
      return Promise.resolve(Object.assign({ partial: true, staged: [], unstaged: [], untracked: [], unmerged: [] }, head))
    }
    const reply = Object.assign({}, head, work)
    if (holdAll === true) return new Promise(function (resolve) { held.push(function () { resolve(reply) }) })
    if (args != null && args.paths !== undefined && slowPathsMs > 0) {
      const cost = slowPathsMs
      return new Promise(function (resolve) { setTimeout(function () { clock += cost; resolve(reply) }, 5) })
    }
    if (slowFullMs > 0) {
      const cost = slowFullMs
      return new Promise(function (resolve) { setTimeout(function () { clock += cost; resolve(reply) }, 5) })
    }
    return Promise.resolve(reply)
  }
  if (method === 'git/watch') {
    calls.push({ method: method, args: args })
    return Promise.resolve({ ok: true, repo: '/tmp/ws', sig: watchSig })
  }
  return realCall(method, args)
}

const lanes = () => timers.filter((t) => t.kind === 'interval' && t.dead !== true)
const laneDelays = () => lanes().map((t) => t.delay).sort((a, b) => a - b)
const pendingTimeouts = () => timers.filter((t) => t.kind === 'timeout' && t.dead !== true)
const fireTimeouts = () => pendingTimeouts().forEach((t) => { t.dead = true; t.cb() })
/* 只推轮询那两条 lane（3 秒 / 5 秒）：面板那个「多久整棵树重来一遍」的时钟是另一件
   事 —— 它自己到点就会发一次全树读，测试要分开看这两件事。 */
const watcherLanes = () => lanes().filter((t) => t.delay <= 5000)
const tick = () => watcherLanes().forEach((t) => t.cb())
/* 第一个 tick 只记下签名（打开面板不白读一遍），第二个才看得见变化。 */
const bump = async function (sig) {
  tick()
  await wait(30)
  watchSig = sig
  tick()
  await wait(30)
}
const shape = (c) => (c.args != null && c.args.quick === true ? '身份'
  : (c.args != null && c.args.paths !== undefined ? '路径' + c.args.paths.length : '整树'))
const shapesSince = (mark) => calls.slice(mark).filter((c) => c.method === 'git/panel').map(shape)
const isPaths = (s) => s.indexOf('路径') === 0
const badgeOf = (tree) => byClass(tree, 'dsh-git-badge')
const badgeText = (tree) => (badgeOf(tree)[0] === undefined ? '' : textOf(badgeOf(tree)[0]))
const badgeClass = (tree) => (badgeOf(tree)[0] === undefined ? '' : String(badgeOf(tree)[0].props.className))
const titleOf = (tree) => String(tree.props.title)
const tabLabel = (tree) => {
  const tab = buttons(tree).find((b) => textOf(b).indexOf('变更') >= 0)
  return tab === undefined ? '' : textOf(tab)
}
/* 两块屏幕都重画一遍：在真页面上这件事是 bump 的通知自己做的，在测试里要人来推。 */
const repaint = async function () {
  const chipTreeNow = await renderUntilStable(makeElement(chip, { sessionId: 's-1' }), 'chip')
  const panelTree = await settle()
  await wait(60)
  return { chip: chipTreeNow, panel: panelTree }
}
const pathsRequests = (mark) => calls.slice(mark)
  .filter((c) => c.method === 'git/panel' && c.args != null && c.args.paths !== undefined)
  .map((c) => c.args.paths)
const clickIn = async function (tree, text) {
  const hit = buttons(tree).find((b) => textOf(b).indexOf(text) >= 0)
  if (hit === undefined) throw new Error('点不到「' + text + '」')
  hit.props.onClick()
  await wait(20)
}

console.log('')
console.log('=== 一个浏览器第一次看这个仓库 ===')
work = workWith(3)
let mark = calls.length
let tree = await repaint()
console.log('  chip 发的读:', JSON.stringify(shapesSince(mark)))
ok('没用过这个仓库 → chip 自己整棵树量一次', shapesSince(mark).indexOf('整树') >= 0)
ok('量出来的数字就在徽标上', badgeText(tree.chip) === '3')
ok('刚量完，不标「正在核对」', badgeClass(tree.chip).indexOf('stale') < 0)

console.log('')
console.log('=== 面板打开：它量出来的就是 chip 用的那一份 ===')
mark = calls.length
tree = await openPanel()
let seen = await repaint()
console.log('  打开的读:', JSON.stringify(shapesSince(mark)))
ok('面板打开只发一次整棵树（chip 不跟着再量一遍）',
  shapesSince(mark).filter((s) => s === '整树').length === 1)
ok('面板页签上那个数字也是 3', tabLabel(seen.panel) === '变更3')
ok('同一个数字也在 chip 上', badgeText(seen.chip) === '3')

console.log('')
console.log('=== 仓库在屏幕底下动过：只问屏上那些路径 ===')
work = workWith(2)
mark = calls.length
await bump('SIG-2')
seen = await repaint()
console.log('  bump 之后的读:', JSON.stringify(shapesSince(mark)))
ok('一次 bump 里没有整棵树读', shapesSince(mark).indexOf('整树') < 0)
/* 也不能只是「压后排队」：读数还新的时候，整棵树根本不该被安排。 */
ok('也没有把整棵树压在后面等着发', pendingTimeouts().some((t) => t.delay === 2000) !== true)
ok('问的是屏上那些路径', shapesSince(mark).filter(isPaths).length > 0)
ok('数字跟着变了', badgeText(seen.chip) === '2')

console.log('')
console.log('=== 在面板里提交：确认读也只有那些路径 ===')
await clickIn(seen.panel, '变更')
seen = await repaint()
console.log('  活跃轮询间隔:', JSON.stringify(laneDelays()))
ok('「变更」页开着，面板那个时钟才起，读得快时停在下限 30 秒', laneDelays().indexOf(30000) >= 0)
const box = collect(seen.panel).find((n) => n.type === 'textarea')
ok('变更页上有提交信息框', box !== undefined)
box.props.onChange({ target: { value: '提交这两个文件' } })
await wait(20)
seen = await repaint()
const commitBtn = byClass(seen.panel, 'dsh-git-primary')[0]
ok('变更页上有提交按钮', commitBtn !== undefined)
mark = calls.length
work = cleanWork()
commitBtn.props.onClick()
await wait(20)
seen = await repaint()
console.log('  提交之后的读:', JSON.stringify(shapesSince(mark)))
ok('提交的确认读是那些路径，不是整棵树',
  shapesSince(mark).indexOf('整树') < 0 && shapesSince(mark).filter(isPaths).length > 0)
ok('提交之后 chip 上的数字跟着清零（它自己一次都没量）',
  badgeText(seen.chip) === '' && titleOf(seen.chip).indexOf('工作区干净') >= 0)

console.log('')
console.log('=== 两次全树读之间的间隔按实测代价走 ===')
/* 让下一次全树读「花 8 秒」：真机上就是这个量级，而 30 秒一次的时钟等于每 30 秒
   冻住整条通道 8 秒。 */
slowFullMs = 8000
mark = calls.length
await clickIn(seen.panel, '⟳')
seen = await repaint()
console.log('  刷新按钮的读:', JSON.stringify(shapesSince(mark)))
ok('⟳ 是明确要求：整棵树重读一次', shapesSince(mark).indexOf('整树') >= 0)
console.log('  活跃轮询间隔:', JSON.stringify(laneDelays()))
/* 一次读量的代价越高，下一次来得越晚（8×8 起，上限 5 分钟）。这里同时有两条全树读
   在跑，所以量到的代价比 8 秒还大 —— 断言的是「不再是 30 秒那个下限」。 */
ok('这一次实测 8 秒，面板的时钟按倍数放大（不再是 30 秒）',
  laneDelays().indexOf(30000) < 0 && laneDelays().some((d) => d >= 64000))
/* 慢读只在这一节里用：留着的话后面每一次读都会「顺手」被算成慢读（虚拟钟是跳着走的）。 */
slowFullMs = 0

console.log('')
console.log('=== 上一次量出来是干净的，仓库又动过了 ===')
work = workWith(1)
advance(70000)
mark = calls.length
holdAll = true
await bump('SIG-3')
const mid = await repaint()
console.log('  中间态:', JSON.stringify(titleOf(mid.chip)))
ok('干净的那份读数不能继续当「现在也干净」用：立刻整棵树重读',
  shapesSince(mark).indexOf('整树') >= 0)
ok('还没量回来时说的是「正在核对」，不谎称干净', titleOf(mid.chip).indexOf('正在核对') >= 0)
releaseAll()
seen = await repaint()
ok('量回来之后数字出现', badgeText(seen.chip) === '1')

console.log('')
console.log('=== 有脏路径可以问时：整棵树压后 2 秒 ===')
advance(70000)
work = workWith(2)
mark = calls.length
await bump('SIG-4')
seen = await repaint()
console.log('  bump 之后的读:', JSON.stringify(shapesSince(mark)), ' 待决 timeout:',
  JSON.stringify(pendingTimeouts().map((t) => t.delay)))
ok('先发身份和路径读，整棵树不占这条路', shapesSince(mark).indexOf('整树') < 0)
ok('整棵树被压后 2 秒（让这次点击的反馈先走）', pendingTimeouts().some((t) => t.delay === 2000))
fireTimeouts()
await wait(40)
seen = await repaint()
ok('压后的那一次确实是整棵树', shapesSince(mark).indexOf('整树') >= 0)

console.log('')
console.log('=== 折叠目录那条不带父目录（否则旁边整棵树都要扫） ===')
/* git 把没跟踪的目录折叠成一条，而那条**本身就是自己的子树**：真机上量到的是
   7 条原始路径 280ms、把它们各自的父目录也带上（12 条）6138ms，多出来的全是
   `holox-modules` 那一条把所有兄弟目录都扫了一遍。 */
work = {
  staged: [],
  unstaged: [{ path: 'docs/pharma/方案.docx', code: ' M' }],
  untracked: [{ path: 'holox-modules/holox-as2/', code: '??' }],
  unmerged: [],
}
mark = calls.length
await clickIn(seen.panel, '⟳')
seen = await repaint()
await bump('SIG-6')
seen = await repaint()
const askedNow = pathsRequests(mark)
const lastAsked = askedNow[askedNow.length - 1]
console.log('  这一轮问过的路径:', JSON.stringify(lastAsked))
ok('折叠目录那一条问的是它自己', lastAsked.indexOf('holox-modules/holox-as2') >= 0)
ok('不再把它的父目录也带上（那是旁边整棵树）', lastAsked.indexOf('holox-modules') < 0)
ok('文件的父目录仍然带着（旁边新出现的文件要看得见）', lastAsked.indexOf('docs/pharma') >= 0)

console.log('')
console.log('=== 路径读本身很贵时：这个仓库收窄成只问那几条路径 ===')
slowPathsMs = 2000
advance(70000)
await bump('SIG-7')
await repaint()
slowPathsMs = 0
advance(70000)
mark = calls.length
await bump('SIG-8')
await repaint()
const narrowed = pathsRequests(mark)
const lastNarrow = narrowed[narrowed.length - 1]
console.log('  收窄之后问的路径:', JSON.stringify(lastNarrow))
ok('一次超时的路径读之后，请求里只剩那几条路径本身',
  lastNarrow !== undefined && lastNarrow.indexOf('docs/pharma') < 0
  && lastNarrow.indexOf('docs/pharma/方案.docx') >= 0
  && lastNarrow.indexOf('holox-modules/holox-as2') >= 0)

console.log('')
console.log('=== 同一个数字：面板页签和 chip ===')
work = workWith(2)
await bump('SIG-5')
seen = await repaint()
console.log('  变更页签:', JSON.stringify(tabLabel(seen.panel)), ' chip:', JSON.stringify(badgeText(seen.chip)))
ok('面板页签上的数字和 chip 上的徽标是同一个',
  tabLabel(seen.panel) === '变更2' && badgeText(seen.chip) === '2')

console.log('')
console.log('=== 多仓库：同名仓库的短名，和装它们的那个块 ===')
/* git/repos 的答复换成同名场景：最浅的 /tmp/ws/d 保裸名 d；/tmp/ws/c/d 补一层
   （c/d）；/tmp/ws/c/e/d 的第一层（e/d）被 /tmp/q/e/d 占了，再补一层（c/e/d）；
   不冲突的 other / ws 不动。扫描按会话只发一次，所以换新会话 s-2 去问。 */
let reposReply = {
  ok: true, workspace: '/tmp/ws',
  repos: ['/tmp/ws/c/e/d', '/tmp/ws/d', '/tmp/ws/c/d', '/tmp/q/e/d', '/tmp/ws/other'],
  manual: [], missing: [],
}
const realCallRepos = host.call
host.call = function (method, args) {
  if (method === 'git/repos') return Promise.resolve(reposReply)
  return realCallRepos(method, args)
}
const pop2 = async () => renderUntilStable(makeElement(popover, { sessionId: 's-2' }), 'pop2')
let multi = await pop2()
await wait(20)
multi = await pop2()
const switcherNames = (t) => byClass(t, 'dsh-git-repo-name').map(textOf)
const pickRow = (t, path) => byClass(t, 'dsh-git-repo-row').find((r) => String(r.props.key) === 'repo:' + path)
const rgroupNames = (t) => byClass(t, 'dsh-git-rgroup').map((g) => textOf(byClass(g, 'dsh-git-repo-name')[0]))
console.log('  切换器行:', JSON.stringify(switcherNames(multi)))
ok('仓库块是一个独立容器，不再和树行平铺在一起', byClass(multi, 'dsh-git-repo-box').length === 1)
ok('同名仓库：最浅的保裸名、其余最小扩展、还撞再补一层，不冲突的不动',
  switcherNames(multi).join('|') === '全部|c/e/d|d|c/d|e/d|other|ws|添加目录')
const repoRowsA = byClass(multi, 'dsh-git-repo-row').filter((r) => String(r.props.key).indexOf('repo:') === 0)
ok('每一行的悬浮 title 仍是完整路径',
  repoRowsA.length === 6 && repoRowsA.every((r) => String(r.props.title).indexOf(r.props.key.slice(5)) === 0))
const curRow = byClass(multi, 'dsh-git-repo-cur')[0]
ok('生效仓库行还是那个语义：● 加粗品牌色（dsh-git-repo-cur）',
  curRow !== undefined && textOf(curRow) === '●ws' && String(curRow.props.title).indexOf('/tmp/ws\n当前生效仓库') === 0)

console.log('  -- Ctrl 多选：两处分组头用同一套短名 --')
pickRow(multi, '/tmp/ws/c/e/d').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
pickRow(multi, '/tmp/ws/d').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
pickRow(multi, '/tmp/ws/c/d').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
console.log('  分支分组头:', JSON.stringify(rgroupNames(multi)))
ok('分支分组头和切换器行叫同一个名字', rgroupNames(multi).join('|') === 'c/e/d|d|c/d')
ok('分组头的 title 仍是完整路径', String(byClass(multi, 'dsh-git-rgroup')[0].props.title).indexOf('/tmp/ws/c/e/d') === 0)
ok('Ctrl 挑中的三个行有选中底色', byClass(multi, 'dsh-git-repo-sel').length === 3)

console.log('  -- 折叠：标题行仍看得出当前生效仓库 --')
byClass(multi, 'dsh-git-repo-head')[0].props.onClick()
multi = await pop2()
const foldedHead = textOf(byClass(multi, 'dsh-git-repo-head')[0])
ok('折叠后行收起，标题带着计数和 ● 短名',
  byClass(multi, 'dsh-git-repo-row').length === 0 && foldedHead.indexOf('仓库 6') >= 0 && foldedHead.indexOf('● ws') >= 0)
byClass(multi, 'dsh-git-repo-head')[0].props.onClick()
multi = await pop2()
ok('再点一下展开，行都回来', byClass(multi, 'dsh-git-repo-row').length === 7)

console.log('  -- 变更页侧栏：同一个块，选择态各自独立 --')
await clickIn(multi, '变更')
multi = await pop2()
const changesSide = byClass(multi, 'dsh-git-reposide')[0]
ok('变更页侧栏继承同一个容器', changesSide !== undefined && byClass(changesSide, 'dsh-git-repo-box').length === 1)
pickRow(multi, '/tmp/ws/c/d').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
pickRow(multi, '/tmp/ws/d').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
console.log('  变更分组头:', JSON.stringify(rgroupNames(multi)))
ok('变更分组头也是同一套短名（和分支树的选择互不干扰）', rgroupNames(multi).join('|') === 'c/d|d')

console.log('  -- 没有同名时与现状一致 --')
reposReply = {
  ok: true, workspace: '/tmp/ws',
  repos: ['/tmp/ws/alpha', '/tmp/ws/beta'],
  manual: ['/tmp/m/gone/x'], missing: ['/tmp/m/gone/x'],
}
let solo = await renderUntilStable(makeElement(popover, { sessionId: 's-3' }), 'pop3')
await wait(20)
solo = await renderUntilStable(makeElement(popover, { sessionId: 's-3' }), 'pop3')
console.log('  切换器行:', JSON.stringify(switcherNames(solo)))
ok('无同名时都是裸 basename', switcherNames(solo).join('|') === '全部|alpha|beta|ws|x|添加目录')
const goneRow = byClass(solo, 'dsh-git-repo-gone')[0]
ok('missing 行还在：压暗、写着已不存在、title 是完整路径',
  goneRow !== undefined && textOf(goneRow).indexOf('已不存在') >= 0 && String(goneRow.props.title).indexOf('/tmp/m/gone/x') === 0)
