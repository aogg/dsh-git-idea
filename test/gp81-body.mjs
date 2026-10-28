
/* ── 文件行右键链：浏览器原生右键菜单必须被拦掉 ──

   挂点的既定规矩（提交行/分支行/push 按钮都这么做）：右键在自己那一层先
   preventDefault + stopPropagation，再交给面板。文件行这条链以前整条没拦：
   变更页 / 单提交详情树 / diff 右列的行把事件原样递给汇聚点 openFileMenu
   （80-panel.js），它只读坐标 —— 结果自定义菜单弹出来的同时，浏览器原生菜单
   也跟着弹。修复把拦截收口在 openFileMenu 一处（event 判空后拦截）。

   这个套件沿真实面板把三处入口各右键一遍，每处断言三件事：
     1. event.preventDefault 被调用（原生菜单没了 —— 本 bug 的回归断言）；
     2. event.stopPropagation 被调用（同一规矩的另一半）；
     3. 文件菜单真的开了（链路走到了 openFileMenu，不是把右键整个弄哑）。 */

const realCall81 = host.call
const head81 = { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, sequencer: null }
let work81 = { staged: [], unstaged: [], untracked: [], unmerged: [] }
let detailFiles81 = []
const diffCalls81 = []
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    if (args != null && args.quick === true) {
      return Promise.resolve(Object.assign({ partial: true, staged: [], unstaged: [], untracked: [], unmerged: [] }, head81))
    }
    return Promise.resolve(Object.assign({}, head81, work81))
  }
  if (method === 'git/commit-detail') {
    return Promise.resolve({
      ok: true, repo: '/tmp/ws', hash: (args && args.hash) || 'aaa111', subject: 'detail subject', body: '',
      author: 'mays', email: 'mays@example.com', date: '2026-09-16T10:00:00',
      files: detailFiles81, branches: ['main'],
    })
  }
  if (method === 'git/diff') {
    diffCalls81.push(args)
    return Promise.resolve({
      ok: true, mode: args != null ? args.mode : '', path: args != null ? args.path : '',
      text: [
        'diff --git a/src/app.js b/src/app.js',
        'index 1111111..2222222 100644',
        '--- a/src/app.js',
        '+++ b/src/app.js',
        '@@ -3,3 +3,4 @@',
        ' line three',
        '-old line',
        '+new line',
        '+extra',
        ' tail',
      ].join('\n'),
      added: 2, removed: 1, binary: false, truncated: false, empty: false,
    })
  }
  return realCall81(method, args)
}

/* 右键一次：把记了账的事件递给行，重画，返回事件与重画后的树。 */
const rightClick81 = async function (row) {
  if (row === undefined || typeof row.props.onContextMenu !== 'function') {
    throw new Error('这行没有 onContextMenu，链路接错行了')
  }
  const ev = {
    clientX: 88, clientY: 66, prevented: 0, stopped: 0,
    preventDefault() { this.prevented += 1 },
    stopPropagation() { this.stopped += 1 },
  }
  row.props.onContextMenu(ev)
  await wait(10)
  return { ev: ev, tree: await settle() }
}
const menu81 = (tree) => byClass(tree, 'dsh-git-menu')[0]
const trow81 = (tree, label) => byClass(tree, 'dsh-git-trow').find((r) => textOf(r).indexOf(label) >= 0)
const openChanges81 = async function () {
  const tree = await openPanel()
  const tab = buttons(tree).find((b) => textOf(b).indexOf('变更') >= 0)
  if (tab === undefined) throw new Error('变更 tab not found')
  tab.props.onClick()
  await wait(10)
  return await settle()
}

console.log('')
console.log('== 变更页文件行（54-changes rowCtx → makeScope.fileCtx → onFileContextAt → openFileMenu）==')
work81 = { staged: [], unstaged: [{ path: 'src/app.js', code: ' M' }], untracked: [], unmerged: [] }
let tree = await openChanges81()
const appRow = trow81(tree, 'app.js')
ok('变更列表里找得到 src/app.js 这一行', appRow !== undefined)
let hit = await rightClick81(appRow)
ok('右键变更页文件行：event.preventDefault 被调用（原生菜单被拦掉）', hit.ev.prevented === 1)
ok('右键变更页文件行：event.stopPropagation 被调用', hit.ev.stopped === 1)
const menuA = menu81(hit.tree)
ok('文件菜单真的开了（worktree 菜单有「还原所选更改」）',
  menuA !== undefined && textOf(menuA).indexOf('还原所选更改') >= 0)

console.log('')
console.log('== 单提交详情树叶子行（52-detail ctxOf → onFileContext → openFileMenu）==')
fibers.clear()
work81 = { staged: [], unstaged: [], untracked: [], unmerged: [] }
detailFiles81 = [{ status: 'M', path: 'de.txt' }]
tree = await openPanel()
byClass(tree, 'dsh-git-crow')[0].props.onClick()
await wait(10)
tree = await settle()
const deRow = trow81(tree, 'de.txt')
ok('提交详情树里找得到 de.txt 这一行', deRow !== undefined)
hit = await rightClick81(deRow)
ok('右键详情树叶子行：event.preventDefault 被调用', hit.ev.prevented === 1)
ok('右键详情树叶子行：event.stopPropagation 被调用', hit.ev.stopped === 1)
const menuB = menu81(hit.tree)
ok('文件菜单真的开了（commit 菜单有「与本地比较」）',
  menuB !== undefined && textOf(menuB).indexOf('与本地比较') >= 0)

console.log('')
console.log('== diff 右列叶子行（55-diff rowContext → onFileContext → openFileMenu）==')
fibers.clear()
detailFiles81 = []
work81 = { staged: [], unstaged: [{ path: 'src/app.js', code: ' M' }], untracked: [], unmerged: [] }
tree = await openChanges81()
const diffEntry = trow81(tree, 'app.js')
ok('变更页里找得到要点开的文件行', diffEntry !== undefined)
diffEntry.props.onClick()
await wait(10)
tree = await settle()
ok('diff 视图开了（表头写着路径）', byClass(tree, 'dsh-git-diffpath').length === 1)
/* diff 开着之后，屏上带右键挂点的树行（右列 rail）整组都验：每一个都得拦。 */
const railRows = byClass(tree, 'dsh-git-trow').filter((r) => typeof r.props.onContextMenu === 'function')
ok('diff 右列带右键挂点的行不止一棵', railRows.length > 0)
let railOk = true
for (const row of railRows) {
  const one = await rightClick81(row)
  /* 目录行在 44-treerow 层已拦过一次，汇聚点再拦一次 = 两次；叶子行只有汇聚点这一次。
     这里守的是回归点「一次都没有」，所以叶子/目录都只认「至少拦了一次」。 */
  if (one.ev.prevented < 1 || one.ev.stopped < 1) railOk = false
  if (menu81(one.tree) === undefined) railOk = false
}
ok('diff 右列每一行右键：preventDefault + stopPropagation + 菜单开', railOk)
