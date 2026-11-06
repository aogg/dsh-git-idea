/* ─────────────── 一个工作区里的所有仓库 ───────────────

   这个插件原本的模型是「一个会话工作区 = 一个仓库」，但一个工作区里完全可能
   嵌着好几个仓库（monorepo 里各自独立的 .git、旁边 clone 下来的参考项目）。
   下面三件事都是为那个事实服务的：

     · `git/repos`      扫一遍工作区，把所有仓库目录列出来（外加这个工作区在
                         配置里手动登记过的仓库，和它们「还在不在」的答案）；
     · `git/repos-save` 把一个路径登记成/移出这个工作区的手动仓库清单；
     · 配置里的形状     `repos: { "<工作区>": ["<仓库绝对路径>", …] }`。

   v0.2.9 加了第二份登记清单 `repoDirs`（与 repos 平行，同一工作区键）：里面是
   「自己没有 .git、但子孙里嵌着仓库」的目录（monorepo 的外层壳、按项目整理的
   仓库集）。`git/repos` 对它们在同一趟 spawn 里各扫一遍子孙，扫到的仓库照常
   并进清单；目录 → 子孙仓库的对应关系用答复新增的 `dirRepos` 带回去，客户端
   据此把列表分组。登记时不再要求路径自己就是仓库：有 `.git` 的进 repos（行为
   不变），没有 `.git` 但存在且是目录的进 repoDirs —— 「必须是仓库才能登记」
   的旧限制只剩「路径得存在」。

   手动清单放在插件配置（70-config.js）而不是浏览器 localStorage（20-prefs.js），
   理由写在 normalizeConfig 那里：它描述的是**这个项目**有哪些仓库，不是某台浏览器
   怎么看它 —— 换一个浏览器、换一台机器打开同一个工作区，清单应该还是那一份。 */

/* 扫描跳过这些目录名：它们是依赖或构建产物，里面的嵌套仓库既不是读者要找的，
   又把扫描拖慢（node_modules 一个就能有几万个目录）。名字大小写敏感 —— 刻意不加
   -iname：误伤一个 Build/ 里的仓库只是少显示一项，而忽略大小写会在大小写敏感的
   文件系统上多走一遍所有目录的比较。 */
const REPO_SCAN_SKIP = [
  'node_modules', 'bower_components', 'vendor', 'Pods', 'Carthage',
  'target', 'dist', 'build', 'out', '.gradle',
  '.venv', 'venv', '__pycache__', '.cache',
]

/* find 的深度与数量上限，两个都是扫描时间的硬边界：
   深度 —— 真正嵌套的仓库很少超过三四层，再深的多半是依赖里的副本；
   数量 —— head 在 shell 里就掐断输出，一个怪物工作区也不能让这条通道挤爆。 */
const REPO_SCAN_DEPTH = 6
const REPO_SCAN_HEAD = 400
const REPO_LIST_MAX = 64

/* 一条 shell 命令回答全部三个问题：工作区里有哪些仓库（find），手动登记过的
   每个路径现在还是不是一个仓库（逐个 `[ -e "$p"/.git ]`），以及每个登记的
   「含仓库目录」里扫到了哪些子孙仓库。合成一次 spawn 是这个文件一贯的规矩 ——
   通道一次只跑一个处理函数，两次便宜的总比一次便宜加一次贵的好。`.git` 既可以
   是目录（普通仓库）也可以是文件（worktree/submodule 的 gitlink），所以不加
   -type；`-prune -print` 让匹配到的 .git 自己也不再往里走。

   find 那一半是一只 while-read 管道（v1 只回 `R:<仓库根>`，v1.1 起分两色）：每一行
   .git 现场判 `[ -f ]` —— 是文件就是 gitlink，仓库根发 `W:`（worktree/子模块，答复
   的 links 那一列）；是目录或别的就发 `R:`。分色放在管道里而不是读回来再 stat 一遍，
   是为了让「哪个仓库是链接的」与「有哪些仓库」同一条命令答完，spawn 数一个不加；
   head 的数量截断仍在管道上游（掐的是 find 的行，while-read 收到的都是完整的行，
   不会出现半截路径）。while 在管道右侧的子 shell 里跑，只往 stdout 打标记，没有
   别的状态要带回来。

   登记目录那一半（v0.2.9）是同一套 find 管道原样再跑一遍，只有行首标记不同：
   `D<序号>R:/D<序号>W:<仓库根>` —— 序号是它在 dirs 实参里的下标，答复据此映射
   「目录 → 它的子孙仓库」，R/W 两色的含义与工作区那半一字不差。序号放在 D 和
   色标之间，首个 `:` 之前只有数字和色标，路径里就算有冒号也切不错列。目录已经
   不在（`[ -d ]` 不成立）的不扫、发 `DX<序号>:<目录>` —— 客户端要把它摆进
   missing 让人移除，不是安静地装作没登记过。每个目录独立过一遍 head 封顶：
   一个登记目录扫爆了不该吃掉别的目录的配额。 */
