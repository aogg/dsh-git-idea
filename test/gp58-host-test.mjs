import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 历史页右键与多选的宿主半侧：git/edit-check / git/commit-messages / git/reword /
 *    git/sequence 多目标 / git/commit-detail 的 {base,head} 形态 ──
 *
 * 真仓库（gp56/gp54 的骨架：HOME 与 GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM 都压到
 * /tmp，谁也摸不到跑测试这个人的真配置），四个仓库各管一段：
 *   R  —— 只读三条的底座：c1..c3 先推到 bare 远端（pushed 的正例），c4 与两个改名
 *         提交留在本地（pushed 的反例；f1 的改名让 {base,head} 的合计清单里有真正
 *         的 R 两段路径 —— base 里得先有这个文件，rename 检测才认得出来），side
 *         分支挂一个不在 main 历史上的提交（reachable 的反例）；
 *   RC —— reword 的现场（每节从 R 重新克隆，hash 与 R 一致）：安全链七道闸逐一
 *         验拒，HEAD 提交走 amend、中间提交走 rebase，rebase 撞身份缺失失败时
 *         分支必须自己回到原位；
 *   RS —— sequence 多目标：revert 两个 hash 各一条反向提交、cherry-pick 按序落、
 *         HEAD 与分支名不再被拒（gp34a 那场回归的两张脸）、去重与前导 - 注入、
 *         50 上限；
 *   R 自己再答 {base,head} 的合计清单。
 *
 * 身份全在仓库 local config 里：reword 的「失败回原位」一节故意把 local 身份清空
 * —— rebase 的 exec `git commit --amend` 没有身份必然失败，正好当那把刀。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp58-home'
const GLOBAL = HOME + '/.gitconfig'
const R = '/tmp/gp58-repo'
const O = '/tmp/gp58-origin.git'
const RC = '/tmp/gp58-reword'
const RS = '/tmp/gp58-seq'

function makeBody() {
  const shellEnv = Object.assign({}, process.env, {
    DSH_HOME: HOME + '/.dsh', HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL,
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  })
  function runShell(spec) {
    return new Promise((res) => {
      const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: shellEnv })
      let o = '', e = ''
      c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
      c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
      c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
    })
  }
  const handlers = new Map()
  const services = { shell: { resolve: r => r, run: runShell }, sessions: { get: () => ({ header: { cwd: R } }) } }
  const ctx = { get: n => services[n], effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return { H: n => handlers.get(n) }
}

function sh(cmd, cwd) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', cmd], { cwd, env: Object.assign({}, process.env, {
      DSH_HOME: HOME + '/.dsh', HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL,
      GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    }) })
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
const rev = async (repo, at) => (await sh('git rev-parse ' + at, repo)).out.trim()
const logSubjects = async (repo, at) => (await sh('git log --format=%s ' + (at || ''), repo)).out.trim().split('\n')

/* fixture：R 先落 c1..c3 并推到 bare 远端（这三个是「已推送」的正例），再在本地落
 * c4 与两次改名（f3 → f3-renamed、f1 → f1-renamed，HEAD=ren2）；side 从 c1 分出、
 * 改 f2.txt（与 main 上 c2 的同名文件相撞 —— sequencer 忙那一节用它制造冲突现场）。 */
await sh(`rm -rf ${R} ${O} ${RC} ${RS} ${HOME} && mkdir -p ${HOME} ${R}
cd ${R} && git init -q -b main && git config user.name T && git config user.email t@t
echo r1 > f1.txt && git add -A && git commit -qm c1
echo r2-main > f2.txt && git add -A && git commit -qm c2
echo r3 > f3.txt && git add -A && git commit -qm c3
git init -q --bare ${O} && git remote add origin ${O} && git push -q origin main
echo r4 > f4.txt && git add -A && git commit -qm c4
git mv f3.txt f3-renamed.txt && git commit -qm ren
git mv f1.txt f1-renamed.txt && git commit -qm ren2
git tag c1 HEAD~5 && git tag c2 HEAD~4 && git tag c3 HEAD~3 && git tag c4 HEAD~2 && git tag ren HEAD~1 && git tag ren2 HEAD
git checkout -qb side c1 && echo r2-side > f2.txt && git add -A && git commit -qm side1
git checkout -q main`, '/tmp')

