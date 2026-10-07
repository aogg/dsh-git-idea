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
    /* 手动登记的仓库，按工作区分组（61-repos.js）。放在这份配置而不是浏览器
       localStorage：它描述的是「这个项目有哪些仓库」，跟着项目走 —— 换浏览器、
       换机器打开同一个工作区，清单应该还是同一份；localStorage 那层（20-prefs.js）
       留给「这台浏览器怎么看」。 */
    repos: {},
    /* 快捷命令（面板的 ⚡ 按钮，78-actions.js 两侧）。跟 repos 同一个理由：它描述的
       是「这个项目要一键跑什么」，跟着插件走而不是跟着某台浏览器。 */
    quickCommands: [],
  }
  if (raw == null || typeof raw !== 'object') return out
  if (isStr(raw.initBranch)) out.initBranch = raw.initBranch.trim().slice(0, 120)
  out.cherryPickRecord = raw.cherryPickRecord === true
  if (isStr(raw.gitPath)) out.gitPath = cleanGitPath(raw.gitPath)
  out.fetchPrune = raw.fetchPrune !== false
  out.pullRebase = raw.pullRebase === true
  out.pushSetUpstream = raw.pushSetUpstream === true
  out.repos = normalizeRepoMap(raw.repos)
  out.quickCommands = normalizeQuickCommands(raw.quickCommands)
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
       反过来也一样。缓存不作废的话，读者在设置页里把路径改对了，面板还在拿上一个二进
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

async function initSnapshot(input) {
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
     directory the reader can write to perfectly well. */
  const args = argsAt(input, target)
  if (branch.length > 0) return await panelMutate(args, ['init', '-b', branch])
  return await panelMutate(args, ['init'])
}

