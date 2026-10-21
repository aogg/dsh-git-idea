
/* ── 在终端/IDEA 里自己切了分支，对话框上的 chip 会跟着变吗？──

   主机侧「签名里必须能看出换了分支」由 gp34a 用真 git 证明（外部 `git switch`
   之后 `git/watch` 的签名确实不同）。这一节接上后半段：签名变了以后，chip 到底
   有没有重读、有没有换名字，以及什么时候它根本不该读。

   2026-10 推送化之后的新契约：浏览器侧不再有任何定时器轮询 —— 变化由宿主 WS
   推送（repo-changed）与事件驱动的一次性核对（live-open（重）连、页面回可见）
   发现。这里的「一拍」一律由 livePush({kind:'live-open'}) 触发；第一拍只记基线
   （不发 git/flush、监听者不被调），签名变了之后的下一拍才 flush + 通知。 */

const realCall = host.call
let watchSig = 'SIG-A'
host.call = function (method, args) {
  if (method === 'git/watch') {
    calls.push({ method: method, args: args })
    return Promise.resolve({ ok: true, repo: '/tmp/ws', sig: watchSig })
  }
  return realCall(method, args)
}

const labelOf = (tree) => {
  const span = byClass(tree, 'dsh-git-chip-label')[0]
  return span === undefined ? '' : textOf(span)
}
/* 活着的 interval 定时器：推送化之后 watcher 一条都不该排（变更页整树重读的时钟
   是另一件事，本套件不开变更页）。 */
const lanes = () => timers.filter((t) => t.kind === 'interval' && t.dead !== true)
/* 推进假时钟：把活着的 interval 全都摇 N 拍 —— 旧世界每一拍都会问一次签名，
   新世界一拍都不该问。 */
const beatClock = (n) => { for (let i = 0; i < (n || 3); i += 1) lanes().forEach((t) => t.cb()) }
/* 一拍核对：live-open（（重）连上）触发的一次性 watcherTickAll（98-register.js）。 */
const beat = async () => { livePush({ kind: 'live-open' }); await wait(30) }
const since = (mark) => calls.slice(mark)
const methodsSince = (mark) => since(mark).map((c) => c.method)

console.log('')
console.log('=== 手动切分支之前：挂载不排任何轮询，时钟走了也不问 ===')
const first = await chipTree()
ok('chip 显示当前分支 main', labelOf(first) === 'main')
ok('chip 不再注册任何轮询定时器（watcher 推送化，没有快慢车道）', lanes().length === 0)
let mark = calls.length
beatClock(6)
await wait(30)
ok('假时钟摇了 6 拍，一次 git/watch 都没有（任何时刻都没有定时器触发的核对）',
  since(mark).filter((c) => c.method === 'git/watch').length === 0)
ok('时钟空转也没有惊动数据读', methodsSince(mark).indexOf('git/panel') < 0)

mark = calls.length
await beat()
const watchArgs = since(mark).filter((c) => c.method === 'git/watch').map((c) => c.args)
ok('live-open 的一拍核对：只记基线，不白读一遍数据', methodsSince(mark).indexOf('git/panel') < 0)
ok('核对问的是廉价签名，不带 deep（慢盘上 deep 是秒级）',
  watchArgs.length === 1 && watchArgs[0].deep === undefined && watchArgs[0].sessionId === 's-1')

console.log('')
console.log('=== 外面切了分支（repo-changed 丢在断线期，live-open 补核对） ===')
mark = calls.length
watchSig = 'SIG-B'
OK_PANEL.branch = 'release/2.0'
await beat()
await wait(30)
const moved = await chipTree()
ok('签名变了 → chip 换成新分支 release/2.0', labelOf(moved) === 'release/2.0')
const seq = methodsSince(mark)
ok('先 flush 主机缓存，再重读（否则读到的还是缓存里的旧分支）',
  seq.indexOf('git/flush') >= 0 && seq.indexOf('git/flush') < seq.indexOf('git/panel'))
/* 一次 bump 之后最多两次读：先身份（0.15s），再只问上次那些脏路径（0.2s）。
   整棵树那一次不在这条路上 —— 它在这台机器上 8–10s，而且占住整条通道。
   （这份快照在这个套件里是「干净的」，所以第二次是全树读；见下一节。） */
ok('重读走的是先便宜、再只问那些路径那两段，不是一整条状态读',
  seq.filter((m) => m === 'git/panel').length === 2)

