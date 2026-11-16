import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ── 「行：」换档帧的复量链终止 + 虚拟窗口几何（6a8392c 的回归钉）──
 *
 * 崩溃：历史 tab 切「行：」档位那一帧整列行高同帧改变，真浏览器在渲染间的强制
 * 同步布局里还夹着滚动锚定/截断调整，useVirtualWindow（12-window.js）连续两趟
 * measure 各得一个不同的窗（A→B→A）；measure 的 setState 又立刻引来下一趟同步
 * 嵌套重渲染，无限嵌套到 50 层后 React 抛 #185，护栏收起面板「面板异常关闭」。
 * 修复：commit() 真换窗时立起 box.settle，紧随其后那趟布局副作用跳过一次复量
 * ——measure 自己引发的同步链就此截断；onScroll 的复量不受影响。
 *
 * 本套件盯三层：
 *   1. 修复形态（源码级）：box 挂盒、commit 先判等后 setWin 且真换窗立 settle、
 *      布局副作用开头 settle 短路一次复量；两个共用方（50-log 的 CommitList 与
 *      55-diff 的 PatchBody）仍把 onScroll 直连 win.measure。
 *   2. 核心回归（面板世界，gp87 的 tmp harness 同款）：视口 400px、scrollTop>0
 *      的真实形态下换档 N=4，并模拟换档帧的窗口抖动——强制布局那几趟里 scrollTop
 *      在 sA↔sB 之间来回拨（锚定抖动的环境模型，见 storm），使连续两趟 measure
 *      各得不同窗。断言：复量链有限步终止（渲染趟数上限即 #185 模拟，修复前该
 *      场景每趟都换窗、必然超限）、链断后窗口按锚定收尾的 scrollTop 收敛到
 *      等高算术参考窗（first/last/垫块/总高逐像素对账）。
 *   3. 既有语义不回归：换档到「全部」档窗口按前缀和重算、每行自己的高度正确；
 *      同一趟渲染间隙里连发两次 onScroll 最终窗=最后一次复量（不被 settle 跳过
 *      吞掉）；同值复量 measure 照跑但不引发任何状态更新；viewport=0 窗口清
 *      null 整列渲染不丢行；换档纯显示设置零 git/graph 重读。
 *
 * 抖动环境模型（storm）的诚实性说明：harness 的迷你 React 没有真实布局，锚定
 * 的「拨 scrollTop」只能由测试替身扮演。模型只换档那一帧生效、每趟被 measure
 * 的换窗引发的渲染才拨一次（物理：锚定调整发生在嵌套强制布局里）；链被 settle
 * 截断后风暴即止，锚定收尾把 scrollTop 拨回锚行齐视口顶的诚实位置，再由
 * onScroll 复量收敛——这正是真浏览器崩溃帧之后发生的顺序。 */

let failed = 0
const ok = function (label, value, vars) {
  if (value !== true) {
    failed += 1
    console.log('  ✗ ' + label + '   ← ' + JSON.stringify(vars === undefined ? { value: value } : vars))
  } else {
    console.log('  ✓ ' + label)
  }
}
/* 断言错误信息带变量：实际值与期望值都进 ✗ 行。 */
const eq = function (label, actual, want) {
  const same = JSON.stringify(actual) === JSON.stringify(want)
  ok(label, same, { actual: actual, want: want })
  return same
}
const ROOT = new URL('..', import.meta.url).pathname

/* ═══ 1. 行几何常量直读 + 修复形态（源码级） ═══ */

console.log('')
console.log('=== 修复形态与行几何常量（源码级） ===')
const fmtSrc = fs.readFileSync(ROOT + 'src/client/40-format.js', 'utf8')
const ROW_H_MATCH = fmtSrc.match(/const ROW_H = (\d+)/)
const MSG_LINE_H_MATCH = fmtSrc.match(/const MSG_LINE_H = (\d+)/)
ok('行几何常量能从 40-format.js 直读（正则各命中一组）',
  ROW_H_MATCH !== null && MSG_LINE_H_MATCH !== null,
  { rowH: ROW_H_MATCH === null ? null : ROW_H_MATCH[1], msgLineH: MSG_LINE_H_MATCH === null ? null : MSG_LINE_H_MATCH[1] })
