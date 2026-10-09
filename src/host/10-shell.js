/* ─────────────── primitives ─────────────── */

function shq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function isStr(value) {
  return typeof value === 'string'
}

/* One field of a record git printed as a separated line. A field git had nothing
   to put in is simply absent from the split, and every reader wants the same
   thing there: the empty string, never `undefined` leaking into a reply the
   Client will render. Longhand this is `fields[3] === undefined ? '' : fields[3]`
   — a forty-two times repeated question, asked once here. */
function field(split, index) {
  const value = split[index]
  return value === undefined ? '' : value
}

function sessionCwd(exec) {
  if (exec == null || exec.agent == null) return undefined
  const session = exec.agent.session
  const header = session != null ? session.header : undefined
  const cwd = header != null ? header.cwd : undefined
  return isStr(cwd) && cwd.length > 0 ? cwd : undefined
}

function workdirFor(args, exec) {
  if (args != null && isStr(args.repo) && args.repo.trim().length > 0) return args.repo.trim()
  return sessionCwd(exec)
}

function here(args, exec) {
  const cwd = workdirFor(args, exec)
  return cwd === undefined ? null : cwd
}

/* ── whose sandbox these commands run under ──

   A shell call that names no policy gets the *deployment* default, not the
   session's. Measured on this deployment: the default is `workspace-write` rooted
   at the deployment's own directory (/mnt/c/Users/mayou here) while the session is
   `danger-full-access` — so every writing git command failed with "Permission
   denied" on `.git/index.lock` for any repository outside that one directory,
   while reads were fine and it looked like git refusing to work.

   The session's mode and its cwd are exactly what the reader's own commands run
   under, so they are what this plugin asks for: `sessions` says which session,
   `sandboxPolicy` says what that session resolved to, and a session that is
   read-only keeps this plugin read-only. Without either service the request goes
   out unchanged and the shell layer falls back as before. */
function sandboxFor(args, exec) {
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined) return undefined
  let session = null
  try {
    if (exec != null && exec.agent != null && exec.agent.session != null) {
      session = exec.agent.session
    } else if (args != null && isStr(args.sessionId) && args.sessionId.length > 0) {
      const sessions = ctx.get('sessions')
      if (sessions !== undefined) session = sessions.get(args.sessionId)
    }
    if (session == null) return undefined
    const resolved = policy.resolve({ session: session })
    return resolved == null ? undefined : resolved
  } catch (error) {
    console.error('dsh-git-idea: could not resolve this session\'s sandbox policy', String(error))
    return undefined
  }
}

/* ── one executor, two shapes ──

   DSH 0.1.7 replaced the executor's one-shot `run(spec)` with `execute(spec)`:
   the call now resolves with a live handle, and `result()` on that handle is the
   settled run this file has always read. Both shapes are served here so one body
   runs on 0.1.5/0.1.6 and on 0.1.7+ — `execute` is preferred exactly when the
   executor offers it, and nothing else about the request changes. */
async function runShell(spec) {
  if (typeof shell.execute === 'function') {
    const execution = await shell.execute(spec)
    return typeof execution.result === 'function' ? await execution.result() : execution
  }
  return await shell.run(spec)
}

async function invoke(command, args, exec, options) {
  const opts = options == null ? {} : options
  const request = {
    command: command,
    timeoutMs: typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 120000,
    stdoutMaxBytes: typeof opts.maxBytes === 'number' ? opts.maxBytes : 1048576,
  }
  const workdir = workdirFor(args, exec)
  if (workdir !== undefined) request.workdir = workdir
  if (isStr(opts.stdin)) request.stdin = opts.stdin
  const sandbox = sandboxFor(args, exec)
  if (sandbox !== undefined) request.sandboxPolicy = sandbox
  const raw = await runShell(shell.resolve(request))
  const out = raw.stdout == null ? null : raw.stdout
  const err = raw.stderr == null ? null : raw.stderr
  return {
    exitCode: raw.exitCode == null ? null : raw.exitCode,
    stdout: out !== null && isStr(out.text) ? out.text : '',
    stderr: err !== null && isStr(err.text) ? err.text : '',
    truncated: (out !== null && out.truncated === true) || (err !== null && err.truncated === true),
    spillPath: out !== null && isStr(out.spillPath) ? out.spillPath : null,
    timedOut: raw.timedOut === true,
    aborted: raw.aborted === true,
    sandboxDenied: raw.sandbox != null && raw.sandbox.denied === true,
    cwd: workdir === undefined ? null : workdir,
  }
}

/* ── the one failure that is not about the repository ──

   On a machine with no `git` on PATH every command below dies at the shell, and
   its "command not found" arrives looking exactly like a repository git refused
   to read: `git status` and `git rev-parse` both answer nothing, `$gd` comes out
   empty, and a perfectly good repository is reported as "not a git repository" —
   the one diagnosis the reader cannot act on, with the path field hidden besides.

   So each git command opens with a question about the machine instead. `command
   -v` is a shell builtin, so the check costs no process, and it asks about the
   PATH *this* command will be resolved with — after `LC_ALL=C` and
   `GIT_TERMINAL_PROMPT=0` have been put in front of it, neither of which changes
   which git is found. The marker word and exit code 127 are what the Host reads;
   bash's own sentence is never matched, because it is printed in whatever
   language the machine happens to speak.

   The panel scripts below are the one place this is not enough: they multiplex
   several answers over stdout in a single process (`pathShell`), so they carry
   the same check's answer as an output marker instead of an exit code —
   `PANEL_NO_GIT`. Same question, same builtin, two transports. */
const GIT_MISSING_MARK = 'dsh-git-idea: no git on PATH'
/* `command -v <word>` answers for a bare name through PATH and for an absolute
   path by checking it is executable, so one guard covers both "the git on PATH"
   and "the git this reader configured". The command word is resolved once per
   call (see `gitCmd` in 70-config.js) and cannot contain a newline. */
