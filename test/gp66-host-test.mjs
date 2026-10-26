/* ═══ gp66：git/toolchain 探测的分诊 —— 「没有 git」不许再冒充 ═══

   2026-10-26 的真机事故：部署默认策略是 workspace-write、回退 workspaceRoot 是 /
   （PID 1 的 PWD），bwrap 的剖面把自己的 /dev/null 盖坏了，探测脚本里那句
   `2>/dev/null` 作为**重定向**失败 —— bash 于是整个跳过 `command -v git`，探测答出
   `P:` 空行，宿主把它当成「这台机器的 PATH 上没有 git」，面板对着一台有 /usr/bin/git
   的机器撒谎（复现与取证：test/gp65-toolchain-sandbox-probe.mjs）。

   修复后的分诊只有四个出口，这个套件把每个出口都钉一遍：
     · 探测跑完、git 在               → found=true（gp34d 已有，这里再钉一发作对照）
     · 探测跑完、PATH 上真没有        → reason='not-on-path'（诚实的负面答案保留）
     · 设置里写的路径不可用           → reason='configured-missing'（gp34d 已有）
     · 探测跑不起来（沙箱坏了剖面 /
       拒绝/confine 起不来）          → reason='probe-blocked'，detail 带原话

   探测的 shell 层用**罐头答复**（不在每台机器上依赖真实沙箱的坏法）：假 shell 只在
   认得探测脚本（Q: 收尾行）时吐罐头，其余命令照旧走真 sh —— 插件配置的读写还得是
   真的。跑法：node test/gp66-host-test.mjs。 */

import fs from 'node:fs'
import { spawn } from 'node:child_process'

const HOME = '/tmp/gp66-home'
const IDENT_DIR = HOME + '/.dsh'
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(IDENT_DIR, { recursive: true })
process.env.DSH_HOME = IDENT_DIR
process.env.HOME = HOME

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

