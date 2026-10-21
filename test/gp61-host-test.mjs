import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── worktree 的主目录：git/wt-main（读）与 git/wt-main-save（配置）的宿主半侧 ──
 *
 * 真仓库夹具（gp58 的骨架：HOME、GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM、DSH_HOME 全压
 * 到 /tmp，谁也摸不到跑测试这个人的真配置），kind 全谱系每种一个真身：
 *   MAIN —— 普通仓库（.git 是目录）→ kind 'main'，主目录=它自己；
 *   WT   —— `git worktree add` 出来的链接工作区（.git 是 gitlink 文件）→ 'linked'，
 *           主目录自动解出 MAIN，worktree list 的 main/current 两个标记各就各位；
 *   BWT  —— bare 主仓（b.git，无工作区）`git worktree add` 出来的工作区：gitlink
 *           在、git 读得动，但 commonDir（b.git）不以 /.git 结尾 → 'bare'，主目录
 *           为空，清单不给；
 *   SM   —— 子模块形态：gitlink 指向 super/.git/modules/subm，commonDir 与 gitdir
 *           重合 → 也判 'main'（它自己就是自己的主目录）；
 *   PLAIN —— 目录在、没有 .git → 'plain'，并且**一次 git 都不许跑**（用 PATH 上的
 *           git 记账壳现场数）；
 *   BROKEN —— gitlink 指向不存在的目录 → 'broken-gitlink'，主目录从 gitlink 文本
 *           解出、mainOk=false、worktrees 恒空；
 *   BROKEN2 —— gitlink 文本配不上「某目录/.git/worktrees/名字」的形状 → 同为 broken，
 *           主目录为空；file / missing 与 no-path、会话回退各一条。
 * 配置那半走真盘：git/wt-main-save 的校验矩阵（add/remove 二选一、绝对路径、
 * missing / not-a-repository）、合法 add 落盘 + 答复 mainSource='config' + 读缓存按
 * tag 作废、remove 删键、同值重复保存一个字节不落盘（写命令计数 + mtime 双保险）；
 * 配置里指向不存在目录时 mainOk=false 但 mainDir 保留（auto 的账照算，不冒充）。
 * readWorkspaceRepos 的 links 与 normalizeConfig 的 worktreeMains 清洗各一节。
 * 「机器上没有 git」一节把 PATH 换成只剩 head/cat 的目录（探针要读 gitlink 文本，
 * 这两个是脚本仅有的外部命令，其余全算 shell 内建；spawn 写死绝对 /bin/sh，
 * 可执行解析不过 PATH）—— linked 退成 broken-gitlink，main 不受影响。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp61-home'
const DSH = HOME + '/.dsh'
const CONFIG_FILE = DSH + '/dsh-git-idea.json'
const ROOT = '/tmp/gp61'
const MAIN = ROOT + '/main'
const WT = ROOT + '/wt'
const BARE = ROOT + '/b.git'
const BWT = ROOT + '/bwt'
const SUBSRC = ROOT + '/subsrc'
const SUPER = ROOT + '/super'
const SM = SUPER + '/subm'
const PLAIN = ROOT + '/plain'
const PLAINFILE = ROOT + '/plainfile'
const GONE = ROOT + '/gone-main'
const BROKEN = ROOT + '/broken'
const BROKEN2 = ROOT + '/broken2'
const WS = ROOT + '/ws'
const NOPATH = ROOT + '/nopath'
const CALLS_LOG = ROOT + '/git-calls.log'

