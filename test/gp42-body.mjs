/* ═══ gp42：一个文件的差异 ═══
   面板能说「哪个文件改了」很久了：变更树、提交下的文件列表都是这样。但两处的行
   都到那里为止 —— 没有一次读取返回过 patch，所以一个文件可以被报告成「改了」，却
   永远看不到「改成什么样」。这个套件盯的就是补上的那一块：

   1. 两个列表里的文件行点开就是差异；返回键回到列表
   2. 一个文件同时有已暂存和未暂存两段时，两次读取分别落在两个小节里
   3. 行号来自 @@ 的计数，删除行只出现在旧文件一侧
   4. 未跟踪的二进制文件不当作文本显示；只有一次读取
   5. 提交下的文件读的是那次提交（重命名的旧路径一起带上）
   6. 勾选框在固定的一列；git 折叠掉的未跟踪目录也有行
   7. 点一下勾选框：立刻画出来，不会被迟到的读抹掉
   8. 树行的手势：单击只选中，双击或点三角才展开
   9. 展开未跟踪目录的那一瞬间：读还没回来时列表是 undefined，不能崩
   10. 两个分组（默认变更列表 / 新增的文件）和两个视图（树 / 扁平）
   11. 一组一个框；勾上新文件之后它留在那一组里（不跳进变更列表）
   12. 未跟踪条目的两种形状（字符串 / 对象）
   13. 勾一下只动那一行：不变暗、不挪窝、不跳组，改动排队
   14. 提交的文件列表里也有目录行，而且和引用树是同一份构造 */

const L = function () {
  let out = ''
  for (let i = 0; i < arguments.length; i += 1) out += arguments[i] + '\n'
  return out
}

/* git 自己就是这么印的：`---`/`+++` 是文件头，不是被删掉/加上的行。 */
const PATCH_WORKTREE = L(
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -3,3 +3,4 @@ const x = 1',
  ' line three',
  '-old line',
  '+new line',
  '+extra',
  ' tail')

const PATCH_STAGED = L(
  'diff --git a/src/app.js b/src/app.js',
  'index 0000000..1111111 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -0,0 +1 @@',
  '+staged line')

const PATCH_COMMIT = L(
  'diff --git a/old.txt b/new.txt',
  'similarity index 83%',
  'rename from old.txt',
  'rename to new.txt',
  '--- a/old.txt',
  '+++ b/new.txt',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '+added in commit')

const diffCalls = []
const untrackedCalls = []
const baseCall = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    const reply = {
      ok: true, repo: '/tmp/ws', branch: 'main', detached: false,
      upstream: 'origin/main', ahead: 0, behind: 0, sequencer: null,
    }
    if (args != null && args.quick === true) return Promise.resolve(reply)
    return Promise.resolve(Object.assign(reply, {
      staged: [{ path: 'src/app.js', code: 'M' }],
      unstaged: [{ path: 'src/app.js', code: 'M' }, { path: 'notes.md', code: 'M' }],
      untracked: ['tmp.bin', 'newdir/'],
      unmerged: [],
    }))
  }
  if (method === 'git/commit-detail') {
    return Promise.resolve({
      ok: true, repo: '/tmp/ws', hash: (args && args.hash) || 'aaa111', subject: 'detail subject', body: '',
      author: 'mays', email: 'mays@example.com', date: '2026-09-16T10:00:00',
      files: [{ status: 'R100', path: 'new.txt', from: 'old.txt' }], branches: ['main'],
    })
  }
  if (method === 'git/untracked') {
    untrackedCalls.push(args)
    return Promise.resolve({ ok: true, dir: args.dir, files: ['newdir/a.txt', 'newdir/deep/b.txt'], truncated: false })
  }
  if (method === 'git/diff') {
    diffCalls.push(args)
    const mode = args != null ? args.mode : ''
    if (mode === 'staged') {
      return Promise.resolve({ ok: true, mode: mode, path: args.path, text: PATCH_STAGED, added: 1, removed: 0, binary: false, truncated: false, empty: false })
    }
    if (mode === 'worktree') {
      return Promise.resolve({ ok: true, mode: mode, path: args.path, text: PATCH_WORKTREE, added: 2, removed: 1, binary: false, truncated: false, empty: false })
    }
    if (mode === 'untracked') {
      return Promise.resolve({ ok: true, mode: mode, path: args.path, text: '', added: 0, removed: 0, binary: true, truncated: false, empty: true })
    }
    if (mode === 'commit') {
      return Promise.resolve({ ok: true, mode: mode, path: args.path, text: PATCH_COMMIT, added: 1, removed: 0, binary: false, truncated: false, empty: false })
    }
    return Promise.resolve({ ok: false, error: 'unknown-mode', stderr: 'nope' })
  }
  return baseCall(method, args)
}

const changeRow = function (tree, label) {
  return byClass(tree, 'dsh-git-trow').find(function (r) { return textOf(r).indexOf(label) >= 0 })
}
const toolByTitle = function (tree, title) {
  return collect(tree).filter(function (n) { return n.type === 'button' && n.props.title === title })[0]
}
const modes = function () { return diffCalls.map(function (c) { return c.mode + '@' + c.path }) }

/* ── 1. 变更页：计数、点开、返回 ── */

let tree = await openPanel()
const changesTab = buttons(tree).find(function (b) { return textOf(b).indexOf('变更') >= 0 })
ok('变更页签上带着未提交文件数（否则它只是个没有内容暗示的页签）', textOf(changesTab) === '变更4')
changesTab.props.onClick()
await wait(10)
tree = await settle()

const appRow = changeRow(tree, 'app.js')
ok('变更列表里有 src/app.js 这一行', appRow !== undefined)
ok('文件行的提示写着可以点开', appRow !== undefined && String(appRow.props.title).indexOf('点开看差异') >= 0)

appRow.props.onClick()
await wait(10)
tree = await settle()

console.log('')
console.log('== 变更页里的一个文件 ==')
ok('一次问了两段：已暂存 + 未暂存（这个文件两段都有）',
  modes().join(' , ') === 'staged@src/app.js , worktree@src/app.js')
/* 面板没「应用」过别的路径时，请求里只有会话：仓库由 Host 从那一次会话的工作目录
   解出来，和面板其它读一样 —— 带上一个猜的路径才是错的。 */
ok('两次都带上了会话（仓库由 Host 从会话解出）',
  diffCalls.every(function (c) { return c.sessionId === 's-1' && c.repo === undefined }))
ok('表头写着路径', textOf(byClass(tree, 'dsh-git-diffpath')[0]) === 'src/app.js')
ok('表头合计 +3 −1（两段相加）', textOf(byClass(tree, 'dsh-git-diffcount')[0]).replace(/\s/g, '') === '+3−1')
const sections = byClass(tree, 'dsh-git-diffsec').map(function (n) { return textOf(n) })
ok('两段各有一个小节标题', sections.length === 2 && sections[0].indexOf('已暂存') === 0 && sections[1].indexOf('未暂存') === 0)
ok('小节标题里也带各自的数', sections[0].indexOf('+1') > 0 && sections[1].indexOf('+2') > 0)

/* @@ -3,3 +3,4 @@：上下文行占 3/3，删除行占旧 4，两个新增行占新 4、5，
   最后一行上下文占旧 5/新 6。 */
const addRows = byClass(tree, 'dsh-git-dl-add')
const delRows = byClass(tree, 'dsh-git-dl-del')
const newLine = addRows.find(function (r) { return textOf(r).indexOf('new line') >= 0 })
const newNos = newLine === undefined ? [] : byClass(newLine, 'dsh-git-dno').map(function (n) { return textOf(n) })
ok('新增行的行号落在新文件一侧', newNos.length === 2 && newNos[0] === '' && newNos[1] === '4')
const extraNos = byClass(addRows.find(function (r) { return textOf(r).indexOf('extra') >= 0 }) || {}, 'dsh-git-dno').map(function (n) { return textOf(n) })
ok('紧接着的下一个新增行是 5', extraNos[1] === '5')
const delNos = byClass(delRows.find(function (r) { return textOf(r).indexOf('old line') >= 0 }) || {}, 'dsh-git-dno').map(function (n) { return textOf(n) })
ok('删除行只出现在旧文件一侧', delNos[0] === '4' && delNos[1] === '')
ok('文件头不计进增删数（+++/--- 是头，不是行）', addRows.every(function (r) { return textOf(r).indexOf('+++') < 0 }))
ok('@@ 那一行单独成一类', byClass(tree, 'dsh-git-dl-hunk').length === 2)

/* 这个文件两段都有：差异页上的按钮说的是「取消暂存」，因为索引里已经有它了。 */
const stageBtn = buttons(tree).find(function (b) { return textOf(b) === '取消暂存' })
ok('差异页上能直接暂存这个文件', stageBtn !== undefined)
const beforeStageCalls = diffCalls.length
stageBtn.props.onClick()
await wait(10)
tree = await settle()
/* 这个文件已经在索引里了，所以按钮是「取消暂存」：点它就撤下来。 */
ok('差异页上的按钮撤下索引里的那个文件',
  calls.some(function (c) { return c.method === 'git/unstage' && c.args.paths[0] === 'src/app.js' }))
ok('暂存之后补一次工作区读', calls.filter(function (c) { return c.method === 'git/panel' && c.args.quick !== true }).length >= 2)

const back = toolByTitle(tree, '返回文件列表')
ok('返回键在', back !== undefined)
back.props.onClick()
await wait(10)
tree = await settle()
ok('返回后又是文件列表', changeRow(tree, 'app.js') !== undefined && byClass(tree, 'dsh-git-diffview').length === 0)
ok('返回没有再发读取', diffCalls.length === beforeStageCalls)

/* ── 4. 未跟踪的二进制：只读一次，不当作文本 ── */

const binCalls = diffCalls.length
changeRow(tree, 'tmp.bin').props.onClick()
await wait(10)
tree = await settle()
console.log('')
console.log('== 未跟踪的二进制 ==')
ok('只问一次（未跟踪没有 HEAD 那一侧）', diffCalls.length - binCalls === 1 && diffCalls[diffCalls.length - 1].mode === 'untracked')
ok('不当作文本渲染', byClass(tree, 'dsh-git-dline').length === 0)
ok('说清楚了是二进制', textOf(tree).indexOf('二进制') >= 0)
/* 一个 git 还没见过的文件，正是最想从这儿放进索引的那种。 */
const addBtn = buttons(tree).find(function (b) { return textOf(b) === '暂存' })
ok('新增的文件在差异页上能直接暂存', addBtn !== undefined)
if (addBtn !== undefined) {
  addBtn.props.onClick()
  await wait(10)
  tree = await settle()
}
ok('走的是 git/stage', calls.some(function (c) { return c.method === 'git/stage' && c.args.paths[0] === 'tmp.bin' }))

/* ── 5. 提交下的文件：读那一次提交，重命名的旧路径一起带上 ── */

const commitCalls = diffCalls.length
toolByTitle(tree, '返回文件列表').props.onClick()
await wait(10)
tree = await settle()
buttons(tree).find(function (b) { return textOf(b).indexOf('历史') >= 0 }).props.onClick()
await wait(10)
tree = await settle()

const commitRow = byClass(tree, 'dsh-git-crow')[0]
ok('历史页有提交行', commitRow !== undefined)
commitRow.props.onClick()
await wait(10)
tree = await settle()
const commitFile = changeRow(tree, 'new.txt')
ok('提交详情里列出了文件', commitFile !== undefined)
commitFile.props.onClick()
await wait(10)
tree = await settle()

