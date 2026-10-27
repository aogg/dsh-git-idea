import fs from 'node:fs'

import { makeEnv } from './gp69-env.mjs'

/* ═══ gp73：worktree 块内快速创建表单（客户端这一半，25-worktree.js v1.3）═══
 *
 * 钉 2c19916 的 WorktreeBox「＋ 新建 worktree」动作行与 WorktreeAddForm：
 *   1. 挂载：动作行在读取中 / 失败 / 空态 / 有清单四态都在、折叠态不在；展开后
 *      表单三模式（新建分支 / 检出分支 / 游离检出）+ 创建/取消；表单只长在
 *      dsh-git-wt-form 前缀族里，dsh-git-wt-row 的行数账不被它动（gp57/gp60
 *      按行数认账，别破坏）；
 *   2. 检出分支的 datalist：本地 ∪ 远端，被占用的本地分支标「已占用」；
 *   3. 目录预填：仓库父目录 + / + 仓库短名 + - + 分支短名（[^A-Za-z0-9._-]+ 折
 *      '-'、两端裁掉），手改即冻结；基准目录 = 生效仓库（wtMain 没接上时）；
 *   4. 预检五条免费拦（不发请求）：空字段 / 相对路径 / 目录撞已登记 worktree /
 *      检出被占用分支 / 新分支撞本地名 —— 冲突类勾「强制覆盖」放行，空字段与
 *      相对路径勾了也照拦；
 *   5. 提交：payload 按模式取舍（new 带 name+at、checkout 带 name、detach 全省），
 *      防连点（busy 后再点不发第二单），成功收起表单；
 *   6. 失败红字折话：noGit / sandboxDenied 专门话术、stderr 首行、校验层 error、
 *      运输层失败兜底 —— 表单都不收起；
 *   7. 创建后切换（jump）：历史页按答复清单里该工作区站着的分支 onPickBranch
 *      （graph 的 ref 跟上）；jump 关掉只刷新；游离检出没有分支、历史页没有
 *      onPickWorktree —— 只刷新；变更页 onPickWorktree 把生效仓库切过去。
 *
 * 自足式套件（gp34b/gp54 先例）：环境用 gp69-env，开 arrayByRef —— 真实 React 的
 * children 语义是「单个数组实参 = 那个数组本身」，25-worktree.js 的 withTail 先
 * h(box, rows) 再 rows.push(动作行)，共享 harness 的展开式 makeElement 看不见这一
 * 笔，这里按真语义渲染。
 */

const src = fs.readFileSync(process.env.GP_SRC || new URL('../dist/client.js', import.meta.url).pathname, 'utf8')
const env = makeEnv({ arrayByRef: true, document: false, window: false })
const components = env.apply(src)