function reposScanCommand(workspace, manual, dirs) {
  const skip = REPO_SCAN_SKIP.map(function (name) { return '-name ' + shq(name) }).join(' -o ')
  const lines = [
    '{ find ' + shq(workspace) + ' -maxdepth ' + String(REPO_SCAN_DEPTH)
      + ' \\( ' + skip + ' \\) -prune -o -name .git -prune -print 2>/dev/null'
      + ' | head -n ' + String(REPO_SCAN_HEAD)
      + ' | while IFS= read -r p; do',
    'case "$p" in */.git) ;; *) continue ;; esac',
    'if [ -f "$p" ]; then printf \'W:%s\\n\' "${p%/.git}"; else printf \'R:%s\\n\' "${p%/.git}"; fi',
    'done; }',
  ]
  for (let i = 0; i < manual.length; i += 1) {
    const quoted = shq(manual[i])
    lines.push('if [ -e ' + quoted + '/.git ]; then printf \'M:%s\\n\' ' + quoted
      + '; else printf \'G:%s\\n\' ' + quoted + '; fi')
  }
  for (let i = 0; i < dirs.length; i += 1) {
    const quoted = shq(dirs[i])
    const tag = 'D' + String(i)
    lines.push('if [ -d ' + quoted + ' ]; then')
    lines.push('{ find ' + quoted + ' -maxdepth ' + String(REPO_SCAN_DEPTH)
      + ' \\( ' + skip + ' \\) -prune -o -name .git -prune -print 2>/dev/null'
      + ' | head -n ' + String(REPO_SCAN_HEAD)
      + ' | while IFS= read -r p; do',
    'case "$p" in */.git) ;; *) continue ;; esac',
    'if [ -f "$p" ]; then printf \'' + tag + 'W:%s\\n\' "${p%/.git}"; else printf \'' + tag + 'R:%s\\n\' "${p%/.git}"; fi',
    'done; }',
    'else printf \'' + tag + 'X:%s\\n\' ' + quoted + '; fi')
  }
  return lines.join('\n')
}

/* 工作区作为配置里的键：去掉尾部的斜杠（同一个目录两种写法要在配置里是同一个键），
   但根目录的 "/" 要留住。 */
function repoKeyOf(path) {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : '/'
}

function manualReposOf(config, workspace) {
  const map = config != null && config.repos != null ? config.repos : null
  const list = map == null ? undefined : map[repoKeyOf(workspace)]
  return list === undefined ? [] : list
}

/* 登记的「含仓库目录」清单：与 manualReposOf 同一副骨架，读的是 repoDirs 那一格。 */
function repoDirsOf(config, workspace) {
  const map = config != null && config.repoDirs != null ? config.repoDirs : null
  const list = map == null ? undefined : map[repoKeyOf(workspace)]
  return list === undefined ? [] : list
}

/* 读一遍：扫描 + 合并手动清单 + 扫登记目录的子孙。手动清单里已经不在（或已不是
   仓库）的路径单独放在 `missing` 里 —— 配置是持久化的，目录会被删掉；这里宁可报
   出来让人移除，也不能让一条死路径把面板弄崩。扫描那半现在带颜色（reposScanCommand）：
   R=普通仓库、W=`.git` 是文件的仓库（worktree/子模块），两色都进 repos，W 的根另外
   进 `links` —— 客户端在仓库行旁标一个「wt」小标，说明这一行不是独立仓库而是链接
   工作区。登记目录那半发的是 `D<序号>R/W:` 与 `DX<序号>:`（标记协议见
   reposScanCommand）：子孙仓库照常进 repos/links（两半扫到同一个仓库时靠 found
   去重 —— 比如登记目录就嵌在工作区里，两边都会扫到它）；「目录 → 子孙仓库」另用
   `dirRepos` 带回去，客户端分组要用，Host 层不去重 —— 同一棵子孙出现在工作区组
   和目录组是客户端按最长前缀分组的事，这里把原始对应关系诚实带出去就好。 */
