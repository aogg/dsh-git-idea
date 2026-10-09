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

/* 面板到浏览器的实时推送（77-cmdrec.js 的 cmdlog-start / cmdlog-exit）汇聚在这个
   对象上：body 片段只认它。默认是一个 no-op —— bridge 版没有 pkg 层，liveSend 里
   的 typeof 守卫本来就不会走到这里；upgrade 路由（host-post.js）注册成功后才把它
   换成真正的广播，卸载时还原。 */
const liveHub = { sockets: new Set(), send: function () {} }

/* The one route the browser half calls: same origin as the page, so no CORS.
   The same-origin check below is what keeps another page on loopback from
   driving git in this reader's working directory. */
const RPC_PATH = '/dsh-git-idea/rpc'
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
