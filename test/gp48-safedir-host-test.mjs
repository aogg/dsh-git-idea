import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 面板对「dubious ownership」的自愈：识别、写 global、重试、修不动时的独立状态 ──
 *
 * 背景（实测过的现场）：仓库属主是别的用户（比如 node），dsh 以 root 跑，git 的
 * safe.directory 保护直接拒读——而 pathShell 把 stderr 丢在地上，$gd 为空，面板于是
 * 对着一个好端端的仓库说「这个目录不是 Git 仓库」。本轮盯五件事：
 *   1. 自愈：属主不同的仓库，第一次读就自动把路径写进 global 的 safe.directory 并
 *      重试，读出 ok 与分支 —— 不再谎称「不是仓库」；
 *   2. 幂等：路径已在列就不再 --add，反复读之后 global 里还是一行（面板每几秒读一次，
 *      不能无限追加）；
 *   3. 识别只认 C locale 的原话：探测命令带 LC_ALL=C 前缀，修复只写 --global
 *      （safe.directory 只认 system/global，-c 与仓库内配置 git 一律忽略）；
 *   4. 配置写不进去（用 GIT_CONFIG_GLOBAL 指到一个目录来制造必然失败，root 也绕不过）
 *      时，答复是独立的 unsafe-owner 状态 —— 绝不是 not-a-repo；
 *   5. 无辜的路不多管：普通仓库读完后 global 里不许多出 safe.directory；真没有 .git
 *      的目录照旧报 not-a-repo。 */

/* chown 夹具只有 root 做得了；非 root 环境直接大声跳过，不算失败（与 gp34e 同一口径）。 */
if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  console.log('gp48-safedir: 需要 root（chown 造属主不同的仓库），本环境跳过')
  process.exit(0)
}

const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

/* 每个场景一个 body 实例：readCache 是模块级 Map，同一个实例里第二次同样的读会命中
 * 缓存、根本不跑脚本 —— 幂等必须靠新实例（fresh 缓存）让脚本真的再跑一遍来验证。
 * spy 收下每条发进 shell 的命令，给「生成的脚本长什么样」那组断言用。 */
function makeBody(extraEnv, spy) {
  const env = Object.assign({}, process.env, { DSH_HOME: '/tmp/gp48-home' }, extraEnv)
  function runShell(spec) {
    if (spy !== undefined) spy.push(spec.command)
    return new Promise((res) => {
      const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: env })
      let o = '', e = ''
      c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
      c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
      c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
    })
  }
  const handlers = new Map()
  const ctx = {
    get: n => (n === 'shell' ? { resolve: r => r, run: runShell } : undefined),
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
  }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return { H: n => handlers.get(n) }
}

function sh(cmd, cwd, extraEnv) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', cmd], { cwd, env: Object.assign({}, process.env, extraEnv) })
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

/* 夹具：R 建好之后整树 chown 给 nobody —— git 由此对 root 拒读。三份 HOME 都是干净
 * 的临时目录，global 配置从零开始，不碰跑测试这个人的真配置。 */
const R = '/tmp/gp48-repo'
const R2 = '/tmp/gp48-clean'
const R3 = '/tmp/gp48-norepo'
const HOME = '/tmp/gp48-home'
const CONFIG_DIR = '/tmp/gp48-config-dir'
await sh(`rm -rf ${R} ${R2} ${R3} ${HOME} ${CONFIG_DIR} ${HOME}2 ${HOME}3
mkdir -p ${HOME} ${HOME}2 ${HOME}3 ${CONFIG_DIR} ${R} ${R2} ${R3}
cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T && printf 'a\\n' > a.txt && git add -A && git commit -qm base
cd ${R2} && git init -q -b main && git config user.email t@t && git config user.name T && printf 'b\\n' > b.txt && git add -A && git commit -qm base
chown -R nobody ${R}`, '/tmp')

/* 前置核对：夹具真的踩在要修的坑上 —— root 读 R 必须被 dubious ownership 拒掉。 */
const pre = await sh(`git -C ${R} rev-parse --absolute-git-dir`, '/tmp', { HOME: HOME })
check('夹具前置：root 读属主 nobody 的仓库被拒，原话是 dubious ownership',
  pre.code !== 0 && pre.err.indexOf('dubious ownership') >= 0)

