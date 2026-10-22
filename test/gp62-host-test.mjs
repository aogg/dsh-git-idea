import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 生效仓库的后端账：git/repo-applied（读）与 git/repo-applied-save（写）的宿主半侧 ──
 *
 * 真仓库夹具（gp61 的骨架：HOME、GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM、DSH_HOME 全压到
 * /tmp，谁也摸不到跑测试这个人的真配置）：
 *   WS         —— 会话工作区（普通目录；账的键，repoKeyOf 口径：去尾斜杠）；
 *   REPO/REPO2 —— 两个真 git 仓库（appliedRepoSnapshot 的存在性 + rev-parse 双重探测要它真在）；
 *   BROKEN     —— .git 是文件（gitlink）但 gitdir 指向不存在的路径：Windows 上建的
 *                 worktree 整棵拷来 Linux 的形状，文件在、git 读不动（stale 那一格）；
 *   GONE       —— 从未存在的路径（stale 那一格）。
 * normalizeAppliedRepos 的清洗矩阵走 git/config-save 那扇门（与 gp61 的 worktreeMains
 * 同一批断言口径）：非对象/数组回空表、非字符串值丢、相对路径（键或值不以 / 开头）丢、
 * 首尾空白 trim 后保留、超 4096 整条丢不截断（恰好 4096 留下）、封顶 64 键序在前的留下。
 * saveAppliedRepo：no-path；相对/超长拒绝且不落盘；合法保存落盘恰好一次，appliedRepos 键值
 * 读得回来、drafts/repos/gitPath 等别的键原样带过去；同值重申（含尾斜杠工作区的同键重申）
 * unchanged:true 一个字节不写（写命令计数 + mtime + 字节三重）；空串清除落盘；清除本来
 * 就没有的键也 unchanged。
 * appliedRepoSnapshot：no-path；账上没记 → repo 空串且没有 stale，一次探测都不落；账上有值
 * 且仓库在 → 原值返回，恰好一次探测（[ -e repo/.git ] 加 rev-parse）、workdir 是会话自己的
 * 目录；账上值指向已删除目录、或 .git 是 gitlink 而 gitdir 断链（git 读不动）→ repo 空串 +
 * stale:true 且账不删、零写盘。
 * 末一节走注册路径：harness.handle 的桩接到了两条处理函数，save 的账同一条 RPC 读得回；
 * 不递 sessionCwd 时由 RPC 壳自己解会话工作区（sessions 桩的 cwd）。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp62-home'
const DSH = HOME + '/.dsh'
const CONFIG_FILE = DSH + '/dsh-git-idea.json'
const ROOT = '/tmp/gp62'
const WS = ROOT + '/ws'
const REPO = ROOT + '/repo'
const REPO2 = ROOT + '/repo2'
const GONE = ROOT + '/gone-repo'
const BROKEN = ROOT + '/broken-wt'
const longKey = '/' + 'k'.repeat(4096)
const longVal = '/' + 'v'.repeat(4096)

