/* ─────────────── git worktree（只读清单）─────────────── */

/* 「工作树」块（客户端 25-worktree.js）的数据：一份 `git worktree list --porcelain`
   的翻译，口径收窄成只含 `git worktree add` 出来的链接工作区 —— 主工作区（porcelain
   的第一条记录，git 保证它排第一）与 bare 记录（也只会是主仓库）解析完即丢，不发给
   客户端。v1 是纯只读的：面板把它画出来，最多允许单击把历史按那个 worktree 的分支
   过滤 —— 不 checkout、不 prune、不碰任何 worktree 的工作区。这条边界在 Host 这一层
   就守住了：这里只有一条读命令，没有任何写路径。

   走 refsSnapshot 同一套按仓库读缓存：cached(repo, 'worktrees', …) 的寿命与
   for-each-ref 那份完全相同，任何一次整仓失效（panelMutate、⟳ 的 flush、以及
   worktree 增删本身 —— 那也是对仓库的改动，watcher bump 后重读）都把它一起作废。
   因此不另立过期机制，客户端也不用理解第二种缓存语义。

   porcelain 的形状：记录之间以空行分隔；每行 `关键字 值`，值原样保留（路径可能带
   空格，取关键字之后的整行）。locked / prunable 只在成立时出现，且可以不带原因
   （光一个 `locked` 或 `prunable` 独占一行）；branch 给的是全名（refs/heads/x），
   这里剥成短名；detached 的记录没有 branch 行；bare 的记录只有 worktree / bare 两行
   —— 它和第一条主工作区一样属于旧口径的弃子，这里仍照原样解析，丢在下面统一做。 */
/* porcelain 的解析本体：记录之间以空行分隔；每行 `关键字 值`，值原样保留（路径
   可能带空格，取关键字之后的整行）。locked / prunable 只在成立时出现，且可以不带
   原因（光一个 `locked` 或 `prunable` 独占一行）；branch 给的是全名（refs/heads/x），
   这里剥成短名；detached 的记录没有 branch 行；bare 的记录只有 worktree / bare 两行
   —— 它和第一条主工作区一样属于旧口径的弃子，这里仍照原样解析，丢在调用方统一做。
   下面的 worktree 块（git/worktrees）与 git 忽略项扫描（本文件下半）共用这一份。 */
function parseWorktreeRows(stdout) {
  const out = []
  let row = null
  const lines = String(stdout).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    /* 空行是记录的分隔符；下一条 `worktree ` 行自己会开新记录，这里只把当前指针放下。 */
    if (line.length === 0) { row = null; continue }
    if (line.indexOf('worktree ') === 0) {
      row = {
        path: line.slice(9),
        head: '', branch: '',
        detached: false, bare: false,
        locked: false, lockReason: '',
        prunable: false, pruneReason: '',
      }
      out.push(row)
      continue
    }
    if (row === null) continue
    if (line.indexOf('HEAD ') === 0) row.head = line.slice(5)
    else if (line.indexOf('branch ') === 0) {
      const full = line.slice(7)
      row.branch = full.indexOf('refs/heads/') === 0 ? full.slice(11) : full
    }
    else if (line === 'detached') row.detached = true
    else if (line === 'bare') row.bare = true
    else if (line.indexOf('locked') === 0) { row.locked = true; row.lockReason = line.length > 6 ? line.slice(7) : '' }
    else if (line.indexOf('prunable') === 0) { row.prunable = true; row.pruneReason = line.length > 8 ? line.slice(9) : '' }
  }
  return out
}

async function readWorktrees(input, repo) {
  const args = argsFor(input)
  /* gitC + core.quotePath=false（66-refs.js readRefs 同一组合）：porcelain 的关键字
     本身不会被翻译，但 locked 的原因会按 quotePath 规则把非 ASCII 原因引成八进制
     （实测：`locked "\345\217\230..."`），关掉它 tooltip 里才是人话。 */
  const listed = await gitC(args, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], null, {})
  if (listed.exitCode !== 0) {
    return { ok: false, repo: repo === undefined ? null : repo, error: 'not-a-repository', stderr: listed.stderr, noGit: gitMissing(listed), worktrees: [] }
  }
  const out = parseWorktreeRows(listed.stdout)
  /* 新口径：只留 `git worktree add` 出来的链接工作区。git 保证 `worktree list`
     把主工作区排成第一条记录，直接丢头一条；bare 记录只会是主仓库（bare 的仓库
     没有工作区，add 不出来），一并丢。detached / prunable / locked 的链接工作区
     保留 —— 它们同样是 worktree add 出来的，客户端已有对应的灰行与不可点逻辑。 */
  const linked = []
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].bare === true) continue
    linked.push(out[i])
  }
  return { ok: true, repo: listed.cwd, worktrees: linked }
}

