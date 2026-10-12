/* ═══ gp51：pull 的上游绑定（客户端这一半）═══
 *
 * 盯三片：
 *   1. 面板工具条 ↓（80-panel.js 的 runOp）：已有 upstream / detached / unborn 照旧
 *      发裸 pull（一字不多）；没有 upstream 且 refs 里有同名远端分支 → origin 优先、
 *      否则字母序第一个，git/pull 带 setUpstream 一次跑完，成功条写明绑到了哪个；
 *      没有同名 → 不发 pull、弹出选择层（分组 + 搜索 + Esc/点外关闭）；refs 缓存
 *      失效（ok:false）→ 先补读一次再判断；绑定这步撞上「does not exist」（refs
 *      过期）→ 自动回落到选择层，不裸报错；
 *   2. 选择层本体（RemotePickList，70-branchpicker.js）：现读 git/refs、按远端分组、
 *      搜索过滤、busy 禁点、点行带 setUpstream 重走 runOp；
 *   3. 分支卡 ↓（70-branchpicker.js）：同一套前置判断；有同名带参跑并把话留在卡上
 *      （note），没同名卡片就地换成远端分支选择，Esc 退回列表。 */

/* ── mock：panel / refs / branches / pull 按用例给答复 ── */
let panelReply = {
  ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0,
  sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [],
}
let refsReply = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [{ segments: ['main'], data: 'main' }],
  remote: [
    { name: 'origin', refs: [{ segments: ['main'], data: 'origin/main' }, { segments: ['topic'], data: 'origin/topic' }] },
    { name: 'zeta', refs: [{ segments: ['main'], data: 'zeta/main' }] },
  ],
}
let branchListReply = {
  ok: true, repo: '/tmp/ws', current: 'main', previous: '',
  branches: [{ name: 'main', current: true, committedAt: Math.floor(Date.now() / 1000), upstream: '', track: '', ahead: 0, behind: 0, head: 'aaa', subject: 'tip' }],
  remotes: [{ name: 'remote-only', remote: 'origin', ref: 'origin/remote-only', committedAt: Math.floor(Date.now() / 1000), head: 'bbb', subject: 'r' }],
}
let pullReply = (args) => ({
  ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0, command: 'git pull',
  sandboxDenied: false, noGit: false, upstreamSet: true, pulled: true,
  /* 答复跟着请求走：Host 回的是这一步真实绑定的远端分支，成功条取的是它。 */
  setUpstream: args != null && args.setUpstream != null
    ? { remote: args.setUpstream.remote, branch: args.setUpstream.branch, exitCode: 0, stderr: '' }
    : { remote: 'origin', branch: 'main', exitCode: 0, stderr: '' },
})
const pullCalls = []
const realCall = host.call
host.call = function (method, args) {
  if (method === 'git/panel') { calls.push({ method, args }); return Promise.resolve(panelReply) }
  if (method === 'git/refs') { calls.push({ method, args }); return Promise.resolve(refsReply) }
  if (method === 'git/branches') { calls.push({ method, args }); return Promise.resolve(branchListReply) }
  if (method === 'git/pull') { calls.push({ method, args }); pullCalls.push(args); return Promise.resolve(pullReply(args)) }
  if (method === 'git/repos') { calls.push({ method, args }); return Promise.resolve({ ok: true, workspace: '/tmp/ws', repos: [], manual: [], missing: [] }) }
  if (method === 'git/authors') { calls.push({ method, args }); return Promise.resolve({ ok: true, repo: '/tmp/ws', authors: [] }) }
  return realCall(method, args)
}

