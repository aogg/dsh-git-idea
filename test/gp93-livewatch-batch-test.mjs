import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── gp93：常驻监听的签名轮询合并成「整轮一次 spawn」的宿主半回归 ──
 *
 * 背景（gp54 之后的新事实）：79-live-watch.js 原来每个仓库一次 invoke，一轮最多
 * 24 个仓库就是 24 个进程；DSH 沙箱每次 invoke 起一个带 --unshare-pid 的 bwrap，
 * 容器里没有 init，这些 bwrap 退出后没人回收，成了 defunct（真机实测约 22 个/分钟、
 * 累积 1419 个还在涨）。插件侧能做的只有压 spawn 数：整轮拼成一条脚本、一次 invoke
 * （62-panel.js 的 liveWatchBatchCommand）+ 按 B/E 下标配对的解析器
 * （parseLiveWatchBatch）。这份套件钉四件事：
 *
 *   1. 一轮 24 个仓库只起 1 个进程（合并前是 24 个）—— 用 gp54 同款「真 shell +
 *      记录 spec.command」的计数法，批次命令的答复用罐头（这一节只看「几次 invoke、
 *      命令长什么样」）；
 *   2. 批次命令的形状：st() 只定义一次、每仓 B/E 下标齐全、路径全过 shq、没有一处
 *      依赖 cwd（每条 git 调用都带 -C 绝对路径）、24 仓长度 ≤ 64KB；
 *   3. 解析器：B/E 按**下标**配对（乱序、下标错位都能对上）、缺 B 或 E 的仓库记空
 *      签名且不牵连别人、F: 的多行正文原样保留；并且批次里每个仓库块的正文与单仓
 *      读（git/watch）的命令行**逐字节相同**，实跑出来的签名也逐字节相同 ——
 *      换读法那一轮不该白推一次；
 *   4. 失败语义：整轮非 0 退出 → 这一轮一个仓库都不推送、已有基线一个字节不动
 *      （下一轮读到与基线相同的签名不推，正是「基线没被清成空」的证据）；
 *      同轮互斥（liveSigBusy）与「没有浏览器连着整轮跳过」原样保留。
 *
 * 解析器是纯函数（不碰 ctx / shell），按 gp53 / gp90 的先例从产物里切片求值 ——
 * 收在 62-panel.js 一片里，函数体没有顶格的花括号，'\n}\n' 就是它的收尾锚点。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp93-home'
const GLOBAL = HOME + '/.gitconfig'
const BASE = '/tmp/gp93'
const R1 = BASE + '/repo-one'
const R2 = BASE + '/repo-two'
const GONE = BASE + '/gone-never-existed'
/* 24 个仓库一轮的清单：两个真仓库 + 22 个不存在的路径。其中一个带空格、一个带单
 * 引号，用来盯 shq() 的转义。 */
const ODD = BASE + '/we ird'
const QUOTE = BASE + "/quo'te"
const ROUND = [R1, R2, ODD, QUOTE]
for (let i = 4; i < 24; i += 1) ROUND.push(BASE + '/gone-' + String(i).padStart(2, '0'))
const q = (p) => "'" + String(p).replace(/'/g, "'\\''") + "'"

/* ── 解析器切片求值（纯函数，见文件头）── */
const parseStart = body.indexOf('function parseLiveWatchBatch')
const parseEnd = body.indexOf('\n}\n', parseStart) + 2
const parseSrc = parseStart >= 0 && parseEnd > parseStart ? body.slice(parseStart, parseEnd) : ''
const parseBatch = new Function(parseSrc + '\nreturn parseLiveWatchBatch')()

/* ── 宿主实例（gp54 的骨架）：shell 记录每条 spec，其余服务是桩 ──
 * opts.canned 只截「批次命令」（签名轮询那条），其余命令照走真 shell：配置读写、
 * git/watch 这类还得是真的才作数。 */
function makeBody(opts) {
  const shellEnv = Object.assign({}, process.env, {
    DSH_HOME: HOME + '/.dsh', HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL,
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  })
  const spawns = []
  function runShell(spec) {
    const command = String(spec.command)
    const batch = command.indexOf("printf 'B:0") >= 0
    const row = { command: command, batch: batch, workdir: spec.workdir }
    spawns.push(row)
    if (batch === true && opts.canned !== undefined) {
      const canned = opts.canned
      canned.calls += 1
      if (canned.gate !== null) {
        return new Promise((res) => {
          canned.gate.push(() => res(canned.reply()))
        })
      }
      return Promise.resolve(canned.reply())
    }
    return new Promise((res) => {
      const c = spawn('sh', ['-c', command], { cwd: spec.workdir, env: shellEnv })
      let o = '', e = ''
      c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
      c.on('error', er => {
        row.exitCode = null
        res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } })
      })
      c.on('close', x => {
        row.stdout = o
        row.exitCode = x
        res({ exitCode: x, stdout: { text: o }, stderr: { text: e } })
      })
    })
  }
  const timers = []
  const timerService = {
    interval(cb, delay) { const t = { kind: 'interval', cb, delay, dead: false }; timers.push(t); return () => { t.dead = true } },
    timeout(cb, delay) { const t = { kind: 'timeout', cb, delay, dead: false }; timers.push(t); return () => { t.dead = true } },
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
  return { H: n => handlers.get(n), spawns, timers, disposers }
}

