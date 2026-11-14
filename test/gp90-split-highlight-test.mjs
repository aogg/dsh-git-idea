import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeEnv } from './gp69-env.mjs'

/* ═══ gp90：历史页两道竖向分割线 + fetch 新分支行高亮（60d0183 + 63c3242）═══
 *
 * 两个功能、两套账，一个套件盯三层：
 *
 *   1. 工作区账层（10-state.js 的 workspace-layout，源码级求值整份 63-storedlists.js
 *      + 10-state.js，diagLog/healGitFloat 两个跨片符号用桩喂进 —— gp88 对
 *      25-worktree.js 的同一写法；63 在 10-state 前求值不影响：函数声明在整个闭包
 *      里提升，与 build.mjs 胶合后的作用域同形）：
 *        · 账形状与键：localStorage 键 dsh.git-idea.workspace-layout，一格 = 一个
 *          工作区路径 → { data:{left,detail,w,h}, at }；落账只在键解析出来之后
 *          （空键不上盘），一次落一整格（尺寸+两道分栏四样数永远对得上）；
 *        · 读入清洗：畸形条目整条丢、left/detail 钳进上下限、w/h 沿用面板尺寸老
 *          语义（>0 取整否则 0）、at 非有限数记 0 —— localStorage 谁都能写；
 *        · 无账回落：面板尺寸回落旧全局账 dsh.git-idea.panel（迁移兜底，只读不删），
 *          分栏回落 208/280 现值 —— 老读者升级后第一次打开不闪回默认；
 *        · LRU：容量 30、队满删队首；同内容 put 不落盘也不挪位置（内容级去重），
 *          异内容 put 先删再插队尾；写失败静默只留内存；
 *        · 钳制函数 clampSplitWidth：parseFloat+取整+钳区间，不是数回落默认，
 *          max<min 时下限赢（body 特别窄时两栏保底、主列表让步的那条铁律）；
 *        · 常量钉死：左栏 160~420、详情栏 200~480、主列表保底 280、默认 208/280。
 *
 *   2. fetch 新分支高亮账（10-state.js，同一求值世界）：
 *        · 名字口径 refNamesOfRefsReply：本地收 local[].data（无前缀）、远端收
 *          remote[].refs[].data（带远端前缀）、current 不收（那是 unborn 推导不是
 *          ref）；答复坏（null / ok!==true）返回 null，空库返回空对象 —— 「没读过」
 *          与「读过但为空」是两件事；
 *        · arm→settle 净新增结算：arm 从 refsTreeStored 钉 fetch 前集合，settle 在
 *          refs 答复到达时结算差集入账、bump 版本、发 signal、排 TTL 清扫；一次 arm
 *          只结算一次（「fetch 之后 refs 恰好没变」的那次也把基线收掉）；答复
 *          self-report 的仓库路径（data.repo）与请求键不同时双写两格（同一份名字）；
 *        · 边界三条：基线不可知（没 arm 过 / arm 时盘上没账）不高亮；空库基线
 *          （第一次 fetch 从无到有）不高亮；坏答复只消费 arm 不入账；
 *        · TTL 清扫：只摘到龄的格（每格 at 独立），没到龄的续排最近一次到点；
 *        · 切仓库隔离 markBranchHighlightScope：真换仓清掉别的格并发 signal，
 *          同仓重入一字不动，空键不认。
 *
 *   3. 面板世界（gp73/gp88 同一副骨架：gp69-env 挂真面板，host.call 桩）——
 *      两功能在真渲染里的接线各钉一遍：
 *        · 分栏：宽屏 body 挂两道把手与两个 CSS 变量、变量值来自工作区账（种子格
 *          300/360、面板 800×600 一并上画）；拖左/右把手走 document 级 pointer
 *          事件，钳制按「按下那一刻量定的 bodyW − 主列表保底 − 另一侧宽」算，松手
 *          落账进 localStorage；bodyW 量不到只剩固定上下限；非左键按下不拖；
 *        · 高亮：⇣ fetch 成功（先 arm 再 bump）→ refs 重读答复到达 → 净新增的本地
 *          与远端行挂 dsh-git-branch-new、基线里已有的行与 HEAD 组行不挂；TTL 到点
 *          清扫后行回归素面；fetch 没带来新分支不高亮；fetch 失败不 arm（外部改
 *          refs 同样不高亮）；⟳ 同仓重入不清账；切仓库（仓库行单击）清掉别的仓的
 *          格，切回来也不再亮 —— 面板侧 markBranchHighlightScope(appliedRepo) 的
 *          接线证据。
 *
 * 取舍（做不了的写明白）：
 *   · 窄屏（narrowBody.narrow）在替身环境不可达：useNarrowWidth 的测量槽由 ref
 *     回调填，gp69-env 的迷你渲染器只对 dsh-git-pop/chip/switch 派 ref，.dsh-git-body
 *     的 attach 收不到节点、量不到宽，narrow 恒 false。「窄屏不渲染把手、不挂变量」
 *     的判定（wideBody = narrow !== true 的那行三元）抽不出来也不值得为它再造第二套
 *     渲染器 —— 本套件只钉宽屏全链路；
 *   · 「宽屏偶发的 28px 折叠态」（右把手在 detailCollapsed=true 时不挂）同理：
 *     detailCollapsed 的真值只能从窄屏折叠回来那条路进，替身里进不去；
 *   · 70-branchpicker.js 分支卡 ⇣ 的 arm 接线（显式 repo → 生效仓库 → 工作区默认仓
 *     的归属回落）不在此套件：卡片世界要另起 chip 悬浮卡整条链；账函数自身的归属
 *     口径（空键不 arm、双键写入）在第 2 层钉死。
 *
 * 面板世界读 build.mjs 的 render 现拼 client 半边（纯函数，不写仓库内任何文件）——
 * 测的永远是 src/，仓库产物一个字节不动。 */

let failed = 0
const ok = (label, value, detail) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label + (value ? '' : '   ← 不符合预期：' + label + (detail === undefined ? '' : '；实际值 ' + detail)))
}
const ROOT = new URL('..', import.meta.url).pathname

/* ═══ 1 + 2. 源码级世界：63-storedlists.js + 10-state.js ═══ */

const env = makeEnv({ arrayByRef: true, document: false, window: false })
const src63 = fs.readFileSync(ROOT + 'src/client/63-storedlists.js', 'utf8')
const src10 = fs.readFileSync(ROOT + 'src/client/10-state.js', 'utf8')
/* 两个跨片符号（05-telemetry 的 diagLog、16-portal 的 healGitFloat）用桩喂进：
   本套件的路径碰不到它们，但闭包里得有这个名字。 */
const api = new Function('ctx', 'React', 'host', 'styles', 'console', 'document', 'window', 'fetch', 'liveBus', 'setTimeout', 'clearTimeout',
  'function diagLog() {}\nfunction healGitFloat() {}\n'
  + src63 + '\n' + src10 + '\nreturn {'
  + ' clampSplitWidth: clampSplitWidth, sanitizeWorkspaceLayoutEntry: sanitizeWorkspaceLayoutEntry,'
  + ' loadPanelSize: loadPanelSize, applyWorkspaceLayout: applyWorkspaceLayout, saveWorkspaceLayout: saveWorkspaceLayout, savePanelSize: savePanelSize,'
  + ' publishPanelSize: publishPanelSize, publishLogSplit: publishLogSplit,'
  + ' panelSizeNow: function () { return panelSize }, panelSizeLegacyNow: function () { return panelSizeLegacy },'
  + ' layoutWorkspaceNow: function () { return layoutWorkspace }, logSplitNow: function () { return logSplit },'
  + ' C: { LEFT_MIN: LOG_SPLIT_LEFT_MIN, LEFT_MAX: LOG_SPLIT_LEFT_MAX, DETAIL_MIN: LOG_SPLIT_DETAIL_MIN, DETAIL_MAX: LOG_SPLIT_DETAIL_MAX,'
  + '       MAIN_MIN: LOG_SPLIT_MAIN_MIN, LEFT_DEF: LOG_SPLIT_LEFT_DEFAULT, DETAIL_DEF: LOG_SPLIT_DETAIL_DEFAULT,'
  + '       WS_KEY: WORKSPACE_LAYOUT_KEY, WS_CAP: WORKSPACE_LAYOUT_MAX },'
  + ' panelSizeSignal: panelSizeSignal, logSplitSignal: logSplitSignal, branchHighlightSignal: branchHighlightSignal,'
  + ' refsTreeStored: refsTreeStored, workspaceLayoutStored: workspaceLayoutStored,'
  + ' refNamesOfRefsReply: refNamesOfRefsReply, armBranchFetchBaseline: armBranchFetchBaseline, settleBranchFetch: settleBranchFetch,'
  + ' putBranchHighlightCell: putBranchHighlightCell, branchHighlightNamesOf: branchHighlightNamesOf, markBranchHighlightScope: markBranchHighlightScope,'
  + ' TTL: BRANCH_HIGHLIGHT_TTL_MS,'
  + ' branchHighlightsNow: function () { return branchHighlights }, branchFetchArmsNow: function () { return branchFetchArms },'
  + ' versionNow: function () { return branchHighlightVersion }, scopeNow: function () { return branchHighlightScope },'
  + '}',
)(env.ctx, env.React, env.host, { insert: function () { return function () {} } }, console,
  env.fakeDoc, undefined, undefined, env.liveBus, setTimeout, clearTimeout)

