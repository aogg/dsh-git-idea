import fs from 'node:fs'

/* ═══ gp72：worktree 快速创建的 Host 半 —— git/worktree-add（65-worktree.js）═══
 *
 * 钉 2c19916 的 addWorktree，罐头 shell 喂答案（gp57 同一副骨架：整份 host.js
 * 求值，shell Service 换成听命令的桩 —— argv 与答复逐字节确定，不赌本机 git）：
 *   1. 入参校验：mode 三选一；path 必填、必须绝对路径（charAt(0)==='/'）；new /
 *      checkout 必填 name；name / at 过 cleanRefHalf（空、前导 -、控制字符都不收）
 *      —— 校验失败一律 {ok:false, error:人话}，且一个字节不跑、一个目录不建；
 *   2. argv 组装（手册顺序 `worktree add [--force] [--detach] [-b <名>] <path>
 *      [<commit-ish>]`）：force 的 --force 排最前；new 的 -b 名在 path 前；detach
 *      空 at 显式给 'HEAD'（git 拒收无起点的 --detach）；起点永远在 path 后面；
 *      工作目录跟着请求点名的仓库走；
 *      checkout 的分支名落在 path 后的 <commit-ish> 位：本地短名 feat 与远端全名
 *      origin/feat/x 同一个位置、不做任何前缀变换（后者交给 git 的 dwim 建同名
 *      本地跟踪分支）；checkout 不收 at —— 非空 at 直接 {ok:false} 且一条命令不跑
 *      （要检出的分支名本身就是起点）；
 *   3. 走 panelMutate 的语义：ok = exitCode===0；人话命令、stdout/stderr/exitCode
 *      透传；noGit（127 + 标记字）与 sandboxDenied 两面旗标原样带上；
 *   4. 成功答复合并 worktreesSnapshot：worktrees 是 porcelain 滤掉主仓后的链接
 *      工作区、repo 回请求的仓库、path 回请求的目录；快照读不出来不抹掉 add 的
 *      成功 —— worktrees 折空数组、原因放 wtError 随行。
 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

/* 罐头 shell：worktree add 与 worktree list 按当前用例答复，其余（配置探测等）答空。 */
let addResult = { exitCode: 0, stdout: '', stderr: '', sandbox: undefined }
let porcelainText = ''
let listExit = 0
let listStderr = ''
function makeBody() {
  const runs = []
  const shellService = {
    resolve: (r) => r,
    run: (spec) => {
      runs.push(spec)
      if (spec.command.indexOf("'worktree' 'add'") >= 0) {
        return Promise.resolve({ exitCode: addResult.exitCode, stdout: { text: addResult.stdout }, stderr: { text: addResult.stderr }, sandbox: addResult.sandbox })
      }
      if (spec.command.indexOf("'worktree' 'list' '--porcelain'") >= 0) {
        return Promise.resolve({ exitCode: listExit, stdout: { text: porcelainText }, stderr: { text: listStderr } })
      }
      return Promise.resolve({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
    },
  }
  const handlers = new Map()
  const ctx = { get: (n) => (n === 'shell' ? shellService : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return { H: (n) => handlers.get(n), runs: runs }
}
const addRuns = (runs) => runs.filter((r) => r.command.indexOf("'worktree' 'add'") >= 0)
const listRuns = (runs) => runs.filter((r) => r.command.indexOf("'worktree' 'list' '--porcelain'") >= 0)

let failed = 0
const check = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}

const PORCELAIN = [
  'worktree /tmp/gp72/main',
  'HEAD aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
  'branch refs/heads/main',
  '',
  'worktree /tmp/gp72/one',
  'HEAD bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
  'branch refs/heads/feat',
  '',
].join('\n')

console.log('')
console.log('=== 1｜入参校验：不合格一律人话回绝，一个字节不跑 ===')
{
  const a = makeBody()
  const cases = [
    [{ sessionId: 's' }, 'mode'],
    [{ sessionId: 's', mode: 'clone', path: '/tmp/gp72/x' }, 'mode'],
    [{ sessionId: 's', mode: 'new' }, '放置目录必填'],
    [{ sessionId: 's', mode: 'new', name: 'feat' }, '放置目录必填'],
    [{ sessionId: 's', mode: 'new', name: 'feat', path: 'wt/relative' }, '绝对路径'],
    [{ sessionId: 's', mode: 'new', path: '/tmp/gp72/x' }, '新分支名必填'],
    [{ sessionId: 's', mode: 'checkout', path: '/tmp/gp72/x' }, '分支名必填'],
    [{ sessionId: 's', mode: 'new', name: '-bad', path: '/tmp/gp72/x' }, '分支名不合法'],
    [{ sessionId: 's', mode: 'new', name: 'bad\nname', path: '/tmp/gp72/x' }, '分支名不合法'],
    [{ sessionId: 's', mode: 'new', name: 'feat', at: '-bad', path: '/tmp/gp72/x' }, '起点不合法'],
  ]
  for (const [input, word] of cases) {
    const reply = await a.H('git/worktree-add')(input)
    check(String(input.mode ?? '(无 mode)') + ' → ok:false，error 里有「' + word + '」',
      reply !== null && typeof reply === 'object' && reply.ok === false && typeof reply.error === 'string' && reply.error.indexOf(word) >= 0)
  }
  check('十种不合格一条 worktree add 都没跑（配置探测那一次不算 git 调用）',
    addRuns(a.runs).length === 0 && listRuns(a.runs).length === 0)
}

console.log('')
console.log('=== 2｜argv 组装：旗标全在 path 前，path 后只跟起点 ===')
{
  porcelainText = PORCELAIN
  listExit = 0
  addResult = { exitCode: 0, stdout: '', stderr: '' }

  const a = makeBody()
  await a.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/main', mode: 'new', name: 'feat/x', path: '/tmp/gp72/feat x' })
  const cmd = addRuns(a.runs)[0].command
  check('new 基本：git worktree add -b feat/x <path>，顺序与省略都对',
    cmd.indexOf("git 'worktree' 'add' '-b' 'feat/x' '/tmp/gp72/feat x'") >= 0
    && cmd.indexOf('--force') < 0 && cmd.indexOf('--detach') < 0)
  check('工作目录跟请求点名的仓库走', addRuns(a.runs)[0].workdir === '/tmp/gp72/main')

  const b = makeBody()
  await b.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/b', mode: 'new', name: 'feat', at: 'origin/main', path: '/tmp/gp72/f' })
  check('new 带起点：起点在 path 之后', addRuns(b.runs)[0].command.indexOf("'-b' 'feat' '/tmp/gp72/f' 'origin/main'") >= 0)

  const c = makeBody()
  await c.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/c', mode: 'new', name: 'feat', path: '/tmp/gp72/f', force: true })
  const cmdC = addRuns(c.runs)[0].command
  check('new + force：--force 排在最前（在 -b 之前）',
    cmdC.indexOf("'--force'") >= 0 && cmdC.indexOf("'--force'") < cmdC.indexOf("'-b'"))

  const d = makeBody()
  await d.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/d', mode: 'detach', path: '/tmp/gp72/dt' })
  const cmdD = addRuns(d.runs)[0].command
  check('detach 空 at：--detach 在 path 前，起点显式 HEAD',
    cmdD.indexOf("'worktree' 'add' '--detach' '/tmp/gp72/dt' 'HEAD'") >= 0)

  const e = makeBody()
  await e.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/e', mode: 'detach', at: 'v1.2.3', path: '/tmp/gp72/dt' })
  check('detach 带起点：tag/commit 原样做起点', addRuns(e.runs)[0].command.indexOf("'--detach' '/tmp/gp72/dt' 'v1.2.3'") >= 0)

  const f = makeBody()
  const replyF = await f.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/f0', mode: 'checkout', name: 'feat', path: '/tmp/gp72/co' })
  const cmdF = addRuns(f.runs)[0].command
  check('checkout 本地分支：argv 精确为 add <path> feat —— 分支名进 <commit-ish> 位，无 --force',
    replyF.ok === true && replyF.command === 'git worktree add /tmp/gp72/co feat'
    && cmdF.indexOf("'worktree' 'add' '/tmp/gp72/co' 'feat'") >= 0 && cmdF.indexOf('--force') < 0)

  const g = makeBody()
  const replyG = await g.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/g0', mode: 'checkout', name: 'origin/feat/x', path: '/tmp/gp72/co-remote' })
  const cmdG = addRuns(g.runs)[0].command
  check('checkout 远端分支名：origin/feat/x 原样落在同一位置，不做任何前缀变换',
    replyG.ok === true && replyG.command === 'git worktree add /tmp/gp72/co-remote origin/feat/x'
    && cmdG.indexOf("'/tmp/gp72/co-remote' 'origin/feat/x'") >= 0
    && cmdG.indexOf('-b') < 0 && cmdG.indexOf('--detach') < 0 && cmdG.indexOf('refs/') < 0)

  const h = makeBody()
  const replyH = await h.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/h0', mode: 'checkout', name: 'feat', path: '/tmp/gp72/co-force', force: true })
  const cmdH = addRuns(h.runs)[0].command
  check('checkout + force：--force 仍在 path 前，分支名照旧在 path 后',
    replyH.ok === true && replyH.command === 'git worktree add --force /tmp/gp72/co-force feat'
    && cmdH.indexOf('--force') >= 0 && cmdH.indexOf('--force') < cmdH.indexOf('/tmp/gp72/co-force')
    && cmdH.indexOf('/tmp/gp72/co-force') < cmdH.indexOf("'feat'"))

  const i = makeBody()
  const replyI = await i.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/i0', mode: 'checkout', name: 'feat', at: 'origin/main', path: '/tmp/gp72/co-at' })
  check('checkout + 非空 at：ok:false、error 说「不接受起点」，一个 worktree add / list 都没跑',
    replyI !== null && typeof replyI === 'object' && replyI.ok === false
    && typeof replyI.error === 'string' && replyI.error.indexOf('不接受起点') >= 0
    && replyI.path === '/tmp/gp72/co-at'
    && addRuns(i.runs).length === 0 && listRuns(i.runs).length === 0)
}

console.log('')
console.log('=== 3｜panelMutate 语义：人话命令、透传、noGit / sandboxDenied 旗标 ===')
{
  porcelainText = ''
  addResult = { exitCode: 0, stdout: 'Preparing worktree\n', stderr: '' }
  const a = makeBody()
  const ok = await a.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/main', mode: 'new', name: 'feat', path: '/tmp/gp72/f' })
  check('成功：ok:true、repo 回工作目录、人话命令、stdout 透传',
    ok.ok === true && ok.repo === '/tmp/gp72/main'
    && ok.command === 'git worktree add -b feat /tmp/gp72/f'
    && ok.stdout === 'Preparing worktree\n' && ok.exitCode === 0
    && ok.noGit === false && ok.sandboxDenied === false)

  addResult = { exitCode: 128, stdout: '', stderr: "fatal: '/tmp/gp72/f' already exists" }
  const fail = await makeBody().H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/main', mode: 'new', name: 'feat', path: '/tmp/gp72/f' })
  check('git 拒收：ok:false、stderr 原话带回、不追快照（没有 list 命令）',
    fail.ok === false && fail.exitCode === 128
    && fail.stderr.indexOf("already exists") >= 0)

  addResult = { exitCode: 127, stdout: '', stderr: 'dsh-git-idea: no git on PATH' }
  const nogit = await makeBody().H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/main', mode: 'new', name: 'feat', path: '/tmp/gp72/f' })
  check('机器上没有 git：noGit 旗标直说', nogit.ok === false && nogit.noGit === true)

  addResult = { exitCode: 1, stdout: '', stderr: 'Permission denied', sandbox: { denied: true } }
  const denied = await makeBody().H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/main', mode: 'new', name: 'feat', path: '/tmp/gp72/f' })
  check('沙箱拒写：sandboxDenied 旗标直说', denied.ok === false && denied.sandboxDenied === true)
}

console.log('')
console.log('=== 4｜成功答复合并 worktreesSnapshot；快照失败不抹成功 ===')
{
  porcelainText = PORCELAIN
  listExit = 0
  addResult = { exitCode: 0, stdout: '', stderr: '' }
  const a = makeBody()
  const ok = await a.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/main', mode: 'new', name: 'feat', path: '/tmp/gp72/one' })
  check('答复带回最新清单：主仓滤掉，恰好 1 条链接工作区',
    ok.ok === true && Array.isArray(ok.worktrees) && ok.worktrees.length === 1
    && ok.worktrees[0].path === '/tmp/gp72/one' && ok.worktrees[0].branch === 'feat')
  check('repo 回请求的仓库、path 回请求的目录', ok.repo === '/tmp/gp72/main' && ok.path === '/tmp/gp72/one')
  check('快照是 add 之后现读的（add 一次、list 一次）',
    addRuns(a.runs).length === 1 && listRuns(a.runs).length === 1
    && a.runs.indexOf(addRuns(a.runs)[0]) < a.runs.indexOf(listRuns(a.runs)[0]))

  listExit = 1
  listStderr = 'fatal: not a git repository'
  const b = makeBody()
  const okB = await b.H('git/worktree-add')({ sessionId: 's', repo: '/tmp/gp72/main', mode: 'new', name: 'feat', path: '/tmp/gp72/two' })
  check('快照读不出来：add 的成功不抹 —— ok 仍 true、worktrees 折空、原因在 wtError',
    okB.ok === true && Array.isArray(okB.worktrees) && okB.worktrees.length === 0
    && typeof okB.wtError === 'string' && okB.wtError.length > 0)
}

if (failed > 0) {
  console.error('gp72-worktree-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
