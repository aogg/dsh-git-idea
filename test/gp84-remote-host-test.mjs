import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── ssh:// 远程工作区 + cmd 方言主机的宿主半侧（11-remote.js）──
 *
 * 真仓库摆在 /tmp/gp84-remote/D:/code/proj，扮演「远端那台 Windows 机器上的目录」；
 * ssh-workspace 的接管面是假的（shell 服务上挂 RemoteShellRouter 同款 Symbol），
 * 但通道语义是真的：
 *   - openChannel 按收到的命令形状分派 —— 探测类（%COMSPEC% 金丝雀、where、
 *     --version）按脚本化的远端答案回答；`cd /d "<win>" && "<bash>" -s` 的包裹
 *     命令则**真的**在本机 spawn 一个 `bash -s`（stdin 喂脚本原文，cwd 映射到
 *     假远端树）——面板读、conflict-save 的 stdin 写回，走的都是这条真路。
 *   - POSIX 方言与本地路径断言「原样透传」：shell.run 接住，openChannel 一次都
 *     不该被调。
 * 发现/拒绝矩阵：手填优先、where git 向上推、System32 的 WSL 存根按路径剔除、
 * pc-linux-gnu 的假 bash 按版本拒绝、失败答案缓存 60 秒、配置改动作废缓存。
 * 三方言判定与永久记录：测得 posix / 测得 cmd 按工作区落进配置 remoteTransports，
 * 新进程零方言探测（posix 记录永久有效；cmd 记录只复审 bash 一次）；记录里的
 * bash 探不通重探一次并覆写；兜底（没测出来）不落记录、照旧透传。
 * 会话只读（read-only）时远程命令拒绝且连判定都不做，口径与 ssh 插件的
 * mode-gate 一致。配置归一化里 ssh:// 键的存取（repos/appliedRepos/drafts/
 * remoteTransports）也在这一场。 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

const HOME = '/tmp/gp84-home'
const REMOTE_ROOT = '/tmp/gp84-remote'
/* 假远端把 D: 盘根安在 REMOTE_ROOT/D:/ —— 脚本文本里的 `D:/code/proj`（重写后的
 * 拼法）与 cd 的 `D:\code\proj` 映射到同一棵真目录，等于 MSYS 的盘符路径层。 */
const R = REMOTE_ROOT + '/D:/code/proj'
const R_OTHER = REMOTE_ROOT + '/D:/code/other'
const WIN_PROJ = 'D:\\code\\proj'
const SSH_PROJ = 'ssh://win/' + 'D:/code/proj'
const SSH_POSIX_R = 'ssh://posix/tmp/gp84-posix'
const POSIX_R = '/tmp/gp84-posix'
const SSH_FB = 'ssh://fb/tmp/gp84-posix'
const GOOD_BASH = 'D:\\soft\\Git\\bin\\bash.exe'
const ROUTER_KEY = Symbol.for('dsh-ssh-workspace.shell-installed')

/* 假远端：把 Windows 拼法映射进本机的假远端树（盘符 → REMOTE_ROOT/<盘>:）。 */
function mapWin(winPath) {
  const match = /^([A-Za-z]):\\(.*)$/.exec(String(winPath))
  if (match === null) return String(winPath)
  return REMOTE_ROOT + '/' + match[1] + ':/' + match[2].split('\\').join('/')
}

/* 一条真的 `bash -s`：stdin 喂脚本原文（这就是通道该有的全部语义），stdout/stderr/
 * 退出码按 ssh2 通道的形状回。 */