console.log('')
console.log('=== 签名没变：再核对几拍也一次都不该读 ===')
mark = calls.length
await beat()
await beat()
ok('仓库没动就不重读（核对是核对，重读只在签名变了之后）', methodsSince(mark).indexOf('git/panel') < 0)
ok('没动的时候 flush 也不会发', methodsSince(mark).indexOf('git/flush') < 0)

console.log('')
console.log('=== 面板打开之后：同一拍核对同时喂饱面板与 chip ===')
await openPanel()
/* 面板开着（历史页）也不该多出任何轮询定时器：变化只由推送与事件核对发现。 */
ok('面板开着也没有新增轮询定时器', lanes().length === 0)
mark = calls.length
watchSig = 'SIG-C'
OK_PANEL.branch = 'main'
await beat()
await wait(40)
const back = await settle()
ok('面板开着时切回去，chip 与面板同时跟上', labelOf(await chipTree()) === 'main' && textOf(back).indexOf('main') >= 0)
ok('事件核对发现变化也仍然先 flush', methodsSince(mark).indexOf('git/flush') >= 0)

console.log('')
console.log('=== 页面被切到后台，再切回来 ===')
fakeDoc.hidden = true
mark = calls.length
await beat()
await wait(30)
ok('页面在后台时连事件核对也跳过（藏着不读）', methodsSince(mark).filter((c) => c.method === 'git/watch').length === 0)
beatClock(4)
await wait(20)
ok('后台空转时钟也不产生任何核对（没有轮询兜底）',
  methodsSince(mark).filter((c) => c.method === 'git/watch').length === 0)
watchSig = 'SIG-D'
OK_PANEL.branch = 'release/3.1'
fakeDoc.hidden = false
mark = calls.length
fakeDoc.fire('visibilitychange')
await wait(40)
ok('切回页面立刻对一次签名（回可见触发的一轮 tickAll）', methodsSince(mark).indexOf('git/watch') >= 0)
ok('对完发现仓库动了，chip 立刻跟上', labelOf(await chipTree()) === 'release/3.1')
mark = calls.length
fakeDoc.fire('visibilitychange')
await wait(40)
ok('仓库没动时切回来也不会白读一遍', methodsSince(mark).indexOf('git/panel') < 0)

/* ── chip 上的未提交数量：便宜的第一次读回来时不能消失 ──

   面板与 chip 都是两段读：先 0.15 秒的身份读（`partial`，**不带工作区**），
   再 7 秒的完整读。把 `partial` 的「没有改动列表」当成「没有改动」，就会在
   每次仓库动过之后把徽标抹掉，几秒后才补回来 —— 用户看到的就是「数量消失，
   过一会才出来」。这一节盯住那个瞬间。 */

console.log('')
console.log('=== 核对发现变化之后，未提交数量不许先消失 ===')
const beforePanel = host.call
let fullPending = 3
let fullGate = null
const panelCalls = []
host.call = function (method, args) {
  if (method === 'git/panel') {
    panelCalls.push(args)
    const head = { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, sequencer: null }
    if (args != null && args.quick === true) {
      return Promise.resolve(Object.assign({ partial: true, staged: [], unstaged: [], untracked: [], unmerged: [] }, head))
    }
    const items = []
    for (let i = 0; i < fullPending; i += 1) items.push({ path: 'f' + i + '.txt', code: ' M' })
    const reply = Object.assign({ staged: [], unstaged: items, untracked: [], unmerged: [] }, head)
    if (fullGate !== null) return new Promise(function (resolve) { fullGate = resolve.bind(null, reply) })
    return Promise.resolve(reply)
  }
  return beforePanel(method, args)
}
const badgeOf = (tree) => byClass(tree, 'dsh-git-badge')
const badgeText = (tree) => (badgeOf(tree)[0] === undefined ? '' : textOf(badgeOf(tree)[0]))
const badgeClass = (tree) => (badgeOf(tree)[0] === undefined ? '' : String(badgeOf(tree)[0].props.className))

const s2 = await renderUntilStable(makeElement(chip, { sessionId: 's-2' }), 'chip-s2')
ok('第一次完整读之后徽标显示 3', badgeText(s2) === '3' && !/stale/.test(badgeClass(s2)))

watchSig = 'SIG-E'
/* 把完整读按住，才看得见中间那一刻 —— 在真机上那一段是 7 秒，在测试里是 0 微秒 */
fullGate = true
await beat()
await wait(40)
const during = await renderUntilStable(makeElement(chip, { sessionId: 's-2' }), 'chip-s2')
ok('便宜的第一次读回来后徽标还在，没有先掉到 0', badgeText(during) === '3')
ok('但它被标成「还没核对」（半透明）', /dsh-git-badge-stale/.test(badgeClass(during)))
ok('tooltip 说的是正在核对，不会谎称工作区干净',
  String(during.props.title).indexOf('正在核对') >= 0)

