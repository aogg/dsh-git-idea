import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── pull 的 ↓ 右键两个变体（Host 半侧）：stashFirst 与 resetToRemote ──
 *
 * 需求（c1a167a）：↓ 右键菜单三件 —— 普通拉取（不带新参数，原路径一字不变）、
 * 暂存后拉取再恢复（stashFirst:true）、使用远端覆盖本地（resetToRemote:true）。
 * 客户端只说「要什么」，argv 在 host 这里成形。Host 这半钉：
 *
 *   stashFirst 款（stash push -u → pull → stash pop，失败语义照 switchBranch 那套）：
 *     1. 脏工作区（含未跟踪文件）→ 三步都跑（status 读 + stash push + pull + stash
 *        pop），改动最终回到工作区（跟踪文件改动与未跟踪文件都在），stash 栈清空；
 *        答复 stashed:true、dirty 数对、pulled:true、popConflict:false；命令页三笔
 *        （暂存改动(拉取前) / 拉取 / 恢暂存(拉取后)），status 那次读不进命令页。
 *     2. 干净工作区 → 跳过 stash：命令页没有「暂存改动(拉取前)」，spy 里一次 stash
 *        都没有，答复 stashed:false、dirty:0。
 *     3. pull 失败（本地领先 + 远端也领先，git 自己拒绝）→ error:'pull-failed'、
 *        stashed:true、pulled:false，stderr 前置「改动安然在 stash 里」的人话；改动
 *        真的留在 stash 里，pop 没跑。
 *     4. pop 撞冲突 → popConflict:true + popStdout/popStderr 有货，工作区留冲突标记
 *        （git 自己把 stash 条目留住，丢不掉）。
 *     5. 上游问不到 → no-upstream / detached-head 人话错误，stash 与 pull 一步不动手，
 *        脏改动原封没动。
 *
 *   resetToRemote 款（fetch --all ± --prune → reset --hard <上游>）：
 *     6. 本地领先 + 脏改动 → fetch 在前 reset 在后，HEAD 与远端一致、本地独有提交
 *        没了、脏改动被卷掉；答复 resetTo:'origin/main'；命令页两笔（覆盖前取回 /
 *        重置到远端）顺序对。
 *     7. fetchPrune 默认开 → fetch 带上 --prune（与 git/fetch 默认款同一副 argv）；
 *        显式关掉才退回裸的 fetch --all。
 *     8. fetch 失败（origin 指到不存在的地方）→ error:'fetch-failed'、resetTo:null，
 *        reset 不跑、脏改动原封（拿旧账覆盖人比不覆盖更糟）。
 *     9. 上游问不到（无上游 / 游离 HEAD）→ 人话错误且一步不动手。
 *
 *   既有路径回归（不带新参数的调用一字不变）：
 *    10. 无参数 pull：argv 就是 pull，答复上没有 stashFirst / resetTo 时代的新键；
 *    11. rebase:true → ['pull','--rebase']；
 *    12. branch 参数（拉别的分支）→ fetch <远端> <远端分支>:<分支>，pull 不跑，
 *        当前分支不动；
 *    13. setUpstream → 先绑定再拉，upstreamSet / pulled / setUpstream 形状照旧
 *        （gp51 已深钉，这里只钉回归形状）。
 *
 * 夹具与隔离骨架照抄 gp51：bare origin + 无 upstream 的旁支 + 一个 peer clone 当
 * 「远端的同事」；HOME / GIT_CONFIG_GLOBAL / SYSTEM 全部压进 /tmp（钉在 makeBody
 * 与 sh 里，不靠每个调用点记得传）。gp50 的 command-log 读法用来断言「命令」页。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

function makeBody(env, spy) {
  const shellEnv = Object.assign({}, process.env, {
    DSH_HOME: HOME + '/.dsh', HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL,
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  }, env)
  function runShell(spec) {
    if (spy !== undefined) spy.push(spec.command)
    return new Promise((res) => {
      const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: shellEnv })
      let o = '', e = ''
      c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
      c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
      c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
    })
  }
  const handlers = new Map()
  const ctx = { get: n => (n === 'shell' ? { resolve: r => r, run: runShell } : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return { H: n => handlers.get(n) }
}

function sh(cmd, cwd, extraEnv) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', cmd], { cwd, env: Object.assign({}, process.env, {
      DSH_HOME: HOME + '/.dsh', HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL,
      GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    }, extraEnv) })
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