function runShellWith(envExtra) {
  return (spec) => new Promise((res) => {
    /* /bin/sh 写死：PATH 被换掉的实例（记账壳 / nopath）里，可执行解析不能交给 PATH */
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
   写盘计数与「plain 不跑 git」的断言都从它来。 */
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

/* ── 夹具 ── */
await sh(`rm -rf ${ROOT} ${HOME} && mkdir -p ${ROOT} ${DSH} ${PLAIN} ${ROOT}/shim ${NOPATH}`)
await sh(`printf 'x' > ${PLAINFILE}`)
await sh(`git init -q -b main ${MAIN} && cd ${MAIN} && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first`, ROOT)
await sh(`git -C ${MAIN} worktree add -q -b wt-one ${WT}`)
await sh(`git clone -q --bare ${MAIN} ${BARE} && git -C ${BARE} worktree add -q ${BWT}`, ROOT)
await sh(`git init -q -b main ${SUBSRC} && cd ${SUBSRC} && git config user.email t@t && git config user.name T && echo s > s.txt && git add -A && git commit -qm s1`, ROOT)
await sh(`git init -q -b main ${SUPER} && cd ${SUPER} && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm a1`
  + ` && git -c protocol.file.allow=always submodule add -q ${SUBSRC} subm && git commit -qm addsub`, ROOT)
await sh(`mkdir -p ${BROKEN} && printf 'gitdir: ${GONE}/.git/worktrees/gone\\n' > ${BROKEN}/.git`)
await sh(`mkdir -p ${BROKEN2} && printf 'gitdir: ${ROOT}/nowhere/.git/modules/sub\\n' > ${BROKEN2}/.git`)
/* readWorkspaceRepos 的工作区：普通仓 + 链接工作区 + 伪 gitlink（子模块同款 .git 文件）*/
await sh(`mkdir -p ${WS} && git init -q -b main ${WS}/plainrepo && cd ${WS}/plainrepo && git config user.email t@t && git config user.name T && echo r > r.txt && git add -A && git commit -qm r1`, ROOT)
await sh(`git -C ${MAIN} worktree add -q -b wt-two ${WS}/link`, ROOT)
await sh(`mkdir -p ${WS}/fakelink && printf 'gitdir: ${SUPER}/.git/modules/subm\\n' > ${WS}/fakelink/.git`)
/* git 记账壳：PATH 上第一个 git 换成「记一笔再转发真身」的壳，plain 那节数它 */
const realGit = (await sh('command -v git')).out.trim()
fs.writeFileSync(ROOT + '/shim/git', '#!/bin/sh\nprintf \'%s\\n\' "$*" >> \'' + CALLS_LOG + '\'\nexec ' + realGit + ' "$@"\n')
fs.chmodSync(ROOT + '/shim/git', 0o755)
/* nopath：探针里仅有的外部命令是 head（读 gitlink 文本）与 cat（读配置文件），
   给它们软链，git 则故意缺席 —— 「机器上没有 git」由这个目录回答 */
await sh(`ln -sf "$(command -v head)" ${NOPATH}/head && ln -sf "$(command -v cat)" ${NOPATH}/cat`)

const probes = (runs) => runs.filter((r) => r.command.indexOf('K:dir') >= 0)
const configWrites = (runs) => runs.filter((r) => r.command.indexOf("> '" + CONFIG_FILE + "'") >= 0)

let failed = 0
const check = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const say = (label, value) => console.log('    ' + label + ': ' + JSON.stringify(value))

/* ═══ kind 全谱系（真 git 夹具）═══ */
console.log('')
console.log('== git/wt-main：kind 全谱系（linked / main / 子模块 main / bare）==')
{
  const a = makeBody()
  const linked = await a.H('git/wt-main')({ repo: WT })
  check('linked：ok、repo 是请求点名的目录，kind 判 linked',
    linked.ok === true && linked.repo === WT && linked.kind === 'linked')
  check('linked：gitlink 原文、gitdir、commonDir、toplevel 各就各位',
    linked.gitlink === 'gitdir: ' + MAIN + '/.git/worktrees/wt'
    && linked.gitdir === MAIN + '/.git/worktrees/wt'
    && linked.commonDir === MAIN + '/.git'
    && linked.toplevel === WT)
  check('linked：主目录自动解出 MAIN，mainSource=auto、mainOk=true、configured 为空',
    linked.mainDir === MAIN && linked.mainSource === 'auto' && linked.mainOk === true && linked.configured === null)
  check('linked：worktree list 全量解析（夹具里 MAIN 挂了两棵链接工作区，共三条），main 标记在 MAIN、current 标记在 WT',
    Array.isArray(linked.worktrees) && linked.worktrees.length === 3
    && linked.worktrees.some((w) => w.path === MAIN && w.main === true && w.current === false && w.branch === 'main')
    && linked.worktrees.some((w) => w.path === WT && w.current === true && w.main === false && w.branch === 'wt-one')
    && linked.worktrees.some((w) => w.path === WS + '/link' && w.main === false && w.current === false && w.branch === 'wt-two'))
  check('linked：探针没有带出 git 的报错（stderr 空）', linked.stderr === '' && linked.gitMissing === false)

  const main = await a.H('git/wt-main')({ repo: MAIN })
  check('main：.git 是目录就判 main，主目录=它自己（不需要 git 认同，但 git 也认同）',
    main.kind === 'main' && main.mainDir === MAIN && main.mainSource === 'auto' && main.mainOk === true)
  check('main：清单也解析，autoMain 就是本目录 → MAIN 行 main 与 current 同时亮',
    main.worktrees.length === 3 && main.worktrees.some((w) => w.path === MAIN && w.main === true && w.current === true))

  const sub = await a.H('git/wt-main')({ repo: SM })
  check('子模块形态：gitlink 在（git 写的是相对形式）、git 读得动、commonDir === gitdir → 也判 main，主目录=它自己',
    sub.kind === 'main' && sub.gitlink === 'gitdir: ../.git/modules/subm'
    && sub.gitdir === SUPER + '/.git/modules/subm' && sub.commonDir === sub.gitdir
    && sub.mainDir === SM && sub.mainSource === 'auto' && sub.mainOk === true)

  const bare = await a.H('git/wt-main')({ repo: BWT })
  check('bare：gitlink 在、git 读得动，但 commonDir（b.git）不以 /.git 结尾 → kind bare',
    bare.kind === 'bare' && bare.gitlink === 'gitdir: ' + BARE + '/worktrees/bwt'
    && bare.gitdir === BARE + '/worktrees/bwt' && bare.commonDir === BARE)
  check('bare：主目录为空（auto 配不上一个工作区），清单不给',
    bare.mainDir === null && bare.mainSource === null && bare.mainOk === false && bare.worktrees.length === 0)

  const before = probes(a.runs).length
  const hot = await a.H('git/wt-main')({ repo: WT })
  check('读缓存按仓库一格：四种身份恰好四次探针，同一仓库的第五问命中不再落',
    hot.ok === true && hot.kind === 'linked' && probes(a.runs).length === before && before === 4)
}

console.log('')
console.log('== git/wt-main：plain 一次 git 都不跑（git 记账壳现场数）==')
{
  const b = makeBody({ PATH: ROOT + '/shim:' + process.env.PATH })
  const plain = await b.H('git/wt-main')({ repo: PLAIN })
  check('plain：目录在、没有 .git → kind plain，mainDir 为空，stderr 空',
    plain.ok === true && plain.kind === 'plain' && plain.mainDir === null
    && plain.gitlink === '' && plain.stderr === '' && plain.worktrees.length === 0)
  check('plain：整个探针一次 git 都没跑（记账壳没有收到任何一笔）',
    fs.existsSync(CALLS_LOG) === false)
  fs.rmSync(CALLS_LOG, { force: true })
  await b.H('git/wt-main')({ repo: WT })
  check('（对照）同一个记账壳在 linked 上记到了 git 调用 —— 壳有效，上面的「零笔」是真的零',
    fs.existsSync(CALLS_LOG) === true)
  fs.rmSync(CALLS_LOG, { force: true })
  const file = await b.H('git/wt-main')({ repo: PLAINFILE })
  const gone = await b.H('git/wt-main')({ repo: GONE })
  check('file / missing：都到不了 git 那一段（记账壳零笔），kind 各自说清',
    file.kind === 'file' && gone.kind === 'missing'
    && fs.existsSync(CALLS_LOG) === false
    && file.mainDir === null && gone.mainDir === null)
}

console.log('')
console.log('== git/wt-main：机器上没有 git —— linked 退成 broken-gitlink，main 不受影响 ==')
{
  const c = makeBody({ PATH: NOPATH })
  const wt = await c.H('git/wt-main')({ repo: WT })
  say('没有 git 时的 WT', { kind: wt.kind, mainDir: wt.mainDir, mainOk: wt.mainOk, gitMissing: wt.gitMissing })
  check('gitlink 在但 git 不在 → broken-gitlink，主目录从 gitlink 文本解出（mainOk 按文件系统答）',
    wt.kind === 'broken-gitlink' && wt.gitMissing === true
    && wt.mainDir === MAIN && wt.mainSource === 'auto' && wt.mainOk === true && wt.worktrees.length === 0)
  const main = await c.H('git/wt-main')({ repo: MAIN })
  check('（对照）.git 是目录的 main 不需要 git：kind 仍是 main、mainOk 仍真',
    main.kind === 'main' && main.mainDir === MAIN && main.mainOk === true && main.worktrees.length === 0)
}

console.log('')
console.log('== git/wt-main：broken-gitlink 谱系（指向不存在 / 文本配不上）==')
{
  const d = makeBody()
  const gone = await d.H('git/wt-main')({ repo: BROKEN })
  check('gitlink 指向不存在的目录：kind broken-gitlink，主目录=gitlink 文本解出的那段，mainOk=false，清单恒空',
    gone.kind === 'broken-gitlink' && gone.mainDir === GONE && gone.mainSource === 'auto'
    && gone.mainOk === false && gone.worktrees.length === 0 && gone.stderr === '')
  const odd = await d.H('git/wt-main')({ repo: BROKEN2 })
  check('gitlink 文本配不上 */.git/worktrees/* 的形状：主目录为空，不猜',
    odd.kind === 'broken-gitlink' && odd.mainDir === null && odd.mainSource === null && odd.mainOk === false)
}

console.log('')
console.log('== git/wt-main：缺省与回退 ==')
{
  const e = makeBody()
  const nothing = await e.H('git/wt-main')({})
  check('连路径都解不出来：ok:false、error no-path（不是一份假读数）',
    nothing.ok === false && nothing.error === 'no-path' && nothing.kind === 'missing')
  const f = makeBody(null, { get: () => ({ header: { cwd: PLAIN } }) })
  const fallback = await f.H('git/wt-main')({ sessionId: 's-61' })
  check('请求不点名仓库：回退会话工作区（会话桩的 cwd）',
    fallback.ok === true && fallback.repo === PLAIN && fallback.kind === 'plain')
}

/* ═══ mainSource=config ═══ */
console.log('')
console.log('== mainSource=config：配置里的主目录压过自动识别 ==')
{
  const g = makeBody()
  const save = await g.H('git/wt-main-save')({ repo: WT, add: MAIN })
  check('save 后答复就是新账：mainSource=config、configured 带上、kind 还是 linked',
    save.ok === true && save.repo === WT && save.kind === 'linked'
    && save.mainDir === MAIN && save.mainSource === 'config' && save.configured === MAIN && save.mainOk === true)
  check('配置真的落了盘（不是只活在缓存里）',
    JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).worktreeMains[WT] === MAIN)
  const probesAfterSave = probes(g.runs).length
  check('save 自己的收尾读恰好落一次探针（答复就是它带回的新账）', probesAfterSave === 1)
  const again = await g.H('git/wt-main')({ repo: WT })
  check('再读与 save 答复一致（save 已把新账放回缓存，同一格命中不再落探针）',
    probes(g.runs).length === probesAfterSave
    && again.mainDir === MAIN && again.mainSource === 'config' && again.configured === MAIN && again.mainOk === true)

  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ worktreeMains: { [WT]: GONE } }))
  const h = makeBody()
  const brokenCfg = await h.H('git/wt-main')({ repo: WT })
  say('配置指向不存在目录时', { kind: brokenCfg.kind, mainDir: brokenCfg.mainDir, mainOk: brokenCfg.mainOk })
  check('配置指向不存在目录：mainOk=false 但 mainDir/configured 原样保留（auto 的账不冒充配置）',
    brokenCfg.ok === true && brokenCfg.kind === 'linked'
    && brokenCfg.mainDir === GONE && brokenCfg.configured === GONE
    && brokenCfg.mainSource === 'config' && brokenCfg.mainOk === false)
  check('此时清单仍按 git 自己认的账标 main（autoMain 不吃配置的账）',
    brokenCfg.worktrees.some((w) => w.path === MAIN && w.main === true))
}

