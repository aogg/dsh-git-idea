import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ── 实时通道迁到 /api 前缀 + token/cid 认证（Host 这一侧：ws-info 与升级握手的门）──
 *
 * 钉的是 pkg 前后奏（host-pre.js / host-post.js）拼出来的正式包那一半 —— 这些路由不
 * 在 bridge body 里，读 dist/host.js 的宿主套件都够不着它。用 build-package.mjs 自己
 * 的 render 把 src/pkg + src/host 现拼到临时文件再 import（不起真端口；仓库里 dist/
 * 新不新鲜都不影响这一场，GP_FRESH 场合测的也永远是当前 src/），apply 进一只桩 ctx
 * 捕获 webServer 的注册，然后直接调捕获到的处理器。四件事：
 *
 *   0. 座位：rpc 与 ws-info 都挂在 /api/dsh-git-idea 前缀的 exact 路由上（与 rpc 同
 *      款、同享宿主认证围栏），ws 挂 registerUpgrade 的 /api/dsh-git-idea/ws；顶层旧
 *      路径不再注册。
 *   1. ws-info：GET 答 {ok:true, token}，token 是 24 字节的 base64url（32 字符、URL
 *      安全字母表）；POST 405。
 *   2. token 每次插件实例 apply 换新（newLiveToken），上一任的 token 握手直接被断
 *      —— dsh 重启后客户端拿旧 token 来只会被拒，重拉 ws-info 才是新账。
 *   3. 升级握手的门序：sameOrigin 不过 → destroy；同源了没带 token / token 错 →
 *      destroy 不回包；token 对 → 101，Sec-WebSocket-Accept 与 RFC 6455 §1.3 的已知
 *      答案逐字一致；cid 异形不断连接（cid 只进握手日志，不参与鉴权）。
 *   4. 形状钉死（源码级）：token 比较先归一到定长 sha256 摘要再 timingSafeEqual
 *      （长度与字节都不从比较耗时里漏出去）；client 半每轮先拉 ws-info（no-store）
 *      拿 token 拼 query，且拉取链必须有 catch 兜底 —— 少了它，ws-info 一次失败就把
 *      connecting 永久卡在 true，liveBus 从此装死。
 */

const built = await import('../build-package.mjs')
const hostTarget = built.PACKAGE_TARGETS.find(function (row) { return row.out === 'dist/lib/index.js' })
const clientTarget = built.PACKAGE_TARGETS.find(function (row) { return row.out === 'dist/client/client.js' })
const hostSrc = built.render(hostTarget)
const clientSrc = built.render(clientTarget)

/* 现拼现 import：正式包写到临时文件再进来，用完即删。 */
const tmpFile = path.join(os.tmpdir(), 'dgi-gp68-pkg-' + String(process.pid) + '.mjs')
fs.writeFileSync(tmpFile, hostSrc)
let pkg
try {
  pkg = await import('file://' + tmpFile)
} finally {
  fs.unlinkSync(tmpFile)
}

let failed = 0
const check = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}

/* 桩 webServer：记下 exact 路由与升级路由；apply 的 effect 收集器负责退订（心跳
   interval、liveHub 接管都必须还回去，不然这场跑完进程挂着不退）。 */
function install() {
  const routes = new Map()
  const upgrades = new Map()
  const disposers = []
  const webServer = {
    register: function (spec) { routes.set(spec.path, spec.handler); return function () { routes.delete(spec.path) } },
    registerUpgrade: function (spec) { upgrades.set(spec.path, spec.handler); return function () { upgrades.delete(spec.path) } },
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
  return {
    routes: routes,
    upgrades: upgrades,
    dispose: function () { while (disposers.length > 0) disposers.pop()() },
  }
}

function fakeResponse() {
  return {
    status: 0,
    body: '',
    writeHead: function (status) { this.status = status },
    end: function (text) { this.body = String(text) },
  }
}

function fakeSocket() {
  return {
    destroyed: false,
    writable: true,
    written: [],
    listeners: {},
    write: function (chunk) {
      if (this.destroyed === true) throw new Error('write after destroy')
      this.written.push(String(chunk))
      return true
    },
    end: function (chunk, cb) {
      if (chunk !== undefined) this.written.push(String(chunk))
      this.destroyed = true
      if (typeof cb === 'function') cb()
    },
    destroy: function () { this.destroyed = true },
    on: function (name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn) },
  }
}

const HOST_HEADER = '127.0.0.1:3080'
/* 真浏览器的升级请求必带 16 字节随机 key；用 RFC 6455 §1.3 的示例 key，好让 101
   回包里的 Accept 直接对得上已知答案。 */
const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='
function upgradeRequest(token, cid, noOrigin) {
  const headers = noOrigin === true ? { host: HOST_HEADER } : { host: HOST_HEADER, origin: 'http://' + HOST_HEADER }
  headers['sec-websocket-key'] = WS_KEY
  let url = '/api/dsh-git-idea/ws'
  const parts = []
  if (token !== undefined) parts.push('token=' + encodeURIComponent(token))
  if (cid !== undefined) parts.push('cid=' + encodeURIComponent(cid))
  if (parts.length > 0) url += '?' + parts.join('&')
  return { method: 'GET', url: url, headers: headers }
}

console.log('')
console.log('=== 0｜座位：rpc 与 ws-info 都是 /api 前缀的 exact 路由，ws 挂 registerUpgrade ===')
const first = install()
check('rpc 路由挂在 /api/dsh-git-idea/rpc', typeof first.routes.get('/api/dsh-git-idea/rpc') === 'function')
check('ws-info 路由挂在 /api/dsh-git-idea/ws-info', typeof first.routes.get('/api/dsh-git-idea/ws-info') === 'function')
check('升级路由挂在 /api/dsh-git-idea/ws', typeof first.upgrades.get('/api/dsh-git-idea/ws') === 'function')
check('顶层旧路径不再注册（/dsh-git-idea/rpc、/dsh-git-idea/ws 都没有）',
  first.routes.has('/dsh-git-idea/rpc') === false
  && first.routes.has('/dsh-git-idea/ws') === false
  && first.upgrades.has('/dsh-git-idea/ws') === false)

