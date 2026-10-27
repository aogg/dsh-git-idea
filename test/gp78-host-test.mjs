/* ═══ gp78：宿主读耗时观测日志（80-rpc.js 的 onRpc 包装层 + rpclog*）═══
 *
 * 「慢」的定位以前只能靠猜：这条给每个 RPC 记一行账（时刻 / 方法名 / 仓库 /
 * paths 条数 / 耗时 ms / 结局），落 $DSH_HOME/logs/dsh-git-idea-host.log。套件把
 * 合同钉在真 shell 上：
 *
 *   1. 每次 RPC 都有账：flush（ok）、stage 空路径（答复层 ok:false → 'no'）、
 *      stage 真跑失败（'no' + git 原话）、paths 条数照记；
 *   2. 防刷屏规则：git/watch 成功且 <200ms 跳过（规则原文写在源码注释里）；
 *   3. transport 层的拒绝记 'err'，且照旧抛给调用方（观测不改行为）；
 *   4. 轮转：5MB 一转、.1 覆盖（client-log 同一思路）；
 *   5. 追加异步且失败安静：日志目录写不进时只 console.error，读照常答复。
 *
 * 跑法：node test/gp78-host-test.mjs（GP_SRC 指向要测的 host 拼接产物）。 */

import fs from 'node:fs'
import { spawn } from 'node:child_process'

const HOME = '/tmp/gp78-home'
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })
const DSH = HOME + '/.dsh'
process.env.HOME = HOME
process.env.DSH_HOME = DSH
const LOG_FILE = DSH + '/logs/dsh-git-idea-host.log'
/* 2s 冲刷定时器 + 进程调度余量：每段断言前等这一个数。 */
const FLUSH_WAIT = 2700
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