/* ═══ saveWorktreeMain：校验矩阵 ═══ */
console.log('')
console.log('== git/wt-main-save：校验矩阵（一条都没写盘）==')
{
  fs.rmSync(CONFIG_FILE, { force: true })
  const i = makeBody()
  const both = await i.H('git/wt-main-save')({ repo: WT, add: MAIN, remove: true })
  const none = await i.H('git/wt-main-save')({ repo: WT })
  check('add 与 remove 都给 / 都不给：都是「二选一」',
    both.ok === false && both.error === 'exactly one of add or remove is required'
    && none.ok === false && none.error === 'exactly one of add or remove is required')
  const relAdd = await i.H('git/wt-main-save')({ repo: WT, add: 'rel/dir' })
  const relRepo = await i.H('git/wt-main-save')({ repo: 'rel/repo', add: MAIN })
  check('相对路径（add 或 repo）都拒：absolute path required',
    relAdd.ok === false && relAdd.error === 'absolute path required'
    && relRepo.ok === false && relRepo.error === 'absolute path required')
  const nowhere = await i.H('git/wt-main-save')({ add: MAIN })
  check('repo 缺省又没有会话工作区：no-path，不猜一个',
    nowhere.ok === false && nowhere.error === 'no-path')
  const missing = await i.H('git/wt-main-save')({ repo: WT, add: GONE })
  check('add 的目录不存在：missing', missing.ok === false && missing.error === 'missing' && missing.path === GONE)
  const notRepo = await i.H('git/wt-main-save')({ repo: WT, add: PLAIN })
  check('add 在了但不是仓库：not-a-repository',
    notRepo.ok === false && notRepo.error === 'not-a-repository' && notRepo.path === PLAIN)
  check('以上七次全部被拒：盘上没有这份配置文件（一个字节都没写）',
    fs.existsSync(CONFIG_FILE) === false)
}