console.log('')
console.log('== 提交里的一个文件 ==')
const last = diffCalls[diffCalls.length - 1]
ok('读的是 commit 模式，ref 是这次提交', diffCalls.length - commitCalls === 1 && last.mode === 'commit' && last.ref === 'aaa111')
ok('重命名的旧路径跟着一起给 git（只给新路径的话它会报成新增）', last.from === 'old.txt')
ok('重命名那几行也显示出来', textOf(tree).indexOf('rename from old.txt') >= 0)
ok('表头还是 +1 −0', textOf(byClass(tree, 'dsh-git-diffcount')[0]).replace(/\s/g, '') === '+1−0')
ok('提交里的文件不给暂存按钮', buttons(tree).every(function (b) { return textOf(b) !== '暂存' && textOf(b) !== '取消暂存' }))

/* 刷新键：同一个文件重新读一次，请求原样 */
const beforeRefresh = diffCalls.length
toolByTitle(tree, '重新读取这个文件的差异').props.onClick()
await wait(10)
await settle()
ok('刷新键重新读一次同一个文件', diffCalls.length - beforeRefresh === 1 && diffCalls[diffCalls.length - 1].path === 'new.txt')

/* ── 一条源码规矩 ──
   差异的「身份」必须把路径算进去。同一个提交里的两个文件，请求的形状（模式、ref）
   完全一样：少了路径，视图会把上一个文件的 patch 留在新文件的名字下面 —— 那是
   最坏的一种错，因为它看起来是对的。现在从列表进差异必然先卸载再挂载，所以这条
   还是预防性的；将来要是把列表和差异摆在一起，它就是承重的。 */
const sourceText = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
const shapeSource = sourceText.slice(sourceText.indexOf('function diffShape'), sourceText.indexOf('function hunkHeader'))
console.log('')
console.log('== 源码规矩 ==')
ok('差异的身份里带着路径与重命名的旧路径',
  shapeSource.indexOf('text(target.path)') >= 0 && shapeSource.indexOf('text(target.from)') >= 0)
ok('那两行确实进了依赖表（shape 在 useEffect 的依赖里）',
  sourceText.indexOf('[shape, props.repo, props.sessionId, props.sig]') >= 0)

/* ── 6. 勾选框那一列，和被折叠的未跟踪目录 ──
   截图量出来的两件事：每个目录层级把勾选框往右推一格（深度 5 的时候框已经在
   60px 处），所以一列框永远对不齐；而 git 折叠掉的未跟踪目录（路径以 / 结尾）
   在树里根本没有行 —— 变更页签说 12 个，树里只数得出 10 个，那两个目录里的文件
   既看不见也暂存不了。 */

console.log('')
console.log('== 勾选框那一列 ==')
/* 上一节停在历史页的提交差异里：先退出来，再回到变更页 */
toolByTitle(tree, '返回文件列表').props.onClick()
await wait(10)
tree = await settle()
buttons(tree).find(function (b) { return textOf(b).indexOf('变更') >= 0 }).props.onClick()
await wait(10)
tree = await settle()

/* 分组标题（默认变更列表 / 新增的文件）是树里的一行，也是这一组的**框**所在：
   框在最左边那一列，和文件行的框列对齐（IDEA 的变更列表节点也带框），点它是整组
   进/出索引；框之外的单击仍然只选中，双击或点三角才折叠。 */
const groupRows = byClass(tree, 'dsh-git-cgroup')
const listRows = byClass(tree, 'dsh-git-trow').filter(function (r) {
  const cls = String(r.props.className)
  return cls.indexOf('dsh-git-trow-head') < 0 && cls.indexOf('dsh-git-cgroup') < 0
})
ok('每一行的第一个孩子都是勾选框（框在最左边一列）',
  listRows.length >= 4 && listRows.every(function (r) {
    const kids = r.props.children || []
    return kids.length > 0 && String(kids[0].props.className).indexOf('dsh-git-cbox') >= 0
  }))
ok('分组标题自己也带一个框，而且在同一列（第一个孩子）',
  groupRows.length === 2 && groupRows.every(function (r) {
    const kids = r.props.children || []
    return kids.length > 1 && String(kids[0].props.className).indexOf('dsh-git-cbox') >= 0
      && String(kids[1].props.className).indexOf('dsh-git-tw') >= 0
  }))
ok('行自己不再带缩进（缩进是行内的空块，所以框不会被推着走）',
  listRows.every(function (r) { return r.props.style === undefined || r.props.style.paddingLeft === undefined }))
const padOf = function (row) {
  const pad = byClass(row, 'dsh-git-tind')[0]
  return pad === undefined ? null : pad.props.style.width
}
ok('顶层行的缩进块宽度是 0', padOf(changeRow(tree, 'notes.md')) === '0px')
ok('下一层是 12px（缩进仍然逐层加宽，只是不再动勾选框）',
  padOf(changeRow(tree, 'app.js')) === '12px')

console.log('')
console.log('== 被折叠的未跟踪目录 ==')
const dirRow = changeRow(tree, 'newdir/')
ok('git 折叠掉的目录照样有一行（以前它被整行丢掉）', dirRow !== undefined)
ok('这一行说得出自己是目录', byClass(dirRow, 'dsh-git-tdir').length === 1)
ok('它也有展开的三角', byClass(dirRow, 'dsh-git-tw').length === 1)
ok('它的缩进块和同层文件一样是 0', padOf(dirRow) === '0px')

byClass(dirRow, 'dsh-git-tw')[0].props.onClick({ stopPropagation: function () {} })
await wait(10)
tree = await settle()
ok('展开时才去读一次目录里的文件', untrackedCalls.length === 1 && untrackedCalls[0].dir === 'newdir/')
ok('读的是这个会话的那次请求', untrackedCalls[0].sessionId === 's-1')

const insideRow = changeRow(tree, 'a.txt')
ok('目录里的文件成为子行', insideRow !== undefined)
ok('子行按名字显示（相对目录的路径）', textOf(insideRow).indexOf('newdir') < 0)
ok('子行缩进一层', padOf(insideRow) === '12px')
ok('子行也是勾选框在最左', String((insideRow.props.children || [])[0].props.className).indexOf('dsh-git-cbox') >= 0)

const beforeChildDiff = diffCalls.length
insideRow.props.onClick()
await wait(10)
tree = await settle()
const childAsk = diffCalls[diffCalls.length - 1]
ok('点开目录里的文件就是它的差异', diffCalls.length - beforeChildDiff === 1
  && childAsk.mode === 'untracked' && childAsk.path === 'newdir/a.txt')

toolByTitle(tree, '返回文件列表').props.onClick()
await wait(10)
tree = await settle()
const deepRow = changeRow(tree, 'b.txt')
const deepName = deepRow === undefined ? undefined : byClass(deepRow, 'dsh-git-tname')[0]
const deepPath = deepRow === undefined ? undefined : byClass(deepRow, 'dsh-git-tpath')[0]
/* 未跟踪目录里的列表是扁平的，所以带层级的那一个显示成「名字 + 目录」：名字在
   前，目录在后（深浅两层都一样）。 */
ok('多层子路径也照常显示，目录跟在名字后面',
  deepName !== undefined && textOf(deepName).indexOf('b.txt') === 0
  && deepPath !== undefined && textOf(deepPath) === 'deep/')
const beforeChildStage = calls.length
const deepBox = deepRow === undefined ? undefined : byClass(deepRow, 'dsh-git-cbox')[0]
if (deepBox !== undefined) deepBox.props.onClick({ stopPropagation: function () {} })
await wait(10)
tree = await settle()
ok('子行的勾选框暂存的是那个文件本身',
  calls.some(function (c) { return c.method === 'git/stage' && c.args.paths[0] === 'newdir/deep/b.txt' }))

const beforeDirStage = calls.length
const dirAgain = changeRow(tree, 'newdir/')
const dirBox = dirAgain === undefined ? undefined : byClass(dirAgain, 'dsh-git-cbox')[0]
if (dirBox !== undefined) dirBox.props.onClick({ stopPropagation: function () {} })
await wait(10)
await settle()
ok('目录那一行的勾选框暂存整个目录（git add -- dir 不需要先列出内容）',
  calls.some(function (c) { return c.method === 'git/stage' && c.args.paths[0] === 'newdir/' }))

/* ── 7. 点一下勾选框：立刻有反应，而且不会被迟到的读抹掉 ──

   在读者那台机器上量过：`git add` 是 98–236ms，而面板原来要等一次整棵树的
   `git status` 才把框画出来 —— 那里是 7.4s（冷的时候 13.6s）。点一下等七秒，
   和点一下没反应是同一件事，所以框现在从点击本身画出来，随后的读只确认它。
   下面盯的就是这条链的四件事：立刻画、只问这些路径、失败就还原、旧读不许翻盘。 */

console.log('')
console.log('== 点一下勾选框 ==')

const savedCall = host.call
const glyphOf = function (row) {
  const box = row === undefined ? undefined : byClass(row, 'dsh-git-cbox')[0]
  return box === undefined ? null : textOf(box)
}
const stagedLine = function (tree) {
  const line = collect(tree).filter(function (n) { return String(textOf(n)).indexOf('已暂存 ') >= 0 })[0]
  return line === undefined ? '' : textOf(line)
}
const clickBox = async function (label) {
  const row = changeRow(tree, label)
  byClass(row, 'dsh-git-cbox')[0].props.onClick({ stopPropagation: function () {} })
  await wait(10)
  return await settle()
}

/* 7a. git 还没回话，框就得动 */
const beforeTick = changeRow(tree, 'notes.md')
ok('点之前 notes.md 是没暂存的空框', glyphOf(beforeTick) === '☐' && stagedLine(tree).indexOf('已暂存 1 ') >= 0)
let releaseStage = null
host.call = function (method, args) {
  if (method === 'git/stage') {
    calls.push({ method: method, args: args })
    return new Promise(function (resolve) { releaseStage = resolve })
  }
  return savedCall(method, args)
}
const tickCalls = calls.length
tree = await clickBox('notes.md')
ok('git 还没回话，框就已经是已暂存（不再等那一次整树读）', glyphOf(changeRow(tree, 'notes.md')) === '☑')
ok('「已暂存 N」跟着动（还是没等 git）', stagedLine(tree).indexOf('已暂存 2 ') >= 0)
ok('这一下确实发出去了', calls.length > tickCalls
  && calls.some(function (c) { return c.method === 'git/stage' && c.args.paths[0] === 'notes.md' }))

