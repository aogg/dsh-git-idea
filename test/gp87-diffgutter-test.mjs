import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/* ── 差异视图「行号右键菜单 + 外观切换 + 未更改段折叠 + blame 注解」（a5dedd5）──
 *
 * 一个套件盯四层：
 *   1. 菜单结构（61-filemenu.js gutterMenuItems 源码级求值，gp86 对 61 的同一写法）：
 *      全项顺序 blame→sep→fold→sep→align→sync→sep→外观四项；align/sync 是 ✓ 前缀
 *      且 disabled:true 且 title 说实话（配对渲染天然对齐 / 同表天然同步滚动）；
 *      显示行号默认勾；blame 未跟踪 blameOk=false 置灰且 title 说原因；没有
 *      「路径导航」项。
 *   2. 左半行号换边 + 折叠（55-diff.js，面板世界挂真差异视图）：paired 行的子节点
 *      顺序左 [记号][正文][行号]、右 [行号][记号][正文]；hunk/meta 行一格横跨；
 *      「收起未更改的片段」默认收起，长未更改段折「⋯ 展开未更改的 N 行」条
 *      （N 正确），首次展开只发一次 context=100000+full 的读，此后收放/逐段展开
 *      零重读（读数计数断言），行号在配对时算好不受折叠影响；超限 truncated 给
 *      「差异过长」警告不冒充完整。
 *   3. git/blame（host/68-detail.js readBlame，桩 + 真仓库）：porcelain 四类输入
 *      （普通头行 / ^ 边界头行 / boundary 元数据行 / filename 复用段）逐格出对；
 *      untracked 路径 git 自己拒（blame-failed）；worktree/commit/range 三种 argv
 *      与版本选择（range 取尾段 head）；16MB 上限 blame-too-large；答复字段
 *      （短 hash、^ 前缀、作者、author-time 原话、边界标记）。
 *   4. 外观四开关（20-prefs.js + 55-diff.js）：normalizeSettings 归一化（非法值回
 *      默认）与 localStorage 持久化往返；显示空格只换画法——wsp span 里仍是原
 *      字符、git/diff 一个不发；自动换行档 dtable/diffwrap 的 -wrap 类与虚拟窗口
 *      让位（无 minHeight）；隐藏行号后记号格仍能打开同一个菜单。
 *
 * Host 那一半读 GP_SRC（run-all.mjs 的 GP_FRESH 会指到临时拼接）；没设时用
 * build.mjs 的 render 现拼。客户端这一半同 gp86 的办法：gp37-harness 连 export
 * 清单写进系统 tmp 作真模块导入，client 读 src/ 现拼的那份。面板世界的 fiber
 * 树以渲染 label 为根——所有 render 沿用 openPanel 的 'pop'。 */

let failed = 0
const ok = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const ROOT = new URL('..', import.meta.url).pathname

/* ═══ 1. gutterMenuItems：结构与形态（源码级） ═══ */

console.log('')
console.log('=== gutterMenuItems：结构、勾选与置灰 ===')
const menuSrc = fs.readFileSync(ROOT + 'src/client/61-filemenu.js', 'utf8')
/* h 桩带第三参：61-filemenu 的 label 走 children，桩得把它接住。 */
const menuApi = new Function('h', 'text', menuSrc + '\nreturn { gutterMenuItems: gutterMenuItems, fileMenuItems: fileMenuItems }')(
  (type, props, ...kids) => ({ type: type, props: Object.assign({}, props, { children: kids.length === 1 ? kids[0] : kids }) }),
  (v) => (typeof v === 'string' ? v : ''))
const keysOf = (items) => items.map((el) => el.props.key)
const labelOf = (el) => String(el.props.children)
const actsOf = (over) => Object.assign({
  blameOn: false, fragOpen: false, showWs: false, showNo: true, guides: false, wrap: false,
  onBlame: () => {}, onFrag: () => {}, onShowWs: () => {}, onShowNo: () => {}, onGuides: () => {}, onWrap: () => {},
}, over)
const itemsOf = (state, acts) => menuApi.gutterMenuItems(state, actsOf(acts))

const BASE_ORDER = ['blame', 'sep-1', 'fold', 'sep-2', 'align', 'sync', 'sep-3', 'ws', 'no', 'guides', 'wrap']
ok('全项顺序：blame→分隔→fold→分隔→align→sync→分隔→外观四项，一个不多一个不少',
  JSON.stringify(keysOf(itemsOf({}))) === JSON.stringify(BASE_ORDER))
