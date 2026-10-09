})()

/* ── WebSocket 实时通道（/dsh-git-idea/ws）──
 *
 * client→host 只有 HTTP RPC（一问一答），host→client 原本没有任何通道 —— 面板执行的
 * 命令开始/结束（77-cmdrec.js 的 cmdlog-start / cmdlog-exit）只能等下一轮整读才上屏。
 * 这段在 webServer 的 upgrade 座位上挂一条 exact 路由，自己完成 RFC 6455 握手与最小
 * 帧读写：只用到「文本帧 + ping/pong + close」这一小角，不引入任何依赖。
 *
 * 同源校验沿用 RPC 路由（host-pre.js 的 sameOrigin）那道门：这个端口机器上任何页面
 * 都够得着，握手必须先证明自己与页面同源，不符就 destroy。
 *
 * 握手 accept、帧编解码与帧读取器是纯函数，经 wsHooks 导出 —— 单元测试不起真端口
 * 就能验（RFC 6455 自带一对已知答案）；这扇小门只服务测试，不承载运行时行为。 */

const WS_PATH = '/dsh-git-idea/ws'
/* RFC 6455 §1.3：握手里那段固定的魔术串。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/* 心跳节奏：每 30s 给每条连接 ping 一次；一条 ping 发出去超过 10s 还没等到 pong
   就当死连接剔除（浏览器对 ping 自动回 pong；回不来的多半是拔线/睡眠的那一侧）。 */
const WS_PING_MS = 30000
const WS_PONG_MAX_MS = 10000

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
}

/* 服务端→客户端的帧不掩码（协议只强制客户端帧带掩码）；长度三档，126/127 两档的
   边界就是协议原文的分界。 */
function wsTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  let head
  if (payload.length < 126) {
    head = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x81
    head[1] = 126
    head.writeUInt16BE(payload.length, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x81
    head[1] = 127
    head.writeUInt32BE(0, 2)
    head.writeUInt32BE(payload.length, 6)
  }
  return Buffer.concat([head, payload])
}

function wsPingFrame() {
  return Buffer.from([0x89, 0])
}

/* pong 要把收到的 ping 载荷原样带回去（协议如此），没有就带空。 */
function wsPongFrame(payload) {
  const body = payload != null && payload.length > 0 ? Buffer.from(payload) : Buffer.alloc(0)
  return Buffer.concat([Buffer.from([0x8a, body.length]), body])
}

function wsCloseFrame() {
  return Buffer.from([0x88, 0])
}

/* 最小帧读取器：客户端帧必掩码，要解掉掩码；opcode 8=close、9=ping、10=pong，
   其余（文本/二进制/分片）忽略 —— 但长度必须照单消费掉，不然坏帧会把缓冲越堆越大。
   分片续帧不做：这个通道上客户端只发 close/ping（浏览器自动），不发业务消息。 */
function wsReader(handlers) {
  let buffer = Buffer.alloc(0)
  return function (chunk) {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = buffer.readUInt32BE(6)
        offset = 10
      }
      let maskAt = -1
      if (masked === true) {
        maskAt = offset
        offset += 4
      }
      if (buffer.length < offset + length) return
      let payload = buffer.subarray(offset, offset + length)
      if (masked === true) {
        const mask = buffer.subarray(maskAt, maskAt + 4)
        const plain = Buffer.allocUnsafe(length)
        for (let i = 0; i < length; i += 1) plain[i] = payload[i] ^ mask[i % 4]
        payload = plain
      }
      buffer = buffer.subarray(offset + length)
      if (opcode === 8) {
        handlers.close()
        return
      }
      if (opcode === 9) {
        handlers.ping(payload)
        continue
      }
      if (opcode === 10) {
        handlers.pong()
        continue
      }
    }
  }
}

/* 广播：逐 socket try/catch，坏连接当场剔除 —— 一条死链不能挡住其余人的推送。 */
function liveBroadcast(text) {
  const frame = wsTextFrame(text)
  for (const socket of Array.from(liveHub.sockets)) {
    if (socket.destroyed === true || socket.writable !== true) {
      liveHub.sockets.delete(socket)
      continue
    }
    try {
      socket.write(frame)
    } catch (error) {
      console.error('dsh-git-idea: live 推送失败，剔除这条连接', String(error))
      liveHub.sockets.delete(socket)
      if (socket.destroyed !== true) socket.destroy()
    }
  }
}

/* 心跳：只对「ping 出去却迟迟没有 pong」的连接动手 —— 刚连上还没被 ping 过的连接
   不看它距上次 pong 多久，否则一上任就会把没等到第一个 ping 的健康连接错杀。 */