const callsOf = (mark, method) => calls.slice(mark).filter((c) => c.method === method)
const panelPull = (t) => collect(t).find((n) => n.type === 'button' && n.props.title === 'pull：拉取并合入当前分支')
const refreshBtn = (t) => collect(t).find((n) => n.type === 'button' && n.props.title === '重新读取仓库（忽略缓存）')
const pickRows = (t) => byClass(t, 'dsh-git-picklist').length > 0 ? byClass(byClass(t, 'dsh-git-picklist')[0], 'dsh-git-bs-row') : []
const pickInput = (t) => byClass(t, 'dsh-git-picklist').length > 0 ? collect(byClass(t, 'dsh-git-picklist')[0]).find((n) => n.type === 'input') : undefined
const overlayOf = (t) => byClass(t, 'dsh-git-qc-overlay').find((n) => textOf(n).indexOf('还没有上游') >= 0)
const cardOf = (t) => byClass(t, 'dsh-git-bs')[0]
/* 卡片里的 ↓ 与面板工具条的 ↓ 同名：一律先钻进卡再找。 */
const cardGlyph = (t, glyph) => buttons(cardOf(t)).find((b) => textOf(b) === glyph)
const type = async function (input, value) {
  input.props.onChange({ target: { value: value } })
  return await settle()
}
const key = async function (input, k) {
  input.props.onKeyDown({ key: k, preventDefault: function () {} })
  return await settle()
}

console.log('')
console.log('== 面板：无 upstream 且远端有同名 → 带 setUpstream 一次跑完 ==')
let tree = await openPanel()
tree = await settle()
let mark = calls.length
panelPull(tree).props.onClick()
tree = await settle()
ok('git/pull 只发了一次，setUpstream 是 {remote:origin, branch:main}（origin 优先），单仓库不带 repo',
  pullCalls.length === 1 && pullCalls[0].setUpstream != null
  && pullCalls[0].setUpstream.remote === 'origin' && pullCalls[0].setUpstream.branch === 'main'
  && pullCalls[0].sessionId === 's-1' && pullCalls[0].repo === undefined)
ok('成功条写明绑到了哪个：已绑定上游 origin/main 并拉取',
  byClass(tree, 'dsh-git-oknote').some((n) => textOf(n).indexOf('已绑定上游 origin/main 并拉取') >= 0))
ok('没有弹选择层（不是两个远端都有同名时要它做什么）', overlayOf(tree) === undefined)

console.log('')
console.log('== 面板：无同名 → 不发 pull，弹选择层 ==')
refsReply = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [{ segments: ['main'], data: 'main' }],
  remote: [
    { name: 'origin', refs: [{ segments: ['topic'], data: 'origin/topic' }] },
    { name: 'zeta', refs: [{ segments: ['else'], data: 'zeta/else' }] },
  ],
}
await refreshBtn(tree).props.onClick()
tree = await settle()
mark = calls.length
panelPull(tree).props.onClick()
tree = await settle()
ok('git/pull 一次都没发', callsOf(mark, 'git/pull').length === 0)
const pick = overlayOf(tree)
ok('选择层开着：标题说这个分支还没有上游、要选一个远端分支',
  pick !== undefined && textOf(pick).indexOf('还没有上游') >= 0 && textOf(pick).indexOf('main') >= 0)
ok('按远端分组列出全部分支：origin 与 zeta 两组（BranchPicker 的分组样式）',
  byClass(pick, 'dsh-git-bs-group').length === 2
  && textOf(pick).indexOf('origin') >= 0 && textOf(pick).indexOf('zeta') >= 0
  && pickRows(tree).length === 2)
ok('搜索过滤：键入 topic 后只剩 origin/topic 一行',
  (tree = await type(pickInput(tree), 'topic')) != null
  && pickRows(tree).length === 1
  && textOf(byClass(tree, 'dsh-git-picklist')[0]).indexOf('zeta') < 0)
mark = pullCalls.length
pickRows(tree)[0].props.onClick()
tree = await settle()
ok('点行 = git/pull 带 setUpstream:{remote:origin, branch:topic}',
  pullCalls.length === mark + 1 && pullCalls[pullCalls.length - 1].setUpstream != null
  && pullCalls[pullCalls.length - 1].setUpstream.remote === 'origin'
  && pullCalls[pullCalls.length - 1].setUpstream.branch === 'topic')
ok('成功后层收起、成功条同样写明', overlayOf(tree) === undefined
  && byClass(tree, 'dsh-git-oknote').some((n) => textOf(n).indexOf('已绑定上游 origin/topic 并拉取') >= 0))

