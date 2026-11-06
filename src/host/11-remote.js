/* ─────────────── ssh:// 远程工作区与 cmd 方言 ───────────────
 *
 * 会话工作区是 ssh:// 远程工作区（dsh-ssh-workspace 插件挂载）时，这个插件的每一条
 * git 命令都要过两层：shell 层把 ssh:// workdir 拆成 alias + remotePath、拼上一段
 * `cd '<remotePath>' && ` 前缀交给远端登录 shell。POSIX 主机（Linux/macOS）上这一段
 * 语法成立，脚本原样透传就是正确行为；Windows OpenSSH 主机的登录 shell 是 cmd.exe，
 * 单引号不是引号字符 —— `cd 'D:/…'` 连目录都进不去，POSIX 脚本必败（实测报
 * 「'p' 不是内部或外部命令」），面板于是把一台好好的仓库判成「不是 git 仓库」。
 *
 * 所以 transport 按「workdir 是否 ssh:// + 主机方言」选：方言拿不到或就是 POSIX 时
 * 一字节不改地走老路（现状即正确）；方言是 cmd 时改走 Git Bash 通道 —— 命令改成
 * `cd /d "<remotePath>" && "<bash路径>" -s`，POSIX 脚本原文连同 stdin 数据从 stdin
 * 喂进 bash（bash -s 把剩余 stdin 交给脚本里的 `cat`/`git apply -` 读，已实测余量
 * 数据不丢）。通道走 dsh-ssh-workspace 自己的 engine.openChannel（同一条池化 SSH
 * 连接上的裸 exec 通道）：patch-shell 那半的自动 cd 前缀是 POSIX 语法、在 cmd 主机
 * 上必死，绕开它而不是修它 —— 那是另一个插件，这里只读不动。
 *
 * 方言与远端 bash 路径都按主机别名缓存在进程内；bash 优先用配置页「远程 bash 路径」
 * 的手填值，空则 `where git` 向上推同树 bin\bash.exe 自动发现，C:\Windows\System32\
 * bash.exe（WSL 存根）明确拒绝，探测（--version 必须自报 pc-msys/pc-cygwin）通过才
 * 启用。发现失败的Readable 原因由 git/remote-transport 带到配置页，指引手填。 */

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

/* ── 方言 ──
 *
 * 首选 ssh 插件自己的 remoteDialect(alias)：它在池化连接的记录上按连接缓存、断线
 * 重连会重探，是最权威的一份。引擎没有这个 API 时退化为自己问一句金丝雀
 * `echo %COMSPEC%`：cmd 把它展开成 cmd.exe 的 Windows 路径，POSIX shell 原样回显
 * 字面量 —— 两种方言的答案可区分（与 dsh-ssh-workspace engine.js 同一问法）。
 * 自探的结果在本进程内按 alias 缓存：答案成立时缓存得久（登录 shell 不会自己变），
 * 失败的缓存 60 秒就过期重探 —— 连接刚断时的失败不该被判成永久事实。 */
const REMOTE_DIALECT_TTL = 300000
const REMOTE_DIALECT_FAIL_TTL = 60000
const REMOTE_WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/
const remoteDialectCache = new Map()

function remoteDialectStale(entry, now) {
  if (entry === undefined || !isStr(entry.dialect)) return true
  return now - entry.at > (entry.dialect === 'cmd' ? REMOTE_DIALECT_TTL : REMOTE_DIALECT_FAIL_TTL)
}

