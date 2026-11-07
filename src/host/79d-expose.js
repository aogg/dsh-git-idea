/* ─────────────── 跨插件数据暴露（只读）─────────────── */

/* 把这个插件已经会回答的问题，两条通道一次说给别的插件听：

     · cordis 服务：`ctx.provide('dsh-git-idea', api)` —— 其他插件
       `ctx.get('dsh-git-idea')` 直接拿到同一个 api 对象（dsh-ops 的 opsSettings
       同一条先例）。服务只属于本插件自己的 fiber：插件停掉，ctx.get 就拿不到，
       消费方自然走降级。
     · HTTP：`ctx.inject(['webServer'], …)` 挂三条 exact 路由
       `/api/dsh-git-idea/{summary,log,manifest}`（与本插件 rpc / ws-info /
       client-log 同一款注册法）。POST 带 JSON body（与 rpcRoute 同一道
       sameOrigin 门 —— POST 是会被 CSRF 利用的方法），GET 只收 query 参数、
       不设 Origin 门（ws-info 的先例：同源 GET 本就不带 Origin 头；这三条路由
       全是只读聚合，没有可 CSRF 的动作）。

   两条通道共用同一套构建函数（exposeSummary / exposeLog），HTTP 只是把参数洗成
   同一个对象再调它 —— 逻辑只有一份。所有构建函数对不可用的环境都要优雅：
   ssh 插件不在场时远端仓库自然走不通（remoteRouteOf 自己处理）；webServer 不在
   （inject 等不到）就不挂路由，面板与本插件的 RPC 一概不受影响；ctx 上没有
   provide / inject（桥式加载的老外观）也只少一条通道。

   边界：这里只有读，没有写 —— 不 commit、不 checkout、不碰 stash。 */

/* 服务与 API 的版本。数据形状变了自己加一 —— 消费方按 apiVersion 判断能不能读。 */
const EXPOSE_API_VERSION = 1

/* 一次聚合最多读多少仓库：每仓库一次 spawn（整脚本一趟），24 个是「大而不倒」
   的边界 —— 再多的仓库调用方应该点名自己要的那几个。 */
const EXPOSE_REPOS_MAX = 24

/* 每仓库并发：find/status 都是本地毫秒级的事，但慢挂载上一仓 7s 的教训在
   62-panel 就有 —— 串行 24 个最坏要几分钟，三个并发把最坏值压进 1/3。 */
const EXPOSE_CONCURRENCY = 3

/* 概要里的分支/标签名清单只带最近的 40 个（总数在 total 里说），远端名 20 个
   —— 概要是给别的插件看「有什么」，不是给它们抄整张 ref 表。 */
const EXPOSE_NAMES_MAX = 40
const EXPOSE_REMOTES_MAX = 20

/* worktree 的行数帽（porcelain 一条记录约 4–7 行）与 HEAD 一行的字节帽：帽是为了
   一个畸形仓库不会把整份聚合撑爆。 */
const EXPOSE_WORKTREES_MAX = 40
const EXPOSE_HEAD_LINE_MAX = 2000

/* 日志查询的帽子。默认 50、上限 500：numstat 把每条提交的文件清单都搬回来，
   500 条 × 平均几十个文件在 4MB 的 stdout 帽内刚好；再大的 appetite 请分页。 */
const LOG_LIMIT_DEFAULT = 50
const LOG_LIMIT_MAX = 500
const LOG_SKIP_MAX = 100000
const LOG_REPOS_MAX = 8
const LOG_TIMEOUT_MS = 30000
const LOG_MAX_BYTES = 4 * 1024 * 1024

/* ── 参数归一（两个通道共用）──

   HTTP 的 query 是字符串、服务的对象参什么都可能是 —— 归一函数把两种都洗成同
   一份「敢直接拼进 argv 的」参数。数值一律 parseInt 之后再用（common--js 的
   规矩），越界收敛到帽子，不是数字就给默认。 */

function exposeInt(value, fallback, max) {
  const parsed = parseInt(value, 10)
  if (!(parsed > 0)) return fallback
  const cap = parseInt(max, 10)
  if (!(cap > 0) || parsed <= cap) return parsed
  return cap
}

function exposeList(value) {
  if (Array.isArray(value)) {
    const out = []
    for (let i = 0; i < value.length; i += 1) {
      if (isStr(value[i]) && value[i].trim().length > 0 && out.indexOf(value[i].trim()) < 0) out.push(value[i].trim())
    }
    return out
  }
  if (isStr(value) && value.trim().length > 0) return [value.trim()]
  return []
}

function exposeBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

/* 聚合的仓库清单：点名（repos / 单个 repo）优先，否则扫工作区。点名必须过了
   isStoredPath（70-config.js）才算数 —— 相对路径在这里没有意义，git -C 一个
   相对路径只会落在调用方想不到的地方。 */