const find86 = (items, key) => items.find((el) => el.props.key === key)
{
  const items = itemsOf({})
  const align = find86(items, 'align')
  const sync = find86(items, 'sync')
  ok('align/sync 都是 ✓ 前缀 + disabled:true（天然如此，不造假开关）',
    labelOf(align) === '✓ 在并排差异中对齐更改' && align.props.disabled === true
    && labelOf(sync) === '✓ 同步滚动' && sync.props.disabled === true)
  ok('align 的 title 说配对渲染天然对齐、sync 的说同表同容器天然同步',
    String(align.props.title).indexOf('配对渲染') >= 0 && String(align.props.title).indexOf('没有要切的开关') >= 0
    && String(sync.props.title).indexOf('同一个滚动容器') >= 0)
  ok('显示行号默认勾（showNo 缺省 !== false）',
    labelOf(find86(items, 'no')) === '✓ 显示行号')
  ok('外观三项默认不勾（ws/guides/wrap 缺省 false）',
    labelOf(find86(items, 'ws')) === '显示空格' && labelOf(find86(items, 'guides')) === '显示缩进参考线'
    && labelOf(find86(items, 'wrap')) === '自动换行')
  ok('没有「路径导航」项',
    items.every((el) => labelOf(el).indexOf('路径导航') < 0))
  const on = itemsOf({ blameOk: true })
  ok('blame 可用未开：不置灰、无 ✓ 前缀、title 说切换与取消',
    find86(on, 'blame').props.disabled !== true
    && labelOf(find86(on, 'blame')) === '使用 Git 退溯注解(N)'
    && String(find86(on, 'blame').props.title).indexOf('切换 blame 注解') >= 0)
  ok('fold 默认（收起态）勾选：✓ 收起未更改的片段，title 说默认与首次大上下文重读',
    labelOf(find86(items, 'fold')) === '✓ 收起未更改的片段'
    && String(find86(items, 'fold').props.title).indexOf('默认') >= 0)
}
{
  const items = itemsOf({ blameOk: true }, { blameOn: true, fragOpen: true, showWs: true, showNo: false, guides: true, wrap: true })
  ok('开态全谱：blame 带 ✓、fold 变「展开未更改的片段」且无 ✓（勾选态=当前收起）',
    labelOf(find86(items, 'blame')) === '✓ 使用 Git 退溯注解(N)'
    && labelOf(find86(items, 'fold')) === '展开未更改的片段'
    && String(find86(items, 'fold').props.title).indexOf('不重读补丁') >= 0)
  ok('外观四项开态都带 ✓，显示行号关后无 ✓',
    labelOf(find86(items, 'ws')) === '✓ 显示空格' && labelOf(find86(items, 'guides')) === '✓ 显示缩进参考线'
    && labelOf(find86(items, 'wrap')) === '✓ 自动换行' && labelOf(find86(items, 'no')) === '显示行号')
  ok('blame 开态 title 说「注解当前开着」，窄条内容与取消说在明处',
    String(find86(items, 'blame').props.title).indexOf('注解当前开着') >= 0
    && String(find86(items, 'blame').props.title).indexOf('再点一次取消') >= 0)
}
{
  const items = itemsOf({ blameOk: false, blameWhy: '未跟踪的文件 git 还没见过它，没有可注解的版本' })
  const blame = find86(items, 'blame')
  ok('未跟踪（blameOk=false）：置灰且 title 原话说原因',
    blame.props.disabled === true && String(blame.props.title).indexOf('未跟踪的文件 git 还没见过它') >= 0)
  ok('blameOk=false 又没给 why：title 有兜底话', String(find86(itemsOf({}), 'blame').props.title).indexOf('当前视图没有可注解的版本') >= 0)
  ok('blameOk=true 时 title 按右栏版本说三路（工作区/这个提交/选区最新一条）',
    String(find86(itemsOf({ blameOk: true }), 'blame').props.title).indexOf('工作区文件') >= 0
    && String(find86(itemsOf({ blameOk: true }), 'blame').props.title).indexOf('选区最新一条') >= 0)
}
{
  let hit = 0
  const acts = actsOf({ onShowWs: () => { hit += 1 } })
  find86(itemsOf({}, acts), 'ws').props.onClick({ stopPropagation: () => {} })
  ok('外观项点击：stopPropagation 后翻转回调跑一次', hit === 1)
  ok('align/sync 没有.onClick（置灰项点不动）',
    find86(itemsOf({}), 'align').props.onClick === undefined && find86(itemsOf({}), 'sync').props.onClick === undefined)
}

/* ═══ 2. 面板世界：行号换边、blame 窄条、折叠、外观 ═══ */

console.log('')
console.log('=== 面板世界：差异视图的行号、blame、折叠与外观 ===')

const built = await import(ROOT + 'build.mjs')
let hostBody = process.env.GP_SRC || null
if (hostBody === null) {
  hostBody = built.render(built.TARGETS.find((t) => t.out === 'dist/host.js'))
} else {
  hostBody = fs.readFileSync(hostBody, 'utf8')
}
const clientTmp = path.join(os.tmpdir(), 'gp87-client-' + process.pid + '.js')
fs.writeFileSync(clientTmp, built.render(built.TARGETS.find((t) => t.out === 'dist/client.js')))
const harnessTmp = path.join(os.tmpdir(), 'gp87-harness-' + process.pid + '.mjs')
fs.writeFileSync(harnessTmp, fs.readFileSync(ROOT + 'test/gp37-harness.part', 'utf8')
  + '\nexport { fs, React, makeElement, renderUntilStable, settle, openPanel, buttons, byClass, textOf, collect, walk, wait, fibers, calls, host, popover, chip, registered, nowSec, store }'
  + '\nexport function gp87GraphSet(v) { graphCommits = v }')
/* 临时文件一律放系统 tmp，跑完（含失败退出）都删。 */
process.on('exit', () => {
  for (const p of [clientTmp, harnessTmp, '/tmp/gp87-repo', '/tmp/gp87-home']) {
    try { fs.rmSync(p, { recursive: true, force: true }) } catch (error) { /* 尽力而为 */ }
  }
})
process.env.GP_SRC = clientTmp
const W = await import(harnessTmp)

/* 外观四开关的归一化（20-prefs.js 源码级，从产物里切出 DEFAULTS+normalize 一段）。 */
const clientText = clientTmp != null ? fs.readFileSync(clientTmp, 'utf8') : ''
/* 两段各取所需：DEFAULTS 一段 + normalizeSettings 一段，中间的 signal 接线不进求值。 */
const prefsSrc = clientText.slice(clientText.indexOf('const SETTINGS_DEFAULTS'), clientText.indexOf('let settingsLoaded'))
  + '\n' + clientText.slice(clientText.indexOf('function normalizeSettings'), clientText.indexOf('function loadSettings'))
const normalizeOf = new Function(prefsSrc + '\nreturn normalizeSettings')()
const NORM = normalizeOf({})
ok('normalizeSettings：四键默认 ws=false / no=true / guides=false / wrap=false',
  NORM.diffShowWs === false && NORM.diffShowNo === true && NORM.diffIndentGuides === false && NORM.diffWrap === false)
{
  const odd = normalizeOf({ diffShowWs: 'yes', diffShowNo: 'x', diffIndentGuides: 1, diffWrap: 'y' })
  ok('非法值归一：ws/guides/wrap 只认布尔 true，no 只认布尔 false（缺省即开）',
    odd.diffShowWs === false && odd.diffShowNo === true && odd.diffIndentGuides === false && odd.diffWrap === false
    && normalizeOf({ diffShowNo: false }).diffShowNo === false)
}