/* ── 生成的面板脚本：识别钉在 C locale，修复只写 global ──
 * 这是「语言环境无关」与「--global 才生效」的可执行说法：探测那行必须以 LC_ALL=C
 * 起头、只认 'dubious ownership' 这句 C 原话；写配置只许 --global，不许出现
 * -c safe.directory（git 对它视而不见，写了也是白写）。 */
console.log('')
console.log('=== 生成的面板脚本：识别与修复的形状 ===')
{
  const seen = []
  const cap = makeBody({ HOME: HOME }, seen)
  await cap.H('git/panel')({ repo: R })
  const panel = seen.find(c => c.indexOf('K:dir') >= 0) || ''
  check('探测命令以 LC_ALL=C 起头，只认 C 原话 dubious ownership',
    panel.indexOf("probe=$(LC_ALL=C git -C '" + R + "' rev-parse --absolute-git-dir 2>&1)") >= 0
    && panel.indexOf("'dubious ownership'") >= 0)
  check('修复只写 global 配置：--get-all 在前（幂等），--add 只在缺的时候补',
    panel.indexOf('git config --global --get-all safe.directory') >= 0
    && panel.indexOf('git config --global --add safe.directory') >= 0)
  check('不许出现 -c safe.directory（git 对它视而不见）',
    panel.indexOf('-c safe.directory') < 0)
}

/* ── 场景一：自愈。第一次读就该把路径写进 global 并重试，读出 ok 与分支。 ── */
console.log('')
console.log('=== 属主不同的仓库：第一次读自动修复 ===')
{
  const a = makeBody({ HOME: HOME })
  const reply = await a.H('git/panel')({ repo: R })
  check('第一次读就 ok，不再谎称「不是 Git 仓库」', reply.ok === true)
  check('分支读出来了（main）', reply.ok === true && reply.branch === 'main')
  const list = await sh('git config --global --get-all safe.directory', '/tmp', { HOME: HOME })
  check('global 的 safe.directory 恰好新增了一行，就是仓库路径', list.out.trim() === R)
  check('快读（身份）也读得动', (await a.H('git/panel')({ repo: R, quick: true })).ok === true)
}

/* ── 场景二：幂等。新实例（fresh 缓存）再读，global 里还是一行。 ──
 * 同一实例里第二次同样的读会命中 readCache、根本不跑脚本，所以这里必须换新实例。 */
console.log('')
console.log('=== 反复读不无限追加（幂等） ===')
{
  const b = makeBody({ HOME: HOME })
  const first = await b.H('git/panel')({ repo: R })
  const second = await b.H('git/panel')({ repo: R, quick: true })
  check('修复已在列：全树读与快读都 ok', first.ok === true && second.ok === true)
  const list = await sh('git config --global --get-all safe.directory', '/tmp', { HOME: HOME })
  check('反复读之后 global 里还是恰好一行', list.out.trim() === R)
}

/* ── 场景三：配置写不进去。GIT_CONFIG_GLOBAL 指到一个目录 —— 读它是错、写它更是
 * 错，root 也绕不过。此时答复必须是独立的 unsafe-owner，而不是 not-a-repo。 ── */
console.log('')
console.log('=== 配置写不进去：独立状态 unsafe-owner ===')
{
  const broken = { HOME: HOME + '2', GIT_CONFIG_GLOBAL: CONFIG_DIR }
  const quick = await makeBody(broken).H('git/panel')({ repo: R, quick: true })
  check('快读答复 ok=false，reason=unsafe-owner',
    quick.ok !== true && quick.reason === 'unsafe-owner')
  check('不是 not-a-repo（这正是本轮要治的谎报）', quick.reason !== 'not-a-repo')
  const full = await makeBody(broken).H('git/panel')({ repo: R })
  check('整树读同样落在 unsafe-owner', full.ok !== true && full.reason === 'unsafe-owner')
}

/* ── 场景四：无辜的路不多管。 ── */
console.log('')
console.log('=== 普通仓库与真没有仓库的目录 ===')
{
  const d = makeBody({ HOME: HOME + '3' })
  const ok = await d.H('git/panel')({ repo: R2 })
  check('属主相同的仓库照旧 ok', ok.ok === true)
  const list = await sh('git config --global --get-all safe.directory', '/tmp', { HOME: HOME + '3' })
  check('读普通仓库不碰 global 配置（一行都不许多写）', list.out.trim() === '')
  const none = await d.H('git/panel')({ repo: R3 })
  check('真没有 .git 的目录照旧报 not-a-repo', none.ok !== true && none.reason === 'not-a-repo')
}

if (failed > 0) {
  console.error('gp48-safedir: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