function gitGuard() {
  return 'command -v ' + gitCmd() + ' >/dev/null 2>&1 || { printf ' + shq(GIT_MISSING_MARK + '\n') + ' >&2; exit 127; }\n'
}
const PANEL_NO_GIT = 'N:nogit'

/* ── the second failure that is not about the repository ──

   `git commit` refuses to author a commit when it cannot work out who the
   author is, and nothing about that is the repository's fault: the identity
   lives in git's own configuration, and only the reader can choose a name and
   an address. Read as plain stderr it arrives as eight lines of English
   ending in `fatal: empty ident name`, which says what failed and not one word
   about the two commands that fix it.

   Recognised where it happens rather than matched out of that text: git
   translates it, and it has several spellings (identity absent, an address but
   no name, a guessed address that is not a full domain). The question asked
   instead is `git var GIT_AUTHOR_IDENT` — the same lookup `git commit` makes
   before it writes anything — and a non-zero exit answers "this commit is
   going to be refused" in every locale. It is asked only *after* a commit has
   already failed, so the path that works pays nothing for it. */
async function identityMissing(args) {
  const asked = await gitC(args, ['var', 'GIT_AUTHOR_IDENT'], null, {})
  return asked.exitCode !== 0
}

/* The same answer as a marker inside a panel script, where a non-zero exit code
   cannot be the transport: `$gd` is already known to be non-empty by the time
   this runs, so it is one git process, in the whole-tree read only. */
const PANEL_NO_IDENT = 'I:none'

/* The three wrappers differ only in what they put in front of the command: the
   package prefix is the whole of the difference, so it is the only argument. */
async function shellGit(prefix, args, argv, exec, options) {
  const result = await invoke(gitGuard() + prefix + gitCmd() + ' ' + argv.map(shq).join(' '), args, exec, options)
  result.command = gitExe + ' ' + argv.join(' ')
  result.ok = result.exitCode === 0
  result.noGit = result.exitCode === 127 && result.stderr.indexOf(GIT_MISSING_MARK) >= 0
  return result
}

async function git(args, argv, exec, options) {
  return await shellGit('', args, argv, exec, options)
}

/* 网络命令必须先回答两个「与仓库无关」的问题，然后才轮到 git：凭据（没有终端可
   以弹提示，等着只会超时）和主机指纹（known_hosts 里没有的机器，ssh 想问「是否
   信任」，面板同样没有地方让它问 —— 报出来的是一句 Host key verification failed，
   说的像是仓库的毛病）。

   指纹这一问有一条不牺牲安全的出路：StrictHostKeyChecking=accept-new 只把「第一次
   见到的主机」自动收下并写进 known_hosts，已登记主机的 key 变了照样拒绝（那正是
   中间人攻击的形状，不该被自动放过）。但 ssh 命令是读者自己配得动的东西
   （GIT_SSH_COMMAND 环境变量、core.sshCommand 配置），人家配了就一个字节都不碰 ——
   所以这段回退只在两者都空着时才 export。它长在 gitGuard 的 `command -v` 行之后：
   `git config --get` 得先知道 git 在哪；配置读不出来（输出为空）按「没有配置」算，
   环境变量也一样 —— 宁可多收一次主机 key，不能把读者自己配的 ssh 命令盖掉。 */
function sshFallbackLine() {
  return 'if [ -z "${GIT_SSH_COMMAND:-}" ] && [ -z "$(' + gitCmd() + ' config --get core.sshCommand 2>/dev/null)" ]; then '
    + 'export GIT_SSH_COMMAND=' + shq('ssh -o StrictHostKeyChecking=accept-new') + '; fi\n'
}

async function gitNet(args, argv, exec, options) {
  return await shellGit(sshFallbackLine() + 'GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true ', args, argv, exec, options)
}

/* for-each-ref's %(upstream:track) is the one atom git translates. The switcher
   shows the numbers out of it, so the words around them have to be predictable
   rather than whatever locale the machine happens to use. */
async function gitC(args, argv, exec, options) {
  return await shellGit('LC_ALL=C ', args, argv, exec, options)
}

/* Every reply that carries a command's failure carries this with it, so that no
   surface has to recognise a missing git by the words in stderr — see
   `gitGuard`. One flag, read in one place per surface: the mutating commands
   through `commandDetail`, the panel reads through their `reason`. */
function gitMissing(result) {
  return result != null && result.noGit === true
}

/* ── HEAD 指着一个还没有提交的分支 ──

   刚 `git init` 出来的仓库就是这样（包括这个插件自己的引导页建出来的那个）：HEAD
   里写着 `refs/heads/main`，而 `refs/heads` 是空的。它没有任何毛病，但所有读 *ref*
   的东西都拿不到答案 —— `for-each-ref` 一个分支都不列，`git log <branch>` 报
   "unknown revision"，而把「这次读失败了」当成「这不是一个仓库」的面板，就会对着
   它自己刚建出来的仓库说那句话。

   这里还剩一个问得出来的问题，而且 git 不用碰任何 ref 就能回答：HEAD 写的是哪个
   分支。只在 ref 表里一个当前分支都没有时才问一次 —— 普通仓库（`%(HEAD)` 已经标出
   来了）一次都不多花。真正的游离 HEAD 同样答不出来，而那正是调用方本来就会处理的
   情况。 */
async function headBranchWithoutCommit(args) {
  const asked = await gitC(args, ['symbolic-ref', '--quiet', '--short', 'HEAD'], null, {})
  if (asked.exitCode !== 0) return ''
  const name = asked.stdout.trim()
  return name.length > 0 ? name : ''
}