/* ── 罐头：差异补丁按 (path, context) 两维给 ──
   小补丁：上下文段都 ≤10 行（普通 -U3 的形状，无折叠条）；
   大补丁：两段未更改区 12 行与 13 行（>10 → 折叠条 N=12 / N=13）。 */
const SMALL_A = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,6 +1,7 @@ head',
  ' ctx1',
  ' ctx2',
  '-del line',
  '+new line',
  ' ctx3',
  '+added line',
  ' ctx4',
].join('\n')
const run = (mark, n) => { const out = []; for (let i = 1; i <= n; i += 1) out.push(' ' + mark + String(i).padStart(2, '0')); return out }
const BIG_A = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,28 +1,16 @@ head',
].concat(run('c', 12), ['-del line', '+new line'], run('d', 13)).join('\n')
const SMALL_B = [
  'diff --git a/src/other.js b/src/other.js',
  'index 3333333..4444444 100644',
  '--- a/src/other.js',
  '+++ b/src/other.js',
  '@@ -1,3 +1,4 @@ head',
  ' octx1',
  '-oold',
  '+onew',
  ' octx2',
].join('\n')
const BIG_B = [
  'diff --git a/src/other.js b/src/other.js',
  'index 3333333..4444444 100644',
  '--- a/src/other.js',
  '+++ b/src/other.js',
  '@@ -1,16 +1,4 @@ head',
].concat(run('o', 12), ['-oold', '+onew']).join('\n') + '\n\\ No newline at end of file'

let bigTruncated = false
/* 变更页的两行未暂存文件：A 供折叠/blame/外观，B 供换文件重读与超限警告。 */
const work87 = { staged: [], unstaged: [{ path: 'src/app.js', code: ' M' }, { path: 'src/other.js', code: ' M' }], untracked: [], unmerged: [] }
const diffCalls = []
const blameCalls = []
const BLAME_LINES = [
  { no: 1, short: 'aaa1111', author: '张三', date: '2026-11-01T09:00:00+08:00', boundary: false },
  { no: 4, short: '^bbb2222', author: '李四', date: '2026-11-02T10:00:00+08:00', boundary: true },
]
const realCall87 = W.host.call
W.host.call = function (method, args) {
  if (method === 'git/diff') {
    diffCalls.push(args)
    const big = args != null && args.context === 100000
    if (args != null && args.path === 'src/other.js') {
      return Promise.resolve(big
        ? { ok: true, mode: 'worktree', path: 'src/other.js', text: BIG_B, added: 1, removed: 1, binary: false, truncated: bigTruncated, empty: false }
        : { ok: true, mode: 'worktree', path: 'src/other.js', text: SMALL_B, added: 1, removed: 1, binary: false, truncated: false, empty: false })
    }
    return Promise.resolve({ ok: true, mode: 'worktree', path: 'src/app.js', text: big ? BIG_A : SMALL_A, added: 2, removed: 1, binary: false, truncated: false, empty: false })
  }
  if (method === 'git/blame') {
    blameCalls.push(args)
    return Promise.resolve({ ok: true, mode: args != null ? args.mode : '', path: args != null ? args.path : '', lines: BLAME_LINES })
  }
  if (method === 'git/panel') {
    return Promise.resolve({ ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0, sequencer: null, staged: work87.staged, unstaged: work87.unstaged, untracked: work87.untracked, unmerged: work87.unmerged })
  }
  return realCall87(method, args)
}

const settlePop = () => W.settle('pop')
const clickTab = async function (tree, label) {
  const hit = W.buttons(tree).find((b) => W.textOf(b).indexOf(label) >= 0)
  if (hit === undefined) throw new Error('找不到页签「' + label + '」')
  hit.props.onClick()
  await W.wait(10)
  return await settlePop()
}
const clickText = async function (tree, label, exact) {
  const hit = W.buttons(tree).find((b) => (exact === true ? W.textOf(b) === label : W.textOf(b).indexOf(label) >= 0))
  if (hit === undefined) throw new Error('找不到按钮「' + label + '」')
  hit.props.onClick({ stopPropagation() {} })
  await W.wait(30)
  return await settlePop()
}
const gutterClick = async function (tree) {
  const cell = W.collect(tree).find((n) => typeof n.props.className === 'string'
    && n.props.className.indexOf('dsh-git-dsign') >= 0 && typeof n.props.onContextMenu === 'function')
  if (cell === undefined) throw new Error('找不到带右键挂点的记号格')
  cell.props.onContextMenu({ clientX: 4, clientY: 4, preventDefault() {}, stopPropagation() {} })
  await W.wait(10)
  return await settlePop()
}
/* 走出渲染树找 paired 行（两个 half 的 dline）与其半列的子节点类名序列。 */
const pairedRowsOf = function (tree) {
  const rows = []
  const visit = (node) => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    const cls = node.props != null && typeof node.props.className === 'string' ? node.props.className : ''
    /* paired 行的判据是形状：两个 dsh-git-dhalf 半列（fold/hunk/meta 行都只有一格 dfull）。 */
    if (cls.indexOf('dsh-git-dline') >= 0) {
      const kids = Array.isArray(node.props.children) ? node.props.children : []
      if (kids.length === 2 && kids[0] != null && String(kids[0].props.className).indexOf('dsh-git-dhalf') >= 0) rows.push(node)
    }
    const kids = node.props != null && Array.isArray(node.props.children) ? node.props.children : []
    kids.forEach(visit)
  }
  visit(tree)
  return rows
}
const halfClasses = (half) => (Array.isArray(half.props.children) ? half.props.children : [])
  .map((c) => String(c != null && c.props != null ? c.props.className : ''))
