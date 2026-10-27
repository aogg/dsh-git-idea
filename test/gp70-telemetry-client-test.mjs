import fs from 'node:fs'

import { makeEnv } from './gp69-env.mjs'

/* ═══ gp70：崩溃 toast 的 DOM 行为 + 生命周期日志的节流/退避/封顶/降级 ═══
 *
 * 钉 2e6e18d 的另外两半（src/client/02-toast.js / 05-telemetry.js，经
 * dist/client.js 整体验证）：
 *
 *   toast（纯 DOM，挂在 body，不依赖面板那棵 React 树）：
 *     · 形态：title / message / stack 各就各位，缺省话术与 2000/4000 字截断；
 *     · × 可点关，点完悬着的自动收定时器一并作废；
 *     · 5 秒自动收；悬停暂停（到点不收），移开 800ms 收；
 *     · 可堆叠但封顶 4 条，超了挤最旧，新的在上。
 *   telemetry（05-telemetry.js）：
 *     · localStorage 镜像（dsh.git-idea.client-log）1 秒节流写，环形缓冲 200 封顶；
 *     · 批量 POST /api/dsh-git-idea/client-log：攒 20 条即发、不足批 4 秒后发、
 *       两次上传限频 2 秒、失败退避 30 秒、待发队列 500 封顶、keepalive 按批大小；
 *     · pagehide / visibilitychange(hidden) 冲刷：环与队列不等到期；
 *     · 没有 document 的环境（单测、桥）降级：只记内存环、不碰存储、不排上传，
 *       面板开关照常 —— 账本永远不碍事。
 *
 * 时间敏感的三处（1s 镜像节流、4s 攒批、2s/30s 限频退避）走 ctx.timer 服务桩与
 * 可控的 Date.now 偏移；toast 的裸 setTimeout 走 gp69-env 的第二条手工时钟。
 * 上传用例在独立 env 实例里跑，账本（环/队列/退避）从零开始不受 toast 节牵连。
 */

const src = fs.readFileSync(process.env.GP_SRC || new URL('../dist/client.js', import.meta.url).pathname, 'utf8')

let failed = 0
const ok = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label + (value ? '' : '   ← 不符合预期'))
}

/* ── toast 场的 env：有 document / window，没有 fetch（上传由 telemetry 场专测）── */
const env = makeEnv({ document: true, window: true, fetch: false })
env.apply(src)
const errors = env.windowListeners.error || []
const crash = function (message, stack) {
  const error = new Error(message === undefined ? 'dsh-git-idea: x' : message)
  if (stack !== undefined) error.stack = stack
  errors[0]({ error: error })
}
/* 上报监听是同步路径：调完即弹，无需等任何一拍。 */
const toastLayer = () => env.fakeDoc.body.children.find(function (one) { return one.className === 'dsh-git-toasts' })
const boxes = () => (toastLayer() === undefined ? [] : toastLayer().children)
const boxByTitle = (title) => boxes().find(function (one) { return one.children.length > 0 && one.children[0].children[0].textContent === title })
const query = (box, cls) => {
  const all = [box].concat(box.children)
  for (const one of all) {
    for (const kid of one.children) {
      if (String(kid.className).indexOf(cls) >= 0) return kid
    }
  }
  return undefined
}
const clickX = (box) => {
  const head = box.children[0]
  const x = head.children[1]
  x.fire('click', { stopPropagation: function () {} })
}

console.log('')
console.log('=== 0｜toast 形态：挂在 body 层、title/message/stack、缺省话术 ===')
crash('面板渲染炸了：dsh-git-idea boom', 'Error: dsh-git-idea boom\n    at panel (94-popover.js:1:1)')
ok('toast 层挂在 body 上（.dsh-git-toasts），条目是 .dsh-git-toast',
  toastLayer() !== undefined && boxes().length === 1 && boxes()[0].className === 'dsh-git-toast')
ok('标题是「Git 插件报错」，正文是错误消息，堆栈在 pre 里',
  boxByTitle('Git 插件报错') !== undefined
  && query(boxes()[0], 'dsh-git-toast-msg').textContent === '面板渲染炸了：dsh-git-idea boom'
  && query(boxes()[0], 'dsh-git-toast-stack').textContent.indexOf('94-popover.js') >= 0)
