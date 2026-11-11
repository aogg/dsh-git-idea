import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/* ── 文件右键菜单「复制完整差异」（61-filemenu.js 的菜单项 + 80-panel.js 的
 *    acts.onCopyPatch + Host 68-detail.js readPatchText 经 80-rpc.js 的 git/patch-text）──
 *
 * 「显示差异」的兄弟项：把这一行目标的完整 unified diff 补丁 + 面向 AI 的说明头
 * 写进剪贴板，粘给大模型解释这次修改。一个套件盯三层：
 *   1. 菜单（61-filemenu.js 源码级整段求值，gp59 同款）：copy-patch 存在且紧跟
 *      show-diff、五棵树（commit / range / worktree 三种 listKind，五棵树共用这份
 *      菜单）都在；普通单击（无 danger、无两段式——第一击就发动作、不武装）；
 *      启停矩阵与「显示差异」完全一致——未跟踪折叠目录置灰且 title 说去处、busy
 *      置灰、普通文件行可用；三种 listKind 的 title 各说各的「复制的是什么」。
 *   2. acts.onCopyPatch（gp37-harness 的面板世界，挂真面板点真菜单）：三种
 *      listKind 发出的 git/patch-text payload（sessionId/path/mode/ref/from/repo）
 *      逐格断言——commit = detail.hash、range = base..head、worktree 按行上状态
 *      （untracked/staged/worktree）挑模式；成功 toast 带字节数与「粘给 AI」、
 *      rpc 拒绝走 setError、空文本答复也走 setError、写剪贴板被拒给出手动复制
 *      的出路（桩 navigator.clipboard.writeText）。多仓库分组里 payload.repo 落
 *      在行自己那个仓库（diff 右列的那条路）。
 *   3. Host git/patch-text（桩 run 验形状 + 真仓库验效果，gp59 的两段式）：mode
 *      白名单外拒绝、ref 只认 DIFF_SHA / DIFF_RANGE（分支名与 ^ 表达式一律拒、
 *      且一个 git 命令都不跑）、路径过 repoRelativePath；commit 的 argv 形状与
 *      16MB 读取上限（不是展示截断那档）；答复带 header/patch/text/bytes，头部
 *      有仓库根、提交 hash、作者、日期、标题、正文（超长截正文并注明）；真仓库
 *      上造一个超过展示截断阈值（DIFF_LINES_MAX=6000 行）的改动，验证补丁完整
 *      不截；untracked 的 --no-index 以 exit 1 + 非空 stdout 判成功；二进制与空
 *      补丁不算失败但 scope 说明写进 header。
 *
 * Host 那一半读 GP_SRC（run-all.mjs 的 GP_FRESH 会指到临时拼接）；没设时用
 * build.mjs 的 render 现拼。客户端这一半同理：gp37-harness 按它自己的读法要
 * GP_SRC，这里把 src/ 现拼的 client 写进系统 tmp 再喂给它——测的永远是 src/，
 * 仓库产物一个字节不动。 */

let failed = 0
const ok = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const ROOT = new URL('..', import.meta.url).pathname

/* ═══ 1. 菜单：copy-patch 的位置、单击形态与启停矩阵 ═══ */

console.log('')
console.log('=== fileMenuItems：copy-patch 项与启停矩阵 ===')
const menuSrc = fs.readFileSync(ROOT + 'src/client/61-filemenu.js', 'utf8')
const menuApi = new Function('h', 'text', menuSrc + '\nreturn { fileMenuItems: fileMenuItems, fileMenuTarget: fileMenuTarget }')(
  (type, props) => ({ type: type, props: Object.assign({}, props) }),
  (v) => (typeof v === 'string' ? v : ''))
const find = (items, key) => items.find((el) => el.props.key === key)
const COMMIT = { listKind: 'commit', repo: '', rev: 'aaa1111bbb2222', paths: [{ path: 'src/a.js', dir: false, untracked: false, staged: false }] }
const RANGE = { listKind: 'range', repo: '', rev: 'aaa1111bbb2222', paths: [{ path: 'src/a.js', dir: false, untracked: false, staged: false }] }
const WORK_FILE = { listKind: 'worktree', repo: '', rev: '', paths: [{ path: 'a.js', dir: false, untracked: false, staged: false }] }
const WORK_NEW_DIR = { listKind: 'worktree', repo: '', rev: '', paths: [{ path: 'newdir/', dir: true, untracked: true, staged: false }] }

const baseActs = () => ({
  busy: false, arm: '', setArm: () => {}, setCtxMenu: () => {},
  canOpenFile: true, openWhy: '', historyOk: true, historyWhy: '',
  onCompareLocal: () => {}, onOpenFile: () => {}, onShowDiff: () => {}, onCopyPatch: () => {},
  onRevert: () => {}, onCherryPick: () => {}, onClean: () => {}, onGetFromRev: () => {}, onShowHistory: () => {},
})

/* 五棵树（单提交详情 / 多选合并视图 / diff 右列 commit·changes 两路 / 变更页）
   收敛成三种 listKind，共用同一份构造——每种都得有 copy-patch，且紧跟 show-diff
   （同一组「看」，中间不插分隔线）。 */
for (const target of [COMMIT, RANGE, WORK_FILE]) {
  const items = menuApi.fileMenuItems(target, baseActs())
  const at = items.findIndex((el) => el.props.key === 'copy-patch')
  ok(target.listKind + ' 树有 copy-patch 且紧跟 show-diff（同一组「看」，中间无分隔线）',
    at > 0 && items[at - 1].props.key === 'show-diff' && items[at].type === 'button')
}

