#!/usr/bin/env node
/* gp83 — 分支会话历史（79c-branchhistory.js + 70-config.js 的三个新键）宿主半套件。
 *
 *   照 gp34d 的先例：读 dist/host.js（GP_FRESH 时读临时拼接的 src）、new Function
 *   注入 ctx/harness 桩、console.log ✓/✗ 计数。两个刻意不同：
 *   · 配置读写走真实 shell、落在 /tmp fixture 的真盘上 —— 「同值不落盘」与「登记
 *     一次定格」要拿 mtime 与字节对比才作数，内存桩给不出这个证据；
 *   · `git branch --show-current` 走桩（runShell 同款形状）：detached、git 失败、
 *     爆炸三种结局的 stdout / exitCode / 拒绝都由小节自己定，不在盘上摆真仓库。
 *   pre-step 监听用 ctx.on 桩把 handler 捕出来，直接喂 {agent,messages,step,next}
 *   模拟 —— 按会话 cwd+分支登记、开关注入、防重复、子代理跳过、失败放行，全在这一
 *   条入口上断。 */

import fs from 'node:fs'
import { spawn } from 'node:child_process'

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

/* ── fixture：配置在 /tmp 的真盘上，DSH_HOME 压到 fixture（gp34d 同款）── */
const HOME = '/tmp/gp83bh-home'
const DSH_DIR = HOME + '/.dsh'
const CONFIG_FILE = DSH_DIR + '/dsh-git-idea.json'
const WS = '/tmp/gp83bh-ws'
const WS2 = '/tmp/gp83bh-ws2'
const KIND = 'dsh-git-idea-branch-history'

function sh(cmd) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', cmd], {
      env: Object.assign({}, process.env, { DSH_HOME: DSH_DIR, HOME: HOME }),
    })
    let o = '', e = ''
    c.stdout.on('data', (b) => { o += b })
    c.stderr.on('data', (b) => { e += b })
    c.on('error', (er) => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', (x) => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}

/* ── branch --show-current 的桩：每个小节自己定 stdout / exitCode / 是否爆炸 ── */
const probeState = { code: 0, out: 'main\n', boom: false }
let probeCount = 0

function makeShellStub() {
  return function (spec) {
    /* argv 是逐个 shq 过的（`'branch' '--show-current'`），不能拿空格连写的串匹配；
     * --show-current 全插件只有分支探测这一处在用，拿它认路最稳。 */
    if (String(spec.command).indexOf('--show-current') >= 0) {
      probeCount += 1
      if (probeState.boom) return Promise.reject(new Error('gp83: 分支桩爆炸'))
      return Promise.resolve({ exitCode: probeState.code, stdout: { text: probeState.out }, stderr: { text: '' } })
    }
    return sh(spec.command)
  }
}

/* ── 一份新的宿主：重读盘上的配置、重挂 RPC 与 pre-step（70-config.js 的缓存是
 *    每份实例一份 —— 直接改盘后要重起一份才能读到，套件里就靠换份实例当「重启」） ── */
function makeRuntime(withOn) {
  const handlers = new Map()
  const onHandlers = new Map()
  const calls = { warn: 0, info: 0 }
  const consoleShim = new Proxy({}, {
    get(_t, key) {
      if (key === 'warn') return (...a) => { calls.warn += 1; return console.warn(...a) }
      if (key === 'info') return (...a) => { calls.info += 1; return console.info(...a) }
      const target = console[key]
      return typeof target === 'function' ? target.bind(console) : target
    },
  })
  const ctx = {
    get: (n) => (n === 'shell' ? { resolve: (r) => r, run: makeShellStub() } : undefined),
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
  }
  if (withOn) ctx.on = (name, fn) => { onHandlers.set(name, fn); return () => {} }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, consoleShim,
    (s) => Buffer.from(s, 'binary').toString('base64'),
    (s) => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder, TextDecoder,
  ).apply(ctx)
  return { handlers, onHandlers, calls }
}
const H = (rt, name) => rt.handlers.get(name)

