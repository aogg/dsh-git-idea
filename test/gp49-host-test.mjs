import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 面板「配置」页的 Host 半侧：git/project-config 读与写 ──
 *
 * 钉六件事：
 *   1. 读：四个键各答 local / global / 生效与来源（--show-origin 那把）；不知道是哪个
 *      仓库时只答 global 并明说 insideRepo:false —— 绝不拿 dsh 进程自己的目录冒充
 *      仓库（74-identity.js 顶部那个被 fixture 抓出来的坑，这里再钉一次）；
 *   2. set 写 --local：user.* 与 core.* 都落在仓库的 .git/config 里，答复是「读回来」
 *      的新快照（不是回显输入）；
 *   3. 键白名单：set 里混进白名单外的键被丢掉，一个字节不写；
 *   4. 值校验：autocrlf 只收 true/false/input、eol 只收 lf/crlf/native，非法直接报
 *      错且什么都不写；user.* 走 cleanIdentValue —— 控制字符与前导 - 拒；
 *   5. unset 用 --unset：本来的键清掉；本来就没配（退出码 5）也算成功 —— 清两次
 *      第二次不报错；
 *   6. 这两条不进「命令」页记录（设置类动作，git/identity-save 同一个先例）；
 *      plugin 配置归一化的新键（refreshOnComplete 缺省 true、pushOnAllComplete 缺省
 *      false、乱输入归位、原有键不丢）也在 git/config-save 上顺手钉住。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

/* 与 gp48 同一套骨架：HOME / GIT_CONFIG_GLOBAL / SYSTEM 都压到 /tmp —— 这份隔离钉
 * 在 makeBody 与 sh 里面，而不是靠每个调用点记得传（漏一处，`git config --global`
 * 就摸到跑测试这个人的真配置了）。spy 收下每条发进 shell 的命令，给「命令形状」
 * 那组断言用。 */
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

const R = '/tmp/gp49-repo'
const HOME = '/tmp/gp49-home'
const GLOBAL = HOME + '/.gitconfig'
await sh(`rm -rf ${R} ${HOME} && mkdir -p ${HOME} ${R}
cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T && printf 'a\\n' > a.txt && git add -A && git commit -qm base
git config --local --unset user.name && git config --local --unset user.email`, '/tmp')

console.log('')
console.log('=== 读：四个键的 local / global / 生效与来源 ===')
{
  const a = makeBody()
  const empty = await a.H('git/project-config')({ repo: R })
  check('干净仓库：ok，四个键都在，全是空', empty.ok === true && empty.insideRepo === true && empty.repo === R
    && ['user.name', 'user.email', 'core.autocrlf', 'core.eol'].every((k) => empty.config[k] != null)
    && empty.config['user.name'].effective === '' && empty.config['core.eol'].local === '')
  await sh(`git config --global user.name 'Ada Lovelace' && git config --global user.email ada@example.com && git config --global core.eol native`, '/tmp')
  const withGlobal = await makeBody().H('git/project-config')({ repo: R })
  check('global 配了：global 与生效都答它，来源指到全局文件',
    withGlobal.config['user.name'].global === 'Ada Lovelace'
    && withGlobal.config['user.name'].effective === 'Ada Lovelace'
    && withGlobal.config['user.name'].effectiveOrigin.indexOf('.gitconfig') >= 0
    && withGlobal.config['user.name'].local === ''
    && withGlobal.config['core.eol'].global === 'native')
  await sh(`git config --local core.autocrlf input`, R)
  const withLocal = await makeBody().H('git/project-config')({ repo: R })
  check('local 配了：local 答它，生效换成它、来源换成 .git/config',
    withLocal.config['core.autocrlf'].local === 'input'
    && withLocal.config['core.autocrlf'].effective === 'input'
    && withLocal.config['core.autocrlf'].effectiveOrigin === '.git/config')
  const nowhere = await makeBody().H('git/project-config')({})
  check('不知道是哪个仓库：insideRepo:false，只答 global，不冒充生效',
    nowhere.ok === true && nowhere.insideRepo === false && nowhere.repo === null
    && nowhere.config['user.name'].global === 'Ada Lovelace'
    && nowhere.config['user.name'].effective === 'Ada Lovelace'
    && nowhere.config['user.name'].effectiveOrigin.indexOf('.gitconfig') >= 0
    && nowhere.config['core.autocrlf'].local === '' && nowhere.config['core.autocrlf'].effective === '')
}

