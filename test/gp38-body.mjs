
/* ── IDEA 式子菜单：悬浮展开、离开收起、点 › 钉住 ── */

const fireTimers = () => {
  const live = timers.filter((t) => t.kind === 'timeout' && !t.dead)
  live.forEach((t) => { t.dead = true; t.cb() })
  return live.length
}
const flyPanel = (t) => byClass(t, 'dsh-git-bs-fly')[0]
const flyItems = (t) => {
  const fly = flyPanel(t)
  return fly === undefined ? [] : buttons(fly).map(textOf)
}
const flyHead = (t) => {
  const fly = flyPanel(t)
  return fly === undefined ? '' : textOf(byClass(fly, 'dsh-git-bs-fly-head')[0])
}
const listKids = (t) => {
  const list = byClass(t, 'dsh-git-bs-list')[0]
  return list === undefined ? 0 : (list.props.children || []).filter((c) => c != null && typeof c === 'object').length
}
const rowEnter = (t, name, top) => rowWith(t, name).props.onMouseEnter({ currentTarget: { offsetTop: top } })
const rowLeave = (t, name) => rowWith(t, name).props.onMouseLeave()

console.log('== 悬浮分支：子菜单出现在右侧，而不是把操作塞进列表 ==')
let t = await openSwitcher()
const kidsBefore = listKids(t)
ok('一开始没有子菜单', flyPanel(t) === undefined)
rowEnter(t, 'solo', 60)
await wait(10)
t = await settle('pop')
ok('悬浮先等一小会儿，不立刻弹（避免扫过列表时闪）', flyPanel(t) === undefined)
fireTimers()
await wait(10)
t = await settle('pop')
console.log('  子菜单 head:', JSON.stringify(flyHead(t)), ' 项:', JSON.stringify(flyItems(t)))
ok('延时到点后弹出子菜单', flyPanel(t) !== undefined)
ok('子菜单挂在列表之外（没有往列表里塞行）', listKids(t) === kidsBefore)
ok('子菜单标题是悬浮的那个分支', flyHead(t).indexOf('solo') >= 0)
ok('子菜单里是 IDEA 那套动作', flyItems(t).join('/') === '检出/从此分支新建分支…/合并到当前分支/删除')
ok('子菜单按行位置定位（offsetTop 60 → top 56px）', flyPanel(t).props.style.top === '56px')
ok('子菜单在卡片之内（点它不会被当成点外面）', byClass(t, 'dsh-git-bs').length === 1
  && collect(byClass(t, 'dsh-git-bs')[0]).indexOf(flyPanel(t)) >= 0)
ok('那一行被标成「子菜单属于我」', String(rowWith(t, 'solo').props.className).indexOf('dsh-git-bs-row-fly') >= 0)
ok('旧的整行操作条彻底没了', byClass(t, 'dsh-git-bs-acts').length === 0)

console.log('')
console.log('== 离开：先等一等，走进子菜单就取消关闭 ==')
rowLeave(t, 'solo')
await wait(5)
t = await settle('pop')
ok('刚离开还留着（给鼠标走向子菜单的时间）', flyPanel(t) !== undefined)
flyPanel(t).props.onPointerEnter()
fireTimers()
await wait(10)
t = await settle('pop')
ok('鼠标进了子菜单就不关了', flyPanel(t) !== undefined)
ok('进面板时把卡片自己的收起计时器也清掉了（不再有 200ms 的 hover 关闭在跑）',
  timers.filter((x) => x.kind === 'timeout' && !x.dead && x.delay === 200).length === 0)

/* 悬浮模式下卡片自己也有一个「离开就收起」的计时器：指针从行里走到面板上时，
   那个计时器也必须被取消，否则面板会在指针底下自己卸载，点击就落空了
   （这正是「点检出没反应」的成因，用模块级计时器的数量来验证）。 */
const hoverTimersBefore = () => timers.filter((x) => x.kind === 'timeout' && !x.dead && x.delay === 200).length
flyPanel(t).props.onPointerLeave()
fireTimers()
await wait(10)
t = await settle('pop')
ok('从子菜单离开后收起', flyPanel(t) === undefined)

