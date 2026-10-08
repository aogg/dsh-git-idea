import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 变更页「默认变更列表」三件套的 Host 那一半：git/restore 与 git/stash ──
 *
 * 盯四件事：
 *   1. 参数构造：argv 一个字符都不能差（restore 要 --source=HEAD --staged --worktree
 *      三个都在，stash 要 -m 说明和 -- 路径）；
 *   2. 真实效果：restore 把索引+工作区一起拉回 HEAD（被删的文件也回来），stash 收进
 *      栈之后 git stash pop 找得回来 —— 客户端成功条里承诺的就是这句；
 *   3. 路径校验与错误路径：没给路径要拒绝，git 的原话要原样带回；
 *   4. 和别的写命令同一个口径：sandboxDenied / noGit 自报，不让人把「被沙箱拒了」
 *      「机器上没有 git」读成仓库的毛病。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

function runShell(spec) {
  return new Promise((res) => {
    /* DSH_HOME 指到 /tmp：插件配置就落在这里，而不是跑测试那个人的 ~/.dsh —— 他要是
       在真机上改过配置（比如设了 git 路径），那台机器的配置会悄悄改变这些断言的答案。 */
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: Object.assign({}, process.env, { DSH_HOME: '/tmp/gp45-home' }) })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}
const handlers = new Map()
const shellService = { resolve: r => r, run: runShell }
const services = { shell: shellService }
const ctx = {
  get: n => services[n],
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
  s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
const H = n => handlers.get(n)

function sh(cmd, cwd) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', cmd], { cwd })
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

/* fixture：两个已提交的文件，一个改了内容、一个被删掉，都进了索引 —— 这正是
   「默认变更列表」里勾上两项之后的样子。 */
const R = '/tmp/gp45-repo'
await sh(`rm -rf ${R} /tmp/gp45-home && mkdir -p ${R} && cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T && printf 'a\n' > a.txt && printf 'b\n' > b.txt && git add -A && git commit -qm base`, '/tmp')
await sh(`printf 'a2\n' > a.txt && rm b.txt && git add -A`, R)

console.log('=== git/restore：命令形状与实际效果 ===')
const restoreCmds = []
const realRun = shellService.run
shellService.run = function (spec) { restoreCmds.push(spec.command); return realRun(spec) }
const restored = await H('git/restore')({ repo: R, paths: ['a.txt', 'b.txt'] })
shellService.run = realRun
const restoreCmd = restoreCmds[restoreCmds.length - 1]
console.log('  ' + restoreCmd.split('\n').pop())
check('argv 是 restore --source=HEAD --staged --worktree -- 路径（三个旗标一个不少）',
  restoreCmd.indexOf("git 'restore' '--source=HEAD' '--staged' '--worktree' '--' 'a.txt' 'b.txt'") >= 0)
check('答复 ok，并带着 panelMutate 统一给的那些字段（command/sandboxDenied/noGit）',
  restored.ok === true && typeof restored.command === 'string'
  && restored.sandboxDenied === false && restored.noGit === false)
check('索引和工作区都干净了（--staged --worktree 一起生效）',
  (await sh('git status --porcelain', R)).out.trim() === '')
check('改过的 a.txt 回到 HEAD 的内容', (await sh('cat a.txt', R)).out.trim() === 'a')
check('被删的 b.txt 也恢复了（还原包含找回被删文件）',
  (await sh('test -f b.txt && echo yes', R)).out.trim() === 'yes')

console.log('')
console.log('=== git/stash：命令形状、效果与找回 ===')
await sh(`printf 'a3\n' > a.txt && git add a.txt`, R)
const stashCmds = []
shellService.run = function (spec) { stashCmds.push(spec.command); return realRun(spec) }
const stashed = await H('git/stash')({ repo: R, paths: ['a.txt'], message: 'dsh-git-idea：暂存 1 个文件' })
shellService.run = realRun
const stashCmd = stashCmds[stashCmds.length - 1]
console.log('  ' + stashCmd.split('\n').pop())
check('argv 是 stash push -m 说明 -- 路径',
  stashCmd.indexOf("git 'stash' 'push' '-m' 'dsh-git-idea：暂存 1 个文件' '--' 'a.txt'") >= 0)
check('答复 ok', stashed.ok === true)
check('收进 stash 后那个路径干净了', (await sh('git status --porcelain', R)).out.trim() === '')
check('stash 栈里认得出是哪一次（git 2.39 起还会在前面带上 On <branch>:）',
  (await sh('git stash list --format=%s', R)).out.trim().indexOf('dsh-git-idea：暂存 1 个文件') >= 0)
check('git stash pop 找得回来（成功条里承诺的就是这句）',
  (await sh('git stash pop >/dev/null && cat a.txt', R)).out.trim() === 'a3')

console.log('')
console.log('=== 参数校验与错误路径 ===')
const noPaths = await H('git/restore')({ repo: R })
check('restore 没给路径：拒绝，而不是跑一条无路径的命令',
  noPaths.ok !== true && noPaths.error === 'no paths given')
const noPathsStash = await H('git/stash')({ repo: R })
check('stash 同样', noPathsStash.ok !== true && noPathsStash.error === 'no paths given')

/* 非字符串的路径被 panelPaths 滤掉 —— 与 git/stage 同一道关卡，行为要一致（空字符串
   是字符串，stage 也照送：客户端两边都不产空路径，这里就不替 git 操那份心）。 */
await sh(`printf 'a4\n' > a.txt && git add a.txt`, R)
const filterCmds = []
shellService.run = function (spec) { filterCmds.push(spec.command); return realRun(spec) }
const filtered = await H('git/restore')({ repo: R, paths: [1, null, 'a.txt'] })
shellService.run = realRun
const filterTail = filterCmds[filterCmds.length - 1].slice(filterCmds[filterCmds.length - 1].lastIndexOf("'--'") + 4).trim()
check('非字符串的路径被滤掉，剩下的照跑', filtered.ok === true && filterTail === "'a.txt'")

/* 说明缺了不硬编一句：让 git 写它自己的 WIP 句子（消息是客户端的措辞，不是协议的
   必填项）。 */
const noMsgCmds = []
shellService.run = function (spec) { noMsgCmds.push(spec.command); return realRun(spec) }
const noMsg = await H('git/stash')({ repo: R, paths: ['a.txt'] })
shellService.run = realRun
check('说明缺了就省掉 -m（让 git 自己写），答复仍然 ok',
  noMsg.ok === true && noMsgCmds[noMsgCmds.length - 1].indexOf("'-m'") < 0)

/* git 拒绝时要把它自己的话原样带回 —— 读者要看的正是那句 pathspec 不匹配。 */
const bad = await H('git/restore')({ repo: R, paths: ['no-such.txt'] })
check('git 的拒绝原样带回（ok/exitCode/stderr）',
  bad.ok !== true && bad.exitCode !== 0 && bad.stderr.indexOf('no-such.txt') >= 0)

console.log('')
console.log('=== 被沙箱拒绝 / 机器上没有 git ===')
const handlers2 = new Map()
const ctx2 = {
  get: (n) => (n === 'shell' ? {
    resolve: (r) => r,
    run: async () => ({ exitCode: 1, stdout: { text: '' }, stderr: { text: "fatal: Unable to create '/x/.git/index.lock': Permission denied" }, sandbox: { mode: 'workspace-write', denied: true } }),
  } : undefined),
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const harness2 = { handle(n, f) { handlers2.set(n, f); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  ctx2, harness2, console, s => Buffer.from(s, 'binary').toString('base64'),
  s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx2)
const deniedRestore = await handlers2.get('git/restore')({ repo: '/x', paths: ['a.txt'] })
const deniedStash = await handlers2.get('git/stash')({ repo: '/x', paths: ['a.txt'], message: 'm' })
check('restore 被拒时答复里明说是沙箱拒绝的', deniedRestore.ok !== true && deniedRestore.sandboxDenied === true)
check('stash 同样', deniedStash.ok !== true && deniedStash.sandboxDenied === true)

/* PATH 指到空目录 = 机器上没有 git。gitGuard 会打出标记并以 127 退出，答复里的
   noGit 就是读的那个标记 —— 与 git/stage 同一个口径。 */
const NOGIT_PATH = '/tmp/gp45-nogit-path'
fs.mkdirSync(NOGIT_PATH, { recursive: true })
const handlers3 = new Map()
const ctx3 = {
  get: (n) => (n === 'shell' ? {
    resolve: (r) => r,
    run: (spec) => new Promise((res) => {
      const c = spawn('/bin/sh', ['-c', spec.command], {
        cwd: spec.workdir,
        env: Object.assign({}, process.env, { PATH: NOGIT_PATH }),
      })
      let o = '', e = ''
      c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
      c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
      c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
    }),
  } : undefined),
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const harness3 = { handle(n, f) { handlers3.set(n, f); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  ctx3, harness3, console, s => Buffer.from(s, 'binary').toString('base64'),
  s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx3)
const ngRestore = await handlers3.get('git/restore')({ repo: R, paths: ['a.txt'] })
const ngStash = await handlers3.get('git/stash')({ repo: R, paths: ['a.txt'] })
check('没有 git 时 restore 自报 noGit（不谎称仓库有问题）', ngRestore.ok !== true && ngRestore.noGit === true)
check('stash 一样', ngStash.ok !== true && ngStash.noGit === true)

if (failed > 0) {
  console.error('gp45-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