crash('', 'stack 里有记号 dsh-git-idea 但 message 为空')
ok('消息为空：落到缺省话术「未知错误（详情见日志）」',
  query(boxes()[0], 'dsh-git-toast-msg').textContent === '未知错误（详情见日志）')

console.log('')
console.log('=== 1｜截断：正文 2000 字、堆栈 4000 字，多出一律折省略号 ===')
crash('m'.repeat(3000) + ' dsh-git', 's'.repeat(5000))
const truncMsg = query(boxes()[0], 'dsh-git-toast-msg').textContent
const truncStack = query(boxes()[0], 'dsh-git-toast-stack').textContent
ok('正文 2000 字 + …（DOM 不被堆栈撑爆）', truncMsg.length === 2001 && truncMsg.charAt(2000) === '…')
ok('堆栈 4000 字 + …', truncStack.length === 4001 && truncStack.charAt(4000) === '…')

console.log('')
console.log('=== 2｜× 可点关：立刻移除，自己的自动收定时器一并作废 ===')
crash('dsh-git-idea: 待关的一条')
const doomed = boxes()[0]
const rawBefore = env.rawTimers.size
clickX(doomed)
ok('× 点完：这条从层里消失，挂着的 5 秒钟也被清掉',
  boxes().indexOf(doomed) < 0 && env.rawTimers.size === rawBefore - 1)

console.log('')
console.log('=== 3｜5 秒自动收；悬停暂停、移开 800ms 收 ===')
crash('dsh-git-idea: 自动收的一条')
const autoBox = boxes()[0]
ok('弹出的瞬间挂着一只 5000ms 的钟', env.rawTimersWith(5000).length >= 1)
env.fireRawTimers(5000)
ok('5 秒到点自动收', boxes().indexOf(autoBox) < 0)
crash('dsh-git-idea: 悬停的一条')
const hoverBox = boxes()[0]
hoverBox.fire('pointerenter', {})
env.fireRawTimers(5000)
ok('悬停期间到点不收（定时器被清）', boxes().indexOf(hoverBox) >= 0 && env.rawTimersWith(5000).length === 0)
hoverBox.fire('pointerleave', {})
ok('移开挂的是 800ms 的收尾钟', env.rawTimersWith(800).length === 1)
env.fireRawTimers(800)
ok('移开 800ms 收掉', boxes().indexOf(hoverBox) < 0)

console.log('')
console.log('=== 4｜堆叠：最多 4 条，挤最旧，新的在上 ===')
const made = []
for (let i = 0; i < 6; i += 1) {
  crash('dsh-git-idea: 堆叠第 ' + String(i) + ' 条')
  made.push(boxes()[0])
}
ok('连弹 6 条，层里只留 4 条', boxes().length === 4)
ok('挤掉的是最旧的两条（第 0、1 条不在了）', boxes().indexOf(made[0]) < 0 && boxes().indexOf(made[1]) < 0)
ok('新的在上（第 5 条在最前面）', boxes()[0] === made[5])

/* ── telemetry 场：独立 env，环 / 队列 / 退避从零开始 ── */
const tenv = makeEnv({ document: true, window: true, fetch: true })
tenv.apply(src)
/* chip 挂一帧：面板表面把 document 交给持久化层（10-state.js 的 settingsDoc），
   后面的 localStorage 镜像才有的写 —— 真页面里 chip 先于一切挂载，同一件事。 */
const tchip = (tenv.registered.find(function (r) { return r.options.id === 'dsh-git-idea-chip' }) || {}).component
await tenv.renderUntilStable(tenv.makeElement(tchip, { sessionId: 's-1' }), 'chip-tenv')
const terrors = tenv.windowListeners.error || []
const logN = function (n, prefix) {
  for (let i = 0; i < n; i += 1) terrors[0]({ error: new Error((prefix || 'dsh-git-idea crash') + ' #' + String(i)) })
}
const terrorsLen = () => tenv.fetchCalls.length
const posts = terrorsLen
const bodyOf = (at) => JSON.parse(tenv.fetchCalls[at].init.body)
/* 上传决策吃的是墙钟：用单调递增的偏移量控时，不用真等 30 秒。 */
const realNow = Date.now
let clockOffset = 0
Date.now = function () { return realNow() + clockOffset }
const restores = []
restores.push(function () { Date.now = realNow })
const drain = () => tenv.wait(10)