/* 与 refsSnapshot 同款的外壳：请求没点名仓库就按会话工作区直接读（git 自己会落到
   那个目录），点名了就走读缓存。 */
async function worktreesSnapshot(input) {
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readWorktrees(input, undefined)
  return await cached(repo, 'worktrees', function () { return readWorktrees(input, repo) })
}

/* ─────────────── worktree 的主目录（读 + 配置）─────────────── */

/* 「这个 worktree 属于哪个主仓库」的读数（git/wt-main）与配置（git/wt-main-save）。

   背景（真机实测）：dsh 把一个 worktree 目录当会话工作区打开时，目录里的 .git 是
   一个**文件**（gitlink，内容 `gitdir: <主目录>/.git/worktrees/<名>`）。主仓库被删
   /搬走后 rev-parse 直接失败（fatal: not a git repository），而 62-panel.js 的
   repoHere 只判 `[ -e dir/.git ]` —— 判真，git 却读不动，面板于是落到说明页的
   'not-a-repo'，那一页 editable:false：读者既看不出这是 worktree，也没有任何地方
   能把「主目录现在在哪」告诉面板。这两条 RPC 就是补那个洞：读的那条把目录身份
   （linked / main / bare / plain / broken-gitlink / missing / file）、gitlink 原文、
   git 与文件系统各答的主目录候选一次带回；写的那条把读者纠正过的主目录存进插件
   配置（70-config.js 的 worktreeMains，按 worktree 绝对路径一钩一份），下次读数
   的 mainSource 就是 'config'，git 那头死活都不影响面板认路。

   边界（one directory, no discovery，62-panel.js 的教条）：只看 target 这**一个**
   目录，绝不向上找父目录 —— git rev-parse 在非仓库目录里会替你找爸爸，答出另一个
   项目的分支，所以 git 那一半全部用 `-C <target>` 显式钉死；gitlink 的文本解析也
   只匹配 `^(.*)/\.git/worktrees/[^/]+$` 这一种形状，配不上就 null，不猜。 */

/* 一次 spawn 答完所有问题（62-panel.js pathShell 同款的多路复用 stdout 标记风格；
   通道一次只跑一个处理函数，两趟便宜的不如一趟全的）。分段：
     K:   目标存在性（dir/file/none，口径同 pathShell）
     GT:  .git 的类型（dir=目录 / file=gitlink / none=没有）
     G:   gitlink 文件的第一行原文（只有 GT:file 才有）
     AM:  从 gitlink 文本解出的主目录候选（`^(.*)/\.git/worktrees/[^/]+$` 第 1 组）
     AC:  [ -e "$AM/.git" ] 的答案（broken-gitlink 时 mainOk 的依据）
     MC:  [ -e "<配置里记的主目录>/.git" ] 的答案（只在配置里真有值时才发这一行）
     N:   机器上没有 git（PANEL_NO_GIT 同一个标记字）
     GD:  `git rev-parse --absolute-git-dir` 的答案；GRC: 带出它的退出码
     CD:  `--path-format=absolute --git-common-dir`，失败退化 `--git-common-dir`
          后手动绝对化（老 git 不认 --path-format，实测 2.25 一类直接报 unknown
          option，stdout 为空正好落进退化分支）
     LC:  CD 去尾部 /.git 之后的那个目录 [ -e <它>/.git ] 的答案（linked 时 mainOk）
     TL:  `git rev-parse --show-toplevel` 的答案（bare 仓库没有，空串）
     WT-BEGIN … WT-END:<rc>：`git worktree list --porcelain` 的原文（porcelain 的
          行只会以 worktree /HEAD /branch /bare /detached /locked /prunable 开头或
          为空，撞不上上面任何标记；rc 非 0 整段作废）。
   git 那一半只在「目录存在且里面有 .git」时才跑（missing/file/plain 不必跑，省
   一趟；file 目标里不可能有 .git，条件自然盖住）。git 的报错走 stderr 原样带回，
   不 2>&1 混进值里。 */
