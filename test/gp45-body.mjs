/* ── 变更页的组工具条：客户端这一半 ──
 *
 * 勾选=选中（勾选add 那次改造）之后，工具条的对象是**勾选账本**里的条目，不再是
 * 「staged===true」的那些。盯六件事：
 *   1. 无勾选：两个组各一条工具条 —— @tracked 三个按钮（添加 / 还原 / 暂存）、
 *      @new 只有「添加」；全部禁用、title 说「先勾选」、计数行说「已勾选 0 项」；
 *   2. 勾选：点行框只写账本（零 rpc），按钮可用，计数跟着勾选数走；⟳ 刷新后
 *      勾选按路径保留；
 *   3. 添加：对勾选项发 git/stage，路径就是勾的那几项；
 *   4. 还原：两段式 —— 第一次点只换红色「确认还原 n 项」，第二次才发 git/restore；
 *      武装之后勾选数变了，确认态自己退回；
 *   5. 暂存（stash）：单击即发，对象也是勾选项；
 *   6. 多仓库：按钮长在哪个仓库的组里，请求就落在哪个仓库（repo 字段）。 */

let reply = {
  ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0,
  sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [],
}
const withWork = function (staged, unstaged, untracked) {
  return Object.assign({}, reply, { staged: staged, unstaged: unstaged, untracked: untracked })
}
/* 多仓库那一段：每个仓库一份自己的答复（按 args.repo 分发）。 */
let repoReplies = null
let reposReply = null
const realCall = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    if (repoReplies != null && args != null && repoReplies[args.repo] !== undefined) {
      return Promise.resolve(repoReplies[args.repo])
    }
    return Promise.resolve(reply)
  }
  if (method === 'git/repos') return Promise.resolve(reposReply)
  if (method === 'git/restore' || method === 'git/stash' || method === 'git/stage') {
    calls.push({ method: method, args: args })
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
/* 勾选=选中：点行框只写账本，零 rpc（本套件数的就是这套手势）。 */
const tickRow = async function (t, path) {
  const row = byClass(t, 'dsh-git-trow').find((r) => textOf(r).indexOf(path) >= 0)
  const box = row === undefined ? undefined : byClass(row, 'dsh-git-cbox')[0]
  if (box === undefined) throw new Error('勾不到「' + path + '」这一行')
  box.props.onClick({ stopPropagation: function () {} })
  await wait(10)
}
const callsOf = function (mark, method) { return calls.slice(mark).filter((c) => c.method === method) }
const noteText = function (tree) {
  const one = byClass(tree, 'dsh-git-oknote')[0]
  return one === undefined ? '' : textOf(one)
}

console.log('')
console.log('=== 无勾选：两个组各一条工具条，按钮全禁用 ===')
reply = withWork([], [{ path: 'w.txt', code: ' M' }], [{ path: 'new.txt', code: '??' }])
let tree = await openPanel()
await clickText(tree, '变更')
tree = await settle()
let bars = byClass(tree, 'dsh-git-ctools')
ok('两个组各一条工具条（默认变更列表 / 新增的文件，各管各的勾选账）', bars.length === 2)
let barButtons = bars.length === 2 ? buttons(bars[0]) : []
ok('默认变更列表的工具条是三个按钮：添加 / 还原 / 暂存',
  barButtons.length === 3 && textOf(barButtons[0]) === '添加' && textOf(barButtons[1]) === '还原' && textOf(barButtons[2]) === '暂存')
const newBarButtons = bars.length === 2 ? buttons(bars[1]) : []
ok('新增那组的工具条只有「添加」一个按钮',
  newBarButtons.length === 1 && textOf(newBarButtons[0]) === '添加')
ok('一个都没勾时全部禁用（两条工具条都是）',
  bars.length === 2 && barButtons.every((b) => b.props.disabled === true) && newBarButtons.every((b) => b.props.disabled === true))
ok('禁用的原因写在 title 里（先勾选…）',
  barButtons.every((b) => String(b.props.title).indexOf('先勾选') === 0)
  && newBarButtons.every((b) => String(b.props.title).indexOf('先勾选') === 0))
ok('计数行说「已勾选 0 项」（两条各说各的组）',
  bars.length === 2 && textOf(bars[0]).indexOf('已勾选 0 项') >= 0 && textOf(bars[1]).indexOf('已勾选 0 项') >= 0)

console.log('')
console.log('=== 勾了两项：按钮可用，计数跟着走，刷新后勾选还在 ===')
reply = withWork(
  [{ path: 'gone.txt', code: 'M ' }, { path: 'kept.txt', code: 'M ' }],
  [{ path: 'w.txt', code: ' M' }],
  [{ path: 'new.txt', code: '??' }])
await clickText(tree, '⟳')
tree = await settle()
/* 勾选=选中：点两下行框（零 rpc），工具条的对象跟着账本走。 */
const tickMark = calls.length
await tickRow(tree, 'gone.txt')
tree = await settle()
await tickRow(tree, 'kept.txt')
tree = await settle()
ok('点框只是选中：一条 rpc 都没发', calls.length === tickMark)
bars = byClass(tree, 'dsh-git-ctools')
barButtons = bars.length === 2 ? buttons(bars[0]) : []
ok('勾了两项：默认变更列表的三个按钮都可用', barButtons.length === 3 && barButtons.every((b) => b.props.disabled !== true))
ok('计数行说「已勾选 2 项」（按勾选算，不看 staged）', bars.length === 2 && textOf(bars[0]).indexOf('已勾选 2 项') >= 0)
ok('新增那组的计数不受牵连（账按组分格）', bars.length === 2 && textOf(bars[1]).indexOf('已勾选 0 项') >= 0)
ok('还原的 title 带着命令和「再点一次确认」', barButtons.length === 3
  && String(barButtons[1].props.title).indexOf('git restore --source=HEAD --staged --worktree') >= 0
  && String(barButtons[1].props.title).indexOf('确认') >= 0)
await clickText(tree, '⟳')
tree = await settle()
bars = byClass(tree, 'dsh-git-ctools')
ok('⟳ 刷新后勾选还在：账本按路径保留（不再跟着索引走）', bars.length === 2 && textOf(bars[0]).indexOf('已勾选 2 项') >= 0)

console.log('')
console.log('=== 添加：走勾框那同一条 git/stage 路 ===')
let mark = calls.length
await clickText(bars[0], '添加')
tree = await settle()
const stageCalls = callsOf(mark, 'git/stage')
ok('发出一条 git/stage，路径就是勾选的那两项（按路径排序）',
  stageCalls.length === 1 && JSON.stringify(stageCalls[0].args.paths) === '["gone.txt","kept.txt"]')

console.log('')
console.log('=== 还原：第一次点只武装，第二次才动手 ===')
mark = calls.length
await clickText(bars[0], '还原')
ok('第一次点不发 git/restore', callsOf(mark, 'git/restore').length === 0)
tree = await settle()
bars = byClass(tree, 'dsh-git-ctools')
const armedButton = bars.length === 2 ? buttons(bars[0])[1] : undefined
ok('按钮换成了红色「确认还原 2 项」', armedButton !== undefined
  && textOf(armedButton) === '确认还原 2 项'
  && String(armedButton.props.className).indexOf('dsh-git-ctool-danger') >= 0)
mark = calls.length
await clickText(bars[0], '确认还原 2 项')
tree = await settle()
const restoreCalls = callsOf(mark, 'git/restore')
ok('第二次点发 git/restore，路径还是那两项', restoreCalls.length === 1
  && JSON.stringify(restoreCalls[0].args.paths) === '["gone.txt","kept.txt"]')
ok('成功条说了做了什么（回到 HEAD）', noteText(tree).indexOf('已还原 2 项') >= 0 && noteText(tree).indexOf('HEAD') >= 0)

console.log('')
console.log('=== 武装之后勾选变了：确认态自己退回 ===')
reply = withWork([{ path: 'kept.txt', code: 'M ' }], [{ path: 'w.txt', code: ' M' }], [{ path: 'new.txt', code: '??' }])
await clickText(tree, '⟳')
tree = await settle()
bars = byClass(tree, 'dsh-git-ctools')
const backButton = bars.length === 2 ? buttons(bars[0])[1] : undefined
ok('按钮退回普通的「还原」（确认的永远是读者正看着的那一组）',
  backButton !== undefined && textOf(backButton) === '还原'
  && String(backButton.props.className).indexOf('dsh-git-ctool-danger') < 0)

console.log('')
console.log('=== 暂存（stash）：单击即发，成功条说怎么找回 ===')
mark = calls.length
await clickText(bars[0], '暂存')
tree = await settle()
const stashCalls = callsOf(mark, 'git/stash')
ok('发出 git/stash，说明带着个数', stashCalls.length === 1
  && stashCalls[0].args.message === 'dsh-git-idea：暂存 1 个文件'
  && JSON.stringify(stashCalls[0].args.paths) === '["kept.txt"]')
ok('成功条说了用 git stash pop 找回', noteText(tree).indexOf('git stash pop') >= 0)

console.log('')
console.log('=== 多仓库：按钮长在哪个组里，就动哪个仓库 ===')
/* 换一个新会话：仓库扫描按会话只发一次（24-repos.js），s-1 已经问过了。 */
reposReply = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws/alpha', '/tmp/ws/beta'], manual: [], missing: [] }
repoReplies = {
  '/tmp/ws/alpha': {
    ok: true, repo: '/tmp/ws/alpha', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0,
    sequencer: null, staged: [{ path: 'alpha-one.txt', code: 'M ' }], unstaged: [], untracked: [], unmerged: [],
  },
  '/tmp/ws/beta': {
    ok: true, repo: '/tmp/ws/beta', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0,
    sequencer: null, staged: [{ path: 'beta-one.txt', code: 'M ' }, { path: 'beta-two.txt', code: 'M ' }],
    unstaged: [], untracked: [], unmerged: [],
  },
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
bars = byClass(multi, 'dsh-git-ctools')
ok('两个仓库的组各有一排工具条', bars.length === 2)
ok('生效仓库自己（ws）没有第三排', byClass(multi, 'dsh-git-reposide').length === 1)
/* 分组顺序 = 挑选顺序（alpha 先、beta 后），第二排属于 beta。勾选账按仓库分格：
   显式勾 beta 的两行，alpha 的账一动不动。 */
await tickRow(multi, 'beta-one.txt')
multi = await pop2()
await tickRow(multi, 'beta-two.txt')
multi = await pop2()
bars = byClass(multi, 'dsh-git-ctools')
const betaButtons = bars.length === 2 ? buttons(bars[1]) : []
ok('beta 组里勾了两项（alpha 那排还是 0，账不串仓库）',
  bars.length === 2 && textOf(bars[1]).indexOf('已勾选 2 项') >= 0
  && textOf(bars[0]).indexOf('已勾选 0 项') >= 0)
mark = calls.length
await clickText(bars[1], '添加')
multi = await pop2()
const betaStage = callsOf(mark, 'git/stage')
ok('添加落在 repo-b 自己的仓库上（不是生效仓库）', betaStage.length === 1
  && betaStage[0].args.repo === '/tmp/ws/beta'
  && JSON.stringify(betaStage[0].args.paths) === '["beta-one.txt","beta-two.txt"]')
mark = calls.length
await clickText(bars[1], '还原')
multi = await pop2()
await clickText(byClass(multi, 'dsh-git-ctools')[1], '确认还原 2 项')
multi = await pop2()
const betaRestore = callsOf(mark, 'git/restore')
ok('还原同样落在 beta 上', betaRestore.length === 1 && betaRestore[0].args.repo === '/tmp/ws/beta')