function realShell(spec) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: Object.assign({}, process.env) })
    let o = '', e = ''
    c.stdout.on('data', (b) => { o += b })
    c.stderr.on('data', (b) => { e += b })
    c.on('error', (er) => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', (x) => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}
/* 对着 git/watch 的探测命令一声 reject 的 shell：transport 层失败只有它能造出来
 * （invoke 的 promise 链上，shell.run reject 会一路 reject 到 RPC）。只认「marker
 * 路径 + git 带空格」的组合 —— 日志冲刷那条 printf 里也含 marker 路径（账行本身
 * 记了仓库），不能连它一起打掉。 */
const REJECT_MARK = '/gp78-transport-reject'
function makeContext(rejectOn) {
  const handlers = new Map()
  const shell = {
    resolve: (r) => r,
    run: function (spec) {
      const text = String(spec.command)
      if (rejectOn !== undefined && text.indexOf(rejectOn) >= 0 && /\bgit\s/.test(text)) {
        return Promise.reject(new Error('shell layer exploded on purpose'))
      }
      return realShell(spec)
    },
  }
  const ctx = { get: (n) => (n === 'shell' ? shell : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, { handle(n, f) { handlers.set(n, f); return () => {} } }, console,
    (s) => Buffer.from(s, 'binary').toString('base64'), (s) => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return (n) => handlers.get(n)
}
const H = makeContext()
const H2 = makeContext(REJECT_MARK)

const guards = []
const check = (label, value) => {
  if (value !== true) guards.push(label)
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const logText = () => { try { return fs.readFileSync(LOG_FILE, 'utf8') } catch (e) { return '' } }
const linesOf = (text, method) => text.split('\n').filter((l) => l.indexOf('\t' + method + '\t') >= 0)

console.log('== 源码形状 ==')
check('防刷屏规则写在源码里：git/watch 成功 <200ms 跳过（RPCLOG_WATCH_SKIP_MS）',
  body.indexOf('RPCLOG_WATCH_SKIP_MS = 200') >= 0 && body.indexOf('防刷屏') >= 0)
check('日志文件是 $DSH_HOME/logs/dsh-git-idea-host.log，5MB 一转 .1',
  body.indexOf('/logs/dsh-git-idea-host.log') >= 0 && body.indexOf('RPCLOG_MAX_BYTES = 5 * 1024 * 1024') >= 0)

console.log('')
console.log('== 每次调用都有账 ==')
const repoA = HOME + '/repo-a'
fs.rmSync(repoA, { recursive: true, force: true })
fs.mkdirSync(repoA, { recursive: true })
const flushReply = await H('git/flush')({ repo: repoA })
check('git/flush 照常答复（日志不许挡读）', flushReply != null && flushReply.ok === true)
const emptyStage = await H('git/stage')({ repo: repoA, paths: [] })
check('stage 空路径：答复层 ok:false（no paths given）原样交给调用方',
  emptyStage != null && emptyStage.ok === false && emptyStage.error === 'no paths given')
const realStage = await H('git/stage')({ repo: repoA, paths: ['a.txt', 'b.txt'] })
check('stage 两条路径：不是仓库 → 答复层 ok:false，stderr 带着 git 的原话',
  realStage != null && realStage.ok === false && String(realStage.stderr || '').indexOf('not a git repository') >= 0)
const watchReply = await H('git/watch')({ repo: repoA })
check('git/watch 在非仓库上照常答复（快速成功，下面断言它没进账）',
  watchReply != null && watchReply.ok === true)
await wait(FLUSH_WAIT)

const log1 = logText()
check('日志文件出现在 $DSH_HOME/logs/ 下', log1.length > 0)
check('git/flush 有账：ok 结局、仓库路径、耗时 ms 都在',
  linesOf(log1, 'git/flush').length >= 1 && linesOf(log1, 'git/flush')[0].indexOf(repoA) >= 0
  && /\t\d+ms\tok$/.test(linesOf(log1, 'git/flush')[0]))
check('stage 空路径的账是「答复层 no」：no + 原话（ok:false 既不是 ok 也不是 err）',
  linesOf(log1, 'git/stage').some((l) => l.indexOf('\tno no paths given') >= 0))
check('stage 真跑的账：paths=2 记了条数、no 后面带 git 的原话',
  linesOf(log1, 'git/stage').some((l) => l.indexOf('paths=2') >= 0 && l.indexOf('not a git repository') >= 0))
check('防刷屏：git/watch 的快速成功一次都没进账', linesOf(log1, 'git/watch').length === 0)
check('每行都是「ISO 时刻 + tab 分段」的表格式账',
  log1.trim().length > 0 && log1.trim().split('\n').every((l) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\t/.test(l)))

console.log('')
console.log('== 轮转：5MB 一转、.1 覆盖 ==')
fs.mkdirSync(DSH + '/logs', { recursive: true })
fs.writeFileSync(LOG_FILE, ('x'.repeat(1024) + '\n').repeat(5 * 1024 + 64))
await H('git/flush')({ repo: repoA })
await wait(FLUSH_WAIT)
const rotated = fs.existsSync(LOG_FILE + '.1')
const afterSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : -1
check('超 5MB 的旧账整体搬到 .1', rotated === true && fs.statSync(LOG_FILE + '.1').size > 5 * 1024 * 1024)
check('主文件从这一批重新开始（体积回到 KB 量级）', afterSize > 0 && afterSize < 1024 * 1024)

console.log('')
console.log('== transport 层的拒绝：记 err、原样抛出 ==')
let caught = null
try { await H2('git/watch')({ repo: HOME + REJECT_MARK }) } catch (e) { caught = e }
check('shell 层 reject → RPC promise 照旧 reject（观测不改行为）',
  caught != null && String(caught.message).indexOf('exploded on purpose') >= 0)
await wait(FLUSH_WAIT)
const errLines = linesOf(logText(), 'git/watch').filter((l) => l.indexOf(REJECT_MARK) >= 0)
check('这次拒绝进了账：err + 原话，仓库一格是那个 marker 路径',
  errLines.length === 1 && errLines[0].indexOf('err ') >= 0 && errLines[0].indexOf('exploded on purpose') >= 0)

console.log('')
console.log('== 失败安静：日志写不进，读照常 ==')
const badHome = HOME + '/bad-home'
fs.rmSync(badHome, { recursive: true, force: true })
fs.mkdirSync(badHome, { recursive: true })
/* 让 $DSH_HOME/logs 本身是一个文件：mkdir -p 与追加都写不进。 */
fs.writeFileSync(badHome + '/logs', 'not a directory')
const savedDsh = process.env.DSH_HOME
process.env.DSH_HOME = badHome
let badReplied = null
try { badReplied = await makeContext()('git/flush')({ repo: repoA }) } catch (e) { badReplied = { crashed: String(e) } }
check('写不进日志的那次读：答复还是 ok:true（追加失败不影响读本身）',
  badReplied != null && badReplied.ok === true && badReplied.crashed === undefined)
process.env.DSH_HOME = savedDsh

console.log('')
if (guards.length > 0) {
  console.log('✗ ' + guards.length + ' 条不符合预期')
  process.exit(1)
}
console.log('（gp78 全部通过）')