/* ═══ saveWorktreeMain：合法路径与同值不写盘 ═══ */
console.log('')
console.log('== git/wt-main-save：合法 add / remove / 同值不写盘 ==')
{
  const j = makeBody()
  const added = await j.H('git/wt-main-save')({ repo: WT, add: MAIN })
  check('合法 add：答复 ok，主目录来自配置',
    added.ok === true && added.mainSource === 'config' && added.mainDir === MAIN)
  check('落盘恰好一次（写命令计数）', configWrites(j.runs).length === 1)
  const mtime = fs.statSync(CONFIG_FILE).mtimeMs
  const bytes = fs.readFileSync(CONFIG_FILE, 'utf8')
  const same = await j.H('git/wt-main-save')({ repo: WT, add: MAIN })
  check('同值再存：ok 且一个字节没落盘（mtime 与字节都不动）',
    same.ok === true && configWrites(j.runs).length === 1
    && fs.readFileSync(CONFIG_FILE, 'utf8') === bytes
    && fs.statSync(CONFIG_FILE).mtimeMs === mtime)
  const removed = await j.H('git/wt-main-save')({ repo: WT, remove: true })
  check('remove：键删掉、答复回到自动识别、又恰好写盘一次',
    removed.ok === true && removed.mainSource === 'auto' && removed.mainDir === MAIN && removed.mainOk === true
    && configWrites(j.runs).length === 2
    && JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).worktreeMains[WT] === undefined)
  const mtime2 = fs.statSync(CONFIG_FILE).mtimeMs
  const removedAgain = await j.H('git/wt-main-save')({ repo: WT, remove: true })
  check('remove 幂等：键已不在就不再写盘',
    removedAgain.ok === true && configWrites(j.runs).length === 2
    && fs.statSync(CONFIG_FILE).mtimeMs === mtime2)
}