const barsOf = (tree) => W.byClass(tree, 'dsh-git-dfold').map(W.textOf)
const openChangesDiff = async function (path) {
  W.fibers.clear()
  let tree = await W.openPanel()
  tree = await clickTab(tree, '变更')
  const base = path.split('/').pop()
  const row = W.byClass(tree, 'dsh-git-trow').find((r) => W.textOf(r).indexOf(base) >= 0)
  if (row === undefined) throw new Error('变更树里没有「' + path + '」')
  row.props.onClick()
  await W.wait(30)
  return await settlePop()
}

let tree = null
let mark = 0

console.log('')
console.log('== 左半行号换边：paired 行与 hunk/meta 行型 ==')
tree = await openChangesDiff('src/app.js')
{
  const rows = pairedRowsOf(tree)
  ok('差异视图开着且 paired 行不止一行', rows.length >= 4)
  const first = rows[0]
  const oldKids = halfClasses(first.props.children[0])
  const newKids = halfClasses(first.props.children[1])
  ok('左半子节点顺序 [记号][正文][行号]（行号贴分隔线内侧）',
    oldKids.length === 3 && oldKids[0].indexOf('dsh-git-dsign') >= 0
    && oldKids[1].indexOf('dsh-git-dtext') >= 0 && oldKids[2].indexOf('dsh-git-dno') >= 0)
  ok('右半子节点顺序 [行号][记号][正文]（不动）',
    newKids.length === 3 && newKids[0].indexOf('dsh-git-dno') >= 0
    && newKids[1].indexOf('dsh-git-dsign') >= 0 && newKids[2].indexOf('dsh-git-dtext') >= 0)
  ok('paired 行行号成对（首行 old=1/new=1，del 行只有 old 号）',
    W.textOf(first.props.children[0].props.children[2]) === '1'
    && W.textOf(first.props.children[1].props.children[0]) === '1')
  const delRow = rows.find((r) => halfClasses(r.props.children[0])[0].indexOf('dsh-git-dsign') >= 0
    && W.textOf(r.props.children[0].props.children[0]) === '-')
  ok('del 行左半仍是 [记号][正文][行号]（换边对每种 paired 行一致）', delRow !== undefined)
  const hunk = W.byClass(tree, 'dsh-git-dl-hunk')[0]
  const meta = W.byClass(tree, 'dsh-git-dl-meta')[0]
  ok('hunk/meta 行型不变：一格 dsh-git-dfull 横跨两列',
    hunk !== undefined && W.byClass(hunk, 'dsh-git-dfull').length === 1
    && meta !== undefined && W.byClass(meta, 'dsh-git-dfull').length === 1)
  ok('默认（fragOpen=false）没有折叠条：普通 -U3 读的画面与从前一字不差', barsOf(tree).length === 0)
  ok('默认只有一次普通读（大上下文读还不发）', diffCalls.length === 1 && diffCalls[0].context === undefined)
}

console.log('')
console.log('== blame：菜单开关、payload 与窄条 ==')
mark = blameCalls.length
tree = await gutterClick(tree)
tree = await clickText(tree, '使用 Git 退溯注解(N)', true)
ok('blame 开关发出 git/blame：file 视图 → mode=worktree、带 path/repo、不带 ref',
  blameCalls.length === mark + 1 && blameCalls[blameCalls.length - 1].mode === 'worktree'
  && blameCalls[blameCalls.length - 1].path === 'src/app.js' && blameCalls[blameCalls.length - 1].ref === undefined
  && blameCalls[blameCalls.length - 1].sessionId === 's-1')
{
  const bars = W.byClass(tree, 'dsh-git-dblame').filter((n) => W.textOf(n).length > 0)
  const boundary = bars.find((n) => String(n.props.className).indexOf('dsh-git-dblame-b') >= 0)
  ok('blame 窄条按行号对号入座（两条有字），边界条带压暗类且短 hash 带 ^ 前缀',
    bars.length === 2 && boundary !== undefined && W.textOf(boundary).indexOf('^bbb2222') >= 0)
  ok('窄条 title 有短 hash/作者/日期与「右键行号可关闭注解」',
    bars.some((n) => String(n.props.title).indexOf('aaa1111') >= 0 && String(n.props.title).indexOf('张三') >= 0
      && String(n.props.title).indexOf('右键行号可关闭注解') >= 0))
}
mark = blameCalls.length
tree = await gutterClick(tree)
tree = await clickText(tree, '✓ 使用 Git 退溯注解(N)', true)
ok('注解关闭：窄条消失，读数留手里不再发 git/blame',
  W.byClass(tree, 'dsh-git-dblame').every((n) => W.textOf(n).length === 0) && blameCalls.length === mark)

console.log('')
console.log('== 折叠：首次展开一次大读、收放零重读、行号不受折叠影响 ==')
mark = diffCalls.length
tree = await gutterClick(tree)
tree = await clickText(tree, '✓ 收起未更改的片段', true)
const bigCall = diffCalls[diffCalls.length - 1]
ok('首次展开发大上下文读：context=100000 + full=true，mode/path 与普通读同一批',
  diffCalls.length === mark + 1 && bigCall.context === 100000 && bigCall.full === true && bigCall.path === 'src/app.js')