function wtMainProbeCommand(target, configured) {
  const lines = [
    'T=' + shq(target),
    'if [ -d "$T" ]; then printf \'K:dir\\n\'',
    'elif [ -f "$T" ]; then printf \'K:file\\n\'',
    'else printf \'K:none\\n\'',
    'fi',
    'gt=\'\'',
    'if [ -d "$T/.git" ]; then gt=\'dir\'; printf \'GT:dir\\n\'',
    'elif [ -f "$T/.git" ]; then gt=\'file\'; printf \'GT:file\\n\'',
    'else gt=\'none\'; printf \'GT:none\\n\'',
    'fi',
    'am=\'\'',
    'if [ "$gt" = \'file\' ]; then',
    '  gl=$(head -n 1 "$T/.git" 2>/dev/null)',
    '  printf \'G:%s\\n\' "$gl"',
    '  q=\'\'',
    '  case "$gl" in',
    '    \'gitdir: \'*) p=${gl#gitdir: }',
    '      case "$p" in */*) q=${p%/*} ;; esac',
    '    ;;',
    '  esac',
    '  case "$q" in */.git/worktrees) am=${q%/.git/worktrees} ;; esac',
    'fi',
    'printf \'AM:%s\\n\' "$am"',
    'if [ -n "$am" ] && [ -e "$am/.git" ]; then printf \'AC:1\\n\'; else printf \'AC:0\\n\'; fi',
  ]
  /* 配置里的主目录是「读者亲自纠正过的答案」：它的存在性必须按它自己验，不能拿
     gitlink 推出来的候选冒充 —— 两者完全可以不同（主仓库搬走后配置指向新家）。 */
  if (isStr(configured) && configured.length > 0) {
    lines.push('if [ -e ' + shq(configured) + '/.git ]; then printf \'MC:1\\n\'; else printf \'MC:0\\n\'; fi')
  }
  lines.push(
    'if command -v ' + gitCmd() + ' >/dev/null 2>&1; then',
    '  if [ "$gt" != \'none\' ]; then',
    '    gd=$(' + gitCmd() + ' -C "$T" rev-parse --absolute-git-dir 2>/dev/null); grc=$?',
    '    printf \'GD:%s\\n\' "$gd"',
    '    printf \'GRC:%s\\n\' "$grc"',
    '    cdp=$(' + gitCmd() + ' -C "$T" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)',
    '    case "$cdp" in',
    '      /*) ;;',
    '      \'\')',
    '        cdp=$(' + gitCmd() + ' -C "$T" rev-parse --git-common-dir 2>/dev/null)',
    '        case "$cdp" in /*) ;; \'\') ;; *) cdp="$T/$cdp" ;; esac',
    '      ;;',
    '      *) cdp="$T/$cdp" ;;',
    '    esac',
    '    printf \'CD:%s\\n\' "$cdp"',
    '    lm=\'\'',
    '    case "$cdp" in */.git) lm=${cdp%/.git} ;; esac',
    '    if [ -n "$lm" ] && [ -e "$lm/.git" ]; then printf \'LC:1\\n\'; else printf \'LC:0\\n\'; fi',
    '    tl=$(' + gitCmd() + ' -C "$T" rev-parse --show-toplevel 2>/dev/null)',
    '    printf \'TL:%s\\n\' "$tl"',
    '    if [ "$grc" = \'0\' ]; then',
    '      printf \'WT-BEGIN\\n\'',
    '      ' + gitCmd() + ' -C "$T" -c core.quotePath=false worktree list --porcelain',
    '      printf \'WT-END:%s\\n\' "$?"',
    '    fi',
    '  fi',
    'else',
    '  printf \'N:nogit\\n\'',
    'fi',
    'exit 0',
  )
  return lines.join('\n')
}

