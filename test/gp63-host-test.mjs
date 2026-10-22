import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── worktree 的目录映射：配置归一化 + 识别链路的前缀替换（宿主半侧）──
 *
 * 背景（session-f8763151 的真机根因）：worktree 整棵从 Windows 拷到 Linux，
 * .git 链接文件里记的还是那台机器的路径（gitdir: D:/…/…/.git/worktrees/x），
 * Linux 的 git 不认 D: 盘符 → rev-parse 失败 → 面板把 worktree 判成
 * broken-gitlink、说明页连主目录都给不出。全局配置的 worktreeDirMappings
 * （[{id,from,to}]，配置页「全局配置 → worktree」组）就是读者的翻译规则：
 * 识别主目录时把候选路径的 from 前缀整段换成 to。本套件两半：
 *   1. normalizeWorktreeDirMappings 的清洗矩阵走 git/config-save 那扇门
 *      （gp61 的 worktreeMains 同款门）：非数组清成空表、空/全空白/非字符串/
 *      超长（>4096）条目整条丢、去首尾空白、id 保留与补造、封顶 50、回读一致；
 *   2. 识别链路（git/wt-main）用真盘夹具：伪 .git 文件写死「另一台机器」的
 *      gitdir（正斜杠 D:/…、全反斜杠 D:\… 两种写法各一个；D: 盘符在 Linux 上
 *      不存在，rev-parse 天然失败，正好就是真机的形状）：
 *        · 没配映射：kind broken-gitlink、主目录=gitlink 文本原样、mainOk=false、
 *          mainMapped=false —— 一次探针，不多发；
 *        · 配了映射且前缀配上：主目录=换算后的本机路径、mainOk=true、
 *          mainMapped=true（mainSource 仍是 auto）；存在性由一次补问回答
 *          （探针计数 +1，只在这一格多发）；
 *        · 前缀按整段配（D:/win/gp63 配不上 D:/win/gp63main…）、映射目标不存在、
 *          多条映射第一条赢、from/to 带尾斜杠也认；
 *        · worktreeMains 的手动答案永远压过映射（mainMapped 回 false）；
 *        · git 读得动的真 worktree（linked）不受映射影响（主目录来自 git 自己
 *          的 commonDir，那是本机路径，映射无事可做）；
 *        · 机器上没有 git（PATH 只剩 head/cat）：映射照常工作（存在性是文件
 *          系统的回答，不需要 git）。
 * 夹具骨架与 gp61 相同：HOME、GIT_CONFIG_GLOBAL/SYSTEM、DSH_HOME 全压到 /tmp，
 * 谁也摸不到跑测试这个人的真配置；每节换一份 body（configCache 各自独立）。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp63-home'
const DSH = HOME + '/.dsh'
const CONFIG_FILE = DSH + '/dsh-git-idea.json'
const ROOT = '/tmp/gp63'
const MAIN = ROOT + '/main'
const WT = ROOT + '/wt'          /* 真 worktree（linked 对照组） */
const WINWT = ROOT + '/winwt'    /* gitdir 记 D:/ 正斜杠写法的伪 worktree */
const BSWT = ROOT + '/bswt'      /* gitdir 记 D:\ 全反斜杠写法的伪 worktree */
const NEARWT = ROOT + '/nearwt'  /* 前缀撞段（D:/win/gp63main）：不该配上 */
const GONEWT = ROOT + '/gonewt'  /* 映射目标不存在 */
const NOPATH = ROOT + '/nopath'
/* 「另一台机器」的目录前缀与两条映射用的目标 */
const WIN = 'D:/win/gp63'
const WIN_BS = 'D:\\win\\gp63'
const GONE_FROM = 'D:/gone/gp63'

