import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { makeEnv } from './gp69-env.mjs'

/* ═══ gp88：worktree 块「清除」（25-worktree.js v1.4 + 80-panel.js worktreeRemove
 *    + 65-worktree.js removeWorktree，RPC 名 git/worktree-remove）═══
 *
 * 钉 13e9eb1 的两条写路径之二，一个套件盯四层：
 *   1. WorktreeBox v1.4 的清除 UI（源码级求值整份 25-worktree.js，gp86 对
 *      61-filemenu 的同一写法；依赖的 11 个闭包符号全部用桩喂进 —— h 用 gp69-env
 *      的 makeElement，arrayByRef 开着，withTail 的「先 h(box, rows) 再塞尾巴」
 *      才看得见；ContextMenu 用形状桩：开合与武装的账在 WorktreeBox 侧，不在浮层）：
 *        · canRemove 总开关：onWorktreeRemove 没传 → 「…」触发器、块头右键、
 *          行右键整段不出现（行为与 v1.3 逐字节相同）；
 *        · 行菜单矩阵：只挂游离（detached）/失联（prunable）行；正常 / locked /
 *          bare 不挂；locked 的 tooltip 说明为什么不给清，可清行的 tooltip 指路；
 *        · 块头两处入口：「…」单击与块头整行右键开同一张块级菜单；「…」单击不把
 *          块折起来；N = 游离 + 失联数，N=0 时「一键清除（0）」置灰且 title 说实话；
 *        · armed 二段确认（ctxArm 同一条先例）：第一次点只武装（变红字「确认…」、
 *          不发单），第二次点才发且只发一单；开新菜单作废旧菜单时武装复位；
 *        · 一键清除逐个顺序发、不连坐：上一单答完才发下一单（pending 门逐单放行
 *          验证），单个失败不中断其余；成功（单 / 多）、部分失败、全败的块内 note
 *          三色格口径（dsh-git-wt-note-ok / -bad），点一下收起；清除在飞时菜单项
 *          disabled；折叠态入口与 note 不收；
 *        · 被清的是当前生效仓库（path === effective）时确认悬停带 ⚠ 警告前缀；
 *        · 失败折话（wtRemoveFailureText）：stderr 首行、noGit / sandboxDenied
 *          专门话术、原话里点了 --force 时附加「手动 git worktree remove --force
 *          <path>」的出路、宿主进程还是旧版（is not registered）说重启 DSH。
 *   2. 80-panel.js 的接线（gp73 同一副骨架：gp69-env 挂真面板，host.call 桩）：
 *        worktreeRemove 统一发 git/worktree-remove，payload = 块的业务字段 {path} +
 *        base 补的 {sessionId, repo: 生效仓库}；失败（failure.reply 在）也 bump；
 *        历史 / 变更两页的 worktreeProps 都透传 onWorktreeRemove（两页都有「…」）。
 *   3. Host git/worktree-remove（gp72 同一副骨架的罐头段：整份 host.js 求值，
 *      shell Service 换成听命令的桩，porcelain 清单按队列给 —— remove 前现读
 *      一份、成功后快照再读一份，两份账本就是「答复带最新清单」的证据）：
 *        · 门票三道全对**现读**清单：path 缺失 / 相对路径拒（一个字节不跑）；
 *          清单读不出来拒（stderr 首行带原话）；noGit 127 带人话；清单外路径拒
 *          （remove 没跑）；主工作区拒；bare 拒；
 *        · 执行 panelMutate：argv 精确 `worktree remove <path>` 无 --force、
 *          workdir 跟请求点名的仓库、人话命令、成功答复 = panelMutate 结果 +
 *          最新 worktrees（快照那份新账）+ path/repo；remove 的 git 拒绝如实
 *          带回（exitCode 128、stderr 原话、command）；
 *        · 现读不走缓存：同一 path 在「已不在清单」的账本上重发，拒在门票第一道。
 *   4. Host 真仓库段（gp86/gp87 同款：临时真 git 仓库，spawn 真的跑）：
 *        · 干净工作区 remove 成功：答复清单没有它了、`git worktree list` 里登记
 *          真被清、人话命令带回；
 *        · 有未提交改动的目录 git 拒（use --force 原话）、答复如实带回、登记还在；
 *        · 目录已失联（手动删掉目录）remove 只清登记照样成功 —— prune 的那半边。
 *
 * Host 两段读 GP_SRC（run-all.mjs 的 GP_FRESH 会指到临时拼接），没设时用
 * build.mjs 的 render 现拼 —— 测的永远是 src/，仓库产物一个字节不动。 */

let failed = 0
const ok = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label + (value ? '' : '   ← 不符合预期'))
}
const ROOT = new URL('..', import.meta.url).pathname

/* ═══ 1. 客户端：WorktreeBox v1.4（源码级求值 + 迷你渲染器直挂）═══ */

/* 25-worktree.js 的闭包符号全部桩进：h 用 gp69-env 的 makeElement（arrayByRef），
   ContextMenu 用形状桩（open:false → null；open:true → dsh-git-menu 一层 children），
   panelNode 给 null（wtMenuPos 走「量不到原样用视口坐标」的兜底）。 */
const wtSrc = fs.readFileSync(ROOT + 'src/client/25-worktree.js', 'utf8')
const env = makeEnv({ arrayByRef: true, document: false, window: false })
const makeEl = env.makeElement
const byCls = env.byClass
const textOf = env.textOf
const buttonsOf = env.buttonsOf
const api = new Function(
  'h', 'text', 'React', 'Icon', 'trackTitle', 'repoBaseName', 'stopEvent',
  'ContextMenu', 'panelNode', 'HOST_NOT_READY', 'failureText',
  wtSrc + '\nreturn { WorktreeBox: WorktreeBox, wtRemoveFailureText: wtRemoveFailureText }',
)(
  env.makeElement,
  (v) => (typeof v === 'string' ? v : ''),
  env.React,
  function Icon(props) { return env.makeElement('i', { className: 'dsh-git-ic-' + String(props.name) }) },
  () => '',
  (p) => { const t = String(p == null ? '' : p).replace(/\/+$/, ''); const c = t.lastIndexOf('/'); return c < 0 ? t : t.slice(c + 1) },
  function stopEvent(event) { if (event != null && typeof event.stopPropagation === 'function') event.stopPropagation() },
  function ContextMenu(props) {
    if (props.open !== true) return null
    return env.makeElement('div', { className: 'dsh-git-menu' }, props.children)
  },
  null,
  'is not registered',
  (failure) => String(failure != null && failure.message !== undefined ? failure.message : failure),
)
const WorktreeBox = api.WorktreeBox

/* ── 渲染世界 ──
   WorktreeBox 直接作为根组件挂（fiber label 'wt88'）。异步 promise 链（runClear 的
   逐单串行）靠「多轮重渲染 + 等待」兜住：RS = 渲染到稳定再等 10ms，重复五轮。 */