function sh(cmd, cwd) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', cmd], {
      cwd: cwd, env: Object.assign({}, process.env, {
        DSH_HOME: HOME + '/.dsh', HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL,
        GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      }),
    })
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
  throw new Error('gp93: 等不到 ' + (label || '条件'))
}
const intervalOf = (a, delay) => a.timers.find((t) => t.kind === 'interval' && t.delay === delay)
const batchOf = (a) => a.spawns.filter((s) => s.batch === true)
const countOf = (text, needle) => text.split(needle).length - 1
const repoChanged = (pushes, repo) => pushes.filter((p) => p.kind === 'repo-changed' && p.repo === repo).length
const writeConfig = (repos) => sh(`printf '%s' ${q(JSON.stringify({ repos: { '/ws': repos } }))} > ${HOME}/.dsh/dsh-git-idea.json`, '/tmp')

/* fixture：两个真仓库 + 配置目录（gp54 同款 env 压法，摸不到跑测试这个人的真配置） */
await sh(`rm -rf ${BASE} ${HOME} && mkdir -p ${HOME} ${BASE} ${R1} ${R2}
cd ${R1} && git init -q -b main && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first
cd ${R2} && git init -q -b main && git config user.email t@t && git config user.name T && echo b > b.txt && git add -A && git commit -qm first
mkdir -p ${HOME}/.dsh`, '/tmp')

const sessions = { list: () => [] }
const agents = { get: () => null }

console.log('')
console.log('=== 一轮 24 个仓库：整轮一次 spawn（合并前是 24 次） ===')
await writeConfig(ROUND)
const pushes = []
const liveHub = { sockets: new Set([{ fake: true }]), send: (t) => pushes.push(JSON.parse(t)) }
/* 罐头：每个下标一段合法签名，H 行带 tag，用来认「谁变了」。 */
const tagSig = (tag, index) => 'F:refs/heads/main:' + tag + '-' + index + '\nH:' + tag + '-' + index + '\nI:1:2\nR:ref: refs/heads/main 3:4\nP:\n'
const cannedRound = (tag, count) => {
  let out = ''
  for (let i = 0; i < count; i += 1) out += 'B:' + i + '\n' + tagSig(tag, i) + 'E:' + i + '\n'
  return out
}
const canned = { calls: 0, gate: null, reply: () => ({ exitCode: 0, stdout: { text: cannedRound('AAA', ROUND.length) }, stderr: { text: '' } }) }
const a = makeBody({ liveHub, sessions, agents, canned: canned })
await until(() => canned.calls >= 1, '首轮批次')
await wait(200)
const firstBatch = batchOf(a)[0]
/* 实例里除了签名轮询还有读插件配置的两个探针（70-config.js 的 configPath /
   readConfigFile 各一次，模块级缓存，一份实例只付一次），所以「这一轮起了几个
   进程」要按批次命令数算，不能拿 spawns.length 当数。 */
