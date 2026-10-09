/* ── 面板「配置」页与会话完成监听（客户端这一半）──
 *
 * 盯四件事：
 *   1. 配置页：顶栏第 4 个页签进得去；三个分组（会话完成 / 提交身份 / 换行符）画得
 *      对 —— placeholder 说全局那份的值、此刻生效带来源、缺身份时红色警告；「写入
 *      本项目」空框一个字节不发（set 里没有空键），「清掉覆盖」unset 的正是填过的
 *      键；换行下拉选中即写、选「跟随全局」即 unset；
 *   2. 会话完成刷新：本会话 running 的 true→false 边沿（初始挂载不算）起 2 秒稳定
 *      窗，期间恢复运行就取消；开跑时逐仓库 git/flush + 整树重读；页面藏着时跳过；
 *      开关关了就一分钱不花；
 *   3. 全部完成推送：从「至少一个在跑」跌到「零个在跑」起 5 秒稳定窗（无关的状态
 *      翻动不重置窗口、恢复运行就取消）；只推领先且无冲突的仓库；失败带 upstream
 *      且设置开了 push -u 时按 runOp 的老路补一次 setUpstream 推送，之后不再重试；
 *   4. 铃与命令页：chip 那一刷让面板的下一读变成整树（needFull 被铃立起来）；命令
 *      页开着时跟着 freshAt 重读、切走再切回不重读。6aede2c 把读数改成「弹窗打开即
 *      后台预读、之后所有刷新走后台增量合并」之后，这里接着钉：藏着不发读、打开
 *      即预读（不等切页）、重读在飞不清列表、按行身份合并不重行、展开跟着行走、
 *      没有-id 的会话行跨两次读 key 稳定、刷新失败列表保留错误挂列表上方、liveBus
 *      的 cmdlog-start 对答复里已有的行不再两行。
 *
 * 会话状态用假的 hook props（真环境里是 DSH 注入的 useSession / useSessionStatus，
 * 见 92-chip.js 顶部注释）。桩按真契约补演 dsh-client-ui-renderer 的选择器 hook：
 * hook 收一个选择器、回「选择器(快照)」的结果 —— 2026-10-09 的 chip 消失就是插件
 * 不传选择器直接调 useSessionStatus()，在真 shell 里渲染期 TypeError 挂掉整个
 * chip，而这里的桩当时照着插件的错误用法写，测试全绿也看不出来；「不传选择器就
 * 抛」这条现在由 strictStatusHooks 一组钉住。bridge 版（props 缺席）安静不启用
 * 那条也在覆盖里。 */

let projectReply = {
  ok: true, repo: '/tmp/ws', insideRepo: true,
  config: {
    'user.name': { local: '', global: 'Ada Lovelace', effective: 'Ada Lovelace', localOrigin: '', globalOrigin: '/home/u/.gitconfig', effectiveOrigin: '/home/u/.gitconfig' },
    'user.email': { local: '', global: 'ada@example.com', effective: 'ada@example.com', localOrigin: '', globalOrigin: '/home/u/.gitconfig', effectiveOrigin: '/home/u/.gitconfig' },
    'core.autocrlf': { local: 'input', global: '', effective: 'input', localOrigin: '.git/config', globalOrigin: '', effectiveOrigin: '.git/config' },
    'core.eol': { local: '', global: 'native', effective: 'native', localOrigin: '', globalOrigin: '/home/u/.gitconfig', effectiveOrigin: '/home/u/.gitconfig' },
  },
}
let configReply = { ok: true, path: '/home/u/.dsh/dsh-git-idea.json', config: { initBranch: 'main', cherryPickRecord: false, pushSetUpstream: true } }
let panelReply = null
/* 推送的答复做成可换的行为：默认一推就成；「没有上游」那节换成第一推失败、
   带 setUpstream 的补推成功 —— 断言看的是补推请求的形状与次数。 */
let pushBehavior = function () { return { ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 } }
const refsReply = { ok: true, repo: '/tmp/ws', current: ['main'], local: [], remote: [{ name: 'origin', refs: [] }] }
const saveCalls = []
const pushCalls = []
/* 命令页的答复可换可扣：cmdLogReply 非 null 时一次性换掉下一次 git/command-log 的
   答复（用完回默认那份）；cmdLogHold 非 null 时把那一次的答复扣住不放，resolve 塞进
   cmdLogHold.done —— 「读在飞期间屏上长什么样」只有扣得住答复才看得见。 */