function runShellWith(envExtra) {
  return (spec) => new Promise((res) => {
    /* /bin/sh 写死：PATH 被换掉的实例（nopath）里，可执行解析不能交给 PATH */
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

/* 每份 body 一套全新模块态（configPathCache / configCache / readCache 都在里面）：
   换一份配置文件就是换一份 body，谁也不读谁的账。runs 记下每一条 shell —— 探针
   计数（K:dir）与补问计数（echo repo）都从它来。 */
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
await sh(`rm -rf ${ROOT} ${HOME} && mkdir -p ${ROOT} ${DSH} ${NOPATH}`)
await sh(`git init -q -b main ${MAIN} && cd ${MAIN} && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first`, ROOT)
await sh(`git -C ${MAIN} worktree add -q -b wt-one ${WT}`)
/* 伪 worktree：.git 是文件、gitdir 记「另一台机器」的路径。正斜杠款照真机抄
   （git 在 Windows 上写的就是这种）；全反斜杠款是另一种合法写法，都得认。 */
await sh(`mkdir -p ${WINWT} && printf 'gitdir: ${WIN}/main/.git/worktrees/win-one\\n' > ${WINWT}/.git`)
await sh(`mkdir -p ${BSWT} && printf 'gitdir: ${WIN_BS}\\main\\.git\\worktrees\\win-two\\n' > ${BSWT}/.git`)
/* 前缀撞段：from 是 D:/win/gp63，这里的路径是 D:/win/gp63main —— 不该配上。 */
await sh(`mkdir -p ${NEARWT} && printf 'gitdir: ${WIN}main/.git/worktrees/near\\n' > ${NEARWT}/.git`)
/* 映射目标不存在：规则本身合法，但 to 那头盘上没有。 */
await sh(`mkdir -p ${GONEWT} && printf 'gitdir: ${GONE_FROM}/main/.git/worktrees/gone\\n' > ${GONEWT}/.git`)
/* nopath：探针里仅有的外部命令是 head（读 gitlink 文本）与 cat（读配置文件）。 */
await sh(`ln -sf "$(command -v head)" ${NOPATH}/head && ln -sf "$(command -v cat)" ${NOPATH}/cat`)

const probes = (runs) => runs.filter((r) => r.command.indexOf('K:dir') >= 0)
const mappedChecks = (runs) => runs.filter((r) => r.command.indexOf('echo repo') >= 0)
/* 把一份配置写进盘再换一份 body —— 每节彼此独立（configCache 不共享）。 */
const bodyWith = function (config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config))
  return makeBody()
}

let failed = 0
const check = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const say = (label, value) => console.log('    ' + label + ': ' + JSON.stringify(value))

/* ═══ 识别链路：目录映射 ═══ */
console.log('')
console.log('== git/wt-main：没配映射 —— 旧账一字不变，一次探针都不多发 ==')
{
  const a = bodyWith({})
  const raw = await a.H('git/wt-main')({ repo: WINWT })
  say('没有映射时的 WINWT', { kind: raw.kind, mainDir: raw.mainDir, mainOk: raw.mainOk, mainMapped: raw.mainMapped })
  check('kind broken-gitlink、gitlink 原文照发（D:/ 正斜杠写法）',
    raw.ok === true && raw.kind === 'broken-gitlink'
    && raw.gitlink === 'gitdir: ' + WIN + '/main/.git/worktrees/win-one')
  check('主目录=gitlink 文本解出的那段（另一台机器的路径），mainOk=false、mainSource=auto、mainMapped=false',
    raw.mainDir === WIN + '/main' && raw.mainOk === false && raw.mainSource === 'auto' && raw.mainMapped === false)
  check('一次探针答完、零次补问（没配映射的读者不多跑一个进程）',
    probes(a.runs).length === 1 && mappedChecks(a.runs).length === 0)
}

console.log('')
console.log('== git/wt-main：配了映射、前缀配上 —— 主目录换算到本机，mainMapped=true ==')
{
  const b = bodyWith({ worktreeDirMappings: [{ id: 'm1', from: WIN, to: ROOT }] })
  const mapped = await b.H('git/wt-main')({ repo: WINWT })
  say('映射命中时的 WINWT', { kind: mapped.kind, mainDir: mapped.mainDir, mainOk: mapped.mainOk, mainMapped: mapped.mainMapped })
  check('主目录换算成 to + 余下路径（' + WIN + ' → ' + ROOT + '），盘上真有 → mainOk=true',
    mapped.kind === 'broken-gitlink' && mapped.mainDir === MAIN && mapped.mainOk === true)
  check('mainSource 仍是 auto（映射是「怎么自动找到」的一部分），mainMapped=true 说破换算这件事',
    mapped.mainSource === 'auto' && mapped.mainMapped === true)
  check('gitlink 原文一个字节不改（.git 文件不许写，答复里的原文也不许换）',
    mapped.gitlink === 'gitdir: ' + WIN + '/main/.git/worktrees/win-one')
  check('一次主探针 + 一次存在性补问（换算候选的 [ -e <它>/.git ] 现场问）',
    probes(b.runs).length === 1 && mappedChecks(b.runs).length === 1)
  check('读缓存按仓库一格：同一仓库再问一次，两次 shell 都不再落',
    (await b.H('git/wt-main')({ repo: WINWT })).mainDir === MAIN
    && probes(b.runs).length === 1 && mappedChecks(b.runs).length === 1)

  const backslash = await b.H('git/wt-main')({ repo: BSWT })
  say('全反斜杠 gitdir 的 BSWT', { mainDir: backslash.mainDir, mainMapped: backslash.mainMapped })
  check('D:\\ 反斜杠写法配同一条正斜杠映射（分隔符归一后按前缀配）',
    backslash.kind === 'broken-gitlink' && backslash.mainDir === MAIN
    && backslash.mainOk === true && backslash.mainMapped === true)
  check('反斜杠的 gitlink 原文照发（G: 行不做归一）',
    backslash.gitlink === 'gitdir: ' + WIN_BS + '\\main\\.git\\worktrees\\win-two')

  const near = await b.H('git/wt-main')({ repo: NEARWT })
  check('前缀按整段配：D:/win/gp63 配不上 D:/win/gp63main…（不撞段）',
    near.mainDir === WIN + 'main' && near.mainMapped === false && near.mainOk === false)
}

console.log('')
console.log('== git/wt-main：映射的边界 —— 目标不在、多条先到先得、尾斜杠也认 ==')
{
  const c = bodyWith({ worktreeDirMappings: [{ id: 'g1', from: GONE_FROM, to: ROOT + '/nowhere' }] })
  const gone = await c.H('git/wt-main')({ repo: GONEWT })
  say('映射目标不存在时', { mainDir: gone.mainDir, mainOk: gone.mainOk, mainMapped: gone.mainMapped })
  check('映射目标不存在：mainDir=换算结果原样保留、mainOk=false（不冒充、也不回退成原文）',
    gone.mainDir === ROOT + '/nowhere/main' && gone.mainOk === false && gone.mainMapped === true)

  /* 两条都配得上：第一条（from 更长的 WIN/main）在前 —— 配置顺序就是优先级。 */
  const d = bodyWith({
    worktreeDirMappings: [
      { id: 's1', from: WIN + '/main', to: MAIN },
      { id: 's2', from: WIN, to: ROOT + '/elsewhere' },
    ],
  })
  const first = await d.H('git/wt-main')({ repo: WINWT })
  check('多条映射第一条赢（清单顺序就是优先级）',
    first.mainDir === MAIN && first.mainOk === true && first.mainMapped === true)

  /* from/to 各带一条尾斜杠：同一条规则，照样配上（匹配前先去尾分隔符）。 */
  const e = bodyWith({ worktreeDirMappings: [{ id: 't1', from: WIN + '/', to: ROOT + '/' }] })
  const tailed = await e.H('git/wt-main')({ repo: WINWT })
  check('from/to 带尾斜杠也认（去尾分隔符后按前缀配，不拼出双斜杠）',
    tailed.mainDir === MAIN && tailed.mainOk === true && tailed.mainMapped === true)
}

console.log('')
console.log('== git/wt-main：worktreeMains 的手动答案压过映射；linked 不受映射影响 ==')
{
  const f = bodyWith({
    worktreeDirMappings: [{ id: 'm1', from: WIN, to: ROOT }],
    worktreeMains: { [WINWT]: MAIN },
  })
  const manual = await f.H('git/wt-main')({ repo: WINWT })
  check('worktreeMains 里有这个 worktree 的手动答案：mainSource=config、mainMapped=false（映射让路）',
    manual.mainDir === MAIN && manual.mainSource === 'config' && manual.configured === MAIN
    && manual.mainMapped === false && manual.mainOk === true)

  const g = bodyWith({ worktreeDirMappings: [{ id: 'm1', from: WIN, to: ROOT }] })
  const linked = await g.H('git/wt-main')({ repo: WT })
  check('（对照）git 读得动的真 worktree：主目录来自 git 自己的 commonDir，映射不掺和',
    linked.kind === 'linked' && linked.mainDir === MAIN && linked.mainSource === 'auto'
    && linked.mainMapped === false && linked.mainOk === true)
  check('（对照）读得动时 porcelain 清单照常解析',
    linked.worktrees.length === 2 && linked.worktrees.some((w) => w.path === MAIN && w.main === true))
}

console.log('')
console.log('== git/wt-main：机器上没有 git —— 映射照常工作（存在性不吃 git）==')
{
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ worktreeDirMappings: [{ id: 'm1', from: WIN, to: ROOT }] }))
  const h = makeBody({ PATH: NOPATH })
  const wt = await h.H('git/wt-main')({ repo: WINWT })
  say('没有 git 时的映射命中', { kind: wt.kind, mainDir: wt.mainDir, mainOk: wt.mainOk, mainMapped: wt.mainMapped })
  check('gitMissing=true 仍是 broken-gitlink，主目录照样换算、存在性照样答得出',
    wt.gitMissing === true && wt.kind === 'broken-gitlink'
    && wt.mainDir === MAIN && wt.mainOk === true && wt.mainMapped === true)
}

