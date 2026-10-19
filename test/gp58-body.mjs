/* ═══ gp58：历史页右键与多选（客户端这一半）═══
 *
 * 盯三片：
 *   1. 新外置的纯函数（80-panel.js 组件外那四个，从产物 client.js 里整段抽出来
 *      单独求值 —— gp50 对 53-merge3 的抽法）：ctxTargetHashes（右键动作的目标集：
 *      右键行在多选里且多选>1 = 整份 multiSel，否则右键那一条；返回的是拷贝）；
 *      graphSliceBetween（Shift 范围：锚点↔点击行按图序整段含两端，谁新谁旧都行，
 *      任一行不在眼前列表 = null 不猜）；selectionSpan（选区的「段」：图序 targets、
 *      连续与否看 parents 链、base=最旧一条的第一父、head=最新；选区有行不在图上
 *      或不足两条 = null）；hashShort（7 位短写）。
 *   2. Shift+点击范围多选（面板世界）：锚点→点击行整段含两端、selected 跟点击行、
 *      浏览器默认行为被拦下（preventDefault）；锚点不动 —— 连续两次扩选都从同一
 *      锚点算起；shift+ctrl 仍是 Ctrl 的逐条加减；无锚点（新挂的面板）与锚点行
 *      已不在图上（重读历史换段）都退化为普通单选，且把这一行立成新锚点。
 *   3. 菜单按选区收放：右键行在多选里 = 体检问整份选区、拣选/还原标「（n 条）」、
 *      发参按最旧→最新交出去；右键行不在多选 = 单条；「编辑提交消息…」要等体检
 *      （git/edit-check）答复落定才解禁 —— 右键后不落 await 的同步帧里必须还是
 *      置灰、title 说「正在检查」；答复 reachable=false 的那一行保持置灰并说出
 *      原因。 */

/* ── mock：图与体检答复都按段落给 ── */
const realCall58 = host.call
let editCheckReply58 = null
const editCheckCalls58 = []
host.call = function (method, args) {
  if (method === 'git/edit-check') {
    calls.push({ method: method, args: args })
    editCheckCalls58.push(args)
    const hashes = args != null && Array.isArray(args.hashes) ? args.hashes : []
    if (editCheckReply58 !== null) return Promise.resolve(editCheckReply58)
    return Promise.resolve({
      ok: true, repo: '/tmp/ws', head: 'h111111',
      checks: hashes.map((hash) => ({ hash: hash, reachable: true, pushed: false, isHead: hash === 'h111111', isRoot: hash === 'h444444' })),
    })
  }
  return realCall58(method, args)
}

/* graphCommits 是 harness 里 let 声明的模块变量：这里铺一条四提交的链，parents
 * 与真实图同形（新→旧：h1 是 HEAD，h1 的父是 h2 ……）。 */
graphCommits = [
  { hash: 'h111111', subject: 'tip one', author: 'mays', date: '2026-10-16', committedAt: nowSec - 60, refs: ['HEAD -> main'], parents: ['h222222'] },
  { hash: 'h222222', subject: 'two', author: 'mays', date: '2026-10-15', committedAt: nowSec - 3600, refs: [], parents: ['h333333'] },
  { hash: 'h333333', subject: 'three', author: 'mays', date: '2026-10-14', committedAt: nowSec - 7200, refs: [], parents: ['h444444'] },
  { hash: 'h444444', subject: 'root four', author: 'mays', date: '2026-10-13', committedAt: nowSec - 10800, refs: [], parents: [] },
]

console.log('')
console.log('== 产物里抽出来的纯函数：目标集 / 范围 / 选区段 ==')
const sourceText58 = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
const pureSource58 = sourceText58.slice(sourceText58.indexOf('function ctxTargetHashes'), sourceText58.indexOf('const panelAnchorBox'))
const pure58 = new Function('text', pureSource58
  + '; return { ctxTargetHashes: ctxTargetHashes, graphSliceBetween: graphSliceBetween, selectionSpan: selectionSpan, hashShort: hashShort }')(
  (value) => (value == null ? '' : String(value)))
const CHAIN = graphCommits

ok('四个函数都在产物里，且组件外只有这一份定义',
  typeof pure58.ctxTargetHashes === 'function' && typeof pure58.graphSliceBetween === 'function'
  && typeof pure58.selectionSpan === 'function' && typeof pure58.hashShort === 'function'
  && (sourceText58.match(/function ctxTargetHashes/g) || []).length === 1)