async function readWorkspaceRepos(input) {
  /* 扫的是**会话自己的工作区**，不是当前生效的仓库：读操作按 repo 参数化之后，
     面板可能正看着工作区外的某个路径，而仓库清单跟随的是项目本身。 */
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) {
    return { ok: false, error: 'no-path', workspace: null, repos: [], manual: [], missing: [], links: [], dirs: [], dirRepos: {} }
  }
  const config = await readConfigFile()
  const manual = manualReposOf(config, workspace)
  const dirs = repoDirsOf(config, workspace)
  /* 30s：正常工作区这条 find 是毫秒级的，但慢挂载上的大树真能走好几秒 —— 它不常
     发生，可一旦发生不该把后面的请求都堵到默认的 120s。登记目录在同一趟里扫，
     超时预算共用这一份。 */
  const probe = await invoke(reposScanCommand(workspace, manual, dirs), argsAt(input, sessionWorkdir(input)), null, { timeoutMs: 30000 })
  if (probe.exitCode !== 0 && probe.stdout.length === 0) {
    return { ok: false, error: 'scan-failed', workspace: workspace, repos: [], manual: manual, missing: [], links: [], dirs: [], dirRepos: {},
      stderr: probe.stderr.slice(0, 400), sandboxDenied: probe.sandboxDenied === true }
  }
  const found = []
  const gone = []
  const linked = []
  const dirRepos = {}
  const rows = probe.stdout.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.length === 0) continue
    if (row.charAt(0) === 'D') {
      /* 登记目录那一半：DX=目录已不在（进 missing 让人移除）；DR/DW=子孙仓库，
         色标与序号在首个 `:` 之前（序号是纯数字，不会被路径里的冒号骗到）。 */
      const cut = row.indexOf(':', 1)
      if (cut < 2) continue
      if (row.charAt(cut - 1) === 'X') {
        const path = row.slice(cut + 1)
        if (path.length > 0 && gone.indexOf(path) < 0) gone.push(path)
        continue
      }
      const seq = parseInt(row.slice(1, cut - 1), 10)
      const kind = row.charAt(cut - 1)
      const root = row.slice(cut + 1)
      /* 序号越界（配置在扫描进行中被改写）或行被通道截半的：丢掉，宁少勿错。 */
      if (!(seq >= 0) || seq >= dirs.length) continue
      /* root 的准入口径用 isStoredPath（70-config.js）：远程工作区的会话里，
         扫描从 ssh://… 的起点原样带出前缀，仓库根是 `ssh://<alias>/<绝对路径>`
         的拼法，一样要收。 */
      if ((kind !== 'R' && kind !== 'W') || root.length === 0 || isStoredPath(root) !== true) continue
      const dir = dirs[seq]
      if (dirRepos[dir] === undefined) dirRepos[dir] = []
      if (dirRepos[dir].indexOf(root) < 0) dirRepos[dir].push(root)
      if (found.indexOf(root) < 0) found.push(root)
      if (kind === 'W' && linked.indexOf(root) < 0) linked.push(root)
      continue
    }
    if (row.indexOf('M:') === 0 || row.indexOf('G:') === 0) {
      /* 手动清单那一半：M=还在的仓库，G=已经不在（或已不是仓库）的路径。 */
      const path = row.slice(2)
      if (row.charAt(0) === 'M' && found.indexOf(path) < 0) found.push(path)
      else if (row.charAt(0) === 'G') gone.push(path)
      continue
    }
    /* find 那一半（管道里已经判完 [ -f ]）：R=普通仓库，W=.git 是文件的仓库根。
       输出被通道截断的话最后一行可能只剩半截 —— 不以 R:/W: 开头、或根为空的行
       直接丢掉，宁少勿错。 */
    const kind = row.charAt(0) === 'R' || row.charAt(0) === 'W' ? row.charAt(0) : ''
    if (kind === '') continue
    const root = row.slice(2)
    if (root.length === 0 || isStoredPath(root) !== true) continue
    if (found.indexOf(root) < 0) found.push(root)
    if (kind === 'W' && linked.indexOf(root) < 0) linked.push(root)
  }
  found.sort()
  gone.sort()
  linked.sort()
  /* dirs 只带「登记且还在」的（丢了的那几条已经在 missing 里）；dirRepos 的键序
     跟着 dirs，每目录的清单同样排序、封顶 —— 分组是客户端的事，这里的职责只是
     把对应关系按稳定的顺序交出去。 */
  const keptDirs = []
  for (let i = 0; i < dirs.length; i += 1) if (gone.indexOf(dirs[i]) < 0) keptDirs.push(dirs[i])
  keptDirs.sort()
  const sortedDirRepos = {}
  for (let i = 0; i < keptDirs.length; i += 1) {
    const list = dirRepos[keptDirs[i]]
    sortedDirRepos[keptDirs[i]] = (list === undefined ? [] : list).slice(0, REPO_LIST_MAX).sort()
  }
  return {
    ok: true, workspace: workspace,
    /* 合并、去重、按路径排序：列表的顺序是路径的性质，不是 git 回答的顺序。 */
    repos: found.slice(0, REPO_LIST_MAX),
    manual: manual,
    missing: gone,
    /* links 与 repos 同一套排序与封顶：清单是给人读的，顺序稳定比什么都要紧。 */
    links: linked.slice(0, REPO_LIST_MAX),
    dirs: keptDirs,
    dirRepos: sortedDirRepos,
    truncated: found.length > REPO_LIST_MAX,
  }
}