/* kind 判定与答复的拼装（wtMainProbeCommand 的 stdout → 答复）。固定口径：
     · target 非目录 → 'missing'（是文件 → 'file'）——都到不了 git 那一段；
     · .git 是目录 → 'main'（mainDir auto=target；不需要 git 认同）；
     · .git 是文件且 git 读得动：commonDir === gitdir → 'main'（子模块就是这种，
       主目录=它自己）；commonDir 以 /.git 结尾 → 'linked'（mainDir auto = 去掉
       尾巴的那段）；否则 → 'bare'（mainDir auto=null）；
     · .git 是文件但 git 读不动（命令不存在 / rev-parse 失败）→ 'broken-gitlink'
       （mainDir auto = gitlink 文本配得上的第 1 组，配不上=null）；
     · 目录在、里面没有 .git → 'plain'。
   绝不向上找父目录；mainDir = 配置里的 ?? 自动找到的，mainSource 相应取
   'config'/'auto'，两边都没有就 null。 */
async function readWtMain(input, repo) {
  const target = repo === undefined || repo === null ? sessionWorkdir(input) : repo
  const empty = { kind: 'missing', gitlink: '', gitdir: '', commonDir: '', toplevel: '',
    mainDir: null, mainSource: null, configured: null, mainOk: false, worktrees: [], gitMissing: false, stderr: '' }
  if (!isStr(target) || target.length === 0) {
    return Object.assign({ ok: false, error: 'no-path', repo: null }, empty)
  }
  const config = await readConfigFile()
  const raw = config != null && config.worktreeMains != null ? config.worktreeMains[repoKeyOf(target)] : undefined
  const configured = isStr(raw) && raw.trim().length > 0 ? raw.trim() : null
  /* cwd 是会话自己的工作区，不是被探测的路径 —— 目标不存在时 spawn 本身会先死，
     62-panel.js probeShell 的同一条规矩。 */
  const probe = await probeShell(input, wtMainProbeCommand(target, configured))
  if (probe.exitCode !== 0 && probe.stdout.length === 0) {
    return Object.assign({ ok: false, error: 'probe-failed', repo: target }, empty,
      { stderr: probe.stderr.slice(0, 400), sandboxDenied: probe.sandboxDenied === true })
  }

  let dirKind = 'none'
  let gitType = 'none'
  let gitlink = ''
  let autoFromGitlink = ''
  let autoFromGitlinkOk = false
  let configuredOk = false
  let gitdir = ''
  let gitRc = -1
  let commonDir = ''
  let linkedOk = false
  let toplevel = ''
  let gitMissing = false
  let porcelain = null
  let porcelainOpen = false
  let porcelainRc = -1
  const rows = probe.stdout.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (porcelainOpen) {
      if (row.indexOf('WT-END:') === 0) { porcelainRc = parseInt(row.slice(7), 10) || 0; porcelainOpen = false }
      else if (porcelain !== null) porcelain.push(row)
      continue
    }
    if (row.indexOf('K:') === 0) dirKind = row.slice(2)
    else if (row.indexOf('GT:') === 0) gitType = row.slice(3)
    else if (row.indexOf('G:') === 0) gitlink = row.slice(2)
    else if (row.indexOf('AM:') === 0) autoFromGitlink = row.slice(3)
    else if (row === 'AC:1') autoFromGitlinkOk = true
    else if (row === 'MC:1') configuredOk = true
    else if (row.indexOf('GD:') === 0) gitdir = row.slice(3)
    else if (row.indexOf('GRC:') === 0) gitRc = parseInt(row.slice(4), 10)
    else if (row.indexOf('CD:') === 0) commonDir = row.slice(3)
    else if (row === 'LC:1') linkedOk = true
    else if (row.indexOf('TL:') === 0) toplevel = row.slice(3)
    else if (row === 'N:nogit') gitMissing = true
    else if (row === 'WT-BEGIN') { porcelain = []; porcelainOpen = true }
  }

  const gitReadable = gitMissing !== true && gitRc === 0 && gitdir.length > 0
  let kind = 'plain'
  let autoMain = null
  let autoOk = false
  if (dirKind === 'file') kind = 'file'
  else if (dirKind !== 'dir') kind = 'missing'
  else if (gitType === 'dir') { kind = 'main'; autoMain = target; autoOk = true }
  else if (gitType === 'file') {
    if (!gitReadable) {
      kind = 'broken-gitlink'
      if (autoFromGitlink.length > 0) { autoMain = autoFromGitlink; autoOk = autoFromGitlinkOk }
    } else if (commonDir.length > 0 && commonDir === gitdir) {
      /* 子模块：gitlink 指向的 modules 目录就是它唯一的版本库，commonDir 与
         gitdir 重合 —— 它自己就是「主目录」。 */
      kind = 'main'; autoMain = target; autoOk = true
    } else {
      const linked = commonDir.slice(-5) === '/.git' ? commonDir.slice(0, -5) : ''
      if (linked.length > 0) { kind = 'linked'; autoMain = linked; autoOk = linkedOk }
      else kind = 'bare'
    }
  }

  let mainDir = null
  let mainSource = null
  let mainOk = false
  if (configured !== null) { mainDir = configured; mainSource = 'config'; mainOk = configuredOk }
  else if (autoMain !== null) { mainDir = autoMain; mainSource = 'auto'; mainOk = autoOk }

  /* worktrees 只在 kind 为 linked/main 且 git 读得动时解析（broken-gitlink 恒空，
     其余 kind 根本没跑 git）；main 按自动找到的主目录标（配置里改过的不参与 ——
     这一列描述的是 git 自己认的账，配置是面板认的账，两本都如实带回）。reason 把
     locked / prunable 的原因折成一句话（契约的行形状就这八个字段）。 */
  const worktrees = []
  if ((kind === 'linked' || kind === 'main') && gitReadable && porcelain !== null && porcelainRc === 0) {
    const listed = parseWorktreeRows(porcelain.join('\n'))
    for (let i = 0; i < listed.length; i += 1) {
      const row = listed[i]
      worktrees.push({
        path: row.path, head: row.head, branch: row.branch,
        detached: row.detached === true, bare: row.bare === true,
        locked: row.locked === true,
        reason: row.locked === true ? row.lockReason : (row.prunable === true ? row.pruneReason : ''),
        main: row.path === autoMain,
        current: row.path === target,
      })
    }
  }

  return Object.assign({ ok: true, repo: target }, empty, {
    kind: kind, gitlink: gitlink, gitdir: gitdir, commonDir: commonDir, toplevel: toplevel,
    mainDir: mainDir, mainSource: mainSource, configured: configured, mainOk: mainOk,
    worktrees: worktrees, gitMissing: gitMissing, stderr: probe.stderr.slice(0, 400),
  })
}

