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
   nothing extra. A remote branch that already has a local branch of the same
   name is dropped: the local row already names it as its upstream, and two rows
   that both mean "dev" would be one row too many.

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
  const localNames = []
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
      localNames.push(short)
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
  const remotes = []
  for (let i = 0; i < remoteRows.length; i += 1) {
    if (localNames.indexOf(remoteRows[i].name) < 0) remotes.push(remoteRows[i])
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
    branches: branches, remotes: remotes,
  }
}

async function branchesSnapshot(input) {
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readBranches(input, undefined)
  return await cached(repo, 'branches', function () { return readBranches(input, repo) })
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
   status 是读，不记。 */
async function switchBranch(input, name, desc) {
  const args = argsFor(input)
  const requested = repoFrom(input, null)
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
    const moved = await mutate(['switch', name])
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

  const moved = await mutate(['switch', name])
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

