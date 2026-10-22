import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── pull 的上游绑定（Host 半侧）：git/pull 的可选 payload setUpstream ──
 *
 * 需求：pull 时当前分支没有 upstream，客户端查到同名远端分支就带
 * setUpstream:{remote,branch} 一次跑完（先 set-upstream-to 再 pull）。Host 这半钉：
 *   1. 不带 setUpstream → 行为一字不变：argv 就是 pull（pullRebase 开了才带 --rebase），
 *      答复上没有 upstreamSet / pulled 这些新键；
 *   2. 带 setUpstream → 先 `git branch --set-upstream-to=<remote>/<branch>`（不给尾参，
 *      git 默认作用于当前分支），成功后跑原来的 pull；两步都进命令记录通道
 *      （panelMutate，spy 里两条都在、绑定在前）；答复 upstreamSet:true、pulled:true、
 *      setUpstream 带远端名与退出码；绑定后 @{u} 真的指向 origin/<branch>；
 *   3. 参数校验（cleanRefHalf，cleanIdentValue 同一套规矩）：空 / 前导 - / 控制字符
 *      一律 bad-value，一个字节不跑、不写；
 *   4. setUpstream 指向不存在的远端分支（refs 数据过期）→ ok:false、
 *      error:'set-upstream-failed'、pulled:false，stderr 带 "does not exist"
 *      （客户端就拿这句话回落到选择层），pull 不跑，@{u} 原样；
 *   5. 绑定成功而 pull 失败（冲突）→ upstream 保留（@{u} 已指向），答复
 *      upstreamSet:true 但 ok:false、exitCode 非 0 —— 错误照常显示。
 *
 * 夹具与隔离骨架照抄：gp34a 的 bare origin + 无 upstream 本地分支、gp49 的
 * HOME / GIT_CONFIG_GLOBAL / SYSTEM 全部压进 /tmp（钉在 makeBody 与 sh 里，
 * 不靠每个调用点记得传）。 */

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

const R = '/tmp/gp51-repo'
const O = '/tmp/gp51-origin'
const O2 = '/tmp/gp51-origin2'
const T = '/tmp/gp51-t2'
const HOME = '/tmp/gp51-home'
const GLOBAL = HOME + '/.gitconfig'

/* gp34a 的骨架：bare origin + 本地分支；这里再要一份「远端有同名、本地没绑」的
   side（git push 不带 -u），以及一个远端根本没有的 lonely。main 也不绑 —— 这个
   仓库里每个本地分支都还没有上游，正是新逻辑管的那批。 */
await sh(`rm -rf ${R} ${O} ${O2} ${T} ${HOME} && mkdir -p ${HOME} ${R}
cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first
git clone -q --bare . ${O} && git remote add origin ${O} && git push -q origin main
git clone -q --bare . ${O2} && git remote add other ${O2} && git push -q other main
git checkout -q -b side && echo b > b.txt && git add -A && git commit -qm side && git push -q origin side
git checkout -q -b lonely && echo l > l.txt && git add -A && git commit -qm lonely
git checkout -q main`, '/tmp')

console.log('')
console.log('=== 不带 setUpstream：行为一字不变 ===')
{
  const seen = []
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  const reply = await a.H('git/pull')({ repo: R })
  check('没有 upstream 的分支上 pull 照旧失败（git 自己的拒绝，不是新逻辑的）',
    reply.ok !== true && /no tracking information|no upstream configured/i.test(reply.stderr || ''))
  check('argv 就是 git pull 一条：没有 set-upstream-to（命令形状）',
    seen.some((c) => c.indexOf("git 'pull'") >= 0) && seen.every((c) => c.indexOf('set-upstream-to') < 0))
  check('答复上没有 upstreamSet / pulled 这些新键（不带的调用一字不多）',
    reply.upstreamSet === undefined && reply.pulled === undefined)
  check('@{u} 仍然为空', (await sh('git rev-parse --abbrev-ref --symbolic-full-name @{u}', R)).code !== 0)
}