/* ── 小工具 ── */
const guards = []
const check = (label, value) => {
  if (value !== true) guards.push(label)
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const seedConfig = (over) => {
  fs.mkdirSync(DSH_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(over == null ? {} : over))
}
const disk = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
const diskBytes = () => fs.readFileSync(CONFIG_FILE, 'utf8')
/* 把盘上文件的 mtime 拨回一分钟前：之后任何一次真写都会把 mtime 跳回「现在」，
 * 没跳就是没落盘 —— 比内容对比更硬的一条证据（内容同值写也看不出差别）。 */
const dialBackMtime = () => {
  const past = new Date(Date.now() - 60000)
  fs.utimesSync(CONFIG_FILE, past, past)
  return past.getTime()
}
const mtimeStill = (pastMs) => Math.abs(fs.statSync(CONFIG_FILE).mtimeMs - pastMs) < 5
/* 会话账一格：{id, at}，at 从 base 起每条错开一分钟（最新在前是登记处的规矩，
 * seed 自己摆好顺序）。 */
const acct = (ids, base) => ids.map((id, i) => ({ id: id, at: (base == null ? 1735689600000 : base) + i * 60000 }))
const stamp = (at) => {
  const d = new Date(at)
  const p2 = (n) => (n < 10 ? '0' + String(n) : String(n))
  return String(d.getFullYear()) + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
    + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
}

/* ── pre-step 模拟：agent / claimed 消息 / 决策都按会话层的最小形状手写 ── */
const claimedMsg = (id) => ({ id: id, role: 'user', content: [{ type: 'text', text: '消息 ' + id }] })
const injectionMsg = () => ({ id: 'inj-0', role: 'user', content: [], source: { kind: KIND } })
const agentOf = (sessionId, over) => ({
  session: Object.assign(
    { id: sessionId, header: { cwd: WS }, surface: { nodes: [] } },
    over == null ? {} : over),
})
const preStep = (rt, payload, decision) =>
  rt.onHandlers.get('agent/pre-step')(payload, async () => decision)

await sh('rm -rf ' + HOME + ' ' + WS + ' ' + WS2 + ' && mkdir -p ' + HOME + ' ' + WS + ' ' + WS2)

console.log('== 源码钉住：三条 RPC 与宿主监听都登记在 Host 半 ==')
check('git/branch-history-config / -switch / branch-prompt-save 三个 RPC 都在表里',
  body.indexOf("onRpc('git/branch-history-config'") >= 0
  && body.indexOf("onRpc('git/branch-history-switch'") >= 0
  && body.indexOf("onRpc('git/branch-prompt-save'") >= 0)
check('pre-step 监听与注册体都在（ctx.on("agent/pre-step" + registerBranchHistory）',
  body.indexOf("'agent/pre-step'") >= 0 && body.indexOf('registerBranchHistory(ctx)') >= 0)

console.log('')
console.log('== 归一化：三个新键的清洗（git/config-save 这道门）==')
let rt = makeRuntime(true)
{
  const dirty = await H(rt, 'git/config-save')({ config: {
    branchHistory: {
      defaultOn: 'yes', maxSessions: 2.5,
      workspaces: { [WS]: true, 'rel/path': false, [WS + '/x']: 'yes', [WS + '/y']: 1, ['  ' + WS2 + '  ']: false },
    },
    branchPrompts: {
      [WS]: { feat: '正文', blank: '   ', long: 'y'.repeat(5000), '': '空名', bad: 42 },
      noabs: { a: 'x' },
      [WS2]: { only: '   ' },
    },
    branchSessions: {
      [WS]: { main: [{ id: ' s1 ', at: 5 }, { id: '', at: 1 }, null, 42, 'str', { id: 's2' }, { id: 's3', at: 'x' }], bad: '不是数组' },
      nopath: { main: [{ id: 'z', at: 1 }] },
    },
  } })
  const bh = dirty.config.branchHistory
  check('脏配置整份收下，答复 ok', dirty.ok === true)
  check('branchHistory：defaultOn 非布尔回 false，maxSessions 非整数回 20，键全在',
    bh.defaultOn === false && bh.maxSessions === 20 && bh.workspaces != null)
  check('workspaces：布尔值留、非布尔丢、非绝对路径键丢',
    Object.keys(bh.workspaces).length === 2 && bh.workspaces[WS] === true)
  check('workspaces：键 trim 后收（同一目录两种写法同一个键）', bh.workspaces[WS2] === false)
  check('branchPrompts：空文本条目不收、只剩空白的工作区整个丢、非对象值的工作区丢',
    JSON.stringify(Object.keys(dirty.config.branchPrompts)) === JSON.stringify([WS]))
  check('branchPrompts：空名/空白/非字符串条目丢，正文原样留',
    JSON.stringify(Object.keys(dirty.config.branchPrompts[WS])) === JSON.stringify(['feat', 'long'])
    && dirty.config.branchPrompts[WS].feat === '正文')
  check('branchPrompts：超长的截到 4000', dirty.config.branchPrompts[WS].long === 'y'.repeat(4000))
  const bs = dirty.config.branchSessions
  check('branchSessions：坏条目丢（空 id / 非对象 / 字符串），trim 后的 id 留',
    JSON.stringify(bs[WS].main.map((o) => o.id)) === JSON.stringify(['s1', 's2', 's3']))
  check('branchSessions：at 读不出记 0，非数组的分支格丢、非绝对路径键丢',
    bs[WS].main[1].at === 0 && bs[WS].main[2].at === 0 && bs[WS].bad === undefined && bs.nopath === undefined)
}
{
  const set = async (branchHistory) => (await H(rt, 'git/config-save')({ config: { branchHistory: branchHistory } })).config.branchHistory
  const edge1 = await set({ maxSessions: 1 })
  const edge50 = await set({ maxSessions: 50 })
  check('maxSessions：边界 1 与 50 收下', edge1.maxSessions === 1 && edge50.maxSessions === 50)
  const bads = await Promise.all(
    [set({ maxSessions: 0 }), set({ maxSessions: 51 }), set({ maxSessions: -3 }), set({ maxSessions: '5' })])
  check('maxSessions：0 / 51 / 负数 / 字符串一律回 20', bads.every((v) => v.maxSessions === 20))
  const many = {}
  for (let i = 0; i < 130; i += 1) many['/tmp/gp83bh-w' + i] = true
  const wsCapped = await set({ workspaces: many })
  check('workspaces 封顶 128：130 个只留 128 个', Object.keys(wsCapped.workspaces).length === 128)
  const manyBranches = {}
  for (let i = 0; i < 70; i += 1) manyBranches['b' + i] = '第' + i + '条'
  const capped = (await H(rt, 'git/config-save')({ config: { branchPrompts: { [WS]: manyBranches } } })).config.branchPrompts
  check('branchPrompts 每工作区封顶 64：70 个分支只留 64 个',
    Object.keys(capped[WS]).length === 64 && capped[WS].b0 === '第0条')
  const manySessions = {}
  for (let i = 0; i < 205; i += 1) manySessions['e' + String(i).padStart(3, '0')] = acct(['x' + i])[0]
  const sessCapped = (await H(rt, 'git/config-save')({ config: { branchSessions: { [WS]: { main: Object.values(manySessions) } } } })).config.branchSessions
  check('branchSessions 每分支封顶 200：205 条裁到 200，裁的是尾部',
    sessCapped[WS].main.length === 200 && sessCapped[WS].main[0].id === 'x0' && sessCapped[WS].main[199].id === 'x199')
}

console.log('')
console.log('== git/branch-history-config 读：全局默认、显式值、effective 口径、prompts/counts 形状 ==')
probeState.code = 0
probeState.out = 'main\n'
seedConfig(null)
rt = makeRuntime(true)
{
  const snap = await H(rt, 'git/branch-history-config')({ sessionCwd: WS, sessionId: 's1' })
  check('空配置：默认档、on:null（跟随全局）、effective:false、branch 来自 git 桩',
    snap.ok === true && snap.workspace === WS && snap.defaultOn === false && snap.maxSessions === 20
    && snap.on === null && snap.effective === false && snap.branch === 'main')
  check('空配置：prompts 与 counts 都是对象，且都只答本工作区（此刻为空）',
    JSON.stringify(snap.prompts) === '{}' && JSON.stringify(snap.counts) === '{}')
  const nowhere = await H(rt, 'git/branch-history-config')({})
  check('拿不到工作区：workspace:null、on:null、branch 空串，且没去问 git',
    nowhere.workspace === null && nowhere.on === null && nowhere.effective === false
    && nowhere.branch === '' && probeCount === 1)
  seedConfig({
    branchHistory: { defaultOn: true, workspaces: { [WS]: false } },
    branchPrompts: { [WS]: { feat: 'P1' }, [WS2]: { dev: 'P2' } },
    branchSessions: {
      [WS]: { main: acct(['a1', 'a2']), dev: acct(['c1']) },
      [WS2]: { dev: acct(['d1', 'd2', 'd3']) },
    },
  })
  rt = makeRuntime(true)
  const wsRead = await H(rt, 'git/branch-history-config')({ sessionCwd: WS, sessionId: 's1' })
  check('工作区显式 false + defaultOn:true → on:false、effective:false（显式值压过全局）',
    wsRead.on === false && wsRead.effective === false)
  check('prompts/counts 只答本工作区那格：别的仓库的提示词与账不掺进来',
    JSON.stringify(wsRead.prompts) === JSON.stringify({ feat: 'P1' })
    && JSON.stringify(wsRead.counts) === JSON.stringify({ main: 2, dev: 1 }))
  const ws2Read = await H(rt, 'git/branch-history-config')({ sessionCwd: WS2, sessionId: 's1' })
  check('没设显式值的工作区：on:null、effective 落回 defaultOn:true',
    ws2Read.on === null && ws2Read.effective === true && ws2Read.counts.dev === 3)
  check('配置里的非布尔开关值归一化时已丢：读答复是 on:null 而不是编造的 false',
    (await H(rt, 'git/branch-history-config')({ sessionCwd: WS2, sessionId: 's1' })).on === null)
}
seedConfig({ branchHistory: { workspaces: { [WS]: true } } })
rt = makeRuntime(true)
{
  probeState.code = 0
  probeState.out = '\n'
  const detached = await H(rt, 'git/branch-history-config')({ sessionCwd: WS, sessionId: 's1' })
  check('detached HEAD（stdout 空）：branch 答空串，其余照常', detached.branch === '' && detached.ok === true)
  probeState.code = 127
  const noGit = await H(rt, 'git/branch-history-config')({ sessionCwd: WS, sessionId: 's1' })
  check('git 失败（非 0 退出）：同样 branch 空串，不是报错', noGit.branch === '' && noGit.ok === true)
}

console.log('')
console.log('== git/branch-history-switch 写：开/关/reset、同值不落盘 ==')
probeState.code = 0
probeState.out = 'main\n'
seedConfig(null)
rt = makeRuntime(true)
{
  const on1 = await H(rt, 'git/branch-history-switch')({ sessionCwd: WS, sessionId: 's1', on: true })
  check('开：答复 on:true、effective:true，盘上 workspaces 里就是它',
    on1.ok === true && on1.on === true && on1.effective === true && on1.workspace === WS
    && disk().branchHistory.workspaces[WS] === true)
  const on2 = await H(rt, 'git/branch-history-switch')({ sessionCwd: WS, sessionId: 's1', on: false })
  check('关：on:false、effective:false，盘上跟着改',
    on2.ok === true && on2.on === false && on2.effective === false
    && disk().branchHistory.workspaces[WS] === false)
  const past = dialBackMtime()
  const bytes = diskBytes()
  const same = await H(rt, 'git/branch-history-switch')({ sessionCwd: WS, sessionId: 's1', on: false })
  check('同值再写一次：答复照常 ok，但 mtime 没动 —— 同值不落盘（重申式点击不碰盘）',
    same.ok === true && same.on === false && mtimeStill(past) && diskBytes() === bytes)
  const bad = await H(rt, 'git/branch-history-switch')({ sessionCwd: WS, sessionId: 's1', on: 'yes' })
  check('on 不是布尔：bad-value 直说，盘上一个字节没动',
    bad.ok === false && bad.error === 'bad-value' && diskBytes() === bytes)
  check('没设过的工作区 reset：ok、on:null（本来就跟随全局）、不落盘',
    (await H(rt, 'git/branch-history-switch')({ sessionCwd: WS2, sessionId: 's1', reset: true })).ok === true
    && (await H(rt, 'git/branch-history-switch')({ sessionCwd: WS2, sessionId: 's1', reset: true })).on === null
    && diskBytes() === bytes)
  const off1 = await H(rt, 'git/branch-history-switch')({ sessionCwd: WS2, sessionId: 's1', on: false })
  const reset = await H(rt, 'git/branch-history-switch')({ sessionCwd: WS2, sessionId: 's1', reset: true })
  check('设过再 reset：格子删掉回跟随全局，别的工作区的格子原样留着',
    off1.on === false && reset.ok === true && reset.on === null && reset.workspace === WS2
    && disk().branchHistory.workspaces[WS2] === undefined
    && disk().branchHistory.workspaces[WS] === false)
  const nopath = await H(rt, 'git/branch-history-switch')({ on: true })
  check('拿不到工作区：no-path 直说', nopath.ok === false && nopath.error === 'no-path')
}
seedConfig({ branchHistory: { defaultOn: true } })
rt = makeRuntime(true)
{
  await H(rt, 'git/branch-history-switch')({ sessionCwd: WS, sessionId: 's1', on: true })
  const reset = await H(rt, 'git/branch-history-switch')({ sessionCwd: WS, sessionId: 's1', reset: true })
  check('defaultOn:true 时 reset：答复 effective:true —— 跟随的全局默认是开的',
    reset.ok === true && reset.on === null && reset.effective === true)
}

console.log('')
console.log('== git/branch-prompt-save 写：保存/空文本删除/超长拒绝/答复形状 ==')
probeState.code = 0
probeState.out = 'main\n'
seedConfig({ branchSessions: { [WS]: { main: acct(['a1', 'a2', 'a3']), feat: acct(['f1']) } } })
rt = makeRuntime(true)
{
  const save = await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: 'feat', text: '这个分支先跑测试再提交' })
  check('保存：答复 ok、prompts 就是本工作区那格、counts 照账报条数',
    save.ok === true && save.branch === 'feat' && save.workspace === WS
    && JSON.stringify(save.prompts) === JSON.stringify({ feat: '这个分支先跑测试再提交' })
    && JSON.stringify(save.counts) === JSON.stringify({ main: 3, feat: 1 })
    && disk().branchPrompts[WS].feat === '这个分支先跑测试再提交')
  const trim = await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: '  feat  ', text: '改名前后的同一条' })
  check('分支名 trim 后落键（同一分支两种写法同一条提示词）',
    trim.ok === true && trim.branch === 'feat' && trim.prompts.feat === '改名前后的同一条')
  const dev = await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: 'dev', text: 'dev 分支的提示词' })
  const clear = await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: 'feat', text: '   ' })
  check('空文本 = 删除该分支条目（「清空了输入框」也是一条答案），别的分支不受影响',
    dev.ok === true && clear.ok === true && clear.prompts.feat === undefined
    && clear.prompts.dev === 'dev 分支的提示词' && disk().branchPrompts[WS].dev === 'dev 分支的提示词')
  const last = await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: 'dev', text: '最后一条' })
  const gone = await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: 'dev', text: '' })
  check('最后一个分支也删空：整个工作区的键从配置里消失',
    last.ok === true && gone.ok === true && JSON.stringify(disk().branchPrompts) === '{}')
  const tolong = await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: 'feat', text: 'y'.repeat(4001) })
  check('4001 字符：bad-value 拒收（RPC 层拒绝，不是悄悄截断）',
    tolong.ok === false && tolong.error === 'bad-value')
  const edge = await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: 'feat', text: 'y'.repeat(4000) })
  check('恰好 4000 字符收下，一个不少', edge.ok === true && edge.prompts.feat.length === 4000)
  check('分支名空 / 超 200 字符：bad-value',
    (await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: '   ', text: 'x' })).ok === false
    && (await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: 'b'.repeat(201), text: 'x' })).ok === false)
  const nopath = await H(rt, 'git/branch-prompt-save')({ branch: 'feat', text: 'x' })
  check('拿不到工作区：no-path，prompts/counts 给空对象形状',
    nopath.ok === false && nopath.error === 'no-path' && JSON.stringify(nopath.prompts) === '{}' && JSON.stringify(nopath.counts) === '{}')
}
seedConfig({ branchPrompts: { [WS]: Object.fromEntries(Array.from({ length: 64 }, (_v, i) => ['b' + i, '第' + i + '条'])) } })
rt = makeRuntime(true)
{
  const full = await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: '新分支', text: '挤不进来' })
  check('64 个分支已满：新分支直说存不下，已有 64 条原样', full.ok === false && full.error === 'too many branch prompts'
    && Object.keys(full.prompts).length === 64)
  const update = await H(rt, 'git/branch-prompt-save')({ sessionCwd: WS, sessionId: 's1', branch: 'b0', text: '更新后的第0条' })
  check('满员时更新已有分支照常', update.ok === true && update.prompts.b0 === '更新后的第0条')
}

