/* ─────────────── 一个工作区里的所有仓库 ───────────────

   这个插件原本的模型是「一个会话工作区 = 一个仓库」，但一个工作区里完全可能
   嵌着好几个仓库（monorepo 里各自独立的 .git、旁边 clone 下来的参考项目）。
   下面三件事都是为那个事实服务的：

     · `git/repos`      扫一遍工作区，把所有仓库目录列出来（外加这个工作区在
                         配置里手动登记过的仓库，和它们「还在不在」的答案）；
     · `git/repos-save` 把一个路径登记成/移出这个工作区的手动仓库清单；
     · 配置里的形状     `repos: { "<工作区>": ["<仓库绝对路径>", …] }`。

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

/* 一条 shell 命令回答全部两个问题：工作区里有哪些仓库（find），以及手动登记过的
   每个路径现在还是不是一个仓库（逐个 `[ -e "$p"/.git ]`）。合成一次 spawn 是这个
   文件一贯的规矩 —— 通道一次只跑一个处理函数，两次便宜的总比一次便宜加一次贵的好。
   `.git` 既可以是目录（普通仓库）也可以是文件（worktree/submodule 的 gitlink），所以
   不加 -type；`-prune -print` 让匹配到的 .git 自己也不再往里走。 */
function reposScanCommand(workspace, manual) {
  const skip = REPO_SCAN_SKIP.map(function (name) { return '-name ' + shq(name) }).join(' -o ')
  const lines = [
    '{ find ' + shq(workspace) + ' -maxdepth ' + String(REPO_SCAN_DEPTH)
      + ' \\( ' + skip + ' \\) -prune -o -name .git -prune -print 2>/dev/null'
      + ' | head -n ' + String(REPO_SCAN_HEAD) + '; }',
  ]
  for (let i = 0; i < manual.length; i += 1) {
    const quoted = shq(manual[i])
    lines.push('if [ -e ' + quoted + '/.git ]; then printf \'M:%s\\n\' ' + quoted
      + '; else printf \'G:%s\\n\' ' + quoted + '; fi')
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

/* 读一遍：扫描 + 合并手动清单。手动清单里已经不在（或已不是仓库）的路径单独放在
   `missing` 里 —— 配置是持久化的，目录会被删掉；这里宁可报出来让人移除，也不能让
   一条死路径把面板弄崩。 */
async function readWorkspaceRepos(input) {
  /* 扫的是**会话自己的工作区**，不是当前生效的仓库：读操作按 repo 参数化之后，
     面板可能正看着工作区外的某个路径，而仓库清单跟随的是项目本身。 */
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) {
    return { ok: false, error: 'no-path', workspace: null, repos: [], manual: [], missing: [] }
  }
  const config = await readConfigFile()
  const manual = manualReposOf(config, workspace)
  /* 30s：正常工作区这条 find 是毫秒级的，但慢挂载上的大树真能走好几秒 —— 它不常
     发生，可一旦发生不该把后面的请求都堵到默认的 120s。 */
  const probe = await invoke(reposScanCommand(workspace, manual), argsAt(input, sessionWorkdir(input)), null, { timeoutMs: 30000 })
  if (probe.exitCode !== 0 && probe.stdout.length === 0) {
    return { ok: false, error: 'scan-failed', workspace: workspace, repos: [], manual: manual, missing: [],
      stderr: probe.stderr.slice(0, 400), sandboxDenied: probe.sandboxDenied === true }
  }
  const found = []
  const gone = []
  const rows = probe.stdout.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.length === 0) continue
    if (row.indexOf('M:') === 0 || row.indexOf('G:') === 0) {
      /* 手动清单那一半：M=还在的仓库，G=已经不在（或已不是仓库）的路径。 */
      const path = row.slice(2)
      if (row.charAt(0) === 'M' && found.indexOf(path) < 0) found.push(path)
      else if (row.charAt(0) === 'G') gone.push(path)
      continue
    }
    /* find 那一半：打印的是 .git 的路径，仓库根是它的父目录。输出被 head 截断过
       的话最后一行可能只剩半截 —— 不以 /.git 结尾的行直接丢掉，宁少勿错。 */
    if (row.slice(-5) !== '/.git') continue
    const root = row.slice(0, -5)
    if (root.length > 0 && found.indexOf(root) < 0) found.push(root)
  }
  found.sort()
  gone.sort()
  return {
    ok: true, workspace: workspace,
    /* 合并、去重、按路径排序：列表的顺序是路径的性质，不是 git 回答的顺序。 */
    repos: found.slice(0, REPO_LIST_MAX),
    manual: manual,
    missing: gone,
    truncated: found.length > REPO_LIST_MAX,
  }
}

/* 登记或移除一个手动仓库。校验用的是和扫描同一个判据 —— `[ -e path/.git ]`，一个
   目录、不做向上发现（62-panel.js 的 repoHere 说明了为什么）：让读者把一个不是仓库
   的目录加进清单，只会在下一次打开时换来一个 setup 页。 */
async function saveWorkspaceRepo(input) {
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) {
    return { ok: false, error: 'no-path', workspace: null, repos: [], manual: [], missing: [] }
  }
  const add = input != null && isStr(input.add) ? input.add.trim() : ''
  const remove = input != null && isStr(input.remove) ? input.remove.trim() : ''
  if ((add.length > 0) === (remove.length > 0)) {
    return { ok: false, error: 'exactly one of add or remove is required' }
  }
  const config = await readConfigFile()
  let list = manualReposOf(config, workspace).slice()
  if (add.length > 0) {
    if (add.charAt(0) !== '/') return { ok: false, error: 'absolute path required', path: add }
    if (list.indexOf(add) >= 0) return await readWorkspaceRepos(input)
    const check = await probeShell(input, 'if [ -e ' + shq(add) + '/.git ]; then echo repo; elif [ -d ' + shq(add) + ' ]; then echo norepo; else echo none; fi')
    const kind = check.stdout.trim()
    if (kind === 'none') return { ok: false, error: 'missing', path: add }
    if (kind !== 'repo') return { ok: false, error: 'not-a-repository', path: add }
    list.push(add)
  } else {
    const next = []
    for (let i = 0; i < list.length; i += 1) if (list[i] !== remove) next.push(list[i])
    if (next.length === list.length) return await readWorkspaceRepos(input)
    list = next
  }
  /* 写的还是那份完整配置（readConfigFile 拿到的已是归一化过的，repos 随行）；只动
     这一个工作区的那一条，别的键原样带过去。 */
  const repos = Object.assign({}, config.repos)
  repos[repoKeyOf(workspace)] = list
  const written = await writeConfigFile(Object.assign({}, config, { repos: repos }), argsAt(input, null))
  if (written.ok !== true) return written
  /* 答复带的是合并后的新清单：客户端一次往返就能把整份列表换成新的。 */
  return await readWorkspaceRepos(input)
}