console.log('')
console.log('=== 带 setUpstream：先绑定再拉取，@{u} 指对 ===')
{
  const seen = []
  /* 每节先把配置文件清掉：上一节可能存过 pullRebase 之类的键，配置是落在
     HOME/.dsh 里的，跨 makeBody 存活。 */
  await sh('rm -f ' + HOME + '/.dsh/dsh-git-idea.json', '/tmp')
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await sh('git checkout -q side', R)
  const reply = await a.H('git/pull')({ repo: R, setUpstream: { remote: 'origin', branch: 'side' } })
  check('ok，upstreamSet:true、pulled:true、setUpstream 带远端名与退出码 0',
    reply.ok === true && reply.upstreamSet === true && reply.pulled === true
    && reply.setUpstream != null && reply.setUpstream.remote === 'origin' && reply.setUpstream.branch === 'side'
    && reply.setUpstream.exitCode === 0)
  const at = seen.findIndex((c) => c.indexOf('set-upstream-to=origin/side') >= 0)
  const pull = seen.findIndex((c) => c.indexOf("git 'pull'") >= 0)
  check('两条命令都跑了：绑定在前（--set-upstream-to=origin/side），pull 在后',
    at >= 0 && pull > at && seen.some((c) => c.indexOf("git 'branch' '--set-upstream-to=origin/side'") >= 0))
  check('绑定真的生效：@{u} = origin/side',
    (await sh('git rev-parse --abbrev-ref --symbolic-full-name @{u}', R)).out.trim() === 'origin/side')
  check('pull 是普通那条（pullRebase 没开，不带 --rebase）',
    (seen[pull] || '').indexOf("'--rebase'") < 0)
}

console.log('')
console.log('=== 参数校验：非法一律 bad-value，一个字节不跑 ===')
{
  const seen = []
  await sh('rm -f ' + HOME + '/.dsh/dsh-git-idea.json', '/tmp')
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  const cases = [
    ['remote 为空', { remote: '  ', branch: 'side' }],
    ['branch 为空', { remote: 'origin', branch: '' }],
    ['remote 前导 -', { remote: '-evil', branch: 'side' }],
    ['branch 前导 -', { remote: 'origin', branch: '-x' }],
    ['remote 带控制字符', { remote: 'o\nr', branch: 'side' }],
    ['branch 带控制字符', { remote: 'origin', branch: 'si\tde' }],
  ]
  for (const [name, payload] of cases) {
    const before = seen.length
    const reply = await a.H('git/pull')({ repo: R, setUpstream: payload })
    /* 配置探测（printf/cat）也会进 spy；这里钉的是 git 一次都没被启动。 */
    check(name + ' → bad-value、git 一次都没跑',
      reply.ok !== true && reply.error === 'bad-value' && reply.upstreamSet === false && reply.pulled === false
      && seen.slice(before).every((c) => c.indexOf("'pull'") < 0 && c.indexOf("'branch'") < 0 && c.indexOf('set-upstream-to') < 0))
  }
  const missing = await a.H('git/pull')({ repo: R, setUpstream: { remote: 'origin' } })
  check('setUpstream 给了但缺 branch 也算没给对（对象缺键同样拒绝）',
    missing.ok !== true && missing.error === 'bad-value')
}

console.log('')
console.log('=== 远端分支其实不存在（refs 过期）：报错可回落，pull 不跑 ===')
{
  const seen = []
  await sh('rm -f ' + HOME + '/.dsh/dsh-git-idea.json', '/tmp')
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await sh('git checkout -q lonely', R)
  const reply = await a.H('git/pull')({ repo: R, setUpstream: { remote: 'origin', branch: 'ghost' } })
  check('ok:false、error:set-upstream-failed、upstreamSet:false、pulled:false',
    reply.ok !== true && reply.error === 'set-upstream-failed' && reply.upstreamSet === false && reply.pulled === false)
  check('stderr 带 "does not exist"（客户端拿这句话回落到选择层）',
    /does not exist/.test(reply.stderr || ''))
  check('setUpstream 带着这一步自己的退出码与非 0 的 exitCode',
    reply.setUpstream != null && reply.setUpstream.branch === 'ghost' && reply.setUpstream.exitCode !== 0
    && reply.exitCode !== 0)
  /* 配置探测（printf/cat）也进 spy；git 命令里只有绑定那一条，pull 一次没跑。 */
  check('pull 没有跑（git 命令里只有绑定那一条）',
    seen.every((c) => c.indexOf("'pull'") < 0)
    && seen.filter((c) => c.indexOf('set-upstream-to=origin/ghost') >= 0).length === 1)
  check('@{u} 原样为空', (await sh('git rev-parse --abbrev-ref --symbolic-full-name @{u}', R)).code !== 0)
}