function realBashRun(cwd, script, cb) {
  /* 假远端扮演 MSYS 的盘符路径层：脚本文本里 `X:/…` 的文件路径落到假远端树的
   * REMOTE_ROOT/X:/… 下（真的 Git for Windows bash 里这层由 cygwin 运行时做）。 */
  const translated = script.replace(/([A-Za-z]):\//g, REMOTE_ROOT + '/$1:/')
  const c = spawn('bash', ['-s'], { cwd: cwd, env: Object.assign({}, process.env, {
    DSH_HOME: HOME + '/.dsh', HOME: HOME,
    GIT_CONFIG_GLOBAL: HOME + '/.gitconfig', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  }) })
  let o = '', e = ''
  c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
  c.on('error', er => cb({ out: o, err: String(er.message), code: 127 }))
  c.on('close', x => cb({ out: o, err: e, code: x }))
  c.stdin.end(translated)
}

function makeEngine(options) {
  const calls = { channels: [], probes: [], wraps: [], dialectCalls: 0, releaseCalls: 0 }
  const engine = {
    calls: calls,
    remoteDialect: typeof options.remoteDialect === 'function'
      ? function (alias) { calls.dialectCalls += 1; return options.remoteDialect(alias) }
      : undefined,
    openChannel: function (alias, command) {
      calls.channels.push(command)
      const listeners = {}
      const fire = function (ev, arg) { const list = listeners[ev] || []; for (let i = 0; i < list.length; i += 1) list[i](arg) }
      const settle = function (result) {
        setTimeout(function () {
          fire('data', Buffer.from(result.out, 'utf8'))
          fire('stderr:data', Buffer.from(result.err, 'utf8'))
          fire('exit', result.code)
          fire('close')
        }, 5)
      }
      /* 命令形状 → 远端答案。探测与金丝雀脚本化回答；包裹命令走真 bash。 */
      let run
      if (command === 'echo %COMSPEC%') {
        run = function (data, cb) {
          cb({ out: options.comspec === undefined ? 'C:\\Windows\\System32\\cmd.exe' : options.comspec, err: '', code: 0 })
        }
      } else if (command === 'where git' || command === 'where bash') {
        const said = command === 'where git' ? options.whereGit : options.whereBash
        run = function (data, cb) { cb({ out: said === undefined ? '' : said, err: '', code: said === undefined ? 1 : 0 }) }
      } else if (/^"[^"]+" --version$/.test(command) === true) {
        const exe = command.slice(1, command.length - ' --version'.length - 1)
        run = function (data, cb) {
          calls.probes.push(exe)
          const said = options.versions !== undefined && exe in options.versions ? options.versions[exe] : 'GNU bash, version 5.3.15(1)-release (x86_64-pc-cygwin)\nCopyright (C) 2025 Free Software Foundation, Inc.'
          if (said === null) cb({ out: '', err: 'no such file', code: 1 })
          else cb({ out: said, err: '', code: 0 })
        }
      } else if (command.indexOf('cd /d "') === 0) {
        const match = /^cd \/d "([^"]+)" && "([^"]+)" -s$/.exec(command)
        run = function (data, cb) {
          if (match === null) { cb({ out: '', err: 'unparseable wrap: ' + command, code: 1 }); return }
          calls.wraps.push({ cwd: match[1], bash: match[2], script: data })
          const mapped = mapWin(match[1])
          if (!fs.existsSync(mapped)) { cb({ out: '', err: 'fake remote dir missing: ' + mapped, code: 1 }); return }
          realBashRun(mapped, data, cb)
        }
      } else {
        run = function (data, cb) { cb({ out: '', err: 'unexpected command: ' + command, code: 1 }) }
      }
      const channel = {
        on: function (ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return channel },
        stderr: { on: function (ev, cb) { (listeners['stderr:' + ev] = listeners['stderr:' + ev] || []).push(cb) } },
        signal: function () {},
        close: function () {},
        end: function (data) { run(Buffer.from(data).toString('utf8'), settle) },
      }
      return Promise.resolve({ channel: channel, record: {}, release: function () { calls.releaseCalls += 1 } })
    },
  }
  return engine
}