console.log('')
console.log('=== 1｜ws-info：GET 答 {ok, token}；POST 405 ===')
{
  const wsInfo = first.routes.get('/api/dsh-git-idea/ws-info')
  const res = fakeResponse()
  wsInfo({ method: 'GET', headers: {} }, res)
  const info = JSON.parse(res.body)
  check('GET → 200 {ok:true, token:…}', res.status === 200 && info.ok === true && typeof info.token === 'string')
  check('token 是 24 字节的 base64url（32 字符、URL 安全字母表、无垫字）', /^[A-Za-z0-9_-]{32}$/.test(info.token))
  const res405 = fakeResponse()
  wsInfo({ method: 'POST', headers: {} }, res405)
  check('POST → 405', res405.status === 405)
}

console.log('')
console.log('=== 2｜token 每次插件实例 apply 换新；上一任的 token 握手直接断 ===')
{
  const res1 = fakeResponse()
  first.routes.get('/api/dsh-git-idea/ws-info')({ method: 'GET', headers: {} }, res1)
  const token1 = JSON.parse(res1.body).token
  first.dispose()
  const second = install()
  const res2 = fakeResponse()
  second.routes.get('/api/dsh-git-idea/ws-info')({ method: 'GET', headers: {} }, res2)
  const token2 = JSON.parse(res2.body).token
  check('重入 apply：ws-info 给的是另一个 token（仍是 24 字节 base64url）',
    token2 !== token1 && /^[A-Za-z0-9_-]{32}$/.test(token2))
  const stale = fakeSocket()
  second.upgrades.get('/api/dsh-git-idea/ws')(upgradeRequest(token1, 'tab-old'), stale, Buffer.alloc(0))
  check('上一任的 token 来握手：直接断开，一字节没回', stale.destroyed === true && stale.written.length === 0)

  console.log('')
  console.log('=== 3｜升级握手的门序：sameOrigin → token → RFC 6455 ===')
  const handler = second.upgrades.get('/api/dsh-git-idea/ws')
  const s1 = fakeSocket()
  handler(upgradeRequest(token2, 'tab', true), s1, Buffer.alloc(0))
  check('缺 Origin（sameOrigin 不过）：destroy，一字节没回', s1.destroyed === true && s1.written.length === 0)
  const s2 = fakeSocket()
  handler(upgradeRequest(undefined, 'tab'), s2, Buffer.alloc(0))
  check('query 没带 token：destroy，不回包', s2.destroyed === true && s2.written.length === 0)
  const s3 = fakeSocket()
  handler(upgradeRequest('A'.repeat(43) + '=', 'tab'), s3, Buffer.alloc(0))
  check('token 错：destroy，不回包', s3.destroyed === true && s3.written.length === 0)
  const s4 = fakeSocket()
  handler(upgradeRequest(token2, 'tab'), s4, Buffer.alloc(0))
  check('token 对：写 101，Accept 与 wsHooks.accept(key) 一致',
    s4.destroyed === false && s4.written.length > 0
    && s4.written[0].indexOf('101 Switching Protocols') >= 0
    && s4.written[0].toLowerCase().indexOf('sec-websocket-accept: ' + pkg.wsHooks.accept(WS_KEY).toLowerCase()) >= 0)
  check('Accept 等于 RFC 6455 §1.3 的示例值', pkg.wsHooks.accept(WS_KEY) === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  const s5 = fakeSocket()
  handler(upgradeRequest(token2, '../../../etc&x y'), s5, Buffer.alloc(0))
  check('cid 异形不断连接（cid 只进握手日志，不参与鉴权）', s5.destroyed === false && s5.written.length > 0)
  second.dispose()
}

console.log('')
console.log('=== 4｜两半的形状（源码级钉死） ===')
check('token 比较先归一到定长 sha256 摘要再 timingSafeEqual（不比较变长原文）',
  hostSrc.indexOf("crypto.createHash('sha256').update(expected).digest()") >= 0
  && hostSrc.indexOf("crypto.createHash('sha256').update(provided).digest()") >= 0
  && hostSrc.indexOf('crypto.timingSafeEqual(left, right)') >= 0)
check('token 每任生成一次：crypto.randomBytes(24).toString(\'base64url\')',
  hostSrc.indexOf("crypto.randomBytes(24).toString('base64url')") >= 0)
check('client 每轮连接先拉 /api/dsh-git-idea/ws-info（no-store）拿 token',
  clientSrc.indexOf("const API_BASE = '/api/dsh-git-idea'") >= 0
  && clientSrc.indexOf("fetch(API_BASE + '/ws-info', { cache: 'no-store' })") >= 0)
check('client 握手 URL 带 token 与 cid（encodeURIComponent 后拼 query）',
  clientSrc.indexOf("'/ws?token=' + encodeURIComponent(info.token)") >= 0
  && clientSrc.indexOf("'&cid=' + encodeURIComponent(WS_CID)") >= 0)
check('client 的 ws-info 拉取链有 catch 兜底（失败清 connecting、走退避重试）',
  /\}\)\.catch\(function \(error\) \{[\s\S]*?liveBus\.connecting = false[\s\S]*?liveBus\.retry\(\)/.test(clientSrc))

if (failed > 0) {
  console.error('gp68-token-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
