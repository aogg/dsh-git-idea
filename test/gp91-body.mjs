/* ── gp91：变更页的勾选=选中（账本），与把勾选变成索引改动的四个显式入口 ──
 *
 * 勾选add 那次改造的主语义，客户端这一半在这里集中钉一遍：
 *   1. 行勾选零 rpc：文件行、未跟踪目录行，点框只写 80-panel 的勾选账本
 *      （checked：按仓库分格、键=路径），git/stage 与确认读一条都不发；
 *   2. 组头框＝全选/全不选这一组（零 rpc），组里有勾有不勾画 ▣；
 *   3. @tracked 工具条的「添加」对勾选项发一条 git/stage（paths=勾选路径）；
 *   4. @new 工具条只有「添加」、@conflict 工具条只有「标记已解决」，都只对勾选项
 *      动手（git/stage，路径=勾选的那几条）；
 *   5. 提交按钮三档：有勾选未暂存 → git/commit 带 paths、不带 stageAll（也不发
 *      独立 stage）；没勾但索引有货 → 裸 commit；没勾索引也空 → stageAll 兜底；
 *   6. 提交成功清空生效仓库的勾选，失败不清（重试还得靠原来那批勾）；
 *   7. 多仓库：勾选账按仓库分格，勾 alpha 不动 beta。
 *
 * mock 与 gp45 同一形状：git/panel 按变量 reply / repoReplies 应答（记录进 calls），
 * stage/commit 记录后照常 ok。勾选/提交的落点全部按 calls 里的 method+args 断言。
 * 提交的几个场景各从一次干净重挂开始：勾选账是面板层 state，重挂即空账，正好是
 * 「没勾」那些档位要的前提。 */

let reply = {
  ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0,
  sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [],
}
const withWork = function (staged, unstaged, untracked, unmerged) {
  return Object.assign({}, reply, { staged: staged, unstaged: unstaged, untracked: untracked, unmerged: unmerged || [] })
}
const repoStatus = (repo, extra) => Object.assign({
  ok: true, repo: repo, branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0,
  sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [],
}, extra)
let reposReply = null
let repoReplies = null
const realCall = host.call
const stageCalls = []
const commitCalls = []
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    if (repoReplies != null && args != null && repoReplies[args.repo] !== undefined) {
      return Promise.resolve(repoReplies[args.repo])
    }
    return Promise.resolve(reply)
  }
  if (method === 'git/repos') return Promise.resolve(reposReply)
  if (method === 'git/stage') {
    calls.push({ method: method, args: args })
    stageCalls.push(args)
    return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
  }
  if (method === 'git/commit') {
    calls.push({ method: method, args: args })
    commitCalls.push(args)
    return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
  }
  return realCall(method, args)
}

const clickText = async function (tree, label) {
  const hit = buttons(tree).find((b) => textOf(b).indexOf(label) >= 0)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
}
/* 点行框（第一个孩子那只 dsh-git-cbox）：勾选=选中，落点在账本。 */
const tickRow = async function (t, path) {
  const row = byClass(t, 'dsh-git-trow').find((r) => textOf(r).indexOf(path) >= 0)
  const box = row === undefined ? undefined : byClass(row, 'dsh-git-cbox')[0]
  if (box === undefined) throw new Error('勾不到「' + path + '」这一行')
  box.props.onClick({ stopPropagation: function () {} })
  await wait(10)
}
const boxOf = function (t, path) {
  const row = byClass(t, 'dsh-git-trow').find((r) => textOf(r).indexOf(path) >= 0)
  return row === undefined ? undefined : byClass(row, 'dsh-git-cbox')[0]
}
const groupBoxOf = function (t, label) {
  const row = byClass(t, 'dsh-git-cgroup').find((r) => textOf(r).indexOf(label) >= 0)
  return row === undefined ? undefined : byClass(row, 'dsh-git-cbox')[0]
}
const toolsOf = (t) => byClass(t, 'dsh-git-ctools')
const callsSince = (mark, method) => calls.slice(mark).filter((c) => c.method === method)
/* 干净重挂：fiber 全清，面板从零开始（勾选账也空）。 */
const remount = async function () {
  fibers.clear()
  const t = await openPanel()
  await clickText(t, '变更')
  return await settle()
}
/* 提交那一段的公共动作：填信息、点主按钮、等落地。 */
const sendCommit = async function (message) {
  const area = collect(tree).filter((n) => n.type === 'textarea')[0]
  if (area !== undefined) area.props.onChange({ target: { value: message } })
  await wait(5)
  tree = await settle()
  const button = byClass(tree, 'dsh-git-primary')[0]
  if (button === undefined) throw new Error('提交按钮不在')
  button.props.onClick()
  await wait(10)
  return await settle()
}

