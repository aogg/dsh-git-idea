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

   「提交身份」在配置页有两档：全局档能写 --global（选机器）也能写 --local（选仓
   库），项目档属于会话、常常开在别的仓库上，要的恰恰是另一件事：**只**管当前这个
   项目 —— 两个身份键之外，git 自己管换行符的两个键（core.autocrlf / core.safecrlf）也
   是同一性质：写进仓库的 .git/config，终端里的 git、IDEA、钩子看到的是同一个答案，
   跟着项目走而不是跟着某台浏览器。

   读法照 identitySnapshot：`--show-origin --get-regexp` 一把同时答「是什么」和「从
   哪个文件来的」，local / global / 生效三把分开问。同一个坑也在：不知道是哪个仓库
   时绝不去问「此刻生效的那份」—— `git config` 按当前目录回答，而当前目录是 dsh 进
   程自己的目录（identitySnapshot 顶部注释里有被 fixture 抓出来的先例），这时只回
   答机器级那份并明说 insideRepo:false。 */

const PROJECT_CONFIG_KEYS = ['user.name', 'user.email', 'core.autocrlf', 'core.safecrlf']
const PROJECT_CONFIG_REGEXP = '^(user\\.(name|email)|core\\.(autocrlf|safecrlf))$'
/* autocrlf 与 safecrlf 的合法值。git 对大小写不挑（`TRUE` 也收），但这份配置的读者是
   人，收进来时就归一成 git 文档里的小写。 */
const AUTOCRLF_VALUES = ['true', 'false', 'input']
/* safecrlf 的合法值，git 的语义是给换行转换把关：转换不可逆（行尾抹过一遍还原不回
   去、真丢字）时，true 让 git 拒绝这次操作、warn 只警告照做、false 不把关。它在这里
   接替 core.eol，是因为 eol 只挑工作区存哪种行尾、拦不住转换本身丢字，把关的活归
   safecrlf。 */
const SAFECRLF_VALUES = ['true', 'false', 'warn']

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
   （originLabel 与全局配置 GitIdentityGroup 的 source() 用的是同一套话）。 */
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
     · autocrlf / safecrlf 只收各自的清单，别的值报错 —— 这两个键写错了不报错的那天，
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
    const allowed = key === 'core.autocrlf' ? AUTOCRLF_VALUES : SAFECRLF_VALUES
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

/* ─────────────── 换行符的全局档：只写 --global ───────────────

   换行符那两个键还有第二个家：~/.gitconfig。项目档（上一节）答的是「这个仓库怎么
   办」，全局档答的是「这台机器默认怎么办」—— 没有自己的答案的仓库都吃这一份。它
   没有项目档那三把问询：local 与「生效」都是仓库的问题，跟 ~/.gitconfig 无关，而
   --global 按定义与目录无关（identitySnapshot 里 global 那把问询的同一句话），所以
   读不需要仓库；写也没有「写进哪个仓库」的门 —— 沙箱策略只能来自会话（identitySave
   的 global 分支同一个先例）。 */

const GLOBAL_CONFIG_KEYS = ['core.autocrlf', 'core.safecrlf']
const GLOBAL_CONFIG_REGEXP = '^(core\\.(autocrlf|safecrlf))$'

/* 全局档快照：一把 `--global --show-origin --get-regexp` 同时答「是什么」和「从哪个
   文件来的」，输出照 parseProjectConfig 拆（键集是项目档的子集，同一套拆法与覆盖
   规则）。没配 = 空串，origin 摘成读者能对上号的路径（originLabel，projectConfigEntry
   同一口径）。 */
async function globalConfigSnapshot(input) {
  const args = input != null && isStr(input.sessionId) ? { sessionId: input.sessionId } : {}
  const one = await gitC(args, ['config', '--global', '--show-origin', '--get-regexp', GLOBAL_CONFIG_REGEXP], null, {})
  const raw = parseProjectConfig(one.stdout)
  const config = {}
  for (let i = 0; i < GLOBAL_CONFIG_KEYS.length; i += 1) {
    const key = GLOBAL_CONFIG_KEYS[i]
    const entry = raw[key]
    config[key] = {
      global: entry != null ? entry.value : '',
      globalOrigin: entry != null ? originLabel(entry.origin) : '',
    }
  }
  return { ok: true, config: config }
}

/* 写进 ~/.gitconfig。三道门照 projectConfigSave 的次序与措辞，全在写之前过（一部分
   非法就一个字节都不写，别让读者拿到半份改动）：
     · 键白名单只收 GLOBAL_CONFIG_KEYS 两个 —— 请求里的别的键直接丢掉，不猜；
     · 值 trim + 归一成小写后只收各自的清单（AUTOCRLF_VALUES / SAFECRLF_VALUES），
       别的值报 bad-value —— 全局这份管着所有没自答的仓库，写错波及的面更大；
     · set 与 unset 全空报 empty —— 一个字节都不写。
   写是 `git config --global <key> <value>`，清是 --unset。沙箱参数照 identitySave 的
   global 分支：有 sessionId 就带上 —— 全局写没有仓库可指名，会话是唯一能说出该用
   哪份写策略的东西。 */