console.log('')
console.log('== 选择层：Esc 与点外关闭 ==')
panelPull(tree).props.onClick()
tree = await settle()
tree = await key(pickInput(tree), 'Escape')
ok('Esc 关闭', overlayOf(tree) === undefined)
panelPull(tree).props.onClick()
tree = await settle()
const open = overlayOf(tree)
open.props.onClick({ target: open, currentTarget: open })
tree = await settle()
ok('点外（点在底板上）关闭', overlayOf(tree) === undefined)
panelPull(tree).props.onClick()
tree = await settle()
overlayOf(tree).props.onClick({ target: {}, currentTarget: open })
tree = await settle()
ok('点在盒子里不关（选择还在）', overlayOf(tree) !== undefined)
tree = await key(pickInput(tree), 'Escape')

console.log('')
console.log('== 面板：绑定这步撞上 does not exist（refs 过期）→ 回落选择层 ==')
pullReply = () => ({
  ok: false, repo: '/tmp/ws', stdout: '', exitCode: 1, command: "git branch '--set-upstream-to=origin/ghost'",
  stderr: "error: the requested upstream branch 'origin/main' does not exist", sandboxDenied: false, noGit: false,
  error: 'set-upstream-failed', upstreamSet: false, pulled: false,
  setUpstream: { remote: 'origin', branch: 'main', exitCode: 1, stderr: "error: the requested upstream branch 'origin/main' does not exist" },
})
refsReply = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [{ segments: ['main'], data: 'main' }],
  remote: [{ name: 'origin', refs: [{ segments: ['main'], data: 'origin/main' }] }],
}
await refreshBtn(tree).props.onClick()
tree = await settle()
panelPull(tree).props.onClick()
tree = await settle()
ok('没有把裸错误甩上屏（回落到选择层重挑）',
  overlayOf(tree) !== undefined && byClass(tree, 'dsh-git-error').length === 0)
tree = await key(pickInput(tree), 'Escape')

console.log('')
console.log('== 面板：refs 缓存失效（ok:false）→ 先补读一次再判断 ==')
pullReply = () => ({
  ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0, command: 'git pull',
  sandboxDenied: false, noGit: false, upstreamSet: true, pulled: true,
  setUpstream: { remote: 'origin', branch: 'main', exitCode: 0, stderr: '' },
})
const freshRefs = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [{ segments: ['main'], data: 'main' }],
  remote: [{ name: 'origin', refs: [{ segments: ['main'], data: 'origin/main' }] }],
}
refsReply = { ok: false, repo: '/tmp/ws', current: [], local: [], remote: [] }
await refreshBtn(tree).props.onClick()
tree = await settle()
mark = pullCalls.length
panelPull(tree).props.onClick()
tree = await settle()
ok('refs 拿不到（ok:false）时按老路直接裸 pull，不弹层',
  pullCalls.length === mark + 1 && pullCalls[pullCalls.length - 1].setUpstream === undefined
  && overlayOf(tree) === undefined)
refsReply = freshRefs
mark = calls.length
panelPull(tree).props.onClick()
tree = await settle()
ok('再点：先补读一次 refs（这次拿到全的），同名命中 → git/pull 带 setUpstream，不弹层',
  callsOf(mark, 'git/refs').length >= 1 && callsOf(mark, 'git/pull').length === 1
  && pullCalls[pullCalls.length - 1].setUpstream != null
  && pullCalls[pullCalls.length - 1].setUpstream.remote === 'origin' && overlayOf(tree) === undefined)

console.log('')
console.log('== 面板：已有 upstream / detached / unborn → 照旧裸 pull ==')
panelReply = Object.assign({}, panelReply, { upstream: 'origin/main' })
await refreshBtn(tree).props.onClick()
tree = await settle()
mark = pullCalls.length
panelPull(tree).props.onClick()
tree = await settle()
ok('已有 upstream：git/pull 不带 setUpstream（行为一字不变）',
  pullCalls.length === mark + 1 && pullCalls[pullCalls.length - 1].setUpstream === undefined)
