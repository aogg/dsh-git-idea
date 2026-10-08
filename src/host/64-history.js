/* ─────────────── the panel's own read, and the graph ─────────────── */

/* ── `git status --porcelain=v2`, and the words for its two letters ──

   The panel's full read is the only caller: the cheap identity read that the
   chip uses asks three questions and never looks at the working tree.
   `STATUS_LABELS` has one reader — `parseStatusV2` puts those words into each
   entry's `label` — so it travels with the parser rather than on its own.
 */
const STATUS_LABELS = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied',
  T: 'typechange', U: 'unmerged', '.': 'unchanged',
}

function statusLabel(code) {
  return STATUS_LABELS[code] === undefined ? code : STATUS_LABELS[code]
}

function parseStatusV2(stdout) {
  const parsed = {
    branch: null, detached: false, upstream: null, ahead: 0, behind: 0,
    staged: [], unstaged: [], untracked: [], unmerged: [],
  }
  const lines = stdout.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.length === 0) continue
    if (line.charAt(0) === '#') {
      const head = line.slice(2)
      const space = head.indexOf(' ')
      const key = space < 0 ? head : head.slice(0, space)
      const rest = space < 0 ? '' : head.slice(space + 1)
      if (key === 'branch.head') {
        if (rest === '(detached)') parsed.detached = true
        else parsed.branch = rest
      } else if (key === 'branch.upstream') {
        parsed.upstream = rest
      } else if (key === 'branch.ab') {
        const parts = rest.split(' ')
        if (parts.length === 2) {
          parsed.ahead = parseInt(parts[0].slice(1), 10) || 0
          parsed.behind = parseInt(parts[1].slice(1), 10) || 0
        }
      }
      continue
    }
    const marker = line.charAt(0)
    if (marker === '?') { parsed.untracked.push(line.slice(2)); continue }
    if (marker === '!') continue
    if (marker === '1' || marker === '2' || marker === 'u') {
      const fields = line.split(' ')
      const xy = fields[1] === undefined ? '..' : fields[1]
      let path = ''
      if (marker === '1') path = fields.slice(8).join(' ')
      else if (marker === '2') path = fields.slice(9).join(' ').split('\t')[0]
      else path = fields.slice(10).join(' ')
      const entry = { path: path, code: xy, label: statusLabel(xy.charAt(0)) + '/' + statusLabel(xy.charAt(1)) }
      if (marker === 'u') { parsed.unmerged.push(entry); continue }
      if (xy.charAt(0) !== '.') parsed.staged.push(entry)
      if (xy.charAt(1) !== '.') parsed.unstaged.push(entry)
    }
  }
  return parsed
}

function missingPanel(target, reason) {
  return {
    ok: false, repo: target, error: 'not-a-repository', reason: reason,
    stderr: '', exitCode: null, staged: [], unstaged: [], untracked: [], unmerged: [],
  }
}

