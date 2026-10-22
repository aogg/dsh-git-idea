/* ── 主机侧 RPC 冷/热耗时：切到一个没用过的工作区时，面板到底在等什么 ──

   跑法：node test/bench-rpc.mjs [仓库路径...]
   不带参数时用几个本机真实仓库。每个仓库先 flush 一次，逐个量第一条（冷）
   与第二条（热）的耗时 —— 冷的那条就是切工作区时用户看到的那一段。 */

import fs from 'node:fs'
import { spawn } from 'node:child_process'

const body = fs.readFileSync(new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

function runShell(spec) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: process.env })
    let o = '', e = ''
    c.stdout.on('data', (b) => { o += b })
    c.stderr.on('data', (b) => { e += b })
    c.on('error', (er) => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', (x) => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}

const handlers = new Map()
const ctx = {
  get: (n) => (n === 'shell' ? { resolve: (r) => r, run: runShell } : undefined),
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
/* harness 现在只有 handle：这个插件不注册工具（见 gp34a 那段断言）。 */
const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  ctx, harness, console, (s) => Buffer.from(s, 'binary').toString('base64'),
  (s) => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)

const H = (n) => handlers.get(n)
const REPOS = process.argv.slice(2).length > 0 ? process.argv.slice(2)
  : ['/mnt/d/work/idea_work/holox_cloud', '/mnt/d/work/dx-system-web']

/* 面板打开时会发出去的请求，顺序就是它们各自 effect 的触发顺序 */
const CALLS = [
  ['git/panel', { quick: true }],
  ['git/panel', {}],
  ['git/branches', {}],
  ['git/refs', {}],
  ['git/graph', { maxCount: 200 }],
  ['git/authors', {}],
  ['git/watch', {}],
  ['git/watch', { deep: true }],
]

for (const repo of REPOS) {
  if (!fs.existsSync(repo + '/.git')) { console.log('跳过（不是仓库）: ' + repo); continue }
  console.log('')
  console.log('== ' + repo + ' ==')
  let coldTotal = 0
  let warmTotal = 0
  for (const [method, extra] of CALLS) {
    await H('git/flush')(Object.assign({ repo }, extra))
    const t0 = process.hrtime.bigint()
    const cold = await H(method)(Object.assign({ repo }, extra))
    const coldMs = Number(process.hrtime.bigint() - t0) / 1e6
    const t1 = process.hrtime.bigint()
    await H(method)(Object.assign({ repo }, extra))
    const warmMs = Number(process.hrtime.bigint() - t1) / 1e6
    coldTotal += coldMs
    warmTotal += warmMs
    const label = method === 'git/watch' && extra.deep === true ? 'git/watch[deep]' : method
    const size = method === 'git/graph' ? String((cold.commits || []).length) + ' 提交'
      : method === 'git/branches' ? String((cold.branches || []).length) + ' 分支'
        : method === 'git/authors' ? String((cold.authors || []).length) + ' 作者'
          : method === 'git/refs' ? String((cold.local || []).length) + ' 本地引用' : ''
    console.log('  ' + label.padEnd(16) + coldMs.toFixed(1).padStart(8) + 'ms 冷   ' + warmMs.toFixed(1).padStart(7) + 'ms 热   ' + size)
  }
  console.log('  ' + '合计'.padEnd(14) + coldTotal.toFixed(1).padStart(8) + 'ms 冷   ' + warmTotal.toFixed(1).padStart(7) + 'ms 热')
}
