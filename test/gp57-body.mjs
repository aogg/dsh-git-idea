/* ═══ gp57：历史页工作树块（客户端这一半）═══
 *
 * 盯五片：
 *   1. 挂载与读数：面板打开就发一条 git/worktrees（80-panel.js 那条跟
 *      [appliedRepo, repoOk, freshAt, props.ready] 的 effect），单仓库请求不带
 *      repo（base(appliedRepo) 的老口径）；标题行「工作树 N」，N = 记录数 ——
 *      detached / bare 的记录也计数（它们是真实存在的工作树，只是不可选）；
 *   2. 行模型：目录短名（tname）+ 它站着的分支（tsub）两段式；↑↓ 徽章从面板
 *      已读的 refs 按分支名免费查，查不到就不画（不为徽章多发一次读数）；
 *      分支 == activeRef 的行首亮 ●——与分支树 scope 高亮同一个值；
 *   3. 灰行语义：detached / bare / prunable 都压暗，其中 detached 与 bare 没有
 *      分支可选、onClick 干脆不挂；prunable 仍可点（单击只是过滤历史，目录丢了
 *      不影响这件事）；locked 不灰、行尾 🔒、tooltip 带原因；tooltip 三件事
 *      （完整路径 / 归属仓库 / 只读点击语义）一条不少；
 *   4. 折叠与退化：标题行是折叠开关，折叠后标题行仍记当前选中项；data==null
 *      一行「正在读取工作树…」；ok:false 与运输层失败都退化成灰说明行、不抛错
 *      （工作树是辅助信息，不上错误横幅）；
 *   5. 点击语义与跟随：单仓库单击行 = onPickBranch('', branch) —— 只 setActiveRef，
 *      git/graph 的 ref 跟上、请求不带 repo，也不为它重发工作树读数；多选分组里
 *      repo 传生效仓库（logSel.length > 0 ? effectiveRepo : ''）—— 单击即收拢回
 *      单仓库并按该分支过滤；切生效仓库（单击仓库行）后 git/worktrees 重发且
 *      请求参数跟着换，块的数据整份换新。侧栏位置：仓库块正下方、分支树行之前。 */

/* ── mock：工作树罐头按请求里的 repo 给（答的是谁要看得出），refs 自带 ahead/behind ── */
const WS_WORKTREES = {
  ok: true, repo: '/tmp/ws',
  worktrees: [
    { path: '/tmp/ws', head: 'aaa', branch: 'main', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/feature one', head: 'bbb', branch: 'feature/one', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/detached one', head: 'ccc', branch: '', detached: true, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/bare main', head: '', branch: '', detached: false, bare: true, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/pruned one', head: 'ddd', branch: 'solo', detached: false, bare: false, locked: false, lockReason: '', prunable: true, pruneReason: 'gitdir 文件指向不存在的地方' },
    { path: '/tmp/lab/locked one', head: 'eee', branch: 'stable', detached: false, bare: false, locked: true, lockReason: '变更多，暂不动', prunable: false, pruneReason: '' },
  ],
}
const ALPHA_WORKTREES = {
  ok: true, repo: '/tmp/ws/alpha',
  worktrees: [
    { path: '/tmp/ws/alpha', head: 'aaa', branch: 'main', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/ws/alpha-wt x', head: 'hhh', branch: 'solo', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
  ],
}
let wtReply = null /* 设了就原样答（ok:false 等固定答复用） */
let hangWorktrees = false
let failWorktrees = false
const reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws/alpha', '/tmp/ws/beta'], manual: [], missing: [], truncated: false }
const refsReply = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [
    { segments: ['main'], data: 'main', upstream: 'origin/main', ahead: 2, behind: 1, at: 0 },
    { segments: ['solo'], data: 'solo', upstream: '', ahead: 0, behind: 0, at: 0 },
  ],
  remote: [],
}
const wtCalls = []
const realCall57 = host.call
host.call = function (method, args) {
  if (method === 'git/worktrees') {
    calls.push({ method: method, args: args })
    wtCalls.push(args)
    if (hangWorktrees === true) return new Promise(function () {})
    if (failWorktrees === true) return Promise.reject(new Error('bridge down'))
    if (wtReply !== null) return Promise.resolve(wtReply)
    return Promise.resolve(args != null && args.repo === '/tmp/ws/alpha' ? ALPHA_WORKTREES : WS_WORKTREES)
  }
  if (method === 'git/repos') { calls.push({ method: method, args: args }); return Promise.resolve(reposReply) }
  if (method === 'git/refs') { calls.push({ method: method, args: args }); return Promise.resolve(refsReply) }
  return realCall57(method, args)
}

