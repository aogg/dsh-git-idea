import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 仓库分组（v0.2.9）的宿主半侧：61-repos.js 的登记目录扫描与三分流，70-config.js 的 repoDirs ──
 *
 * e1618b0 / 9a5c429 两个提交在 git/repos 与 git/repos-save 上加的第二份登记清单
 * repoDirs（工作区 → 「自己没有 .git、但子孙里嵌着仓库」的目录）。这份套件盯五片：
 *
 *   1. reposScanCommand 生成的 shell（从记的账里逐字看）：登记目录路径含空格 /
 *      单引号 / 冒号 / 尾斜杠时 shq 引用正确；每个目录一段 `if [ -d ] … else DX`
 *      —— 目录不在的分支发 `D<序号>X:`；标记协议 `D<序号>R|W:` 的序号与色标都
 *      在首个冒号之前（路径里有冒号也切不错列）；整趟读仍然只有一次 spawn。
 *   2. readWorkspaceRepos 的解析（假 shell 喂罐头行，边界真 find 给不出来）：
 *      D 行 → dirRepos 映射（keptDirs 排序为键序）、子孙并入 found 且去重、
 *      W 进 links、DX 进 missing；序号越界 / 色标不对 / 相对路径 / 非数字序号 /
 *      截半行（没有冒号、cut<2）的行整行丢弃；每目录清单与答复各自封顶；
 *      答复旧字段（repos/manual/missing/links/truncated）形状一字不变。
 *   3. 真盘端到端：空格 / 引号 / 冒号 / 尾斜杠目录名真扫一遍，dirRepos 的键是
 *      登记原文（尾斜杠保留）、根路径里的冒号原样带回来。
 *   4. saveWorkspaceRepo 三分流：有 .git → repos（原行为）、无 .git 存在目录 →
 *      repoDirs、不存在 → missing；重复 add 早退不写盘；remove 对「只在 repos /
 *      只在 repoDirs / 两边都在 / 两边都不在」四种情况幂等；写盘只动本工作区的
 *      键，别的键原样带过去。
 *   5. 70-config normalizeConfig 的 repoDirs：与 repos 同一套清洗（非对象清空、
 *      相对路径/超长丢、去首尾空白、去重、每工作区封顶 64、键封顶 128）；旧配置
 *      （无该键）读入兼容，git/repos 照常答 dirs:[] / dirRepos:{}。
 *
 * 骨架与 gp61 同一套：HOME / GIT_CONFIG_GLOBAL / SYSTEM 压到 /tmp，谁也摸不到
 * 跑测试这个人的真配置；假 shell 那半按命令形状发罐头，让解析层的边界行
 * （序号越界、截半行）真的流进 readWorkspaceRepos —— 真 find 永远产不出这些行。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp82-home'
const DSH = HOME + '/.dsh'
const CONFIG_FILE = DSH + '/dsh-git-idea.json'
const ROOT = '/tmp/gp82'