function wsHeartbeat() {
  const now = Date.now()
  for (const socket of Array.from(liveHub.sockets)) {
    if (socket.destroyed === true) {
      liveHub.sockets.delete(socket)
      continue
    }
    const seen = socket.__dshLiveSeen || 0
    const pingedAt = socket.__dshLivePingAt
    if (pingedAt != null && seen < pingedAt && now - pingedAt > WS_PONG_MAX_MS) {
      liveHub.sockets.delete(socket)
      socket.destroy()
      continue
    }
    socket.__dshLivePingAt = now
    if (socket.destroyed !== true && socket.writable === true) socket.write(wsPingFrame())
  }
}

/* 握手 + 收编：写 101、进 liveHub、帧读取器接上（head 是 upgrade 分发可能已经
   垫好的首批字节，不能丢）。webServer 的 upgrade 分发自己挂着 error 监听，这里
   听 close 就够 —— 死连接从 Set 里消失。 */
function wsUpgrade(request, socket, head) {
  if (sameOrigin(request) !== true) {
    socket.destroy()
    return
  }
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || key.length === 0) {
    socket.destroy()
    return
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + 'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n')
  const feed = wsReader({
    close: function () {
      /* 回一个 close 再断：既守协议的礼数，也不让对方等 TCP 挥发的超时。 */
      if (socket.destroyed !== true && socket.writable === true) socket.end(wsCloseFrame(), function () { socket.destroy() })
      else if (socket.destroyed !== true) socket.destroy()
      liveHub.sockets.delete(socket)
    },
    ping: function (payload) {
      if (socket.destroyed !== true && socket.writable === true) socket.write(wsPongFrame(payload))
    },
    pong: function () {
      socket.__dshLiveSeen = Date.now()
    },
  })
  if (head != null && head.length > 0) feed(head)
  socket.on('data', feed)
  socket.on('close', function () { liveHub.sockets.delete(socket) })
  socket.__dshLiveSeen = Date.now()
  liveHub.sockets.add(socket)
}

/* The body's own apply, plus the one thing the bridge used to own: the
   transport to the browser half. `webServer` is optional at the type level but
   present in every web profile; without it the panel goes quiet and nothing
   else changes. */
export function apply(ctx, config) {
  ctx.inject(['webServer'], function (scope) {
    scope.effect(function () {
      return scope.webServer.register({ kind: 'exact', path: RPC_PATH, handler: rpcRoute })
    }, 'dsh-git-idea rpc route')
    /* 实时通道：registerUpgrade 是这个 webServer 才有的座位，没有就退化为纯轮询
       （面板照常工作，只是没有推送）。卸载时按座位的规矩收拾干净：停心跳、给每条
       连接发 close 并断开、清空集合、把 liveHub.send 还原成 no-op —— 下一次 apply
       再重新接管。 */
    if (typeof scope.webServer.registerUpgrade === 'function') {
      scope.effect(function () {
        const remove = scope.webServer.registerUpgrade({ path: WS_PATH, handler: wsUpgrade })
        const timer = setInterval(wsHeartbeat, WS_PING_MS)
        liveHub.send = liveBroadcast
        return function () {
          if (typeof remove === 'function') remove()
          clearInterval(timer)
          for (const socket of Array.from(liveHub.sockets)) {
            if (socket.destroyed !== true && socket.writable === true) socket.end(wsCloseFrame(), function () { socket.destroy() })
            else if (socket.destroyed !== true) socket.destroy()
          }
          liveHub.sockets.clear()
          liveHub.send = function () {}
        }
      }, 'dsh-git-idea live route')
    }
  })
  return plugin.apply(ctx, config)
}

/* 单元测试的小门：握手 accept 与帧编解码的纯函数部分（RFC 6455 自带一对已知答案）。 */
export const wsHooks = {
  accept: wsAccept,
  textFrame: wsTextFrame,
  pingFrame: wsPingFrame,
  pongFrame: wsPongFrame,
  closeFrame: wsCloseFrame,
  reader: wsReader,
}

/* `shell` is the one service the host half cannot do without: every git command
   goes through it. Declared, not only read, because the executor that provides
   it (`bash-sandbox` / `pwsh-sandbox`) is itself parked until `subprocess`,
   `sandbox` and `sandboxPolicy` are ready — so at this plugin's apply time
   `ctx.get('shell')` can still be undefined, and the body's guard would then
   register no RPC at all. Cordis parks this plugin until the service exists;
   `dsh-tool-bash`, the product's own bash tool, declares the same one. The rest
   — `fs`, `timer`, `sandboxPolicy`, `sessions` — stay `ctx.get` reads with
   guards, because a panel without them is still a panel. */
export const inject = ['shell']
