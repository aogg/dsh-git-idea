import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 会话完成 → 提交历史列表跟着刷新（Host 这一侧：失效范围与 graph 缓存键）──
 *
 * 用户报的场景：会话完成后，历史页的 git/graph 提交列表没有跟着刷新。客户端那一半
 * （gp67-client）钉「铃响后面板确实重发了 git/graph」；这里钉的是另一半 —— 重发
 * 之后的那个读，拿到的到底是不是失效缓存后的新账。四件事：
 *
 *   0.（钉缺口）没有任何浏览器页面在场的完成：chip 边沿不存在、liveBus 订阅不存在、
 *      git/flush 没人发，签名轮询也因 sockets 空而整轮省掉（79-live-watch.js 的
 *      两条取舍）——宿主读缓存里那份 graph 就永远停在提交之前。会话完成边沿 2 秒
 *      防抖到点的那一拍，宿主自己必须先把这笔账作废，下次打开面板（重发 git/graph）
 *      读到的才是新提交。这一条是「关着下次打开必是新账」的宿主半边，也是本次修的
 *      那个缺口。
 *   1. 页面在场的既有契约：客户端完成那一刷发的两条 flush（会话级不带 repo + 带
 *      repo）与 graphSnapshot 的缓存键 repo 前缀对得上 —— 会话工作区就是仓库时，
 *      两条各自都足以让下一条 git/graph 变新账。
 *   2. 面板生效仓库是嵌套仓库（请求显式带 repo=A，会话工作区是 W）：会话级 flush
 *      只作废 W 前缀，动不了 A 的 graph —— 负对照先钉「少了带 A 的那条 flush 就
 *      是用户看到的旧列表」，再钉「带上就新账」。客户端必须把生效仓库算进
 *      completionReposOf（gp67-client 钉）。
 *   3. 重开面板边界的带 tags flush（panel-ident/branches）刻意不动 graph —— 历史
 *      列表的新旧只挂在完成那一刷（或 ⟳）上；顺手钉「flush 的 repo 必须与缓存键
 *      逐字节同形（尾斜杠都不行）」，这是客户端清单路径与请求路径同源的硬约束。
 *
 * 与 gp49 同一套骨架：HOME / GIT_CONFIG_GLOBAL / SYSTEM 压到 /tmp。sessions / agents
 * 是桩（79-live-watch 只认这两个形状），liveHub 给一只 sockets 为空的壳 —— 正是
 * 「浏览器一个都不在」的现场；liveSend 是记录器，完成推送发没发看得见。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

const R = '/tmp/gp67-repo'
const W = '/tmp/gp67-ws'
const A = '/tmp/gp67-nested'
const HOME = '/tmp/gp67-home'
const GLOBAL = HOME + '/.gitconfig'

function makeBody67(spy, services) {
  const shellEnv = Object.assign({}, process.env, {
    DSH_HOME: HOME + '/.dsh', HOME: HOME, GIT_CONFIG_GLOBAL: GLOBAL,
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  })
  function runShell(spec) {
    if (spy != null) spy.push(spec.command)
    return new Promise((res) => {
      const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: shellEnv })
      let o = '', e = ''
      c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
      c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
      c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
    })
  }
  const handlers = new Map()
  const ctx = {
    get(n) {
      if (n === 'shell') return { resolve: r => r, run: runShell }
      if (n === 'sessions') return services != null ? services.sessions : undefined
      if (n === 'agents') return services != null ? services.agents : undefined
      return undefined
    },
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
  }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  /* 与 gp49 同一条路：bundle 求值返回 { apply(ctx) }，再 apply 进这个 ctx。
     liveHub 是外层参数（pkg 前奏提供的全局在这里由桩顶上）：sockets 空壳 +
     send 记录器；liveSend 由 bundle 自己定义（走 liveHub.send），不用桩。 */
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', 'liveHub', body)(
    ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder,
    services != null ? services.liveHub : undefined
  ).apply(ctx)
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
const subjectOf = (reply, index) => (reply != null && Array.isArray(reply.commits) && reply.commits[index] != null
  ? String(reply.commits[index].subject) : '')

await sh(`rm -rf ${R} ${W} ${A} ${HOME} && mkdir -p ${HOME} ${W}
git init -q -b main ${R} && cd ${R} && git config user.email t@t && git config user.name T && printf 'a\\n' > a.txt && git add -A && git commit -qm base
git init -q -b main ${A} && cd ${A} && git config user.email t@t && git config user.name T && printf 'n\\n' > n.txt && git add -A && git commit -qm nested-base
cd ${W} && git init -q -b main . && git config user.email t@t && git config user.name T && printf 'w\\n' > w.txt && git add -A && git commit -qm ws-base`, '/tmp')

