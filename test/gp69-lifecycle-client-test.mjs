import fs from 'node:fs'

import { makeEnv } from './gp69-env.mjs'

/* ═══ gp69：弹窗防卡死 —— 看门狗三形态、开关记账、崩溃护栏、全局上报 ═══
 *
 * 钉 2e6e18d 的客户端行为（src/client/10-state.js / 94-popover.js / 98-register.js
 * / 02-toast.js / 16-portal.js，经 dist/client.js 整体验证）：
 *
 *   1. 开关记账：chip 开（source=chip）、chip 收（user-toggle）、点外面
 *      （outside-click）、Esc（esc）—— 每条都带 ISO 时间戳落进环形缓冲，
 *      window.__dshGitIdeaLogs() 翻得到，且翻到的是副本；
 *   2. 看门狗形态一（树崩）：open 位是 true、面板根节点已不在文档里，chip 再点
 *      不是空转的翻转 —— 先复位、记 watchdog-recovery，再走一次干净打开；
 *   3. 看门狗形态三（正常开）：面板活着时同一入口就是普通的 user-toggle 收起，
 *      不虚报 watchdog；
 *   4. 看门狗形态二（浮层游离 + 巡检眼）：打开 300ms 的巡检发现根节点不在文档里
 *      就记 watchdog-recovery（source=panel-watch）并 healGitFloat —— bump 浮层
 *      代数让 GitPopover 重渲染，gitFloatEscape 每次核对 host.isConnected，游离
 *      即换新 host，无需读者点第二下；
 *   5. outside-close 让路：open 但根节点已死时，点外面不伪记 outside-click、
 *      不复位 open（看门狗的诊断机会不被弄脏）；崩溃 toast 在场时点它也不算
 *      「点在外面」；
 *   6. 全局上报（98-register）：window error / unhandledrejection 只认带 dsh-git
 *      记号的错，报过的（__dshGitIdeaSeen）不重报，crash 走 console.error；
 *   7. 崩溃护栏 GitCrashBoundary（真类，直驱）：记 crash、弹 toast、复位 open
 *      （close 原因 crash），收起后自动重武装，封顶 3 次 —— 第 4 次崩在原地，
 *      新的一次打开把重试账清零；护栏报过的错全局兜底不再重复报。
 *
 * 环境由 gp69-env.mjs 提供：document / window 在 apply 之前就位（98-register 的
 * 监听是 apply 时注册的），所以这里是一场独立求值的自足套件。
 */

const src = fs.readFileSync(process.env.GP_SRC || new URL('../dist/client.js', import.meta.url).pathname, 'utf8')
const env = makeEnv({ document: true, window: true })
const components = env.apply(src)

let failed = 0
const ok = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label + (value ? '' : '   ← 不符合预期'))
}

const makeEl = env.makeElement
const ring = () => env.fakeWindow.__dshGitIdeaLogs()
const chipTree = (label) => env.renderUntilStable(makeEl(components.chip, { sessionId: 's-1' }), label || 'chip')
const popTree = (label) => env.renderUntilStable(makeEl(components.popover, { sessionId: 's-1' }), label || 'pop')
const settle = async function () {
  await env.wait(10)
  await popTree()
  await env.wait(10)
  return await popTree()
}
async function openPanel() {
  const t = await chipTree()
  if (t.props.className.indexOf('dsh-git-chip-open') < 0) { t.props.onClick(); await env.wait(10) }
  return await settle()
}
async function closePanel() {
  const t = await chipTree()
  if (String(t.props.className).indexOf('dsh-git-chip-open') >= 0) { t.props.onClick(); await env.wait(10) }
  return await settle()
}
const isOpenNow = async function () {
  const t = await chipTree()
  return String(t.props.className).indexOf('dsh-git-chip-open') >= 0
}
const kindsSince = (mark) => ring().slice(mark).map(function (one) { return one.kind + (one.reason !== undefined ? ':' + one.reason : '') + (one.source !== undefined ? '@' + one.source : '') })
const toastBoxes = () => {
  const layer = env.fakeDoc.body.children.find(function (one) { return one.className === 'dsh-git-toasts' })
  return layer === undefined ? [] : layer.children
}
const floatHosts = () => env.fakeDoc.body.children.filter(function (one) { return one.className === 'dsh-git-float' })

console.log('')
console.log('=== 0｜翻账口子与开关记账：chip 开 / chip 收，来源与时间戳 ===')
ok('apply 后 window.__dshGitIdeaLogs 可用（98-register 的翻账 effect）', typeof ring() === 'function' || Array.isArray(ring()))
let mark0 = ring().length
await openPanel()
ok('面板打开：记账有一条 open，来源是 chip',
  kindsSince(mark0).indexOf('open@chip') >= 0)
