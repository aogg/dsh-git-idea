import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 配置页「远端」组的 Host 半侧：git/remotes 读 + git/remotes-save 写 ──
 *
 * 真起一个仓库（gp34a/gp51 的骨架），对着它跑这两条 RPC。盯这些：
 *   1. git/remotes 读：空仓库（没有任何远端）→ 空表 + insideRepo:true；两个远端
 *      其中之一配了不同 pushurl → 解析成两条、pushUrl 按 (push) 行合并进来、
 *      push 与 fetch 相同时 pushUrl 收成空串；目录在但不是仓库、连路径都没有
 *      （会话也没有工作区）→ 都是 ok:true + insideRepo:false + 空表（这组没得
 *      管，不算失败）；
 *   2. git/remotes-save add：正常名字+地址成功，答复带 action/name 与重新读出的
 *      远端表（读回来而不是回显输入），仓库里 git remote -v 真的多了一条，命令
 *      走 panelMutate 进「命令」页（argv 就是 git remote add 名 地址 一条）；
 *      重复名字 → ok:false 且 stderr 是 git 的原话（already exists）；
 *   3. 非法输入一律在动手前拒绝：远端名前导 - / 含空格 / 含控制字符 / 修剪后为
 *      空 / 缺名字，地址前导 - / 含控制字符 / 为空 / 缺地址 → bad-value，一条
 *      git remote 命令都没跑、git remote -v 原样；
 *   4. setUrl 改地址与 remove 删除：答复里的表都是重读出来的（新地址在、被删的
 *      不在），仓库里 git remote -v 跟着变，命令页里各是一条 git remote set-url
 *      / git remote remove；
 *   5. 形状不对 → bad-request：add/setUrl/remove 给了两个、一个都没给、add 不是
 *      对象 —— 同样一个字节不写。
 *
 * 夹具与隔离骨架照抄 gp51：HOME / GIT_CONFIG_GLOBAL / SYSTEM 全部压进 /tmp（钉
 * 在 makeBody 与 sh 里，不靠每个调用点记得传）；RPC 处理函数同款入参 —— 直接把
 * harness.handle 注册进表里的函数当 (input) => Promise 调。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')

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

const R = '/tmp/gp53-repo'
const T = '/tmp/gp53-notrepo'
const HOME = '/tmp/gp53-home'
const GLOBAL = HOME + '/.gitconfig'

/* 干净的空仓库 + 一个不是仓库的目录：读的一半用前者，分界的那两条用后者。 */
await sh(`rm -rf ${R} ${T} ${HOME} && mkdir -p ${HOME} ${R} ${T}
cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first`, '/tmp')

console.log('')
console.log('=== git/remotes 读：空仓库、push 不同、不在仓库 ===')
{
  const a = makeBody({})
  const empty = await a.H('git/remotes')({ repo: R })
  check('空仓库：ok:true、insideRepo:true、remotes 是空表',
    empty.ok === true && empty.insideRepo === true && empty.repo === R
    && Array.isArray(empty.remotes) && empty.remotes.length === 0)
  await sh(`cd ${R} && git remote add origin /tmp/gp53-origin.git && git remote add fork /tmp/gp53-fork.git && git remote set-url --push fork git@example.com:fork.git`, '/tmp')
  const list = await a.H('git/remotes')({ repo: R })
  const origin = list.remotes.find((one) => one.name === 'origin')
  const fork = list.remotes.find((one) => one.name === 'fork')
  check('两个远端解析成两条记录（名字各就各位）',
    list.ok === true && list.insideRepo === true && list.remotes.length === 2 && origin != null && fork != null)
  check('origin：url 是 fetch 地址，push 与 fetch 相同时 pushUrl 收成空串',
    origin.url === '/tmp/gp53-origin.git' && origin.pushUrl === '')
  check('fork：pushUrl 按 (push) 行合并进来，fetch 地址与 push 地址各归各',
    fork.url === '/tmp/gp53-fork.git' && fork.pushUrl === 'git@example.com:fork.git')
  const outside = await a.H('git/remotes')({ repo: T })
  check('目录在但不是仓库：ok:true + insideRepo:false + 空表（不是失败）',
    outside.ok === true && outside.insideRepo === false && outside.repo === T
    && Array.isArray(outside.remotes) && outside.remotes.length === 0)
  const nowhere = await a.H('git/remotes')({})
  check('连路径都没有（会话也没有工作区）：同样 ok:true + insideRepo:false + 空表',
    nowhere.ok === true && nowhere.insideRepo === false && nowhere.repo === null
    && Array.isArray(nowhere.remotes) && nowhere.remotes.length === 0)
}

