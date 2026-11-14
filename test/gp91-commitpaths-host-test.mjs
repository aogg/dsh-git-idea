import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── git/commit 的 paths 优先级（Host 半侧）──
 *
 * 勾选add 那次改造给 git/commit 扩了 input.paths：非空时先 `git add -- 这些路径`
 * 再 commit（勾选未暂存路径随这次提交走）。优先级在 Host 写死：paths > stageAll
 * （一件都没勾时的兜底）> 裸 commit（索引里已有东西）。客户端保证 paths 与
 * stageAll 不同时给，但 Host 不信客户端 —— 本套件盯着 Host 这半：
 *
 *   1. paths 非空 → add -- 路径在前、commit -m 在后，没有 add -A；提交内容恰是
 *      「勾选路径 + 提交前已在索引里的」，别的未暂存改动不进；
 *   2. paths 与 stageAll 同时给 → 只走 paths（stageAll 被无视）；
 *   3. 无 paths、stageAll:true → add -A + commit，工作区全进；
 *   4. paths 是空数组 → 不算 paths 分支，照旧走 stageAll；
 *   5. 无 paths 无 stageAll → 裸 commit，工作区未暂存的不进；
 *   6. paths 里非字符串的项被洗掉（panelPaths 只收字符串），合法项照用；
 *   7. add 失败（pathspec 不中）→ 答复 ok:false、commit 不跑；
 *   8. 空 message → 答复层直接拒绝，一条命令都不起（既有规矩的回归）；
 *   9. 命令页：add 与 commit 两笔都记「提交」，退出码如实（读不记）。
 *
 * 夹具照 gp89 的骨架：真仓库 + 真 git，HOME/GIT_CONFIG_* 压进 /tmp，shell 层 spy
 * 记下每一条命令。每个场景前把仓库擦回 HEAD（reset --hard + clean -fd）。 */

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