let cmdLogReply = null
let cmdLogHold = null
const realCall = host.call
/* 与 host 侧 projectConfigSave 同一条「写后回读」的约定：答复 = 新快照 + written/unset。 */
const fakeSave = function (args) {
  saveCalls.push(args)
  const next = JSON.parse(JSON.stringify(projectReply.config))
  const written = []
  const unset = []
  if (args != null && args.set != null) {
    for (const key of Object.keys(args.set)) {
      if (next[key] === undefined) continue
      next[key] = Object.assign({}, next[key], { local: args.set[key], effective: args.set[key], effectiveOrigin: '.git/config', localOrigin: '.git/config' })
      written.push(key)
    }
  }
  if (Array.isArray(args != null ? args.unset : null)) {
    for (const key of args.unset) {
      if (next[key] === undefined) continue
      next[key] = Object.assign({}, next[key], { local: '', localOrigin: '', effective: next[key].global, effectiveOrigin: next[key].globalOrigin })
      unset.push(key)
    }
  }
  projectReply = Object.assign({}, projectReply, { config: next })
  return Promise.resolve(Object.assign({ written: written, unset: unset }, projectReply))
}
host.call = function (method, args) {
  if (method === 'git/project-config') { calls.push({ method: method, args: args }); return Promise.resolve(projectReply) }
  if (method === 'git/project-config-save') return fakeSave(args)
  if (method === 'git/config') { calls.push({ method: method, args: args }); return Promise.resolve(configReply) }
  if (method === 'git/push') { calls.push({ method: method, args: args }); pushCalls.push(args); return Promise.resolve(pushBehavior(args)) }
  if (method === 'git/refs') { calls.push({ method: method, args: args }); return Promise.resolve(refsReply) }
  if (method === 'git/command-log') {
    calls.push({ method: method, args: args })
    if (cmdLogHold !== null) {
      const hold = cmdLogHold
      cmdLogHold = null
      return new Promise(function (resolve) { hold.done = resolve })
    }
    const reply = cmdLogReply
    cmdLogReply = null
    if (reply !== null) return Promise.resolve(reply)
    return Promise.resolve({ ok: true, sessionId: args != null ? args.sessionId : '', commands: [{ id: 'a', time: Date.now(), command: 'git status', desc: '', source: 'session', exitCode: 0 }], truncated: false, warning: '' })
  }
  if (method === 'git/panel' && panelReply !== null) { calls.push({ method: method, args: args }); return Promise.resolve(panelReply) }
  return realCall(method, args)
}

const clickText = async function (tree, label) {
  const hit = buttons(tree).find((b) => textOf(b).indexOf(label) >= 0)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
}
const callsOf = function (mark, method) { return calls.slice(mark).filter((c) => c.method === method) }
const fireTimers = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}
const checkboxes = (t) => collect(t).filter((n) => n.type === 'input' && n.props.type === 'checkbox')
const selects = (t) => collect(t).filter((n) => n.type === 'select')
const optionsOf = (s) => (Array.isArray(s.props.children) ? s.props.children : [s.props.children]).filter((o) => o != null && o.type === 'option')
const pickedOption = (s) => optionsOf(s).find((o) => String(o.props.value) === String(s.props.value))
const hintText = (t, contains) => {
  const one = collect(t).find((n) => n.props.className === 'dsh-git-set-hint' && textOf(n).indexOf(contains) >= 0)
  return one === undefined ? '' : textOf(one)
}
/* 命令页的取景：行、行内命令文本（去重数它）、展开详情、屏上有没有某句话。 */
const cmdRows = (t) => byClass(t, 'dsh-git-cmdline')
const cmdRowWith = (t, label) => cmdRows(t).find((r) => textOf(r).indexOf(label) >= 0)
const cmdTextCount = (t, label) => collect(t).filter((n) => n.props.className === 'dsh-git-cmdtext' && textOf(n) === label).length
const cmdOpenOf = (t, label) => collect(t).find((n) => n.props.className === 'dsh-git-cmdopen' && textOf(n).indexOf(label) >= 0)
const hasText = (t, s) => collect(t).some((n) => textOf(n).indexOf(s) >= 0)
const chipClose49 = async function () {
  const t = await chipTree()
  if (String(t.props.className).indexOf('dsh-git-chip-open') >= 0) { t.props.onClick(); await wait(20) }
  return await settle()
}
/* 换一把新扣子：测试自己留着引用（mock 消费时会把 cmdLogHold 置回 null），答复
   到没到、什么时候到，由这里说了算。 */
const cmdLogHoldNew = function () { const hold = {}; cmdLogHold = hold; return hold }

console.log('')
console.log('=== 配置页：页签、三组与只读的「此刻生效」 ===')
let tree = await openPanel()
ok('顶栏现在是 4 个页签，第 4 个是「配置」', buttons(byClass(tree, 'dsh-git-tabs')[0]).length === 4
  && textOf(buttons(byClass(tree, 'dsh-git-tabs')[0])[3]) === '配置')
