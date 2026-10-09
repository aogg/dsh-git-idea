/* ─────────────── who a commit is signed by ───────────────

   `git commit` will not write a commit until it knows a name and an address, and
   when it does not it prints eight lines of English advice. The panel used to
   hand those eight lines to the reader; the two `git config` commands inside them
   are the real answer, and this is where the panel offers to run them.

   Read through git and not through the config file: the effective value depends
   on the local file, the global file, the system file, `GIT_AUTHOR_NAME` and the
   command line, in an order only git knows (`git var GIT_AUTHOR_IDENT` is the
   same lookup the commit makes, and it is what `identityMissing` asks). One
   `--show-origin --get-regexp` answers "what is it" and "where did that come
   from" together, which is the pair the settings page has to show: a name that
   comes from `.git/config` is *this repository's*, and one that comes from
   `~/.gitconfig` is the machine's. */

/* The two values, each with the file it came from. `git config` prints
   `file:/path/to/config<TAB>user.name Ada`; the origin prefix is the part that
   says who is winning. */
function parseIdentity(out) {
  const found = { name: '', email: '', nameOrigin: '', emailOrigin: '' }
  const lines = out.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const origin = line.slice(0, tab)
    const rest = line.slice(tab + 1)
    const space = rest.indexOf(' ')
    if (space < 0) continue
    const key = rest.slice(0, space)
    const value = rest.slice(space + 1)
    if (key === 'user.name') { found.name = value; found.nameOrigin = origin }
    if (key === 'user.email') { found.email = value; found.emailOrigin = origin }
  }
  return found
}

/* `file:/home/x/.gitconfig` is what git prints; the reader wants the path. */
function originLabel(origin) {
  if (origin.length === 0) return ''
  if (origin.indexOf('file:') === 0) return origin.slice(5)
  return origin
}

async function identitySnapshot(input) {
  const target = repoFrom(input, null)
  const inside = target !== undefined
  const args = inside ? argsAt(input, target) : {}
  /* 不知道是哪个仓库时，绝不去问「此刻生效的那一份」：`git config`（和 `git var`）
     会按**当前目录**回答，而当前目录是 dsh 进程自己的目录，不是读者在看的东西 ——
     拿它答出来的作者名去填「此刻生效」，就是把另一个仓库的身份说成这个仓库的。这时
     只回答机器级的那一份，并明说不知道仓库（`insideRepo: false`），由界面自己说清。
     这条是被 fixture 抓出来的：临时仓库里读到的 `user.name` 是插件自己仓库里的那个。 */
  const effective = inside
    ? await gitC(args, ['config', '--show-origin', '--get-regexp', '^user\\.(name|email)$'], null, {})
    : null
  /* 机器级的这一份按定义与目录无关，所以它在两种情况下都问。 */
  const global = await gitC(args, ['config', '--global', '--show-origin', '--get-regexp', '^user\\.(name|email)$'], null, {})
  const here = effective === null
    ? { name: '', email: '', nameOrigin: '', emailOrigin: '' }
    : parseIdentity(effective.stdout)
  const machine = parseIdentity(global.stdout)
  /* The same question the commit asks, so the settings page and the commit pane
     can never disagree about whether a commit would be refused. Not asked when
     there is no repository to ask about: "would a commit here be refused" is a
     question about a repository, and answering it from whatever directory the
     Host happens to sit in is the misreport this whole function avoids. */
  const missing = inside ? await identityMissing(args) : false
  return {
    ok: true, repo: inside ? target : null, insideRepo: inside,
    name: inside ? here.name : machine.name,
    email: inside ? here.email : machine.email,
    nameOrigin: inside ? originLabel(here.nameOrigin) : originLabel(machine.nameOrigin),
    emailOrigin: inside ? originLabel(here.emailOrigin) : originLabel(machine.emailOrigin),
    globalName: machine.name, globalEmail: machine.email,
    needsIdentity: missing,
    /* Both halves are the same value from the same file: a name set here but no
       address is the case git reports as "empty ident name", and the page has to
       be able to say which half is missing rather than "fill both". */
    nameMissing: (inside ? here.name : machine.name).length === 0,
    emailMissing: (inside ? here.email : machine.email).length === 0,
  }
}

