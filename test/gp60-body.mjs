/* ═══ gp60：变更页左栏的 worktree 块（仓库模式，00dd32e）═══
 *
 * gp57 钉的是历史页那份（不给 onPickWorktree 的分支过滤模式，契约逐行不动）；这里
 * 钉 00dd32e 加的第二种用法：变更页左列 dsh-git-reposide 里挂同一个 WorktreeBox，
 * 但给了 onPickWorktree —— 行点击不再是过滤历史，而是 80-panel.js 的
 * repoSingle('changes', path)，把生效仓库切到那个工作区目录。盯四片：
 *   1. 挂块：变更页左列、仓库块之后出现 dsh-git-wt-box；数据就是面板级那条
 *      git/worktrees（80-panel 的 worktreeProps），切页签不为它多发一次读数；
 *      worktreeProps 缺席就不挂（守卫的 false 路：对 client.js 另求值一份独立
 *      实例，在 createElement 处把 worktreeProps 从 ChangesPane 头上摘掉 —— gp50
 *      的 typeof 守卫同款手法，整条路还是真代码）；
 *   2. 仓库模式行模型：普通 / detached / locked 行可点；bare / prunable 行的
 *      onClick 干脆不挂（bare 是防御行 —— Host 新口径不发这种行，罐头故意喂一条
 *      钉组件自己的合同）；detached 不再压暗（dim 收窄成 bare || prunable，灰行
 *      配「可点」就自相矛盾）；↑↓ 徽章照旧按分支名从 refs 免费查；
 *   3. 高亮按路径：path === effective 才亮 ●（历史那套「分支 == activeRef」在
 *      这页没了 —— worktreeProps 压根不传 activeRef），行首 ● 与标题行记的
 *      current 都按路径算，now 的 title 也是仓库模式那句新文案；
 *   4. 点击语义 = repoSingle('changes', path)：先收拢这一栏的多选（repo-sel
 *      清零），再切生效仓库 —— git/panel 的 quick 读、git/worktrees、git/refs
 *      的请求都带上新仓库，切换器 cur 行与 wt 行的 ● 跟着路径走；点的就是当前
 *      生效工作区时原地返回，一次读都不发。 */

/* ── mock：worktree 罐头（面板级那条读数，历史页与变更页吃同一份）──
 * 比 gp57 的罐头多一条 bare 防御行：Host 的 git/worktrees 早就不发 bare（gp57
 * 注释同款说明），但组件里 bare 的分支还在 —— 变更页这条合同（bare 行不可点）
 * 只能靠罐头喂出来钉。 */
