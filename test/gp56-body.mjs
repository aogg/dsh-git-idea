/* ═══ gp56：配置页项目档的多仓库（客户端这一半）═══
 *
 * 盯四片：
 *   1. 页首「仓库」组（24-repos.js RepoSwitcher 的受控单选变体，pane='config'）：
 *      清单与历史/变更页是同一份（扫描 + 生效仓库兜底）；受控模式没有「全部」行；
 *      行上的 ● 仍是生效仓库，底色选中行 = 本页正在编辑的仓库。
 *   2. 编辑目标（repoViews 按会话 + 'config' 格）：默认 = 生效仓库；单击行（连
 *      Ctrl+单击也是单击语义，不进多选）只换本页编辑目标 —— 快照与远端表立即重读，
 *      请求里明说 repo: <路径>（宿主 repoFrom 显式路径优先，缺省才回退会话工作区），
 *      sessionId 照旧带上；绝不改生效仓库：没有 git/repos-save 之外的写，历史页的
 *      ● 还在生效仓库上；名字/邮箱草稿切目标即清 —— 对着上一个仓库打的半截话不能
 *      被写进下一个；写答复落地时目标已切走的一个字节不上屏（targetBox 守着，
 *      10-state.js repoEpoch 同一个问题）。目标选择跨页签保留（按会话记的）。
 *   3. 「＋ 添加目录」与历史页同一份持久清单、同一套报错话术（saveManualRepo /
 *      repoSaveProblem）；加成功自动把新仓库选为本页目标；移除的正好是目标时退回
 *      生效仓库；missing 行只可移除、点它不发生任何事。
 *   4. 会话完成组保持插件级：自动推送仍作用于当前生效仓库，提示语照实说一句
 *      （不随本页正在编辑的仓库走）。 */

/* ── mock：清单按用例给；身份/远端的答复按请求里的 repo 现做，才分得清「答的是谁」── */
let reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/lab', '/tmp/ws'], manual: [], missing: [], truncated: false }
let reposSaveReply = null
const reposSaveCalls = []
const projectSaveCalls = []
const remoteSaveCalls = []