{
  const multi = ['h111111', 'h333333']
  const picked = pure58.ctxTargetHashes('h333333', multi)
  ok('右键行在多选里且多选>1：目标集 = 整份 multiSel（原序拷贝，不是同一个数组）',
    JSON.stringify(picked) === JSON.stringify(['h111111', 'h333333']) && picked !== multi)
  picked.push('x')
  ok('改返回值不动调用方的 multiSel（slice 出去的）', JSON.stringify(multi) === JSON.stringify(['h111111', 'h333333']))
  ok('右键行不在多选里：目标集就是右键那一条',
    JSON.stringify(pure58.ctxTargetHashes('h222222', multi)) === JSON.stringify(['h222222']))
  ok('multiSel 为空 / 只有一条：都是单条',
    JSON.stringify(pure58.ctxTargetHashes('h111111', [])) === JSON.stringify(['h111111'])
    && JSON.stringify(pure58.ctxTargetHashes('h111111', ['h111111'])) === JSON.stringify(['h111111'])
    && JSON.stringify(pure58.ctxTargetHashes('h111111', undefined)) === JSON.stringify(['h111111']))
}

{
  ok('范围按图序整段含两端：锚点新、点击旧（h2→h4 = [h2,h3,h4]）',
    JSON.stringify(pure58.graphSliceBetween(CHAIN, 'h222222', 'h444444')) === JSON.stringify(['h222222', 'h333333', 'h444444']))
  ok('反着点也一样：锚点旧、点击新（h3→h1 = [h1,h2,h3]）',
    JSON.stringify(pure58.graphSliceBetween(CHAIN, 'h333333', 'h111111')) === JSON.stringify(['h111111', 'h222222', 'h333333']))
  ok('点在锚点自己身上：单元素段', JSON.stringify(pure58.graphSliceBetween(CHAIN, 'h222222', 'h222222')) === JSON.stringify(['h222222']))
  ok('任一行不在眼前列表：null（调用方退化单选，不猜）',
    pure58.graphSliceBetween(CHAIN, 'gone', 'h111111') === null
    && pure58.graphSliceBetween(CHAIN, 'h111111', 'gone') === null)
  ok('列表本身不是数组：null', pure58.graphSliceBetween(null, 'h111111', 'h222222') === null)
}

{
  const span = pure58.selectionSpan(CHAIN, ['h222222', 'h333333'])
  ok('连续两跳：targets 按图序、contiguous=true、base=最旧一条的第一父、head=最新',
    JSON.stringify(span.targets) === JSON.stringify(['h222222', 'h333333'])
    && span.contiguous === true && span.base === 'h444444' && span.head === 'h222222')
  ok('乱序的 multiSel 也按图序整理（targets 只含选中的，不含中间未选的）',
    JSON.stringify(pure58.selectionSpan(CHAIN, ['h333333', 'h111111']).targets) === JSON.stringify(['h111111', 'h333333']))
  ok('中间隔一条未选：contiguous=false（parents 链断在没选的那条上）',
    pure58.selectionSpan(CHAIN, ['h111111', 'h333333']).contiguous === false)
  ok('选区里混着图上没有的行：null（合并查看与整段改写都不开）',
    pure58.selectionSpan(CHAIN, ['h111111', 'gone']) === null)
  ok('不足两条 / commits 不是数组：null',
    pure58.selectionSpan(CHAIN, ['h111111']) === null && pure58.selectionSpan(CHAIN, []) === null
    && pure58.selectionSpan(null, ['h111111', 'h222222']) === null)
  ok('最旧一条是根提交：base 为空串（整段改写无从谈起的信号）',
    pure58.selectionSpan(CHAIN, ['h333333', 'h444444']).base === '')
  ok('图上缺 parents 字段：按不连续算（不猜）',
    pure58.selectionSpan([{ hash: 'a' }, { hash: 'b' }], ['a', 'b']).contiguous === false)
}

ok('hashShort：7 位短写、短的照抄、空值归空串',
  pure58.hashShort('abc1234567') === 'abc1234' && pure58.hashShort('abc123') === 'abc123'
  && pure58.hashShort(null) === '' && pure58.hashShort(undefined) === '')

console.log('')
console.log('== Shift+点击范围多选：锚点、整段、退化 ==')
fibers.clear()
let t58 = await openPanel()
const crow58 = () => byClass(t58, 'dsh-git-crow')
const multi58 = () => byClass(t58, 'dsh-git-crow-multi')
const sel58 = () => byClass(t58, 'dsh-git-crow-sel')
const prevent = () => { let hit = false; return { event: { shiftKey: true, preventDefault() { hit = true } }, fired: () => hit } }

