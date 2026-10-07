/* ─────────────── one commit, one file, one directory, and the one mutation ─────────────── */

async function readCommitDetail(input) {
  const hash = input != null && isStr(input.hash) ? input.hash.trim() : ''
  if (hash.length === 0) return { ok: false, error: 'hash is required' }
  const args = argsFor(input)
  const meta = await git(args, ['-c', 'core.quotePath=false', 'show', '-s',
    '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b', hash], null, {})
  if (meta.exitCode !== 0) return { ok: false, error: 'commit-not-found', stderr: meta.stderr, noGit: gitMissing(meta) }
  const fields = meta.stdout.split('\u001f')

  const files = []
  const named = await git(args, ['-c', 'core.quotePath=false', 'show', '--name-status', '-z', '-M', '--first-parent', '--format=', hash], null, { maxBytes: 800000 })
  if (named.exitCode === 0) {
    const parts = named.stdout.split('\u0000')
    let index = 0
    while (index < parts.length) {
      const status = parts[index]
      if (status === undefined || status.length === 0) { index += 1; continue }
      const head = status.charAt(0)
      if (head === 'R' || head === 'C') {
        const from = field(parts, index + 1)
        const to = field(parts, index + 2)
        files.push({ status: status, path: to, from: from })
        index += 3
      } else {
        const path = field(parts, index + 1)
        files.push({ status: status, path: path, from: null })
        index += 2
      }
    }
  }

  const branches = []
  const contains = await git(args, ['-c', 'core.quotePath=false', 'branch', '-a', '--contains', hash, '--format=%(refname:short)'], null, {})
  if (contains.exitCode === 0) {
    const rows = contains.stdout.split('\n')
    for (let i = 0; i < rows.length; i += 1) if (rows[i].length > 0) branches.push(rows[i])
  }

  /* 指在这个提交上的标签（一行一个）。快捷命令的 {tags} 变量用它；读不动（比如一个
     还没有引用的空仓库）就是空数组，不说成失败。加字段，别动上面的既有字段。 */
  const tags = []
  const tagged = await git(args, ['tag', '--points-at', hash], null, {})
  if (tagged.exitCode === 0) {
    const rows = tagged.stdout.split('\n')
    for (let i = 0; i < rows.length; i += 1) if (rows[i].length > 0) tags.push(rows[i])
  }

  return {
    ok: true,
    hash: fields[0] === undefined ? hash : fields[0],
    short: field(fields, 1),
    author: field(fields, 2),
    email: field(fields, 3),
    date: field(fields, 4),
    subject: field(fields, 5),
    body: field(fields, 6).replace(/\s+$/, ''),
    files: files,
    branches: branches,
    tags: tags,
  }
}

/* A commit is immutable, so its detail is held until the repository is mutated
   (which cannot rewrite an existing hash, so this only frees memory). */
async function commitDetailSnapshot(input) {
  const hash = input != null && isStr(input.hash) ? input.hash.trim() : ''
  if (hash.length === 0) return { ok: false, error: 'hash is required' }
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readCommitDetail(input)
  return await cached(repo, 'detail|' + hash, function () { return readCommitDetail(input) })
}

/* ── one file's change ──

   The panel could say *which* files changed and nothing else. The changes tree
   and the file list under a commit both ended on a dead row: there was no read
   that returned a patch, so a file could be reported as modified and never shown
   as modified. This is that read.

   Four modes, because that is what the two lists can be looking at: the index
   against HEAD (`staged`), the working tree against the index (`worktree`), one
   commit (`commit`, with the old path of a rename travelling along — with only
   the new path as a pathspec git reports the file as newly added instead), and a
   file git has never seen (`untracked`, the one case with no HEAD side at all,
   which needs `--no-index`).

   Nothing is cached. The text is live, and the reader looking at it is the one
   who just edited the file. `--no-color` because there is no terminal to read
   colour, `--no-ext-diff` because a configured diff driver is not a viewer, and
   `core.quotePath=false` so a non-ASCII path arrives as itself.

   `--no-optional-locks` is the same rule every read here follows, and here it is
   load-bearing rather than decorative: measured on this box after `touch f` made
   the cached stat stale, a plain `git diff` rewrote `.git/index` in 2 of 20 runs
   while the flagged one did 0 of 20 (`git status` writes 20 of 20) — a read that
   may refresh the index may also take the lock, occasionally being exactly the
   case that hurts. */
