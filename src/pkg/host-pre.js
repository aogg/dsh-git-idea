/* ── the real-package Host half ──

   The fragments under src/host/ were written for the dynamic Cordis bridge:
   that realm handed the plugin a \`harness\` and a façade \`ctx\`. A real package
   gets neither, so this prelude supplies the one thing the body still asks of a
   harness — \`handle\`, which the RPC route below serves. (It used to supply
   \`defineTool\` / \`registerTool\` too, for the model tools; the plugin ships
   none, see the README's 「不注册工具」.) The body after it is the same text the
   dynamic bridge loads — one body, two builds — and host-post.js exports the
   plugin object. */

/* node:crypto 只有真包这一半用得上（WebSocket 握手的 Sec-WebSocket-Accept），而
   import 只能放在拼接后的文件头 —— host-post.js 在文件中部，放 import 是语法错误。 */
import crypto from 'node:crypto'
/* 客户端日志落盘（/api/dsh-git-idea/client-log → ~/.dsh/logs/…）用得到的三样。 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/* 面板到浏览器的实时推送（77-cmdrec.js 的 cmdlog-start / cmdlog-exit）汇聚在这个
   对象上：body 片段只认它。默认是一个 no-op —— bridge 版没有 pkg 层，liveSend 里
   的 typeof 守卫本来就不会走到这里；upgrade 路由（host-post.js）注册成功后才把它
   换成真正的广播，卸载时还原。 */
const liveHub = { sockets: new Set(), send: function () {} }

/* The one route the browser half calls: same origin as the page, so no CORS.
   The same-origin check below is what keeps another page on loopback from
   driving git in this reader's working directory. */
/* 插件全部路由的统一前缀。过去 RPC 与 ws 挂在顶层自造路径（/dsh-git-idea/rpc、
   /dsh-git-idea/ws）上，这条形状在某些代理链（Windows 侧 whistle/nohost）里被
   改写成 GET /ws//… 之类，握手永远到不了宿主；与 dsh 其它插件同款的
   /api/<名>/… 前缀在同一条链上实测是通的 —— 全部搬过来。 */
const API_BASE = '/api/dsh-git-idea'
const RPC_PATH = API_BASE + '/rpc'
const RPC_MAX_BYTES = 1048576

/* Every handler the Client registered through \`harness.handle\`, keyed by the
   method string it passed to \`host.call\`. */
const rpcHandlers = new Map()

function detail(error) {
  return error != null && error.message !== undefined ? String(error.message) : String(error)
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/* Required on every POST: the port is reachable from any page on this machine,
   and these methods run git in the reader's own working directory. */
function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch (error) {
    return false
  }
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > RPC_MAX_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? null : JSON.parse(text)
}

/* The dynamic bridge refused an unregistered method with "... is not
   registered", and 10-state.js retries exactly that sentence while the Host
   half is still coming up. The 404 below keeps the same words, so that retry
   survives the move to a real package. */
async function rpcRoute(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: 'rpc is POST only' })
    return
  }
  if (!sameOrigin(request)) {
    sendJson(response, 403, { ok: false, error: 'same-origin requests only' })
    return
  }
  let body
  try {
    body = await readJsonBody(request)
  } catch (error) {
    sendJson(response, 400, { ok: false, error: detail(error) })
    return
  }
  const method = body != null && typeof body.method === 'string' ? body.method : ''
  const handler = rpcHandlers.get(method)
  if (handler === undefined) {
    sendJson(response, 404, { ok: false, error: method + ' is not registered' })
    return
  }
  try {
    const value = await handler(body.payload)
    sendJson(response, 200, { ok: true, value: value === undefined ? null : value })
  } catch (error) {
    sendJson(response, 200, { ok: false, error: detail(error) })
  }
}

/* ── 客户端日志的宿主落点（/api/dsh-git-idea/client-log）──
 *
 * 浏览器那半（05-telemetry.js）把生命周期账（open/close/crash/watchdog）批量 POST
 * 过来，这里逐条洗成单行、追加写 ~/.dsh/logs/dsh-git-idea-client.log —— 刷新页面
 * 日志也不丢。与 rpcRoute 同一道门：只收 POST、必须同源（这个端口机器上任何页面都
 * 够得着）；单请求体沿用 1MB 上限，事件最多收 200 条，字段逐条截断 —— 一条日志
 * 永远不许变成一次磁盘写入事故。文件 5MB 一转（.1 覆盖旧的），封顶防膨胀。
 */
const CLIENT_LOG_PATH = '/api/dsh-git-idea/client-log'
const CLIENT_LOG_FILE = path.join(os.homedir(), '.dsh', 'logs', 'dsh-git-idea-client.log')
const CLIENT_LOG_MAX_BYTES = 5 * 1024 * 1024
const CLIENT_LOG_EVENTS_MAX = 200