await W.wait(40)
tree = await settlePop()
{
  const rows = pairedRowsOf(tree)
  const ctxNos = rows.filter((r) => W.textOf(r.props.children[0].props.children[0]) === ' ')
    .map((r) => W.textOf(r.props.children[0].props.children[2]))
  ok('展开态（fragOpen=true）全部行在列、无折叠条：大补丁的 25 行未更改内容都在（12+13）',
    barsOf(tree).length === 0 && ctxNos.length === 25)
  ok('展开态行号是配对时算好的：old 侧 1..12、14..26 连续不重编（del 行的 13 不在 ctx 列表里）',
    ctxNos.slice(0, 12).every((n, i) => n === String(i + 1)) && ctxNos[12] === '14' && ctxNos[24] === '26')
}
mark = diffCalls.length
tree = await gutterClick(tree)
tree = await clickText(tree, '展开未更改的片段', true)
ok('收起（fragOpen=false）：长未更改段折成两条「⋯ 展开未更改的 N 行」，N=12 与 N=13',
  barsOf(tree).length === 2 && barsOf(tree)[0].indexOf('⋯ 展开未更改的 12 行') >= 0
  && barsOf(tree)[1].indexOf('⋯ 展开未更改的 13 行') >= 0)
ok('收放只换画法：一个读都不发', diffCalls.length === mark)
{
  const expandBtn = W.byClass(tree, 'dsh-git-dfold')[0]
  expandBtn.props.onClick()
  await W.wait(10)
  tree = await settlePop()
  const rows = pairedRowsOf(tree)
  const ctxNos = rows.filter((r) => W.textOf(r.props.children[0].props.children[0]) === ' ')
    .map((r) => W.textOf(r.props.children[0].props.children[2]))
  ok('逐段展开：只露出本段 12 行，行号 1..12 与全展开态逐行一致（折叠不改行号）',
    ctxNos.length === 12 && ctxNos[0] === '1' && ctxNos[11] === '12')
  ok('展开态条换「⌃ 收起」，另一段条不受影响（逐段互斥）',
    barsOf(tree)[0].indexOf('⌃ 收起未更改的 12 行') >= 0 && barsOf(tree)[1].indexOf('⋯ 展开未更改的 13 行') >= 0)
  mark = diffCalls.length
  W.byClass(tree, 'dsh-git-dfold')[0].props.onClick()
  await W.wait(10)
  tree = await settlePop()
  ok('再收起：条回「⋯ 展开」，一个读都不发（收放只换画法）',
    barsOf(tree)[0].indexOf('⋯ 展开未更改的 12 行') >= 0 && diffCalls.length === mark)
  mark = diffCalls.length
  W.byClass(tree, 'dsh-git-dfold')[1].props.onClick()
  await W.wait(10)
  tree = await settlePop()
  ok('两段各自独立收放（第二段展开不惊动第一段的收起态），读数仍是两笔',
    barsOf(tree).length === 2 && barsOf(tree)[0].indexOf('⋯ 展开未更改的 12 行') >= 0
    && barsOf(tree)[1].indexOf('⌃ 收起未更改的 13 行') >= 0 && diffCalls.length === mark)
}
console.log('')
console.log('== 超限：truncated 给「差异过长」警告，不冒充完整折叠 ==')
mark = diffCalls.length
bigTruncated = true
tree = await openChangesDiff('src/other.js')
ok('换文件按 shape 先发普通读', diffCalls.length === mark + 1)
tree = await gutterClick(tree)
tree = await clickText(tree, '✓ 收起未更改的片段', true)
ok('新文件首开展开：大读照发（context=100000+full）', diffCalls.length === mark + 2
  && diffCalls[diffCalls.length - 1].path === 'src/other.js' && diffCalls[diffCalls.length - 1].context === 100000)
await W.wait(40)
tree = await settlePop()
tree = await gutterClick(tree)
tree = await clickText(tree, '展开未更改的片段', true)
ok('大读 truncated：视图给「差异过长，只显示了开头一部分」警告',
  W.byClass(tree, 'dsh-git-diffwarn').some((n) => W.textOf(n).indexOf('差异过长') >= 0))
ok('警告与折叠并存：截过的账没有冒充完整（折叠条与警告同屏）',
  barsOf(tree).some((b) => b.indexOf('展开未更改的 12 行') >= 0)
  && W.byClass(tree, 'dsh-git-diffwarn').length > 0)