/* A value about to become one `git config` argument. Quoting is the shell's
   problem (`shq` handles it); what git itself would misread is a leading dash,
   and what would cut a command in half is a control character. */
function cleanIdentValue(value) {
  const raw = isStr(value) ? value : ''
  const trimmed = raw.trim().slice(0, 200)
  if (trimmed.length === 0) return ''
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (trimmed.charAt(0) === '-') return null
  return trimmed
}

/* Written through git so that everything else on the machine sees it: a terminal,
   IDEA, a hook. The alternative — keeping the pair in this plugin's own config and
   passing `-c user.name=…` to every commit — would make the panel the only tool
   that knows who the author is, which is a worse surprise than the failure it
   fixes.

   `scope` is 'global' (this machine) or 'local' (this repository). Nothing is
   written for a field left empty: `git config user.name ''` is how a reader ends
   up with git's "empty ident name" error in the first place, so an empty box
   means "leave this one alone" rather than "set it to nothing". */
async function identitySave(input) {
  const scope = input != null && input.scope === 'local' ? 'local' : 'global'
  const target = repoFrom(input, null)
  if (scope === 'local' && target === undefined) {
    return { ok: false, error: 'no-path', stderr: '不知道该写进哪个仓库：这个会话没有工作区，也没有指定路径' }
  }
  const name = cleanIdentValue(input != null ? input.name : '')
  const email = cleanIdentValue(input != null ? input.email : '')
  if (name === null || email === null) {
    return { ok: false, error: 'bad-value', stderr: '名字和邮箱里不能有控制字符，也不能以 - 开头' }
  }
  if (name.length === 0 && email.length === 0) {
    return { ok: false, error: 'empty', stderr: '名字和邮箱至少要填一个' }
  }
  const flag = scope === 'local' ? '--local' : '--global'
  /* The sandbox is the session's, and that is decided from `args`: a global write
     has no repository to name, so the session id is what carries the policy. */
  const args = scope === 'local' ? argsAt(input, target) : (input != null && isStr(input.sessionId) ? { sessionId: input.sessionId } : {})
  const written = []
  if (name.length > 0) {
    const one = await git(args, ['config', flag, 'user.name', name], null, {})
    if (one.exitCode !== 0) return { ok: false, error: 'write-failed', field: 'user.name', stderr: one.stderr, stdout: one.stdout, sandboxDenied: one.sandboxDenied === true, noGit: gitMissing(one) }
    written.push('user.name')
  }
  if (email.length > 0) {
    const one = await git(args, ['config', flag, 'user.email', email], null, {})
    if (one.exitCode !== 0) return { ok: false, error: 'write-failed', field: 'user.email', stderr: one.stderr, stdout: one.stdout, sandboxDenied: one.sandboxDenied === true, noGit: gitMissing(one) }
    written.push('user.email')
  }
  /* Read back rather than echo the input: `git config` may have written something
     other than what was typed (a local value being overridden by a higher scope
     is the interesting one), and the page should show what git now answers. The
     read is told which repository to ask about — never left to fall back on the
     Host's own directory (see identitySnapshot). */
  const after = await identitySnapshot({ repo: target, sessionId: input != null ? input.sessionId : undefined })
  return {
    ok: true, scope: scope, written: written, repo: after.repo,
    name: after.name, email: after.email,
    nameOrigin: after.nameOrigin, emailOrigin: after.emailOrigin,
    globalName: after.globalName, globalEmail: after.globalEmail,
    needsIdentity: after.needsIdentity,
  }
}

/* ─────────────── 本项目的 git 配置：身份与换行符 ───────────────

   「提交身份」设置页能写 --global（选机器）也能写 --local（选仓库），但面板属于会
   话、常常在别的仓库上开着；面板的「配置」页要的恰恰是另一件事：**只**管当前这个
   项目 —— 两个身份键之外，git 自己管换行符的两个键（core.autocrlf / core.eol）也
   是同一性质：写进仓库的 .git/config，终端里的 git、IDEA、钩子看到的是同一个答案，
   跟着项目走而不是跟着某台浏览器。

   读法照 identitySnapshot：`--show-origin --get-regexp` 一把同时答「是什么」和「从
   哪个文件来的」，local / global / 生效三把分开问。同一个坑也在：不知道是哪个仓库
   时绝不去问「此刻生效的那份」—— `git config` 按当前目录回答，而当前目录是 dsh 进
   程自己的目录（identitySnapshot 顶部注释里有被 fixture 抓出来的先例），这时只回
   答机器级那份并明说 insideRepo:false。 */

