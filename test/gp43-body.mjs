/* ═══ gp43：机器上的 git，和它在网上做的事 ═══
   配置页的「全局配置」档（原先自己占 DSH 设置面板的一页，2026-10 起搬进面板）一直
   只有几样东西：插件自己的开关、本浏览器的外观，和读者真正会去那里找的三件事 ——
   我是谁（提交身份）、我用的是哪个 git（装在 PATH 之外时怎么办）、以及
   fetch / pull / push 到底带不带那几个参数。这个套件盯的就是这三块，加上它们唯一
   一处会动手的地方：推送没有上游的分支时，面板会不会自己把那一步走完。

   1. 提交身份：此刻生效的那一份（连来源一起）、缺哪一半、预填、写入时带的 scope
   2. 空框不写：`git config user.name ''` 正是那个错误的来路，面板不制造它
   3. git 位置：PATH 上的 / 设置里写的 / 写错了 / 一个都没有，四种话各不相同
   4. 远程同步：三个开关，以及「也就是」那行照着实参说
   5. 推送没有上游：开着就自己走完，关着就问一句；走完的那次不再重试

   两条关于这个骨架的注意（踩过）：同一个组件的两次渲染要用**同一个 label**，否则
   fiber 是新的、组件等于重新挂载（状态和 effect 都会重来）；而 `timer.timeout` 在这
   里只是被记下来，不会自己到点 —— 去抖的保存要手动推一下。 */

const configReply = function (over) {
  return Object.assign({
    ok: true, path: '/home/u/.dsh/dsh-git-idea.json',
    config: { initBranch: 'main', cherryPickRecord: false, gitPath: '', fetchPrune: true, pullRebase: false, pushSetUpstream: false },
  }, over)
}

const baseCall = host.call
const identityCalls = []
const identitySaves = []
const toolCalls = []
const configSaves = []
let configNow = configReply().config
let identityReply = {
  ok: true, repo: '/tmp/ws', insideRepo: true,
  name: 'Ada Lovelace', email: 'ada@example.com',
  nameOrigin: '/home/u/.gitconfig', emailOrigin: '/home/u/.gitconfig',
  globalName: 'Ada Lovelace', globalEmail: 'ada@example.com',
  needsIdentity: false, nameMissing: false, emailMissing: false,
}
let toolReply = { ok: true, configured: '', fromPath: true, path: '/usr/bin/git', version: 'git version 2.43.0', found: true, reason: '', platform: 'ok' }

host.call = function (method, args) {
  if (method === 'git/identity') { identityCalls.push(args); return Promise.resolve(identityReply) }
  if (method === 'git/identity-save') {
    identitySaves.push(args)
    return Promise.resolve({
      ok: true, scope: args.scope, written: ['user.name', 'user.email'],
      repo: args.scope === 'local' ? '/tmp/ws' : null,
      name: args.name, email: args.email,
      nameOrigin: args.scope === 'local' ? '.git/config' : '/home/u/.gitconfig', emailOrigin: '/home/u/.gitconfig',
      globalName: args.name, globalEmail: args.email, needsIdentity: false,
    })
  }
  if (method === 'git/toolchain') { toolCalls.push(args); return Promise.resolve(toolReply) }
  if (method === 'git/config') return Promise.resolve(configReply({ config: configNow }))
  if (method === 'git/config-save') { configSaves.push(args.config); configNow = args.config; return Promise.resolve(configReply({ config: args.config })) }
  return baseCall(method, args)
}

/* 全局配置这一档住在面板「配置」页里（80-panel.js 的作用域切换），进页走 harness
   的 openConfig；label 只留给渲染 trace，fiber 由它统一按 'pop' 管。 */