const DIFF_MODES = ['worktree', 'staged', 'commit', 'untracked']
const DIFF_LINES_MAX = 6000
const DIFF_CHARS_MAX = 400000
const DIFF_SHA = /^[0-9a-f]{7,40}$/i

function diffArgv(mode, paths, ref) {
  const common = ['--no-optional-locks', '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff']
  if (mode === 'commit') {
    /* `-m --first-parent` is what makes a merge commit readable: without it git
       prints the combined diff, which for a clean merge is empty — the file list
       would name a change and the patch would say there is none. */
    return ['--no-optional-locks', '-c', 'core.quotePath=false', 'show', '--no-color', '--no-ext-diff',
      '--format=', '--patch', '-m', '--first-parent', ref, '--'].concat(paths)
  }
  if (mode === 'untracked') return common.concat(['--no-index', '--', '/dev/null', paths[0]])
  if (mode === 'staged') return common.concat(['--cached', '--']).concat(paths)
  return common.concat(['--']).concat(paths)
}

/* The two numbers IDEA puts in the corner of a file row. `---`/`+++` are the
   file headers rather than a removed and an added line. */
function patchCounts(patch) {
  let added = 0
  let removed = 0
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].charAt(0)
    if (head === '+') { if (lines[i].indexOf('+++') !== 0) added += 1; continue }
    if (head === '-') { if (lines[i].indexOf('---') !== 0) removed += 1; continue }
  }
  return { added: added, removed: removed }
}

/* A patch that is not text is not shown as text. A new binary file is printed by
   git as its own bytes when the file happens to contain no NUL — measured here —
   and a byte string with a NUL in it cannot survive being handed to a renderer
   at all, so both are reported as "binary" with no body. */
function patchLooksBinary(patch) {
  if (patch.indexOf('\u0000') >= 0) return true
  if (/^Binary files /m.test(patch)) return true
  if (/^GIT binary patch/m.test(patch)) return true
  return patchHasControlBytes(patch)
}

/* git decides "binary" from the first 8000 bytes, so a NUL-free blob is printed
   as if it were text: measured here, 400 random bytes came back as one 524-byte
   line of noise. Text does not carry C0 control characters, and a handful is
   enough to tell. */
function patchHasControlBytes(patch) {
  let seen = 0
  for (let i = 0; i < patch.length; i += 1) {
    const code = patch.charCodeAt(i)
    if (code === 9 || code === 10 || code === 13) continue
    if (code < 32 || code === 127) {
      seen += 1
      if (seen > 8) return true
    }
  }
  return false
}

async function readFileDiff(input) {
  const mode = input != null && isStr(input.mode) ? input.mode.trim() : ''
  if (DIFF_MODES.indexOf(mode) < 0) {
    return { ok: false, error: 'unknown-mode', exitCode: null, stderr: 'mode must be one of ' + DIFF_MODES.join(', ') }
  }
  const path = input != null && isStr(input.path) ? input.path : ''
  const bad = repoRelativePath(path)
  if (bad.length > 0) return { ok: false, error: 'invalid-path', exitCode: null, stderr: bad }

  const from = input != null && isStr(input.from) ? input.from : ''
  const ref = input != null && isStr(input.ref) ? input.ref.trim() : ''
  if (mode === 'commit' && !DIFF_SHA.test(ref)) {
    return { ok: false, error: 'invalid-ref', exitCode: null, stderr: 'a commit hash is required' }
  }
  const paths = from.length > 0 && from !== path ? [from, path] : [path]

  const result = await git(argsFor(input), diffArgv(mode, paths, ref), null, { maxBytes: 1200000 })
  /* `git diff --no-index` says "these differ" with exit code 1 and a perfectly
     good patch on stdout; every other mode says it with exit code 0. */
  const produced = result.exitCode === 0 || (mode === 'untracked' && result.exitCode === 1 && result.stdout.length > 0)
  if (!produced) {
    return { ok: false, error: 'diff-failed', exitCode: result.exitCode, stderr: result.stderr, noGit: gitMissing(result), mode: mode, path: path }
  }

  const binary = patchLooksBinary(result.stdout)
  const counts = binary ? { added: 0, removed: 0 } : patchCounts(result.stdout)
  let patch = binary ? '' : result.stdout
  let truncated = result.truncated === true
  const lines = patch.split('\n')
  if (lines.length > DIFF_LINES_MAX) {
    patch = lines.slice(0, DIFF_LINES_MAX).join('\n')
    truncated = true
  }
  if (patch.length > DIFF_CHARS_MAX) {
    patch = patch.slice(0, DIFF_CHARS_MAX)
    truncated = true
  }
  return {
    ok: true, mode: mode, path: path, from: from, ref: ref,
    text: patch, added: counts.added, removed: counts.removed,
    binary: binary, truncated: truncated, empty: patch.length === 0,
    exitCode: result.exitCode,
  }
}