console.log('')
console.log('=== 5｜批量上传：攒 20 条即发；不足批 4 秒后发 ===')
logN(19, 'dsh-git-idea 攒批 #a')
await drain()
ok('19 条还不出门（也没有请求发出去）', terrorsLen() === 0)
ok('挂的是一只 4000ms 的攒批钟', tenv.pendingTimers().some(function (t) { return t.delay === 4000 }))
logN(1, 'dsh-git-idea 攒批 #b')
await drain()
ok('第 20 条一到立刻 POST /api/dsh-git-idea/client-log',
  terrorsLen() === 1 && tenv.fetchCalls[0].path === '/api/dsh-git-idea/client-log')
ok('请求形状：POST + JSON 头 + events 20 条 + keepalive（小批走 keepalive）',
  tenv.fetchCalls[0].init.method === 'POST'
  && tenv.fetchCalls[0].init.headers['content-type'] === 'application/json'
  && JSON.parse(tenv.fetchCalls[0].init.body).events.length === 20
  && tenv.fetchCalls[0].init.keepalive === true)
tenv.fetchCalls[0].resolve({ status: 200 })
await drain()
ok('成功应答：出队、限频账起算（再攒一条只挂 4 秒钟）', (function () {
  logN(1, 'dsh-git-idea 限频 #c')
  return terrorsLen() === 1 && tenv.pendingTimers().some(function (t) { return t.delay === 4000 })
})())

console.log('')
console.log('=== 6｜限频 2 秒：到点也不出门，重排到间隔满 ===')
tenv.fireTimers(4000)
await drain()
ok('4 秒到点但距上次成功不足 2 秒：没有发，改挂 ~2 秒的间隔钟',
  terrorsLen() === 1 && tenv.pendingTimers().some(function (t) { return t.delay > 1500 && t.delay <= 2000 }))
clockOffset += 3000
tenv.fireTimers()
await drain()
ok('间隔满了重发：第二条 POST 带上积的那 1 条',
  terrorsLen() === 2 && JSON.parse(tenv.fetchCalls[1].init.body).events.length === 1)

console.log('')
console.log('=== 7｜失败退避 30 秒：失败后怎么都不出门，退避满了才重试 ===')
tenv.fetchCalls[1].reject(new Error('host gone'))
await drain()
ok('失败：挂的是 30 秒的退避钟', tenv.pendingTimers().some(function (t) { return t.delay === 30000 }))
logN(2, 'dsh-git-idea 退避期 #d')
tenv.fireTimers(4000)
await drain()
ok('退避期内攒批到点也不发（事件留在队列里）', terrorsLen() === 2)
tenv.fireTimers(3000)
await drain()
ok('退避期内别的钟也不破门', terrorsLen() === 2)
clockOffset += 31000
tenv.fireTimers()
await drain()
ok('退避满 30 秒：重发，一次带上被拒的那 1 条与退避期攒下的 2 条（共 3 条）',
  posts() === 3 && bodyOf(2).events.length === 3)
tenv.fetchCalls[2].resolve({ status: 200 })
await drain()
ok('重试成功把失败账清了（diagFailAt 归零；限频间隔一满，20 条照样立刻出门）', (function () {
  clockOffset += 3000
  logN(20, 'dsh-git-idea 清账后 #e')
  return terrorsLen() === 4
})())

console.log('')
console.log('=== 8｜队列 500 封顶 + 大批 keepalive 关 ===')
/* fetch#3（清账后那 20 条）先落地；随后一口气攒 700 条 —— 攒的期间限频间隔
   未满（一笔都不出门），队列积到 700 封顶 500、挤掉最旧的 200 条，间隔一满
   整批补发恰好 500 条。 */
tenv.fetchCalls[3].resolve({ status: 200 })
await drain()
logN(700, 'dsh-git-idea 封顶 #f')
await drain()
ok('攒 700 条期间一笔都不出门（距上次成功不足 2 秒）', posts() === 4)
clockOffset += 3000
tenv.fireTimers()
await drain()
const tail = tenv.fetchCalls[terrorsLen() - 1]
ok('挤掉最旧之后补发的一批恰好 500 条（700 → 封顶 500 → 整批补发）',
  JSON.parse(tail.init.body).events.length === 500)
ok('大批（>50 条）keepalive 关掉（pagehide 那把带不动这么大的体）', tail.init.keepalive === false)
tenv.fetchCalls[terrorsLen() - 1].resolve({ status: 200 })
await drain()