const sectionTree = async function (label) { return await openConfig('global', label) }
/* 去抖的保存靠这个推一下：骨架里的 timer 只被记下来。 */
const fireTimers = function () {
  timers.filter(function (t) { return t.kind === 'timeout' && t.dead !== true }).forEach(function (t) { t.cb() })
}
const rowTexts = function (t) { return byClass(t, 'dsh-git-set-row').map(function (r) { return textOf(r) }) }
const setRow = function (t, label) { return byClass(t, 'dsh-git-set-row').filter(function (r) { return textOf(r).indexOf(label) >= 0 })[0] }
const inputFor = function (t, label) {
  const row = setRow(t, label)
  return row === undefined ? undefined : collect(row).filter(function (n) { return n.type === 'input' })[0]
}
const inputByPlaceholder = function (t, placeholder) {
  return collect(t).filter(function (n) { return n.type === 'input' && n.props.placeholder === placeholder })[0]
}
const btnWith = function (t, label) { return buttons(t).filter(function (b) { return textOf(b) === label })[0] }
const warnText = function (t) { return byClass(t, 'dsh-git-warn').map(function (n) { return textOf(n) }).join(' | ') }
const effectiveRow = function (t) { return rowTexts(t).filter(function (x) { return x.indexOf('此刻生效') >= 0 })[0] || '' }

/* ── 1. 缺一半的时候说什么 ── */

console.log('')
console.log('== 配置页 · 全局配置 · 提交身份：缺哪一半 ==')
identityReply = Object.assign({}, identityReply, { needsIdentity: true, nameMissing: true, name: '', email: '', nameOrigin: '', emailOrigin: '', globalName: '', globalEmail: '' })
let st = await sectionTree('gp43-ident-missing')
console.log('  缺一半:', JSON.stringify(warnText(st)))
ok('缺名字时明说原因是它，并且说清后果',
  warnText(st).indexOf('还缺：名字') >= 0 && warnText(st).indexOf('提交会被 git 拒绝') >= 0)
ok('这一行是警告色', byClass(st, 'dsh-git-warn').length > 0)
ok('读的时候只把 session id 交给 Host（路径由它从会话解出来，仓库路径不归客户端猜）',
  identityCalls.length >= 1 && identityCalls[0].repo === undefined && identityCalls[0].sessionId === 's-1')

/* ── 2. 有身份时：值 + 来源、预填、写入 ── */

console.log('')
console.log('== 配置页 · 全局配置 · 提交身份：写进去 ==')
identityReply = {
  ok: true, repo: '/tmp/ws', insideRepo: true,
  name: 'Ada Lovelace', email: 'ada@example.com',
  nameOrigin: '/home/u/.gitconfig', emailOrigin: '.git/config',
  globalName: 'Ada Lovelace', globalEmail: 'ada@example.com',
  needsIdentity: false, nameMissing: false, emailMissing: false,
}
st = await sectionTree('gp43-ident')
console.log('  此刻生效:', JSON.stringify(effectiveRow(st)))
ok('「此刻生效」把值连来源一起说（来自哪个文件才有意义）',
  effectiveRow(st).indexOf('Ada Lovelace（来自 /home/u/.gitconfig）') >= 0
  && effectiveRow(st).indexOf('ada@example.com（来自 .git/config）') >= 0)
ok('两个输入框预填了此刻生效的那一份',
  String(inputFor(st, '名字').props.value) === 'Ada Lovelace'
  && String(inputFor(st, '邮箱').props.value) === 'ada@example.com')
ok('有身份时没有警告', byClass(st, 'dsh-git-warn').length === 0)
const radios = collect(st).filter(function (n) { return n.type === 'input' && n.props.type === 'radio' })
ok('写入范围默认是这台机器（--global），也就是 git 自己建议的那一条',
  radios.length === 2 && radios[0].props.checked === true && radios[1].props.checked === false)

inputFor(st, '邮箱').props.onChange({ target: { value: 'new@example.com' } })
await wait(5)
/* 同一次挂载里继续：草稿活在 fiber 上，重新开一页就会把它弄丢 —— 页内的重渲染
   走 settle（同一 fiber），只有换场景才用 sectionTree 的新挂载。 */
st = await settle('pop')
console.log('  改了邮箱，再点写入')
btnWith(st, '写入 git 配置').props.onClick()
await wait(20)
st = await settle('pop')
console.log('  写出去的:', JSON.stringify(identitySaves[0]))
ok('点一下就把两个值写出去，scope 是 global',
  identitySaves.length === 1 && identitySaves[0].scope === 'global'
  && identitySaves[0].name === 'Ada Lovelace' && identitySaves[0].email === 'new@example.com')
ok('写完之后页面把结果说出来（写到哪、写了哪两个字段）',
  rowTexts(st).join(' | ').indexOf('已写进这台机器的 git 配置') >= 0
  && rowTexts(st).join(' | ').indexOf('user.name') >= 0)

/* ── 3. 只对这个仓库：谁记着这个页面在哪个会话里 ── */