async function exposeRepoList(input) {
  const asked = exposeList(input != null ? input.repos : null)
  const single = input != null && isStr(input.repo) && input.repo.trim().length > 0 ? input.repo.trim() : ''
  if (single.length > 0 && asked.indexOf(single) < 0) asked.push(single)
  if (asked.length > 0) {
    const kept = []
    for (let i = 0; i < asked.length && kept.length < EXPOSE_REPOS_MAX; i += 1) {
      if (isStoredPath(asked[i]) === true && kept.indexOf(asked[i]) < 0) kept.push(asked[i])
    }
    return { mode: 'repos', repos: kept, scan: null, dropped: asked.length - kept.length }
  }
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) return { mode: 'none', repos: [], scan: null, dropped: 0 }
  /* 工作区扫描复用 61-repos.js 的 readWorkspaceRepos：同一趟 find + 手动清单 +
     登记目录，答复里 found 的仓库才是要逐个读的清单（missing 的名字进 scan，
     让消费方知道登记过但已经不在）。显式 workspace 参数借 sessionCwd 的口进。 */
  const scan = await readWorkspaceRepos(Object.assign({}, input, { sessionCwd: workspace }))
  const total = scan != null && Array.isArray(scan.repos) ? scan.repos.length : 0
  const repos = scan != null && Array.isArray(scan.repos) ? scan.repos.slice(0, EXPOSE_REPOS_MAX) : []
  return { mode: 'workspace', repos: repos, scan: scan, dropped: Math.max(0, total - repos.length) }
}

/* ── 每仓库一份聚合脚本 ──

   复用 pathShell 的外壳（K:dir / 无 git 标记 / safe.directory / gd 解析）、
   branchIdentityShell（B:/U:）与 sequencerShell（S:），中间自己加几段：
     · CT:  status --porcelain=v2 的 awk 计数（staged unstaged untracked
             unmerged）—— 计数在远端就地算完，整棵树的输出不过通道；
     · SK:  stash 条数；
     · WT:…WTE:  worktree list --porcelain（复用 parseWorktreeRows）；
     · RB/RT/RR:  分支与标签的总数 + 名单（截帽）、远端名；
     · HD:  HEAD 一行（hash/short/date/subject，\x1f 分列）。
   一次 spawn 答一个仓库 —— 24 个仓库只是一趟并发里的 24 个进程。 */

/* `printf '<TAG>:%s\n' "$(…)"` 的一行。引号只有三种：JS 里 `\\n` 出来的字面
   `\n` 交给 printf 变换行、`\"` 出来的字面双引号包住命令替换、标签名不带任何
   引号字符 —— 多一个转义这行就哑了（第一版就是在这里写坏的）。 */
function exposeCountLine(tag, command) {
  return "    printf '" + tag + ":%s\\n' \"$(" + command + ")\""
}

/* status 计数一行 awk：porcelain v2 的行类是 `1 XY …` / `2 XY …` / `u …` / `? …`
   （# 开头的 branch 头不进任何模式）。X 位非「.」= staged，Y 位非「.」=
   unstaged。单行单引号包裹 —— 程序里没有单引号字符，双引号归 awk 自己。 */
function exposeCountsAwk() {
  return "awk '/^\\?/{u++} /^1 /{xy=substr($2,1,2); if (substr(xy,1,1) != \".\") s++; if (substr(xy,2,1) != \".\") g++; next} /^2 /{xy=substr($2,1,2); if (substr(xy,1,1) != \".\") s++; if (substr(xy,2,1) != \".\") g++; next} /^u /{m++} END { printf \"%d %d %d %d\\n\", s+0, g+0, u+0, m+0 }'"
}

function exposeRepoScript(target) {
  const quoted = shq(target)
  const at = gitCmd() + ' -C ' + quoted
  return pathShell(target, [
    '  if [ -z "$gd" ]; then',
    "    printf 'RC:1\\n'",
    "    printf 'fatal: not a git repository\\n'",
    '  else',
    branchIdentityShell(target),
    sequencerShell(),
    exposeCountLine('CT', at + ' status --porcelain=v2 --branch 2>/dev/null | ' + exposeCountsAwk()),
    exposeCountLine('SK', at + ' stash list 2>/dev/null | grep -c .'),
    "    printf 'WT:\\n'",
    '    LC_ALL=C ' + at + ' -c core.quotePath=false worktree list --porcelain 2>/dev/null | head -n ' + String(EXPOSE_WORKTREES_MAX + 2),
    "    printf 'WTE:\\n'",
    exposeCountLine('RB', at + " for-each-ref refs/heads --format='x' 2>/dev/null | grep -c ."),
    "    printf 'RBL:\\n'",
    '    ' + at + " for-each-ref --format='%(refname:short)' --sort=-committerdate refs/heads 2>/dev/null | head -n " + String(EXPOSE_NAMES_MAX),
    "    printf 'RBLE:\\n'",
    exposeCountLine('RT', at + " for-each-ref refs/tags --format='x' 2>/dev/null | grep -c ."),
    "    printf 'RTL:\\n'",
    '    ' + at + " for-each-ref --format='%(refname:short)' --sort=-creatordate refs/tags 2>/dev/null | head -n " + String(EXPOSE_NAMES_MAX),
    "    printf 'RTLE:\\n'",
    "    printf 'RR:\\n'",
    '    ' + at + ' remote 2>/dev/null | head -n ' + String(EXPOSE_REMOTES_MAX),
    "    printf 'RRE:\\n'",
    exposeCountLine('HD', 'LC_ALL=C ' + at + ' log -1 --pretty=format:%H%x1f%h%x1f%aI%x1f%s 2>/dev/null | head -c ' + String(EXPOSE_HEAD_LINE_MAX)),
    "    printf 'RC:0\\n'",
    '  fi',
  ].join('\n'))
}

/* 成对标记之间的原样行（WT:…WTE:、RBL:…RBLE:、RTL:…RTLE:、RR:…RRE:）。 */
function exposeBlockParse(lines, open, close) {
  const out = []
  let inside = false
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === close) { inside = false; continue }
    if (lines[i] === open) { inside = true; continue }
    if (inside === true && lines[i].length > 0) out.push(lines[i])
  }
  return out
}