function makeBody(engine, extra) {
  const shellEnv = Object.assign({}, process.env, {
    DSH_HOME: HOME + '/.dsh', HOME: HOME,
    GIT_CONFIG_GLOBAL: HOME + '/.gitconfig', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  })
  let localRuns = 0
  function runShell(spec) {
    return new Promise((res) => {
      /* 假 shell 层：ssh:// 远端拼法摘掉 `ssh://<alias>` 前缀映射回本机
         （ssh://posix/tmp/x 与 ssh://fb/tmp/x 都落到 /tmp/x），本地路径原样 ——
         这正是 patch-shell 对 POSIX 远端的透传语义（与本插件 POSIX passthrough
         的命令文本换写是配套的两半）。 */
      let cwd = spec.workdir
      if (typeof cwd === 'string' && cwd.indexOf('ssh://') === 0) cwd = cwd.replace(/^ssh:\/\/[^/]+/, '')
      localRuns += 1
      const c = spawn('sh', ['-c', spec.command], { cwd: cwd, env: shellEnv })
      let o = '', e = ''
      c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
      c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
      c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
    })
  }
  const handlers = new Map()
  const services = Object.assign({
    shell: Object.assign({ resolve: r => r, run: runShell, runs: () => localRuns }, { [ROUTER_KEY]: { engine: engine } }),
    sessions: { get: () => ({ header: { cwd: SSH_PROJ } }) },
  }, extra || {})
  const ctx = { get: n => services[n], effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return { H: n => handlers.get(n), runs: () => localRuns }
}

function sh(cmd, cwd) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', cmd], { cwd, env: Object.assign({}, process.env, {
      DSH_HOME: HOME + '/.dsh', HOME: HOME,
      GIT_CONFIG_GLOBAL: HOME + '/.gitconfig', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
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
/* 各节的 body 各自为政：判定记录落在共享的配置文件里（进程内 configCache 是每
   个 body 一份，文件却只有一份），上一节留下的记录会替下一节“免探测”——需要
   「首次判定」的断言前先清一次。 */
async function resetConfig() {
  await sh('rm -rf ' + HOME + '/.dsh && mkdir -p ' + HOME + '/.dsh', '/tmp')
}

/* fixture：假远端树里一个真仓库（两个提交 + 一条未提交改动），本机树里一个 POSIX
   远端的真仓库；「远端家目录」铺一个 68 字节 .git 文件的 worktree 情形不需要 ——
   .git 文件在远端 bash 看来与本地无异（-e 判定），已有套件盖着。 */
await sh(`rm -rf ${HOME} ${REMOTE_ROOT} ${POSIX_R} && mkdir -p ${HOME} ${R} ${R_OTHER} ${POSIX_R}
cd ${R} && git init -q -b main && git config user.name T && git config user.email t@t
echo a1 > f1.txt && git add -A && git commit -qm c1 && echo a2 > f2.txt && git add -A && git commit -qm c2
echo dirty > f1.txt
cd ${R_OTHER} && git init -q -b main && git config user.name T && git config user.email t@t
echo o1 > of.txt && git add -A && git commit -qm o1
cd ${POSIX_R} && git init -q -b main && git config user.name T && git config user.email t@t
echo p1 > pf.txt && git add -A && git commit -qm p1`, '/tmp')

console.log('')
console.log('=== transport 的选择：本地与 POSIX 远端透传，cmd 远端走通道 ===')
{
  /* 本地会话：会话 cwd 与读的都是本机路径 —— 通道与方言一次都不该被问。 */
  const engine = makeEngine({ remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n' })
  const a = makeBody(engine, { sessions: { get: () => ({ header: { cwd: POSIX_R } }) } })
  const localRead = await a.H('git/panel')({ sessionId: 's-1', repo: POSIX_R })
  check('本地路径照旧走 shell 层（openChannel 一次都没被调）',
    localRead.ok === true && engine.calls.channels.length === 0 && engine.calls.dialectCalls === 0 && a.runs() > 0)
  check('本地读拿到真仓库的答案（分支）',
    localRead.ok === true && localRead.branch === 'main')

  /* POSIX 远端会话：透传 shell 层（假 shell 层把 ssh://posix 映射回本机执行）。 */
  const posixEngine = makeEngine({ remoteDialect: () => 'posix' })
  const b = makeBody(posixEngine, { sessions: { get: () => ({ header: { cwd: SSH_POSIX_R } }) } })
  const posixRead = await b.H('git/panel')({ sessionId: 's-2', repo: SSH_POSIX_R })
  check('POSIX 远端照旧透传 shell 层（脚本一字节不改，openChannel 不参与）',
    posixRead.ok === true && posixEngine.calls.channels.length === 0 && posixRead.branch === 'main'
    && posixEngine.calls.dialectCalls >= 1)

  /* 新进程（重新求值 body）：posix 记录永久有效 —— 方言一次都不再问，照旧透传。 */
  const posixEngine2 = makeEngine({ remoteDialect: () => 'posix' })
  const b2 = makeBody(posixEngine2, { sessions: { get: () => ({ header: { cwd: SSH_POSIX_R } }) } })
  const posixRead2 = await b2.H('git/panel')({ sessionId: 's-2', repo: SSH_POSIX_R })
  check('新进程读 posix 记录的工作区：方言零探测、照旧透传（记录永久有效不再探）',
    posixRead2.ok === true && posixEngine2.calls.dialectCalls === 0
    && posixEngine2.calls.channels.length === 0 && posixRead2.branch === 'main')
  const posixSnap2 = await b2.H('git/remote-transport')({ sessionId: 's-2' })
  const posixStored = await b2.H('git/config')({ sessionId: 's-2' })
  check('快照说清结论来自记录：origin=record、recordedAt 就是配置里的落账时刻',
    posixSnap2.ok === true && posixSnap2.origin === 'record' && posixSnap2.measured === true
    && posixSnap2.recordedAt > 0
    && posixStored.ok === true && posixStored.config.remoteTransports != null
    && posixStored.config.remoteTransports[SSH_POSIX_R] != null
    && posixStored.config.remoteTransports[SSH_POSIX_R].at === posixSnap2.recordedAt)
}

console.log('')
console.log('=== cmd 远端：包裹命令形状与真读 ===')
{
  const engine = makeEngine({
    remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n',
    versions: { 'D:\\soft\\Git\\cmd\\bin\\bash.exe': null },
  })
  const a = makeBody(engine)
  const read = await a.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ })
  check('cmd 远端的整树读成功（真仓库、真通道）：分支与改动数都对',
    read.ok === true && read.branch === 'main')
  const wrap = engine.calls.wraps[engine.calls.wraps.length - 1]
  check('包裹命令是 `cd /d "<远端路径>" && "<bash>" -s`：路径换算成 Windows 反斜杠拼法',
    wrap !== undefined && wrap.cwd === WIN_PROJ && wrap.bash === GOOD_BASH)
  check('脚本里的 ssh://win/ 前缀整段摘成远端路径（stdin 数据不在此列），[ -e .git ] 才探得到',
    wrap.script.indexOf('ssh://win/') < 0 && wrap.script.indexOf(WIN_PROJ.split('\\').join('/')) >= 0
    && wrap.script.indexOf('[ -e ') >= 0)
  check('通道用完把连接占用还回去（release 成对出现）',
    engine.calls.releaseCalls > 0)
  /* 缓存生效：再读一次，发现/方言都不重探（channels 只增包裹命令，不再有 --version 探测）。 */
  const probesBefore = engine.calls.probes.length
  await a.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ })
  check('第二次读直接用缓存：bash 探测零次、方言零次',
    engine.calls.probes.length === probesBefore && engine.calls.dialectCalls === 1)
  /* 首次判定的结论按工作区落进部署配置（70-config.js 的 remoteTransports）。 */
  const stored = await a.H('git/config')({ sessionId: 's-1' })
  check('判定记录按工作区永久落账（dialect=cmd + 发现来的 bash）',
    stored.ok === true && stored.config.remoteTransports != null
    && stored.config.remoteTransports[SSH_PROJ] != null
    && stored.config.remoteTransports[SSH_PROJ].dialect === 'cmd'
    && stored.config.remoteTransports[SSH_PROJ].bash === GOOD_BASH)
  /* 新进程（重新求值 body）：cmd 记录直接当家 —— 方言不再问，只复审记录里的
     bash 一次（探得通就照记录办，不再自动发现）。 */
  const engine2 = makeEngine({
    remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n',
    versions: { 'D:\\soft\\Git\\cmd\\bin\\bash.exe': null },
  })
  const c = makeBody(engine2)
  const read2 = await c.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ })
  check('新进程读 cmd 记录的工作区：方言零探测、只复审记录里的 bash 一次，通道照常跑读',
    read2.ok === true && engine2.calls.dialectCalls === 0
    && engine2.calls.probes.length === 1 && engine2.calls.probes[0] === GOOD_BASH
    && engine2.calls.wraps.length > 0 && engine2.calls.wraps[0].bash === GOOD_BASH)
  /* 清除记录：配置里的条目删掉，下一读重新首次判定。 */
  const cleared = await a.H('git/remote-transport-clear')({ sessionId: 's-1' })
  const afterClear = await a.H('git/config')({ sessionId: 's-1' })
  check('git/remote-transport-clear 删掉记录，配置里不再有这个工作区',
    cleared.ok === true && cleared.cleared === true
    && (afterClear.config.remoteTransports == null || afterClear.config.remoteTransports[SSH_PROJ] === undefined))
}