const wsStoreKey = api.C.WS_KEY
const json = (v) => JSON.stringify(v)

/* signal 通知计数：apply/settle/清扫「发没发铃」的断言全靠它。 */
const notifyCount = { panel: 0, split: 0, highlight: 0 }
api.panelSizeSignal.subscribe(function () { notifyCount.panel += 1 })
api.logSplitSignal.subscribe(function () { notifyCount.split += 1 })
api.branchHighlightSignal.subscribe(function () { notifyCount.highlight += 1 })

console.log('')
console.log('=== 常量钉死：分栏上下限、主列表保底、默认宽、账键与容量、TTL ===')
{
  ok('左栏钳制区间 160~420（分支树一列还读得动的下限）',
    api.C.LEFT_MIN === 160 && api.C.LEFT_MAX === 420,
    'LEFT_MIN=' + api.C.LEFT_MIN + ' LEFT_MAX=' + api.C.LEFT_MAX)
  ok('详情栏钳制区间 200~480（文件列表还读得动的下限）',
    api.C.DETAIL_MIN === 200 && api.C.DETAIL_MAX === 480,
    'DETAIL_MIN=' + api.C.DETAIL_MIN + ' DETAIL_MAX=' + api.C.DETAIL_MAX)
  ok('主列表保底 LOG_SPLIT_MAIN_MIN=280（54-changes.js 量法表 560=280+280 的同一个数）',
    api.C.MAIN_MIN === 280, 'MAIN_MIN=' + api.C.MAIN_MIN)
  ok('分栏默认就是 CSS 现值 208/280（没有账的工作区画出来与从前一字不差）',
    api.C.LEFT_DEF === 208 && api.C.DETAIL_DEF === 280,
    'LEFT_DEF=' + api.C.LEFT_DEF + ' DETAIL_DEF=' + api.C.DETAIL_DEF)
  ok('账键 dsh.git-idea.workspace-layout、容量 30', wsStoreKey === 'dsh.git-idea.workspace-layout' && api.C.WS_CAP === 30,
    'key=' + wsStoreKey + ' cap=' + api.C.WS_CAP)
  ok('高亮 TTL 6000ms（与 46-css.js 的 dsh-git-branch-new 动画时长同一个数）', api.TTL === 6000, 'TTL=' + api.TTL)
}

console.log('')
console.log('=== clampSplitWidth：解析、取整、钳区间、回落、下限赢 ===')
{
  ok('数字原样收、区间内不动（clampSplitWidth(300,9,160,420)=300）', api.clampSplitWidth(300, 9, 160, 420) === 300,
    'got ' + api.clampSplitWidth(300, 9, 160, 420))
  ok('超上限收上限（clampSplitWidth(9999,9,160,420)=420）', api.clampSplitWidth(9999, 9, 160, 420) === 420,
    'got ' + api.clampSplitWidth(9999, 9, 160, 420))
  ok('低于下限收下限（clampSplitWidth(-5,9,160,420)=160）', api.clampSplitWidth(-5, 9, 160, 420) === 160,
    'got ' + api.clampSplitWidth(-5, 9, 160, 420))
  ok('小数取整（clampSplitWidth("300.7",9,160,420)=301）', api.clampSplitWidth('300.7', 9, 160, 420) === 301,
    'got ' + api.clampSplitWidth('300.7', 9, 160, 420))
  ok('不是数回落默认（"abc"/NaN/undefined 都回 fallback=9）',
    api.clampSplitWidth('abc', 9, 160, 420) === 9 && api.clampSplitWidth(NaN, 9, 160, 420) === 9
    && api.clampSplitWidth(undefined, 9, 160, 420) === 9,
    'got ' + api.clampSplitWidth('abc', 9, 160, 420) + ',' + api.clampSplitWidth(NaN, 9, 160, 420) + ',' + api.clampSplitWidth(undefined, 9, 160, 420))
  ok('下限赢：max<min 时收下限（clampSplitWidth(300,9,160,100)=160 —— body 特别窄时两栏保底）',
    api.clampSplitWidth(300, 9, 160, 100) === 160, 'got ' + api.clampSplitWidth(300, 9, 160, 100))
}

console.log('')
console.log('=== sanitizeWorkspaceLayoutEntry：清洗即读入的合同 ===')
{
  ok('非对象条目整条丢（null/42/字符串 → null）',
    api.sanitizeWorkspaceLayoutEntry(null) === null && api.sanitizeWorkspaceLayoutEntry(42) === null
    && api.sanitizeWorkspaceLayoutEntry('junk') === null,
    'got ' + api.sanitizeWorkspaceLayoutEntry(null) + ',' + api.sanitizeWorkspaceLayoutEntry(42) + ',' + api.sanitizeWorkspaceLayoutEntry('junk'))
  ok('没有 data 或 data 不是对象 → null', api.sanitizeWorkspaceLayoutEntry({ nope: 1 }) === null
    && api.sanitizeWorkspaceLayoutEntry({ data: 'x' }) === null,
    'got ' + api.sanitizeWorkspaceLayoutEntry({ data: 'x' }))
  ok('left/detail 逐项钳进上下限（9999→420、-1→200）',
    api.sanitizeWorkspaceLayoutEntry({ data: { left: 9999, detail: -1, w: 0, h: 0 } }).data.left === 420
    && api.sanitizeWorkspaceLayoutEntry({ data: { left: 9999, detail: -1, w: 0, h: 0 } }).data.detail === 200,
    'got ' + json(api.sanitizeWorkspaceLayoutEntry({ data: { left: 9999, detail: -1, w: 0, h: 0 } })))
  ok('w/h 沿用面板尺寸老语义：>0 取整，负数/不是数都记 0',
    json(api.sanitizeWorkspaceLayoutEntry({ data: { left: 208, detail: 280, w: 800.9, h: 'x' } }).data) === json({ left: 208, detail: 280, w: 801, h: 0 })
    && api.sanitizeWorkspaceLayoutEntry({ data: { left: 208, detail: 280, w: -3, h: 0 } }).data.w === 0,
    'got ' + json(api.sanitizeWorkspaceLayoutEntry({ data: { left: 208, detail: 280, w: 800.9, h: 'x' } })))
  ok('at 非有限数记 0、有限数原样收',
    api.sanitizeWorkspaceLayoutEntry({ data: { left: 208, detail: 280, w: 0, h: 0 }, at: 'bad' }).at === 0
    && api.sanitizeWorkspaceLayoutEntry({ data: { left: 208, detail: 280, w: 0, h: 0 }, at: 12345 }).at === 12345,
    'got ' + api.sanitizeWorkspaceLayoutEntry({ data: { left: 208, detail: 280, w: 0, h: 0 }, at: 'bad' }).at)
}