function exposeHeadLine(raw) {
  if (!isStr(raw) || raw.length === 0) return null
  const fields = raw.split('\u001f')
  if (field(fields, 0).length < 7) return null
  return {
    hash: field(fields, 0),
    short: field(fields, 1),
    date: field(fields, 2),
    subject: field(fields, 3),
  }
}

/* 一份脚本 stdout → 一个仓库的概要对象。任何一段读不出来都把那一小段留空，不让
   一个坏段落拖垮整仓 —— 概要是聚合，诚实比整齐重要。 */
function exposeRepoFromOutput(target, stdout) {
  const lines = stdout.split('\n')
  const kind = lines.length > 0 ? lines[0] : ''
  if (kind === 'K:file') return { path: target, ok: false, error: 'not-a-repository', reason: 'file' }
  if (kind !== 'K:dir') return { path: target, ok: false, error: 'not-a-repository', reason: 'missing' }
  let exitCode = null
  let sequencer = null
  let branch = null
  let upstream = null
  let track = ''
  let countsLine = ''
  let stashLine = ''
  let headLine = ''
  let branchTotal = ''
  let tagTotal = ''
  let noGit = false
  let unsafeOwner = false
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === PANEL_NO_GIT) { noGit = true; continue }
    if (line === PANEL_UNSAFE_OWNER) { unsafeOwner = true; continue }
    if (line.indexOf('RC:') === 0) { exitCode = parseInt(line.slice(3), 10); continue }
    if (line.indexOf('S:') === 0) { if (sequencer === null) sequencer = line.slice(2); continue }
    if (line.indexOf('B:') === 0) { branch = line.slice(2); continue }
    if (line.indexOf('U:') === 0) {
      const fields = line.slice(2).split('\u001f')
      upstream = field(fields, 0)
      track = field(fields, 1)
      continue
    }
    if (line.indexOf('CT:') === 0 && countsLine.length === 0) { countsLine = line.slice(3); continue }
    if (line.indexOf('SK:') === 0 && stashLine.length === 0) { stashLine = line.slice(3); continue }
    if (line.indexOf('RB:') === 0 && branchTotal.length === 0) { branchTotal = line.slice(3); continue }
    if (line.indexOf('RT:') === 0 && tagTotal.length === 0) { tagTotal = line.slice(3); continue }
    if (line.indexOf('HD:') === 0 && headLine.length === 0) { headLine = line.slice(3); continue }
  }
  if (noGit === true) return { path: target, ok: false, error: 'no-git', reason: 'no-git' }
  if (unsafeOwner === true) return { path: target, ok: false, error: 'unsafe-owner', reason: 'unsafe-owner' }
  if (exitCode !== 0) return { path: target, ok: false, error: 'not-a-repository', reason: 'not-a-repo' }

  /* awk 的四个数与三个总数一律 parseInt（common--js：数值比较前先转）—— "0" 和
     0 在这里就分清楚，别等消费方比较时踩。 */
  const counts = countsLine.trim().split(/\s+/)
  const stashParsed = parseInt(stashLine.trim(), 10)
  const trackParsed = trackCounts(track)
  return {
    path: target,
    ok: true,
    branch: branch !== null && branch.length > 0 ? branch : null,
    detached: branch === null || branch.length === 0,
    upstream: upstream != null && upstream.length > 0 ? upstream : null,
    ahead: trackParsed.ahead,
    behind: trackParsed.behind,
    sequencer: sequencer,
    counts: {
      staged: parseInt(field(counts, 0), 10) || 0,
      unstaged: parseInt(field(counts, 1), 10) || 0,
      untracked: parseInt(field(counts, 2), 10) || 0,
      unmerged: parseInt(field(counts, 3), 10) || 0,
    },
    stash: stashParsed > 0 ? stashParsed : 0,
    worktrees: parseWorktreeRows(exposeBlockParse(lines, 'WT:', 'WTE:').join('\n'))
      .slice(1)
      .filter(function (row) { return row.bare !== true })
      .slice(0, EXPOSE_WORKTREES_MAX),
    head: exposeHeadLine(headLine),
    refs: {
      branches: {
        total: parseInt(branchTotal.trim(), 10) || 0,
        names: exposeBlockParse(lines, 'RBL:', 'RBLE:').slice(0, EXPOSE_NAMES_MAX),
      },
      tags: {
        total: parseInt(tagTotal.trim(), 10) || 0,
        names: exposeBlockParse(lines, 'RTL:', 'RTLE:').slice(0, EXPOSE_NAMES_MAX),
      },
      remotes: exposeBlockParse(lines, 'RR:', 'RRE:').slice(0, EXPOSE_REMOTES_MAX),
    },
  }
}

/* 简单并发池：worker 一个接一个地领活，同时在跑的最多 limit 个。聚合对顺序没有
   要求，答复按请求的仓库顺序排。 */
async function exposeEachLimit(list, limit, worker) {
  const out = new Array(list.length)
  let next = 0
  async function lane() {
    for (;;) {
      const mine = next
      next += 1
      if (mine >= list.length) return
      out[mine] = await worker(list[mine], mine)
    }
  }
  const lanes = []
  const lanesCount = limit > 0 ? Math.min(limit, list.length) : 1
  for (let i = 0; i < lanesCount; i += 1) lanes.push(lane())
  await Promise.all(lanes)
  return out
}

