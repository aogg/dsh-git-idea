/* ═══ gp79：命令页扫描账本（76-cmdlog.js 的 scan/incr 两模式 + 宿主账本）═══
 *
 * 合同（全部对着**真** zstd 帧与真 shell 钉）：
 *
 *   1. 冷启动正确性：账为空时的答复与全量扫描一字不差（同一份数据两种问法互相
 *      印证：首读 = 冷 = scan 模式；full === true 的「重新读取」也是 scan 模式，
 *      两者 commands 深度相等）；
 *   2. 账热立即答复：同一工作区第二次读不发 scan、用账本回同样的行，后台只发
 *      一声 incr（argv 里带着 {文件: [mtimeMs, size]} 的账本地图）；
 *   3. 没变就没动静：incr 后账没变 → 无推送；
 *   4. 变了的只重扫变化的：文件追加了新命令 → 后台 incr → cmdlog-refresh 推送把
 *      增量并回来（含 durationMs），下一次热读也在账里；
 *   5. 新会话目录进来、会话目录消失：账本跟着长/摘，推送与热读都认账；
 *   6. 面板执行那一半照旧参与合并（cmdrecBegin 的行在热读里也有）。
 *
 * 跑法：node test/gp79-host-test.mjs（GP_SRC 指向要测的 host 拼接产物）。 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'

const HOME = '/tmp/gp79-home'
const DSH = HOME + '/.dsh'
const WS = '/tmp/gp79-ws'
const SLUG_DIR = DSH + '/sessions/--tmp-gp79-ws--'
fs.rmSync(HOME, { recursive: true, force: true })
fs.rmSync(WS, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(WS, { recursive: true })
process.env.HOME = HOME
process.env.DSH_HOME = DSH
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 假会话树：每条记录一帧 zstd（与真 v4 文件同一形状，魔数扫描切得开）── */
let seq76 = 0
function frame(rec) {
  return zlib.zstdCompressSync(Buffer.from(JSON.stringify(rec) + '\n', 'utf8'))
}
function callRec(id, at, command, workdir) {
  seq76 += 1
  return { type: 'tool/call', time: at, seq: seq76, data: { turn: 1, step: seq76, callId: id, name: 'bash', arguments: JSON.stringify({ command: command, description: 'd-' + id, workdir: workdir === undefined ? WS : workdir }) } }
}
function resultRec(id, at, exitCode) {
  seq76 += 1
  const text = exitCode === null ? 'done\n' : 'done\n[exit code: ' + String(exitCode) + ']\n'
  return { type: 'tool/result', time: at, seq: seq76, data: { turn: 1, step: seq76, message: { role: 'tool', source: 'bash', toolCallId: id, content: [{ type: 'text', text: text }], isError: exitCode !== null && exitCode > 0, id: 'r-' + id } } }
}
function writeSession(sessionId, recs) {
  const dir = SLUG_DIR + '/' + sessionId
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(dir + '/session.v4.jsonl.zstd', Buffer.concat([frame({ type: 'session', cwd: WS })].concat(recs.map(frame))))
}