const C1 = await rev(R, 'c1')
const C2 = await rev(R, 'c2')
const C3 = await rev(R, 'c3')
const C4 = await rev(R, 'c4')
const REN2 = await rev(R, 'ren2')
const SIDE1 = await rev(R, 'side')

console.log('')
console.log('=== git/edit-check：四问各来一条正反例 ===')
{
  const a = makeBody()
  const ask = async (hashes) => a.H('git/edit-check')({ sessionId: 's-1', repo: R, hashes: hashes })
  const one = (hash) => ask([hash])
  const c1 = await one(C1)
  const c1row = c1.ok === true ? c1.checks[0] : {}
  check('c1（根提交、已推送、不在 HEAD 上）：reachable=true pushed=true isRoot=true isHead=false；head 是完整 HEAD',
    c1.ok === true && c1row.hash === C1 && c1row.reachable === true && c1row.pushed === true
    && c1row.isRoot === true && c1row.isHead === false && c1.head === REN2)
  const c4 = await one(C4)
  const c4row = c4.ok === true ? c4.checks[0] : {}
  check('c4（在历史上、未推送、非 HEAD、非根）：reachable=true pushed=false isHead=false isRoot=false',
    c4.ok === true && c4row.reachable === true && c4row.pushed === false && c4row.isHead === false && c4row.isRoot === false)
  const side = await one(SIDE1)
  const siderow = side.ok === true ? side.checks[0] : {}
  check('side1（别的分支上的提交）：reachable=false（merge-base 退出码 1 按不在答）',
    side.ok === true && siderow.reachable === false && siderow.isHead === false)
  const headRow = (await one(REN2)).checks[0]
  check('ren2 就是 HEAD：isHead=true（isRoot 的反例同一条：它有父提交）',
    headRow.isHead === true && headRow.isRoot === false)
  const short = await one(REN2.slice(0, 7))
  check('短 hash 也认（isHead 按前缀比对）',
    short.ok === true && short.checks[0].hash === REN2.slice(0, 7) && short.checks[0].isHead === true)
  const empty = await a.H('git/edit-check')({ sessionId: 's-1', repo: R, hashes: [] })
  const junk = await a.H('git/edit-check')({ sessionId: 's-1', repo: R, hashes: ['main', 'HEAD', 'not-a-hash'] })
  check('干净清单为空（没给 / 全被清洗掉）→ ok:false hash is required',
    empty.ok === false && empty.error === 'hash is required'
    && junk.ok === false && junk.error === 'hash is required')
  const many = await ask(Array.from({ length: 51 }, () => C4))
  check('一次最多 50 个（去重前 51 个就拒，多一个都不读）',
    many.ok === false && many.error === 'too-many-hashes')
  const pair = await ask([C4, C1])
  check('保序：请求 [c4, c1] 答的就是这个顺序（宿主不重排，交给 git 的 argv）',
    pair.ok === true && JSON.stringify(pair.checks.map((x) => x.hash)) === JSON.stringify([C4, C1]))
  const dup = await ask([C4, C4])
  check('重复的 hash 也算超交（given 数的是清洗前）→ too-many-hashes',
    dup.ok === false && dup.error === 'too-many-hashes')
}

