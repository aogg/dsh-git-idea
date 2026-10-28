/* ═══ gp82：仓库分组（v0.2.9）的客户端这一半 ═══
 *
 * 盯 e1618b0 / 9a5c429 落下的四片：
 *   1. RepoSwitcher 的分组渲染（照 h() 树断言）：list.dirs.length > 0 就走分组
 *      —— 哪怕只有一组（登记项的组头是它唯一的可见落点）；组头 = 压暗小字 +
 *      folder 图标 + 目录短名（title=完整路径），登记目录组头带 ×（走
 *      git/repos-save 的 remove），伪组（工作区/手动登记）头不带 ×。
 *   2. repoGroupsOf 的归组语义从渲染结果看：组序 工作区 → 登记目录（按路径排序）
 *      → 手动登记；嵌套登记 /a 与 /a/b 取最长前缀；登记目录带尾斜杠与不带是同
 *      一个前缀；伪组空桶丢弃、登记目录空组保留（组头照画 + 压暗占位行「没扫到
 *      仓库」，不可点、无 ×）；工作区未知时全落手动登记组。零回归线：没登记
 *      目录且 ≤1 组时一张组头都不画。
 *   3. 20-prefs.js：repoDirs 照 repos 的先例原样搬运 —— 配置页改一个开关触发的
 *      整份保存必须把 Host 给的 repoDirs 一字不改地送回 git/config-save。
 *   4. 63-storedlists.js：旧盘账（无 dirs/dirRepos）读入不炸、按平铺垫底；内容
 *      比较把 dirs/dirRepos 一并投影 —— 同内容反复 adopt 不落盘，登记目录变了
 *      才落盘且新形状（带 dirs/dirRepos）上盘。
 *
 * 「刷新页面」沿 gp75 的先例：同一份 fakeDoc/localStorage 把 CLIENT_SRC 再求值
 * 一遍 —— 模块内存归零，盘账原样还在（repoLists / repoScanAsked 都住模块层，
 * 只清 fiber 是不够的）。 */

const K_RL82 = 'dsh.git-idea.repo-lists'
const CLIENT82 = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
/* 60-icons.js 的 ICON_PATHS.folder：组头图标断言认的就是这一个 path。 */
const FOLDER_D82 = 'M2.2 4.4 H6.4 L7.8 6.2 H13.8 V12.4 H2.2 Z'

/* ── mock：git/repos 答复按用例换；hold 住不回，才看得到盘账垫底的首帧 ── */
let repos82 = null
let holdRepos82 = false
const heldRepos82 = []
let reposSave82 = null
const reposSaveCalls82 = []
const configSaveCalls82 = []
const CONFIG82 = {
  ok: true, path: '/home/u/.dsh/dsh-git-idea.json',
  config: { initBranch: 'main', cherryPickRecord: false, repoDirs: { '/w/82': ['/dir/one', '/dir/two'] }, drafts: { '/tmp/ws': '写到一半' } },
}
const realCall82 = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    /* harness 的 OK_PANEL 带着 repo:'/tmp/ws'（全家族套件的工作区都是 /tmp/ws，
       所以从没人看见它）。本套件的工作区是自定义路径，那格 repo 会被 80-panel.js
       当成生效仓库补进 shown（reposShown），凭空多出一行 /tmp/ws → 多出一组
       「手动登记」。按家族「单仓库不带 repo」的既有口径把 repo 置空：清单语义
       只由 git/repos 的答复决定，正是这几个用例要盯的东西。 */
    return Promise.resolve(Object.assign({}, OK_PANEL, { repo: '' }))
  }
  if (method === 'git/repos') {
    calls.push({ method: method, args: args })
    if (holdRepos82 === true) return new Promise(function (resolve) { heldRepos82.push(resolve) })
    return Promise.resolve(repos82)
  }
  if (method === 'git/repos-save') { calls.push({ method: method, args: args }); reposSaveCalls82.push(args); return Promise.resolve(reposSave82) }
  if (method === 'git/config') return Promise.resolve(CONFIG82)
  if (method === 'git/config-save') {
    const saved = args != null && args.config != null ? args.config : {}
    configSaveCalls82.push(saved)
    return Promise.resolve({ ok: true, path: CONFIG82.path, config: saved })
  }
  return realCall82(method, args)
}
/* 放行：把扣着的扫描按新答复放回去（扣着的那份 promise 一直没回，不能只翻开关）。 */
const releaseRepos82 = function (reply) {
  repos82 = reply
  holdRepos82 = false
  const list = heldRepos82.splice(0)
  list.forEach(function (resolve) { resolve(reply) })
}