/* git/wt-main 的外壳：读缓存按仓库一格（tag 'wt-main'），寿命与 refs / worktrees
   同一条 —— 任何一次整仓失效（panelMutate、⟳ 的 flush、watcher bump）都把它一起
   作废；只有 saveWorktreeMain 自己会在写完配置后按 tag 精确作废这一格（它改的是
   面板认的那本账，git 一根汗毛没动，整仓失效是浪费）。 */
async function wtMainSnapshot(input) {
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readWtMain(input, undefined)
  return await cached(repo, 'wt-main', function () { return readWtMain(input, repo) })
}

/* git/wt-main-save：把「这个 worktree 的主目录在哪」写进插件配置（70-config.js 的
   worktreeMains），答复是该 worktree 的最新 wtMainSnapshot —— 客户端一次往返就能
   把整块读数换成新账。写法仿 61-repos.js 的 saveWorkspaceRepo：readConfigFile 拿
   到的已是归一化过的整份配置，只动 worktreeMains 这一个键（add 设值 / remove 删键），
   其余键原样带过去，谁也抹不掉谁。
   校验：add 与 remove 二选一（都给/都不给都是错）；repo 缺省=会话工作区，add 与
   repo 都必须绝对路径；add 用与手动登记同一判据 `[ -e add/.git ]` 现场验（目录或
   gitlink 文件都算 —— 主仓库自己也可以是另一个 worktree 的主），不存在是 'missing'、
   在了但不是仓库是 'not-a-repository'。同值不写盘：重复保存不该真碰一次磁盘。 */