/* ═══ readWorkspaceRepos 的 links ═══ */
console.log('')
console.log('== git/repos：links 只收 .git 是文件的仓库根 ==')
{
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ repos: { [WS]: ['/tmp/gp61/gone-repo'] } }))
  const k = makeBody()
  const repos = await k.H('git/repos')({ sessionCwd: WS })
  check('ok，工作区是会话自己的目录', repos.ok === true && repos.workspace === WS)
  check('repos 收全：普通仓、链接工作区、伪 gitlink 都在（按路径排序）',
    JSON.stringify(repos.repos) === JSON.stringify([WS + '/fakelink', WS + '/link', WS + '/plainrepo']))
  check('links 只含 .git 是文件的根：link 与 fakelink 在，普通仓不在',
    JSON.stringify(repos.links) === JSON.stringify([WS + '/fakelink', WS + '/link'])
    && repos.links.indexOf(WS + '/plainrepo') < 0)
  check('手动登记里已经不在的路径进 missing，不进 repos 也不进 links',
    JSON.stringify(repos.missing) === JSON.stringify(['/tmp/gp61/gone-repo'])
    && repos.repos.indexOf('/tmp/gp61/gone-repo') < 0 && repos.links.indexOf('/tmp/gp61/gone-repo') < 0)
  check('truncated 没误报', repos.truncated === false)
  const old = makeBody()
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({}))
  const quiet = await old.H('git/repos')({ sessionCwd: WS })
  check('（对照）没有手动登记：missing 空表，其余两列照旧',
    quiet.ok === true && quiet.missing.length === 0
    && quiet.repos.length === 3 && quiet.links.length === 2)
}