const configSpawns = a.spawns.filter((s) => s.batch !== true)
check('24 个仓库一轮只起 1 个进程（原来 24 个仓库 = 24 次 spawn，现在 1 次；实测批次 spawn '
  + String(batchOf(a).length) + ' 次，同一实例的进程总数 ' + String(a.spawns.length)
  + ' = 1 批次 + ' + String(configSpawns.length) + ' 个读配置探针）',
  batchOf(a).length === 1 && configSpawns.length === 2 && firstBatch !== undefined)
check('一次 invoke 里带着全部 24 个仓库的 B/E 下标（B:0 … B:23，各 24 条）',
  firstBatch !== undefined
  && countOf(firstBatch.command, "printf 'B:") === 24 && countOf(firstBatch.command, "printf 'E:") === 24
  && firstBatch.command.indexOf("printf 'B:23") >= 0)
check('st() 函数定义整条批量脚本只出现一次（每仓正文共用那一份）',
  countOf(firstBatch.command, 'st() {') === 1)
check('每个仓库路径都过 shq（带空格、带单引号的路径原样转义）',
  firstBatch.command.indexOf('-C ' + q(R1)) >= 0 && firstBatch.command.indexOf('-C ' + q(ODD)) >= 0
  && firstBatch.command.indexOf('-C ' + q(QUOTE)) >= 0)
/* 每条 git 调用都紧跟着 -C：\bgit\b 那种数法会把 `.git ]`、`--absolute-git-dir`
 * 里的片段也算进去，所以只认「git 前面不是 . - 字母数字」的那种调用。 */
const bareGit = firstBatch.command.match(/(^|[^-.\w])git (?!-C )/g)
check('脚本没有一处依赖 cwd：' + String(countOf(firstBatch.command, 'git -C ')) + ' 条 git 调用全带 -C'
  + '（24 仓 × 3 条 = 72），没有一条裸 git', bareGit === null && countOf(firstBatch.command, 'git -C ') === 72)
check('24 仓批量命令长度 ≤ 64KB（实测 ' + String(Buffer.byteLength(firstBatch.command)) + ' 字节）',
  Buffer.byteLength(firstBatch.command) <= 64 * 1024)
check('整轮不传 workdir（没有哪个仓库被当成整轮的工作目录）', firstBatch.workdir === undefined)
check('首轮只记基线：一条推送都没有', pushes.length === 0)

{
  /* 第二轮：24 段里只有下标 5 的签名变了 —— 正好钉住「按下标配对、只推变的那一个」。 */
  const mark = batchOf(a).length
  const onlyAt = (index, tag, count) => {
    let out = ''
    for (let i = 0; i < count; i += 1) out += 'B:' + i + '\n' + tagSig(i === index ? tag : 'AAA', i) + 'E:' + i + '\n'
    return out
  }
  canned.reply = () => ({ exitCode: 0, stdout: { text: onlyAt(5, 'BBB', ROUND.length) }, stderr: { text: '' } })
  intervalOf(a, 10000).cb()
  await until(() => repoChanged(pushes, ROUND[5]) === 1, '下标 5 的 repo-changed')
  await wait(120)
  check('第二轮仍是 1 次 spawn（不是每仓一次，实测新增 ' + String(batchOf(a).length - mark) + ' 次）',
    batchOf(a).length === mark + 1)
  check('只有签名变了的那一个仓库被推送（下标 5 = ' + ROUND[5] + '）',
    repoChanged(pushes, ROUND[5]) === 1 && pushes.length === 1)
}

