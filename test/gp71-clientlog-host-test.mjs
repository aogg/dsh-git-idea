import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ── 生命周期日志的宿主落点：/api/dsh-git-idea/client-log → ~/.dsh/logs/… ──
 *
 * 钉 2e6e18d / 691994a 的宿主半（src/pkg/host-pre.js 的 clientLogRoute 与
 * host-post.js 的注册行），现拼正式包再 import（gp68 同款：不起真端口，apply
 * 进一只桩 ctx 捕获 webServer 的注册，然后直接调捕获到的处理器）。八件事：
 *
 *   0. 座位：client-log 与 rpc / ws-info 同挂在 /api/dsh-git-idea 前缀的 exact
 *      路由上，与 rpc 同享宿主认证围栏的座位形状；
 *   1. 门：只收 POST（否则 405）、必须同源（跨源 403）、体超 1MB 拒（400）、
 *      坏 JSON 拒（400）—— 一条日志永远不许变成一次事故；
 *   2. 落盘形状：单行 TAB 分隔 t/kind/reason/message/detail/stack，控制字符洗成
 *      空格再收尾去空白，字段逐条截断（80/2000/300/4000 + …）；
 *   3. reason 缺席回落 source（open 事件的 source 记到同一列）；
 *   4. 空批与非对象事件：written:0、一个字节不写盘；非对象事件不产空行；
 *   5. 事件上限：一批最多收 200 条，多出来的直接不要（written:200）；
 *   6. 缺 t 的事件按接收时刻补 ISO 时间戳；
 *   7. 轮转：文件超 5MB 先改名 .1（旧的被覆盖），新文件从零开始。
 *
 * HOME 在 import 前就压进临时目录 —— CLIENT_LOG_FILE 是模块加载时算出来的，
 * 这一场所有写都落在 /tmp 的沙盘里，跑完删干净。
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dgi-gp71-home-'))
process.env.HOME = HOME

const built = await import('../build-package.mjs')
const hostTarget = built.PACKAGE_TARGETS.find(function (row) { return row.out === 'dist/lib/index.js' })
const hostSrc = built.render(hostTarget)

const tmpFile = path.join(os.tmpdir(), 'dgi-gp71-pkg-' + String(process.pid) + '.mjs')
fs.writeFileSync(tmpFile, hostSrc)
let pkg
try {
  pkg = await import('file://' + tmpFile)
} finally {
  fs.unlinkSync(tmpFile)
}

const LOG_FILE = path.join(HOME, '.dsh', 'logs', 'dsh-git-idea-client.log')

let failed = 0
const check = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}

/* 桩 webServer（gp68 同款）：记 exact 路由；effect 收集器负责退订。 */
function install() {
  const routes = new Map()
  const disposers = []
  const webServer = {
    register: function (spec) { routes.set(spec.path, spec.handler); return function () { routes.delete(spec.path) } },
    registerUpgrade: function (spec) { routes.set(spec.path, spec.handler); return function () { routes.delete(spec.path) } },
  }
  const ctx = {
    get: function () { return undefined },
    effect: function (cb) { const d = cb(); return typeof d === 'function' ? d : function () {} },
    on: function () {},
    inject: function (deps, fn) {
      fn({ webServer: webServer, effect: function (cb) { const d = cb(); if (typeof d === 'function') disposers.push(d); return d } })
    },
  }
  pkg.apply(ctx, {})
  return { routes: routes, dispose: function () { while (disposers.length > 0) disposers.pop()() } }
}