/* ── 真 shell 的 body（gp61 同款）：记账每一条命令，写盘计数从它来 ── */
function makeRealBody(sessions) {
  const runs = []
  const shellService = {
    resolve: (r) => r,
    run: (spec) => new Promise((res) => {
      runs.push(spec)
      const c = spawn('/bin/sh', ['-c', spec.command], {
        cwd: spec.workdir,
        env: Object.assign({}, process.env, {
          DSH_HOME: DSH, HOME: HOME,
          GIT_CONFIG_GLOBAL: HOME + '/.gitconfig', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        }),
      })
      let o = '', e = ''
      c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
      c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
      c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
    }),
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

/* ── 假 shell 的 body：按命令形状发罐头，解析层的边界行才能流进宿主 ──
 * spec: { config: 对象或 () => 对象, scan: () => ({ exitCode, stdout }) ,
 *         probe: (command) => 'repo' | 'dir' | 'none', writes: [] （落盘 JSON 收这里） } */
function makeFakeBody(spec) {
  const runs = []
  const home = (spec.home !== undefined ? spec.home : DSH)
  const configOf = () => (typeof spec.config === 'function' ? spec.config() : spec.config)
  const shellService = {
    resolve: (r) => r,
    run: (s) => {
      runs.push(s)
      const cmd = s.command
      if (cmd.indexOf('printf %s "${DSH_HOME') === 0) {
        return Promise.resolve({ exitCode: 0, stdout: { text: home }, stderr: { text: '' } })
      }
      if (cmd.indexOf('[ -f ') === 0) {
        const config = configOf()
        return Promise.resolve({ exitCode: config === null ? 1 : 0, stdout: { text: config === null ? '' : JSON.stringify(config) }, stderr: { text: '' } })
      }
      if (cmd.indexOf('{ find ') === 0) {
        const canned = spec.scan !== undefined ? spec.scan() : { exitCode: 0, stdout: '' }
        return Promise.resolve({ exitCode: canned.exitCode, stdout: { text: canned.stdout }, stderr: { text: '' } })
      }
      if (cmd.indexOf('if [ -e ') === 0) {
        return Promise.resolve({ exitCode: 0, stdout: { text: spec.probe(cmd) }, stderr: { text: '' } })
      }
      if (cmd.indexOf('mkdir -p ') === 0) {
        const m = cmd.match(/^mkdir -p .+ && printf %s (.+) > (.+)\n$/s)
        if (m !== null && spec.writes !== undefined) spec.writes.push({ json: unshq(m[1]), path: unshq(m[2]) })
        return Promise.resolve({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
      }
      return Promise.resolve({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
    },
  }
  const handlers = new Map()
  /* ctx.get('shell') 必须把假 shell 交出去：00-plugin.js 的入口在 apply 时就要拿到
     shell Service，拿不到就一句报错直接 return，一个 RPC 都不注册（真 body 同款）。 */
  const ctx = { get: (n) => (n === 'shell' ? shellService : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return { H: (n) => handlers.get(n), runs: runs }
}

/* shq 的逆：去两端引号，还原 '\'' 转义（writeConfigFile 落盘 JSON 的抓取用）。 */
function unshq(q) {
  return q.slice(1, -1).replace(/'\\''/g, "'")
}

function sh(cmd, cwd) {
  return new Promise((res) => {
    const c = spawn('/bin/sh', ['-c', cmd], { cwd, env: Object.assign({}, process.env, { HOME: HOME, GIT_CONFIG_GLOBAL: HOME + '/.gitconfig', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) })
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

/* ═══ 1. reposScanCommand 生成的 shell ═══ */
console.log('')
console.log('== reposScanCommand：登记目录的引用、DX 分支与标记协议（一次 spawn）==')
{
  await sh(`rm -rf ${ROOT}/scan ${HOME} && mkdir -p ${ROOT}/scan/ws ${DSH} '${ROOT}/scan/trail' '${ROOT}/scan/my dir' "${ROOT}/scan/quo'te" '${ROOT}/scan/co:lon'`)
  await sh(`git init -q '${ROOT}/scan/trail/inner' && git init -q '${ROOT}/scan/my dir/inner' && git init -q "${ROOT}/scan/quo'te/inner" && git init -q '${ROOT}/scan/co:lon/inner' && git init -q '${ROOT}/scan/ws/wsinner'`)
  const D_TRAIL = ROOT + '/scan/trail'
  const D_SPACE = ROOT + '/scan/my dir'
  const D_QUOTE = ROOT + '/scan/quo\'te'
  const D_COLON = ROOT + '/scan/co:lon'
  const D_GONE = ROOT + '/scan/gone-dir'
  const WS = ROOT + '/scan/ws'
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    repos: { [WS]: [ROOT + '/scan/gone-repo'] },
    repoDirs: { [WS]: [D_TRAIL + '/', D_SPACE, D_QUOTE, D_COLON, D_GONE] },
  }))
  const a = makeRealBody()
  const reply = await a.H('git/repos')({ sessionCwd: WS })
  const scans = a.runs.filter((r) => r.command.indexOf('{ find ') === 0)
  const cmd = scans.length > 0 ? scans[0].command : ''
  check('整趟读只有一次 spawn（登记目录并进同一条脚本，不加第二次）', scans.length === 1)
  check('工作区那半还是老样子打头（find <工作区> -maxdepth 6 …）',
    cmd.indexOf('{ find \'' + WS + '\' -maxdepth 6') === 0)
  check('手动清单那半的探针还在（[ -e …/.git ]）',
    cmd.indexOf('if [ -e \'' + ROOT + '/scan/gone-repo\'/.git ]') > 0)
  check('登记目录路径含空格：shq 单引号整体包住（[ -d \'<…>/my dir\' ]）',
    cmd.indexOf("if [ -d '" + D_SPACE + "' ]; then") > 0)
  check("登记目录路径含单引号：shq 的 '\\' 转义在（quo'te 变 quo'\\''te）",
    cmd.indexOf("if [ -d '" + D_QUOTE.replace("'", "'\\''") + "' ]; then") > 0)
  check('登记目录路径含冒号：原样进单引号（[ -d \'<…>/co:lon\' ]）',
    cmd.indexOf("if [ -d '" + D_COLON + "' ]; then") > 0)
  check('登记目录带尾斜杠：引用按登记原文（[ -d \'<…>/trail/\' ]）',
    cmd.indexOf("if [ -d '" + D_TRAIL + "/' ]; then") > 0)
  check("标记协议：序号+色标都在首个冒号之前（printf 'D0R:%s\\n' 与 D0W / D4X）",
    cmd.indexOf("printf 'D0W:%s\\n'") > 0 && cmd.indexOf("printf 'D0R:%s\\n'") > 0
    && cmd.indexOf("printf 'D4X:%s\\n'") > 0)
  check('协议没有退化成无序号的裸标记（D0: 与 D: 都不该出现）',
    cmd.indexOf("printf 'D0:%s") < 0 && cmd.indexOf("printf 'D:%s") < 0)
  check('目录已不存在的那段有 DX 分支（else printf 的 D4X 与 gone-dir 原文）',
    cmd.indexOf("else printf 'D4X:%s\\n' '" + D_GONE + "'") > 0)
  check('每个登记目录独立过 head 封顶（5 个目录 5 处 head -n 400 + 工作区 1 处 = 6）',
    (cmd.match(/head -n 400/g) || []).length === 6)

  check('答复 ok，工作区是会话自己的目录', reply.ok === true && reply.workspace === WS)
  check('dirs 只带登记且还在的，按路径排序（尾斜杠是登记原文的一部分，排序后原样在）',
    JSON.stringify(reply.dirs) === JSON.stringify([D_COLON, D_SPACE, D_QUOTE, D_TRAIL + '/']))
  check('dirRepos：冒号目录的子孙带回来了，根里的冒号原样（首个冒号切列切不错）',
    JSON.stringify(reply.dirRepos[D_COLON]) === JSON.stringify([D_COLON + '/inner']))
  check('dirRepos：空格/引号目录的子孙各自归位',
    JSON.stringify(reply.dirRepos[D_SPACE]) === JSON.stringify([D_SPACE + '/inner'])
    && JSON.stringify(reply.dirRepos[D_QUOTE]) === JSON.stringify([D_QUOTE + '/inner']))
  check('dirRepos：尾斜杠目录的键是登记原文（trail/），子孙在',
    reply.dirRepos[D_TRAIL + '/'] !== undefined
    && JSON.stringify(reply.dirRepos[D_TRAIL + '/']) === JSON.stringify([D_TRAIL + '/inner']))
  check('DX 的目录进 missing（跟手动清单里不在的并作一列，排序）',
    JSON.stringify(reply.missing) === JSON.stringify([D_GONE, ROOT + '/scan/gone-repo']))
  check('子孙仓库照常并入 repos（去重、排序），工作区自己的仓库也在',
    JSON.stringify(reply.repos) === JSON.stringify([
      D_COLON + '/inner', D_SPACE + '/inner', D_QUOTE + '/inner', D_TRAIL + '/inner', WS + '/wsinner',
    ]))
  check('旧字段形状不变：manual 原样、links 空、truncated false',
    JSON.stringify(reply.manual) === JSON.stringify([ROOT + '/scan/gone-repo'])
    && JSON.stringify(reply.links) === '[]' && reply.truncated === false)
}

/* ═══ 2. readWorkspaceRepos 的解析（假 shell 喂罐头行）═══ */
console.log('')
console.log('== readWorkspaceRepos 解析：D 行协议、去重、越界与截半行丢弃 ==')
{
  const WS = '/tmp/gp82/p/ws'
  const D1 = '/tmp/gp82/p/d-one'
  const D2 = '/tmp/gp82/p/d-two'
  const D3 = '/tmp/gp82/p/d-gone'
  const f = makeFakeBody({
    config: { repos: { [WS]: ['/tmp/gp82/p/manual-here', '/tmp/gp82/p/manual-gone'] }, repoDirs: { [WS]: [D2, D1, D3] } },
    scan: () => ({
      exitCode: 0,
      stdout: [
        'R:/tmp/gp82/p/ws/plain',
        'W:/tmp/gp82/p/ws/link',
        'M:/tmp/gp82/p/manual-here',
        'G:/tmp/gp82/p/manual-gone',
        'D0R:/tmp/gp82/p/d-two/x',
        'D0R:/tmp/gp82/p/d-two/x',
        'R:/tmp/gp82/p/d-two/x',
        'D1R:/tmp/gp82/p/d-one/a',
        'D1W:/tmp/gp82/p/d-one/b',
        'D1R:/tmp/gp82/p/co:lon/inside',
        'D2X:/tmp/gp82/p/d-gone',
        'D9R:/tmp/out-of-range',
        'D1Q:/tmp/bad-kind',
        'D1R:relative/path',
        'DxR:/tmp/not-a-number',
        'D1R:',
        'D1',
        'D:',
        '',
      ].join('\n'),
    }),
  })
  const reply = await f.H('git/repos')({ sessionCwd: WS })
  check('dirRepos 的映射：序号对回登记原文，键序跟 keptDirs（排序后），不在的目录不作键',
    JSON.stringify(Object.keys(reply.dirRepos)) === JSON.stringify([D1, D2]))
  check('dirRepos[d-one]：该目录名下三棵子孙都记着、组内排序，根里的冒号无碍',
    JSON.stringify(reply.dirRepos[D1]) === JSON.stringify([
      '/tmp/gp82/p/co:lon/inside', '/tmp/gp82/p/d-one/a', '/tmp/gp82/p/d-one/b',
    ]))
  check('dirRepos[d-two]：同一棵重复报两遍只记一次',
    JSON.stringify(reply.dirRepos[D2]) === JSON.stringify(['/tmp/gp82/p/d-two/x']))
  check('子孙并入 found 且去重（登记目录、工作区、手动清单三半扫到同一个仓库只留一份）',
    JSON.stringify(reply.repos) === JSON.stringify([
      '/tmp/gp82/p/co:lon/inside', '/tmp/gp82/p/d-one/a', '/tmp/gp82/p/d-one/b',
      '/tmp/gp82/p/d-two/x', '/tmp/gp82/p/manual-here', '/tmp/gp82/p/ws/link', '/tmp/gp82/p/ws/plain',
    ]))
  check('W 色进 links（登记目录与工作区两半同一个口径）',
    JSON.stringify(reply.links) === JSON.stringify(['/tmp/gp82/p/d-one/b', '/tmp/gp82/p/ws/link']))
  check('DX 进 missing（与手动清单的 G 并作一列、排序）',
    JSON.stringify(reply.missing) === JSON.stringify(['/tmp/gp82/p/d-gone', '/tmp/gp82/p/manual-gone']))
  check('序号越界（D9）的行整行丢弃：found / dirRepos / missing 里都没有它',
    reply.repos.indexOf('/tmp/out-of-range') < 0
    && JSON.stringify(reply).indexOf('/tmp/out-of-range') < 0)
  check('坏行全丢：色标不是 R/W（D1Q）、根不是绝对路径、序号非数字（Dx）、截半行（无冒号 / cut<2 / 空根）',
    JSON.stringify(reply).indexOf('/tmp/bad-kind') < 0 && JSON.stringify(reply).indexOf('relative/path') < 0
    && JSON.stringify(reply).indexOf('/tmp/not-a-number') < 0)
  check('keptDirs 排序：登记序是 [d-two, d-one, d-gone]，答复是排序后的 [d-one, d-two]',
    JSON.stringify(reply.dirs) === JSON.stringify([D1, D2]))
  check('旧字段形状不变：manual 照登记原文、truncated false、workspace 原样',
    JSON.stringify(reply.manual) === JSON.stringify(['/tmp/gp82/p/manual-here', '/tmp/gp82/p/manual-gone'])
    && reply.truncated === false && reply.workspace === WS && reply.ok === true)
}
console.log('')
console.log('== readWorkspaceRepos 解析：每目录封顶与答复封顶（70 行喂进去）==')
{
  const WS = '/tmp/gp82/c/ws'
  const D = '/tmp/gp82/c/dir'
  const rows = []
  /* 倒着喂：插入序与排序序相反，才分得出「先封顶再排序」还是「先排序再封顶」。 */
  for (let i = 69; i >= 0; i -= 1) rows.push('D0R:/tmp/gp82/c/r' + String(i).padStart(2, '0'))
  const f = makeFakeBody({
    config: { repoDirs: { [WS]: [D] } },
    scan: () => ({ exitCode: 0, stdout: rows.join('\n') }),
  })
  const reply = await f.H('git/repos')({ sessionCwd: WS })
  check('found/repositories 排序在前、封顶在后：字典序前 64 条（r00–r63）留下，truncated 报出来',
    reply.repos.length === 64 && reply.repos[0] === '/tmp/gp82/c/r00' && reply.repos[63] === '/tmp/gp82/c/r63'
    && reply.truncated === true)
  check('dirRepos 封顶在前（按扫描先后留前 64：r69 倒着喂 → r06–r69）、排序在后只管顺序',
    reply.dirRepos[D].length === 64 && reply.dirRepos[D][0] === '/tmp/gp82/c/r06'
    && reply.dirRepos[D][63] === '/tmp/gp82/c/r69' && reply.dirRepos[D].indexOf('/tmp/gp82/c/r00') < 0)
}
console.log('')
console.log('== readWorkspaceRepos 解析：no-path 与 scan-failed 的答复形状 ==')
{
  const f = makeFakeBody({ config: {} })
  const nopath = await f.H('git/repos')({})
  check('no-path：ok:false，新旧字段一齐在（dirs 空、dirRepos 空对象）',
    nopath.ok === false && nopath.error === 'no-path' && nopath.workspace === null
    && JSON.stringify(nopath.repos) === '[]' && JSON.stringify(nopath.manual) === '[]'
    && JSON.stringify(nopath.missing) === '[]' && JSON.stringify(nopath.links) === '[]'
    && JSON.stringify(nopath.dirs) === '[]' && JSON.stringify(nopath.dirRepos) === '{}')
  const WS = '/tmp/gp82/f/ws'
  const dead = makeFakeBody({ config: { repos: { [WS]: ['/tmp/gp82/f/m'] } }, scan: () => ({ exitCode: 1, stdout: '' }) })
  const failedScan = await dead.H('git/repos')({ sessionCwd: WS })
  check('scan-failed：ok:false 带 stderr，登记的账原样带出（manual），空的新字段也在',
    failedScan.ok === false && failedScan.error === 'scan-failed'
    && JSON.stringify(failedScan.manual) === JSON.stringify(['/tmp/gp82/f/m'])
    && JSON.stringify(failedScan.dirs) === '[]' && JSON.stringify(failedScan.dirRepos) === '{}')
}

/* ═══ 3+4. 真盘：saveWorkspaceRepo 三分流 / 幂等 remove / 只动本工作区键 ═══ */
const S = ROOT + '/s'
const S_WS = S + '/ws'
const S_REPO = S + '/exists-repo'
const S_NEWREPO = S + '/newrepo'
const S_PLAINDIR = S + '/plaindir'
const S_NEWDIR = S + '/newdir'
const S_NOWHERE = S + '/nowhere'
const S_GONE = S + '/gone-repo'
const S_BOTH = S + '/both'
const O_WS = '/tmp/gp82/other-ws'
const O_REPO = '/tmp/gp82/other-repo'
const O_DIR = '/tmp/gp82/other-dir'
const configWrites = (runs) => runs.filter((r) => r.command.indexOf("> '" + CONFIG_FILE + "'") >= 0)
const onDisk = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))

console.log('')
console.log('== git/repos-save：add 三分流（repo → repos / dir → repoDirs / none → missing）==')
{
  await sh(`rm -rf ${S} ${HOME} && mkdir -p ${S_WS} ${S_PLAINDIR}/nested ${S_NEWDIR} ${DSH}`
    + ` && git init -q -b main ${S_REPO} && git init -q -b main ${S_NEWREPO} && git init -q -b main ${S_PLAINDIR}/nested`)
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    repos: { [S_WS]: [S_REPO, S_GONE], [O_WS]: [O_REPO] },
    repoDirs: { [S_WS]: [S_PLAINDIR], [O_WS]: [O_DIR] },
  }))
  const a = makeRealBody()
  const addRepo = await a.H('git/repos-save')({ sessionCwd: S_WS, add: S_NEWREPO })
  check('有 .git 的 add 走老路：进 manual/repos，答复就是合并后的新清单',
    addRepo.ok === true && addRepo.manual.indexOf(S_NEWREPO) >= 0 && addRepo.repos.indexOf(S_NEWREPO) >= 0
    && Array.isArray(addRepo.dirs) && addRepo.dirRepos != null)
  check('落盘恰好一次，repos 键是 push 追加（原行为）、repoDirs 键没动',
    configWrites(a.runs).length === 1
    && JSON.stringify(onDisk().repos[S_WS]) === JSON.stringify([S_REPO, S_GONE, S_NEWREPO])
    && JSON.stringify(onDisk().repoDirs[S_WS]) === JSON.stringify([S_PLAINDIR]))
  const bytes1 = fs.readFileSync(CONFIG_FILE, 'utf8')
  const dupRepo = await a.H('git/repos-save')({ sessionCwd: S_WS, add: S_NEWREPO })
  check('重复 add 同一个仓库：早退（答复是当前清单），一个字节不落盘',
    dupRepo.ok === true && dupRepo.manual.indexOf(S_NEWREPO) >= 0
    && configWrites(a.runs).length === 1 && fs.readFileSync(CONFIG_FILE, 'utf8') === bytes1)
  const addDir = await a.H('git/repos-save')({ sessionCwd: S_WS, add: S_NEWDIR })
  check('无 .git 但存在的目录：进 repoDirs，repos 一字不动',
    addDir.ok === true && addDir.dirs.indexOf(S_NEWDIR) >= 0
    && JSON.stringify(onDisk().repoDirs[S_WS]) === JSON.stringify([S_PLAINDIR, S_NEWDIR])
    && JSON.stringify(onDisk().repos[S_WS]) === JSON.stringify([S_REPO, S_GONE, S_NEWREPO]))
  const bytes2 = fs.readFileSync(CONFIG_FILE, 'utf8')
  const dupDir = await a.H('git/repos-save')({ sessionCwd: S_WS, add: S_NEWDIR })
  check('重复 add 同一个目录：同样早退不落盘',
    dupDir.ok === true && configWrites(a.runs).length === 2 && fs.readFileSync(CONFIG_FILE, 'utf8') === bytes2)
  const addNone = await a.H('git/repos-save')({ sessionCwd: S_WS, add: S_NOWHERE })
  const addRel = await a.H('git/repos-save')({ sessionCwd: S_WS, add: 'relative/path' })
  const addBoth = await a.H('git/repos-save')({ sessionCwd: S_WS, add: S_REPO, remove: S_GONE })
  check('不存在的路径 → missing；相对路径 → absolute path required；add/remove 都给 → 二选一',
    addNone.ok === false && addNone.error === 'missing' && addNone.path === S_NOWHERE
    && addRel.ok === false && addRel.error === 'absolute path required'
    && addBoth.ok === false && addBoth.error === 'exactly one of add or remove is required')
  check('被拒的三次都没写盘', configWrites(a.runs).length === 2)
  check('写盘只动本工作区的键：别的键原样带过去',
    JSON.stringify(onDisk().repos[O_WS]) === JSON.stringify([O_REPO])
    && JSON.stringify(onDisk().repoDirs[O_WS]) === JSON.stringify([O_DIR]))
}
console.log('')
console.log('== git/repos-save：remove 两份清单幂等删，都不在早退不写盘 ==')
{
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    repos: { [S_WS]: [S_REPO, S_BOTH], [O_WS]: [O_REPO] },
    repoDirs: { [S_WS]: [S_PLAINDIR, S_BOTH], [O_WS]: [O_DIR] },
  }))
  const b = makeRealBody()
  const rmRepo = await b.H('git/repos-save')({ sessionCwd: S_WS, remove: S_REPO })
  check('remove 只在 repos 的：repos 删掉，repoDirs 原样，恰好写盘一次',
    rmRepo.ok === true && JSON.stringify(onDisk().repos[S_WS]) === JSON.stringify([S_BOTH])
    && JSON.stringify(onDisk().repoDirs[S_WS]) === JSON.stringify([S_PLAINDIR, S_BOTH])
    && configWrites(b.runs).length === 1)
  const rmDir = await b.H('git/repos-save')({ sessionCwd: S_WS, remove: S_PLAINDIR })
  check('remove 只在 repoDirs 的：repoDirs 删掉，repos 原样，又写盘一次',
    rmDir.ok === true && JSON.stringify(onDisk().repoDirs[S_WS]) === JSON.stringify([S_BOTH])
    && JSON.stringify(onDisk().repos[S_WS]) === JSON.stringify([S_BOTH])
    && configWrites(b.runs).length === 2)
  const rmBoth = await b.H('git/repos-save')({ sessionCwd: S_WS, remove: S_BOTH })
  /* 空清单按 normalizeRepoMap 的老规矩（repos 一直如此）整条从盘上消失 —— 答复侧
     repoDirsOf/manualReposOf 照样答 []，界面与行为不受盘上形状影响。 */
  check('remove 两边都在的：一份 remove 两边都删（幂等），只写一次盘（空清单的键从盘上消失，答复照答空）',
    rmBoth.ok === true && rmBoth.manual.length === 0 && rmBoth.dirs.length === 0
    && onDisk().repos[S_WS] === undefined && onDisk().repoDirs[S_WS] === undefined
    && configWrites(b.runs).length === 3)
  const bytes = fs.readFileSync(CONFIG_FILE, 'utf8')
  const rmNeither = await b.H('git/repos-save')({ sessionCwd: S_WS, remove: S_NOWHERE })
  check('remove 两边都不在：早退返回当前清单，一个字节不写',
    rmNeither.ok === true && rmNeither.manual.length === 0 && rmNeither.dirs.length === 0
    && configWrites(b.runs).length === 3 && fs.readFileSync(CONFIG_FILE, 'utf8') === bytes)
  const rmOther = await b.H('git/repos-save')({ sessionCwd: S_WS, remove: O_REPO })
  check('remove 别的工作区登记的路径：本工作区两份清单都没它 → 早退不写盘',
    configWrites(b.runs).length === 3 && fs.readFileSync(CONFIG_FILE, 'utf8') === bytes
    && JSON.stringify(onDisk().repos[O_WS]) === JSON.stringify([O_REPO]))
}

/* ═══ 5. 70-config normalizeConfig 的 repoDirs ═══ */
console.log('')
console.log('== normalizeConfig：repoDirs 与 repos 同一套清洗（git/config-save 那扇门）==')
{
  fs.rmSync(CONFIG_FILE, { force: true })
  const c = makeRealBody()
  const notMap1 = await c.H('git/config-save')({ config: { repoDirs: '不是表' } })
  const notMap2 = await c.H('git/config-save')({ config: { repoDirs: ['a'] } })
  check('非对象 / 数组：清成空表（键永远在）',
    notMap1.ok === true && JSON.stringify(notMap1.config.repoDirs) === '{}'
    && notMap2.ok === true && JSON.stringify(notMap2.config.repoDirs) === '{}')
  const longVal = '/' + 'v'.repeat(4097)
  const dirty = await c.H('git/config-save')({
    config: {
      repoDirs: {
        [S_WS]: ['relative/dir', '   ', 42, null, S_PLAINDIR + '  ', S_PLAINDIR, longVal, S_NEWDIR],
        'rel/key': [S_PLAINDIR],
        ['  ' + S_WS + '  ']: [S_NEWDIR],
      },
    },
  })
  const dirs = dirty.config.repoDirs
  check('脏值全丢：相对路径、空与全空白、非字符串；合法条目值去过两端空白',
    dirty.ok === true && dirs[S_WS] !== undefined
    && JSON.stringify(dirs[S_WS]) === JSON.stringify([S_PLAINDIR, S_NEWDIR]))
  /* normalizeRepoMap 不洗键（键在读取时才过 repoKeyOf）：带空白的键、根本不是路径的
     键都原样保留（值侧的清洗不殃及键），与 worktreeMains（键去空白）刻意不同 ——
     钉的就是这份「不同」不漂移。 */
  check('键不做清洗：相对路径的键、带空白的键都原样保留',
    dirs['rel/key'] !== undefined && JSON.stringify(dirs['rel/key']) === JSON.stringify([S_PLAINDIR])
    && dirs['  ' + S_WS + '  '] !== undefined
    && JSON.stringify(dirs['  ' + S_WS + '  ']) === JSON.stringify([S_NEWDIR]))
  check('同一格内去重、超长（>4096）整条丢，留下的是去重后的序',
    JSON.stringify(dirs[S_WS]) === JSON.stringify([S_PLAINDIR, S_NEWDIR]))
  check('读回来一致（写盘的就是清洗后的那份）',
    JSON.stringify((await c.H('git/config')({})).config.repoDirs) === JSON.stringify(dirs))
  const many = []
  for (let n = 0; n < 70; n += 1) many.push(S + '/cap-' + String(n).padStart(2, '0'))
  const capped = await c.H('git/config-save')({ config: { repoDirs: { [S_WS]: many } } })
  check('每工作区封顶 64 条：序在前的留下',
    capped.ok === true && capped.config.repoDirs[S_WS].length === 64
    && capped.config.repoDirs[S_WS][0] === S + '/cap-00'
    && capped.config.repoDirs[S_WS].indexOf(S + '/cap-69') < 0)
  const manyKeys = {}
  for (let n = 0; n < 130; n += 1) manyKeys[S + '/ws-' + String(n).padStart(3, '0')] = [S_PLAINDIR]
  const cappedKeys = await c.H('git/config-save')({ config: { repoDirs: manyKeys } })
  const keyCount = Object.keys(cappedKeys.config.repoDirs).length
  check('工作区键封顶 128 个：键序在前的留下',
    cappedKeys.ok === true && keyCount === 128
    && cappedKeys.config.repoDirs[S + '/ws-000'] !== undefined
    && cappedKeys.config.repoDirs[S + '/ws-129'] === undefined)
}
console.log('')
console.log('== 旧配置（无 repoDirs 键）兼容：读入不炸，git/repos 照常答空 ==')
{
  await sh(`rm -rf ${ROOT}/old ${HOME} && mkdir -p ${ROOT}/old/ws ${DSH} && git init -q ${ROOT}/old/ws/inner`)
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ repos: { [ROOT + '/old/ws']: [] } }))
  const d = makeRealBody()
  const cfg = await d.H('git/config')({})
  check('git/config 读出缺省：repoDirs 键在、是空表（normalizeConfig 的缺省形状）',
    cfg.ok === true && JSON.stringify(cfg.config.repoDirs) === '{}')
  const repos = await d.H('git/repos')({ sessionCwd: ROOT + '/old/ws' })
  check('git/repos 照常工作：扫到工作区的仓库，dirs 空、dirRepos 空对象、missing 空',
    repos.ok === true && JSON.stringify(repos.repos) === JSON.stringify([ROOT + '/old/ws/inner'])
    && JSON.stringify(repos.dirs) === '[]' && JSON.stringify(repos.dirRepos) === '{}'
    && JSON.stringify(repos.missing) === '[]')
}

console.log('')
if (failed > 0) {
  console.error('gp82-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
console.log('（gp82-host 全部通过）')
