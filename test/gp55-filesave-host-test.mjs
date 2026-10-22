import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 文件保存联动（79b-file-save.js）：better-sidebar/file-saved → invalidateRepo + 1.5s 尾沿防抖广播 ──
 *
 * 真起仓库（gp54 的骨架）+ 桩 ctx（shell 真跑、timer/会话服务与 cordis 事件源是测试桩），
 * 对照 docs/联动插件.md 的五种情形矩阵与八条必测点：
 *   1. better-sidebar 未安装＝没人 emit：订阅挂着、listener 永不触发，apply 后零推送零报错，
 *      其余 RPC 照常注册；
 *   2. 保存路径命中已知仓库（配置登记或会话工作区）：invalidateRepo 立刻被调（防抖未到点，
 *      读缓存已经空了），防抖到点后 liveSend 恰好一次 {kind:'repo-changed', repo}，repo 是
 *      清单原拼写（配置里带尾斜杠就原样广播）；
 *   3. 尾沿防抖：1.5 秒内同一仓库连续保存只挂一个定时器、旧的全部先拆（挂着先拆再挂），
 *      到点只广播一次；不同仓库各挂各的互不吞并；
 *   4. 相对路径与 cwd 拼接（含 cwd 带尾反斜杠）；绝对路径照用；无 cwd 的相对路径安静放弃；
 *      反斜杠归一成正斜杠后再匹配；
 *   5. 带分隔符边界：/gp55-repo 与 /gp55-repo2 前缀重叠互不误吞，最长前缀胜出；
 *      仓库路径本身（target===candidate）算命中；不在任何已知仓库 → 安静返回，
 *      不失效缓存、不挂防抖、不广播；
 *   6. payload 形状不对（null / 数字 / 字符串 / 数组 / 空 object / path 空或非字符串）
 *      → 安静返回；listener 内部抛错（定时器服务炸了）只记日志不外传，读缓存失效照做；
 *   7. bridge 形状（无 liveHub）：watch 不启用、事件链照跑，flush 一步安静跳过不抛；
 *      liveHub.sockets 为空 → 不 send 但 invalidateRepo 照做；
 *   8. effect 清理：退订 + 挂着的防抖定时器全部拆掉，dispose 后再 emit 不广播。
 *
 * 定时器全部走 ctx.get('timer') 桩（79-live-watch.js 的 liveTimers 优先取服务），测试手动
 * 开火，不真等 1.5 秒。GP_FRESH 时 GP_SRC 指向临时拼接的 host.js（见 run-all.mjs）。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp55-home'