/* ── mock：worktree / refs 罐头；git/worktree-add 按用例的剧本应答并记账 ── */
const WT73 = {
  ok: true, repo: '/tmp/ws',
  worktrees: [
    { path: '/tmp/lab/wt-a', head: 'aaa', branch: 'main', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/wt-b', head: 'bbb', branch: 'topic', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
  ],
}
const REFS73 = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [
    { segments: ['main'], data: 'main', upstream: 'origin/main', ahead: 0, behind: 0, at: 0 },
    { segments: ['solo'], data: 'solo', upstream: '', ahead: 0, behind: 0, at: 0 },
  ],
  remote: [{ name: 'origin', refs: [{ segments: ['only'], data: 'origin/only' }] }],
}
let wtReply73 = null
let hangWorktrees73 = false
let addScript73 = null /* {reply} 成功 / {failure} 已答失败 / {thrown} 运输层失败 / {pending} 挂着等用例放行 */
let deferredReply73 = null /* {pending} 那次请求的放行口子 */
const addCalls73 = []
const wtCalls73 = []
const panelCalls73 = []
const graphCalls73 = []
const realCall73 = env.host.call
env.host.call = function (method, args) {
  if (method === 'git/worktrees') {
    env.calls.push({ method: method, args: args })
    wtCalls73.push(args)
    if (hangWorktrees73 === true) return new Promise(function () {})
    if (wtReply73 !== null) return Promise.resolve(wtReply73)
    return Promise.resolve(WT73)
  }
  if (method === 'git/refs') { env.calls.push({ method: method, args: args }); return Promise.resolve(REFS73) }
  if (method === 'git/repos') { env.calls.push({ method: method, args: args }); return Promise.resolve({ ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws'], manual: [], missing: [], links: [] }) }
  if (method === 'git/worktree-add') {
    env.calls.push({ method: method, args: args })
    addCalls73.push(args)
    const script = addScript73
    if (script === null || script.reply !== undefined) return Promise.resolve(script === null ? { ok: true, repo: '/tmp/ws', path: args.path, worktrees: [] } : script.reply)
    if (script.pending === true) return new Promise(function (resolve) { deferredReply73 = resolve })
    if (script.failure !== undefined) return Promise.resolve(script.failure)
    return Promise.reject(new Error(script.thrown === undefined ? 'transport down' : script.thrown))
  }
  if (method === 'git/panel') { env.calls.push({ method: method, args: args }); panelCalls73.push(args); return Promise.resolve({ ok: true, repo: (args && args.repo) || '/tmp/ws', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] }) }
  if (method === 'git/graph') { env.calls.push({ method: method, args: args }); graphCalls73.push(args); return Promise.resolve({ ok: true, repo: (args && args.repo) || '/tmp/ws', ref: (args && args.ref) || 'main', currentBranch: 'main', commits: [], rows: [], lanes: 1 }) }
  return realCall73(method, args)
}

/* ── 取景 ── */
const makeEl = env.makeElement
const byCls = env.byClass
const textOf = env.textOf
const wait = env.wait
const ok = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label + (value ? '' : '   ← 不符合预期'))
}
const pop73 = (sid) => env.renderUntilStable(makeEl(components.popover, { sessionId: sid }), sid || 's-73')
async function settle73(sid) { let t = null; for (let i = 0; i < 4; i += 1) { t = await pop73(sid); await wait(10) } return t }
const wtBox73 = (t) => byCls(t, 'dsh-git-wt-box')[0]
const wtRows73 = (t) => byCls(wtBox73(t) || t, 'dsh-git-wt-row')
const addRow73 = (t) => byCls(t, 'dsh-git-wt-add')[0]
const wtHead73 = (t) => byCls(t, 'dsh-git-wt-head')[0]
const form73 = (t) => byCls(t, 'dsh-git-wt-form')[0]
const formInput73 = (t, label) => {
  const row = byCls(form73(t) || t, 'dsh-git-wt-form-row').filter(function (one) {
    const lab = byCls(one, 'dsh-git-wt-form-label')[0]
    return lab !== undefined && textOf(lab) === label
  })[0]
  return row === undefined ? undefined : env.inputsOf(row).find(function (n) { return n.props.type === undefined || n.props.type === 'text' })
}
const radio73 = (t, text) => {
  const lab = byCls(form73(t) || t, 'dsh-git-wt-form-mode').find(function (one) { return textOf(one).indexOf(text) >= 0 })
  return lab === undefined ? undefined : env.inputsOf(lab).find(function (n) { return n.props.type === 'radio' })
}
const checkbox73 = (t, text) => {
  const lab = byCls(form73(t) || t, 'dsh-git-wt-form-check').find(function (one) { return textOf(one).indexOf(text) >= 0 })
  return lab === undefined ? undefined : env.inputsOf(lab).find(function (n) { return n.props.type === 'checkbox' })
}
const btn73 = (t, text) => env.buttonsOf(form73(t) || t).find(function (b) { return textOf(b) === text })
const err73 = (t) => {
  const e = byCls(form73(t) || t, 'dsh-git-wt-form-error')[0]
  return e === undefined ? '' : textOf(e)
}
const options73 = (t) => {
  /* datalist 没有 className（byClass 是按类名认路的），按元素类型找。 */
  const dl = env.byTag(form73(t) || t, 'datalist')[0]
  if (dl === undefined) return []
  return (Array.isArray(dl.props.children) ? dl.props.children : []).map(function (o) {
    return String(o.props.value) + '|' + String(o.props.label === undefined ? o.props.value : o.props.label)
  })
}
async function openForm73(t) {
  const row = addRow73(t)
  if (row === undefined) throw new Error('gp73: 动作行不在')
  row.props.onClick()
  const next = await settle73()
  if (form73(next) === undefined) throw new Error('gp73: 表单没展开')
  return next
}
const closeForm73 = async function (t) {
  btn73(t, '取消').props.onClick()
  return await settle73()
}