/* ── 聚合数据构建：两条通道共用的那一份 ── */
async function exposeSummary(input) {
  const startedAt = Date.now()
  const resolved = await exposeRepoList(input)
  const reply = {
    ok: true,
    apiVersion: EXPOSE_API_VERSION,
    plugin: 'dsh-git-idea',
    generatedAt: new Date().toISOString(),
    scope: { mode: resolved.mode, workspace: resolved.mode === 'workspace' ? sessionWorkdir(input) : null, repos: resolved.repos },
    repoCount: resolved.repos.length,
    repos: [],
  }
  if (resolved.scan != null) {
    reply.scan = {
      repos: resolved.scan.repos, manual: resolved.scan.manual, missing: resolved.scan.missing,
      links: resolved.scan.links, dirs: resolved.scan.dirs, dirRepos: resolved.scan.dirRepos,
    }
  }
  if (resolved.dropped > 0) reply.droppedRepos = resolved.dropped
  if (resolved.repos.length === 0) {
    reply.reposOkCount = 0
    reply.elapsedMs = Date.now() - startedAt
    if (resolved.mode === 'none') reply.error = 'no-workspace'
    return reply
  }
  /* 每仓库一趟脚本；workdir 用仓库自己 —— 显式点名时（HTTP 通道没有会话）远端
     仓库的 ssh:// 前缀才能被 remoteRouteOf 认出来（11-remote.js）。 */
  const rows = await exposeEachLimit(resolved.repos, EXPOSE_CONCURRENCY, async function (repo) {
    try {
      const probe = await invoke(exposeRepoScript(repo), argsAt(input, repo), null, { timeoutMs: 30000 })
      if (probe.timedOut === true) return { path: repo, ok: false, error: 'timeout' }
      const parsed = exposeRepoFromOutput(repo, probe.stdout)
      if (parsed.ok !== true && parsed.reason !== 'missing' && parsed.reason !== 'file' && probe.stderr.length > 0) {
        parsed.stderr = probe.stderr.slice(0, 400)
      }
      return parsed
    } catch (error) {
      /* ssh 通道开不出来（沙箱只读、bash 没就绪）这类抛错落在这里：仓库行给
         error，聚合的其他仓库照常 —— 一仓的失败不是整份聚合的失败。 */
      return { path: repo, ok: false, error: error != null && error.message !== undefined ? String(error.message) : String(error) }
    }
  })
  reply.repos = rows
  let okCount = 0
  for (let i = 0; i < rows.length; i += 1) if (rows[i].ok === true) okCount += 1
  reply.reposOkCount = okCount
  reply.elapsedMs = Date.now() - startedAt
  return reply
}

/* ─────────────── 多条件日志查询 ─────────────── */

/* 参数（对象参或 HTTP query 都一样，归一后见 exposeLogParams）：

     repo / repos        仓库（单个或多个，≤ LOG_REPOS_MAX）；都不给时用会话工作区
                         自己（与面板「当前仓库」同一个口径）
     ref                 单个分支/ref（也接受 `a..b` 这类范围写法，git 自己认）
     from / to           范围两半：拼成 `from..to`（to 可达、from 不可达的提交）
     all                 true = --all
     authors / author    作者，单个或数组（每项一个 --author=，多个取并集）
     since / until       日期范围（git 认的任何写法）
     grep                关键词，单个或数组（每项一个 --grep=）
     grepAll             true = --all-match（多个 --grep 同时命中才算）
     regex               true = 关键词按扩展正则（默认字面量 fixed-strings）
     caseSensitive       true = 大小写敏感（默认 -i 忽略大小写）
     paths / path        路径过滤（`--` 之后的 pathspec）
     limit / skip        分页（默认 50 / 上限 500；skip 上限 100000）
     includeFiles        false = 不带 --numstat（轻查询；默认带）
     detectRenames       false = 不带 -M（默认带）
     firstParent         true = --first-parent
     merges              'only' = --merges；'exclude' = --no-merges；默认都算
     reverse             true = --reverse

   输出：每条提交带 hash/short/作者与提交者两侧/subject/body/refs/parents，以及
   includeFiles !== false 时的文件清单（path、added、deleted、renamed、oldPath、
   binary）与 stats（filesChanged/additions/deletions）。多仓库时每条提交带
   repo 字段，commits 是按作者日期倒序的合集；limit/skip 逐仓库生效 —— 跨仓库
   全局分页没有干净的定义，诚实交回每仓自己的页。 */