await clickText(tree, '配置')
tree = await settle()
const groupTexts = (t) => collect(t).filter((n) => n.props.className === 'dsh-git-set-group').map(textOf)
ok('三个分组都在：会话完成 / 提交身份 / 换行符', groupTexts(tree).join('|').indexOf('会话完成') >= 0
  && groupTexts(tree).join('|').indexOf('提交身份（只写这个项目的 .git/config）') >= 0
  && groupTexts(tree).join('|').indexOf('换行符（git 自己的换行配置）') >= 0)
const paneInputs = collect(tree).filter((n) => n.type === 'input' && n.props.type !== 'checkbox')
ok('名字框的 placeholder 显示全局那份的值', paneInputs.length >= 2
  && paneInputs[0].props.placeholder === '留空 = 用全局（Ada Lovelace）')
ok('全局也没配的措辞是另一句（邮箱全局有值所以只验证名字这句的反例在下一节）',
  paneInputs.length >= 2 && String(paneInputs[1].props.placeholder).indexOf('ada@example.com') >= 0)
const effectiveRow = collect(tree).find((n) => n.props.className === 'dsh-git-set-hint' && textOf(n).indexOf('Ada Lovelace（来自 /home/u/.gitconfig）') >= 0)
ok('「此刻生效」显示生效值 + 来源文件', effectiveRow !== undefined)
ok('身份齐全时不出现红色警告', collect(tree).find((n) => String(n.props.className).indexOf('dsh-git-warn') >= 0 && textOf(n).indexOf('还缺') >= 0) === undefined)
const writeBtn = buttons(tree).find((b) => textOf(b) === '写入本项目')
const clearBtn = buttons(tree).find((b) => textOf(b) === '清掉本项目覆盖，用回全局')
ok('两个框都空 → 「写入本项目」禁用', writeBtn !== undefined && writeBtn.props.disabled === true)
ok('本项目覆盖过 autocrlf → 「清掉覆盖」可用，且 hint 列出覆盖的键',
  clearBtn !== undefined && clearBtn.props.disabled !== true
  && hintText(tree, '本项目覆盖了：').indexOf('core.autocrlf') >= 0)
const eolSelect = selects(tree).find((s) => optionsOf(s).some((o) => o.props.value === 'crlf'))
ok('core.eol 下拉落在「跟随全局」，选项里带全局当前值', eolSelect !== undefined
  && String(eolSelect.props.value) === ''
  && textOf(pickedOption(eolSelect)).indexOf('跟随全局（全局当前：native）') === 0)
const autocrlfSelect = selects(tree).find((s) => optionsOf(s).some((o) => o.props.value === 'input'))
ok('core.autocrlf 下拉落在本地覆盖 input 上', autocrlfSelect !== undefined && String(autocrlfSelect.props.value) === 'input')

console.log('')
console.log('=== 配置页：写入只发填了的键，清掉只发填过的键 ===')
paneInputs[0].props.onChange({ target: { value: 'Repo Only' } })
tree = await settle()
const writeBtn2 = buttons(tree).find((b) => textOf(b) === '写入本项目')
ok('填了一个框就可用', writeBtn2.props.disabled !== true)
await clickText(tree, '写入本项目')
tree = await settle()
let lastSave = saveCalls[saveCalls.length - 1]
ok('save 只带 user.name（空着的邮箱一个字节不发）', lastSave != null
  && lastSave.set != null && lastSave.set['user.name'] === 'Repo Only'
  && lastSave.set['user.email'] === undefined && lastSave.sessionId === 's-1')
ok('写后回读：此刻生效换成刚写的（来自 .git/config）',
  collect(tree).some((n) => n.props.className === 'dsh-git-set-hint' && textOf(n).indexOf('Repo Only（来自 .git/config）') >= 0))
await clickText(tree, '清掉本项目覆盖，用回全局')
tree = await settle()
lastSave = saveCalls[saveCalls.length - 1]
ok('清掉 = unset 本地覆盖过的键（刚写的 user.name + 原来的 autocrlf，按键序）', lastSave != null
  && Array.isArray(lastSave.unset) && lastSave.unset.join(',') === 'user.name,core.autocrlf')