let failed = 0

/* 面板得先「开」一次：everOpened 是模块级的，此后直接挂 popover 就是就绪态。 */
env.fibers.clear()
let chipT73 = await env.renderUntilStable(makeEl(components.chip, { sessionId: 's-73' }), 'chip-73')
if (chipT73.props.className.indexOf('dsh-git-chip-open') < 0) { chipT73.props.onClick(); await wait(10) }
let tree73 = await settle73()

console.log('')
console.log('== 挂载：动作行四态都在、折叠态不在；表单展开/取消；wt-row 行数账不动 ==')
ok('有清单：块底有「＋ 新建 worktree」动作行，清单两行原样（dsh-git-wt-row 不多不少）',
  addRow73(tree73) !== undefined && wtRows73(tree73).length === 2)
env.fibers.clear()
hangWorktrees73 = true
tree73 = await settle73('s-73b')
ok('读取中：动作行也在（四态共享的尾巴）', addRow73(tree73) !== undefined)
env.fibers.clear()
hangWorktrees73 = false
wtReply73 = { ok: false, repo: '/tmp/ws', error: 'not-a-repository', worktrees: [] }
tree73 = await settle73('s-73c')
ok('读取失败：动作行仍在', addRow73(tree73) !== undefined)
wtReply73 = { ok: true, repo: '/tmp/ws', worktrees: [] }
env.fibers.clear()
tree73 = await settle73('s-73d')
ok('空态：动作行仍在', addRow73(tree73) !== undefined)
wtReply73 = null
env.fibers.clear()
tree73 = await settle73()
tree73 = await openForm73(tree73)
ok('动作行点开：表单在场，三模式 + 创建/取消，错误行还没影',
  form73(tree73) !== undefined
  && ['新建分支', '检出分支', '游离检出'].every(function (m) { return radio73(tree73, m) !== undefined })
  && btn73(tree73, '创建') !== undefined && btn73(tree73, '取消') !== undefined
  && err73(tree73) === '')
tree73 = await closeForm73(tree73)
ok('取消收起表单：表单没了，动作行回来', form73(tree73) === undefined && addRow73(tree73) !== undefined)
wtHead73(tree73).props.onClick()
tree73 = await settle73()
ok('折叠态：整段尾巴都不在（动作行、表单都没有）',
  addRow73(tree73) === undefined && form73(tree73) === undefined)
wtHead73(tree73).props.onClick()
tree73 = await settle73()
ok('再展开块：动作行回来', addRow73(tree73) !== undefined)

console.log('')
console.log('== 三模式：字段行随模式增减；检出分支 datalist 本地 ∪ 远端、占用标「已占用」 ==')
tree73 = await openForm73(tree73)
ok('默认新建分支：名字行「新分支」+ 起点行都在（起点可空 = HEAD）',
  formInput73(tree73, '新分支') !== undefined && formInput73(tree73, '起点') !== undefined)
radio73(tree73, '检出分支').props.onChange()
tree73 = await settle73()
ok('检出分支：名字行换标签「分支」，datalist 本地 main/solo + 远端 origin/only，被占用的 main 标「已占用」',
  formInput73(tree73, '分支') !== undefined
  && options73(tree73).join(',') === 'main|main（已占用）,solo|solo,origin/only|origin/only')
radio73(tree73, '游离检出').props.onChange()
tree73 = await settle73()
ok('游离检出：名字行收起、只剩起点行（分支/commit/tag，默认 HEAD）',
  formInput73(tree73, '新分支') === undefined && formInput73(tree73, '分支') === undefined
  && formInput73(tree73, '起点') !== undefined)
radio73(tree73, '新建分支').props.onChange()
tree73 = await settle73()