/* ── 取景工具 ── */
const hasClass57 = (n, s) => n.props != null && typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(s) >= 0
const wtBox57 = (t) => byClass(t, 'dsh-git-wt-box')[0]
const wtRows57 = (t) => byClass(wtBox57(t) || t, 'dsh-git-wt-row')
const wtRowOf57 = (t, path) => wtRows57(t).find((r) => String(r.props.key) === 'wt:' + path)
const wtHead57 = (t) => byClass(t, 'dsh-git-wt-head')[0]
const markOf57 = (row) => { const m = byClass(row, 'dsh-git-repo-mark')[0]; return m === undefined ? null : textOf(m) }
const badgesOf57 = (row) => byClass(row, 'dsh-git-ab').map(textOf)
const subOf57 = (row) => { const s = byClass(row, 'dsh-git-tsub')[0]; return s === undefined ? '' : textOf(s) }
const nameOf57 = (row) => { const s = byClass(row, 'dsh-git-tname')[0]; return s === undefined ? '' : textOf(s) }
const marksOf57 = (row) => byClass(row, 'dsh-git-wt-mark').map(textOf)
const callsOf57 = (mark, method) => calls.slice(mark).filter((c) => c.method === method)
const lastCall57 = (mark, method) => { const list = callsOf57(mark, method); return list.length > 0 ? list[list.length - 1].args : undefined }
const repoRow57 = (t, path) => byClass(t, 'dsh-git-repo-row').find((r) => String(r.props.key) === 'repo:' + path)
/* 换场景 = 清掉 fiber 再换会话挂：hooks（worktrees 读数、activeRef）跟着归零，
   生效仓库的盘账按会话分格、新会话自然是空（openConfig 的同一条老规矩）。 */
const pop57 = (sid) => renderUntilStable(makeElement(popover, { sessionId: sid }), sid)
async function settle57(sid) { let t = null; for (let i = 0; i < 4; i += 1) { t = await pop57(sid); await wait(10) } return t }

/* 面板得先「开」一次：everOpened 是模块级的，此后直接挂 popover 就是就绪态。 */
fibers.clear()
let chipT = await renderUntilStable(makeElement(chip, { sessionId: 's-57a' }), 'chip-57a')
if (chipT.props.className.indexOf('dsh-git-chip-open') < 0) { chipT.props.onClick(); await wait(10) }
let tree = await settle57('s-57a')

console.log('')
console.log('== 挂载与读数：一条 git/worktrees、标题行「工作树 N」、● 只亮当前分支 ==')
ok('面板打开就问 git/worktrees，恰好一次；单仓库请求只带会话不带 repo（生效仓库由 Host 解）',
  wtCalls.length === 1 && wtCalls[0].sessionId === 's-57a' && wtCalls[0].repo === undefined)
ok('标题行「工作树 6」：六份记录（含 detached / bare）都计数',
  wtHead57(tree) !== undefined && textOf(wtHead57(tree)).indexOf('工作树 6') >= 0)
ok('六行，没有混进读取中 / 失败的说明行',
  wtRows57(tree).length === 6)
ok('行首 ● 只亮分支 == 当前分支（main）的那一行，其余行的记号位是空的',
  wtRows57(tree).map(markOf57).join('|') === '●|||||')
ok('名字与小字两段式：目录短名 + 它站着的分支（带空格的目录名整段保留）',
  nameOf57(wtRowOf57(tree, '/tmp/ws')) === 'ws' && subOf57(wtRowOf57(tree, '/tmp/ws')) === 'main'
  && nameOf57(wtRowOf57(tree, '/tmp/lab/feature one')) === 'feature one'
  && subOf57(wtRowOf57(tree, '/tmp/lab/feature one')) === 'feature/one')

console.log('')
console.log('== 行模型：↑↓ 徽章免费查 refs、tooltip 三件事 ==')
const wsRow = wtRowOf57(tree, '/tmp/ws')
ok('徽章从面板已读的 refs 按分支名免费查：main ↑2 ↓1（进/出的类各就位）',
  badgesOf57(wsRow).join('') === '↓1↑2'
  && byClass(wsRow, 'dsh-git-ab-in').length === 1 && byClass(wsRow, 'dsh-git-ab-out').length === 1)
ok('refs 查不到的分支不画徽章（feature/one 不在本地账里），不为它多发一次读数',
  badgesOf57(wtRowOf57(tree, '/tmp/lab/feature one')).length === 0 && wtCalls.length === 1)