const WT60 = {
  ok: true, repo: '/tmp/ws',
  worktrees: [
    { path: '/tmp/lab/wt main', head: 'aaa', branch: 'main', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/feature one', head: 'bbb', branch: 'feature/one', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/detached one', head: 'ccc', branch: '', detached: true, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/pruned one', head: 'ddd', branch: 'solo', detached: false, bare: false, locked: false, lockReason: '', prunable: true, pruneReason: 'gitdir 文件指向不存在的地方' },
    { path: '/tmp/lab/locked one', head: 'eee', branch: 'stable', detached: false, bare: false, locked: true, lockReason: '变更多，暂不动', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/bare one', head: '', branch: '', detached: false, bare: true, locked: false, lockReason: '', prunable: false, pruneReason: '' },
  ],
}
const REPOS60 = { ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws/alpha', '/tmp/ws/beta'], manual: [], missing: [], truncated: false }
const REFS60 = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [
    { segments: ['main'], data: 'main', upstream: 'origin/main', ahead: 2, behind: 1, at: 0 },
    { segments: ['stable'], data: 'stable', upstream: '', ahead: 0, behind: 0, at: 0 },
  ],
  remote: [],
}
const wtCalls = []
const realCall60 = host.call
host.call = function (method, args) {
  /* 拦下的三条也要进 `calls` 账本（gp57 同款）—— 不 push 的话，「读数跟着生效
     仓库换」那节的对账就是一笔看不见的账（host 收到了、断言看不到）。 */
  if (method === 'git/worktrees') { calls.push({ method: method, args: args }); wtCalls.push(args); return Promise.resolve(WT60) }
  if (method === 'git/repos') { calls.push({ method: method, args: args }); return Promise.resolve(REPOS60) }
  if (method === 'git/refs') { calls.push({ method: method, args: args }); return Promise.resolve(REFS60) }
  return realCall60(method, args)
}

/* ── 取景工具（变更页这一半； wtBox 只在变更页左列，历史页那棵没挂载）── */
const side60 = (t) => byClass(t, 'dsh-git-reposide')[0]
const wtBox60 = (t) => byClass(t, 'dsh-git-wt-box')[0]
const wtRows60 = (t) => byClass(wtBox60(t) || t, 'dsh-git-wt-row')
const wtRowOf60 = (t, path) => wtRows60(t).find((r) => String(r.props.key) === 'wt:' + path)
const wtHead60 = (t) => byClass(t, 'dsh-git-wt-head')[0]
const nowOf60 = (t) => { const n = byClass(wtHead60(t) || t, 'dsh-git-repo-now')[0]; return n === undefined ? null : n }
const markOf60 = (row) => { const m = byClass(row, 'dsh-git-repo-mark')[0]; return m === undefined ? null : textOf(m) }
const badgesOf60 = (row) => byClass(row, 'dsh-git-ab').map(textOf)
const hasGone60 = (row) => String(row.props.className).indexOf('dsh-git-wt-gone') >= 0
const callsSince60 = (mark, method) => calls.slice(mark).filter((c) => c.method === method)
const repoRow60 = (t, path) => byClass(t, 'dsh-git-repo-row').find((r) => String(r.props.key) === 'repo:' + path)
const clickIn60 = async function (tree, label) {
  const hit = buttons(tree).find((b) => textOf(b).indexOf(label) >= 0)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
}
/* 换场景 = 清掉 fiber 再换会话挂：hooks（worktrees 读数、生效仓库）跟着归零。 */
const pop60 = (sid) => renderUntilStable(makeElement(popover, { sessionId: sid }), sid)
async function settle60(sid) { let t = null; for (let i = 0; i < 4; i += 1) { t = await pop60(sid); await wait(10) } return t }

/* 面板得先「开」一次：everOpened 是模块级的，此后直接挂 popover 就是就绪态。 */
fibers.clear()
let chipT = await renderUntilStable(makeElement(chip, { sessionId: 's-60a' }), 'chip-60a')
if (chipT.props.className.indexOf('dsh-git-chip-open') < 0) { chipT.props.onClick(); await wait(10) }
let tree = await settle60('s-60a')
await clickIn60(tree, '变更')
tree = await settle60('s-60a')

console.log('')
console.log('== 挂块：变更页左列、仓库块之后；数据复用面板级那条读数 ==')
const sideKids60 = (side60(tree).props.children || []).map((k) => String((k.props && k.props.className) || ''))
const atRepo60 = sideKids60.findIndex((c) => c.indexOf('dsh-git-repo-box') >= 0)
const atWt60 = sideKids60.findIndex((c) => c.indexOf('dsh-git-wt-box') >= 0)
ok('变更页左列 reposide 里挂着 dsh-git-wt-box，恰好一个',
  side60(tree) !== undefined && byClass(side60(tree), 'dsh-git-wt-box').length === 1)
ok('顺序与历史页同款：仓库块在上、worktree 块紧贴其下',
  atRepo60 >= 0 && atWt60 === atRepo60 + 1)
ok('标题行「worktree 6」：罐头六条都在计数里（含那条防御用的 bare）',
  wtHead60(tree) !== undefined && textOf(wtHead60(tree)).indexOf('worktree 6') >= 0)
ok('数据是面板级那条 git/worktrees：开面板到进变更页，恰好读过一次，切页签没有多发',
  wtCalls.length === 1 && wtCalls[0].sessionId === 's-60a' && wtCalls[0].repo === undefined)
ok('六行都画出来了（没有混进读取中 / 失败的说明行）', wtRows60(tree).length === 6)

console.log('')
console.log('== 仓库模式行模型：可点口径、灰行收窄、徽章照旧 ==')
const pickable60 = ['/tmp/lab/wt main', '/tmp/lab/feature one', '/tmp/lab/detached one', '/tmp/lab/locked one']
const blocked60 = ['/tmp/lab/pruned one', '/tmp/lab/bare one']
ok('普通 / detached / locked 行可点（onClick 在）—— 变更页看工作区改动，与站不站分支无关',
  pickable60.every((p) => typeof wtRowOf60(tree, p).props.onClick === 'function'))
ok('bare / prunable 行不可点：onClick 干脆不挂（点了也不该有反应）',
  blocked60.every((p) => wtRowOf60(tree, p).props.onClick === undefined))
ok('detached 行不灰了（dim 收窄成 bare || prunable），历史模式的灰行口径回不来',
  hasGone60(wtRowOf60(tree, '/tmp/lab/detached one')) === false
  && hasGone60(wtRowOf60(tree, '/tmp/lab/wt main')) === false
  && hasGone60(wtRowOf60(tree, '/tmp/lab/locked one')) === false)
ok('bare / prunable 行仍压暗', hasGone60(wtRowOf60(tree, '/tmp/lab/bare one'))
  && hasGone60(wtRowOf60(tree, '/tmp/lab/pruned one')))
ok('↑↓ 徽章照旧按分支名从面板已读的 refs 免费查：main ↓1↑2，feature/one 查不到不画，也不为此多发读数',
  badgesOf60(wtRowOf60(tree, '/tmp/lab/wt main')).join('') === '↓1↑2'
  && badgesOf60(wtRowOf60(tree, '/tmp/lab/feature one')).length === 0 && wtCalls.length === 1)

console.log('')
console.log('== 仓库模式 tooltip：点击语义换文案，detached 补游离说明 ==')
const tipPlain60 = String(wtRowOf60(tree, '/tmp/lab/feature one').props.title)
ok('可点行的点击语义是仓库模式这句：变更列表切到这个工作区，只切查看的仓库',
  tipPlain60.indexOf('/tmp/lab/feature one') === 0
  && tipPlain60.indexOf('归属仓库：/tmp/ws') >= 0
  && tipPlain60.indexOf('单击 = 变更列表切到这个工作区') >= 0
  && tipPlain60.indexOf('不 checkout、不切分支、不动任何工作区') >= 0)
ok('历史模式的过滤文案在这页不出现（同一段 tooltip 只能有一句点击语义）',
  tipPlain60.indexOf('历史按分支') < 0 && tipPlain60.indexOf('不切换分支') < 0)
const tipDet60 = String(wtRowOf60(tree, '/tmp/lab/detached one').props.title)
ok('detached 行可点，tooltip 里补一句它为什么叫「游离」：不影响切过去看工作区改动',
  tipDet60.indexOf('单击 = 变更列表切到这个工作区') >= 0
  && tipDet60.indexOf('游离 HEAD：这个 worktree 停在具体提交上、不站任何分支；不影响切过去看工作区改动') >= 0)
ok('bare / prunable 的不可点解释保持原文',
  String(wtRowOf60(tree, '/tmp/lab/bare one').props.title).indexOf('bare 仓库：只有版本库没有工作区，不可选分支') >= 0
  && String(wtRowOf60(tree, '/tmp/lab/pruned one').props.title).indexOf('目录已丢失，可 prune 清理') >= 0
  && String(wtRowOf60(tree, '/tmp/lab/locked one').props.title).indexOf('已锁定：变更多，暂不动') >= 0)

console.log('')
console.log('== 高亮按路径：path === effective 才亮 ●，标题行 current 同一口径 ==')
ok('初始生效仓库是会话工作区 /tmp/ws，没有一行路径对得上：全部不亮',
  wtRows60(tree).map(markOf60).join('|') === '|||||')
ok('亮不亮与分支无关：wt main 站的 main 正是当前分支，路径不匹配照样不亮',
  markOf60(wtRowOf60(tree, '/tmp/lab/wt main')) === '' && nowOf60(tree) === null)

console.log('')
console.log('== 点击语义 = repoSingle(\'changes\', path)：收拢多选、切生效仓库、读数跟上 ==')
repoRow60(tree, '/tmp/ws/alpha').props.onClick({ ctrlKey: true })
await wait(10)
tree = await settle60('s-60a')
repoRow60(tree, '/tmp/ws/beta').props.onClick({ ctrlKey: true })
await wait(10)
tree = await settle60('s-60a')
ok('先造两仓多选：变更页有两行选中底色', byClass(tree, 'dsh-git-repo-sel').length === 2)
const markPick60 = calls.length
wtRowOf60(tree, '/tmp/lab/feature one').props.onClick()
tree = await settle60('s-60a')
ok('多选先收拢回单仓库：选中底色清零（repoSingle 的第一件事）',
  byClass(tree, 'dsh-git-repo-sel').length === 0)
ok('生效仓库切到该工作区：git/panel 的 quick 读带 repo /tmp/lab/feature one（loadWork(path) 那支）',
  callsSince60(markPick60, 'git/panel').some((c) => c.args != null && c.args.quick === true && c.args.repo === '/tmp/lab/feature one'))
ok('git/worktrees 恰好重发一次，请求跟着生效仓库换（effect 的 appliedRepo 依赖）',
  callsSince60(markPick60, 'git/worktrees').length === 1
  && callsSince60(markPick60, 'git/worktrees')[0].args.repo === '/tmp/lab/feature one'
  && callsSince60(markPick60, 'git/worktrees')[0].args.sessionId === 's-60a')
ok('git/refs 的请求也带上新仓库（分支账跟着换）',
  callsSince60(markPick60, 'git/refs').some((c) => c.args != null && c.args.repo === '/tmp/lab/feature one'))
ok('● 跟着路径走：feature one 行亮、wt main 行灭',
  markOf60(wtRowOf60(tree, '/tmp/lab/feature one')) === '●' && markOf60(wtRowOf60(tree, '/tmp/lab/wt main')) === '')
ok('切换器的 cur 行同步到新仓库（生效仓库只有一个，两块屏幕说的是同一件事）',
  byClass(tree, 'dsh-git-repo-cur').length === 1 && textOf(byClass(tree, 'dsh-git-repo-cur')[0]) === '●feature one')
ok('标题行也记着它：● feature one，now 的 title 是仓库模式那句新文案',
  textOf(wtHead60(tree)).indexOf('● feature one') >= 0
  && nowOf60(tree).props.title === '/tmp/lab/feature one\n变更列表正看着这个工作区'
  && nowOf60(tree).props.title.indexOf('历史正按这个 worktree 的分支过滤') < 0)

console.log('')
console.log('== 点的就是当前生效工作区：原地返回，无副作用 ==')
const markAgain60 = calls.length
wtRowOf60(tree, '/tmp/lab/feature one').props.onClick()
tree = await settle60('s-60a')
ok('path === appliedRepo：一行读都不发（panel / worktrees / refs 全安静）',
  callsSince60(markAgain60, 'git/panel').length === 0
  && callsSince60(markAgain60, 'git/worktrees').length === 0
  && callsSince60(markAgain60, 'git/refs').length === 0)

console.log('')
console.log('== 折叠：标题行按路径记 current，展开后行原样回来 ==')
wtHead60(tree).props.onClick()
tree = await settle60('s-60a')
ok('收起后行全没了，标题行仍按路径记着生效工作区（● feature one）',
  wtRows60(tree).length === 0 && textOf(wtHead60(tree)).indexOf('● feature one') >= 0
  && nowOf60(tree).props.title === '/tmp/lab/feature one\n变更列表正看着这个工作区')
wtHead60(tree).props.onClick()
tree = await settle60('s-60a')
ok('再点展开：六行原样回来，● 还在 feature one 行上',
  wtRows60(tree).length === 6 && markOf60(wtRowOf60(tree, '/tmp/lab/feature one')) === '●')

console.log('')
console.log('== worktreeProps 缺席（宿主太旧等）：变更页左列不挂块，仓库块照旧 ==')
/* 对 client.js 另求值一份独立实例：在 createElement 处把 worktreeProps 从
   ChangesPane 的 props 里删掉 —— 守卫的 false 路只有这条注入路走得到（真面板
   永远传）。各自 slots / host / label 前缀隔开 fiber 键，主世界不受扰动（gp50
   的 typeof 守卫同款手法）。 */
const CLIENT_SRC60 = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
const registered60b = []
const makeElement60b = function (type, props) {
  const kids = Array.prototype.slice.call(arguments, 2)
  if (typeof type === 'function' && type.name === 'ChangesPane') {
    const less = Object.assign({}, props)
    delete less.worktreeProps
    return makeElement.apply(null, [type, less].concat(kids))
  }
  return makeElement.apply(null, [type, props].concat(kids))
}
const React60b = Object.assign({}, React, { createElement: makeElement60b })
const ctx60b = {
  get(n) {
    if (n === 'slots') return { inject: (k, cb) => cb(), register: (o, c) => { registered60b.push({ options: o, component: c }); return () => {} } }
    if (n === 'timer') return ctx.get('timer')
    return undefined
  },
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const host60b = {
  call(method, args) {
    if (method === 'git/panel') return Promise.resolve(OK_PANEL)
    if (method === 'git/repos') return Promise.resolve(REPOS60)
    if (method === 'git/worktrees') return Promise.resolve(WT60)
    /* 其余读走主世界的共享 mock：泛泛的 ok 答复会让历史页在一棵没人测的树上摔跤。 */
    return realCall60(method, args)
  },
}
new Function('ctx', 'React', 'host', 'styles', 'console', CLIENT_SRC60)(
  ctx60b, React60b, host60b, { insert: () => () => {} }, console).apply(ctx60b)
const chip60b = registered60b.find((r) => r.options.id === 'dsh-git-idea-chip').component
const popover60b = registered60b.find((r) => r.options.id === 'dsh-git-idea-panel').component
async function settle60b() { let t = null; for (let i = 0; i < 4; i += 1) { t = await renderUntilStable(makeElement60b(popover60b, { sessionId: 's-60b' }), 'pop-60b'); await wait(10) } return t }
let chipB = await renderUntilStable(makeElement60b(chip60b, { sessionId: 's-60b' }), 'chip-60b')
if (chipB.props.className.indexOf('dsh-git-chip-open') < 0) { chipB.props.onClick(); await wait(10) }
let treeB = await settle60b()
await clickIn60(treeB, '变更')
treeB = await settle60b()
ok('左列 reposide 还在（repoProps 照传，仓库块不受牵连）',
  side60(treeB) !== undefined && byClass(treeB, 'dsh-git-repo-box').length === 1)
ok('worktreeProps 缺席就不挂：整棵树上一块 dsh-git-wt-box 都没有',
  byClass(treeB, 'dsh-git-wt-box').length === 0)