function exposeLogParams(input) {
  const asked = input != null ? input : {}
  const params = {
    repos: exposeList(asked.repos),
    ref: isStr(asked.ref) && asked.ref.trim().length > 0 ? asked.ref.trim() : '',
    from: isStr(asked.from) && asked.from.trim().length > 0 ? asked.from.trim() : '',
    to: isStr(asked.to) && asked.to.trim().length > 0 ? asked.to.trim() : '',
    all: exposeBool(asked.all),
    authors: exposeList(asked.authors),
    since: isStr(asked.since) && asked.since.trim().length > 0 ? asked.since.trim() : '',
    until: isStr(asked.until) && asked.until.trim().length > 0 ? asked.until.trim() : '',
    grep: exposeList(asked.grep),
    grepAll: exposeBool(asked.grepAll),
    regex: exposeBool(asked.regex),
    caseSensitive: exposeBool(asked.caseSensitive),
    paths: exposeList(asked.paths),
    limit: exposeInt(asked.limit, LOG_LIMIT_DEFAULT, LOG_LIMIT_MAX),
    skip: exposeInt(asked.skip, 0, LOG_SKIP_MAX),
    includeFiles: asked.includeFiles === undefined ? true : exposeBool(asked.includeFiles),
    detectRenames: asked.detectRenames === undefined ? true : exposeBool(asked.detectRenames),
    firstParent: exposeBool(asked.firstParent),
    merges: asked.merges === 'only' || asked.merges === 'exclude' ? asked.merges : '',
    reverse: exposeBool(asked.reverse),
  }
  const single = isStr(asked.repo) && asked.repo.trim().length > 0 ? asked.repo.trim() : ''
  if (single.length > 0 && params.repos.indexOf(single) < 0) params.repos.unshift(single)
  params.repos = params.repos.filter(function (repo) { return isStoredPath(repo) === true }).slice(0, LOG_REPOS_MAX)
  return params
}

function exposeLogRangeOf(params) {
  if (params.from.length > 0 || params.to.length > 0) {
    if (params.from.length > 0 && params.to.length > 0) return params.from + '..' + params.to
    return params.from.length > 0 ? params.from + '..HEAD' : 'HEAD..' + params.to
  }
  if (params.ref.length > 0) return params.ref
  return ''
}

function exposeLogArgv(params, range) {
  /* 字段序（0–11）：hash short 作者名/邮箱/日期 提交者名/邮箱/日期 subject body
     refs parents —— \x1e 收尾、\x1f 分列，解析见 exposeParseLog。 */
  const pretty = '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%b%x1f%D%x1f%P%x1e'
  /* max-count 永远比 limit 多一条：多出的那条不回，它就是「还有更多」这句话。 */
  const argv = ['-c', 'core.quotePath=false', 'log', '--max-count=' + String(params.limit + 1), pretty]
  if (params.skip > 0) argv.push('--skip=' + String(params.skip))
  /* grep 的匹配器二选一：regex → 扩展正则；其余字面量 --fixed-strings（作者
     同样按字面量）。 */
  if ((params.grep.length > 0 && params.regex !== true) || params.authors.length > 0) argv.push('--fixed-strings')
  if (params.grep.length > 0) {
    for (let i = 0; i < params.grep.length; i += 1) argv.push('--grep=' + params.grep[i])
    if (params.regex === true) argv.push('--extended-regexp')
    if (params.grepAll === true) argv.push('--all-match')
    if (params.caseSensitive !== true) argv.push('-i')
  }
  for (let i = 0; i < params.authors.length; i += 1) argv.push('--author=' + params.authors[i])
  if (params.since.length > 0) argv.push('--since=' + params.since)
  if (params.until.length > 0) argv.push('--until=' + params.until)
  if (params.firstParent === true) argv.push('--first-parent')
  if (params.merges === 'only') argv.push('--merges')
  if (params.merges === 'exclude') argv.push('--no-merges')
  if (params.includeFiles !== false) {
    /* -M 找重命名；-z 让 numstat 的路径按 \0 分隔原样交出（不引号化，改名条目
       是 `add\tdel\t\0新\0旧\0`）—— 解析见 exposeParseNumstat。 */
    if (params.detectRenames !== false) argv.push('-M')
    argv.push('--numstat', '-z')
  }
  if (params.reverse === true) argv.push('--reverse')
  if (params.all === true) argv.push('--all')
  else if (range.length > 0) argv.push(range)
  if (params.paths.length > 0) {
    argv.push('--')
    for (let i = 0; i < params.paths.length; i += 1) argv.push(params.paths[i])
  }
  return argv
}

/* numstat -z 的 section：每条 `added\tdeleted\tpath\0`，改名条目是
   `added\tdeleted\t\0新\0旧\0`，二进制是 `-\t-\tpath\0`；token 流式解析。 */
function exposeParseNumstat(section) {
  const files = []
  const tokens = section.split('\u0000')
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.length === 0) { i += 1; continue }
    const cols = token.split('\t')
    const addedRaw = field(cols, 0).trim()
    const deletedRaw = field(cols, 1).trim()
    const binary = addedRaw === '-' && deletedRaw === '-'
    const added = binary === true ? null : parseInt(addedRaw, 10) || 0
    const deleted = binary === true ? null : parseInt(deletedRaw, 10) || 0
    if (cols.length <= 3 && field(cols, 2) === '') {
      /* 改名：随后的两个 token 是新、旧路径。 */
      const newPath = tokens[i + 1]
      const oldPath = tokens[i + 2]
      if (isStr(newPath) && newPath.length > 0) {
        files.push({ path: newPath, oldPath: isStr(oldPath) && oldPath.length > 0 ? oldPath : null, added: added, deleted: deleted, binary: binary, renamed: true })
        i += 3
        continue
      }
      i += 1
      continue
    }
    /* 路径可能带 \t（文件名里 \t 合法）—— 第 3 列起整段拼回去，别只取一列。 */
    const path = cols.slice(2).join('\t')
    if (path.length === 0) { i += 1; continue }
    files.push({ path: path, oldPath: null, added: added, deleted: deleted, binary: binary, renamed: false })
    i += 1
  }
  return files
}