console.log('')
console.log('=== 行勾选零 rpc：文件行与未跟踪目录行 ===')
reply = withWork([], [{ path: 'a.txt', code: ' M' }, { path: 'b.txt', code: ' M' }], [{ path: 'new.txt', code: '??' }, { path: 'newdir/', code: '??' }])
let tree = await remount()
let mark = calls.length
await tickRow(tree, 'a.txt')
tree = await settle()
ok('文件行点框：零 rpc（不发 git/stage，也不发确认读）', calls.length === mark)
ok('框就地亮了（☑），工具条按勾选计数（已勾选 1 项）',
  boxOf(tree, 'a.txt') !== undefined && textOf(boxOf(tree, 'a.txt')) === '☑'
  && toolsOf(tree).some((t) => textOf(t).indexOf('已勾选 1 项') >= 0))
await tickRow(tree, 'newdir/')
tree = await settle()
ok('未跟踪目录行点框：同样零 rpc（整目录的选中记的是目录键）', calls.length === mark)
ok('目录框亮了（☑）', boxOf(tree, 'newdir/') !== undefined && textOf(boxOf(tree, 'newdir/')) === '☑')
ok('「添加」按钮的 title 说着它对谁做事（勾选项）',
  toolsOf(tree).some((t) => buttons(t).some((b) => textOf(b) === '添加' && String(b.props.title).indexOf('git add 勾选的') >= 0)))

console.log('')
console.log('=== 组头框：全选/全不选（零 rpc），▣ 是部分勾 ===')
let trackedGroupBox = groupBoxOf(tree, '默认变更列表')
mark = calls.length
trackedGroupBox.props.onClick({ stopPropagation: function () {} })
await wait(10)
tree = await settle()
ok('组头点一下：整组全选（a.txt、b.txt 都亮），一条 rpc 都没发',
  calls.length === mark
  && boxOf(tree, 'a.txt') !== undefined && textOf(boxOf(tree, 'a.txt')) === '☑'
  && boxOf(tree, 'b.txt') !== undefined && textOf(boxOf(tree, 'b.txt')) === '☑'
  && groupBoxOf(tree, '默认变更列表') !== undefined && textOf(groupBoxOf(tree, '默认变更列表')) === '☑')
trackedGroupBox = groupBoxOf(tree, '默认变更列表')
trackedGroupBox.props.onClick({ stopPropagation: function () {} })
await wait(10)
tree = await settle()
ok('再点一下：整组全不选，还是零 rpc',
  calls.length === mark
  && textOf(boxOf(tree, 'a.txt')) === '☐' && textOf(boxOf(tree, 'b.txt')) === '☐'
  && textOf(groupBoxOf(tree, '默认变更列表')) === '☐')
await tickRow(tree, 'a.txt')
tree = await settle()
ok('只勾组里一条：组头是半选 ▣（▣=部分勾）',
  groupBoxOf(tree, '默认变更列表') !== undefined && textOf(groupBoxOf(tree, '默认变更列表')) === '▣')

console.log('')
console.log('=== @tracked 的「添加」：对勾选项发一条 git/stage ===')
await tickRow(tree, 'b.txt')
tree = await settle()
let bars = toolsOf(tree)
mark = calls.length
await clickText(bars[0], '添加')
tree = await settle()
let one = callsSince(mark, 'git/stage')
ok('发出一条 git/stage，路径就是勾选的那两条（组内按路径排序）',
  one.length === 1 && JSON.stringify(one[0].args.paths) === '["a.txt","b.txt"]'
  && (one[0].args.repo === undefined || one[0].args.repo === '/tmp/ws'))