function runShellWith(envExtra) {
  return (spec) => new Promise((res) => {
    /* /bin/sh 写死：这两条处理函数自己不跑 git，夹具的 git init 走 sh() 自己的环境 */
    const c = spawn('/bin/sh', ['-c', spec.command], {
      cwd: spec.workdir,
      env: Object.assign({}, process.env, {
        DSH_HOME: DSH, HOME: HOME,
        GIT_CONFIG_GLOBAL: HOME + '/.gitconfig', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      }, envExtra || {}),
    })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}

/* 每份 body 一套全新模块态（configPathCache / configCache / gitExe / readCache 都在
   里面）：换一份配置文件就是换一份 body，谁也不读谁的账。runs 记下每一条 shell，
   写盘计数与探测计数都从它来。 */
function makeBody(envExtra, sessions) {
  const runs = []
  const shellService = {
    resolve: (r) => r,
    run: (spec) => { runs.push(spec); return runShellWith(envExtra)(spec) },
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

function sh(cmd, cwd) {
  return new Promise((res) => {
    const c = spawn('/bin/sh', ['-c', cmd], { cwd, env: Object.assign({}, process.env, { HOME: HOME, GIT_CONFIG_GLOBAL: HOME + '/.gitconfig', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('close', x => res({ code: x, out: o, err: e }))
  })
}

/* ── 夹具：两个真仓库 + 一个普通工作区（账的键），GONE 从不创建 ── */
await sh(`rm -rf ${ROOT} ${HOME} && mkdir -p ${ROOT} ${DSH} ${WS}`)
await sh(`git init -q -b main ${REPO} && cd ${REPO} && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first`, ROOT)
await sh(`git init -q -b main ${REPO2} && cd ${REPO2} && git config user.email t@t && git config user.name T && echo b > b.txt && git add -A && git commit -qm second`, ROOT)
/* gitlink 断链夹具：.git 是文件、gitdir 指向不存在的路径 —— Windows 上建的
   worktree 整棵拷来 Linux 的形状（git 把 D:/ 当相对路径解析，这里换成同样
   不存在的绝对路径，断的是同一件事：git 读不动）。 */
fs.mkdirSync(BROKEN, { recursive: true })
fs.writeFileSync(BROKEN + '/.git', 'gitdir: /nonexistent/gp62/main/.git/worktrees/broken\n')

const configWrites = (runs) => runs.filter((r) => r.command.indexOf("> '" + CONFIG_FILE + "'") >= 0)
/* appliedRepoSnapshot 的自检探针原话：if [ -e <repo>/.git ] && git -C <repo>
   rev-parse --absolute-git-dir >/dev/null 2>&1; then echo repo; else echo gone; fi */
const appliedProbes = (runs) => runs.filter((r) => r.command.indexOf('; then echo repo; else echo gone; fi') >= 0)

let failed = 0
const check = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const say = (label, value) => console.log('    ' + label + ': ' + JSON.stringify(value))

/* ═══ normalizeAppliedRepos 的清洗矩阵（git/config-save 那扇门）═══ */
console.log('')
console.log('== normalizeConfig：appliedRepos 按 worktreeMains 同一口径清洗 ==')
{
  const l = makeBody()
  const notMap1 = await l.H('git/config-save')({ config: { appliedRepos: '不是表' } })
  const notMap2 = await l.H('git/config-save')({ config: { appliedRepos: ['a'] } })
  check('非对象 / 数组：清成空表（键永远在）',
    notMap1.ok === true && JSON.stringify(notMap1.config.appliedRepos) === '{}'
    && notMap2.ok === true && JSON.stringify(notMap2.config.appliedRepos) === '{}')
  const edgeVal = '/' + 'v'.repeat(4095)
  const dirty = await l.H('git/config-save')({
    config: {
      appliedRepos: {
        [WS]: REPO,
        'relative/key': REPO,
        [ROOT + '/w2']: 'relative/value',
        [ROOT + '/w3']: '   ',
        [ROOT + '/w4']: 42,
        [ROOT + '/w5']: null,
        [longKey]: REPO,
        [ROOT + '/w6']: longVal,
        [ROOT + '/wtrim  ']: REPO + '  ',
        [ROOT + '/w-ok']: edgeVal,
      },
    },
  })
  const applied = dirty.config.appliedRepos
  check('脏条目全丢：相对路径的键/值、全空白值、非字符串值（42 / null）',
    dirty.ok === true && applied[WS] === REPO && applied['relative/key'] === undefined
    && applied[ROOT + '/w2'] === undefined && applied[ROOT + '/w3'] === undefined
    && applied[ROOT + '/w4'] === undefined && applied[ROOT + '/w5'] === undefined)
  check('超长（>4096）整条丢，不是截断（4097 的键与值都活不下来）',
    applied[longKey] === undefined && applied[ROOT + '/w6'] === undefined)
  check('恰好 4096 是边界内：这一条留下且原样（不截断）',
    applied[ROOT + '/w-ok'] === edgeVal && edgeVal.length === 4096)
  check('合法条目留下，键与值都去过两端空白（同一个目录两种写法是同一个键）',
    applied[ROOT + '/wtrim'] === REPO && Object.keys(applied).length === 3)
  const many = {}
  for (let n = 0; n < 70; n += 1) many[ROOT + '/m' + n] = ROOT + '/t' + n
  const capped = await l.H('git/config-save')({ config: { appliedRepos: many } })
  check('封顶 64 条：键序在前的留下', capped.ok === true && Object.keys(capped.config.appliedRepos).length === 64
    && capped.config.appliedRepos[ROOT + '/m0'] === ROOT + '/t0'
    && capped.config.appliedRepos[ROOT + '/m69'] === undefined)
  check('读回来一致（写盘的就是清洗后的那份）',
    JSON.stringify((await l.H('git/config')({})).config.appliedRepos) === JSON.stringify(capped.config.appliedRepos))
}

/* ═══ saveAppliedRepo：no-path 与相对/超长拒绝 ═══ */
console.log('')
console.log('== git/repo-applied-save：no-path 与相对/超长拒绝（一条都没写盘）==')
{
  fs.rmSync(CONFIG_FILE, { force: true })
  const i = makeBody()
  const noPath = await i.H('git/repo-applied-save')({ repo: REPO })
  check('no-path：会话与 sessionCwd 都解不出工作区，不猜一个',
    noPath.ok === false && noPath.error === 'no-path' && noPath.workspace === null)
  const rel = await i.H('git/repo-applied-save')({ sessionCwd: WS, repo: 'rel/repo' })
  check('相对路径拒绝：absolute path required，答复点名原值',
    rel.ok === false && rel.error === 'absolute path required' && rel.repo === 'rel/repo')
  const tooLong = await i.H('git/repo-applied-save')({ sessionCwd: WS, repo: longVal })
  check('超长（>4096）同样拒：absolute path required',
    tooLong.ok === false && tooLong.error === 'absolute path required')
  check('以上全部被拒：盘上没有这份配置文件（一个字节都没写）',
    fs.existsSync(CONFIG_FILE) === false && configWrites(i.runs).length === 0)
}

/* ═══ saveAppliedRepo：合法保存 / 别的键原样 / 同值不写盘 / 清除 ═══ */
console.log('')
console.log('== git/repo-applied-save：合法保存 / 别的键原样 / 同值不写盘 / 清除 ==')
{
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ drafts: { [REPO]: '写到一半' }, repos: { [WS]: [REPO] }, gitPath: '/usr/bin/git' }))
  const j = makeBody()
  const saved = await j.H('git/repo-applied-save')({ sessionCwd: WS, repo: REPO })
  check('合法保存：ok，答复带 workspace 与 repo（这一次不是 unchanged）',
    saved.ok === true && saved.workspace === WS && saved.repo === REPO && saved.unchanged === undefined)
  check('落盘恰好一次（写命令计数）', configWrites(j.runs).length === 1)
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  check('appliedRepos 的键值读得回来：键是去掉尾斜杠的工作区、值是仓库绝对路径',
    onDisk.appliedRepos[WS] === REPO)
  check('别的键原样带过去：drafts / repos / gitPath 没被这次整份写回抹掉',
    onDisk.drafts[REPO] === '写到一半' && JSON.stringify(onDisk.repos[WS]) === JSON.stringify([REPO])
    && onDisk.gitPath === '/usr/bin/git')
  check('git/config 读回与盘一致（写后回读的是同一份账）',
    JSON.stringify((await j.H('git/config')({})).config.appliedRepos) === JSON.stringify({ [WS]: REPO }))
  const mtime = fs.statSync(CONFIG_FILE).mtimeMs
  const bytes = fs.readFileSync(CONFIG_FILE, 'utf8')
  const same = await j.H('git/repo-applied-save')({ sessionCwd: WS, repo: REPO })
  check('同值重申：unchanged:true，一个字节没落盘（计数、字节、mtime 三重）',
    same.ok === true && same.unchanged === true && configWrites(j.runs).length === 1
    && fs.readFileSync(CONFIG_FILE, 'utf8') === bytes && fs.statSync(CONFIG_FILE).mtimeMs === mtime)
  const sameSlash = await j.H('git/repo-applied-save')({ sessionCwd: WS + '/', repo: REPO })
  check('尾斜杠的工作区是同一个键（repoKeyOf 口径）：同值照旧 unchanged 不写盘',
    sameSlash.ok === true && sameSlash.unchanged === true && configWrites(j.runs).length === 1)
  const moved = await j.H('git/repo-applied-save')({ sessionCwd: WS, repo: REPO2 })
  check('换一个仓库：ok、恰好又写盘一次，盘上换新',
    moved.ok === true && moved.repo === REPO2 && configWrites(j.runs).length === 2
    && JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).appliedRepos[WS] === REPO2)
  const cleared = await j.H('git/repo-applied-save')({ sessionCwd: WS, repo: '' })
  check('空串是删除语义：键删掉、恰好又写盘一次',
    cleared.ok === true && cleared.repo === '' && configWrites(j.runs).length === 3
    && JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).appliedRepos[WS] === undefined)
  const mtime2 = fs.statSync(CONFIG_FILE).mtimeMs
  const clearedAgain = await j.H('git/repo-applied-save')({ sessionCwd: WS, repo: '' })
  check('清除本来就不存在的键也 unchanged：一个字节不写',
    clearedAgain.ok === true && clearedAgain.unchanged === true && configWrites(j.runs).length === 3
    && fs.statSync(CONFIG_FILE).mtimeMs === mtime2)
}

/* ═══ appliedRepoSnapshot：读数三态 ═══ */
console.log('')
console.log('== git/repo-applied：没记 / 记了还在 / 记了已不在（stale 不删账）==')
{
  fs.rmSync(CONFIG_FILE, { force: true })
  const k = makeBody()
  const empty = await k.H('git/repo-applied')({ sessionCwd: WS })
  check('账上没记：ok、workspace 是会话目录、repo 空串、没有 stale',
    empty.ok === true && empty.workspace === WS && empty.repo === '' && empty.stale === undefined)
  check('没有账就没有探测、更没有写盘（盘上连配置文件都还没有）',
    appliedProbes(k.runs).length === 0 && configWrites(k.runs).length === 0
    && fs.existsSync(CONFIG_FILE) === false)

  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ appliedRepos: { [WS]: REPO } }))
  const k2 = makeBody()
  const live = await k2.H('git/repo-applied')({ sessionCwd: WS })
  check('账上有值且仓库在（真 git 夹具）：原值返回、无 stale',
    live.ok === true && live.workspace === WS && live.repo === REPO && live.stale === undefined)
  check('恰好落一次探测（存在 + rev-parse 一条命令），且 workdir 是会话自己的目录',
    appliedProbes(k2.runs).length === 1 && appliedProbes(k2.runs)[0].workdir === WS)
  check('读不写盘：写命令计数为零', configWrites(k2.runs).length === 0)

  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ appliedRepos: { [WS]: GONE, [ROOT + '/other']: REPO2 }, drafts: { [REPO]: '还要' } }))
  const k3 = makeBody()
  const stale = await k3.H('git/repo-applied')({ sessionCwd: WS })
  say('账指向已删除目录时', { repo: stale.repo, stale: stale.stale })
  check('账上的仓库已不在：ok、repo 空串、stale:true（不套用）',
    stale.ok === true && stale.repo === '' && stale.stale === true)
  const onDisk3 = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  check('stale 不删账：那条原值还在，别的格（另一个工作区、drafts）也一个没动',
    onDisk3.appliedRepos[WS] === GONE && onDisk3.appliedRepos[ROOT + '/other'] === REPO2
    && onDisk3.drafts[REPO] === '还要')
  check('stale 自愈不落盘：写命令计数为零', configWrites(k3.runs).length === 0)

  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ appliedRepos: { [WS]: BROKEN } }))
  const kb = makeBody()
  const broken = await kb.H('git/repo-applied')({ sessionCwd: WS })
  say('账指向 gitlink 断链的目录时（.git 是文件、git 读不动）', { repo: broken.repo, stale: broken.stale })
  check('gitlink 断链（Windows 拷来的 worktree 形状）：也 stale:true，不再把读者自动带进说明页',
    broken.ok === true && broken.repo === '' && broken.stale === true)
  check('同样不删账、不落盘',
    JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).appliedRepos[WS] === BROKEN
    && configWrites(kb.runs).length === 0)

  const k4 = makeBody()
  const nothing = await k4.H('git/repo-applied')({})
  check('no-path：ok:false、error no-path、workspace null、repo 空串',
    nothing.ok === false && nothing.error === 'no-path' && nothing.workspace === null && nothing.repo === '')
}