/* ═══ normalizeConfig 的 worktreeMains 清洗 ═══ */
console.log('')
console.log('== normalizeConfig：worktreeMains 按 repos 同一口径清洗（git/config-save 那扇门）==')
{
  const l = makeBody()
  const notMap1 = await l.H('git/config-save')({ config: { worktreeMains: '不是表' } })
  const notMap2 = await l.H('git/config-save')({ config: { worktreeMains: ['a'] } })
  check('非对象 / 数组：清成空表（键永远在）',
    notMap1.ok === true && JSON.stringify(notMap1.config.worktreeMains) === '{}'
    && JSON.stringify(notMap2.config.worktreeMains) === '{}')
  const longKey = '/' + 'k'.repeat(4096)
  const longVal = '/' + 'v'.repeat(4096)
  const dirty = await l.H('git/config-save')({
    config: {
      worktreeMains: {
        [WT]: MAIN,
        'relative/key': MAIN,
        [ROOT + '/w2']: 'relative/value',
        [ROOT + '/w3']: '   ',
        [ROOT + '/w4']: 42,
        [ROOT + '/w5']: null,
        [longKey]: MAIN,
        [ROOT + '/w6']: longVal,
        [ROOT + '/wtrim  ']: MAIN + '  ',
      },
    },
  })
  const mains = dirty.config.worktreeMains
  check('脏条目全丢：相对路径的键/值、空与全空白值、非字符串值',
    dirty.ok === true && mains[WT] === MAIN && mains['relative/key'] === undefined
    && mains[ROOT + '/w2'] === undefined && mains[ROOT + '/w3'] === undefined
    && mains[ROOT + '/w4'] === undefined && mains[ROOT + '/w5'] === undefined)
  check('超长（>4096）整条丢，不是截断（与 drafts 的口径不同）',
    mains[longKey] === undefined && mains[ROOT + '/w6'] === undefined)
  check('合法条目留下，键与值都去过两端空白',
    mains[ROOT + '/wtrim'] === MAIN && Object.keys(mains).length === 2)
  const many = {}
  for (let n = 0; n < 70; n += 1) many[ROOT + '/m' + n] = ROOT + '/t' + n
  const capped = await l.H('git/config-save')({ config: { worktreeMains: many } })
  check('封顶 64 条：键序在前的留下', capped.ok === true && Object.keys(capped.config.worktreeMains).length === 64
    && capped.config.worktreeMains[ROOT + '/m0'] === ROOT + '/t0'
    && capped.config.worktreeMains[ROOT + '/m69'] === undefined)
  check('读回来一致（写盘的就是清洗后的那份）',
    JSON.stringify((await l.H('git/config')({})).config.worktreeMains) === JSON.stringify(capped.config.worktreeMains))
}

console.log('')
if (failed > 0) {
  console.error('gp61-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
console.log('（gp61-host 全部通过）')