console.log('')
console.log('=== 配置页：换行下拉选中即写、「跟随全局」即清 ===')
await clickText(tree, '配置')
tree = await settle()
const eolSelect2 = selects(tree).find((s) => optionsOf(s).some((o) => o.props.value === 'crlf'))
eolSelect2.props.onChange({ target: { value: 'lf' } })
tree = await settle()
lastSave = saveCalls[saveCalls.length - 1]
ok('选 lf 立即写入 set.core.eol', lastSave != null && lastSave.set != null && lastSave.set['core.eol'] === 'lf')
const eolSelect3 = selects(tree).find((s) => optionsOf(s).some((o) => o.props.value === 'crlf'))
eolSelect3.props.onChange({ target: { value: '' } })
tree = await settle()
lastSave = saveCalls[saveCalls.length - 1]
ok('选「跟随全局」= unset core.eol', lastSave != null && Array.isArray(lastSave.unset) && lastSave.unset.join(',') === 'core.eol')

console.log('')
console.log('=== 配置页：bridge 版（没有会话 props）明说不行，不装能用 ===')
ok('sessionAware=false 时 hint 换成「当前环境不支持会话状态监听」',
  hintText(tree, '当前环境不支持会话状态监听').length > 0)
ok('会话完成刷新默认开着（配置里没有这个键 = 缺省 true）',
  checkboxes(tree)[0] !== undefined && checkboxes(tree)[0].props.checked === true)

console.log('')
console.log('=== 配置页：两个开关的落盘 —— 原有键一个不丢 ===')
const marks = { configSave: calls.length }
checkboxes(tree)[0].props.onChange({ target: { checked: false } })
tree = await settle()
fireTimers(400)
await wait(10)
const savedConfig = calls.slice(marks.configSave).filter((c) => c.method === 'git/config-save')
ok('关掉「会话完成时刷新」走 git/config-save', savedConfig.length === 1 && savedConfig[0].args.config.refreshOnComplete === false)
ok('原有键不丢：initBranch / pushSetUpstream 还在（repos 那条教训的同款门槛）',
  savedConfig.length === 1 && savedConfig[0].args.config.initBranch === 'main'
  && savedConfig[0].args.config.pushSetUpstream === true)
checkboxes(tree)[0].props.onChange({ target: { checked: true } })
tree = await settle()
checkboxes(tree)[1].props.onChange({ target: { checked: true } })
tree = await settle()
fireTimers(400)
await wait(10)

console.log('')
console.log('=== 会话完成刷新：边沿 + 2 秒稳定窗 ===')
let runningC = false
const statusC = new Map()
const hooksC = {
  useSession: function (sel) { return sel({ running: runningC }) },
  useSessionStatus: function (sel) { return sel(statusC) },
}
const renderChipC = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-c1' }, hooksC)), 'chip-c1')
await renderChipC()
ok('初始挂载 running=false：什么都不发（挂载不算完成）', calls.filter((c) => c.method === 'git/flush' && c.args.sessionId === 's-c1').length === 0)
runningC = true
await renderChipC()
runningC = false
let mark = calls.length
await renderChipC()
ok('边沿后先不刷：稳定窗还没走完', callsOf(mark, 'git/flush').length === 0)
fireTimers(2000)
await wait(30)
await renderChipC()
const flushes = callsOf(mark, 'git/flush')
ok('稳定窗走完：flush 了工作区本身 + 清单里那个仓库', flushes.length === 2
  && JSON.stringify(flushes[0].args) === '{"sessionId":"s-c1"}'
  && flushes[1].args.sessionId === 's-c1' && flushes[1].args.repo === '/tmp/ws')
ok('刷新里带一次整树读（不带 paths、不带 quick）', callsOf(mark, 'git/panel').some((c) =>
  c.args.quick !== true && !Array.isArray(c.args.paths)))

console.log('')
console.log('=== 会话完成刷新：goal 续轮的间隙不算完成 ===')
let runningD = false
const hooksD = {
  useSession: function (sel) { return sel({ running: runningD }) },
  useSessionStatus: function (sel) { return sel(statusC) },
}
const renderChipD = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-c2' }, hooksD)), 'chip-c2')
await renderChipD()
runningD = true
await renderChipD()
runningD = false
await renderChipD()
runningD = true
mark = calls.length
await renderChipD()
fireTimers(2000)
await wait(20)
ok('2 秒内又跑起来了：上一轮取消，一个 flush 都没有', callsOf(mark, 'git/flush').filter((c) => c.args.sessionId === 's-c2').length === 0)

console.log('')
console.log('=== 会话完成刷新：页面藏着时跳过 ===')
fakeDoc.hidden = true
let runningE = false
const hooksE = {
  useSession: function (sel) { return sel({ running: runningE }) },
  useSessionStatus: function (sel) { return sel(statusC) },
}
const renderChipE = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-c3' }, hooksE)), 'chip-c3')
await renderChipE()
runningE = true
await renderChipE()
runningE = false
mark = calls.length
await renderChipE()
fireTimers(2000)
await wait(20)
ok('页面藏着：那一刷不发（回可见时靠既有补读兜底）', callsOf(mark, 'git/flush').filter((c) => c.args.sessionId === 's-c3').length === 0)
fakeDoc.hidden = false