console.log('')
console.log('=== 工作区账层：load 兜底、上账回落、落账形状、空键不上盘 ===')
{
  /* 种盘：旧全局账一份 + 新工作区账两格（一格带畸形值）+ 两条畸形条目。 */
  env.store['dsh.git-idea.panel'] = json({ w: 777, h: 444 })
  env.store[wsStoreKey] = json({
    '/w1': { data: { left: 300, detail: 360, w: 800, h: 600 }, at: 11 },
    '/w2': { data: { left: 9999, detail: -1, w: -5, h: 'x' }, at: 'bad' },
    '/wbad': 'junk',
    '/wnull': { nope: 1 },
  })
  api.loadPanelSize(env.fakeDoc)
  ok('loadPanelSize 只把旧全局账收进 panelSizeLegacy，不动模块现值（panelSize 仍 {0,0}）',
    json(api.panelSizeLegacyNow()) === json({ w: 777, h: 444 }) && json(api.panelSizeNow()) === json({ w: 0, h: 0 }),
    'legacy=' + json(api.panelSizeLegacyNow()) + ' panelSize=' + json(api.panelSizeNow()))
  ok('迁移兜底不删旧键：dsh.git-idea.panel 原样还在盘上', env.store['dsh.git-idea.panel'] === json({ w: 777, h: 444 }),
    'got ' + env.store['dsh-git-idea.panel'])

  api.saveWorkspaceLayout()
  ok('工作区键还没解析出来（layoutWorkspace 空串）时落账口直接挡住：盘上还是种盘的那份原样',
    env.store[wsStoreKey] === json({
      '/w1': { data: { left: 300, detail: 360, w: 800, h: 600 }, at: 11 },
      '/w2': { data: { left: 9999, detail: -1, w: -5, h: 'x' }, at: 'bad' },
      '/wbad': 'junk',
      '/wnull': { nope: 1 },
    }),
    'got ' + env.store[wsStoreKey])

  api.applyWorkspaceLayout('')
  ok('applyWorkspaceLayout(空键) 不上账：layoutWorkspace 仍空、logSplit 仍默认、零通知',
    api.layoutWorkspaceNow() === '' && json(api.logSplitNow()) === json({ left: 208, detail: 280 })
    && notifyCount.panel === 0 && notifyCount.split === 0,
    'ws=' + api.layoutWorkspaceNow() + ' split=' + json(api.logSplitNow()) + ' notify=' + notifyCount.split)

  api.applyWorkspaceLayout('/w1')
  ok('/w1 有账：面板尺寸与两道分栏一格齐上（800×600 / 300+360），panel/split 两份铃各响一次',
    json(api.panelSizeNow()) === json({ w: 800, h: 600 }) && json(api.logSplitNow()) === json({ left: 300, detail: 360 })
    && api.layoutWorkspaceNow() === '/w1' && notifyCount.panel === 1 && notifyCount.split === 1,
    'size=' + json(api.panelSizeNow()) + ' split=' + json(api.logSplitNow()) + ' notify=' + notifyCount.panel + '/' + notifyCount.split)

  const panelMark = notifyCount.panel
  const splitMark = notifyCount.split
  api.applyWorkspaceLayout('/w1')
  ok('同一工作区重入不重上账：零通知（signal 的读者不被空转打扰）',
    api.layoutWorkspaceNow() === '/w1' && notifyCount.panel === panelMark && notifyCount.split === splitMark,
    'notify=' + notifyCount.panel + '/' + notifyCount.split)

  api.applyWorkspaceLayout('/w2')
  ok('/w2 畸形值被清洗钳回：left 9999→420、detail -1→200、w/h 非正→0',
    json(api.logSplitNow()) === json({ left: 420, detail: 200 }) && json(api.panelSizeNow()) === json({ w: 0, h: 0 }),
    'split=' + json(api.logSplitNow()) + ' size=' + json(api.panelSizeNow()))
  ok('畸形条目（/wbad 字符串、/wnull 没 data）整条没进账（上账不炸、无值可读）',
    api.workspaceLayoutStored.get('/wbad') === null && api.workspaceLayoutStored.get('/wnull') === null)

  api.applyWorkspaceLayout('/wfresh')
  ok('无账工作区：面板尺寸回落旧全局账（迁移兜底 777×444）、分栏回落默认 208/280',
    json(api.panelSizeNow()) === json({ w: 777, h: 444 }) && json(api.logSplitNow()) === json({ left: 208, detail: 280 }),
    'size=' + json(api.panelSizeNow()) + ' split=' + json(api.logSplitNow()))

  api.saveWorkspaceLayout()
  const freshCell = JSON.parse(env.store[wsStoreKey])['/wfresh']
  ok('saveWorkspaceLayout 落一整格：{left,detail,w,h} 与内存四样一致，at 是有限数',
    json(freshCell.data) === json({ left: 208, detail: 280, w: 777, h: 444 })
    && typeof freshCell.at === 'number' && isFinite(freshCell.at),
    'got ' + json(freshCell))

  /* 一次拖动改分栏、一次拖角改尺寸，savePanelSize（旧名落账口）一格齐落。 */
  api.publishLogSplit({ left: 400, detail: 200 })
  api.saveWorkspaceLayout()
  ok('分栏变了再落：格子的 left/detail 跟上（一次落一整格，四样数永远对得上）',
    json(JSON.parse(env.store[wsStoreKey])['/wfresh'].data) === json({ left: 400, detail: 200, w: 777, h: 444 }),
    'got ' + json(JSON.parse(env.store[wsStoreKey])['/wfresh']))
  api.publishPanelSize({ w: 900, h: 500 })
  api.savePanelSize()
  ok('savePanelSize（旧名保留的落账口）落的也是工作区格：尺寸跟分栏同格齐落',
    json(api.workspaceLayoutStored.get('/wfresh')) === json({ left: 400, detail: 200, w: 900, h: 500 })
    && json(JSON.parse(env.store[wsStoreKey])['/wfresh'].data) === json({ left: 400, detail: 200, w: 900, h: 500 }),
    'got ' + json(api.workspaceLayoutStored.get('/wfresh')))

  /* 写失败静默只留内存（先例同一条）。 */
  const realSetItem = env.fakeDoc.defaultView.localStorage.setItem
  env.fakeDoc.defaultView.localStorage.setItem = function () { throw new Error('quota exceeded') }
  let threw = false
  api.publishLogSplit({ left: 160, detail: 480 })
  try { api.saveWorkspaceLayout() } catch (error) { threw = true }
  env.fakeDoc.defaultView.localStorage.setItem = realSetItem
  ok('写失败（quota 拒绝）静默：不抛、盘上还是上一份、内存里是新值',
    threw === false
    && json(JSON.parse(env.store[wsStoreKey])['/wfresh'].data) === json({ left: 400, detail: 200, w: 900, h: 500 })
    && json(api.workspaceLayoutStored.get('/wfresh')) === json({ left: 160, detail: 480, w: 900, h: 500 }),
    'threw=' + threw + ' disk=' + json(JSON.parse(env.store[wsStoreKey])['/wfresh'].data)
    + ' mem=' + json(api.workspaceLayoutStored.get('/wfresh')))
}

console.log('')
console.log('=== 工作区账层：LRU 容量 30、队首淘汰、内容去重不挪位、异写插队尾 ===')
{
  /* 盘上现账（清洗后）：/w1、/w2、/wfresh —— 先压满再说。 */
  for (let i = 0; i < 30; i += 1) {
    api.workspaceLayoutStored.put('/bulk' + i, { left: 1, detail: 1, w: 0, h: 0 })
  }
  const onDisk = JSON.parse(env.store[wsStoreKey])
  ok('容量 30：压进 30 个新工作区后盘上恰好 30 格，最久没人碰的 /w1、/w2、/wfresh 被队首淘汰',
    Object.keys(onDisk).length === 30
    && onDisk['/w1'] === undefined && onDisk['/w2'] === undefined && onDisk['/wfresh'] === undefined
    && onDisk['/bulk0'] !== undefined && onDisk['/bulk29'] !== undefined,
    'size=' + Object.keys(onDisk).length + ' keys=' + Object.keys(onDisk).slice(0, 4).join(','))

  /* 内容级去重的另一半：同内容 put 连 LRU 位置都不动 —— /bulk0 还是队首，下一个
     新键把它挤掉。 */
  api.workspaceLayoutStored.put('/bulk0', { left: 1, detail: 1, w: 0, h: 0 })
  api.workspaceLayoutStored.put('/bulk30', { left: 2, detail: 2, w: 0, h: 0 })
  ok('同内容 put 不落盘也不挪位置：/bulk0 还在队首被 /bulk30 挤掉，/bulk1 无恙',
    api.workspaceLayoutStored.get('/bulk0') === null
    && api.workspaceLayoutStored.get('/bulk1') != null
    && api.workspaceLayoutStored.get('/bulk30') != null,
    'bulk0=' + api.workspaceLayoutStored.get('/bulk0') + ' bulk1=' + json(api.workspaceLayoutStored.get('/bulk1')))

  /* 异内容 put 先删再插队尾：把当前队首 /bulk1 异写 —— 挪去队尾后，下一个新键挤掉
     的应是 /bulk2（新的队首）而不是 /bulk1。 */
  api.workspaceLayoutStored.put('/bulk1', { left: 9, detail: 9, w: 0, h: 0 })
  api.workspaceLayoutStored.put('/bulk31', { left: 3, detail: 3, w: 0, h: 0 })
  ok('异内容 put 挪队尾：队首 /bulk1 异写后逃过下一轮淘汰，新队首 /bulk2 出局',
    api.workspaceLayoutStored.get('/bulk1') != null
    && JSON.parse(env.store[wsStoreKey])['/bulk1'].data.left === 9
    && api.workspaceLayoutStored.get('/bulk2') === null,
    'bulk1=' + json(api.workspaceLayoutStored.get('/bulk1')) + ' bulk2=' + api.workspaceLayoutStored.get('/bulk2'))
  ok('淘汰后容量仍是 30', Object.keys(JSON.parse(env.store[wsStoreKey])).length === 30,
    'size=' + Object.keys(JSON.parse(env.store[wsStoreKey])).length)
}