/* 一份 `log --pretty … --numstat -z` 的 stdout → 提交数组。

   布局（本仓库实测字节序）：字段串以 \x1e 收尾；随后 `\n`、该提交的 numstat 段
   （每条以 \0 收尾，整段再补一个多余的 \0）、下一条的字段串。所以按 \x1e 切开的
   每段（除第一段）=「上一条的 numstat + 本条的字段串」；\0 不出现在字段串里，
   本条字段串从最后一个 \0 之后开始。 */
function exposeParseLog(stdout) {
  const pairs = []
  const chunks = stdout.split('\u001e')
  let pending = ''
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]
    if (i === 0) { pending = chunk; continue }
    pairs.push(pending, null)
    const lastNul = chunk.lastIndexOf('\u0000')
    if (lastNul >= 1) {
      pairs[pairs.length - 1] = exposeParseNumstat(chunk.slice(1, lastNul))
      pending = chunk.slice(lastNul + 1)
    } else {
      /* 没有 \0：numstat 段为空（merge 提交默认不产生 numstat）—— 段里只有那个
         分隔换行，它不属于字段串，剥掉。 */
      const term = chunk.indexOf('\u0000')
      pairs[pairs.length - 1] = term >= 0 ? exposeParseNumstat(chunk.slice(1, term)) : []
      pending = term >= 0 ? chunk.slice(term + 1) : chunk.replace(/^\n+/, '')
    }
  }
  /* 最后一条的字段串一直躺在 pending 里 —— 补上（它没有随后的 numstat 段）。 */
  if (pending.length > 0) pairs.push(pending, [])
  const out = []
  for (let i = 0; i < pairs.length; i += 2) {
    const fields = pairs[i].split('\u001f')
    /* 被通道截半的最后一条：hash 不成形就不收，宁可少一条，不给半条。 */
    if (/^[0-9a-f]{7,40}$/.test(field(fields, 0)) !== true) break
    const parentsRaw = field(fields, 11)
    const parents = []
    if (parentsRaw.length > 0) {
      const parts = parentsRaw.split(' ')
      for (let k = 0; k < parts.length; k += 1) if (parts[k].length > 0) parents.push(parts[k])
    }
    out.push({
      hash: field(fields, 0),
      short: field(fields, 1),
      author: { name: field(fields, 2), email: field(fields, 3), date: field(fields, 4) },
      committer: { name: field(fields, 5), email: field(fields, 6), date: field(fields, 7) },
      subject: field(fields, 8),
      body: field(fields, 9).replace(/\n+$/, ''),
      refs: field(fields, 10),
      parents: parents,
      files: pairs[i + 1] != null ? pairs[i + 1] : [],
    })
  }
  return out
}

function exposeLogSummary(files) {
  let additions = 0
  let deletions = 0
  for (let i = 0; i < files.length; i += 1) {
    additions += files[i].added === null ? 0 : files[i].added
    deletions += files[i].deleted === null ? 0 : files[i].deleted
  }
  return { filesChanged: files.length, additions: additions, deletions: deletions }
}

/* 单仓库一次查询。unborn（还没有任何提交）不是错误 —— readGraph 同一口径。 */
async function exposeLogRepo(repo, params, range, input) {
  const args = argsAt(input, repo)
  const argv = exposeLogArgv(params, range)
  const logged = await git(args, argv, null, { timeoutMs: LOG_TIMEOUT_MS, maxBytes: LOG_MAX_BYTES })
  const answer = {
    repo: repo,
    ok: logged.exitCode === 0,
    unborn: false,
    commits: [],
    hasMore: false,
    outputTruncated: logged.truncated === true,
    stderr: '',
    error: '',
  }
  if (logged.exitCode !== 0) {
    /* ── 一个提交都还没有的仓库 ── 判据与 64-history readGraph 相同：rev-parse
       --git-dir 能答上来 = 确实是仓库，--verify HEAD 答不上来 = 还没有提交。 */
    const verifyHead = await git(args, ['rev-parse', '-q', '--verify', 'HEAD'], null, {})
    if (verifyHead.exitCode !== 0) {
      const gitDir = await git(args, ['rev-parse', '--git-dir'], null, {})
      if (gitDir.exitCode === 0) {
        answer.ok = true
        answer.unborn = true
        return answer
      }
    }
    answer.error = 'not-a-repository'
    answer.stderr = logged.stderr.slice(0, 400)
    answer.noGit = gitMissing(logged)
    return answer
  }
  let rows = exposeParseLog(logged.stdout)
  answer.hasMore = rows.length > params.limit
  if (answer.hasMore === true) rows = rows.slice(0, params.limit)
  for (let i = 0; i < rows.length; i += 1) {
    rows[i].stats = exposeLogSummary(rows[i].files)
    if (params.includeFiles === false) rows[i].files = []
  }
  answer.commits = rows
  return answer
}

/* 查询落点：点名仓库优先；都不给时用会话工作区自己（与面板「当前仓库」同一个
   口径 —— repoFrom 也是它）。工作区不是仓库根时 git log 会向上找到包含它的
   仓库，这是查询 API 合理的行为；面板 own-dir 的口径是给「身份读」用的。 */
async function exposeLogScope(input) {
  const params = exposeLogParams(input)
  let repos = params.repos
  let mode = 'repos'
  if (repos.length === 0) {
    const workspace = sessionWorkdir(input)
    if (workspace === undefined) return { params: params, repos: [], mode: 'none' }
    repos = [workspace]
    mode = 'workspace'
  }
  return { params: params, repos: repos, mode: mode }
}

