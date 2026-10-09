import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 三方合并冲突的 Host 半侧：git/conflict 读三个阶段，git/conflict-save 写回解决结果 ──
 *
 * 真起一个仓库、真制造一次 merge 冲突（两条分支各改同一行），外加 AA（各自新增无
 * base）、UD/DU（一侧删除）、二进制、超 1.2MB 的两条拒绝路径。盯这些：
 *   1. git/conflict：ok；base/ours/theirs 的 text 与 `git show :1:/:2:/:3:` 逐字节
 *      一致；present 按阶段如实回答（AA 缺 :1:、DU 缺 :2:、UD 缺 :3:）；crlf 与
 *      endsWithNewline 逐侧带回；oursLabel/theirsLabel 是分支名（main/feature）；
 *   2. 不在冲突列表的路径给 not-unmerged（「可能已经被解决」）而不是空白；绝对路径
 *      与跳出仓库的相对路径给 invalid-path；不知道是哪个仓库给 no-path；
 *   3. 拒绝路径：单侧超过大小上限整个拒绝（too-large，不给半份）；二进制冲突
 *      （内容带 NUL）给 binary；
 *   4. git/conflict-save：写入字节与 content 逐一致（含结尾无换行的内容）；之后
 *      `ls-files -u` 为空、`git status` 该路径不再是 UU（git add 生效）；嵌套目录
 *      的工作区文件没了也写得进（mkdir -p 兜底）；对已解决路径再存返回
 *      not-unmerged 且一个字节不写；content 非 string 拒绝、超写回上限拒绝；
 *   5. 整件事进了命令页：一行「git add -- 路径」、动作列人话「标记冲突已解决」
 *      （cmdrec 的断言法照 gp49 的 command-log 读法）。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

/* 与 gp49 同一套骨架：HOME / GIT_CONFIG_GLOBAL / SYSTEM 都压到 /tmp —— 这份隔离钉
 * 在 makeBody 与 sh 里面，而不是靠每个调用点记得传。这里比 gp49 多一件事：spec.stdin
 * 必须真的喂进子进程 —— conflict-save 的内容走 stdin 过 cat，不喂它写入的就是空文件。 */