/* ═══ normalizeConfig 的 worktreeDirMappings 清洗 ═══ */
console.log('')
console.log('== normalizeConfig：worktreeDirMappings 清洗（git/config-save 那扇门）==')
{
  const i = makeBody()
  const notList1 = await i.H('git/config-save')({ config: { worktreeDirMappings: '不是表' } })
  const notList2 = await i.H('git/config-save')({ config: { worktreeDirMappings: { a: 1 } } })
  check('非数组 / 对象：清成空表（键永远在）',
    notList1.ok === true && JSON.stringify(notList1.config.worktreeDirMappings) === '[]'
    && JSON.stringify(notList2.config.worktreeDirMappings) === '[]')
  const longFrom = 'D:/' + 'f'.repeat(4096)
  const longTo = '/' + 't'.repeat(4096)
  const dirty = await i.H('git/config-save')({
    config: {
      worktreeDirMappings: [
        { id: 'keep1', from: '  ' + WIN + '  ', to: ' ' + ROOT + ' ' },
        { id: 'no-from', from: '   ', to: ROOT },
        { id: 'no-to', from: WIN, to: '' },
        { id: 'num-from', from: 42, to: ROOT },
        { id: 'num-to', from: WIN, to: 42 },
        '不是条目',
        { id: 'long', from: longFrom, to: ROOT },
        { id: 'longto', from: WIN, to: longTo },
        { from: WIN + '/x', to: ROOT + '/x' },
      ],
    },
  })
  const mappings = dirty.config.worktreeDirMappings
  check('脏条目全丢：缺 from/to、全空白、非字符串值、非对象条目',
    dirty.ok === true && mappings.length === 2
    && mappings.every((m) => typeof m.from === 'string' && typeof m.to === 'string' && m.from.length > 0 && m.to.length > 0))
  check('留下的条目去了首尾空白、id 保留',
    mappings[0].id === 'keep1' && mappings[0].from === WIN && mappings[0].to === ROOT)
  check('没带 id 的条目补造一个稳定串（quickCommands 同款），不是 undefined',
    typeof mappings[1].id === 'string' && mappings[1].id.length > 0 && mappings[1].from === WIN + '/x')
  check('超长（>4096）整条丢，不是截断（路径截半截会恰好配上别处）',
    mappings.every((m) => m.from.length <= 4096 && m.to.length <= 4096)
    && mappings.some((m) => m.id === 'long') === false && mappings.some((m) => m.id === 'longto') === false)
  const many = []
  for (let n = 0; n < 55; n += 1) many.push({ id: 'c' + n, from: WIN + '/' + n, to: ROOT + '/' + n })
  const capped = await i.H('git/config-save')({ config: { worktreeDirMappings: many } })
  check('封顶 50 条：排在前面的留下',
    capped.ok === true && capped.config.worktreeDirMappings.length === 50
    && capped.config.worktreeDirMappings[0].id === 'c0'
    && capped.config.worktreeDirMappings.some((m) => m.id === 'c50') === false)
  check('读回来一致（写盘的就是清洗后的那份）',
    JSON.stringify((await i.H('git/config')({})).config.worktreeDirMappings) === JSON.stringify(capped.config.worktreeDirMappings))
}

console.log('')
if (failed > 0) {
  console.error('gp63-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
console.log('（gp63-host 全部通过）')