console.log('')
console.log('=== 绑定成功而 pull 失败（冲突）：upstream 保留 ===')
{
  const seen = []
  await sh('rm -f ' + HOME + '/.dsh/dsh-git-idea.json', '/tmp')
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await sh(`cd ${R} && git checkout -q -b conf main
git config pull.rebase false
echo base > c.txt && git add -A && git commit -qm conf-base && git push -q origin conf
git clone -q ${O} ${T} && cd ${T} && git config user.email t@t && git config user.name T && git checkout -q -b conf origin/conf && echo theirs > c.txt && git add -A && git commit -qm conf-theirs && git push -q origin conf
cd ${R} && git checkout -q conf && echo ours > c.txt && git add -A && git commit -qm conf-ours`, '/tmp')
  const reply = await a.H('git/pull')({ repo: R, setUpstream: { remote: 'origin', branch: 'conf' } })
  check('答复 upstreamSet:true（绑定这步成功了）但 ok:false、pulled:true、退出码非 0',
    reply.upstreamSet === true && reply.pulled === true && reply.ok !== true && reply.exitCode !== 0)
  /* git merge 的冲突叙述走 stdout（Auto-merging / CONFLICT / Automatic merge
     failed），stderr 常常是空的 —— 两股合起来验。仓库里 config 了 pull.rebase
     false：这台 git（≥2.34）在策略未定时根本不拉（"Need to specify how to
     reconcile divergent branches"），那就到不了冲突这一步。 */
  check('答复里说的是合并冲突（stdout 或 stderr）',
    /CONFLICT|Automatic merge failed/i.test((reply.stderr || '') + '\n' + (reply.stdout || '')))
  check('upstream 保留：@{u} 已经指向 origin/conf —— 冲突解决后照常 pull',
    (await sh('git rev-parse --abbrev-ref --symbolic-full-name @{u}', R)).out.trim() === 'origin/conf')
  check('两条命令都在（绑定 + 拉取）',
    seen.some((c) => c.indexOf('set-upstream-to=origin/conf') >= 0) && seen.some((c) => c.indexOf("git 'pull'") >= 0))
  await sh('cd ' + R + ' && git merge --abort 2>/dev/null; git rebase --abort 2>/dev/null; true', '/tmp')
}

console.log('')
console.log('=== pullRebase：原路径原样，setUpstream 叠加也照旧带 --rebase ===')
{
  const seen = []
  const a = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen)
  await a.H('git/config-save')({ config: { pullRebase: true } })
  await sh('cd ' + R + ' && git checkout -q side', '/tmp')
  await a.H('git/pull')({ repo: R })
  check('不带 setUpstream：pullRebase 开了照旧带 --rebase（原路径原样保留）',
    seen.some((c) => c.indexOf("git 'pull' '--rebase'") >= 0 && c.indexOf('set-upstream-to') < 0))
  const seen2 = []
  const b = makeBody({ HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL }, seen2)
  await sh('cd ' + R + ' && git checkout -q main', '/tmp')
  const reply = await b.H('git/pull')({ repo: R, setUpstream: { remote: 'origin', branch: 'main' } })
  const at = seen2.findIndex((c) => c.indexOf('set-upstream-to=origin/main') >= 0)
  const pull = seen2.findIndex((c) => c.indexOf("git 'pull' '--rebase'") >= 0)
  check('带 setUpstream：先绑定再 pull --rebase，@{u} = origin/main',
    reply.ok === true && reply.upstreamSet === true && at >= 0 && pull > at
    && (await sh('git rev-parse --abbrev-ref --symbolic-full-name @{u}', R)).out.trim() === 'origin/main')
}

if (failed > 0) {
  console.error('gp51-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