console.log('')
console.log('=== @new 的「添加」：只有这一个按钮，对象是勾选的新文件 ===')
reply = withWork([], [{ path: 'a.txt', code: ' M' }], [{ path: 'new.txt', code: '??' }])
await clickText(tree, '⟳')
tree = await settle()
/* @new 那排工具条在 bars[1]（组顺序 @tracked → @new）；先勾再取工具条 ——
   按钮的可用与落点是渲染那一刻的账本，旧节点算的是旧账。 */
await tickRow(tree, 'new.txt')
tree = await settle()
bars = toolsOf(tree)
ok('@new 工具条只有「添加」一个按钮',
  bars.length === 2 && buttons(bars[1]).length === 1 && textOf(buttons(bars[1])[0]) === '添加')
mark = calls.length
await clickText(bars[1], '添加')
tree = await settle()
one = callsSince(mark, 'git/stage')
ok('点 @new 的「添加」：git/stage 落在勾选的新文件上',
  one.length === 1 && JSON.stringify(one[0].args.paths) === '["new.txt"]')

console.log('')
console.log('=== @conflict 的「标记已解决」：只有这一个按钮，对象是勾选的冲突 ===')
reply = withWork([], [{ path: 'a.txt', code: ' M' }], [{ path: 'new.txt', code: '??' }], [{ path: 'u.txt', code: 'UU' }])
await clickText(tree, '⟳')
tree = await settle()
/* 冲突组置顶：它的工具条是 bars[0]。 */
bars = toolsOf(tree)
ok('冲突组的工具条只有「标记已解决」一个按钮',
  bars.length === 3 && buttons(bars[0]).length === 1 && textOf(buttons(bars[0])[0]) === '标记已解决')
ok('一个都没勾时它禁用，计数行说「已勾选 0 项」',
  buttons(bars[0])[0].props.disabled === true && textOf(bars[0]).indexOf('已勾选 0 项') >= 0)
await tickRow(tree, 'u.txt')
tree = await settle()
mark = calls.length
await clickText(toolsOf(tree)[0], '标记已解决')
tree = await settle()
one = callsSince(mark, 'git/stage')
ok('点「标记已解决」：git/stage 落在勾选的冲突路径上',
  one.length === 1 && JSON.stringify(one[0].args.paths) === '["u.txt"]')

console.log('')
console.log('=== 提交按钮：勾选 → git/commit 带 paths，不带 stageAll ===')
reply = withWork([], [{ path: 'a.txt', code: ' M' }, { path: 'b.txt', code: ' M' }], [])
tree = await remount()
await tickRow(tree, 'a.txt')
tree = await settle()
ok('有勾选时按钮的话术带着勾选数（提交 勾选N 项）', textOf(byClass(tree, 'dsh-git-primary')[0]) === '提交 勾选1 项')
stageCalls.length = 0
commitCalls.length = 0
mark = calls.length
tree = await sendCommit('勾选的那条一起提交')
ok('发的是 git/commit，paths=勾选未暂存路径，不带 stageAll',
  commitCalls.length === 1 && commitCalls[0].message === '勾选的那条一起提交'
  && JSON.stringify(commitCalls[0].paths) === '["a.txt"]' && commitCalls[0].stageAll === undefined)
ok('没有先发独立的 git/stage（add 由 commit 捎带，不发第二条 rpc）',
  callsSince(mark, 'git/stage').length === 0 && stageCalls.length === 0)
ok('提交成功清空生效仓库的勾选：计数回 0，按钮话术回到索引现状',
  toolsOf(tree).every((t) => textOf(t).indexOf('已勾选 0 项') >= 0)
  && textOf(byClass(tree, 'dsh-git-primary')[0]).indexOf('提交 勾选') < 0)

console.log('')
console.log('=== 提交失败不清勾选（重试还得靠原来那批勾） ===')
const realCommitFallback = host.call
host.call = function (method, args) {
  if (method === 'git/commit') {
    calls.push({ method: method, args: args })
    return Promise.resolve({ ok: false, repo: '/tmp/ws', exitCode: 1, stdout: '', stderr: 'fatal: 别的什么地方坏了' })
  }
  return realCommitFallback(method, args)
}
await tickRow(tree, 'a.txt')
tree = await settle()
await tickRow(tree, 'b.txt')
tree = await settle()
tree = await sendCommit('这次会被拒')
ok('答复 no：勾选原样留着（已勾选 2 项还在）',
  toolsOf(tree).some((t) => textOf(t).indexOf('已勾选 2 项') >= 0)
  && boxOf(tree, 'a.txt') !== undefined && textOf(boxOf(tree, 'a.txt')) === '☑')