async function globalConfigSave(input) {
  const set = input != null && input.set != null && typeof input.set === 'object' && !Array.isArray(input.set) ? input.set : {}
  const unsetRaw = input != null && Array.isArray(input.unset) ? input.unset : []
  const setKeys = []
  const setValues = {}
  for (let i = 0; i < GLOBAL_CONFIG_KEYS.length; i += 1) {
    const key = GLOBAL_CONFIG_KEYS[i]
    if (Object.prototype.hasOwnProperty.call(set, key) !== true) continue
    const wanted = isStr(set[key]) ? set[key].trim().toLowerCase() : ''
    const allowed = key === 'core.autocrlf' ? AUTOCRLF_VALUES : SAFECRLF_VALUES
    if (allowed.indexOf(wanted) < 0) {
      return { ok: false, error: 'bad-value', key: key, stderr: key + ' 只接受 ' + allowed.join(' / ') }
    }
    setKeys.push(key)
    setValues[key] = wanted
  }
  const unsetKeys = []
  for (let i = 0; i < unsetRaw.length && unsetKeys.length < GLOBAL_CONFIG_KEYS.length; i += 1) {
    const key = unsetRaw[i]
    if (GLOBAL_CONFIG_KEYS.indexOf(key) < 0 || unsetKeys.indexOf(key) >= 0) continue
    unsetKeys.push(key)
  }
  if (setKeys.length === 0 && unsetKeys.length === 0) {
    return { ok: false, error: 'empty', stderr: '没有要写也没有要清的键' }
  }
  const args = input != null && isStr(input.sessionId) ? { sessionId: input.sessionId } : {}
  for (let i = 0; i < setKeys.length; i += 1) {
    const key = setKeys[i]
    const one = await git(args, ['config', '--global', key, setValues[key]], null, {})
    if (one.exitCode !== 0) return { ok: false, error: 'write-failed', key: key, stderr: one.stderr, stdout: one.stdout, sandboxDenied: one.sandboxDenied === true, noGit: gitMissing(one) }
  }
  for (let i = 0; i < unsetKeys.length; i += 1) {
    const key = unsetKeys[i]
    const one = await git(args, ['config', '--global', '--unset', key], null, {})
    /* 退出码 5 = 本来就没配（git config(1) 的说法）。「清掉」要的就是回到没有的状态，
       本来没有正是目的地，算成功 —— projectConfigSave 的同一条注释。 */
    if (one.exitCode !== 0 && one.exitCode !== 5) return { ok: false, error: 'unset-failed', key: key, stderr: one.stderr, stdout: one.stdout, sandboxDenied: one.sandboxDenied === true, noGit: gitMissing(one) }
  }
  /* 读回来而不是回显输入（identitySave / projectConfigSave 的同一个原则）：写进去的
     值 git 怎么记下的，以此刻的问询为准。 */
  const after = await globalConfigSnapshot(input)
  return Object.assign({ written: setKeys, unset: unsetKeys }, after)
}

/* ─────────────── 远端：面板「配置」页的第四组 ───────────────

   「提交身份」「换行符」两组管 .git/config 里的键，远端其实也是同一个文件里的东西
   （[remote "origin"] url = …），但它有自己的专用命令（git remote add / set-url /
   remove），会把 fetchurl、pushurl、mirror 一起收拾好 —— 让读者直接改 config 文本
   等于要他先懂这些。所以读写都走 `git remote`：读是 `git remote -v`，写是三条子命令。

   读法的分界照 projectConfigSnapshot（上一节）：repoFrom / argsAt / insideRepo ——
   不知道是哪个仓库（会话没有工作区）时绝不去问「此刻生效的那份」，`git remote -v`
   按当前目录回答，而当前目录是 dsh 进程自己的目录。 */

/* `origin\thttps://… (fetch)` 一行拆成名字与地址：末尾的 (fetch)/(push) 是 git 自己
   写死的标记，掐掉之后剩下的「名字 + 一段空白 + 地址」从第一段空白切成两半。同一个
   远端占两行（fetch 一行 push 一行，配过多条 pushurl 的还会更多），按名字合并成
   一条记录。 */
function parseRemotes(out) {
  const list = []
  const seen = {}
  const lines = out.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+$/, '')
    if (line.length === 0) continue
    const isFetch = line.slice(-8) === ' (fetch)'
    const isPush = line.slice(-7) === ' (push)'
    if (isFetch !== true && isPush !== true) continue
    const rest = line.slice(0, line.length - (isFetch ? 8 : 7))
    const gap = rest.search(/\s/)
    if (gap < 0) continue
    const name = rest.slice(0, gap)
    const url = rest.slice(gap).replace(/^\s+/, '')
    if (name.length === 0 || url.length === 0) continue
    let row = seen[name]
    if (row === undefined) {
      row = { name: name, url: '', pushUrl: '' }
      seen[name] = row
      list.push(row)
    }
    if (isFetch) row.url = url
    else row.pushUrl = url
  }
  /* push 与 fetch 相同时 pushUrl 给空串：界面只在真的不同时才多说一句。 */
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].pushUrl === list[i].url) list[i].pushUrl = ''
  }
  return list
}