console.log('')
console.log('=== bash 路径的发现：向上推、System32 拒绝、假 bash 版本拒绝 ===')
{
  const engine = makeEngine({
    remoteDialect: () => 'cmd',
    whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n',
    versions: { 'D:\\soft\\Git\\cmd\\bin\\bash.exe': null },
  })
  const a = makeBody(engine)
  const read = await a.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ })
  check('自动发现从 git.exe 所在目录向上推到同树 bin\\bash.exe 并用它跑读',
    read.ok === true && engine.calls.probes.indexOf('D:\\soft\\Git\\cmd\\bin\\bash.exe') >= 0
    && engine.calls.probes.indexOf(GOOD_BASH) >= 0)

  const remote = await a.H('git/remote-transport')({ sessionId: 's-1' })
  check('git/remote-transport 答出通道快照：cmd + 发现来的 bash',
    remote.ok === true && remote.remote === true && remote.alias === 'win'
    && remote.dialect === 'cmd' && remote.bash === GOOD_BASH && remote.source === 'discovered')

  /* WSL 存根：git 不在（推不出候选）→ where bash 只答 System32 → 按路径剔除，
     不发探测；没有任何可用候选 → 拒绝话里点名原因与出路。 */
  await resetConfig()
  const stubEngine = makeEngine({
    remoteDialect: () => 'cmd',
    whereGit: undefined, whereBash: 'C:\\Windows\\System32\\bash.exe\n',
    versions: {},
  })
  const b = makeBody(stubEngine)
  let stubError = null
  await b.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ }).then(null, function (error) { stubError = error })
  check('System32 的 bash.exe 按路径剔除，一次探测都不发',
    stubError !== null && stubEngine.calls.probes.length === 0)
  check('拒绝的话说清 reason（no-git-found / 跳过 WSL 存根）并指路手填',
    String(stubError && stubError.message).indexOf('win') >= 0
    && (String(stubError && stubError.message).indexOf('no-git-found') >= 0 || String(stubError && stubError.message).indexOf('WSL') >= 0))

  /* 伪装的 WSL bash（自报 pc-linux-gnu）：就算混进候选也被 --version 那一问挡下。 */
  await resetConfig()
  const linuxEngine = makeEngine({
    remoteDialect: () => 'cmd',
    whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n',
    versions: {
      'D:\\soft\\Git\\cmd\\bin\\bash.exe': null,
      [GOOD_BASH]: 'GNU bash, version 5.1.16(1)-release (x86_64-pc-linux-gnu)\n',
      'D:\\soft\\bin\\bash.exe': null,
      'D:\\bin\\bash.exe': null,
    },
  })
  const c = makeBody(linuxEngine)
  let linuxError = null
  await c.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ }).then(null, function (error) { linuxError = error })
  check('自报 pc-linux-gnu 的假 bash 被版本问挡下（试过候选后拒绝）',
    linuxError !== null && linuxEngine.calls.probes.indexOf(GOOD_BASH) >= 0
    && String(linuxError && linuxError.message).indexOf('no-bash-found') >= 0)
}

