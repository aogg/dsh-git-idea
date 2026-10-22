/* ── plugin-side configuration ──

   Split from the browser-local presentation preferences on purpose. "Which
   branch should a new repository start on" is a property of this plugin, not of
   whoever happens to be looking at it, so it belongs beside the deployment's
   own settings rather than in one browser's localStorage. When this becomes an
   ordinary plugin this file is exactly what its config section would own. */

let configPathCache
let configCache = null

async function configPath() {
  if (configPathCache !== undefined) return configPathCache
  const probe = await invoke('printf %s "${DSH_HOME:-$HOME/.dsh}"', {}, null, { timeoutMs: 10000 })
  const home = probe.exitCode === 0 ? probe.stdout.trim() : ''
  configPathCache = home.length > 0 ? home + '/dsh-git-idea.json' : null
  return configPathCache
}

function normalizeConfig(raw) {
  const out = {
    initBranch: 'main', cherryPickRecord: false,
    /* Which git to run. Empty means "the one on the deployment's PATH", which is
       what every command used before this key existed. */
    gitPath: '',
    /* The three choices the plugin itself makes about the network — each one is
       the argument this plugin passes, not a copy of a git setting: `git fetch`
       is `--all --prune` here, pull merges, and a push to a branch with no
       upstream asks first. git's own `push.default` / `pull.rebase` still apply
       underneath and are not overridden. */
    fetchPrune: true, pullRebase: false, pushSetUpstream: false,
    /* 会话完成后的两件事（客户端 92-chip.js 听 DSH 的会话状态）：跑完自动刷新一次，
       全部跑完（稳定 5 秒）后自动推一次。默认「只刷新、不推送」—— 刷新只是把屏幕
       上已有的数字对齐现实，推送却是把读者的工作发到远端，没问过就不能替他做。 */
    refreshOnComplete: true, pushOnAllComplete: false,
    /* 手动登记的仓库，按工作区分组（61-repos.js）。放在这份配置而不是浏览器
       localStorage：它描述的是「这个项目有哪些仓库」，跟着项目走 —— 换浏览器、
       换机器打开同一个工作区，清单应该还是同一份；localStorage 那层（20-prefs.js）
       留给「这台浏览器怎么看」。 */
    repos: {},
    /* 快捷命令（面板的 ⚡ 按钮，78-actions.js 两侧）。跟 repos 同一个理由：它描述的
       是「这个项目要一键跑什么」，跟着插件走而不是跟着某台浏览器。 */
    quickCommands: [],
    /* 提交信息草稿，按生效仓库的根绝对路径一仓一份（下面的 normalizeDrafts 与
       draftRead/draftSave）。跟 repos、quickCommands 同一个理由：它描述的是「这个
       项目写到一半的那条提交信息」，跟着项目走 —— 换浏览器、换机器打开同一个
       工作区，草稿还是同一份；客户端 20-prefs.js 那份整配置归一化也照 repos 的
       先例原样搬运它，设置页一次整份保存不至于把草稿抹掉。 */
    drafts: {},
    /* worktree → 主目录（65-worktree.js 的 saveWorktreeMain 写，wtMainSnapshot 读）。
       键是链接工作区（worktree/子模块这类 .git 是文件的目录）的绝对路径，值是它
       指向的主仓库绝对路径。跟 repos 同一个理由：它描述的是「这个项目的这个
       worktree 属于哪个主仓库」，主仓库被删/搬走后读者手动改对的那个答案必须跟着
       项目走，而不是跟着某台浏览器；客户端 20-prefs.js 同样照 repos 的先例原样
       搬运，配置页一次整份保存不至于把手工配置的主目录抹掉。 */
    worktreeMains: {},
    /* 生效仓库的跨浏览器记忆：{ "<工作区绝对路径>": "<仓库绝对路径>" }。
       读者在这个工作区里单击选定的仓库是这个项目的事实，不是某台浏览器怎么看它 ——
       按工作区（不是按会话）存进这份配置，换浏览器、换机器、开新会话都还是它。
       浏览器 localStorage 那层（客户端 10-state.js 的 APPLIED_REPOS_KEY）降级为
       首帧快速通道：后端答复落地前后端为准。客户端 20-prefs.js 照 repos 的先例
       原样搬运，设置页一次整份保存不至于把这份记忆抹掉。 */
    appliedRepos: {},
    /* worktree 的目录映射：[{id,from,to}]（65-worktree.js 识别主目录时套用）。
       一整棵目录树从别的机器拷来时（Windows 上建好的 worktree 拿到 Linux 用），
       .git 链接文件里记的主仓库路径是**那台机器**的（D:/code/…），这台机器的
       git 与文件系统都读不动它 —— worktree 于是被当成 broken-gitlink。这份映射
       就是读者替面板做的「虚拟机挂载」式翻译：识别主目录时，路径以 from 开头的
       那一段整段换成 to（前缀匹配，D:/… 与 D:\\… 两种写法都认）。跟 repos 同一个
       理由放这份配置而不是浏览器 localStorage：它描述的是「这台机器上目录长什么样」，
       跟着部署走；数组形状（含稳定 id）参考 quickCommands，编辑器在客户端
       79-globalconfig.js 的「worktree」组。 */
    worktreeDirMappings: [],
  }
  if (raw == null || typeof raw !== 'object') return out
  if (isStr(raw.initBranch)) out.initBranch = raw.initBranch.trim().slice(0, 120)
  out.cherryPickRecord = raw.cherryPickRecord === true
  if (isStr(raw.gitPath)) out.gitPath = cleanGitPath(raw.gitPath)
  out.fetchPrune = raw.fetchPrune !== false
  out.pullRebase = raw.pullRebase === true
  out.pushSetUpstream = raw.pushSetUpstream === true
  out.refreshOnComplete = raw.refreshOnComplete !== false
  out.pushOnAllComplete = raw.pushOnAllComplete === true
  out.repos = normalizeRepoMap(raw.repos)
  out.quickCommands = normalizeQuickCommands(raw.quickCommands)
  out.drafts = normalizeDrafts(raw.drafts)
  out.worktreeMains = normalizeWorktreeMains(raw.worktreeMains)
  out.appliedRepos = normalizeAppliedRepos(raw.appliedRepos)
  out.worktreeDirMappings = normalizeWorktreeDirMappings(raw.worktreeDirMappings)
  return out
}

