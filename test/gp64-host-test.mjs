import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 宿主常驻监听（79-live-watch.js）× cordis v4 的服务可见性 ──
 *
 * 起因（2026-10-22 真机误诊）：WS 通路、RPC、签名轮询进程全都活着，却一度判定
 * 「宿主常驻监听是哑的」——因为 sessions/agents 拿不到时跳过是完全无声的，「按设计
 * 跳过」与「以为在监听、其实每轮都在跳过」从外面无法区分。本套件钉三件事：
 *
 *   1. cordis v4 形状的 ctx（对齐 @deepseek-ai/cordis 0.2.0-rc.2 的 reflect 语义）：
 *      · ctx.get(name) 是 strict 读 —— 服务实现存在、且 providing fiber 的 state
 *        恰为 ACTIVE(2) 才返回实现，否则 undefined（fiber 还在 PENDING 时服务
 *        尚不可见，这正是「拿到了 undefined」的合法来源）；
 *      · 没走 inject 的属性访问（ctx.sessions 这类）必抛
 *        "cannot get property … without inject"（reflect 的 proxy get 陷阱）。
 *      片段只用 ctx.get 读服务 —— 若哪天有人把读法改回属性访问，本套件的 Proxy
 *      会让 apply 当场抛错，整组失败；
 *   2. 三态行为：两服务可见 → running 边沿照常挂防抖、到点推 session-complete，
 *      且全程没有「看不到」日志；两服务实现存在但 fiber PENDING（对真机就是
 *      「ctx.get 拿 undefined」）→ 会话那一半静默跳过、定时器照排、RPC 照常注册、
 *      **「看不到」日志每个服务恰好一条**（同一状态不重复刷屏）；PENDING→ACTIVE
 *      （服务迟到）→ 下一拍自动恢复，各补一条「重新看到」，边沿流程照常走通；
 *   3. 两个一半相互独立：agents 不可见只会哑掉 session-complete，仓库签名轮询
 *      （配置登记的仓库）与 repo-changed 推送照常。
 *
 * 定时器走 timer 服务桩（liveTimers 优先取服务），手动开火，不真等。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp64-home'
const GLOBAL = HOME + '/.gitconfig'
const R = '/tmp/gp64-repo'
const R2 = '/tmp/gp64-repo2'

function makeBody(opts) {
  const shellEnv = Object.assign({}, process.env, {
    DSH_HOME: HOME + '/.dsh', HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL,
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  })
  const spawns = []
  function runShell(spec) {
    spawns.push(spec.command)
    return new Promise((res) => {
      const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: shellEnv })
      let o = '', e = ''
      c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
      c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
      c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
    })
  }
  const timers64 = []
  const timerService = {
    interval(cb, delay) { const t = { kind: 'interval', cb, delay, dead: false }; timers64.push(t); return () => { t.dead = true } },
    timeout(cb, delay) { const t = { kind: 'timeout', cb, delay, dead: false }; timers64.push(t); return () => { t.dead = true } },
  }
  /* cordis v4 形状的服务表：实现 + providing fiber 的 state（2 = ACTIVE）。
   * shell/timer 永远 ACTIVE —— apply 门口就要读 shell，定时器桩也要走服务。 */
  const impls = new Map()
  impls.set('shell', { fiberState: 2, value: { resolve: r => r, run: runShell } })
  impls.set('timer', { fiberState: 2, value: timerService })
  if (opts.sessions !== undefined) impls.set('sessions', { fiberState: opts.sessionsState === undefined ? 2 : opts.sessionsState, value: opts.sessions })
  if (opts.agents !== undefined) impls.set('agents', { fiberState: opts.agentsState === undefined ? 2 : opts.agentsState, value: opts.agents })
  const logged = []
  const fakeConsole = {
    error: function () { logged.push(Array.from(arguments).map(String).join(' ')) },
    log: function () {}, warn: function () {},
  }
  const disposers = []
  const base = {
    /* 79b-file-save.js 读 ctx.on（cordis 的事件 mixin，是 ctx 的合法成员）——
     * 给一个最小的 no-op，只让那一读成立；其余没声明过的属性访问仍然必抛。 */
    on: function () { return function () {} },
  }
  const ctx = new Proxy(base, {
    get: function (target, prop) {
      if (prop === 'get') {
        return function (name) {
          const impl = impls.get(name)
          if (impl == null || impl.fiberState !== 2) return undefined
          return impl.value
        }
      }
      if (prop === 'effect') {
        return function (cb) {
          const d = cb()
          if (typeof d === 'function') disposers.push(d)
          return typeof d === 'function' ? d : function () {}
        }
      }
      if (Reflect.has(target, prop)) return target[prop]
      throw new Error('cannot get property "' + String(prop) + '" without inject')
    },
  })
  const handlers = new Map()
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  const params = ['ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder']
  const args = [ctx, harness, fakeConsole, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder]
  if (opts.liveHub !== undefined) { params.push('liveHub'); args.push(opts.liveHub) }
  new Function(...params, body)(...args).apply(ctx)
  return {
    H: n => handlers.get(n), spawns: spawns, timers: timers64, disposers: disposers,
    logged: logged,
    activate: function (name) { const impl = impls.get(name); if (impl != null) impl.fiberState = 2 },
    setState: function (name, state) { const impl = impls.get(name); if (impl != null) impl.fiberState = state },
  }
}