/* ═══ 注册路径 ═══ */
console.log('')
console.log('== 注册路径：git/repo-applied 与 git/repo-applied-save 经 harness.handle 走通 ==')
{
  fs.rmSync(CONFIG_FILE, { force: true })
  const m = makeBody()
  check('两条都注册在案（onRpc 的桩接到了处理函数）',
    typeof m.H('git/repo-applied') === 'function' && typeof m.H('git/repo-applied-save') === 'function')
  const saved = await m.H('git/repo-applied-save')({ sessionCwd: WS, repo: REPO, sessionId: 's-62' })
  const read = await m.H('git/repo-applied')({ sessionCwd: WS, sessionId: 's-62' })
  check('save→read 同一对 RPC 对上账：答复字段齐全，读回就是刚存的值',
    saved.ok === true && saved.workspace === WS && saved.repo === REPO
    && read.ok === true && read.workspace === WS && read.repo === REPO)
  check('save 恰好写盘一次，read 一次都不写', configWrites(m.runs).length === 1)
  const n = makeBody(null, { get: () => ({ header: { cwd: WS } }) })
  const viaSession = await n.H('git/repo-applied-save')({ sessionId: 's-62sess', repo: REPO2 })
  check('不递 sessionCwd：RPC 壳自己解会话工作区（sessions 桩的 cwd），保存按它分键',
    viaSession.ok === true && viaSession.workspace === WS && viaSession.repo === REPO2
    && JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).appliedRepos[WS] === REPO2)
}

console.log('')
if (failed > 0) {
  console.error('gp62-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
console.log('（gp62-host 全部通过）')