console.log('')
console.log('=== git/remotes-save：add 成功进命令页，重复名被 git 拒 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  const add = await a.H('git/remotes-save')({ repo: R, add: { name: 'upstream', url: 'https://example.com/u.git' } })
  check('add 成功：action/name 带回，答复里是重新读出的表（里面真的有它）',
    add.ok === true && add.action === 'add' && add.name === 'upstream' && add.insideRepo === true
    && add.remotes.some((one) => one.name === 'upstream' && one.url === 'https://example.com/u.git'))
  check('仓库里真写进去了：git remote -v 多了一条 upstream',
    (await sh('git remote -v', R)).out.indexOf('upstream\thttps://example.com/u.git') >= 0)
  check('走的是 panelMutate：命令页里是 git remote add 名 地址 一条原样',
    seen.some((c) => c.indexOf("git 'remote' 'add' 'upstream' 'https://example.com/u.git'") >= 0))
  const dup = await a.H('git/remotes-save')({ repo: R, add: { name: 'upstream', url: 'https://example.com/again.git' } })
  check('重复名字 → ok:false，stderr 是 git 的原话（already exists）',
    dup.ok !== true && /already exists/i.test(dup.stderr || ''))
}

console.log('')
console.log('=== 非法输入：动手前拒绝，一条命令都不跑 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  const before = (await sh('git remote -v', R)).out
  const mark = seen.length
  const badNames = [['前导 -', '-evil'], ['含空格', 'my remote'], ['含控制字符', 'my\tremote'], ['修剪后为空', '   '], ['缺名字', undefined]]
  for (const [said, name] of badNames) {
    const payload = { url: 'https://example.com/ok.git' }
    if (name !== undefined) payload.name = name
    const reply = await a.H('git/remotes-save')({ repo: R, add: payload })
    check('名字 ' + said + ' → bad-value', reply.ok !== true && reply.error === 'bad-value')
  }
  const badUrls = [['前导 -', '-https://example.com/x.git'], ['含控制字符', 'https://example.com/x\tx.git'], ['为空', ''], ['缺地址', undefined]]
  for (const [said, url] of badUrls) {
    const payload = { name: 'legit' }
    if (url !== undefined) payload.url = url
    const reply = await a.H('git/remotes-save')({ repo: R, add: payload })
    check('地址 ' + said + ' → bad-value', reply.ok !== true && reply.error === 'bad-value')
  }
  check('这些拒绝一次 git remote 命令都没跑', seen.slice(mark).every((c) => c.indexOf("'remote'") < 0))
  check('仓库原样：git remote -v 一个字节没变', (await sh('git remote -v', R)).out === before)
}

console.log('')
console.log('=== setUrl 与 remove：答复里的表都是重读出来的 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  const set = await a.H('git/remotes-save')({ repo: R, setUrl: { name: 'upstream', url: 'https://example.com/u2.git' } })
  check('setUrl 成功：答复的重读表里 upstream 已是新地址',
    set.ok === true && set.action === 'setUrl'
    && set.remotes.some((one) => one.name === 'upstream' && one.url === 'https://example.com/u2.git'))
  check('仓库里 git remote -v 跟着变了',
    (await sh('git remote -v', R)).out.indexOf('upstream\thttps://example.com/u2.git') >= 0)
  check('命令页里是 git remote set-url 名 新地址',
    seen.some((c) => c.indexOf("git 'remote' 'set-url' 'upstream' 'https://example.com/u2.git'") >= 0))
  const rm = await a.H('git/remotes-save')({ repo: R, remove: { name: 'upstream' } })
  check('remove 成功：重读的表里没有它了（origin/fork 还在）',
    rm.ok === true && rm.action === 'remove' && rm.remotes.length === 2 && rm.remotes.every((one) => one.name !== 'upstream'))
  check('仓库里 git remote -v 也没了', (await sh('git remote -v', R)).out.indexOf('upstream') < 0)
  check('命令页里是 git remote remove 名', seen.some((c) => c.indexOf("git 'remote' 'remove' 'upstream'") >= 0))
}

console.log('')
console.log('=== 形状不对 → bad-request：add/setUrl/remove 一次只收一个 ===')
{
  const seen = []
  const a = makeBody({}, seen)
  const before = (await sh('git remote -v', R)).out
  const mark = seen.length
  const both = await a.H('git/remotes-save')({ repo: R, add: { name: 'x', url: 'https://example.com/x.git' }, setUrl: { name: 'origin', url: 'https://example.com/y.git' } })
  check('add 与 setUrl 同时给 → bad-request', both.ok !== true && both.error === 'bad-request')
  const none = await a.H('git/remotes-save')({ repo: R })
  check('一个动作都不给 → bad-request', none.ok !== true && none.error === 'bad-request')
  const notObject = await a.H('git/remotes-save')({ repo: R, add: 'https://example.com/x.git' })
  check('add 不是对象（给了字符串）等于没给 → bad-request', notObject.ok !== true && notObject.error === 'bad-request')
  check('这三次一个 git remote 命令都没跑、仓库原样',
    seen.slice(mark).every((c) => c.indexOf("'remote'") < 0) && (await sh('git remote -v', R)).out === before)
}

if (failed > 0) {
  console.error('gp53-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