console.log('')
console.log('=== refNamesOfRefsReply：名字口径与答复坏的三种脸 ===')
{
  const reply = {
    ok: true, repo: '/hl/r1', current: ['phantom'],
    local: [{ segments: ['main'], data: 'main' }, { segments: ['dev'], data: 'dev' }, { segments: ['x'], data: '' }],
    remote: [
      { remote: 'origin', refs: [{ segments: ['origin', 'main'], data: 'origin/main' }, { segments: ['origin', 'nx'], data: 'origin/nx' }] },
      { remote: 'fork', refs: [] },
      null,
    ],
  }
  const names = api.refNamesOfRefsReply(reply)
  ok('本地收 local[].data（无前缀）、远端收 remote[].refs[].data（带远端前缀）',
    names.main === true && names.dev === true && names['origin/main'] === true && names['origin/nx'] === true,
    'got ' + json(names))
  ok('current 不收（unborn 推导不是 ref）：集合里没有 phantom', names.phantom !== true, 'got ' + json(names))
  ok('空名跳过、空远端组与 null 组不炸', names[''] === undefined && Object.keys(names).length === 4, 'got ' + json(names))
  ok('答复 null / ok!==true → null（基线记「不可知」的脸）',
    api.refNamesOfRefsReply(null) === null && api.refNamesOfRefsReply({ ok: false }) === null,
    'got ' + api.refNamesOfRefsReply(null) + ',' + api.refNamesOfRefsReply({ ok: false }))
  const empty = api.refNamesOfRefsReply({ ok: true, local: [], remote: [] })
  ok('空库（刚 init）返回空对象而非 null ——「读过但为空」与「没读过」是两件事',
    empty != null && typeof empty === 'object' && Object.keys(empty).length === 0, 'got ' + json(empty))
}

/* refsTreeStored 的种子答复（arm 的基线从它来）。 */
const REPLY1 = { ok: true, repo: '/hl/r1', current: ['main'],
  local: [{ segments: ['main'], data: 'main' }],
  remote: [{ remote: 'origin', refs: [{ segments: ['origin', 'main'], data: 'origin/main' }] }] }
const REPLY2 = { ok: true, repo: '/hl/r1', current: ['main'],
  local: [{ segments: ['main'], data: 'main' }, { segments: ['feat'], data: 'feat' }],
  remote: [{ remote: 'origin', refs: [
    { segments: ['origin', 'main'], data: 'origin/main' },
    { segments: ['origin', 'nx'], data: 'origin/nx' },
  ] }] }

console.log('')
console.log('=== arm→settle：净新增结算、arm 只结算一次、双键归属 ===')
{
  api.refsTreeStored.put('/hl/r1', REPLY1)

  /* 没 arm 过的 settle 是空转。 */
  const v0 = api.versionNow()
  const hMark0 = notifyCount.highlight
  api.settleBranchFetch('/hl/r1', REPLY2)
  ok('没 arm 过（基线不可知）：settle 空转 —— 不入账、不发铃、不排清扫',
    api.versionNow() === v0 && notifyCount.highlight === hMark0
    && Object.keys(api.branchHighlightsNow()).length === 0 && env.pendingTimers().length === 0,
    'version=' + api.versionNow() + ' cells=' + Object.keys(api.branchHighlightsNow()).join(','))

  /* arm 的两个空键/没账脸。 */
  api.armBranchFetchBaseline('')
  ok('仓库路径为空（归属不了）：不 arm', Object.keys(api.branchFetchArmsNow()).length === 0,
    'arms=' + Object.keys(api.branchFetchArmsNow()).join(','))
  api.armBranchFetchBaseline('/hl/never')
  ok('该仓从未读过 refs（盘上没账）：arm 记 null 基线（边界一的脸），格子还是立了',
    api.branchFetchArmsNow()['/hl/never'] != null && api.branchFetchArmsNow()['/hl/never'].before === null,
    'got ' + json(api.branchFetchArmsNow()['/hl/never']))
  api.settleBranchFetch('/hl/never', REPLY2)
  ok('边界一：基线 null 的 arm 被 settle 消费后什么都不入账',
    api.branchHighlightsNow()['/hl/never'] === undefined && api.branchFetchArmsNow()['/hl/never'] === undefined,
    'cells=' + Object.keys(api.branchHighlightsNow()).join(','))

  /* 正片：arm（基线 = REPLY1）→ settle（答复 = REPLY2）→ 净新增。 */
  api.armBranchFetchBaseline('/hl/r1')
  ok('arm：从 refsTreeStored 钉下 fetch 前集合（main + origin/main），等答复来结算',
    api.branchFetchArmsNow()['/hl/r1'] != null
    && api.branchFetchArmsNow()['/hl/r1'].before.main === true
    && api.branchFetchArmsNow()['/hl/r1'].before['origin/main'] === true,
    'got ' + json(api.branchFetchArmsNow()['/hl/r1']))
  const vMark = api.versionNow()
  const hMark = notifyCount.highlight
  const tMark = env.pendingTimers().length
  api.settleBranchFetch('/hl/r1', REPLY2)
  const cell = api.branchHighlightsNow()['/hl/r1']
  ok('settle 结算净新增：只有 feat 与 origin/nx 进格（基线里已有的不闪）',
    cell != null && cell.names.feat === true && cell.names['origin/nx'] === true
    && cell.names.main !== true && cell.names['origin/main'] !== true
    && Object.keys(cell.names).length === 2,
    'got ' + json(cell != null ? cell.names : null))
  ok('入账发铃：版本 +1、signal 通知一次、并排下一次 TTL 清扫',
    api.versionNow() === vMark + 1 && notifyCount.highlight === hMark + 1
    && env.pendingTimers().length === tMark + 1
    && env.pendingTimers().every(function (t) { return t.delay === api.TTL }),
    'version=' + api.versionNow() + ' notify=' + notifyCount.highlight + ' timers=' + env.pendingTimers().map((t) => t.delay).join(','))

  /* arm 只结算一次：同一份答复再来也空转（fetch 之后 refs 恰好没变的那次也要收掉基线）。 */
  api.settleBranchFetch('/hl/r1', REPLY2)
  ok('arm 只结算一次：第二条答复到达时 arm 已不在 —— 版本不动、格子合并不动',
    api.versionNow() === vMark + 1 && notifyCount.highlight === hMark + 1,
    'version=' + api.versionNow() + ' notify=' + notifyCount.highlight)

  /* 答复坏：arm 照样消费，什么都不入账（不为一次读失败留陈账）。 */
  api.armBranchFetchBaseline('/hl/r1')
  api.settleBranchFetch('/hl/r1', { ok: false, repo: '/hl/r1' })
  ok('答复坏（ok!==true）：arm 已删、不入账 —— 下一次 fetch 会重新 arm',
    api.branchFetchArmsNow()['/hl/r1'] === undefined && api.branchHighlightsNow()['/hl/r1'].names.feat === true
    && Object.keys(api.branchHighlightsNow()['/hl/r1'].names).length === 2,
    'arms=' + Object.keys(api.branchFetchArmsNow()).join(',') + ' names=' + json(api.branchHighlightsNow()['/hl/r1'].names))

  /* 边界二：fetch 前是空库。 */
  api.refsTreeStored.put('/hl/empty', { ok: true, repo: '/hl/empty', current: [], local: [], remote: [] })
  api.armBranchFetchBaseline('/hl/empty')
  api.settleBranchFetch('/hl/empty', { ok: true, repo: '/hl/empty', current: [], local: [],
    remote: [{ remote: 'origin', refs: [{ segments: ['origin', 'a'], data: 'origin/a' }] }] })
  ok('边界二：fetch 前空库（第一次 fetch 从无到有）不高亮 —— 全量闪一遍是噪音',
    api.branchHighlightsNow()['/hl/empty'] === undefined, 'cells=' + Object.keys(api.branchHighlightsNow()).join(','))

  /* 双键归属：请求键与答复自报的仓库路径不同时各落一格，同一份名字。 */
  api.refsTreeStored.put('/hl/req', REPLY1)
  api.armBranchFetchBaseline('/hl/req')
  api.settleBranchFetch('/hl/req', Object.assign({}, REPLY2, { repo: '/hl/real' }))
  ok('归属双写：请求键与答复键（Host 的 cwd）各落一格、同一份名字对象',
    api.branchHighlightsNow()['/hl/req'] != null && api.branchHighlightsNow()['/hl/real'] != null
    && api.branchHighlightsNow()['/hl/req'].names === api.branchHighlightsNow()['/hl/real'].names
    && api.branchHighlightsNow()['/hl/req'].names.feat === true,
    'cells=' + Object.keys(api.branchHighlightsNow()).join(','))
  ok('按答复键也能找到 arm（答复到达的键是 Host 解析后的 cwd）：/hl/real 的 arm 被消费',
    api.branchFetchArmsNow()['/hl/real'] === undefined, 'arms=' + Object.keys(api.branchFetchArmsNow()).join(','))

  /* 反向：arm 落在答复键上，settle 报请求键来。 */
  api.refsTreeStored.put('/hl/real2', REPLY1)
  api.armBranchFetchBaseline('/hl/real2')
  api.settleBranchFetch('/hl/other', Object.assign({}, REPLY2, { repo: '/hl/real2' }))
  ok('arm 落在答复键、settle 报请求键：照样配对（谁在用谁），/hl/other 与 /hl/real2 双写',
    api.branchHighlightsNow()['/hl/other'] != null && api.branchHighlightsNow()['/hl/real2'] != null
    && api.branchHighlightsNow()['/hl/other'].names.feat === true,
    'cells=' + Object.keys(api.branchHighlightsNow()).join(','))
}