/* 快捷命令清单：[{id,name,command}]。id 是客户端起的稳定串（名称+时间戳），这里只负责
   「形状对、不超限」：名字/模板为空的条目丢掉，超过 50 条的截断 —— Host 是这份文件的
   最后一道关卡，客户端归一化（20-prefs.js）拦得住的这里也得拦得住。 */
const QUICK_COMMANDS_MAX = 50
const QUICK_NAME_MAX = 120
const QUICK_COMMAND_LEN_MAX = 2000
function normalizeQuickCommands(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (let i = 0; i < raw.length && out.length < QUICK_COMMANDS_MAX; i += 1) {
    const one = raw[i]
    if (one == null || typeof one !== 'object') continue
    const name = isStr(one.name) ? one.name.trim().slice(0, QUICK_NAME_MAX) : ''
    const command = isStr(one.command) ? one.command.slice(0, QUICK_COMMAND_LEN_MAX) : ''
    if (name.length === 0 || command.trim().length === 0) continue
    const id = isStr(one.id) && one.id.trim().length > 0 ? one.id.trim().slice(0, 200)
      : (name + '-' + String(Date.now()))
    out.push({ id: id, name: name, command: command })
  }
  return out
}

/* 工作区 → 手动仓库清单。键和值都是磁盘上的路径，唯一的清洗是「绝对路径、去重、
   封顶」：一个也读不出来的键比一个被悄悄改写过的键诚实 —— 目录被删掉这件事由
   `git/repos` 每次读的时候报出来（missing），配置里先留着原文。 */
const REPO_MAP_WORKSPACES = 128
const REPO_MAP_PER_WORKSPACE = 64
function normalizeRepoMap(raw) {
  const out = {}
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out
  let kept = 0
  for (const key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    if (kept >= REPO_MAP_WORKSPACES) break
    const list = raw[key]
    if (!Array.isArray(list)) continue
    const clean = []
    for (let i = 0; i < list.length && clean.length < REPO_MAP_PER_WORKSPACE; i += 1) {
      const path = list[i]
      if (!isStr(path)) continue
      const trimmed = path.trim()
      if (trimmed.charAt(0) !== '/' || trimmed.length > 4096) continue
      if (clean.indexOf(trimmed) < 0) clean.push(trimmed)
    }
    if (clean.length > 0) { out[key] = clean; kept += 1 }
  }
  return out
}

/* worktree → 主目录。清洗口径与 normalizeRepoMap 一致：键（链接工作区的绝对路径）
   与值（主目录的绝对路径）都必须是「非空字符串 + 以 / 开头」，超长的整条丢掉 ——
   4096 与 REPO_MAP 同款，是磁盘路径的边界而不是 git 的；条数封顶 64（一个项目的
   worktree 数远够用了，drafts 的 DRAFT_REPOS_MAX 同一个数）。清洗后为空的映射就
   存空对象：一个读不出来的条目比一个被悄悄改写过的条目诚实。 */