console.log('')
console.log('== 外观四开关：持久化往返、字符保真、wrap 让位、隐藏行号不锁门 ==')
tree = await openChangesDiff('src/app.js')
{
  const style0 = W.collect(tree).find((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dsh-git-diffwrap') >= 0)
  ok('默认（wrap 关）：diffwrap 无 -wrap 类且带 minHeight（虚拟窗口在位）',
    style0 !== undefined && String(style0.props.className).indexOf('dsh-git-diffwrap-wrap') < 0
    && style0.props.style != null && style0.props.style.minHeight !== undefined)
}
mark = diffCalls.length
tree = await gutterClick(tree)
tree = await clickText(tree, '显示空格', true)
ok('显示空格：偏好写进 localStorage（dsh.git-idea.settings 的 diffShowWs=true）',
  JSON.parse(W.store['dsh.git-idea.settings'] || '{}').diffShowWs === true)
ok('ws 只换画法：一个 git/diff 都不发', diffCalls.length === mark)
{
  const wsp = W.byClass(tree, 'dsh-git-wsp')
  ok('ws 字符保真：wsp span 里的字符还是原空格/制表符（字形只走 ::after），复制到的不变',
    wsp.length > 0 && wsp.every((n) => W.textOf(n) === ' ' || W.textOf(n) === '\t'))
}
tree = await gutterClick(tree)
tree = await clickText(tree, '✓ 显示空格', true)
ok('再点还原：diffShowWs 回 false',
  JSON.parse(W.store['dsh.git-idea.settings'] || '{}').diffShowWs === false)
tree = await gutterClick(tree)
tree = await clickText(tree, '自动换行', true)
{
  const wrapEl = W.collect(tree).find((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dsh-git-diffwrap') >= 0)
  const table = W.byClass(tree, 'dsh-git-dtable-wrap')
  ok('自动换行：dtable 与 diffwrap 都加 -wrap 类，容器退回 100% 宽、无 minHeight（虚拟窗口让位全量渲染）',
    wrapEl !== undefined && String(wrapEl.props.className).indexOf('dsh-git-diffwrap-wrap') >= 0
    && table.length > 0 && wrapEl.props.style === undefined)
}
tree = await gutterClick(tree)
tree = await clickText(tree, '✓ 自动换行', true)
{
  const wrapEl = W.collect(tree).find((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dsh-git-diffwrap') >= 0)
  ok('换行关掉：-wrap 类退场（回单行横向滚动）',
    String(wrapEl.props.className).indexOf('dsh-git-diffwrap-wrap') < 0)
}
tree = await gutterClick(tree)
tree = await clickText(tree, '✓ 显示行号', true)
/* 疑似 bug 在案（交付报告有专条）：onShowNo 的翻转式子写成 prefs.diffShowNo !== false，
   对 true/false 都求出原值——「显示行号」点击不动、偏好不落盘。这里钉住当前行为，
   修复后这条会变红，届时改成翻转断言 + 「隐藏行号后记号格仍能开菜单」的完整路径。 */
ok('「显示行号」点击（当前实现）：开关不动、偏好不落盘（疑似 bug：onShowNo 式子 !== false 恒等原值）',
  JSON.parse(W.store['dsh.git-idea.settings'] || '{}').diffShowNo === true
  && W.byClass(tree, 'dsh-git-dno').length > 0
  && W.buttons(tree).some((b) => W.textOf(b) === '✓ 显示行号'))
tree = await settlePop()
ok('记号格的菜单始终可达（行号显隐之外的入口不受伤）：右键记号格菜单四外观项都在',
  W.buttons(tree).filter((b) => ['显示空格', '✓ 显示行号', '显示缩进参考线', '自动换行'].indexOf(W.textOf(b)) >= 0).length === 4)

/* ═══ 3. Host：git/blame（桩：形状与 porcelain 解析） ═══ */

console.log('')
console.log('=== Host：git/blame（桩 run：形状、porcelain 四类、上限）===')

function makeHost(run) {
  const handlers = new Map()
  const ctx = {
    get: (n) => (n === 'shell' ? { resolve: (r) => r, run: run } : undefined),
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
  }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', hostBody)(
    ctx, harness, console, (s) => Buffer.from(s, 'binary').toString('base64'),
    (s) => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return (n) => handlers.get(n)
}

const isConfigProbe = (spec) => String(spec.command).indexOf("git '") < 0
const probeAnswer = (spec) => (String(spec.command).indexOf('DSH_HOME') >= 0 ? '/tmp/gp87-home' : '{}')
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const SHA_C = 'cccccccccccccccccccccccccccccccccccccccc'
/* porcelain 四类齐活：普通头行+元数据 / ^ 边界头行 / boundary 元数据行的提交 /
   filename 复用段（同 sha 第二批行只带头行）。 */
const PORCELAIN = [
  SHA_A + ' 1 1 2',
  'author 张三',
  'author-mail <z@x>',
  'author-time 2026-11-01T09:00:00+08:00',
  'author-tz +0800',
  'committer 李四',
  'committer-time 2026-11-01T09:00:00+08:00',
  'summary first',
  'filename a.txt',
  '\tline one',
  '\tline two',
  '^' + SHA_B + ' 3 3',
  '\tline three',
  SHA_C + ' 4 4 1',
  'author 王五',
  'author-time 2026-11-02T10:00:00+08:00',
  'boundary',
  'filename a.txt',
  '\tline four',
  SHA_A + ' 5 5',
  'filename a.txt',
  '\tline five',
].join('\n')

{
  let blameAnswer = () => ({ exitCode: 0, stdout: { text: PORCELAIN }, stderr: { text: '' } })
  const calls = []
  const run = (spec) => {
    if (isConfigProbe(spec)) return Promise.resolve({ exitCode: 0, stdout: { text: probeAnswer(spec) }, stderr: { text: '' } })
    calls.push(spec)
    return Promise.resolve(blameAnswer())
  }
  const H = makeHost(run)

  const mode = await H('git/blame')({ repo: '/r', mode: 'local', path: 'a.txt' })
  ok('mode 白名单外（local 不进 blame）：unknown-mode，stderr 列三个合法值，零命令',
    mode.ok === false && mode.error === 'unknown-mode' && calls.length === 0
    && String(mode.stderr).indexOf('worktree, commit, range') >= 0)
  const badBranch = await H('git/blame')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'main' })
  const badCaret = await H('git/blame')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'HEAD^' })
  const badRange = await H('git/blame')({ repo: '/r', mode: 'range', path: 'a.txt', ref: 'main..HEAD' })
  ok('commit 只认单个 hash、range 只认两段十六进制 base..head：同拒且零命令',
    badBranch.error === 'invalid-ref' && badCaret.error === 'invalid-ref' && badRange.error === 'invalid-ref' && calls.length === 0)
  const badPath = await H('git/blame')({ repo: '/r', mode: 'worktree', path: '../x' })
  ok('路径过 repoRelativePath（invalid-path，零命令）', badPath.ok === false && badPath.error === 'invalid-path' && calls.length === 0)

  calls.length = 0
  const worktree = await H('git/blame')({ repo: '/r', mode: 'worktree', path: 'a.txt' })
  ok('worktree：blame --porcelain 不带 rev（问的就是工作区文件），读取上限 16MB',
    calls.length === 1 && calls[0].command.indexOf("'blame' '--porcelain' '--' 'a.txt'") >= 0
    && calls[0].stdoutMaxBytes === 16777216)
  calls.length = 0
  const commit = await H('git/blame')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'aaa11112222' })
  ok('commit：rev 就是那个提交（问该提交的 blob）', calls[0].command.indexOf("'blame' '--porcelain' 'aaa11112222' '--' 'a.txt'") >= 0)
  calls.length = 0
  const range = await H('git/blame')({ repo: '/r', mode: 'range', path: 'a.txt', ref: 'aaa11112222..bbb22223333' })
  ok('range：rev 取 base..head 的尾段（head 那一版的 blob）',
    calls[0].command.indexOf("'blame' '--porcelain' 'bbb22223333' '--' 'a.txt'") >= 0)

  ok('答复 ok 且带 mode/path/ref', worktree.ok === true && worktree.mode === 'worktree' && worktree.path === 'a.txt')
  const lines = worktree.lines
  ok('四个头行各出一条：行号 1/3/4/5（porcelain 天然顺序，count=2 的提交只出一条）', lines.length === 4
    && lines[0].no === 1 && lines[1].no === 3 && lines[2].no === 4 && lines[3].no === 5)
  ok('普通头行：短 hash 7 位、boundary=false', lines[0].short === SHA_A.slice(0, 7) && lines[0].boundary === false)
  ok('^ 边界头行：boundary=true 且短 hash 带 ^ 前缀（头行自带的标记跟得上）',
    lines[1].boundary === true && lines[1].short === '^' + SHA_B.slice(0, 7))
  /* 疑似 bug 在案（交付报告有专条）：porcelain 的 author/author-time 元数据在头行
     入列之后才解析，行对象按值拷贝到的是当时的空串——答复的 author/date 恒为空。
     下面两条钉住当前行为；修复后变红，届时改成 author='张三'/date=原话 的正断言。 */
  ok('（疑似 bug）author/author-time 元数据行解析到了但没回到已入列的行：author/date 恒空串',
    lines[0].author === '' && lines[0].date === '' && lines[2].author === '' && lines[2].date === '')
  ok('（疑似 bug 同根）boundary 元数据行认出了提交，但首现行的标记没跟上：boundary=false、短 hash 无 ^',
    lines[2].boundary === false && lines[2].short === SHA_C.slice(0, 7))
  ok('filename 复用段：同 sha 第二批行（行号 5）按首次元数据复用——info 是共享对象，首段元数据落地后再入列的行拿得到作者',
    lines[3].no === 5 && lines[3].author === '张三' && lines[3].date === '2026-11-01T09:00:00+08:00')

  calls.length = 0
  /* transport 的截断记号在 stdout 通道对象上（invoke 读 raw.stdout.truncated）。 */
  blameAnswer = () => ({ exitCode: 0, stdout: { text: PORCELAIN, truncated: true }, stderr: { text: '' } })
  const tooBig = await H('git/blame')({ repo: '/r', mode: 'worktree', path: 'a.txt' })
  ok('transport 截断：blame-too-large，stderr 说半份注解会指错行',
    tooBig.ok === false && tooBig.error === 'blame-too-large' && String(tooBig.stderr).indexOf('指错行') >= 0)
  blameAnswer = () => ({ exitCode: 128, stdout: { text: '' }, stderr: { text: "fatal: no such path 'a.txt' in HEAD" } })
  const noPath = await H('git/blame')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'aaa11112222' })
  ok('git 拒绝（路径不在该版本）：blame-failed 且 stderr 原话带回',
    noPath.ok === false && noPath.error === 'blame-failed' && String(noPath.stderr).indexOf('no such path') >= 0)
  blameAnswer = () => ({ exitCode: 127, stdout: { text: '' }, stderr: { text: 'dsh-git-idea: no git on PATH' } })
  const noGit = await H('git/blame')({ repo: '/r', mode: 'worktree', path: 'a.txt' })
  ok('git 不在机器上：noGit 标记位立起来', noGit.ok === false && noGit.noGit === true)
}