/* ── 取景工具 ── */
const heads82 = (t) => byClass(t, 'dsh-git-repo-ghead')
const gnames82 = (t) => byClass(t, 'dsh-git-repo-gname').map(textOf)
const gempty82 = (t) => byClass(t, 'dsh-git-repo-gempty')
const repoRowOf82 = (t, path) => byClass(t, 'dsh-git-repo-row').find((r) => typeof r.props.title === 'string' && r.props.title.indexOf(path) === 0)
const idx82 = (t, node) => collect(t).indexOf(node)
const buttonsIn82 = (n) => collect(n).filter((c) => c.type === 'button')
const readAccount82 = function () {
  try { const raw = store[K_RL82]; return raw == null ? null : JSON.parse(raw) } catch (error) { return null }
}
/* 再求值一遍 CLIENT_SRC = 一次「刷新」（gp75 同款）：模块内存全新，store 原样。 */
function evalInstance82() {
  const registered82 = []
  const slots82 = { inject: (k, cb) => cb(), register: (o, c) => { registered82.push({ options: o, component: c }); return () => {} } }
  const ctx82 = {
    get(n) {
      if (n === 'slots') return slots82
      if (n === 'timer') return ctx.get('timer')
      return undefined
    },
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
  }
  const host82 = { call(method, args) { return host.call(method, args) } }
  new Function('ctx', 'React', 'host', 'styles', 'console', CLIENT82)(
    ctx82, React, host82, { insert: () => () => {} }, console).apply(ctx82)
  const found82 = function (id) { return registered82.find((r) => r.options.id === id).component }
  return { chip: found82('dsh-git-idea-chip'), panel: found82('dsh-git-idea-panel') }
}
async function openPanel82(instObj, sid, label) {
  fibers.clear()
  const t = await renderUntilStable(makeElement(instObj.chip, { sessionId: sid }), (label || sid) + '-chip')
  if (String(t.props.className).indexOf('dsh-git-chip-open') < 0) { t.props.onClick(); await wait(10) }
  /* label 稳定在一个会话一个值：harness 的 fiber 按渲染路径+label 记账，换 label
     等于整树重挂 —— adding/tab 这些组件内 hook 状态全被清掉（gp75 的成法是全程
     一个 'pop-75r'）。点击后的每次 settle 必须还是这个 label，状态才存续。 */
  const stable82 = 'pop-' + sid
  let out = null
  for (let i = 0; i < 4; i += 1) { out = await renderUntilStable(makeElement(instObj.panel, { sessionId: sid, active: true, ready: true }), stable82); await wait(10) }
  return out
}
const settlePanel82 = async function (instObj, sid, label) {
  let out = null
  for (let i = 0; i < 4; i += 1) { out = await renderUntilStable(makeElement(instObj.panel, { sessionId: sid, active: true, ready: true }), 'pop-' + sid); await wait(10) }
  return out
}
const fireTimers82 = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}
/* 简单答复的成法：所有字段一齐给，谁缺省一目了然。 */
const reply82 = function (workspace, extra) {
  return Object.assign({ ok: true, workspace: workspace, repos: [], manual: [], missing: [], links: [], dirs: [], dirRepos: {}, truncated: false }, extra)
}

console.log('')
console.log('== 分组触发：登记了目录就走分组，哪怕只有一组 ==')
const MAIN82 = { chip: chip, panel: popover }
const DA = '/tmp/gp82/a/dir'
const WSA = '/tmp/gp82/a/ws'
repos82 = reply82(WSA, { repos: [DA + '/proj'], dirs: [DA], dirRepos: { [DA]: [DA + '/proj'] } })
let inst = MAIN82
let tree = await openPanel82(inst, 's-82a', 'pop-82a')
const headsA = heads82(tree)
ok('dirs>0 且只有一组：组头照画（登记项的唯一可见落点，不退回平铺）',
  headsA.length === 1 && gnames82(tree).join('|') === 'dir')
ok('组头三件套：title=完整路径、folder 图标（ICON_PATHS.folder 那一条 path）、短名取 basename',
  String(headsA[0].props.title) === DA
  && collect(headsA[0]).some((n) => n.props != null && n.props.d === FOLDER_D82)
  && textOf(headsA[0]).indexOf('dir') >= 0)