console.log('')
console.log('=== 会话状态 hook 的真契约：选择器进、选择器的返回值出 ===')
/* 桩故意照真 shell 的脾气长牙：不传选择器当场抛（真环境是 useSyncExternalStore-
   WithSelector 里的 l is not a function）。上面各组已经全部走 sel(...) 形状 —— 这里
   再用这一对钉一次，谁把 chip 改回无参调用，第一个死的就是这一组，报错原文可读。 */
const strictStatusHooks = {
  useSession: function (sel) {
    if (typeof sel !== 'function') throw new TypeError('useSession 需要一个选择器参数（真 shell 的 hook 契约）')
    return sel({ running: false })
  },
  useSessionStatus: function (sel) {
    if (typeof sel !== 'function') throw new TypeError('useSessionStatus 需要一个选择器参数（真 shell 的 hook 契约）')
    return sel(new Map([['s-x', { running: true }], ['s-y', { running: false }]]))
  },
}
try {
  const strictTree = await renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-strict' }, strictStatusHooks)), 'chip-strict')
  ok('chip 传了选择器：渲染不炸，且整页计数把别的会话也算进来', collect(strictTree).some((n) => String(n.props.className || '').indexOf('dsh-git-chip') >= 0))
} catch (error) {
  ok('chip 传了选择器：渲染不炸，且整页计数把别的会话也算进来', false)
  console.log('  ' + String(error && error.message))
}

console.log('')
console.log('=== 会话完成刷新：bridge 版（没有 hook props）安静不启用 ===')
mark = calls.length
const renderChipF = () => renderUntilStable(makeElement(chip, { sessionId: 's-c4' }), 'chip-c4')
await renderChipF()
await renderChipF()
fireTimers(2000)
await wait(20)
ok('props 里没有 useSession：没有任何 flush', callsOf(mark, 'git/flush').filter((c) => c.args.sessionId === 's-c4').length === 0)

console.log('')
console.log('=== 铃：chip 那一刷让面板的下一读变成整树 ===')
tree = await settle()
mark = calls.length
let runningB = false
const hooksB = {
  useSession: function (sel) { return sel({ running: runningB }) },
  useSessionStatus: function (sel) { return sel(statusC) },
}
const renderChipB = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-bell' }, hooksB)), 'chip-bell')
await renderChipB()
runningB = true
await renderChipB()
runningB = false
await renderChipB()
fireTimers(2000)
await wait(20)
tree = await settle()
ok('铃响后面板走了一次整树重读（needFull 被立起来）', callsOf(mark, 'git/panel').some((c) =>
  c.args.quick !== true && !Array.isArray(c.args.paths) && c.args.sessionId === 's-1'))

console.log('')
console.log('=== 命令页跟着 freshAt 重读；切走再切回不重读 ===')
await clickText(tree, '命令')
tree = await settle()
mark = calls.length
await clickText(tree, '⟳')
tree = await settle()
ok('命令页开着时，⟳ 的 bump 让它自己重扫了一遍', callsOf(mark, 'git/command-log').length === 1)
mark = calls.length
await clickText(tree, '历史')
tree = await settle()
await clickText(tree, '命令')
tree = await settle()
ok('切走再切回、期间没有 bump：不重读', callsOf(mark, 'git/command-log').length === 0)

console.log('')
console.log('=== 命令页：弹窗打开即后台预读（藏着不发读），不等切页 ===')
/* 回到「历史」再走一遍关-开：预读发生在打开那一刻，跟读者站在哪个页签无关 ——
   这正是 6aede2c 的规格（每次打开都算一次刷新时机），代价也是规格内的。 */
const cmdT0 = Date.now()
mark = calls.length
await clickText(tree, '历史')
tree = await settle()
ok('命令→历史：切走这半边也不发读（上一条只钉了往返命令页）', callsOf(mark, 'git/command-log').length === 0)
mark = calls.length
await chipClose49()
await settle()
ok('面板藏着：仓库没动，一轮命令读都不发', callsOf(mark, 'git/command-log').length === 0)
mark = calls.length
const holdOpen = cmdLogHoldNew()
tree = await openPanel()
ok('弹窗一打开就发了一次命令读（面板开在「历史」，没切页签）', callsOf(mark, 'git/command-log').length === 1)
/* 第二次答复：同 id 行换退出码、另多一条新命令 —— 增量合并看的就这两件事。 */
holdOpen.done({ ok: true, sessionId: 's-1', commands: [
  { id: 'a', time: cmdT0, command: 'git status', desc: '', source: 'session', exitCode: 3 },
  { id: 'b', time: cmdT0 + 60000, command: 'git log --oneline', desc: '', source: 'session', exitCode: 0 },
], truncated: false, warning: '' })
tree = await settle()
await clickText(tree, '命令')
tree = await settle()
ok('按行身份合并：新答复独有的行收进，git status 还是只有一份（不整表翻新也不重行）',
  cmdRows(tree).length === 2 && cmdTextCount(tree, 'git status') === 1
  && cmdRowWith(tree, 'git log --oneline') !== undefined)
