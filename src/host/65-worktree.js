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