const projectSnapshot = function (repo) {
  const lab = repo === '/tmp/lab'
  return { ok: true, repo: repo, insideRepo: true, config: {
    'user.name': { local: lab ? 'Lab' : '', global: 'Ada', effective: lab ? 'Lab' : 'Ada',
      localOrigin: lab ? '.git/config' : '', globalOrigin: '~/.gitconfig', effectiveOrigin: lab ? '.git/config' : '~/.gitconfig' },
    'user.email': { local: '', global: 'ada@example.com', effective: 'ada@example.com',
      localOrigin: '', globalOrigin: '~/.gitconfig', effectiveOrigin: '~/.gitconfig' },
    'core.autocrlf': { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' },
    'core.safecrlf': { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' },
  } }
}
/* 与 host 侧 projectConfigSave 同一条「写后回读」的约定：答复 = 新快照 + written/unset。 */
const projectSaveReply = function (args) {
  const snap = projectSnapshot(args != null ? args.repo : undefined)
  const set = args != null && args.set != null && typeof args.set === 'object' ? args.set : {}
  const keys = Object.keys(set)
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    if (snap.config[key] === undefined) continue
    snap.config[key] = Object.assign({}, snap.config[key],
      { local: set[key], effective: set[key], localOrigin: '.git/config', effectiveOrigin: '.git/config' })
  }
  return Object.assign({ written: keys, unset: [] }, snap)
}
const remotesFor = function (repo) {
  const lab = repo === '/tmp/lab'
  return { ok: true, repo: repo, insideRepo: true, remotes: lab
    ? [{ name: 'up', url: 'https://example.com/lab.git', pushUrl: '' }]
    : [{ name: 'origin', url: 'https://example.com/ws.git', pushUrl: '' }] }
}
const realCall56 = host.call
host.call = function (method, args) {
  if (method === 'git/repos') { calls.push({ method: method, args: args }); return Promise.resolve(reposReply) }
  if (method === 'git/repos-save') { calls.push({ method: method, args: args }); reposSaveCalls.push(args); return Promise.resolve(reposSaveReply) }
  if (method === 'git/project-config') { calls.push({ method: method, args: args }); return Promise.resolve(projectSnapshot(args != null ? args.repo : undefined)) }
  if (method === 'git/project-config-save') { calls.push({ method: method, args: args }); projectSaveCalls.push(args); return Promise.resolve(projectSaveReply(args)) }
  if (method === 'git/remotes') { calls.push({ method: method, args: args }); return Promise.resolve(remotesFor(args != null ? args.repo : undefined)) }
  if (method === 'git/remotes-save') { calls.push({ method: method, args: args }); remoteSaveCalls.push(args); return Promise.resolve(remotesFor(args != null ? args.repo : undefined)) }
  return realCall56(method, args)
}

/* ── 取景工具 ── */
const hasClass56 = (n, s) => n.props != null && typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(s) >= 0
const saysOn = (t, s) => collect(t).some((n) => hasClass56(n, 'dsh-git-set-hint') && textOf(n).indexOf(s) >= 0)
const repoRows = (t) => byClass(t, 'dsh-git-repo-row')
const repoRowOf = (t, path) => repoRows(t).find((r) => typeof r.props.title === 'string' && r.props.title.indexOf(path) === 0)
const callsOf56 = (mark, method) => calls.slice(mark).filter((c) => c.method === method)
const lastArgs = (method) => { const list = calls.filter((c) => c.method === method); return list.length > 0 ? list[list.length - 1].args : undefined }
const rowInput56 = (t, label) => {
  const row = collect(t).find((n) => hasClass56(n, 'dsh-git-set-row') && textOf(n).indexOf(label) >= 0)
  return row === undefined ? undefined : collect(row).find((n) => n.type === 'input')
}
const clickText56 = async function (t, label) {
  const hit = buttons(t).find((b) => textOf(b) === label)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
  return await settle()
}
const openConfigOn56 = async function (label, sid) {
  let t = null
  for (let i = 0; i < 4; i += 1) { t = await renderUntilStable(makeElement(popover, { sessionId: sid }), label); await wait(10) }
  const cfg = buttons(t).find((b) => textOf(b) === '配置')
  if (cfg === undefined) throw new Error('点不到「配置」页签')
  cfg.props.onClick()
  for (let i = 0; i < 4; i += 1) { t = await renderUntilStable(makeElement(popover, { sessionId: sid }), label); await wait(10) }
  return t
}

console.log('')
console.log('== 页首「仓库」组：同一份清单，受控单选，没有「全部」 ==')
let tree = await openPanel()
let mark56 = calls.length
tree = await clickText56(tree, '配置')
ok('组头在：「仓库（这一页在编辑哪个仓库）」',
  collect(tree).some((n) => hasClass56(n, 'dsh-git-set-group') && textOf(n) === '仓库（这一页在编辑哪个仓库）'))
ok('说明行把规矩说全：编辑目标是这里选中的仓库、默认生效仓库、加目录的出路',
  saysOn(tree, '默认是当前生效仓库') && saysOn(tree, '不跟着换') && saysOn(tree, '＋ 添加目录'))
ok('扫描到的两个仓库各一行（生效仓库已扫到，不重复种）',
  repoRowOf(tree, '/tmp/lab') !== undefined && repoRowOf(tree, '/tmp/ws') !== undefined && repoRows(tree).length === 2)
ok('受控单选没有「全部」行（配置一次只写得了一个仓库）',
  repoRows(tree).every((r) => typeof r.props.title !== 'string' || r.props.title.indexOf('一起显示') !== 0))
ok('默认编辑目标 = 生效仓库：选中行与 ● 都在 /tmp/ws 上',
  hasClass56(repoRowOf(tree, '/tmp/ws'), 'dsh-git-repo-sel') && hasClass56(repoRowOf(tree, '/tmp/ws'), 'dsh-git-repo-cur')
  && hasClass56(repoRowOf(tree, '/tmp/lab'), 'dsh-git-repo-sel') !== true)
ok('进页读快照与远端表都明说 repo:/tmp/ws + 会话',
  callsOf56(mark56, 'git/project-config').length === 1 && lastArgs('git/project-config').repo === '/tmp/ws'
  && lastArgs('git/project-config').sessionId === 's-1'
  && callsOf56(mark56, 'git/remotes').length === 1 && lastArgs('git/remotes').repo === '/tmp/ws')

console.log('')
console.log('== 单击行只换本页编辑目标：Ctrl+单击也是单击，生效仓库不动，草稿清空 ==')
const nameBox56 = () => rowInput56(tree, '名字（user.name）')
nameBox56().props.onChange({ target: { value: 'Draft' } })
tree = await settle()
mark56 = calls.length
repoRowOf(tree, '/tmp/lab').props.onClick({ ctrlKey: true, metaKey: false })
tree = await settle()
ok('Ctrl+单击 /tmp/lab：快照与远端表都改问 /tmp/lab（多选模式才会只改高亮不发读）',
  callsOf56(mark56, 'git/project-config').length === 1 && lastArgs('git/project-config').repo === '/tmp/lab'
  && callsOf56(mark56, 'git/remotes').length === 1 && lastArgs('git/remotes').repo === '/tmp/lab')
ok('选中行换到 /tmp/lab，● 仍在生效仓库 /tmp/ws 上',
  hasClass56(repoRowOf(tree, '/tmp/lab'), 'dsh-git-repo-sel')
  && hasClass56(repoRowOf(tree, '/tmp/ws'), 'dsh-git-repo-cur')
  && hasClass56(repoRowOf(tree, '/tmp/ws'), 'dsh-git-repo-sel') !== true)
ok('「此刻生效」跟着换了仓库：Lab（来自 .git/config）', saysOn(tree, 'Lab（来自 .git/config）'))
ok('对着上一个仓库打的草稿被清空（不留给下一个仓库误写）',
  nameBox56() !== undefined && nameBox56().props.value === '')
ok('远端表也换了仓库：lab 的远端是 up', saysOn(tree, 'https://example.com/lab.git'))
ok('没碰任何持久化（清单的 add/remove 一次都没发）', reposSaveCalls.length === 0)

console.log('')
console.log('== 写入落到编辑目标：请求带 repo，答复回读为准 ==')
nameBox56().props.onChange({ target: { value: 'LabName' } })
tree = await settle()
const writeBtn = () => buttons(tree).find((b) => textOf(b) === '写入本项目')
ok('按钮 title 明说写进哪个仓库', String(writeBtn().props.title).indexOf('/tmp/lab') >= 0)
writeBtn().props.onClick()
tree = await settle()
ok('发的是 git/project-config-save + repo:/tmp/lab + 会话',
  projectSaveCalls.length === 1 && projectSaveCalls[0].repo === '/tmp/lab'
  && projectSaveCalls[0].sessionId === 's-1'
  && JSON.stringify(projectSaveCalls[0].set) === JSON.stringify({ 'user.name': 'LabName' }))
ok('提示行带 Host 回读的落点：已写进 /tmp/lab 的 .git/config', saysOn(tree, '已写进 /tmp/lab 的 .git/config'))
ok('框里是答复的 local 值（写后回读，不回显输入）', nameBox56().props.value === 'LabName')

console.log('')
console.log('== ＋ 添加目录：同一份持久清单、同一套话术，加完自动选中 ==')
const addRow56 = () => byClass(tree, 'dsh-git-repo-add')[0]
addRow56().props.onClick()
tree = await settle()
const addInput = () => byClass(tree, 'dsh-git-repo-input')[0]
const addOk = () => buttons(tree).find((b) => textOf(b) === '添加')
ok('输入行出现了，空框时「添加」禁用', addInput() !== undefined && addOk().props.disabled === true)
addInput().props.onChange({ target: { value: '/tmp/third' } })
tree = await settle()
reposSaveReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/lab', '/tmp/third', '/tmp/ws'], manual: ['/tmp/third'], missing: [], truncated: false }
addOk().props.onClick()
tree = await settle()
ok('走的是 git/repos-save：{sessionId, add}，不带 repo（清单跟随项目，不由编辑目标决定）',
  reposSaveCalls.length === 1 && reposSaveCalls[0].sessionId === 's-1' && reposSaveCalls[0].add === '/tmp/third'
  && reposSaveCalls[0].repo === undefined && reposSaveCalls[0].remove === undefined)
ok('新行出现了，并且自动成为本页编辑目标（快照改问 /tmp/third）',
  repoRowOf(tree, '/tmp/third') !== undefined && hasClass56(repoRowOf(tree, '/tmp/third'), 'dsh-git-repo-sel')
  && lastArgs('git/project-config').repo === '/tmp/third' && lastArgs('git/remotes').repo === '/tmp/third')

console.log('')
console.log('== ＋ 添加目录：失败走 repoSaveProblem 的同一套话术 ==')
addRow56().props.onClick()
tree = await settle()
addInput().props.onChange({ target: { value: '/tmp/plain' } })
tree = await settle()
reposSaveReply = { ok: false, error: 'not-a-repository' }
addOk().props.onClick()
tree = await settle()
ok('输入框下面一句人话：这个目录不是 git 仓库（与历史页同一套 repoSaveProblem）',
  byClass(tree, 'dsh-git-repo-problem').length === 1
  && textOf(byClass(tree, 'dsh-git-repo-problem')[0]).indexOf('这个目录不是 git 仓库') >= 0)

console.log('')
console.log('== 写答复落地时目标已切走：一个字节不上屏 ==')
repoRowOf(tree, '/tmp/ws').props.onClick({})
tree = await settle()
nameBox56().props.onChange({ target: { value: 'Stale' } })
tree = await settle()
writeBtn().props.onClick()
repoRowOf(tree, '/tmp/lab').props.onClick({})
tree = await settle()
ok('写确实发出去了（repo 是点击时的 /tmp/ws）',
  projectSaveCalls.length === 2 && projectSaveCalls[1].repo === '/tmp/ws')
ok('答复落地时目标已是 /tmp/lab：草稿保持清空、提示与错误一个字都没有',
  nameBox56().props.value === '' && saysOn(tree, '已写进 /tmp/ws') !== true
  && byClass(tree, 'dsh-git-error').length === 0)
ok('屏上是新目标的快照：Lab（来自 .git/config）', saysOn(tree, 'Lab（来自 .git/config）'))

console.log('')
console.log('== 生效仓库不动：历史页的 ● 还在 /tmp/ws 上 ==')
tree = await clickText56(tree, '历史')
const curRows = byClass(tree, 'dsh-git-repo-cur')
ok('历史页侧栏的 ● 仍是 /tmp/ws（配置页的单击不换生效仓库）',
  curRows.length === 1 && String(curRows[0].props.title).indexOf('/tmp/ws') === 0)
ok('历史页侧栏仍是多选模式：「全部」行在（受控单选只属于配置页那一格）',
  byClass(tree, 'dsh-git-repo-row').some((r) => textOf(r).indexOf('全部') === 0))
tree = await clickText56(tree, '配置')
ok('切回配置页：编辑目标还是 /tmp/lab（按会话记的，跨页签保留）',
  hasClass56(repoRowOf(tree, '/tmp/lab'), 'dsh-git-repo-sel') && lastArgs('git/project-config').repo === '/tmp/lab')

console.log('')
console.log('== 新会话：missing 行只可移除、不可选中；移除的正是目标时退回生效仓库 ==')
/* 独立会话另给一份清单：手动登记的 /tmp/lab（行上才有 ×）+ 一个已不存在的路径。 */
reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/lab', '/tmp/ws'], manual: ['/tmp/lab'], missing: ['/tmp/gone'], truncated: false }
let treeB = await openConfigOn56('gp56-b', 's-56b')
const goneRow = repoRowOf(treeB, '/tmp/gone')
ok('「已不存在」行压暗、不带单击（点了也不会发任何读）',
  goneRow !== undefined && hasClass56(goneRow, 'dsh-git-repo-gone')
  && textOf(goneRow).indexOf('已不存在') >= 0 && goneRow.props.onClick === undefined)
treeB = await openConfigOn56('gp56-b2', 's-56b')
repoRowOf(treeB, '/tmp/lab').props.onClick({})
treeB = await openConfigOn56('gp56-b3', 's-56b')
ok('手动登记的 /tmp/lab 选中为本页目标（快照改问它）', lastArgs('git/project-config').repo === '/tmp/lab')
const labX = collect(repoRowOf(treeB, '/tmp/lab')).find((n) => n.type === 'button' && textOf(n) === '×')
ok('手动仓库行上有 ×（扫描来的行没有）',
  labX !== undefined && collect(repoRowOf(treeB, '/tmp/ws')).every((n) => !(n.type === 'button' && textOf(n) === '×')))
reposSaveReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws'], manual: [], missing: ['/tmp/gone'], truncated: false }
const markSaveB = reposSaveCalls.length
labX.props.onClick({})
treeB = await openConfigOn56('gp56-b4', 's-56b')
ok('移除发的是 remove，答复把行拿掉',
  reposSaveCalls.length === markSaveB + 1 && reposSaveCalls[markSaveB].sessionId === 's-56b'
  && reposSaveCalls[markSaveB].remove === '/tmp/lab'
  && repoRowOf(treeB, '/tmp/lab') === undefined)
ok('移除的正好是本页目标：编辑目标退回生效仓库 /tmp/ws（快照与远端跟着改问）',
  lastArgs('git/project-config').repo === '/tmp/ws' && lastArgs('git/remotes').repo === '/tmp/ws'
  && hasClass56(repoRowOf(treeB, '/tmp/ws'), 'dsh-git-repo-sel'))

console.log('')
console.log('== 会话完成组保持插件级：自动推送仍作用于生效仓库，照实说 ==')
ok('推送提示带那句「不随本页正在编辑的仓库走」', saysOn(treeB, '不随本页正在编辑的仓库走'))
ok('推送提示仍旧说清生效仓库与只推条件', saysOn(treeB, '对当前生效仓库执行一次 push') && saysOn(treeB, '领先远端且没有未解决冲突'))
const refreshRow56 = collect(treeB).find((n) => hasClass56(n, 'dsh-git-set-row') && textOf(n).indexOf('会话完成时刷新') >= 0)
ok('开关还是插件级那对：会话完成刷新的勾选框原样在', refreshRow56 !== undefined
  && collect(refreshRow56).some((n) => n.type === 'input' && n.props.type === 'checkbox'))