console.log('')
console.log('=== git/commit-messages：%B 原样、20 上限、坏 hash 拒绝 ===')
{
  const a = makeBody()
  await sh(`rm -rf ${RC} && git clone -q ${R} ${RC} && cd ${RC} && git config user.name T && git config user.email t@t
printf "subject line\\n\\nbody para\\n" > /tmp/gp58-msg && git commit -q --allow-empty -F /tmp/gp58-msg`, '/tmp')
  const MSGC = await rev(RC, 'HEAD')
  const ask = async (hashes) => a.H('git/commit-messages')({ sessionId: 's-1', repo: RC, hashes: hashes })
  const oneMsg = await ask([MSGC])
  check('%B 原样取回（标题 + 空行 + 正文，尾随空白收掉）',
    oneMsg.ok === true && oneMsg.messages.length === 1
    && oneMsg.messages[0].message === 'subject line\n\nbody para'
    && oneMsg.messages[0].subject === 'subject line')
  const ordered = await ask([C2, C1])
  check('按请求的顺序答（不重排）',
    ordered.ok === true && JSON.stringify(ordered.messages.map((m) => m.hash)) === JSON.stringify([C2, C1])
    && ordered.messages[1].message === 'c1' && ordered.messages[0].message === 'c2')
  const bad = await ask(['ffff000000'])
  check('坏 hash：commit-not-found，带原话', bad.ok === false && bad.error === 'commit-not-found' && typeof bad.stderr === 'string')
  const empty = await a.H('git/commit-messages')({ sessionId: 's-1', repo: RC, hashes: ['main'] })
  check('ref 名不算 hash（只认 7–40 位十六进制）→ hash is required',
    empty.ok === false && empty.error === 'hash is required')
  const many = await ask(Array.from({ length: 21 }, () => C4))
  check('一次最多 20 条：21 个直接拒（先收窄选区）',
    many.ok === false && many.error === 'too-many-hashes')
}