/* 普通单击：无 danger、无两段式。第一次点就发动作（onCopyPatch 收到行上的
   第一个 path 对象本身）、不武装（setArm 一个字都不动）、顺手关菜单。 */
{
  let armedKey = null
  let fired = 0
  let gotPath = null
  let menuClosed = 0
  let stopped = 0
  const acts = Object.assign(baseActs(), {
    setArm: (key) => { armedKey = key },
    setCtxMenu: () => { menuClosed += 1 },
    onCopyPatch: (one) => { fired += 1; gotPath = one },
  })
  const items = menuApi.fileMenuItems(COMMIT, acts)
  const item = find(items, 'copy-patch')
  ok('copy-patch 是普通按钮（无 danger 类）', String(item.props.className).indexOf('dsh-git-menu-danger') < 0)
  ok('别的键武装着也不连坐（copy-patch 依旧不红）',
    String(menuApi.fileMenuItems(COMMIT, Object.assign(acts, { arm: 'file:revert:src/a.js' })).find((el) => el.props.key === 'copy-patch').props.className).indexOf('dsh-git-menu-danger') < 0)
  item.props.onClick({ stopPropagation: () => { stopped += 1 } })
  ok('第一次点击就发动作（无两段式）：onCopyPatch 收到行上的 path 对象本身',
    fired === 1 && gotPath === COMMIT.paths[0] && armedKey === null)
  ok('点击顺手关菜单并拦住事件冒泡', menuClosed === 1 && stopped === 1)
}

/* 启停矩阵与「显示差异」完全一致：未跟踪折叠目录置灰且 title 同句、busy 置灰、
   普通文件行可用；title 三种 listKind 各说各的范围。 */
{
  const items = menuApi.fileMenuItems(WORK_NEW_DIR, baseActs())
  const patch = find(items, 'copy-patch')
  const diff = find(items, 'show-diff')
  ok('未跟踪折叠目录：copy-patch 置灰且与 show-diff 同置灰（矩阵一致）',
    patch.props.disabled === true && diff.props.disabled === true)
  ok('未跟踪折叠目录的 title 说「展开后对里面的文件用」',
    String(patch.props.title).indexOf('展开后对里面的文件用') >= 0)
  ok('busy 时置灰，title 与 show-diff 一样不找借口',
    find(menuApi.fileMenuItems(WORK_FILE, Object.assign(baseActs(), { busy: true })), 'copy-patch').props.disabled === true)
  ok('普通文件行可用',
    find(menuApi.fileMenuItems(WORK_FILE, baseActs()), 'copy-patch').props.disabled !== true)
  const titleOf = (target) => String(find(menuApi.fileMenuItems(target, baseActs()), 'copy-patch').props.title)
  ok('commit 树的 title 说「这个提交…完整补丁」', titleOf(COMMIT).indexOf('这个提交') >= 0 && titleOf(COMMIT).indexOf('完整补丁') >= 0)
  ok('range 树的 title 说「这段选区…合计补丁」', titleOf(RANGE).indexOf('这段选区') >= 0 && titleOf(RANGE).indexOf('合计补丁') >= 0)
  ok('worktree 树的 title 说「现在的改动补丁」并点名粘给 AI', titleOf(WORK_FILE).indexOf('现在的改动补丁') >= 0 && titleOf(WORK_FILE).indexOf('AI') >= 0)
}

/* ═══ 2. 面板世界：acts.onCopyPatch 的 payload 与两条失败腿 ═══
 *
 * gp37-harness 按「一个模块一个世界」写成；这里把它连同一行 export 清单写进
 * 系统 tmp 作为真模块导入，client 半侧读 src/ 现拼的那份（GP_SRC 喂给 harness
 * 的既有读法）。面板世界的 fiber 树以渲染 label 为根——所有 render 必须
 * 沿用 openPanel 的 'pop'，换 label 等于换了一套 fiber，多选/详情全是新的。 */

const built = await import(ROOT + 'build.mjs')
let hostBody = process.env.GP_SRC || null
if (hostBody === null) {
  hostBody = built.render(built.TARGETS.find((t) => t.out === 'dist/host.js'))
} else {
  hostBody = fs.readFileSync(hostBody, 'utf8')
}
const clientTmp = path.join(os.tmpdir(), 'gp86-client-' + process.pid + '.js')
fs.writeFileSync(clientTmp, built.render(built.TARGETS.find((t) => t.out === 'dist/client.js')))
const harnessTmp = path.join(os.tmpdir(), 'gp86-harness-' + process.pid + '.mjs')
fs.writeFileSync(harnessTmp, fs.readFileSync(ROOT + 'test/gp37-harness.part', 'utf8')
  + '\nexport { fs, React, makeElement, renderUntilStable, settle, openPanel, buttons, byClass, textOf, collect, wait, fibers, calls, host, popover, chip, registered, nowSec }'
  + '\nexport function gp86GraphSet(v) { graphCommits = v }')
/* 临时文件一律放系统 tmp，跑完（含失败退出）都删：真仓库夹具与两份拼接件。 */
process.on('exit', () => {
  for (const p of [clientTmp, harnessTmp, '/tmp/gp86-repo', '/tmp/gp86-home']) {
    try { fs.rmSync(p, { recursive: true, force: true }) } catch (error) { /* 尽力而为 */ }
  }
})
process.env.GP_SRC = clientTmp
const W = await import(harnessTmp)