/* spy 里混着配置探测（printf/cat）与命令记录写盘（printf >> jsonl），git 命令按
 * 「引号包裹的子命令」这个形状滤出来 —— shq 把 argv 一律单引号包裹。 */
const gitLines = (seen) => seen.filter((c) => /git '/.test(c))
const findGit = (seen, re) => gitLines(seen).filter((c) => re.test(c))
const rev = async (what, cwd) => (await sh('git rev-parse ' + what, cwd)).out.trim()
const stashCount = async (cwd) => (await sh('git stash list', cwd)).out.trim().split('\n').filter((l) => l.length > 0).length

/* peer（远端的同事）在 origin/main 上补一笔：peerlog 追加一行 —— 内容式断言用
 * 专行，这里只造「远端领先」的事实。 */
const peerMark = async (mark) => {
  await sh(`echo ${mark} >> peerlog.txt && git add -A && git commit -qm ${mark} && git push -q origin main`, T)
}

const R = '/tmp/gp89-repo'
const O = '/tmp/gp89-origin'
const T = '/tmp/gp89-peer'
const HOME = '/tmp/gp89-home'
const GLOBAL = HOME + '/.gitconfig'
const NOWHERE = '/tmp/gp89-nowhere'

/* gp51 的骨架：bare origin + 本地分支。main 与 side 都绑了上游（push -u）——
 * 变体要的正是「站在有上游的分支上」；上游问不到的形状用临时分支 gp89-lonely
 * 现造。T 是读者在远端的同事，专门往 origin 推提交。 */
await sh(`rm -rf ${R} ${O} ${T} ${HOME} ${NOWHERE} && mkdir -p ${HOME} ${R}
cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T
printf 'base-1\\nbase-2\\n' > base.txt && printf 'mine\\n' > mine.txt
git add -A && git commit -qm first
git clone -q --bare . ${O} && git remote add origin ${O} && git push -q -u origin main
git checkout -q -b side && printf 's\\n' > side.txt && git add -A && git commit -qm side && git push -q -u origin side
git checkout -q main
git clone -q ${O} ${T} && cd ${T} && git config user.email t@t && git config user.name T`, '/tmp')

/* 每节先把插件配置清掉：上一节可能存过 pullRebase / fetchPrune 之类的键，配置落在
 * HOME/.dsh 里，跨 makeBody 存活（gp51 同一句）。 */
async function freshConfig() {
  await sh('rm -f ' + HOME + '/.dsh/dsh-git-idea.json', '/tmp')
}

console.log('')
console.log('=== stashFirst：脏工作区（含未跟踪）→ 三步都跑、改动回到工作区、stash 栈清空 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  /* 远端领先一笔（动 base-1 那行），本地脏两处：跟踪文件 mine.txt + 未跟踪 untracked.txt。
   * 两处都不与远端那笔重叠 —— pop 该干净地放回来。 */
  await sh(`printf 'remote-1\\nbase-2\\n' > base.txt && git add -A && git commit -qm remote-1 && git push -q origin main`, T)
  await sh(`printf 'mine-edited\\n' > mine.txt && printf 'hallo\\n' > untracked.txt`, R)
  const beforeHead = await rev('HEAD', R)
  const reply = await a.H('git/pull')({ repo: R, stashFirst: true, sessionId: 'gp89-dirty' })
  check('答复形状：ok:true、stashed:true、dirty:2、pulled:true、popConflict:false'
    + '（实际 ok=' + reply.ok + ' stashed=' + reply.stashed + ' dirty=' + reply.dirty
    + ' pulled=' + reply.pulled + ' popConflict=' + reply.popConflict + '）',
    reply.ok === true && reply.stashed === true && reply.dirty === 2
    && reply.pulled === true && reply.popConflict === false)
  check('远端那笔真进来了：HEAD 从 ' + beforeHead.slice(0, 7) + ' 前进到与 origin/main 一致',
    (await rev('HEAD', R)) === (await rev('origin/main', R)) && (await rev('HEAD', R)) !== beforeHead)
  check('跟踪文件的改动放回了：mine.txt 仍是工作区那版（stash pop 生效）',
    (await sh('cat ' + R + '/mine.txt', R)).out.trim() === 'mine-edited')
  check('未跟踪文件也放回了：untracked.txt 回到工作区（-u 收的）',
    (await sh('cat ' + R + '/untracked.txt', R)).out.trim() === 'hallo')
  check('stash 栈清空：git stash list 一条不剩', (await stashCount(R)) === 0)
  const g = gitLines(seen)
  const atStatus = g.findIndex((c) => /git '--no-optional-locks' 'status' '--porcelain=v1'/.test(c))
  const atPush = g.findIndex((c) => /git 'stash' 'push' '-u' '-m' 'dsh-git-idea: pull 拉取前暂存'/.test(c))
  const atPull = g.findIndex((c) => /git 'pull'/.test(c))
  const atPop = g.findIndex((c) => /git 'stash' 'pop'/.test(c))
  check('spy 顺序：status 读在前，stash push -u → pull → stash pop 三步各一次',
    atStatus >= 0 && atPush > atStatus && atPull > atPush && atPop > atPush
    && findGit(seen, /git 'stash' 'push'/).length === 1 && findGit(seen, /git 'stash' 'pop'/).length === 1)
  const log = await a.H('git/command-log')({ repo: R, sessionCwd: R, sessionId: 'gp89-dirty', limit: 200 })
  const panel = log.ok === true && Array.isArray(log.commands) ? log.commands.filter((c) => c.source === 'panel') : []
  check('命令页恰好三笔：暂存改动(拉取前)、拉取、恢复暂存(拉取后)，退出码全 0'
    + '（实际 ' + panel.map((c) => c.description + '/' + String(c.exitCode)).join(' | ') + '）',
    panel.length === 3
    && panel.some((c) => c.description === '暂存改动(拉取前)' && /stash push -u/.test(c.command) && c.exitCode === 0)
    && panel.some((c) => c.description === '拉取' && c.command === 'git pull' && c.exitCode === 0)
    && panel.some((c) => c.description === '恢复暂存(拉取后)' && c.command === 'git stash pop' && c.exitCode === 0))
  check('status 那次读不进命令页（读不记，变更才记）',
    panel.every((c) => c.command.indexOf("'status'") < 0 && c.command.indexOf('symbolic-ref') < 0))
  await sh('git checkout -q -- mine.txt && rm -f untracked.txt', R)
}

console.log('')
console.log('=== stashFirst：干净工作区 → 无 stash 步，命令页没有「暂存改动(拉取前)」 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await peerMark('remote-2')
  const reply = await a.H('git/pull')({ repo: R, stashFirst: true, sessionId: 'gp89-clean' })
  check('答复形状：ok:true、stashed:false、dirty:0、pulled:true'
    + '（实际 ok=' + reply.ok + ' stashed=' + reply.stashed + ' dirty=' + reply.dirty + ' pulled=' + reply.pulled + '）',
    reply.ok === true && reply.stashed === false && reply.dirty === 0 && reply.pulled === true)
  check('spy 里一次 stash 都没有（干净的工作区没有改动可收，两步白跑）',
    gitLines(seen).length > 0 && gitLines(seen).every((c) => c.indexOf("'stash'") < 0))
  check('远端那笔照样进来（peerlog 里有 remote-2 提交）',
    /remote-2/.test((await sh('git log --format=%s origin/main', R)).out))
  const log = await a.H('git/command-log')({ repo: R, sessionCwd: R, sessionId: 'gp89-clean', limit: 200 })
  const panel = log.ok === true && Array.isArray(log.commands) ? log.commands.filter((c) => c.source === 'panel') : []
  check('命令页只有「拉取」一笔：没有「暂存改动(拉取前)」也没有「恢复暂存(拉取后)」'
    + '（实际 ' + panel.map((c) => c.description).join(' | ') + '）',
    panel.length === 1 && panel[0].description === '拉取' && panel[0].exitCode === 0)
}

console.log('')
console.log('=== stashFirst：pull 失败 → error:pull-failed，改动安然在 stash 里 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  /* 本地领先一笔 + 远端领先一笔 = 分叉；这台 git 对分叉又没定策略，pull 自己拒绝。
   * 脏的是 mine.txt（与远端那笔不重叠）—— stash 收走后 pull 在干净工作区上跑，
   * 拒绝纯粹因为分叉。 */
  await sh(`printf 'local-1\\nbase-2\\n' > base.txt && git add -A && git commit -qm local-1`, R)
  await sh(`printf 'diverge-1\\nbase-2\\n' > base.txt && git add -A && git commit -qm diverge-1 && git push -q origin main`, T)
  await sh(`printf 'mine-kept\\n' > mine.txt`, R)
  const reply = await a.H('git/pull')({ repo: R, stashFirst: true, sessionId: 'gp89-pullfail' })
  check('答复形状：ok:false、error:pull-failed、stashed:true、pulled:false、popConflict:false'
    + '（实际 ok=' + reply.ok + ' error=' + reply.error + ' stashed=' + reply.stashed
    + ' pulled=' + reply.pulled + ' popConflict=' + reply.popConflict + ' exitCode=' + reply.exitCode + '）',
    reply.ok === false && reply.error === 'pull-failed' && reply.stashed === true
    && reply.pulled === false && reply.popConflict === false && reply.exitCode !== 0)
  check('stderr 第一句是人话：改动安然在 stash 里 + git stash list/pop 的找回办法前置',
    (reply.stderr || '').indexOf('拉取失败了，你的改动安然在 stash 里') === 0
    && (reply.stderr || '').indexOf('git stash list') > 0 && (reply.stderr || '').indexOf('git stash pop') > 0)
  check('人话后面跟着 git 的原话（分叉拒绝还在 stderr 里）',
    /divergent/i.test(reply.stderr || ''))
  check('改动真的在 stash 里：git stash list 恰好一条，且是拉取前暂存那条',
    (await stashCount(R)) === 1 && /dsh-git-idea: pull 拉取前暂存/.test((await sh('git stash list', R)).out))
  check('工作区是收干净了的样子：mine.txt 回到已提交版本（改动被 stash 收走）',
    (await sh('cat ' + R + '/mine.txt', R)).out.trim() === 'mine')
  const log = await a.H('git/command-log')({ repo: R, sessionCwd: R, sessionId: 'gp89-pullfail', limit: 200 })
  const panel = log.ok === true && Array.isArray(log.commands) ? log.commands.filter((c) => c.source === 'panel') : []
  check('命令页两笔：暂存改动(拉取前)成功、拉取失败；没有「恢复暂存(拉取后)」'
    + '（实际 ' + panel.map((c) => c.description + '/' + String(c.exitCode)).join(' | ') + '）',
    panel.length === 2
    && panel.some((c) => c.description === '暂存改动(拉取前)' && c.exitCode === 0)
    && panel.some((c) => c.description === '拉取' && c.exitCode !== 0)
    && panel.every((c) => c.description !== '恢复暂存(拉取后)'))
  /* 清场：丢弃 stash 里的那份改动、本地对齐远端（local-1 这笔只是分叉道具）。 */
  await sh('git stash drop -q && git reset -q --hard origin/main', R)
}

console.log('')
console.log('=== stashFirst：pop 撞冲突 → popConflict:true，stdout/stderr 有货 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  /* 远端领先一笔动 base-2，本地脏改动也动 base-2 同一行：pull 快进成功（工作区已
   * 被 stash 收干净），stash pop 撞上 —— git 自己把 stash 条目留住。 */
  await sh(`printf 'diverge-1\\npop-theirs\\n' > base.txt && git add -A && git commit -qm pop-theirs && git push -q origin main`, T)
  await sh(`printf 'diverge-1\\npop-mine\\n' > base.txt`, R)
  const reply = await a.H('git/pull')({ repo: R, stashFirst: true, sessionId: 'gp89-popconflict' })
  check('pull 成功而 pop 失败：ok:true、pulled:true、stashed:true、popConflict:true'
    + '（实际 ok=' + reply.ok + ' pulled=' + reply.pulled + ' stashed=' + reply.stashed
    + ' popConflict=' + reply.popConflict + '）',
    reply.ok === true && reply.pulled === true && reply.stashed === true && reply.popConflict === true)
  check('pop 的两路输出都带回来了：popStdout/popStderr 合起来有 CONFLICT 字样'
    + '（实际长度 stdout=' + String(reply.popStdout || '').length + ' stderr=' + String(reply.popStderr || '').length + '）',
    /CONFLICT/.test((reply.popStdout || '') + '\n' + (reply.popStderr || '')))
  check('工作区留着冲突标记（出路要读者自己走）：base.txt 有 <<<<<<<',
    (await sh('cat ' + R + '/base.txt', R)).out.indexOf('<<<<<<<') >= 0)
  check('git 把 stash 条目留住了（丢不掉）：git stash list 恰好一条',
    (await stashCount(R)) === 1)
  const log = await a.H('git/command-log')({ repo: R, sessionCwd: R, sessionId: 'gp89-popconflict', limit: 200 })
  const panel = log.ok === true && Array.isArray(log.commands) ? log.commands.filter((c) => c.source === 'panel') : []
  check('命令页三笔都在，「恢复暂存(拉取后)」那笔退出码非 0'
    + '（实际 ' + panel.map((c) => c.description + '/' + String(c.exitCode)).join(' | ') + '）',
    panel.length === 3 && panel.some((c) => c.description === '恢复暂存(拉取后)' && c.exitCode !== 0))
  /* 清场：放弃工作区冲突、丢掉留住的 stash 条目，对齐远端。 */
  await sh('git reset -q --hard origin/main && git stash drop -q', R)
}

console.log('')
console.log('=== stashFirst：上游问不到 → 人话错误，stash 与 pull 一步不动手 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await sh(`git checkout -q -b gp89-lonely && printf 'mine-lonely\\n' > mine.txt`, R)
  const reply = await a.H('git/pull')({ repo: R, stashFirst: true })
  check('答复形状：ok:false、error:no-upstream（' + String(reply.error) + '），stderr 教人绑上游',
    reply.ok === false && reply.error === 'no-upstream'
    && /还没有上游/.test(reply.stderr || '') && /修改跟踪分支/.test(reply.stderr || ''))
  check('stash 与 pull 都没跑：spy 里一次 stash、一次 pull 都没有',
    findGit(seen, /git 'stash'/).length === 0 && findGit(seen, /git 'pull'/).length === 0)
  check('只问了上游两问：symbolic-ref 问分支、rev-parse @{u} 问上游，各一次',
    findGit(seen, /git 'symbolic-ref' '--quiet' '--short' 'HEAD'/).length === 1
    && findGit(seen, /'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@\{u\}'/).length === 1)
  check('脏改动原封没动：mine.txt 仍是工作区那版',
    (await sh('cat ' + R + '/mine.txt', R)).out.trim() === 'mine-lonely')
  check('stash 栈仍是空的（一步没动手）', (await stashCount(R)) === 0)
  const dseen = []
  const d = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, dseen)
  await sh('git checkout -q --detach HEAD', R)
  const detached = await d.H('git/pull')({ repo: R, stashFirst: true })
  check('游离 HEAD：ok:false、error:detached-head，stderr 说先切回分支',
    detached.ok === false && detached.error === 'detached-head'
    && /游离 HEAD/.test(detached.stderr || '') && /分支列表/.test(detached.stderr || ''))
  check('游离同样一步不动手：没有 stash 也没有 pull',
    findGit(dseen, /git 'stash'/).length === 0 && findGit(dseen, /git 'pull'/).length === 0)
  await sh('git checkout -q main && git reset -q --hard origin/main', R)
}

