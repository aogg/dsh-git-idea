import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 宿主常驻监听（79-live-watch.js）：签名轮询推 repo-changed，running 边沿推
 *    session-complete ──
 *
 * 真起仓库（gp53 的骨架）+ 桩 ctx（shell 真跑、timer/会话服务是测试桩），盯这些：
 *   1. bridge 版（host.js 没有 pkg 层、没有 liveHub）：整个常驻监听安静不启用 ——
 *      不排定时器、不起进程、不报错；
 *   2. 真包形状（liveHub 桩 + sessions/agents 桩）：上任先立基线 —— 首轮对每个仓库
 *      只记签名不推送；配置登记的仓库 ∪ 各 live 会话的 cwd 去重（同一路径一轮只起
 *      一个进程）；目录已消失的路径只记基线从不推送；
 *   3. 签名变化 → 先失效宿主读缓存（git/panel 第二次读从「缓存命中」变回「重新起
 *      进程」）→ liveHub 收到 {kind:'repo-changed', repo}；2 秒最小推送间隔压住的
 *      变化保留旧基线，下一轮补推；
 *   4. running 位：首次见到只记基线；true→false 边沿挂 2 秒防抖，期间又变回
 *      running 整轮取消（不推）；防抖到点推 {kind:'session-complete', sessionId}；
 *      一直 idle 的会话永不推；
 *   5. 没接 sessions/agents 服务的部署：会话那半安静跳过；没有浏览器连着
 *      （liveHub.sockets 空）：签名轮询不起进程；
 *   6. 卸载：两个 interval 与挂着的防抖一起停。
 *
 * 定时器全部走 ctx.get('timer') 桩（79-live-watch.js 的 liveTimers 优先取服务），
 * 测试手动开火，不真等 10 秒。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp54-home'
const GLOBAL = HOME + '/.gitconfig'
const R = '/tmp/gp54-repo'
const R2 = '/tmp/gp54-repo2'
const GONE = '/tmp/gp54-gone'
/* 引用形式：watchCommand / panelCommand 里路径都经 shq（单引号）进命令行，
 * 带上引号才能把 R 与前缀相同的 R2 区分开。 */
const q = (p) => "'" + p + "'"

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
  const timers54 = []
  const timerService = {
    interval(cb, delay) { const t = { kind: 'interval', cb, delay, dead: false }; timers54.push(t); return () => { t.dead = true } },
    timeout(cb, delay) { const t = { kind: 'timeout', cb, delay, dead: false }; timers54.push(t); return () => { t.dead = true } },
  }
  const services = { shell: { resolve: r => r, run: runShell }, timer: timerService }
  if (opts.sessions !== undefined) services.sessions = opts.sessions
  if (opts.agents !== undefined) services.agents = opts.agents
  const disposers = []
  const ctx = {
    get: n => services[n],
    effect(cb) { const d = cb(); if (typeof d === 'function') disposers.push(d); return typeof d === 'function' ? d : () => {} },
  }
  const handlers = new Map()
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  const params = ['ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder']
  const args = [ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder]
  if (opts.liveHub !== undefined) { params.push('liveHub'); args.push(opts.liveHub) }
  new Function(...params, body)(...args).apply(ctx)
  return { H: n => handlers.get(n), spawns, timers: timers54, disposers }
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
  for (let i = 0; i < 240; i += 1) {
    if (fn() === true) return true
    await wait(25)
  }
  throw new Error('gp54-host: 等不到 ' + (label || '条件'))
}
/* 一轮签名轮询是顺序起的几个进程：等到「最后一个该出现的 spawn」之后，再留一段
 * 让比较/推送落地、busy 位落回 —— 否则下一轮手动开火会被 busy 原样丢掉。 */
const settle = (ms) => wait(ms || 150)
/* 签名轮询/会话快照两根 interval，按延迟找出来手动开火。 */
const intervalOf = (a, delay) => a.timers.find((t) => t.kind === 'interval' && t.delay === delay)
const liveTimeouts = (a) => a.timers.filter((t) => t.kind === 'timeout' && t.delay === 2000 && t.dead !== true)
/* 真 setTimeout 到点后就不挂着了；stub 的 cb 是手动开的，开完顺手标 dead，
 * 让 liveTimeouts 的「还挂着」语义与真实时钟一致。 */
const fireTimeout = (t) => { t.cb(); t.dead = true }
const livePushes = (pushes, kind) => pushes.filter((p) => p.kind === kind)
const sigSpawns = (a, repo) => a.spawns.filter((c) => c.indexOf('-C ' + q(repo)) >= 0 && c.indexOf('for-each-ref') >= 0).length

