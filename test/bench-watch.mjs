/* 新旧签名在真仓库上的代价对比：多读一个 HEAD 文件应该等于零成本 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'

function load(file) {
  const body = fs.readFileSync(file, 'utf8')
  const runShell = (spec) => new Promise((res) => {
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: process.env })
    let o = '', e = ''
    c.stdout.on('data', (b) => { o += b })
    c.stderr.on('data', (b) => { e += b })
    c.on('close', (x) => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
  const handlers = new Map()
  const ctx = { get: (n) => (n === 'shell' ? { resolve: (r) => r, run: runShell } : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, console, (s) => Buffer.from(s, 'binary').toString('base64'),
    (s) => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return (repo) => handlers.get('git/watch')({ repo })
}

const repo = process.argv[2] || '/mnt/d/work/idea_work/holox_cloud'
const N = 9
for (const [label, file] of [['旧（只 stat）', '/tmp/gp-before-host.js'], ['新（读 HEAD 内容）', new URL('../dist/host.js', import.meta.url).pathname]]) {
  const watch = load(file)
  await watch(repo) /* 预热 */
  const times = []
  for (let i = 0; i < N; i += 1) {
    const t = process.hrtime.bigint()
    await watch(repo)
    times.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  times.sort((a, b) => a - b)
  const sig = (await watch(repo)).sig
  console.log(label.padEnd(20) + '中位 ' + times[Math.floor(N / 2)].toFixed(1).padStart(7) + 'ms   最快 ' + times[0].toFixed(1).padStart(7) + 'ms')
  if (label.indexOf('新') === 0) console.log('  当前分支那行: ' + sig.split('\n').find((l) => l.indexOf('R:') === 0))
}