console.log('')
console.log('=== resetToRemote：本地领先 + 脏改动 → fetch+reset 与远端一致、脏改动被卷掉 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await sh(`printf 'ahead\\n' > resetme.txt && git add -A && git commit -qm gp89-local-only`, R)
  await sh(`printf 'reset-1\\nbase-2\\n' > base.txt && git add -A && git commit -qm reset-1 && git push -q origin main`, T)
  await sh(`printf 'diverge-1\\ndirty-reset\\n' > base.txt`, R)
  const localHead = await rev('HEAD', R)
  const reply = await a.H('git/pull')({ repo: R, resetToRemote: true, sessionId: 'gp89-reset' })
  check('答复形状：ok:true、resetTo:"origin/main"'
    + '（实际 ok=' + reply.ok + ' resetTo=' + String(reply.resetTo) + ' exitCode=' + reply.exitCode + '）',
    reply.ok === true && reply.resetTo === 'origin/main')
  check('HEAD 按到远端那一份：HEAD == origin/main，且不再是本地那笔 ' + localHead.slice(0, 7),
    (await rev('HEAD', R)) === (await rev('origin/main', R)) && (await rev('HEAD', R)) !== localHead)
  check('本地独有的提交没了：log 里有远端的 reset-1、没有 gp89-local-only',
    /reset-1/.test((await sh('git log --format=%s HEAD', R)).out)
    && !/gp89-local-only/.test((await sh('git log --format=%s HEAD', R)).out))
  check('脏改动被卷掉：base.txt 是远端那版 reset-1，工作区全干净',
    (await sh('cat ' + R + '/base.txt', R)).out.trim() === 'reset-1\nbase-2'
    && (await sh('git status --porcelain', R)).out.trim() === '')
  const g = gitLines(seen)
  const atFetch = g.findIndex((c) => /git 'fetch' '--all'/.test(c))
  const atReset = g.findIndex((c) => /git 'reset' '--hard' 'origin\/main'/.test(c))
  check('spy 顺序：fetch --all 在前，reset --hard origin/main 在后，各一次',
    atFetch >= 0 && atReset > atFetch && findGit(seen, /git 'reset' '--hard'/).length === 1)
  const log = await a.H('git/command-log')({ repo: R, sessionCwd: R, sessionId: 'gp89-reset', limit: 200 })
  const panel = log.ok === true && Array.isArray(log.commands) ? log.commands.filter((c) => c.source === 'panel') : []
  /* 命令页按时间倒序（cmdrecMerge 最新在前）：重置在取回之后，索引反而更小。 */
  const atFetched = panel.findIndex((c) => c.description === '覆盖前取回')
  const atReseted = panel.findIndex((c) => c.description === '重置到远端')
  check('命令页两笔：覆盖前取回（fetch --all）、重置到远端（reset --hard origin/main），取回在前，退出码全 0'
    + '（实际 ' + panel.map((c) => c.description + '/' + String(c.exitCode)).join(' | ') + '）',
    panel.length === 2 && atFetched === 1 && atReseted === 0
    && /fetch --all/.test(panel[atFetched].command) && panel[atFetched].exitCode === 0
    && /reset --hard origin\/main/.test(panel[atReseted].command) && panel[atReseted].exitCode === 0)
  check('fetch 那步带 --prune（fetchPrune 默认开，与 git/fetch 默认款同一副 argv）',
    findGit(seen, /git 'fetch' '--all' '--prune'/).length === 1)
}

