/* ═══ gp65：git/toolchain 探测在部署默认沙箱策略下的真实下场（诊断脚本）═══

   面板「设置 → git 位置」对着一台明明有 /usr/bin/git 的机器说「PATH 上没有 git」。
   嫌疑在探测链路的最后一环：toolchainSnapshot 的 invoke 不带 sessionId、不带
   sandboxPolicy（10-shell.js：args={} exec=null），于是 shell 层落回**部署默认策略**
   —— 而面板里真正跑起来的 git 命令（fetch 等）带的是会话策略 danger-full-access。
   两者唯一的差别就是这条策略，所以这里用**真实的 dsh shell 服务栈**
   （dsh-subprocess-local + dsh-sandbox-local + dsh-sandbox-policy + dsh-bash-sandbox，
   全部从部署的 /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules 里取），
   分别以 defaultMode = workspace-write 与 danger-full-access 各跑一次：

     1. 探测脚本原文直接过一遍执行器 —— shell 层的证据（退出码、stdout/stderr、
        sandbox.mode / sandbox.denied、或抛出的 SandboxUnavailableError 原文）；
     2. 再加载 dist/host.js，调**真的** git/toolchain 处理器 —— 插件层看到的
        found / reason / path / version（或整个 RPC 的拒绝原文）。

   跑法：node test/gp65-toolchain-sandbox-probe.mjs（工作目录最好是 /，与运行中的
   dsh PID 1 的 PWD 一致 —— workspace-write 的回退 workspaceRoot 就来自它）。
   这是诊断不是回归套件：它依赖这台部署上的 bwrap 与 dsh 安装，不进 run-all。 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const PKGS = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { SandboxBashExecutor } = await import(pathToFileURL(PKGS + '/dsh-bash-sandbox/lib/index.js'))
const { LocalSandboxProvider } = await import(pathToFileURL(PKGS + '/dsh-sandbox-local/lib/index.js'))
const { SandboxPolicyService } = await import(pathToFileURL(PKGS + '/dsh-sandbox-policy/lib/index.js'))
const { LocalSubprocessRuntime } = await import(pathToFileURL(PKGS + '/dsh-subprocess-local/lib/index.js'))

/* 插件配置文件落到一个一次性的 DSH_HOME 里，别碰真实部署的那份。 */
const HOME = '/tmp/gp65-home'
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME + '/.dsh', { recursive: true })
process.env.DSH_HOME = HOME + '/.dsh'
process.env.HOME = HOME

/* host.js 用到的最小 ctx：get 只发 shell；effect/inject/reflect/sessionProjections
   都是服务构造期的登记钩子，真实行为全在四个服务实例自己身上。 */
const effects = []
const ctx = {
  get(name) { return name === 'shell' ? ctx.shell : undefined },
  effect(cb) { const d = cb(); effects.push(typeof d === 'function' ? d : () => {}); return d },
  inject(_deps, _cb) {},
  reflect: { provide() {} },
  sessionProjections: { register() {} },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

/* bash-local 的 Config 字段是带 .get() 的引用（cordis 装配时生成），直连构造就自己
   造同一形状；数值与部署默认一致，cwd 不设（落到 process.cwd()，与 PID 1 的 PWD=/ 同形）。 */
const ref = (value) => ({ get: () => value })
const bashConfig = {
  cwd: ref(undefined), timeoutMs: ref(120000), maxTimeoutMs: ref(600000),
  maxOutputBytes: ref(1048576), maxSpillBytes: ref(67108864), graceMs: ref(3000),
}

/* 服务栈与部署同形：subprocess / sandbox / sandboxPolicy / shell 四件都是真类。
   subprocess 一份就够（部署也是进程级单例）；sandboxPolicy 每种模式重建一个。 */
ctx.subprocess = new LocalSubprocessRuntime(ctx)

function buildStack(mode, workspaceRoot) {
  ctx.sandboxPolicy = new SandboxPolicyService(ctx, { mode, workspaceRoot })
  ctx.sandbox = new LocalSandboxProvider(ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 })
  ctx.shell = new SandboxBashExecutor(ctx, bashConfig)
}