ok('open 这条带 ISO 时间戳', /^\d{4}-\d{2}-\d{2}T/.test(ring()[mark0].t))
const copy = ring()
copy.push({ kind: 'forged' })
ok('翻账给的是副本：外面的改动不进环', ring().length === mark0 + 1 && ring()[ring().length - 1].kind !== 'forged')

console.log('')
console.log('=== 1｜收起的三个原因：user-toggle / outside-click / esc ===')
mark0 = ring().length
await closePanel()
ok('chip 再点收起：close 原因 user-toggle', kindsSince(mark0).indexOf('close:user-toggle') >= 0)
mark0 = ring().length
await openPanel()
ok('再打开又是一条 open（开关往复各记各的）', kindsSince(mark0).filter(function (k) { return k === 'open@chip' }).length === 1)
mark0 = ring().length
env.fakeDoc.fire('pointerdown', { target: env.OUTSIDE })
await settle()
ok('点在面板外：close 原因 outside-click', kindsSince(mark0).indexOf('close:outside-click') >= 0)
ok('点外面真的收起了', await isOpenNow() === false)
await openPanel()
mark0 = ring().length
env.fakeDoc.fire('keydown', { key: 'Escape' })
await settle()
ok('Esc：close 原因 esc', kindsSince(mark0).indexOf('close:esc') >= 0)
mark0 = ring().length
env.fakeDoc.fire('keydown', { key: 'Enter' })
await settle()
ok('别的键不记账（keydown 只认 Escape）', ring().length === mark0)
/* 点在 chip / 面板里都不算外面（94-popover 的既有守卫，顺带钉住不回归） */
await openPanel()
mark0 = ring().length
env.fakeDoc.fire('pointerdown', { target: env.IN_CHIP })
await settle()
env.fakeDoc.fire('pointerdown', { target: env.INSIDE })
await settle()
ok('点 chip / 点面板里都不关面板、不记账', ring().length === mark0 && await isOpenNow() === true)

console.log('')
console.log('=== 2｜看门狗形态一（树崩）：open 但根节点已不在文档，chip 再点先复位再重开 ===')
env.panelNodeObj.isConnected = false
mark0 = ring().length
const chipDead = await chipTree()
chipDead.props.onClick()
await env.wait(10)
await settle()
const deadKinds = kindsSince(mark0)
ok('记了一条 watchdog-recovery（来源 chip，不是 close/open 的空转）',
  deadKinds.some(function (k) { return k.indexOf('watchdog-recovery@chip') === 0 }))
ok('随后是一次干净的 open（先复位再重开，中间没有 close 折腾）',
  deadKinds.indexOf('open@chip') === deadKinds.indexOf('watchdog-recovery@chip') + 1
  && deadKinds.indexOf('close:') < 0)
ok('面板真的开了（不是在 true↔false 之间空转）', await isOpenNow() === true)
env.panelNodeObj.isConnected = true
await closePanel()

console.log('')
console.log('=== 3｜看门狗形态三（正常开）：面板活着，同一入口就是普通收起 ===')
await openPanel()
mark0 = ring().length
await closePanel()
ok('面板活着时 chip 点击：只有 user-toggle，没有 watchdog-recovery',
  kindsSince(mark0).indexOf('close:user-toggle') >= 0
  && kindsSince(mark0).every(function (k) { return k.indexOf('watchdog-recovery') < 0 }))

console.log('')
console.log('=== 4｜巡检眼：打开 300ms 后根节点不在文档 → 记账 + 喊 healGitFloat ===')
await openPanel()
ok('打开后挂着一只 300ms 的巡检定时器',
  env.pendingTimers().some(function (t) { return t.delay === 300 }))
mark0 = ring().length
env.panelNodeObj.isConnected = false
env.fireTimers(300)
await env.wait(10)
ok('巡检发现根节点不在文档：记 watchdog-recovery（来源 panel-watch）',
  kindsSince(mark0).some(function (k) { return k.indexOf('watchdog-recovery@panel-watch') === 0 }))
ok('crash 走 console.error 的同时，watchdog 走的是 console.warn（open/close 不上控制台）',
  env.consoleLines.some(function (one) { return one.level === 'warn' && String(one.args[0]).indexOf('watchdog-recovery') >= 0 }))
env.panelNodeObj.isConnected = true
/* 面板活着时巡检安静 */
mark0 = ring().length
env.fireTimers(300)
await env.wait(10)
ok('面板活着时巡检不记账', ring().length === mark0)
/* 重开一次再巡检：巡检定时器随开关重新武装，面板活着时到点也安静 */
await closePanel()
await openPanel()
mark0 = ring().length
env.fireTimers(300)
await env.wait(10)
ok('重开后巡检重新武装，面板活着时到点也不记账', ring().length === mark0)
await closePanel()

