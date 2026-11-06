/* ─────────────── ssh:// 远程工作区与 cmd 方言 ───────────────
 *
 * 会话工作区是 ssh:// 远程工作区（dsh-ssh-workspace 插件挂载）时，这个插件的每一条
 * git 命令都要过两层：shell 层把 ssh:// workdir 拆成 alias + remotePath、拼上一段
 * `cd '<remotePath>' && ` 前缀交给远端登录 shell。POSIX 主机（Linux/macOS）上这一段
 * 语法成立，脚本原样透传就是正确行为；Windows OpenSSH 主机的登录 shell 是 cmd.exe，
 * 单引号不是引号字符 —— `cd 'D:/…'` 连目录都进不去，POSIX 脚本必败（实测报
 * 「'p' 不是内部或外部命令」），面板于是把一台好好的仓库判成「不是 git 仓库」。
 *
 * 所以 transport 按「workdir 是否 ssh:// + 主机方言」选，方言三态：
 *   - 测得 posix（Linux/macOS）：脚本原样透传，零包装（现状即正确）；
 *   - 测得 cmd（Windows OpenSSH）：改走 Git Bash 通道 —— 命令改成
 *     `cd /d "<remotePath>" && "<bash路径>" -s`，POSIX 脚本原文连同 stdin 数据从
 *     stdin 喂进 bash（bash -s 把剩余 stdin 交给脚本里的 `cat`/`git apply -` 读，
 *     已实测余量数据不丢）。通道走 dsh-ssh-workspace 自己的 engine.openChannel
 *     （同一条池化 SSH 连接上的裸 exec 通道）：patch-shell 那半的自动 cd 前缀是
 *     POSIX 语法、在 cmd 主机上必死，绕开它而不是修它 —— 那是另一个插件，这里
 *     只读不动。
 *   - 没测出来按 posix 兜底：探测失败时照旧透传（现状即正确）。兜底不是结论，
 *     不落永久记录，进程内只缓存 60 秒、稍后重探。
 *
 * 三种结论的去向不同：测得的两样都**按工作区永久记录**进部署配置（70-config.js
 * 的 remoteTransports，键 = 工作区 ssh:// 路径）—— 每个远端工作区只在第一次需要
 * 时探测一次，之后直接读记录、不再探测；进程内的缓存降级为记录之外的一次兜底
 * （进程重启后复审记录的那几问）。cmd 记录只在 bash 还探得通时有效，探不通
 * （或配置页换了手填路径）就重探一次并覆写；posix 记录永久有效不再探。
 *
 * cmd 方言要的 bash 路径优先用配置页「远程 bash 路径」的手填值，空则 `where git`
 * 向上推同树 bin\bash.exe 自动发现，C:\Windows\System32\bash.exe（WSL 存根）明确
 * 拒绝，探测（--version 必须自报 pc-msys/pc-cygwin）通过才启用。发现失败的原因
 * 由 git/remote-transport 带到配置页，指引手填。 */

/* `ssh://<alias>/<绝对路径>` 的拆解 —— 与 dsh-ssh-workspace protocol.js 同一条正则：
 * alias 是 DNS 式标签、不含 `/`，所以按第一个 `/` 切开是无歧义的。不是 ssh:// 或
 * 缺远端绝对路径的，都算本地。 */
const SSH_REMOTE_RE = /^ssh:\/\/([^/]+)(\/.*)$/

function remotePartsOf(workdir) {
  if (!isStr(workdir)) return undefined
  const match = SSH_REMOTE_RE.exec(workdir)
  return match === null ? undefined : { alias: match[1], remotePath: match[2] }
}

/* dsh-ssh-workspace 在接管 ctx.shell 时留下的把柄（Symbol.for 注册，跨模块同键），
 * 挂着它的 RemoteShellRouter，router.engine 是池化 SSH 引擎。没有这个键（插件没装、
 * 没接管）就说明这个会话没有远端半 —— 一切照旧。 */
const REMOTE_ROUTER_KEY = typeof Symbol === 'function' ? Symbol.for('dsh-ssh-workspace.shell-installed') : undefined

let remoteRouterMissingLogged = false

function remoteRouter() {
  if (REMOTE_ROUTER_KEY === undefined || shell == null) return undefined
  const router = shell[REMOTE_ROUTER_KEY]
  if (router == null || typeof router !== 'object') return undefined
  const engine = router.engine
  if (engine == null || typeof engine !== 'object') return undefined
  if (typeof engine.openChannel !== 'function') {
    /* 老版本的 ssh 插件没有 openChannel：cmd 通道开不出来。说一次，然后照旧走
     * shell 层老路（现状），不把每一次读都刷成一条错误。 */
    if (remoteRouterMissingLogged !== true) {
      remoteRouterMissingLogged = true
      console.error('dsh-git-idea: ssh-workspace 引擎没有 openChannel()，cmd 方言的 Git Bash 通道不可用，命令照旧走 shell 层')
    }
    return undefined
  }
  return { engine: engine }
}