const PROJECT_CONFIG_KEYS = ['user.name', 'user.email', 'core.autocrlf', 'core.eol']
const PROJECT_CONFIG_REGEXP = '^(user\\.(name|email)|core\\.(autocrlf|eol))$'
/* autocrlf 与 eol 的合法值。git 对大小写不挑（`TRUE` 也收），但这份配置的读者是
   人，收进来时就归一成 git 文档里的小写。 */
const AUTOCRLF_VALUES = ['true', 'false', 'input']
const EOL_VALUES = ['lf', 'crlf', 'native']

/* `file:/path<TAB>key value` → { key: {value, origin} }。同一把问询里同一个键出现
   多行时（local 和 global 都写了它），后面那行覆盖前面 —— `--get-regexp` 按配置文
   件的先后顺序打印，git 自己取「生效值」也是取最后一条。 */
function parseProjectConfig(out) {
  const found = {}
  const lines = out.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const rest = line.slice(tab + 1)
    const space = rest.indexOf(' ')
    if (space < 0) continue
    const key = rest.slice(0, space)
    if (PROJECT_CONFIG_KEYS.indexOf(key) < 0) continue
    found[key] = { value: rest.slice(space + 1), origin: line.slice(0, tab) }
  }
  return found
}

/* 一把问询折成「值 + 来源文件」。没配 = 空串；origin 摘成读者能对上号的路径
   （originLabel 与设置页 GitIdentityGroup 的 source() 用的是同一套话）。 */
function projectConfigEntry(raw, key) {
  const one = raw != null ? raw[key] : undefined
  return {
    value: one != null ? one.value : '',
    origin: one != null ? originLabel(one.origin) : '',
  }
}

async function projectConfigSnapshotFrom(input, target, inside) {
  const args = inside ? argsAt(input, target) : {}
  const regexp = ['config', '--show-origin', '--get-regexp', PROJECT_CONFIG_REGEXP]
  /* 与 identitySnapshot 同一条分界：local 与「生效」都是仓库的问题，不知道仓库就
     不问；global 按定义与目录无关，两种情况都问。 */
  const local = inside === true ? await gitC(args, ['config', '--local'].concat(regexp.slice(1)), null, {}) : null
  const global = await gitC(args, ['config', '--global'].concat(regexp.slice(1)), null, {})
  const effective = inside === true ? await gitC(args, regexp, null, {}) : null
  const localMap = local !== null ? parseProjectConfig(local.stdout) : {}
  const globalMap = parseProjectConfig(global.stdout)
  const effectiveMap = effective !== null ? parseProjectConfig(effective.stdout) : {}
  const config = {}
  for (let i = 0; i < PROJECT_CONFIG_KEYS.length; i += 1) {
    const key = PROJECT_CONFIG_KEYS[i]
    const here = projectConfigEntry(localMap, key)
    const machine = projectConfigEntry(globalMap, key)
    /* 生效值不知道仓库可问时就落在 global 那份上（identitySnapshot 的同款口径）：
       没有仓库时生效的本来就是机器那份，界面拿来填 placeholder 正合适。 */
    const now = effective !== null ? projectConfigEntry(effectiveMap, key) : machine
    config[key] = {
      local: here.value, global: machine.value, effective: now.value,
      localOrigin: here.origin, globalOrigin: machine.origin, effectiveOrigin: now.origin,
    }
  }
  return { ok: true, repo: inside ? target : null, insideRepo: inside, config: config }
}

async function projectConfigSnapshot(input) {
  const target = repoFrom(input, null)
  return await projectConfigSnapshotFrom(input, target, target !== undefined)
}