const GLOBAL = HOME + '/.gitconfig'
const R = '/tmp/gp55-repo'
const R2 = '/tmp/gp55-repo2'
const R3 = '/tmp/gp55-repo3'
const R2_SLASH = R2 + '/' /* 配置登记的原样拼写：带尾斜杠，广播必须原样带回 */
const ELSEWHERE = '/tmp/gp55-elsewhere'
const OUTSIDE = '/tmp/gp55-outside'
const EVENT = 'better-sidebar/file-saved'
const SAVE_MS = 1500
/* 引用形式：命令行路径都经 shq（单引号）进命令行，带引号才能把 R 与前缀相同的 R2/R3 区分开。 */
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
  const timers55 = []
  const timerService = opts.timer !== undefined ? opts.timer : {
    interval(cb, delay) { const t = { kind: 'interval', cb, delay, dead: false }; timers55.push(t); return () => { t.dead = true } },
    timeout(cb, delay) { const t = { kind: 'timeout', cb, delay, dead: false }; timers55.push(t); return () => { t.dead = true } },
  }
  const errors55 = []
  const consoleStub = {
    log: function () {}, warn: function () {}, info: function () {},
    error: function () { errors55.push(Array.prototype.slice.call(arguments).map(String).join(' ')) },
  }
  const services = { shell: { resolve: r => r, run: runShell }, timer: timerService }
  if (opts.sessions !== undefined) services.sessions = opts.sessions
  if (opts.agents !== undefined) services.agents = opts.agents
  const disposers = []
  const subs = new Map()
  const ctx = {
    get: n => services[n],
    effect(cb) { const d = cb(); if (typeof d === 'function') disposers.push(d); return typeof d === 'function' ? d : () => {} },
  }
  if (opts.withOn !== false) {
    ctx.on = function (name, fn) {
      const list = subs.get(name) || []
      list.push(fn)
      subs.set(name, list)
      return function () { subs.set(name, (subs.get(name) || []).filter(f => f !== fn)) }
    }
  }
  const handlers = new Map()
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  const params = ['ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder']
  const args = [ctx, harness, consoleStub, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder]
  if (opts.liveHub !== undefined) { params.push('liveHub'); args.push(opts.liveHub) }
  new Function(...params, body)(...args).apply(ctx)
  return {
    H: n => handlers.get(n), spawns, timers: timers55, disposers, subs, errors: errors55,
    emit(name, payload) { for (const fn of Array.from(subs.get(name) || [])) fn(payload) },
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
/* 一条保存事件的处置要过 liveRepoList（首次要起进程读插件配置），给足落地时间。 */
const settle = (ms) => wait(ms || 80)
/* 防抖定时器全是 1500 的 timeout；79-live-watch 的会话 interval 也是 1500，靠 kind 区分。 */
const saveTimers = (a) => a.timers.filter((t) => t.kind === 'timeout' && t.delay === SAVE_MS)
const saveAlive = (a) => saveTimers(a).filter((t) => t.dead !== true)
const fireTimer = (t) => { t.cb(); t.dead = true }
const fireAll = (a) => { for (const t of saveAlive(a)) fireTimer(t) }

/* fixture：三个真仓库 + 配置登记 [R, R2_SLASH]；会话工作区 R3（只在会话清单里）。 */
await sh(`rm -rf ${R} ${R2} ${R3} ${HOME} && mkdir -p ${HOME} ${R} ${R2} ${R3} ${HOME}/.dsh
cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first
cd ${R2} && git init -q -b main && git config user.email t@t && git config user.name T && echo b > b.txt && git add -A && git commit -qm first
cd ${R3} && git init -q -b main && git config user.email t@t && git config user.name T && echo c > c.txt && git add -A && git commit -qm first`, '/tmp')
await sh(`printf '%s' ${q(JSON.stringify({ repos: { '/ws': [R, R2_SLASH] } }))} > ${HOME}/.dsh/dsh-git-idea.json`, '/tmp')

const SESSIONS = { list: () => [{ id: 'sc', header: { cwd: R3 } }] }
const AGENTS = { get: () => ({ status: 'running' }) }
const hub = () => { const lines = []; return { sockets: new Set([{ fake: true }]), send: (t) => lines.push(JSON.parse(t)), lines: lines } }

console.log('')
console.log('=== better-sidebar 未安装＝没人 emit：订阅挂着，零推送零报错 ===')
{
  const hubA = hub()
  const a = makeBody({ liveHub: hubA, sessions: SESSIONS, agents: AGENTS })
  await settle(150) /* 79-live-watch 的上任基线轮照跑，与本片无关，等它落地 */
  check('订阅挂上了：' + EVENT + ' 恰好一个 listener', (a.subs.get(EVENT) || []).length === 1)
  check('没有事件：不挂任何防抖定时器、不报错', saveTimers(a).length === 0 && a.errors.length === 0)
  check('没有事件：一条推送都没有', hubA.lines.length === 0)
  check('其余功能照旧：git/panel RPC 照常注册', typeof a.H('git/panel') === 'function')
}

console.log('')
console.log('=== 老版动态桥 façade 没有 ctx.on：安静不启用 ===')
{
  const b = makeBody({ withOn: false, liveHub: hub(), sessions: SESSIONS, agents: AGENTS })
  await settle(60)
  check('没有 ctx.on：什么都不订阅、apply 不炸', b.subs.size === 0 && typeof b.H('git/panel') === 'function')
}

console.log('')
console.log('=== 命中配置登记仓库：先失效读缓存，防抖到点恰好一次广播（清单原拼写） ===')
const hubC = hub()
const c = makeBody({ liveHub: hubC, sessions: SESSIONS, agents: AGENTS })
await settle(150)
{
  /* 预热：一条不属于任何仓库的事件把 readConfigFile 的进程读了、缓存了，之后的
   * spawn 计数只可能来自 git/panel 或异常路径。 */
  c.emit(EVENT, { sessionId: 's1', cwd: ELSEWHERE, path: ELSEWHERE + '/x.txt', at: 1 })
  await settle()
  check('不在任何已知仓库：安静返回，不挂防抖、不推送',
    saveTimers(c).length === 0 && hubC.lines.length === 0)

  const first = c.spawns.length
  await c.H('git/panel')({ repo: R })
  const warmed = c.spawns.length
  await c.H('git/panel')({ repo: R })
  check('对照组：读缓存生效，第二次 git/panel 没再起进程', c.spawns.length === warmed && warmed > first)

  const mark = c.spawns.length
  c.emit(EVENT, { sessionId: 's1', path: R + '/a.txt', at: 2 }) /* 绝对路径，无 cwd */
  await settle()
  check('事件处置本身不起进程（配置已缓存）：spawns 不动', c.spawns.length === mark)
  check('命中已知仓库：立刻挂起一个 1.5s 防抖，此刻还没广播',
    saveAlive(c).length === 1 && hubC.lines.length === 0)
  await c.H('git/panel')({ repo: R })
  check('防抖未到点读缓存已失效：git/panel 重新起进程（invalidateRepo 不参与防抖）',
    c.spawns.length > mark)
  fireAll(c)
  check('防抖到点：恰好一次 {kind:"repo-changed", repo} 且 repo 是配置原拼写',
    hubC.lines.length === 1 && hubC.lines[0].kind === 'repo-changed' && hubC.lines[0].repo === R)
  check('广播后防抖表清空', saveAlive(c).length === 0)
}

console.log('')
console.log('=== 命中会话工作区：相对路径与 cwd 拼接 ===')
{
  const before = hubC.lines.length
  c.emit(EVENT, { sessionId: 'sc', cwd: R3, path: 'c.txt', at: 3 })
  await settle()
  check('相对 path + cwd 拼成绝对路径，命中会话工作区：挂起防抖', saveAlive(c).length === 1)
  fireAll(c)
  check('广播 {kind:"repo-changed", repo:会话工作区}', hubC.lines.length === before + 1
    && hubC.lines[before].repo === R3)
}

console.log('')
console.log('=== 带分隔符边界：前缀重叠互不误吞，最长前缀胜出，仓库路径本身算命中 ===')
{
  c.emit(EVENT, { sessionId: 's1', path: R2 + '/sub/b.txt', at: 4 })
  await settle()
  fireAll(c)
  const last = hubC.lines[hubC.lines.length - 1]
  check('/gp55-repo 没吞掉 /gp55-repo2 的文件：最长前缀胜出，且原样带回配置里的尾斜杠拼写',
    hubC.lines.length >= 1 && last.kind === 'repo-changed' && last.repo === R2_SLASH)

  c.emit(EVENT, { sessionId: 's1', path: R2, at: 5 }) /* target === candidate */
  await settle()
  fireAll(c)
  check('保存路径就是仓库路径本身：也算命中，广播原拼写',
    hubC.lines[hubC.lines.length - 1].repo === R2_SLASH)
}

console.log('')
console.log('=== 尾沿防抖：一波保存只广播一次，定时器对齐最后一次；各仓库互不吞并 ===')
{
  const deadBefore = saveTimers(c).filter((t) => t.dead === true).length
  const before = hubC.lines.length
  c.emit(EVENT, { sessionId: 's1', path: R + '/a.txt', at: 6 })
  c.emit(EVENT, { sessionId: 's1', path: R + '/a.txt', at: 7 })
  c.emit(EVENT, { sessionId: 's1', path: R + '/a.txt', at: 8 })
  await settle()
  check('连存三下：仍只挂一个防抖定时器', saveAlive(c).length === 1)
  check('挂着先拆再挂：前两个定时器都被拆掉（对齐最后一次保存）',
    saveTimers(c).filter((t) => t.dead === true).length === deadBefore + 2)
  check('停手前一条不广播', hubC.lines.length === before)
  fireAll(c)
  check('到点只广播一次', hubC.lines.length === before + 1
    && hubC.lines[before].repo === R)

  const before2 = hubC.lines.length
  c.emit(EVENT, { sessionId: 'sc', cwd: R3, path: 'c.txt', at: 9 })
  c.emit(EVENT, { sessionId: 's1', path: R2 + '/b.txt', at: 9 })
  await settle()
  check('不同仓库各挂各的防抖：两个定时器并存', saveAlive(c).length === 2)
  fireAll(c)
  const repos = hubC.lines.slice(before2).map((p) => p.repo).sort()
  check('两个仓库各自广播一次', hubC.lines.length === before2 + 2
    && JSON.stringify(repos) === JSON.stringify([R2_SLASH, R3].sort()))
}

console.log('')
console.log('=== 路径形状：反斜杠归一、cwd 尾反斜杠、无 cwd 的相对路径安静放弃 ===')
{
  c.emit(EVENT, { sessionId: 's1', path: R + '\\sub\\a.txt', at: 10 })
  await settle()
  fireAll(c)
  check('反斜杠路径归一成正斜杠后命中仓库', hubC.lines[hubC.lines.length - 1].repo === R)

  c.emit(EVENT, { sessionId: 's1', cwd: R + '\\', path: 'a.txt', at: 11 })
  await settle()
  fireAll(c)
  check('cwd 带尾反斜杠：直接拼接不添乱，照样命中', hubC.lines[hubC.lines.length - 1].repo === R)

  const before = hubC.lines.length
  c.emit(EVENT, { sessionId: 's1', path: 'lonely.txt', at: 12 }) /* 相对路径但没有 cwd */
  await settle()
  check('无 cwd 的相对路径：拼不成绝对路径，安静放弃（不挂防抖、不广播）',
    saveTimers(c).length >= 0 && saveAlive(c).length === 0 && hubC.lines.length === before)
}

console.log('')
console.log('=== 不属于任何已知仓库：不失效缓存、不广播 ===')
{
  await c.H('git/panel')({ repo: R })
  const warm = c.spawns.length
  await c.H('git/panel')({ repo: R })
  const mark = c.spawns.length
  check('前置：读缓存是热的', mark === warm)
  c.emit(EVENT, { sessionId: 's1', cwd: OUTSIDE, path: OUTSIDE + '/f.txt', at: 13 })
  await settle()
  await c.H('git/panel')({ repo: R })
  check('命不中：R 的读缓存原封不动（没有 invalidateRepo）', c.spawns.length === mark)
  check('命不中：不挂防抖、不广播', saveAlive(c).length === 0
    && hubC.lines.every((p) => p.repo !== OUTSIDE))
}

console.log('')
console.log('=== payload 形状不对：安静返回，绝不报错 ===')
{
  const before = hubC.lines.length
  const badPayloads = [null, 42, 'str', [], {}, { path: '' }, { path: null }, { path: 7 }, { cwd: R }]
  for (const bad of badPayloads) {
    c.emit(EVENT, bad)
    await settle(20)
  }
  check('九种坏 payload：全程不挂防抖、不推送、不记错误日志',
    saveAlive(c).length === 0 && hubC.lines.length === before && c.errors.length === 0)
}

console.log('')
console.log('=== listener 内部抛错：只记日志不外传，读缓存失效照做 ===')
{
  const brokenTimer = {
    interval(cb, delay) { const t = { kind: 'interval', cb, delay, dead: false }; return () => { t.dead = true } },
    timeout() { throw new Error('timer service down') },
  }
  const hubK = { sockets: new Set(), send: () => {} }
  const k = makeBody({ timer: brokenTimer, liveHub: hubK })
  k.emit(EVENT, { sessionId: 's1', cwd: ELSEWHERE, path: ELSEWHERE + '/x.txt', at: 1 }) /* 预热配置 */
  await settle()
  const mark = k.spawns.length
  await k.H('git/panel')({ repo: R })
  const warm = k.spawns.length
  await k.H('git/panel')({ repo: R })
  const base = k.spawns.length
  let threw = false
  try {
    k.emit(EVENT, { sessionId: 's1', path: R + '/a.txt', at: 2 })
  } catch (error) { threw = true }
  await settle()
  check('listener 内部炸了（定时器服务抛错）：不向事件源外传', threw === false)
  check('错误只进了日志（catch 分支的那句话）',
    k.errors.some((line) => line.indexOf('处理文件保存事件失败') >= 0))
  await k.H('git/panel')({ repo: R })
  check('抛错前的 invalidateRepo 照做：git/panel 重新起进程', k.spawns.length > base && warm > mark)
  check('炸掉的这波没留下任何防抖定时器', saveAlive(k).length === 0)
}

console.log('')
console.log('=== bridge 形状（无 liveHub）：watch 不启用，事件链照跑，flush 安静跳过 ===')
{
  const b = makeBody({})
  check('没有 liveHub：79-live-watch 整个不启用（不排 interval）',
    b.timers.filter((t) => t.kind === 'interval').length === 0)
  check('file-save 订阅照挂', (b.subs.get(EVENT) || []).length === 1)
  b.emit(EVENT, { sessionId: 's1', path: R + '/a.txt', at: 1 })
  await settle()
  check('防抖照挂（订阅与读缓存失效不受 bridge 影响）', saveAlive(b).length === 1)
  let threw = false
  try { fireAll(b) } catch (error) { threw = true }
  await settle()
  check('到点的广播一步被 typeof 守卫安静跳过，不抛', threw === false && saveAlive(b).length === 0)
}

console.log('')
console.log('=== 没有浏览器连着（sockets 空）：不 send，invalidateRepo 照做 ===')
{
  const lines = []
  const m = makeBody({
    liveHub: { sockets: new Set(), send: (t) => lines.push(JSON.parse(t)) },
    sessions: SESSIONS, agents: AGENTS,
  })
  m.emit(EVENT, { sessionId: 's1', cwd: ELSEWHERE, path: ELSEWHERE + '/x.txt', at: 0 }) /* 预热配置 */
  await settle()
  const mark = m.spawns.length
  await m.H('git/panel')({ repo: R })
  const warm = m.spawns.length
  await m.H('git/panel')({ repo: R })
  const base = m.spawns.length
  m.emit(EVENT, { sessionId: 's1', path: R + '/a.txt', at: 1 })
  await settle()
  await m.H('git/panel')({ repo: R })
  check('读缓存照常失效：git/panel 重新起进程', m.spawns.length > base && warm > mark)
  fireAll(m)
  await settle(20)
  check('sockets 空：广播一步跳过，一条都不 send', lines.length === 0)
}

console.log('')
console.log('=== effect 清理：退订 + 挂起的防抖全部拆掉 ===')
{
  const hubN = hub()
  const n = makeBody({ liveHub: hubN, sessions: SESSIONS, agents: AGENTS })
  await settle(150)
  n.emit(EVENT, { sessionId: 's1', path: R + '/a.txt', at: 1 })
  n.emit(EVENT, { sessionId: 'sc', cwd: R3, path: 'c.txt', at: 1 })
  await settle()
  check('卸载前：两个仓库的防抖都挂着', saveAlive(n).length === 2)
  for (const dispose of n.disposers) dispose()
  check('卸载：所有定时器（含两根 watch interval 与两个防抖）全部停掉',
    n.timers.length > 0 && n.timers.every((t) => t.dead === true))
  check('卸载：订阅退干净', (n.subs.get(EVENT) || []).length === 0)
  n.emit(EVENT, { sessionId: 's1', path: R + '/a.txt', at: 2 })
  await settle()
  check('卸载后再 emit：事件源里没人听了，不挂防抖、不广播',
    saveAlive(n).length === 0 && hubN.lines.length === 0)
  check('全程零错误日志', n.errors.length === 0)
}

if (failed > 0) {
  console.error('gp55-filesave-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