const dirX82 = buttonsIn82(headsA[0]).find((b) => textOf(b) === '×')
ok('登记目录组头带一枚 ×，title 说的是移除登记（不是移除仓库那句话）',
  dirX82 !== undefined && String(dirX82.props.title).indexOf('移除这个登记目录') === 0)
ok('仓库行跟在组头后面（组内顺序 = 清单顺序），「全部」行照旧在最前',
  idx82(tree, headsA[0]) < idx82(tree, repoRowOf82(tree, DA + '/proj'))
  && byClass(tree, 'dsh-git-repo-row').some((r) => textOf(r).indexOf('全部') === 0))
ok('只有一组也没有伪组头（工作区/手动登记的空桶丢弃）',
  gnames82(tree).indexOf('工作区') < 0 && gnames82(tree).indexOf('手动登记') < 0)

console.log('')
console.log('== 组头 × 就是 remove 那条老路 ==')
reposSave82 = reply82(WSA, { repos: [], manual: [], missing: [], links: [], dirs: [], dirRepos: {} })
dirX82.props.onClick({})
await wait(20)
tree = await settlePanel82(inst, 's-82a', 'pop-82a2')
ok('× 点击发的是 git/repos-save {sessionId, remove:<登记目录>}，不带 add',
  reposSaveCalls82.length === 1 && reposSaveCalls82[0].sessionId === 's-82a'
  && reposSaveCalls82[0].remove === DA && reposSaveCalls82[0].add === undefined)
ok('答复 adopt 后组头与仓库行一起消失（分组随之取消）',
  heads82(tree).length === 0 && repoRowOf82(tree, DA + '/proj') === undefined)

console.log('')
console.log('== 零回归线：没登记目录且只有一组 → 一张组头都不画 ==')
const WSB = '/tmp/gp82/b/ws'
repos82 = reply82(WSB, { repos: ['/tmp/gp82/b/ws/one', '/tmp/gp82/b/ws/two'] })
tree = await openPanel82(inst, 's-82b', 'pop-82b')
const rowOne82 = repoRowOf82(tree, '/tmp/gp82/b/ws/one')
const rowTwo82 = repoRowOf82(tree, '/tmp/gp82/b/ws/two')
ok('无 dirs 且组数 ≤1：平铺 —— 组头、占位行一个都没有，两行按清单顺序在',
  heads82(tree).length === 0 && gempty82(tree).length === 0 && gnames82(tree).length === 0
  && rowOne82 !== undefined && rowTwo82 !== undefined && idx82(tree, rowOne82) < idx82(tree, rowTwo82))

console.log('')
console.log('== 没登记目录但仓库跨容器（工作区 + 工作区外）→ 两组伪组头，都不带 × ==')
const WSC = '/tmp/gp82/c/ws'
repos82 = reply82(WSC, { repos: [WSC + '/in', '/tmp/gp82-elsewhere/out'] })
tree = await openPanel82(inst, 's-82c', 'pop-82c')
const headsC = heads82(tree)
ok('两组起走分组：组序 工作区 → 手动登记，组名与 title 各就各位',
  headsC.length === 2 && gnames82(tree).join('|') === '工作区|手动登记'
  && String(headsC[0].props.title) === WSC
  && String(headsC[1].props.title) === '工作区之外手动登记的仓库')
ok('伪组头只是分组的衍生物：两枚组头一枚 × 都没有',
  buttonsIn82(headsC[0]).length === 0 && buttonsIn82(headsC[1]).length === 0)
ok('行各归各组：in 在工作区头之后、手动登记头之前，out 在最后',
  idx82(tree, headsC[0]) < idx82(tree, repoRowOf82(tree, WSC + '/in'))
  && idx82(tree, repoRowOf82(tree, WSC + '/in')) < idx82(tree, headsC[1])
  && idx82(tree, headsC[1]) < idx82(tree, repoRowOf82(tree, '/tmp/gp82-elsewhere/out')))

console.log('')
console.log('== 嵌套登记取最长前缀；尾斜杠同前缀 ==')
const NA = '/tmp/gp82/d/nest/a'
const NAB = NA + '/b'
repos82 = reply82('/tmp/gp82/d/ws', {
  repos: [NA + '/loose', NAB + '/deep'],
  dirs: [NA + '/', NAB],
  dirRepos: { [NA + '/']: [NA + '/loose'], [NAB]: [NAB + '/deep'] },
})
tree = await openPanel82(inst, 's-82d', 'pop-82d')
const headsD = heads82(tree)
ok('两个登记目录两组头，组序按路径排序（a → a/b），伪组空桶不画',
  headsD.length === 2 && gnames82(tree).join('|') === 'a|b'
  && String(headsD[0].props.title) === NA && String(headsD[1].props.title) === NAB)