/* 写剪贴板的桩：78-actions.js 的 copyTextToClipboard 先问 navigator.clipboard，
   被拒才落隐藏 textarea（node 世界没有 document，兜底自然走到 onFailed）。 */
const clipboardWrites = []
let clipboardMode = 'ok'
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'gp86-test',
    clipboard: {
      writeText: (value) => {
        if (clipboardMode === 'reject') return Promise.reject(new Error('denied by test'))
        clipboardWrites.push(value)
        return Promise.resolve()
      },
    },
  },
  configurable: true,
})

/* 面板世界的罐头：图是一条 parents 相连的四提交链（hash 都是 7+ 位十六进制，
   和真 hash 同形）；commit-detail 按 hash / base+head 两种形态各答各的。 */
const GRAPH = [
  { hash: 'aaa11112222', subject: 'tip one', author: 'mays', date: '2026-10-16', committedAt: W.nowSec - 60, refs: ['HEAD -> main'], parents: ['bbb22223333'] },
  { hash: 'bbb22223333', subject: 'two', author: 'mays', date: '2026-10-15', committedAt: W.nowSec - 3600, refs: [], parents: ['ccc33334444'] },
  { hash: 'ccc33334444', subject: 'three', author: 'mays', date: '2026-10-14', committedAt: W.nowSec - 7200, refs: [], parents: ['ddd44445555'] },
  { hash: 'ddd44445555', subject: 'root', author: 'mays', date: '2026-10-13', committedAt: W.nowSec - 10800, refs: [], parents: [] },
]
W.gp86GraphSet(GRAPH)

let detailFiles = [{ status: 'M', path: 'app.txt', from: 'old.txt' }]
let work86 = { staged: [], unstaged: [], untracked: [], unmerged: [] }
let patchReply = null
const patchCalls = []
const reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws/alpha', '/tmp/ws/beta'], manual: [], missing: [], links: [], truncated: false }
const realCall86 = W.host.call
W.host.call = function (method, args) {
  if (method === 'git/patch-text') {
    patchCalls.push(args)
    return Promise.resolve(patchReply)
  }
  if (method === 'git/commit-detail') {
    if (args != null && args.base != null) {
      return Promise.resolve({ ok: true, repo: '/tmp/ws', hash: args.head, subject: 'range head subject', body: '', author: 'mays', email: 'mays@example.com', date: '2026-09-16T10:00:00', files: [{ status: 'M', path: 'rng.txt', from: null }], branches: ['main'] })
    }
    return Promise.resolve({ ok: true, repo: '/tmp/ws', hash: (args && args.hash) || 'aaa11112222', subject: 'detail subject', body: '', author: 'mays', email: 'mays@example.com', date: '2026-09-16T10:00:00', files: detailFiles, branches: ['main'] })
  }
  if (method === 'git/panel') {
    return Promise.resolve({ ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0, sequencer: null, staged: work86.staged, unstaged: work86.unstaged, untracked: work86.untracked, unmerged: work86.unmerged })
  }
  if (method === 'git/repos') return Promise.resolve(reposReply)
  if (method === 'git/diff') {
    return Promise.resolve({ ok: true, mode: args && args.mode, path: args && args.path, text: 'diff --git a/x b/x\n', added: 1, removed: 0, binary: false, truncated: false, empty: false })
  }
  return realCall86(method, args)
}

const settlePop = () => W.settle('pop')
const clickTab = async function (tree, label) {
  const hit = W.buttons(tree).find((b) => W.textOf(b).indexOf(label) >= 0)
  if (hit === undefined) throw new Error('找不到页签「' + label + '」')
  hit.props.onClick()
  await W.wait(10)
  return await settlePop()
}
const rightClick = async function (tree, label) {
  const row = W.byClass(tree, 'dsh-git-trow').find((r) => W.textOf(r).indexOf(label) >= 0)
  if (row === undefined || typeof row.props.onContextMenu !== 'function') throw new Error('找不到带右键挂点的行「' + label + '」')
  row.props.onContextMenu({ clientX: 8, clientY: 8, preventDefault() {}, stopPropagation() {} })
  await W.wait(10)
  return await settlePop()
}
const clickMenuItem = async function (tree, label) {
  const hit = W.buttons(tree).find((b) => W.textOf(b) === label)
  if (hit === undefined) throw new Error('菜单里没有「' + label + '」')
  hit.props.onClick({ stopPropagation() {} })
  await W.wait(30)
  return await settlePop()
}
const okNote = (tree) => W.byClass(tree, 'dsh-git-oknote').map(W.textOf).join('\n')
const errNote = (tree) => W.byClass(tree, 'dsh-git-error').map(W.textOf).join('\n')
const openHistory = async function () {
  W.fibers.clear()
  return await W.openPanel()
}
const PATCH_OK = { ok: true, text: 'Git 补丁（unified diff，完整未截断）\ndiff --git a/app.txt b/app.txt\n', bytes: 2048, binary: false, empty: false, added: 2, removed: 1 }