console.log('')
console.log('=== 手填优先与缓存作废 ===')
{
  const engine = makeEngine({
    remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n',
    versions: { 'D:\\soft\\Git\\cmd\\bin\\bash.exe': null },
  })
  await resetConfig()
  const a = makeBody(engine)
  /* 先让自动发现把缓存填上。 */
  const first = await a.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ })
  check('（铺垫）自动发现就绪，读成功', first.ok === true && engine.calls.probes.length > 0)
  const saved = await a.H('git/config-save')({ sessionId: 's-1', config: {
    initBranch: 'main', cherryPickRecord: false, gitPath: '', remoteBashPath: 'D:\\my\\own\\bash.exe',
    fetchPrune: true, pullRebase: false, pushSetUpstream: false, repos: {}, repoDirs: {},
    quickCommands: [], drafts: {}, worktreeMains: {}, appliedRepos: {}, worktreeDirMappings: [],
    branchHistory: { defaultOn: false, maxSessions: 20, workspaces: {} }, branchPrompts: {}, branchSessions: {},
  } })
  check('remoteBashPath 能存进配置（cmd 不认的字符被清掉留下原文）',
    saved.ok === true && saved.config.remoteBashPath === 'D:\\my\\own\\bash.exe')
  /* 面板整树读有按仓库的读缓存，第二次会一口命令都不跑 —— 换 paths 的部分读
     （另一个缓存键），逼它真的过一遍 transport。 */
  const wrapsBefore = engine.calls.wraps.length
  const after = await a.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ, paths: ['f2.txt'] })
  const afterWrap = engine.calls.wraps[engine.calls.wraps.length - 1]
  check('配置改动作废缓存：下一读改用手填的 bash',
    after.ok === true && engine.calls.wraps.length === wrapsBefore + 1
    && afterWrap !== undefined && afterWrap.bash === 'D:\\my\\own\\bash.exe')
  const snap = await a.H('git/remote-transport')({ sessionId: 's-1' })
  check('快照标出 source=config', snap.ok === true && snap.bash === 'D:\\my\\own\\bash.exe' && snap.source === 'config')
  /* 手填的探测失败也要说人话。 */
  const badEngine = makeEngine({
    remoteDialect: () => 'cmd',
    versions: { 'D:\\broken\\bash.exe': null },
  })
  await resetConfig()
  const c = makeBody(badEngine)
  await c.H('git/config-save')({ sessionId: 's-1', config: {
    initBranch: 'main', cherryPickRecord: false, gitPath: '', remoteBashPath: 'D:\\broken\\bash.exe',
    fetchPrune: true, pullRebase: false, pushSetUpstream: false, repos: {}, repoDirs: {},
    quickCommands: [], drafts: {}, worktreeMains: {}, appliedRepos: {}, worktreeDirMappings: [],
    branchHistory: { defaultOn: false, maxSessions: 20, workspaces: {} }, branchPrompts: {}, branchSessions: {},
  } })
  const badSnap = await c.H('git/remote-transport')({ sessionId: 's-1' })
  check('手填的 bash 探测不过：reason=configured-bash-missing，detail 说清现场',
    badSnap.ok === true && badSnap.remote === true && badSnap.bash === ''
    && badSnap.reason === 'configured-bash-missing' && String(badSnap.detail).indexOf('D:\\broken\\bash.exe') >= 0)
  let badError = null
  await c.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ }).then(null, function (error) { badError = error })
  check('读不再落成「不是仓库」：拒绝话带着同样的原因',
    badError !== null && String(badError.message).indexOf('configured-bash-missing') >= 0)
}