console.log('')
console.log('=== resetToRemote：fetchPrune 关 → fetch 不带 --prune ===')
{
  const seen = []
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await a.H('git/config-save')({ config: { fetchPrune: false } })
  const reply = await a.H('git/pull')({ repo: R, resetToRemote: true })
  check('答复照旧 ok:true、resetTo:"origin/main"（实际 ok=' + reply.ok + ' resetTo=' + String(reply.resetTo) + '）',
    reply.ok === true && reply.resetTo === 'origin/main')
  check('fetch 那步是裸的 fetch --all（开关关了就一个字不加）',
    findGit(seen, /git 'fetch' '--all' '--prune'/).length === 0
    && findGit(seen, /git 'fetch' '--all'$/).length === 1)
  await freshConfig()
}

console.log('')
console.log('=== resetToRemote：fetch 失败 → fetch-failed，reset 不跑、脏改动原封 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await sh(`git remote set-url origin ${NOWHERE} && printf 'diverge-1\\nfetch-dirty\\n' > base.txt`, R)
  const reply = await a.H('git/pull')({ repo: R, resetToRemote: true })
  check('答复形状：ok:false、error:fetch-failed、resetTo:null（实际 ok=' + reply.ok
    + ' error=' + String(reply.error) + ' resetTo=' + String(reply.resetTo) + '）',
    reply.ok === false && reply.error === 'fetch-failed' && reply.resetTo === null)
  check('reset 一步没跑：spy 里没有 reset',
    findGit(seen, /git 'reset' '--hard'/).length === 0 && findGit(seen, /git 'fetch' '--all'/).length === 1)
  check('脏改动原封：base.txt 还是工作区那版 fetch-dirty（拿旧账覆盖人比不覆盖更糟）',
    (await sh('cat ' + R + '/base.txt', R)).out.trim() === 'diverge-1\nfetch-dirty')
  await sh(`git remote set-url origin ${O} && git reset -q --hard origin/main`, R)
}