const ROW_H = Number(ROW_H_MATCH[1])
const MSG_LINE_H = Number(MSG_LINE_H_MATCH[1])
ok('行几何常量仍是任务口径：ROW_H=26、MSG_LINE_H=15',
  ROW_H === 26 && MSG_LINE_H === 15,
  { ROW_H: ROW_H, MSG_LINE_H: MSG_LINE_H })
const winSrc = fs.readFileSync(ROOT + 'src/client/12-window.js', 'utf8')
const OVERSCAN_MATCH = winSrc.match(/const VIRTUAL_OVERSCAN = (\d+)/)
ok('VIRTUAL_OVERSCAN 能直读且 =8', OVERSCAN_MATCH !== null && Number(OVERSCAN_MATCH[1]) === 8,
  { overscan: OVERSCAN_MATCH === null ? null : OVERSCAN_MATCH[1] })
const OVERSCAN = Number(OVERSCAN_MATCH[1])

const reBox = /const \[box\] = React\.useState\(function \(\) \{ return \{ win: null, settle: false \} \}\)/
const reSkip = /if \(box\.settle === true\) \{\s*box\.settle = false\s*return undefined/
const iGuard = winSrc.indexOf('previous.first === next.first')
const iSettle = winSrc.indexOf('box.settle = true')
const iSetWin = winSrc.indexOf('setWin(next)')
ok('修复形态：box 挂盒在（win 镜像 + settle 记号，client 侧无 useRef 的 draftBox 同款）',
  reBox.test(winSrc), { matched: reBox.test(winSrc) })
ok('修复形态：commit 先判等（previous.first === next.first）→ 真换窗立 settle → 才 setWin(next)；旧的 setWin(function…) updater 判等已撤',
  iGuard >= 0 && iSettle >= 0 && iSetWin >= 0 && iGuard < iSettle && iSettle < iSetWin && winSrc.indexOf('setWin(function') < 0,
  { iGuard: iGuard, iSettle: iSettle, iSetWin: iSetWin, legacyUpdater: winSrc.indexOf('setWin(function') })
ok('修复形态：布局副作用开头 settle 短路一次复量（同步自环由此截断）',
  reSkip.test(winSrc), { matched: reSkip.test(winSrc) })
const logSrc = fs.readFileSync(ROOT + 'src/client/50-log.js', 'utf8')
const diffSrc = fs.readFileSync(ROOT + 'src/client/55-diff.js', 'utf8')
ok('两个共用方都走这个 hook：CommitList 用 log、PatchBody 用 diff:<id>',
  logSrc.indexOf("useVirtualWindow('log'") >= 0 && diffSrc.indexOf("useVirtualWindow('diff:'") >= 0,
  { logUse: logSrc.indexOf("useVirtualWindow('log'"), diffUse: diffSrc.indexOf("useVirtualWindow('diff:'") })
ok('既有语义在源码级钉住：onScroll 直连 win.measure（滚动复量不经 settle 门）',
  logSrc.indexOf('onScroll: win.measure') >= 0 && diffSrc.indexOf('onScroll: wrap === true ? undefined : win.measure') >= 0,
  { logOnScroll: logSrc.indexOf('onScroll: win.measure'), diffOnScroll: diffSrc.indexOf('onScroll: wrap === true ? undefined : win.measure') })

/* ═══ 2. 面板世界：换档帧的复量链 ═══ */

console.log('')
console.log('=== 面板世界：换档帧复量链终止与窗口收敛（#185 回归核心） ===')

/* 客户端这一半同 gp87 的办法：GP_SRC 没设时用 build.mjs 的 render 现拼一份进
   系统 tmp（纯函数，不写仓库产物）；run-all 的 GP_FRESH 已指好临时拼接。 */
let clientPath = process.env.GP_SRC || null
let madeClient = false
if (clientPath === null) {
  const built = await import(ROOT + 'build.mjs')
  clientPath = path.join(os.tmpdir(), 'gp92-client-' + String(process.pid) + '.js')
  fs.writeFileSync(clientPath, built.render(built.TARGETS.find((t) => t.out === 'dist/client.js')))
  process.env.GP_SRC = clientPath
  madeClient = true
}
const harnessTmp = path.join(os.tmpdir(), 'gp92-harness-' + String(process.pid) + '.mjs')
fs.writeFileSync(harnessTmp, fs.readFileSync(ROOT + 'test/gp37-harness.part', 'utf8')
  + '\nexport { React, makeElement, renderRoot, renderUntilStable, settle, openPanel, buttons, byClass, textOf, collect, wait, fibers, calls, host, popover, chip, registered, store, fakeNode }'
  + '\nexport function gp92Dirty() { return dirty }'
  + '\nexport function gp92ClearDirty() { dirty = false }'
  + '\nexport function gp92SetGraph(v) { graphCommits = v }')
process.on('exit', () => {
  const list = madeClient ? [clientPath, harnessTmp] : [harnessTmp]
  for (const p of list) {
    try { fs.rmSync(p, { force: true }) } catch (error) { /* 尽力而为 */ }
  }
})
const W = await import(harnessTmp)

/* ── 滚动容器替身：harness 把 fakeNode 递给每一个带 ref 的宿主元素，
   .dsh-git-log 的 win.attach 收到的就是它。clientHeight 直接给值；
   scrollTop 走 getter（带读取计数），由测试按布局步骤拨动 —— 这就是
   「浏览器布局」在这套测试里的替身。 */
const VIEWPORT = 400
const fake = W.fakeNode
const model = { scroll: 0 }
let reads = 0
Object.defineProperty(fake, 'clientHeight', { configurable: true, writable: true, value: VIEWPORT })
Object.defineProperty(fake, 'scrollTop', {
  configurable: true,
  get() { reads += 1; return model.scroll },
  /* 滚动只由测试的布局步骤拨动；替身之外的任何写入一律吞掉。 */
  set() {},
})

/* ── 罐头历史：60 条提交，body 行数按 i%4 循环（1..4 行）——「全部」档的
   每行高度 26/41/56/71 循环，前缀和窗口有得算。 */
const COUNT = 60
const commits92 = []
for (let i = 0; i < COUNT; i += 1) {
  const extra = i % 4
  const bodyLines = []
  for (let k = 0; k < extra; k += 1) bodyLines.push('body ' + String(i) + '.' + String(k))
  commits92.push({
    hash: 'h' + String(i).padStart(3, '0'),
    subject: '提交 ' + String(i),
    body: bodyLines.join('\n'),
    author: 'mays',
    date: '2026-09-16',
    committedAt: 1787000000 - i * 60,
    refs: [],
  })
}
const heightsAll = commits92.map((c, i) => ROW_H + (i % 4) * MSG_LINE_H)
const topsAll = [0]
for (let i = 0; i < COUNT; i += 1) topsAll.push(topsAll[i] + heightsAll[i])
W.gp92SetGraph(commits92)

/* ── 参考实现：等高算术窗与前缀和窗（12-window.js 的两条路径，独立再写一遍，
   含 overscan 与两端 clamp；测试断言对着它逐像素对账）。 */
const refEqual = function (top, viewport, rowH, count) {
  const first = Math.max(0, Math.min(count, Math.floor(top / rowH) - OVERSCAN))
  const last = Math.max(first, Math.min(count, Math.ceil((top + viewport) / rowH) + OVERSCAN))
  return { first: first, last: last }
}
const refPrefix = function (heights, top, viewport) {
  const count = heights.length
  let at = 0
  let acc = 0
  while (at < count && acc + heights[at] <= top) { acc += heights[at]; at += 1 }
  const first = Math.max(0, at - OVERSCAN)
  let end = at
  let seen = acc
  const bottom = top + viewport
  while (end < count && seen < bottom) { seen += heights[end]; end += 1 }
  const last = Math.max(first, Math.min(count, end + OVERSCAN))
  return { first: first, last: last }
}

/* ── 渲染结果里读窗口几何：logwrap 的 minHeight、行数、紧贴行块两端的垫块。 */
function logInnerOf(tree) {
  const wrap = W.byClass(tree, 'dsh-git-logwrap')[0]
  if (wrap === undefined) return null
  const kids = Array.isArray(wrap.props.children) ? wrap.props.children : [wrap.props.children]
  return kids.find((c) => c != null && c.props != null && c.props.style != null && c.props.style.marginLeft !== undefined) || null
}
function geometryOf(tree) {
  const wrap = W.byClass(tree, 'dsh-git-logwrap')[0]
  const inner = logInnerOf(tree)
  if (wrap === undefined || inner === null) return null
  const kids = Array.isArray(inner.props.children) ? inner.props.children : [inner.props.children]
  let firstCrowAt = -1
  let lastCrowAt = -1
  let rows = 0
  for (let i = 0; i < kids.length; i += 1) {
    const c = kids[i]
    const isCrow = c != null && c.props != null && typeof c.props.className === 'string'
      && c.props.className.indexOf('dsh-git-crow') >= 0
    if (isCrow) { rows += 1; if (firstCrowAt < 0) firstCrowAt = i; lastCrowAt = i }
  }
  const padAt = function (i) {
    const c = kids[i]
    return c != null && c.props != null && c.props.style != null && typeof c.props.style.height === 'string'
      && c.props.className === undefined ? parseFloat(c.props.style.height) : 0
  }
  return {
    rows: rows,
    padTop: firstCrowAt > 0 ? padAt(firstCrowAt - 1) : 0,
    padBottom: lastCrowAt >= 0 && lastCrowAt + 1 < kids.length ? padAt(lastCrowAt + 1) : 0,
    minHeight: wrap.props.style != null && typeof wrap.props.style.minHeight === 'string' ? parseFloat(wrap.props.style.minHeight) : 0,
  }
}
const geomWant = function (first, last, rowH, count, tops) {
  return {
    rows: last - first,
    padTop: tops != null ? tops[first] : first * rowH,
    padBottom: tops != null ? tops[tops.length - 1] - tops[last] : (count - last) * rowH,
    minHeight: tops != null ? tops[tops.length - 1] : count * rowH,
  }
}
const logElOf = function (tree) { return W.byClass(tree, 'dsh-git-log')[0] }
const rowOf92 = function (tree, i) {
  return W.byClass(tree, 'dsh-git-crow').find((r) => W.textOf(r).indexOf('提交 ' + String(i) + 'mays') >= 0)
}

/* ── 渲染趟驱动器：每趟 = 一次 renderRoot（效果在趟末跑）+ 抖动步骤。
   趟数上限就是 #185 的模拟——真 React 里每次换窗引来一趟同步嵌套渲染，
   50 层即崩；这里换成渲染趟数上限，修复前每趟都换窗、必然超限。 */
async function driveSettle(label, cap) {
  const element = W.makeElement(W.popover, { sessionId: 's-1' })
  let passes = 0
  const commits = []
  for (;;) {
    passes += 1
    if (passes > cap) {
      throw new Error('复量链 ' + String(cap) + ' 趟渲染未终止（React #185 模拟：measure→换窗→同步重渲染→再复量 没有收敛）；'
        + 'label=' + label + '；各趟窗口序列=' + JSON.stringify(commits))
    }
    W.gp92ClearDirty()
    const tree = W.renderRoot(element, 'pop')
    await W.wait(0)
    const g = geometryOf(tree)
    if (W.gp92Dirty() !== true) return { passes: passes, tree: tree, commits: commits }
    commits.push(g)
    stormStep()
  }
}

/* ── 换档帧的锚定抖动模型：只在复量链还在换窗时生效，每次被换窗引发的渲染
   拨一次，scrollTop 在 sA↔sB 之间交替 —— 连续两趟 measure 各得不同窗。 */
const storm = { on: false, flip: 0, a: 0, b: 0 }
function stormStep() {
  if (storm.on !== true) return
  model.scroll = storm.flip % 2 === 0 ? storm.a : storm.b
  storm.flip += 1
}

/* ── 「行：」换档：点开触发器下拉，再点选项。返回选项点击后的复量链结果。 */
async function pickMsgLines(tree, value, label) {
  const btn = W.byClass(tree, 'dsh-git-msgsel-btn')[0]
  if (btn === undefined) throw new Error('找不到「行：」触发器（label=' + label + '）')
  btn.props.onClick()
  const opened = await driveSettle(label + '·开下拉', 12)
  const item = W.byClass(opened.tree, 'dsh-git-lfsel-item').find((b) => W.textOf(b) === String(value))
  if (item === undefined) throw new Error('找不到档位选项「' + String(value) + '」（label=' + label + '）')
  item.props.onClick({ stopPropagation() {}, preventDefault() {} })
  return await driveSettle(label, 12)
}

/* 初始形态：视口 400、滚动停在 20×26 —— 第 20 行正压视口顶（viewport>0、
   scrollTop>0 的真实形态），档 1 等高算术窗 [12,44)。 */
model.scroll = 20 * ROW_H
W.fibers.clear()
let tree = await W.openPanel()
{
  const want = refEqual(model.scroll, VIEWPORT, ROW_H, COUNT)
  ok('初始（档1）窗口 = 等高算术参考窗 first=' + String(want.first) + ' last=' + String(want.last),
    JSON.stringify(geometryOf(tree)) === JSON.stringify(geomWant(want.first, want.last, ROW_H, COUNT, null)),
    { actual: geometryOf(tree), want: geomWant(want.first, want.last, ROW_H, COUNT, null) })
  ok('档1 虚拟化在位：只渲染窗口内的行（不是全量 ' + String(COUNT) + ' 行）',
    geometryOf(tree).rows === want.last - want.first && want.last - want.first < COUNT,
    { rows: geometryOf(tree).rows, window: want.last - want.first })
  ok('档1 行是单行画法（无行内定高 style）',
    W.byClass(tree, 'dsh-git-crow').every((r) => r.props.style === undefined),
    { styledRows: W.byClass(tree, 'dsh-git-crow').filter((r) => r.props.style !== undefined).length })
  ok('窗口边界行对号：first 行在列、窗口外的上下两行都不在',
    rowOf92(tree, want.first) !== undefined && rowOf92(tree, want.last - 1) !== undefined
    && rowOf92(tree, want.first - 1) === undefined && rowOf92(tree, want.last) === undefined,
    { first: want.first, last: want.last, hasFirst: rowOf92(tree, want.first) !== undefined, hasLastMinus1: rowOf92(tree, want.last - 1) !== undefined })
}

/* 各段流转时始终记着最新一棵已稳定的树：后续段的 onScroll 都从它取。 */
let lastTree = tree

/* ── 核心：换档 N=4 的复量链（风暴开）── */
const ROW_H_4 = ROW_H + 3 * MSG_LINE_H
storm.on = true
storm.flip = 0
storm.a = 1420
storm.b = 2840
const picked4 = await pickMsgLines(tree, '4', '换档4')
storm.on = false
ok('换档帧复量链有限步终止：只有一次换窗提交、渲染趟数封顶（修复前：抖动下每趟换窗，A→B→A 超限即 #185）',
  picked4.commits.length <= 1 && picked4.passes <= 3,
  { passes: picked4.passes, windowCommits: picked4.commits.length, commits: picked4.commits })

/* 链断后的锚定收尾：第 20 行回视口顶（20×71=1420），onScroll 复量收敛。 */
model.scroll = 20 * ROW_H_4
const wantHonest = refEqual(model.scroll, VIEWPORT, ROW_H_4, COUNT)
logElOf(picked4.tree).props.onScroll()
const honest = await driveSettle('换档4·锚定收尾', 12)
eq('换档后（N=4）窗口按新行高重算收敛到参考窗（first/last/垫块/总高）',
  geometryOf(honest.tree),
  geomWant(wantHonest.first, wantHonest.last, ROW_H_4, COUNT, null))
lastTree = honest.tree
const converged = await driveSettle('换档4·收敛复验', 12)
ok('窗口已收敛：再跑一趟渲染零换窗、零多余提交',
  converged.passes === 1 && converged.commits.length === 0,
  { passes: converged.passes, windowCommits: converged.commits.length })
{
  const crows = W.byClass(honest.tree, 'dsh-git-crow')
  ok('N=4 档整列等高 26+3×15=71px，信息不足 4 行的行高不缩',
    crows.length === wantHonest.last - wantHonest.first
    && crows.every((r) => r.props.style != null && r.props.style.height === String(ROW_H_4) + 'px'),
    { rows: crows.length, wantRows: wantHonest.last - wantHonest.first, height: ROW_H_4 })
  const shortRow = rowOf92(honest.tree, wantHonest.first)
  const fatRow = rowOf92(honest.tree, wantHonest.first + 1)
  ok('行内正文行数 = 信息行数-1（短信息行不补空行）',
    shortRow != null && fatRow != null
    && W.byClass(shortRow, 'dsh-git-crow-bodyline').length === 0
    && W.byClass(fatRow, 'dsh-git-crow-bodyline').length === 1,
    { shortBodyLines: shortRow === null ? null : W.byClass(shortRow, 'dsh-git-crow-bodyline').length, fatBodyLines: fatRow === null ? null : W.byClass(fatRow, 'dsh-git-crow-bodyline').length })
}

/* ── 换档到「全部」：前缀和窗口 ── */
model.scroll = topsAll[30]
const pickedAll = await pickMsgLines(honest.tree, '全部', '换全部')
const wantAll = refPrefix(heightsAll, model.scroll, VIEWPORT)
ok('换「全部」也是一次换窗即收敛（风暴已停，无抖动）',
  pickedAll.commits.length <= 1 && pickedAll.passes <= 3,
  { passes: pickedAll.passes, windowCommits: pickedAll.commits.length })
eq('「全部」档窗口按前缀和重算（first=' + String(wantAll.first) + ' last=' + String(wantAll.last) + '）',
  geometryOf(pickedAll.tree),
  geomWant(wantAll.first, wantAll.last, 0, COUNT, topsAll))
lastTree = pickedAll.tree
{
  const crows = W.byClass(pickedAll.tree, 'dsh-git-crow')
  const bad = []
  for (let i = wantAll.first; i < wantAll.last; i += 1) {
    const row = rowOf92(pickedAll.tree, i)
    const want = String(heightsAll[i]) + 'px'
    if (row === undefined || row.props.style == null || row.props.style.height !== want) {
      bad.push({ row: i, got: row === undefined ? null : row.props.style == null ? null : row.props.style.height, want: want })
    }
  }
  ok('「全部」档每行自己的高度 26+(信息行数-1)×15', bad.length === 0, { bad: bad, rows: crows.length })
  const single = rowOf92(pickedAll.tree, 24)
  ok('「全部」档单行信息的提交也是 tall 行（26px 定高、无正文行）',
    single !== undefined && single.props.style != null && single.props.style.height === String(ROW_H) + 'px'
    && W.byClass(single, 'dsh-git-crow-bodyline').length === 0,
    { height: single === undefined ? null : single.props.style == null ? null : single.props.style.height })
}

/* ── 既有语义：onScroll 即时、不被 settle 跳过吞掉 ──
   同一趟渲染间隙里连发两次 onScroll：第一次提交换窗立起 settle，第二次照常
   复量提交 —— 最终窗必须是最后一次复量的窗。 */
{
  const scrollA = topsAll[28]
  const scrollB = topsAll[56]
  const wantD2 = refPrefix(heightsAll, scrollB, VIEWPORT)
  const logD = logElOf(pickedAll.tree)
  model.scroll = scrollA
  logD.props.onScroll()
  model.scroll = scrollB
  logD.props.onScroll()
  const d = await driveSettle('onScroll 即时', 12)
  eq('连发两次 onScroll：最终窗 = 最后一次复量的窗（settle 跳过没吞掉滚动复量）',
    geometryOf(d.tree),
    geomWant(wantD2.first, wantD2.last, 0, COUNT, topsAll))
  lastTree = d.tree
}

/* ── 既有语义：同值复量不引发多余状态更新 ──
   measure 照跑（scrollTop getter 读取 ×3：typeof、>0、取值），但窗口同值，
   commit 判等退回 —— dirty 不立、零额外渲染。 */
{
  reads = 0
  W.gp92ClearDirty()
  const element = W.makeElement(W.popover, { sessionId: 's-1' })
  const eTree = W.renderRoot(element, 'pop')
  await W.wait(0)
  const eDirty = W.gp92Dirty()
  const eGeom = geometryOf(eTree)
  ok('同值复量：measure 照跑（scrollTop 读取 ×3）但 dirty 不立、窗口不动',
    eDirty === false && reads === 3 && JSON.stringify(eGeom) === JSON.stringify(geometryOf(lastTree)),
    { reads: reads, dirty: eDirty, geometry: eGeom, settled: geometryOf(lastTree) })
  lastTree = eTree
}

/* ── 既有语义：viewport=0 窗口清 null，整列渲染不丢行 ── */
{
  fake.clientHeight = 0
  logElOf(lastTree).props.onScroll()
  const f = await driveSettle('viewport=0', 12)
  eq('viewport=0：窗口清 null，整列 ' + String(COUNT) + ' 行全渲染、无垫块',
    geometryOf(f.tree),
    { rows: COUNT, padTop: 0, padBottom: 0, minHeight: topsAll[COUNT] })
  ok('窗口 null 时首尾提交都在列（量不到高度绝不让行消失）',
    rowOf92(f.tree, 0) !== undefined && rowOf92(f.tree, COUNT - 1) !== undefined,
    { hasFirst: rowOf92(f.tree, 0) !== undefined, hasLast: rowOf92(f.tree, COUNT - 1) !== undefined })
  fake.clientHeight = VIEWPORT
  logElOf(f.tree).props.onScroll()
  const f2 = await driveSettle('viewport 恢复', 12)
  const wantBack = refPrefix(heightsAll, model.scroll, VIEWPORT)
  eq('恢复可见：onScroll 一发窗口回到前缀和参考窗',
    geometryOf(f2.tree),
    geomWant(wantBack.first, wantBack.last, 0, COUNT, topsAll))
}

/* ── 既有语义：换档纯显示设置，零 git/graph 重读 ── */
ok('两次换档（4 → 全部）没发任何 git/graph 重读（纯显示设置）',
  W.calls.filter((c) => c.method === 'git/graph').length === 1,
  { graphCalls: W.calls.filter((c) => c.method === 'git/graph').length })

console.log('')
if (failed > 0) {
  console.error('gp92-msglines-window: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
console.log('gp92-msglines-window: all checks passed')