async function exposeLog(input) {
  const startedAt = Date.now()
  const scope = await exposeLogScope(input)
  const params = scope.params
  const range = exposeLogRangeOf(params)
  const reply = {
    ok: true,
    apiVersion: EXPOSE_API_VERSION,
    plugin: 'dsh-git-idea',
    generatedAt: new Date().toISOString(),
    scope: { mode: scope.mode, repos: scope.repos, range: range, all: params.all },
    query: {
      authors: params.authors, since: params.since, until: params.until, grep: params.grep,
      grepAll: params.grepAll, regex: params.regex, caseSensitive: params.caseSensitive,
      paths: params.paths, limit: params.limit, skip: params.skip,
      includeFiles: params.includeFiles, detectRenames: params.detectRenames,
      firstParent: params.firstParent, merges: params.merges, reverse: params.reverse,
    },
    repos: [],
    commits: [],
    commitCount: 0,
  }
  if (scope.repos.length === 0) {
    reply.error = 'no-repository'
    reply.elapsedMs = Date.now() - startedAt
    return reply
  }
  const answers = await exposeEachLimit(scope.repos, EXPOSE_CONCURRENCY, async function (repo) {
    try {
      return await exposeLogRepo(repo, params, range, input)
    } catch (error) {
      return { repo: repo, ok: false, unborn: false, commits: [], hasMore: false, outputTruncated: false, stderr: '', error: error != null && error.message !== undefined ? String(error.message) : String(error) }
    }
  })
  reply.repos = answers
  const merged = []
  for (let i = 0; i < answers.length; i += 1) {
    const one = answers[i]
    if (one.ok !== true) continue
    for (let k = 0; k < one.commits.length; k += 1) {
      one.commits[k].repo = one.repo
      merged.push(one.commits[k])
    }
  }
  /* 多仓合集按作者日期倒序并。%aI 是带时区的 ISO，字符串比较对跨时区不可靠 ——
     Date.parse 成毫秒数（本来就是 Number）再比。同一毫秒按仓库序保持稳定。 */
  if (answers.length > 1) {
    merged.sort(function (left, right) {
      const lt = Date.parse(left.author.date)
      const rt = Date.parse(right.author.date)
      const ln = isNaN(lt) ? 0 : lt
      const rn = isNaN(rt) ? 0 : rt
      if (ln !== rn) return rn - ln
      return left.repo < right.repo ? -1 : (left.repo > right.repo ? 1 : 0)
    })
  }
  reply.commits = merged
  reply.commitCount = merged.length
  reply.elapsedMs = Date.now() - startedAt
  return reply
}

/* ─────────────── 两条通道 ─────────────── */

const EXPOSE_API_BASE = '/api/dsh-git-idea'

/* 服务对象：其他插件 `ctx.get('dsh-git-idea')` 拿到的就是它。manifest 描述两条
   通道的全部形状，供发现与自检。 */
const exposeService = {
  name: 'dsh-git-idea',
  apiVersion: EXPOSE_API_VERSION,
  summary: exposeSummary,
  log: exposeLog,
  manifest: function () {
    return {
      ok: true,
      apiVersion: EXPOSE_API_VERSION,
      plugin: 'dsh-git-idea',
      service: 'dsh-git-idea',
      httpBase: EXPOSE_API_BASE,
      routes: [
        { path: EXPOSE_API_BASE + '/summary', methods: ['GET', 'POST'], description: '跨仓库只读聚合：仓库清单/分支/ahead-behind/脏文件计数/stash/worktree/refs-tags 概要' },
        { path: EXPOSE_API_BASE + '/log', methods: ['GET', 'POST'], description: '多条件 git log 查询（作者/日期/关键词/路径/范围/分页 + 每条提交的文件与增删行数）' },
        { path: EXPOSE_API_BASE + '/manifest', methods: ['GET'], description: '本清单' },
      ],
      docs: 'docs/被扩展说明.md',
    }
  },
}

/* HTTP 参数：query 里的数组键按重复键收（repos=/a&repos=/b），单值键收最后一个，
   布尔键收 true/1，数值键 parseInt（归一函数里做）。 */
function exposeParamsFromQuery(search) {
  const one = function (key) {
    const all = search.getAll(key)
    return all.length > 0 ? all[all.length - 1] : ''
  }
  const many = function (key) { return search.getAll(key) }
  return {
    repos: many('repos'),
    repo: one('repo'),
    workspace: one('workspace'),
    sessionId: one('sessionId'),
    ref: one('ref'),
    from: one('from'),
    to: one('to'),
    all: one('all'),
    authors: many('authors'),
    author: one('author'),
    since: one('since'),
    until: one('until'),
    grep: many('grep'),
    grepAll: one('grepAll'),
    regex: one('regex'),
    caseSensitive: one('caseSensitive'),
    paths: many('paths'),
    path: one('path'),
    limit: one('limit'),
    skip: one('skip'),
    includeFiles: one('includeFiles'),
    detectRenames: one('detectRenames'),
    firstParent: one('firstParent'),
    merges: one('merges'),
    reverse: one('reverse'),
  }
}

/* 作者与关键词的单数键（HTTP 用起来顺手）：有的话并进复数清单。 */
function exposeMergeSingles(params) {
  if (isStr(params.author) && params.author.trim().length > 0 && params.authors.indexOf(params.author.trim()) < 0) {
    params.authors.unshift(params.author.trim())
  }
  if (isStr(params.path) && params.path.trim().length > 0 && params.paths.indexOf(params.path.trim()) < 0) {
    params.paths.unshift(params.path.trim())
  }
  return params
}