async function remotesSnapshot(input) {
  const target = repoFrom(input, null)
  if (target === undefined) {
    return { ok: true, repo: null, insideRepo: false, remotes: [] }
  }
  const listed = await gitC(argsAt(input, target), ['remote', '-v'], null, {})
  if (listed.exitCode !== 0) {
    /* 不在仓库里不算失败，算「这一组没得管」（ok:true + insideRepo:false + 空表）：
       gitC 固定 LC_ALL=C（10-shell.js），git 那句 not a git repository 认得出来。
       其余的失败（沙箱拒了、git 缺了）才照失败答，原话带给界面。 */
    if (listed.stderr.indexOf('not a git repository') >= 0) {
      return { ok: true, repo: target, insideRepo: false, remotes: [] }
    }
    return { ok: false, repo: target, insideRepo: false, error: 'remote-failed', stderr: listed.stderr, stdout: listed.stdout, noGit: gitMissing(listed) }
  }
  return { ok: true, repo: target, insideRepo: true, remotes: parseRemotes(listed.stdout) }
}

/* 远端名与地址即将成为一条 git 命令的参数。argv 是数组、不过 shell（panelMutate），
   切不开命令；要挡的是 git 自己会误读的形状 —— 控制字符与前导 -（cleanIdentValue
   的同一套规矩，见本文件上面），上限分别放宽到远端名与 URL 该有的长度。名字另外拒
   一切空白：它要进 config 当节名（remote.<name>.*），git 自己也不收带空白的名字。 */
function cleanRemoteName(value) {
  const raw = isStr(value) ? value : ''
  const trimmed = raw.trim().slice(0, 300)
  if (trimmed.length === 0) return ''
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (/\s/.test(trimmed)) return null
  if (trimmed.charAt(0) === '-') return null
  return trimmed
}

function cleanRemoteUrl(value) {
  const raw = isStr(value) ? value : ''
  const trimmed = raw.trim().slice(0, 2000)
  if (trimmed.length === 0) return ''
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (trimmed.charAt(0) === '-') return null
  return trimmed
}

/* 一次一个动作：add = git remote add，setUrl = git remote set-url，remove = git
   remote remove。三条都走 panelMutate —— 远端表是仓库自己的东西，fetch / pull /
   push 都吃它，与 stage / pull 同一条变更路（进「命令」页、失效读缓存），这点和
   project-config-save「不进命令页」不同。写完读回来而不是回显输入（projectConfigSave
   的同一个原则）：git 怎么记下的、此刻清单里还有谁，以答复里那份重新读出的表为准。 */
async function remotesSave(input) {
  const target = repoFrom(input, null)
  if (target === undefined) {
    return { ok: false, error: 'no-path', stderr: '不知道该改哪个仓库：这个会话没有工作区，也没有指定路径' }
  }
  const shape = function (key) {
    const one = input != null && input[key] != null && typeof input[key] === 'object' && !Array.isArray(input[key]) ? input[key] : null
    return one
  }
  const add = shape('add')
  const setUrl = shape('setUrl')
  const remove = shape('remove')
  const given = (add !== null ? 1 : 0) + (setUrl !== null ? 1 : 0) + (remove !== null ? 1 : 0)
  if (given !== 1) {
    return { ok: false, error: 'bad-request', stderr: 'add / setUrl / remove 三个动作一次只能给一个' }
  }
  const kind = add !== null ? 'add' : (setUrl !== null ? 'setUrl' : 'remove')
  const holder = kind === 'add' ? add : (kind === 'setUrl' ? setUrl : remove)
  const name = cleanRemoteName(holder != null ? holder.name : '')
  if (name === null) {
    return { ok: false, error: 'bad-value', stderr: '远端名不能有空白和控制字符，也不能以 - 开头' }
  }
  if (name.length === 0) {
    return { ok: false, error: 'bad-value', stderr: '远端名不能为空' }
  }
  let url = ''
  if (kind !== 'remove') {
    const clean = cleanRemoteUrl(holder != null ? holder.url : '')
    if (clean === null) {
      return { ok: false, error: 'bad-value', stderr: '地址不能有控制字符，也不能以 - 开头' }
    }
    if (clean.length === 0) {
      return { ok: false, error: 'bad-value', stderr: '地址不能为空' }
    }
    url = clean
  }
  const argv = kind === 'add' ? ['remote', 'add', name, url]
    : (kind === 'setUrl' ? ['remote', 'set-url', name, url] : ['remote', 'remove', name])
  const said = kind === 'add' ? '添加远端' : (kind === 'setUrl' ? '修改远端地址' : '删除远端')
  const done = await panelMutate(input, argv, { desc: said })
  if (done.ok !== true) return done
  const after = await remotesSnapshot({ repo: target, sessionId: input != null ? input.sessionId : undefined })
  return Object.assign({ action: kind, name: name }, after)
}