console.log('')
console.log('=== 格子合并与查询：连续 fetch 并格、同名去重、branchHighlightNamesOf ===')
{
  api.refsTreeStored.put('/hl/m', REPLY1)
  api.armBranchFetchBaseline('/hl/m')
  api.settleBranchFetch('/hl/m', REPLY2)
  const first = api.branchHighlightsNow()['/hl/m']
  const firstAt = first.at
  first.at = 1 /* 把 at 拨回可辨识的旧值：并格时 at 必须被挪到现在 */
  /* 第二次 fetch：基线取盘账（账外世界没动它时是上一份答复）——手动把盘账推到
     REPLY2 再 arm，答复带更多新名。 */
  api.refsTreeStored.put('/hl/m', REPLY2)
  api.armBranchFetchBaseline('/hl/m')
  api.settleBranchFetch('/hl/m', { ok: true, repo: '/hl/m', current: ['main'],
    local: [{ segments: ['main'], data: 'main' }, { segments: ['feat'], data: 'feat' }, { segments: ['more'], data: 'more' }],
    remote: [{ remote: 'origin', refs: [
      { segments: ['origin', 'main'], data: 'origin/main' },
      { segments: ['origin', 'nx'], data: 'origin/nx' },
      { segments: ['origin', 'more'], data: 'origin/more' },
    ] }] })
  const merged = api.branchHighlightsNow()['/hl/m']
  ok('连续两次 fetch 并格：旧名字（feat、origin/nx）与新名字（more、origin/more）同格共存',
    merged.names.feat === true && merged.names['origin/nx'] === true
    && merged.names.more === true && merged.names['origin/more'] === true
    && Object.keys(merged.names).length === 4,
    'got ' + json(merged.names))
  ok('并格把 at 挪到现在（旧名字的动画多半播完，推迟摘除没有可察觉的视觉）',
    merged.at !== 1 && merged.at >= firstAt, 'at=' + merged.at + ' first=' + firstAt)
  ok('同名分支只在第一次进集合（对象键语义天然去重，feat 没有闪第二次的位置）',
    Object.keys(merged.names).filter(function (n) { return n === 'feat' }).length === 1)

  ok('branchHighlightNamesOf：有格返回名字集，没格/空键返回 null',
    api.branchHighlightNamesOf('/hl/m') === merged.names
    && api.branchHighlightNamesOf('/hl/none') === null && api.branchHighlightNamesOf('') === null,
    'got ' + json(api.branchHighlightNamesOf('/hl/none')) + ',' + json(api.branchHighlightNamesOf('')))
}

console.log('')
console.log('=== TTL 清扫：只摘到龄的格、没到龄的续排、每格 at 独立 ===')
{
  /* 当前挂着的清扫是上一节 settle 排的（delay 恰为 TTL）。先钉「没到龄保留」。 */
  const tYoung = env.pendingTimers().length
  env.fireTimers(api.TTL)
  ok('没到龄（刚写入 age≈0）的格清扫后保留，清扫器续排最近一次到点',
    api.branchHighlightsNow()['/hl/m'] != null && env.pendingTimers().length === tYoung,
    'm=' + (api.branchHighlightsNow()['/hl/m'] != null) + ' timers=' + env.pendingTimers().length)

  /* 每格 at 独立：只把 /hl/m 拨老，别的格到龄与否不受牵连。续排的 delay 是
     「剩余毫秒」（不再是整 TTL），这里用无过滤的 fireTimers() 放行。 */
  const cellsBefore = Object.keys(api.branchHighlightsNow())
  api.branchHighlightsNow()['/hl/m'].at -= (api.TTL + 100)
  const vMark = api.versionNow()
  const hMark = notifyCount.highlight
  env.fireTimers()
  ok('到龄的格被摘（at 落后 TTL+100 的 /hl/m 没了），版本 +1、发铃',
    api.branchHighlightsNow()['/hl/m'] === undefined && api.versionNow() === vMark + 1
    && notifyCount.highlight === hMark + 1,
    'cells=' + Object.keys(api.branchHighlightsNow()).join(',') + ' version=' + api.versionNow())
  ok('清扫只动到龄格：其余 ' + (cellsBefore.length - 1) + ' 格原样在（每格 at 独立）',
    Object.keys(api.branchHighlightsNow()).length === cellsBefore.length - 1
    && api.branchHighlightsNow()['/hl/r1'] != null && api.branchHighlightsNow()['/hl/req'] != null,
    'cells=' + Object.keys(api.branchHighlightsNow()).join(','))
  ok('还有没到龄的格时清扫器续排（定时器还在）', env.pendingTimers().length === 1,
    'timers=' + env.pendingTimers().length)

  /* 全部到龄后：摘完不再续排。 */
  for (const key of Object.keys(api.branchHighlightsNow())) {
    api.branchHighlightsNow()[key].at -= (api.TTL + 100)
  }
  env.fireTimers()
  ok('全部到龄：账清空、铃发过、清扫器不再续排',
    Object.keys(api.branchHighlightsNow()).length === 0 && env.pendingTimers().length === 0,
    'cells=' + Object.keys(api.branchHighlightsNow()).join(',') + ' timers=' + env.pendingTimers().length)
}

