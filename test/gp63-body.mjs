/* ═══ gp63：worktree 的目录映射（客户端这一半）═══
 *
 * 宿主半侧在 gp63-host-test.mjs（清洗矩阵、识别链路的前缀替换）。这里钉浏览器
 * 这一半的三个面：
 *   1. 配置页「全局配置」多出的 worktree 组：组头、说明文案（虚拟机挂载的类比、
 *      前缀匹配替换、D:/ 与 D:\ 两种写法）与「目录映射」编辑器都在；初始两条
 *      映射画成「原目录 → 替换目录」两列行（类名 dsh-git-wdm-*，不进 qc 的账）。
 *   2. 编辑器交互（QuickCommandsEditor 同一副骨架）：编辑一条（两个输入框预填、
 *      保存走整份插件配置、id 保留）、新增（空着保存被拦「原目录和替换目录都要
 *      填」、填齐才落）、删除两段式（第一次换成「确认删除」不写、第二次才写），
 *      每次保存经 400ms 去抖发 git/config-save、答复 adopt 后列表换新账。
 *   3. 20-prefs.js：整份插件配置归一化原样搬运 worktreeDirMappings —— 配置页改
 *      一个开关触发的整份保存必须把它一字不改地送回（worktreeMains/gp61、
 *      appliedRepos/gp62 同一批对照）。
 * mock：git/config 带两条初始映射；git/config-save 记账并原样回声（与宿主的
 * 「答复带清洗后的整份配置」同一形状）。 */

/* ── mock：git/config 罐头；config-save 记账 + 回声 ── */
const MAPPINGS63 = [
  { id: 'wdm-a', from: 'D:/code/www/gs/zuodian', to: '/code/www/gs/zuodian' },
  { id: 'wdm-b', from: 'E:\\work\\lab', to: '/code/www/lab' },
]
const CONFIG63 = {
  ok: true, path: '/home/u/.dsh/dsh-git-idea.json',
  config: {
    initBranch: 'main', cherryPickRecord: false,
    worktreeDirMappings: MAPPINGS63.slice(),
    drafts: { '/tmp/ws': '写到一半' },
  },
}
const configSaves63 = []
const realCall63 = host.call
host.call = function (method, args) {
  if (method === 'git/config') return Promise.resolve(CONFIG63)
  if (method === 'git/config-save') {
    const saved = args != null && args.config != null ? args.config : {}
    configSaves63.push(saved)
    return Promise.resolve({ ok: true, path: CONFIG63.path, config: saved })
  }
  return realCall63(method, args)
}

/* ── 取景工具 ── */
const saveConfig63 = function () { return configSaves63.length > 0 ? configSaves63[configSaves63.length - 1] : undefined }
const fireTimers63 = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}
const pop63 = () => renderUntilStable(makeElement(popover, { sessionId: 's-63' }), 'pop')
const wdmEditor63 = (t) => byClass(t, 'dsh-git-qc-box').find(function (box) {
  /* 列表态的标题是「目录映射（n/50）」、编辑态是「新建/编辑目录映射」—— 都认。 */
  const head = byClass(box, 'dsh-git-qc-head')[0]
  return head != null && textOf(head).indexOf('目录映射') >= 0
})
const wdmRows63 = (t) => { const box = wdmEditor63(t); return box == null ? [] : byClass(box, 'dsh-git-wdm-row') }
const wdmInputs63 = (box) => collect(box).filter(function (n) { return n.type === 'input' })
const btnIn63 = function (node, label) {
  return buttons(node).find(function (b) { return textOf(b) === label })
}

/* ── 1. 全局配置页的 worktree 组与编辑器 ── */
console.log('')
console.log('== 全局配置：worktree 组、说明文案与目录映射编辑器 ==')
let t63 = await openConfig('global', 'cfg-63')
const wdmGroup63 = collect(t63).find(function (n) {
  return n.props.className === 'dsh-git-set-group' && textOf(n) === 'worktree'
})
ok('「worktree」分组在（快捷命令之后、git 位置之前）', wdmGroup63 !== undefined)
const wdmHint63 = collect(t63).find(function (n) {
  return String(n.props.className).indexOf('dsh-git-set-hint') >= 0 && textOf(n).indexOf('虚拟机挂载的目录映射') >= 0
})
ok('说明文案讲到点子上：虚拟机挂载的类比、前缀匹配替换、D:/ 与 D:\\ 两种写法',
  wdmHint63 !== undefined && textOf(wdmHint63).indexOf('前缀匹配替换') >= 0
  && textOf(wdmHint63).indexOf('D:\\…') >= 0)