ok('tooltip 三件事：完整路径、归属仓库、只读点击语义（只改历史视图，不 checkout）',
  String(wsRow.props.title).indexOf('/tmp/ws') === 0
  && String(wsRow.props.title).indexOf('归属仓库：/tmp/ws') >= 0
  && String(wtRowOf57(tree, '/tmp/lab/feature one').props.title).indexOf('单击 = 历史按分支 feature/one 过滤') >= 0
  && String(wtRowOf57(tree, '/tmp/lab/feature one').props.title).indexOf('不 checkout、不切换分支、不动任何工作区') >= 0)
ok('徽章的 tooltip 与分支树同一句：分岔（领先 2 落后 1）+ 上游名',
  String(wsRow.props.title).indexOf('与上游分岔：领先 2，落后 1') >= 0
  && String(wsRow.props.title).indexOf('origin/main') >= 0)

console.log('')
console.log('== 灰行语义：detached/bare 不可点、prunable 灰但可点、locked 🔒 带原因 ==')
const detRow = wtRowOf57(tree, '/tmp/lab/detached one')
const bareRow = wtRowOf57(tree, '/tmp/lab/bare main')
const pruneRow = wtRowOf57(tree, '/tmp/lab/pruned one')
const lockRow = wtRowOf57(tree, '/tmp/lab/locked one')
ok('detached 灰行、小字「游离 HEAD」、没有 onClick（没有分支可选，点了也不该有反应）',
  hasClass57(detRow, 'dsh-git-wt-gone') && subOf57(detRow) === '游离 HEAD' && detRow.props.onClick === undefined)
ok('bare 灰行、小字 bare、同样没有 onClick',
  hasClass57(bareRow, 'dsh-git-wt-gone') && subOf57(bareRow) === 'bare' && bareRow.props.onClick === undefined)
ok('prunable 灰行但仍可点：onClick 在，行尾 ⚠，tooltip 说明目录已丢失且本版没有 prune',
  hasClass57(pruneRow, 'dsh-git-wt-gone') && typeof pruneRow.props.onClick === 'function'
  && marksOf57(pruneRow).join('') === '⚠'
  && String(pruneRow.props.title).indexOf('目录已丢失，可 prune 清理') >= 0
  && String(pruneRow.props.title).indexOf('本版没有 prune 动作') >= 0)
ok('locked 不灰（分支还在、可选），行尾 🔒 且 tooltip 带原因原文',
  hasClass57(lockRow, 'dsh-git-wt-gone') === false && typeof lockRow.props.onClick === 'function'
  && marksOf57(lockRow).join('') === '🔒'
  && String(lockRow.props.title).indexOf('已锁定：变更多，暂不动') >= 0)

console.log('')
console.log('== 折叠：标题行是开关，折叠后仍记当前选中项 ==')
wtHead57(tree).props.onClick()
tree = await settle57('s-57a')
ok('点标题行收起：行全没了，标题行记着当前选中的那棵（● ws）',
  wtRows57(tree).length === 0 && textOf(wtHead57(tree)).indexOf('● ws') >= 0)
wtHead57(tree).props.onClick()
tree = await settle57('s-57a')
ok('再点展开：六行原样回来', wtRows57(tree).length === 6 && wtRowOf57(tree, '/tmp/ws') !== undefined)

console.log('')
console.log('== 退化：正在读取 / ok:false / 运输层失败，都不抛错、都是灰说明行 ==')
fibers.clear()
hangWorktrees = true
tree = await settle57('s-57b')
ok('data==null：标题行「正在读取…」+ 一行灰「正在读取工作树…」',
  textOf(wtHead57(tree)).indexOf('正在读取…') >= 0 && wtRows57(tree).length === 1
  && textOf(wtRows57(tree)[0]).indexOf('正在读取工作树…') >= 0
  && hasClass57(wtRows57(tree)[0], 'dsh-git-wt-gone'))
fibers.clear()
hangWorktrees = false
wtReply = { ok: false, repo: '/tmp/ws', error: 'not-a-repository', worktrees: [] }
tree = await settle57('s-57c')
ok('ok:false：标题行退成「工作树」+「读取失败」，一行灰说明「这里可能不是 git 仓库」',
  textOf(wtHead57(tree)).indexOf('工作树') >= 0 && textOf(wtHead57(tree)).indexOf('读取失败') >= 0
  && textOf(wtHead57(tree)).indexOf('工作树 6') < 0
  && wtRows57(tree).length === 1
  && textOf(wtRows57(tree)[0]).indexOf('无法读取工作树（这里可能不是 git 仓库）') >= 0)