async function saveWorktreeMain(input) {
  const add = input != null && isStr(input.add) ? input.add.trim() : ''
  const remove = input != null && input.remove === true
  if ((add.length > 0) === remove) {
    return { ok: false, error: 'exactly one of add or remove is required' }
  }
  const repo = input != null && isStr(input.repo) && input.repo.trim().length > 0 ? input.repo.trim() : (sessionWorkdir(input) || '')
  if (repo.length === 0) return { ok: false, error: 'no-path' }
  if (repo.charAt(0) !== '/') return { ok: false, error: 'absolute path required', path: repo }
  const key = repoKeyOf(repo)
  const config = await readConfigFile()
  const mains = Object.assign({}, config.worktreeMains)
  if (add.length > 0) {
    if (add.charAt(0) !== '/') return { ok: false, error: 'absolute path required', path: add }
    if (mains[key] !== add) {
      const check = await probeShell(input, 'if [ -e ' + shq(add) + '/.git ]; then echo repo; elif [ -d ' + shq(add) + ' ]; then echo norepo; else echo none; fi')
      const kind = check.stdout.trim()
      if (kind === 'none') return { ok: false, error: 'missing', path: add }
      if (kind !== 'repo') return { ok: false, error: 'not-a-repository', path: add }
      mains[key] = add
      const written = await writeConfigFile(Object.assign({}, config, { worktreeMains: mains }), argsAt(input, null))
      if (written.ok !== true) return written
    }
  } else {
    if (mains[key] !== undefined) {
      delete mains[key]
      const written = await writeConfigFile(Object.assign({}, config, { worktreeMains: mains }), argsAt(input, null))
      if (written.ok !== true) return written
    }
  }
  /* 只作废这一格再读：git 那头没动，refs / worktrees / 图的缓存都还是新账。 */
  invalidateRepo(repo, ['wt-main'])
  return await wtMainSnapshot(Object.assign({}, input, { repo: repo }))
}


/* ─────────────── git 忽略项扫描（只读，多仓库 × 多 worktree）─────────────── */

/* 配置页「仓库」组里「git 忽略项」分组的数据（80-panel.js GitIgnoredScanGroup）。
   与上面的 worktree 块不是一回事：那边只描述当前生效仓库，这份扫描一次吃下客户端
   shown 清单里的**全部仓库**（工作区扫到 + 手动登记，missing 不在列），并逐仓库
   枚举它的**全部工作树** —— 被忽略的文件是工作树局部的（.gitignore 站在工作树里，
   被忽略的产物也只存在于某棵工作树），不逐工作树问，链接工作树里的忽略项会整个
   漏掉。纯只读，三条边界在这里守死：

     · 只有两条读命令（worktree list --porcelain、ls-files --others --ignored
       --exclude-standard --directory），没有任何写路径，也**不进读缓存** —— 扫描
       的意义就是「点按钮、看现在」，缓存一份旧账反而误导；
     · 路径只进 workdir（每工作树一次 spawn，workdir=工作树根），argv 全是常量，
       没有 shell 拼接面；
     · 上限口径（ao-local 同款）：单次 10s、输出 16MB、总量 2000 条截断、整次约
       30s 软截止；一个仓库或一个工作树失败只标它自己（ok:false + reason），
       不拖垮其余。 */

const IGNORED_SCAN_TIMEOUT_MS = 10000
const IGNORED_SCAN_MAX_BYTES = 16 * 1024 * 1024
const IGNORED_SCAN_MAX_ITEMS = 2000
const IGNORED_SCAN_TOTAL_BUDGET_MS = 30000
/* 与 61-repos.js 的 REPO_LIST_MAX 同一个边界：shown 清单本身就到不了 64 个以上，
   这里照抄封顶，一个怪物请求也进不了 spawn 循环。 */
const IGNORED_SCAN_MAX_REPOS = 64

/* 一次失败的人话（runGitIgnoredListing 的同款折法，换成这个插件的旗标）：没有 git、
   被沙箱拒了、超时，都说它自己的话；其余用 stderr 首行 —— git 的原话在哪个 locale
   都比「退出码 128」有用。 */