/* ── 方言：三态测量 ──
 *
 * 答案只有三样：测得 posix、测得 cmd、没测出来按 posix 兜底（state = 'posix' /
 * 'cmd' / 'posix-fallback'，measured 标出后一种）。首选 ssh 插件自己的
 * remoteDialect(alias)：它在池化连接的记录上按连接缓存、断线重连会重探，是最
 * 权威的一份。引擎没有这个 API 时退化为自己问一句金丝雀 `echo %COMSPEC%`：cmd
 * 把它展开成 cmd.exe 的 Windows 路径，POSIX shell 原样回显字面量 —— 两种方言
 * 的答案可区分（与 dsh-ssh-workspace engine.js 同一问法）。
 *
 * 本进程内按 alias 缓存，只为了别把同一台主机问出老茧（同一主机的几个工作区
 * 各自首次落记录之前共用这一问）：测得的答案缓存 300 秒（登录 shell 不会自己
 * 变），兜底只缓存 60 秒就过期重探 —— 连接刚断时的失败不该被判成永久事实，
 * 而且兜底本来就不落记录，这一问过一会儿还要重来。 */
const REMOTE_DIALECT_TTL = 300000
const REMOTE_DIALECT_FAIL_TTL = 60000
const REMOTE_WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/
const remoteDialectCache = new Map()

function remoteDialectStale(entry, now) {
  if (entry === undefined || !isStr(entry.state)) return true
  return now - entry.at > (entry.state === 'posix-fallback' ? REMOTE_DIALECT_FAIL_TTL : REMOTE_DIALECT_TTL)
}

async function measureRemoteDialect(alias) {
  const now = Date.now()
  const cached = remoteDialectCache.get(alias)
  if (remoteDialectStale(cached, now) !== true) return cached
  const router = remoteRouter()
  let answer
  if (router !== undefined && typeof router.engine.remoteDialect === 'function') {
    try {
      const said = await router.engine.remoteDialect(alias)
      answer = said === 'cmd' ? { state: 'cmd', measured: true } : { state: 'posix', measured: true }
    } catch (error) {
      console.error('dsh-git-idea: 主机 ' + alias + ' 的方言探测失败，按 POSIX 兜底（不落记录，稍后重探）', String(error))
      answer = { state: 'posix-fallback', measured: false, reason: 'dialect-unknown', detail: String(error) }
    }
  } else {
    try {
      const canary = await remoteChannelRun(router.engine, alias, 'echo %COMSPEC%', null, null, 15000)
      const value = canary.stdout.text.trim()
      if (canary.timedOut === true || canary.exitCode !== 0 || value === '') {
        answer = { state: 'posix-fallback', measured: false, reason: 'dialect-unknown', detail: '方言金丝雀没有跑成（' + (canary.timedOut === true ? '超时' : '退出码 ' + String(canary.exitCode)) + '）' }
      } else if (value.indexOf('%COMSPEC%') < 0 && REMOTE_WINDOWS_PATH_RE.test(value)) {
        answer = { state: 'cmd', measured: true }
      } else {
        answer = { state: 'posix', measured: true }
      }
    } catch (error) {
      console.error('dsh-git-idea: 主机 ' + alias + ' 的方言金丝雀没有跑成，按 POSIX 兜底（不落记录，稍后重探）', String(error))
      answer = { state: 'posix-fallback', measured: false, reason: 'dialect-unknown', detail: String(error) }
    }
  }
  remoteDialectCache.set(alias, Object.assign({ at: now }, answer))
  return answer
}

/* ── 远端 bash 路径 ──
 *
 * 配置页「远程 bash 路径」的手填值优先；空则自动发现：`where git`（必要时补一次
 * `where bash`）拿候选，沿 git.exe 所在目录向上每一级配一个 bin\bash.exe，System32
 * 的 WSL 存根按路径直接剔除，余下的逐个探测 —— `--version` 的首行必须是
 * 「GNU bash, version …」且自报 pc-msys/pc-cygwin（Git for Windows 的两个家族拼法；
 * WSL 存根自报 pc-linux-gnu，即使哪天混进候选也被这一问挡下）。探测通过才启用并
 * 缓存；失败的答案（含原因与现场）缓存 60 秒，配置页「再检查一次」可立即重探。 */