function fakeResponse() {
  return {
    status: 0,
    body: '',
    writeHead: function (status) { this.status = status },
    end: function (text) { this.body = String(text) },
  }
}
function fakeRequest(body, origin, host) {
  const chunks = body == null ? [] : (Buffer.isBuffer(body) ? [body] : [Buffer.from(body)])
  return {
    method: 'POST',
    headers: { origin: origin === undefined ? 'http://127.0.0.1:3080' : origin, host: host === undefined ? '127.0.0.1:3080' : host },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}
async function postLog(inst, body, origin, host) {
  const res = fakeResponse()
  await inst.routes.get('/api/dsh-git-idea/client-log')(fakeRequest(body, origin, host), res)
  return res
}
const logLines = () => (fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(function (l) { return l.length > 0 }) : [])

console.log('')
console.log('=== 0｜座位：client-log 与 rpc / ws-info 同挂 /api 前缀的 exact 路由 ===')
const inst = install()
check('client-log 挂在 /api/dsh-git-idea/client-log', typeof inst.routes.get('/api/dsh-git-idea/client-log') === 'function')
check('同场还有 rpc 与 ws-info（前缀搬家后一排座位）',
  typeof inst.routes.get('/api/dsh-git-idea/rpc') === 'function'
  && typeof inst.routes.get('/api/dsh-git-idea/ws-info') === 'function')

console.log('')
console.log('=== 1｜门：POST 专属 + 同源 + 1MB 体上限 + 坏 JSON ===')
{
  const res405 = fakeResponse()
  inst.routes.get('/api/dsh-git-idea/client-log')({ method: 'GET', headers: {} }, res405)
  check('GET → 405', res405.status === 405 && JSON.parse(res405.body).ok === false)
  const cross = await postLog(inst, JSON.stringify({ events: [{ kind: 'open' }] }), 'http://evil.example:80')
  check('跨源 POST → 403（这个端口机器上任何页面都够得着，必须自证同源）',
    cross.status === 403 && JSON.parse(cross.body).ok === false)
  const big = await postLog(inst, Buffer.concat([Buffer.from('{"events":['), Buffer.alloc(1048576, 120), Buffer.from(']}')]))
  check('体超 1MB → 400（一条日志不许变成一次磁盘写入事故）',
    big.status === 400 && JSON.parse(big.body).ok === false)
  const bad = await postLog(inst, '{events:')
  check('坏 JSON → 400', bad.status === 400 && JSON.parse(bad.body).ok === false)
  check('四种越界都没落一根线到盘上', logLines().length === 0)
}

console.log('')
console.log('=== 2｜落盘形状：TAB 分隔、控制字符洗成空格、字段截断 ===')
{
  const res = await postLog(inst, JSON.stringify({ events: [
    { t: '2026-10-26T10:00:00.000Z', kind: 'close', reason: 'outside-click' },
    { t: '2026-10-26T10:00:01.000Z', kind: 'crash', message: 'boom\nwith\tnasty\u0000chars', stack: 'Error: boom\n    at panel', detail: 'window error' },
  ] }))
  check('答复 {ok:true, written:2}', res.status === 200 && JSON.parse(res.body).written === 2)
  const lines = logLines()
  check('两行落盘，一事件一行', lines.length === 2)
  check('close 行：t + kind + reason 三段', lines[0] === '2026-10-26T10:00:00.000Z\tclose\toutside-click')
  check('crash 行：消息里的换行/NUL 洗成空格，message → detail → stack 依次跟在后面',
    lines[1] === '2026-10-26T10:00:01.000Z\tcrash\tboom with nasty chars\twindow error\tError: boom at panel'
    || lines[1].indexOf('2026-10-26T10:00:01.000Z\tcrash\tboom with nasty chars\twindow error\t') === 0)
  const long = await postLog(inst, JSON.stringify({ events: [
    { t: 't2', kind: 'crash', reason: 'r'.repeat(100), message: 'm'.repeat(2500), detail: 'd'.repeat(400), stack: 's'.repeat(4500) },
  ] }))
  check('长字段照收（答复不报错）', JSON.parse(long.body).written === 1)
  const line = logLines()[2]
  const seg = line.split('\t')
  check('reason 截到 80 + …', seg[2] === 'r'.repeat(80) + '…')
  check('message 截到 2000 + …', seg[3] === 'm'.repeat(2000) + '…')
  check('detail 截到 300 + …', seg[4] === 'd'.repeat(300) + '…')
  check('stack 截到 4000 + …', seg[5] === 's'.repeat(4000) + '…')
}

console.log('')
console.log('=== 3｜reason 缺席回落 source（open 的来源记到同一列）===')
{
  await postLog(inst, JSON.stringify({ events: [{ t: 't3', kind: 'open', source: 'chip' }] }))
  check('open 行第三段是 source=chip', logLines()[3] === 't3\topen\tchip')
}

console.log('')
console.log('=== 4｜空批与非对象事件：不写盘、不产空行 ===')
{
  fs.rmSync(LOG_FILE, { force: true })
  const empty = await postLog(inst, JSON.stringify({ events: [] }))
  check('空 events → written:0，且文件根本没有被创建',
    JSON.parse(empty.body).written === 0 && fs.existsSync(LOG_FILE) === false)
  const noEvents = await postLog(inst, JSON.stringify({ foo: 1 }))
  check('没有 events 键 → written:0', JSON.parse(noEvents.body).written === 0)
  const mixed = await postLog(inst, JSON.stringify({ events: [null, 'junk', { t: 't4', kind: 'open', source: 'chip' }, 42] }))
  check('非对象事件跳过：written 记的是收到的 4 条，盘上只落真正的一行、没有空行',
    JSON.parse(mixed.body).written === 4 && logLines().length === 1 && logLines()[0] === 't4\topen\tchip')
}

console.log('')
console.log('=== 5｜事件上限：一批最多收 200 条 ===')
{
  const many = []
  for (let i = 0; i < 300; i += 1) many.push({ t: 't5-' + String(i), kind: 'open', source: 'chip' })
  const res = await postLog(inst, JSON.stringify({ events: many }))
  check('300 条进来只收 200（written:200）',
    JSON.parse(res.body).written === 200 && logLines().length === 201)
  check('收下的是前 200 条（多出来的直接不要）',
    logLines()[200] === 't5-199\topen\tchip')
}

console.log('')
console.log('=== 6｜缺 t 的事件按接收时刻补 ISO 时间戳 ===')
{
  fs.rmSync(LOG_FILE, { force: true })
  await postLog(inst, JSON.stringify({ events: [{ kind: 'watchdog-recovery', source: 'panel-watch', detail: '打开后面板根节点不在文档里，重建浮层' }] }))
  const line = logLines()[0]
  check('t 段是接收时刻的 ISO 串', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line.split('\t')[0]))
}

console.log('')
console.log('=== 7｜轮转：文件超 5MB 先改名 .1，新文件从零开始 ===')
{
  fs.rmSync(LOG_FILE, { force: true })
  fs.rmSync(LOG_FILE + '.1', { force: true })
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  fs.writeFileSync(LOG_FILE, 'x'.repeat(5 * 1024 * 1024 + 1))
  const res = await postLog(inst, JSON.stringify({ events: [{ t: 't7', kind: 'open', source: 'chip' }] }))
  check('答复照常 ok（轮转对客户端透明）', JSON.parse(res.body).written === 1)
  check('旧内容整体搬到 .1', fs.existsSync(LOG_FILE + '.1') && fs.readFileSync(LOG_FILE + '.1', 'utf8').length === 5 * 1024 * 1024 + 1)
  check('新文件只有这一条新账', logLines().length === 1 && logLines()[0] === 't7\topen\tchip')
}

inst.dispose()
fs.rmSync(HOME, { recursive: true, force: true })

if (failed > 0) {
  console.error('gp71-clientlog-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