console.log('')
console.log('=== git/reword：安全链七道闸，然后两条动手路 ===')
{
  /* RC 从 R 重新克隆：干净的 main = ren2，不再有别节加的提交。 */
  await sh(`rm -rf ${RC} && git clone -q ${R} ${RC} && cd ${RC} && git config user.name T && git config user.email t@t`, '/tmp')
  const a = makeBody()
  const ask = (input) => a.H('git/reword')(Object.assign({ sessionId: 's-1', repo: RC }, input))
  const headNow = () => rev(RC, 'HEAD')
  const RC_HEAD = REN2

  const bad = await ask({ hash: 'main', message: 'x' })
  check('ref 名不是 hash → bad-value（没有做任何改动）',
    bad.ok === false && bad.error === 'bad-value' && (await headNow()) === RC_HEAD)
  const blank = await ask({ hash: C4, message: '   \n  ' })
  check('空消息（trim 后为空）→ a commit message is required',
    blank.ok === false && blank.error === 'a commit message is required' && (await headNow()) === RC_HEAD)
  const long = await ask({ hash: C4, message: 'a'.repeat(8001) })
  check('超长（8001 > 8000）→ message-too-long', long.ok === false && long.error === 'message-too-long' && (await headNow()) === RC_HEAD)
  const moved = await ask({ hash: C4, message: 'nope', expect: C1 })
  check('expect 对不上（读数过期）→ head-moved，分支没动',
    moved.ok === false && moved.error === 'head-moved' && (await headNow()) === RC_HEAD)
  const foreign = await ask({ hash: SIDE1, message: 'nope' })
  check('不在当前分支历史上 → not-reachable（改了也不会生效，挡在动手前）',
    foreign.ok === false && foreign.error === 'not-reachable' && (await headNow()) === RC_HEAD)
  const root = await ask({ hash: C1, message: 'root reword' })
  check('根提交 → is-root（它没有父提交可以变基）',
    root.ok === false && root.error === 'is-root' && (await headNow()) === RC_HEAD)

  /* sequencer 忙：cherry-pick side1 撞上 c2 的 f2.txt，现场留在 .git 里（单条拣选
   * 的冲突现场是 CHERRY_PICK_HEAD，不带 .git/sequencer —— 后者的探测只认多提交的
   * 序列）。 */
  const conflict = await sh('cd ' + RC + ' && git cherry-pick ' + SIDE1, '/tmp')
  check('（铺垫）cherry-pick 真的撞出冲突、现场还在',
    conflict.code !== 0 && (await sh('test -f ' + RC + '/.git/CHERRY_PICK_HEAD && echo yes', '/tmp')).out.trim() === 'yes')
  const busy = await ask({ hash: C4, message: 'busy reword' })
  check('sequencer 忙 → sequencer-busy（别人的进行时上不再起一场）',
    busy.ok === false && busy.error === 'sequencer-busy' && (await headNow()) === RC_HEAD)
  await sh('cd ' + RC + ' && git cherry-pick --abort', '/tmp')
  check('（收场）abort 后现场干净', (await sh('test -d ' + RC + '/.git/sequencer && echo yes || echo no', '/tmp')).out.trim() === 'no')

  /* 动手路一：HEAD 提交走 amend。树不变、父不变、只有消息换。 */
  const treeBefore = await rev(RC, 'HEAD^{tree}')
  const parentBefore = await rev(RC, 'HEAD~1')
  const rewordHead = await ask({ hash: RC_HEAD, message: 'ren2 with new message\n\nnew body', expect: RC_HEAD })
  const headAfterAmend = await headNow()
  check('HEAD 提交改写成功（amend 路）：ok、newHead 是新 HEAD',
    rewordHead.ok === true && rewordHead.newHead === headAfterAmend && headAfterAmend !== RC_HEAD)
  check('amend 只换了消息：树与父提交一字不动',
    (await rev(RC, 'HEAD^{tree}')) === treeBefore && (await rev(RC, 'HEAD~1')) === parentBefore
    && (await sh('git log -1 --format=%B', RC)).out.trim() === 'ren2 with new message\n\nnew body')
  check('amend 进了「命令」页（答复带着真跑的命令）',
    typeof rewordHead.command === 'string' && rewordHead.command.indexOf('commit --amend') >= 0)

  /* 动手路二：中间提交走 rebase -i + exec amend。只有那一条消息变了。 */
  const subjectsBefore = await logSubjects(RC, '')
  const treesBefore = {}
  for (const at of ['HEAD', 'HEAD~1', 'HEAD~2']) treesBefore[at] = await rev(RC, at + '^{tree}')
  const rewordMid = await ask({ hash: C2, message: 'c2 with a better message' })
  const subjectsAfter = await logSubjects(RC, '')
  const expectedSubjects = subjectsBefore.slice()
  expectedSubjects[subjectsBefore.indexOf('c2')] = 'c2 with a better message'
  check('中间提交改写成功（rebase 路）：ok、newHead 是重放后的新 HEAD',
    rewordMid.ok === true && rewordMid.newHead === (await headNow()) && (await headNow()) !== headAfterAmend)
  check('只有那一条消息变了：其余五条的标题原样、顺序不变',
    JSON.stringify(subjectsAfter) === JSON.stringify(expectedSubjects))
  check('重放的三条树都不变（改动一字未动，动的只有消息）',
    (await rev(RC, 'HEAD^{tree}')) === treesBefore['HEAD'] && (await rev(RC, 'HEAD~1^{tree}')) === treesBefore['HEAD~1']
    && (await rev(RC, 'HEAD~2^{tree}')) === treesBefore['HEAD~2'])

  /* 失败回原位：rebase 的 exec 撞上「没有提交身份」，必须自己 abort 干净。目标用
   * HEAD~2 —— C2 那场 rebase 成功后老 hash 全部换代，旧 C3 已经不在当前分支的
   * 历史上了（那样会被更早的 reachable 闸挡下，试不到 rebase 失败这一条）。 */
  await sh('cd ' + RC + ' && git config user.name "" && git config user.email ""', '/tmp')
  const failTarget = await rev(RC, 'HEAD~2')
  const preFailHead = await headNow()
  const preFailSubjects = await logSubjects(RC, '')
  const boom = await ask({ hash: failTarget, message: 'this rebase will fail' })
  check('rebase 失败 → rebase-failed + aborted=true（git 的原话带回来）',
    boom.ok === false && boom.error === 'rebase-failed' && boom.aborted === true
    && typeof boom.stderr === 'string' && boom.stderr.indexOf('rebase') >= 0)
  check('失败时分支回到原位：HEAD 与提交史一字不动',
    (await headNow()) === preFailHead && JSON.stringify(await logSubjects(RC, '')) === JSON.stringify(preFailSubjects))
  check('现场收干净：.git 里没有 rebase 的半成品',
    (await sh('test -d ' + RC + '/.git/rebase-merge -o test -d ' + RC + '/.git/rebase-apply && echo dirty || echo clean', '/tmp')).out.trim() === 'clean')
}