function ignoredFailureReason(result) {
  if (result == null) return 'git 没有给出原因'
  if (gitMissing(result) === true) return 'git 命令不存在（这台机器的 PATH 里没有可用的 git）'
  if (result.sandboxDenied === true) return '文件沙箱拒绝了这次读取'
  if (result.timedOut === true) return '读取超时（10 秒上限）'
  const lines = String(result.stderr == null ? '' : result.stderr).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line.length > 0) return line
  }
  return 'git 读取失败（退出码 ' + String(result.exitCode) + '）'
}

/* 仓库路径先校验（一次 shell 问完所有仓库，61-repos.js 合成一次 spawn 的同一手法）：
   存在、是目录、里面有没有 .git（目录或 worktree gitlink 文件都算，与手动登记同一
   判据）。cwd 是会话自己的工作区，不是被探测的路径 —— 62-panel.js probeShell 的
   同一条规矩。 */
function ignoredValidateCommand(repos) {
  const lines = []
  for (let i = 0; i < repos.length; i += 1) {
    const quoted = shq(repos[i])
    lines.push('if [ -d ' + quoted + ' ]; then '
      + 'if [ -e ' + quoted + '/.git ]; then printf ' + shq('V:' + i + ':ok\n')
      + '; else printf ' + shq('V:' + i + ':nogit\n') + '; fi; '
      + 'else printf ' + shq('V:' + i + ':nodir\n') + '; fi')
  }
  return lines.join('\n')
}

/* 一棵工作树的忽略项清单：cwd=工作树根跑 ls-files --others --ignored
   --exclude-standard --directory（--exclude-standard 含 .gitignore + .git/info/
   exclude + 全局排除；--directory 把整个被忽略目录折叠成一行带尾斜杠的目录）。
   刻意不带 -z、改用 core.quotePath=false + 按行分割：本插件走 shell 通道而不是
   直接 spawn，\0 能不能活着穿过通道没有保证；quotePath 关掉后 git 仍会把换行等
   控制字符引成 C 转义（65-worktree 头部对 locked 原因的实测同一规则），行分割
   因此永远安全，而非 ASCII 文件名保持原样 —— 忽略项是给人看的清单，中文文件名
   不该变成八进制。 */
async function ignoredWorktreeScan(input, worktreePath) {
  const listed = await gitC(argsAt(input, worktreePath),
    ['-c', 'core.quotePath=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    null, { timeoutMs: IGNORED_SCAN_TIMEOUT_MS, maxBytes: IGNORED_SCAN_MAX_BYTES })
  if (listed.exitCode !== 0) {
    return { ok: false, reason: ignoredFailureReason(listed), items: [], truncated: false }
  }
  /* 通道在 16MB 处截断输出时 stdout 会被掐短（truncated 标志）：照实说「不完整」，
     装作完整反而是害人。 */
  const truncated = listed.truncated === true
  const items = []
  const lines = listed.stdout.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.length === 0) continue
    items.push({ path: line, dir: line.slice(-1) === '/' })
  }
  return { ok: true, reason: '', items: items, truncated: truncated }
}

/* git/ignored-scan 的执行体（80-rpc.js 注册）：入参 {sessionId, repos:[绝对路径]}。
   逐仓库：worktree list 解析出全部工作树（含主工作区，跳过 bare）→ 逐工作树跑
   上面的 ignoredWorktreeScan。总量 2000 条截断（截到点后不再启动新的工作树读取，
   没扫的格子 ok:false 说明原因）；整次 30s 软截止在每次 spawn 之前看表，到点同样
   不再启动新读取、timedOut:true —— 两把闸都只在「启动前」拦，绝不半路掐断一个
   正在读的工作树（半份输出比没有更误导）。 */