console.log('')
console.log('=== 写：set 落 --local，键白名单外的键被丢掉 ===')
{
  const seen = []
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  const first = await a.H('git/project-config-save')({ repo: R, set: { 'user.name': 'Repo Only', 'user.email': 'repo@example.com' } })
  check('save ok，written 列出两个键', first.ok === true && first.written.join(',') === 'user.name,user.email')
  check('确实落在仓库的 .git/config（--local）',
    (await sh('git config --local --get user.name', R)).out.trim() === 'Repo Only'
    && (await sh('git config --local --get user.email', R)).out.trim() === 'repo@example.com')
  check('命令形状：config --local <k> <v>（argv 由 shq 逐个加引号）',
    seen.some((c) => c.indexOf("git 'config' '--local' 'user.name'") >= 0))
  check('答复是回读不是回显：生效与来源都换成 .git/config',
    first.config['user.name'].effective === 'Repo Only' && first.config['user.name'].effectiveOrigin === '.git/config')
  const sneaky = await a.H('git/project-config-save')({ repo: R, set: { 'core.eol': 'lf', 'evil.key': 'boom' } })
  check('白名单外的键直接丢掉，白名单内的照写', sneaky.ok === true && sneaky.written.join(',') === 'core.eol'
    && (await sh('git config --local --get evil.key', R)).code !== 0
    && (await sh('git config --local --get core.eol', R)).out.trim() === 'lf')
  const upper = await a.H('git/project-config-save')({ repo: R, set: { 'core.autocrlf': 'TRUE' } })
  check('autocrlf 收下来归一成小写', upper.ok === true && (await sh('git config --local --get core.autocrlf', R)).out.trim() === 'true')
}

console.log('')
console.log('=== 写：非法值一律拒绝，且一个字节都不写 ===')
{
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL })
  const before = (await sh('cat ' + R + '/.git/config', '/tmp')).out
  const badCrlf = await a.H('git/project-config-save')({ repo: R, set: { 'core.autocrlf': 'auto' } })
  const badEol = await a.H('git/project-config-save')({ repo: R, set: { 'core.eol': 'system' } })
  const badName = await a.H('git/project-config-save')({ repo: R, set: { 'user.name': 'a\nb' } })
  const badDash = await a.H('git/project-config-save')({ repo: R, set: { 'user.email': '-x' } })
  const emptySet = await a.H('git/project-config-save')({ repo: R, set: { 'user.name': '  ' } })
  check('autocrlf 非法值被拒', badCrlf.ok !== true && badCrlf.error === 'bad-value')
  check('eol 非法值被拒', badEol.ok !== true && badEol.error === 'bad-value')
  check('user.name 的控制字符被拒（cleanIdentValue 的规矩）', badName.ok !== true)
  check('前导 - 被拒', badDash.ok !== true)
  check('空值 = 没有要写的键，也不算成功', emptySet.ok !== true)
  check('这五次拒绝一个字节都没写', (await sh('cat ' + R + '/.git/config', '/tmp')).out === before)
  const nowhere = await a.H('git/project-config-save')({ set: { 'user.name': 'x' } })
  check('不知道写进哪个仓库 → 直说 no-path，不猜一个', nowhere.ok !== true && nowhere.error === 'no-path')
}

console.log('')
console.log('=== 清：unset 用 --unset，退出码 5（本来就没配）算成功 ===')
{
  const seen = []
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  const one = await a.H('git/project-config-save')({ repo: R, unset: ['core.eol'] })
  check('清掉配过的键：ok，本地那份没了，生效落回全局',
    one.ok === true && one.unset.join(',') === 'core.eol'
    && (await sh('git config --local --get core.eol', R)).code !== 0
    && one.config['core.eol'].effective === 'native')
  check('命令形状：config --local --unset <k>', seen.some((c) => c.indexOf("git 'config' '--local' '--unset' 'core.eol'") >= 0))
  const twice = await a.H('git/project-config-save')({ repo: R, unset: ['core.eol'] })
  const thrice = await a.H('git/project-config-save')({ repo: R, unset: ['user.name'] })
  check('再清一次（本来就没配）照样 ok —— 退出码 5 就是目的地',
    twice.ok === true && twice.unset.join(',') === 'core.eol'
    && thrice.ok === true && (await sh('git config --local --get user.name', R)).code !== 0)
}

console.log('')
console.log('=== 设置类动作不进「命令」页；plugin 配置归一化的新键 ===')
{
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL })
  await a.H('git/project-config-save')({ repo: R, set: { 'user.name': 'Quiet' } })
  const log = await a.H('git/command-log')({ repo: R, limit: 100 })
  check('命令页里没有 project-config 这条（git/identity-save 同一个先例）',
    log.ok !== true || !Array.isArray(log.commands) || log.commands.every((c) => String(c.command).indexOf('project-config') < 0 && String(c.desc || '').indexOf('配置') < 0))
  const saved = await a.H('git/config-save')({ config: { initBranch: 'dev', refreshOnComplete: 'yes', pushOnAllComplete: true, repos: { '/w': ['/r'] } } })
  check('乱输入归位：refreshOnComplete 非 false 即 true', saved.ok === true && saved.config.refreshOnComplete === true)
  check('pushOnAllComplete 收布爾', saved.config.pushOnAllComplete === true)
  check('原有键不丢：initBranch 与 repos 原样在', saved.config.initBranch === 'dev' && saved.config.repos['/w'][0] === '/r')
  const off = await a.H('git/config-save')({ config: { initBranch: 'dev', refreshOnComplete: false, pushOnAllComplete: false } })
  check('显式关掉的两个开关原样落盘', off.ok === true && off.config.refreshOnComplete === false && off.config.pushOnAllComplete === false)
  const blank = await a.H('git/config-save')({ config: null })
  check('没有这份配置时落在缺省：true / false', blank.ok === true && blank.config.refreshOnComplete === true && blank.config.pushOnAllComplete === false)
}

if (failed > 0) {
  console.error('gp49-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