console.log('')
console.log('=== stdin 数据随行：conflict-save 的 cat > 写回（真冲突现场） ===')
{
  /* 在假远端仓库里铺一场真冲突：side 分支改 f1.txt，main 也改，merge 撞出 unmerged。 */
  await sh(`cd ${R} && git checkout -qb side main~1 && echo side > f1.txt && git add -A && git commit -qm side1
git checkout -q main && echo main > f1.txt && git add -A && git commit -qm main2 && git merge -q side || true
git ls-files -u | head -3`, '/tmp')
  const unmerged = await sh('git ls-files -u -- f1.txt', R)
  check('（铺垫）f1.txt 真的处于 unmerged', unmerged.out.trim().length > 0)
  const engine = makeEngine({ remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n' })
  const a = makeBody(engine)
  const saved = await a.H('git/conflict-save')({ sessionId: 's-1', repo: SSH_PROJ, path: 'f1.txt', content: 'resolved-by-通道\n' })
  check('conflict-save 经通道写回成功（stdin 过 cat >，内容一字节不差）',
    saved.ok === true && (await sh('cat ' + R + '/f1.txt', '/tmp')).out === 'resolved-by-通道\n')
  const staged = await sh('git status --porcelain -- f1.txt', R)
  check('写回后 git add 已把冲突标成已解决（状态是 M 不是 U）',
    staged.out.trim().indexOf('M ') === 0)
  await sh(`cd ${R} && git merge --abort 2>/dev/null || true; git checkout -q main`, '/tmp')
}

console.log('')
console.log('=== 会话只读：远程命令拒绝，口径与 mode-gate 一致 ===')
{
  const engine = makeEngine({ remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n' })
  const a = makeBody(engine, { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } })
  let roError = null
  await a.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ }).then(null, function (error) { roError = error })
  check('read-only 会话拒绝远程命令（判定与通道都不进），拒绝里说清怎么解锁',
    roError !== null && roError.sandboxDenied === true
    && String(roError.message).indexOf('read-only') >= 0
    && String(roError.message).indexOf('workspace-write') >= 0
    && engine.calls.channels.length === 0 && engine.calls.dialectCalls === 0)
  const unknownMode = makeBody(engine, { sandboxPolicy: { resolve: () => ({ mode: 'future-mode' }) } })
  let fmError = null
  await unknownMode.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ }).then(null, function (error) { fmError = error })
  check('认不得的模式从严拒绝（本地沙箱同款口径）',
    fmError !== null && fmError.sandboxDenied === true && String(fmError.message).indexOf('future-mode') >= 0)
}