async function ignoredScanSnapshot(input) {
  const startedAt = Date.now()
  const requested = input != null && Array.isArray(input.repos) ? input.repos : []
  const repos = []
  for (let i = 0; i < requested.length && repos.length < IGNORED_SCAN_MAX_REPOS; i += 1) {
    const one = isStr(requested[i]) ? requested[i].trim() : ''
    if (one.length === 0 || one.charAt(0) !== '/' || repos.indexOf(one) >= 0) continue
    repos.push(one)
  }
  if (repos.length === 0) {
    return { ok: false, error: 'no-repos', repos: [], truncated: false, timedOut: false }
  }

  const checked = await probeShell(input, ignoredValidateCommand(repos))
  if (checked.exitCode !== 0 && checked.stdout.length === 0) {
    return { ok: false, error: 'validate-failed', stderr: checked.stderr.slice(0, 400),
      sandboxDenied: checked.sandboxDenied === true, repos: [], truncated: false, timedOut: false }
  }
  const verdict = {}
  const rows = checked.stdout.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.indexOf('V:') !== 0) continue
    const parts = row.split(':')
    verdict[parts[1]] = parts[2]
  }

  const reports = []
  let totalItems = 0
  let truncated = false
  let timedOut = false

  for (let r = 0; r < repos.length; r += 1) {
    const repoPath = repos[r]
    const report = { path: repoPath, ok: true, reason: '', worktrees: [] }
    reports.push(report)
    if (timedOut === true || Date.now() - startedAt >= IGNORED_SCAN_TOTAL_BUDGET_MS) {
      timedOut = true
      report.ok = false
      report.reason = '扫描总时长到了上限（30 秒），这个仓库没有扫'
      continue
    }
    const kind = verdict[String(r)]
    if (kind !== 'ok') {
      report.ok = false
      report.reason = kind === 'nogit'
        ? '这个目录存在，但不是 git 仓库（里面没有 .git）'
        : '这个目录不存在（或不是目录）'
      continue
    }
    const listed = await gitC(argsAt(input, repoPath),
      ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], null,
      { timeoutMs: IGNORED_SCAN_TIMEOUT_MS })
    if (listed.exitCode !== 0) {
      report.ok = false
      report.reason = ignoredFailureReason(listed)
      continue
    }
    const treeRows = parseWorktreeRows(listed.stdout)
    /* 主工作区 = porcelain 里第一条非 bare 记录（git 保证它排第一；bare 仓库的主
       记录是 bare，没有工作区可言），其余非 bare 记录都是 git worktree add 出来的
       链接工作区 —— 行上的 main 就是按这个位置标的。 */
    let mainIndex = -1
    for (let w = 0; w < treeRows.length; w += 1) {
      if (treeRows[w].bare === true) continue
      mainIndex = w
      break
    }
    for (let w = 0; w < treeRows.length; w += 1) {
      const row = treeRows[w]
      if (row.bare === true) continue
      const worktree = {
        path: row.path,
        main: w === mainIndex,
        branch: row.branch,
        detached: row.detached === true,
        ok: true,
        reason: '',
        items: [],
      }
      report.worktrees.push(worktree)
      if (timedOut === true || Date.now() - startedAt >= IGNORED_SCAN_TOTAL_BUDGET_MS) {
        timedOut = true
        worktree.ok = false
        worktree.reason = '扫描总时长到了上限（30 秒），这个工作树没有扫'
        continue
      }
      if (totalItems >= IGNORED_SCAN_MAX_ITEMS) {
        worktree.ok = false
        worktree.reason = '忽略项总量到了上限（' + String(IGNORED_SCAN_MAX_ITEMS) + ' 条），这里没有再扫'
        continue
      }
      const outcome = await ignoredWorktreeScan(input, row.path)
      if (outcome.ok !== true) {
        worktree.ok = false
        worktree.reason = outcome.reason
        continue
      }
      /* 全局 2000 条硬截断（ao-local 同一口径）：装填到点就停 —— 这棵工作树剩下
         的条目不再收，排在后面的工作树也不再启动（上面那道闸），truncated 说话。
         装填途中被截的那棵，行上的条数因此比实际少。 */
      for (let k = 0; k < outcome.items.length; k += 1) {
        if (totalItems >= IGNORED_SCAN_MAX_ITEMS) { truncated = true; break }
        worktree.items.push(outcome.items[k])
        totalItems += 1
      }
      if (outcome.truncated === true) {
        worktree.truncated = true
        truncated = true
      }
    }
  }

  const reply = { ok: true, repos: reports, truncated: truncated, timedOut: timedOut }
  return reply
}