console.log('')
console.log('=== 0｜没有任何浏览器在场：完成那一拍宿主自己作废 graph，重开即新账 ===')
{
  /* agents 的 running 位由这面旗子驱动，每拍现读 —— 模拟「agent 在跑 → 停了」。 */
  const live = { running: true }
  const pushed = []
  const a = makeBody67(null, {
    sessions: { get: (id) => ({ header: { cwd: R } }), list: () => [{ id: 'sx', header: { cwd: R } }] },
    agents: { get: (id) => ({ status: live.running === true ? 'running' : 'idle' }) },
    liveHub: { sockets: new Set(), send: (text) => pushed.push(text) },
  })
  /* 面板上次开着时读进缓存的那份 graph（重开要命中的就是这一格）。 */
  const warm = await a.H('git/graph')({ sessionId: 'sx', maxCount: 200 })
  check('预热：graph 答一份提交（base）', warm.ok === true && warm.commits.length === 1 && subjectOf(warm, 0) === 'base')
  /* agent 提交，然后会话完成。没有页面在场：flush 不会来，签名轮询因 sockets 空
     一轮都不跑 —— 唯一能作废这份缓存的只剩宿主自己在完成那一拍的动作。 */
  await sh(`cd ${R} && printf 'b\\n' > b.txt && git add -A && git commit -qm second`, '/tmp')
  live.running = false
  let done = false
  for (let i = 0; i < 40 && done !== true; i += 1) {
    await new Promise((r) => setTimeout(r, 250))
    done = pushed.some((t) => String(t).indexOf('session-complete') >= 0)
  }
  check('完成推送发出去了（2 秒防抖后，sockets 空也照发）', done === true)
  const again = await a.H('git/graph')({ sessionId: 'sx', maxCount: 200 })
  check('重开面板重发的 git/graph 拿到新账（second 在列表里，不再是缓存的旧一份）',
    again.ok === true && again.commits.length === 2 && subjectOf(again, 0) === 'second')
}

console.log('')
console.log('=== 1｜页面在场：完成那一刷的两条 flush 与 graph 缓存键对得上 ===')
{
  const a = makeBody67(null, {
    sessions: { get: (id) => ({ header: { cwd: R } }), list: () => [{ id: 'sx', header: { cwd: R } }] },
  })
  const g1 = await a.H('git/graph')({ sessionId: 'sx', maxCount: 200 })
  check('预热：会话工作区就是仓库，graph 答到此刻为止的两份', g1.ok === true && g1.commits.length === 2 && subjectOf(g1, 0) === 'second')
  await sh(`cd ${R} && printf 'c\\n' > c.txt && git add -A && git commit -qm third`, '/tmp')
  await a.H('git/flush')({ sessionId: 'sx' })
  const g2 = await a.H('git/graph')({ sessionId: 'sx', maxCount: 200 })
  check('会话级 flush（不带 repo）单独就够：graph 变新账', g2.ok === true && g2.commits.length === 3 && subjectOf(g2, 0) === 'third')
  await sh(`cd ${R} && printf 'd\\n' > d.txt && git add -A && git commit -qm fourth`, '/tmp')
  await a.H('git/flush')({ sessionId: 'sx', repo: R })
  const g3 = await a.H('git/graph')({ sessionId: 'sx', maxCount: 200 })
  check('带 repo 的 flush 也对得上同一个前缀：graph 照样变新账', g3.ok === true && g3.commits.length === 4 && subjectOf(g3, 0) === 'fourth')
}

console.log('')
console.log('=== 2｜生效仓库是嵌套仓库：会话级 flush 动不了它，带 A 的那条才是命门 ===')
{
  const a = makeBody67(null, {
    sessions: { get: (id) => ({ header: { cwd: W } }), list: () => [{ id: 'sx', header: { cwd: W } }] },
  })
  const g1 = await a.H('git/graph')({ sessionId: 'sx', repo: A, maxCount: 200 })
  check('预热：面板正看着嵌套仓库 A，graph 答一份', g1.ok === true && g1.commits.length === 1 && subjectOf(g1, 0) === 'nested-base')
  await sh(`cd ${A} && printf 'm\\n' > m.txt && git add -A && git commit -qm nested-two`, '/tmp')
  /* 负对照：客户端完成那一刷若只发作废工作区 W 的两条（会话级 + chip 记的工作区），
     A 的 graph 一格不动 —— 这正是用户看到的旧列表。 */
  await a.H('git/flush')({ sessionId: 'sx' })
  await a.H('git/flush')({ sessionId: 'sx', repo: W })
  const stale = await a.H('git/graph')({ sessionId: 'sx', repo: A, maxCount: 200 })
  check('负对照：少了带 A 的 flush，重发的 git/graph 拿到的还是旧一份（stale）',
    stale.ok === true && stale.commits.length === 1 && subjectOf(stale, 0) === 'nested-base')
  await a.H('git/flush')({ sessionId: 'sx', repo: A })
  const fresh = await a.H('git/graph')({ sessionId: 'sx', repo: A, maxCount: 200 })
  check('带上生效仓库的 flush：graph 变新账（nested-two 在）',
    fresh.ok === true && fresh.commits.length === 2 && subjectOf(fresh, 0) === 'nested-two')
}