console.log('')
console.log('=== 配置归一化：ssh:// 键照常存取，语义不变 ===')
{
  const engine = makeEngine({ remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n' })
  const a = makeBody(engine)
  const config = {
    initBranch: 'main', cherryPickRecord: false, gitPath: '', remoteBashPath: '',
    fetchPrune: true, pullRebase: false, pushSetUpstream: false,
    quickCommands: [], worktreeDirMappings: [],
    branchHistory: { defaultOn: false, maxSessions: 20, workspaces: {} }, branchPrompts: {}, branchSessions: {},
    repos: { [SSH_PROJ]: ['ssh://win/D:/code/proj', '/local/repo', 'relative/junk'] },
    appliedRepos: { [SSH_PROJ]: 'ssh://win/D:/code/proj', '/local/ws': '/local/repo' },
    drafts: { 'ssh://win/D:/code/proj': '远程仓库的草稿', '/local/repo': '本地草稿' },
    worktreeMains: { 'ssh://win/D:/code/wt': 'ssh://win/D:/code/proj' },
    remoteTransports: {
      [SSH_PROJ]: { dialect: 'cmd', bash: 'D:\\soft\\Git\\bin\\bash.exe', at: 1234 },
      'ssh://posix/tmp/gp84-posix': { dialect: 'posix', bash: '', at: 99 },
      'ssh://win/D:/broken': { dialect: 'cmd', bash: '', at: 7 },
      'relative/junk': { dialect: 'posix', bash: '', at: 1 },
      '/local/only': { dialect: 'posix', bash: '', at: 2 },
    },
  }
  const saved = await a.H('git/config-save')({ sessionId: 's-1', config: config })
  check('ssh:// 键与值原样落盘（不再被「必须以 / 开头」静默丢掉）',
    saved.ok === true && saved.config.repos[SSH_PROJ][0] === 'ssh://win/D:/code/proj'
    && saved.config.appliedRepos[SSH_PROJ] === 'ssh://win/D:/code/proj'
    && saved.config.drafts['ssh://win/D:/code/proj'] === '远程仓库的草稿'
    && saved.config.worktreeMains['ssh://win/D:/code/wt'] === 'ssh://win/D:/code/proj')
  check('本地路径键照旧，非路径键照旧拒（relative/junk 丢）',
    saved.config.repos[SSH_PROJ][1] === '/local/repo' && saved.config.repos[SSH_PROJ].length === 2
    && saved.config.drafts['/local/repo'] === '本地草稿')
  check('remoteTransports 归一化：cmd 记录带 bash 落账、posix 记录落账、没 bash 的 cmd 记录丢、非 ssh:// 键丢',
    saved.config.remoteTransports != null
    && saved.config.remoteTransports[SSH_PROJ] != null
    && saved.config.remoteTransports[SSH_PROJ].dialect === 'cmd'
    && saved.config.remoteTransports[SSH_PROJ].bash === 'D:\\soft\\Git\\bin\\bash.exe'
    && saved.config.remoteTransports['ssh://posix/tmp/gp84-posix'] != null
    && saved.config.remoteTransports['ssh://posix/tmp/gp84-posix'].dialect === 'posix'
    && saved.config.remoteTransports['ssh://win/D:/broken'] === undefined
    && saved.config.remoteTransports['relative/junk'] === undefined
    && saved.config.remoteTransports['/local/only'] === undefined)
  const readBack = await a.H('git/draft-read')({ sessionId: 's-1', repo: SSH_PROJ })
  check('draft-read 按远程仓库键答草稿', readBack.ok === true && readBack.message === '远程仓库的草稿')
  const applied = await a.H('git/repo-applied-save')({ sessionId: 's-1', repo: 'ssh://win/D:/code/other' })
  check('repo-applied-save 在远程工作区存得进（工作区键是 ssh:// 拼法）',
    applied.ok === true && (await a.H('git/repo-applied')({ sessionId: 's-1' })).repo === 'ssh://win/D:/code/other')
}

console.log('')
console.log('=== git/remote-transport 的其余答案 ===')
{
  const engine = makeEngine({ remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n' })
  const a = makeBody(engine, { sessions: { get: () => ({ header: { cwd: POSIX_R } }) } })
  const local = await a.H('git/remote-transport')({ sessionId: 's-9' })
  check('本地会话：remote=false（这一组只在远程会话里有答案）',
    local.ok === true && local.remote === false)
  await resetConfig()
  const posix = makeBody(makeEngine({ remoteDialect: () => 'posix' }), {
    sessions: { get: () => ({ header: { cwd: SSH_POSIX_R } }) },
  })
  const posixSnap = await posix.H('git/remote-transport')({ sessionId: 's-8' })
  check('POSIX 远端：测得的 posix 结论带着永久记录时刻',
    posixSnap.ok === true && posixSnap.remote === true && posixSnap.dialect === 'posix'
    && posixSnap.measured === true && posixSnap.origin === 'probe' && posixSnap.recordedAt > 0)
}

console.log('')
console.log('=== cmd 记录失效：bash 探不通，重探一次并覆写 ===')
{
  /* 铺垫：白纸（上一节清过配置）上首次判定一次，落 GOOD_BASH 记录。候选清单里
     cmd\bin 那个先冒出来，照前几节的口径把它置空，发现才落到 GOOD_BASH。 */
  const engine = makeEngine({
    remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n',
    versions: { 'D:\\soft\\Git\\cmd\\bin\\bash.exe': null },
  })
  const a = makeBody(engine)
  const first = await a.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ, paths: ['f2.txt'] })
  const setupStored = await a.H('git/config')({ sessionId: 's-1' })
  check('（铺垫）首次判定落 GOOD_BASH 记录，读成功',
    first.ok === true && first.branch === 'main' && engine.calls.dialectCalls === 1
    && engine.calls.probes.indexOf(GOOD_BASH) >= 0
    && setupStored.ok === true && setupStored.config.remoteTransports[SSH_PROJ] != null
    && setupStored.config.remoteTransports[SSH_PROJ].bash === GOOD_BASH)

  /* 新进程里 GOOD_BASH 探不通了（远端重装/搬走）：记录复审失败 → 重探一次
     （方言重问、候选重试）→ 新答案覆写记录。 */
  const engine2 = makeEngine({
    remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n',
    versions: { 'D:\\soft\\Git\\cmd\\bin\\bash.exe': null, [GOOD_BASH]: null },
  })
  const b = makeBody(engine2)
  const again = await b.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ, paths: ['f2.txt'] })
  const overwritten = await b.H('git/config')({ sessionId: 's-1' })
  check('记录里的 bash 探不通：重探一次（方言重问）并覆写成新发现的 bash',
    again.ok === true && engine2.calls.dialectCalls === 1
    && engine2.calls.probes.indexOf(GOOD_BASH) >= 0
    && overwritten.ok === true && overwritten.config.remoteTransports[SSH_PROJ] != null
    && overwritten.config.remoteTransports[SSH_PROJ].bash === 'D:\\soft\\bin\\bash.exe'
    && overwritten.config.remoteTransports[SSH_PROJ].dialect === 'cmd')
  const wrap2 = engine2.calls.wraps[engine2.calls.wraps.length - 1]
  check('覆写后的通道就用新 bash 跑', wrap2 !== undefined && wrap2.bash === 'D:\\soft\\bin\\bash.exe')
  /* 覆写过的记录在下一个进程里复审一次就照常当家。 */
  const engine3 = makeEngine({
    remoteDialect: () => 'cmd', whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n',
    versions: { 'D:\\soft\\Git\\cmd\\bin\\bash.exe': null, [GOOD_BASH]: null },
  })
  const c = makeBody(engine3)
  const third = await c.H('git/panel')({ sessionId: 's-1', repo: SSH_PROJ, paths: ['f2.txt'] })
  check('覆写后的记录被后续进程照常采用（复审一次、零方言）',
    third.ok === true && engine3.calls.dialectCalls === 0
    && engine3.calls.probes.length === 1 && engine3.calls.probes[0] === 'D:\\soft\\bin\\bash.exe')
}