const REFS88 = {
  ok: true, repo: '/tmp/ws', current: ['main'],
  local: [{ segments: ['main'], data: 'main', upstream: 'origin/main', ahead: 0, behind: 0, at: 0 }],
  remote: [],
}
const EFFECTIVE = '/tmp/ws'
const WT_ROWS = function () {
  return [
    { path: '/tmp/lab/wt-a', head: 'aaa', branch: 'main', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/wt-b', head: 'bbb', branch: '', detached: true, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/wt-c', head: 'ccc', branch: 'gone', detached: false, bare: false, locked: false, lockReason: '', prunable: true, pruneReason: 'gitdir points nowhere' },
    { path: '/tmp/lab/wt-d', head: 'ddd', branch: 'held', detached: false, bare: false, locked: true, lockReason: 'in use', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/wt-e', head: '', branch: '', detached: false, bare: true, locked: false, lockReason: '', prunable: false, pruneReason: '' },
  ]
}
const boxProps = function (over) {
  return Object.assign({
    data: { ok: true, repo: EFFECTIVE, worktrees: WT_ROWS() },
    refs: REFS88,
    effective: EFFECTIVE,
    activeRef: 'main',
    repo: EFFECTIVE,
  }, over)
}
const wait = env.wait
/* 每棵树都带着渲染它的 props（__props88）：交互后的重渲染永远用最新 props，
   openMenu / setArm 的状态才能落进下一棵树。 */
const R = async function (props) {
  const t = await env.renderUntilStable(makeEl(WorktreeBox, props), 'wt88')
  t.__props88 = props
  return t
}
const RS = async function (props) {
  let t = null
  for (let i = 0; i < 5; i += 1) { t = await R(props); await wait(10) }
  return t
}
const headOf = (t) => byCls(t, 'dsh-git-wt-head')[0]
const rowsOf = (t) => byCls(t, 'dsh-git-wt-row')
const moreOf = (t) => byCls(t, 'dsh-git-wt-more')[0]
const noteOf = (t) => byCls(t, 'dsh-git-wt-note')[0]
const menuOf = (t) => byCls(t, 'dsh-git-menu')[0]
const menuButtons = (t) => (menuOf(t) === undefined ? [] : buttonsOf(menuOf(t)))
const rowByPath = (t, p) => rowsOf(t).find((r) => String(r.props.key) === 'wt:' + p)
const ctxOf = (t, p) => {
  const row = rowByPath(t, p)
  return row !== undefined && typeof row.props.onContextMenu === 'function' ? row.props.onContextMenu : null
}
const rightClick = async function (t, p) {
  const fn = ctxOf(t, p)
  if (fn === null) throw new Error('gp88: 行 ' + p + ' 没有右键挂点')
  fn({ clientX: 8, clientY: 8, preventDefault() {}, stopPropagation() {} })
  await wait(10)
  return await R(t.__props88)
}
const clickMenu = async function (t, text) {
  const hit = menuButtons(t).find((b) => textOf(b) === text)
  if (hit === undefined) throw new Error('gp88: 菜单里没有「' + text + '」')
  hit.props.onClick({ stopPropagation() {} })
  await wait(10)
  return await R(t.__props88)
}
/* 行清除的两段确认（右键 → 武装 → 确认）走完，返回发单后的树。 */
const clearRow = async function (t, p) {
  const opened = await rightClick(t, p)
  const armed = await clickMenu(opened, '清除这个 worktree')
  return await clickMenu(armed, '确认清除这个 worktree')
}

console.log('')
console.log('=== WorktreeBox v1.4：canRemove 总开关（onWorktreeRemove 没传 → 整段 UI 不出现）===')
{
  const t = await RS(boxProps({})) /* 不给 onWorktreeRemove（v1.2 及更早的调用方） */
  ok('canRemove 关：没有「…」触发器（dsh-git-wt-more 一个都不在）', moreOf(t) === undefined)
  ok('canRemove 关：全部清单行（含游离 wt-b / 失联 wt-c）都没有右键挂点',
    rowsOf(t).every((r) => typeof r.props.onContextMenu !== 'function'))
  ok('canRemove 关：块头整行没有右键挂点', typeof headOf(t).props.onContextMenu !== 'function')
  ok('canRemove 关：块头 title 不带清除语义的后半句',
    String(headOf(t).props.title).indexOf('清除') < 0)
  ok('canRemove 关：清单行原样渲染（5 行：正常/游离/失联/locked/bare），块与行账户没被动过',
    rowsOf(t).length === 5 && byCls(t, 'dsh-git-wt-box')[0] !== undefined)
}

console.log('')
console.log('=== 行菜单矩阵：只挂 detached / prunable；块头两处入口 ===')
let removeCalls = []
/* git/worktree-remove 的桩剧本：{reply} 成功 / {failure} 已答失败 / {thrown} 运输层
   失败 / {gate} 挂着等放行（放行口在 removeGates，逐个 resolve/reject）。 */
let removeScript = null
let removeGates = []
const replyOf = (fields) => ({ ok: true, repo: EFFECTIVE, path: fields.path, worktrees: [] })
const onRemove88 = function (fields) {
  removeCalls.push(fields)
  if (removeScript !== null && removeScript.gate === true) {
    return new Promise((resolve, reject) => { removeGates.push({ resolve: resolve, reject: reject, path: fields.path }) })
  }
  if (removeScript === null || removeScript.reply !== undefined) {
    return Promise.resolve(removeScript === null ? replyOf(fields) : removeScript.reply)
  }
  /* {failure} 剧本模拟的是「rpc 折话之后」的失败：80-panel.js 的 rpc 会把 ok:false
     的答复折成带 reply 的 rejection（wtRemoveFailureText 吃 failure.reply）—— 这个
     桩站在 props.onWorktreeRemove 的位置，所以失败必须 reject，resolve(ok:false)
     会被 runClear 的 then(ok) 当成成功。 */
  if (removeScript.failure !== undefined) {
    return Promise.reject(Object.assign(new Error('git 拒绝'), { reply: removeScript.failure }))
  }
  return Promise.reject(new Error(removeScript.thrown === undefined ? 'transport down' : removeScript.thrown))
}
let t88 = await RS(boxProps({ onWorktreeRemove: onRemove88 }))
{
  ok('canRemove 开：「…」触发器在场，title 报可清数（当前 2 个可清）',
    moreOf(t88) !== undefined && String(moreOf(t88).props.title).indexOf('当前 2 个可清') >= 0)
  ok('块头 title 带清除语义的后半句（右键块头或点「…」）',
    String(headOf(t88).props.title).indexOf('右键块头或点右端「…」') >= 0)
  ok('行菜单挂游离行（wt-b）与失联行（wt-c）',
    ctxOf(t88, '/tmp/lab/wt-b') !== null && ctxOf(t88, '/tmp/lab/wt-c') !== null)
  ok('行菜单不挂正常行（wt-a）、locked 行（wt-d）、bare 行（wt-e）',
    ctxOf(t88, '/tmp/lab/wt-a') === null && ctxOf(t88, '/tmp/lab/wt-d') === null
    && ctxOf(t88, '/tmp/lab/wt-e') === null)
  const lockedTip = String(rowByPath(t88, '/tmp/lab/wt-d').props.title)
  ok('locked 行 tooltip 说明为什么不给清（git 会拒绝）',
    lockedTip.indexOf('已锁定') >= 0 && lockedTip.indexOf('不能在这里清除') >= 0)
  const clearableTip = String(rowByPath(t88, '/tmp/lab/wt-b').props.title)
  ok('可清行 tooltip 指路（右键：清除这个 worktree）',
    clearableTip.indexOf('右键：清除这个 worktree') >= 0)
  const bareTip = String(rowByPath(t88, '/tmp/lab/wt-e').props.title)
  ok('bare 行不给右键、tooltip 还是 bare 的那句话',
    ctxOf(t88, '/tmp/lab/wt-e') === null && bareTip.indexOf('bare 仓库') >= 0)
}

/* 「…」触发器的单击事件桩：openMenu 会调 preventDefault + stopPropagation。 */
const clickEv = () => ({ clientX: 8, clientY: 8, preventDefault() {}, stopPropagation() {} })

console.log('')
console.log('=== 块级菜单：「…」单击与块头整行右键同一张；N=0 置灰 ===')
{
  moreOf(t88).props.onClick(clickEv())
  t88 = await R(t88.__props88)
  ok('「…」单击开块级菜单（dsh-git-menu 在树，项是「一键清除（2）」）',
    menuOf(t88) !== undefined && menuButtons(t88).some((b) => textOf(b) === '一键清除（2）'))
  ok('「…」单击不把块折起来：清单 5 行原样都在', rowsOf(t88).length === 5)
  ok('N=2：一键清除可用，菜单底注说清除语义与「逐个执行、单个失败不影响其余」',
    menuButtons(t88).find((b) => textOf(b) === '一键清除（2）').props.disabled !== true
    && textOf(menuOf(t88)).indexOf('不碰主工作区') >= 0
    && textOf(menuOf(t88)).indexOf('单个失败不影响其余') >= 0)
  headOf(t88).props.onContextMenu({ clientX: 4, clientY: 4, preventDefault() {}, stopPropagation() {} })
  t88 = await R(t88.__props88)
  ok('块头整行右键开同一张菜单（同样「一键清除（2）」，且作废旧菜单时武装复位 —— 项无红字）',
    menuButtons(t88).some((b) => textOf(b) === '一键清除（2）')
    && menuButtons(t88).every((b) => String(b.props.className).indexOf('dsh-git-menu-danger') < 0))
  ok('N=2 未武装的 title 说逐个清（wt-b、wt-c）与「再点一次确认」',
    String(menuButtons(t88).find((b) => textOf(b) === '一键清除（2）').props.title).indexOf('wt-b、wt-c') >= 0
    && String(menuButtons(t88).find((b) => textOf(b) === '一键清除（2）').props.title).indexOf('再点一次确认') >= 0)
}
{
  const t0 = await (async function () {
    let t = await RS(boxProps({
      data: { ok: true, repo: EFFECTIVE, worktrees: WT_ROWS().filter((one) => one.detached !== true && one.prunable !== true) },
      onWorktreeRemove: onRemove88,
    }))
    moreOf(t).props.onClick(clickEv())
    return await R(t.__props88)
  })()
  const zero = menuButtons(t0).find((b) => textOf(b) === '一键清除（0）')
  ok('N=0：项还在但置灰（一键清除（0）disabled），title 说没有可清的、点名哪三种不行',
    zero !== undefined && zero.props.disabled === true
    && String(zero.props.title).indexOf('没有可清除的 worktree') >= 0
    && String(zero.props.title).indexOf('游离') >= 0 && String(zero.props.title).indexOf('目录已丢失') >= 0
    && String(zero.props.title).indexOf('🔒 锁定') >= 0)
  const before = removeCalls.length
  zero.props.onClick({ stopPropagation() {} })
  await wait(10)
  ok('N=0 点了也不发单（disabled 的 onClick 早退）', removeCalls.length === before)
}

console.log('')
console.log('=== 行菜单 armed 二段确认：第一次只武装，第二次发且只发一单 ===')
{
  const mark = removeCalls.length
  const opened = await rightClick(t88, '/tmp/lab/wt-b')
  ok('行菜单开着：项「清除这个 worktree」，未武装不红',
    menuButtons(opened).some((b) => textOf(b) === '清除这个 worktree')
    && menuButtons(opened).every((b) => String(b.props.className).indexOf('dsh-git-menu-danger') < 0))
  ok('未武装的 title 是 git 命令原文与清除语义（再点一次确认）',
    String(menuButtons(opened).find((b) => textOf(b) === '清除这个 worktree').props.title).indexOf('git worktree remove /tmp/lab/wt-b') >= 0
    && String(menuButtons(opened).find((b) => textOf(b) === '清除这个 worktree').props.title).indexOf('再点一次确认') >= 0)
  const armedT = await clickMenu(opened, '清除这个 worktree')
  const armed = menuButtons(armedT).find((b) => textOf(b) === '确认清除这个 worktree')
  ok('第一次点：变红字「确认清除这个 worktree」（dsh-git-menu-danger），没有发单',
    armed !== undefined && String(armed.props.className).indexOf('dsh-git-menu-danger') >= 0
    && removeCalls.length === mark)
  const sentProps = (await clickMenu(armedT, '确认清除这个 worktree')).__props88
  const sentT = await RS(sentProps)
  ok('第二次点：发且只发一单 {path}（业务字段就一个 path，80-panel.js 在另一层补会话与仓库）',
    removeCalls.length === mark + 1 && removeCalls[mark].path === '/tmp/lab/wt-b'
    && removeCalls[mark].sessionId === undefined && removeCalls[mark].repo === undefined)
  ok('发出后菜单关了，成功答复回来后块内出现绿格 note（「已清除 worktree wt-b」）',
    menuOf(sentT) === undefined && noteOf(sentT) !== undefined
    && textOf(noteOf(sentT)) === '已清除 worktree wt-b')
}

console.log('')
console.log('=== 武装复位：开新菜单作废旧菜单（arm 一并清）===')
{
  const mark = removeCalls.length
  const armedT = await (async function () {
    const opened = await rightClick(t88, '/tmp/lab/wt-b')
    return await clickMenu(opened, '清除这个 worktree')
  })()
  ok('wt-b 的菜单上了膛（红字确认态）',
    menuButtons(armedT).some((b) => textOf(b) === '确认清除这个 worktree'
      && String(b.props.className).indexOf('dsh-git-menu-danger') >= 0))
  const fresh = await rightClick(armedT, '/tmp/lab/wt-c')
  ok('换 wt-c 开新菜单：武装复位 —— 项回「清除这个 worktree」且不红，旧目标的确认态消失',
    menuButtons(fresh).some((b) => textOf(b) === '清除这个 worktree' && String(b.props.className).indexOf('dsh-git-menu-danger') < 0)
    && menuButtons(fresh).every((b) => textOf(b) !== '确认清除这个 worktree'))
  const armed2 = await clickMenu(fresh, '清除这个 worktree')
  const stillMark = removeCalls.length
  ok('新菜单第一次点也只是武装（不发单）',
    removeCalls.length === stillMark && menuButtons(armed2).some((b) => textOf(b) === '确认清除这个 worktree'))
  const sent = await clickMenu(armed2, '确认清除这个 worktree')
  await RS(sent.__props88)
  ok('第二次点发的是新行（wt-c）：作废后的武装没把旧目标捎上',
    removeCalls.length === stillMark + 1 && removeCalls[stillMark].path === '/tmp/lab/wt-c'
    && menuOf(sent) === undefined)
}

console.log('')
console.log('=== 当前生效仓库的确认警告前缀（path === effective）===')
{
  const mine = boxProps({
    data: { ok: true, repo: EFFECTIVE, worktrees: WT_ROWS().concat([
      { path: EFFECTIVE, head: 'fff', branch: '', detached: true, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    ]) },
    onWorktreeRemove: onRemove88,
  })
  let tm = await RS(mine)
  tm = await rightClick(tm, EFFECTIVE)
  tm = await clickMenu(tm, '清除这个 worktree')
  const warned = menuButtons(tm).find((b) => textOf(b) === '确认清除这个 worktree')
  ok('被清的是当前生效仓库：武装后 title 以 ⚠ 警告前缀开头（变更列表就没有仓库可看了）',
    warned !== undefined && String(warned.props.title).indexOf('⚠ 这是变更列表正看着的工作区') === 0
    && String(warned.props.title).indexOf('变更列表就没有仓库可看了') >= 0)
  tm = await rightClick(tm, '/tmp/lab/wt-b')
  tm = await clickMenu(tm, '清除这个 worktree')
  const quiet = menuButtons(tm).find((b) => textOf(b) === '确认清除这个 worktree')
  ok('不是生效仓库的行：同样的确认态，title 没有 ⚠ 前缀（直接是 git 命令原文）',
    quiet !== undefined && String(quiet.props.title).indexOf('⚠') < 0
    && String(quiet.props.title).indexOf('git worktree remove /tmp/lab/wt-b') === 0)
}

console.log('')
console.log('=== 一键清除：逐个顺序发（pending 门）、单个失败不中断其余 ===')
{
  const mark = removeCalls.length
  removeScript = { gate: true }
  removeGates = []
  let tg = await RS(boxProps({ onWorktreeRemove: onRemove88 }))
  moreOf(tg).props.onClick(clickEv())
  tg = await R(tg.__props88)
  tg = await clickMenu(tg, '一键清除（2）')
  const armedAll = menuButtons(tg).find((b) => textOf(b) === '确认清除（2）')
  ok('一键清除武装：变红「确认清除（2）」，title 说逐个执行，还没有发单',
    armedAll !== undefined && String(armedAll.props.className).indexOf('dsh-git-menu-danger') >= 0
    && String(armedAll.props.title).indexOf('逐个执行') >= 0 && removeCalls.length === mark)
  tg = await clickMenu(tg, '确认清除（2）')
  await wait(20)
  tg = await R(tg.__props88)
  await wait(20)
  tg = await R(tg.__props88)
  ok('菜单关、第一单出门（wt-b）、第二单还没发 —— 上一单答完才发下一单（逐个串行）',
    menuOf(tg) === undefined && removeCalls.length === mark + 1
    && removeCalls[mark].path === '/tmp/lab/wt-b')
  removeGates[0].resolve(replyOf(removeCalls[mark]))
  await wait(20)
  tg = await R(tg.__props88)
  await wait(20)
  tg = await R(tg.__props88)
  ok('第一单答完：第二单出门（wt-c）——顺序就是清单里的顺序，不是并发',
    removeCalls.length === mark + 2 && removeCalls[mark + 1].path === '/tmp/lab/wt-c')
  removeScript = { failure: { ok: false, exitCode: 128, stderr: "fatal: '/tmp/lab/wt-c' contains modified or untracked files, use --force to delete it", path: '/tmp/lab/wt-c' } }
  removeGates[1].reject(Object.assign(new Error('git 拒绝'), { reply: removeScript.failure }))
  await wait(20)
  tg = await RS(tg.__props88)
  removeScript = null
  const note = noteOf(tg)
  ok('一个失败没有中断其余（两单都发了），块内 note 是红格（-bad）',
    removeCalls.length === mark + 2 && note !== undefined
    && String(note.props.className).indexOf('dsh-git-wt-note-bad') >= 0)
  ok('部分失败的 note 口径：先说清成了几个（1 个，wt-b），再逐行点名没成的与原因',
    textOf(note).indexOf('清除了 1 个（wt-b）') >= 0
    && textOf(note).indexOf('1 个没成') >= 0
    && textOf(note).indexOf('· wt-c ——') >= 0)
  ok('--force 被点名的失败带上手动出路（面板不给强删入口：手动 git worktree remove --force <path>）',
    textOf(note).indexOf('手动执行 git worktree remove --force /tmp/lab/wt-c') >= 0)
  ok('失败 note 的 title 说「有没清成的」',
    String(note.props.title).indexOf('有没清成的') >= 0)
  const before = textOf(note)
  note.props.onClick()
  tg = await R(tg.__props88)
  ok('点一下 note 收起（块内辅助信息不上顶部横幅的格调）',
    noteOf(tg) === undefined && before.length > 0)
}

console.log('')
console.log('=== note 三色格口径：单个成功 / 多个全成功 / 全败 / busy ===')
{
  removeScript = null
  let ts = await RS(boxProps({ onWorktreeRemove: onRemove88 }))
  const markS = removeCalls.length
  ts = await clearRow(ts, '/tmp/lab/wt-b')
  const noteS = noteOf(ts)
  ok('单个成功（行菜单两段）：绿格（-ok）「已清除 worktree wt-b」，title 说清除完成',
    noteS !== undefined && String(noteS.props.className).indexOf('dsh-git-wt-note-ok') >= 0
    && textOf(noteS) === '已清除 worktree wt-b' && String(noteS.props.title).indexOf('清除完成') >= 0
    && removeCalls.length === markS + 1)

  removeScript = { gate: true }
  removeGates = []
  let ta = await RS(boxProps({ onWorktreeRemove: onRemove88 }))
  const markA = removeCalls.length
  moreOf(ta).props.onClick(clickEv())
  ta = await R(ta.__props88)
  ta = await clickMenu(ta, '一键清除（2）')
  ta = await clickMenu(ta, '确认清除（2）')
  await wait(20)
  ta = await R(ta.__props88)
  removeGates[0].resolve(replyOf(removeCalls[markA]))
  await wait(20)
  ta = await R(ta.__props88)
  removeGates[1].resolve(replyOf(removeCalls[markA + 1]))
  await wait(20)
  ta = await RS(ta.__props88)
  removeScript = null
  const noteA = noteOf(ta)
  ok('两个都成：绿格「已清除 2 个 worktree：wt-b、wt-c」（逐个点的短名清单）',
    noteA !== undefined && String(noteA.props.className).indexOf('dsh-git-wt-note-ok') >= 0
    && textOf(noteA) === '已清除 2 个 worktree：wt-b、wt-c')

  removeScript = { gate: true }
  removeGates = []
  let tf = await RS(boxProps({ onWorktreeRemove: onRemove88 }))
  const markF = removeCalls.length
  moreOf(tf).props.onClick(clickEv())
  tf = await R(tf.__props88)
  tf = await clickMenu(tf, '一键清除（2）')
  tf = await clickMenu(tf, '确认清除（2）')
  await wait(20)
  tf = await R(tf.__props88)
  /* 先换成第二个 failure 剧本再拒第一单：第二单出门时立即收到失败应答（校验层
     error 那种没有 stderr 的拒绝），不建门 —— 这本身就是「失败不连坐、下一单
     照发」的形状；第一单的 why 从 reject 带的 reply 折（stderr 首行）。 */
  removeScript = { failure: { ok: false, error: '这个路径不在本仓库的 worktree 清单里（git worktree list 没有它）：只能清除 git 自己登记的工作区' } }
  removeGates[0].reject(Object.assign(new Error('第一个不行'), { reply: { ok: false, exitCode: 128, stderr: 'fatal: 第一个不行' } }))
  await wait(20)
  tf = await RS(tf.__props88)
  removeScript = null
  const noteF = noteOf(tf)
  ok('全败：红格「一个都没清成：」，两行各自的原话（stderr 首行 / 校验层 error 原句带尾段人话）都在',
    noteF !== undefined && String(noteF.props.className).indexOf('dsh-git-wt-note-bad') >= 0
    && textOf(noteF).indexOf('一个都没清成：') === 0
    && textOf(noteF).indexOf('· wt-b —— fatal: 第一个不行') >= 0
    && textOf(noteF).indexOf('· wt-c —— 这个路径不在本仓库的 worktree 清单里') >= 0
    && textOf(noteF).indexOf('只能清除 git 自己登记的工作区') >= 0)

  removeScript = { gate: true }
  removeGates = []
  let tb = await RS(boxProps({ onWorktreeRemove: onRemove88 }))
  const markB = removeCalls.length
  moreOf(tb).props.onClick(clickEv())
  tb = await R(tb.__props88)
  tb = await clickMenu(tb, '一键清除（2）')
  tb = await clickMenu(tb, '确认清除（2）')
  await wait(20)
  tb = await R(tb.__props88)
  moreOf(tb).props.onClick(clickEv())
  tb = await R(tb.__props88)
  const busyBtn = menuButtons(tb).find((b) => textOf(b) === '一键清除（2）')
  ok('清除在飞（第一单挂着）：重开块级菜单，一键清除 disabled（busy 的项点不动）',
    busyBtn !== undefined && busyBtn.props.disabled === true && removeCalls.length === markB + 1)
  removeGates[0].resolve(replyOf(removeCalls[markB]))
  /* 先换成 failure 剧本再放行第一单：第二单出门时立即收到失败应答（不建门）。 */
  removeScript = { failure: { ok: false, stderr: 'fatal: busy 收尾' } }
  await wait(20)
  tb = await RS(tb.__props88)
  removeScript = null
  ok('busy 收尾后红格 note 出场，一切回到能再点的状态',
    noteOf(tb) !== undefined && String(noteOf(tb).props.className).indexOf('dsh-git-wt-note-bad') >= 0)
}

console.log('')
console.log('=== 失败折话（wtRemoveFailureText）：noGit / 沙箱 / --force / 校验层 / 旧宿主 / 运输层 ===')
{
  const say = (failure) => api.wtRemoveFailureText(failure)
  ok('noGit 答复：专门话术（这台机器上找不到 git）',
    say({ reply: { ok: false, noGit: true, stderr: '', exitCode: 127 } }).indexOf('这台机器上找不到 git') >= 0)
  ok('sandboxDenied 答复：专门话术（文件沙箱不允许这次清除）',
    say({ reply: { ok: false, sandboxDenied: true, stderr: 'Permission denied' } }).indexOf('沙箱') >= 0)
  ok('stderr 里有 --force：原话之后附加「手动 git worktree remove --force <path>」的出路',
    say({ reply: { ok: false, exitCode: 128, stderr: "fatal: '/x' contains modified or untracked files, use --force to delete it", path: '/x' } })
      .indexOf('手动执行 git worktree remove --force /x') >= 0)
  ok('host 校验层拒绝（没有 stderr）：落 reply.error 那句人话',
    say({ reply: { ok: false, error: '这是主工作区（清单第一条）：面板不清主工作区' } }).indexOf('主工作区') >= 0)
  const oldHost = say(new Error('git/worktree-remove is not registered'))
  ok('宿主进程还是旧版（运输层 is not registered，无 reply）：说重启 DSH 加载新版宿主，不甩原文',
    oldHost.indexOf('重启 DSH') >= 0 && oldHost.indexOf('is not registered') < 0)
  ok('真没答复的普通运输失败：兜底话术原样（failureText 那句）',
    say(new Error('socket gone')) === 'socket gone')
}

console.log('')
console.log('=== 折叠态：清除入口与 note 不收 ===')
{
  removeScript = null
  let td = await RS(boxProps({ onWorktreeRemove: onRemove88 }))
  headOf(td).props.onClick() /* 折叠 */
  td = await R(td.__props88)
  ok('折叠后清单行收起（dsh-git-wt-row 一个不剩）', rowsOf(td).length === 0)
  ok('折叠态「…」触发器还在', moreOf(td) !== undefined)
  moreOf(td).props.onClick(clickEv())
  td = await R(td.__props88)
  ok('折叠态点「…」照样开块级菜单（入口不收）',
    menuOf(td) !== undefined && menuButtons(td).some((b) => textOf(b) === '一键清除（2）'))
  headOf(td).props.onClick() /* 展开，回常态 */
  td = await R(td.__props88)
  ok('再点展开：清单回来（5 行）', rowsOf(td).length === 5)
}

/* ═══ 2. 面板世界：80-panel.js 的接线（gp73 骨架）═══
 *
 * worktreeRemove 统一发 git/worktree-remove：payload = 块的业务字段 {path} + base
 * 补的 {sessionId, repo: 生效仓库}；失败（failure.reply 在）也 bump —— 读数刷新不
 * 落空。历史 / 变更两页的 worktreeProps 都透传 onWorktreeRemove（两页都有「…」）。
 * 挂真面板点真菜单，菜单浮层是 80-panel.js 的 ContextMenu 本尊。 */

console.log('')
console.log('=== 面板世界：worktreeRemove 的 rpc 接线（payload 补齐 + 失败也 bump）===')

/* build.mjs 的 render 是纯函数（不写仓库内任何文件）：面板世界的 client 半边照
   gp86 的办法现拼 src/ —— GP_FRESH 场合仓库产物可能是旧的，套件测的永远是 src/。 */
const built = await import(ROOT + 'build.mjs')
const clientTmp = path.join(os.tmpdir(), 'gp88-client-' + process.pid + '.js')
fs.writeFileSync(clientTmp, built.render(built.TARGETS.find((t) => t.out === 'dist/client.js')))
const R88 = '/tmp/gp88-repo'
const CLEAN = '/tmp/gp88-wt-clean'
const DIRTY = '/tmp/gp88-wt-dirty'
const GONE = '/tmp/gp88-wt-gone'
const HOME88 = '/tmp/gp88-home'
process.on('exit', () => {
  for (const p of [clientTmp, R88, CLEAN, DIRTY, GONE, HOME88]) {
    try { fs.rmSync(p, { recursive: true, force: true }) } catch (error) { /* 尽力而为 */ }
  }
})
const penv = makeEnv({ arrayByRef: true, document: false, window: false })
const pcomponents = penv.apply(fs.readFileSync(clientTmp, 'utf8'))
/* 面板世界的清单：正常 / 游离 / 失联 / locked（bare 那行 Host 本来就不发）。 */
const WT_PANEL = {
  ok: true, repo: '/tmp/ws',
  worktrees: WT_ROWS().filter((one) => one.path !== '/tmp/lab/wt-e').map((one) => Object.assign({}, one)),
}
let wtReplyPanel = null
const wtReads = []
const rpcCalls = []
let rpcFail = null
const realCall = penv.host.call
penv.host.call = function (method, args) {
  if (method === 'git/worktrees') {
    wtReads.push(args)
    if (wtReplyPanel !== null) return Promise.resolve(wtReplyPanel)
    return Promise.resolve(WT_PANEL)
  }
  if (method === 'git/refs') return Promise.resolve(REFS88)
  if (method === 'git/repos') return Promise.resolve({ ok: true, workspace: '/tmp/ws', repos: ['/tmp/ws'], manual: [], missing: [], links: [] })
  if (method === 'git/worktree-remove') {
    rpcCalls.push(args)
    if (rpcFail !== null) return Promise.resolve(rpcFail)
    return Promise.resolve({ ok: true, repo: '/tmp/ws', path: args != null ? args.path : '', worktrees: WT_PANEL.worktrees })
  }
  if (method === 'git/panel') return Promise.resolve({ ok: true, repo: (args && args.repo) || '/tmp/ws', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] })
  if (method === 'git/graph') return Promise.resolve({ ok: true, repo: (args && args.repo) || '/tmp/ws', ref: (args && args.ref) || 'main', currentBranch: 'main', commits: [], rows: [], lanes: 1 })
  return realCall(method, args)
}
const pwait = penv.wait
/* sessionId 必须真的落进 props：base() 拿它填 payload 的 sessionId，传 undefined
   的话 JSON 里那个字段整个消失（账面上像「没带会话」）。 */
const pop88 = (sid) => penv.renderUntilStable(penv.makeElement(pcomponents.popover, { sessionId: sid || 's-88' }), sid || 's-88')
async function settlePanel(sid) {
  let t = null
  for (let i = 0; i < 4; i += 1) { t = await pop88(sid); await pwait(10) }
  return t
}
const pmore = (t) => byCls(t, 'dsh-git-wt-more')[0]
const pmenu = (t) => byCls(t, 'dsh-git-menu')[0]
const pmenuButtons = (t) => (pmenu(t) === undefined ? [] : buttonsOf(pmenu(t)))
const clickPanelMenu = async function (t, text) {
  const hit = pmenuButtons(t).find((b) => textOf(b) === text)
  if (hit === undefined) throw new Error('gp88: 面板菜单里没有「' + text + '」')
  hit.props.onClick({ stopPropagation() {} })
  await pwait(30)
  return await settlePanel()
}

penv.fibers.clear()
let chip88 = await penv.renderUntilStable(penv.makeElement(pcomponents.chip, { sessionId: 's-88' }), 'chip-88')
if (chip88.props.className.indexOf('dsh-git-chip-open') < 0) { chip88.props.onClick(); await pwait(10) }
let panel88 = await settlePanel()
{
  ok('历史页的 worktree 块带着「…」（80-panel.js 的 worktreeProps 透传了 onWorktreeRemove）',
    pmore(panel88) !== undefined)
  pmore(panel88).props.onClick(clickEv())
  await pwait(10)
  panel88 = await settlePanel()
  ok('历史页块头菜单开（真 ContextMenu 浮层，项「一键清除（2）」）',
    pmenuButtons(panel88).some((b) => textOf(b) === '一键清除（2）'))
  const wtMark = wtReads.length
  const marks = rpcCalls.length
  panel88 = await clickPanelMenu(panel88, '一键清除（2）')
  panel88 = await clickPanelMenu(panel88, '确认清除（2）')
  ok('面板发单：payload = {path} + base 补的 sessionId/repo（生效仓库 /tmp/ws）',
    rpcCalls.length === marks + 2
    && rpcCalls[marks].sessionId === 's-88' && rpcCalls[marks].repo === '/tmp/ws'
    && rpcCalls[marks].path === '/tmp/lab/wt-b'
    && rpcCalls[marks + 1].path === '/tmp/lab/wt-c')
  ok('成功也 bump：git/worktrees 在清除后重读了（清单刷新全靠 bump，块不按答复刷）',
    wtReads.length > wtMark)
  ok('面板清除完出绿格 note（80-panel.js → 块内 note 的落点）',
    byCls(panel88, 'dsh-git-wt-note-ok').length > 0)

  const wtMark2 = wtReads.length
  const marks2 = rpcCalls.length
  rpcFail = { ok: false, exitCode: 128, stderr: 'fatal: 面板世界的拒绝' }
  pmore(panel88).props.onClick(clickEv())
  await pwait(10)
  panel88 = await settlePanel()
  panel88 = await clickPanelMenu(panel88, '一键清除（2）')
  panel88 = await clickPanelMenu(panel88, '确认清除（2）')
  rpcFail = null
  ok('失败也 bump（failure.reply 在）：host 那头的整仓失效可能已发生，读数照样刷（两单照发、逐个不连坐）',
    rpcCalls.length === marks2 + 2 && wtReads.length > wtMark2)
  ok('失败折进红格 note（stderr 首行的原话在块内，不上顶部错误横幅）',
    byCls(panel88, 'dsh-git-wt-note-bad').some((n) => textOf(n).indexOf('fatal: 面板世界的拒绝') >= 0))
}

console.log('')
console.log('=== 面板世界：变更页（仓库模式）同样有清除入口 ===')
{
  const changesBtn = buttonsOf(panel88).find((b) => textOf(b).indexOf('变更') === 0)
  changesBtn.props.onClick()
  panel88 = await settlePanel()
  ok('变更页左栏的 worktree 块也有「…」（两处 worktreeProps 都透传了 onWorktreeRemove）',
    pmore(panel88) !== undefined)
  pmore(panel88).props.onClick(clickEv())
  await pwait(10)
  panel88 = await settlePanel()
  ok('变更页块头菜单同样开着（一键清除（2））',
    pmenuButtons(panel88).some((b) => textOf(b) === '一键清除（2）'))
}

/* ═══ 3. Host：git/worktree-remove（罐头：门票三道、argv、答复形状）═══ */

let hostBody = process.env.GP_SRC || null
if (hostBody === null) {
  hostBody = built.render(built.TARGETS.find((t) => t.out === 'dist/host.js'))
} else {
  hostBody = fs.readFileSync(hostBody, 'utf8')
}

console.log('')
console.log('=== Host：git/worktree-remove（桩 run：门票三道、argv、答复形状）===')

const porcelainMain = 'worktree /tmp/gp88/main\nHEAD 1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa\nbranch refs/heads/main\n'
const porcelainWith = (extra) => porcelainMain + extra
const WT_ONE = 'worktree /tmp/gp88/one\nHEAD 2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb\nbranch refs/heads/feat\n'
const WT_TWO = 'worktree /tmp/gp88/two\nHEAD 4444dddd4444dddd4444dddd4444dddd4444dddd\nbranch refs/heads/feat2\n'

function makeHost88() {
  /* porcelain 队列：remove 前的现读弹第一份，成功后快照弹第二份 —— 两份账本就是
     「答复带最新清单」的证据。remove 的 git 结果按剧本。 */
  const runs = []
  let porcelainQueue = [porcelainWith(WT_ONE), porcelainMain]
  let removeResult = { exitCode: 0, stdout: '', stderr: '' }
  const shellService = {
    resolve: (r) => r,
    run: (spec) => {
      runs.push(spec)
      const cmd = String(spec.command)
      if (cmd.indexOf("'worktree' 'remove'") >= 0) {
        return Promise.resolve({ exitCode: removeResult.exitCode, stdout: { text: removeResult.stdout }, stderr: { text: removeResult.stderr }, sandbox: removeResult.sandbox })
      }
      if (cmd.indexOf("'worktree' 'list' '--porcelain'") >= 0) {
        /* 队列元素收字符串（porcelain 原文）或对象 {exitCode, stdout, stderr}：
           字符串按 exitCode 0 归一。缺省退出码兜成 0 —— invoke 读 raw.exitCode，
           null 会被当成「git 都没跑成」。 */
        const next = porcelainQueue.length > 0 ? porcelainQueue.shift() : { exitCode: 0, stdout: '', stderr: '' }
        const one = typeof next === 'string' ? { exitCode: 0, stdout: next, stderr: '' } : next
        return Promise.resolve({ exitCode: one.exitCode == null ? 0 : one.exitCode, stdout: { text: one.stdout }, stderr: { text: one.stderr } })
      }
      return Promise.resolve({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
    },
  }
  const handlers = new Map()
  const ctx = { get: (n) => (n === 'shell' ? shellService : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', hostBody)(
    ctx, harness, console, (s) => Buffer.from(s, 'binary').toString('base64'),
    (s) => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return {
    H: (n) => handlers.get(n),
    runs: runs,
    setQueue: (q) => { porcelainQueue = q },
    setRemove: (r) => { removeResult = r },
  }
}
const removeRuns = (runs) => runs.filter((r) => r.command.indexOf("'worktree' 'remove'") >= 0)
const listRuns88 = (runs) => runs.filter((r) => r.command.indexOf("'worktree' 'list' '--porcelain'") >= 0)

{
  const a = makeHost88()
  const missing = await a.H('git/worktree-remove')({ sessionId: 's' })
  ok('path 缺失：ok:false「要清除的工作区路径必填」，worktree 的 remove / list 一条都没跑（apply 期的配置探测不算）',
    missing.ok === false && missing.error.indexOf('要清除的工作区路径必填') >= 0
    && removeRuns(a.runs).length === 0 && listRuns88(a.runs).length === 0)
  const relative = await a.H('git/worktree-remove')({ sessionId: 's', repo: '/tmp/gp88/main', path: 'wt/relative' })
  ok('相对路径：ok:false「绝对路径」，同样零命令（清单都不读）',
    relative.ok === false && relative.error.indexOf('绝对路径') >= 0 && relative.path === 'wt/relative'
    && removeRuns(a.runs).length === 0 && listRuns88(a.runs).length === 0)

  const b = makeHost88()
  b.setQueue([{ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }])
  const unreadable = await b.H('git/worktree-remove')({ sessionId: 's', repo: '/tmp/gp88/main', path: '/tmp/gp88/one' })
  ok('清单读不出来：ok:false「worktree 清单读不出来」并把 stderr 首行带上，remove 没跑',
    unreadable.ok === false && unreadable.error.indexOf('worktree 清单读不出来') >= 0
    && unreadable.error.indexOf('fatal: not a git repository') >= 0
    && removeRuns(b.runs).length === 0)

  const c = makeHost88()
  c.setQueue([{ exitCode: 127, stdout: '', stderr: 'dsh-git-idea: no git on PATH\n' }])
  const noGit = await c.H('git/worktree-remove')({ sessionId: 's', repo: '/tmp/gp88/main', path: '/tmp/gp88/one' })
  ok('机器上没有 git（127 + 标记字）：noGit 旗标与人话同答，remove 没跑',
    noGit.ok === false && noGit.noGit === true
    && noGit.error.indexOf('这台机器上找不到 git') >= 0 && removeRuns(c.runs).length === 0)

  const d = makeHost88()
  const stranger = await d.H('git/worktree-remove')({ sessionId: 's', repo: '/tmp/gp88/main', path: '/tmp/gp88/stranger' })
  ok('清单外路径：ok:false「不在本仓库的 worktree 清单里」，remove 没跑（只现读了一次清单）',
    stranger.ok === false && stranger.error.indexOf('不在本仓库的 worktree 清单里') >= 0
    && stranger.path === '/tmp/gp88/stranger'
    && removeRuns(d.runs).length === 0 && listRuns88(d.runs).length === 1)

  const e = makeHost88()
  const mainRow = await e.H('git/worktree-remove')({ sessionId: 's', repo: '/tmp/gp88/main', path: '/tmp/gp88/main' })
  ok('主工作区（清单第一条）：ok:false「主工作区」，remove 没跑',
    mainRow.ok === false && mainRow.error.indexOf('主工作区') >= 0 && removeRuns(e.runs).length === 0)

  const f = makeHost88()
  f.setQueue([porcelainMain + 'worktree /tmp/gp88/bare\nHEAD 3333cccc3333cccc3333cccc3333cccc3333cccc\nbare\n',
    porcelainMain])
  const bareRow = await f.H('git/worktree-remove')({ sessionId: 's', repo: '/tmp/gp88/main', path: '/tmp/gp88/bare' })
  ok('bare 记录：ok:false「bare 记录只有版本库没有工作区」，remove 没跑',
    bareRow.ok === false && bareRow.error.indexOf('bare') >= 0 && removeRuns(f.runs).length === 0)

  const g = makeHost88()
  g.setQueue([porcelainWith(WT_ONE), porcelainWith(WT_TWO)])
  const done = await g.H('git/worktree-remove')({ sessionId: 's', repo: '/tmp/gp88/main', path: '/tmp/gp88/one' })
  const cmd = removeRuns(g.runs)[0]
  ok('成功：argv 精确 `worktree remove <path>` —— 无 --force（面板不给强删入口），workdir 跟点名的仓库',
    done.ok === true && cmd.command.indexOf("'worktree' 'remove' '/tmp/gp88/one'") >= 0
    && cmd.command.indexOf('--force') < 0 && cmd.workdir === '/tmp/gp88/main')
  ok('成功答复 = panelMutate 结果 + 最新清单：repo/path/command/stdout/exitCode 各就各位',
    done.repo === '/tmp/gp88/main' && done.path === '/tmp/gp88/one'
    && done.command === 'git worktree remove /tmp/gp88/one' && done.exitCode === 0
    && done.noGit === false && done.sandboxDenied === false)
  ok('答复的 worktrees 是快照那份新账（one 清掉了、two 在）—— 客户端一次往返拿到「清成了」与「最新清单」',
    Array.isArray(done.worktrees) && done.worktrees.length === 1
    && done.worktrees[0].path === '/tmp/gp88/two')
  ok('panelMutate 无条件失效读缓存：清单跑了两次（remove 前现读一次 + 答复快照一次），不是缓存回魂',
    listRuns88(g.runs).length === 2)

  const h88 = makeHost88()
  h88.setRemove({ exitCode: 128, stdout: '', stderr: "fatal: '/tmp/gp88/one' contains modified or untracked files, use --force to delete it" })
  h88.setQueue([porcelainWith(WT_ONE), porcelainWith(WT_ONE)])
  const refused = await h88.H('git/worktree-remove')({ sessionId: 's', repo: '/tmp/gp88/main', path: '/tmp/gp88/one' })
  ok('git 拒绝（有未提交改动）：ok:false 且失败如实带回 —— exitCode 128、stderr 原话、人话命令',
    refused.ok === false && refused.exitCode === 128
    && refused.stderr.indexOf('use --force to delete it') >= 0
    && refused.command === 'git worktree remove /tmp/gp88/one')

  /* 现读不走缓存：同一 path 在「已不在清单」的账本上重发，拒在门票第一道 ——
     破坏性动作的依据必须是现在的账（读者手动删过登记、缓存还没过期时，缓存里
     那句「在册」是谎言）。 */
  const i88 = makeHost88()
  i88.setQueue([porcelainMain, porcelainMain])
  const gone = await i88.H('git/worktree-remove')({ sessionId: 's', repo: '/tmp/gp88/main', path: '/tmp/gp88/one' })
  ok('现读账本里没有这个路径（读者已手动清过）：拒在门票第一道，remove 没跑',
    gone.ok === false && gone.error.indexOf('不在本仓库的 worktree 清单里') >= 0
    && removeRuns(i88.runs).length === 0)
}

/* ═══ 4. Host 真仓库：登记真被清 / git 拒绝如实带回 / 失联记录只清登记 ═══ */

const hasGit = await new Promise((res) => {
  const c = spawn('sh', ['-c', 'command -v git >/dev/null 2>&1 && echo yes || echo no'])
  let out = ''
  c.stdout.on('data', (b) => { out += b })
  c.on('close', () => res(out.trim() === 'yes'))
})
const sh = (cmd, cwd) => new Promise((res) => {
  const c = spawn('sh', ['-c', cmd], { cwd })
  let o = '', e = ''
  c.stdout.on('data', (b) => { o += b })
  c.stderr.on('data', (b) => { e += b })
  c.on('error', (er) => res({ code: null, out: o, err: String(er.message) }))
  c.on('close', (x) => res({ code: x, out: o, err: e }))
})

if (hasGit !== true) {
  console.log('')
  console.log('  （这台机器没有 git，git/worktree-remove 的真仓库一段跳过）')
} else {
  console.log('')
  console.log('=== Host：git/worktree-remove（真仓库：登记真被清、git 拒绝、失联只清登记）===')
  for (const p of [R88, CLEAN, DIRTY, GONE, HOME88]) {
    fs.rmSync(p, { recursive: true, force: true })
  }
  fs.mkdirSync(HOME88, { recursive: true })
  await sh(`mkdir -p ${R88} && cd ${R88} && git init -q -b main && git config user.email t@t && git config user.name Tester`
    + ` && printf 'a\\n' > a.txt && git add -A && git commit -qm base`
    + ` && git branch feat && git branch dirty && git branch gone`
    + ` && git worktree add -q ${CLEAN} feat && git worktree add -q ${DIRTY} dirty && git worktree add -q ${GONE} gone`, '/tmp')
  /* wt-dirty 塞一个未提交改动（未跟踪文件同样触发 use --force 的拒绝）；wt-gone
     的目录整棵删掉（失联）。 */
  await sh(`printf 'dirty\\n' > untracked.txt`, DIRTY)
  fs.rmSync(GONE, { recursive: true, force: true })

  const handlers = new Map()
  const run = (spec) => new Promise((res) => {
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: Object.assign({}, process.env, { DSH_HOME: HOME88 }) })
    let o = '', e = ''
    c.stdout.on('data', (b) => { o += b })
    c.stderr.on('data', (b) => { e += b })
    c.on('error', (er) => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', (x) => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
  const ctx = { get: (n) => (n === 'shell' ? { resolve: (r) => r, run: run } : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', hostBody)(
    ctx, harness, console, (s) => Buffer.from(s, 'binary').toString('base64'),
    (s) => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  const H = (n) => handlers.get(n)
  const listing = async () => (await sh(`git -C ${R88} -c core.quotePath=false worktree list --porcelain`, '/tmp')).out

  const okDone = await H('git/worktree-remove')({ sessionId: 's', repo: R88, path: CLEAN })
  const afterOk = await listing()
  ok('干净工作区 remove（真仓库）：ok:true、人话命令、repo 回主仓',
    okDone.ok === true && okDone.command === 'git worktree remove ' + CLEAN && okDone.repo === R88)
  ok('答复的 worktrees 清单没有它了（最新快照，DIRTY 还在）',
    Array.isArray(okDone.worktrees) && okDone.worktrees.every((one) => one.path !== CLEAN)
    && okDone.worktrees.some((one) => one.path === DIRTY))
  ok('git 侧登记真被清：`git worktree list --porcelain` 里没有 CLEAN（目录也真没了，主仓完好）',
    afterOk.indexOf(CLEAN) < 0 && fs.existsSync(CLEAN) === false
    && fs.existsSync(path.join(R88, '.git')) === true)
  ok('主仓与另一棵工作区还在（清除不连坐）',
    afterOk.indexOf(DIRTY) >= 0 && afterOk.indexOf(GONE) >= 0)

  const refused = await H('git/worktree-remove')({ sessionId: 's', repo: R88, path: DIRTY })
  const afterRefused = await listing()
  ok('有未提交改动的目录 git 拒（真仓库）：ok:false、stderr 带原话（use --force）',
    refused.ok === false && refused.exitCode === 128
    && String(refused.stderr).indexOf('use --force') >= 0)
  ok('拒绝的答复把失败如实带回（人话命令在），登记原样（DIRTY 还在清单里、目录没被删）',
    refused.command === 'git worktree remove ' + DIRTY && afterRefused.indexOf(DIRTY) >= 0
    && fs.existsSync(DIRTY) === true)

  const goneDone = await H('git/worktree-remove')({ sessionId: 's', repo: R88, path: GONE })
  const afterGone = await listing()
  ok('失联记录（目录已删）remove 成功：只清登记，不带 --force',
    goneDone.ok === true && goneDone.command === 'git worktree remove ' + GONE
    && goneDone.command.indexOf('--force') < 0)
  ok('失联的登记真被清（清单里没有 GONE 了），答复清单同步新账',
    afterGone.indexOf(GONE) < 0 && Array.isArray(goneDone.worktrees)
    && goneDone.worktrees.every((one) => one.path !== GONE))

  const stranger = await H('git/worktree-remove')({ sessionId: 's', repo: R88, path: '/tmp/gp88-never-was' })
  ok('清单外路径（真仓库）：拒在门票第一道，零 git 写动作',
    stranger.ok === false && stranger.error.indexOf('不在本仓库的 worktree 清单里') >= 0)
}

console.log('')
if (failed > 0) {
  console.error('gp88-wtremove: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
console.log('gp88-wtremove: all checks passed')
