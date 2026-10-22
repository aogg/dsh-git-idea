import fs from 'node:fs'
import { spawn } from 'node:child_process'
const body = fs.readFileSync('new URL('../dist/host.js', import.meta.url).pathname', 'utf8')
function runShell(spec) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: process.env })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}
const handlers = new Map()
const ctx = { get: n => (n === 'shell' ? { resolve: r => r, run: runShell } : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(ctx, { handle(n, f) { handlers.set(n, f); return () => {} } }, console, s => s, s => s, TextEncoder, TextDecoder).apply(ctx)
const H = n => handlers.get(n)
const R = '/tmp/gp35-big'
const ms = async (fn) => { const t = Date.now(); await fn(); return Date.now() - t }

console.log('=== 真实体量仓库（1201 提交 / 4200 文件）冷读耗时 ===')
for (const [method, args] of [
  ['git/panel', {}],
  ['git/branches', {}],
  ['git/refs', {}],
  ['git/graph', { maxCount: 200 }],
  ['git/authors', {}],
  ['git/watch', {}],
]) {
  await H('git/flush')({ repo: R })
  const cold = await ms(() => H(method)(Object.assign({ repo: R }, args)))
  const warm = await ms(() => H(method)(Object.assign({ repo: R }, args)))
  console.log('  ' + method.padEnd(13), '冷 ' + String(cold).padStart(5) + 'ms   热 ' + String(warm).padStart(4) + 'ms')
}

console.log('')
console.log('=== 打开一次面板（历史页）实际要读几个、各多慢 ===')
await H('git/flush')({ repo: R })
let t = Date.now()
await H('git/panel')({ repo: R })
await H('git/refs')({ repo: R })
await H('git/authors')({ repo: R })
const graph = await H('git/graph')({ repo: R, maxCount: 200 })
await H('git/commit-detail')({ repo: R, hash: graph.commits[0].hash })
console.log('  冷启动整轮: ' + (Date.now() - t) + 'ms')

console.log('')
console.log('=== 仓库里改一个文件之后，再开一次面板要重读多少 ===')
await new Promise((res) => spawn('sh', ['-c', 'echo changed >> src/mod1/file1.txt'], { cwd: R }).on('close', res))
const sigBefore = (await H('git/watch')({ repo: R })).sig
const sigAfter = (await H('git/watch')({ repo: R })).sig
console.log('  监测签名变了:', sigBefore !== sigAfter, '（客户端会跟着 git/flush + 重读）')
t = Date.now()
await H('git/flush')({ repo: R })
await H('git/panel')({ repo: R })
await H('git/refs')({ repo: R })
await H('git/authors')({ repo: R })
const g2 = await H('git/graph')({ repo: R, maxCount: 200 })
await H('git/commit-detail')({ repo: R, hash: g2.commits[0].hash })
console.log('  改一个文件后的整轮重读: ' + (Date.now() - t) + 'ms   ← 其中 shortlog 占大头')

console.log('')
console.log('=== 只改工作区、没有新提交时，哪些数据其实没变 ===')
console.log('  authors（历史作者统计）依赖于提交，不依赖工作区')
console.log('  refs / branches 依赖于 HEAD 与 refs，不依赖工作区文件')
await H('git/flush')({ repo: R })
const sA = (await H('git/watch')({ repo: R })).sig
await new Promise((res) => spawn('sh', ['-c', 'echo more >> src/mod2/file2.txt'], { cwd: R }).on('close', res))
const sB = (await H('git/watch')({ repo: R })).sig
const parts = (s) => { const m = {}; for (const line of s.split('\n')) { const i = line.indexOf(':'); if (i === 2) m[line.slice(0, 1) + ':'] = line.slice(2) } return m }
const pa = parts(sA), pb = parts(sB)
console.log('  签名分片变化: ' + ['H:', 'I:', 'R:', 'P:'].map((k) => k + (pa[k] === pb[k] ? '=' : '≠')).join('  ') + '  status' + (pa['status'] === pb['status'] ? '=' : '≠'))