/* 7b. 确认读只问这些路径 —— 整棵树 7.4s，这些路径 0.5s */
const targetReads = function () {
  return calls.filter(function (c) {
    return c.method === 'git/panel' && c.args.quick !== true && Array.isArray(c.args.paths)
  })
}
if (releaseStage !== null) releaseStage({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
host.call = savedCall
tree = await settle()
const confirmAsk = targetReads()[targetReads().length - 1]
ok('确认读按路径问（不是整棵树）', confirmAsk !== undefined && confirmAsk.args.paths.length === 1
  && confirmAsk.args.paths[0] === 'notes.md')
ok('确认读仍带着这个会话', confirmAsk.args.sessionId === 's-1' && confirmAsk.args.repo === undefined)

/* 7c. 一次正在飞的整树读，不许把刚点的框擦回去 */
let releaseFull = null
host.call = function (method, args) {
  if (method === 'git/panel' && args != null && args.quick !== true) {
    calls.push({ method: method, args: args })
    if (Array.isArray(args.paths)) {
      /* 这一节里 mock 照刚才那次点击回答，这样确认读真的是「确认」 */
      return Promise.resolve({
        ok: true, partial: true, paths: args.paths, repo: '/tmp/ws', branch: 'main', detached: false,
        upstream: '', ahead: 0, behind: 0, sequencer: null,
        staged: [{ path: 'notes.md', code: 'M' }], unstaged: [], untracked: [], unmerged: [],
      })
    }
    return new Promise(function (resolve) { releaseFull = resolve })
  }
  return savedCall(method, args)
}
toolByTitle(tree, '重新读取仓库（忽略缓存）').props.onClick()
await wait(10)
tree = await settle()
ok('刷新键发出的是一次整树读，它还没回来', releaseFull !== null)
tree = await clickBox('notes.md')
ok('在读还没回来的时候点：框照样立刻是已暂存', glyphOf(changeRow(tree, 'notes.md')) === '☑')
if (releaseFull !== null) {
  /* 这份回答描述的是点击之前的工作区：它要是画上去，刚点的那一下就没了 */
  releaseFull({
    ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0, sequencer: null,
    staged: [], unstaged: [{ path: 'notes.md', code: 'M' }, { path: 'stale.txt', code: 'M' }], untracked: [], unmerged: [],
  })
}
host.call = savedCall
tree = await settle()
ok('迟到的旧读被丢掉，框还在（这就是「点一下又丢失」的那个 bug）', glyphOf(changeRow(tree, 'notes.md')) === '☑')
ok('旧读里的别的改动也没被画上去', changeRow(tree, 'stale.txt') === undefined)

/* 7d. git 拒绝的时候：还原，并且说清楚 */
const failBefore = host.call
host.call = function (method, args) {
  if (method === 'git/stage') {
    calls.push({ method: method, args: args })
    return Promise.resolve({ ok: false, repo: '/tmp/ws', stdout: '', stderr: 'fatal: pathspec did not match', exitCode: 1, command: 'git add -- tmp.bin' })
  }
  return failBefore(method, args)
}
tree = await clickBox('tmp.bin')
ok('git 拒绝了：框退回原样', glyphOf(changeRow(tree, 'tmp.bin')) === '☐')
ok('并且把 git 的话显示出来', byClass(tree, 'dsh-git-error').length > 0 && textOf(tree).indexOf('pathspec did not match') >= 0)
host.call = failBefore
await settle()

/* ── 8. 树行的手势：单击只选中，双击或点三角才展开 ──

   这是 IDEA 的项目树手势，也是读者点名要的那一条：行的第一次点击只是把这一行选中，
   树的形状一点不动；展开/折叠要么双击整行，要么点它左边那个三角。

   对它较真的是未跟踪目录：展开它要读一次目录内容（一次读取），而单击不该顺手把它
   带走 —— 单击就展开的话，想「只选中这一行」的人每次都要多一次目录读。这一节把
   手势逐条钉住，顺带钉住唯一不在这条规矩上的那种行：文件行仍然是单击就看差异，
   那是 IDEA 提交窗口自己的手势（竖着排的列表旁边就是差异，选中即预览）。 */

console.log('')
console.log('== 单击只选中，双击或三角才展开 ==')

const selectedRows = function (t) {
  return byClass(t, 'dsh-git-trow').filter(function (r) {
    return String(r.props.className).split(' ').indexOf('dsh-git-trow-sel') >= 0
  })
}
const isSelected = function (t, label) {
  const row = changeRow(t, label)
  return row !== undefined && String(row.props.className).split(' ').indexOf('dsh-git-trow-sel') >= 0
}
/* 未跟踪目录的展开是一次 git/untracked；这一节数的就是它 */
const dirReads = function () { return untrackedCalls.length }

/* 8a. 已跟踪的目录行：单击只是选中 */
const srcRow = changeRow(tree, 'src')
ok('目录行有它自己的三角（展开是这一个控件的事）',
  srcRow !== undefined && byClass(srcRow, 'dsh-git-tw').length === 1)
const beforeDirClick = calls.length
srcRow.props.onClick()
await wait(10)
tree = await settle()
ok('单击目录行：子行还在（树没有动）', changeRow(tree, 'app.js') !== undefined)
ok('单击目录行：没有发出任何读取', calls.length === beforeDirClick)
ok('单击目录行：这一行变成选中', isSelected(tree, 'src') && selectedRows(tree).length === 1)

/* 8b. 双击同一个目录行：这才收起来 */
/* 手势要是退回「单击就展开」，这一节该报一排 ✗ 而不是抛栈：抛出去会把后面
   所有段落一起带走。 */
const srcAgain = changeRow(tree, 'src')
if (typeof srcAgain.props.onDoubleClick === 'function') srcAgain.props.onDoubleClick()
await wait(10)
tree = await settle()
ok('双击目录行：子行收起来了', changeRow(tree, 'app.js') === undefined)
ok('双击也只是折叠，没有触发别的读取', calls.length === beforeDirClick)
ok('双击之后选中的还是这一行', isSelected(tree, 'src'))

/* 8c. 三角：展开它，并且不把选中改到别的行上去 */
let twistyStopped = false
byClass(changeRow(tree, 'src'), 'dsh-git-tw')[0].props.onClick({ stopPropagation: function () { twistyStopped = true } })
await wait(10)
tree = await settle()
ok('点三角会拦住冒泡（所以它顺手改不了选中）', twistyStopped)
ok('点三角：子行回来了', changeRow(tree, 'app.js') !== undefined)
ok('点三角：选中的还是原来那一行', isSelected(tree, 'src') && selectedRows(tree).length === 1)

/* 8d. 未跟踪目录：先收起来（它是第 6 节展开的） */
const newdirRow = function (t) { return changeRow(t, 'newdir/') }
ok('未跟踪目录行还在（子行也还在）', newdirRow(tree) !== undefined && changeRow(tree, 'a.txt') !== undefined)
const beforeCollapse = dirReads()
byClass(newdirRow(tree), 'dsh-git-tw')[0].props.onClick({ stopPropagation: function () {} })
await wait(10)
tree = await settle()
ok('收起未跟踪目录：不读任何东西（列表只是藏起来）', dirReads() === beforeCollapse)
ok('收起之后子行不见了', changeRow(tree, 'a.txt') === undefined)

/* 8e. 折叠着的未跟踪目录上单击：只选中 */
const beforeSingle = calls.length
newdirRow(tree).props.onClick()
await wait(10)
tree = await settle()
ok('单击未跟踪目录：只选中，没有去读目录里的文件',
  isSelected(tree, 'newdir/') && dirReads() === beforeCollapse && calls.length === beforeSingle)
ok('单击未跟踪目录：树还是折着的', changeRow(tree, 'a.txt') === undefined)

/* 8f. 双击（真实的双击会先来两次单击，再来 onDoubleClick）：只读一次 */
const beforeDouble = dirReads()
const doubleRow = newdirRow(tree)
doubleRow.props.onClick()
doubleRow.props.onClick()
if (typeof doubleRow.props.onDoubleClick === 'function') doubleRow.props.onDoubleClick()
await wait(10)
tree = await settle()
ok('双击未跟踪目录：这才读一次目录内容', dirReads() - beforeDouble === 1)
ok('双击未跟踪目录：文件列出来了', changeRow(tree, 'a.txt') !== undefined && changeRow(tree, 'b.txt') !== undefined)

/* 8g. 再展开一次会重新读：暂存/提交之后那份列表就是会变的东西 */
byClass(newdirRow(tree), 'dsh-git-tw')[0].props.onClick({ stopPropagation: function () {} })
await wait(10)
tree = await settle()
const beforeReopen = dirReads()
byClass(newdirRow(tree), 'dsh-git-tw')[0].props.onClick({ stopPropagation: function () {} })
await wait(10)
tree = await settle()
ok('再展开一次重新读一次（不拿上一次的旧列表凑数）', dirReads() - beforeReopen === 1)

/* 8h. 唯一不在这条规矩上的行：文件行的单击就是「看差异」 */
const beforeFileClick = diffCalls.length
changeRow(tree, 'notes.md').props.onClick()
await wait(10)
tree = await settle()
ok('文件行仍是「单击就看差异」（提交窗口里选中即预览的那个手势）',
  diffCalls.length - beforeFileClick === 1 && diffCalls[diffCalls.length - 1].path === 'notes.md')
toolByTitle(tree, '返回文件列表').props.onClick()
await wait(10)
tree = await settle()
ok('返回后还是那棵树，目录的展开状态也还在',
  changeRow(tree, 'app.js') !== undefined && changeRow(tree, 'a.txt') !== undefined)

/* ── 9. 展开未跟踪目录的那一瞬间：读还在飞的时候，列表是 undefined ──

   真实的面板在这里崩过一次，整块面板因此从 slot 上掉下来：

     Cannot read properties of undefined (reading 'length')
     at ChangesPane

   原因是一秒钟的窗口：单击展开 → `untrackedFiles[dir]` 立刻被清掉（好让行说
   「正在读取…」）→ 读回来之前它是 **undefined**。代码先把「正在读取…」画上
   去，然后**照旧**去跑 `for (k < list.length)` —— 那就是 undefined.length。

   为什么以前没发现：测试里的 mock 是立刻回答的，`await wait(10)` 之后列表早就
   在了，这一帧从来没被渲染过。**mock 越快，越看不见这条缝。** 所以这一节把
   `git/untracked` 扣住不回答，专门渲染那一帧。 */

console.log('')
console.log('== 展开未跟踪目录，读还没回来 ==')

const beforeHeld = host.call
let releaseHeld = null
host.call = function (method, args) {
  if (method === 'git/untracked') {
    untrackedCalls.push(args)
    return new Promise(function (resolve) { releaseHeld = resolve })
  }
  return beforeHeld(method, args)
}
/* 先收起来，才能再展开一次（展开的那一下就是这一节的被测对象） */
byClass(newdirRow(tree), 'dsh-git-tw')[0].props.onClick({ stopPropagation: function () {} })
await wait(10)
tree = await settle()
byClass(newdirRow(tree), 'dsh-git-tw')[0].props.onClick({ stopPropagation: function () {} })
await wait(10)
let paneCrash = null
try {
  tree = await settle()
} catch (error) {
  paneCrash = error
}
ok('读还在飞的时候渲染这一棵树不会抛异常'
  + (paneCrash === null ? '' : '：' + String(paneCrash && paneCrash.message)),
  paneCrash === null)
ok('这一帧里那一行说的是「正在读取…」',
  paneCrash === null && tree !== null && textOf(tree).indexOf('正在读取') >= 0)
if (releaseHeld !== null) {
  releaseHeld({ ok: true, dir: 'newdir/', files: ['newdir/a.txt', 'newdir/deep/b.txt'], truncated: false })
}
host.call = beforeHeld
let afterCrash = null
try {
  tree = await settle()
} catch (error) {
  afterCrash = error
}
ok('读回来之后文件行照常出现（那一帧只是中间态，不是终点）',
  afterCrash === null && changeRow(tree, 'a.txt') !== undefined && changeRow(tree, 'b.txt') !== undefined)

/* ── 10. 两个分组，两个视图 ──

   IDEA 的提交窗不是一个「git 看到的东西」的大列表：它有一个变更列表（git 管着的
   改动），下面另起一个 **Unversioned Files** 节点（git 还没见过的路径）。以前这个
   面板把两者混在一棵树里 —— 未跟踪的目录就夹在被跟踪的目录中间，唯一能分辨的办法
   是去读每一行的状态字母。

   另一条轴是 IDEA 的另一个开关：按目录折叠的树，还是每个文件一行的扁平列表。同一批
   行、同样的框、同样的手势，差别只在标签和缩进（扁平视图按路径排序）。

   这一节还钉住两件后来改掉的事：扁平行里**文件名排在目录前面**（`.../impl/` 那样的
   长路径先出现的话，行尾裁掉的正好是文件名），以及那个开关**住在面板头部**、只在变更
   页出现 —— 它以前在列表上方单独占一行，两个词花掉列表一整行的高度。 */

console.log('')
console.log('== 两组：默认变更列表 / 新增的文件 ==')

const groupTitleRow = function (t, label) {
  return byClass(t, 'dsh-git-cgroup').filter(function (r) { return textOf(r).indexOf(label) >= 0 })[0]
}
/* 每个文件行属于哪一组：按行序走，遇到分组标题就换组 */
const membersOf = function (t, label) {
  const rows = byClass(t, 'dsh-git-trow')
  const out = []
  let current = ''
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i].props.className).indexOf('dsh-git-cgroup') >= 0) { current = textOf(rows[i]); continue }
    if (current.indexOf(label) >= 0) out.push(textOf(rows[i]))
  }
  return out
}
const trackedDirRow = function (t) {
  return byClass(t, 'dsh-git-trow').filter(function (r) {
    return textOf(r).indexOf('个文件') >= 0 && String(r.props.className).indexOf('dsh-git-cgroup') < 0
  })[0]
}