host.call = realCommitFallback

console.log('')
console.log('=== 提交按钮：没勾、索引有货 → 裸 commit（不带 paths 也不带 stageAll） ===')
reply = withWork([{ path: 's.txt', code: 'M ' }], [{ path: 'a.txt', code: ' M' }], [])
tree = await remount()
commitCalls.length = 0
ok('没勾时按钮话术是「提交 N 个文件」（不再有「全部暂存并提交」）',
  textOf(byClass(tree, 'dsh-git-primary')[0]).indexOf('提交 1 个文件') === 0)
tree = await sendCommit('只提交索引里已有的')
ok('没勾时请求不带 paths（stagedCount>0 也不带 stageAll）：裸提交索引',
  commitCalls.length === 1 && commitCalls[0].paths === undefined && commitCalls[0].stageAll === undefined)

console.log('')
console.log('=== 提交按钮：没勾、索引也空 → stageAll 兜底 ===')
reply = withWork([], [{ path: 'a.txt', code: ' M' }], [])
tree = await remount()
commitCalls.length = 0
ok('按钮话术是「全部暂存并提交」', textOf(byClass(tree, 'dsh-git-primary')[0]).indexOf('全部暂存并提交') === 0)
tree = await sendCommit('一个都没勾：全提交')
ok('兜底走 stageAll:true，不带 paths',
  commitCalls.length === 1 && commitCalls[0].stageAll === true && commitCalls[0].paths === undefined)

console.log('')
console.log('=== 多仓库：勾选账按仓库分格 ===')
reply = repoStatus('/tmp/ws')
reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws/alpha', '/tmp/ws/beta'], manual: [], missing: [] }
repoReplies = {
  '/tmp/ws/alpha': repoStatus('/tmp/ws/alpha', { unstaged: [{ path: 'alpha-one.txt', code: ' M' }] }),
  '/tmp/ws/beta': repoStatus('/tmp/ws/beta', { unstaged: [{ path: 'beta-one.txt', code: ' M' }] }),
}
const pop2 = async () => renderUntilStable(makeElement(popover, { sessionId: 's-2' }), 'pop2')
let multi = await pop2()
await wait(20)
multi = await pop2()
await clickText(multi, '变更')
multi = await pop2()
const pickRow = (t, path) => byClass(t, 'dsh-git-repo-row').find((r) => String(r.props.key) === 'repo:' + path)
pickRow(multi, '/tmp/ws/alpha').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
pickRow(multi, '/tmp/ws/beta').props.onClick({ ctrlKey: true })
await wait(10)
multi = await pop2()
await wait(30)
multi = await pop2()
await tickRow(multi, 'alpha-one.txt')
multi = await pop2()
await tickRow(multi, 'beta-one.txt')
multi = await pop2()
let multiBars = toolsOf(multi)
ok('两个仓库各勾各的：alpha 1 项、beta 1 项（互不吞并）',
  multiBars.length === 2 && textOf(multiBars[0]).indexOf('已勾选 1 项') >= 0
  && textOf(multiBars[1]).indexOf('已勾选 1 项') >= 0)
mark = calls.length
await clickText(multiBars[0], '添加')
multi = await pop2()
one = callsSince(mark, 'git/stage')
ok('alpha 组的「添加」落在 alpha 仓库上，路径只带 alpha 的勾选',
  one.length === 1 && one[0].args.repo === '/tmp/ws/alpha'
  && JSON.stringify(one[0].args.paths) === '["alpha-one.txt"]')
mark = calls.length
await clickText(toolsOf(multi)[1], '添加')
multi = await pop2()
one = callsSince(mark, 'git/stage')
ok('beta 组的「添加」落在 beta 仓库上',
  one.length === 1 && one[0].args.repo === '/tmp/ws/beta'
  && JSON.stringify(one[0].args.paths) === '["beta-one.txt"]')