panelReply = Object.assign({}, panelReply, { upstream: '', detached: true, branch: null })
refsReply = { ok: true, repo: '/tmp/ws', current: [], local: [], remote: [{ name: 'origin', refs: [{ segments: ['main'], data: 'origin/main' }] }] }
await refreshBtn(tree).props.onClick()
tree = await settle()
panelPull(tree).props.onClick()
tree = await settle()
ok('detached：裸 pull，不弹层',
  pullCalls[pullCalls.length - 1].setUpstream === undefined && overlayOf(tree) === undefined)
panelReply = Object.assign({}, panelReply, { detached: false, branch: 'main' })
refsReply = { ok: true, repo: '/tmp/ws', current: ['main'], local: [], remote: [{ name: 'origin', refs: [{ segments: ['main'], data: 'origin/main' }] }] }
await refreshBtn(tree).props.onClick()
tree = await settle()
panelPull(tree).props.onClick()
tree = await settle()
ok('unborn（refs.current 说得出名字、refs/heads 里没有它）：裸 pull，不弹层',
  pullCalls[pullCalls.length - 1].setUpstream === undefined && overlayOf(tree) === undefined)

console.log('')
console.log('== 分支卡 ↓：同名带参跑；没同名卡内就地选 ==')
tree = await openSwitcher()
const card = cardOf(tree)
ok('分支卡开着，↓ 在卡上的动作区里', card !== undefined && cardGlyph(tree, '↓') !== undefined)
refsReply = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [{ segments: ['main'], data: 'main' }],
  remote: [{ name: 'origin', refs: [{ segments: ['main'], data: 'origin/main' }] }],
}
mark = pullCalls.length
cardGlyph(tree, '↓').props.onClick({ stopEvent: function () {} })
tree = await settle()
ok('卡里的 pull 先问了一次 refs（这份列表不含与本地同名的远端行，判断不了）',
  callsOf(mark, 'git/refs').length >= 1)
ok('有同名 → git/pull 带 setUpstream，卡上留下「已绑定上游 origin/main 并拉取」',
  pullCalls.length === mark + 1 && pullCalls[pullCalls.length - 1].setUpstream != null
  && pullCalls[pullCalls.length - 1].setUpstream.remote === 'origin'
  && textOf(cardOf(tree)).indexOf('已绑定上游 origin/main 并拉取') >= 0)
refsReply = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [{ segments: ['main'], data: 'main' }],
  remote: [{ name: 'upstream', refs: [{ segments: ['elsewhere'], data: 'upstream/elsewhere' }] }],
}
cardGlyph(tree, '↓').props.onClick({ stopEvent: function () {} })
tree = await settle()
ok('没同名：卡片就地换成远端分支选择（不是整卡关闭）',
  cardOf(tree) !== undefined && byClass(cardOf(tree), 'dsh-git-picklist').length === 1
  && textOf(cardOf(tree)).indexOf('还没有上游') >= 0 && pickRows(tree).length === 1)
mark = pullCalls.length
pickRows(tree)[0].props.onClick()
tree = await settle()
ok('点行绑定并拉取：setUpstream 是 {remote:upstream, branch:elsewhere}',
  pullCalls.length === mark + 1 && pullCalls[pullCalls.length - 1].setUpstream != null
  && pullCalls[pullCalls.length - 1].setUpstream.remote === 'upstream'
  && pullCalls[pullCalls.length - 1].setUpstream.branch === 'elsewhere')
refsReply = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [{ segments: ['main'], data: 'main' }],
  remote: [{ name: 'upstream', refs: [{ segments: ['elsewhere'], data: 'upstream/elsewhere' }] }],
}
cardGlyph(tree, '↓').props.onClick({ stopEvent: function () {} })
tree = await settle()
tree = await key(pickInput(tree), 'Escape')
ok('卡内 Esc 退回分支列表（不是关掉整卡）',
  byClass(cardOf(tree), 'dsh-git-picklist').length === 0 && cardOf(tree) !== undefined)