console.log('')
console.log('=== 解析器：B/E 按下标配对，F/H/I/R/P 原样切给每仓 ===')
{
  const sig = (tag) => 'F:refs/heads/' + tag + ':sha-' + tag + '\nH:' + tag + '-head\nI:1:2\nR:ref: refs/heads/' + tag + ' 3:4\nP:\n'
  const ordered = 'B:0\n' + sig('a') + 'E:0\n' + 'B:1\n' + sig('b') + 'E:1\n' + 'B:2\n' + sig('c') + 'E:2\n'
  check('顺序输出：三块的签名各自归位',
    JSON.stringify(parseBatch(ordered, 3)) === JSON.stringify([sig('a'), sig('b'), sig('c')]))
  const shuffled = 'B:2\n' + sig('c') + 'E:2\n' + 'B:0\n' + sig('a') + 'E:0\n' + 'B:1\n' + sig('b') + 'E:1\n'
  check('乱序输出（2 → 0 → 1）：按下标对上，而不是按块出现的先后',
    JSON.stringify(parseBatch(shuffled, 3)) === JSON.stringify([sig('a'), sig('b'), sig('c')]))
  const missingE = 'B:0\n' + sig('a') + 'E:0\n' + 'B:1\nH:cut-in-half\n' + 'B:2\n' + sig('c') + 'E:2\n'
  const broken = parseBatch(missingE, 3)
  check('缺 E 的那一块记空签名，其它仓不受影响', broken[1] === '' && broken[0] === sig('a') && broken[2] === sig('c'))
  const missingB = 'E:0\n' + 'B:1\n' + sig('b') + 'E:1\n'
  const orphan = parseBatch(missingB, 2)
  check('只有 E 没有 B 的仓库记空签名', orphan[0] === '' && orphan[1] === sig('b'))
  check('块内的 F: 多行正文（for-each-ref 多个 ref）原样保留',
    parseBatch('B:0\nF:a:1\nb:2\nH:h\nE:0\n', 1)[0] === 'F:a:1\nb:2\nH:h\n')
  check('空块（B 紧跟 E）是空签名，不是「一行空串」', parseBatch('B:0\nE:0\n', 1)[0] === '')
  check('下标越界 / 非数字的行当没收过，不落到任何仓库上',
    JSON.stringify(parseBatch('B:9\nX:1\nE:9\nB:x\nY:2\nE:x\nB:0\nH:ok\nE:0\n', 2)) === JSON.stringify(['H:ok\n', '']))
  check('抽到的是产物里的真代码（B/E 配对与错位判定那两句都在函数体里）',
    parseSrc.indexOf("head !== 'B:' && head !== 'E:'") >= 0 && parseSrc.indexOf('open === index') >= 0)
}

console.log('')
console.log('=== 批次里每仓的正文与单仓读逐字节相同，实跑签名也相同 ===')
{
  await writeConfig([R1, GONE])
  const canned2 = { calls: 0, gate: null, reply: () => ({ exitCode: 0, stdout: { text: 'B:0\n' + tagSig('AAA', 0) + 'E:0\nB:1\nE:1\n' }, stderr: { text: '' } }) }
  const e = makeBody({ liveHub: { sockets: new Set([{}]), send: () => {} }, sessions, agents, canned: canned2 })
  await until(() => canned2.calls >= 1, '两仓批次')
  await wait(120)
  const batchCommand = batchOf(e)[0].command
  /* 单仓读：git/watch 起的是同一个 watchCommand（真 shell，真仓库）。 */
  const single = await e.H('git/watch')({ repo: R1 })
  const singleCommand = e.spawns.filter((s) => s.batch !== true && s.command.indexOf('for-each-ref') >= 0
    && s.command.indexOf(q(R1)) >= 0).pop().command
  const batchLines = batchCommand.split('\n')
  const from = batchLines.indexOf("printf 'B:0\\n'")
  const to = batchLines.indexOf("printf 'E:0\\n'")
  /* 块 0 = `printf 'B:0'` + `if [ -d … ]; then` + 正文 + `fi` + `printf 'E:0'`。 */
  const blockBody = batchLines.slice(from + 2, to - 1)
  const singleBody = singleCommand.split('\n').slice(1)
  check('批次里 R1 那一块的正文与 git/watch 的命令行逐字节相同（同一份 watchBodyLines）',
    from >= 0 && to > from && blockBody.length === singleBody.length
    && blockBody.join('\n') === singleBody.join('\n'))
  /* 实跑这条批次命令，工作目录故意给 /：脚本不依赖 cwd，签名必须与 git/watch 一样。 */
  const ran = await sh(batchCommand, '/')
  const parsed = parseBatch(ran.out, 2)
  check('实跑（cwd=/）退出码 0（整轮成功才轮到比较基线）', ran.code === 0)
  check('实跑：R1 的切片签名与单仓读逐字节相同（' + String(parsed[0].length) + ' 字节）',
    parsed[0].length > 0 && parsed[0] === single.sig)
  check('目录已经不存在的仓库发空块 → 空签名（单仓时代那是 spawn 失败的空签名，同一口径）',
    parsed[1] === '')
}