async function readPanelIdentity(input, target) {
  const probe = await probeShell(input, panelIdentityCommand(target))
  const lines = probe.stdout.split('\n')
  const kind = lines.length > 0 ? lines[0] : ''
  if (kind === 'K:file') return missingPanel(target, 'file')
  if (kind !== 'K:dir') return missingPanel(target, 'missing')

  let exitCode = null
  let sequencer = null
  let branch = null
  let upstream = null
  let track = ''
  let noGit = false
  let unsafeOwner = false
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === PANEL_NO_GIT) { noGit = true; continue }
    if (line === PANEL_UNSAFE_OWNER) { unsafeOwner = true; continue }
    if (line.indexOf('RC:') === 0) { exitCode = parseInt(line.slice(3), 10); continue }
    if (line.indexOf('S:') === 0) { if (sequencer === null) sequencer = line.slice(2); continue }
    if (line.indexOf('B:') === 0) { branch = line.slice(2); continue }
    /* The upstream and its standing arrive in one line, separated by the same
       \u001f the rest of the Host uses: one for-each-ref answers both. */
    if (line.indexOf('U:') === 0) {
      const fields = line.slice(2).split('\u001f')
      upstream = field(fields, 0)
      track = field(fields, 1)
    }
  }
  /* Before the exit code, which the script never reached: "this machine has no
     git" is not a repository that failed to read, and the reader can act on it. */
  if (noGit) return missingPanel(target, 'no-git')
  /* Before the exit code too, for the same shape of reason: the exit code only
     says the read failed, the marker says why — git refuses this repository's
     owner, the panel already attempted the global safe.directory write and the
     retry, and the reader gets a state of their own with the command that fixes
     it, not "not a repository" (see `safeDirectoryShell`). */
  if (unsafeOwner) return missingPanel(target, 'unsafe-owner')
  if (exitCode !== 0) {
    const failed = missingPanel(target, 'not-a-repo')
    failed.exitCode = exitCode
    failed.stderr = ''
    return failed
  }
  const counts = trackCounts(track)
  return {
    ok: true, repo: target, branch: branch, detached: branch === null,
    upstream: upstream !== null && upstream.length > 0 ? upstream : null,
    ahead: counts.ahead, behind: counts.behind,
    sequencer: sequencer,
    staged: [], unstaged: [], untracked: [], unmerged: [],
    /* Says outright that the working tree was not read, so nothing downstream
       can mistake "no changes" for "not asked". */
    partial: true,
  }
}

async function readPanel(input, target, paths) {
  const asked = paths == null ? [] : paths
  const probe = await probeShell(input, panelCommand(target, asked))
  const lines = probe.stdout.split('\n')
  const kind = lines.length > 0 ? lines[0] : ''
  if (kind === 'K:file') return missingPanel(target, 'file')
  if (kind !== 'K:dir') return missingPanel(target, 'missing')

  let exitCode = null
  let sequencer = null
  let noGit = false
  let unsafeOwner = false
  let needsIdentity = false
  const body = []
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === PANEL_NO_GIT) { noGit = true; continue }
    if (line === PANEL_UNSAFE_OWNER) { unsafeOwner = true; continue }
    if (line === PANEL_NO_IDENT) { needsIdentity = true; continue }
    if (line.indexOf('RC:') === 0) { exitCode = parseInt(line.slice(3), 10); continue }
    if (line.indexOf('S:') === 0) { if (sequencer === null) sequencer = line.slice(2); continue }
    body.push(line)
  }
  const output = body.join('\n')

  if (noGit) return missingPanel(target, 'no-git')
  /* Before the exit-code branch below, and for the same reason `noGit` comes
     first: the marker says the read failed because git refuses the repository's
     owner — after the panel's own global safe.directory write and the one retry
     already happened — and that is a different page for the reader than either
     "not a repository" or a git error (see `safeDirectoryShell`). */
  if (unsafeOwner) return missingPanel(target, 'unsafe-owner')
  if (exitCode !== 0) {
    const outsideRepo = output.indexOf('not a git repository') >= 0
    const failed = missingPanel(target, outsideRepo ? 'not-a-repo' : 'git-error')
    failed.exitCode = exitCode
    failed.stderr = outsideRepo ? '' : output
    return failed
  }

  const parsed = parseStatusV2(output)
  const untracked = []
  for (let i = 0; i < parsed.untracked.length; i += 1) untracked.push({ path: parsed.untracked[i], code: '??' })
  const reply = {
    ok: true, repo: target, branch: parsed.detached ? null : parsed.branch, detached: parsed.detached,
    upstream: parsed.upstream, ahead: parsed.ahead, behind: parsed.behind,
    sequencer: sequencer,
    staged: parsed.staged, unstaged: parsed.unstaged, untracked: untracked, unmerged: parsed.unmerged,
    /* Always a boolean, never left out and never `undefined`: the bridge validates
       every field of a reply for "can this become lossless JSON", and a key whose
       value is `undefined` rejects the *whole* reply — the client would get an
       error instead of a snapshot. (Found live, not in a suite: the suites call
       these handlers directly, with no validation in between.) */
    needsIdentity: needsIdentity === true,
  }
  /* A pathspec answer is about those paths and nothing else. It says so, and it
     names them, so the client can fold it into the snapshot it already has
     instead of mistaking it for the whole working tree. The whole-tree answer
     carries neither key — the same convention the identity read uses. */
  if (asked.length > 0) {
    reply.partial = true
    reply.paths = asked
  }
  return reply
}

