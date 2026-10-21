/* ─────────────── authors, refs, branches, and switching ─────────────── */

async function readAuthors(input, repo) {
  const args = argsFor(input)
  const listed = await git(args, ['--no-pager', 'shortlog', '-sne', '--all'], null, { maxBytes: 200000 })
  if (listed.exitCode !== 0) {
    return { ok: false, repo: repo === undefined ? null : repo, error: 'not-a-repository', stderr: listed.stderr, noGit: gitMissing(listed), authors: [] }
  }
  const authors = []
  const rows = listed.stdout.split('\n')
  for (let i = 0; i < rows.length && authors.length < 120; i += 1) {
    const row = rows[i]
    if (row.length === 0) continue
    const tab = row.indexOf('\t')
    if (tab < 0) continue
    const count = parseInt(row.slice(0, tab).trim(), 10) || 0
    const who = row.slice(tab + 1).trim()
    if (who.length === 0) continue
    const open = who.lastIndexOf('<')
    const close = who.lastIndexOf('>')
    const name = open > 0 ? who.slice(0, open).trim() : who
    const email = open >= 0 && close > open ? who.slice(open + 1, close).trim() : ''
    authors.push({ name: name, email: email, count: count })
  }
  return { ok: true, repo: listed.cwd, authors: authors }
}

/* shortlog walks the entire history for every author, so it is the most
   expensive read there is. It is deferred by the client to the history tab and
   then held until something invalidates it. */
async function authorsSnapshot(input) {
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readAuthors(input, undefined)
  return await cached(repo, 'authors', function () { return readAuthors(input, repo) })
}

async function readRefs(input, repo) {
  const args = argsFor(input)
  /* The tracking columns matter as much as the names here: the tree is where a
     branch and its standing against its upstream are seen together, and the
     atoms are free once the command is running anyway. */
  /* `gitC`, not `git`: %(upstream:track) is a translated string and parsing it
     needs the same pinned locale the branch list already runs under. */
  const listed = await gitC(args, ['-c', 'core.quotePath=false', 'for-each-ref',
    '--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix)',
    'refs/heads', 'refs/remotes'], null, {})
  if (listed.exitCode !== 0) {
    return { ok: false, repo: repo === undefined ? null : repo, error: 'not-a-repository', stderr: listed.stderr, noGit: gitMissing(listed), current: [], local: [], remote: [] }
  }
  const local = []
  const current = []
  const remoteMap = new Map()
  const rows = listed.stdout.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].length === 0) continue
    const fields = rows[i].split('\u001f')
    const full = field(fields, 0)
    const short = field(fields, 1)
    const isCurrent = fields[2] === '*'
    if (full.indexOf('refs/heads/') === 0) {
      const counts = trackCounts(field(fields, 5))
      local.push({
        segments: short.split('/'), data: short,
        upstream: field(fields, 4),
        ahead: counts.ahead, behind: counts.behind,
        at: parseInt(fields[6], 10) || 0,
      })
      if (isCurrent) current.push(short)
    } else if (full.indexOf('refs/remotes/') === 0) {
      const slash = short.indexOf('/')
      const remoteName = slash < 0 ? short : short.slice(0, slash)
      const rest = slash < 0 ? short : short.slice(slash + 1)
      if (rest.length === 0 || rest === 'HEAD') continue
      if (!remoteMap.has(remoteName)) remoteMap.set(remoteName, [])
      remoteMap.get(remoteName).push({ segments: rest.split('/'), data: short })
    }
  }
  const remote = []
  remoteMap.forEach(function (entries, name) { remote.push({ name: name, refs: entries }) })
  /* refs 推导只认 refs/remotes 下的引用：配置里声明了却从未 fetch 过的远端一个
     引用都没有，整个远端就从这张表里消失（`git remote -v` 明明列着它）。所以再问
     一次 `git remote` 拿配置声明的远端名，把表里没有的并到表尾，refs 给空数组 ——
     客户端照旧画「远程 · 名字」分组，组内自己说明没有远程分支。这一步在 readRefs
     里做，答复整体走 refs 那份读缓存，寿命与 for-each-ref 相同，不另立缓存。 */
  const configured = await git(args, ['remote'], null, {})
  /* 读不出来（理论上 for-each-ref 都成功了它不该失败）就保持引用推导的原样：
     少并几个名字，好过让整张分支表跟着一次附属读数失败。 */
  if (configured.exitCode === 0) {
    const known = new Set()
    for (let i = 0; i < remote.length; i += 1) known.add(remote[i].name)
    const names = configured.stdout.split('\n')
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i].trim()
      if (name.length === 0 || known.has(name)) continue
      known.add(name)
      remote.push({ name: name, refs: [] })
    }
  }
  /* 一个 ref 都没标出当前分支，可能不是游离 HEAD，而是这个分支还没有提交 ——
     那也要说出它的名字（见 `headBranchWithoutCommit`）。 */
  if (current.length === 0) {
    const unborn = await headBranchWithoutCommit(args)
    if (unborn.length > 0) current.push(unborn)
  }
  return { ok: true, repo: listed.cwd, current: current, local: local, remote: remote }
}

