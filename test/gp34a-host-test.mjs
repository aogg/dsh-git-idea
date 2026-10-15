import fs from 'node:fs'
import { spawn } from 'node:child_process'
const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

function runShell(spec) {
  return new Promise((res) => {
    /* DSH_HOME 指到 /tmp：插件配置就落在这里，而不是跑测试那个人的 ~/.dsh —— 他要是
       在真机上改过配置（比如设了 git 路径），那台机器的配置会悄悄改变这些断言的答案。 */
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: Object.assign({}, process.env, { DSH_HOME: '/tmp/gp34a-home' }) })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}
const handlers = new Map()
/* The service object is held by name because the Host half captures it once, at
   apply time (`const shell = ctx.get('shell')`): swapping `ctx.get` later would
   change nothing, so a test that wants to see the command line has to wrap this
   very object's `run`. */
const shellService = { resolve: r => r, run: runShell }
/* Everything the body reaches by name, held in one object so a suite can hand a
   service in for the length of one check and take it away again — the storage
   fallback below is exactly that. */
const services = { shell: shellService }
const ctx = {
  get: n => services[n],
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const TOOLS = new Map()
const harness = { defineTool: d => { TOOLS.set(d.name, d); return d }, registerTool: () => () => {}, handle(n, f) { handlers.set(n, f); return () => {} } }
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

const R = '/tmp/gp34-repo'
const O = '/tmp/gp34-origin'
const F = '/tmp/gp34-fork'
await sh(`rm -rf ${R} ${O} ${F} && mkdir -p ${R} && cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first && git clone -q --bare . ${O} && git remote add origin ${O} && git push -q -u origin main`, '/tmp')
const dated = (n, cmd) => `GIT_COMMITTER_DATE="2020-01-0${n}T00:00:00" GIT_AUTHOR_DATE="2020-01-0${n}T00:00:00" ${cmd}`
await sh(`git checkout -q -b ahead-one && git push -q -u origin ahead-one && ${dated(3, 'git commit -q --allow-empty -m "ahead tip"')}`, R)
await sh(`git checkout -q -b behind-one && git push -q -u origin behind-one && git checkout -q main && ${dated(4, 'git commit -q --allow-empty -m "main tip"')} && git push -q origin main && git checkout -q behind-one && git reset -q --hard HEAD~1`, R)
await sh(`git checkout -q main && git checkout -q -b local-only && ${dated(2, 'git commit -q --allow-empty -m "local tip"')}`, R)
await sh(`git push -q origin main:remote-only`, R)
/* 第二个远端 fork：也有一条 main（与本地同名 —— 多远端仓库的常态），外加一条
   fork 独有的分支。下面的断言守的就是「两个远端的 main 各自成行」。 */
await sh(`git init -q --bare ${F}`, '/tmp')
await sh(`git checkout -q main && git remote add fork ${F} && git push -q fork main && git push -q fork main:fork-only`, R)
await sh(`git fetch -q origin && git fetch -q fork`, R)
await sh(`git checkout -q main`, R)

const r = await H('git/branches')({ repo: R })
console.log('=== 数字领先/落后 ===')
for (const b of r.branches) {
  console.log('  ' + b.name.padEnd(12), 'track=' + (b.track || '-').padEnd(3), 'ahead=' + String(b.ahead).padEnd(3), 'behind=' + String(b.behind).padEnd(3), 'upstream=' + (b.upstream || '-'))
}
const ahead = r.branches.find(b => b.name === 'ahead-one')
const behind = r.branches.find(b => b.name === 'behind-one')
const main = r.branches.find(b => b.name === 'main')
console.log('  ahead-one 领先 1:', ahead.ahead === 1 && ahead.behind === 0, ' track 符号 >:', ahead.track === '>')
console.log('  behind-one 落后 1:', behind.behind === 1 && behind.ahead === 0, ' track 符号 <:', behind.track === '<')
console.log('  main 与上游一致:', main.ahead === 0 && main.behind === 0 && main.track === '=')
console.log('  local-only 没有上游:', r.branches.find(b => b.name === 'local-only').upstream === '')

console.log('')
console.log('=== 远端分支（多远端全量在列，同名不剔除）===')
console.log('  remotes:', JSON.stringify(r.remotes.map(x => x.name + '@' + x.remote)))
console.log('  有 remote-only:', r.remotes.some(x => x.name === 'remote-only' && x.remote === 'origin'))
console.log('  有 fork-only:', r.remotes.some(x => x.name === 'fork-only' && x.remote === 'fork'))
console.log('  两个远端的 main 各一行:', r.remotes.filter(x => x.name === 'main').map(x => x.remote).join(','))
console.log('  ahead-one / behind-one 也在:', r.remotes.some(x => x.name === 'ahead-one' && x.remote === 'origin'), r.remotes.some(x => x.name === 'behind-one' && x.remote === 'origin'))
console.log('  每行都带完整 ref:', r.remotes.every(x => x.ref === x.remote + '/' + x.name))
console.log('  current/previous:', r.current, '/', r.previous)

console.log('')
console.log('=== 检出远端分支（DWIM 建本地）===')
const sw = await H('git/checkout')({ repo: R, name: 'remote-only' })
const head = await sh('git rev-parse --abbrev-ref HEAD', R)
const up = await sh('git rev-parse --abbrev-ref --symbolic-full-name @{u}', R)
console.log('  ok =', sw.ok, ' 现在在 =', head.out.trim(), ' 上游 =', up.out.trim())
console.log('  切完列表里 local 有了；远端行照旧在（不再因本地同名而隐藏）:')
const after = await H('git/branches')({ repo: R })
console.log('   ', after.branches.some(b => b.name === 'remote-only'), after.remotes.some(x => x.name === 'remote-only' && x.remote === 'origin'))

console.log('')
console.log('=== 排序与字段没坏 ===')
const stamps = r.branches.map(b => b.committedAt)
console.log('  按最近提交倒序:', stamps.every((v, i) => i === 0 || stamps[i - 1] >= v))
console.log('  每行都有 head/subject:', r.branches.every(b => typeof b.head === 'string' && typeof b.subject === 'string'))

console.log('')
console.log('=== 非仓库 / 缓存 ===')
const bad = await H('git/branches')({ repo: '/tmp/gp34-nope' })
console.log('  不存在:', bad.ok, bad.error, JSON.stringify(bad.remotes))
await H('git/flush')({ repo: R })
const t0 = Date.now(); await H('git/branches')({ repo: R }); const cold = Date.now() - t0
const t1 = Date.now(); await H('git/branches')({ repo: R }); const hot = Date.now() - t1
console.log('  冷/热 =', cold + 'ms/' + hot + 'ms')

console.log('')
console.log('=== 繁体/中文 locale 下数字仍然正确 ===')
const env = Object.assign({}, process.env, { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' })
const r2 = await new Promise((res) => {
  const c = spawn('sh', ['-c', 'git for-each-ref "--format=%(refname:short) %(upstream:track)" refs/heads'], { cwd: R, env })
  let o = ''; c.stdout.on('data', b => o += b); c.on('close', () => res(o))
})
console.log('  同一台机器上 git 的原话:', JSON.stringify(r2.trim().split('\n').filter(l => l.indexOf('ahead-one') === 0 || l.indexOf('behind-one') === 0)))
await H('git/flush')({ repo: R })
const r3 = await H('git/branches')({ repo: R })
console.log('  固定 locale 后仍然 ahead=1:', r3.branches.find(b => b.name === 'ahead-one').ahead === 1, ' behind=1:', r3.branches.find(b => b.name === 'behind-one').behind === 1)

console.log('')
console.log('=== 搜索：字面量 / 正则 / 大小写 ===')
const S = '/tmp/gp40-search'
await sh('rm -rf ' + S + ' && mkdir -p ' + S, '/tmp')
await sh('git init -q . && git config user.email t@t && git config user.name t', S)
const MSGS = ['Fix the parser', 'fix the lexer', 'REFACTOR: parser', 'unrelated']
for (const m of MSGS) {
  await sh('echo x >> f.txt && git add -A', S)
  await sh('git commit -qm ' + JSON.stringify(m), S)
}
const graph = async (args) => { await H('git/flush')({ repo: S }); return await H('git/graph')(Object.assign({ repo: S }, args)) }
const literal = await graph({ search: 'parser' })
const caret = await graph({ search: '^fix' })
const reAny = await graph({ search: '^fix', regex: true })
const reCase = await graph({ search: '^fix', regex: true, caseSensitive: true })
const msgsOf = (g) => g.commits.map((c) => c.subject).join(' | ')
console.log('  字面量 parser        →', literal.commits.length, msgsOf(literal))
console.log('  字面量 ^fix（原样）  →', caret.commits.length, msgsOf(caret))
console.log('  正则 ^fix 忽略大小写 →', reAny.commits.length, msgsOf(reAny))
console.log('  正则 ^fix 区分大小写 →', reCase.commits.length, msgsOf(reCase))
let searchOk = true
/* 一次都不许静默通过：任何一条 ✗ 都要让这个文件以非 0 退出。之前只有搜索那一段
   会 exit(1)，后面段落里的失败只留一行红字 —— 那样的绿是假的。 */
let failedChecks = 0
const check = (label, value) => {
  if (value !== true) { searchOk = false; failedChecks += 1 }
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
check('默认仍是字面量 + 忽略大小写', literal.commits.length === 2 && caret.commits.length === 0)
check('正则开关生效', reAny.commits.length === 2)
check('大小写开关生效', reCase.commits.length === 1 && reCase.commits[0].subject === 'fix the lexer')
if (searchOk !== true) process.exit(1)

console.log('')
console.log('=== 分页、廉价身份读、轮询签名 ===')
await H('git/flush')({ repo: S })
const one = await H('git/graph')({ repo: S, maxCount: 1 })
const many = await H('git/graph')({ repo: S, maxCount: 10 })
check('要 1 条就给 1 条，并且说还有更多', one.commits.length === 1 && one.hasMore === true)
check('要的比历史多就全给，并且说没有了', many.commits.length === 4 && many.hasMore === false)
await H('git/flush')({ repo: S })
const ident = await H('git/panel')({ repo: S, quick: true })
const full = await H('git/panel')({ repo: S })
check('身份读给分支、不给工作区（并自报 partial）',
  ident.ok === true && ident.branch !== null && ident.partial === true && ident.staged.length === 0 && ident.untracked.length === 0)
check('完整读给工作区，且不再标 partial', full.ok === true && full.partial === undefined && Array.isArray(full.unstaged))
check('两种读不共用缓存键（先读便宜的不会污染完整读）', ident.partial === true && full.partial === undefined)
const cheap = await H('git/watch')({ repo: S })
const deep = await H('git/watch')({ repo: S, deep: true })
check('轮询签名默认不读工作区', cheap.ok === true && cheap.sig.indexOf('# branch.head') < 0 && cheap.sig.indexOf('F:') >= 0)
check('deep 的轮询才带上工作区状态', deep.sig.indexOf('# branch.head') >= 0)

/* 在终端里（或者 IDEA 里）自己切分支，插件必须看得见 —— 它靠的就是上面这条
   签名。签名里如果只有引用表 + HEAD 的 sha，那「两个分支指向同一个提交」就完全
   看不出来：`git switch -c` 永远是这样，快进合并之后也是这样。 */
console.log('')
console.log('=== 外面自己切分支，轮询签名必须看得见 ===')
const W = '/tmp/gp41-switch'
await sh('rm -rf ' + W + ' && mkdir -p ' + W, '/tmp')
await sh('git init -q -b main . && git config user.email t@t && git config user.name t && echo 1 > a.txt && git add -A && git commit -qm one && echo 2 > b.txt && git add -A && git commit -qm two', W)
await sh('git branch other main~1', W)
const sigOf = async () => (await H('git/watch')({ repo: W })).sig
const sigLine = (sig, key) => (sig.split('\n').find((l) => l.indexOf(key + ':') === 0) || '')

let moved = await sigOf()
await sh('git switch -q other', W)
const afterOther = await sigOf()
console.log('  ' + sigLine(afterOther, 'R'))
check('换到另一个提交上的分支：签名变了', moved !== afterOther)
check('签名里带着当前分支的名字', sigLine(afterOther, 'R').indexOf('ref: refs/heads/other') > 0)
const identAfter = await (async () => { await H('git/flush')({ repo: W }); return await H('git/panel')({ repo: W, quick: true }) })()
check('身份读跟着给出新分支（chip 显示的就是它）', identAfter.branch === 'other')

/* 同一个提交上的两个等长分支名，并且把 HEAD 的时间戳按住不动 —— 也就是
   「同一秒内切换」在签名上留下的全部痕迹。只有 HEAD 文件的内容能分辨它们。 */
await sh('git switch -q main && git branch aa && git branch bb && git switch -q aa', W)
const sameA = await sigOf()
await sh('touch -r .git/index .git/HEAD && git switch -q bb && touch -r .git/index .git/HEAD', W)
const sameB = await sigOf()
console.log('  aa → bb 前后的 R 行：\n    ' + sigLine(sameA, 'R') + '\n    ' + sigLine(sameB, 'R'))
check('同一个提交、等长名字、同一秒：签名仍然变了', sameA !== sameB)

/* `git switch -c` 是最常见的一种：新分支和原分支指向同一个提交。 */
const beforeNew = await sigOf()
await sh('git switch -q -c fresh', W)
const afterNew = await sigOf()
check('git switch -c 新分支（同一个提交）：签名变了', beforeNew !== afterNew)
const detachBefore = await sigOf()
await sh('git switch -q --detach main', W)
const detachAfter = await sigOf()
check('切到游离 HEAD：签名变了', detachBefore !== detachAfter)
await H('git/flush')({ repo: W })
const detached = await H('git/panel')({ repo: W, quick: true })
check('游离 HEAD 时身份读说 detached，chip 显示 HEAD', detached.branch === null && detached.detached === true)

console.log('')
console.log('=== 只认这一个目录：不向上找，也不往里看 ===')
/* 工作区是仓库就在它自己身上：`$dir/.git`（worktree 和子模块那里是个文件）。
   少了这道判断，git 会自己往上找 —— 面板会报出楼上某个仓库的分支，轮询也会跟着
   那个仓库的引用走。 */
const P = '/tmp/gp41-one-dir'
await sh('rm -rf ' + P + ' && mkdir -p ' + P + '/inner/deep', '/tmp')
await sh('git init -q -b main . && git config user.email t@t && git config user.name t && echo x > a.txt && git add -A && git commit -qm one', P)
const panelAt = async (dir) => { await H('git/flush')({ repo: dir }); return await H('git/panel')({ repo: dir, quick: true }) }
const watchAt = async (dir) => (await H('git/watch')({ repo: dir })).sig
const atRoot = await panelAt(P)
const atInner = await panelAt(P + '/inner')
const atDeep = await panelAt(P + '/inner/deep')
console.log('  仓库根目录      :', atRoot.ok === true ? '在 ' + atRoot.branch : atRoot.reason)
console.log('  它的子目录      :', atInner.ok !== true ? atInner.reason : '在 ' + atInner.branch)
check('仓库根目录本身照常是仓库', atRoot.ok === true && atRoot.branch === 'main')
check('仓库的子目录：不认楼上那个仓库', atInner.ok !== true && atInner.reason === 'not-a-repo')
check('再深一层也一样', atDeep.ok !== true && atDeep.reason === 'not-a-repo')
const innerSig = await watchAt(P + '/inner')
console.log('  子目录的轮询签名:', JSON.stringify(innerSig.replace(/\n/g, '|')))
check('子目录的签名里没有楼上仓库的引用', innerSig.indexOf('refs/heads') < 0 && innerSig.indexOf('F:refs') < 0)

/* 反过来：在子目录里自己建一个仓库，它就该被认出来 —— 规则看的是这个目录，
   不是「不许有子目录」 */
await sh('git init -q -b inner . && git config user.email t@t && git config user.name t', P + '/inner')
const innerOwn = await panelAt(P + '/inner')
const innerSig2 = await watchAt(P + '/inner')
check('子目录自己成了仓库，就认它', innerOwn.ok === true && innerOwn.branch === 'inner')
check('而且这时候签名变了（轮询能发现刚 init 的目录）', innerSig !== innerSig2)

/* 空目录 / 随便一个目录：就是「不是仓库」，不再偷看里面有什么 */
const E = '/tmp/gp41-empty'
await sh('rm -rf ' + E + ' && mkdir -p ' + E, '/tmp')
const empty = await panelAt(E)
check('空目录也只是「不是仓库」，没有别的花样', empty.ok !== true && empty.reason === 'not-a-repo')
check('连目录里有什么都不看（脚本里没有 ls）', body.indexOf('ls -A') < 0 && body.indexOf('ls -1') < 0)

/* ── 刚 init、还没有第一个提交的仓库 ──

   这是插件自己的引导页「在此初始化仓库」刚做完的样子，也是每个仓库的第一个状态：
   HEAD 写着 `refs/heads/inner`，而 `refs/heads` 是空的。以前这里会红着说「不是 git
   仓库」—— 历史页上一个字都不对，而仓库其实好好的，只是还没有提交。上面那个
   `P/inner` 正好就是这个样子（第 228 行只 init 没提交）。 */
const DET = '/tmp/gp41-detached'
await sh('rm -rf ' + DET + ' && mkdir -p ' + DET, '/tmp')
await sh('git init -q -b main . && git config user.email t@t && git config user.name t && echo d > d.txt && git add -A && git commit -qm one && git checkout -q --detach HEAD', DET)

await H('git/flush')({ repo: P + '/inner' })
const unbornGraph = await H('git/graph')({ repo: P + '/inner' })
const unbornRefs = await H('git/refs')({ repo: P + '/inner' })
const unbornBranches = await H('git/branches')({ repo: P + '/inner' })
console.log('  还没提交的仓库:', JSON.stringify({
  graph: unbornGraph.ok, unborn: unbornGraph.unborn, error: unbornGraph.error,
  commits: unbornGraph.commits.length, refs: unbornRefs.current, current: unbornBranches.current,
}))
check('一个提交都没有：历史是空的，不是「不是仓库」',
  unbornGraph.ok === true && unbornGraph.unborn === true && unbornGraph.commits.length === 0
  && unbornGraph.error === undefined)
check('分支树上的当前分支照样有名字（不是「游离 HEAD」）',
  unbornRefs.ok === true && unbornRefs.current.length === 1 && unbornRefs.current[0] === 'inner')
check('面板头上那行也一样（不是 HEAD）', unbornBranches.ok === true && unbornBranches.current === 'inner')
check('但那个分支不进 ref 清单（它还不是一个 ref，列出来就成了点得动的不存在的东西）',
  unbornRefs.local.length === 0 && unbornBranches.branches.length === 0)

/* 负对照：这三种都不能被当成「还没提交」——
   第一版把 `repoHere(...)` 当布尔用（它返回的是一段 shell 文本，永远为真），
   于是不是仓库的目录也被说成「还没提交」；这一条就是那时候先红的。 */
await H('git/flush')({ repo: E })
const emptyGraph = await H('git/graph')({ repo: E })
check('（对照）根本不是仓库的目录：仍然是「不是仓库」，不是空历史',
  emptyGraph.ok !== true && emptyGraph.error === 'not-a-repository' && emptyGraph.unborn === undefined)
await H('git/flush')({ repo: DET })
const detGraph = await H('git/graph')({ repo: DET })
const detRefs = await H('git/refs')({ repo: DET })
check('（对照）真游离 HEAD：历史读得出来，当前分支仍然是空的',
  detGraph.ok === true && detGraph.unborn === undefined && detGraph.commits.length === 1
  && detRefs.ok === true && detRefs.current.length === 0)
await H('git/flush')({ repo: P })
const bornGraph = await H('git/graph')({ repo: P })
check('（对照）有提交的分支上不会冒出 unborn',
  bornGraph.ok === true && bornGraph.unborn === undefined && bornGraph.commits.length === 1)

/* 这一问是「只在需要时才问」的：ref 表已经标出当前分支的仓库，一次都不多花。 */
const refsRealRun = shellService.run
const refCommands = []
shellService.run = (spec) => { refCommands.push(spec.command); return refsRealRun(spec) }
await H('git/flush')({ repo: P })
await H('git/refs')({ repo: P })
const bornRefCommands = refCommands.filter((c) => c.indexOf('for-each-ref') >= 0 || c.indexOf('symbolic-ref') >= 0)
refCommands.length = 0
await H('git/flush')({ repo: P + '/inner' })
await H('git/refs')({ repo: P + '/inner' })
const unbornRefCommands = refCommands.filter((c) => c.indexOf('for-each-ref') >= 0 || c.indexOf('symbolic-ref') >= 0)
shellService.run = refsRealRun
console.log('  git/refs 里的进程数：普通仓库', bornRefCommands.length, '／还没提交的', unbornRefCommands.length)
check('（对照）已经标出当前分支的仓库一次都不多问；还没提交的才补问一次 HEAD',
  bornRefCommands.length === 1 && bornRefCommands[0].indexOf('for-each-ref') >= 0
  && unbornRefCommands.length === 2 && unbornRefCommands[1].indexOf('symbolic-ref') >= 0)

console.log('')
console.log('=== 分支树需要的领先/落后 ===')
await H('git/flush')({ repo: R })
const refTree = await H('git/refs')({ repo: R })
const refOf = (n) => refTree.local.find((e) => e.data === n)
const aheadOne = refOf('ahead-one')
const behindOne = refOf('behind-one')
console.log('  ahead-one:', JSON.stringify(aheadOne))
check('refs 带上上游名', aheadOne !== undefined && aheadOne.upstream.length > 0)
check('refs 带上领先/落后', aheadOne.ahead === 1 && behindOne.behind === 1)
check('refs 带上最后提交时间', typeof aheadOne.at === 'number' && aheadOne.at > 0)
if (searchOk !== true) process.exit(1)

console.log('')
console.log('=== 写操作跑在谁的沙箱里 ===')
/* 不带策略的 shell 调用拿到的是**部署默认**（实测：workspace-write，root 是部署
   自己的目录），不是这个会话的策略 —— 实测里会话是 danger-full-access。于是任何
   写操作（git 要建 .git/index.lock）在别的目录上都被拒，而读一切正常。 */
const specs = []
const fakePolicy = { calls: 0, resolve(request) { this.calls += 1; return { mode: 'danger-full-access', workspaceRoot: '/home/mayou/work/dsh-git-map', sessionId: request.session != null ? request.session.id : undefined } } }
const fakeSessions = { get(id) { return id === 's-known' ? { id: id, header: { cwd: '/tmp/gp41-one-dir' } } : null } }
const handlers2 = new Map()
const ctx2 = {
  get: (n) => {
    if (n === 'shell') {
      return {
        resolve: (r) => r,
        run: async (spec) => {
          specs.push(spec)
          /* `git init` first asks whether the path is a directory, and a force
             push with no branch asks which branch is checked out. */
          const text = spec.command.indexOf('echo dir') >= 0 ? 'dir\n' : (spec.command.indexOf('symbolic-ref') >= 0 ? 'main\n' : '')
          return { exitCode: 0, stdout: { text: text }, stderr: { text: '' } }
        },
      }
    }
    if (n === 'sandboxPolicy') return fakePolicy
    if (n === 'sessions') return fakeSessions
    return undefined
  },
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const harness2 = { handle(n, f) { handlers2.set(n, f); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  ctx2, harness2, console, s => Buffer.from(s, 'binary').toString('base64'),
  s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx2)
const H2 = n => handlers2.get(n)

await H2('git/flush')({ repo: '/tmp/gp41-one-dir' })
await H2('git/panel')({ repo: '/tmp/gp41-one-dir', quick: true, sessionId: 's-known' })
const withSession = specs[specs.length - 1].sandboxPolicy
console.log('  带 sessionId 的请求 →', JSON.stringify(withSession))
check('请求带上了那个会话解析出来的沙箱策略',
  withSession !== undefined && withSession.mode === 'danger-full-access' && withSession.sessionId === 's-known')

specs.length = 0
await H2('git/flush')({ repo: '/tmp/gp41-one-dir' })
await H2('git/panel')({ repo: '/tmp/gp41-one-dir', quick: true, sessionId: 's-unknown' })
check('会话找不到时不硬编一个策略（交回 shell 层回落）', specs[specs.length - 1].sandboxPolicy === undefined)

specs.length = 0
await H2('git/flush')({ repo: '/tmp/gp41-one-dir' })
await H2('git/panel')({ repo: '/tmp/gp41-one-dir', quick: true })
check('完全没有 sessionId 时也一样不编', specs[specs.length - 1].sandboxPolicy === undefined)

/* `git init` 是这些 RPC 里唯一自己拼过入参的：它传了 {repo}，sessionId 就掉了，
   于是真正要写 .git 的那条命令拿到的是部署默认策略 —— 一个读得到、却写不进去的
   目录，报回来还是 git 的 "Permission denied"。 */
specs.length = 0
const initReply = await H2('git/init')({ sessionId: 's-known', repo: '/tmp/gp41-one-dir', branch: 'main' })
const initSpec = specs[specs.length - 1]
console.log('  git/init ->', JSON.stringify(specs.map((x) => x.command)), '策略:', JSON.stringify(initSpec.sandboxPolicy))
check('git/init 的写入命令也带着那个会话的策略（它要建 .git）',
  initReply.ok === true && initSpec.sandboxPolicy !== undefined && initSpec.sandboxPolicy.sessionId === 's-known')

/* 被沙箱拒了要和「仓库有问题」分开说 */
specs.length = 0
const previousRun = ctx2.get
const handlers3 = new Map()
const ctx3 = {
  get: (n) => {
    if (n === 'shell') {
      return {
        resolve: (r) => r,
        run: async () => ({ exitCode: 1, stdout: { text: '' }, stderr: { text: "fatal: Unable to create '/x/.git/index.lock': Permission denied" }, sandbox: { mode: 'workspace-write', denied: true } }),
      }
    }
    if (n === 'sandboxPolicy' || n === 'sessions') return undefined
    return undefined
  },
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const harness3 = { handle(n, f) { handlers3.set(n, f); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  ctx3, harness3, console, s => Buffer.from(s, 'binary').toString('base64'),
  s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx3)
const denied = await handlers3.get('git/stage')({ repo: '/x', paths: ['a.txt'] })
console.log('  被拒的答复:', JSON.stringify({ ok: denied.ok, sandboxDenied: denied.sandboxDenied, stderr: denied.stderr.slice(0, 40) }))
check('被沙箱拒绝时答复里明说是沙箱拒绝的', denied.ok !== true && denied.sandboxDenied === true)
check('git 的原话也还在', denied.stderr.indexOf('index.lock') >= 0)

/* ── 机器上没有 git ──

   `repoHere` 是 `[ -e "$dir/.git" ]`：目录是不是仓库由文件系统回答，不需要 git。
   于是 git 不在 PATH 上时，一个真仓库照样被认成仓库，而
   `gd=$(git … rev-parse --absolute-git-dir 2>/dev/null)` 拿到空串 —— 脚本就按
   「这里没有 .git」走了，面板首页报「这个目录不是 Git 仓库」，并且把路径输入框
   关掉：一条读者无法执行的诊断，而完整读那一屏说的是另一回事（git 执行失败）。

   这里把 PATH 指到一个空目录，其余一切照旧：命令文本、解析、答复都是插件自己的。
   空目录连 stat/cat 也没有，但那正是「机器上什么都没有」的样子。 */
const NOGIT_PATH = '/tmp/gp34-nogit-path'
const NG = '/tmp/gp34-nogit-repo'
const NGE = '/tmp/gp34-nogit-empty'
fs.mkdirSync(NOGIT_PATH, { recursive: true })
await sh(`rm -rf ${NG} ${NGE} && mkdir -p ${NG} ${NGE} && cd ${NG} && git init -q -b main && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first && echo b > b.txt`, '/tmp')

let nogitRuns = 0
const handlers4 = new Map()
const ctx4 = {
  get: (n) => (n === 'shell' ? {
    resolve: (r) => r,
    run: (spec) => {
      nogitRuns += 1
      return new Promise((res) => {
        const c = spawn('/bin/sh', ['-c', spec.command], {
          cwd: spec.workdir,
          env: Object.assign({}, process.env, { PATH: NOGIT_PATH }),
        })
        let o = '', e = ''
        c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
        c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
        c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
      })
    },
  } : undefined),
  effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
const harness4 = { handle(n, f) { handlers4.set(n, f); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  ctx4, harness4, console, s => Buffer.from(s, 'binary').toString('base64'),
  s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx4)
const H4 = n => handlers4.get(n)

const ngHead = (await sh('git rev-parse --short HEAD', NG)).out.trim()
console.log('')
console.log('=== 机器上没有 git ===')
console.log('  （对照用的）真仓库:', NG, ngHead)
check('先确认 fixture 本身是个有提交的仓库（不然下面那些绿都是空的）', ngHead.length > 0)
const ngIdent = await H4('git/panel')({ repo: NG, quick: true })
const ngFull = await H4('git/panel')({ repo: NG })
console.log('  身份读:', JSON.stringify({ ok: ngIdent.ok, reason: ngIdent.reason, stderr: ngIdent.stderr }))
console.log('  完整读:', JSON.stringify({ ok: ngFull.ok, reason: ngFull.reason, stderr: ngFull.stderr }))
check('身份读说的是「找不到 git」，不是「这个目录不是仓库」', ngIdent.ok !== true && ngIdent.reason === 'no-git')
check('首帧和完整读一个口径（一屏说一个说法是最坏的）', ngFull.ok !== true && ngFull.reason === 'no-git')
check('答复里没有假的 stderr（原因已经在 reason 里说清了）', ngIdent.stderr === '' && ngFull.stderr === '')

/* 负对照：同一个仓库，PATH 正常时一个 no-git 都不许冒出来 —— 判据本身写错的话，
   这一条会先红，而不是等用户在一台装了 git 的机器上看到「找不到 git」。 */
await H('git/flush')({ repo: NG })
const okIdent = await H('git/panel')({ repo: NG, quick: true })
const okFull = await H('git/panel')({ repo: NG })
check('（对照）git 在的时候，两种读都正常，且没有 no-git 这个理由',
  okIdent.ok === true && okIdent.branch === 'main' && okIdent.reason === undefined
  && okFull.ok === true && okFull.reason === undefined && okFull.untracked.length === 1)
check('（对照）正常答复里也没有 noGit 标志', okFull.noGit === undefined
  && (await H('git/stage')({ repo: NG, paths: ['b.txt'] })).noGit === false)

/* 面板之外的那些读：它们不经过 reason 这条路，各自带一个 noGit 标志 */
const ngGraph = await H4('git/graph')({ repo: NG, maxCount: 5 })
const ngBranches = await H4('git/branches')({ repo: NG })
const ngRefs = await H4('git/refs')({ repo: NG })
const ngAuthors = await H4('git/authors')({ repo: NG })
const ngDiff = await H4('git/diff')({ repo: NG, mode: 'worktree', path: 'a.txt' })
const ngUntracked = await H4('git/untracked')({ repo: NG, dir: 'sub' })
const ngDetail = await H4('git/commit-detail')({ repo: NG, hash: 'deadbeef' })
const ngStage = await H4('git/stage')({ repo: NG, paths: ['a.txt'] })
const ngCommit = await H4('git/commit')({ repo: NG, message: 'x' })
const ngInit = await H4('git/init')({ repo: NGE })
const readFlags = { graph: ngGraph.noGit, branches: ngBranches.noGit, refs: ngRefs.noGit, authors: ngAuthors.noGit, diff: ngDiff.noGit, untracked: ngUntracked.noGit, detail: ngDetail.noGit }
console.log('  各条读的 noGit 标志:', JSON.stringify(readFlags))
console.log('  各条写的 noGit 标志:', JSON.stringify({ stage: ngStage.noGit, commit: ngCommit.noGit, init: ngInit.noGit }))
check('每一条读失败都自报「机器上没有 git」',
  ngGraph.ok !== true && ngBranches.ok !== true && ngRefs.ok !== true && ngAuthors.ok !== true
  && ngDiff.ok !== true && ngUntracked.ok !== true && ngDetail.ok !== true
  && Object.keys(readFlags).every((k) => readFlags[k] === true))
check('每一条写失败也一样（暂存、提交、初始化都在内）',
  ngStage.ok !== true && ngCommit.ok !== true && ngInit.ok !== true
  && ngStage.noGit === true && ngCommit.noGit === true && ngInit.noGit === true)
const okGraph = await H('git/graph')({ repo: NG, maxCount: 5 })
check('（对照）同一批调用在 git 在的时候，没有一条说自己 noGit',
  ngGraph.noGit === true && okGraph.noGit === undefined)

/* 这个判据是 shell 内建，不是又一次 spawn：一笔身份读仍然只起一个进程。 */
await H4('git/flush')({ repo: NG })
nogitRuns = 0
await H4('git/panel')({ repo: NG, quick: true })
const oneRead = nogitRuns
await H('git/flush')({ repo: NG })
const normalRuns = []
const realRunNogit = shellService.run
shellService.run = (spec) => { normalRuns.push(spec.command); return realRunNogit(spec) }
const normalReply = await H('git/panel')({ repo: NG, quick: true })
shellService.run = realRunNogit
console.log('  一笔身份读起的进程数：没有 git', oneRead, '／有 git', normalRuns.length)
check('判据不多起进程（那边 1 个，这边也 1 个）', oneRead === 1 && normalRuns.length === 1)
check('判据确实进了命令文本（两边都带这一行，而且命令词只有一个来源）',
  body.indexOf("'command -v ' + gitCmd()") >= 0
  && body.indexOf("if ! command -v ' + gitCmd()") >= 0
  && (body.match(/function gitGuard\(\)/g) || []).length === 1)
check('（对照）判据在有 git 时通过，这一读照常拿到分支',
  normalRuns[0].indexOf('command -v git') >= 0
  && normalReply.ok === true && normalReply.branch === 'main')

/* 轮询读的是签名，不是仓库状态：没有 git 时它照样安静地回答，而且两次一样 ——
   签名一直在变的话，chip 会每隔几秒重载一次面板。 */
const ngWatch1 = await H4('git/watch')({ repo: NG, deep: true })
const ngWatch2 = await H4('git/watch')({ repo: NG, deep: true })
check('没有 git 时轮询签名稳定（不会把面板拖进重载循环）',
  ngWatch1.ok === true && ngWatch1.sig === ngWatch2.sig)

/* ── 提交身份：机器上的第二件事 ──

   `git commit` 在没有作者身份时整个失败，给的是八行英文，而这件事和仓库无关：身份
   写在 git 自己的配置里，选什么名字只有读者能定。判据不许去认那八行 —— git 按机器
   语言翻译它，而且它有好几种写法。这里问的是 `git var GIT_AUTHOR_IDENT`，也就是
   `git commit` 自己拼身份时走的那条路，任何语言下都是同一个退出码。

   fixture 把空字符串写进**仓库本地**配置：本地的空值压得住这台机器上的全局身份，
   所以「git 认不出作者」是这个 fixture 的事实，而不是某台机器的偶然 —— 下面第一条
   断言就是在守这件事，它要是红了，说明 fixture 已经不成立了。 */

console.log('')
console.log('=== 提交身份（提交被拒的原因不在仓库里）===')
const NID = '/tmp/gp34-noid'
await sh(`rm -rf ${NID} && mkdir -p ${NID} && cd ${NID} && git init -q -b main .`
  + ` && git config user.name '' && git config user.email '' && echo a > a.txt && git add -A`, '/tmp')
const nidProbe = await sh('git var GIT_AUTHOR_IDENT >/dev/null 2>&1; echo $?', NID)
const nidCommit = await sh('git commit -m x 2>&1 | tail -1', NID)
check('先确认 fixture 本身没有作者身份（不然下面那些绿都是空的）', nidProbe.out.trim() === '128')
console.log('  fixture 里的提交被拒于:', nidCommit.out.trim())

await H('git/flush')({ repo: NID })
const nidPanel = await H('git/panel')({ repo: NID })
console.log('  面板读:', JSON.stringify({ ok: nidPanel.ok, branch: nidPanel.branch, staged: nidPanel.staged.length, needsIdentity: nidPanel.needsIdentity }))
check('面板整树读里带着「这台机器没有提交身份」',
  nidPanel.ok === true && nidPanel.branch === 'main' && nidPanel.staged.length === 1
  && nidPanel.needsIdentity === true)

const identCommitCommands = []
const realRunIdent = shellService.run
shellService.run = (spec) => { identCommitCommands.push(spec.command); return realRunIdent(spec) }
const nidCommitReply = await H('git/commit')({ repo: NID, message: 'first' })
shellService.run = realRunIdent
console.log('  被拒的提交起的进程:', identCommitCommands.map((c) => (c.indexOf('GIT_AUTHOR_IDENT') >= 0 ? 'git var' : 'git ' + c.split('\n')[1].slice(4, 30))))
console.log('  被拒的提交:', JSON.stringify({ ok: nidCommitReply.ok, exitCode: nidCommitReply.exitCode, needsIdentity: nidCommitReply.needsIdentity, stderr: nidCommitReply.stderr.trim().split('\n').slice(-1)[0] }))
check('提交失败时答复里明说是身份的问题（不让读者自己去猜那八行）',
  nidCommitReply.ok !== true && nidCommitReply.exitCode !== 0 && nidCommitReply.needsIdentity === true)
check('判据只在那一次失败之后才问（成功路径一次都不多花）',
  identCommitCommands.length === 2
  && identCommitCommands[0].indexOf('GIT_AUTHOR_IDENT') < 0
  && identCommitCommands[1].indexOf('GIT_AUTHOR_IDENT') >= 0)

/* 负对照三条：这一个是同一类误诊的三张脸 —— 判据写松成「提交失败了」、写松成
   「这个仓库读过一次没有身份」，都会在这里先红。 */
await H('git/flush')({ repo: R })
const okPanel = await H('git/panel')({ repo: R })
check('（对照）有身份的仓库：面板读里这个标志是 false（不是 undefined —— 见末尾那条规矩）', okPanel.ok === true && okPanel.needsIdentity === false)
await sh('printf "id\\n" > id.txt', R)
const okCommit = await H('git/commit')({ repo: R, message: 'identity is fine', stageAll: true })
check('（对照）有身份的仓库：提交成功，成功路径上也没有这个标志',
  okCommit.ok === true && okCommit.needsIdentity === undefined)
const emptyCommit = await H('git/commit')({ repo: R, message: 'nothing left to commit' })
check('（对照）同一个仓库里因为别的原因失败时，不会被说成身份问题',
  emptyCommit.ok !== true && emptyCommit.needsIdentity === false)

/* 会写提交对象的命令不止「提交」一个：拣选、还原、合并的继续都在造提交，身份缺失在
   它们身上同样是那个失败。而 `git add`、`git branch -d`、中止这类命令在没有身份的
   机器上照跑 —— 把「这台机器没有身份」挂在它们身上，等于让读者去修一个没坏的东西。 */
const NID2 = '/tmp/gp34-noid2'
await sh(`rm -rf ${NID2} && mkdir -p ${NID2} && cd ${NID2} && git init -q -b main .`
  + ` && git -c user.name=T -c user.email=t@t commit -q --allow-empty -m base`
  + ` && git config user.name '' && git config user.email ''`, '/tmp')
await H('git/flush')({ repo: NID2 })
const revertReply = await H('git/sequence')({ repo: NID2, op: 'revert', action: 'start', target: 'HEAD' })
console.log('  没有身份时的还原:', JSON.stringify({ ok: revertReply.ok, exitCode: revertReply.exitCode, needsIdentity: revertReply.needsIdentity, stderr: revertReply.stderr.trim().split('\n').slice(-1)[0] }))
check('还原也要造提交 → 没有身份时照样报身份', revertReply.ok !== true && revertReply.needsIdentity === true)
const deleteReply = await H('git/branch-delete')({ repo: NID2, name: 'no-such-branch' })
check('（对照）不造提交的操作失败时，不许挂上身份这件事',
  deleteReply.ok !== true && deleteReply.needsIdentity === undefined)
const stageReply = await H('git/stage')({ repo: NID2, paths: ['no-such-file'] })
check('（对照）暂存失败也一样（git add 在没有身份的机器上本来就跑得动）',
  stageReply.ok !== true && stageReply.needsIdentity === undefined)

/* 面板读里的那一行只在整树读里，而且落在 `$gd` 的守卫后面：不在仓库里时那一问没有
   意义，git 也会为它去问一个不存在的仓库。 */
await H('git/flush')({ repo: R })
const quickCommands = []
const panelCommands = []
shellService.run = (spec) => {
  quickCommands.push(spec.command)
  return realRunIdent(spec)
}
const quickReply = await H('git/panel')({ repo: R, quick: true })
shellService.run = (spec) => { panelCommands.push(spec.command); return realRunIdent(spec) }
const fullReply = await H('git/panel')({ repo: R })
shellService.run = realRunIdent
check('廉价读里没有这一行（身份只影响提交区，chip 不为它多起进程）',
  quickCommands.length === 1 && quickCommands[0].indexOf('GIT_AUTHOR_IDENT') < 0
  && quickReply.ok === true && fullReply.ok === true)
check('整树读里那一条只在 $gd 的守卫里面（不在仓库里就不问）',
  panelCommands.length === 1
  && panelCommands[0].indexOf('GIT_AUTHOR_IDENT') >= 0
  && panelCommands[0].indexOf('if [ -n "$gd" ]; then') < panelCommands[0].indexOf('GIT_AUTHOR_IDENT')
  && /\n\s*LC_ALL=C git -C [^\n]*GIT_AUTHOR_IDENT[^\n]*\n\s*fi\n/.test(panelCommands[0]))
check('那一条在源码里也只有一处（判据不许有第二份写法）',
  (body.match(/GIT_AUTHOR_IDENT >\/dev\/null 2>&1 \|\| printf/g) || []).length === 1)

/* ── 读操作不许抢 index.lock ──

   一个 `git status` 会顺手刷新 index 的 stat 缓存 —— 也就是说它会拿
   .git/index.lock。轮询的面板、被并发调用的模型工具，只要撞上别人正在
   `git add`，输的就是别人（"Unable to create index.lock"）。这里的规矩：
   所有读路径都带 --no-optional-locks，读就只是读。

   顺带记一个查错记录：一次 fetch 触发的后台 auto-gc 被当成元凶，但 gc 根本
   不碰 index.lock（它跑的是 pack-objects --indexed-objects，只读 index）。
   会写 index 的只有 index 的写者，而 `git status` 就是其中一个。 */

console.log('')
console.log('=== 读操作不写 index（也就不抢 index.lock）===')
const LOCK = '/tmp/gp34-lock'
await sh(`rm -rf ${LOCK} && mkdir -p ${LOCK} && cd ${LOCK} && git init -q -b main && git config user.email t@t && git config user.name T && seq 1 50 > f && git add f && git commit -qm init`, '/tmp')
const indexStamp = async () => (await sh('stat -c %y .git/index', LOCK)).out.trim()

/* 先把 index 里的 stat 缓存弄过期 —— 不然裸 status 也懒得重写，对照就白测了 */
await sh('touch f', LOCK)
const beforeBare = await indexStamp()
await sh('git status --porcelain >/dev/null', LOCK)
const afterBare = await indexStamp()
check('对照组：裸 git status 确实会重写 index（这个 fixture 能触发它）', beforeBare !== afterBare)

await sh('touch f', LOCK)
const beforePanel = await indexStamp()
await H('git/flush')({ repo: LOCK })
const panelRead = await H('git/panel')({ repo: LOCK })
const afterPanel = await indexStamp()
console.log('  面板完整读取:', panelRead.ok === true ? 'ok' : String(panelRead.error), ' index 有没被动:', beforePanel !== afterPanel)
check('面板的完整读取没有写 index', panelRead.ok === true && beforePanel === afterPanel)

/* 这条读以前有两个面：面板的 RPC，和模型的 `git_status` 工具。工具撤了，只剩面板
   这一面 —— 上面那条断言钉的就是它，这里不再有第二条通路要照顾。 */

/* 差异读（`git/diff`）照同一套规矩，而且这里只钉能钉住的那一件事。

   先说量到的事实（20 次一组，同一台机器）：裸 `git diff` 在 `touch f` 之后
   **2/20 次**重写了 .git/index，带 `--no-optional-locks` 的 **0/20** 次，而裸
   `git status` 是 **20/20**。也就是说这条读确实会碰 index，但只在少数状态下
   （stat 缓存过期那一类）——所以「跑一次、比 mtime」这种测法本身是不稳的：它
   在带标志时也可能偶尔撞上（本套件在 Node 这一侧见过一次）。能稳定钉住的是
   argv：四种模式发出去的每一条命令，标志都在子命令前面。 */
const diffCommands = []
const realRun = shellService.run
shellService.run = function (spec) { diffCommands.push(spec.command); return realRun(spec) }
await sh("printf 'x\\n' > untr.txt", LOCK)
const lockHead = (await sh('git rev-parse HEAD', LOCK)).out.trim()
await H('git/diff')({ repo: LOCK, mode: 'worktree', path: 'f' })
await H('git/diff')({ repo: LOCK, mode: 'staged', path: 'f' })
await H('git/diff')({ repo: LOCK, mode: 'untracked', path: 'untr.txt' })
await H('git/diff')({ repo: LOCK, mode: 'commit', path: 'f', ref: lockHead })
shellService.run = realRun
console.log('  四种模式的命令:')
for (const cmd of diffCommands) console.log('    ' + cmd)
check('四种模式的命令里都带着 --no-optional-locks，而且在子命令前面',
  diffCommands.length === 4 && diffCommands.every(function (cmd) {
    const at = cmd.indexOf("'--no-optional-locks'")
    return at >= 0 && at < cmd.search(/'diff'|'show'/)
  }))

/* 规矩写死在源码里：以后再加一条读状态的地方，忘了标志就红。
   只认真正的调用行（`git -C …` 的 shell 串，或 `git(args, […])` 的参数表），
   免得某段注释里提了一句 `git status` 也算进来。 */
const statusLines = body.split('\n').map((l, i) => ({ n: i + 1, l: l }))
  .filter((x) => x.l.indexOf('--porcelain') >= 0 && x.l.indexOf('status') >= 0
    && (x.l.indexOf('gitCmd()') >= 0 || x.l.indexOf('git(args,') >= 0))
const unguarded = statusLines.filter((x) => x.l.indexOf('no-optional-locks') < 0)
console.log('  源码里读状态的调用:', statusLines.length, '条，没带标志的:', unguarded.length)
for (const x of unguarded) console.log('    L' + x.n + ': ' + x.l.trim().slice(0, 80))
check('每一条读状态的 git 调用都带 --no-optional-locks', statusLines.length >= 3 && unguarded.length === 0)

/* ── 按路径读，而不是按整棵树读 ──

   `git status` 会 stat 每一个被跟踪的文件、走遍每一个未跟踪目录，而在一个
   Windows 挂载的工作区上这就是它全部的开销。在读者那台机器上量到的（同一个仓库，
   同一个时刻）：整棵树 7.4s（冷的时候 13.6s），`-uno` 5.3s，`--untracked-files=all`
   13.0s —— 而**同一条命令只问变更页正在显示的那 36 个路径是 0.5s**。所以读可以
   带上它要问的路径，答案只说这些路径（并自报 partial），客户端把它们折进屏幕上
   那份快照里。路径来自客户端，所以每一个都过 diff 用的那道关卡，条数也有上限。 */
console.log('')
console.log('=== 按路径读（pathspec），而不是整棵树 ===')
const pathCommands = []
const realRunForPaths = shellService.run
shellService.run = function (spec) { pathCommands.push(spec.command); return realRunForPaths(spec) }
await sh("printf 'more\\n' >> f && git add -- f", LOCK)
const targeted = await H('git/panel')({ repo: LOCK, paths: ['f'] })
shellService.run = realRunForPaths
console.log('  只问 f 的那次:', JSON.stringify({ partial: targeted.partial, paths: targeted.paths, branch: targeted.branch }))
console.log('  它说 f 的状态:', targeted.staged.map((e) => e.code + ' ' + e.path).join(',') || '(不在索引里)',
  '| 未跟踪:', JSON.stringify(targeted.untracked))
console.log('  命令:', pathCommands[pathCommands.length - 1])
check('按路径的读自报 partial，并且把问的路径原样带回来',
  targeted.ok === true && targeted.partial === true && targeted.paths.length === 1 && targeted.paths[0] === 'f')
check('命令里确实带着 pathspec（在 -- 之后）',
  pathCommands.length >= 1 && /status --porcelain=v2 --branch --untracked-files=normal -- 'f'/.test(pathCommands[pathCommands.length - 1]))
check('答案只说这些路径（整树读里有的 untr.txt 不在这里）',
  targeted.untracked.length === 0 && targeted.staged.length === 1 && targeted.staged[0].path === 'f')
check('分支、领先落后照旧作答（路径不影响身份那半边）',
  targeted.branch !== null && typeof targeted.ahead === 'number' && typeof targeted.behind === 'number')

/* 每个路径都过 diff 那道关卡：绝对路径、往上走、NUL 一律丢掉，留下合法的那个 */
const guarded = await H('git/panel')({ repo: LOCK, paths: ['/etc/hostname', '../outside', 'a\u0000b', 'f'] })
check('越界的路径被丢掉，合法的那个留下',
  guarded.paths.length === 1 && guarded.paths[0] === 'f' && guarded.partial === true)
const capped = await H('git/panel')({ repo: LOCK, paths: Array.from({ length: 250 }, (_, i) => 'p' + i) })
check('路径条数有上限（pathspec 列表就是一条命令行）', capped.paths.length === 200 && capped.partial === true)

/* 两份答案不共用缓存键：先读便宜的，再读整棵树，整棵树不能变成那一次的部分答案 */
await H('git/flush')({ repo: LOCK })
const partialFirst = await H('git/panel')({ repo: LOCK, paths: ['f'] })
const wholeAfter = await H('git/panel')({ repo: LOCK })
console.log('  先按路径读 f，再读整棵树 —— 整棵树的 untracked:', JSON.stringify(wholeAfter.untracked))
check('按路径的读不会污染整棵树的读（整棵树仍然给出 untr.txt）',
  partialFirst.partial === true && wholeAfter.partial === undefined
  && wholeAfter.untracked.length === 1 && wholeAfter.untracked[0].path === 'untr.txt')

/* 轮询签名同样按路径问：整棵树的签名 53 行，这些路径 30 行（读者仓库实测） */
const watchCommands = []
const realRunForWatch = shellService.run
shellService.run = function (spec) { watchCommands.push(spec.command); return realRunForWatch(spec) }
const watchFew = await H('git/watch')({ repo: LOCK, deep: true, paths: ['f'] })
const watchAll = await H('git/watch')({ repo: LOCK, deep: true })
shellService.run = realRunForWatch
console.log('  只问 f 的签名行数:', watchFew.sig.trim().split('\n').length, ' 整棵树:', watchAll.sig.trim().split('\n').length)
check('轮询的深读也带着 pathspec', /status --porcelain=v2 --branch --untracked-files=normal -- 'f'/.test(watchCommands[0])
  && watchCommands[1].indexOf('status --porcelain=v2 --branch --untracked-files=normal -- ') < 0)
check('按路径的签名只说这些路径（untr.txt 不在里面），整棵树的签名说全部',
  watchFew.sig.indexOf('untr.txt') < 0 && watchAll.sig.indexOf('untr.txt') >= 0)
check('同一个问题同一个签名（不然每个 tick 都像变了）',
  (await H('git/watch')({ repo: LOCK, deep: true, paths: ['f'] })).sig === watchFew.sig)

/* 按路径问，仍然必须看得见「列出来的那个文件又被改了」—— 这是深读存在的理由；
   而看不见别的文件，正是它省下来的开销（别的由面板自己的整树时钟兜住）。 */
await sh("printf 'one\\n' > other.txt && git add -- other.txt && git commit -qm other -- other.txt", LOCK)
const sigF1 = (await H('git/watch')({ repo: LOCK, deep: true, paths: ['f'] })).sig
const wholeF1 = (await H('git/watch')({ repo: LOCK, deep: true })).sig
await sh("printf 'again\\n' >> f", LOCK)
const sigF2 = (await H('git/watch')({ repo: LOCK, deep: true, paths: ['f'] })).sig
const wholeF2 = (await H('git/watch')({ repo: LOCK, deep: true })).sig
await sh("printf 'more\\n' >> other.txt", LOCK)
const sigF3 = (await H('git/watch')({ repo: LOCK, deep: true, paths: ['f'] })).sig
const wholeF3 = (await H('git/watch')({ repo: LOCK, deep: true })).sig
check('列在里面的文件被改动 → 按路径的签名就变（深读还是深读）', sigF1 !== sigF2 && wholeF1 !== wholeF2)
check('别的文件被改动 → 按路径的签名不变（省下的就是这一次走树），整棵树的签名照变',
  sigF2 === sigF3 && wholeF2 !== wholeF3)


/* 身份读（chip 用的那个廉价读）自己也要报数，而且未出生的分支也要认名字。 */
console.log('')
console.log('=== 身份读：报数、认未出生的分支 ===')
await sh('git switch -q ahead-one', R)
await H('git/flush')({ repo: R })
const identAhead = await H('git/panel')({ repo: R, quick: true })
console.log('  ahead-one:', JSON.stringify({ branch: identAhead.branch, upstream: identAhead.upstream, ahead: identAhead.ahead, behind: identAhead.behind }))
check('身份读给出领先数（locale 固定，词是英文）',
  identAhead.ok === true && identAhead.branch === 'ahead-one' && identAhead.upstream === 'origin/ahead-one' && identAhead.ahead === 1 && identAhead.behind === 0)
await sh('git switch -q behind-one', R)
await H('git/flush')({ repo: R })
const identBehind = await H('git/panel')({ repo: R, quick: true })
check('身份读给出落后数', identBehind.branch === 'behind-one' && identBehind.behind === 1 && identBehind.ahead === 0)
await sh('git switch -q main', R)

const UNBORN = '/tmp/gp41-unborn'
await sh('rm -rf ' + UNBORN + ' && mkdir -p ' + UNBORN, '/tmp')
await sh('git init -q -b trunk .', UNBORN)
await H('git/flush')({ repo: UNBORN })
const unborn = await H('git/panel')({ repo: UNBORN, quick: true })
console.log('  未出生分支:', JSON.stringify({ branch: unborn.branch, detached: unborn.detached, ok: unborn.ok }))
check('还没有提交的分支，身份读照样报名字（读的是 HEAD 文件本身）',
  unborn.ok === true && unborn.branch === 'trunk' && unborn.detached === false)

/* ── 过滤之后的图形 ──
   搜索框一开，普通布局就只连得上它手里的那些提交：被筛掉的父提交不在列表里，
   为它占的道永远没人来认领，下一个提交于是另占一条 —— 读者那台机器上量到过：
   200 个 `fix` 匹配，104 条道的占位（上限 14），202px 宽、大半是空的列，52% 的
   边只画一行就断，圆点一路往右挤最后全堆在最后一条道上。

   现在有过滤时，Host 会另读一遍**这段匹配真正覆盖的普通历史**（`--not <最老的
   那个匹配>`，只取 `%H %P`），按真实 DAG 排好道，再把每个匹配放到它真正所在的
   道上；边连到最近的**可见**祖先，中间隔着被筛掉的提交时标成虚线 —— 和 IDEA
   对虚线的读法一样。没有过滤时这条路径根本不走，一个字节都没变。 */

console.log('')
console.log('=== 过滤后的图形：按真实历史布局 ===')

/* 一条直线：四个提交里只有两个匹配，中间那个被筛掉 */
const G = '/tmp/gp42-graphrepo'
await sh('rm -rf ' + G + ' && mkdir -p ' + G + ' && cd ' + G + ' && git init -q -b main .'
  + " && git config user.email t@t && git config user.name T", '/tmp')
const gcommit = async (n, msg) => {
  await sh('GIT_COMMITTER_DATE="2020-01-0' + n + 'T00:00:00" GIT_AUTHOR_DATE="2020-01-0' + n + 'T00:00:00" '
    + 'git commit -q --allow-empty -m ' + JSON.stringify(msg), G)
}
await gcommit(1, 'unrelated first')
await gcommit(2, 'REFACTOR: parser')
await gcommit(3, 'fix the lexer')
await gcommit(4, 'Fix the parser')
const ggraph = async (args) => { await H('git/flush')({ repo: G }); return await H('git/graph')(Object.assign({ repo: G }, args)) }

const plainGraph = await ggraph({})
const filteredGraph = await ggraph({ search: 'parser' })
console.log('  未过滤：' + plainGraph.commits.length + ' 条，道 ' + plainGraph.lanes
  + '；过滤 parser：' + filteredGraph.commits.length + ' 条，道 ' + filteredGraph.lanes)
console.log('  过滤后的行:', JSON.stringify(filteredGraph.rows))
check('过滤读只给匹配的那两条',
  filteredGraph.commits.length === 2 && filteredGraph.commits[0].subject === 'Fix the parser'
  && filteredGraph.commits[1].subject === 'REFACTOR: parser')
check('两条落在同一条道上（它们在一条链上），列宽也只有一条道',
  filteredGraph.rows[0].lane === 0 && filteredGraph.rows[1].lane === 0 && filteredGraph.lanes === 1)
check('边指向最近的**可见**祖先（不是那个看不见的父提交）',
  filteredGraph.rows[0].edges.length === 1
  && filteredGraph.rows[0].edges[0].hash === filteredGraph.commits[1].hash
  && filteredGraph.rows[0].edges[0].lane === 0)
check('中间隔着被筛掉的提交：这条边是虚线',
  filteredGraph.rows[0].edges[0].dashed === true)
check('没有可见祖先可连：也标虚线，让画面把线画到页外（而不是断在自己下面一行）',
  filteredGraph.rows[1].edges.length === 1 && filteredGraph.rows[1].edges[0].dashed === true
  && filteredGraph.commits.every((c) => c.hash !== filteredGraph.rows[1].edges[0].hash))
check('没有过滤时一条虚线都没有（那条路径没变）',
  plainGraph.rows.every((r) => r.edges.every((e) => e.dashed !== true))
  && plainGraph.lanes === 1 && plainGraph.rows.length === 4)

/* 有分支的仓库：两个匹配不在同一条链上，真实 DAG 就该把它们放在两条道上 ——
   「谁先来谁占 0 号」的写法会把它们挤在一条道上，或者各占一条越来越右的新道。 */
const GB = '/tmp/gp42-graphbranch'
await sh('rm -rf ' + GB + ' && mkdir -p ' + GB + ' && cd ' + GB + ' && git init -q -b main .'
  + " && git config user.email t@t && git config user.name T", '/tmp')
const bcommit = async (n, msg) => {
  await sh('GIT_COMMITTER_DATE="2020-01-0' + n + 'T00:00:00" GIT_AUTHOR_DATE="2020-01-0' + n + 'T00:00:00" '
    + 'git commit -q --allow-empty -m ' + JSON.stringify(msg), GB)
}
await bcommit(1, 'base commit')
await sh('git checkout -q -b feat', GB)
await bcommit(2, 'fix on feat')
await sh('git checkout -q main', GB)
await bcommit(3, 'fix on main')
await sh('GIT_COMMITTER_DATE="2020-01-04T00:00:00" GIT_AUTHOR_DATE="2020-01-04T00:00:00" '
  + 'git merge -q --no-ff -m "Merge branch feat" feat', GB)
const gbranch = async (args) => { await H('git/flush')({ repo: GB }); return await H('git/graph')(Object.assign({ repo: GB }, args)) }
const branched = await gbranch({ search: 'fix' })
console.log('  分支仓库，过滤 fix：' + branched.commits.length + ' 条 ' + JSON.stringify(branched.rows)
  + '，道 ' + branched.lanes)
check('两个匹配各在自己的道上（布局来自真实 DAG，不是「谁先来谁占 0 号」）',
  branched.commits.length === 2 && branched.lanes === 2
  && branched.rows[0].lane !== branched.rows[1].lane)
check('两条边都是虚线，而且都指向这一页里没有的提交（线画到页外）',
  branched.rows.every((r) => r.edges.length === 1 && r.edges[0].dashed === true
    && branched.commits.every((c) => c.hash !== r.edges[0].hash)))
check('列宽数的是真正画出来的道（两条）',
  Math.max(branched.rows[0].lane, branched.rows[1].lane) + 1 === branched.lanes)

/* ── 新文件的形状：客户端的分组判据靠它 ──
   面板把「新文件」留在自己那一组里（勾上之后不跳进变更列表），判据是「HEAD 从来
   没有过这个路径」：`untracked`，或者索引里以 `A` 开头。所以 Host 报出来的这一位
   必须说得出「加进索引」—— porcelain=v2 给的是两位 XY：`A.` 是加了没改，`AM` 是
   加了又改。哪天这两个字母的形状变了，这里先红，而不是等面板把新文件错分到变更
   列表里去（那正是读者报上来的那个现象）。 */
console.log('')
console.log('=== 新文件在索引里的样子 ===')
const A = '/tmp/gp42-addedrepo'
await sh('rm -rf ' + A + ' && mkdir -p ' + A + ' && cd ' + A + ' && git init -q -b main .'
  + " && git config user.email t@t && git config user.name T"
  + " && echo one > tracked.txt && git add -A && git commit -qm base", '/tmp')
await sh('echo new > brand-new.txt && git add -- brand-new.txt', A)
await H('git/flush')({ repo: A })
const addedPanel = await H('git/panel')({ repo: A })
const added = addedPanel.staged.filter(function (x) { return x.path === 'brand-new.txt' })
console.log('  git add 之后:', JSON.stringify(addedPanel.staged), ' untracked:', JSON.stringify(addedPanel.untracked))
check('加了没改：索引给的以 A 开头（porcelain 的 `A.`）',
  added.length === 1 && String(added[0].code).slice(0, 1) === 'A' && addedPanel.untracked.length === 0)
await sh('echo more >> brand-new.txt', A)
await H('git/flush')({ repo: A })
const editedPanel = await H('git/panel')({ repo: A })
const edited = editedPanel.staged.filter(function (x) { return x.path === 'brand-new.txt' })
check('加了又改：还是以 A 开头（`AM`），工作区那一段也在',
  edited.length === 1 && String(edited[0].code).slice(0, 1) === 'A'
  && editedPanel.unstaged.some(function (x) { return x.path === 'brand-new.txt' }))
await sh('echo second > tracked.txt && git add tracked.txt', A)
await H('git/flush')({ repo: A })
const modifiedPanel = await H('git/panel')({ repo: A })
const modified = modifiedPanel.staged.filter(function (x) { return x.path === 'tracked.txt' })
check('（对照）本来就有的文件改了：不是 A，客户端不该把它算成新文件',
  modified.length === 1 && String(modified[0].code).slice(0, 1) !== 'A')

/* ── 一个文件的差异 ──
   面板能说「哪个文件改了」很久了，但没有任何一次读取返回过 patch，所以两处的
   文件行都到那里为止。这一节盯的就是补上的那次读取：四种状态各自的形状。 */

console.log('')
console.log('=== 差异读：四种状态 ===')
const D = '/tmp/gp42-diffrepo'
await sh('rm -rf ' + D + ' && mkdir -p ' + D + ' && cd ' + D + ' && git init -q -b main .'
  + " && git config user.email t@t && git config user.name T"
  + " && printf 'one\\ntwo\\nthree\\n' > a.txt && git add -A && git commit -qm one", '/tmp')

const rootHash = (await sh('git rev-parse HEAD', D)).out.trim()
const rootDiff = await H('git/diff')({ repo: D, mode: 'commit', path: 'a.txt', ref: rootHash })
check('根提交也读得出来（它没有父提交）',
  rootDiff.ok === true && rootDiff.added === 3 && rootDiff.removed === 0 && rootDiff.text.indexOf('new file mode') > 0)

await sh("printf 'one\\ntwo changed\\nthree\\n' > a.txt && git add a.txt"
  + " && printf 'one\\ntwo changed\\nthree\\nfour\\n' > a.txt", D)
const stagedDiff = await H('git/diff')({ repo: D, mode: 'staged', path: 'a.txt' })
const worktreeDiff = await H('git/diff')({ repo: D, mode: 'worktree', path: 'a.txt' })
check('已暂存那一段：+1 −1，数的是改动行不是文件头',
  stagedDiff.ok === true && stagedDiff.added === 1 && stagedDiff.removed === 1
  && stagedDiff.text.indexOf('+two changed') > 0 && stagedDiff.text.indexOf('+++ b/a.txt') > 0)
check('未暂存那一段：+1 −0（同一个文件，两种状态）',
  worktreeDiff.ok === true && worktreeDiff.added === 1 && worktreeDiff.removed === 0
  && worktreeDiff.text.indexOf('+four') > 0)

await sh("printf 'brand new\\n' > n.txt", D)
const untrackedDiff = await H('git/diff')({ repo: D, mode: 'untracked', path: 'n.txt' })
check('未跟踪：--no-index 的退出码是 1，但补丁本身是好的',
  untrackedDiff.ok === true && untrackedDiff.added === 1 && untrackedDiff.text.indexOf('new file mode') > 0)

console.log('')
console.log('  — 守卫 —')
/* 拒绝要发生在拼命令**之前**：这条读是 `git diff --no-index -- /dev/null <path>`，
   一个子进程起出去就已经读到了仓库外的东西，答不答复都晚了。所以这里连进程数一起量。 */
const escapeCommands = []
const beforeEscapeRun = shellService.run
shellService.run = function (spec) { escapeCommands.push(spec.command); return beforeEscapeRun(spec) }
/* 一个 NUL 字节要是漏到这一层，Node 的 spawn 会**抛**而不是返回 —— 守卫被拿掉时
   这一行会直接把整个套件带走，回归信号就只剩一个栈。所以这两次读自己吞掉异常，
   把一个 throw 变成一行 ✗。 */
const probeDiff = async function (args) {
  try { return await H('git/diff')(args) } catch (error) {
    return { ok: false, error: 'threw: ' + String(error != null ? error.message : error) }
  }
}
const absPath = await probeDiff({ repo: D, mode: 'untracked', path: '/etc/hostname' })
const nulPath = await probeDiff({ repo: D, mode: 'untracked', path: 'a\u0000b' })
shellService.run = beforeEscapeRun
console.log('  绝对路径 ->', JSON.stringify(absPath.error), ' 起了几个进程:', escapeCommands.length)
check('绝对路径被拒，而且一个进程都没起（拒绝在拼命令之前）',
  absPath.ok === false && absPath.error === 'invalid-path' && escapeCommands.length === 0)
check('路径里的 NUL 字节同样被拒',
  nulPath.ok === false && nulPath.error === 'invalid-path' && escapeCommands.length === 0)
/* 对照：同一个命令绕过守卫，读的就是仓库外的文件 —— 守卫是承重的，不是装饰 */
const rawEscape = await sh('cd ' + D + ' && git --no-optional-locks diff --no-color --no-index -- /dev/null /etc/hostname | head -1', '/tmp')
check('（对照）同一条 git 命令绕过守卫确实会读出 /etc/hostname',
  rawEscape.out.indexOf('/etc/hostname') >= 0)
check('.. 被拒', (await H('git/diff')({ repo: D, mode: 'worktree', path: '../x' })).error === 'invalid-path')
check('未知 mode 被拒', (await H('git/diff')({ repo: D, mode: 'nope', path: 'a.txt' })).error === 'unknown-mode')
check('commit 模式必须给哈希（选项串也过不去）',
  (await H('git/diff')({ repo: D, mode: 'commit', path: 'a.txt', ref: '--output=/tmp/x' })).error === 'invalid-ref')

console.log('')
console.log('  — 不是文本的，不作文本 —')
await sh("printf 'a\\000b' > c.bin && git add c.bin", D)
const nulBinary = await H('git/diff')({ repo: D, mode: 'staged', path: 'c.bin' })
check('带 NUL 的二进制：只说二进制，不给正文',
  nulBinary.ok === true && nulBinary.binary === true && nulBinary.text.length === 0)
/* git 只在头 8000 字节里找 NUL，所以没有 NUL 的二进制会被当成文本印出来 */
await sh("head -c 400 /dev/urandom | tr -d '\\000' > r.bin", D)
const noisyBinary = await H('git/diff')({ repo: D, mode: 'untracked', path: 'r.bin' })
check('没有 NUL 的二进制也不当文本（否则面板里是一屏噪声）',
  noisyBinary.ok === true && noisyBinary.binary === true && noisyBinary.text.length === 0)

const cleanDiff = await H('git/diff')({ repo: D, mode: 'worktree', path: 'c.bin' })
check('没有差异时是空补丁，不是错误', cleanDiff.ok === true && cleanDiff.empty === true && cleanDiff.text === '')

await sh('for i in $(seq 1 7000); do echo "l$i" >> big.txt; done', D)
const bigDiff = await H('git/diff')({ repo: D, mode: 'untracked', path: 'big.txt' })
console.log('  超长补丁:', JSON.stringify({ truncated: bigDiff.truncated, lines: bigDiff.text.split('\n').length }))
check('超长补丁截断并自报截断', bigDiff.ok === true && bigDiff.truncated === true && bigDiff.text.split('\n').length <= 6000)

await sh("printf 'x\\n' > ./-dash.txt", D)
const dashDiff = await H('git/diff')({ repo: D, mode: 'untracked', path: '-dash.txt' })
check('以 - 开头的文件名照样当路径（-- 之后都是路径）', dashDiff.ok === true && dashDiff.added === 1)

console.log('')
console.log('  — 提交：重命名与合并 —')
await sh('git add -A && git commit -qm two && git mv a.txt renamed.txt && git commit -qm rename', D)
const renameHash = (await sh('git rev-parse HEAD', D)).out.trim()
const renamed = await H('git/diff')({ repo: D, mode: 'commit', path: 'renamed.txt', from: 'a.txt', ref: renameHash })
const renamedOnly = await H('git/diff')({ repo: D, mode: 'commit', path: 'renamed.txt', ref: renameHash })
check('带上旧路径才认得出是一次重命名', renamed.ok === true && renamed.text.indexOf('rename from a.txt') > 0)
check('（对照）只给新路径，git 报成新增', renamedOnly.text.indexOf('new file mode') > 0 && renamedOnly.text.indexOf('rename from') < 0)

await sh('git checkout -q -b side HEAD~1 && echo s > s.txt && git add s.txt && git commit -qm side'
  + ' && git checkout -q main && git merge -q --no-edit side', D)
const mergeHash = (await sh('git rev-parse HEAD', D)).out.trim()
const parentFields = (await sh('git rev-list --parents -n1 ' + mergeHash + ' | wc -w', D)).out.trim()
const mergedDiff = await H('git/diff')({ repo: D, mode: 'commit', path: 's.txt', ref: mergeHash })
console.log('  合并提交:', JSON.stringify({ parents: parentFields, added: mergedDiff.added, empty: mergedDiff.empty }))
check('这确实是合并提交（三个字段：自己 + 两个父）', parentFields === '3')
check('合并读的是第一父提交的差异（不加 -m 的话组合差异是空的）',
  mergedDiff.ok === true && mergedDiff.added === 1 && mergedDiff.text.indexOf('+s') > 0)

console.log('')
console.log('  — 差异不缓存 —')
await H('git/flush')({ repo: D })
const beforeEdit = await H('git/diff')({ repo: D, mode: 'worktree', path: 's.txt' })
await sh("printf 's\\nchanged\\n' > s.txt", D)
const afterEdit = await H('git/diff')({ repo: D, mode: 'worktree', path: 's.txt' })
check('改完再读就是新的（这是给正在看的那个人读的文本）',
  beforeEdit.empty === true && afterEdit.added === 1 && afterEdit.text.indexOf('+changed') > 0)

/* ── 未跟踪目录里有什么 ──
   git 把未跟踪目录折叠成一行（路径以 / 结尾），不说里面有什么。勾选整行不需要
   答案；展开它是一次单独的读，`ls-files --others --exclude-standard` 列的正是
   `git add <dir>` 会收的那些，.gitignore 同样生效。 */

console.log('')
console.log('=== 未跟踪目录里有什么 ===')
await sh("mkdir -p newdir/deep && printf 'a\\n' > newdir/a.txt && printf 'b\\n' > newdir/deep/b.txt"
  + " && printf 'c\\n' > newdir/c.bin && printf '*.log\\n' > .gitignore && printf 'x\\n' > newdir/skip.log", D)

const listed = await H('git/untracked')({ repo: D, dir: 'newdir/' })
console.log('  目录里:', JSON.stringify(listed.files))
check('列出的是 git add <dir> 会收的那些文件（递归）',
  listed.ok === true && listed.files.length === 3
  && listed.files.indexOf('newdir/a.txt') >= 0 && listed.files.indexOf('newdir/deep/b.txt') >= 0
  && listed.files.indexOf('newdir/c.bin') >= 0)
check('被 .gitignore 排除的不在其中', listed.files.indexOf('newdir/skip.log') < 0)

/* 对照：面板那一次读对同一个目录只有一行，没有内容 —— 展开是另一件事 */
await H('git/flush')({ repo: D })
const panelWithDir = await H('git/panel')({ repo: D })
const collapsedRows = panelWithDir.untracked.filter(function (x) { return String(x.path).indexOf('newdir/') === 0 })
console.log('  面板读里这个目录:', JSON.stringify(collapsedRows))
check('（对照）面板那一次读只给一行、末尾带斜杠、没有内容',
  collapsedRows.length === 1 && collapsedRows[0].path === 'newdir/')

const dirEscape = await H('git/untracked')({ repo: D, dir: '../../etc' })
check('目录同样不许跑出仓库', dirEscape.ok === false && dirEscape.error === 'invalid-path')

const insideDiff = await H('git/diff')({ repo: D, mode: 'untracked', path: 'newdir/a.txt' })
check('目录里的文件照样读得出差异', insideDiff.ok === true && insideDiff.added === 1)

/* ── 不向 DSH 注册任何工具 ──

   这个插件给 DSH 的只有 UI 和它自己的 RPC 通道：客户端从头到尾只走
   `host.call('git/…')`，一次工具调用都没有。模型要跑 git 本来就有 bash，那 8 个
   工具是同一件事的第二条通路，代价是每一轮请求都带着 7.2KB 的 schema。所以
   harness 一个 defineTool 都不该收到 —— 谁再把它加回来，这里先红。 */
console.log('')
console.log('=== 不注册工具 ===')
console.log('  harness 收到的工具定义:', TOOLS.size, '处')
check('不向 DSH 注册任何工具', TOOLS.size === 0)
check('源码里也没有 registerTool / defineTool 的调用',
  body.indexOf('registerTool(') < 0 && body.indexOf('defineTool(') < 0)
/* 同一条源码还有第二份产物：正式包的 lib/index.js，前面挂着 pkg/host-pre.js 那个
   harness 垫片。垫片里曾经有 defineTool / registerTool 两项，撤工具时一起撤了 ——
   谁把它加回去，这里也要红，不然「不注册工具」只对桥那一半成立。 */
const pkgBody = fs.readFileSync(new URL('../lib/index.js', import.meta.url).pathname, 'utf8')
check('正式包那一半（lib/index.js）也没有注册工具',
  pkgBody.indexOf('registerTool(') < 0 && pkgBody.indexOf('defineTool(') < 0)

/* ── 答复里不许有 undefined ──

   宿主运行时对每一条 RPC 答复逐个字段校验「能不能无损地变成 JSON」。规矩很硬：
   只要有一个字段的值是 `undefined`，被拒的是**整条**答复 —— 客户端拿到的不是一份
   少了字段的快照，而是一个错误，面板于是空着。

   这条规矩在别处都看不见：这些套件是直接调用处理器的，中间没有那道校验；而客户端
   那半边用的又是 mock 的 host。所以它栽在真实页面上过一次（`needsIdentity` 只在
   缺身份时为 true，另一半写成了 undefined，于是有身份的仓库整条读被拒），这里
   自己扫一遍：几个具代表性的答复，深度遍历，一个 undefined 都不许有。

   注意分别：**键不在**（成功路径上没有 needsIdentity 这个键）是允许的；**键在而值
   是 undefined** 才是被拒的那种。`Object.keys` 认的正是这个分别。 */
function undefinedPaths(value, path, out) {
  if (value === undefined) { out.push(path); return out }
  if (value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) undefinedPaths(value[i], path + '[' + i + ']', out)
    return out
  }
  const keys = Object.keys(value)
  for (let i = 0; i < keys.length; i += 1) undefinedPaths(value[keys[i]], path + '.' + keys[i], out)
  return out
}

console.log('')
console.log('=== 答复里不许有 undefined（桥会拒掉整条）===')
await H('git/flush')({ repo: R })
await H('git/flush')({ repo: NID })
const shapes = [
  ['git/panel 整树（有身份）', await H('git/panel')({ repo: R })],
  ['git/panel 整树（没身份）', await H('git/panel')({ repo: NID })],
  ['git/panel 整树（未出生的分支）', await H('git/panel')({ repo: UNBORN })],
  ['git/panel 整树（不是仓库）', await H('git/panel')({ repo: '/tmp' })],
  ['git/panel 按路径', await H('git/panel')({ repo: R, paths: ['id.txt'] })],
  ['git/panel 廉价读', await H('git/panel')({ repo: R, quick: true })],
  ['git/graph', await H('git/graph')({ repo: R, maxCount: 5 })],
  ['git/branches', await H('git/branches')({ repo: R })],
  ['git/refs', await H('git/refs')({ repo: R })],
  ['git/authors', await H('git/authors')({ repo: R })],
  ['git/commit-detail', await H('git/commit-detail')({ repo: R, hash: 'deadbeef' })],
  ['git/diff 未跟踪', await H('git/diff')({ repo: R, mode: 'untracked', path: 'id.txt' })],
  ['git/diff 越界路径', await H('git/diff')({ repo: R, mode: 'worktree', path: '../x' })],
  ['git/untracked', await H('git/untracked')({ repo: R, dir: 'sub' })],
  ['git/watch', await H('git/watch')({ repo: R, deep: true })],
  ['git/stage', await H('git/stage')({ repo: R, paths: ['id.txt'] })],
  ['git/unstage', await H('git/unstage')({ repo: R, paths: ['id.txt'] })],
  ['git/commit 成功', await H('git/commit')({ repo: R, message: 'shape' })],
  ['git/commit 被拒（没身份）', await H('git/commit')({ repo: NID, message: 'shape' })],
  ['git/sequence 还原被拒（没身份）', revertReply],
  ['git/branch-delete 被拒', deleteReply],
  ['git/commit 缺信息', await H('git/commit')({ repo: R })],
  ['git/checkout 不存在的分支', await H('git/checkout')({ repo: R, name: 'no-such-branch' })],
  ['git/branch-create 缺名字', await H('git/branch-create')({ repo: R })],
  ['git/tag 缺名字', await H('git/tag')({ repo: R })],
  ['git/branch-delete 缺名字', await H('git/branch-delete')({ repo: R })],
  ['git/sequence 未知操作', await H('git/sequence')({ repo: R, op: 'nope', action: 'start' })],
  ['git/config', await H('git/config')({})],
  ['git/flush', await H('git/flush')({ repo: R })],
  ['git/init', await H('git/init')({ repo: '/tmp/gp34-shape-init' })],
]
let dirty = ''
for (let i = 0; i < shapes.length; i += 1) {
  const bad = undefinedPaths(shapes[i][1], shapes[i][0], [])
  if (bad.length > 0) dirty += (dirty.length > 0 ? '；' : '') + bad.join('、')
}
console.log('  扫过的答复:', shapes.length, '条；带 undefined 的字段:', dirty.length > 0 ? dirty : '（没有）')
check('每一条答复深度扫过都没有 undefined 字段', dirty.length === 0)
check('扫的确实是真答复（不是一堆 null）',
  shapes.filter((s) => s[1] != null).length === shapes.length
  && shapes.filter((s) => s[1].ok === false).length > 0)

console.log('')
console.log('=== 执行器换了形状：0.1.7 的 execute/result ===')
/* DSH 0.1.7 把执行器的一次性 `run(spec)` 换成了 `execute(spec)`：调用先拿到一个
   句柄，`result()` 才是跑完的那份答案。这里把同一个 shell 服务临时换成新形状 ——
   真命令照跑 —— 面板的读必须照样有答案，而且必须确实走了新那条路。两个计数器是
   唯一的证人：`run` 还在（旧版会用它），只看答复分不出走的是哪条。 */
let executeCalls = 0
let runCalls = 0
const realRunBeforeShape = shellService.run
const realExecuteBeforeShape = shellService.execute
shellService.execute = function (spec) {
  executeCalls += 1
  return Promise.resolve({ result: function () { return realRunBeforeShape(spec) } })
}
shellService.run = function (spec) {
  runCalls += 1
  return realRunBeforeShape(spec)
}
await H('git/flush')({ repo: R })
const viaExecute = await H('git/branches')({ repo: R })
check('新形状下读得到真实分支列表',
  viaExecute != null && Array.isArray(viaExecute.branches) && viaExecute.branches.some((b) => b.name === 'main'))
check('走的是 execute/result，而不是旧的 run', executeCalls > 0 && runCalls === 0)
console.log('  execute 次数:', executeCalls, ' run 次数:', runCalls)
shellService.execute = realExecuteBeforeShape
shellService.run = realRunBeforeShape

console.log('')
console.log('=== 非活动会话：工作区从存储里解析 ===')
/* DSH 0.1.7 的 `sessions.get(id)` 只回答**活着的**会话（0.1.5 会从存储里加载）。
   面板刚挂上、会话还在恢复的那一瞬就落在这一条上：解析不到工作区，读到的是
   not-a-repository，于是面板一直说「未检测到仓库」，而晚一步的 chip 却报出了分支。
   这里把 sessions 换成「查不到」，把 sessionPersistence 换成「存着这条会话」，
   同一个请求必须解析出工作区。 */
services.sessions = { get: () => undefined }
const noStore = await H('git/branches')({ sessionId: 'session-not-live' })
/* 没有存储时，这个请求只能落到 shell 自己的默认工作目录（跑测试时就是插件仓库
   本身），能不能读成仓库取决于那个目录 —— 但它绝不该是这条会话的工作区。 */
check('（对照）没有存储时解析不到那个会话的工作区', noStore != null && noStore.repo !== R)
services.sessionPersistence = { stat: async () => ({ header: { cwd: R } }) }
await H('git/flush')({ repo: R })
const viaStore = await H('git/branches')({ sessionId: 'session-not-live' })
check('存储里那份工作区被解析出来了', viaStore != null && viaStore.ok === true && viaStore.repo === R)
delete services.sessionPersistence
delete services.sessions

/* 前面任何一条 ✗ 都要反映到退出码上 */
if (failedChecks > 0) {
  console.log('')
  console.log('✗ ' + failedChecks + ' 条不符合预期')
  process.exit(1)
}