console.log('')
console.log('== 注入文本：默认模板、专用提示词替换、maxSessions 上限 ==')
probeState.code = 0
probeState.out = 'main\n'
const BASE = 1735689600000
seedConfig({
  branchHistory: { workspaces: { [WS]: true } },
  branchSessions: { [WS]: { main: acct(['s1', 's2', 's3', 's4', 's5'], BASE) } },
})
rt = makeRuntime(true)
{
  const c1 = claimedMsg('c1')
  const c2 = claimedMsg('c2')
  const extra = { id: 'asst-1', role: 'assistant', content: [] }
  const decision = { kind: 'continue', messages: [c1, c2, extra] }
  const result = await preStep(rt, { agent: agentOf('cur'), messages: [c1, c2], step: 1 }, decision)
  const injected = result.messages[2]
  check('开关打开：注入消息插在最后一条 claimed 之后（extra 之前），decision 是新对象',
    result !== decision && result.messages.length === 4 && result.messages[0] === c1
    && result.messages[1] === c2 && result.messages[3] === extra)
  check('注入消息形状：role user、source 三件套（kind/workspace/branch）、整体冻结',
    injected.role === 'user' && injected.source.kind === KIND && injected.source.workspace === WS
    && injected.source.branch === 'main' && Object.isFrozen(injected) && Object.isFrozen(injected.source)
    && Object.isFrozen(injected.content))
  const text = injected.content[0].text
  const listText = ['s1', 's2', 's3', 's4', 's5'].map((id, i) => String(i + 1) + '. ' + id + ' · ' + stamp(BASE + i * 60000)).join('\n')
  const expected = '[dsh-git-idea · 分支会话历史]\n'
    + '仓库 gp83bh-ws 的分支「main」下的历史会话（本插件按分支自动记录，最近优先，最多 20 条）：\n'
    + listText + '\n'
    + '用途：这些 id 用于定位本分支往来的历史对话；需要回顾先前结论时，可按会话 id'
    + '到 DSH 会话记录目录查找对应内容。本条为自动附加的上下文说明，无需回应。'
  check('默认模板逐字对上：来源标注、仓库名、分支名、编号清单、无需回应的收尾', text === expected)
  check('清单排除当前会话自己（cur 已登记进账，但不在注入里）',
    text.indexOf('cur') < 0 && disk().branchSessions[WS].main[0].id === 'cur')
  check('注入成功的 info 日志有一条', rt.calls.info >= 1)
}
seedConfig({
  branchHistory: { workspaces: { [WS]: true }, maxSessions: 3 },
  branchSessions: { [WS]: { main: acct(['jia', 'yi', 'bing', 'ding', 'wu'], BASE) } },
})
rt = makeRuntime(true)
{
  /* 同一条消息必须是同一个对象：插入锚点靠引用相等认「claimed」。 */
  const only = claimedMsg('c1')
  const result = await preStep(rt, { agent: agentOf('cur'), messages: [only], step: 1 },
    { kind: 'continue', messages: [only] })
  const text = result.messages[1].content[0].text
  check('maxSessions:3 → 清单只取最近 3 条，第 4 条起不出现',
    text.indexOf('1. jia · ') >= 0 && text.indexOf('3. bing · ') >= 0
    && text.indexOf('4. ') < 0 && text.indexOf('ding') < 0)
}
seedConfig({
  branchHistory: { workspaces: { [WS]: true } },
  branchPrompts: { [WS]: { main: '这个分支只做热修，别动公共代码。' } },
  branchSessions: { [WS]: { main: acct(['s1', 's2'], BASE) } },
})
rt = makeRuntime(true)
{
  const only = claimedMsg('c1')
  const result = await preStep(rt, { agent: agentOf('cur'), messages: [only], step: 1 },
    { kind: 'continue', messages: [only] })
  const text = result.messages[1].content[0].text
  const listText = '1. s1 · ' + stamp(BASE) + '\n2. s2 · ' + stamp(BASE + 60000)
  check('专用提示词整段替换正文，后接同一份 id 清单，默认模板的措辞不再出现',
    text === '[dsh-git-idea · 分支会话历史]\n这个分支只做热修，别动公共代码。\n本分支历史会话 id：\n' + listText
    && text.indexOf('无需回应') < 0 && text.indexOf('仓库 gp83bh-ws') < 0)
}
{
  const longIds = Array.from({ length: 50 }, (_v, i) => ('L' + String(i + 1).padStart(3, '0') + 'x'.repeat(196)))
  seedConfig({
    branchHistory: { workspaces: { [WS]: true }, maxSessions: 50 },
    branchPrompts: { [WS]: { main: '长'.repeat(4000) } },
    branchSessions: { [WS]: { main: acct(longIds, BASE) } },
  })
  rt = makeRuntime(true)
  const only = claimedMsg('c1')
  const result = await preStep(rt, { agent: agentOf('cur'), messages: [only], step: 1 },
    { kind: 'continue', messages: [only] })
  const text = result.messages[1].content[0].text
  check('可注入的极限形状（50 条 × 200 字符 id + 4000 字专用词）在 32768 预算内完整给出，不误截断',
    Buffer.byteLength(text, 'utf8') < 32768 && text.indexOf('（内容过长已截断）') < 0
    && text.indexOf('\n50. L050') >= 0)
  check('截断机构钉在源码上（32768 预算与截断尾注）',
    body.indexOf('32768') >= 0 && body.indexOf('（内容过长已截断）') >= 0)
}
seedConfig({ branchHistory: { workspaces: { [WS]: true } }, branchSessions: { [WS]: { main: acct(['cur'], BASE) } } })
rt = makeRuntime(true)
{
  const only = claimedMsg('c1')
  const decision = { kind: 'continue', messages: [only] }
  const result = await preStep(rt, { agent: agentOf('cur'), messages: [only], step: 1 }, decision)
  check('新会话首轮账里只有自己：排除后无历史可注，decision 原样放行',
    result === decision && result.messages.length === 1)
}