console.log('')
console.log('=== resetToRemote：上游问不到 → 人话错误且一步不动手 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await sh(`git checkout -q gp89-lonely && printf 'mine-lonely2\\n' > mine.txt`, R)
  const reply = await a.H('git/pull')({ repo: R, resetToRemote: true })
  check('无上游：ok:false、error:no-upstream（' + String(reply.error) + '），stderr 是绑上游的人话',
    reply.ok === false && reply.error === 'no-upstream'
    && /还没有上游/.test(reply.stderr || '') && /修改跟踪分支/.test(reply.stderr || ''))
  check('一步不动手：spy 里没有 fetch --all 也没有 reset',
    findGit(seen, /git 'fetch' '--all'/).length === 0 && findGit(seen, /git 'reset' '--hard'/).length === 0
    && findGit(seen, /git 'stash'/).length === 0)
  check('脏改动原封：mine.txt 还是工作区那版',
    (await sh('cat ' + R + '/mine.txt', R)).out.trim() === 'mine-lonely2')
  const dseen = []
  const d = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, dseen)
  await sh('git checkout -q --detach HEAD', R)
  const detached = await d.H('git/pull')({ repo: R, resetToRemote: true })
  check('游离 HEAD：ok:false、error:detached-head，人话说先从分支列表切回分支',
    detached.ok === false && detached.error === 'detached-head' && /游离 HEAD/.test(detached.stderr || ''))
  check('游离同样一步不动手：没有 fetch --all 也没有 reset',
    findGit(dseen, /git 'fetch' '--all'/).length === 0 && findGit(dseen, /git 'reset' '--hard'/).length === 0)
  await sh('git checkout -q main && git reset -q --hard origin/main', R)
}