console.log('')
console.log('=== 切仓库隔离 markBranchHighlightScope：换仓清别的格、同仓重入不动 ===')
{
  /* 开两格（put 直落，走的是 settle 用的同一个写入口）。 */
  api.putBranchHighlightCell('/sc/a', { feat: true })
  api.putBranchHighlightCell('/sc/b', { nx: true })
  const vMark = api.versionNow()
  const hMark = notifyCount.highlight
  api.markBranchHighlightScope('/sc/a')
  ok('切到 /sc/a：别的格（/sc/b）被清掉、本仓格保留，版本 +1、发铃',
    api.branchHighlightsNow()['/sc/b'] === undefined && api.branchHighlightsNow()['/sc/a'] != null
    && api.versionNow() === vMark + 1 && notifyCount.highlight === hMark + 1,
    'cells=' + Object.keys(api.branchHighlightsNow()).join(',') + ' version=' + api.versionNow())
  ok('scope 记下当前生效仓库', api.scopeNow() === '/sc/a', 'scope=' + api.scopeNow())

  const vMark2 = api.versionNow()
  const hMark2 = notifyCount.highlight
  api.markBranchHighlightScope('/sc/a')
  ok('同仓重入（refs effect 每次重跑都报一声）一字不动：零清账、零通知',
    api.versionNow() === vMark2 && notifyCount.highlight === hMark2
    && api.branchHighlightsNow()['/sc/a'] != null,
    'version=' + api.versionNow() + ' notify=' + notifyCount.highlight)

  api.markBranchHighlightScope('')
  ok('空键不认（还没解析出生效仓库时不当地清账）', api.scopeNow() === '/sc/a', 'scope=' + api.scopeNow())

  api.markBranchHighlightScope('/sc/c')
  ok('真换仓（→/sc/c）：/sc/a 的格也清掉 —— 高亮永远只在「眼前这个仓」里亮',
    api.scopeNow() === '/sc/c' && Object.keys(api.branchHighlightsNow()).length === 0,
    'scope=' + api.scopeNow() + ' cells=' + Object.keys(api.branchHighlightsNow()).join(','))
}

/* ═══ 3. 面板世界：分栏拖动 + 行挂类的真渲染接线 ═══ */

console.log('')
console.log('=== 面板世界：工作区账上画、两道把手、拖动钳制与落账 ===')

const built = await import(ROOT + 'build.mjs')
const clientTmp = path.join(os.tmpdir(), 'gp90-client-' + process.pid + '.js')
fs.writeFileSync(clientTmp, built.render(built.TARGETS.find(function (t) { return t.out === 'dist/client.js' })))
process.on('exit', function () {
  try { fs.rmSync(clientTmp, { force: true }) } catch (error) { /* 尽力而为 */ }
})

const REPO_A = '/tmp/gp90/repo-a'
const REPO_B = '/tmp/gp90/repo-b'
const L = function (name) { return { segments: [name], data: name, upstream: '', ahead: 0, behind: 0, at: 0 } }
const R = function (remote, names) {
  return { remote: remote, refs: names.map(function (n) { return { segments: [remote, n], data: remote + '/' + n } }) }
}
const refsReplyA1 = { ok: true, repo: REPO_A, current: ['main'],
  local: [L('main'), L('dev')],
  remote: [R('origin', ['main', 'dev'])] }
const refsReplyA2 = { ok: true, repo: REPO_A, current: ['main'],
  local: [L('main'), L('dev'), L('feat-new')],
  remote: [R('origin', ['main', 'dev', 'new-x'])] }
const refsReplyA3 = { ok: true, repo: REPO_A, current: ['main'],
  local: [L('main'), L('dev'), L('feat-new'), L('stealth')],
  remote: [R('origin', ['main', 'dev', 'new-x'])] }
const refsReplyA4 = { ok: true, repo: REPO_A, current: ['main'],
  local: [L('main'), L('dev'), L('feat-new'), L('stealth'), L('again')],
  remote: [R('origin', ['main', 'dev', 'new-x', 'again'])] }
const refsReplyB1 = { ok: true, repo: REPO_B, current: ['trunk'],
  local: [L('trunk')],
  remote: [R('origin', ['trunk'])] }

/* document 开着（面板 ref 派发的 ownerDocument 才有值：拖动的 document 级监听与
   localStorage 账层都靠它）、window 关着（没有 ReactDOM.createPortal 就不走
   body 级浮层，面板照旧渲染在槽位里 —— gp88 面板世界的同一副骨架）。 */
const penv = makeEnv({ arrayByRef: true, document: true, window: false })
/* 面板打开前种盘：repo-a 的工作区账一格（分栏 300/360、面板 800×600）——
   面板首帧就该照它画。 */
penv.store[wsStoreKey] = json({
  [REPO_A]: { data: { left: 300, detail: 360, w: 800, h: 600 }, at: 1 },
})
const refsByRepo = {}
refsByRepo[REPO_A] = refsReplyA1
refsByRepo[REPO_B] = refsReplyB1
let fetchScript = { ok: true }
const fetchCalls = []
const realCall = penv.host.call
penv.host.call = function (method, args) {
  const repo = args != null && typeof args.repo === 'string' && args.repo.length > 0 ? args.repo : REPO_A
  if (method === 'git/refs') return Promise.resolve(refsByRepo[repo] != null ? refsByRepo[repo] : refsReplyA1)
  if (method === 'git/fetch') {
    fetchCalls.push(args)
    if (fetchScript.reject === true) return Promise.reject(new Error(fetchScript.message || 'network down'))
    return Promise.resolve({ ok: true, repo: repo, stdout: '', stderr: '', exitCode: 0 })
  }
  if (method === 'git/repos') return Promise.resolve({ ok: true, workspace: '/tmp/gp90', repos: [REPO_A, REPO_B], manual: [], missing: [], links: [] })
  if (method === 'git/repo-applied') return Promise.resolve({ ok: true, workspace: '/tmp/gp90', repo: REPO_A })
  if (method === 'git/repo-applied-save') return Promise.resolve({ ok: true, workspace: '/tmp/gp90', repo: args != null ? args.repo : '', unchanged: true })
  if (method === 'git/panel') return Promise.resolve({ ok: true, repo: repo, branch: repo === REPO_B ? 'trunk' : 'main', detached: false, upstream: '', ahead: 0, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] })
  if (method === 'git/graph') return Promise.resolve({ ok: true, repo: repo, ref: repo === REPO_B ? 'trunk' : 'main', currentBranch: repo === REPO_B ? 'trunk' : 'main', commits: [], rows: [], lanes: 1 })
  if (method === 'git/worktrees') return Promise.resolve({ ok: true, repo: repo, worktrees: [] })
  if (method === 'git/branches') return Promise.resolve({ ok: true, repo: repo, current: repo === REPO_B ? 'trunk' : 'main', previous: '', branches: [], remotes: [] })
  if (method === 'git/authors') return Promise.resolve({ ok: true, repo: repo, authors: [] })
  if (method === 'git/watch') return Promise.resolve({ ok: true, repo: repo, sig: 'SIG90' })
  if (method === 'git/config') return Promise.resolve({ ok: true, path: '/home/u/.dsh/dsh-git-idea.json', config: {} })
  return realCall(method, args)
}
const pcomponents = penv.apply(fs.readFileSync(clientTmp, 'utf8'))
const pwait = penv.wait
const byCls = penv.byClass
const buttonsOf = penv.buttonsOf
const pop90 = function (sid) {
  return penv.renderUntilStable(penv.makeElement(pcomponents.popover, { sessionId: sid || 's-90' }), sid || 's-90')
}
async function settlePanel() {
  let t = null
  for (let i = 0; i < 5; i += 1) { t = await pop90(); await pwait(10) }
  return t
}
const bodyOf = (t) => byCls(t, 'dsh-git-body')[0]
const splitL = (t) => byCls(t, 'dsh-git-split-l')[0]
const splitR = (t) => byCls(t, 'dsh-git-split-r')[0]
const leftVar = (t) => (bodyOf(t) != null && bodyOf(t).props.style != null ? bodyOf(t).props.style['--dsh-git-left-w'] : undefined)
const detailVar = (t) => (bodyOf(t) != null && bodyOf(t).props.style != null ? bodyOf(t).props.style['--dsh-git-detail-w'] : undefined)
/* 分支行 = tooltip 首行带「双击只看这个分支的历史」的行（HEAD 组行与本地组当前分支
   的叶子行都有）。HEAD 组行（不参与高亮）用行 key 的 cur: 前缀认 —— 它是组里
   keyOf('cur:'+name) 的那行，叶子行的 key 是树节点 id。 */