/* 写进本项目的 .git/config。三道门都在写之前过（一部分非法就一个字节都不写，别让
   读者拿到半份改动）：
     · 键白名单就是上面四个 —— 请求里的别的键直接丢掉，不猜；
     · user.* 走 cleanIdentValue（控制字符与前导 - 的规矩见它自己的注释），空 = 这一
       项跳过（`git config user.name ''` 正是「empty ident name」的来路）；
     · autocrlf / eol 只收各自的清单，别的值报错 —— 这两个键写错了不报错的那天，
       git 会拿它把整棵树的换行符改一遍。 */
async function projectConfigSave(input) {
  const target = repoFrom(input, null)
  if (target === undefined) {
    return { ok: false, error: 'no-path', stderr: '不知道该写进哪个仓库：这个会话没有工作区，也没有指定路径' }
  }
  const set = input != null && input.set != null && typeof input.set === 'object' && !Array.isArray(input.set) ? input.set : {}
  const unsetRaw = input != null && Array.isArray(input.unset) ? input.unset : []
  const setKeys = []
  const setValues = {}
  for (let i = 0; i < PROJECT_CONFIG_KEYS.length; i += 1) {
    const key = PROJECT_CONFIG_KEYS[i]
    if (Object.prototype.hasOwnProperty.call(set, key) !== true) continue
    const raw = set[key]
    if (key === 'user.name' || key === 'user.email') {
      const clean = cleanIdentValue(raw)
      if (clean === null) return { ok: false, error: 'bad-value', key: key, stderr: '名字和邮箱里不能有控制字符，也不能以 - 开头' }
      if (clean.length === 0) continue
      setKeys.push(key)
      setValues[key] = clean
      continue
    }
    const wanted = isStr(raw) ? raw.trim().toLowerCase() : ''
    const allowed = key === 'core.autocrlf' ? AUTOCRLF_VALUES : EOL_VALUES
    if (allowed.indexOf(wanted) < 0) {
      return { ok: false, error: 'bad-value', key: key, stderr: key + ' 只接受 ' + allowed.join(' / ') }
    }
    setKeys.push(key)
    setValues[key] = wanted
  }
  const unsetKeys = []
  for (let i = 0; i < unsetRaw.length && unsetKeys.length < PROJECT_CONFIG_KEYS.length; i += 1) {
    const key = unsetRaw[i]
    if (PROJECT_CONFIG_KEYS.indexOf(key) < 0 || unsetKeys.indexOf(key) >= 0) continue
    unsetKeys.push(key)
  }
  if (setKeys.length === 0 && unsetKeys.length === 0) {
    return { ok: false, error: 'empty', stderr: '没有要写也没有要清的键' }
  }
  const args = argsAt(input, target)
  for (let i = 0; i < setKeys.length; i += 1) {
    const key = setKeys[i]
    const one = await git(args, ['config', '--local', key, setValues[key]], null, {})
    if (one.exitCode !== 0) return { ok: false, error: 'write-failed', key: key, stderr: one.stderr, stdout: one.stdout, sandboxDenied: one.sandboxDenied === true, noGit: gitMissing(one) }
  }
  for (let i = 0; i < unsetKeys.length; i += 1) {
    const key = unsetKeys[i]
    const one = await git(args, ['config', '--local', '--unset', key], null, {})
    /* 退出码 5 = 本来就没配（git config(1) 的说法）。「清掉覆盖」要的就是回到没有
       覆盖的状态，本来没有正是目的地，算成功 —— 否则连点两次「用回全局」第二次
       就得报错。 */
    if (one.exitCode !== 0 && one.exitCode !== 5) return { ok: false, error: 'unset-failed', key: key, stderr: one.stderr, stdout: one.stdout, sandboxDenied: one.sandboxDenied === true, noGit: gitMissing(one) }
  }
  /* 读回来而不是回显输入（identitySave 同一个原则）：写进去的值 git 怎么归一的、
     生效的那份现在是谁，都以此刻的问询为准。 */
  const after = await projectConfigSnapshotFrom(input, target, true)
  return Object.assign({ written: setKeys, unset: unsetKeys }, after)
}