fibers.clear()
wtReply = null
failWorktrees = true
tree = await settle57('s-57d')
ok('运输层失败走 catch 的占位：同样的灰说明行，面板照常画（分支树还在），不抛错',
  wtRows57(tree).length === 1
  && textOf(wtRows57(tree)[0]).indexOf('无法读取工作树（这里可能不是 git 仓库）') >= 0
  && byClass(tree, 'dsh-git-trow').length > 0)
failWorktrees = false

console.log('')
console.log('== 点击语义（单仓库）：onPickBranch(\'\', branch) —— 只过滤历史 ==')
fibers.clear()
tree = await settle57('s-57e')
const markPick = calls.length
wtRowOf57(tree, '/tmp/lab/feature one').props.onClick()
tree = await settle57('s-57e')
ok('单击行：git/graph 的 ref 跟到 feature/one，请求仍不带 repo（pickBranch(\'\') 那支）',
  lastCall57(markPick, 'git/graph') != null
  && lastCall57(markPick, 'git/graph').ref === 'feature/one'
  && lastCall57(markPick, 'git/graph').repo === undefined)
ok('单击只是过滤历史：工作树读数一次都没多发',
  callsOf57(markPick, 'git/worktrees').length === 0)
ok('● 跟着选择走：feature one 行亮、ws 行灭（activeRef 与分支树同一个值）',
  markOf57(wtRowOf57(tree, '/tmp/lab/feature one')) === '●' && markOf57(wtRowOf57(tree, '/tmp/ws')) === '')

console.log('')
console.log('== 点击语义（多选分组）：repo 传生效仓库，单击即收拢回单仓库 ==')
fibers.clear()
tree = await settle57('s-57f')
repoRow57(tree, '/tmp/ws/alpha').props.onClick({ ctrlKey: true })
await wait(10)
tree = await settle57('s-57f')
repoRow57(tree, '/tmp/ws/beta').props.onClick({ ctrlKey: true })
await wait(10)
tree = await settle57('s-57f')
ok('多选分组里工作树块仍在、行仍可点（它跟的是生效仓库，不进分组账）',
  wtBox57(tree) !== undefined && wtRows57(tree).length === 6
  && typeof wtRowOf57(tree, '/tmp/lab/feature one').props.onClick === 'function')
const markGroup = calls.length
wtRowOf57(tree, '/tmp/lab/feature one').props.onClick()
tree = await settle57('s-57f')
ok('单击行：git/graph 带生效仓库 /tmp/ws + ref feature/one（先 applyRepo 再选分支的那支）',
  lastCall57(markGroup, 'git/graph') != null
  && lastCall57(markGroup, 'git/graph').repo === '/tmp/ws'
  && lastCall57(markGroup, 'git/graph').ref === 'feature/one')

console.log('')
console.log('== 跟随生效仓库：切仓库后 git/worktrees 重发，参数与数据整份换 ==')
fibers.clear()
tree = await settle57('s-57g')
const markFollow = wtCalls.length
ok('切换前：行是 ws 罐头里的（feature one 在）', wtRowOf57(tree, '/tmp/lab/feature one') !== undefined)
repoRow57(tree, '/tmp/ws/alpha').props.onClick({})
await wait(10)
tree = await settle57('s-57g')
tree = await settle57('s-57g')
ok('单击 alpha 仓库行后 git/worktrees 恰好重发一次，请求 repo 跟着换成 /tmp/ws/alpha',
  wtCalls.length === markFollow + 1 && wtCalls[wtCalls.length - 1].repo === '/tmp/ws/alpha'
  && wtCalls[wtCalls.length - 1].sessionId === 's-57g')
ok('块的数据整份换新：alpha 罐头的行在（alpha-wt x），ws 罐头的行（feature one）不在了',
  wtRowOf57(tree, '/tmp/ws/alpha-wt x') !== undefined && wtRowOf57(tree, '/tmp/lab/feature one') === undefined
  && wtRows57(tree).length === 2)

console.log('')
console.log('== 侧栏位置：仓库块正下方、分支树行之前 ==')
fibers.clear()
tree = await settle57('s-57h')
const sideKids = (byClass(tree, 'dsh-git-side')[0].props.children || []).map((k) => String((k.props && k.props.className) || ''))
const atRepo = sideKids.findIndex((c) => c.indexOf('dsh-git-repo-box') >= 0)
const atWt = sideKids.findIndex((c) => c.indexOf('dsh-git-wt-box') >= 0)
const atBranch = sideKids.findIndex((c) => c.indexOf('dsh-git-trow') >= 0)
ok('从粗到细一列读完：仓库块 → 工作树块（紧贴其下）→ 分支树行',
  atRepo >= 0 && atWt === atRepo + 1 && atBranch > atWt)