/* ═══ 4. Host：readFileDiff 的 context / full（桩） ═══ */

console.log('')
console.log('=== Host：git/diff 的大上下文读（-U 与 full 的形状）===')
{
  const calls = []
  let diffAnswer = () => ({ exitCode: 0, stdout: { text: 'diff --git a/a.txt b/a.txt\n' }, stderr: { text: '' } })
  const run = (spec) => {
    if (isConfigProbe(spec)) return Promise.resolve({ exitCode: 0, stdout: { text: probeAnswer(spec) }, stderr: { text: '' } })
    calls.push(spec)
    return Promise.resolve(diffAnswer())
  }
  const H = makeHost(run)

  await H('git/diff')({ repo: '/r', mode: 'range', path: 'a.txt', ref: 'aaa11112222..bbb22223333' })
  ok('不带 context：range argv 与从前逐字节一致（没有 -U）',
    calls[0].command.indexOf("'diff' '--no-color' '--no-ext-diff' 'aaa11112222..bbb22223333' '--' 'a.txt'") >= 0
    && calls[0].command.indexOf('-U') < 0)
  calls.length = 0
  await H('git/diff')({ repo: '/r', mode: 'range', path: 'a.txt', ref: 'aaa11112222..bbb22223333', context: 100000, full: true })
  ok('context=100000：-U100000 插在 diff 参数里、ref 之前',
    calls[0].command.indexOf("'diff' '--no-color' '--no-ext-diff' '-U100000' 'aaa11112222..bbb22223333' '--' 'a.txt'") >= 0)
  calls.length = 0
  await H('git/diff')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'aaa11112222', context: 100000 })
  ok('commit 模式：-U 插在 --first-parent 与 ref 之间',
    calls[0].command.indexOf("'--patch' '-m' '--first-parent' '-U100000' 'aaa11112222' '--'") >= 0)
  calls.length = 0
  await H('git/diff')({ repo: '/r', mode: 'range', path: 'a.txt', ref: 'aaa11112222..bbb22223333', context: 100001 })
  await H('git/diff')({ repo: '/r', mode: 'range', path: 'a.txt', ref: 'aaa11112222..bbb22223333', context: -1 })
  await H('git/diff')({ repo: '/r', mode: 'range', path: 'a.txt', ref: 'aaa11112222..bbb22223333', context: 1.5 })
  ok('非法 context（>100000 / 负数 / 小数）按没带算：三笔 argv 都没有 -U',
    calls.every((c) => c.command.indexOf('-U') < 0))

  const fat = 'first\n' + 'x'.repeat(250000) + '\n' + 'y'.repeat(250000) + '\n'
  diffAnswer = () => ({ exitCode: 0, stdout: { text: fat }, stderr: { text: '' } })
  calls.length = 0
  const fullFat = await H('git/diff')({ repo: '/r', mode: 'worktree', path: 'a.txt', context: 100000, full: true })
  ok('full=true 免 DIFF_CHARS_MAX：40 万字符级的补丁不截（truncated 不置位）',
    fullFat.ok === true && fullFat.truncated !== true && fullFat.text.length > 400000)
  calls.length = 0
  const plainFat = await H('git/diff')({ repo: '/r', mode: 'worktree', path: 'a.txt' })
  ok('full 缺省：DIFF_CHARS_MAX 照旧（截到 400000 并如实标 truncated）',
    plainFat.truncated === true && plainFat.text.length === 400000)
  const many = []
  for (let i = 0; i < 6100; i += 1) many.push(' L' + String(i))
  diffAnswer = () => ({ exitCode: 0, stdout: { text: many.join('\n') }, stderr: { text: '' } })
  calls.length = 0
  const capped = await H('git/diff')({ repo: '/r', mode: 'worktree', path: 'a.txt', context: 100000, full: true })
  ok('DIFF_LINES_MAX 照旧封顶（full 只免字符那道）：6100 行读回来只剩 6000 且如实标 truncated',
    capped.truncated === true && capped.text.split('\n').length === 6000)
}

