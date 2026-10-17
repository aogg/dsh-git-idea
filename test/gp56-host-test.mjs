import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 配置页项目档多仓库的宿主半侧：显式 repo 优先，缺省回退会话工作区 ──
 *
 * 客户端（gp56 客户端套件）把「本页在编辑哪个仓库」明说成 input.repo 发上来。
 * 宿主侧的语义是既有的（60-reads.js 的 repoFrom：显式路径优先、缺省回退会话
 * 工作区；argsAt 带 sessionId 保沙箱策略），这次多仓库改动在宿主是零改动 ——
 * 这份套件钉的就是那个「零改动」不能破，四条路由各钉一头：
 *   1. git/project-config：带 repo 答那个仓库（两个仓库的 local 名字各不相同才
 *      分得出来）；只带 sessionId 回退会话工作区（ctx 的 sessions 桩，cwd=R）；
 *   2. git/project-config-save：写落显式仓库的 .git/config，另一个仓库一个字节
 *      不动，答复回读的也是那个仓库；
 *   3. git/remotes：指名仓库答那个仓库的清单；缺省回退会话工作区；
 *   4. git/remotes-save：add 落显式仓库，另一个仓库的远端清单原样不动。
 *
 * 与 gp49 同一套骨架：HOME / GIT_CONFIG_GLOBAL / SYSTEM 都压到 /tmp，谁也摸不到
 * 跑测试这个人的真配置；sessions 桩只答 header.cwd —— 正好是 repoFrom 缺省那一半
 * 要的东西（沙箱策略没有 sandboxPolicy 服务时本来就取部署默认，与 gp49 一致）。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp56-home'
const GLOBAL = HOME + '/.gitconfig'
const R = '/tmp/gp56-repo'
const R2 = '/tmp/gp56-repo2'

function makeBody(sessions) {
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
  const services = { shell: { resolve: r => r, run: runShell } }
  if (sessions !== undefined) services.sessions = sessions
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

/* fixture：两个仓库，local 名字各配一个不一样的（local 值就是「答的是谁」的标签）；
 * R 挂 origin、R2 挂 upstream —— remotes 的两组断言靠名字分家。会话桩的 cwd 指向
 * R：哪条断言若答成了 R 的东西，而它本该答 R2，就说明显式 repo 被忽略了。 */
await sh(`rm -rf ${R} ${R2} ${HOME} && mkdir -p ${HOME} ${R} ${R2}
cd ${R} && git init -q -b main && git config user.email r@t && git config user.name Local-One && git remote add origin .
cd ${R2} && git init -q -b main && git config user.email r2@t && git config user.name Local-Two && git remote add upstream .`, '/tmp')

const sessionsStub = { get: () => ({ header: { cwd: R } }) }

console.log('')
console.log('=== git/project-config：显式 repo 优先，缺省回退会话工作区 ===')
{
  const a = makeBody(sessionsStub)
  const atR2 = await a.H('git/project-config')({ sessionId: 's-x', repo: R2 })
  check('带 repo:R2 答的是 R2（repo 字段与 local 名字都是它）',
    atR2.ok === true && atR2.repo === R2 && atR2.insideRepo === true && atR2.config['user.name'].local === 'Local-Two')
  const atR = await a.H('git/project-config')({ sessionId: 's-x', repo: R })
  check('同一会话指名 R：答的是 R（显式路径说了算，不由会话决定）',
    atR.ok === true && atR.repo === R && atR.config['user.name'].local === 'Local-One')
  const fallback = await a.H('git/project-config')({ sessionId: 's-x' })
  check('只带会话：回退会话工作区（桩的 cwd=R），与多仓库之前一字不差',
    fallback.ok === true && fallback.repo === R && fallback.config['user.name'].local === 'Local-One')
}

console.log('')
console.log('=== git/project-config-save：写落显式仓库，另一个仓库不动 ===')
{
  const b = makeBody(sessionsStub)
  const saved = await b.H('git/project-config-save')({ sessionId: 's-x', repo: R2, set: { 'user.name': 'Written-R2' } })
  check('save ok，答复回读的是 R2（local 与生效都换成写入值）',
    saved.ok === true && saved.repo === R2 && saved.config['user.name'].local === 'Written-R2'
    && saved.config['user.name'].effective === 'Written-R2')
  check('确实落 R2 的 .git/config；R 的 local 一个字节没动',
    (await sh('git config --local --get user.name', R2)).out.trim() === 'Written-R2'
    && (await sh('git config --local --get user.name', R)).out.trim() === 'Local-One')
}

console.log('')
console.log('=== git/remotes：指名答谁；缺省回退会话工作区 ===')
{
  const c = makeBody(sessionsStub)
  const atR2 = await c.H('git/remotes')({ sessionId: 's-x', repo: R2 })
  check('带 repo:R2 清单是 R2 的（upstream 在，origin 不在）',
    atR2.ok === true && atR2.repo === R2 && atR2.insideRepo === true
    && atR2.remotes.some((r) => r.name === 'upstream') && atR2.remotes.every((r) => r.name !== 'origin'))
  const fallback = await c.H('git/remotes')({ sessionId: 's-x' })
  check('只带会话：回退会话工作区 R（origin 在，upstream 不在）',
    fallback.ok === true && fallback.repo === R
    && fallback.remotes.some((r) => r.name === 'origin') && fallback.remotes.every((r) => r.name !== 'upstream'))
}

console.log('')
console.log('=== git/remotes-save：add 落显式仓库，另一个仓库的清单不动 ===')
{
  const d = makeBody(sessionsStub)
  const added = await d.H('git/remotes-save')({ sessionId: 's-x', repo: R2, add: { name: 'lab', url: '.' } })
  check('add ok，答复重读出的清单里有 lab（repo 是 R2）',
    added.ok === true && added.repo === R2 && added.remotes.some((r) => r.name === 'lab'))
  check('R2 的远端里真的有了 lab；R 的远端原样（lab 不在）',
    (await sh('git remote', R2)).out.split('\n').indexOf('lab') >= 0
    && (await sh('git remote', R)).out.split('\n').indexOf('lab') < 0
    && (await sh('git remote', R)).out.split('\n').indexOf('origin') >= 0)
}

if (failed > 0) {
  console.error('gp56-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