console.log('')
console.log('=== git/sequence 多目标：revert 两条、cherry-pick 按序、HEAD/分支名不再被拒 ===')
{
  const a = makeBody()
  const seq = (input) => a.H('git/sequence')(Object.assign({ sessionId: 's-1', repo: RS }, input))
  /* RS：从 R 克隆，再铺一段各管一个文件的提交好让 revert 不相撞。 */
  await sh(`rm -rf ${RS} && git clone -q ${R} ${RS} && cd ${RS} && git config user.name T && git config user.email t@t
echo A > aA.txt && git add -A && git commit -qm rA
echo B > aB.txt && git add -A && git commit -qm rB
echo C > aC.txt && git add -A && git commit -qm rC`, '/tmp')
  const RA = await rev(RS, 'HEAD~2')
  const RB = await rev(RS, 'HEAD~1')

  const rev2 = await seq({ op: 'revert', action: 'start', targets: [RA, RB] })
  check('revert 两个 hash：ok，各生成一条反向提交、argv 顺序 = 落地顺序（最旧的先落）',
    rev2.ok === true && JSON.stringify(await logSubjects(RS, '-3')) === JSON.stringify(['Revert "rB"', 'Revert "rA"', 'rC']))
  check('两处改动都没了', (await sh('test ! -f ' + RS + '/aA.txt && test ! -f ' + RS + '/aB.txt && echo gone', '/tmp')).out.trim() === 'gone')

  /* cherry-pick 按序落在当前分支。 */
  await sh('cd ' + RS + ' && git checkout -qb picksrc main~2 && echo p1 > p1.txt && git add -A && git commit -qm p1 && echo p2 > p2.txt && git add -A && git commit -qm p2 && git checkout -q main', '/tmp')
  const P1 = await rev(RS, 'picksrc~1')
  const P2 = await rev(RS, 'picksrc')
  const pick = await seq({ op: 'cherry-pick', action: 'start', targets: [P1, P2] })
  check('cherry-pick 两个 hash：按 argv 顺序落在当前分支（p1 在前 p2 在后），文件都到了',
    pick.ok === true && JSON.stringify(await logSubjects(RS, '-2')) === JSON.stringify(['p2', 'p1'])
    && (await sh('test -f ' + RS + '/p1.txt && test -f ' + RS + '/p2.txt && echo both', '/tmp')).out.trim() === 'both')

  /* gp34a 那场回归的两张脸：HEAD 与分支名都曾是「清洗掉 → a commit is required」。 */
  const atHead = await seq({ op: 'revert', action: 'start', target: 'HEAD' })
  check('单 target 字符串 HEAD 不被拒（真发了一条反向提交）',
    atHead.ok === true && (await logSubjects(RS, '-1'))[0] === 'Revert "p2"')
  const headBeforeMerge = await rev(RS, 'HEAD')
  await sh('cd ' + RS + ' && git branch mrgsrc && echo m0 > m0.txt && git add -A && git commit -qm m0 && echo m1 > m1.txt && git add -A && git commit -qm m1 && git checkout -q mrgsrc && echo other > other.txt && git add -A && git commit -qm other && git checkout -q main', '/tmp')
  const headAtMerge = await rev(RS, 'HEAD')
  const merge = await seq({ op: 'merge', action: 'start', target: 'mrgsrc' })
  check('merge 的目标是分支名：不被拒，真并进来（合并提交有两个父提交）',
    merge.ok === true && (await sh('git rev-list --parents -n1 HEAD', RS)).out.trim().split(' ').length === 3
    && (await rev(RS, 'HEAD~1')) === headAtMerge && headAtMerge !== headBeforeMerge)

  await sh('cd ' + RS + ' && echo D > aD.txt && git add -A && git commit -qm rD', '/tmp')
  const RD = await rev(RS, 'HEAD')
  const dup = await seq({ op: 'revert', action: 'start', targets: [RD, RD] })
  check('去重：同一个 hash 给两遍只 revert 一条', dup.ok === true && (await logSubjects(RS, '-1'))[0] === 'Revert "rD"')
  const inject = await seq({ op: 'revert', action: 'start', targets: ['--amend'] })
  const inject2 = await seq({ op: 'revert', action: 'start', target: '-x' })
  check('前导 - 的目标清洗掉（注入防护保留）：目标集为空 → a commit is required',
    inject.ok === false && inject.error === 'a commit is required'
    && inject2.ok === false && inject2.error === 'a commit is required')

  /* 50 上限：51 个不同 hash、每个都带真改动（空提交的 revert 会被 git 判成 empty
   * 中断整场），直接铺在 main 上 —— revert 的目标必须真的在眼前这份树上，否则
   * 删一个 main 上没有的文件就是一场冲突。只有前 50 个被应用。 */
  await sh('cd ' + RS + ' && for i in $(seq -w 1 51); do echo $i > e$i.txt && git add -A && git commit -qm e$i; done', '/tmp')
  const caps = (await sh('cd ' + RS + ' && git rev-list -51 HEAD', '/tmp')).out.trim().split('\n').reverse()
  const before = (await sh('git rev-list --count HEAD', RS)).out.trim()
  const capped = await seq({ op: 'revert', action: 'start', targets: caps })
  const after = (await sh('git rev-list --count HEAD', RS)).out.trim()
  check('51 个目标：ok，但只应用前 50 个（封顶不报错，客户端自己负责收窄）',
    capped.ok === true && Number(after) - Number(before) === 50
    && (await logSubjects(RS, '-1'))[0] === 'Revert "e50"')
}