async function refsSnapshot(input) {
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readRefs(input, undefined)
  return await cached(repo, 'refs', function () { return readRefs(input, repo) })
}

/* "[ahead 2, behind 3]", "[behind 3]", "[gone]" — the words are English because
   gitC pins the locale, and only the numbers are wanted here. */
function trackCounts(raw) {
  const out = { ahead: 0, behind: 0 }
  const text = raw == null ? '' : String(raw)
  const a = text.indexOf('ahead ')
  if (a >= 0) out.ahead = parseInt(text.slice(a + 6), 10) || 0
  const b = text.indexOf('behind ')
  if (b >= 0) out.behind = parseInt(text.slice(b + 7), 10) || 0
  return out
}

/* The branch switcher's own list, which the panel's sidebar is not: it is
   ordered by when each branch last moved, and carries the things a chooser needs
   but a tree does not — how long ago it moved, what it tracks, how far ahead or
   behind that is, and where "the previous branch" is, so one row can undo a
   mistaken switch.

   Local and remote heads come from the same for-each-ref, so grouping them costs
   nothing extra. Every remote branch is kept, including the ones a local branch
   already shadows: with two remotes (origin/main and upstream/main beside a
   local main) dropping the shadowed rows emptied the switcher's remote section
   down to nothing, and a row that only exists on one remote is exactly the row
   worth showing. Same-named branches from different remotes stay distinct —
   each row carries its remote name and its full short ref, and the switcher
   keys on that pair.

   Two processes, once per repository per invalidation: the list, and rev-parse
   for @{-1}, which exits 128 (not a failure worth reporting) in a repository
   where nothing has been checked out yet. */