/* 与 72-gitbin.js toolchainSnapshot 里那一段逐字相同的探测脚本（gitPath 为空时）。 */
const PROBE = 'p=$(command -v git 2>/dev/null || true)\n'
  + "printf 'P:%s\\n' \"$p\"\n"
  + "printf 'V:%s\\n' \"$(git --version 2>&1 | head -1)\"\n"

async function rawProbe(label) {
  console.log('  -- 原始探测脚本过真实执行器（' + label + '）--')
  try {
    const execution = await ctx.shell.execute(ctx.shell.resolve({ command: PROBE, timeoutMs: 10000, stdoutMaxBytes: 1048576 }))
    const r = typeof execution.result === 'function' ? await execution.result() : execution
    console.log('    exitCode:', r.exitCode, ' sandbox:', JSON.stringify(r.sandbox), ' timedOut:', r.timedOut === true)
    console.log('    stdout:', JSON.stringify(r.stdout != null && r.stdout.text))
    console.log('    stderr:', JSON.stringify(r.stderr != null && r.stderr.text))
  } catch (error) {
    console.log('    抛出:', error != null ? error.name : typeof error, '-', String(error && error.message))
    if (error != null && error.code !== undefined) console.log('    code:', String(error.code))
  }
}

async function callToolchain(label) {
  console.log('  -- 真实 git/toolchain 处理器（' + label + '）--')
  const handlers = new Map()
  const harness = { handle(name, fn) { handlers.set(name, fn); return () => {} } }
  /* 默认读**部署里正在跑的那份** dist/host.js（面板看到的答案就是它答的）；
     GP_SRC 可以指到别的构建产物（其他套件同一条约定）。 */
  const hostSrc = process.env.GP_SRC || '/app/cache/my/github/dsh-git-idea/dist/host.js'
  const body = fs.readFileSync(hostSrc, 'utf8')
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, console,
    (s) => Buffer.from(s, 'binary').toString('base64'),
    (s) => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  const handler = handlers.get('git/toolchain')
  if (handler === undefined) { console.log('    ✗ dist/host.js 没注册 git/toolchain'); return }
  try {
    const reply = await handler({})
    console.log('    答复:', JSON.stringify(reply))
    console.log('    ⇒ 面板 verdict 落在:',
      reply.found === true ? '「现在用的是 …」（正常）'
        : reply.reason === 'configured-missing' ? '「设置里写的路径不可用」'
          : reply.reason === 'not-on-path' ? '「这台机器的 PATH 上没有 git」'
            : reply.reason === 'probe-blocked' ? '新版客户端：「这条检查在沙箱里没跑成」+ detail 原话（旧客户端仍会谎报「PATH 上没有 git」）'
              : '「这台机器的 PATH 上没有 git」（reason=' + JSON.stringify(reply.reason) + ' 被当成没有 git）← 谎报')
  } catch (error) {
    console.log('    RPC 整体被拒:', error != null ? error.name : typeof error, '-', String(error && error.message))
    if (error != null && error.code !== undefined) console.log('    code:', String(error.code))
    console.log('    ⇒ 客户端 catch 落 reason=probe-failed ⇒ 面板说「这台机器的 PATH 上没有 git」← 谎报')
  }
}

for (const mode of ['workspace-write', 'danger-full-access']) {
  console.log('')
  console.log('== defaultMode = ' + mode + '（workspaceRoot = /，与运行中 dsh 的回退一致）==')
  buildStack(mode, '/')
  const resolved = ctx.sandboxPolicy.resolve()
  console.log('  解析出的策略:', JSON.stringify(resolved))
  await rawProbe(mode)
  await callToolchain(mode)
}

console.log('')
console.log('（gp65 诊断脚本跑完 —— 这是根因取证，不是回归套件，不设退出码门槛）')