function clientLogField(value, cap) {
  if (value === undefined || value === null) return ''
  const raw = typeof value === 'string' ? value : String(value)
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return cleaned.length > cap ? cleaned.slice(0, cap) + '…' : cleaned
}

function clientLogLine(event) {
  if (event == null || typeof event !== 'object') return ''
  const at = clientLogField(event.t, 40) || new Date().toISOString()
  const kind = clientLogField(event.kind, 40) || 'unknown'
  const reason = clientLogField(event.reason !== undefined ? event.reason : event.source, 80)
  const message = clientLogField(event.message, 2000)
  const stackText = clientLogField(event.stack, 4000)
  const extra = clientLogField(event.detail, 300)
  let line = at + '\t' + kind
  if (reason.length > 0) line += '\t' + reason
  if (message.length > 0) line += '\t' + message
  if (extra.length > 0) line += '\t' + extra
  if (stackText.length > 0) line += '\t' + stackText
  return line + '\n'
}

async function clientLogRoute(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: 'client-log is POST only' })
    return
  }
  if (!sameOrigin(request)) {
    sendJson(response, 403, { ok: false, error: 'same-origin requests only' })
    return
  }
  let body
  try {
    body = await readJsonBody(request)
  } catch (error) {
    sendJson(response, 400, { ok: false, error: detail(error) })
    return
  }
  const events = body != null && Array.isArray(body.events) ? body.events.slice(0, CLIENT_LOG_EVENTS_MAX) : []
  if (events.length === 0) {
    sendJson(response, 200, { ok: true, written: 0 })
    return
  }
  try {
    await fsp.mkdir(path.dirname(CLIENT_LOG_FILE), { recursive: true })
    try {
      const stats = await fsp.stat(CLIENT_LOG_FILE)
      if (stats != null && stats.size > CLIENT_LOG_MAX_BYTES) {
        await fsp.rename(CLIENT_LOG_FILE, CLIENT_LOG_FILE + '.1')
      }
    } catch (error) { /* 还没有这个文件就是最好的状态 */ }
    let text = ''
    for (let i = 0; i < events.length; i += 1) text += clientLogLine(events[i])
    await fsp.appendFile(CLIENT_LOG_FILE, text, 'utf8')
    sendJson(response, 200, { ok: true, written: events.length })
  } catch (error) {
    sendJson(response, 200, { ok: false, error: detail(error) })
  }
}

/* ── ws 接入令牌（/api/dsh-git-idea/ws-info → /api/dsh-git-idea/ws?token=…）──
 *
 * 实时通道与 dsh 其它插件同款（/api/<名>/ws）之后，鉴权也照搬同一个模型
 * （dsh-resume-on-restart 的 ws-state）：token 由宿主半每次 apply（插件实例上任）
 * 生成一次（crypto.randomBytes(24).toString('base64url')，24 字节），只经 ws-info
 * 下发；升级握手（host-post.js 的 wsUpgrade）校验 query 里的 token，不符直接
 * destroy 不回包。比较先把两边都归一到定长 sha256 摘要再 timingSafeEqual ——
 * 长度与字节都不会从比较耗时里漏出去。dsh 重启或插件重装后 token 换新，客户端
 * 每轮连接都重拉 ws-info，拿旧 token 握手只会被断开再退避重来。
 *
 * ws-info 本身走 webServer.register 的 exact 路由（与 rpc 同一款，自动享受宿主
 * 既有认证围栏），自己不再叠 sameOrigin 一道门 —— 同源的 GET fetch 本就不带
 * Origin 头（浏览器只对 POST 与跨源请求附 Origin），那道门只会把正经客户端也
 * 挡在门外；token 的真正关口在升级握手那一步。 */
const WS_INFO_PATH = API_BASE + '/ws-info'
let liveToken = ''

function newLiveToken() {
  liveToken = crypto.randomBytes(24).toString('base64url')
}

/* token 比较（timing-safe）：先归一到定长 sha256 摘要再比较。 */
function tokenMatches(expected, provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false
  const left = crypto.createHash('sha256').update(expected).digest()
  const right = crypto.createHash('sha256').update(provided).digest()
  return crypto.timingSafeEqual(left, right)
}

function wsInfoRoute(request, response) {
  if (request.method !== 'GET') {
    sendJson(response, 405, { ok: false, error: 'ws-info is GET only' })
    return
  }
  sendJson(response, 200, { ok: true, token: liveToken })
}

/* The body registers RPC handlers here and nothing else: with no model tools
   there is no tool registry to reach, and \`inject\` no longer names one. */
const harness = {
  handle: function (method, handler) {
    rpcHandlers.set(method, handler)
    return function () { rpcHandlers.delete(method) }
  },
}

export const name = 'dsh-git-idea'

const plugin = (function () {