const branchRows = (t) => byCls(t, 'dsh-git-trow').filter(function (r) {
  return String(r.props.title || '').indexOf('（双击只看这个分支的历史）') >= 0
})
const rowOf = (t, name, head) => branchRows(t).filter(function (r) {
  const isHeadRow = String(r.props.key).indexOf('cur:') === 0
  return (head === true ? isHeadRow : isHeadRow !== true)
    && String(r.props.title).indexOf(name + '（双击') === 0
})[0]
const leafNames = (t) => branchRows(t)
  .filter(function (r) { return String(r.props.key).indexOf('cur:') !== 0 })
  .map(function (r) { return String(r.props.title).split('（双击')[0] })
const highlightCount = (t) => branchRows(t).filter(function (r) {
  return String(r.props.className).indexOf('dsh-git-branch-new') >= 0
}).length
const fetchBtn = (t) => buttonsOf(t).find(function (b) { return b.props.key === 'fetch' })
const refreshBtn = (t) => buttonsOf(t).find(function (b) { return b.props.key === 'refresh' })
const repoRow = (t, p) => byCls(t, 'dsh-git-repo-row').find(function (r) { return r.props.key === 'repo:' + p })
/* 把手事件桩：currentTarget.parentElement 就是 .dsh-git-body（真 DOM 里的父子关系，
   替身里用手造节点顶上 —— clientWidth / getBoundingClientRect 由用例给）。 */
const fakeBody = function (width) {
  const node = { ownerDocument: penv.fakeDoc }
  if (width == null) {
    /* 量不到宽的脸：clientWidth 缺席（bodyW 按 0），getBoundingClientRect 还在
       （拖动几何照常）—— 钳制只剩固定上下限的那条路。 */
    node.getBoundingClientRect = function () { return { left: 0, right: 6000 } }
    return node
  }
  node.clientWidth = width
  node.getBoundingClientRect = function () { return { left: 0, right: width } }
  return node
}
const press = function (handle, width, button) {
  handle.props.onPointerDown({
    button: button === undefined ? 0 : button,
    preventDefault: function () {},
    stopPropagation: function () {},
    currentTarget: { parentElement: fakeBody(width) },
  })
}
const docMove = function (x) { penv.fakeDoc.fire('pointermove', { clientX: x }) }
const docUp = function () { penv.fakeDoc.fire('pointerup', {}) }
const savedCell = function () {
  const disk = JSON.parse(penv.store[wsStoreKey] || '{}')
  return disk[REPO_A] != null ? disk[REPO_A].data : null
}

penv.fibers.clear()
let chip90 = await penv.renderUntilStable(penv.makeElement(pcomponents.chip, { sessionId: 's-90' }), 'chip-90')
if (chip90.props.className.indexOf('dsh-git-chip-open') < 0) { chip90.props.onClick(); await pwait(10) }
let panel90 = await settlePanel()

{
  ok('面板按工作区账画：左栏/详情栏宽变量来自 repo-a 的格（300px/360px）',
    leftVar(panel90) === '300px' && detailVar(panel90) === '360px',
    'left=' + leftVar(panel90) + ' detail=' + detailVar(panel90))
  ok('面板尺寸也在同一格里：pop 根宽 800px（种子 w=800）',
    byCls(panel90, 'dsh-git-pop')[0] != null
    && byCls(panel90, 'dsh-git-pop')[0].props.style != null
    && byCls(panel90, 'dsh-git-pop')[0].props.style.width === '800px',
    'got ' + json(byCls(panel90, 'dsh-git-pop')[0] != null && byCls(panel90, 'dsh-git-pop')[0].props.style != null ? byCls(panel90, 'dsh-git-pop')[0].props.style.width : null))
  ok('宽屏两道把手都在（dsh-git-split-l / dsh-git-split-r）', splitL(panel90) !== undefined && splitR(panel90) !== undefined)
  ok('首帧分支树已按答复画好（4 行叶子：main/dev/origin/main/origin/dev）',
    json(leafNames(panel90)) === json(['main', 'dev', 'origin/main', 'origin/dev']),
    'rows=' + json(leafNames(panel90)))
  ok('没 fetch 过：没有任何行挂 dsh-git-branch-new', highlightCount(panel90) === 0, 'got ' + highlightCount(panel90))
}

{
  press(splitL(panel90), 500) /* body 特别窄：两栏保底、主列表让步 */
  panel90 = await pop90()
  ok('按下左把手：body 挂 dsh-git-splitting（拖动中禁选中），document 级 pointermove 已挂',
    String(bodyOf(panel90).props.className).indexOf('dsh-git-splitting') >= 0
    && penv.docListeners['pointermove'] != null && penv.docListeners['pointermove'].length === 1,
    'class=' + String(bodyOf(panel90).props.className) + ' listeners=' + (penv.docListeners['pointermove'] || []).length)
  docMove(300)
  panel90 = await pop90()
  /* leftMax = min(420, 500 − 280 − 360) = min(420, −140) = −140 → max<min，下限赢。 */
  ok('body 窄到保底都放不下：下限赢，左栏钳在 160（主列表暂时让步）',
    leftVar(panel90) === '160px', 'left=' + leftVar(panel90))
  docUp()
  panel90 = await pop90()
  ok('松手：splitting 摘掉、document 监听拆干净、账落盘（{left:160,detail:360,w:800,h:600}）',
    String(bodyOf(panel90).props.className).indexOf('dsh-git-splitting') < 0
    && (penv.docListeners['pointermove'] || []).length === 0
    && (penv.docListeners['pointerup'] || []).length === 0
    && json(savedCell()) === json({ left: 160, detail: 360, w: 800, h: 600 }),
    'class=' + String(bodyOf(panel90).props.className) + ' cell=' + json(savedCell()))
}

{
  press(splitL(panel90), 1200)
  panel90 = await pop90()
  docMove(500)
  panel90 = await pop90()
  /* leftMax = min(420, 1200 − 280 − 360) = 420。 */
  ok('左把手越过上限：钳在 min(420, bodyW−280−detail)=420', leftVar(panel90) === '420px', 'left=' + leftVar(panel90))
  docMove(100)
  panel90 = await pop90()
  ok('左把手低于下限：钳在 160', leftVar(panel90) === '160px', 'left=' + leftVar(panel90))
  docMove(5000)
  panel90 = await pop90()
  ok('同一个拖动里往回走到天边：仍钳在 420（按下那一刻量定的 max 全程有效）', leftVar(panel90) === '420px', 'left=' + leftVar(panel90))
  docUp()
  panel90 = await pop90()
  ok('左拖落账：格子里 left=420、detail 没被动过（360）',
    json(savedCell()) === json({ left: 420, detail: 360, w: 800, h: 600 }), 'cell=' + json(savedCell()))
}

{
  press(splitR(panel90), 1200)
  panel90 = await pop90()
  docMove(700)
  panel90 = await pop90()
  /* detailMax = min(480, 1200 − 280 − 420) = 480；detail = 1200 − 700 = 500 → 480。 */
  ok('右把手越过上限：详情栏钳在 min(480, bodyW−280−left)=480', detailVar(panel90) === '480px', 'detail=' + detailVar(panel90))
  docMove(1190)
  panel90 = await pop90()
  ok('右把手贴到右缘：详情栏钳在下限 200（1200−1190=10 < 200）', detailVar(panel90) === '200px', 'detail=' + detailVar(panel90))
  docUp()
  panel90 = await pop90()
  ok('右拖落账：格子里 detail=200、left 保持在左拖落下的 420',
    json(savedCell()) === json({ left: 420, detail: 200, w: 800, h: 600 }), 'cell=' + json(savedCell()))
}

{
  press(splitL(panel90), null) /* clientWidth 缺席：bodyW 按 0，钳制只剩固定上下限 */
  panel90 = await pop90()
  docMove(3000)
  panel90 = await pop90()
  ok('body 宽量不到（clientWidth 没有）：钳制只剩固定上下限，3000 也收在 420',
    leftVar(panel90) === '420px', 'left=' + leftVar(panel90))
  docMove(200)
  panel90 = await pop90()
  docUp()
  panel90 = await pop90()
  ok('量不到宽照样能拖能落账：200 落进格子（固定下限 160 之上）',
    json(savedCell()) === json({ left: 200, detail: 200, w: 800, h: 600 }), 'cell=' + json(savedCell()))
}