/* spy 里混着日志攒批冲刷的管道命令，git 命令按「引号包裹的子命令」滤出来。 */
const gitLines = (seen) => seen.filter((c) => /git '/.test(c))
const committed = async () => (await sh('git show --name-only --format= HEAD', R)).out.trim().split('\n').filter((l) => l.length > 0).sort()
const dirty = async () => (await sh('git status --porcelain', R)).out.trim()
const wipe = () => sh('git reset -q --hard HEAD && git clean -qfd && git cat-file -p $(git rev-parse HEAD^{tree}) >/dev/null', R)

const R = '/tmp/gp91-repo'
const HOME = '/tmp/gp91-home'
const GLOBAL = HOME + '/.gitconfig'

await sh(`rm -rf ${R} ${HOME} && mkdir -p ${HOME} ${R}
cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T
printf 'base\\n' > base.txt && git add -A && git commit -qm first
printf 'other\\n' > other.txt && git add -A && git commit -qm second`, '/tmp')

console.log('')
console.log('=== paths 非空：add -- 路径在前、commit 在后，内容恰是勾选 + 索引既有 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  /* 工作区三处：m.txt 改动（勾选要 add 的）、u.txt 未跟踪（勾选要 add 的）、
     o.txt 改动（没勾，必须留在工作区）；索引里预先收了 s.txt（提交前就在索引里，
     照旧随这次提交走）。 */
  await wipe()
  await sh(`printf 'm-edited\\n' > m.txt && printf 'o-edited\\n' > o.txt && printf 'u\\n' > u.txt && printf 's\\n' > s.txt && git add s.txt`, R)
  const reply = await a.H('git/commit')({ repo: R, message: '勾选的随提交走', paths: ['m.txt', 'u.txt'], sessionId: 'gp91-paths' })
  check('答复 ok:true（实际 ' + JSON.stringify({ ok: reply.ok, exitCode: reply.exitCode }) + '）',
    reply.ok === true && reply.exitCode === 0)
  const atAdd = gitLines(seen).findIndex((c) => /git 'add' '--' 'm\.txt' 'u\.txt'/.test(c))
  const atCommit = gitLines(seen).findIndex((c) => /git 'commit' '-m' '勾选的随提交走'/.test(c))
  check('spy 顺序：add -- m.txt u.txt 在前，commit -m 在后，全程没有 add -A',
    atAdd >= 0 && atCommit > atAdd && gitLines(seen).every((c) => /git 'add' '-A'/.test(c) === false))
  check('提交内容：这次的文件就是 m.txt/u.txt（勾选的）+ s.txt（索引既有的）',
    JSON.stringify(await committed()) === JSON.stringify(['m.txt', 's.txt', 'u.txt']))
  check('没勾的 o.txt 留在工作区（勾选没把它卷进提交，还是未跟踪）',
    (await dirty()).indexOf('?? o.txt') >= 0)
}

console.log('')
console.log('=== paths 与 stageAll 同时给：只走 paths（Host 不信客户端的「不同时给」） ===')
{
  const seen = []
  const a = makeBody({}, seen)
  await wipe()
  await sh(`printf 'm-2\\n' > m.txt && printf 'u\\n' > u.txt && printf 'leak\\n' > leak.txt`, R)
  const reply = await a.H('git/commit')({ repo: R, message: '只认 paths', paths: ['m.txt'], stageAll: true })
  check('答复 ok:true', reply.ok === true && reply.exitCode === 0)
  check('spy 里一次 add -A 都没有（stageAll 被无视）',
    gitLines(seen).every((c) => /git 'add' '-A'/.test(c) === false))
  check('这次提交只带 m.txt（leak.txt/u.txt 没被卷进来）',
    JSON.stringify(await committed()) === JSON.stringify(['m.txt']))
  check('leak.txt 留在工作区', (await dirty()).indexOf('leak.txt') >= 0)
}

console.log('')
console.log('=== 无 paths、stageAll:true：add -A 兜底，工作区全进 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  await wipe()
  await sh(`printf 'm-3\\n' > m.txt && printf 'u-3\\n' > u.txt`, R)
  const reply = await a.H('git/commit')({ repo: R, message: '全都要', stageAll: true })
  check('答复 ok:true', reply.ok === true && reply.exitCode === 0)
  const atAll = gitLines(seen).findIndex((c) => /git 'add' '-A'/.test(c))
  const atCommit = gitLines(seen).findIndex((c) => /git 'commit' '-m' '全都要'/.test(c))
  check('spy 顺序：add -A 在前、commit 在后', atAll >= 0 && atCommit > atAll)
  check('这次提交带工作区两件（m.txt/u.txt）（实际 ' + JSON.stringify(await committed()) + '）',
    JSON.stringify(await committed()) === JSON.stringify(['m.txt', 'u.txt']))
  check('工作区干净', (await dirty()).length === 0)
}

console.log('')
console.log('=== paths 是空数组：不算 paths 分支，照旧走 stageAll ===')
{
  const seen = []
  const a = makeBody({}, seen)
  await wipe()
  await sh(`printf 'm-4\\n' > m.txt`, R)
  const reply = await a.H('git/commit')({ repo: R, message: '空 paths 也是没勾', paths: [], stageAll: true })
  check('答复 ok:true', reply.ok === true && reply.exitCode === 0)
  check('走了 add -A（空数组被 panelPaths 洗成空清单，跳过 paths 分支）',
    gitLines(seen).some((c) => /git 'add' '-A'/.test(c)))
  check('m.txt 进了提交', JSON.stringify(await committed()) === JSON.stringify(['m.txt']))
}

console.log('')
console.log('=== 无 paths 无 stageAll：裸 commit，索引里有什么提交什么 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  await wipe()
  await sh(`printf 'p\\n' > p.txt && git add p.txt && printf 'm-5\\n' > m.txt`, R)
  const reply = await a.H('git/commit')({ repo: R, message: '裸的' })
  check('答复 ok:true', reply.ok === true && reply.exitCode === 0)
  check('spy 里一条 add 都没有（既没有 -- 路径的，也没有 -A）',
    gitLines(seen).every((c) => /git 'add'/.test(c) === false))
  const bareDirty = await dirty()
  check('提交只带索引里已有的 p.txt，工作区的 m.txt 没进（porcelain 的 M m.txt 还在）',
    JSON.stringify(await committed()) === JSON.stringify(['p.txt'])
    && bareDirty.indexOf('M m.txt') >= 0)
}

console.log('')
console.log('=== paths 里非字符串的项洗掉（panelPaths 只收字符串） ===')
{
  const seen = []
  const a = makeBody({}, seen)
  await wipe()
  await sh(`printf 'ok\\n' > ok.txt && printf 'also\\n' > also-ok.txt`, R)
  const reply = await a.H('git/commit')({ repo: R, message: '洗过再 add', paths: ['ok.txt', 42, null, 'also-ok.txt'] })
  check('答复 ok:true', reply.ok === true && reply.exitCode === 0)
  check('add 只带了那两条合法路径（数字与 null 没进 argv）',
    gitLines(seen).some((c) => /git 'add' '--' 'ok\.txt' 'also-ok\.txt'/.test(c)))
  check('两条都进了提交', JSON.stringify(await committed()) === JSON.stringify(['also-ok.txt', 'ok.txt']))
}

console.log('')
console.log('=== add 失败：答复 no，commit 不跑 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  await wipe()
  const reply = await a.H('git/commit')({ repo: R, message: '这条 add 不中', paths: ['no-such-file.txt'] })
  check('答复 ok:false、exitCode 非 0，stderr 带着 git 的原话（pathspec）',
    reply.ok === false && reply.exitCode !== 0 && String(reply.stderr || '').indexOf('pathspec') >= 0)
  check('commit 一步都没跑（add 没过，提交不许接着来）',
    gitLines(seen).every((c) => /git 'commit'/.test(c) === false))
}

console.log('')
console.log('=== 空 message：答复层直接拒绝，一条命令都不起 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  const reply = await a.H('git/commit')({ repo: R, message: '   ' })
  check('答复 ok:false、error 是「a commit message is required」',
    reply != null && reply.ok === false && reply.error === 'a commit message is required')
  check('spy 里连 git 都没起', gitLines(seen).length === 0)
}

console.log('')
console.log('=== 命令页：add 与 commit 两笔都记「提交」，退出码如实 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  await wipe()
  await sh(`printf 'm-edited\\n' > m.txt`, R)
  await a.H('git/commit')({ repo: R, message: '记两笔', paths: ['m.txt'], sessionId: 'gp91-log' })
  const log = await a.H('git/command-log')({ repo: R, sessionCwd: R, sessionId: 'gp91-log', limit: 200 })
  const panel = log.ok === true && Array.isArray(log.commands) ? log.commands.filter((c) => c.source === 'panel') : []
  check('恰好两笔：add 与 commit，描述都是「提交」，退出码全 0'
    + '（实际 ' + panel.map((c) => c.description + '/' + String(c.exitCode)).join(' | ') + '）',
    panel.length === 2 && panel.every((c) => c.description === '提交' && c.exitCode === 0)
    && panel.some((c) => c.command === 'git add -- m.txt')
    && panel.some((c) => c.command === 'git commit -m 记两笔'))
  await wipe()
}

console.log('')
if (failed > 0) {
  console.error('✗ ' + String(failed) + ' 条不符合预期')
  process.exit(1)
}
console.log('（全部符合预期）')