function sh(cmd, cwd) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', cmd], { cwd, env: Object.assign({}, process.env, {
      DSH_HOME: HOME + '/.dsh', HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL,
      GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    }) })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('close', x => res({ code: x, out: o, err: e }))
  })
}

let failed = 0
const check = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 25))
async function until(fn, label) {
  for (let i = 0; i < 400; i += 1) {
    if (fn() === true) return true
    await wait(25)
  }
  throw new Error('gp64-host: 等不到 ' + (label || '条件'))
}
const intervalOf = (a, delay) => a.timers.find((t) => t.kind === 'interval' && t.delay === delay && t.dead !== true)
const pendingTimeouts = (a) => a.timers.filter((t) => t.kind === 'timeout' && t.delay === 2000 && t.dead !== true)
const fireTimeout = (t) => { t.cb(); t.dead = true }
const missingLogs = (a, name) => a.logged.filter((line) => line.indexOf('看不到 ' + name + ' 服务') >= 0)
const backLogs = (a, name) => a.logged.filter((line) => line.indexOf('重新看到 ' + name + ' 服务') >= 0)

/* fixture：两个真仓库；配置只登记 R，R2 专走「会话工作区」那条路。 */
await sh(`rm -rf ${R} ${R2} ${HOME} && mkdir -p ${HOME} ${R} ${R2} ${HOME}/.dsh
cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first
cd ${R2} && git init -q -b main && git config user.email t@t && git config user.name T && echo b > b.txt && git add -A && git commit -qm first`, '/tmp')
await sh(`printf '%s' '${JSON.stringify({ repos: { '/ws': [R] } })}' > ${HOME}/.dsh/dsh-git-idea.json`, '/tmp')

const sessionRows = [{ id: 'session-gp64', header: { cwd: R2 } }]
const sessionsStub = { list: () => sessionRows.map(r => ({ id: r.id, header: { cwd: r.header.cwd } })) }
function agentsStubOf() {
  const status = { v: 'running' }
  return { stub: { get: (id) => (id === 'session-gp64' ? { status: status.v } : null) }, status: status }
}

console.log('')
console.log('=== 两服务可见（ACTIVE）：边沿→防抖→推送，全程无「看不到」 ===')
{
  const pushes = []
  const liveHub = { sockets: new Set([{ fake: true }]), send: (t) => pushes.push(JSON.parse(t)) }
  const agent = agentsStubOf()
  const a = makeBody({ sessions: sessionsStub, agents: agent.stub, liveHub })
  check('RPC 照常注册', typeof a.H('git/panel') === 'function' && typeof a.H('git/watch') === 'function')
  const sigTick = intervalOf(a, 10000)
  const sesTick = intervalOf(a, 1500)
  check('两根 interval 都排上了', sigTick != null && sesTick != null)
  sesTick.cb()
  check('running 基线：不推、不挂防抖', pushes.length === 0 && pendingTimeouts(a).length === 0)
  agent.status.v = 'idle'
  sesTick.cb()
  check('true→false 边沿：挂上 2 秒防抖', pendingTimeouts(a).length === 1)
  fireTimeout(pendingTimeouts(a)[0])
  const done = pushes.filter((p) => p.kind === 'session-complete' && p.sessionId === 'session-gp64')
  check('防抖到点：推 session-complete', done.length === 1)
  check('可见时全程没有「看不到」日志', a.logged.length === 0)
  a.disposers.forEach((d) => d())
}

