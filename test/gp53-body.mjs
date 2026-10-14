/* ═══ gp53：推送兜底挑远端 + 配置页「远端」组（客户端这一半）═══
 *
 * 盯两片：
 *   1. guessPushRemote（70-branchpicker.js 的纯函数，从产物里单独求值 —— gp50 对
 *      53-merge3.js 的同款做法）：git/refs 的答复里 remote 是按远端分组的表，挑的
 *      规矩与右键推送 ctxPush 先立的那条一致 —— 有 origin 用 origin（哪怕排在
 *      清单后面）；没有 origin 且远端多于一个 → 空串（-u 会把上游绑到替读者挑的
 *      远端上，这件事不能猜）；恰好一个 → 用它；手头没数据（null / ok:false /
 *      remote 不是数组 / 空表）→ 同样空串，由调用方把「修改跟踪分支…」说出来；
 *   2. 面板「配置」页的「远端」组（80-panel.js）：进页问一次 git/remotes（带会话）；
 *      每个远端一行，fetch 地址常显、push 地址只在真的不同时才带「（push：…）」；
 *      添加区空框禁用，填了名字+地址 → 「添加远端」发 {add:{name,url}}（Host 一次
 *      只收一个动作），成功后框清空可连添、提示行带 Host 重读出的地址、面板跟着
 *      bump（分支树的「远程」分组才有得刷）；新表照重读的答复重画；删除两段式：
 *      第一次「删除」只上膛，「确认删除」才发 {remove:{name}}；工作区不是仓库
 *      （insideRepo:false）→ 控件全禁用 + 说明行说人话；读失败落在组自己的说明行，
 *      不占页面底部那条 problem。 */

