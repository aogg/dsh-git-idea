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
const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(ctx, harness, console, s => s, s => s, TextEncoder, TextDecoder).apply(ctx)
const H = n => handlers.get(n)
const R = '/tmp/gp34-repo'
const time = async (label, fn) => { const t = Date.now(); const out = await fn(); return { label, ms: Date.now() - t, out } }

console.log('=== 1. 缓存还有效么（同一个仓库，冷 vs 热）===')
for (const method of ['git/panel', 'git/branches', 'git/refs']) {
  await H('git/flush')({ repo: R })
  const cold = await time('cold', () => H(method)({ repo: R }))
  const warm = await time('warm', () => H(method)({ repo: R }))
  const warm2 = await time('warm', () => H(method)({ repo: R }))
  console.log('  ' + method.padEnd(13), '冷 ' + String(cold.ms).padStart(4) + 'ms   热 ' + String(warm.ms).padStart(3) + 'ms / ' + String(warm2.ms).padStart(3) + 'ms')
}

console.log('')
console.log('=== 2. 关键怀疑：面板自己的探测会不会把监测签名弄脏 ===')
const sig = async () => (await H('git/watch')({ repo: R })).sig
const before = await sig()
await H('git/flush')({ repo: R })
await H('git/panel')({ repo: R })          // 面板探测：内部跑了一次普通 git status
const after = await sig()
console.log('  读面板前签名长度:', before.length)
console.log('  读面板后签名变了:', before !== after)
const diffLines = []
{
  const a = before.split('\n'), b = after.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) diffLines.push((a[i] || '(空)') + '  →  ' + (b[i] || '(空)'))
}
console.log('  差异行:', JSON.stringify(diffLines))

console.log('')
console.log('=== 3. 连续读三次面板，签名是否每次都变（会不会自己踢自己）===')
let prev = await sig()
for (let i = 1; i <= 3; i += 1) {
  await H('git/panel')({ repo: R })
  const now = await sig()
  console.log('  第 ' + i + ' 次读面板后签名变了:', prev !== now)
  prev = now
}

console.log('')
console.log('=== 4. 换个仓库/不存在的路径对比 ===')
await H('git/flush')({ repo: '/tmp' })
const t1 = await time('c', () => H('git/panel')({ repo: '/tmp' }))
const t2 = await time('w', () => H('git/panel')({ repo: '/tmp' }))
console.log('  非仓库 /tmp：冷 ' + t1.ms + 'ms  热 ' + t2.ms + 'ms  结果 ok=' + t2.out.ok + ' reason=' + t2.out.reason)