/* ── 宿主实例：真 shell + liveHub 与 node -e 调用的捕获 ── */
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
const scans = []
const pushes = []
const handlers = new Map()
const shell76 = {
  resolve: (r) => r,
  run: function (spec) {
    const text = String(spec.command)
    if (text.indexOf('node -e ') >= 0 && (text.indexOf("'scan' ") >= 0 || text.indexOf("'incr' ") >= 0)) {
      scans.push({ mode: text.indexOf("'incr' ") >= 0 ? 'incr' : 'scan', command: text })
    }
    return realShell(spec)
  },
}
const ctx76 = { get: (n) => (n === 'shell' ? shell76 : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', 'liveHub', body)(
  ctx76, { handle(n, f) { handlers.set(n, f); return () => {} } }, console,
  (s) => Buffer.from(s, 'binary').toString('base64'), (s) => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder,
  { send: (payload) => { try { pushes.push(JSON.parse(payload)) } catch (e) { pushes.push({ raw: payload }) } } }).apply(ctx76)
const H = (n) => handlers.get(n)
const ask = (extra) => H('git/command-log')(Object.assign({ sessionId: 'sX', sessionCwd: WS, limit: 500 }, extra))

const guards = []
const check = (label, value) => {
  if (value !== true) guards.push(label)
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const slim = (rows) => (Array.isArray(rows) ? rows : []).map((r) => ({ command: r.command, time: parseFloat(r.time) || 0, exitCode: r.exitCode, durationMs: r.durationMs, sessionId: r.sessionId }))
const lastScan = () => scans[scans.length - 1]

console.log('== 1｜冷启动 = 全量扫描 ==')
writeSession('s1', [
  callRec('c1', 1000, 'git status'),
  resultRec('c1', 1820, 0),
  callRec('c2', 1500, 'git log --oneline'),
  callRec('c3', 2000, 'cd /x && git commit -m x'),
  resultRec('c3', 2600, 1),
  callRec('c8', 2100, 'ls -la'),
])
const cold = await ask()
check('冷读答复 ok，带 workspace，4 条里没有 ls（过滤照旧）',
  cold != null && cold.ok === true && cold.workspace === WS
  && cold.commands.length === 3 && cold.commands.every((r) => String(r.command).indexOf('ls -la') < 0))
check('耗时列从两端记录的 time 相减：820 / 600 / 拿不到（无 result）是 null',
  slim(cold.commands).some((r) => r.command === 'git status' && r.durationMs === 820 && r.exitCode === 0)
  && slim(cold.commands).some((r) => r.command.indexOf('git commit') >= 0 && r.durationMs === 600 && r.exitCode === 1)
  && slim(cold.commands).some((r) => r.command === 'git log --oneline' && r.durationMs === null && r.exitCode === null))
check('按 time 降序：commit(2000) > log(1500) > status(1000)',
  JSON.stringify(slim(cold.commands).map((r) => r.command)) === JSON.stringify(['cd /x && git commit -m x', 'git log --oneline', 'git status']))
check('首读走 scan 模式', scans.length >= 1 && lastScan().mode === 'scan')
const full1 = await ask({ full: true })
check('full（「重新读取」）也是 scan 模式，答复与冷读一字不差',
  lastScan().mode === 'scan' && full1.ok === true
  && JSON.stringify(slim(full1.commands)) === JSON.stringify(slim(cold.commands)))

console.log('')
console.log('== 2｜账热：立即用账本答复，后台只发 incr ==')
const scanMark = scans.length
const hot1 = await ask()
await wait(1200)
check('第二次读没发 scan（答复来自账本），后台发的是 incr',
  scans.slice(scanMark).every((s) => s.mode === 'incr') && scans.length > scanMark)
check('热读与冷读同一份行（账本里存的就是解析结果）',
  hot1.ok === true && JSON.stringify(slim(hot1.commands)) === JSON.stringify(slim(cold.commands)))
const incrCmd = lastScan().command
check('incr 的 argv 里带着账本地图：s1 的文件与它的 (mtimeMs,size)',
  incrCmd.indexOf(SLUG_DIR + '/s1/session.v4.jsonl.zstd') >= 0
  && /\[\d+(\.\d+)?,\d+\]/.test(incrCmd.slice(incrCmd.indexOf('s1/session'))))
check('账没变就没有推送', pushes.filter((p) => p.kind === 'cmdlog-refresh').length === 0)

console.log('')
console.log('== 3｜文件变了：只重扫它，增量经推送并回 ==')
writeSession('s1', [
  callRec('c1', 1000, 'git status'),
  resultRec('c1', 1820, 0),
  callRec('c2', 1500, 'git log --oneline'),
  callRec('c3', 2000, 'cd /x && git commit -m x'),
  resultRec('c3', 2600, 1),
  callRec('c4', 3000, 'git add -A'),
  resultRec('c4', 3600, 0),
])
const hot2 = await ask()
check('答复还是账里的旧账（3 行，没有 c4）—— 刷新在后台',
  hot2.ok === true && hot2.commands.length === 3 && hot2.commands.every((r) => r.command !== 'git add -A'))
await wait(1500)
const refreshPushes = pushes.filter((p) => p.kind === 'cmdlog-refresh')
check('后台刷完推送一次 cmdlog-refresh：workspace 对号，c4 带着耗时 600 进来',
  refreshPushes.length === 1 && refreshPushes[0].workspace === WS
  && slim(refreshPushes[0].commands).length === 4
  && slim(refreshPushes[0].commands).some((r) => r.command === 'git add -A' && r.durationMs === 600 && r.exitCode === 0))
const hot3 = await ask()
check('下一次热读：4 行，c4 已在账里', hot3.ok === true && hot3.commands.length === 4
  && slim(hot3.commands).some((r) => r.command === 'git add -A'))

console.log('')
console.log('== 4｜新会话目录进来 / 消失：账本跟着长与摘 ==')
writeSession('s2', [callRec('c5', 4000, 'git fetch --all')])
const hot4 = await ask()
check('答复还是 4 行（s2 还没进账）', hot4.ok === true && hot4.commands.length === 4)
await wait(1500)
const hot5 = await ask()
check('增量刷新把新文件收进账：5 行，s2 的行 sessionId 是 s2',
  hot5.ok === true && hot5.commands.length === 5
  && slim(hot5.commands).some((r) => r.command === 'git fetch --all' && r.sessionId === 's2'))
fs.rmSync(SLUG_DIR + '/s2', { recursive: true, force: true })
await ask()
await wait(1500)
const hot6 = await ask()
check('消失的文件从账本摘除：回到 4 行，c5 不还魂',
  hot6.ok === true && hot6.commands.length === 4 && hot6.commands.every((r) => r.command !== 'git fetch --all'))

console.log('')
console.log('== 5｜面板那一半照旧参与合并 ==')
const staged = await H('git/stage')({ sessionId: 'sX', sessionCwd: WS, repo: WS, paths: ['x.txt'] })
check('面板 stage 照常执行失败（不是仓库）并记了一笔（cmdrecBegin）',
  staged != null && staged.ok === false)
const hot7 = await ask()
const panelRow = hot7.commands.find((r) => r.source === 'panel')
check('热读里面板行也在（与账本行同表合并），耗时已带上（命令早跑完了）',
  hot7.ok === true && panelRow !== undefined && String(panelRow.command).indexOf('add') >= 0
  && typeof panelRow.durationMs === 'number')

console.log('')
console.log('== 6｜空工作区：账为空的冷读是「一条也没有」，不是错误 ==')
const WS2 = '/tmp/gp79-ws2'
fs.mkdirSync(WS2, { recursive: true })
const cold2 = await H('git/command-log')({ sessionId: 'sY', sessionCwd: WS2, limit: 500 })
check('没有会话记录的工作区：ok:true、空列表',
  cold2 != null && cold2.ok === true && Array.isArray(cold2.commands) && cold2.commands.length === 0)

console.log('')
if (guards.length > 0) {
  console.log('✗ ' + guards.length + ' 条不符合预期')
  process.exit(1)
}
console.log('（gp79 全部通过）')