console.log('')
console.log('== onCopyPatch：commit 的 payload、成功 toast 与剪贴板 ==')
patchReply = PATCH_OK
let tree = await openHistory()
W.byClass(tree, 'dsh-git-crow')[0].props.onClick()
await W.wait(20)
tree = await settlePop()
tree = await rightClick(tree, 'app.txt')
tree = await clickMenuItem(tree, '复制完整差异')
ok('commit 树：payload 带 sessionId/path/mode/ref/from——ref 是 detail.hash、from 是行上的改名来源',
  patchCalls.length === 1 && patchCalls[0].sessionId === 's-1' && patchCalls[0].path === 'app.txt'
  && patchCalls[0].mode === 'commit' && patchCalls[0].ref === 'aaa11112222' && patchCalls[0].from === 'old.txt')
ok('commit 树：单仓库不带 repo 字段（repo 空 = 生效仓库，不硬塞空串）', patchCalls[0].repo === undefined)
ok('成功 toast 带字节数（2048 → 2 KB）并点名「粘给 AI」',
  okNote(tree).indexOf('已复制完整差异 2 KB') >= 0 && okNote(tree).indexOf('粘给 AI') >= 0)
ok('写进剪贴板的是答复的 text 整段（header + patch）',
  clipboardWrites.length === 1 && clipboardWrites[0] === PATCH_OK.text)
ok('成功后错误条是空的（一次只说一件事）', errNote(tree).length === 0)

console.log('')
console.log('== onCopyPatch：rpc 拒绝走 setError，不碰剪贴板 ==')
const writes86 = clipboardWrites.length
patchReply = { ok: false, error: 'diff-failed', exitCode: 128, stderr: "fatal: bad revision 'aaa11112222'" }
tree = await openHistory()
W.byClass(tree, 'dsh-git-crow')[0].props.onClick()
await W.wait(20)
tree = await settlePop()
tree = await rightClick(tree, 'app.txt')
tree = await clickMenuItem(tree, '复制完整差异')
ok('rpc 答复 ok:false：git 的原话进错误条', errNote(tree).indexOf("fatal: bad revision 'aaa11112222'") >= 0)
ok('拒绝时成功条是空的、剪贴板一个字没写', okNote(tree).length === 0 && clipboardWrites.length === writes86)

console.log('')
console.log('== onCopyPatch：空文本答复同样走 setError ==')
patchReply = { ok: true, text: '', bytes: 0, binary: false, empty: true, added: 0, removed: 0 }
tree = await openHistory()
W.byClass(tree, 'dsh-git-crow')[0].props.onClick()
await W.wait(20)
tree = await settlePop()
tree = await rightClick(tree, 'app.txt')
tree = await clickMenuItem(tree, '复制完整差异')
ok('答复没有补丁文本：错误条说明白（0 KB）', errNote(tree).indexOf('宿主没有返回补丁文本') >= 0 && errNote(tree).indexOf('0 KB') >= 0)

console.log('')
console.log('== onCopyPatch：写剪贴板被拒给出手动复制的出路 ==')
clipboardMode = 'reject'
patchReply = PATCH_OK
tree = await openHistory()
W.byClass(tree, 'dsh-git-crow')[0].props.onClick()
await W.wait(20)
tree = await settlePop()
tree = await rightClick(tree, 'app.txt')
tree = await clickMenuItem(tree, '复制完整差异')
clipboardMode = 'ok'
ok('写剪贴板被拒：提示条说出路——差异视图手动选择复制，或改用 https 直连',
  okNote(tree).indexOf('无法写入剪贴板') >= 0 && okNote(tree).indexOf('差异视图') >= 0 && okNote(tree).indexOf('https://') >= 0)
ok('被拒的这一次没有半截文本进剪贴板，错误条也是空的', clipboardWrites.length === writes86 && errNote(tree).length === 0)

console.log('')
console.log('== onCopyPatch：range（多选合并视图）的 payload ==')
patchCalls.length = 0
patchReply = PATCH_OK
tree = await openHistory()
const crow86 = () => W.byClass(tree, 'dsh-git-crow')
crow86()[0].props.onClick()
await W.wait(10)
tree = await settlePop()
crow86()[2].props.onClick({ shiftKey: true, preventDefault() {} })
await W.wait(30)
tree = await settlePop()
ok('Shift+点击成段后合并视图开了（0 个文件合计那行在屏上）',
  W.byClass(tree, 'dsh-git-rangehead').length > 0 && W.textOf(tree).indexOf('3 条提交合并视图') >= 0)
tree = await rightClick(tree, 'rng.txt')
tree = await clickMenuItem(tree, '复制完整差异')
ok('range 树：payload.mode=range、ref 是 selSpanKey（base..head）、from 跟着行上的 raw',
  patchCalls.length === 1 && patchCalls[0].mode === 'range'
  && patchCalls[0].ref === 'ddd44445555..aaa11112222' && patchCalls[0].path === 'rng.txt' && patchCalls[0].from === '')

console.log('')
console.log('== onCopyPatch：worktree 三态各挑各的模式 ==')
for (const [name, work, want] of [
  ['未暂存行', { staged: [], unstaged: [{ path: 'w1.txt', code: ' M' }], untracked: [], unmerged: [] }, 'worktree'],
  ['已暂存行', { staged: [{ path: 'w2.txt', code: 'M.' }], unstaged: [], untracked: [], unmerged: [] }, 'staged'],
  ['未跟踪行', { staged: [], unstaged: [], untracked: [{ path: 'w3.txt', code: '??' }], unmerged: [] }, 'untracked'],
]) {
  work86 = work
  patchCalls.length = 0
  patchReply = PATCH_OK
  tree = await openHistory()
  tree = await clickTab(tree, '变更')
  tree = await rightClick(tree, name === '未暂存行' ? 'w1.txt' : (name === '已暂存行' ? 'w2.txt' : 'w3.txt'))
  tree = await clickMenuItem(tree, '复制完整差异')
  ok('worktree ' + name + '：payload.mode=' + want + '（ref/from 不发）',
    patchCalls.length === 1 && patchCalls[0].mode === want && patchCalls[0].ref === undefined && patchCalls[0].from === undefined
    && patchCalls[0].sessionId === 's-1')
}