console.log('')
console.log('== 悬浮卡片（hover 模式）：走到子菜单上不能把卡片弄没 ==')
/* 这一节复现用户报的「点检出没反应」：hover 模式的卡片自己有一个 pointerleave
   → 200ms 收起的计时器。指针从行里走到面板上时，只要那个计时器还在跑，卡片就会
   在指针底下卸载，点击落到空气上。 */
async function closePanel() {
  let t = await chipTree()
  if (t.props.className.indexOf('dsh-git-chip-open') >= 0) { t.props.onClick(); await wait(10) }
  return await chipTree()
}
await closePanel()
let chipTreeNow = await chipTree()
ok('面板已收起，卡片按钮是关的', chipTreeNow.props.className.indexOf('dsh-git-chip-open') < 0)
chipTreeNow.props.onPointerEnter()
fireTimers()
await wait(15)
let hover = await settle('pop')
ok('悬浮 chip 后出现 hover 卡片', byClass(hover, 'dsh-git-switch-hover').length === 1)
const hoverRows = byClass(hover, 'dsh-git-bs-row')
ok('hover 卡片里有分支行', hoverRows.length > 0)
hoverRows.find((r) => textOf(r).indexOf('solo') >= 0).props.onMouseEnter({ currentTarget: { offsetTop: 60 } })
fireTimers()
await wait(15)
hover = await settle('pop')
ok('hover 卡片里也弹出了子菜单', flyPanel(hover) !== undefined)
/* 模拟「指针离开卡片、然后进入子菜单」：卡片的收起计时器先安排上，子菜单的
   pointerenter 必须把它清掉。 */
byClass(hover, 'dsh-git-switch-hover')[0].props.onPointerLeave()
ok('离开卡片后有一个待收起的计时器', timers.filter((x) => x.kind === 'timeout' && !x.dead && x.delay === 200).length === 1)
flyPanel(hover).props.onPointerEnter()
ok('进入子菜单后那个计时器被清掉了', timers.filter((x) => x.kind === 'timeout' && !x.dead && x.delay === 200).length === 0)
fireTimers()
await wait(15)
hover = await settle('pop')
ok('因此卡片和子菜单都还在（点击才有落点）', byClass(hover, 'dsh-git-switch-hover').length === 1 && flyPanel(hover) !== undefined)
const hoverFly = flyPanel(hover)
ok('hover 卡片上的子菜单项可以点', buttons(hoverFly).length === 4)
calls.length = 0
buttons(hoverFly).find((b) => textOf(b) === '检出').props.onClick({ stopPropagation() {} })
await wait(15)
ok('点「检出」真的发出 git/checkout', calls.some((c) => c.method === 'git/checkout' && c.args.name === 'solo'))
checkoutReply = { ok: true, repo: '/tmp/ws', stashed: false, dirty: 0, popConflict: false, stdout: '', stderr: '', exitCode: 0 }

console.log('')
console.log('== 悬浮另一行会换成那一行的子菜单 ==')
t = await openSwitcher()
rowEnter(t, 'zeta', 120)
fireTimers()
await wait(10)
t = await settle('pop')
ok('换成了 zeta 的子菜单', flyHead(t).indexOf('zeta') >= 0)