/* ── what is inside an untracked directory ──

   git reports an untracked directory as one entry ending in "/" and says nothing
   about what is in it, which is exactly why the panel could not show those files:
   it had nothing to show. Ticking the row needs no answer (`git add -- dir`
   takes the whole thing); opening it is a second, deliberate act, and that is the
   right moment to pay — `-uall` on a repository with one large untracked tree is
   the cost git's own collapsing exists to avoid.

   `ls-files --others --exclude-standard` lists the files `git add <dir>` would
   take, honours .gitignore the same way, and is a read: `--no-optional-locks`,
   no index write. Not cached — the directory is the thing most likely to be
   changing while the reader looks at it. */
const UNTRACKED_FILES_MAX = 2000

async function readUntrackedTree(input) {
  const raw = input != null && isStr(input.dir) ? input.dir : ''
  const dir = raw.replace(/\/+$/, '')
  const bad = repoRelativePath(dir)
  if (bad.length > 0) return { ok: false, error: 'invalid-path', stderr: bad }
  const result = await git(argsFor(input), ['--no-optional-locks', '-c', 'core.quotePath=false',
    'ls-files', '--others', '--exclude-standard', '-z', '--', dir], null, { maxBytes: 800000 })
  if (result.exitCode !== 0) {
    return { ok: false, error: 'ls-files-failed', exitCode: result.exitCode, stderr: result.stderr, noGit: gitMissing(result), dir: dir }
  }
  const files = []
  const parts = result.stdout.split('\u0000')
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].length > 0 && files.length < UNTRACKED_FILES_MAX) files.push(parts[i])
  }
  return {
    ok: true, dir: dir, files: files,
    truncated: result.truncated === true || parts.length > UNTRACKED_FILES_MAX + 1,
  }
}

async function panelMutate(input, argv, options) {
  const opts = options == null ? {} : options
  const requested = repoFrom(input, null)
  const runner = opts.net === true ? gitNet : git
  const result = await runner(argsFor(input), argv, null, opts.spawn == null ? {} : opts.spawn)
  /* Unconditionally, not only on success: a conflicting cherry-pick, merge or
     revert changes the index and the working tree and then exits non-zero, so
     gating on exitCode === 0 would leave the panel showing the pre-conflict
     state and hide the very banner that gets the user out of it. */
  invalidateRepo(requested !== undefined ? requested : result.cwd)
  return {
    ok: result.exitCode === 0, repo: result.cwd, stdout: result.stdout,
    stderr: result.stderr, exitCode: result.exitCode, command: result.command,
    /* Says outright that the file sandbox refused the write, so the reader is not
       left reading git's "Permission denied" as a problem with their repository. */
    sandboxDenied: result.sandboxDenied === true,
    /* And the other failure that is not about the repository: no git on this
       machine at all. Every mutating command and `git init` come through here. */
    noGit: gitMissing(result),
  }
}

function panelPaths(input) {
  return input != null && Array.isArray(input.paths) ? input.paths.filter(isStr) : []
}