const WT_MAIN_MAP_MAX = 64
const WT_MAIN_PATH_MAX = 4096

function normalizeWorktreeMains(raw) {
  const out = {}
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out
  let kept = 0
  for (const key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    if (kept >= WT_MAIN_MAP_MAX) break
    const worktree = key.trim()
    const main = isStr(raw[key]) ? raw[key].trim() : ''
    if (worktree.charAt(0) !== '/' || worktree.length > WT_MAIN_PATH_MAX) continue
    if (main.charAt(0) !== '/' || main.length > WT_MAIN_PATH_MAX) continue
    out[worktree] = main
    kept += 1
  }
  return out
}

/* 工作区 → 生效仓库（61-repos.js 的 saveAppliedRepo 写、appliedRepoSnapshot 读）。
   键是工作区的绝对路径（repoKeyOf 的口径 —— 去掉尾部斜杠后的样子），值是读者在
   这个工作区里单击选定的仓库根绝对路径。清洗口径与 normalizeWorktreeMains 完全
   一致：键与值都必须是「非空、以 / 开头、≤4096 字符」的字符串（去首尾空白 ——
   同一个目录两种写法得是同一个键），4096 与 REPO_MAP / WT_MAIN 同款，是磁盘路径
   的边界而不是 git 的；条数封顶 64（WT_MAIN_MAP_MAX / DRAFT_REPOS_MAX 同一个数，
   读者点不出更多「工作区 × 仓库」的组合）。清洗后条目不足不报错、为空就存空
   映射：一个读不出来的条目比一个被悄悄改写过的条目诚实。 */
const APPLIED_MAP_MAX = 64
const APPLIED_PATH_MAX = 4096

function normalizeAppliedRepos(raw) {
  const out = {}
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out
  let kept = 0
  for (const key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    if (kept >= APPLIED_MAP_MAX) break
    const workspace = key.trim()
    const repo = isStr(raw[key]) ? raw[key].trim() : ''
    if (workspace.charAt(0) !== '/' || workspace.length > APPLIED_PATH_MAX) continue
    if (repo.charAt(0) !== '/' || repo.length > APPLIED_PATH_MAX) continue
    out[workspace] = repo
    kept += 1
  }
  return out
}

/* worktree 的目录映射清单：[{id,from,to}]。与 quickCommands 是同一条规矩的两半
   （quickCommands 同款注释在前面）：id 是客户端起的稳定串，这里只负责「形状对、
   不超限」—— from / to 为空的条目丢掉（映射一条腿谈不上替换），超过 50 条的截断。
   Host 是这份文件的最后一道关卡，客户端归一化拦得住的这里也得拦得住。
   与 worktreeMains 那批「绝对路径、以 / 开头」的清洗**刻意不同**：from 记的正是
   别的机器的路径（Windows 的 D:/code/…），盘符开头不是错误；两边共同的口径只有
   去首尾空白与长度 —— 4096 与 WT_MAIN_PATH_MAX 同款，是磁盘路径的边界，超长的
   整条丢掉（quickCommands 的 name/command 是「截断」，这里不学它：路径截半截
   会得到一个恰好匹配别处的前缀，比没有更害人）。 */
const WORKTREE_DIR_MAPPINGS_MAX = 50
const DIR_MAPPING_PATH_MAX = 4096

function normalizeWorktreeDirMappings(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (let i = 0; i < raw.length && out.length < WORKTREE_DIR_MAPPINGS_MAX; i += 1) {
    const one = raw[i]
    if (one == null || typeof one !== 'object') continue
    const from = isStr(one.from) ? one.from.trim() : ''
    const to = isStr(one.to) ? one.to.trim() : ''
    if (from.length === 0 || to.length === 0) continue
    if (from.length > DIR_MAPPING_PATH_MAX || to.length > DIR_MAPPING_PATH_MAX) continue
    const id = isStr(one.id) && one.id.trim().length > 0 ? one.id.trim().slice(0, 200)
      : (from + '-' + String(Date.now()))
    out.push({ id: id, from: from, to: to })
  }
  return out
}