console.log('')
console.log('=== 服务存在但 fiber PENDING：静默跳过 + 每服务恰好一条「看不到」 ===')
{
  const pushes = []
  const liveHub = { sockets: new Set([{ fake: true }]), send: (t) => pushes.push(JSON.parse(t)) }
  const agent = agentsStubOf()
  const a = makeBody({ sessions: sessionsStub, agents: agent.stub, liveHub, sessionsState: 0, agentsState: 0 })
  check('ctx.get 拿 undefined 不炸 apply，RPC 照常注册', typeof a.H('git/panel') === 'function')
  const sigTick = intervalOf(a, 10000)
  const sesTick = intervalOf(a, 1500)
  check('两根 interval 照排（跳过不等于停摆）', sigTick != null && sesTick != null)
  for (let i = 0; i < 5; i += 1) sesTick.cb()
  check('连开五拍：session-complete 一次不推', pushes.filter((p) => p.kind === 'session-complete').length === 0)
  check('「看不到 sessions」恰好一条（同一状态不重复）', missingLogs(a, 'sessions').length === 1)
  check('「看不到 agents」恰好一条', missingLogs(a, 'agents').length === 1)
  check('还没有「重新看到」', backLogs(a, 'sessions').length === 0 && backLogs(a, 'agents').length === 0)
  /* agents 哑不连累仓库那一半：配置登记的 R 照常轮询、变化照常推。 */
  sigTick.cb()
  await until(() => a.spawns.some((c) => c.indexOf('for-each-ref') >= 0 && c.indexOf(R) >= 0), '基线轮询起进程')
  await wait(2200) /* LIVE_REPO_PUSH_GAP_MS：两轮之间留够最小推送间隔 */
  await sh(`cd ${R} && git update-ref refs/heads/seen HEAD`, R)
  sigTick.cb()
  await until(() => pushes.some((p) => p.kind === 'repo-changed' && p.repo === R), 'repo-changed 推送')
  check('agents 不可见不连累 repo-changed（两个一半独立）', pushes.some((p) => p.kind === 'repo-changed' && p.repo === R))
  /* 会话工作区那条腿（R2）确实哑着：PENDING 的 sessions 让 liveRepoList 只剩配置登记。 */
  check('会话工作区 R2 不进轮询清单', !a.spawns.some((c) => c.indexOf('for-each-ref') >= 0 && c.indexOf(R2 + "'") >= 0))
  a.disposers.forEach((d) => d())
}

console.log('')
console.log('=== 服务迟到（PENDING→ACTIVE）：下一拍自动恢复 + 各一条「重新看到」 ===')
{
  const pushes = []
  const liveHub = { sockets: new Set([{ fake: true }]), send: (t) => pushes.push(JSON.parse(t)) }
  const agent = agentsStubOf()
  const a = makeBody({ sessions: sessionsStub, agents: agent.stub, liveHub, sessionsState: 0, agentsState: 0 })
  const sesTick = intervalOf(a, 1500)
  sesTick.cb()
  check('恢复前：「看不到」各一条', missingLogs(a, 'sessions').length === 1 && missingLogs(a, 'agents').length === 1)
  a.activate('sessions')
  sesTick.cb()
  check('sessions 先回来：agents 仍缺，还是不推', pushes.filter((p) => p.kind === 'session-complete').length === 0)
  check('「重新看到 sessions」一条', backLogs(a, 'sessions').length === 1)
  a.activate('agents')
  sesTick.cb() /* 基线（running） */
  agent.status.v = 'idle'
  sesTick.cb()
  check('边沿重新有效：挂上防抖', pendingTimeouts(a).length === 1)
  fireTimeout(pendingTimeouts(a)[0])
  check('迟到到位后 session-complete 照推', pushes.some((p) => p.kind === 'session-complete' && p.sessionId === 'session-gp64'))
  check('「重新看到 agents」一条', backLogs(a, 'agents').length === 1)
  check('「看不到」没有新增', missingLogs(a, 'sessions').length === 1 && missingLogs(a, 'agents').length === 1)
  a.disposers.forEach((d) => d())
  check('卸载：interval 全停', a.timers.every((t) => t.dead === true))
}

console.log('')
if (failed > 0) {
  console.log(`gp64-host: ${failed} 失败`)
  process.exit(1)
}
console.log('gp64-host: 全部通过')