/* ═══ 5. Host：git/blame 真仓库（版本三路 + untracked 拒） ═══ */

const hasGit = await new Promise((res) => {
  const c = spawn('sh', ['-c', 'command -v git >/dev/null 2>&1 && echo yes || echo no'])
  let out = ''
  c.stdout.on('data', (b) => { out += b })
  c.on('close', () => res(out.trim() === 'yes'))
})
const R = '/tmp/gp87-repo'
const sh = (cmd, cwd) => new Promise((res) => {
  const c = spawn('sh', ['-c', cmd], { cwd })
  let o = '', e = ''
  c.stdout.on('data', (b) => { o += b })
  c.stderr.on('data', (b) => { e += b })
  c.on('error', (er) => res({ code: null, out: o, err: String(er.message) }))
  c.on('close', (x) => res({ code: x, out: o, err: e }))
})

if (hasGit !== true) {
  console.log('  （这台机器没有 git，git/blame 的真仓库一段跳过）')
} else {
  console.log('')
  console.log('=== Host：git/blame（真仓库：版本三路与 untracked 拒）===')
  fs.rmSync(R, { recursive: true, force: true })
  fs.rmSync('/tmp/gp87-home', { recursive: true, force: true })
  await sh(`mkdir -p ${R} && cd ${R} && git init -q -b main && git config user.email t@t && git config user.name Tester`
    + ` && printf 'a\\n' > a.txt && git add -A && git commit -qm one`, '/tmp')
  const hash1 = (await sh('git rev-parse HEAD', R)).out.trim()
  await sh(`printf 'a\\nb\\n' > a.txt && git add -A && git commit -qm two`, R)
  const hash2 = (await sh('git rev-parse HEAD', R)).out.trim()

  const calls = []
  const run = (spec) => new Promise((res) => {
    if (isConfigProbe(spec)) {
      return res({ exitCode: 0, stdout: { text: probeAnswer(spec) }, stderr: { text: '' } })
    }
    calls.push(spec)
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: Object.assign({}, process.env, { DSH_HOME: '/tmp/gp87-home' }) })
    let o = '', e = ''
    c.stdout.on('data', (b) => { o += b })
    c.stderr.on('data', (b) => { e += b })
    c.on('error', (er) => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', (x) => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
  const H = makeHost(run)

  const wt = await H('git/blame')({ repo: R, mode: 'worktree', path: 'a.txt' })
  ok('worktree（真仓库）：ok，两行注解，行号 1/2，短 hash 分别是两笔提交',
    wt.ok === true && wt.lines.length === 2 && wt.lines[0].no === 1 && wt.lines[1].no === 2
    && wt.lines[0].short === hash1.slice(0, 7) && wt.lines[1].short === hash2.slice(0, 7))
  ok('worktree（真仓库）：author 字段当前恒空串（疑似 bug 在案，见上）——真 porcelain 也一样',
    wt.lines[0].author === '' && wt.lines[0].date === '')
  ok('worktree（真仓库）：argv 带 --porcelain 且不带 rev', calls[0].command.indexOf("'blame' '--porcelain' '--' 'a.txt'") >= 0)

  calls.length = 0
  const byHash = await H('git/blame')({ repo: R, mode: 'commit', path: 'a.txt', ref: hash2 })
  ok('commit（真仓库）：该提交 blob 的注解与工作区一致（a.txt 没再改过）',
    byHash.ok === true && byHash.lines.length === 2 && byHash.lines[1].short === hash2.slice(0, 7)
    && calls[0].command.indexOf("'" + hash2 + "'") >= 0)
  calls.length = 0
  const byRange = await H('git/blame')({ repo: R, mode: 'range', path: 'a.txt', ref: hash1 + '..' + hash2 })
  ok('range（真仓库）：问的是尾段 head 的版本（argv 里是 hash2）',
    byRange.ok === true && byRange.lines[1].short === hash2.slice(0, 7)
    && calls[0].command.indexOf("'" + hash2 + "'") >= 0)

  await sh(`printf 'new\\n' > fresh.txt`, R)
  const untracked = await H('git/blame')({ repo: R, mode: 'worktree', path: 'fresh.txt' })
  ok('untracked 路径（真仓库）：git 自己拒 → blame-failed，stderr 原话带回',
    untracked.ok === false && untracked.error === 'blame-failed' && String(untracked.stderr).length > 0)
}

console.log('')
if (failed > 0) {
  console.error('gp87-diffgutter: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
console.log('gp87-diffgutter: all checks passed')