const groupTitles = byClass(tree, 'dsh-git-cgroup').map(function (r) { return textOf(r) })
ok('两个分组都在，各带自己的条数（变更列表 2 个文件 / 未跟踪 1 个文件 + 1 个目录）',
  groupTitles.length === 2
  && groupTitles[0].indexOf('默认变更列表') >= 0 && groupTitles[0].indexOf('2 个文件') >= 0
  && groupTitles[1].indexOf('新增的文件') >= 0 && groupTitles[1].indexOf('1 个文件 + 1 个目录') >= 0)
ok('变更列表排在新增的文件前面（IDEA 的顺序）', groupTitles.length === 2
  && groupTitles[0].indexOf('默认变更列表') >= 0 && groupTitles[1].indexOf('新增的文件') >= 0)

const inTracked = membersOf(tree, '默认变更列表')
const inUnversioned = membersOf(tree, '新增的文件')
ok('未跟踪的目录和新增的文件都落在未跟踪这一组',
  inUnversioned.some(function (x) { return x.indexOf('newdir/') >= 0 })
  && inUnversioned.some(function (x) { return x.indexOf('tmp.bin') >= 0 }))
ok('被跟踪的文件一个都不在未跟踪组里（以前它们混在一棵树里）',
  inUnversioned.every(function (x) { return x.indexOf('app.js') < 0 && x.indexOf('notes.md') < 0 }))
ok('目录树在变更列表这一组里', inTracked.some(function (x) { return x.indexOf('src') >= 0 })
  && inTracked.some(function (x) { return x.indexOf('app.js') >= 0 }))
ok('未跟踪目录里列出来的文件也算未跟踪组的（它们跟着自己的目录）',
  inUnversioned.some(function (x) { return x.indexOf('a.txt') >= 0 }))

console.log('')
console.log('== 两个视图：树 / 扁平 ==')
const viewBtn = function (t, label) {
  return buttons(t).filter(function (b) {
    return textOf(b) === label && String(b.props.className).indexOf('dsh-git-cview') >= 0
  })[0]
}
/* 这一节剩下的断言都要点控件：分组或开关要是退回去了，这里该报 ✗ 而不是抛栈 ——
   抛出去会把这一节剩下的断言一起带走，回归信号就只剩一个栈。 */
const press = function (node, name, extra) {
  if (node !== undefined && typeof node.props[name] === 'function') node.props[name](extra)
}
ok('工具条上有两个视图按钮', viewBtn(tree, '树') !== undefined && viewBtn(tree, '扁平') !== undefined)
ok('默认是树视图（src/ 带条数的那一行在）',
  trackedDirRow(tree) !== undefined && textOf(trackedDirRow(tree)).indexOf('src') >= 0)
/* 开关不住在列表上方那一行里了：它在面板头部的最右端，和页签、同步按钮、分支同一行。 */
const topBar = byClass(tree, 'dsh-git-top')[0]
const topKids = topBar === undefined ? [] : topBar.props.children
const topLast = topKids.length === 0 ? undefined : topKids[topKids.length - 1]
ok('视图开关住在面板头部（最右端），不再自己占一行',
  byClass(tree, 'dsh-git-cbar').length === 0
  && topBar !== undefined && textOf(topBar).indexOf('扁平') >= 0
  && topLast !== undefined && String(topLast.props.className).indexOf('dsh-git-cviews') >= 0
  && byClass(tree, 'dsh-git-clist').length === 1
  && textOf(byClass(tree, 'dsh-git-clist')[0]).indexOf('扁平') < 0)
/* 布局是 CSS 的事，量不到（这一套没有真的排版引擎）：钉住那两条规则本身 ——
   一行把开关推到最右端，另一行让目录压暗、和名字隔开 8px。 */
const panelCss = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
ok('样式把开关推到头部那一行的最右端（margin-left:auto）',
  /\.dsh-git-cviews\{[^}]*margin-left:auto/.test(panelCss))
ok('扁平的目录格是压暗的小字、和名字隔开（.dsh-git-tpath 的二级色 + margin-left）',
  /\.dsh-git-tpath\{[^}]*color:var\(--dsw-alias-label-secondary\)/.test(panelCss)
  && /\.dsh-git-tpath\{[^}]*margin-left:8px/.test(panelCss))

press(viewBtn(tree, '扁平'), 'onClick')
await wait(10)
tree = await settle()
const flatTexts = byClass(tree, 'dsh-git-trow').map(function (r) { return textOf(r) })
const flatRow = function (t, name) {
  return byClass(t, 'dsh-git-trow').filter(function (r) { return textOf(r).indexOf(name) >= 0 })[0]
}
ok('扁平视图：目录行没有了（每个文件一行）', trackedDirRow(tree) === undefined)
/* 一行的文本是「名字 + 目录」拼起来的（中间那 8px 是 CSS 的 margin，不在文本里），
   所以「一个文件一行」要看的是这两部分在同一行上。 */
const flatHas = function (name, dir) {
  return flatTexts.some(function (x) { return x.indexOf(name) >= 0 && x.indexOf(dir) >= 0 })
}
ok('扁平视图：每个文件还是一行，名字和它的目录在同一行里',
  flatHas('app.js', 'src/') && flatTexts.some(function (x) { return x.indexOf('notes.md') >= 0 }))
/* 名字必须排在目录前面：一条 120 字的路径先出现的话，行尾裁掉的正好是文件名。 */
const flatApp = flatRow(tree, 'app.js')
ok('扁平视图：文件名排在目录前面（名字在行的开头那一格）',
  flatApp !== undefined && byClass(flatApp, 'dsh-git-tname').length === 1
  && textOf(byClass(flatApp, 'dsh-git-tname')[0]).indexOf('app.js') === 0)
ok('扁平视图：目录单独一格、压暗（.dsh-git-tpath），不再是名字那一格的一部分',
  flatApp !== undefined && byClass(flatApp, 'dsh-git-tpath').length === 1
  && textOf(byClass(flatApp, 'dsh-git-tpath')[0]) === 'src/')
ok('扁平视图：按路径排序（notes.md 排在 src/app.js 前面）',
  flatTexts.findIndex(function (x) { return x.indexOf('notes.md') >= 0 })
  < flatTexts.findIndex(function (x) { return x.indexOf('app.js') >= 0 }))
ok('扁平视图：未跟踪目录行还在，展开的列表也是一行一个名字',
  changeRow(tree, 'newdir/') !== undefined && flatHas('a.txt', 'newdir/'))
ok('扁平视图里分组照样是两组', byClass(tree, 'dsh-git-cgroup').length === 2)

const stored = JSON.parse(store['dsh.git-idea.settings'] || '{}')
ok('视图选择被记住了（写进这个浏览器的偏好）', stored.changesView === 'flat')

/* 重新挂载一遍：偏好是「记住」，不是「这一次会话里凑巧还在」 */
fibers.clear()
tree = await openPanel()
buttons(tree).find(function (b) { return textOf(b).indexOf('变更') >= 0 }).props.onClick()
await wait(10)
tree = await settle()
ok('重开面板仍然是扁平视图（偏好真的生效）',
  trackedDirRow(tree) === undefined
  && byClass(tree, 'dsh-git-trow').some(function (r) {
    const t = textOf(r)
    return t.indexOf('app.js') >= 0 && t.indexOf('src/') >= 0
  }))

press(viewBtn(tree, '树'), 'onClick')
await wait(10)
tree = await settle()
ok('切回树视图：目录行回来了', trackedDirRow(tree) !== undefined)
/* 树视图不重复目录：层级本身就是那条路径。 */
const treeApp = changeRow(tree, 'app.js')
ok('树视图的行里没有第二个目录格',
  treeApp !== undefined && byClass(treeApp, 'dsh-git-tpath').length === 0)
ok('偏好跟着改回 tree', JSON.parse(store['dsh.git-idea.settings']).changesView === 'tree')

console.log('')
console.log('== 分组标题守同一条手势 ==')
const unvTitle = groupTitleRow(tree, '新增的文件')
ok('分组标题给了「双击」提示', unvTitle !== undefined && String(unvTitle.props.title).indexOf('双击') > 0)
press(unvTitle, 'onClick')
await wait(10)
tree = await settle()
ok('单击分组标题：只选中，组里的行都还在',
  changeRow(tree, 'tmp.bin') !== undefined
  && groupTitleRow(tree, '新增的文件') !== undefined
  && String(groupTitleRow(tree, '新增的文件').props.className).indexOf('dsh-git-trow-sel') >= 0)
press(groupTitleRow(tree, '新增的文件'), 'onDoubleClick')
await wait(10)
tree = await settle()
ok('双击分组标题：这一组折起来（行不见了，标题还在）',
  changeRow(tree, 'tmp.bin') === undefined && groupTitleRow(tree, '新增的文件') !== undefined)
ok('另一组不受影响（变更列表还在）', changeRow(tree, 'app.js') !== undefined)

/* 开关只出现在它管得着的那一页：历史页上它什么也切不了，就不该在那里。 */
console.log('')
console.log('== 视图开关只在变更页出现 ==')
const tabBtn = function (t, label) {
  return buttons(t).filter(function (b) {
    return textOf(b).indexOf(label) >= 0 && String(b.props.className).indexOf('dsh-git-tab') >= 0
  })[0]
}
press(tabBtn(tree, '历史'), 'onClick')
await wait(10)
tree = await settle()
ok('历史页没有这个开关', viewBtn(tree, '扁平') === undefined && viewBtn(tree, '树') === undefined)
press(tabBtn(tree, '变更'), 'onClick')
await wait(10)
tree = await settle()
ok('回到变更页它又在了', viewBtn(tree, '扁平') !== undefined && viewBtn(tree, '树') !== undefined)

/* ── 11. 一组一个框，和「这些数字数的是什么」──

   读者指出的两件事：每个变更列表该有自己的全选框，以及右边那句统计看起来和勾选框对不上。

   第一件是 IDEA 的行为：它的变更列表节点本来就带框。框放在文件行那一列框的最左边一格，
   点它整组进索引、再点整组出来（半选的时候点 = 全选）。

   第二件是真错：git 把未跟踪的目录折叠成一条以 / 结尾的条目，那**一个框**代表底下多少个
   文件是展开之前不知道的。把它算成「1 个文件」就对不上了 —— 十个框里有三个是目录，句子
   却写「共 10 个文件」；而那三个目录一旦勾上，又会被说成「已暂存 3 个文件」。现在文件与
   目录分开数，暂存的比例数的是**项**（框的个数），拆解写在分组标题和提示里。

   这一段从一次干净的重新挂载开始：前面每一节都在改这棵树。 */
console.log('')
console.log('== 一组一个框 ==')
fibers.clear()
tree = await openPanel()
press(tabBtn(tree, '变更'), 'onClick')
await wait(10)
tree = await settle()

const groupRow = function (t, label) {
  return byClass(t, 'dsh-git-cgroup').filter(function (r) { return textOf(r).indexOf(label) >= 0 })[0]
}
const groupBox = function (t, label) {
  const row = groupRow(t, label)
  return row === undefined ? undefined : byClass(row, 'dsh-git-cbox')[0]
}
const stageLineOf = function (t) {
  const line = collect(t).filter(function (n) { return String(textOf(n)).indexOf('已暂存 /') >= 0 || String(textOf(n)).indexOf('已暂存 ') === 0 })[0]
  return line === undefined ? '' : textOf(line)
}
ok('变更列表那一组的框是半选（组里有已暂存的、也有没暂存的）',
  groupBox(tree, '默认变更列表') !== undefined && textOf(groupBox(tree, '默认变更列表')) === '▣')