crow58()[1].props.onClick()
await wait(10)
t58 = await settle('pop')
ok('先普通点击 h2：单选（它同时是锚点）', sel58().length === 1 && multi58().length === 0)
const shiftEv = prevent()
crow58()[3].props.onClick(Object.assign({ shiftKey: true }, shiftEv.event, {}))
await wait(10)
t58 = await settle('pop')
ok('Shift+点击 h4：h2..h4 整段进多选（含两端，三行都带强调条）', multi58().length === 3)
ok('selected 跟点击行（h4），详情也跟着它走',
  sel58().length === 1 && textOf(sel58()[0]).indexOf('root four') >= 0
  && calls.filter((c) => c.method === 'git/commit-detail').slice(-1)[0].args.hash === 'h444444')
ok('浏览器的「扩展文字选区」被拦下（preventDefault 真的被调了）', shiftEv.fired() === true)

const shiftEv2 = prevent()
crow58()[0].props.onClick(Object.assign({ shiftKey: true }, shiftEv2.event, {}))
await wait(10)
t58 = await settle('pop')
ok('锚点不动：再 Shift+点击 h1，段是从 h2 算起的 [h1,h2]（不是从 h4）',
  multi58().length === 2 && textOf(crow58()[0]).indexOf('tip one') >= 0 && textOf(crow58()[1]).indexOf('two') >= 0
  && byClass(crow58()[2], 'dsh-git-crow-multi').length === 0)

crow58()[2].props.onClick({ shiftKey: true, ctrlKey: true })
await wait(10)
t58 = await settle('pop')
ok('shift+ctrl 还是 Ctrl 的语义：h3 单条进出多选，不拉一段',
  multi58().length === 3)

/* 无锚点的退化：新挂的面板第一下 Shift+点击就是普通单选。 */
fibers.clear()
graphCommits = [
  { hash: 'h111111', subject: 'tip one', author: 'mays', date: '2026-10-16', committedAt: nowSec - 60, refs: ['HEAD -> main'], parents: ['h222222'] },
  { hash: 'h222222', subject: 'two', author: 'mays', date: '2026-10-15', committedAt: nowSec - 3600, refs: [], parents: [] },
]
t58 = await openPanel()
crow58()[1].props.onClick({ shiftKey: true })
await wait(10)
t58 = await settle('pop')
ok('无锚点的新面板：Shift+点击退化为单选（还把这一行立成锚点）',
  multi58().length === 0 && sel58().length === 1 && textOf(sel58()[0]).indexOf('two') >= 0)

/* 锚点行不在图上了：重读历史换段之后，Shift 扩选不猜，退化为普通单选。 */
crow58()[0].props.onClick()
await wait(10)
t58 = await settle('pop')
graphCommits = [
  { hash: 'h111111', subject: 'tip one', author: 'mays', date: '2026-10-16', committedAt: nowSec - 60, refs: ['HEAD -> main'], parents: [] },
]
const refresh58 = byClass(t58, 'dsh-git-tool').find((b) => String(b.props.title).indexOf('重新读取仓库') === 0)
refresh58.props.onClick()
await wait(15)
t58 = await settle('pop')
ok('（铺垫）重读后图上只剩 h1，锚点 h2 已不在', crow58().length === 1 && multi58().length === 0)
crow58()[0].props.onClick({ shiftKey: true })
await wait(10)
t58 = await settle('pop')
ok('锚点行不在图上：Shift+点击退化单选（锚点挪到这一行，不猜一段）',
  multi58().length === 0 && sel58().length === 1)

console.log('')
console.log('== 菜单按选区收放：目标集、体检与置灰 ==')
fibers.clear()
graphCommits = [
  { hash: 'h111111', subject: 'tip one', author: 'mays', date: '2026-10-16', committedAt: nowSec - 60, refs: ['HEAD -> main'], parents: ['h222222'] },
  { hash: 'h222222', subject: 'two', author: 'mays', date: '2026-10-15', committedAt: nowSec - 3600, refs: [], parents: ['h333333'] },
  { hash: 'h333333', subject: 'three', author: 'mays', date: '2026-10-14', committedAt: nowSec - 7200, refs: [], parents: ['h444444'] },
  { hash: 'h444444', subject: 'root four', author: 'mays', date: '2026-10-13', committedAt: nowSec - 10800, refs: [], parents: [] },
]
t58 = await openPanel()
const ctxMenus58 = () => byClass(t58, 'dsh-git-menu')
const ctxItems58 = () => { const m = ctxMenus58()[0]; return m === undefined ? [] : buttons(m) }
const item58 = (label) => ctxItems58().find((b) => textOf(b) === label)
const rightClick58 = async (i) => {
  byClass(t58, 'dsh-git-crow')[i].props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 30, clientY: 40 })
  await wait(15)
  t58 = await settle('pop')
}