/* 罐头：只有探测脚本吃到它；其余命令（配置路径、配置读写）走真 sh。 */
let probeReply = null
function realShell(spec) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: Object.assign({}, process.env) })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}
async function runShell(spec) {
  if (spec.command.indexOf("printf 'Q:") >= 0 && probeReply != null) {
    const canned = probeReply
    return {
      exitCode: canned.exitCode,
      stdout: { text: canned.stdout },
      stderr: { text: canned.stderr },
      sandbox: canned.denied === true ? { denied: true } : null,
    }
  }
  return realShell(spec)
}
const handlers = new Map()
const ctx = { get: n => (n === 'shell' ? { resolve: r => r, run: runShell } : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'), s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
const H = n => handlers.get(n)

const guards = []
const check = (label, value) => {
  if (value !== true) guards.push(label)
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}

console.log('== 探测脚本的形状 ==')
check('探测不再把 stderr 重定向进 /dev/null（workspace-write 根为 / 时它是坏的）',
  body.indexOf("command -v ' + gitCmd() + ' 2>/dev/null") < 0)
check('探测带 Q: 收尾行（「跑到了头」与「没跑起来」从此分得开）',
  body.indexOf("printf 'Q:%s\\\\n' ok") >= 0)
check('reply 里有了 probe-blocked 这个 reason',
  body.indexOf("reason: 'probe-blocked'") >= 0)

console.log('')
console.log('== 探测跑完：四个诚实的答案 ==')
probeReply = { exitCode: 0, stdout: 'P:/usr/bin/git\nV:git version 2.39.5\nQ:ok\n', stderr: '' }
const good = await H('git/toolchain')({})
console.log('  git 在:', JSON.stringify({ path: good.path, version: good.version, found: good.found, reason: good.reason, platform: good.platform }))
check('git 在 PATH 上：found=true，reason 空，platform=ok',
  good.found === true && good.reason === '' && good.platform === 'ok' && good.path === '/usr/bin/git')

probeReply = { exitCode: 0, stdout: 'P:\nV:\nQ:ok\n', stderr: '' }
const none = await H('git/toolchain')({})
console.log('  没有 git:', JSON.stringify({ found: none.found, reason: none.reason }))
check('探测跑到了收尾而 PATH 上没有：还是诚实的 not-on-path（不许被误伤成 probe-blocked）',
  none.found === false && none.reason === 'not-on-path' && none.platform === 'ok')

await H('git/config-save')({ config: { gitPath: '/nonexistent/bin/git' } })
const bad = await H('git/toolchain')({})
console.log('  写错路径:', JSON.stringify({ found: bad.found, reason: bad.reason }))
check('写进去的路径不存在：仍是 configured-missing', bad.found === false && bad.reason === 'configured-missing')
await H('git/config-save')({ config: { gitPath: '' } })

console.log('')
console.log('== 探测跑不起来：probe-blocked，带原话 ==')
/* 真机量到的那一种：/dev/null 坏了，git 解析得到但说不出版本（修复后的探测不会再
   被自家的 2>/dev/null 绊倒，P: 有值、V: 是 git 的 fatal 原话）。 */
probeReply = { exitCode: 0, stdout: 'P:/usr/bin/git\nV:fatal: could not open \'/dev/null\' for reading and writing: Permission denied\nQ:ok\n', stderr: '' }
const fatalV = await H('git/toolchain')({})
console.log('  git 在但说不出版本:', JSON.stringify({ path: fatalV.path, found: fatalV.found, reason: fatalV.reason, detail: fatalV.detail }))
check('解析得到 git 但 --version 不是 git version：probe-blocked，path 与原话都带上',
  fatalV.found === false && fatalV.reason === 'probe-blocked' && fatalV.path === '/usr/bin/git'
  && fatalV.detail.indexOf('/dev/null') >= 0 && fatalV.platform === 'probe-blocked')

/* 更糟的那一种：脚本根本没跑到收尾（剖面坏了把 stdout 弄丢 / 进程被中断）。 */
probeReply = { exitCode: 1, stdout: 'P:\nV:\n', stderr: 'bash: line 1: /dev/null: Permission denied\n' }
const noCanary = await H('git/toolchain')({})
console.log('  没跑到收尾:', JSON.stringify({ found: noCanary.found, reason: noCanary.reason, detail: noCanary.detail }))
check('罐头里没有 Q: 行：probe-blocked，detail 是 stderr 的原话，绝不是 not-on-path',
  noCanary.found === false && noCanary.reason === 'probe-blocked'
  && noCanary.detail.indexOf('/dev/null: Permission denied') >= 0)

/* dsh 沙箱层自己在答复里盖了 denied 章（退出码非 0）：同样是「没跑成」。 */
probeReply = { exitCode: 126, stdout: 'P:\nV:\nQ:ok\n', stderr: '', denied: true }
const denied = await H('git/toolchain')({})
console.log('  sandbox.denied:', JSON.stringify({ found: denied.found, reason: denied.reason, detail: denied.detail }))
check('sandbox.denied=true 且退出码非 0：probe-blocked（有一条说明原因的话）',
  denied.found === false && denied.reason === 'probe-blocked' && denied.detail.length > 0)

/* confine 本身起不来：shell 层对**探测这一次调用**抛 SandboxUnavailableError —— RPC
   要接住它答成分诊，不能整个 reject（那样客户端只会看到一句天书）。配置的读写等
   其余命令照走真 sh：confine 是逐次调用的，坏的是探测这一条，不是整台机器。 */
const throwingShell = {
  resolve: r => r,
  run(spec) {
    if (spec.command.indexOf("printf 'Q:") >= 0) {
      return Promise.reject(new Error('sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host'))
    }
    return realShell(spec)
  },
}
const throwingCtx = {
  get: n => (n === 'shell' ? throwingShell : undefined),
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const throwHandlers = new Map()
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  throwingCtx, { handle(n, f) { throwHandlers.set(n, f); return () => {} } }, console,
  s => Buffer.from(s, 'binary').toString('base64'), s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder
).apply(throwingCtx)
const fromThrow = await throwHandlers.get('git/toolchain')({})
console.log('  SandboxUnavailable:', JSON.stringify({ found: fromThrow.found, reason: fromThrow.reason, detail: String(fromThrow.detail).slice(0, 60) }))
check('shell 层抛 SandboxUnavailableError：答复 probe-blocked 带 runner 原话，RPC 不 reject',
  fromThrow.found === false && fromThrow.reason === 'probe-blocked'
  && String(fromThrow.detail).indexOf('no sandbox backend is usable') >= 0)

console.log('')
if (guards.length > 0) {
  console.log('✗ ' + guards.length + ' 条不符合预期')
  process.exit(1)
}
console.log('（gp66 全部通过）')