ok('同 id 行以新答复为准：cmdfail 失败徽标的数字换成 3（此徽标画法 = 叉号加退出码数字）',
  collect(tree).some((n) => n.props.className === 'dsh-git-cmdfail' && textOf(n) === '✗3'))

console.log('')
console.log('=== 命令页：重读在飞不清列表，展开跟着行走 ===')
cmdRowWith(tree, 'git status').props.onClick()
tree = await settle()
ok('点开 git status 那行：详情与复制按钮挂在那行下面', cmdOpenOf(tree, 'git status') !== undefined
  && textOf(cmdOpenOf(tree, 'git status')).indexOf('复制') >= 0)
const holdReread = cmdLogHoldNew()
await clickText(tree, '重新读取')
tree = await settle()
ok('读在飞：列表照常画（2 行、展开还在），不回到「正在读取命令记录…」',
  hasText(tree, '正在读取命令记录') === false && cmdRows(tree).length === 2
  && cmdOpenOf(tree, 'git status') !== undefined)
ok('读在飞：条数旁挂着一句轻的「刷新中…」', hasText(tree, '刷新中…') === true)
holdReread.done({ ok: true, sessionId: 's-1', commands: [
  { id: 'c', time: cmdT0 + 120000, command: 'git add -A', desc: '', source: 'session', exitCode: 0 },
  { sessionId: 's-9', time: cmdT0 + 90000, command: 'git fetch --all', desc: '', source: 'session', exitCode: 0 },
  { id: 'b', time: cmdT0 + 60000, command: 'git log --oneline', desc: '', source: 'session', exitCode: 2 },
  { id: 'a', time: cmdT0, command: 'git status', desc: '', source: 'session', exitCode: 3 },
], truncated: false, warning: '' })
tree = await settle()
ok('答复到了：新答复独有的行收进（4 行），同一行没有第二份',
  cmdRows(tree).length === 4 && cmdTextCount(tree, 'git status') === 1
  && cmdTextCount(tree, 'git add -A') === 1)
ok('旧行被新答复就地换新：b 的退出码从 0 换成失败徽标 2',
  collect(tree).some((n) => n.props.className === 'dsh-git-cmdfail' && textOf(n) === '✗2'))
ok('展开状态跟着行走：重读、合并之后 git status 那行还开着', cmdOpenOf(tree, 'git status') !== undefined)

console.log('')
console.log('=== 命令页：没有 id 的会话行跨两次读也是同一行 ===')
cmdLogReply = { ok: true, sessionId: 's-1', commands: [
  { id: 'c', time: cmdT0 + 120000, command: 'git add -A', desc: '', source: 'session', exitCode: 0 },
  { sessionId: 's-9', time: cmdT0 + 90000, command: 'git fetch --all', desc: '', source: 'session', exitCode: 0 },
  { id: 'b', time: cmdT0 + 60000, command: 'git log --oneline', desc: '', source: 'session', exitCode: 2 },
  { id: 'a', time: cmdT0, command: 'git status', desc: '', source: 'session', exitCode: 3 },
], truncated: false, warning: '' }
await clickText(tree, '重新读取')
tree = await settle()
ok('同一份会话行（同会话同时刻同命令）再读一遍：git fetch --all 还是只有一份',
  cmdRows(tree).length === 4 && cmdTextCount(tree, 'git fetch --all') === 1)
ok('读完放下：展开还在、「刷新中…」放掉、也没有挂着错误', cmdOpenOf(tree, 'git status') !== undefined
  && hasText(tree, '刷新中…') === false
  && collect(tree).some((n) => String(n.props.className || '').indexOf('dsh-git-error') >= 0) === false)

console.log('')
console.log('=== 命令页：后台刷新失败不清列表，错误原话挂在列表上方 ===')
cmdLogReply = { ok: false, error: '沙箱拒绝了 node，会话记录读不了' }
await clickText(tree, '重新读取')
tree = await settle()
ok('刷新失败：列表原样保留（4 行还在，不是整页换错）',
  cmdRows(tree).length === 4 && cmdTextCount(tree, 'git status') === 1)