console.log('')
console.log('== pre-step 守卫：不动账、不问 git、原样放行 ==')
probeState.code = 0
probeState.out = 'main\n'
seedConfig(null)
rt = makeRuntime(true)
{
  const bytes = diskBytes()
  const decision = { kind: 'continue', messages: [claimedMsg('c1')] }
  const claim = claimedMsg('c1')
  /* 这一节断言「git 都没问」：桩计数只看增量（前面的节已经问过它好几轮了）。 */
  const probesBefore = probeCount
  const untouched = () => probeCount === probesBefore && diskBytes() === bytes
  let r = await preStep(rt, { agent: agentOf('cur'), messages: [claim], step: 2 }, decision)
  check('step !== 1：原样放行，不问 git、不登记', r === decision && untouched())
  r = await preStep(rt, { agent: agentOf('cur'), messages: [], step: 1 }, decision)
  check('本轮 messages 为空：原样放行，什么都没碰', r === decision && untouched())
  r = await preStep(rt, { agent: agentOf('cur', { header: null }), messages: [claim], step: 1 }, decision)
  check('会话头缺失：原样放行', r === decision && untouched())
  r = await preStep(rt, { agent: agentOf('cur', { header: { cwd: WS, origin: 'subagent' } }), messages: [claim], step: 1 }, decision)
  check('子代理（origin 标出来的）：不登记不注入，git 都没问', r === decision && untouched())
  r = await preStep(rt, { agent: agentOf('cur', { header: { cwd: WS, parentSession: 'p-1' } }), messages: [claim], step: 1 }, decision)
  check('fork 出来带着父会话的：同算子代理，跳过', r === decision && untouched())
  r = await preStep(rt, { agent: agentOf('cur', { header: { cwd: 'relative/path' } }), messages: [claim], step: 1 }, decision)
  check('cwd 不是绝对路径：跳过', r === decision && untouched())
  r = await preStep(rt, { agent: agentOf(undefined), messages: [claim], step: 1 }, decision)
  check('会话 id 拿不到：跳过', r === decision && untouched())
  const claimed = [claim, injectionMsg()]
  r = await preStep(rt, { agent: agentOf('cur'), messages: claimed, step: 1 }, { kind: 'continue', messages: claimed })
  check('防重复：本轮 claimed 里已有本 source.kind 的注入，跳过（fork 继承历史同款口径）',
    r.messages.length === 2 && untouched())
  const forkAgent = agentOf('cur', { surface: { nodes: ['n1'] }, eventAt: () => ({ type: 'user/message', data: { source: { kind: KIND } } }) })
  r = await preStep(rt, { agent: forkAgent, messages: [claim], step: 1 }, decision)
  check('防重复：surface 事件历史里已有注入也跳过', r === decision && untouched())
  probeState.out = '\n'
  r = await preStep(rt, { agent: agentOf('cur'), messages: [claim], step: 1 }, decision)
  check('detached（branch --show-current 空）：连账都不记 —— 没有分支概念时记到哪都是猜',
    r === decision && probeCount === probesBefore + 1 && disk().branchSessions === undefined)
  probeState.code = 1
  r = await preStep(rt, { agent: agentOf('cur'), messages: [claim], step: 1 }, decision)
  check('git 失败（非 0 退出）：同样放行不记', r === decision && probeCount === probesBefore + 2 && disk().branchSessions === undefined)
}