async function remoteDialectOf(alias) {
  const now = Date.now()
  const cached = remoteDialectCache.get(alias)
  if (remoteDialectStale(cached, now) !== true) return cached.dialect
  const router = remoteRouter()
  let dialect = 'posix'
  if (router !== undefined && typeof router.engine.remoteDialect === 'function') {
    try {
      const said = await router.engine.remoteDialect(alias)
      dialect = said === 'cmd' ? 'cmd' : 'posix'
    } catch (error) {
      console.error('dsh-git-idea: 主机 ' + alias + ' 的方言探测失败，按 POSIX 处理', String(error))
      dialect = 'posix'
    }
  } else if (router !== undefined) {
    try {
      const canary = await remoteChannelRun(router.engine, alias, 'echo %COMSPEC%', null, null, 15000)
      const value = canary.stdout.text.trim()
      if (canary.exitCode === 0 && value !== '' && value.indexOf('%COMSPEC%') < 0 && REMOTE_WINDOWS_PATH_RE.test(value)) {
        dialect = 'cmd'
      }
    } catch (error) {
      console.error('dsh-git-idea: 主机 ' + alias + ' 的方言金丝雀没有跑成，按 POSIX 处理', String(error))
      dialect = 'posix'
    }
  }
  remoteDialectCache.set(alias, { dialect: dialect, at: now })
  return dialect
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
  if (probe.timedOut === true) return { ok: false, detail: '探测超时（10 秒）——远端没有响应 ' + bashPath }
  const said = probe.stdout.text
  const firstLine = said.split('\n')[0].trim()
  if (firstLine.indexOf('GNU bash, version') !== 0) {
    return { ok: false, detail: '它不是 bash（--version 的首行是「' + firstLine.slice(0, 120) + '」）' }
  }
  if (/pc-(msys|cygwin)/.test(said) !== true) {
    return { ok: false, detail: '它自报的不是 Git for Windows 一族的 bash（' + firstLine.slice(0, 120) + '）——多半是 WSL 的 bash' }
  }
  if (probe.exitCode !== 0) return { ok: false, detail: '探测退出码 ' + String(probe.exitCode) + '（' + (probe.stderr.text.trim().slice(0, 200) || '无 stderr') + '）' }
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

/* ── transport 的选择 ──
 *
 * invoke() 每次调这里。返回 null = 照旧走 shell 层（本地、POSIX 远端、没有通道）；
 * 返回 route = 走 Git Bash 通道；route.error 非空 = 通道开不出来，抛给调用方
 * （RPC 拒绝 → 面板的 problem 行拿到原因，绝不落成「不是 git 仓库」）。 */
async function remoteRouteOf(request, sandbox) {
  const parts = remotePartsOf(request.workdir)
  if (parts === undefined) return null
  const router = remoteRouter()
  if (router === undefined) return null
  const dialect = await remoteDialectOf(parts.alias)
  if (dialect !== 'cmd') return null
  /* 会话是「仅可查看」时远端命令本来就该被拒（本地沙箱的边界过不了 SSH，ssh 插件
     在 shell 层把 read-only 一律拒掉）——这条通道绕开了那一层，所以同一道闸在这里
     自己装一道，口径与其 mode-gate 一致：认得的三种模式之外一律从严。 */
  const mode = sandbox != null && isStr(sandbox.mode) ? sandbox.mode : undefined
  if (mode !== undefined && mode !== 'workspace-write' && mode !== 'danger-full-access') {
    const why = mode === 'read-only'
      ? 'cannot run a remote command on ssh://' + parts.alias + parts.remotePath + ': the session sandbox mode is "read-only" and a remote command cannot be confined — switch this session to workspace-write or danger-full-access.'
      : 'cannot run a remote command on ssh://' + parts.alias + parts.remotePath + ': the session sandbox mode is "' + mode + '", which this plugin does not recognise — the command was refused rather than run unconfined.'
    const refusal = new Error(why)
    refusal.sandboxDenied = true
    throw refusal
  }
  const bash = await remoteBashOf(parts.alias)
  if (!isStr(bash.bash)) {
    throw new Error('远程主机 ' + parts.alias + ' 的 Git Bash 通道没有就绪（' + bash.reason + '）：' + bash.detail)
  }
  return { engine: router.engine, alias: parts.alias, remotePath: parts.remotePath, bash: bash.bash, source: bash.source }
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
  const marker = 'ssh://' + route.alias + '/'
  if (command.indexOf(marker) < 0) return command
  return command.split(marker).join('')
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

/* 配置页要的那份快照：这个会话的主机、方言、bash、失败原因。 */
async function remoteTransportSnapshot(alias, refresh) {
  const router = remoteRouter()
  const dialect = await remoteDialectOf(alias)
  if (dialect !== 'cmd') {
    return { alias: alias, dialect: dialect, bash: '', source: '', reason: '', detail: dialect === 'posix' ? '远程是 POSIX 主机：POSIX 脚本原样透传，不需要 Git Bash 通道。' : '' }
  }
  if (router === undefined) {
    return { alias: alias, dialect: dialect, bash: '', source: '', reason: 'no-channel', detail: 'ssh-workspace 的命令通道不可用（插件版本太旧或没有接管 shell），Git Bash 通道开不出来。' }
  }
  const bash = await remoteBashOf(alias, refresh === true)
  return { alias: alias, dialect: dialect, bash: bash.bash, source: bash.source, reason: bash.reason, detail: bash.detail }
}