console.log('')
console.log('=== 既有路径回归：无参数 pull 一字不变 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await peerMark('plain-1')
  const reply = await a.H('git/pull')({ repo: R })
  check('ok:true，答复上没有 stashFirst / resetTo 时代的新键（stashed/dirty/popConflict/'
    + 'popStdout/popStderr/resetTo/upstreamSet/pulled 都不在）'
    + '（实际 keys=' + Object.keys(reply).sort().join(',') + '）',
    reply.ok === true
    && reply.stashed === undefined && reply.dirty === undefined && reply.popConflict === undefined
    && reply.popStdout === undefined && reply.popStderr === undefined && reply.resetTo === undefined
    && reply.upstreamSet === undefined && reply.pulled === undefined)
  check('argv 就是 pull 一条：不带 --rebase，没有 stash / reset / fetch --all',
    findGit(seen, /git 'pull' '--rebase'/).length === 0 && findGit(seen, /git 'pull'/).length === 1
    && gitLines(seen).every((c) => c.indexOf("'stash'") < 0 && c.indexOf("'reset'") < 0
      && c.indexOf("'fetch'") < 0))
}

console.log('')
console.log('=== 既有路径回归：rebase:true → pull --rebase ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await peerMark('plain-2')
  const reply = await a.H('git/pull')({ repo: R, rebase: true })
  const pullRb = findGit(seen, /git 'pull' '--rebase'/)
  const pullPlain = findGit(seen, /git 'pull'$/)
  check('ok:true（实际 ok=' + reply.ok + ' exitCode=' + reply.exitCode + '），argv 是 pull --rebase，不带 --rebase 的普通 pull 没跑'
    + '（实际 pull --rebase=' + pullRb.length + ' 条、普通 pull=' + pullPlain.length + ' 条）',
    reply.ok === true && pullRb.length === 1 && pullPlain.length === 0)
  check('答复上没有变体时代的新键（新参数不搭旧路径）',
    reply.stashed === undefined && reply.resetTo === undefined)
}