const release2 = fullGate
fullGate = null
release2()
await wait(40)
const settled3 = await renderUntilStable(makeElement(chip, { sessionId: 's-2' }), 'chip-s2')
ok('完整读回来之后同一个数字转正（去掉半透明）', badgeText(settled3) === '3' && !/stale/.test(badgeClass(settled3)))

/* 换会话：这个会话是第一次来，自己的完整读还没回来 */
fullGate = true
watchSig = 'SIG-F'
const s3 = await renderUntilStable(makeElement(chip, { sessionId: 's-3' }), 'chip-s3')
ok('新会话的第一眼就带着这个仓库上次的数字（不空着）', badgeText(s3) === '3')
ok('而且是「还没核对」的样子', /dsh-git-badge-stale/.test(badgeClass(s3)))
const release = fullGate
fullGate = null
release()
await wait(40)
const s3done = await renderUntilStable(makeElement(chip, { sessionId: 's-3' }), 'chip-s3')
ok('它自己的完整读回来后就转正了', badgeText(s3done) === '3' && !/stale/.test(badgeClass(s3done)))

/* 提交干净之后：数字该变成「没有徽标」，而且不再是核对中的样子 */
fullPending = 0
watchSig = 'SIG-G'
await beat()
await wait(60)
const clean = await renderUntilStable(makeElement(chip, { sessionId: 's-3' }), 'chip-s3')
ok('改动清零后徽标消失', badgeOf(clean).length === 0)
ok('tooltip 这时才说工作区干净', String(clean.props.title).indexOf('工作区干净') >= 0)

console.log('')
console.log('=== 一个页面里的两个会话：各自核对各自的工作区 ===')
/* 没有应用过仓库时，核对问的是「这个会话自己的工作区」，而每个面板和 chip 都是
   从这个状态开始的。按仓库路径当键的时候，这个状态只有一个条目：两个会话先后
   把自己的 id 写进去，最后一个赢 —— 另一个会话于是去核对别人的工作区，自己改
   了看不见，别人改了自己重读。键里带上会话，一拍核对就该问出两个 id。 */
const beforeTwo = calls.length
await renderUntilStable(makeElement('div', null,
  makeElement(chip, { sessionId: 's-A', key: 'a' }),
  makeElement(chip, { sessionId: 's-B', key: 'b' })), 'two-chips')
await beat()
await wait(40)
const askedSessions = since(beforeTwo).filter((c) => c.method === 'git/watch').map((c) => c.args.sessionId)
console.log('  这一轮问过的会话:', JSON.stringify(askedSessions))
ok('两个会话各问各的（不是同一个 id 问两遍）',
  askedSessions.indexOf('s-A') >= 0 && askedSessions.indexOf('s-B') >= 0)

console.log('')
console.log('=== 核对的监听者按「注册」记，不按「回调函数」记 ===')
/* chip 和面板要的是同一个回调（bumpData），而以回调为键的 Set 会把两次注册并成
   一条：先注销的那个把另一个的通知、以及以「还有没有人在看」为准的定时器一起带走。
   面板不再认为这是仓库时必然如此；只是关掉面板时，谁先谁后取决于浏览器里两个 slot
   root 的清理顺序，所以在真实使用里是「有时候」——面板反应过来了，对话框上的图标
   一直不动。两个 root 的清理顺序在 mock-React 里复现不出来，所以这条守源码。 */
const CLIENT_SRC = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
ok('每个注册有自己的键（token），注销只注销自己那一个',
  CLIENT_SRC.indexOf('entry.listeners.set(token, listener)') >= 0
  && CLIENT_SRC.indexOf('entry.listeners.delete(token)') >= 0
  && CLIENT_SRC.indexOf('entry.listeners.add(listener)') < 0
  && CLIENT_SRC.indexOf('entry.listeners.delete(listener)') < 0)
ok('通知时把每个注册的回调都调一遍',
  CLIENT_SRC.indexOf('entry.listeners.forEach(function (listener) { listener() })') >= 0)