async function panelSnapshot(input) {
  const target = repoFrom(input, null)
  if (target === undefined) return missingPanel(null, 'no-path')
  /* Two tags, never one: a cheap answer cached under the full read's name would
     hand an empty working tree to the changes tab. */
  if (input != null && input.quick === true) {
    return await cached(target, 'panel-ident', function () { return readPanelIdentity(input, target) })
  }
  const paths = readPaths(input)
  if (paths.length > 0) {
    /* A partial answer is cached under the question it answered: same paths, same
       tag. Any mutation drops it with the rest of this repository's entries. */
    return await cached(target, 'panel|' + paths.join('\u0001'), function () { return readPanel(input, target, paths) })
  }
  return await cached(target, 'panel', function () { return readPanel(input, target, []) })
}

async function readGraph(input, repo) {
  const args = argsFor(input)
  const requested = input != null && typeof input.maxCount === 'number' && input.maxCount > 0 ? Math.floor(input.maxCount) : 200
  const maxCount = requested > 20000 ? 20000 : requested

  const head = await git(args, ['-c', 'core.quotePath=false', 'symbolic-ref', '--quiet', '--short', 'HEAD'], null, {})
  const currentBranch = head.exitCode === 0 ? head.stdout.trim() : null
  const allRefs = input != null && input.allRefs === true
  const asked = input != null && isStr(input.ref) && input.ref.trim().length > 0 ? input.ref.trim() : null
  const ref = asked !== null ? asked : (currentBranch !== null && currentBranch.length > 0 ? currentBranch : 'HEAD')

  const search = input != null && isStr(input.search) ? input.search.trim() : ''
  const author = input != null && isStr(input.author) ? input.author.trim() : ''
  const since = input != null && isStr(input.since) ? input.since.trim() : ''
  const until = input != null && isStr(input.until) ? input.until.trim() : ''
  const path = input != null && isStr(input.path) ? input.path.trim() : ''

  /* The two switches the log's search box carries, both off by default so the
     plain search is unchanged: `regex` hands the text to extended regexp
     instead of matching it literally, and `caseSensitive` drops git's `-i`. */
  const regex = input != null && input.regex === true
  const caseSensitive = input != null && input.caseSensitive === true

  /* One commit more than asked for: the extra row is not returned, it is how
     "there is more history" is answered without a second read. */
  const argv = ['-c', 'core.quotePath=false', 'log', '--max-count=' + String(maxCount + 1), '--date-order',
    '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1f%P%x1e']
  if ((search.length > 0 && regex !== true) || author.length > 0) argv.push('--fixed-strings')
  if (search.length > 0) {
    argv.push('--grep=' + search)
    if (regex === true) argv.push('--extended-regexp')
    if (caseSensitive !== true) argv.push('-i')
  }
  if (author.length > 0) argv.push('--author=' + author)
  if (since.length > 0) argv.push('--since=' + since)
  if (until.length > 0) argv.push('--until=' + until)
  if (allRefs) argv.push('--all')
  else argv.push(ref)
  if (path.length > 0) { argv.push('--'); argv.push(path) }

  const logged = await git(args, argv, null, {})
  if (logged.exitCode !== 0) {
    /* ── 一个提交都还没有的仓库 ──
       `git log <branch>` 在这里必然失败（那个 ref 还不存在），但那不是「读不动这个
       仓库」：它是这个仓库的第一个状态，历史就是空的。判据是两句 git 自己的问话，
       都不认措辞：`rev-parse --git-dir` 能答上来 = 这确实是个仓库（在仓库外它退出
       128），而 `--verify HEAD` 答不上来 = HEAD 还没指向任何提交。

       注意别拿 `repoHere` 来判：它返回的是一段 shell 文本（给脚本拼命令用的），在
       JS 里永远为真 —— 第一版就是这么写的，负对照立刻把它抓出来了。 */
    const verifyHead = await git(args, ['rev-parse', '-q', '--verify', 'HEAD'], null, {})
    if (verifyHead.exitCode !== 0) {
      const gitDir = await git(args, ['rev-parse', '--git-dir'], null, {})
      if (gitDir.exitCode === 0) {
        return {
          ok: true, repo: logged.cwd, currentBranch: currentBranch, ref: ref, allRefs: allRefs,
          unborn: true, hasMore: false, maxCount: maxCount, commits: [], rows: [], lanes: 1,
        }
      }
    }
    return { ok: false, repo: repo === undefined ? null : repo, error: 'not-a-repository', stderr: logged.stderr, noGit: gitMissing(logged), currentBranch: currentBranch, ref: ref, commits: [], rows: [], lanes: 1 }
  }
  const parsed = parseCommitRecords(logged.stdout)
  const hasMore = parsed.length > maxCount
  const commits = hasMore ? parsed.slice(0, maxCount) : parsed
  /* ── a filtered list is laid out on the history it was filtered out of ──

     Anything that *hides* commits — the search box, an author, a date range, a
     path — leaves the plain layout with parents it cannot see, and the lanes it
     books for them are never claimed (see layoutVisible). So the plain
     hash+parents history is read for the span those matches cover: everything
     above the oldest match, plus the oldest itself (its parents came with the
     filtered read). `--not <oldest>` is exactly that span, and it is what keeps
     this read proportional to the answer instead of to the repository.

     The scope is the same as the filtered read's — `--all` or the one ref — and
     deliberately carries none of the hiding flags: this is the history, not the
     answer. `DAG_MAX` bounds the walk for a search that matches rarely; past it
     an edge simply leaves the page, which is what the unfiltered graph does at
     the end of a page too. */
  const hiding = search.length > 0 || author.length > 0 || since.length > 0 || until.length > 0 || path.length > 0
  let layout = layoutGraph(commits, 14)
  if (hiding && commits.length > 0) {
    const oldest = commits[commits.length - 1].hash
    const dagArgv = ['-c', 'core.quotePath=false', 'log', '--date-order', '--max-count=' + String(DAG_MAX),
      '--pretty=format:%H %P']
    if (allRefs) dagArgv.push('--all')
    else dagArgv.push(ref)
    dagArgv.push('--not')
    dagArgv.push(oldest)
    const dagged = await git(args, dagArgv, null, {})
    if (dagged.exitCode === 0) {
      const full = parseDag(dagged.stdout)
      const last = commits[commits.length - 1]
      full.push({ hash: last.hash, parents: last.parents })
      layout = layoutVisible(full, commits, 14)
    }
  }
  return {
    ok: true, repo: logged.cwd, currentBranch: currentBranch, ref: ref, allRefs: allRefs,
    commits: commits, rows: layout.rows, lanes: layout.lanes, hasMore: hasMore, maxCount: maxCount,
  }
}

function graphTag(input) {
  const part = function (value) { return value != null && isStr(value) ? value : '' }
  return 'graph|' + [
    input != null && input.allRefs === true ? '1' : '0',
    part(input != null ? input.ref : null),
    part(input != null ? input.search : null),
    input != null && input.regex === true ? 're' : '',
    input != null && input.caseSensitive === true ? 'cs' : '',
    part(input != null ? input.author : null),
    part(input != null ? input.since : null),
    part(input != null ? input.until : null),
    part(input != null ? input.path : null),
    input != null && typeof input.maxCount === 'number' ? String(input.maxCount) : '',
  ].join('\u0001')
}

async function graphSnapshot(input) {
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readGraph(input, undefined)
  return await cached(repo, graphTag(input), function () { return readGraph(input, repo) })
}