ok('未跟踪那一组的框是空的（它们按定义都还没进索引）',
  groupBox(tree, '新增的文件') !== undefined && textOf(groupBox(tree, '新增的文件')) === '☐')
ok('条数把文件和目录分开数（不再把折叠的目录算成 1 个文件）',
  textOf(groupRow(tree, '新增的文件')).indexOf('1 个文件 + 1 个目录') >= 0
  && textOf(groupRow(tree, '默认变更列表')).indexOf('2 个文件') >= 0
  && textOf(groupRow(tree, '新增的文件')).indexOf('个目录') >= 0)
ok('右边那句数的是框（项），不再是「个文件」',
  stageLineOf(tree).indexOf('已暂存 1 / 共 4 项') >= 0)

/* 点一组的框：整组的路径都发给 git，本地这一帧就全勾上（不等 git 回话）。

   mock 照着 Host 的样子回答：按路径的问法只回答被问到的那几条，而且**记住**刚被暂存的
   东西。这是必须的 —— 面板现在把改动按点击顺序排队（80-panel.js 的 queueMutation：
   并发的 `git add` 会互相抢 .git/index.lock，在 /tmp 里量过一次，39 个并发 add 有 **29
   个**直接死在 `Unable to create .git/index.lock: File exists`），所以第二次点击要等
   第一次被回答才会发出去。mock 要还是扣着不回答，第二次点击就只会排在队里。 */
const groupIdentity = {
  ok: true, repo: '/tmp/ws', branch: 'main', detached: false,
  upstream: 'origin/main', ahead: 0, behind: 0, sequencer: null,
}
const groupState = {
  staged: [{ path: 'src/app.js', code: 'M.' }],
  unstaged: [{ path: 'src/app.js', code: 'M.' }, { path: 'notes.md', code: 'M.' }],
  untracked: [{ path: 'tmp.bin', code: '??' }, { path: 'newdir/', code: '??' }],
}
const GROUP_TRACKED = { 'src/app.js': true, 'notes.md': true }
const groupSaved = host.call
let groupAsk = null
const groupDrop = function (list, path) {
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].path === path) list.splice(i, 1)
}
const groupApply = function (method, paths) {
  for (let i = 0; i < paths.length; i += 1) {
    const p = paths[i]
    groupDrop(groupState.staged, p); groupDrop(groupState.unstaged, p); groupDrop(groupState.untracked, p)
    if (method === 'git/stage') {
      /* git 折叠未跟踪目录：暂存 `newdir/` 之后索引里是它里面的文件。已经跟踪过的
         文件暂存起来是 `M.`（改动的那个字母），只有 HEAD 没有过的路径才是 `A.` ——
         这个字母就是分组判据本身，mock 写错了整组都会换地方。 */
      if (p.slice(-1) === '/') groupState.staged.push({ path: p + 'a.txt', code: 'A.' }, { path: p + 'deep/b.txt', code: 'A.' })
      else groupState.staged.push({ path: p, code: GROUP_TRACKED[p] === true ? 'M.' : 'A.' })
    } else if (GROUP_TRACKED[p] === true) {
      groupState.unstaged.push({ path: p, code: '.M' })
    } else {
      groupState.untracked.push({ path: p, code: '??' })
    }
  }
  /* 撤出索引之后那个目录又整个是未跟踪的；整树读会把它重新折叠成一条（量过真 git：
     `git restore --staged -- newdir/a.txt newdir/deep/b.txt` 之后整树读是 `? newdir/`，
     而按这两个文件的路径去问，回答的是 `? newdir/a.txt` / `? newdir/deep/b.txt`，
     不折叠）。所以折叠只发生在整树读那次回答里。 */
}
const groupCollapsed = function (entries) {
  const out = []
  const seen = {}
  for (let i = 0; i < entries.length; i += 1) {
    const p = entries[i].path
    const cut = p.lastIndexOf('/')
    if (cut < 0) { out.push(entries[i]); continue }
    const top = p.slice(0, cut + 1)
    if (seen[top] === true) continue
    seen[top] = true
    out.push({ path: top, code: '??' })
  }
  return out
}
const groupReplyFor = function (paths) {
  const wanted = function (p) {
    for (let i = 0; i < paths.length; i += 1) {
      const one = paths[i]
      if (p === one) return true
      if (one.slice(-1) === '/' && p.indexOf(one) === 0) return true
    }
    return false
  }
  const pick = function (entries) {
    return entries.filter(function (e) { return wanted(e.path) }).map(function (e) { return { path: e.path, code: e.code } })
  }
  return Object.assign({}, groupIdentity, {
    partial: true, paths: paths,
    staged: pick(groupState.staged), unstaged: pick(groupState.unstaged),
    untracked: pick(groupState.untracked), unmerged: [],
  })
}
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    if (args != null && args.quick === true) return Promise.resolve(groupIdentity)
    if (args != null && Array.isArray(args.paths)) return Promise.resolve(groupReplyFor(args.paths))
    return Promise.resolve(Object.assign({}, groupIdentity, {
      staged: groupState.staged.slice(), unstaged: groupState.unstaged.slice(),
      untracked: groupCollapsed(groupState.untracked), unmerged: [],
    }))
  }
  if (method === 'git/stage' || method === 'git/unstage') {
    calls.push({ method: method, args: args })
    groupAsk = { method: method, args: args }
    groupApply(method, args.paths)
    return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
  }
  return groupSaved(method, args)
}

/* 半选的那一组：点一次 = 把组里剩下的也暂存，这一帧里它的框变成全选 */
press(groupBox(tree, '默认变更列表'), 'onClick', { stopPropagation: function () {} })
await wait(10)
tree = await settle()
ok('半选的组点一下 = 整组暂存（路径正好是这一组两个）',
  groupAsk != null && groupAsk.method === 'git/stage'
  && groupAsk.args.paths.slice().sort().join(',') === 'notes.md,src/app.js')
ok('这一帧里那一组的框变成全选 ☑',
  groupBox(tree, '默认变更列表') !== undefined && textOf(groupBox(tree, '默认变更列表')) === '☑')
ok('点框不算选中这一行（框自己 stopPropagation）',
  String(groupRow(tree, '默认变更列表').props.className).indexOf('dsh-git-trow-sel') < 0)

/* 全选之后，同一个框是「整组撤出索引」 */
groupAsk = null
press(groupBox(tree, '默认变更列表'), 'onClick', { stopPropagation: function () {} })
await wait(10)
tree = await settle()
ok('全选的组再点一次：整组撤出索引（发的是 unstage，路径还是整组）',
  groupAsk != null && groupAsk.method === 'git/unstage'
  && groupAsk.args.paths.slice().sort().join(',') === 'notes.md,src/app.js')
ok('这一帧里那一组的框回到空 ☐',
  groupBox(tree, '默认变更列表') !== undefined && textOf(groupBox(tree, '默认变更列表')) === '☐')

/* 新增的文件那一组：它是空的框，点一下整组进索引 —— 而这一组的行**留在原地**。
   （以前它们会跳进变更列表：`untracked` 一个判据说了算，勾上 = 进了索引 = 不再是
   未跟踪的，于是整组跟着消失，读者刚勾上的东西一下全看不见了。现在判据是「HEAD
   从来没有过这个路径」：`untracked` 或者索引里的 `A…`，勾上只是框变了。） */
groupAsk = null
press(groupBox(tree, '新增的文件'), 'onClick', { stopPropagation: function () {} })
await wait(10)
tree = await settle()
ok('点新增那一组的框：整组的两个路径一次发出去',
  groupAsk != null && groupAsk.method === 'git/stage'
  && groupAsk.args.paths.slice().sort().join(',') === 'newdir/,tmp.bin')
ok('本地这一帧就勾上了（tmp.bin 的框已是 ☑）',
  (function () {
    const row = changeRow(tree, 'tmp.bin')
    return row !== undefined && textOf(byClass(row, 'dsh-git-cbox')[0]) === '☑'
  })())
ok('这一组还在（没有跳进变更列表）：tmp.bin 留在这一组，那个目录展开成它里面的文件也在',
  groupRow(tree, '新增的文件') !== undefined
  && membersOf(tree, '新增的文件').some(function (x) { return x.indexOf('tmp.bin') >= 0 })
  && membersOf(tree, '新增的文件').some(function (x) { return x.indexOf('a.txt') >= 0 }))
ok('这一组的框变成全选 ☑（组里的行都进索引了）',
  groupBox(tree, '新增的文件') !== undefined && textOf(groupBox(tree, '新增的文件')) === '☑')
ok('变更列表里没有混进新文件（新文件还在自己那一组里）',
  membersOf(tree, '默认变更列表').every(function (x) {
    return x.indexOf('tmp.bin') < 0 && x.indexOf('newdir') < 0 && x.indexOf('a.txt') < 0
  }))

/* 再点一次：整组撤出索引，行还是留在这一组里，只是框回到空的（可以来回切）。
   组里的条目这时是索引里的三个文件 —— `newdir/` 一旦进了索引就展开成了它里面的文件，
   所以这次发出去的是那三个路径，不是折叠的那一条。撤出之后 git 又把那个目录折叠回一条。 */
groupAsk = null
press(groupBox(tree, '新增的文件'), 'onClick', { stopPropagation: function () {} })
await wait(10)
tree = await settle()
ok('再点一次是整组撤出索引（unstage，路径是组里此刻的三条）',
  groupAsk != null && groupAsk.method === 'git/unstage'
  && groupAsk.args.paths.slice().sort().join(',') === 'newdir/a.txt,newdir/deep/b.txt,tmp.bin')
ok('撤出之后这一组照样在，框回到空的',
  groupRow(tree, '新增的文件') !== undefined
  && textOf(groupBox(tree, '新增的文件')) === '☐'
  && changeRow(tree, 'tmp.bin') !== undefined)
ok('撤出之后组里的条目回到未跟踪（同一组，框都是空的）',
  membersOf(tree, '新增的文件').some(function (x) { return x.indexOf('a.txt') >= 0 })
  && membersOf(tree, '新增的文件').some(function (x) { return x.indexOf('tmp.bin') >= 0 }))

host.call = groupSaved
await wait(10)
tree = await settle()

/* ── 12. 未跟踪的条目：字符串形状也要认 ──

   git 的未跟踪列表在这一半有两种形状：Host 现在返回对象 `{path, code}`，但裸字符串一直
   也是合法的（这个套件自己的 mock 用的就是字符串）。`mergeChanges` 两种都认，另外两个读
   这些列表的地方不认 —— 它们直接读 `entry.path`，在字符串上是 `undefined`，于是**按路径
   的读永远盖不掉一条字符串条目**：勾上一个未跟踪目录、它的文件已经进了索引，那条折叠的
   目录行还留在「新增的文件」里（量到过：十个框说「共 6 个文件」，一边是暂存好的文件、
   一边是同名的目录），而 `pathsOfInterest` 在一棵「全是未跟踪」的树上会回答「没有要问的
   路径」，把省时间的那次按路径读变回整棵树的 `git status`。

   这一节用一个和 Host 一样回答的 mock（`partial: true` + `paths` + 只关于这些路径的列表）
   来钉它：暂存一个未跟踪目录之后，那条目录行必须消失。 */
console.log('')
console.log('== 未跟踪条目：两种形状 ==')
fibers.clear()
tree = await openPanel()
press(tabBtn(tree, '变更'), 'onClick')
await wait(10)
tree = await settle()