console.log('')
console.log('== 只对这个仓库 ==')
/* 面板本来就带着会话：sessionId 是 props 一路递进「全局配置」的提交身份组的，
   不必再借 chip 的记忆。先开一次新页（重新读身份），再在同一次挂载里切范围。 */
st = await sectionTree('gp43-ident')
collect(st).filter(function (n) { return n.type === 'input' && n.props.type === 'radio' })[1].props.onChange()
await wait(5)
st = await settle('pop')
const localBtn = btnWith(st, '写入 git 配置')
ok('切到「只对这个仓库」之后按钮仍然可按（这个会话有仓库）', localBtn !== undefined && localBtn.props.disabled !== true)
ok('这一行说得出「这个仓库」到底是哪个', rowTexts(st).join(' | ').indexOf('这个仓库 = /tmp/ws') >= 0)
localBtn.props.onClick()
await wait(20)
st = await settle('pop')
console.log('  第二次写出去的:', JSON.stringify(identitySaves[1]))
ok('本地 scope 带着 session id（Host 靠它解出仓库，也靠它选沙箱）',
  identitySaves.length === 2 && identitySaves[1].scope === 'local' && identitySaves[1].sessionId === 's-1')
ok('落点也换成了这个仓库', rowTexts(st).join(' | ').indexOf('已写进 /tmp/ws 的 .git/config') >= 0)

/* 不知道是哪个仓库时：那条路要关掉并说清，而不是猜一个路径往里写。 */
identityReply = Object.assign({}, identityReply, { repo: null, insideRepo: false })
st = await sectionTree('gp43-ident-nowhere')
console.log('  不知道仓库时:', JSON.stringify(rowTexts(st).filter(function (x) { return x.indexOf('还不知道') >= 0 })[0] || ''))
ok('不知道仓库时，页面上写着这件事', rowTexts(st).join(' | ').indexOf('还解不出仓库路径') >= 0)
/* 全局那一份仍然可以写（它不需要知道是哪个仓库）；要写本地就没有落点，按钮关掉。 */
ok('这时候全局那份照旧能写', btnWith(st, '写入 git 配置').props.disabled !== true)
collect(st).filter(function (n) { return n.type === 'input' && n.props.type === 'radio' })[1].props.onChange()
await wait(5)
st = await settle('pop')
ok('选「只对这个仓库」而不知道是哪个仓库时，按钮关掉（不猜一个路径往里写）',
  btnWith(st, '写入 git 配置').props.disabled === true)
identityReply = Object.assign({}, identityReply, { repo: '/tmp/ws', insideRepo: true })

/* ── 4. git 位置 ── */

console.log('')
console.log('== 配置页 · 全局配置 · git 位置 ==')
const toolRow = function (t) {
  return rowTexts(t).filter(function (x) {
    return x.indexOf('现在用的是') >= 0 || x.indexOf('不可用') >= 0 || x.indexOf('PATH 上没有 git') >= 0
  })[0] || ''
}
st = await sectionTree('gp43-tool')
console.log('  PATH 上:', JSON.stringify(toolRow(st)))
ok('默认说的是「用的是 PATH 上的那一个」，并带版本',
  toolRow(st).indexOf('现在用的是 /usr/bin/git（来自 PATH）') >= 0 && toolRow(st).indexOf('git version 2.43.0') >= 0)
ok('默认这一行不是警告色', byClass(st, 'dsh-git-warn').length === 0)

toolReply = { ok: true, configured: '', fromPath: true, path: '', version: '', found: false, reason: 'not-on-path', platform: 'ok' }
st = await sectionTree('gp43-tool-none')
console.log('  机器上没有:', JSON.stringify(toolRow(st)))
ok('PATH 上找不到 git 时说的是「装上它，或写一个绝对路径」',
  toolRow(st).indexOf('PATH 上没有 git') >= 0 && toolRow(st).indexOf('绝对路径') >= 0)
ok('这一行是警告色（读者要动手）', byClass(st, 'dsh-git-warn').length > 0)

toolReply = { ok: true, configured: '/opt/nope/git', fromPath: false, path: '', version: '', found: false, reason: 'configured-missing', platform: 'ok' }
st = await sectionTree('gp43-tool-bad')
console.log('  写错了:', JSON.stringify(toolRow(st)))
ok('写进去的路径不可用时，说的是「设置里写的这个路径不可用」，而不是「这台机器没有 git」',
  toolRow(st).indexOf('设置里写的这个路径不可用') >= 0 && toolRow(st).indexOf('PATH 上没有 git') < 0)