/* fixture：两个真仓库 + 一个不存在的路径；配置登记 {R, GONE}；会话工作区 {R, R2}
 * —— R 两边都有，正好钉「去重」。 */
await sh(`rm -rf ${R} ${R2} ${GONE} ${HOME} && mkdir -p ${HOME} ${R} ${R2}
cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first
cd ${R2} && git init -q -b main && git config user.email t@t && git config user.name T && echo b > b.txt && git add -A && git commit -qm first
mkdir -p ${HOME}/.dsh`, '/tmp')
await sh(`printf '%s' ${q(JSON.stringify({ repos: { '/ws': [R, GONE] } }))} > ${HOME}/.dsh/dsh-git-idea.json`, '/tmp')

console.log('')
console.log('=== bridge 版安静不启用 ===')
{
  const a = makeBody({})
  await wait(40)
  check('没有 liveHub：不排任何定时器、不起任何进程', a.timers.length === 0 && a.spawns.length === 0)
  check('没有 liveHub：RPC 照常注册（面板其余功能不受影响）', typeof a.H('git/panel') === 'function' && typeof a.H('git/watch') === 'function')
}

console.log('')
console.log('=== 真包形状：上任立基线，首轮不推 ===')
const pushes = []
const liveHub = { sockets: new Set([{ fake: true }]), send: (t) => pushes.push(JSON.parse(t)) }
const agentState = { sa: 'running', sb: 'idle' }
const sessions = { list: () => [
  { id: 'sa', header: { cwd: R } },
  { id: 'sb', header: { cwd: R2 } },
] }
const agents = { get: (id) => ({ status: agentState[id] }) }
const a = makeBody({ liveHub, sessions, agents })
check('排了两根 interval：10s 签名轮询 + 1.5s 会话快照',
  a.timers.filter((t) => t.kind === 'interval').length === 2
  && intervalOf(a, 10000) !== undefined && intervalOf(a, 1500) !== undefined)
await until(() => sigSpawns(a, R) >= 1 && sigSpawns(a, R2) >= 1, '首轮签名')
await settle()
check('配置登记 ∪ 会话工作区都看了：GONE 也被试过（spawn 失败按空签名记基线）',
  a.spawns.some((c) => c.indexOf('-C ' + q(GONE)) >= 0))
check('同一仓库去重：R 虽在配置和会话两边都出现，一轮只起一个签名进程', sigSpawns(a, R) === 1)
check('首轮只记基线：一条推送都没有', pushes.length === 0)
check('首轮只记基线：running 的 sa、idle 的 sb 都不推完成',
  livePushes(pushes, 'session-complete').length === 0)

console.log('')
console.log('=== 签名变化：失效宿主缓存 + 推 repo-changed ===')
{
  const markRead = a.spawns.length
  await a.H('git/panel')({ repo: R })
  const afterFirst = a.spawns.length
  await a.H('git/panel')({ repo: R })
  check('对照组：读缓存生效，第二次 git/panel 没再起进程', a.spawns.length === afterFirst && afterFirst > markRead)

  await sh(`cd ${R} && git commit -q --allow-empty -m live-1`, '/tmp')
  intervalOf(a, 10000).cb()
  await until(() => livePushes(pushes, 'repo-changed').some((p) => p.repo === R), 'repo-changed')
  check('签名变化 → 推送 {kind:"repo-changed", repo:R}',
    livePushes(pushes, 'repo-changed').length === 1 && livePushes(pushes, 'repo-changed')[0].repo === R)
  const mark = a.spawns.length
  await a.H('git/panel')({ repo: R })
  check('推送之前宿主缓存已失效：同一读重新起进程（拿得到新答案）', a.spawns.length > mark)
  check('GONE 从没被推过（目录消失只记基线）', livePushes(pushes, 'repo-changed').every((p) => p.repo !== GONE))
}