ok('前提：未跟踪目录在新增那一组里',
  membersOf(tree, '新增的文件').some(function (x) { return x.indexOf('newdir/') >= 0 })
  && membersOf(tree, '新增的文件').some(function (x) { return x.indexOf('tmp.bin') >= 0 }))

const shapeSaved = host.call
host.call = function (method, args) {
  if (method === 'git/panel' && args != null && args.quick !== true && Array.isArray(args.paths)) {
    calls.push({ method: method, args: args })
    const staged = []
    const untracked = []
    for (let i = 0; i < args.paths.length; i += 1) {
      const p = args.paths[i]
      if (p === 'newdir/') {
        staged.push({ path: 'newdir/a.txt', code: 'A.' }, { path: 'newdir/deep/b.txt', code: 'A.' })
      } else {
        untracked.push({ path: p, code: '??' })
      }
    }
    return Promise.resolve({
      ok: true, partial: true, paths: args.paths, repo: '/tmp/ws', branch: 'main', detached: false,
      upstream: '', ahead: 0, behind: 0, sequencer: null,
      staged: staged, unstaged: [], untracked: untracked, unmerged: [],
    })
  }
  return shapeSaved(method, args)
}
const shapeDir = changeRow(tree, 'newdir/')
if (shapeDir !== undefined) byClass(shapeDir, 'dsh-git-cbox')[0].props.onClick({ stopPropagation: function () {} })
await wait(30)
tree = await settle()
host.call = shapeSaved

ok('暂存未跟踪目录：里面的文件出现在**同一组**里（索引里的 A… 也算新文件）',
  membersOf(tree, '新增的文件').some(function (x) { return x.indexOf('a.txt') >= 0 })
  && membersOf(tree, '默认变更列表').every(function (x) { return x.indexOf('a.txt') < 0 }))
ok('而那条折叠的目录行不在这一组里了（按路径的读盖得掉字符串条目）',
  membersOf(tree, '新增的文件').every(function (x) { return x.indexOf('newdir/') < 0 }))
ok('同一次读没动别的路径（tmp.bin 还在未跟踪里）',
  membersOf(tree, '新增的文件').some(function (x) { return x.indexOf('tmp.bin') >= 0 }))

/* 三处读未跟踪列表的地方必须走同一个读法。按路径的读（`mergePanelStatus`）和
   「要问哪些路径」（`pathsOfInterest`）都要认字符串形状 —— 少了前者，条目永远盖不掉；
   少了后者，一棵全是未跟踪路径的树会让这条捷径回答「没有要问的」，把省时间的按路径读
   变回整棵树的 `git status`。 */