const editor63 = wdmEditor63(t63)
ok('「目录映射」编辑器在（qc-box 家族的盒子，计数的行是 wdm 自己的类名）',
  editor63 !== undefined && wdmRows63(t63).length === 2)
ok('标题带条数（2/50），行画成「原目录 → 替换目录」',
  textOf(byClass(editor63, 'dsh-git-qc-head')[0]).indexOf('目录映射（2/50）') === 0
  && textOf(wdmRows63(t63)[0]).indexOf('D:/code/www/gs/zuodian') >= 0
  && textOf(wdmRows63(t63)[0]).indexOf('→') >= 0
  && textOf(wdmRows63(t63)[0]).indexOf('/code/www/gs/zuodian') >= 0
  && textOf(wdmRows63(t63)[1]).indexOf('E:\\work\\lab') >= 0)
ok('快捷命令编辑器还在、各画各的行（qc 的行没被 wdm 混进来）',
  byClass(t63, 'dsh-git-qc-row').length === 0 && byClass(t63, 'dsh-git-wdm-row').length === 2)

/* ── 2. 编辑器交互：编辑 / 新增（含被拦）/ 删除两段式 ── */
console.log('')
console.log('== 编辑器：编辑一条（id 保留）→ 整份保存 → adopt 换新账 ==')
btnIn63(wdmRows63(t63)[0], '编辑').props.onClick()
t63 = await pop63()
let editing63 = wdmEditor63(t63)
let fields63 = wdmInputs63(editing63)
ok('编辑态：两个输入框预填这条映射的 from / to',
  fields63.length === 2 && fields63[0].props.value === 'D:/code/www/gs/zuodian'
  && fields63[1].props.value === '/code/www/gs/zuodian')
fields63[0].props.onChange({ target: { value: 'D:/code/www/gs/zuodian2' } })
t63 = await pop63()
btnIn63(wdmEditor63(t63), '保存').props.onClick()
t63 = await pop63()
await wait(10)
fireTimers63(400)
await wait(10)
t63 = await pop63()
const savedEdit63 = saveConfig63()
ok('保存走整份插件配置（400ms 去抖后 git/config-save）：改过的 from 落盘、id 保留、另一条不动',
  savedEdit63 != null && Array.isArray(savedEdit63.worktreeDirMappings)
  && savedEdit63.worktreeDirMappings[0].id === 'wdm-a'
  && savedEdit63.worktreeDirMappings[0].from === 'D:/code/www/gs/zuodian2'
  && JSON.stringify(savedEdit63.worktreeDirMappings[1]) === JSON.stringify(MAPPINGS63[1]))
ok('答复 adopt 后列表是新账（第一行的 from 已换）',
  wdmRows63(t63).length === 2 && textOf(wdmRows63(t63)[0]).indexOf('D:/code/www/gs/zuodian2') >= 0)
ok('同一次保存里草稿也还在（整份保存不抹别的键的既有先例不回归）',
  savedEdit63.drafts != null && savedEdit63.drafts['/tmp/ws'] === '写到一半')

console.log('')
console.log('== 编辑器：新增 —— 空着保存被拦，填齐才落；id 是新造的稳定串 ==')
const markSave63 = configSaves63.length
btnIn63(wdmEditor63(t63), '新增').props.onClick()
t63 = await pop63()
let creating63 = wdmEditor63(t63)
let newFields63 = wdmInputs63(creating63)
ok('新增态：两个输入框都是空的', newFields63.length === 2
  && newFields63[0].props.value === '' && newFields63[1].props.value === '')
newFields63[0].props.onChange({ target: { value: 'D:/x' } })
t63 = await pop63()
btnIn63(wdmEditor63(t63), '保存').props.onClick()
t63 = await pop63()
ok('只填了原目录：保存被拦（「原目录和替换目录都要填」），一次 git/config-save 都没发',
  wdmEditor63(t63) !== undefined
  && textOf(collect(wdmEditor63(t63)).find(function (n) { return String(n.props.className).indexOf('dsh-git-error') >= 0 })).indexOf('原目录和替换目录都要填') >= 0
  && configSaves63.length === markSave63)