function makeBody(env, spy) {
  const shellEnv = Object.assign({}, process.env, {
    DSH_HOME: HOME + '/.dsh', HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL,
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  }, env)
  function runShell(spec) {
    if (spy !== undefined) spy.push(spec.command)
    return new Promise((res) => {
      const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: shellEnv })
      /* conflict-save 的内容走 stdin：不喂它，`cat > 路径` 就干等到天荒地老。
         空串也得 end —— 那是一次合法的「写零个字节」。 */
      if (typeof spec.stdin === 'string') {
        c.stdin.on('error', () => {})
        c.stdin.end(spec.stdin)
      }
      let o = '', e = ''
      c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
      c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
      c.on('close', x => {
        /* 执行器的 stdoutMaxBytes 契约：超了截断并带 truncated 标记 —— 69-conflict.js
           的 too-large 拒绝正是读这个标记，桩不演它，超限路径就永远测不到。 */
        let out = { text: o }
        if (typeof spec.stdoutMaxBytes === 'number' && Buffer.byteLength(o) > spec.stdoutMaxBytes) {
          out = { text: Buffer.from(o, 'utf8').subarray(0, spec.stdoutMaxBytes).toString('utf8'), truncated: true }
        }
        res({ exitCode: x, stdout: out, stderr: { text: e } })
      })
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

/* 夹具：一次真 merge 撞出全部形态 —— c.txt 双改（UU， stages 1/2/3 齐全）、both.txt
 * 各自新增（AA，无 :1:）、du.txt 本侧删除（DU，无 :2:）、ud.txt 对侧删除（UD，无
 * :3:）、bin.dat 二进制、big.txt 单侧超 1.2MB、dir1/f.txt 与 dir3/g.txt 嵌套路径的
 * UU（后者留给出 mkdir -p 兜底的那一节）。 */
const R = '/tmp/gp50-repo'
const HOME = '/tmp/gp50-home'
const GLOBAL = HOME + '/.gitconfig'
await sh(`rm -rf ${R} ${HOME} && mkdir -p ${HOME} ${R}
cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T
printf 'base-1\\nbase-2\\nbase-3\\n' > c.txt
printf 'a\\n' > a.txt
printf 'ud-base\\n' > ud.txt
printf 'du-base\\n' > du.txt
mkdir -p dir1 && printf 'dir-base\\n' > dir1/f.txt
mkdir -p dir3 && printf 'dir3-base\\n' > dir3/g.txt
{ printf 'BIN'; head -c 1 /dev/zero; printf 'v1\\n'; } > bin.dat
yes 'probe-fill-line' | head -n 100000 > big.txt
git add -A && git commit -qm base
git checkout -qb feature
printf 'feature-1\\nbase-2\\nbase-3\\n' > c.txt
printf 'from-feature\\n' > both.txt
git rm -q ud.txt
printf 'du-feature\\n' > du.txt
printf 'dir-feature\\n' > dir1/f.txt
printf 'dir3-feature\\n' > dir3/g.txt
{ printf 'BIN'; head -c 1 /dev/zero; printf 'v2\\n'; } > bin.dat
sed -i '1s/.*/feature-first/' big.txt
git add -A && git commit -qm feature
git checkout -q main
printf 'main-1\\nbase-2\\nbase-3\\n' > c.txt
printf 'from-main\\n' > both.txt
printf 'ud-main\\n' > ud.txt
git rm -q du.txt
printf 'dir-main\\n' > dir1/f.txt
printf 'dir3-main\\n' > dir3/g.txt
{ printf 'BIN'; head -c 1 /dev/zero; printf 'v3\\n'; } > bin.dat
sed -i '1s/.*/main-first/' big.txt
git add -A && git commit -qm main-side
git merge feature || :
git status --porcelain`, '/tmp')

/* 前置核对：夹具真的踩在要测的形态上，缺一种后面就是白测。 */
{
  const st = await sh('git status --porcelain', R)
  const codes = {}
  for (const line of st.out.split('\n')) {
    if (line.length < 4) continue
    codes[line.slice(3)] = line.slice(0, 2)
  }
  check('夹具前置：UU / AA / DU / UD 各就各位',
    codes['c.txt'] === 'UU' && codes['both.txt'] === 'AA' && codes['du.txt'] === 'DU' && codes['ud.txt'] === 'UD'
    && codes['bin.dat'] === 'UU' && codes['big.txt'] === 'UU'
    && codes['dir1/f.txt'] === 'UU' && codes['dir3/g.txt'] === 'UU')
}

console.log('')
console.log('=== git/conflict：三阶段逐字节、标签、换行信息 ===')
{
  const a = makeBody()
  const reply = await a.H('git/conflict')({ repo: R, path: 'c.txt' })
  const show = async (stage, path) => (await sh(`git show :${stage}:${path}`, R)).out
  check('ok，repo/path 原样带回，merging=true（MERGE_HEAD 在）',
    reply.ok === true && reply.repo === R && reply.path === 'c.txt' && reply.merging === true && reply.cherryPicking === false)
  check('三侧 text 与 git show :1:/:2:/:3: 逐字节一致',
    reply.base.text === await show(1, 'c.txt') && reply.ours.text === await show(2, 'c.txt')
    && reply.theirs.text === await show(3, 'c.txt'))
  check('三侧内容确实是「base-1 / main-1 / feature-1」三条分支各自的版本',
    reply.base.text === 'base-1\nbase-2\nbase-3\n' && reply.ours.text === 'main-1\nbase-2\nbase-3\n'
    && reply.theirs.text === 'feature-1\nbase-2\nbase-3\n')
  check('oursLabel/theirsLabel 是分支名（symbolic-ref → MERGE_HEAD 的 name-rev）',
    reply.oursLabel === 'main' && reply.theirsLabel === 'feature')
  check('换行信息逐侧带回：LF 文件 crlf=false、结尾换行 endsWithNewline=true、没截断',
    [reply.base, reply.ours, reply.theirs].every((s) => s.present === true && s.crlf === false && s.endsWithNewline === true && s.truncated === false))
}

console.log('')
console.log('=== git/conflict：缺阶段如实答 present:false（AA / DU / UD） ===')
{
  const a = makeBody()
  const aa = await a.H('git/conflict')({ repo: R, path: 'both.txt' })
  check('AA：base present:false 且 text 空，两侧各自的新增都在',
    aa.ok === true && aa.base.present === false && aa.base.text === ''
    && aa.ours.present === true && aa.ours.text === 'from-main\n'
    && aa.theirs.present === true && aa.theirs.text === 'from-feature\n')
  const du = await a.H('git/conflict')({ repo: R, path: 'du.txt' })
  check('DU（本侧删除）：ours present:false，theirs 是对侧的修改版',
    du.ok === true && du.ours.present === false && du.ours.text === ''
    && du.theirs.present === true && du.theirs.text === 'du-feature\n' && du.base.present === true)
  const ud = await a.H('git/conflict')({ repo: R, path: 'ud.txt' })
  check('UD（对侧删除）：theirs present:false，ours 是本侧的修改版',
    ud.ok === true && ud.theirs.present === false && ud.theirs.text === ''
    && ud.ours.present === true && ud.ours.text === 'ud-main\n' && ud.base.present === true)
}

console.log('')
console.log('=== git/conflict：读不得与读不得说的明白话 ===')
{
  const a = makeBody()
  const solved = await a.H('git/conflict')({ repo: R, path: 'a.txt' })
  check('不在冲突列表：not-unmerged，话说「可能已经被解决」而不是空白',
    solved.ok === false && solved.error === 'not-unmerged'
    && solved.stderr.indexOf('不在冲突列表') >= 0 && solved.stderr.indexOf('解决') >= 0)
  const escape = await a.H('git/conflict')({ repo: R, path: '../escape.txt' })
  const abs = await a.H('git/conflict')({ repo: R, path: '/etc/hostname' })
  check('跳出仓库与绝对路径都拒绝（invalid-path）',
    escape.ok === false && escape.error === 'invalid-path' && abs.ok === false && abs.error === 'invalid-path')
  const nowhere = await a.H('git/conflict')({ path: 'c.txt' })
  check('不知道是哪个仓库：no-path，不猜一个',
    nowhere.ok === false && nowhere.error === 'no-path')
  const binary = await a.H('git/conflict')({ repo: R, path: 'bin.dat' })
  check('二进制冲突（内容带 NUL）：binary，一句话让人去专用工具',
    binary.ok === false && binary.error === 'binary' && binary.stderr.indexOf('二进制') >= 0)
  const big = await a.H('git/conflict')({ repo: R, path: 'big.txt' })
  check('单侧超 1.2MB：too-large 整个拒绝 —— 拒绝把半份内容当成三个完整版本',
    big.ok === false && big.error === 'too-large' && big.stderr.indexOf('大小上限') >= 0)
  const pre = (await sh('git ls-files -u -- big.txt', R)).out
  check('（前置核对）big.txt 的阶段确实有 1.6MB —— 拒绝是因为真超了，不是没造出来',
    pre.length > 0 && (await sh('git show :1:big.txt | wc -c', R)).out.trim() === '1600000')
}

console.log('')
console.log('=== git/conflict-save：字节一致、git add 生效、命令页有记录 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  const content = 'resolved-1\nresolved-2\n'
  const one = await a.H('git/conflict-save')({ repo: R, path: 'c.txt', content: content, sessionId: 'gp50-s' })
  check('save ok：exitCode 0，答复形状照变更 RPC（command/repo/path 都在）',
    one.ok === true && one.exitCode === 0 && one.command === 'git add -- c.txt' && one.repo === R && one.path === 'c.txt')
  check('写入字节与 content 逐一致（cat 过 stdin 原样落盘，不加也不吃结尾换行）',
    (await sh('cat ' + R + '/c.txt', '/tmp')).out === content)
  check('之后 ls-files -u 没有它了，git status 该路径不再是 UU（git add 标记已解决生效）',
    (await sh('git ls-files -u -- c.txt', R)).out === ''
    && (await sh('git status --porcelain -- c.txt', R)).out.trim() === 'M  c.txt')
  const nl = await a.H('git/conflict-save')({ repo: R, path: 'dir1/f.txt', content: 'no-trailing-newline', sessionId: 'gp50-s' })
  check('结尾无换行的内容逐字节落盘（不会被补一个 \\n）',
    nl.ok === true && (await sh('cat ' + R + '/dir1/f.txt', '/tmp')).out === 'no-trailing-newline'
    && (await sh('git ls-files -u -- dir1/f.txt', R)).out === '')
  const log = await a.H('git/command-log')({ repo: R, sessionCwd: R, sessionId: 'gp50-s', limit: 200 })
  /* 命令页按时间倒序，本块存了两条：点名找 c.txt 那一条，别拿先到的算。 */
  const rec = log.ok === true && Array.isArray(log.commands)
    ? log.commands.find((c) => c.description === '标记冲突已解决' && c.command === 'git add -- c.txt') : null
  check('命令页有「标记冲突已解决」记录：一行 git add -- 路径，面板来源、退出码 0',
    rec != null && rec.command === 'git add -- c.txt' && rec.source === 'panel'
    && rec.exitCode === 0 && rec.cwd === R && rec.sessionId === 'gp50-s')
  check('生成的写盘命令是 cat 的形状、内容走 stdin 不进命令行（argv 里没有它）',
    seen.some((c) => c.indexOf("cat > 'c.txt'") >= 0)
    && seen.every((c) => c.indexOf('resolved-1') < 0))
}

console.log('')
console.log('=== git/conflict-save：工作区里目录整个没了 —— mkdir -p 兜底（UD 的形状） ===')
{
  const a = makeBody()
  /* dir3/g.txt 仍是 UU（stages 在索引里，写盘守卫问的是索引），把工作区的整个目录
     删掉再存 —— 写盘命令里的 mkdir -p 就是给这个形状兜底的。 */
  const gone = (await sh('test -d ' + R + '/dir3', '/tmp')).code !== 0
  await sh('rm -rf ' + R + '/dir3', '/tmp')
  const still = await a.H('git/conflict')({ repo: R, path: 'dir3/g.txt' })
  const saved = await a.H('git/conflict-save')({ repo: R, path: 'dir3/g.txt', content: 'recreated\n', sessionId: 'gp50-s2' })
  check('目录没了仍读得出三个阶段、存得回去：目录被 mkdir -p 重建、内容逐字节落盘、git add 生效',
    gone === false && still.ok === true && saved.ok === true
    && (await sh('cat ' + R + '/dir3/g.txt', '/tmp')).out === 'recreated\n'
    && (await sh('git ls-files -u -- dir3/g.txt', R)).out === '')
}

console.log('')
console.log('=== git/conflict-save：护栏 —— 不在冲突列表不写；content 不是字符串拒绝 ===')
{
  const a = makeBody()
  const solved = await a.H('git/conflict-save')({ repo: R, path: 'c.txt', content: '覆盖读者的成果', sessionId: 'gp50-s' })
  check('已解决的路径再存：not-unmerged，且一个字节不写（打开界面到点按钮之间可能已在别处解决）',
    solved.ok === false && solved.error === 'not-unmerged'
    && (await sh('cat ' + R + '/c.txt', '/tmp')).out === 'resolved-1\nresolved-2\n')
  const noAdd = await a.H('git/conflict-save')({ repo: R, path: 'c.txt', content: 'x', sessionId: 'gp50-s' })
  check('被拒的那次连 git add 也没执行（ls-files -u 依旧没有它，status 不是 UU）',
    noAdd.ok === false && (await sh('git ls-files -u -- c.txt', R)).out === ''
    && (await sh('git status --porcelain -- c.txt', R)).out.trim() === 'M  c.txt')
  const badNum = await a.H('git/conflict-save')({ repo: R, path: 'ud.txt', content: 42, sessionId: 'gp50-s' })
  const badNone = await a.H('git/conflict-save')({ repo: R, path: 'ud.txt', sessionId: 'gp50-s' })
  check('content 非 string（数字 / 缺席）都拒绝（bad-content），UD 路径原样未动',
    badNum.ok === false && badNum.error === 'bad-content' && badNone.ok === false && badNone.error === 'bad-content'
    && (await sh('git status --porcelain -- ud.txt', R)).out.slice(0, 2) === 'UD')
  const huge = await a.H('git/conflict-save')({ repo: R, path: 'ud.txt', content: 'x'.repeat(4000001), sessionId: 'gp50-s' })
  check('超过写回上限（4MB）拒绝（too-large），一个字节没写',
    huge.ok === false && huge.error === 'too-large'
    && (await sh('git status --porcelain -- ud.txt', R)).out.slice(0, 2) === 'UD')
  const escape = await a.H('git/conflict-save')({ repo: R, path: '../outside', content: 'x', sessionId: 'gp50-s' })
  check('路径护栏在写回这条路上同样成立（invalid-path）',
    escape.ok === false && escape.error === 'invalid-path')
}

if (failed > 0) {
  console.error('gp50-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