console.log('')
console.log('== onCopyPatch：多仓库分组里 repo 落在行自己那个仓库 ==')
/* 第二个面板世界用独立的渲染循环（harness 的 settle/popTree 永远挂 sessionId
   's-1'——与 gp50 的 pop2 同一条规矩：渲染 label 与 sessionId 一套到底，混用
   等于换 fiber 树，详情/多选/仓库分组全是新的）。 */
patchCalls.length = 0
patchReply = PATCH_OK
work86 = { staged: [], unstaged: [{ path: 'app.txt', code: ' M' }], untracked: [], unmerged: [] }
W.fibers.clear()
const pop2 = async function () {
  const t = await W.renderUntilStable(W.makeElement(W.popover, { sessionId: 's-2' }), 'pop2')
  await W.wait(10)
  return t
}
let multi86 = await pop2()
const tab2 = function (t, label) {
  const hit = W.buttons(t).find((b) => W.textOf(b).indexOf(label) >= 0)
  if (hit === undefined) throw new Error('找不到页签「' + label + '」')
  hit.props.onClick()
  return pop2()
}
multi86 = await tab2(multi86, '变更')
const repoRow = (t, p) => W.byClass(t, 'dsh-git-repo-row').find((r) => String(r.props.key) === 'repo:' + p)
repoRow(multi86, '/tmp/ws/alpha').props.onClick({ ctrlKey: true })
await W.wait(10)
multi86 = await pop2()
repoRow(multi86, '/tmp/ws/beta').props.onClick({ ctrlKey: true })
await W.wait(10)
multi86 = await pop2()
await W.wait(30)
multi86 = await pop2()
const alphaRow = W.byClass(multi86, 'dsh-git-trow').find((r) => W.textOf(r).indexOf('app.txt') >= 0)
ok('多仓库分组的变更树里有 alpha 组的 app.txt 行', alphaRow !== undefined)
alphaRow.props.onClick()
await W.wait(30)
multi86 = await pop2()
const railRows = W.byClass(multi86, 'dsh-git-trow').filter((r) => typeof r.props.onContextMenu === 'function')
ok('diff 视图开了，右列行带着右键挂点', railRows.length > 0)
railRows[0].props.onContextMenu({ clientX: 6, clientY: 6, preventDefault() {}, stopPropagation() {} })
await W.wait(10)
multi86 = await pop2()
const patchBtn2 = W.buttons(multi86).find((b) => W.textOf(b) === '复制完整差异')
ok('diff 右列的菜单里找得到「复制完整差异」', patchBtn2 !== undefined)
patchBtn2.props.onClick({ stopPropagation() {} })
await W.wait(30)
multi86 = await pop2()
ok('diff 右列的复制：payload.repo 是点开它的那个仓库（alpha），会话也是面板自己的',
  patchCalls.length === 1 && patchCalls[0].repo === '/tmp/ws/alpha' && patchCalls[0].mode === 'worktree'
  && patchCalls[0].sessionId === 's-2' && patchCalls[0].path === 'app.txt')

/* ═══ 3. Host：git/patch-text ═══ */

console.log('')
console.log('=== Host：git/patch-text（桩 run：形状与拒绝）===')

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

/* 记账式 shell 替身：被测 git 命令逐条记下；配置探针（readConfigFile 的
   DSH_HOME 一问与 cat 配置文件）单独答、不记——与 gp59 同一条分账规则。 */
const isConfigProbe = (spec) => String(spec.command).indexOf("git '") < 0
const probeAnswer = (spec) => (String(spec.command).indexOf('DSH_HOME') >= 0 ? '/tmp/gp86-home' : '{}')
const FAKE_PATCH = 'diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+a2\n'
const META_LINE = ['fullhash1111111aaaaaaaaaaaaaaaaaa', 'fullhash1', '张三', 'zhang@x.example', '2026-11-11T10:00:00+08:00', '修复崩溃', '第一行\n第二行'].join('\u001f')