console.log('')
console.log('=== 9｜pagehide / 藏起来：待发队列立刻冲刷，不等到期 ===')
logN(2, 'dsh-git-idea 冲刷 #g')
await drain()
const flushMark = terrorsLen()
clockOffset += 3000
tenv.fakeDoc.visibilityState = 'hidden'
tenv.fakeDoc.fire('visibilitychange', {})
await drain()
ok('visibilitychange(hidden)：待发的 2 条立刻出门（不等 4 秒攒批）',
  terrorsLen() === flushMark + 1
  && JSON.parse(tenv.fetchCalls[flushMark].init.body).events.length === 2)
tenv.fetchCalls[flushMark].resolve({ status: 200 })
await drain()
tenv.fakeDoc.visibilityState = 'visible'
tenv.fakeDoc.fire('visibilitychange', {})
await drain()
logN(1, 'dsh-git-idea 冲刷 #h')
clockOffset += 3000
tenv.fakeWindow.fire('pagehide', {})
await drain()
ok('pagehide 同款冲刷（两条监听各接各的）',
  terrorsLen() === flushMark + 2)
tenv.fetchCalls[terrorsLen() - 1].resolve({ status: 200 })
await drain()
tenv.fakeDoc.visibilityState = 'visible'

console.log('')
console.log('=== 10｜localStorage 镜像：1 秒节流写，环形缓冲 200 封顶 ===')
const sw0 = tenv.storeWrites.length
logN(5, 'dsh-git-idea 镜像 #i')
await drain()
ok('5 条记账只排了一只 1 秒的镜像钟（节流，不逐条写）',
  tenv.pendingTimers().filter(function (t) { return t.delay === 1000 }).length === 1)
tenv.fireTimers(1000)
await drain()
ok('到点写进 localStorage，键名 dsh.git-idea.client-log',
  tenv.storeWrites.length === sw0 + 1 && tenv.storeWrites[sw0].key === 'dsh.git-idea.client-log')
/* 前面上传各节的 700+ 条已经把环灌满过一轮：镜像与环此刻都顶着 200 的上限。 */
ok('镜像就是环形缓冲的原样（早已顶到 200 上限）',
  JSON.parse(tenv.store['dsh.git-idea.client-log']).length === 200)
logN(3, 'dsh-git-idea 镜像 #j')
await drain()
tenv.fireTimers(1000)
await drain()
ok('第二批记账第二次落盘', tenv.storeWrites.length === sw0 + 2)
logN(250, 'dsh-git-idea 封顶 #k')
await drain()
ok('环形缓冲 200 封顶：再灌 250 条也只留 200，最旧的先走',
  tenv.fakeWindow.__dshGitIdeaLogs().length === 200)
const after = tenv.fakeWindow.__dshGitIdeaLogs()
ok('挤掉的是最旧的 250 条：环首是这批的第 50 条，环尾是最后一条',
  after[0].message.indexOf('#50') >= 0 && after[199].message.indexOf('#249') >= 0)
tenv.fireTimers(1000)
await drain()
ok('镜像跟着环走（也是 200 条）', JSON.parse(tenv.store['dsh.git-idea.client-log']).length === 200)

console.log('')
console.log('=== 11｜没有 document 的环境：只记内存环之外什么都不碰，面板照常 ===')
const denv = makeEnv({ document: false, window: false, fetch: false })
const dcomps = denv.apply(src)
const dchipTree = () => denv.renderUntilStable(denv.makeElement(dcomps.chip, { sessionId: 's-1' }), 'chip')
const dpopTree = () => denv.renderUntilStable(denv.makeElement(dcomps.popover, { sessionId: 's-1' }), 'pop')
let dt = await dchipTree()
dt.props.onClick()
await denv.wait(10)
await dpopTree()
dt = await dchipTree()
ok('面板照常打开（账本降级不碍事）', String(dt.props.className).indexOf('dsh-git-chip-open') >= 0)
dt.props.onClick()
await denv.wait(10)
await dpopTree()
ok('开关往复几轮：localStorage 一个字节没写、一次 fetch 都没有、控制台没报错',
  denv.storeWrites.length === 0 && Object.keys(denv.store).length === 0
  && denv.fetchCalls.length === 0 && denv.consoleLines.length === 0)
restores.forEach(function (one) { one() })

if (failed > 0) {
  console.error('gp70-telemetry-client: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