async function readBranches(input, repo) {
  const args = argsFor(input)
  const listed = await gitC(args, ['-c', 'core.quotePath=false', 'for-each-ref',
    '--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(committerdate:unix)%1f%(upstream:short)%1f%(upstream:trackshort)%1f%(upstream:track)%1f%(objectname:short)%1f%(contents:subject)',
    '--sort=-committerdate', 'refs/heads', 'refs/remotes'], null, {})
  if (listed.exitCode !== 0) {
    return { ok: false, repo: repo === undefined ? null : repo, error: 'not-a-repository', stderr: listed.stderr, noGit: gitMissing(listed), current: '', previous: '', branches: [], remotes: [] }
  }
  const branches = []
  const remoteRows = []
  let current = ''
  const rows = listed.stdout.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].length === 0) continue
    const fields = rows[i].split('\u001f')
    const full = field(fields, 0)
    const short = field(fields, 1)
    if (short.length === 0) continue
    const isCurrent = fields[2] === '*'
    /* parseInt and a truthiness test rather than Number/isFinite: the restricted
       Host realm is not the full JavaScript global scope, and parseInt is the one
       converter the rest of this file already relies on. */
    const stamp = parseInt(field(fields, 3), 10)
    /* trackshort is symbols only (=, >, <, <>) and is never translated; the
       numbers beside it come from :track, whose words are pinned to C by gitC. */
    const counts = trackCounts(field(fields, 6))
    const entry = {
      name: short,
      current: isCurrent,
      committedAt: stamp > 0 ? stamp : 0,
      upstream: field(fields, 4),
      track: field(fields, 5),
      ahead: counts.ahead,
      behind: counts.behind,
      head: field(fields, 7),
      subject: field(fields, 8),
    }
    if (full.indexOf('refs/heads/') === 0) {
      if (isCurrent) current = short
      branches.push(entry)
    } else if (full.indexOf('refs/remotes/') === 0) {
      const slash = short.indexOf('/')
      if (slash <= 0) continue
      const rest = short.slice(slash + 1)
      if (rest.length === 0 || rest === 'HEAD') continue
      remoteRows.push({
        name: rest, remote: short.slice(0, slash), ref: short,
        committedAt: entry.committedAt, head: entry.head, subject: entry.subject,
        ahead: 0, behind: 0,
      })
    }
  }
  const prev = await git(args, ['rev-parse', '--abbrev-ref', '@{-1}'], null, {})
  const previous = prev.exitCode === 0 ? prev.stdout.trim() : ''
  /* 当前分支还没有提交时，ref 表里没有它 —— 头上那行不能因此写成 HEAD（见
     `headBranchWithoutCommit`）。它不进 `branches`：那是一份 ref 清单，而它还不是
     一个 ref，列进去会给人一个点得动的、其实不存在的东西。 */
  const unborn = current.length === 0 ? await headBranchWithoutCommit(args) : ''
  return {
    ok: true, repo: listed.cwd, current: current.length === 0 ? unborn : current,
    previous: previous === 'HEAD' || previous === current ? '' : previous,
    /* 说出来，切换器才有办法换一套说法：一个提交都没有的仓库里，`git stash`
       直接失败（"You do not have the initial commit yet"），所以那张卡片上「先暂存
       再切（切完自动恢复）」这句承诺在这里兑现不了。 */
    unborn: unborn.length > 0,
    branches: branches, remotes: remoteRows,
  }
}

async function branchesSnapshot(input) {
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readBranches(input, undefined)
  return await cached(repo, 'branches', function () { return readBranches(input, repo) })
}

/* ── 推送前的预览（git/push-preview，两段式推送的第一段）──

   「用户主动发起」的推送在面板里是两段式：先弹确认框列出要推哪些提交，读者点
   「推送」才真推。这一读就是那半句「问」：某个分支领先它上游的提交清单。

   branch 参数为空 = 面板顶栏 ↑ 那条路 —— 当前分支；非空 = 分支行右键「推送」
   那条路 —— 被右键的那个分支（它不一定是当前分支，多选分组里甚至不属于生效
   仓库，所以上游也按 <分支>@{u} 问，不按 HEAD 猜）。没有上游不是错误：ok:true
   带 upstream:null 回去 —— 弹窗那半要的正是这个事实，它自己走「设置上游并推
   送」的选择流程，Host 不替读者挑远端。

   ahead / behind 用 rev-list --left-right --count 的 <up>...<branch> 一条拿全
   （左列是落后、右列是领先，顺序 git 定死）；清单用 log，pretty 串与 64-history.js
   的图同一份，解析直接复用 parseCommitRecords —— 弹窗行吃的就是日志行那套字段
   （作者、相对时间），不再另造一个解析器。上限 200 条：预览是给人过目的，不是
   完整变更集，顶满就带 hasMore 说一声。进读缓存（tag push-preview，按分支各一
   份），寿命与 refs 相同 —— 真推送、提交、fetch 都会整仓失效，弹窗开着期间上游
   被人动了，下一次打开读到的就是新账。

   localExists（2026-10-15 推送事故的另一半）：这个分支在**本地**存不存在，一次
   `git show-ref --verify --quiet refs/heads/<名字>` 就有答案 —— 弹窗在读者点
   「推送」之前就该把「本地没有这个分支」说破（git/push 那边的 branch-missing 是
   最后一道闸，这里是提前的那道）；detached 那条 branch:null 也带 localExists:
   false —— 没有名字就是没有本地分支。它跟着这份预览一起进读缓存，失效寿命与
   refs 相同，不需要单独作废。 */
const PUSH_PREVIEW_MAX = 200