{
  let topLevelOk = true
  let metaAnswer = META_LINE
  let diffAnswer = () => ({ exitCode: 0, stdout: { text: FAKE_PATCH }, stderr: { text: '' } })
  const calls = []
  const run = (spec) => {
    if (isConfigProbe(spec)) return Promise.resolve({ exitCode: 0, stdout: { text: probeAnswer(spec) }, stderr: { text: '' } })
    const cmd = String(spec.command)
    calls.push(spec)
    if (cmd.indexOf("'rev-parse'") >= 0) {
      return Promise.resolve(topLevelOk
        ? { exitCode: 0, stdout: { text: '/repo/root\n' }, stderr: { text: '' } }
        : { exitCode: 1, stdout: { text: '' }, stderr: { text: 'not a repository' } })
    }
    if (cmd.indexOf("'show' '-s'") >= 0) {
      return Promise.resolve({ exitCode: 0, stdout: { text: metaAnswer }, stderr: { text: '' } })
    }
    return Promise.resolve(diffAnswer())
  }
  const H = makeHost(run)

  const mode = await H('git/patch-text')({ repo: '/r', mode: 'local', path: 'a.txt', ref: 'aaa1111' })
  ok('mode 白名单外（local 是 git/diff 的，不进这条）：unknown-mode，一个命令都没跑，stderr 列出五个合法值',
    mode.ok === false && mode.error === 'unknown-mode' && calls.length === 0
    && String(mode.stderr).indexOf('commit, range, staged, worktree, untracked') >= 0)

  const badBranch = await H('git/patch-text')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'main' })
  ok('commit 模式 ref 是分支名：invalid-ref 且零命令（DIFF_SHA 只认十六进制 hash）',
    badBranch.ok === false && badBranch.error === 'invalid-ref' && calls.length === 0)
  const badCaret = await H('git/patch-text')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'HEAD^' })
  const badShort = await H('git/patch-text')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'abcde0' })
  ok('^ 表达式与不足 7 位的 hash 同拒', badCaret.error === 'invalid-ref' && badShort.error === 'invalid-ref')
  const badRange1 = await H('git/patch-text')({ repo: '/r', mode: 'range', path: 'a.txt', ref: 'main..HEAD' })
  const badRange2 = await H('git/patch-text')({ repo: '/r', mode: 'range', path: 'a.txt', ref: 'aaa1111..zzzzzzz' })
  ok('range 模式 ref 不是两段十六进制 hash 的 base..head：同拒且零命令',
    badRange1.ok === false && badRange1.error === 'invalid-ref' && badRange2.error === 'invalid-ref' && calls.length === 0)

  const badPath = await H('git/patch-text')({ repo: '/r', mode: 'worktree', path: '/etc/passwd' })
  const upPath = await H('git/patch-text')({ repo: '/r', mode: 'worktree', path: '../x' })
  ok('路径过 repoRelativePath：绝对路径与「..」同拒（invalid-path，零命令）',
    badPath.ok === false && badPath.error === 'invalid-path' && upPath.error === 'invalid-path' && calls.length === 0)

  calls.length = 0
  const commit = await H('git/patch-text')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'aaa1111bbb2222' })
  ok('commit 模式：argv 是 show --no-color --no-ext-diff --format= --patch -m --first-parent <ref> -- <path>',
    calls.length === 3 && calls[2].command.indexOf("'show' '--no-color' '--no-ext-diff' '--format=' '--patch' '-m' '--first-parent' 'aaa1111bbb2222' '--' 'a.txt'") >= 0)
  ok('commit 模式：先问仓库根（rev-parse --show-toplevel）与提交元数据（show -s --format=%H…），最后才取补丁',
    calls[0].command.indexOf("'rev-parse' '--show-toplevel'") >= 0
    && calls[1].command.indexOf("'show' '-s'") >= 0 && calls[1].command.indexOf('aaa1111bbb2222') >= 0)
  ok('commit 模式：读取上限是 16MB（stdoutMaxBytes=16777216），不是展示截断那档',
    calls[2].stdoutMaxBytes === 16777216)
  ok('答复 ok，text = header + patch，bytes 是全文的 UTF-8 字节数',
    commit.ok === true && commit.text === commit.header + commit.patch
    && commit.bytes === Buffer.byteLength(commit.text, 'utf8'))
  ok('header 有仓库根（git 自己认的根）、提交 hash、作者、日期、提交标题',
    commit.header.indexOf('仓库: /repo/root') >= 0
    && commit.header.indexOf('提交: fullhash1（fullhash1111111aaaaaaaaaaaaaaaaaa）') >= 0
    && commit.header.indexOf('作者: 张三 <zhang@x.example>') >= 0
    && commit.header.indexOf('日期: 2026-11-11T10:00:00+08:00') >= 0
    && commit.header.indexOf('提交标题: 修复崩溃') >= 0)
  ok('提交正文逐行进 header（每行带两格缩进）',
    commit.header.indexOf('提交正文:') >= 0 && commit.header.indexOf('\n  第一行\n  第二行') >= 0)
  ok('补丁完整（FAKE_PATCH 一字不动，没有展示截断的记号）',
    commit.patch === FAKE_PATCH && commit.header.indexOf('此处截断') < 0)

  calls.length = 0
  const renamed = await H('git/patch-text')({ repo: '/r', mode: 'commit', path: 'new.txt', from: 'old.txt', ref: 'aaa1111bbb2222' })
  ok('改名文件：paths = [from, path]（两个 pathspec 都给 git），header 的路径行写 old.txt → new.txt',
    calls[2].command.indexOf("'--' 'old.txt' 'new.txt'") >= 0
    && renamed.header.indexOf('路径: old.txt → new.txt') >= 0)

  calls.length = 0
  const longBody = 'x'.repeat(25000)
  metaAnswer = ['hash2', 'short2', '李四', 'li@x', '2026-11-12T09:00:00+08:00', '大提交', longBody].join('\u001f')
  const big = await H('git/patch-text')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'aaa1111bbb2222' })
  ok('提交正文超 20000 字：截到 20000 并在 header 里注明',
    big.header.indexOf('…（提交正文过长，此处截断）') >= 0
    && big.header.indexOf('x'.repeat(20000)) >= 0 && big.header.indexOf('x'.repeat(20100)) < 0)
  metaAnswer = META_LINE

  calls.length = 0
  /* transport 的截断记号在 stdout 通道对象上（invoke 读 raw.stdout.truncated）。 */
  diffAnswer = () => ({ exitCode: 0, stdout: { text: FAKE_PATCH, truncated: true }, stderr: { text: '' } })
  const tooBig = await H('git/patch-text')({ repo: '/r', mode: 'commit', path: 'a.txt', ref: 'aaa1111bbb2222' })
  ok('transport 截断：整件事不发生（patch-too-large，stderr 说改用更具体的路径），不复制半份补丁',
    tooBig.ok === false && tooBig.error === 'patch-too-large' && String(tooBig.stderr).indexOf('更具体的路径') >= 0
    && calls.length === 3)
  diffAnswer = () => ({ exitCode: 0, stdout: { text: FAKE_PATCH }, stderr: { text: '' } })

  calls.length = 0
  diffAnswer = () => ({ exitCode: 1, stdout: { text: FAKE_PATCH }, stderr: { text: '' } })
  const untracked = await H('git/patch-text')({ repo: '/r', mode: 'untracked', path: 'new.txt' })
  ok('untracked 模式：--no-index 的 exit 1 + 非空 stdout 判成功（argv 带 --no-index 与 /dev/null）',
    untracked.ok === true && untracked.patch === FAKE_PATCH
    && calls[1].command.indexOf("'--no-index'") >= 0 && calls[1].command.indexOf("'--' '/dev/null' 'new.txt'") >= 0)
  ok('untracked 的 header 说「与空文件对比」',
    untracked.header.indexOf('--no-index：未跟踪的新文件，与空文件对比') >= 0)
  diffAnswer = () => ({ exitCode: 0, stdout: { text: FAKE_PATCH }, stderr: { text: '' } })

  calls.length = 0
  diffAnswer = () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
  const empty = await H('git/patch-text')({ repo: '/r', mode: 'worktree', path: 'a.txt' })
  ok('空补丁不算失败：empty=true，header 的 scope 说明「git 没有输出任何差异」',
    empty.ok === true && empty.empty === true && empty.patch === ''
    && empty.header.indexOf('git 没有输出任何差异') >= 0 && empty.text === empty.header)
  diffAnswer = () => ({ exitCode: 0, stdout: { text: 'Binary files a/x.bin and b/x.bin differ\n' }, stderr: { text: '' } })
  const binary = await H('git/patch-text')({ repo: '/r', mode: 'commit', path: 'x.bin', ref: 'aaa1111bbb2222' })
  ok('二进制不算失败：binary=true、无补丁正文，header 的 scope 说明「只有说明头」',
    binary.ok === true && binary.binary === true && binary.patch === ''
    && binary.header.indexOf('二进制文件') >= 0 && binary.header.indexOf('只有说明头') >= 0)
  diffAnswer = () => ({ exitCode: 0, stdout: { text: FAKE_PATCH }, stderr: { text: '' } })

  calls.length = 0
  const range = await H('git/patch-text')({ repo: '/r', mode: 'range', path: 'a.txt', ref: 'bbb22223333..ccc33334444' })
  ok('range 模式：argv 是 diff <base> <head> -- <path>；元数据问的是 head 那一条',
    calls.length === 3 && calls[2].command.indexOf("'diff' '--no-color' '--no-ext-diff' 'bbb22223333..ccc33334444' '--' 'a.txt'") >= 0
    && calls[1].command.indexOf('ccc33334444') >= 0)
  ok('range 的 header 说明「合计」并给出选区最新提交，防止把整段当成一条提交',
    range.header.indexOf('合计改动') >= 0 && range.header.indexOf('选区最新提交: fullhash1') >= 0)

  topLevelOk = false
  calls.length = 0
  const noRoot = await H('git/patch-text')({ repo: '/fallback/repo', mode: 'commit', path: 'a.txt', ref: 'aaa1111bbb2222' })
  ok('仓库根问不出来：头部退回请求里的仓库路径，补丁照常完整（加餐不拦正事）',
    noRoot.ok === true && noRoot.header.indexOf('仓库: /fallback/repo') >= 0 && noRoot.patch === FAKE_PATCH)
  topLevelOk = true
}