console.log('')
console.log('== pre-step 登记：无条件记、开关压注入、挪顶与裁尾 ==')
probeState.code = 0
probeState.out = 'main\n'
seedConfig(null)
rt = makeRuntime(true)
{
  const decision = { kind: 'continue', messages: [claimedMsg('c1')] }
  const r = await preStep(rt, { agent: agentOf('cur'), messages: [claimedMsg('c1')], step: 1 }, decision)
  const row = disk().branchSessions[WS].main[0]
  check('开关关着账照记（「记」是账，「注入」才是开关），decision 原样放行',
    r === decision && row.id === 'cur' && typeof row.at === 'number')
  const seeded = agentOf('cur2', { header: { cwd: WS + '/' } })
  await preStep(rt, { agent: seeded, messages: [claimedMsg('c1')], step: 1 }, decision)
  const keys = Object.keys(disk().branchSessions)
  check('登记键是 repoKeyOf 口径：尾部斜杠去掉，同一工作区同一格',
    keys.length === 1 && keys[0] === WS && disk().branchSessions[WS].main[0].id === 'cur2')
}
seedConfig({ branchSessions: { [WS]: { main: acct(['s1', 's2', 's3']) } } })
rt = makeRuntime(true)
{
  await preStep(rt, { agent: agentOf('snew'), messages: [claimedMsg('c1')], step: 1 },
    { kind: 'continue', messages: [claimedMsg('c1')] })
  const ids = disk().branchSessions[WS].main.map((o) => o.id)
  check('新会话登记到最前（最新优先）', JSON.stringify(ids) === JSON.stringify(['snew', 's1', 's2', 's3']))
}
seedConfig({ branchSessions: { [WS]: { main: [{ id: 'cur', at: 1000 }, { id: 's1', at: 2000 }] } } })
rt = makeRuntime(true)
{
  const bytes = diskBytes()
  const past = dialBackMtime()
  await preStep(rt, { agent: agentOf('cur'), messages: [claimedMsg('c1')], step: 1 },
    { kind: 'continue', messages: [claimedMsg('c1')] })
  const fresh = makeRuntime(true)
  const row = (await H(fresh, 'git/config')({})).config.branchSessions[WS].main[0]
  check('登记一次定格：已在账里不刷新 at、不挪顶、连盘都不碰',
    diskBytes() === bytes && mtimeStill(past) && row.id === 'cur' && row.at === 1000)
}
{
  const many = acct(Array.from({ length: 200 }, (_v, i) => 'e' + String(i).padStart(3, '0')), BASE)
  seedConfig({ branchSessions: { [WS]: { main: many } } })
  rt = makeRuntime(true)
  await preStep(rt, { agent: agentOf('snew'), messages: [claimedMsg('c1')], step: 1 },
    { kind: 'continue', messages: [claimedMsg('c1')] })
  const ids = disk().branchSessions[WS].main.map((o) => o.id)
  check('200 条裁尾：新会话进头部，最老的一条出尾', ids.length === 200 && ids[0] === 'snew' && ids[1] === 'e000' && ids[199] === 'e198')
}
seedConfig({ branchSessions: { [WS]: { main: [{ id: '', at: 1 }, null, { id: 'ok', at: 5 }, 'str', { id: 'ok2' }] } } })
rt = makeRuntime(true)
{
  await preStep(rt, { agent: agentOf('snew'), messages: [claimedMsg('c1')], step: 1 },
    { kind: 'continue', messages: [claimedMsg('c1')] })
  const ids = disk().branchSessions[WS].main.map((o) => o.id)
  check('账里的坏条目登记时顺手清掉（id 空的、非对象的）',
    JSON.stringify(ids) === JSON.stringify(['snew', 'ok', 'ok2']))
}