async function readPushPreview(input, repo) {
  const args = argsFor(input)
  const branch = input != null && isStr(input.branch) && input.branch.trim().length > 0 ? input.branch.trim() : ''
  /* 分支名（branch 为空时才要问 HEAD）：detached 答不上来 —— 连名字都没有就谈
     不上上游，branch:null 回去，弹窗把这句话说给读者。 */
  let name = branch
  if (name.length === 0) {
    const sym = await git(args, ['symbolic-ref', '--quiet', '--short', 'HEAD'], null, {})
    if (sym.exitCode !== 0) {
      return { ok: true, repo: sym.cwd, branch: null, localExists: false, upstream: null, ahead: 0, behind: 0, hasMore: false, maxCount: PUSH_PREVIEW_MAX, commits: [] }
    }
    name = sym.stdout.trim()
  }
  /* 本地分支在不在：只认退出码 0/1 之外不猜（与 git/push 的预检、resolveCheckoutTarget
     的 localProbe 同一条规矩）—— 答不上来就当「不在」，弹窗宁可多说一句，不放过
     一次对着不存在的分支推送的机会。 */
  const localProbe = await git(args, ['show-ref', '--verify', '--quiet', 'refs/heads/' + name], null, {})
  const localExists = localProbe.exitCode === 0
  const upstream = await git(args, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', name + '@{u}'], null, {})
  if (upstream.exitCode !== 0) {
    return { ok: true, repo: upstream.cwd, branch: name, localExists: localExists, upstream: null, ahead: 0, behind: 0, hasMore: false, maxCount: PUSH_PREVIEW_MAX, commits: [] }
  }
  const up = upstream.stdout.trim()
  const range = up + '..' + name
  const listed = await git(args, ['-c', 'core.quotePath=false', 'log', '--max-count=' + String(PUSH_PREVIEW_MAX + 1), '--date-order',
    '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1f%P%x1e', range], null, {})
  if (listed.exitCode !== 0) {
    return { ok: false, repo: listed.cwd, branch: name, localExists: localExists, upstream: up, error: 'not-a-repository', stderr: listed.stderr, noGit: gitMissing(listed), commits: [] }
  }
  const parsed = parseCommitRecords(listed.stdout)
  const hasMore = parsed.length > PUSH_PREVIEW_MAX
  const commits = hasMore ? parsed.slice(0, PUSH_PREVIEW_MAX) : parsed
  /* ahead 先拿清单条数垫底，rev-list 答得上来再用精确值 —— 两读之间仓库又动了
     的话两者可能差一条，弹窗里的行数以清单为准，这里的数只喂标题与「落后」提醒。 */
  let ahead = commits.length
  let behind = 0
  const counted = await git(args, ['rev-list', '--left-right', '--count', up + '...' + name], null, {})
  if (counted.exitCode === 0) {
    const parts = counted.stdout.trim().split('\t')
    if (parts.length === 2) {
      behind = parseInt(parts[0], 10) || 0
      const exact = parseInt(parts[1], 10) || 0
      if (exact > 0) ahead = exact
    }
  }
  return {
    ok: true, repo: listed.cwd, branch: name, localExists: localExists, upstream: up,
    ahead: ahead, behind: behind, hasMore: hasMore, maxCount: PUSH_PREVIEW_MAX,
    commits: commits,
  }
}

async function pushPreviewSnapshot(input) {
  const repo = repoFrom(input, null)
  const tag = 'push-preview' + (input != null && isStr(input.branch) && input.branch.trim().length > 0 ? '|' + input.branch.trim() : '')
  if (repo === undefined) return await readPushPreview(input, undefined)
  return await cached(repo, tag, function () { return readPushPreview(input, repo) })
}

async function previousBranch(input) {
  const prev = await git(argsFor(input), ['rev-parse', '--abbrev-ref', '@{-1}'], null, {})
  if (prev.exitCode !== 0) return ''
  const name = prev.stdout.trim()
  return name === 'HEAD' ? '' : name
}

/* Switching with local changes in the way. git itself decides whether the
   changes actually conflict, so the cheap path is to try the switch first and
   only offer to stash when git refuses; stashing unconditionally would turn
   every switch of a dirty tree into two extra writes and one more chance to
   conflict on the way back.

   When the caller does ask for the stash, the failure paths matter more than
   the happy one: if the switch fails after the stash, the work goes back before
   the error is reported, because leaving someone's edits in a stash they never
   asked for is worse than the failed switch. A pop that conflicts is not hidden
   either — git keeps the stash entry in that case, and the caller says so. */
/* desc 是「命令」页（77-cmdrec.js）给这次切换起的中文名，由 RPC 调用点（80-rpc.js）
   传入。这里不经 panelMutate —— 答复的形状（stashed/dirty/popConflict…）是客户端
   专门消费的 —— 所以它手里的四次变更 git 调用各自用 cmdrecGit 包上记录；开头那次
   status 是读，不记。

   create（可选）是远程分支行的「签出」走的形状：'origin/feat/x' 这样一个
   远端分支全名 —— 命令变成 `git switch -c <本地名> --track <全名>`，本地名由调用点
   剥好（去掉远端前缀的那一段）。不用裸的 `git switch <remote>/<branch>` 是因为
   DWIM 在「本地同名分支已存在」时的行为不明确（git switch 直接拒绝、git checkout
   却悄悄切到已有的本地分支），显式 -c 让两边都是同一句看得懂的错。stash 兜底对
   这条路同样成立 —— 签出前工作区是脏的照样先收再切。裸路（普通 switch，不带
   create）现在也在进这里前先做过一遍同样的显式解析（80-rpc.js 的
   resolveCheckoutTarget）：目标认得是远端分支而本地不存在时，一样以 create 形状
   进来 —— git 的 --guess 在任何一条路上都不再是被依赖的那个。 */
async function switchBranch(input, name, desc, create) {
  const args = argsFor(input)
  const requested = repoFrom(input, null)
  const argvOf = function () {
    return create != null
      ? ['switch', '-c', name, '--track', create]
      : ['switch', name]
  }
  const finish = function (result, extra) {
    invalidateRepo(requested !== undefined ? requested : result.cwd)
    const out = extra == null ? {} : extra
    out.ok = result.exitCode === 0
    out.repo = result.cwd
    out.stdout = result.stdout
    out.stderr = result.stderr
    out.exitCode = result.exitCode
    out.command = result.command
    out.sandboxDenied = result.sandboxDenied === true
    return out
  }
  const mutate = function (argv) {
    return cmdrecGit(input, desc, argv, function () { return git(args, argv, null, {}) })
  }

  if (input == null || input.stash !== true) {
    const moved = await mutate(argvOf())
    return finish(moved, { stashed: false, dirty: 0, popConflict: false })
  }

  /* --no-optional-locks is a top-level option, so it has to sit before the
     subcommand: git status rejects it in its own option list. Without it this
     read fights the user's own `git add` for .git/index.lock. */
  const before = await git(args, ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=normal'], null, {})
  let dirty = 0
  const lines = before.stdout.split('\n')
  for (let i = 0; i < lines.length; i += 1) if (lines[i].length > 0) dirty += 1

  let stashed = false
  if (dirty > 0 && before.exitCode === 0) {
    const saved = await mutate(['stash', 'push', '-u', '-m', 'dsh-git-idea: switch to ' + name])
    if (saved.exitCode !== 0) {
      return finish(saved, { stashed: false, dirty: dirty, popConflict: false, error: 'stash-failed' })
    }
    stashed = true
  }

  const moved = await mutate(argvOf())
  if (moved.exitCode !== 0) {
    let restored = false
    let restoreError = ''
    if (stashed) {
      const back = await mutate(['stash', 'pop'])
      restored = back.exitCode === 0
      restoreError = restored ? '' : back.stderr
    }
    return finish(moved, {
      stashed: stashed, restored: restored, restoreError: restoreError,
      dirty: dirty, popConflict: false, error: 'switch-failed',
    })
  }

  let popConflict = false
  let popStdout = ''
  let popStderr = ''
  if (stashed) {
    const popped = await mutate(['stash', 'pop'])
    popConflict = popped.exitCode !== 0
    /* Which stream git chooses is not stable — a conflicting pop narrates the
       merge on stdout and the failure on stderr — so both travel and the caller
       shows whichever has something in it. */
    popStdout = popped.stdout
    popStderr = popped.stderr
  }
  return finish(moved, {
    stashed: stashed, dirty: dirty, popConflict: popConflict,
    popStdout: popStdout, popStderr: popStderr,
  })
}

