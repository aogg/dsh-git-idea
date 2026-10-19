import fs from 'node:fs'

/* ── 历史页工作树块的 Host 那一半：git/worktrees（65-worktree.js）──
 *
 * 这条 RPC 是一份 `git worktree list --porcelain` 的翻译，v1 纯只读。盯四片：
 *   1. 解析：porcelain 按空行分块；`worktree ` 之后的整行是路径（带空格的路径
 *      不许被截断）；`branch refs/heads/x` 剥成短名；`detached` / `bare` 光一个
 *      关键字一行；`locked` / `prunable` 只在成立时出现，且带与不带原因都要收
 *      —— 原因就是关键字之后的那一段原文，一个字节不加工；
 *   2. 失败折返：非零退出折成 ok:false（error: 'not-a-repository'、worktrees: []
 *      、stderr 原话带回），127 + gitGuard 的标记时 noGit 自报 —— 不另立错误通道，
 *      客户端只认 ok:false 一副长相；
 *   3. 命令形状（9b0c450）：走 gitC —— LC_ALL=C 在前，且带 `-c core.quotePath=false`
 *      ：porcelain 的关键字本身不会被翻译，但 locked 的原因会按 quotePath 规则把
 *      非 ASCII 原文引成八进制，关掉它 tooltip 里才是人话。workdir 跟请求的仓库走；
 *   4. 读缓存：与 refs 同一套按仓库一格（cached(repo, 'worktrees')）—— 同一仓库
 *      的第二次问不落子进程；换个仓库才是新的一次；请求不点名仓库就回退会话
 *      工作区（repoFrom 的老规矩），workdir 跟着会话走。
 *
 * 与 gp45/gp56 同一副骨架：整份 host.js 求值，shell Service 换成听命令的桩 ——
 * porcelain 的答复按用例给罐头，解析断言因此逐字节确定，不赌本机 git 的版本与
 * 措辞（prunable 的原因原文各版本不一样，真实 git 反而钉不住）。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

/* ── 罐头 shell：配置探测一律空 ok；worktree list 按“当前用例”答复，并记账 ── */
let porcelainText = ''
let worktreeExit = 0
let worktreeStderr = ''
function makeBody(sessions) {
  const runs = []
  const shellService = {
    resolve: (r) => r,
    run: (spec) => {
      runs.push(spec)
      if (spec.command.indexOf("'worktree' 'list' '--porcelain'") >= 0) {
        return Promise.resolve({ exitCode: worktreeExit, stdout: { text: porcelainText }, stderr: { text: worktreeStderr } })
      }
      /* configPath() 的 `printf %s "${DSH_HOME:-$HOME/.dsh}"` 落到这里：答空 = 没有部署
         目录，readConfigFile 走默认配置（gitPath 空 → gitCmd 就是 'git'）。 */
      return Promise.resolve({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
    },
  }
  const handlers = new Map()
  const services = { shell: shellService }
  if (sessions !== undefined) services.sessions = sessions
  const ctx = { get: (n) => services[n], effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return { H: (n) => handlers.get(n), runs: runs }
}

let failed = 0
const check = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const wtRuns = (runs) => runs.filter((r) => r.command.indexOf("'worktree' 'list' '--porcelain'") >= 0)

/* 一份把每种形状都摆出来的 porcelain：主仓 + 带空格路径 + detached + bare +
   locked 带原因 + locked 不带原因 + prunable 带原因 + prunable 不带原因。 */
const PORCELAIN = [
  'worktree /tmp/gp57/ws',
  'HEAD aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
  'branch refs/heads/main',
  '',
  'worktree /tmp/gp57/wt dir with space',
  'HEAD bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
  'branch refs/heads/feature/one',
  '',
  'worktree /tmp/gp57/detached one',
  'HEAD cccc3333cccc3333cccc3333cccc3333cccc3333',
  'detached',
  '',
  'worktree /tmp/gp57/bare main',
  'bare',
  '',
  'worktree /tmp/gp57/locked why',
  'HEAD dddd4444dddd4444dddd4444dddd4444dddd4444',
  'branch refs/heads/locked-b',
  'locked 变更多，暂不动',
  '',
  'worktree /tmp/gp57/locked bare word',
  'HEAD eeee5555eeee5555eeee5555eeee5555eeee5555',
  'branch refs/heads/locked-c',
  'locked',
  '',
  'worktree /tmp/gp57/pruned why',
  'HEAD ffff6666ffff6666ffff6666ffff6666ffff6666',
  'branch refs/heads/pruned-b',
  'prunable gitdir 文件指向不存在的地方',
  '',
  'worktree /tmp/gp57/pruned bare word',
  'HEAD abcd7777abcd7777abcd7777abcd7777abcd7777',
  'branch refs/heads/pruned-c',
  'prunable',
  '',
].join('\n')

console.log('')
console.log('=== git/worktrees：porcelain 解析（空行分块 / 空格路径 / 剥短名 / 四个旗标） ===')
{
  porcelainText = PORCELAIN
  worktreeExit = 0
  worktreeStderr = ''
  const a = makeBody()
  const reply = await a.H('git/worktrees')({ sessionId: 's-x', repo: '/tmp/lab' })
  check('ok，答复的 repo 是请求点名的那个仓库',
    reply.ok === true && reply.repo === '/tmp/lab')
  check('空行分块：8 份记录都在（多一少一都是把块切错了）',
    Array.isArray(reply.worktrees) && reply.worktrees.length === 8)
  const wt = reply.worktrees
  check('主仓记录：path / HEAD / branch 全收，refs/heads/ 剥成短名 main，旗标全歇',
    wt[0].path === '/tmp/gp57/ws' && wt[0].head === 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111'
    && wt[0].branch === 'main' && wt[0].detached === false && wt[0].bare === false
    && wt[0].locked === false && wt[0].lockReason === '' && wt[0].prunable === false && wt[0].pruneReason === '')
  check('带空格的路径整行收下（worktree 关键字之后的原样），带斜杠的分支短名照剥',
    wt[1].path === '/tmp/gp57/wt dir with space' && wt[1].branch === 'feature/one')
  check('detached：旗标立、没有 branch（游离记录本来就没有这一行）',
    wt[2].path === '/tmp/gp57/detached one' && wt[2].detached === true && wt[2].branch === '')
  check('bare：旗标立、没有 HEAD 也没有 branch（bare 记录只有两行）',
    wt[3].path === '/tmp/gp57/bare main' && wt[3].bare === true && wt[3].head === '' && wt[3].branch === '')
  check('locked 带原因：原因 = 关键字之后那一段原文（非 ASCII 不被加工）',
    wt[4].locked === true && wt[4].lockReason === '变更多，暂不动')
  check('locked 不带原因：旗标立、原因是空串',
    wt[5].locked === true && wt[5].lockReason === '')
  check('prunable 带原因：原因同样原样收',
    wt[6].prunable === true && wt[6].pruneReason === 'gitdir 文件指向不存在的地方')
  check('prunable 不带原因：旗标立、原因是空串',
    wt[7].prunable === true && wt[7].pruneReason === '')
  check('workdir 跟请求的仓库走（git 落在那个目录里列工作树）',
    wtRuns(a.runs).length === 1 && wtRuns(a.runs)[0].workdir === '/tmp/lab')
}

console.log('')
console.log('=== git/worktrees：非零退出折成 ok:false（不另立错误通道） ===')
{
  porcelainText = 'worktree /tmp/gp57/never\n'
  worktreeExit = 128
  worktreeStderr = 'fatal: this operation must be run in a work tree'
  const b = makeBody()
  const bad = await b.H('git/worktrees')({ sessionId: 's-x', repo: '/tmp/lab' })
  check('exitCode 128：ok:false、error not-a-repository、worktrees 空表',
    bad.ok === false && bad.error === 'not-a-repository' && Array.isArray(bad.worktrees) && bad.worktrees.length === 0)
  check('git 的原话原样带回（stderr 一个字节不裁）',
    bad.stderr === 'fatal: this operation must be run in a work tree')
  check('答复仍记得是哪个仓库的账（repo 字段留着）', bad.repo === '/tmp/lab')

  worktreeExit = 127
  worktreeStderr = 'dsh-git-idea: no git on PATH'
  /* 独立一份 body：ok:false 也是 cached() 会收下的一格账（读没有拒绝，就没有重试），
     127 这一问得开新实例才走得到 shell。 */
  const noGit = await makeBody().H('git/worktrees')({ sessionId: 's-x', repo: '/tmp/lab' })
  check('127 + gitGuard 标记：noGit 自报（机器上没有 git，不是仓库的毛病）',
    noGit.ok === false && noGit.noGit === true)

  worktreeExit = 0
  worktreeStderr = ''
}

console.log('')
console.log('=== git/worktrees：命令形状（9b0c450，gitC + core.quotePath=false） ===')
{
  porcelainText = PORCELAIN
  worktreeExit = 0
  const c = makeBody()
  await c.H('git/worktrees')({ sessionId: 's-x', repo: '/tmp/lab' })
  const cmd = wtRuns(c.runs)[0].command
  const atLC = cmd.indexOf('LC_ALL=C')
  const atQuote = cmd.indexOf("'core.quotePath=false'")
  const atList = cmd.indexOf("'worktree' 'list' '--porcelain'")
  check('走 gitC：LC_ALL=C 在前（porcelain 的字面量不吃 locale 的账）', atLC >= 0)
  check('带 -c core.quotePath=false：locked 的非 ASCII 原因不被引成八进制',
    atQuote >= 0)
  check('问的还是 worktree list --porcelain（只读清单，一个字没多）', atList >= 0)
  check('顺序对：LC_ALL=C → quotePath → 清单命令（包裹层差一点整个语义就变了）',
    atLC >= 0 && atQuote > atLC && atList > atQuote)
  /* 反向钉一下旧路的死灰复燃：没有 quotePath 的同一条命令不算数。 */
  check('不是 d19cb35 那条光杆 git worktree list（改动前的形状回不来）',
    cmd.indexOf('LC_ALL=C ') >= 0 && cmd.indexOf('core.quotePath') >= 0)
}

console.log('')
console.log('=== git/worktrees：按仓库读缓存 + 缺省回退会话工作区 ===')
{
  porcelainText = PORCELAIN
  worktreeExit = 0
  const d = makeBody({ get: () => ({ header: { cwd: '/tmp/sess-ws' } }) })
  await d.H('git/worktrees')({ sessionId: 's-1', repo: '/tmp/r-a' })
  await d.H('git/worktrees')({ sessionId: 's-1', repo: '/tmp/r-a' })
  check('同一仓库问两次，worktree list 只落一次子进程（cached(repo, \'worktrees\') 命中）',
    wtRuns(d.runs).length === 1)
  await d.H('git/worktrees')({ sessionId: 's-1', repo: '/tmp/r-b' })
  check('换个仓库才是新的一次：第二格缓存，不共账', wtRuns(d.runs).length === 2)
  const fallback = await d.H('git/worktrees')({ sessionId: 's-1' })
  check('请求不点名仓库：回退会话工作区（会话桩的 cwd），workdir 跟着会话走',
    wtRuns(d.runs).length === 3 && wtRuns(d.runs)[2].workdir === '/tmp/sess-ws')
  check('回退那次答复的 repo 也落回会话工作区（客户端按它记账）',
    fallback.ok === true && fallback.repo === '/tmp/sess-ws')
}

if (failed > 0) {
  console.error('gp57-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