/* ── mock：配置页的两个读与一个写按用例给答复 ── */
let projectReply = { ok: true, repo: '/tmp/ws', insideRepo: true, config: {
  'user.name': { local: 'Ada', global: '', effective: 'Ada', localOrigin: '.git/config', globalOrigin: '', effectiveOrigin: '.git/config' },
  'user.email': { local: '', global: 'ada@example.com', effective: 'ada@example.com', localOrigin: '', globalOrigin: '/home/u/.gitconfig', effectiveOrigin: '/home/u/.gitconfig' },
  'core.autocrlf': { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' },
  'core.eol': { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' },
} }
/* 两个远端：origin 的 push 与 fetch 相同（答复里 pushUrl 是空串），fork 真的不同。 */
const TABLE_2 = [
  { name: 'origin', url: 'https://example.com/origin.git', pushUrl: '' },
  { name: 'fork', url: 'https://example.com/fetch-f.git', pushUrl: 'git@example.com:push-f.git' },
]
let remoteSnapReply = { ok: true, repo: '/tmp/ws', insideRepo: true, remotes: TABLE_2 }
let remoteSaveReply = null
const remoteSaveCalls = []
const realCall53 = host.call
host.call = function (method, args) {
  if (method === 'git/project-config') { calls.push({ method: method, args: args }); return Promise.resolve(projectReply) }
  if (method === 'git/remotes') { calls.push({ method: method, args: args }); return Promise.resolve(remoteSnapReply) }
  if (method === 'git/remotes-save') { calls.push({ method: method, args: args }); remoteSaveCalls.push(args); return Promise.resolve(remoteSaveReply) }
  return realCall53(method, args)
}

const callsOf53 = (mark, method) => calls.slice(mark).filter((c) => c.method === method)
const hasClass53 = (n, s) => n.props != null && typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(s) >= 0
/* 说明行 / 提示行（dsh-git-set-hint）里有没有这句话 —— 远端组的成败话都说在那。 */
const saysOn = (t, s) => collect(t).some((n) => hasClass53(n, 'dsh-git-set-hint') && textOf(n).indexOf(s) >= 0)
/* 远端行 = 带「改地址」按钮的 set-row（身份/换行符的行没有按钮，添加区也没有）。 */
const remoteRow = (t, name) => collect(t).find((n) => hasClass53(n, 'dsh-git-set-row')
  && textOf(n).indexOf(name) >= 0 && collect(n).some((b) => b.type === 'button' && textOf(b) === '改地址'))
const rowButton = (t, name, label) => {
  const row = remoteRow(t, name)
  return row === undefined ? undefined : collect(row).find((b) => b.type === 'button' && textOf(b) === label)
}
const clickText53 = async function (t, label) {
  const hit = buttons(t).find((b) => textOf(b) === label)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
  return await settle()
}
/* 另一把面板实例（effect 只认 sessionId，换会话才会真去重读）：label 隔开 fiber 键。 */
const openConfigOn = async function (label, sid) {
  let t = null
  for (let i = 0; i < 4; i += 1) { t = await renderUntilStable(makeElement(popover, { sessionId: sid }), label); await wait(10) }
  const cfg = buttons(t).find((b) => textOf(b) === '配置')
  if (cfg === undefined) throw new Error('点不到「配置」页签')
  cfg.props.onClick()
  for (let i = 0; i < 4; i += 1) { t = await renderUntilStable(makeElement(popover, { sessionId: sid }), label); await wait(10) }
  return t
}

console.log('')
console.log('== guessPushRemote：与 ctxPush 同一条挑远端规则（70-branchpicker 单独求值）==')
const CLIENT_SRC = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
const textSrc = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function text(value)'), CLIENT_SRC.indexOf('function failureText'))
const gprSrc = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function guessPushRemote'), CLIENT_SRC.indexOf('function RemotePickList'))
ok('从产物里抽到的是真代码（origin 优先与唯一远端两条规则都在函数体里）',
  gprSrc.indexOf("names[i] === 'origin'") >= 0 && gprSrc.indexOf("names.length === 1 ? names[0] : ''") >= 0
  && textSrc.indexOf("typeof value === 'string'") >= 0)
const guess = new Function(textSrc + '\n' + gprSrc + '\nreturn guessPushRemote')()
const refsData = (names) => ({ ok: true, repo: '/tmp/ws', current: ['main'], local: [], remote: names.map((n) => ({ name: n, refs: [] })) })
ok('有 origin 返回 origin（哪怕它排在清单后面）', guess(refsData(['zeta', 'origin', 'alpha'])) === 'origin')
ok('没有 origin 且远端多于一个：空串（-u 绑到替读者挑的远端，这件事不猜）',
  guess(refsData(['zeta', 'alpha'])) === '')
ok('没有 origin 但恰好一个远端：就用它', guess(refsData(['solo'])) === 'solo')
ok('手头没数据全是空串：null / ok:false / remote 不是数组 / 空表',
  guess(null) === '' && guess({ ok: false, remote: [{ name: 'origin' }] }) === ''
  && guess({ ok: true, remote: 'nope' }) === '' && guess({ ok: true, remote: [] }) === '')

console.log('')
console.log('== 配置页「远端」组：清单一行一个远端，push 不同才多说一句 ==')
let tree = await openPanel()
let mark53 = calls.length
tree = await clickText53(tree, '配置')
ok('进配置页问了一次 git/remotes（只带会话，路径由 Host 从会话解）',
  callsOf53(mark53, 'git/remotes').length === 1 && callsOf53(mark53, 'git/remotes')[0].args.sessionId === 's-1'
  && callsOf53(mark53, 'git/remotes')[0].args.repo === undefined)
ok('组头把话说全：「远端（这个仓库的 remote 清单）」',
  collect(tree).some((n) => hasClass53(n, 'dsh-git-set-group') && textOf(n) === '远端（这个仓库的 remote 清单）'))
const originRow = remoteRow(tree, 'origin')
const forkRow = remoteRow(tree, 'fork')
ok('两个远端各一行，fetch 地址常显',
  originRow !== undefined && forkRow !== undefined
  && textOf(originRow).indexOf('https://example.com/origin.git') >= 0
  && textOf(forkRow).indexOf('https://example.com/fetch-f.git') >= 0)
ok('push 与 fetch 相同的不重复说：origin 行没有「（push：」', textOf(originRow).indexOf('（push：') < 0)
ok('push 真的不同才一并显示：fork 行带「（push：git@example.com:push-f.git）」',
  textOf(forkRow).indexOf('（push：git@example.com:push-f.git）') >= 0)

console.log('')
console.log('== 添加远端：add 一次一个动作，成功后框清空、面板跟着刷 ==')
const nameBox = () => inputs(tree).find((n) => n.props.placeholder === '名字（如 origin / upstream）')
const urlBox = () => inputs(tree).find((n) => n.props.placeholder === '地址（https://… 或 git@…）')
const addBtn = () => buttons(tree).find((b) => textOf(b) === '添加远端')
ok('添加区三件套在：名字框、地址框，空框时「添加远端」禁用',
  nameBox() !== undefined && urlBox() !== undefined && addBtn() !== undefined && addBtn().props.disabled === true)
nameBox().props.onChange({ target: { value: 'lab' } })
tree = await settle()
urlBox().props.onChange({ target: { value: 'https://example.com/lab.git' } })
tree = await settle()
ok('填了名字与地址，「添加远端」亮了', addBtn() !== undefined && addBtn().props.disabled !== true)
remoteSaveReply = { ok: true, repo: '/tmp/ws', insideRepo: true, remotes: TABLE_2.concat([{ name: 'lab', url: 'https://example.com/lab.git', pushUrl: '' }]) }
const markSave = remoteSaveCalls.length
const markBump = calls.length
addBtn().props.onClick()
tree = await settle()
ok('发的是 add 一次一个动作：{add:{name,url}} + 会话，setUrl/remove 一个都不带',
  remoteSaveCalls.length === markSave + 1
  && JSON.stringify(remoteSaveCalls[markSave].add) === JSON.stringify({ name: 'lab', url: 'https://example.com/lab.git' })
  && remoteSaveCalls[markSave].sessionId === 's-1'
  && remoteSaveCalls[markSave].setUrl === undefined && remoteSaveCalls[markSave].remove === undefined)
ok('草稿框清空了（可以连着添下一个）', nameBox() !== undefined && nameBox().props.value === '' && urlBox().props.value === '')
ok('提示行带的是 Host 重读出的地址：已添加远端 lab → https://example.com/lab.git',
  saysOn(tree, '已添加远端 lab → https://example.com/lab.git'))
ok('新行来自重读的表：lab 一行真的画出来了', remoteRow(tree, 'lab') !== undefined)
ok('onChanged 把面板整体刷了一遍（bump 引来的面板重读）', callsOf53(markBump, 'git/panel').length >= 1)

console.log('')
console.log('== 删除远端：两段式，第二次才是 git remote remove ==')
rowButton(tree, 'fork', '删除').props.onClick()
tree = await settle()
ok('第一段只上膛：按钮换成「确认删除」，一次保存都还没发',
  remoteSaveCalls.length === markSave + 1 && rowButton(tree, 'fork', '确认删除') !== undefined)
remoteSaveReply = { ok: true, repo: '/tmp/ws', insideRepo: true, remotes: TABLE_2.concat([{ name: 'lab', url: 'https://example.com/lab.git', pushUrl: '' }]).filter((one) => one.name !== 'fork') }
const markRemove = remoteSaveCalls.length
rowButton(tree, 'fork', '确认删除').props.onClick()
tree = await settle()
ok('第二段才发：{remove:{name}} + 会话', remoteSaveCalls.length === markRemove + 1
  && JSON.stringify(remoteSaveCalls[markRemove].remove) === JSON.stringify({ name: 'fork' })
  && remoteSaveCalls[markRemove].sessionId === 's-1')
ok('行没了、提示说已删除', remoteRow(tree, 'fork') === undefined && saysOn(tree, '已删除远端 fork'))

console.log('')
console.log('== 不是仓库：控件全禁用、说明行说人话 ==')
remoteSaveReply = null
remoteSnapReply = { ok: true, repo: '/tmp/ws', insideRepo: false, remotes: [] }
let treeB = await openConfigOn('gp53b', 's-53b')
ok('说明行说人话：这个会话的工作区还不是 Git 仓库 —— 远端加不了也改不了',
  saysOn(treeB, '这个会话的工作区还不是 Git 仓库 —— 远端加不了也改不了'))
const nameB = inputs(treeB).find((n) => n.props.placeholder === '名字（如 origin / upstream）')
const urlB = inputs(treeB).find((n) => n.props.placeholder === '地址（https://… 或 git@…）')
const addB = buttons(treeB).find((b) => textOf(b) === '添加远端')
ok('添加区的两个框与「添加远端」全禁用', nameB.props.disabled === true && urlB.props.disabled === true && addB.props.disabled === true)
ok('不是仓库时不画远端行', remoteRow(treeB, 'origin') === undefined && remoteRow(treeB, 'fork') === undefined)

console.log('')
console.log('== 读失败：落在组自己的说明行，不占页面底部那条 problem ==')
remoteSnapReply = { ok: false, stderr: 'git 的原话：权限不给' }
let treeC = await openConfigOn('gp53c', 's-53c')
ok('说明行是「远端列表没读出来：」+ git 原话', saysOn(treeC, '远端列表没读出来：git 的原话：权限不给'))
ok('页面底部那条 problem 没被占（dsh-git-error 一行都没有）', byClass(treeC, 'dsh-git-error').length === 0)