console.log('')
console.log('=== 2 秒最小推送间隔：压住的变化保留基线，下一轮补推 ===')
{
  const mark = livePushes(pushes, 'repo-changed').filter((p) => p.repo === R).length
  /* 先让 live-1 那次推送的 2 秒间隔过去，live-2 才推得出去 —— 这一段钉的是阀本身。 */
  await wait(2100)
  await sh(`cd ${R} && git commit -q --allow-empty -m live-2`, '/tmp')
  intervalOf(a, 10000).cb()
  await until(() => livePushes(pushes, 'repo-changed').filter((p) => p.repo === R).length === mark + 1, 'live-2 推送')
  await settle()
  await sh(`cd ${R} && git commit -q --allow-empty -m live-3`, '/tmp')
  intervalOf(a, 10000).cb()
  await until(() => sigSpawns(a, R) >= 3, 'live-3 的签名轮询')  // 这轮读到了新签名但被间隔阀压住
  await settle(120)
  check('压着 2s 间隔的那次变化没有立刻推',
    livePushes(pushes, 'repo-changed').filter((p) => p.repo === R).length === mark + 1)
  await wait(2100)
  intervalOf(a, 10000).cb()
  await until(() => livePushes(pushes, 'repo-changed').filter((p) => p.repo === R).length === mark + 2, 'live-3 补推')
  check('间隔过后下一轮把压住的变化补推出来（旧基线没被覆盖）',
    livePushes(pushes, 'repo-changed').filter((p) => p.repo === R).length === mark + 2)
}

console.log('')
console.log('=== 会话完成：true→false 边沿 + 2s 防抖 ===')
{
  check('此前没有任何 session-complete（首轮基线 + sb 一直 idle）',
    livePushes(pushes, 'session-complete').length === 0)
  agentState.sa = 'idle'
  intervalOf(a, 1500).cb()
  check('true→false 边沿：挂起一个 2 秒防抖，此刻还没推',
    liveTimeouts(a).length === 1 && livePushes(pushes, 'session-complete').length === 0)
  agentState.sa = 'running'
  intervalOf(a, 1500).cb()
  check('防抖窗口里又变回 running：挂起的那轮被整轮取消（goal 续轮间隙不推）',
    liveTimeouts(a).length === 0 && livePushes(pushes, 'session-complete').length === 0)
  agentState.sa = 'idle'
  intervalOf(a, 1500).cb()
  check('再次 idle：重新挂起 2 秒防抖', liveTimeouts(a).length === 1)
  fireTimeout(liveTimeouts(a)[0])
  check('防抖到点 → 推送 {kind:"session-complete", sessionId:"sa"}',
    livePushes(pushes, 'session-complete').length === 1 && livePushes(pushes, 'session-complete')[0].sessionId === 'sa')
  intervalOf(a, 1500).cb()
  check('一直 idle 的 sb：从基线到结尾一条完成都不推',
    livePushes(pushes, 'session-complete').every((p) => p.sessionId !== 'sb'))
  check('同一个 false 上挂着防抖时不重挂（不会一直顺延）', liveTimeouts(a).length === 0)
}

console.log('')
console.log('=== 没接 sessions/agents 服务：会话那半安静跳过 ===')
{
  const pushesB = []
  const b = makeBody({ liveHub: { sockets: new Set([{}]), send: (t) => pushesB.push(JSON.parse(t)) } })
  const tick = intervalOf(b, 1500)
  tick.cb()
  await wait(40)
  check('不崩、不推，两根定时器照排', pushesB.length === 0 && intervalOf(b, 10000) !== undefined)
}

console.log('')
console.log('=== 没有浏览器连着：签名轮询不起进程 ===')
{
  const c = makeBody({ liveHub: { sockets: new Set(), send: () => {} }, sessions, agents })
  await wait(60)
  check('sockets 空：上任那一轮一个进程都没起，定时器照排',
    c.spawns.length === 0 && c.timers.filter((t) => t.kind === 'interval').length === 2)
}

console.log('')
console.log('=== 卸载：定时器与挂着的防抖一起停 ===')
{
  const pushesD = []
  const stateD = { sa: 'running' }
  const d = makeBody({
    liveHub: { sockets: new Set([{}]), send: (t) => pushesD.push(JSON.parse(t)) },
    sessions: { list: () => [{ id: 'sa', header: { cwd: R } }] },
    agents: { get: (id) => ({ status: stateD[id] }) },
  })
  await until(() => sigSpawns(d, R) >= 1, '基线')
  await settle()
  stateD.sa = 'idle'
  intervalOf(d, 1500).cb()
  check('卸载前：一条完成防抖挂着', liveTimeouts(d).length === 1)
  for (const dispose of d.disposers) dispose()
  check('卸载：所有 effect（含 live watch）都收干净，定时器全部停掉',
    d.timers.length > 0 && d.timers.every((t) => t.dead === true))
  stateD.sa = 'running'
  intervalOf(d, 1500).cb()
  check('卸载后再开火：不起进程、不推送', pushesD.length === 0)
}

if (failed > 0) {
  console.error('gp54-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