console.log('')
console.log('=== 面板里打开另一个目录之后，chip 要看的是那个目录 ===')
/* chip 的读和核对都拿「会话自己的工作区」当入参，而这个入参以前不随面板里应用的
   目录变化：面板已经在新仓库上核对，chip 还在问一个不是仓库的目录，签名永远
   不变 —— 面板反应过来了，对话框上的图标一直不动。 */
/* 上面那一段把 host.call 换成了它自己的 git/panel 回答（都是「是仓库」）。这里
   再套一层：这个会话自己的工作区不是仓库，而面板里打开的目录是 —— 这正是用户在
   引导页上「打开这个目录」之后的状态。 */
const beforeSetup = host.call
const SETUP_REPLY = { ok: false, repo: '/tmp/applied', error: 'not-a-repository', reason: 'not-a-repo', stderr: '', staged: [], unstaged: [], untracked: [], unmerged: [] }
host.call = function (method, args) {
  if (method !== 'git/panel') return beforeSetup(method, args)
  if (args != null && args.repo === '/tmp/applied') return Promise.resolve(Object.assign({}, OK_PANEL, { repo: '/tmp/applied' }))
  if (args != null && args.repo !== undefined) return beforeSetup(method, args)
  return Promise.resolve(SETUP_REPLY)
}
const forSetup = await chipTree()
if (forSetup.props.className.indexOf('dsh-git-chip-open') < 0) { forSetup.props.onClick(); await wait(20) }
const notRepo = await settle('setup-again')
const openHere = byClass(notRepo, 'dsh-git-btn').find((b) => textOf(b) === '打开这个目录')
/* chip 是面板之外唯一会说这句话的地方。同一个「读不动」的状态有两种原因，而它们
   在屏幕上必须分开：目录里没有仓库，和这台机器上没有 git（见 92-chip 的那一串
   理由）。中文只在这里验一遍 —— 面板那一页在 gp40。 */
ok('（对照）reason 还是 not-a-repo 时，chip 说的是「这个目录不是 Git 仓库」',
  String(forSetup.props.title).indexOf('不是 Git 仓库') >= 0)
SETUP_REPLY.reason = 'no-git'
forSetup.props.onClick()
await wait(30)
const chipNoGitClosed = await chipTree()
chipNoGitClosed.props.onClick()
await wait(30)
const chipNoGit = await chipTree()
console.log('  没有 git 时 chip 的 tooltip:', JSON.stringify(String(chipNoGit.props.title).slice(0, 90)))
ok('机器上没有 git 时，chip 说的是找不到 git',
  String(chipNoGit.props.title).indexOf('这台机器上找不到 git') >= 0)
ok('chip 不再跟着首帧说「这个目录不是 Git 仓库」',
  String(chipNoGit.props.title).indexOf('不是 Git 仓库') < 0)

/* 「这个目录不是 Git 仓库」那一页是没有路径框的（路径不是问题，没什么可填的），
   所以 chip 也不能承诺「点击选择路径」—— 承诺一个点不到的东西比不承诺更坏。 */
ok('（对照）not-a-repo 时 chip 不再承诺「点击选择路径」',
  String(forSetup.props.title).indexOf('选择路径') < 0
  && String(forSetup.props.title).indexOf('点击查看') >= 0)

/* 第三种状态：连看哪个目录都还不知道（no-path，刚切会话那一瞬间就是这样）。
   那时要人填一个目录，说法也就得是「填」，不能说「这个目录不是仓库」。 */
SETUP_REPLY.reason = 'no-path'
chipNoGit.props.onClick()
await wait(30)
const chipNoPathOpen = await chipTree()
chipNoPathOpen.props.onClick()
await wait(30)
const chipNoPath = await chipTree()
console.log('  路径没定时 chip 的 tooltip:', JSON.stringify(String(chipNoPath.props.title).slice(0, 60)))
ok('路径没定时 chip 说的是「还没确定看哪个目录」',
  String(chipNoPath.props.title).indexOf('还没确定看哪个目录') >= 0)
ok('也不再说成「这个目录不是 Git 仓库」',
  String(chipNoPath.props.title).indexOf('不是 Git 仓库') < 0)
console.log('  引导页上有「打开这个目录」:', openHere !== undefined)
openHere.props.onClick()
await wait(30)
await chipTree()
mark = calls.length
await beat()
await wait(40)
const askedAfterApply = since(mark).filter((c) => c.method === 'git/watch').map((c) => c.args)
console.log('  chip 这一轮问的入参:', JSON.stringify(askedAfterApply))
ok('chip 核对的是面板里打开的那个目录', askedAfterApply.some((a) => a.repo === '/tmp/applied'))