/* 真实 git：header 的字与补丁的完整性在真仓库上再走一遍（gp59 的真仓库模式）。 */
const hasGit = await new Promise((res) => {
  const c = spawn('sh', ['-c', 'command -v git >/dev/null 2>&1 && echo yes || echo no'])
  let out = ''
  c.stdout.on('data', (b) => { out += b })
  c.on('close', () => res(out.trim() === 'yes'))
})
const R = '/tmp/gp86-repo'
const sh = (cmd, cwd) => new Promise((res) => {
  const c = spawn('sh', ['-c', cmd], { cwd })
  let o = '', e = ''
  c.stdout.on('data', (b) => { o += b })
  c.stderr.on('data', (b) => { e += b })
  c.on('error', (er) => res({ code: null, out: o, err: String(er.message) }))
  c.on('close', (x) => res({ code: x, out: o, err: e }))
})

if (hasGit !== true) {
  console.log('  （这台机器没有 git，git/patch-text 的真仓库一段跳过）')
} else {
  console.log('')
  console.log('=== Host：git/patch-text（真仓库：header 字句与补丁完整性）===')
  const lines = []
  for (let i = 1; i <= 7000; i += 1) lines.push('L' + String(i))
  fs.rmSync(R, { recursive: true, force: true })
  fs.rmSync('/tmp/gp86-home', { recursive: true, force: true })
  await sh(`mkdir -p ${R} && cd ${R} && git init -q -b main && git config user.email t@t && git config user.name Tester`
    + ` && printf 'a\\n' > a.txt && printf 'b\\n' > b.txt && git add -A && git commit -qm base`, '/tmp')
  const hash1 = (await sh('git rev-parse HEAD', R)).out.trim()
  await sh(`printf '%s\\n' ${lines.join(' ')} > a.txt && git add -A && git commit -qm tweak`, R)
  const hash2 = (await sh('git rev-parse HEAD', R)).out.trim()

  const calls = []
  const run = (spec) => new Promise((res) => {
    if (isConfigProbe(spec)) {
      return res({ exitCode: 0, stdout: { text: probeAnswer(spec) }, stderr: { text: '' } })
    }
    calls.push(spec)
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: Object.assign({}, process.env, { DSH_HOME: '/tmp/gp86-home' }) })
    let o = '', e = ''
    c.stdout.on('data', (b) => { o += b })
    c.stderr.on('data', (b) => { e += b })
    c.on('error', (er) => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', (x) => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
  const H = makeHost(run)

  const commit = await H('git/patch-text')({ repo: R, mode: 'commit', path: 'a.txt', ref: hash2 })
  const head = commit.ok === true ? commit.header : String(JSON.stringify(commit).slice(0, 400))
  ok('commit 模式（真仓库）：ok，header 有仓库根 / 提交 hash / 作者 / 日期 / 提交标题',
    commit.ok === true && head.indexOf('仓库: ' + R) >= 0 && head.indexOf('提交: ') >= 0
    && head.indexOf(hash2) >= 0 && head.indexOf('作者: Tester <t@t>') >= 0
    && head.indexOf('日期: ') >= 0 && head.indexOf('提交标题: tweak') >= 0)
  ok('commit 模式（真仓库）：补丁完整——7000 行改动全须全尾，不受展示截断（DIFF_LINES_MAX=6000）影响',
    commit.patch.split('\n').length > 6000
    && commit.patch.indexOf('+L1\n') >= 0 && commit.patch.indexOf('+L7000') >= 0
    && commit.text === commit.header + commit.patch)
  const direct = await sh(`git show --no-color --no-ext-diff --format= --patch -m --first-parent ${hash2} -- a.txt`, R)
  ok('commit 模式（真仓库）：patch 与 git show 的原文逐字节一致', commit.patch === direct.out)

  calls.length = 0
  const empty = await H('git/patch-text')({ repo: R, mode: 'worktree', path: 'b.txt' })
  ok('worktree 模式（真仓库）：干净路径答复 ok，empty=true，header 说没有差异',
    empty.ok === true && empty.empty === true && empty.header.indexOf('git 没有输出任何差异') >= 0)

  await sh(`printf 'b2\\n' > b.txt && git add b.txt`, R)
  calls.length = 0
  const staged = await H('git/patch-text')({ repo: R, mode: 'staged', path: 'b.txt' })
  ok('staged 模式（真仓库）：--cached 取到已暂存的改动，header 说明「相对 HEAD」',
    staged.ok === true && staged.patch.indexOf('+b2') >= 0
    && calls[1].command.indexOf("'--cached'") >= 0
    && staged.header.indexOf('git diff --cached：已暂存的改动，相对 HEAD') >= 0)

  await sh(`git commit -qm stage-b`, R)
  await sh(`printf 'R1\\nR2\\nR3\\n' >> a.txt && git add -A && git commit -qm tweak2`, R)
  const hash3 = (await sh('git rev-parse HEAD', R)).out.trim()
  calls.length = 0
  const range = await H('git/patch-text')({ repo: R, mode: 'range', path: 'a.txt', ref: hash1 + '..' + hash3 })
  ok('range 模式（真仓库）：ok，补丁是 base..head 的合计（7000 行与追加的 R1..R3 都在），header 标题是 head 的',
    range.ok === true && range.patch.indexOf('+R3') >= 0 && range.patch.indexOf('+L7000') >= 0
    && range.header.indexOf('提交标题: tweak2') >= 0)

  await sh(`printf 'n\\n' > new.txt`, R)
  calls.length = 0
  const untracked = await H('git/patch-text')({ repo: R, mode: 'untracked', path: 'new.txt' })
  ok('untracked 模式（真仓库）：--no-index 以 exit 1 出补丁照样 ok，patch 就是与空文件的差异',
    untracked.ok === true && untracked.patch.indexOf('+n') >= 0
    && calls[1].command.indexOf("'--no-index'") >= 0)

  /* printf 用八进制转义（\000）：套件的 sh 是 POSIX shell，不认 \xHH。 */
  await sh(`printf 'bin\\000data\\000\\001\\002' > bin.dat && git add -A && git commit -qm bin`, R)
  const binary = await H('git/patch-text')({ repo: R, mode: 'commit', path: 'bin.dat', ref: (await sh('git rev-parse HEAD', R)).out.trim() })
  ok('二进制（真仓库）：binary=true，header 的 scope 说明在（git 没有文本补丁）',
    binary.ok === true && binary.binary === true && binary.patch === ''
    && binary.header.indexOf('二进制文件') >= 0)

  /* 收尾也交给开头的 exit 处理器（临时件与真仓库夹具一起删）。 */
}

console.log('')
if (failed > 0) {
  console.error('gp86-copypatch: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
console.log('gp86-copypatch: all checks passed')