console.log('')
console.log('== 目录预填：仓库父目录 + 短名 slug；手改即冻结 ==')
ok('初始建议 = /tmp/ws-main（生效仓库 /tmp/ws 的父目录 + 仓库名 - 当前分支短名）',
  formInput73(tree73, '目录').props.value === '/tmp/ws-main')
formInput73(tree73, '新分支').props.onChange({ target: { value: 'Feature/One!!' } })
tree73 = await settle73()
ok('分支名进 slug：[^A-Za-z0-9._-]+ 折 -、两端裁掉 → /tmp/ws-Feature-One',
  formInput73(tree73, '目录').props.value === '/tmp/ws-Feature-One')
formInput73(tree73, '目录').props.onChange({ target: { value: '/tmp/lab/custom' } })
tree73 = await settle73()
formInput73(tree73, '新分支').props.onChange({ target: { value: 'zzz' } })
tree73 = await settle73()
ok('手改过就冻结：分支名再变，目录不再跟（/tmp/lab/custom 不动）',
  formInput73(tree73, '目录').props.value === '/tmp/lab/custom')
tree73 = await closeForm73(tree73)

console.log('')
console.log('== 预检五条：免费拦，不发请求；冲突类勾「强制覆盖」放行 ==')
let markAdd73 = addCalls73.length
tree73 = await openForm73(tree73)
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
ok('空字段：新分支名必填（红字），没有发请求', err73(tree73).indexOf('新分支名必填') >= 0 && addCalls73.length === markAdd73)
formInput73(tree73, '目录').props.onChange({ target: { value: 'relative/x' } })
tree73 = await settle73()
formInput73(tree73, '新分支').props.onChange({ target: { value: 'feat' } })
tree73 = await settle73()
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
ok('相对路径：绝对路径拦', err73(tree73).indexOf('绝对路径') >= 0 && addCalls73.length === markAdd73)
formInput73(tree73, '目录').props.onChange({ target: { value: '/tmp/lab/wt-a' } })
tree73 = await settle73()
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
ok('目录撞已登记 worktree：拦，并提示换目录或勾「强制覆盖」',
  err73(tree73).indexOf('/tmp/lab/wt-a') >= 0 && err73(tree73).indexOf('强制覆盖') >= 0)
checkbox73(tree73, '强制覆盖').props.onChange({ target: { checked: true } })
tree73 = await settle73()
markAdd73 = addCalls73.length
/* 答复先摆好再点：host 成功 → 表单按 design 收起（下面不再有「取消」可点）。 */
addScript73 = { reply: { ok: true, repo: '/tmp/ws', path: '/tmp/lab/wt-a', worktrees: WT73.worktrees } }
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
addScript73 = null
ok('勾了强制覆盖：同目录放行，请求带 force:true',
  addCalls73.length === markAdd73 + 1 && addCalls73[markAdd73].force === true)
ok('成功一次：表单按约收起（下一次展开是全新的空白表单）', form73(tree73) === undefined)

tree73 = await openForm73(tree73)
radio73(tree73, '检出分支').props.onChange()
tree73 = await settle73()
formInput73(tree73, '分支').props.onChange({ target: { value: 'main' } })
tree73 = await settle73()
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
ok('检出被占用分支（main 被 /tmp/lab/wt-a 检出）：拦，话里点名占用的工作区',
  err73(tree73).indexOf('main') >= 0 && err73(tree73).indexOf('/tmp/lab/wt-a') >= 0)
formInput73(tree73, '分支').props.onChange({ target: { value: 'solo' } })
tree73 = await settle73()
markAdd73 = addCalls73.length
addScript73 = { reply: { ok: true, repo: '/tmp/ws', path: '/tmp/ws-solo', worktrees: [] } }
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
addScript73 = null
ok('检出空闲分支（solo）：预检放行，请求出门', addCalls73.length === markAdd73 + 1)

tree73 = await openForm73(tree73)
formInput73(tree73, '新分支').props.onChange({ target: { value: 'solo' } })
tree73 = await settle73()
markAdd73 = addCalls73.length
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
ok('新建撞本地已有分支名（solo）：拦，话里给出「强制覆盖」的出路',
  err73(tree73).indexOf('本地已有同名分支 solo') >= 0 && err73(tree73).indexOf('强制覆盖') >= 0)