/* 登记或移除。add 按探测结果分流：有 `.git` → 手动仓库清单（行为与从前一字不差）；
   没有 `.git` 但存在且是目录 → 「含仓库目录」清单（v0.2.9 的新能力 —— 它自己不是
   仓库，扫的是子孙，git/repos 每次读都会照扫）；不存在 → missing。移除从两份
   清单里都试着删：调用方（客户端）只知道「这一行在列表里」，不知道它在哪份账上，
   幂等地两边都删才是对的；两边都不在就照旧原样返回当前清单，一个字节不写。 */
async function saveWorkspaceRepo(input) {
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) {
    return { ok: false, error: 'no-path', workspace: null, repos: [], manual: [], missing: [], dirs: [], dirRepos: {} }
  }
  const add = input != null && isStr(input.add) ? input.add.trim() : ''
  const remove = input != null && isStr(input.remove) ? input.remove.trim() : ''
  if ((add.length > 0) === (remove.length > 0)) {
    return { ok: false, error: 'exactly one of add or remove is required' }
  }
  const config = await readConfigFile()
  let list = manualReposOf(config, workspace).slice()
  let dirList = repoDirsOf(config, workspace).slice()
  if (add.length > 0) {
    if (isStoredPath(add) !== true) return { ok: false, error: 'absolute path required', path: add }
    const check = await probeShell(input, 'if [ -e ' + shq(add) + '/.git ]; then echo repo; elif [ -d ' + shq(add) + ' ]; then echo dir; else echo none; fi')
    const kind = check.stdout.trim()
    if (kind === 'none') return { ok: false, error: 'missing', path: add }
    if (kind === 'repo') {
      if (list.indexOf(add) >= 0) return await readWorkspaceRepos(input)
      list.push(add)
    } else {
      if (dirList.indexOf(add) >= 0) return await readWorkspaceRepos(input)
      dirList.push(add)
    }
  } else {
    const next = []
    for (let i = 0; i < list.length; i += 1) if (list[i] !== remove) next.push(list[i])
    const nextDirs = []
    for (let i = 0; i < dirList.length; i += 1) if (dirList[i] !== remove) nextDirs.push(dirList[i])
    /* 两份清单都没删掉东西（remove 本来就不在）= 照旧原样返回当前清单，一个字节
       不写 —— 与旧版只对 repos 早退同一纪律。 */
    if (next.length === list.length && nextDirs.length === dirList.length) return await readWorkspaceRepos(input)
    list = next
    dirList = nextDirs
  }
  /* 写的还是那份完整配置（readConfigFile 拿到的已是归一化过的，repos 随行）；只动
     这一个工作区的那一条，别的键原样带过去。 */
  const repos = Object.assign({}, config.repos)
  repos[repoKeyOf(workspace)] = list
  const repoDirs = Object.assign({}, config.repoDirs)
  repoDirs[repoKeyOf(workspace)] = dirList
  const written = await writeConfigFile(Object.assign({}, config, { repos: repos, repoDirs: repoDirs }), argsAt(input, null))
  if (written.ok !== true) return written
  /* 答复带的是合并后的新清单：客户端一次往返就能把整份列表换成新的。 */
  return await readWorkspaceRepos(input)
}

/* ── 生效仓库的后端账（按工作区一格）──

   单击选定的生效仓库过去只记在浏览器的 localStorage 里，而且键是「会话 id」：
   会话 id 一换（开新对话）、浏览器一换、缓存一清，账就没了，面板于是回落到
   工作区默认仓库 —— 读者切了几次的仓库「过一会老是变回第一个」，正是这个 bug。
   生效仓库跟着的应该是这个工作区，不是某一次对话：所以它按工作区分键存进插件
   配置（normalizeConfig 的 appliedRepos），换浏览器、换机器、开新会话都还是它。

   为什么读改写都放在 Host、客户端只递「这个会话、哪个仓库」：config-save 是
   「整份换掉」的写法 —— 客户端先读整份、改一个键、再整体写回，读与写之间别人
   落盘的键（另一台浏览器刚存的草稿、全局档正在改的 git 路径）会被这一次整体
   写回悄悄抹掉，draftSave 同一条理由（70-config.js 那一段写全了）。这里与
   saveWorkspaceRepo 一样只动自己那一格，其余键原样带过去，谁也抹不掉谁。 */