console.log('')
console.log('=== 5｜outside 让路：open 但根节点已死，点外面不伪记、不复位 ===')
await openPanel()
env.panelNodeObj.isConnected = false
mark0 = ring().length
env.fakeDoc.fire('pointerdown', { target: env.OUTSIDE })
await env.wait(10)
ok('点在外面但面板根已死：不记 close、open 位原样留给看门狗',
  ring().length === mark0 && (await isOpenNow()) === true)
env.panelNodeObj.isConnected = true
env.fakeDoc.fire('pointerdown', { target: env.OUTSIDE })
await settle()
ok('根节点恢复后同一点法：正常记 outside-click', kindsSince(mark0).indexOf('close:outside-click') >= 0)
ok('面板收起了', await isOpenNow() === false)

console.log('')
console.log('=== 6｜浮层游离：gitFloatEscape 每渲染核对 isConnected，healGitFloat 兜底重建 ===')
/* portal 门此刻才开：之前各节走「槽位内 absolute」老路，这一节起面板搬进 body 浮层。 */
env.fakeWindow.ReactDOM = {
  createPortal: function (children, host) { return { $$portal: true, props: { children: children }, host: host } },
}
await openPanel()
let hosts = floatHosts()
ok('浮层路径：body 上挂了一个 .dsh-git-float 层', hosts.length === 1)
const firstHost = hosts[0]
firstHost.parentNode.removeChild(firstHost)
firstHost.isConnected = false
mark0 = ring().length
await settle()
hosts = floatHosts()
ok('游离的 host 被丢弃：重渲染后换了一个新 host（旧节点不再回来）',
  hosts.length === 1 && hosts[0] !== firstHost)
/* 「没有人触发重渲染」的场合：巡检眼喊 healGitFloat → bump 代数 → 下一次渲染自愈 */
hosts[0].parentNode.removeChild(hosts[0])
hosts[0].isConnected = false
env.panelNodeObj.isConnected = false
mark0 = ring().length
env.fireTimers(300)
await env.wait(10)
env.fireTimers(0)
await settle()
ok('巡检记 watchdog-recovery 后，healGitFloat 让浮层换代（面板搬回文档）',
  kindsSince(mark0).some(function (k) { return k.indexOf('watchdog-recovery@panel-watch') === 0 })
  && floatHosts().length === 1 && floatHosts()[0] !== hosts[0])
ok('自愈后 open 位还在（读者没有点过第二下）', await isOpenNow() === true)
env.panelNodeObj.isConnected = true
await closePanel()

console.log('')
console.log('=== 7｜全局上报（98-register）：只认 dsh-git 记号的错，报过的不重报 ===')
const errors = env.windowListeners.error || []
const rejections = env.windowListeners.unhandledrejection || []
ok('error 与 unhandledrejection 各挂了一个监听', errors.length === 1 && rejections.length === 1)
mark0 = ring().length
const marked = new Error('boom at /api/dsh-git-idea/rpc while reading git/panel')
marked.stack = 'Error: boom at /api/dsh-git-idea/rpc\n    at panel (dsh-git-idea.js:1:1)'
errors[0]({ error: marked })
await env.wait(10)
const reportKinds = kindsSince(mark0)
ok('带 dsh-git 记号的错：记一条 crash（detail 是 window error）',
  reportKinds.indexOf('crash') >= 0 && ring()[mark0].detail === 'window error')
ok('这条 crash 走了 console.error（watchdog 才是 warn）',
  env.consoleLines.some(function (one) { return one.level === 'error' && String(one.args[0]).indexOf('[crash]') >= 0 }))
ok('同时弹了一条崩溃 toast（纯 DOM，挂在 body 的 toast 层里）',
  toastBoxes().length === 1 && toastBoxes()[0].className === 'dsh-git-toast')
const beforeSame = ring().length
errors[0]({ error: marked })
await env.wait(10)
ok('同一个错再报一次：__dshGitIdeaSeen 记号让它哑火', ring().length === beforeSame)
const plain = new Error('nothing to do with this plugin')
plain.stack = 'Error: nothing to do with this plugin\n    at other (vendor.js:1:1)'
errors[0]({ error: plain })
errors[0]({ error: null })
await env.wait(10)
ok('别家的错（与空事件）一个字节都不劫持', ring().length === beforeSame)
rejections[0]({ reason: new Error('unhandled dsh-git-idea: live 消息不是 JSON') })
await env.wait(10)
ok('unhandledrejection 同样收（detail 是 unhandledrejection）',
  ring().length === beforeSame + 1 && ring()[ring().length - 1].detail === 'unhandledrejection')