function exposeSendJson(response, status, payload) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/* POST 的 body 读取与 rpcRoute（host-pre.js）同一形状，但这里是宿主片段，桥式
   构建里没有 host-pre —— 自带一份，1MB 帽。 */
function exposeReadBody(request) {
  return new Promise(function (resolve, reject) {
    const chunks = []
    let size = 0
    request.on('data', function (chunk) {
      const buffer = Buffer.isBuffer(chunk) === true ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > 1048576) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.on('end', function () {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) { resolve(null); return }
      try { resolve(JSON.parse(text)) } catch (error) { reject(error) }
    })
    request.on('error', reject)
  })
}

/* query 参数里「真的带了值」——数组看长度，单值看非空。 */
function exposeParamPresent(value) {
  if (Array.isArray(value) === true) return value.length > 0
  return value !== '' && value !== undefined && value !== null
}

/* 三条路由共同的壳：POST 必同源（rpcRoute 同一道门），GET 免 Origin（ws-info 的
   理由：同源 GET 不带 Origin 头）；答复一律 JSON，失败也给 {ok:false,error}，
   HTTP 状态只在「这根本不是一个合法请求」时才不是 200。 */
function exposeRoute(builder) {
  return async function (request, response) {
    try {
      if (request.method !== 'GET' && request.method !== 'POST') {
        exposeSendJson(response, 405, { ok: false, error: request.method + ' is not supported; use GET or POST' })
        return
      }
      let params = null
      if (request.method === 'POST') {
        const origin = request.headers.origin
        const host = request.headers.host
        let sameOrigin = false
        if (origin !== undefined && host !== undefined) {
          try { sameOrigin = new URL(origin).host === host } catch (error) { sameOrigin = false }
        }
        if (sameOrigin !== true) {
          exposeSendJson(response, 403, { ok: false, error: 'same-origin requests only (POST)' })
          return
        }
        let body = null
        try { body = await exposeReadBody(request) } catch (error) {
          exposeSendJson(response, 400, { ok: false, error: error != null && error.message !== undefined ? String(error.message) : 'bad request body' })
          return
        }
        params = body != null && typeof body === 'object' && Array.isArray(body) !== true ? body : {}
        /* query 里带的值补进 body 没有的键：body 显式给的赢，query 只是补充。 */
        const search = new URL(request.url === undefined ? '/' : request.url, 'http://dsh.local').searchParams
        const query = exposeParamsFromQuery(search)
        for (const key in query) {
          if (Object.prototype.hasOwnProperty.call(query, key) !== true) continue
          if (exposeParamPresent(query[key]) === true && params[key] === undefined) params[key] = query[key]
        }
      } else {
        params = exposeParamsFromQuery(new URL(request.url === undefined ? '/' : request.url, 'http://dsh.local').searchParams)
      }
      const value = await builder(params)
      exposeSendJson(response, 200, value)
    } catch (error) {
      exposeSendJson(response, 200, { ok: false, error: error != null && error.message !== undefined ? String(error.message) : String(error) })
    }
  }
}

/* 显式 workspace（HTTP 通道没有会话时的落点）：借 sessionCwd 的口进 ——
   sessionWorkdir(input) 第一眼就读它（60-reads.js）。 */
function exposeWorkspaceOverride(params) {
  if (isStr(params.workspace) === true && params.workspace.trim().length > 0 && !(isStr(params.sessionId) === true && params.sessionId.length > 0)) {
    params.sessionCwd = params.workspace.trim()
  }
  return params
}

function exposeSummaryRouteHandler(request, response) {
  return exposeRoute(function (params) {
    return exposeSummary(exposeWorkspaceOverride(exposeMergeSingles(params)))
  })(request, response)
}

function exposeLogRouteHandler(request, response) {
  return exposeRoute(function (params) {
    return exposeLog(exposeWorkspaceOverride(exposeMergeSingles(params)))
  })(request, response)
}

function exposeManifestRouteHandler(request, response) {
  exposeSendJson(response, 200, exposeService.manifest())
}

/* 注册。shell 缺席时 00-plugin.js 已经提前 return，这里根本走不到；webServer
   缺席时 inject 等不到、路由不挂；ctx 上没有 inject/provide（桥式外观的老版本）
   时各少一条通道，互不影响。 */
function exposeRegister(context) {
  if (typeof context.provide === 'function') {
    try {
      context.provide('dsh-git-idea', exposeService)
    } catch (error) {
      console.error('dsh-git-idea: 服务注册失败（HTTP 通道不受影响）', String(error))
    }
  }
  if (typeof context.inject === 'function') {
    context.inject(['webServer'], function (scope) {
      scope.effect(function () {
        return scope.webServer.register({ kind: 'exact', path: EXPOSE_API_BASE + '/summary', handler: exposeSummaryRouteHandler })
      }, 'dsh-git-idea expose summary route')
      scope.effect(function () {
        return scope.webServer.register({ kind: 'exact', path: EXPOSE_API_BASE + '/log', handler: exposeLogRouteHandler })
      }, 'dsh-git-idea expose log route')
      scope.effect(function () {
        return scope.webServer.register({ kind: 'exact', path: EXPOSE_API_BASE + '/manifest', handler: exposeManifestRouteHandler })
      }, 'dsh-git-idea expose manifest route')
    })
  }
}

exposeRegister(ctx)