crow58()[1].props.onClick({ ctrlKey: true })
await wait(10)
t58 = await settle('pop')
crow58()[2].props.onClick({ ctrlKey: true })
await wait(10)
t58 = await settle('pop')
ok('铺垫：Ctrl 两行进多选（h2 + h3，图上连续的一段）', multi58().length === 2)
editCheckCalls58.length = 0
await rightClick58(2)
ok('右键行在多选里：体检问的是整份选区（[h222222, h333333]）',
  JSON.stringify(editCheckCalls58[editCheckCalls58.length - 1].hashes) === JSON.stringify(['h222222', 'h333333']))
ok('拣选/还原标出「（2 条）」；发参把选区按最旧→最新交出去（h333333 在前）',
  item58('拣选（2 条）') !== undefined && item58('还原（2 条）') !== undefined
  && item58('打标签…') !== undefined)
calls.length = 0
item58('拣选（2 条）').props.onClick({ stopPropagation() {} })
await wait(15)
t58 = await settle('pop')
const seqCalls58 = calls.filter((c) => c.method === 'git/sequence')
ok('拣选（2 条）发 targets 数组：[h333333, h222222]（图序反过来，最旧的先落）',
  seqCalls58.length === 1 && seqCalls58[0].args.op === 'cherry-pick'
  && JSON.stringify(seqCalls58[0].args.targets) === JSON.stringify(['h333333', 'h222222'])
  && seqCalls58[0].args.target === undefined)

crow58()[3].props.onClick({ ctrlKey: true })
await wait(10)
t58 = await settle('pop')
crow58()[2].props.onClick({ ctrlKey: true })
await wait(10)
t58 = await settle('pop')
ok('铺垫：多选换成 h2 + h4（中间隔着 h3，不连续）—— Ctrl 加 h4、移出 h3',
  multi58().length === 2 && byClass(crow58()[2], 'dsh-git-crow-multi').length === 0
  && byClass(crow58()[3], 'dsh-git-crow-multi').length === 1)
editCheckCalls58.length = 0
await rightClick58(3)
ok('右键行在多选里：体检照旧问整份（不连续也算选区）',
  JSON.stringify(editCheckCalls58[editCheckCalls58.length - 1].hashes) === JSON.stringify(['h222222', 'h444444']))

/* 体检答复没回来时的那一帧：右键后一个 await 都不落，同步渲一帧。 */
editCheckReply58 = { ok: false, stderr: 'boom' }
byClass(t58, 'dsh-git-crow')[1].props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 50, clientY: 60 })
const pendingFrame58 = renderRoot(makeElement(popover, { sessionId: 's-1' }), 'pop')
const pendingItem58 = buttons(byClass(pendingFrame58, 'dsh-git-menu')[0]).find((b) => textOf(b) === '编辑提交消息…')
ok('体检没回来：「编辑提交消息…」置灰，title 说正在检查',
  pendingItem58 !== undefined && pendingItem58.props.disabled === true
  && String(pendingItem58.props.title).indexOf('正在检查这个提交能不能改写') > 0)
editCheckReply58 = null
await wait(15)
t58 = await settle('pop')

/* reachable=false 的行：答复落定后这一项仍置灰，title 把原因说出来。 */
editCheckReply58 = {
  ok: true, repo: '/tmp/ws', head: 'h111111',
  checks: [
    { hash: 'h222222', reachable: false, pushed: false, isHead: false, isRoot: false },
  ],
}
await rightClick58(1)
ok('体检说不在当前分支历史上：「编辑提交消息…」保持置灰并说出原因',
  item58('编辑提交消息…') !== undefined && item58('编辑提交消息…').props.disabled === true
  && String(item58('编辑提交消息…').props.title).indexOf('不在当前分支历史上') > 0)
editCheckReply58 = null

/* 这一段收工：把体检的桩换回默认，后面的段落不受影响。 */
host.call = realCall58
fibers.clear()