checkbox73(tree73, '强制覆盖').props.onChange({ target: { checked: true } })
tree73 = await settle73()
formInput73(tree73, '目录').props.onChange({ target: { value: 'still/relative' } })
tree73 = await settle73()
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
ok('相对路径在 force 勾着时照拦（空字段与路径不吃 force 的豁免）',
  err73(tree73).indexOf('绝对路径') >= 0 && addCalls73.length === markAdd73)
tree73 = await closeForm73(tree73)

console.log('')
console.log('== 提交：payload 按模式取舍、防连点、成功收起 ==')
markAdd73 = addCalls73.length
tree73 = await openForm73(tree73)
formInput73(tree73, '新分支').props.onChange({ target: { value: 'brand-new' } })
tree73 = await settle73()
formInput73(tree73, '起点').props.onChange({ target: { value: 'origin/main' } })
tree73 = await settle73()
checkbox73(tree73, '强制覆盖').props.onChange({ target: { checked: false } })
tree73 = await settle73()
/* host 挂着不答（{pending}）才看得见 busy：答完表单就收起了。 */
addScript73 = { pending: true }
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
ok('new 模式 payload：mode/path/name/at/force 各就各位（目录用预填值）',
  addCalls73.length === markAdd73 + 1
  && addCalls73[markAdd73].mode === 'new'
  && addCalls73[markAdd73].path === '/tmp/ws-brand-new'
  && addCalls73[markAdd73].name === 'brand-new'
  && addCalls73[markAdd73].at === 'origin/main'
  && addCalls73[markAdd73].force === false)
ok('busy 中：按钮变「…」且 disabled，再点不发第二单',
  btn73(tree73, '…') !== undefined && btn73(tree73, '…').props.disabled === true)