/* cmd 的命令行没有引号转义这回事，双引号里的 `%` 还会展开环境变量 —— 手填或发现的
 * bash 路径里这两样都拒收，控制字符与开头的 `-` 沿 cleanGitPath 的口径。 */
function cleanRemoteBashPath(value) {
  const clean = cleanGitPath(value)
  if (clean.length === 0) return ''
  if (clean.indexOf('"') >= 0 || clean.indexOf('%') >= 0) return ''
  return clean
}

/* C:\Windows\System32\bash.exe（或任何 <盘>:\Windows\System32\bash.exe 拼法）是 WSL
 * 的启动存根：跑起来的是 Linux bash，MSYS 一族的环境 git 都不在。按路径剔除之外，
 * 探测那一问（pc-msys/pc-cygwin）还在兜底。 */
function wslBashStubPath(value) {
  const lowered = String(value).replace(/\//g, '\\').toLowerCase()
  return lowered.indexOf('\\windows\\system32\\bash.exe', Math.max(0, lowered.length - 40)) >= 0
}

/* git.exe 的目录向上每一级都配一个 bin\bash.exe：D:\soft\Git\cmd\git.exe 推出
 * D:\soft\Git\bin\bash.exe（Git for Windows 的标准家），mingw64\bin 里装的也一样
 * 逐级试到盘根。候选有上限：一个怪 PATH 也试不出七级以外的惊喜。 */
function remoteBashCandidatesFromGit(gitPath) {
  const segments = String(gitPath).replace(/\//g, '\\').split('\\')
  const out = []
  for (let top = segments.length - 2; top >= 1 && out.length < 6; top -= 1) {
    out.push(segments.slice(0, top + 1).join('\\') + '\\bin\\bash.exe')
  }
  return out
}

async function remoteChannelRun(engine, alias, command, stdinText, cwdRemotePath, timeoutMs) {
  const opened = await engine.openChannel(alias, command, {})
  const channel = opened.channel
  return await new Promise(function (resolve) {
    const outChunks = []
    const errChunks = []
    let exitCode = null
    let settled = false
    let timedOut = false
    let failNote = ''
    let timer = null
    const toBuf = function (chunk) {
      if (Buffer.isBuffer(chunk)) return chunk
      return Buffer.from(String(chunk), 'utf8')
    }
    const finish = function () {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try { opened.release() } catch (error) { console.error('dsh-git-idea: 远程通道的连接占用没有还上', String(error)) }
      const out = Buffer.concat(outChunks)
      const err = Buffer.concat(errChunks)
      resolve({
        exitCode: exitCode,
        stdout: { text: out.toString('utf8') },
        stderr: { text: (failNote.length > 0 && err.length === 0 ? failNote + (err.length > 0 ? '\n' : '') : '') + err.toString('utf8') },
        timedOut: timedOut,
      })
    }
    /* 超时自己计时自己杀：引擎的 openChannel 不管预算，KILL 信号远端收得到，
     * close 兜住已经死掉的通道。 */
    timer = setTimeout(function () {
      timedOut = true
      try { channel.signal('KILL') } catch (error) { /* 通道已经没了 */ }
      try { channel.close() } catch (error) { /* 通道已经没了 */ }
    }, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120000)
    if (typeof timer.unref === 'function') timer.unref()
    channel.on('data', function (chunk) { outChunks.push(toBuf(chunk)) })
    if (channel.stderr != null && typeof channel.stderr.on === 'function') {
      channel.stderr.on('data', function (chunk) { errChunks.push(toBuf(chunk)) })
    }
    channel.on('exit', function (code) { exitCode = typeof code === 'number' ? code : null })
    channel.on('error', function (error) { failNote = String(error != null && error.message !== undefined ? error.message : error) })
    channel.on('close', function () { finish() })
    try {
      channel.end(Buffer.from(isStr(stdinText) ? stdinText : '', 'utf8'))
    } catch (error) {
      failNote = String(error != null && error.message !== undefined ? error.message : error)
      try { channel.close() } catch (error2) { /* 通道已经没了 */ }
    }
  })
}

/* 远端 absolute 路径 → cmd 认的 Windows 路径：/D:/code → D:\code（ssh://win/D:/…
 * 的存储拼法带一个 cmd 不认的前导斜杠）。与 dsh-ssh-workspace engine.js 的
 * windowsRemotePath 同一条规则，拷在这里是因为本插件只读那个仓库。 */
function remoteCmdPath(remotePath) {
  const slashed = String(remotePath).replace(/\//g, '\\')
  return /^[\\/][A-Za-z]:[\\/]/.test(slashed) ? slashed.slice(1) : slashed
}

function cmdQuoteWin(value) {
  return '"' + String(value) + '"'
}

/* ── bash 的解析与缓存 ── */
const REMOTE_BASH_FAIL_TTL = 60000
const remoteBashCache = new Map()

async function probeRemoteBash(engine, alias, bashPath) {
  const probe = await remoteChannelRun(engine, alias, cmdQuoteWin(bashPath) + ' --version', null, null, 10000)
  if (probe.timedOut === true) return { ok: false, detail: bashPath + '：探测超时（10 秒），远端没有响应' }
  const said = probe.stdout.text
  const firstLine = said.split('\n')[0].trim()
  if (firstLine.indexOf('GNU bash, version') !== 0) {
    return { ok: false, detail: bashPath + '：它不是 bash（--version 的首行是「' + firstLine.slice(0, 120) + '」）' }
  }
  if (/pc-(msys|cygwin)/.test(said) !== true) {
    return { ok: false, detail: bashPath + '：它自报的不是 Git for Windows 一族的 bash（' + firstLine.slice(0, 120) + '）——多半是 WSL 的 bash' }
  }
  if (probe.exitCode !== 0) return { ok: false, detail: bashPath + '：探测退出码 ' + String(probe.exitCode) + '（' + (probe.stderr.text.trim().slice(0, 200) || '无 stderr') + '）' }
  return { ok: true, detail: firstLine }
}

/* 手填优先，自动发现兜底；两个来源都要过探测。答复带着 {bash, source, reason,
 * detail}：bash 为 null 时 reason/detail 是给配置页的那两句（沿用 reason/detail
 * 的文案风格）。 */
async function resolveRemoteBash(alias) {
  const router = remoteRouter()
  if (router === undefined) return { bash: null, source: '', reason: 'no-channel', detail: 'ssh-workspace 的命令通道不可用，开不出 Git Bash 通道' }
  const config = await readConfigFile()
  const configured = cleanRemoteBashPath(config.remoteBashPath)
  if (configured.length > 0) {
    const probe = await probeRemoteBash(router.engine, alias, configured)
    if (probe.ok === true) return { bash: configured, source: 'config', reason: '', detail: probe.detail }
    return {
      bash: null, source: 'config', reason: 'configured-bash-missing',
      detail: '配置的「远程 bash 路径」在主机 ' + alias + ' 上不可用：' + probe.detail + '。可以改一个，或清空让它重新自动发现。',
    }
  }
  /* `where git` 找的是 PATH 上的 git；它是 Git 家族安装的活证据，它所在目录向上
   * 每一级的 bin\bash.exe 都是候选。`where bash` 直接给出的也补进候选尾部 ——
   * 有的安装只把 bash 挂上了 PATH。 */
  const candidates = []
  const whereGit = await remoteChannelRun(router.engine, alias, 'where git', null, null, 10000)
  const gitLines = whereGit.stdout.text.split('\n').map(function (line) { return line.trim() }).filter(function (line) { return line.length > 0 }).slice(0, 3)
  for (let i = 0; i < gitLines.length; i += 1) {
    const derived = remoteBashCandidatesFromGit(gitLines[i])
    for (let j = 0; j < derived.length && candidates.length < 8; j += 1) {
      if (candidates.indexOf(derived[j]) < 0) candidates.push(derived[j])
    }
  }
  if (candidates.length === 0) {
    const whereBash = await remoteChannelRun(router.engine, alias, 'where bash', null, null, 10000)
    const bashLines = whereBash.stdout.text.split('\n').map(function (line) { return line.trim() }).filter(function (line) { return line.length > 0 }).slice(0, 3)
    for (let i = 0; i < bashLines.length && candidates.length < 8; i += 1) {
      if (candidates.indexOf(bashLines[i]) < 0 && bashLines[i].length > 0) candidates.push(bashLines[i])
    }
  }
  if (candidates.length === 0) {
    return {
      bash: null, source: '', reason: 'no-git-found',
      detail: '远端 PATH 上找不到 git（where git 没有结果），推不出 Git Bash 的位置。确认远端装了 Git for Windows，或在配置页手填 bash 的绝对路径。',
    }
  }
  const tried = []
  const stubbed = []
  for (let i = 0; i < candidates.length; i += 1) {
    const one = candidates[i]
    if (wslBashStubPath(one) === true) { stubbed.push(one); continue }
    tried.push(one)
    const probe = await probeRemoteBash(router.engine, alias, one)
    if (probe.ok === true) return { bash: one, source: 'discovered', reason: '', detail: probe.detail }
  }
  const detail = (stubbed.length > 0 ? '跳过了 WSL 存根：' + stubbed.join('、') + '。' : '')
    + '试过的候选都不行：' + (tried.length > 0 ? tried.join('、') : '（没有可试的候选）')
    + '。请在配置页手填远端 bash 的绝对路径。'
  return { bash: null, source: '', reason: 'no-bash-found', detail: detail }
}

async function remoteBashOf(alias, refresh) {
  const now = Date.now()
  const cached = remoteBashCache.get(alias)
  if (refresh !== true && cached !== undefined) {
    if (isStr(cached.bash)) return cached
    if (now - cached.at < REMOTE_BASH_FAIL_TTL) return cached
  }
  const resolved = await resolveRemoteBash(alias)
  remoteBashCache.set(alias, { bash: resolved.bash, source: resolved.source, reason: resolved.reason, detail: resolved.detail, at: now })
  return resolved
}

/* 配置换了一个 bash、或读者点了「再检查一次」时作废缓存。alias 给空就全清。 */
function invalidateRemoteBash(alias) {
  if (isStr(alias) && alias.length > 0) remoteBashCache.delete(alias)
  else remoteBashCache.clear()
}

/* ── 工作区的永久记录（70-config.js 的 remoteTransports）──
 *
 * 每个远端工作区只在第一次需要 transport 时探测一次，结论（测得 posix 或测得
 * cmd）写进部署配置的 remoteTransports 映射、键是工作区的 ssh:// 拼法 —— 之后
 * 这个工作区直接读记录，方言与 bash 都不再探。记录是「那台远端是什么机器」的
 * 事实，不是某次会话的观感：换会话、换浏览器、重启部署都还是同一个答案。
 * 兜底（没测出来）不落账：它不是结论，落了账反而把一次探测失败判成永久事实。
 *
 * 记录怎么审（transportForWorkdir）：
 *   - posix 记录：永久有效，零探测 —— 直接透传；
 *   - cmd 记录：bash 先审两道 —— 配置页的手填路径换了没有（换了记录就过期）、
 *     记录里的 bash 还探不探得通（每进程复审一次，探不通记录就失效）—— 失效
 *     才重探一次并覆写；
 *   - 没有记录：首次判定，测得即落账。
 * 进程内的 memo（remoteTransportMemo）只是记录之外的一次兜底：复审过的结论在
 * 本进程生命周期里直接复用，一条 git 命令一次探测都不用再付。 */

function remoteTransportKeyOf(workdir) {
  return repoKeyOf(workdir)
}

/* 判定结论落账。写的是部署配置文件（住在任何工作区之外），所以要这个会话的
 * 沙箱策略 —— args 里带着 sessionId（argsAt 放进来的；写命令不带 workdir，
 * 与 draftSave / saveAppliedRepo 的 argsAt(input, null) 同一个形状）。落账失败
 * 不拦读：账写不进去顶多是下次多探一轮（进程内 memo 照常兜着），console.error
 * 说一声就好 —— rpclog 那条「观测不许反过来伤害被观测的东西」的同一条例外。 */
async function saveRemoteTransportRecord(workdir, record, args) {
  try {
    const config = await readConfigFile()
    const map = Object.assign({}, config.remoteTransports)
    const key = remoteTransportKeyOf(workdir)
    const before = map[key]
    map[key] = record
    /* 同值不写盘（saveAppliedRepo 同一条纪律）：重复探测得出同一个答案时，
       一个字节都不该碰配置文件。 */
    if (before !== undefined && before.dialect === record.dialect && before.bash === record.bash) return
    const sessionArgs = args != null && isStr(args.sessionId) && args.sessionId.length > 0 ? { sessionId: args.sessionId } : {}
    const written = await writeConfigFile(Object.assign({}, config, { remoteTransports: map }), sessionArgs)
    if (written.ok !== true) {
      console.error('dsh-git-idea: 工作区 ' + workdir + ' 的 transport 判定记录落不了盘（读本身不受影响，下次重探），' + String(written.error))
    }
  } catch (error) {
    console.error('dsh-git-idea: 工作区 ' + workdir + ' 的 transport 判定记录写失败（读本身不受影响，下次重探）', String(error))
  }
}

const remoteTransportMemo = new Map()

/* memo 作废：workdir 给空就全清（配置动了手填 bash 时，writeConfigFile 调的全清 —
 * 每条 cmd 记录都要按新配置重审一遍）；「清除记录」按钮给单条。 */
function invalidateRemoteTransports(workdir) {
  if (isStr(workdir) && workdir.length > 0) remoteTransportMemo.delete(workdir)
  else remoteTransportMemo.clear()
}

/* 首次判定：三态测量 + 测得即落账。 */
async function detectRemoteTransport(workdir, args) {
  const parts = remotePartsOf(workdir)
  const dialect = await measureRemoteDialect(parts.alias)
  if (dialect.measured !== true) {
    return { state: 'posix-fallback', measured: false, origin: 'fallback', reason: dialect.reason, detail: dialect.detail }
  }
  if (dialect.state === 'posix') {
    const record = { dialect: 'posix', bash: '', at: Date.now() }
    await saveRemoteTransportRecord(workdir, record, args)
    const entry = { state: 'posix', measured: true, origin: 'probe', at: record.at }
    remoteTransportMemo.set(workdir, entry)
    return entry
  }
  /* cmd：bash 解析（手填优先、自动发现，remoteBashOf 自带 60 秒失败缓存）。
     方言测得了、bash 没着落 —— cmd 这个结论可信，bash 的失败原因照旧由
     remoteBashCache 兜着，下一读重试解析；记录不落（归一化也不收没有 bash 的
     cmd 记录）。 */
  const bash = await remoteBashOf(parts.alias)
  if (!isStr(bash.bash)) {
    return { state: 'cmd', measured: true, origin: 'probe', bash: '', reason: bash.reason, detail: bash.detail }
  }
  const record = { dialect: 'cmd', bash: bash.bash, at: Date.now() }
  await saveRemoteTransportRecord(workdir, record, args)
  const entry = { state: 'cmd', measured: true, origin: 'probe', bash: bash.bash, source: bash.source, at: record.at, detail: bash.detail }
  remoteTransportMemo.set(workdir, entry)
  return entry
}

async function transportForWorkdir(workdir, args) {
  const memo = remoteTransportMemo.get(workdir)
  if (memo !== undefined) return memo
  const router = remoteRouter()
  const config = await readConfigFile()
  const record = config.remoteTransports != null ? config.remoteTransports[remoteTransportKeyOf(workdir)] : undefined
  if (record !== undefined && record.dialect === 'posix') {
    /* posix 记录永久有效：不再探，直接透传。 */
    const entry = { state: 'posix', measured: true, origin: 'record', at: record.at }
    remoteTransportMemo.set(workdir, entry)
    return entry
  }
  if (record !== undefined && record.dialect === 'cmd') {
    const parts = remotePartsOf(workdir)
    /* 记录先审配置：手填的 bash 换了（或从空到有），记录里的自动发现答案就
       过期了 —— 重探一次（resolveRemoteBash 手填优先），得出什么覆写什么。 */
    const configured = cleanRemoteBashPath(config.remoteBashPath)
    if (configured.length > 0 && configured !== record.bash) {
      return await detectRemoteTransport(workdir, args)
    }
    /* 再审 bash 本身：每进程复审一次（memo 未命中才走到这），探得通就照记录办，
       探不通记录失效 —— 重探一次并覆写。 */
    const probe = await probeRemoteBash(router.engine, parts.alias, record.bash)
    if (probe.ok === true) {
      const entry = { state: 'cmd', measured: true, origin: 'record', bash: record.bash, at: record.at, detail: probe.detail }
      remoteTransportMemo.set(workdir, entry)
      return entry
    }
    console.error('dsh-git-idea: 工作区 ' + workdir + ' 的 cmd 记录里的 bash 探不通（' + probe.detail + '），重探一次并覆写')
    return await detectRemoteTransport(workdir, args)
  }
  return await detectRemoteTransport(workdir, args)
}

/* 清除一个工作区的判定记录（配置页「远程主机」组的按钮）：配置里的条目删掉、
 * 进程内 memo 作废，下一读重新首次判定。本来就没有记录的同值早退（saveAppliedRepo
 * 同一条纪律）。方言的进程内缓存也一并作废 —— 清除多半是因为怀疑记录过时
 * （主机重装过、换过系统），那一问值得重问。 */
async function clearRemoteTransport(workdir, args) {
  const config = await readConfigFile()
  const map = Object.assign({}, config.remoteTransports)
  const key = remoteTransportKeyOf(workdir)
  if (map[key] === undefined) {
    invalidateRemoteTransports(workdir)
    return { ok: true, workspace: workdir, cleared: false }
  }
  delete map[key]
  const sessionArgs = args != null && isStr(args.sessionId) && args.sessionId.length > 0 ? { sessionId: args.sessionId } : {}
  const written = await writeConfigFile(Object.assign({}, config, { remoteTransports: map }), sessionArgs)
  if (written.ok !== true) return written
  invalidateRemoteTransports(workdir)
  const parts = remotePartsOf(workdir)
  if (parts !== undefined) remoteDialectCache.delete(parts.alias)
  return { ok: true, workspace: workdir, cleared: true }
}

/* ── transport 的选择 ──
 *
 * invoke() 每次调这里（args 原样带进来 —— 首次判定落账要用它的 sessionId）。
 * 返回 null = 照旧走 shell 层（本地、ssh 插件不在场）；返回 route 两种：
 * kind:'engine' = 走 Git Bash 通道；kind:'passthrough' = POSIX 远端（测得或兜底）
 * 仍走 shell 层透传，但命令文本里的 ssh://<alias>/ 前缀要摘成本机路径拼法 ——
 * 片段脚本把 <repo>/<workspace> 原文嵌在命令里，ssh://posix/tmp/x 这个拼法在
 * 远端文件系统上并不存在，不换写的话 POSIX 远端照样答「不是仓库」（实测）。
 * 通道没就绪时抛错给调用方（RPC 拒绝 → 面板的 problem 行拿到原因，绝不落成
 * 「不是 git 仓库」）。 */
async function remoteRouteOf(request, sandbox, args) {
  const parts = remotePartsOf(request.workdir)
  if (parts === undefined) return null
  const router = remoteRouter()
  if (router === undefined) return null
  /* 会话是「仅可查看」时远端命令本来就该被拒（本地沙箱的边界过不了 SSH，ssh 插件
     在 shell 层把 read-only 一律拒掉）——这条通道绕开了那一层，所以同一道闸在这里
     自己装一道，而且装在一切探测之前：只读会话连方言/记录复审的通道都不开。
     口径与 ssh 插件的 mode-gate 一致：认得的三种模式之外一律从严。 */
  const mode = sandbox != null && isStr(sandbox.mode) ? sandbox.mode : undefined
  if (mode !== undefined && mode !== 'workspace-write' && mode !== 'danger-full-access') {
    const why = mode === 'read-only'
      ? 'cannot run a remote command on ssh://' + parts.alias + parts.remotePath + ': the session sandbox mode is "read-only" and a remote command cannot be confined — switch this session to workspace-write or danger-full-access.'
      : 'cannot run a remote command on ssh://' + parts.alias + parts.remotePath + ': the session sandbox mode is "' + mode + '", which this plugin does not recognise — the command was refused rather than run unconfined.'
    const refusal = new Error(why)
    refusal.sandboxDenied = true
    throw refusal
  }
  const transport = await transportForWorkdir(request.workdir, args)
  if (transport.state !== 'cmd') {
    return { kind: 'passthrough', alias: parts.alias, remotePath: parts.remotePath }
  }
  if (!isStr(transport.bash) || transport.bash.length === 0) {
    throw new Error('远程主机 ' + parts.alias + ' 的 Git Bash 通道没有就绪（' + transport.reason + '）：' + transport.detail)
  }
  return {
    kind: 'engine',
    engine: router.engine, alias: parts.alias, remotePath: parts.remotePath,
    bash: transport.bash, source: isStr(transport.source) ? transport.source : '',
  }
}

/* ssh:// 拼法 → 远端 bash 认的路径拼法。片段脚本把仓库/工作区路径用 shq 原文嵌进
 * 命令（`[ -e '<repo>/.git' ]`、`git -C '<repo>'`、`find '<workspace>' …`），而那些
 * 路径在本会话里是 `ssh://<alias>/<绝对路径>` —— 这个拼法只有 shell 层的 cd 前缀
 * 认识，远端文件系统上不存在，不换写的话脚本照样答「不是仓库」。规则只有一条：
 * 本主机的 `ssh://<alias>/` 前缀整段摘掉（`ssh://win/D:/code/proj` → `D:/code/proj`，
 * 反斜杠都不用换 —— MSYS bash 认正斜杠的盘符路径）。只改命令文本；stdin 数据
 * （conflict-save 的文件内容、revert 的补丁）一字节不碰 —— 那是读者的东西，里面
 * 出现同样的字符串也不是路径。别的别名、git 自己的 `ssh://git@…` 远端 URL 都不在
 * 本主机的这条前缀里，不会误伤。 */
function remoteScriptText(route, command) {
  /* cmd 通道摘 `ssh://<alias>/`（连斜杠一起 —— 余下的 `D:/…` 正是 MSYS 认的拼法）；
     POSIX 透传摘 `ssh://<alias>`（不连斜杠 —— 余下的 `/tmp/…` 本来就是远端绝对
     路径，把斜杠吃掉就成了相对路径）。别名按整个词匹配（后面必须紧跟 `/`），
     `ssh://posix2/...` 不会被 alias=posix 的规则误伤。 */
  const escaped = String(route.alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp('ssh://' + escaped + (route.kind === 'engine' ? '/' : '(?=/)'), 'g')
  return command.replace(pattern, '')
}

/* 通道上跑一条：`cd /d "<win路径>" && "<bash>" -s`，POSIX 脚本原文（连同 stdin
 * 数据）从 stdin 喂入。bash -s 把脚本里 `cat`/`git apply -` 的 stdin 指到剩余
 * 输入 —— 数据跟在脚本后面原样到达，实测一字节不少。 */
async function remoteShellRun(route, request) {
  const script = remoteScriptText(route, request.command)
    + (isStr(request.stdin) ? (request.command.endsWith('\n') ? '' : '\n') + request.stdin : '')
  const command = 'cd /d ' + cmdQuoteWin(remoteCmdPath(route.remotePath)) + ' && ' + cmdQuoteWin(route.bash) + ' -s'
  try {
    const raw = await remoteChannelRun(route.engine, route.alias, command, script, route.remotePath, request.timeoutMs)
    return {
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
      timedOut: raw.timedOut === true,
      aborted: false,
    }
  } catch (error) {
    /* 连接层面的失败（acquire 拒绝、通道开不出来）：说清楚是 transport，不是仓库。 */
    const detail = error != null && error.message !== undefined ? String(error.message) : String(error)
    throw new Error('远程主机 ' + route.alias + ' 的命令通道开不出来：' + detail)
  }
}

/* 配置页要的那份快照：这个工作区的主机、三态方言结论、Git Bash 通道与永久
 * 记录的状态。dialect 是生效方言（'posix' / 'cmd' / 'posix-fallback'），measured
 * 区分「测得」与「兜底」，origin 说结论从哪来（record=永久记录 / probe=本次刚
 * 测 / memo=进程内复审过 / fallback=兜底），recordedAt 是记录落账的时刻。
 * refresh（配置页「再检查一次」）作废这个工作区的 memo 与进程内的方言、bash
 * 缓存：cmd 记录当场复审（bash 重新探测），没有记录的当场重测 —— 记录本身
 * 不删，删是另一个按钮的事。 */
async function remoteTransportSnapshot(workdir, refresh, args) {
  const parts = remotePartsOf(workdir)
  if (parts === undefined) {
    return { remote: false, workdir: '', alias: '', dialect: '', measured: false, origin: '', recordedAt: 0, bash: '', source: '', reason: '', detail: '' }
  }
  if (refresh === true) {
    invalidateRemoteTransports(workdir)
    remoteDialectCache.delete(parts.alias)
    invalidateRemoteBash(parts.alias)
  }
  const router = remoteRouter()
  if (router === undefined) {
    /* 通道不在（ssh 插件太旧 / 没接管）：探测无从谈起，但已有的记录还能说。 */
    const config = await readConfigFile()
    const record = config.remoteTransports != null ? config.remoteTransports[remoteTransportKeyOf(workdir)] : undefined
    if (record !== undefined) {
      return {
        remote: true, workdir: workdir, alias: parts.alias, dialect: record.dialect, measured: true,
        origin: 'record', recordedAt: record.at, bash: record.bash, source: '',
        reason: 'no-channel',
        detail: '这个工作区的判定记录还在（' + (record.dialect === 'cmd' ? 'cmd，bash ' + record.bash : 'posix') + '），但 ssh-workspace 的命令通道不可用（插件版本太旧或没有接管 shell），探测与通道都开不出来。',
      }
    }
    return {
      remote: true, workdir: workdir, alias: parts.alias, dialect: '', measured: false, origin: '',
      recordedAt: 0, bash: '', source: '', reason: 'no-channel',
      detail: 'ssh-workspace 的命令通道不可用（插件版本太旧或没有接管 shell），方言与 Git Bash 通道都无从判定。',
    }
  }
  const transport = await transportForWorkdir(workdir, args)
  return {
    remote: true, workdir: workdir, alias: parts.alias,
    dialect: transport.state, measured: transport.measured === true,
    origin: isStr(transport.origin) ? transport.origin : '',
    recordedAt: typeof transport.at === 'number' ? transport.at : 0,
    bash: isStr(transport.bash) ? transport.bash : '',
    source: isStr(transport.source) ? transport.source : '',
    reason: isStr(transport.reason) ? transport.reason : '',
    detail: isStr(transport.detail) ? transport.detail : '',
  }
}