console.log('')
console.log('=== git/commit-detail 的 {base,head}：合计清单、R 两段路径、坏 hash 拒绝 ===')
{
  const a = makeBody()
  const range = await a.H('git/commit-detail')({ sessionId: 's-1', repo: R, base: C1, head: REN2 })
  const names = range.ok === true ? range.files.map((f) => f.path) : []
  const renamed = range.ok === true ? range.files.find((f) => f.path === 'f1-renamed.txt') : null
  check('合计清单：段里的文件都在，base 自己的 f1.txt 不在（它的下场是改名，不是删除）',
    range.ok === true && names.indexOf('f2.txt') >= 0 && names.indexOf('f4.txt') >= 0
    && names.indexOf('f3-renamed.txt') >= 0 && names.indexOf('f1.txt') < 0)
  check('R 带两段路径：path=新名、from=旧名、状态字母 R 开头',
    renamed !== undefined && renamed !== null && renamed.from === 'f1.txt' && renamed.status.charAt(0) === 'R')
  check('截断标记在场（这段远没到上限，false）', range.ok === true && range.truncated === false)
  const badBase = await a.H('git/commit-detail')({ sessionId: 's-1', repo: R, base: 'main', head: REN2 })
  const badHead = await a.H('git/commit-detail')({ sessionId: 's-1', repo: R, base: C1, head: REN2 + 'z' })
  check('坏 hash（base 用了 ref 名 / head 带尾巴）→ bad-value',
    badBase.ok === false && badBase.error === 'bad-value' && badHead.ok === false && badHead.error === 'bad-value')
  const single = await a.H('git/commit-detail')({ sessionId: 's-1', repo: R, hash: C4 })
  check('旧的单 hash 形态一字不变（hash 字段与文件清单照旧）',
    single.ok === true && single.hash === C4 && single.subject === 'c4' && single.files.length === 1)
}

if (failed > 0) {
  console.error('gp58-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