/* ── 这份配置文件走 shell，不走文件服务 ──

   它住在部署的配置目录里（`<DSH_HOME>/dsh-git-idea.json`），也就是**任何工作区之外**。
   文件服务是按工作区发策略的，而这条路径不在任何一个工作区里：写它的时候拿到的是部署
   默认那份策略（workspace-write），于是被拒绝 —— 而且拒得安静：面板里点了保存、磁盘上
   一个字节没变、屏幕上什么也没说。这是真机上抓到的（改用 `git` 路径时）。

   所以它和这个插件改的所有东西走同一条路：`invoke` + 会话自己的沙箱策略（`sandboxFor`），
   失败时答复里带着 sandboxDenied 和 git 那句话，界面上说得出为什么。读也一样走这条路，
   免得读到一个地方、写到另一个地方。 */

async function readConfigFile() {
  if (configCache !== null) return configCache
  const path = await configPath()
  if (path === null) { configCache = applyConfig(normalizeConfig(null)); return configCache }
  /* `[ -f … ]` 先说有没有这个文件：不存在不是错误，是「还没有配置过」。 */
  const probe = await invoke('[ -f ' + shq(path) + ' ] && cat ' + shq(path) + '\n', {}, null, { timeoutMs: 10000 })
  if (probe.exitCode !== 0) { configCache = applyConfig(normalizeConfig(null)); return configCache }
  try {
    configCache = applyConfig(normalizeConfig(JSON.parse(probe.stdout)))
  } catch (error) {
    console.error('dsh-git-idea: could not parse the plugin config', String(error))
    configCache = applyConfig(normalizeConfig(null))
  }
  return configCache
}

async function writeConfigFile(raw, args) {
  const path = await configPath()
  if (path === null) return { ok: false, error: '无法确定配置目录', stderr: '读不出部署的配置目录' }
  const next = normalizeConfig(raw)
  try {
    /* `mkdir -p` 先来一次：`DSH_HOME` 可以指到一个还不存在的目录，而重定向不会替
       你建目录。`printf %s` 而不是 heredoc —— 值里可能有引号、反斜杠、换行，`shq`
       一个都不挑。 */
    const dir = path.slice(0, path.lastIndexOf('/'))
    const written = await invoke(
      'mkdir -p ' + shq(dir) + ' && printf %s ' + shq(JSON.stringify(next, null, 2) + '\n') + ' > ' + shq(path) + '\n',
      args, null, { timeoutMs: 10000 })
    if (written.exitCode !== 0) {
      return {
        ok: false, path: path,
        error: written.sandboxDenied === true ? '文件沙箱不允许写这个配置文件' : '写不进这个配置文件',
        stderr: written.stderr, stdout: written.stdout,
        sandboxDenied: written.sandboxDenied === true,
        noGit: false,
      }
    }
    /* 换了一个 git，所有读的答案都可能跟着变 —— 可能从「读不动这个目录」变成读得动，
       反过来也一样。缓存不作废的话，读者在配置页的全局档里把路径改对了，面板还在拿上一个二进
       制留下的答案说话（这条是 fixture 抓出来的：改完之后同一棵树仍然回答旧的那一份）。 */
    const before = gitExe
    configCache = applyConfig(next)
    if (before !== gitExe) invalidateRepo(null)
    return { ok: true, path: path, config: next }
  } catch (error) {
    const detail = error != null && error.message !== undefined ? String(error.message) : String(error)
    return { ok: false, error: detail, path: path }
  }
}

/* ── 提交信息草稿：按生效仓库分键，跟着这份配置走 ──

   提交信息过去只活在浏览器的输入框里：提交成功就被清空，换个浏览器、换台机器
   打开同一个工作区，写到一半的那条信息就没了。它和 repos、quickCommands 是同一类
   东西 —— 描述「这个项目写到一半的那条提交信息」，跟着项目走而不是跟着某台浏览器
   —— 落点也相同：这份配置文件。键是生效仓库的根绝对路径，一仓一份互不干扰；
   monorepo 里几个仓库各自写到一半的信息，谁也不盖谁的。

   为什么是独立的 git/draft-read / git/draft-save，而不是让客户端拿着整份配置走
   git/config-save：config-save 是「整份换掉」的写法 —— 客户端每存一次草稿都得
   先读一遍完整配置、改一个键、再整体写回，读与写之间落进的任何别的键（全局配置
   那边正在改的、另一台浏览器刚写的）都会被这一次整体写回悄悄抹掉。草稿的读改写
   放在 Host（readConfigFile 的缓存上只动 drafts 这一片，其余键原样带过去，与
   61-repos.js 的 saveWorkspaceRepo 同一条路），客户端只递「哪个仓库、这条信息」，
   谁也抹不掉谁。

   归一化与 quickCommands/repoMap 同一条思路：Host 是这份文件的最后一道关卡，
   客户端拦得住的这里也得拦得住。单条封顶 4000 字符（git 对提交信息没有硬上限，
   这里防的是把配置文件写成一条信息的长河）、最多 64 个仓库、键必须是 / 开头的
   绝对路径（客户端发来的就是 Host 解出来的仓库根）；清洗之后只剩空白的条目直接
   丢掉 —— 「空」也是一条信息（读者清空了输入框），配置里没有这个键就是「空」
   的存储形状。 */