console.log('')
console.log('== pre-step 兜底：reject / 空决策 / 桩爆炸都不炸宿主 ==')
probeState.code = 0
probeState.out = 'main\n'
seedConfig({ branchHistory: { workspaces: { [WS]: true } }, branchSessions: { [WS]: { main: acct(['s1']) } } })
rt = makeRuntime(true)
{
  const reject = { kind: 'reject' }
  const r = await preStep(rt, { agent: agentOf('cur'), messages: [claimedMsg('c1')], step: 1 }, reject)
  check('decision 是 reject：登记照做，但绝不往 reject 里插消息',
    r === reject && r.messages === undefined && disk().branchSessions[WS].main[0].id === 'cur')
  const empty = { kind: 'continue', messages: [] }
  const r2 = await preStep(rt, { agent: agentOf('cur2'), messages: [claimedMsg('c1')], step: 1 }, empty)
  check('decision.messages 为空：原样放行（没有 inbox 兜底，下一轮带账重来）',
    r2 === empty && r2.messages.length === 0)
  const r3 = await preStep(rt, { agent: agentOf('cur3'), messages: [claimedMsg('c1')], step: 1 }, null)
  check('decision 为 null：原样返回 null，不炸', r3 === null)
  probeState.boom = true
  const decision = { kind: 'continue', messages: [claimedMsg('c1')] }
  const warnsBefore = rt.calls.warn
  const r4 = await preStep(rt, { agent: agentOf('cur4'), messages: [claimedMsg('c1')], step: 1 }, decision)
  check('分支桩爆炸（shell 层拒绝）：只 warn 一声，放行原决策，进程活着',
    r4 === decision && rt.calls.warn === warnsBefore + 1)
  probeState.boom = false
}

console.log('')
console.log('== bridge 老 ctx：没有 on 也安静不启用，RPC 照常 ==')
{
  seedConfig(null)
  const old = makeRuntime(false)
  const snap = await H(old, 'git/branch-history-config')({ sessionCwd: WS, sessionId: 's1' })
  check('老 ctx façade：三条 RPC 照常注册可用', snap.ok === true && snap.workspace === WS)
  check('老 ctx 没挂 pre-step 监听（守卫生效，没把监听注册炸出来）',
    old.onHandlers.size === 0)
}

console.log('')
if (guards.length > 0) {
  console.log('✗ ' + guards.length + ' 条不符合预期')
  for (const one of guards) console.log('  - ' + one)
  process.exit(1)
}
console.log('（gp83 全部通过）')