/* 读当前工作区记的生效仓库。repo 非空时顺手探测一次它还在不在、git 还读不读得
   动 —— 记的账是持久化的，目录会被删/搬走；**.git 是文件（worktree/子模块）时
   里面那条 gitdir 还可能指向别处**（Windows 上建的 worktree 整棵拷来 Linux，
   gitdir 写的是 D:/ 盘符路径），文件在、git 却读不动。两种坏都答空串（不套用），
   但**不删账**：也许只是暂时挂不上，读者下一次单击自然会覆写它。stale: true 把
   「账上有、盘上读不了」这件事说破，客户端据此安静维持现状 —— 不做这一步，账
   就会每次打开面板把读者自动带进「这个目录不是 Git 仓库」的说明页。 */
async function appliedRepoSnapshot(input) {
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) {
    return { ok: false, error: 'no-path', workspace: null, repo: '' }
  }
  const config = await readConfigFile()
  const key = repoKeyOf(workspace)
  const found = config.appliedRepos[key]
  let repo = isStr(found) ? found : ''
  if (repo.length > 0) {
    /* probeShell 的 workdir 是会话自己的目录 —— 正合「检查别处路径」的教条：
       要检查的这个仓库多半不在会话目录里，拿它当 workdir 只会在 spawn 那一步
       就失败。`[ -e ]` 加一道 `rev-parse --absolute-git-dir`：前者只证明 .git
       这个文件/目录在，后者才是「git 认这是不是一个仓库」—— worktree 的
       gitlink 指向不存在的 gitdir 时前者真、后者假。与面板打开时对每个仓库的
       身份读数（64-history.js readPanelIdentity）同一道判据，账本与面板才不会
       各说各话。一次 spawn，是账本的自检，不是仓库读数，不进读缓存。 */
    const check = await probeShell(input, 'if [ -e ' + shq(repo) + '/.git ] && '
      + gitCmd() + ' -C ' + shq(repo) + ' rev-parse --absolute-git-dir >/dev/null 2>&1; then echo repo; else echo gone; fi')
    if (check.stdout.trim() !== 'repo') {
      return { ok: true, workspace: workspace, repo: '', stale: true }
    }
  }
  return { ok: true, workspace: workspace, repo: repo }
}

/* 存/清当前工作区的生效仓库。repo 空串 = 删除语义（这个工作区回到默认回落），
   非空必须是 / 开头、不超过 APPLIED_PATH_MAX 的绝对路径。**不做存在性探测**：
   客户端只会把扫描清单里的路径送来，而读的那条（appliedRepoSnapshot）已经对
   死路径自愈 —— 存进一个此刻还在、明天被删的路径，不是这次保存该拦的事。

   同值早退：重申式单击常来同值 —— 与账上完全一致的那一次连盘都不该碰
   （draftSave 同一条纪律），别的键也少冒一次被并发写回抹掉的风险。 */
async function saveAppliedRepo(input) {
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) {
    return { ok: false, error: 'no-path', workspace: null }
  }
  const repo = input != null && isStr(input.repo) ? input.repo.trim() : ''
  if (repo.length > 0 && (isStoredPath(repo) !== true || repo.length > APPLIED_PATH_MAX)) {
    return { ok: false, error: 'absolute path required', repo: repo }
  }
  const config = await readConfigFile()
  const map = Object.assign({}, config.appliedRepos)
  const key = repoKeyOf(workspace)
  if (repo.length === 0) delete map[key]
  else map[key] = repo
  /* 改完的副本与原账逐键一致（含「删一条本来就没有的」）= 一个字节不用写。 */
  if (map[key] === config.appliedRepos[key]) {
    return { ok: true, workspace: workspace, repo: repo, unchanged: true }
  }
  /* 写这份文件要这个会话的沙箱策略 —— 它在任何工作区之外（writeConfigFile 的
     那段说明），argsAt 把 sessionId 带上，理由与 saveWorkspaceRepo 相同。 */
  const written = await writeConfigFile(Object.assign({}, config, { appliedRepos: map }), argsAt(input, null))
  if (written.ok !== true) return written
  return { ok: true, workspace: workspace, repo: repo }
}