const DRAFT_REPOS_MAX = 64
const DRAFT_LEN_MAX = 4000
const DRAFT_KEY_MAX = 4096

function normalizeDrafts(raw) {
  const out = {}
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out
  let kept = 0
  for (const key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    if (kept >= DRAFT_REPOS_MAX) break
    if (key.length === 0 || key.length > DRAFT_KEY_MAX || key.charAt(0) !== '/') continue
    const value = raw[key]
    if (!isStr(value)) continue
    const clean = value.slice(0, DRAFT_LEN_MAX)
    if (clean.trim().length === 0) continue
    out[key] = clean
    kept += 1
  }
  return out
}

/* 读一个仓库的草稿。没有就是空串：客户端拿它填输入框，空串恰好就是「无草稿」。
   读是安静的——路径不像话也答空串，不报错：一个读不出草稿的路径，值得的是
   一个空框，不是一条错误。 */
async function draftRead(input) {
  const repo = input != null && isStr(input.repo) ? input.repo.trim() : ''
  const key = repoKeyOf(repo)
  if (repo.length === 0 || repo.charAt(0) !== '/') return { ok: true, repo: key, message: '' }
  const config = await readConfigFile()
  const found = config.drafts[key]
  return { ok: true, repo: key, message: isStr(found) ? found : '' }
}

/* 存一个仓库的草稿。同值不写盘：防抖的保存常在停手之后又来一次同值的，同值的
   那一次连盘都不该碰。写失败原样返回（ok:false 带原因），客户端只把它送进
   控制台 —— 草稿不承载任何主流程，写不进去不能变成一次操作失败。 */
async function draftSave(input) {
  const repo = input != null && isStr(input.repo) ? input.repo.trim() : ''
  const message = input != null && isStr(input.message) ? input.message : ''
  if (repo.length === 0 || repo.length > DRAFT_KEY_MAX || repo.charAt(0) !== '/') {
    return { ok: false, error: 'a repository path is required' }
  }
  const key = repoKeyOf(repo)
  const clean = message.slice(0, DRAFT_LEN_MAX)
  const config = await readConfigFile()
  const drafts = Object.assign({}, config.drafts)
  if (clean.trim().length === 0) delete drafts[key]
  else {
    if (drafts[key] === undefined && Object.keys(drafts).length >= DRAFT_REPOS_MAX) {
      return { ok: false, error: 'too many drafts', repo: key }
    }
    drafts[key] = clean
  }
  if (drafts[key] === config.drafts[key]) return { ok: true, repo: key, unchanged: true }
  /* 写这份文件要这个会话的沙箱策略（它在任何工作区之外，见 writeConfigFile），
     所以调用必须带着 sessionId —— 客户端的 saveDraft 递了。 */
  const written = await writeConfigFile(Object.assign({}, config, { drafts: drafts }), argsAt(input, null))
  if (written.ok !== true) return written
  return { ok: true, repo: key }
}

async function initSnapshot(input, desc) {
  const target = repoFrom(input, null)
  if (target === undefined) return { ok: false, error: 'no-path', stderr: '无法确定要初始化的目录', repo: null }
  const kind = await pathKind(input, target)
  if (kind !== 'dir') {
    return {
      ok: false, error: 'bad-path', repo: target,
      stderr: kind === 'file' ? '目标是一个文件，不是目录' : '目标目录不存在，无法在此初始化仓库',
    }
  }
  const branch = input != null && isStr(input.branch) ? input.branch.trim() : ''
  /* Through `argsAt`, so the session id survives: `git init` is a write, and a
     request that loses its session runs under the deployment's default sandbox
     policy rather than this reader's — which is a "Permission denied" on a
     directory the reader can write to perfectly well. desc 是「命令」页（77-cmdrec.js）
     的中文名，由 RPC 调用点传入。 */
  const args = argsAt(input, target)
  if (branch.length > 0) return await panelMutate(args, ['init', '-b', branch], { desc: desc })
  return await panelMutate(args, ['init'], { desc: desc })
}