const cmdSeen = collect(tree)
const cmdErrAt = cmdSeen.findIndex((n) => String(n.props.className || '').indexOf('dsh-git-error') >= 0
  && textOf(n).indexOf('沙箱拒绝了 node') >= 0)
const cmdListAt = cmdSeen.findIndex((n) => n.props.className === 'dsh-git-cmdlist')
ok('错误原话一个字不改，画在列表上方（不是顶掉列表）',
  cmdErrAt >= 0 && cmdListAt >= 0 && cmdErrAt < cmdListAt)
await clickText(tree, '重新读取')
tree = await settle()
ok('下一次读成了：错误行自己消失，列表还在',
  collect(tree).some((n) => String(n.props.className || '').indexOf('dsh-git-error') >= 0) === false
  && cmdRows(tree).length === 4)

console.log('')
console.log('=== 命令页：liveBus 的 cmdlog-start 对答复里已有的行不再多出一行 ===')
/* 重挂一次面板（fibers 清掉、面板状态从零再来），让它出生就有 liveBus 可订阅 ——
   真包的 client-pre.js 提供 liveBus，bridge 版没有；桩只按 subscribe 契约长牙。 */
fibers.clear()
const bus49 = {
  handlers: [],
  subscribe: function (cb) { bus49.handlers.push(cb); return function () { bus49.handlers = bus49.handlers.filter(function (f) { return f !== cb }) } },
}
globalThis.liveBus = bus49
cmdLogReply = { ok: true, sessionId: 's-1', commands: [
  { id: 'x', time: cmdT0 + 180000, command: 'git push', desc: '', source: 'panel', exitCode: 0 },
], truncated: false, warning: '' }
mark = calls.length
tree = await settle()
await clickText(tree, '命令')
tree = await settle()
ok('重挂后的预读照发（弹窗开着就算，不等切页）：答复进来 git push 一行',
  callsOf(mark, 'git/command-log').length === 1 && cmdRows(tree).length === 1
  && cmdTextCount(tree, 'git push') === 1
  && collect(tree).some((n) => n.props.className === 'dsh-git-cmdrun') === false)
bus49.handlers.slice().forEach(function (cb) {
  cb({ kind: 'cmdlog-start', entry: { id: 'x', time: cmdT0 + 180000, command: 'git push', desc: '', source: 'panel', exitCode: null } })
})
tree = await settle()
ok('cmdlog-start 不再把刚开的命令前插成两行：还是一行，回到「运行中」',
  cmdRows(tree).length === 1 && cmdTextCount(tree, 'git push') === 1
  && collect(tree).some((n) => n.props.className === 'dsh-git-cmdrun') === true)
bus49.handlers.slice().forEach(function (cb) { cb({ kind: 'cmdlog-exit', id: 'x', exitCode: 7 }) })
tree = await settle()
ok('cmdlog-exit 照旧按 id 就地改退出码：失败徽标 7 顶掉运行徽标',
  cmdRows(tree).length === 1
  && collect(tree).some((n) => n.props.className === 'dsh-git-cmdfail' && textOf(n) === '✗7') === true
  && collect(tree).some((n) => n.props.className === 'dsh-git-cmdrun') === false)
globalThis.liveBus = undefined

console.log('')
console.log('=== 全部完成推送：5 秒稳定窗与前值判定 ===')
panelReply = { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, ahead: 2, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] }
let statusMapP = new Map([['s-push', { running: true }], ['s-other', { running: false }]])
const hooksP = {
  useSession: function (sel) { return sel({ running: statusMapP.get('s-push').running }) },
  useSessionStatus: function (sel) { return sel(statusMapP) },
}
const renderChipP = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-push' }, hooksP)), 'chip-push')
await renderChipP()
statusMapP = new Map([['s-push', { running: false }], ['s-other', { running: false }]])
mark = calls.length
await renderChipP()
ok('边沿后先不推：5 秒稳定窗还没走完', callsOf(mark, 'git/push').length === 0)
statusMapP = new Map([['s-push', { running: false }], ['s-other', { running: false }]])
await renderChipP()
fireTimers(5000)
await wait(30)
await renderChipP()
ok('无关的状态翻动（Map 换新、计数没变）不重置窗口：5 秒到了照推', callsOf(mark, 'git/push').length === 1
  && pushCalls[0].sessionId === 's-push' && pushCalls[0].repo === '/tmp/ws')