btn73(tree73, '…').props.onClick()
await wait(10)
ok('busy 中的点击被吞（仍是一单）', addCalls73.length === markAdd73 + 1)
let graphMark73 = graphCalls73.length
deferredReply73({ ok: true, repo: '/tmp/ws', path: '/tmp/ws-brand-new', worktrees: [
  { path: '/tmp/ws-brand-new', head: 'ccc', branch: 'brand-new', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
] })
tree73 = await settle73()
addScript73 = null
deferredReply73 = null
ok('成功：表单收起，历史按新工作区站着的分支过滤（graph ref = brand-new）',
  form73(tree73) === undefined
  && graphCalls73.slice(graphMark73).length > 0
  && graphCalls73.slice(graphMark73).every(function (a) { return a.ref === 'brand-new' }))

console.log('')
console.log('== jump 关掉：只刷新，不切分支 ==')
markAdd73 = addCalls73.length
graphMark73 = graphCalls73.length
tree73 = await openForm73(tree73)
checkbox73(tree73, '创建后切到新工作区').props.onChange({ target: { checked: false } })
tree73 = await settle73()
formInput73(tree73, '新分支').props.onChange({ target: { value: 'quiet-add' } })
tree73 = await settle73()
addScript73 = { reply: { ok: true, repo: '/tmp/ws', path: '/tmp/ws-quiet-add', worktrees: [
  { path: '/tmp/ws-quiet-add', head: 'ddd', branch: 'quiet-add', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
] } }
const wtMark73 = wtCalls73.length
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
addScript73 = null
ok('jump 关：清单照样重读（bump 那一刷），graph 的 ref 没被拽走',
  wtCalls73.length > wtMark73 && graphCalls73.slice(graphMark73).every(function (a) { return a.ref === 'brand-new' }))

console.log('')
console.log('== detach：payload 不带 name/at；游离没分支 → 历史页没有 onPickWorktree，只刷新 ==')
markAdd73 = addCalls73.length
graphMark73 = graphCalls73.length
tree73 = await openForm73(tree73)
radio73(tree73, '游离检出').props.onChange()
tree73 = await settle73()
formInput73(tree73, '目录').props.onChange({ target: { value: '/tmp/ws-det' } })
tree73 = await settle73()
addScript73 = { reply: { ok: true, repo: '/tmp/ws', path: '/tmp/ws-det', worktrees: [
  { path: '/tmp/ws-det', head: 'eee', branch: '', detached: true, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
] } }
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
addScript73 = null
ok('detach payload：只有 mode/path/force，没有 name/at',
  addCalls73.length === markAdd73 + 1
  && addCalls73[markAdd73].mode === 'detach'
  && addCalls73[markAdd73].path === '/tmp/ws-det'
  && addCalls73[markAdd73].name === undefined && addCalls73[markAdd73].at === undefined)
ok('游离检出成功：没有分支可过滤（graph 仍按原 ref 重读、没被拽到新分支），表单收起、清单重读',
  graphCalls73.slice(graphMark73).every(function (a) { return a.ref === 'brand-new' }) && form73(tree73) === undefined)

console.log('')
console.log('== 失败红字折话：noGit / sandboxDenied / stderr 首行 / 校验层 error / 运输层 ==')
const sayIt = async function (script) {
  let t = await openForm73(tree73)
  const nameInput = formInput73(t, '新分支')
  if (nameInput !== undefined) { nameInput.props.onChange({ target: { value: 'fail-case' } }); t = await settle73() }
  addScript73 = script
  btn73(t, '创建').props.onClick()
  const after = await settle73()
  addScript73 = null
  return after
}
tree73 = await sayIt({ failure: { ok: false, noGit: true, stderr: '', exitCode: 127 } })
ok('noGit：专门话术（这台机器上找不到 git），表单不收起',
  err73(tree73).indexOf('找不到 git') >= 0 && form73(tree73) !== undefined)
tree73 = await closeForm73(tree73)
tree73 = await sayIt({ failure: { ok: false, sandboxDenied: true, stderr: 'Permission denied', exitCode: 1 } })
ok('sandboxDenied：专门话术（文件沙箱不允许），表单不收起',
  err73(tree73).indexOf('沙箱') >= 0 && form73(tree73) !== undefined)
tree73 = await closeForm73(tree73)
tree73 = await sayIt({ failure: { ok: false, exitCode: 128, stderr: "fatal: '/x' already exists\n第二行不要", stdout: '' } })
ok('git 原话：stderr 首行（比退出码有用）', err73(tree73) === "fatal: '/x' already exists")
tree73 = await closeForm73(tree73)
tree73 = await sayIt({ failure: { ok: false, error: '起点不合法：不能以 - 开头、不能含控制字符', stderr: '' } })
ok('host 校验层拒绝（没有 stderr）：落 reply.error 那句人话', err73(tree73).indexOf('起点不合法') >= 0)
tree73 = await closeForm73(tree73)
tree73 = await sayIt({ thrown: 'socket gone' })
ok('运输层失败（host 没答话）：兜底话术也在，表单不收起', err73(tree73).length > 0 && form73(tree73) !== undefined)
tree73 = await closeForm73(tree73)

console.log('')
console.log('== 变更页（仓库模式）：成功后 onPickWorktree 把生效仓库切到新工作区 ==')
const changesBtn73 = env.buttonsOf(tree73).find(function (b) { return textOf(b).indexOf('变更') === 0 })
changesBtn73.props.onClick()
tree73 = await settle73()
ok('变更页左栏也有 worktree 块与动作行（仓库模式同款尾巴）',
  addRow73(tree73) !== undefined && wtBox73(tree73) !== undefined)
markAdd73 = addCalls73.length
const panelMark73 = panelCalls73.length
tree73 = await openForm73(tree73)
formInput73(tree73, '新分支').props.onChange({ target: { value: 'repo-jump' } })
tree73 = await settle73()
addScript73 = { reply: { ok: true, repo: '/tmp/ws', path: '/tmp/ws-repo-jump', worktrees: [
  { path: '/tmp/ws-repo-jump', head: 'fff', branch: 'repo-jump', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
] } }
btn73(tree73, '创建').props.onClick()
tree73 = await settle73()
addScript73 = null
ok('变更页创建成功：生效仓库切到新工作区（git/panel 带着新 repo 重读），表单收起',
  panelCalls73.length > panelMark73
  && panelCalls73.slice(panelMark73).some(function (a) { return a.repo === '/tmp/ws-repo-jump' })
  && form73(tree73) === undefined)

if (failed > 0) {
  console.error('gp73-worktree-form-client: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
