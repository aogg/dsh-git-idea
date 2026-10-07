#!/usr/bin/env node
/* Every suite, in one command, against whatever is on disk right now.
   `node test/run-all.mjs` — and it refuses to trust a green run when either
   generated artifact has fallen behind its sources: the built host.js/client.js
   against src/, and each suite file against the harness plus the body it is
   glued from. Both are failures this layout can produce and no assertion inside
   a suite can see. */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.dirname(HERE)

/* Suites that count ✓ / ✗ in their output. */
const COUNTING = [
  'gp34b-client-test.mjs',
  'gp35-panel-test.mjs',
  'gp36-click-test.mjs',
  'gp37-logpanel-test.mjs',
  'gp38-flyout-test.mjs',
  'gp39-session-test.mjs',
  'gp40-refactor-test.mjs',
  'gp41-watch-test.mjs',
  'gp42-diff-test.mjs',
  'gp43-settings-test.mjs',
  'gp44-shared-test.mjs',
]
/* Suites that report by exit code and print their own lines. */
const PROSE = ['gp34a-host-test.mjs', 'gp34d-config-test.mjs', 'gp34e-bridge-test.mjs']

/* ── GP_FRESH：不落仓库产物也做回归 ──

   build.mjs 的产物（host.js / client.js / lib）落在仓库里，有些场合明令禁止在本机
   重建它们（产物由用户侧统一重建）。但本文件进门的三道门槛恰恰要求产物与 src/ 一致
   —— 那样一来，改了 src/ 的那次提交永远测不了。GP_FRESH=1 是给那种场合的出路：
   用 build.mjs 自己的 TARGETS/render（纯函数，不写仓库内任何文件）把 src/ 拼到临时
   目录，让套件经 GP_SRC 读这份拼接 —— 测的还是这份 src/，仓库里的产物一个字节不动。
   门槛跳过时会大声说出来，绿色因此不会被误读成「产物也是新的」。 */
const FRESH = process.env.GP_FRESH === '1'
const FRESH_DIR = process.env.GP_FRESH_DIR || '/code/www/.dsh/tmp/dgi-gpfresh'
let freshClient = null
let freshHost = null
if (FRESH) {
  const built = await import('../build.mjs')
  fs.mkdirSync(FRESH_DIR, { recursive: true })
  for (const target of built.TARGETS) {
    const file = path.join(FRESH_DIR, target.out)
    fs.writeFileSync(file, built.render(target))
    if (target.out === 'client.js') freshClient = file
    else freshHost = file
  }
  console.log('GP_FRESH: src/ 已拼接为临时产物（仓库产物未动），套件读：' + FRESH_DIR)
}

function run(file) {
  const started = Date.now()
  /* 这两个套件读的是 host 那一半，其余读 client 那一半（GP_SRC 在它们各自文件里
     的含义就是「要测的那份源码」）。 */
  const env = Object.assign({}, process.env)
  if (FRESH) {
    env.GP_SRC = file === 'gp34a-host-test.mjs' || file === 'gp34d-config-test.mjs' ? freshHost : freshClient
  }
  const result = spawnSync(process.execPath, [path.join(HERE, file)], { encoding: 'utf8', env: env })
  const out = (result.stdout || '') + (result.stderr || '')
  const mark = (text) => (out.match(new RegExp(text, 'g')) || []).length
  return {
    file: file,
    code: result.status,
    passed: mark('✓'),
    failed: mark('✗'),
    ms: Date.now() - started,
    out: out,
  }
}

/* Both artifacts are checked before anything runs, and each refusal names the
   command that fixes it: one is the plugin half, the other the suites. */
function stale(script, hint) {
  const check = spawnSync(process.execPath, [path.join(ROOT, script), '--check'], { encoding: 'utf8' })
  if (check.status === 0) return false
  console.error((check.stdout || '') + (check.stderr || ''))
  console.error(hint)
  return true
}
function publishedGap() {
  const host = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const client = fs.readFileSync(path.join(ROOT, 'client', 'client.js'), 'utf8')
  if (host.indexOf("export const inject = ['shell']") < 0) return 'lib/index.js does not declare the shell inject'
  if (client.indexOf('const styles = {') < 0) return 'client/client.js does not define styles'
  return null
}

if (FRESH) {
  console.log('GP_FRESH: 跳过产物新鲜度门槛 —— 本次刻意不重建仓库内的产物（见文件头）')
} else {
  if (stale('build.mjs', 'run `node build.mjs` first: the suites would otherwise test a stale artifact')) process.exit(1)
  if (stale(path.join('test', 'build-suites.mjs'), 'run `node test/build-suites.mjs` first: the suite on disk would otherwise assert what its body said last time')) process.exit(1)
  /* The published package is built from the same fragments. Editing src/ and
     running only build.mjs leaves lib/index.js — the file that actually ships —
     asserting an older plugin. */
  if (stale('build-package.mjs', 'run `node build-package.mjs` first: lib/index.js is what the published package exports')) process.exit(1)
  /* Two things the preludes must supply for the fragments to run at all, and
     both were missing once: the host half declares `shell` (or it applies
     before the executor exists and registers no RPC), and the client half
     defines the `styles` symbol its CSS fragment calls. Assert them on the
     files that ship, not on the sources they are assembled from. */
  const gap = publishedGap()
  if (gap !== null) {
    console.error('published package: ' + gap)
    process.exit(1)
  }
}

let passed = 0
let failed = 0
let broken = 0
for (const file of COUNTING.concat(PROSE)) {
  const row = run(file)
  passed += row.passed
  failed += row.failed
  const bad = row.code !== 0 || row.failed > 0
  if (bad) broken += 1
  const label = row.passed > 0 ? '✓ ' + row.passed + (row.failed > 0 ? '  ✗ ' + row.failed : '') : row.code === 0 ? 'ok' : 'exit ' + row.code
  console.log((bad ? '✗ ' : '  ') + file.padEnd(24) + label.padEnd(14) + String(row.ms).padStart(6) + 'ms')
  if (bad) {
    console.log(row.out.split('\n').filter((line) => line.indexOf('✗') >= 0 || line.indexOf('Error') >= 0).slice(0, 20).join('\n'))
  }
}
console.log('')
console.log('assertions: ' + passed + ' ✓  ' + failed + ' ✗      suites with a problem: ' + broken)
const summary = JSON.stringify({ passed: passed, failed: failed, broken: broken, at: new Date().toISOString() })
fs.writeFileSync(path.join(HERE, '.last-run.json'), summary + '\n')
process.exit(failed > 0 || broken > 0 ? 1 : 0)
