#!/usr/bin/env node
/* The six gp3x suites are one shared harness plus a body, and the benchmarks are
   the same shape. This glues them, with the newline the earlier by-hand
   concatenation happened to get away with not having.

   Same contract as build.mjs: the generated file is an artifact, its sources are
   the `.part` and the `-body`, and `--check` says whether the artifact on disk
   still matches them. run-all.mjs asks both before it trusts a green run — a
   body edited without re-gluing would otherwise leave the suite asserting what
   the body said last time, and nothing inside a suite can see that. */

import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)

export const SUITES = [
  ['gp37-body.mjs', 'gp37-logpanel-test.mjs'],
  ['gp38-body.mjs', 'gp38-flyout-test.mjs'],
  ['gp39-body.mjs', 'gp39-session-test.mjs'],
  ['gp40-body.mjs', 'gp40-refactor-test.mjs'],
  ['gp41-body.mjs', 'gp41-watch-test.mjs'],
  ['gp42-body.mjs', 'gp42-diff-test.mjs'],
  ['gp43-body.mjs', 'gp43-settings-test.mjs'],
  ['gp44-body.mjs', 'gp44-shared-test.mjs'],
  ['gp45-body.mjs', 'gp45-actions-test.mjs'],
  ['bench-body.mjs', 'bench.mjs'],
  ['bench-branch-body.mjs', 'bench-branch.mjs'],
]

export function render(body) {
  const harness = fs.readFileSync(path.join(HERE, 'gp37-harness.part'), 'utf8')
  return harness + '\n' + fs.readFileSync(path.join(HERE, body), 'utf8')
}

export function buildAll(write) {
  const report = []
  for (const [body, out] of SUITES) {
    const next = render(body)
    const file = path.join(HERE, out)
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    const stale = current !== next
    if (write && stale) fs.writeFileSync(file, next)
    report.push({ out: out, stale: stale, bytes: Buffer.byteLength(next) })
  }
  return report
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (invokedDirectly) {
  const check = process.argv.indexOf('--check') >= 0
  const report = buildAll(check !== true)
  let bad = 0
  for (const row of report) {
    const state = row.stale ? (check ? 'STALE' : 'written') : 'current'
    if (check && row.stale) bad += 1
    console.log(row.out.padEnd(24) + state.padEnd(9) + String(row.bytes).padStart(9) + ' bytes')
  }
  if (bad > 0) {
    console.error('suites: ' + String(bad) + ' generated file(s) are not up to date — run `node test/build-suites.mjs`')
    process.exit(1)
  }
}