/* 改路径：去抖之后写进插件配置，同时立刻再检查一次「它到底能不能跑」。 */
toolReply = { ok: true, configured: '/usr/local/bin/git', fromPath: false, path: '/usr/local/bin/git', version: 'git version 2.44.0', found: true, reason: '', platform: 'ok' }
const pathBox = inputByPlaceholder(st, '留空 = 用 PATH 里的 git')
ok('有一个写路径的输入框', pathBox !== undefined)
const toolCallsBefore = toolCalls.length
pathBox.props.onChange({ target: { value: '/usr/local/bin/git' } })
await wait(5)
fireTimers()
await wait(20)
st = await sectionTree('gp43-tool-bad')
console.log('  存下来的 gitPath:', JSON.stringify(configSaves.length > 0 ? configSaves[configSaves.length - 1].gitPath : null))
ok('路径写进插件配置（跟着插件走，换浏览器也一致）',
  configSaves.length >= 1 && configSaves[configSaves.length - 1].gitPath === '/usr/local/bin/git')
ok('改完立刻又问了一次「它到底能不能跑」', toolCalls.length > toolCallsBefore)
ok('结果就显示在下面（写的就是它、版本是新的那个）',
  toolRow(st).indexOf('git version 2.44.0') >= 0 && toolRow(st).indexOf('设置里写的就是它') >= 0)

/* ── 5. 远程同步 ── */

console.log('')
console.log('== 配置页 · 全局配置 · 远程同步 ==')
const boxNamed = function (t, label) {
  const row = setRow(t, label)
  return row === undefined ? undefined : collect(row).filter(function (n) { return n.type === 'input' && n.props.type === 'checkbox' })[0]
}
const commandLine = function (t) { return rowTexts(t).filter(function (x) { return x.indexOf('也就是') >= 0 })[0] || '' }
st = await sectionTree('gp43-net')
const fetchBox = boxNamed(st, 'fetch 时删掉远端已经删了的远程分支')
const pullBox = boxNamed(st, 'pull 用 rebase')
const pushBox = boxNamed(st, '推送没有上游的分支时直接推上去')
ok('三个开关都在，而且默认值就是原来的行为',
  fetchBox !== undefined && fetchBox.props.checked === true
  && pullBox !== undefined && pullBox.props.checked === false
  && pushBox !== undefined && pushBox.props.checked === false)
console.log('  也就是:', JSON.stringify(commandLine(st)))
ok('「也就是」那行照着实参说：--prune、不加 --rebase、推送先问一句',
  commandLine(st).indexOf('git fetch --all --prune') >= 0 && commandLine(st).indexOf('git pull ·') >= 0
  && commandLine(st).indexOf('git push（没有上游时由面板问一句）') >= 0)

fetchBox.props.onChange({ target: { checked: false } })
await wait(5)
fireTimers()
await wait(20)
st = await sectionTree('gp43-net')
console.log('  关掉 prune:', JSON.stringify(commandLine(st)))
ok('关掉 prune：fetch 那行就不带它了', commandLine(st).indexOf('git fetch --all ·') >= 0)
ok('同一个插件配置里存下了 false', configSaves[configSaves.length - 1].fetchPrune === false)

boxNamed(st, 'pull 用 rebase').props.onChange({ target: { checked: true } })
await wait(5)
fireTimers()
await wait(20)
st = await sectionTree('gp43-net')
ok('打开 rebase：pull 那行带上 --rebase', commandLine(st).indexOf('git pull --rebase') >= 0)
ok('存下了 true', configSaves[configSaves.length - 1].pullRebase === true)

boxNamed(st, '推送没有上游的分支时直接推上去').props.onChange({ target: { checked: true } })
await wait(5)
fireTimers()
await wait(20)
st = await sectionTree('gp43-net')
console.log('  开了自动上游:', JSON.stringify(commandLine(st)))
ok('打开自动上游：那行说的是 push -u，而不是「由面板问一句」',
  commandLine(st).indexOf('git push -u <remote> <branch>') >= 0 && commandLine(st).indexOf('问一句') < 0)