ok('按路径的读和「问哪些路径」都走 entryPath（一个读法，两种形状）',
  /function mergePanelStatus[\s\S]{0,1600}entryPath\(/.test(panelCss)
  && /function pathsOfInterest[\s\S]{0,1600}entryPath\(/.test(panelCss)
  && /function stageLocally[\s\S]{0,1600}entryPath\(/.test(panelCss))

/* ── 13. 勾一下只动那一行 ──

   读者看着运行中的面板说「还是有点闪动」。一帧一帧量过之后，闪的是三处，都不是点击
   本身：

   1. 整个面板变暗。勾一下会抬起面板级的 `busy`，而 `busy` 是全局的：头部四个工具和
      提交按钮在它挂着的时候按 40–45% 不透明度渲染，提交按钮的文字还换成「处理中…」
      （宽度一变，右边整块跟着动）。`git add` 在这台机器上是 98–236ms，所以每勾一下，
      工具条和提交那一栏都闪一次。
   2. 那一行自己会跳。`mergeChanges` 的次序来自 git 回答的列表（索引在前、工作区次之、
      未跟踪最后），于是条目在列表里的位置说明了它来自哪个列表；勾上 = 进索引 = 挪到本组
      最前面。量到：三个新文件里勾第二个，这一组从 `[tmp.bin, zztail.bin, newdir/]`
      重画成 `[zztail.bin, tmp.bin, newdir/]`，取消勾选再挪一次。
   3. 取消勾选时那一行会**跳到另一组再跳回来**。`stageLocally` 的「回到未跟踪」分支比的
      是整串 `indexCode === 'A'`，而 Host 报的是 porcelain 的两个字母 `A.` / `AM`（同一
      份代码里 `isNewFile` 走的是首字母）。于是取消勾选被预测成「工作区改了」，行落进
      默认变更列表，等 `git restore --staged` 和它后面那次读回来才跳回新增的文件。

   这一节把三件事都钉住：行的次序只由路径决定，勾一下不碰面板级的任何东西，取消勾选
   预测的是「回到未跟踪」。用的 mock 和 Host 一样回答 `partial`（按路径的问法），并且
   按帧渲染 —— 变暗和跳组都只发生在中途那一两帧里，settle 之后是看不见的。 */
console.log('')
console.log('== 勾一下只动那一行 ==')

const rowsInGroup = function (t, label) {
  const rws = byClass(t, 'dsh-git-trow')
  const out = []
  let cur = ''
  for (let i = 0; i < rws.length; i += 1) {
    if (String(rws[i].props.className).indexOf('dsh-git-cgroup') >= 0) { cur = textOf(rws[i]); continue }
    if (cur.indexOf(label) >= 0) {
      /* 名字那一格，不是整行的文字：行里还有框、状态字母（? → A 正是勾选该做的事），
         次序要比的是「哪个文件在第几个」，那些都不是位置。 */
      const cell = byClass(rws[i], 'dsh-git-tname')[0]
      out.push(cell === undefined ? textOf(rws[i]) : textOf(cell))
    }
  }
  return out
}
const dimmedTools = function (t) {
  return byClass(t, 'dsh-git-tool').filter(function (b) { return b.props.disabled === true }).length
}
const primaryText = function (t) {
  const b = byClass(t, 'dsh-git-primary')[0]
  return b === undefined ? '' : textOf(b)
}
const sameOrder = function (a, b) {
  return a.length === b.length && a.every(function (x, i) { return x === b[i] })
}

/* 一个有状态的 mock 仓库：勾了会记得，按路径读只回答被问到的路径。 */
const tickState = {
  staged: [{ path: 'src/app.js', code: 'M.' }],
  unstaged: [{ path: 'src/app.js', code: 'M.' }, { path: 'notes.md', code: 'M.' }],
  untracked: [{ path: 'tmp.bin', code: '??' }, { path: 'zztail.bin', code: '??' }, { path: 'newdir/', code: '??' }],
}
const tickIdentity = {
  ok: true, repo: '/tmp/ws', branch: 'main', detached: false,
  upstream: 'origin/main', ahead: 0, behind: 0, sequencer: null,
}
const tickReply = function (paths) {
  const wanted = function (p) {
    for (let i = 0; i < paths.length; i += 1) {
      const one = paths[i]
      if (p === one) return true
      if (one.slice(-1) === '/' && p.indexOf(one) === 0) return true
    }
    return false
  }
  const pick = function (entries) {
    return entries.filter(function (e) { return wanted(e.path) }).map(function (e) { return { path: e.path, code: e.code } })
  }
  return Object.assign({}, tickIdentity, {
    partial: true, paths: paths,
    staged: pick(tickState.staged), unstaged: pick(tickState.unstaged),
    untracked: pick(tickState.untracked), unmerged: [],
  })
}
const tickWhole = function () {
  return Object.assign({}, tickIdentity, {
    staged: tickState.staged.slice(), unstaged: tickState.unstaged.slice(),
    untracked: tickState.untracked.slice(), unmerged: [],
  })
}
const heldStage = []
const heldTickRead = []
const tickSaved = host.call
host.call = function (method, args) {
  if (method === 'git/panel') {
    calls.push({ method: method, args: args })
    if (args != null && args.quick === true) return Promise.resolve(tickIdentity)
    if (args != null && Array.isArray(args.paths)) {
      return new Promise(function (resolve) { heldTickRead.push({ paths: args.paths, resolve: resolve }) })
    }
    return Promise.resolve(tickWhole())
  }
  if (method === 'git/stage' || method === 'git/unstage') {
    calls.push({ method: method, args: args })
    return new Promise(function (resolve) { heldStage.push({ method: method, args: args, resolve: resolve }) })
  }
  return tickSaved(method, args)
}
const applyHeldStage = function (entry) {
  const paths = entry.args.paths
  for (let i = 0; i < paths.length; i += 1) {
    const p = paths[i]
    const drop = function (list) { for (let k = list.length - 1; k >= 0; k -= 1) if (list[k].path === p) list.splice(k, 1) }
    drop(tickState.staged); drop(tickState.unstaged); drop(tickState.untracked)
    if (entry.method === 'git/stage') {
      if (p.slice(-1) === '/') tickState.staged.push({ path: p + 'a.txt', code: 'A.' }, { path: p + 'deep/b.txt', code: 'A.' })
      else tickState.staged.push({ path: p, code: 'A.' })
    } else {
      tickState.untracked.push({ path: p, code: '??' })
    }
  }
}
const answerStage = function () {
  const done = heldStage.splice(0)
  for (let i = 0; i < done.length; i += 1) {
    applyHeldStage(done[i])
    done[i].resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
  }
  return done.length
}
const answerTickReads = function () {
  const pending = heldTickRead.splice(0)
  for (let i = 0; i < pending.length; i += 1) pending[i].resolve(tickReply(pending[i].paths))
  return pending.length
}
const tickElement = function () { return makeElement(popover, { sessionId: 's-1' }) }
const targetTickReads = function () {
  return calls.filter(function (c) {
    return c.method === 'git/panel' && c.args.quick !== true && Array.isArray(c.args.paths)
  })
}

fibers.clear()
tree = await openPanel()
press(tabBtn(tree, '变更'), 'onClick')
await wait(10)
tree = await settle()

ok('前提：两组都按路径排，和索引状态无关（新增那一组是 newdir/ · tmp.bin · zztail.bin）',
  sameOrder(rowsInGroup(tree, '新增的文件'), ['newdir/', 'tmp.bin', 'zztail.bin'])
  && sameOrder(rowsInGroup(tree, '默认变更列表'), ['src', 'app.js', 'notes.md']))

const tickOn = async function (label) {
  const row = changeRow(tree, label)
  const box = row === undefined ? undefined : byClass(row, 'dsh-git-cbox')[0]
  if (box === undefined) return null
  calls.length = 0
  box.props.onClick({ stopPropagation: function () {} })
  const frame1 = renderRoot(tickElement(), 'pop')
  await wait(1)
  const sent = answerStage()
  await wait(1)
  const frame2 = renderRoot(tickElement(), 'pop')
  const reads = answerTickReads()
  await wait(20)
  tree = await settle()
  return { sent: sent, reads: reads, frame1: frame1, frame2: frame2, frame3: tree, calls: calls.slice() }
}

/* ── 勾上 ── */
const orderBefore = rowsInGroup(tree, '新增的文件')
const on = await tickOn('zztail.bin')
ok('勾上：一次 git/stage，路径正好是那一条',
  on !== null && on.sent === 1
  && on.calls.filter(function (c) { return c.method === 'git/stage' })[0].args.paths.join(',') === 'zztail.bin')
ok('勾上：随后照旧有一次按路径的确认读（问的就是这一条）',
  on !== null && on.reads >= 1
  && on.calls.filter(function (c) { return c.method === 'git/panel' && Array.isArray(c.args.paths) })[0].args.paths.join(',') === 'zztail.bin')
ok('勾上：三帧里那一行的位置一模一样（行序只由路径决定）',
  on !== null && sameOrder(rowsInGroup(on.frame1, '新增的文件'), orderBefore)
  && sameOrder(rowsInGroup(on.frame2, '新增的文件'), orderBefore)
  && sameOrder(rowsInGroup(on.frame3, '新增的文件'), orderBefore))
ok('勾上：它还在新增的文件里，只是框变成 ☑',
  on !== null && glyphOf(changeRow(on.frame1, 'zztail.bin')) === '☑'
  && rowsInGroup(on.frame3, '新增的文件').indexOf('zztail.bin') >= 0
  && membersOf(on.frame3, '默认变更列表').every(function (x) { return x.indexOf('zztail.bin') < 0 }))
ok('勾上：这一刻面板没有变暗 —— 头部没有工具被禁用',
  on !== null && dimmedTools(on.frame1) === 0)
ok('勾上：提交按钮还是那句话，没有变成「处理中…」',
  on !== null && primaryText(on.frame1).indexOf('提交') === 0
  && primaryText(on.frame1).indexOf('处理中') < 0)

/* ── 取消勾选：这一行不许跳进另一组再跳回来 ── */
const off = await tickOn('zztail.bin')
ok('取消勾选：一次 git/unstage',
  off !== null && off.sent === 1
  && off.calls.filter(function (c) { return c.method === 'git/unstage' })[0].args.paths.join(',') === 'zztail.bin')
ok('取消勾选：预测的是「回到未跟踪」（A. 也要认，以前只认裸 A）',
  off !== null && glyphOf(changeRow(off.frame1, 'zztail.bin')) === '☐'
  && textOf(byClass(changeRow(off.frame1, 'zztail.bin'), 'dsh-git-st')[0]) === '?'
  && membersOf(off.frame1, '默认变更列表').every(function (x) { return x.indexOf('zztail.bin') < 0 }))
ok('取消勾选：三帧都不动，它留在原处',
  off !== null && sameOrder(rowsInGroup(off.frame1, '新增的文件'), orderBefore)
  && sameOrder(rowsInGroup(off.frame2, '新增的文件'), orderBefore)
  && sameOrder(rowsInGroup(off.frame3, '新增的文件'), orderBefore))
ok('取消勾选：面板同样没有变暗，按钮也没换字',
  off !== null && dimmedTools(off.frame1) === 0 && primaryText(off.frame1).indexOf('处理中') < 0)

/* ── 提交排在勾选后面 ──
   `busy` 以前是提交按钮的锁（勾选在飞的时候它按不动），撤掉它就得把这把锁换个地方：
   命令按点击顺序排队，提交排在前面那次勾选后面。 */
const commitOrder = await (async function () {
  const box = byClass(changeRow(tree, 'tmp.bin'), 'dsh-git-cbox')[0]
  calls.length = 0
  box.props.onClick({ stopPropagation: function () {} })
  await wait(1)
  const textarea = collect(tree).filter(function (n) { return n.type === 'textarea' })[0]
  if (textarea !== undefined) textarea.props.onChange({ target: { value: '把这次勾上提交掉' } })
  await wait(5)
  tree = await settle()
  const button = byClass(tree, 'dsh-git-primary')[0]
  const enabled = button !== undefined && button.props.disabled !== true
  if (enabled) button.props.onClick()
  await wait(5)
  const beforeAnswer = calls.map(function (c) { return c.method })
  const sent = answerStage()
  await wait(10)
  answerTickReads()
  await wait(20)
  tree = await settle()
  return { enabled: enabled, beforeAnswer: beforeAnswer, sent: sent, after: calls.map(function (c) { return c.method }) }
})()
ok('勾选在飞的时候提交按钮是可按的（不再靠禁用闪一下来挡）', commitOrder.enabled)
ok('但那一次提交还没发出去（排队等前面那次勾选）',
  commitOrder.beforeAnswer.indexOf('git/commit') < 0)
ok('勾选一被回答，提交才跟着发出去（顺序不会反）',
  commitOrder.sent === 1 && commitOrder.after.indexOf('git/commit') > commitOrder.after.indexOf('git/unstage'))

/* 同一个判据只能有一处：「这个路径是新增吗」。分组规则（isNewFile）和取消勾选的预测
   （stageLocally）必须问同一个问题，不然两种字母形状又会各认各的。 */
ok('「是不是新增」只有一个读法（isNewFile 和 stageLocally 都走 addedInIndex）',
  /function addedInIndex[\s\S]{0,200}slice\(0, 1\) === 'A'/.test(panelCss)
  && /function isNewFile[\s\S]{0,400}addedInIndex\(/.test(panelCss)
  && /function stageLocally[\s\S]{0,2000}addedInIndex\(/.test(panelCss))

host.call = tickSaved

/* ═══ 14. 提交下的文件列表：目录行 ═══
   提交的文件列表和左侧的树画的是同一种目录行（同一个 `treeDirRow`）。这一节把
   「同一种」钉住：以前没有任何一套件画过它 —— 每个套件给 `git/commit-detail` 的
   files 都是一层的，目录行只有树那边有断言，所以那一份复制品可以静静地偏离。 */
console.log('')
console.log('== 提交下的文件列表：目录行 ==')
const detailSaved = host.call
host.call = function (method, args) {
  if (method === 'git/commit-detail') {
    return Promise.resolve({
      ok: true, repo: '/tmp/ws', hash: (args && args.hash) || 'aaa111',
      subject: 'detail subject', body: '', author: 'mays', date: '2026-09-16T10:00:00',
      files: [
        { status: 'M', path: 'deep/inner/app.js', from: null },
        { status: 'A', path: 'deep/README.md', from: null },
        { status: 'M', path: 'notes.md', from: null },
      ],
      branches: ['main'],
    })
  }
  return detailSaved(method, args)
}
press(buttons(tree).find(function (b) { return textOf(b).indexOf('历史') >= 0 }), 'onClick')
await wait(10)
tree = await settle()
press(byClass(tree, 'dsh-git-crow')[0], 'onClick')
await wait(10)
tree = await settle()

const paneOf = function (t) { return byClass(t, 'dsh-git-detail')[0] }
const paneRows = function (t) { return byClass(paneOf(t), 'dsh-git-trow') }
/* 目录行带一个条数（`dsh-git-tdim`），文件行带状态字母 —— 这是两者的分界 */
const paneDir = function (t, name) {
  return paneRows(t).filter(function (r) {
    return byClass(r, 'dsh-git-tdim').length === 1 && textOf(r).indexOf(name) >= 0
  })[0]
}
const paneFile = function (t, name) {
  return paneRows(t).filter(function (r) {
    return byClass(r, 'dsh-git-tdim').length === 0 && textOf(r).indexOf(name) >= 0
  })[0]
}
const deepDir = paneDir(tree, 'deep')
ok('提交的文件列表里画出了目录行', deepDir !== undefined && paneDir(tree, 'inner') !== undefined)
ok('目录行的条数说得清是什么的条数',
  deepDir !== undefined && textOf(byClass(deepDir, 'dsh-git-tdim')[0]) === '2 个文件')
ok('缩进按层级来（deep 6px，inner 18px）',
  deepDir !== undefined && paneDir(tree, 'inner') !== undefined
  && String(deepDir.props.style.paddingLeft) === '6px'
  && String(paneDir(tree, 'inner').props.style.paddingLeft) === '18px')

press(deepDir, 'onClick')
await wait(10)
tree = await settle()
ok('单击目录行：只选中，不折叠（里面的行都还在）',
  paneDir(tree, 'deep') !== undefined
  && String(paneDir(tree, 'deep').props.className).indexOf('dsh-git-trow-sel') >= 0
  && paneDir(tree, 'inner') !== undefined && paneFile(tree, 'notes.md') !== undefined)

press(paneDir(tree, 'deep'), 'onDoubleClick')
await wait(10)
tree = await settle()
ok('双击目录行：这一层折起来（深处的行不见了，别的还在）',
  paneDir(tree, 'deep') !== undefined
  && paneDir(tree, 'inner') === undefined
  && paneFile(tree, 'notes.md') !== undefined)

press(paneDir(tree, 'deep'), 'onDoubleClick')
await wait(10)
tree = await settle()
ok('再双击展开：深处的行回来了', paneDir(tree, 'inner') !== undefined)

/* 一处构造，两个调用点。谁再把它抄回去一份，这里就会红。 */
ok('目录行只有一份构造，两个调用点（分支树和提交文件列表）',
  (panelCss.match(/function treeDirRow/g) || []).length === 1
  && (panelCss.match(/push\(treeDirRow\(node, props,/g) || []).length === 2)

const beforeDetailDiff = diffCalls.length
press(paneFile(tree, 'app.js'), 'onClick')
await wait(10)
tree = await settle()
ok('从提交的文件列表点开的是那次提交的差异',
  diffCalls.length - beforeDetailDiff === 1
  && diffCalls[diffCalls.length - 1].mode === 'commit'
  && diffCalls[diffCalls.length - 1].ref === 'aaa111'
  && diffCalls[diffCalls.length - 1].path === 'deep/inner/app.js')
host.call = detailSaved

/* ═══ 15. 提交身份：提交被拒的原因不在仓库里 ═══
   `git commit` 在没有作者身份时整个失败，而 git 为它印八行英文（"Author identity
   unknown"、"Run git config --global …"、最后一行才是拒绝本身）。判据在 Host 那
   边（`git var GIT_AUTHOR_IDENT` 的回答），这里管的是它到界面上有没有变成能照抄
   的命令 —— 以及在没这回事的仓库里，这几句话一个字都不许多出来。 */

const identSaved = host.call
let panelIdent = false
let commitReply = { ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 }
host.call = function (method, args) {
  if (method === 'git/commit') return Promise.resolve(commitReply)
  const answered = identSaved(method, args)
  if (method !== 'git/panel' || args == null || args.quick === true) return answered
  return answered.then(function (reply) {
    return panelIdent === true ? Object.assign({}, reply, { needsIdentity: true }) : reply
  })
}
/* 面板的整树读挂在 30 秒的时钟上（没有刷新键）：直接推一下那个时钟，和读者等它
   自己到点是同一条路。 */
const tickAll = function () {
  timers.filter(function (t) { return t.kind === 'interval' && t.dead !== true })
    .forEach(function (t) { t.cb() })
}
const identityHint = function (t) {
  return byClass(t, 'dsh-git-warn').filter(function (n) { return textOf(n).indexOf('提交身份') >= 0 })[0]
}
const errorStrip = function (t) {
  return collect(t).filter(function (n) { return n.props.className === 'dsh-git-error' })[0]
}
const sendCommit = async function (message) {
  const area = collect(tree).filter(function (n) { return n.type === 'textarea' })[0]
  if (area !== undefined) area.props.onChange({ target: { value: message } })
  await wait(5)
  tree = await settle()
  press(byClass(tree, 'dsh-git-primary')[0], 'onClick')
  await wait(10)
  return await settle()
}

press(buttons(tree).find(function (b) { return textOf(b).indexOf('变更') >= 0 }), 'onClick')
await wait(10)
tree = await settle()

panelIdent = true
tickAll()
await wait(10)
tree = await settle()
console.log('')
console.log('== 提交区先说清楚 ==')
ok('没有身份时，写提交信息之前提交区就说出来了（不是等被 git 拒一次）', identityHint(tree) !== undefined)
ok('那句话里是能照抄的两条命令，不是「请配置 git 身份」这种没有下一步的话',
  textOf(identityHint(tree) || {}).indexOf('git config --global user.name') > 0
  && textOf(identityHint(tree) || {}).indexOf('git config --global user.email') > 0)

commitReply = {
  /* `needsIdentity` 是 Host 的答复里带的那个判据（`git var GIT_AUTHOR_IDENT`
     的回答），界面这一侧只负责把它翻成能照抄的话。 */
  ok: false, exitCode: 128, needsIdentity: true, stdout: '',
  stderr: 'Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n'
    + '  git config --global user.email "you@example.com"\n'
    + '  git config --global user.name "Your Name"\n\n'
    + 'to set your account\'s default identity.\n'
    + 'Omit --global to set the identity only in this repository.\n\n'
    + 'fatal: empty ident name (for <mayou@MAYS.localdomain>) not allowed\n',
}
tree = await sendCommit('试一次提交')
const strip = errorStrip(tree)
console.log('  错误条:', JSON.stringify(textOf(strip)))
ok('提交被拒时，错误条里就是那两条命令', strip !== undefined
  && textOf(strip).indexOf('git config --global user.name "你的名字"') > 0)
ok('git 自己的最后一行还在下面（身份缺失不一定是一次提交失败的唯一原因）',
  textOf(strip).indexOf('fatal: empty ident name (for <mayou@MAYS.localdomain>) not allowed') > 0)
ok('错误条按行显示（两条命令不能挤成一句话）',
  strip !== undefined && strip.props.style.whiteSpace === 'pre-wrap')

/* 负对照：别的失败不许被说成身份问题 —— 判据写松了（比如只看「提交失败了」和
   「git var 说没有身份」两件事）就会在这里红，而不是等读者被指去改一个没坏的东西。 */
commitReply = { ok: false, exitCode: 1, stdout: '', stderr: 'fatal: 别的什么地方坏了\n' }
tree = await sendCommit('再试一次')
ok('（对照）不是身份的失败，错误条里只有 git 自己那句话',
  textOf(errorStrip(tree)) === 'fatal: 别的什么地方坏了')

panelIdent = false
tickAll()
await wait(10)
tree = await settle()
ok('（对照）有身份的仓库里，提交区一个字都不多出来', identityHint(tree) === undefined)

host.call = identSaved

/* ═══ 16. 差异头部的「查看文件」：把这一个文件交给官方右侧文件页 ═══
   补丁回答「改成了什么样」，有时读者要的是整个文件 —— DSH 官方右侧的文件页
   （ctx.reflect 的 'sidebarRight' 服务）本来就是干这个的，头部按钮只负责把地址递
   过去。地址必须与官方 sessionFileAddress 逐字一致（反斜杠归一、去前导 ./，
   sessionId 与路径按 / 分段 encodeURIComponent、%3A 还原为 ':'），三道守卫（服务
   在、会话工作区已知、绝对路径在工作区内）任何一道不过就不画按钮；点击时
   openResource 抛什么都只进控制台，绝不能把面板点崩。 */

console.log('')
console.log('== 头部的「查看文件」==')

/* ctx.get 是套件与插件共用的那一格：sidebarRight 之外的名字照旧走原来的表，装与
   拆都换 sideService 这一个变量 —— 「服务不在」随时可以恢复。替身只记录收到的
   地址，别的什么都不做。 */
const baseCtxGet = ctx.get
const openedFiles = []
let sideService = null
ctx.get = function (name) {
  if (name === 'sidebarRight') return sideService
  return baseCtxGet(name)
}

/* 从变更页点开 src/app.js 的差异。此刻 ctx 认不得 sidebarRight，git/repos 也从没
   答出过工作区 —— 正是两道守卫一起缺席的样子。 */
const openAppDiff = async function () {
  press(buttons(tree).find(function (b) { return textOf(b).indexOf('变更') >= 0 }), 'onClick')
  await wait(10)
  tree = await settle()
  const row = changeRow(tree, 'app.js')
  row.props.onClick()
  await wait(10)
  tree = await settle()
}
await openAppDiff()
ok('官方服务不在（老版 dsh / bridge）：头部没有「查看文件」按钮',
  buttons(tree).every(function (b) { return textOf(b) !== '查看文件' }))

/* 会话工作区落地。真实的扫描（ensureWorkspaceRepos）在第一次开面板时就问过了，
   替身当时照基座的默认答了一份没有 workspace 的 ok —— repoScanAsked 已经把「s-1
   问过了」记死，重扫不会再发。改走同一扇会落 adoptReposReply 的门：变更页左栏
   仓库侧栏的「添加目录」，git/repos-save 的答复带着整份清单（含 workspace）——
   和读者手动登记仓库、答复落地是同一条路。 */
const viewSavedCall = host.call
host.call = function (method, args) {
  if (method === 'git/repos-save') {
    return Promise.resolve({ ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws'], manual: ['/tmp/ws'], missing: [], truncated: false })
  }
  return viewSavedCall(method, args)
}
press(buttons(tree).find(function (b) { return textOf(b).indexOf('变更') >= 0 }), 'onClick')
await wait(10)
tree = await settle()
const addRepoRow = collect(tree).filter(function (n) { return n.props.className === 'dsh-git-repo-add' })[0]
ok('（前情）变更页左栏有「添加目录」那一行（工作区还没落地，扫描失败话也在）',
  addRepoRow !== undefined && textOf(tree).indexOf('扫描失败') >= 0)
addRepoRow.props.onClick()
await wait(10)
tree = await settle()
const repoInput = byClass(tree, 'dsh-git-repo-input')[0]
repoInput.props.onChange({ target: { value: '/tmp/ws' } })
await wait(10)
tree = await settle()
buttons(tree).find(function (b) { return textOf(b) === '添加' }).props.onClick()
await wait(20)
tree = await settle()
host.call = viewSavedCall
ok('登记落地：扫描失败的话被带 workspace 的清单换掉了（工作区从此已知）',
  textOf(tree).indexOf('扫描失败') < 0)

/* 服务在但不像话（openResource 不是函数）与「拿不到服务」同罪：按钮都不画。 */
sideService = { nope: true }
await openAppDiff()
ok('服务在但 openResource 不是函数：头部也没有「查看文件」按钮',
  buttons(tree).every(function (b) { return textOf(b) !== '查看文件' }))

/* 正式替身：记录地址的 openResource。 */
sideService = { openResource: function (address) { openedFiles.push(address) } }
await openAppDiff()
const fileBtn = buttons(tree).find(function (b) { return textOf(b) === '查看文件' })
ok('服务在、工作区已知：头部有「查看文件」按钮', fileBtn !== undefined)
ok('按钮是「暂存」同款的文字按钮（同一个 dsh-git-btn）',
  fileBtn !== undefined && fileBtn.props.className === 'dsh-git-btn')
ok('title 说出双重语义：完整文件、工作区当前内容（提交那一路打开的也是这一版）',
  fileBtn !== undefined && String(fileBtn.props.title).indexOf('完整文件') >= 0
  && String(fileBtn.props.title).indexOf('工作区当前内容') >= 0
  && String(fileBtn.props.title).indexOf('提交') >= 0)
const headNode = byClass(tree, 'dsh-git-diffhead')[0]
const headTexts = headNode.props.children.map(function (c) { return textOf(c) })
ok('按钮排在「暂存」之后、⟳ 之前（右上角那一排的既有顺序不动）',
  headTexts.indexOf('查看文件') > headTexts.indexOf('取消暂存')
  && headTexts.indexOf('查看文件') < headTexts.indexOf('⟳'))

const hostCallsBefore = calls.length
fileBtn.props.onClick()
await wait(10)
ok('点击把官方地址逐字符递给 openResource（绝对路径按 / 分段编码，sessionId 同一口径）',
  openedFiles.length === 1 && openedFiles[0] === 'dsh-resource://file/session/s-1//tmp/ws/src/app.js')
ok('打开是纯客户端的事，一个 host 调用都没发', calls.length === hostCallsBefore)

/* openResource 抛了：原话进控制台（带 dsh-git-idea: 前缀），界面一个字节不动。 */
const realError = console.error
const consoleErrors = []
console.error = function () { consoleErrors.push(Array.prototype.slice.call(arguments)) }
sideService = { openResource: function () { throw new Error('sidebar unavailable') } }
tree = await settle()
buttons(tree).find(function (b) { return textOf(b) === '查看文件' }).props.onClick()
await wait(10)
console.error = realError
sideService = { openResource: function (address) { openedFiles.push(address) } }
ok('openResource 抛错只进控制台，前缀是 dsh-git-idea:',
  consoleErrors.length === 1 && String(consoleErrors[0][0]).indexOf('dsh-git-idea:') === 0
  && String(consoleErrors[0][1]).indexOf('sidebar unavailable') >= 0)
tree = await settle()
ok('抛错之后差异界面照常在（头部、补丁、右列都没少）',
  byClass(tree, 'dsh-git-diffview').length === 1
  && byClass(tree, 'dsh-git-diffpath').length === 1
  && byClass(tree, 'dsh-git-diffrail').length === 1)

/* 提交那一路：同一个按钮、同一套地址 —— 打开的同样是工作区里的当前内容。 */
toolByTitle(tree, '返回文件列表').props.onClick()
await wait(10)
tree = await settle()
buttons(tree).find(function (b) { return textOf(b).indexOf('历史') >= 0 }).props.onClick()
await wait(10)
tree = await settle()
byClass(tree, 'dsh-git-crow')[0].props.onClick()
await wait(10)
tree = await settle()
const commitFileRow = changeRow(tree, 'new.txt')
ok('提交详情里列出了 new.txt', commitFileRow !== undefined)
commitFileRow.props.onClick()
await wait(10)
tree = await settle()
const commitViewBtn = buttons(tree).find(function (b) { return textOf(b) === '查看文件' })
ok('提交那一路的头部也有「查看文件」（这一路没有暂存按钮，按钮跟在计数后面）',
  commitViewBtn !== undefined && commitViewBtn.props.className === 'dsh-git-btn')
const beforeCommitClick = openedFiles.length
commitViewBtn.props.onClick()
await wait(10)
ok('提交文件的地址同样逐字符正确（工作区根 + 提交里的路径）',
  openedFiles.length === beforeCommitClick + 1
  && openedFiles[openedFiles.length - 1] === 'dsh-resource://file/session/s-1//tmp/ws/new.txt')

/* 第三道守卫：绝对路径越出会话工作区（手动登记过工作区外的仓库、生效仓库切过去
   时会发生）。快读答一个工作区外的仓库，推一下变更页的时钟让 work.repo 换新 ——
   打开差异后按钮消失；仓库回到工作区内，同一个打开着的差异上按钮回来。守卫审的
   和点击打开的必须是同一个绝对路径，所以审不过就不画。 */
press(buttons(tree).find(function (b) { return textOf(b).indexOf('变更') >= 0 }), 'onClick')
await wait(10)
tree = await settle()
const outsideSaved = host.call
host.call = function (method, args) {
  if (method === 'git/panel' && args != null && args.quick === true) {
    return Promise.resolve({ ok: true, repo: '/opt/elsewhere', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0, sequencer: null })
  }
  return outsideSaved(method, args)
}
tickAll()
await wait(10)
tree = await settle()
await openAppDiff()
ok('绝对路径（生效仓库 + 文件路径）越出会话工作区：按钮不画（官方 Host 拒读工作区外的路径）',
  buttons(tree).every(function (b) { return textOf(b) !== '查看文件' }))
host.call = outsideSaved
tickAll()
await wait(10)
tree = await settle()
ok('仓库回到工作区内：还开着的这个差异上按钮回来了',
  buttons(tree).some(function (b) { return textOf(b) === '查看文件' }))

/* 源码规矩：编码那行必须与官方逐字相同，失败必须落在带前缀的 console.error。 */
const viewSource = sourceText.slice(sourceText.indexOf('function encodeFileSegment'), sourceText.indexOf('function DiffView'))
ok('地址段编码与官方一字不差（encodeURIComponent 之后把 %3A 还原为 \':\'）',
  viewSource.indexOf("encodeURIComponent(segment).replace(/%3A/gi, ':')") >= 0)
ok('三道守卫先于按钮：服务、工作区、越界检查都在 viewFileButton 里',
  viewSource.indexOf("typeof side.openResource !== 'function'") >= 0
  && viewSource.indexOf('workspaceOf(sessionId)') >= 0
  && viewSource.indexOf("absolute.indexOf(root + '/')") >= 0)

ctx.get = baseCtxGet
sideService = null