ok('登记原文的尾斜杠不另立门户：a/ 的组头 title 是去尾斜杠后的同一路径',
  String(headsD[0].props.title).indexOf(NA + '/') !== 0)
ok('最长前缀赢：deep 归 a/b 组（不是 a），loose 归 a 组',
  idx82(tree, headsD[0]) < idx82(tree, repoRowOf82(tree, NA + '/loose'))
  && idx82(tree, repoRowOf82(tree, NA + '/loose')) < idx82(tree, headsD[1])
  && idx82(tree, headsD[1]) < idx82(tree, repoRowOf82(tree, NAB + '/deep')))

console.log('')
console.log('== 空登记目录组：组头照画可移除，占位行不可点、无 × ==')
const EE = '/tmp/gp82/e/empty'
repos82 = reply82('/tmp/gp82/e/ws', { repos: [], dirs: [EE], dirRepos: {} })
tree = await openPanel82(inst, 's-82e', 'pop-82e')
const headsE = heads82(tree)
const gemptyE = gempty82(tree)
ok('登记目录一个仓库都没扫到：组头照画（× 在），不会变成看不见也删不掉的幽灵',
  headsE.length === 1 && gnames82(tree).join('|') === 'empty' && String(headsE[0].props.title) === EE
  && buttonsIn82(headsE[0]).some((b) => textOf(b) === '×'))
ok('组头底下跟一行压暗占位「没扫到仓库」，title 点名目录与原因',
  gemptyE.length === 1 && textOf(gemptyE[0]).indexOf('没扫到仓库') >= 0
  && String(gemptyE[0].props.title).indexOf(EE) === 0)
ok('占位行不是仓库行：没有 onClick、没有按钮、也不是带选中语义的仓库行类',
  gemptyE[0].props.onClick === undefined && buttonsIn82(gemptyE[0]).length === 0
  && String(gemptyE[0].props.className) === 'dsh-git-repo-gempty')
ok('清单空了也没有伪组头跟着画', gnames82(tree).indexOf('工作区') < 0 && gnames82(tree).indexOf('手动登记') < 0)

console.log('')
console.log('== missing 行与「添加目录」不受分组影响 ==')
const WSG = '/tmp/gp82/g/ws'
repos82 = reply82(WSG, { repos: [WSG + '/in'], manual: [WSG + '/in'], missing: ['/tmp/gp82/g/gone'] })
tree = await openPanel82(inst, 's-82g', 'pop-82g')
const goneRow82 = repoRowOf82(tree, '/tmp/gp82/g/gone')
ok('missing 行照旧：压暗、「已不存在」、整行不可点',
  goneRow82 !== undefined && String(goneRow82.props.className).indexOf('dsh-git-repo-gone') >= 0
  && textOf(goneRow82).indexOf('已不存在') >= 0 && goneRow82.props.onClick === undefined)
const addRow82 = byClass(tree, 'dsh-git-repo-add')[0]
ok('「添加目录」那行照旧，title 说清「目录自己不必是仓库」',
  addRow82 !== undefined && String(addRow82.props.title).indexOf('目录自己不必是仓库') > 0)
addRow82.props.onClick()
tree = await settlePanel82(inst, 's-82g', 'pop-82g2')
const addInput82 = byClass(tree, 'dsh-git-repo-input')[0]
ok('输入行的 placeholder 是「仓库或含仓库的目录」都行',
  addInput82 !== undefined && addInput82.props.placeholder === '仓库或含仓库的目录，绝对路径')

console.log('')
console.log('== 工作区未知（盘账垫底、扫描扣着）：全部归手动登记组 ==')
store[K_RL82] = JSON.stringify({
  's-82h': { data: { repos: ['/tmp/gp82/h/elsewhere/proj'], manual: [], missing: [], links: [], dirs: ['/tmp/gp82/h/seeded'], dirRepos: {}, note: '' }, at: 1 },
})
holdRepos82 = true
inst = evalInstance82()
tree = await openPanel82(inst, 's-82h', 'pop-82h')
const headsH = heads82(tree)
ok('盘账垫底首帧走分组（dirs 在盘账里）：登记目录组头 + 手动登记组头',
  headsH.length === 2 && gnames82(tree).join('|') === 'seeded|手动登记')