console.log('')
console.log('=== 全部完成推送：不稳定就取消 ===')
const hooksQ = {
  useSession: function (sel) { return sel({ running: statusMapP.get('s-push2').running }) },
  useSessionStatus: function (sel) { return sel(statusMapP) },
}
const renderChipQ = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-push2' }, hooksQ)), 'chip-push2')
statusMapP = new Map([['s-push2', { running: true }], ['s-other', { running: false }]])
await renderChipQ()
statusMapP = new Map([['s-push2', { running: false }], ['s-other', { running: false }]])
await renderChipQ()
statusMapP = new Map([['s-push2', { running: false }], ['s-other', { running: true }]])
mark = calls.length
await renderChipQ()
fireTimers(5000)
await wait(20)
ok('稳定窗里任何会话恢复运行：整轮取消，git/panel 都不为推送问', callsOf(mark, 'git/panel').filter((c) => c.args.sessionId === 's-push2').length === 0)

console.log('')
console.log('=== 全部完成推送：不领先 / 有冲突时不推 ===')
statusMapP = new Map([['s-push2', { running: true }], ['s-other', { running: false }]])
const hooksP2 = {
  useSession: function (sel) { return sel({ running: statusMapP.get('s-push2').running }) },
  useSessionStatus: function (sel) { return sel(statusMapP) },
}
const renderChipP2 = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-push2' }, hooksP2)), 'chip-push2b')
await renderChipP2()
panelReply = Object.assign({}, panelReply, { ahead: 0 })
statusMapP = new Map([['s-push2', { running: false }], ['s-other', { running: false }]])
mark = calls.length
await renderChipP2()
fireTimers(5000)
await wait(30)
/* 那行状态画在「配置」页：上一节把面板切到了命令页，先切回来再断言。 */
await clickText(tree, '配置')
tree = await settle()
ok('不领先：不推，那行状态记下原因', callsOf(mark, 'git/push').length === 0
  && collect(tree).some((n) => n.props.className === 'dsh-git-set-hint' && textOf(n).indexOf('没有领先远端的提交') >= 0))
statusMapP = new Map([['s-push2', { running: true }], ['s-other', { running: false }]])
await renderChipP2()
panelReply = Object.assign({}, panelReply, { ahead: 3, unmerged: [{ path: 'a.txt', code: 'UU' }] })
statusMapP = new Map([['s-push2', { running: false }], ['s-other', { running: false }]])
mark = calls.length
await renderChipP2()
fireTimers(5000)
await wait(30)
tree = await settle()
ok('有未解决冲突：不推，原因带个数', callsOf(mark, 'git/push').length === 0
  && collect(tree).some((n) => n.props.className === 'dsh-git-set-hint' && textOf(n).indexOf('1 个未解决的冲突') >= 0))

console.log('')
console.log('=== 全部完成推送：没有上游时按 runOp 的老路补一次 -u ===')
const pushOk = { ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 }
pushBehavior = function (args) {
  if (args != null && args.setUpstream === true) return pushOk
  return { ok: false, repo: '/tmp/ws', stdout: '', stderr: 'fatal: The current branch main has no upstream branch.', exitCode: 128 }
}
statusMapP = new Map([['s-push3', { running: true }], ['s-other', { running: false }]])
const hooksP3 = {
  useSession: function (sel) { return sel({ running: statusMapP.get('s-push3').running }) },
  useSessionStatus: function (sel) { return sel(statusMapP) },
}
const renderChipP3 = () => renderUntilStable(makeElement(chip, Object.assign({ sessionId: 's-push3' }, hooksP3)), 'chip-push3')
await renderChipP3()
panelReply = Object.assign({}, panelReply, { ahead: 2, unmerged: [] })
statusMapP = new Map([['s-push3', { running: false }], ['s-other', { running: false }]])
mark = pushCalls.length
await renderChipP3()
fireTimers(5000)
await wait(40)
tree = await settle()
ok('第一推失败带 upstream → 问了一次 refs，补发 setUpstream:true 的推送',
  pushCalls.length - mark === 2 && pushCalls[mark + 1].setUpstream === true
  && pushCalls[mark + 1].remote === 'origin' && pushCalls[mark + 1].branch === 'main')
ok('答复读回配置页：成功那行说推了、设了上游',
  hintText(tree, '并设了上游').indexOf('成功') >= 0 && hintText(tree, '已推送 /tmp/ws').length > 0)

console.log('')
console.log('=== 配置页：推送那行状态 ===')
tree = await settle()
ok('「最近一次自动推送」不再是「还没有自动推送过」，且带着时间与结论',
  collect(tree).some((n) => n.props.className === 'dsh-git-set-hint' && textOf(n).indexOf('还没有自动推送过') >= 0) === false
  && hintText(tree, '最近一次自动推送').length === 0
  && collect(tree).some((n) => n.props.className === 'dsh-git-set-hint' && textOf(n).indexOf('成功') >= 0))