console.log('')
console.log('=== 方言没测出来：按 POSIX 兜底透传，结论不算数、不落记录 ===')
{
  const fbEngine = makeEngine({
    remoteDialect: () => { throw new Error('探测通道断了') },
    whereGit: 'D:\\soft\\Git\\cmd\\git.exe\n',
  })
  /* 会话 cwd 就挂在这个工作区上（probeShell 用的是会话目录，不是被检的 repo），
     面板读才会为 SSH_FB 走 transport。 */
  const fb = makeBody(fbEngine, { sessions: { get: () => ({ header: { cwd: SSH_FB } }) } })
  const fbRead = await fb.H('git/panel')({ sessionId: 's-7', repo: SSH_FB, paths: ['pf.txt'] })
  check('兜底读照旧透传 shell 层（通道一次不开、方言问过一次）',
    fbRead.ok === true && fbRead.branch === 'main'
    && fbEngine.calls.channels.length === 0 && fbEngine.calls.dialectCalls === 1)
  const fbSnap = await fb.H('git/remote-transport')({ sessionId: 's-7' })
  check('兜底在快照里三态分明：posix-fallback / measured=false / origin=fallback',
    fbSnap.ok === true && fbSnap.remote === true && fbSnap.dialect === 'posix-fallback'
    && fbSnap.measured === false && fbSnap.origin === 'fallback')
  const fbStored = await fb.H('git/config')({ sessionId: 's-7' })
  check('兜底不落记录（它不是结论）：配置里没有这个工作区的条目',
    fbStored.ok === true
    && (fbStored.config.remoteTransports == null || fbStored.config.remoteTransports[SSH_FB] === undefined))
}

if (failed > 0) {
  console.error('gp84-remote-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