{
  const before = leftVar(panel90)
  press(splitL(panel90), 1200, 2) /* 非左键 */
  panel90 = await pop90()
  docMove(100)
  panel90 = await pop90()
  ok('非左键按下（button=2）不拖：没有挂 document 监听、宽度不动',
    (penv.docListeners['pointermove'] || []).length === 0 && leftVar(panel90) === before,
    'listeners=' + (penv.docListeners['pointermove'] || []).length + ' left=' + leftVar(panel90))
}

/* ═══ 3b. 面板世界：fetch 新分支行的挂类与清扫 ═══ */

console.log('')
console.log('=== 面板世界：⇣ fetch 成功 → 净新增行挂 dsh-git-branch-new → TTL 摘除 ===')
{
  refsByRepo[REPO_A] = refsReplyA2 /* fetch 之后的 refs 重读会拿到它 */
  fetchScript = { ok: true }
  fetchBtn(panel90).props.onClick()
  panel90 = await settlePanel()
  ok('⇣ 发出 git/fetch（面板 runOp 的成功回调里先 arm 再 bump）', fetchCalls.length === 1,
    'fetchCalls=' + fetchCalls.length)
  const featRow = rowOf(panel90, 'feat-new', false)
  const nxRow = rowOf(panel90, 'origin/new-x', false)
  ok('净新增的本地行 feat-new 与远端行 origin/new-x 都挂上 dsh-git-branch-new',
    featRow !== undefined && String(featRow.props.className).indexOf('dsh-git-branch-new') >= 0
    && nxRow !== undefined && String(nxRow.props.className).indexOf('dsh-git-branch-new') >= 0,
    'feat=' + (featRow != null ? String(featRow.props.className) : 'missing') + ' nx=' + (nxRow != null ? String(nxRow.props.className) : 'missing'))
  ok('基线里已有的行不挂（main/dev/origin/main/origin/dev）',
    rowOf(panel90, 'main', false) !== undefined
    && String(rowOf(panel90, 'main', false).props.className).indexOf('dsh-git-branch-new') < 0
    && String(rowOf(panel90, 'dev', false).props.className).indexOf('dsh-git-branch-new') < 0
    && String(rowOf(panel90, 'origin/main', false).props.className).indexOf('dsh-git-branch-new') < 0
    && String(rowOf(panel90, 'origin/dev', false).props.className).indexOf('dsh-git-branch-new') < 0,
    'main=' + (rowOf(panel90, 'main', false) != null ? String(rowOf(panel90, 'main', false).props.className) : 'missing'))
  const headRow = rowOf(panel90, 'main', true)
  ok('HEAD 组的行不参与（fetch 不改 HEAD，当前分支不可能是新长出来的那行）',
    headRow !== undefined && String(headRow.props.className).indexOf('dsh-git-branch-new') < 0,
    'head=' + (headRow != null ? String(headRow.props.className) : 'missing'))
  ok('全树恰好两行在闪（feat-new + origin/new-x）', highlightCount(panel90) === 2, 'got ' + highlightCount(panel90))

  /* TTL 清扫（面板排的是 ctx.timer 服务里的 timeout，delay 恰为 TTL）。替身里
     时钟不走，把 Date.now 拨快 TTL+500 再放行 delay===TTL 的那一发清扫 ——
     sweep 读到的 age 就过了线（其余挂着的 timeout 不在这一发里，不受拨钟影响）。 */
  const realNow = Date.now
  const tBefore = penv.pendingTimers().length
  Date.now = function () { return realNow() + (api.TTL + 500) }
  penv.fireTimers(api.TTL)
  Date.now = realNow
  panel90 = await settlePanel()
  ok('TTL 到点：清扫摘格、行回归素面（挂类的行归零），到龄摘完不再续排',
    highlightCount(panel90) === 0
    && penv.pendingTimers().every(function (t) { return t.delay !== api.TTL }),
    'highlight=' + highlightCount(panel90) + ' timers=' + penv.pendingTimers().map((t) => t.delay).join(',') + '(was ' + tBefore + ')')

  /* fetch 没带来新分支：基线 = 现账，settle 空转，行不闪。 */
  fetchBtn(panel90).props.onClick()
  panel90 = await settlePanel()
  ok('第二次 fetch（refs 没变）：基线吃掉自己，没有任何行挂类', highlightCount(panel90) === 0,
    'got ' + highlightCount(panel90))

  /* fetch 失败不 arm：外部（CLI）改的 refs 不算 fetch 的新分支。 */
  refsByRepo[REPO_A] = refsReplyA3 /* stealth 是「没有 fetch 动作」长出来的行 */
  fetchScript = { reject: true, message: 'could not resolve host' }
  fetchBtn(panel90).props.onClick()
  panel90 = await settlePanel()
  fetchScript = { ok: true }
  ok('fetch 失败：错误横幅说话、不 arm —— stealth 行虽然出现在树里但不挂类',
    highlightCount(panel90) === 0 && rowOf(panel90, 'stealth', false) !== undefined
    && String(rowOf(panel90, 'stealth', false).props.className).indexOf('dsh-git-branch-new') < 0
    && byCls(panel90, 'dsh-git-error').length > 0,
    'highlight=' + highlightCount(panel90) + ' stealthRow=' + (rowOf(panel90, 'stealth', false) != null)
    + ' error=' + byCls(panel90, 'dsh-git-error').length)

  /* 再真 fetch 一次：失败没留下陈账，链路没坏；again 两行挂类。 */
  refsByRepo[REPO_A] = refsReplyA4
  fetchBtn(panel90).props.onClick()
  panel90 = await settlePanel()
  ok('再真 fetch 一次：again/origin/again 两行挂类（前一次失败没留下陈账）',
    highlightCount(panel90) === 2
    && String(rowOf(panel90, 'again', false).props.className).indexOf('dsh-git-branch-new') >= 0
    && String(rowOf(panel90, 'origin/again', false).props.className).indexOf('dsh-git-branch-new') >= 0,
    'highlight=' + highlightCount(panel90))

  /* ⟳ 同仓重入（refs effect 每次重跑都报一声 markBranchHighlightScope）不清账。 */
  refreshBtn(panel90).props.onClick()
  panel90 = await settlePanel()
  ok('⟳ 同仓重入（refs effect 重跑又报了同一仓）：高亮格不被清，行还挂着类',
    highlightCount(panel90) === 2,
    'highlight=' + highlightCount(panel90))
}

console.log('')
console.log('=== 面板世界：切仓库（仓库行单击）清掉别的仓的格，切回来也不再亮 ===')
{
  ok('切仓前 repo-a 的两行还在闪', highlightCount(panel90) === 2, 'got ' + highlightCount(panel90))
  const rowB = repoRow(panel90, REPO_B)
  ok('左栏树里有仓库清单（RepoSwitcher），repo-b 一行在', rowB !== undefined)
  rowB.props.onClick({ ctrlKey: false })
  panel90 = await settlePanel()
  ok('切到 repo-b：树换成 trunk 的行，没有任何行挂类（repo-a 的格被 markBranchHighlightScope 清掉）',
    rowOf(panel90, 'trunk', false) !== undefined && highlightCount(panel90) === 0,
    'trunkRow=' + (rowOf(panel90, 'trunk', false) != null) + ' highlight=' + highlightCount(panel90))
  const rowA = repoRow(panel90, REPO_A)
  rowA.props.onClick({ ctrlKey: false })
  panel90 = await settlePanel()
  const nxRow = rowOf(panel90, 'origin/new-x', false)
  ok('切回 repo-a：origin/new-x 行还在树里（refs 没变），但不再挂类 —— 切仓库即失效，不是暂停',
    nxRow !== undefined && String(nxRow.props.className).indexOf('dsh-git-branch-new') < 0
    && highlightCount(panel90) === 0,
    'nxRow=' + (nxRow != null ? String(nxRow.props.className) : 'missing') + ' highlight=' + highlightCount(panel90))
}

console.log('')
if (failed > 0) {
  console.log('gp90: ' + failed + ' assertion(s) failed')
  process.exit(1)
}
console.log('gp90: all assertions passed')