console.log('')
console.log('=== 失败语义：整轮失败不推送、基线不动 ===')
{
  await writeConfig([R1])
  const pushC = []
  const hub = { sockets: new Set([{}]), send: (t) => pushC.push(JSON.parse(t)) }
  const lines = (tag) => 'B:0\nF:refs/heads/main:' + tag + '\nH:' + tag + '\nI:1:2\nR:ref: refs/heads/main 3:4\nP:\nE:0\n'
  const canned3 = { calls: 0, gate: null, reply: () => ({ exitCode: 0, stdout: { text: lines('AAA') }, stderr: { text: '' } }) }
  const c = makeBody({ liveHub: hub, sessions, agents, canned: canned3 })
  await until(() => canned3.calls >= 1, '首轮罐头')
  await wait(120)
  check('首轮罐头：只记基线，不推送（推送 ' + String(pushC.length) + ' 条）', pushC.length === 0)

  canned3.reply = () => ({ exitCode: 0, stdout: { text: lines('BBB') }, stderr: { text: '' } })
  intervalOf(c, 10000).cb()
  await until(() => repoChanged(pushC, R1) === 1, 'BBB 的推送')
  await wait(120)
  check('签名变化 → 推 {kind:"repo-changed", repo:R1}', repoChanged(pushC, R1) === 1)

  await wait(2100)
  canned3.reply = () => ({ exitCode: 0, stdout: { text: lines('CCC') }, stderr: { text: '' } })
  intervalOf(c, 10000).cb()
  await until(() => repoChanged(pushC, R1) === 2, 'CCC 的推送')
  await wait(120)
  check('再变一次 → 再推一次（基线走到 CCC）', repoChanged(pushC, R1) === 2)

  await wait(2100)
  canned3.reply = () => ({ exitCode: 1, stdout: { text: lines('DDD') }, stderr: { text: 'boom' } })
  intervalOf(c, 10000).cb()
  await until(() => canned3.calls >= 4, '失败那一轮')
  await wait(200)
  check('整轮非 0 退出：这一轮一个仓库都不推送', repoChanged(pushC, R1) === 2)

  canned3.reply = () => ({ exitCode: 0, stdout: { text: lines('CCC') }, stderr: { text: '' } })
  intervalOf(c, 10000).cb()
  await until(() => canned3.calls >= 5, '恢复那一轮')
  await wait(200)
  check('下一轮读到与基线相同的签名 → 不推送（失败那轮没把基线清成空签名）',
    repoChanged(pushC, R1) === 2)

  await wait(2100)
  canned3.reply = () => ({ exitCode: 0, stdout: { text: lines('DDD') }, stderr: { text: '' } })
  intervalOf(c, 10000).cb()
  await until(() => repoChanged(pushC, R1) === 3, 'DDD 的推送')
  check('基线还在：后来的真变化照常推得出去', repoChanged(pushC, R1) === 3)
}

console.log('')
console.log('=== 同轮互斥与「没浏览器连着」，原样保留 ===')
{
  const gate = []
  const canned4 = { calls: 0, gate: gate, reply: () => ({ exitCode: 0, stdout: { text: 'B:0\nH:x\nE:0\n' }, stderr: { text: '' } }) }
  const g = makeBody({ liveHub: { sockets: new Set([{}]), send: () => {} }, sessions, agents, canned: canned4 })
  /* 先等这一轮真的走到批次命令（配置读是两个真 shell 探针，慢盘上要一会儿），
   * 它此刻挂在 gate 上 = liveSigBusy 还没落回。 */
  await until(() => canned4.calls >= 1, 'gate 批次')
  intervalOf(g, 10000).cb()
  intervalOf(g, 10000).cb()
  await wait(120)
  check('上一轮还在飞（liveSigBusy）时再开火：整轮被丢掉，只有 1 次 invoke（实测 '
    + String(canned4.calls) + ' 次）', canned4.calls === 1)
  while (gate.length > 0) gate.shift()()
  await wait(120)
  const idle = makeBody({ liveHub: { sockets: new Set(), send: () => {} }, sessions, agents })
  await wait(120)
  check('没有浏览器连着（sockets 空）：一轮都不读（spawn ' + String(idle.spawns.length) + ' 次）',
    idle.spawns.length === 0)
}

if (failed > 0) {
  console.error('gp93: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