const fillTo63 = wdmInputs63(wdmEditor63(t63))
fillTo63[1].props.onChange({ target: { value: '/code/x' } })
t63 = await pop63()
btnIn63(wdmEditor63(t63), '保存').props.onClick()
t63 = await pop63()
await wait(10)
fireTimers63(400)
await wait(10)
t63 = await pop63()
const savedNew63 = saveConfig63()
ok('填齐了才落：第三条进配置，新 id 是补造的稳定串（不是 undefined、不与旧 id 撞）',
  savedNew63 != null && savedNew63.worktreeDirMappings.length === 3
  && savedNew63.worktreeDirMappings[2].from === 'D:/x' && savedNew63.worktreeDirMappings[2].to === '/code/x'
  && typeof savedNew63.worktreeDirMappings[2].id === 'string' && savedNew63.worktreeDirMappings[2].id.length > 0
  && savedNew63.worktreeDirMappings[2].id !== 'wdm-a' && savedNew63.worktreeDirMappings[2].id !== 'wdm-b')
ok('列表跟着换新账（3/50，第三行是 D:/x → /code/x）',
  wdmRows63(t63).length === 3
  && textOf(byClass(wdmEditor63(t63), 'dsh-git-qc-head')[0]).indexOf('目录映射（3/50）') === 0
  && textOf(wdmRows63(t63)[2]).indexOf('D:/x') >= 0 && textOf(wdmRows63(t63)[2]).indexOf('/code/x') >= 0)

console.log('')
console.log('== 编辑器：删除两段式 —— 第一次只亮「确认删除」，第二次才写 ==')
const markDel63 = configSaves63.length
btnIn63(wdmRows63(t63)[1], '删除').props.onClick()
t63 = await pop63()
ok('第一次点：按钮换成「确认删除」，配置一个字节没写',
  textOf(btnIn63(wdmRows63(t63)[1], '确认删除')) === '确认删除' && configSaves63.length === markDel63)
btnIn63(wdmRows63(t63)[1], '确认删除').props.onClick()
t63 = await pop63()
await wait(10)
fireTimers63(400)
await wait(10)
t63 = await pop63()
const savedDel63 = saveConfig63()
ok('第二次点才写：那条没了（剩下 2 条，wdm-a 与新造的那条），去抖后落盘',
  savedDel63 != null && savedDel63.worktreeDirMappings.length === 2
  && savedDel63.worktreeDirMappings.some(function (m) { return m.id === 'wdm-a' })
  && savedDel63.worktreeDirMappings.some(function (m) { return m.from === 'D:/x' })
  && savedDel63.worktreeDirMappings.some(function (m) { return m.id === 'wdm-b' }) === false)
ok('列表同步（2 行）', wdmRows63(t63).length === 2)

/* ── 3. 20-prefs：整份归一化原样搬运 worktreeDirMappings ── */
console.log('')
console.log('== 20-prefs：整份归一化把 worktreeDirMappings 原样送回（一次整份保存）==')
const beforeFlip63 = saveConfig63().worktreeDirMappings
const cherryRow63 = collect(t63).find(function (n) {
  return n.type === 'label' && textOf(n).indexOf('cherry-pick 时记录来源') >= 0
})
const flip63 = cherryRow63 !== undefined ? collect(cherryRow63).find(function (n) {
  return n.type === 'input' && n.props.type === 'checkbox'
}) : undefined
ok('插件行为的开关找到了（cherry-pick 记录来源，初值来自 mock 配置的 false）',
  flip63 !== undefined && flip63.props.checked === false)
flip63.props.onChange({ target: { checked: true } })
await wait(10)
fireTimers63(400)
await wait(10)
const savedFlip63 = saveConfig63()
ok('开关触发的整份保存：worktreeDirMappings 一字不改地送回（「手工映射不再被抹」的口子）',
  savedFlip63 != null && JSON.stringify(savedFlip63.worktreeDirMappings) === JSON.stringify(beforeFlip63))
ok('同一次保存里草稿也还在、开关的值真的翻了',
  savedFlip63.drafts != null && savedFlip63.drafts['/tmp/ws'] === '写到一半'
  && savedFlip63.cherryPickRecord === true)