console.log('')
console.log('== 点 › 钉住：鼠标移开也不收 ==')
const kidsNow = listKids(t)
const moreBtn = collect(rowWith(t, 'solo')).find((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dsh-git-bs-more') >= 0)
moreBtn.props.onClick({ stopPropagation() {}, currentTarget: { offsetTop: 60 } })
fireTimers()
await wait(10)
t = await settle('pop')
ok('点 › 打开 solo 的子菜单', flyHead(t).indexOf('solo') >= 0)
rowLeave(t, 'solo')
fireTimers()
await wait(10)
t = await settle('pop')
ok('钉住之后鼠标移开也不收', flyPanel(t) !== undefined)
ok('钉住时不会把 list 撑高', listKids(t) === kidsNow)
const moreBtn2 = collect(rowWith(t, 'solo')).find((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dsh-git-bs-more') >= 0)
moreBtn2.props.onClick({ stopPropagation() {}, currentTarget: { offsetTop: 60 } })
await wait(10)
t = await settle('pop')
ok('再点一次 › 收起', flyPanel(t) === undefined)

console.log('')
console.log('== 子菜单里的动作真的会发出去 ==')
rowEnter(t, 'solo', 60)
fireTimers()
await wait(10)
t = await settle('pop')
calls.length = 0
buttons(flyPanel(t)).find((b) => textOf(b) === '合并到当前分支').props.onClick({ stopPropagation() {} })
await wait(15)
ok('「合并到当前分支」发出 git/sequence merge', calls.some((c) => c.method === 'git/sequence' && c.args.op === 'merge' && c.args.target === 'solo'))
t = await settle('pop')
ok('执行后子菜单收起来', flyPanel(t) === undefined)

console.log('')
console.log('== 远端分支的子菜单 ==')
rowEnter(t, 'remote-only', 200)
fireTimers()
await wait(10)
t = await settle('pop')
console.log('  远端子菜单:', JSON.stringify(flyItems(t)), ' 头:', JSON.stringify(flyHead(t)))
ok('远端行给「检出为本地分支」', flyItems(t).indexOf('检出为本地分支') === 0)
ok('远端行不给删除', flyItems(t).every((i) => i.indexOf('删除') < 0))
ok('远端行也不给合并', flyItems(t).every((i) => i.indexOf('合并') < 0))
ok('子菜单头带完整 ref（多远端下认得出是谁家的分支）', flyHead(t).indexOf('origin/remote-only') >= 0)
/* 检出走显式形状（git switch -c remote-only --track origin/remote-only）：
   多远端下 DWIM 的短名切换会被 git 以 "'x' is ambiguous" 拒掉。让答复失败一次，
   卡片才不会在断言前自己收掉。 */
calls.length = 0
checkoutReply = { ok: false, repo: '/tmp/ws', stashed: false, dirty: 0, popConflict: false, stdout: '', stderr: "fatal: 'remote-only' is ambiguous", exitCode: 1 }
buttons(flyPanel(t)).find((b) => textOf(b) === '检出为本地分支').props.onClick({ stopPropagation() {} })
await wait(15)
ok('检出发出完整远端分支名 + asNewLocal',
  calls.some((c) => c.method === 'git/checkout' && c.args.name === 'origin/remote-only' && c.args.asNewLocal === true))
checkoutReply = { ok: true, repo: '/tmp/ws', stashed: false, dirty: 0, popConflict: false, stdout: '', stderr: '', exitCode: 0 }
t = await settle('pop')

console.log('')
console.log('== 当前分支的子菜单 ==')
rowEnter(t, 'main', 20)
fireTimers()
await wait(10)
t = await settle('pop')
console.log('  当前分支子菜单:', JSON.stringify(flyItems(t)), ' head:', JSON.stringify(flyHead(t)))
ok('当前分支不给检出', flyItems(t).every((i) => i.indexOf('检出') < 0))
ok('当前分支不给删除', flyItems(t).every((i) => i.indexOf('删除') < 0))
ok('当前分支仍能从这里新建分支', flyItems(t).some((i) => i.indexOf('从此分支新建分支') >= 0))
ok('子菜单标题标出「当前」', flyHead(t).indexOf('当前') >= 0)

console.log('')
console.log('== 点当前分支那一行也能钉住 ==')
rowEnter(t, 'zeta', 90)
fireTimers()
await wait(10)
t = await settle('pop')
const mainRow = rowWith(t, 'main')
mainRow.props.onClick({ stopPropagation() {}, currentTarget: { offsetTop: 26 } })
await wait(10)
t = await settle('pop')
ok('点当前分支行打开了它自己的子菜单', flyHead(t).indexOf('main') >= 0)
const mainRow2 = rowWith(t, 'main')
mainRow2.props.onClick({ stopPropagation() {}, currentTarget: { offsetTop: 26 } })
await wait(10)
t = await settle('pop')
ok('再点一次收起', flyPanel(t) === undefined)
rowLeave(t, 'main')
fireTimers()
await wait(5)
t = await settle('pop')

console.log('')
console.log('== 滚动列表会收起子菜单（它锚在行的屏幕位置上）==')
rowEnter(t, 'zeta', 90)
fireTimers()
await wait(10)
t = await settle('pop')
ok('滚动前是开着的', flyPanel(t) !== undefined)
byClass(t, 'dsh-git-bs-list')[0].props.onScroll()
await wait(10)
t = await settle('pop')
ok('滚动后收起', flyPanel(t) === undefined)

console.log('')
console.log('== 点了检出之后：卡片不能先把自己收掉（这是「点了没反应」的另一半）==')

/* 让 git/checkout 挂住，模拟慢盘上的一次真实切换 */
const plainCheckout = host.call
let held = null
host.call = function (method, args) {
  if (method === 'git/checkout' && held === null) {
    calls.push({ method, args })
    held = { args: args }
    return new Promise(function (resolve) { held.resolve = resolve })
  }
  return plainCheckout.call(host, method, args)
}

let slowChip = await chipTree()
if (slowChip.props.className.indexOf('dsh-git-chip-open') >= 0) { slowChip.props.onClick(); await wait(10) }
slowChip = await chipTree()
slowChip.props.onPointerEnter()
fireTimers()
await wait(15)
let slow = await settle('pop')
byClass(slow, 'dsh-git-bs-row').find((r) => textOf(r).indexOf('solo') >= 0).props.onMouseEnter({ currentTarget: { offsetTop: 60 } })
fireTimers()
await wait(15)
slow = await settle('pop')
const slowFly = flyPanel(slow)
ok('慢切换前：卡片与子菜单都在', byClass(slow, 'dsh-git-switch-hover').length === 1 && slowFly !== undefined)

calls.length = 0
buttons(slowFly).find((b) => textOf(b) === '检出').props.onClick({ stopPropagation() {} })
await wait(15)
slow = await settle('pop')
ok('点下去立刻说「正在切到 …」', textOf(slow).indexOf('正在切到') >= 0)
ok('请求确实发出去了', held !== null && held.args.name === 'solo')
/* 子菜单收起后指针就落在卡片外面了，卡片自己那个 200ms 收起计时器会开始跑 */
byClass(slow, 'dsh-git-switch-hover')[0].props.onPointerLeave()
fireTimers()
await wait(15)
const during = await settle('pop')
ok('切换还没回来时，卡片不会被自己收掉', byClass(during, 'dsh-git-switch-hover').length === 1)

/* 切换在飞的时候，输入框上的图标必须转起来 —— 卡片收起后就剩它是唯一看得见的东西 */
const spinningChip = await chipTree()
const spinClass = (tree) => collect(tree).filter((n) => n.type === 'svg' && String(n.props.className || '').indexOf('dsh-git-spin') >= 0)
console.log('  切换中 chip 上的 svg 类:', JSON.stringify(spinClass(spinningChip).map((n) => n.props.className)))
ok('切换在飞的时候，输入框上的分支图标在转', spinClass(spinningChip).length >= 1)
ok('chip 的 tooltip 说明了正在切到哪个分支', String(spinningChip.props.title).indexOf('正在切到 solo') >= 0)
const spinningPanel = byClass(during, 'dsh-git-branch-chip')
ok('面板头部那个分支 chip 也在转',
  spinningPanel.length === 1 && collect(spinningPanel[0]).some((n) => n.type === 'svg' && String(n.props.className || '').indexOf('dsh-git-spin') >= 0))

/* 现在让这次切换失败（工作区脏，正是最常见的失败） */
const pending = held
held = null
pending.resolve({
  ok: false, repo: '/tmp/ws', stashed: false, dirty: 1, popConflict: false,
  stdout: '', stderr: 'error: Your local changes to the following files would be overwritten by checkout:\n\tf.txt',
  exitCode: 1,
})
await wait(20)
const failedCard = await settle('pop')
ok('失败之后卡片仍在原地（错误不会被丢掉）', byClass(failedCard, 'dsh-git-switch-hover').length === 1)
ok('错误信息看得见', textOf(failedCard).indexOf('overwritten') >= 0)
ok('并且给出「先暂存再切」的补救按钮', buttons(failedCard).some((b) => textOf(b).indexOf('先暂存') >= 0))

/* 失败也要停下来：转个不停的图标比不转更糟 */
const stoppedChip = await chipTree()
ok('切换失败之后，图标停下来（不会一直转）', spinClass(stoppedChip).length === 0)

/* 成功那一路也要停：转个不停的图标和失败一样糟 */
let okTree = await settle('pop')
byClass(okTree, 'dsh-git-bs-row').find((r) => textOf(r).indexOf('zeta') >= 0).props.onMouseEnter({ currentTarget: { offsetTop: 60 } })
fireTimers()
await wait(15)
okTree = await settle('pop')
const okFly = flyPanel(okTree)
if (okFly !== undefined) buttons(okFly).find((b) => textOf(b) === '检出').props.onClick({ stopPropagation() {} })
await wait(15)
ok('成功那一路在飞的时候也转', spinClass(await chipTree()).length >= 1)
const holdOk = held
held = null
holdOk.resolve({ ok: true, repo: '/tmp/ws', stashed: false, dirty: 0, popConflict: false, stdout: 'Switched to branch zeta', stderr: '', exitCode: 0 })
await wait(25)
ok('切换成功之后图标停下来', spinClass(await chipTree()).length === 0)

/* 另一种失败：git 报的是 Permission denied，而真正的原因是文件沙箱不允许写这个
   仓库（.git/index.lock 建不出来）。读者得能分清「我的仓库坏了」和「沙箱不让写」。 */
let denied = null
host.call = function (method, args) {
  if (method === 'git/checkout') {
    calls.push({ method, args })
    return Promise.resolve({
      ok: false, repo: '/tmp/ws', stashed: false, dirty: 0, popConflict: false, sandboxDenied: true,
      stdout: '', stderr: "fatal: Unable to create '/mnt/d/work/idea_work/holox_cloud/.git/index.lock': Permission denied",
      exitCode: 1,
    })
  }
  return plainCheckout.call(host, method, args)
}
/* 上一步成功切换之后卡片已经收起，这里重新把它打开，再挑第一行可检出的分支 */
let deniedTree = await chipTree()
if (deniedTree.props.className.indexOf('dsh-git-chip-open') >= 0) { deniedTree.props.onClick(); await wait(10) }
deniedTree = await chipTree()
deniedTree.props.onPointerEnter()
fireTimers()
await wait(15)
deniedTree = await settle('pop')
const deniedRows = byClass(deniedTree, 'dsh-git-bs-row').filter((r) => String(r.props.className).indexOf('dsh-git-bs-action') < 0)
const deniedTarget = deniedRows.find((r) => textOf(r).indexOf('zeta') >= 0) || deniedRows[deniedRows.length - 1]
deniedTarget.props.onMouseEnter({ currentTarget: { offsetTop: 60 } })
fireTimers()
await wait(15)
deniedTree = await settle('pop')
const deniedRow = flyPanel(deniedTree)
if (deniedRow !== undefined) {
  buttons(deniedRow).find((b) => textOf(b) === '检出').props.onClick({ stopPropagation() {} })
  await wait(20)
  denied = await settle('pop')
}
console.log('  卡片里看到的错误:', JSON.stringify(textOf(denied === null ? deniedTree : denied).slice(0, 120)))
ok('沙箱拒绝时，卡片说的是沙箱不允许写，而不是仓库有问题',
  denied !== null && textOf(denied).indexOf('文件沙箱不允许写这个仓库') >= 0)
ok('git 的原话也还在（读者能自查）', denied !== null && textOf(denied).indexOf('index.lock') >= 0)
host.call = plainCheckout

/* 第三种失败：这台机器上根本没有 git。git 一个字都没说 —— bash 说的是
   "command not found"，而那是 shell 的话，不是仓库的话。读者要看到的是原因。 */
let nogit = null
host.call = function (method, args) {
  if (method === 'git/checkout') {
    calls.push({ method, args })
    return Promise.resolve({
      ok: false, repo: '/tmp/ws', stashed: false, dirty: 0, popConflict: false, noGit: true,
      stdout: '', stderr: 'bash: line 1: git: command not found', exitCode: 127,
    })
  }
  return plainCheckout.call(host, method, args)
}
let nogitTree = await chipTree()
if (nogitTree.props.className.indexOf('dsh-git-chip-open') >= 0) { nogitTree.props.onClick(); await wait(10) }
nogitTree = await chipTree()
nogitTree.props.onPointerEnter()
fireTimers()
await wait(15)
nogitTree = await settle('pop')
const nogitRows = byClass(nogitTree, 'dsh-git-bs-row').filter((r) => String(r.props.className).indexOf('dsh-git-bs-action') < 0)
const nogitTarget = nogitRows.find((r) => textOf(r).indexOf('zeta') >= 0) || nogitRows[nogitRows.length - 1]
nogitTarget.props.onMouseEnter({ currentTarget: { offsetTop: 60 } })
fireTimers()
await wait(15)
nogitTree = await settle('pop')
const nogitRow = flyPanel(nogitTree)
if (nogitRow !== undefined) {
  buttons(nogitRow).find((b) => textOf(b) === '检出').props.onClick({ stopPropagation() {} })
  await wait(20)
  nogit = await settle('pop')
}
const nogitText = textOf(nogit === null ? nogitTree : nogit)
const nogitAt = nogitText.indexOf('这台机器上找不到 git')
console.log('  没有 git 时卡片里那句话:', JSON.stringify(nogitAt < 0 ? '（没有）' : nogitText.slice(nogitAt, nogitAt + 60)))
ok('没有 git 时说的是机器上找不到 git，不是仓库有问题',
  nogit !== null && nogitText.indexOf('这台机器上找不到 git') >= 0)
ok('不再把 bash 的 command not found 丢给读者看', nogitText.indexOf('command not found') < 0)
host.call = plainCheckout

/* ── 一个提交都还没有的仓库：这张卡片不能承诺它兑现不了的事 ──

   这种仓库里 `git stash` 必然失败（"You do not have the initial commit yet"），
   所以「有 N 个未提交改动 —— 先暂存再切（切完自动恢复）」那一行不能出现；而「本地」
   那一组也不能只说「这个仓库还没有本地分支」—— chip 上明明写着 main。 */
const unbornSavedCall = host.call
const dirtyPanel = Object.assign({}, OK_PANEL, {
  untracked: [{ path: 'a.txt', code: '??' }, { path: 'b.txt', code: '??' }],
})
const switcherWith = async (branches, panel) => {
  host.call = function (method, args) {
    if (method === 'git/branches') return Promise.resolve(branches)
    if (method === 'git/panel') return Promise.resolve(panel)
    return unbornSavedCall.call(host, method, args)
  }
  /* 整棵重挂一次：卡片只在挂载时读分支表（之后靠版本号），不重挂就会拿上一份数据，
     测的就成了缓存。重挂之前它是关着的，重挂之后可能是开着的 —— 两种都要摆平。 */
  fibers.clear()
  await wait(20)
  let tree = await openPanel()
  if (byClass(tree, 'dsh-git-bs').length > 0) {
    byClass(tree, 'dsh-git-branch-chip')[0].props.onClick()
    await wait(10)
    tree = await settle()
  }
  tree = await openSwitcher()
  await wait(20)
  tree = await settle()
  host.call = unbornSavedCall
  return tree
}

const unbornCard = await switcherWith(
  { ok: true, repo: '/tmp/ws', current: 'main', previous: '', unborn: true, branches: [], remotes: [] },
  dirtyPanel)
const unbornCardText = textOf(unbornCard)
console.log('  还没有提交时卡片里:', JSON.stringify(unbornCardText.slice(0, 110)))
ok('说得出当前分支叫什么', unbornCardText.indexOf('当前在 main，还没有第一个提交') >= 0)
ok('不说成「这个仓库还没有本地分支」', unbornCardText.indexOf('这个仓库还没有本地分支') < 0)
ok('不留「先暂存再切」那一行（这里 git stash 一定失败）',
  byClass(unbornCard, 'dsh-git-bs-check').length === 0)

/* 负对照：普通仓库里那行还得在 —— 在那里 stash 是能用的，撤回它就是把能救人的路
   一起撤了。 */
const normalCard = await switcherWith(branchesReply, dirtyPanel)
console.log('  普通仓库里同一行:', JSON.stringify(textOf(byClass(normalCard, 'dsh-git-bs-check')[0]).slice(0, 60)))
ok('（对照）普通仓库里「先暂存再切」还在', byClass(normalCard, 'dsh-git-bs-check').length === 1)
ok('（对照）普通仓库也不会冒出 unborn 那句', textOf(normalCard).indexOf('还没有第一个提交') < 0)