ok('三个开关都进了同一个配置文件', configSaves[configSaves.length - 1].pushSetUpstream === true)

/* ── 6. 推送没有上游：自己走完，还是问一句 ── */

console.log('')
console.log('== 面板 · 推送没有上游 ==')
const pushCalls = []
let pushSetUpstream = false
const panelSaved = host.call
host.call = function (method, args) {
  if (method === 'git/push') {
    pushCalls.push(args)
    /* 第一次失败在 git 自己的那句话上；带上 -u 的那一次成功。 */
    if (args != null && args.setUpstream === true) return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
    return Promise.resolve({ ok: false, repo: '/tmp/ws', stdout: '', stderr: 'fatal: The current branch main has no upstream branch', exitCode: 128 })
  }
  if (method === 'git/refs') {
    return Promise.resolve({
      ok: true, repo: '/tmp/ws', current: ['main'], previous: '',
      local: [{ segments: ['main'], data: 'main' }],
      remote: [{ name: 'origin', remote: 'origin', refs: [{ segments: ['origin', 'main'], data: 'origin/main' }] }],
    })
  }
  if (method === 'git/config') return Promise.resolve(configReply({ config: Object.assign({}, configNow, { pushSetUpstream: pushSetUpstream }) }))
  return panelSaved(method, args)
}
/* 面板读的是内存里那份插件配置（usePluginConfig 只从 Host 拉一次），所以要改它得走
   全局配置自己那扇门：勾一下那个开关。这样「设了之后面板怎么做」测的就是真路径，而不是
   测试往内存里塞一个值。 */
const setPushSetting = async function (on) {
  const t = await sectionTree('gp43-net')
  const box = boxNamed(t, '推送没有上游的分支时直接推上去')
  box.props.onChange({ target: { checked: on } })
  await wait(5)
  fireTimers()
  await wait(20)
  await sectionTree('gp43-net')
}
/* 注意 label：`ready` 是弹层自己「开过一次」之后才为真的，而 fiber 是按 label 认的 ——
   换个 label 渲染就等于重新挂载，`git/refs` 不会发出去，横幅也就永远画不出来（第一版
   就是这么错的）。所以整段都留在 `openPanel` 用的那个 label 上。 */
const clickPush = async function () {
  const t = await openPanel()
  /* 前面的用例把面板留在了「配置」页；横幅画在历史页的正文里 —— 先切回历史再按 ↑。 */
  const logTab = buttons(t).find(function (b) { return textOf(b) === '历史' })
  if (logTab !== undefined && String(logTab.props.className).indexOf('dsh-git-tab-on') < 0) {
    logTab.props.onClick()
    await wait(10)
  }
  const t2 = await settle('pop')
  const btn = buttons(t2).filter(function (b) { return String(b.props.title).indexOf('push：推送当前分支') === 0 })[0]
  if (btn !== undefined) btn.props.onClick()
  await wait(30)
  return await settle('pop')
}

await setPushSetting(false)
let pushTree = await clickPush()
console.log('  关着:', JSON.stringify({ 次数: pushCalls.length, 横幅: textOf(pushTree).indexOf('推送并设为上游') >= 0 }))
ok('关着的时候只推一次，然后问一句（原来的行为没变）',
  pushCalls.length === 1 && pushCalls[0].setUpstream === undefined)
ok('横幅还在，读者可以自己按', textOf(pushTree).indexOf('推送并设为上游') >= 0)

pushCalls.length = 0
pushSetUpstream = true
await setPushSetting(true)
pushTree = await clickPush()
console.log('  开着:', JSON.stringify({
  次数: pushCalls.length,
  参数: pushCalls.map(function (a) { return a.setUpstream === true ? 'setUpstream' : 'plain' }),
  横幅: textOf(pushTree).indexOf('推送并设为上游') >= 0,
}))
ok('开着的时候自己走完那一步：第二次带着 -u、远端和分支',
  pushCalls.length === 2 && pushCalls[1].setUpstream === true
  && pushCalls[1].remote === 'origin' && pushCalls[1].branch === 'main')
ok('走完了就不用再问一句', textOf(pushTree).indexOf('推送并设为上游') < 0)
ok('没有第二次重试（-u 那次失败也不会再套一层）', pushCalls.filter(function (a) { return a.setUpstream === true }).length === 1)

host.call = panelSaved