console.log('')
console.log('=== 3｜重开边界的 tags flush 不动 graph；flush 的 repo 必须与缓存键逐字节同形 ===')
{
  const a = makeBody67(null, {
    sessions: { get: (id) => ({ header: { cwd: R } }), list: () => [{ id: 'sx', header: { cwd: R } }] },
  })
  const g1 = await a.H('git/graph')({ sessionId: 'sx', maxCount: 200 })
  check('预热：graph 进缓存（到上一节为止共四份）', g1.ok === true && g1.commits.length === 4 && subjectOf(g1, 0) === 'fourth')
  await sh(`cd ${R} && printf 'e\\n' > e.txt && git add -A && git commit -qm fifth`, '/tmp')
  await a.H('git/flush')({ repo: R, tags: ['panel-ident', 'branches'] })
  const still = await a.H('git/graph')({ sessionId: 'sx', maxCount: 200 })
  check('重开面板只作废身份与分支两格：graph 原样是缓存的旧一份（历史的新旧只挂完成那一刷）',
    still.ok === true && still.commits.length === 4 && subjectOf(still, 0) === 'fourth')
  await a.H('git/flush')({ repo: R + '/' })
  const slashy = await a.H('git/graph')({ sessionId: 'sx', maxCount: 200 })
  check('尾斜杠的 repo 作废不了这一格（前缀逐字节匹配）：路径形状必须与请求同源',
    slashy.ok === true && slashy.commits.length === 4)
  await a.H('git/flush')({ repo: R })
  const fresh = await a.H('git/graph')({ sessionId: 'sx', maxCount: 200 })
  check('同形的 flush 照旧清整仓：graph 变新账（fifth 在）',
    fresh.ok === true && fresh.commits.length === 5 && subjectOf(fresh, 0) === 'fifth')
}

console.log('')
console.log('=== 0b｜无页面 + 生效仓库是嵌套仓库：配置里记的家底一起作废 ===')
{
  const live = { running: true }
  const pushed = []
  /* appliedRepos 记着「这个工作区的生效仓库是 A」——面板正看着的正是它。 */
  await sh(`mkdir -p ${HOME}/.dsh && printf '%s' '{}' > ${HOME}/.dsh/dsh-git-idea.json && node -e "
    const fs = require('fs'); const p = process.argv[1];
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    c.appliedRepos = { '${W}': '${A}' };
    fs.writeFileSync(p, JSON.stringify(c));" ${HOME}/.dsh/dsh-git-idea.json`, '/tmp')
  const a = makeBody67(null, {
    sessions: { get: (id) => ({ header: { cwd: W } }), list: () => [{ id: 'sx', header: { cwd: W } }] },
    agents: { get: (id) => ({ status: live.running === true ? 'running' : 'idle' }) },
    liveHub: { sockets: new Set(), send: (text) => pushed.push(text) },
  })
  const warm = await a.H('git/graph')({ sessionId: 'sx', repo: A, maxCount: 200 })
  check('预热：面板看着嵌套仓库 A，graph 进缓存（第 2 节后共两份）', warm.ok === true && warm.commits.length === 2 && subjectOf(warm, 0) === 'nested-two')
  await sh(`cd ${A} && printf 'z\\n' > z.txt && git add -A && git commit -qm nested-three`, '/tmp')
  live.running = false
  let done = false
  for (let i = 0; i < 40 && done !== true; i += 1) {
    await new Promise((r) => setTimeout(r, 250))
    done = pushed.some((t) => String(t).indexOf('session-complete') >= 0)
  }
  check('完成推送发出去了', done === true)
  const again = await a.H('git/graph')({ sessionId: 'sx', repo: A, maxCount: 200 })
  check('重开面板：嵌套仓库 A 的 graph 也是新账（作废清单跟着生效仓库账走）',
    again.ok === true && again.commits.length === 3 && subjectOf(again, 0) === 'nested-three')
  await sh(`printf '%s' '{}' > ${HOME}/.dsh/dsh-git-idea.json`, '/tmp')
}

if (failed > 0) {
  console.error('gp67-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