ok('工作区还不知道：proj 不在登记目录下也不在工作区下 → 落手动登记，没有「工作区」组头',
  gnames82(tree).indexOf('工作区') < 0
  && idx82(tree, headsH[1]) < idx82(tree, repoRowOf82(tree, '/tmp/gp82/h/elsewhere/proj')))
releaseRepos82(reply82('/tmp/gp82/h/ws', {
  repos: ['/tmp/gp82/h/ws/inner', '/tmp/gp82/h/elsewhere/proj'],
  dirs: ['/tmp/gp82/h/seeded'],
  dirRepos: { ['/tmp/gp82/h/seeded']: [] },
}))
await wait(20)
tree = await settlePanel82(inst, 's-82h', 'pop-82h2')
const headsH2 = heads82(tree)
ok('扫描答复落地、工作区已知：组序 工作区 → 登记目录 → 手动登记，ws/inner 归工作区组',
  headsH2.length === 3 && gnames82(tree).join('|') === '工作区|seeded|手动登记'
  && idx82(tree, headsH2[0]) < idx82(tree, repoRowOf82(tree, '/tmp/gp82/h/ws/inner'))
  && idx82(tree, repoRowOf82(tree, '/tmp/gp82/h/ws/inner')) < idx82(tree, headsH2[1]))
delete store[K_RL82]

console.log('')
console.log('== 20-prefs：整份归一化把 repoDirs 原样送回（配置页一次整份保存）==')
inst = evalInstance82()
fibers.clear()
let cfgTree = await openPanel82(inst, 's-82cfg', 'pop-82cfg')
const cfgTab = buttons(cfgTree).find((b) => textOf(b) === '配置')
if (cfgTab === undefined) throw new Error('配置 tab not found')
cfgTab.props.onClick()
cfgTree = await settlePanel82(inst, 's-82cfg', 'pop-82cfg2')
const globalBtn = buttons(cfgTree).find((b) => textOf(b) === '全局配置')
if (globalBtn === undefined) throw new Error('全局配置 tab not found')
if (String(globalBtn.props.className).indexOf('dsh-git-cview-on') < 0) { globalBtn.props.onClick(); cfgTree = await settlePanel82(inst, 's-82cfg', 'pop-82cfg3') }
const cherryRow82 = collect(cfgTree).find((n) => n.type === 'label' && textOf(n).indexOf('cherry-pick 时记录来源') >= 0)
const flip82 = cherryRow82 !== undefined ? collect(cherryRow82).find((n) => n.type === 'input' && n.props.type === 'checkbox') : undefined
ok('全局配置页开了，插件开关找到（初值来自 mock 配置的 false）',
  byClass(cfgTree, 'dsh-git-global').length > 0 && flip82 !== undefined && flip82.props.checked === false)
flip82.props.onChange({ target: { checked: true } })
await wait(10)
fireTimers82(400)
await wait(10)
const saved82 = configSaveCalls82.length > 0 ? configSaveCalls82[configSaveCalls82.length - 1] : null
ok('开关触发的整份保存：repoDirs 一字不改地送回（「登记目录不再被整份保存抹掉」的口子）',
  saved82 != null && JSON.stringify(saved82.repoDirs) === JSON.stringify({ '/w/82': ['/dir/one', '/dir/two'] }))
ok('同一次保存里草稿也还在（既有先例不回归），开关的值真的翻了',
  saved82.drafts != null && saved82.drafts['/tmp/ws'] === '写到一半' && saved82.cherryPickRecord === true)

console.log('')
console.log('== 63-storedlists：旧盘账读入不炸；内容比较带上 dirs/dirRepos ==')
store[K_RL82] = JSON.stringify({
  's-82o': { data: { repos: ['/tmp/gp82/o/one', '/tmp/gp82/o/two'], manual: [], missing: [], links: [], note: '' }, at: 1 },
})
const seeded82 = store[K_RL82]
let rlWrites82 = 0
const savedView82 = fakeDoc.defaultView
fakeDoc.defaultView = {
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { if (k === K_RL82) rlWrites82 += 1; store[k] = String(v) },
  },
}
inst = evalInstance82()
holdRepos82 = true
tree = await openPanel82(inst, 's-82o', 'pop-82o')
ok('旧盘账（无 dirs/dirRepos 两格）读入不炸：两行按平铺垫底，没有组头',
  repoRowOf82(tree, '/tmp/gp82/o/one') !== undefined && repoRowOf82(tree, '/tmp/gp82/o/two') !== undefined
  && heads82(tree).length === 0 && gempty82(tree).length === 0
  && textOf(tree).indexOf('正在扫描') < 0)