console.log('')
console.log('=== 既有路径回归：branch 参数 → fetch 远端分支:分支，pull 不跑 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await sh(`cd ${T} && git checkout -q -b side origin/side && printf 's2\\n' > side2.txt && git add -A && git commit -qm side-remote-2 && git push -q origin side`, '/tmp')
  const mainBefore = await rev('refs/heads/main', R)
  const reply = await a.H('git/pull')({ repo: R, branch: 'side' })
  check('ok:true（实际 ok=' + reply.ok + ' exitCode=' + reply.exitCode + '），当前分支仍是 main',
    reply.ok === true && (await sh('git symbolic-ref --short HEAD', R)).out.trim() === 'main')
  check('argv 是 fetch origin side:side（快进 refspec，不带 +），pull 没跑',
    findGit(seen, /git 'fetch' 'origin' 'side:side'/).length === 1
    && findGit(seen, /git 'pull'/).length === 0)
  check('side 真被快进了：side == origin/side，main 一动不动',
    (await rev('refs/heads/side', R)) === (await rev('origin/side', R))
    && (await rev('refs/heads/main', R)) === mainBefore)
}

console.log('')
console.log('=== 既有路径回归：setUpstream → 先绑定再拉，形状与从前一致 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await sh(`git checkout -q -b gp89-reg`, R)
  const reply = await a.H('git/pull')({ repo: R, setUpstream: { remote: 'origin', branch: 'main' } })
  check('答复形状照旧：ok:true、upstreamSet:true、pulled:true、setUpstream.exitCode === 0'
    + '（实际 ok=' + reply.ok + ' upstreamSet=' + String(reply.upstreamSet) + ' pulled=' + String(reply.pulled)
    + ' setUpstream.exitCode=' + (reply.setUpstream != null ? String(reply.setUpstream.exitCode) : 'null') + '）',
    reply.ok === true && reply.upstreamSet === true && reply.pulled === true
    && reply.setUpstream != null && reply.setUpstream.remote === 'origin' && reply.setUpstream.branch === 'main'
    && reply.setUpstream.exitCode === 0)
  const at = findGit(seen, /git 'branch' '--set-upstream-to=origin\/main'/).length
  const pullAt = gitLines(seen).findIndex((c) => /git 'pull'/.test(c))
  check('两条命令都跑了：绑定在前、pull 在后；@{u} 真的指到 origin/main',
    at === 1 && pullAt > 0
    && (await sh('git rev-parse --abbrev-ref --symbolic-full-name @{u}', R)).out.trim() === 'origin/main')
  check('答复上没有变体时代的新键', reply.stashed === undefined && reply.resetTo === undefined)
  await sh('git checkout -q main && git branch -q -D gp89-reg', R)
}

console.log('')
console.log('=== 变体优先：stashFirst / resetToRemote 压过 branch 参数 ===')
{
  const seen = []
  await freshConfig()
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await sh(`git checkout -q -b gp89-lonely2`, R)
  /* 变体只认「读者此刻站着的分支」：branch 参数给了别的分支也不该走 fetch side:side
   * 那条 —— 上游问不到先行挡下，一步不动手（源码里变体排在 branch 分支前）。 */
  const reply = await a.H('git/pull')({ repo: R, stashFirst: true, branch: 'side' })
  check('stashFirst + branch 一起发：变体说了算，走的是 no-upstream（' + String(reply.error) + '）',
    reply.ok === false && reply.error === 'no-upstream')
  check('fetch side:side 那条没跑（branch 参数被变体盖住）',
    findGit(seen, /git 'fetch' 'origin' 'side:side'/).length === 0
    && findGit(seen, /git 'pull'/).length === 0)
  await sh('git checkout -q main', R)
}

if (failed > 0) {
  console.error('gp89-pullctx-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
