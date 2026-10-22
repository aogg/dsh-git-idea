import fs from 'node:fs'
import { spawn } from 'node:child_process'
const body = fs.readFileSync('new URL('../dist/host.js', import.meta.url).pathname', 'utf8')
let spawns = 0
function runShell(spec) {
  spawns += 1                                  // 每一次 shell.run 就是一次真实的子进程
  return new Promise((res) => {
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: process.env })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}
const handlers = new Map()
const ctx = { get: n => (n === 'shell' ? { resolve: r => r, run: runShell } : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  ctx, { handle(n, f) { handlers.set(n, f); return () => {} } },
  console, s => s, s => s, TextEncoder, TextDecoder).apply(ctx)
const H = n => handlers.get(n)
const R = '/tmp/gp35-big'

async function probe(label, method, args) {
  spawns = 0
  const t = Date.now()
  await H(method)(Object.assign({ repo: R }, args || {}))
  const ms = Date.now() - t
  console.log('  ' + label.padEnd(22) + String(ms + 'ms').padStart(6) + '   起了 ' + spawns + ' 个 git 子进程')
}

console.log('仓库: ' + R + '（1201 提交 / 4200 文件）')
console.log('')
for (const [method, args] of [['git/panel', {}], ['git/branches', {}], ['git/graph', { maxCount: 200 }], ['git/authors', {}]]) {
  await H('git/flush')({ repo: R })                    // 把这份缓存丢掉，制造「冷」
  await probe(method + '  冷', method, args)
  await probe(method + '  热', method, args)
  await probe(method + '  热', method, args)
  console.log('')
}

console.log('=== 缓存里到底存了什么（键与值）===')
await H('git/flush')({ repo: R })
await H('git/panel')({ repo: R })
await H('git/branches')({ repo: R })
const src = body.match(/const readCache = new Map\(\)[\s\S]*?readCache\.set\(key, \{ at: at, value: value \}\)/)
console.log('  ' + src[0].split('\n').filter(l => l.indexOf('key') >= 0 || l.indexOf('readCache.set') >= 0).map(l => l.trim()).join('\n  '))

console.log('')
console.log('=== 什么会让「热」变回「冷」===')
await probe('读一次（热）', 'git/panel')
await H('git/flush')({ repo: R })                       // 刷新按钮 / 监测发现变化时走的就是这个
await probe('flush 之后', 'git/panel')