console.log('')
console.log('=== 8｜崩溃护栏 GitCrashBoundary：记账 + toast + 复位 + 重武装与 3 次封顶 ===')
await openPanel()
const Boundary = env.capturedClasses.find(function (one) { return one.name === 'GitCrashBoundary' })
ok('迷你 React 给了 Component 记号：护栏没有退化成透传（拿到了真类）',
  Boundary !== undefined && typeof Boundary === 'function' && typeof Boundary.prototype.componentDidCatch === 'function')
const inst = new Boundary({ active: true, children: [] })
ok('初始：没崩、重试账为 0', inst.state.crashed === null && inst.state.retries === 0)
mark0 = ring().length
const crashOnce = function () {
  const error = new Error('dsh-git-idea: 渲染抛错（第 ' + (inst.state.retries + 1) + ' 次）')
  Object.assign(inst.state, Boundary.getDerivedStateFromError(error))
  inst.componentDidCatch(error)
  return error
}
crashOnce()
const crashEntries = ring().slice(mark0).filter(function (one) { return one.kind === 'crash' })
ok('第一次崩：记 crash（detail 说是面板渲染/副作用抛错）',
  crashEntries.length === 1 && crashEntries[0].detail === '面板渲染/副作用抛错，已收起面板')
ok('open 被护栏复位：close 原因是 crash',
  kindsSince(mark0).indexOf('close:crash') >= 0)
ok('重试账 +1，渲染返回 null（不把崩了的子树画出来）',
  inst.state.retries === 1 && inst.render() === null)
inst.props = { active: false, children: [] }
inst.componentDidUpdate({ active: true })
ok('面板已收起：护栏自动重武装（crashed 清掉，重试账保留）',
  inst.state.crashed === null && inst.state.retries === 1)
/* 再崩三次：第 2、3 次崩之后继续重武装，第 4 次崩停原地（封顶 3 次防循环） */
crashOnce()
inst.props = { active: false, children: [] }
inst.componentDidUpdate({ active: true })
const rearmed2 = inst.state.crashed === null && inst.state.retries === 2
crashOnce()
inst.props = { active: false, children: [] }
inst.componentDidUpdate({ active: true })
const rearmed3 = inst.state.crashed === null && inst.state.retries === 3
crashOnce()
inst.props = { active: false, children: [] }
inst.componentDidUpdate({ active: true })
ok('第 2、3 次崩后仍自动重武装', rearmed2 === true && rearmed3 === true)
ok('第 4 次崩（重试账 4 > 3）：停在原地不再重武装',
  inst.state.crashed !== null && inst.state.retries === 4 && inst.render() === null)
ok('四条 crash 都进了账，但 close:crash 只有第一条（open 本就已是 false）',
  ring().slice(mark0).filter(function (one) { return one.kind === 'crash' }).length === 4
  && kindsSince(mark0).filter(function (k) { return k === 'close:crash' }).length === 1)
ok('封顶期间 toast 也只按次数弹、层里永远挤不掉 4 条（堆叠上限）',
  toastBoxes().length > 0 && toastBoxes().length <= 4)
/* 新的一次打开：重试账清零 */
inst.props = { active: true, children: [] }
inst.componentDidUpdate({ active: false })
ok('新的一次打开：crashed 与重试账一起清零（下一次崩按全新护栏走）',
  inst.state.crashed === null && inst.state.retries === 0)
/* 护栏报过的错，全局兜底让路 */
const guardErr = crashOnce()
const dedupeMark = ring().length
errors[0]({ error: guardErr })
await env.wait(10)
ok('护栏报过的错（__dshGitIdeaSeen）全局兜底不再重报', ring().length === dedupeMark)

console.log('')
console.log('=== 9｜点崩溃 toast 不算「点在面板外」===')
await openPanel()
ok('toast 层在场（前面几节弹的还没到期）', toastBoxes().length > 0)
mark0 = ring().length
env.fakeDoc.fire('pointerdown', { target: toastBoxes()[0] })
await env.wait(10)
ok('点在 toast 上：面板不关、不记 outside-click',
  ring().length === mark0 && (await isOpenNow()) === true)
env.fakeDoc.fire('pointerdown', { target: env.OUTSIDE })
await settle()
ok('紧接着点在外面：正常 outside-click（toast 的豁免不外溢）',
  kindsSince(mark0).indexOf('close:outside-click') >= 0)

if (failed > 0) {
  console.error('gp69-lifecycle-client: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