releaseRepos82(reply82('/tmp/gp82/o/ws', { repos: ['/tmp/gp82/o/one', '/tmp/gp82/o/two'] }))
await wait(20)
tree = await settlePanel82(inst, 's-82o', 'pop-82o2')
/* 读入清洗（63-storedlists.js 的 sanitize）在读旧账那一刻就已把 dirs/dirRepos 补成
   新形状，同一份内容的答复 adopt 时内容比较判一致 —— 盘上一个字节都不动，「新形状
   上盘」要等内容真变（下面登记目录变了的那次）。 */
ok('扫描答复（内容同账、dirs/dirRepos 缺省空）adopt：内容比较判一致 → 不落盘（字节原样），首帧仍平铺',
  rlWrites82 === 0 && store[K_RL82] === seeded82 && heads82(tree).length === 0)
/* 内容级去重的另一半：Host 对重复登记回一份与现账逐字一致的清单 → adopt 不落盘。
   走「添加目录」的输入行触发第二次 adopt（repoScanAsked 挡住了再扫，save 是同会话
   再 adopt 的自然入口）。 */
const bytes82 = store[K_RL82]
const midWrites82 = rlWrites82
reposSave82 = reply82('/tmp/gp82/o/ws', { repos: ['/tmp/gp82/o/one', '/tmp/gp82/o/two'] })
byClass(tree, 'dsh-git-repo-add')[0].props.onClick()
tree = await settlePanel82(inst, 's-82o', 'pop-82o3')
byClass(tree, 'dsh-git-repo-input')[0].props.onChange({ target: { value: '/tmp/gp82/o/one' } })
tree = await settlePanel82(inst, 's-82o', 'pop-82o4')
buttons(tree).find((b) => textOf(b) === '添加').props.onClick()
await wait(20)
tree = await settlePanel82(inst, 's-82o', 'pop-82o5')
ok('与现账逐字一致的 repos-save 答复：adopt 不落盘（repo-lists 的 setItem 计数一动不动、字节不变）',
  rlWrites82 === midWrites82 && store[K_RL82] === bytes82)
/* 登记目录变了：内容比较判不一致 → 落盘且新形状上盘，分组跟着重画。 */
reposSave82 = reply82('/tmp/gp82/o/ws', {
  repos: ['/tmp/gp82/o/one', '/tmp/gp82/o/two'],
  dirs: ['/tmp/gp82/o/newdir'],
  dirRepos: { ['/tmp/gp82/o/newdir']: ['/tmp/gp82/o/one'] },
})
byClass(tree, 'dsh-git-repo-add')[0].props.onClick()
tree = await settlePanel82(inst, 's-82o', 'pop-82o6')
byClass(tree, 'dsh-git-repo-input')[0].props.onChange({ target: { value: '/tmp/gp82/o/two' } })
tree = await settlePanel82(inst, 's-82o', 'pop-82o7')
buttons(tree).find((b) => textOf(b) === '添加').props.onClick()
await wait(20)
tree = await settlePanel82(inst, 's-82o', 'pop-82o8')
ok('登记目录变了：内容比较判不一致，落盘一次，盘上 dirs/dirRepos 是新的',
  rlWrites82 === midWrites82 + 1
  && JSON.stringify(readAccount82()['s-82o'].data.dirs) === JSON.stringify(['/tmp/gp82/o/newdir'])
  && JSON.stringify(readAccount82()['s-82o'].data.dirRepos) === JSON.stringify({ ['/tmp/gp82/o/newdir']: ['/tmp/gp82/o/one'] }))
/* two 在工作区外（/tmp/gp82/o/two 与工作区 /tmp/gp82/o/ws 是兄弟）：登记目录组照画，
   它归「手动登记」伪组 —— 分组语义照旧，不因登记目录的存在改道。 */
ok('分组跟着新账重画：登记目录组头出现，子孙仓库行在它后面，工作区外的 two 归手动登记组',
  heads82(tree).length === 2 && gnames82(tree).join('|') === 'newdir|手动登记'
  && idx82(tree, heads82(tree)[0]) < idx82(tree, repoRowOf82(tree, '/tmp/gp82/o/one'))
  && idx82(tree, heads82(tree)[1]) < idx82(tree, repoRowOf82(tree, '/tmp/gp82/o/two')))
fakeDoc.defaultView = savedView82
delete store[K_RL82]
