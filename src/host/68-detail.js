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
  const base = input != null && isStr(input.base) ? input.base.trim() : ''
  const head = input != null && isStr(input.head) ? input.head.trim() : ''
  /* 选区视图（客户端多选合并查看）的 {base, head} 形态：一段连续提交的合计改动。
     提交不可改写，一段区间同样不可改写 —— 缓存寿命与单提交那份同一个理由。 */
  if (base.length > 0 && head.length > 0) {
    const repo = repoFrom(input, null)
    if (repo === undefined) return await commitRangeDetail(input, base, head)
    return await cached(repo, 'detail-range|' + base + '..' + head, function () { return commitRangeDetail(input, base, head) })
  }
  const hash = input != null && isStr(input.hash) ? input.hash.trim() : ''
  if (hash.length === 0) return { ok: false, error: 'hash is required' }
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readCommitDetail(input)
  return await cached(repo, 'detail|' + hash, function () { return readCommitDetail(input) })
}

/* ── 一段连续提交的合计改动（选区视图的数据） ──
 *
 * {base, head} → `git diff --raw -M -z --no-commit-id <base> <head>`：文件清单是
 * base..head 的合计（base 本身不算在内 —— 客户端传的 base 是最旧选中项的父提交）。
 * -z 的分段与单提交详情那套同款：每条记录先「:模式 模式 sha sha 状态」一段，路径
 * 跟在后面；R/C（改名/复制）带两段路径，旧路径进 from，差异视图点开时才用得上。
 * 状态字母原样带回去，客户端的 statusClass/statusLabel 认的就是同一套。 */
const RANGE_FILES_MAX = 4000
const COMMIT_RANGE_SHA = /^[0-9a-f]{7,40}$/i

async function commitRangeDetail(input, base, head) {
  if (COMMIT_RANGE_SHA.test(base) !== true || COMMIT_RANGE_SHA.test(head) !== true) {
    return { ok: false, error: 'bad-value', stderr: 'base 与 head 都要是 7–40 位十六进制的提交 hash' }
  }
  const args = argsFor(input)
  const raw = await git(args, ['-c', 'core.quotePath=false', 'diff', '--raw', '-M', '-z', '--no-commit-id', base, head], null, { maxBytes: 800000 })
  if (raw.exitCode !== 0) {
    return { ok: false, error: 'range-failed', base: base, head: head, stderr: raw.stderr, noGit: gitMissing(raw) }
  }
  const parts = raw.stdout.split('\u0000')
  const files = []
  let index = 0
  while (index < parts.length && files.length < RANGE_FILES_MAX) {
    const meta = parts[index]
    if (meta === undefined || meta.charAt(0) !== ':') { index += 1; continue }
    /* 状态是冒号那一段的最后一个空白分隔词（R100 / C075 这类相似度分数跟着字母）。 */
    const status = meta.slice(meta.lastIndexOf(' ') + 1)
    if (status.length === 0) { index += 1; continue }
    if (status.charAt(0) === 'R' || status.charAt(0) === 'C') {
      files.push({ status: status, path: field(parts, index + 2), from: field(parts, index + 1) })
      index += 3
    } else {
      files.push({ status: status, path: field(parts, index + 1), from: null })
      index += 2
    }
  }
  return {
    ok: true, base: base, head: head, files: files,
    truncated: raw.truncated === true || files.length >= RANGE_FILES_MAX,
  }
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
const DIFF_MODES = ['worktree', 'staged', 'commit', 'untracked', 'range', 'local']
const DIFF_LINES_MAX = 6000
const DIFF_CHARS_MAX = 400000
const DIFF_SHA = /^[0-9a-f]{7,40}$/i
/* range 模式的 ref 是「base..head」整段（选区视图点开一个文件时的读法）。 */
const DIFF_RANGE = /^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/i

function diffArgv(mode, paths, ref) {
  const common = ['--no-optional-locks', '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff']
  if (mode === 'commit') {
    /* `-m --first-parent` is what makes a merge commit readable: without it git
       prints the combined diff, which for a clean merge is empty — the file list
       would name a change and the patch would say there is none. */
    return ['--no-optional-locks', '-c', 'core.quotePath=false', 'show', '--no-color', '--no-ext-diff',
      '--format=', '--patch', '-m', '--first-parent', ref, '--'].concat(paths)
  }
  /* range：两棵树之间的一只文件（`git diff <base> <head> -- <path>`），选区视图
     「这一段提交合计改了它什么」的答案。 */
  if (mode === 'range') return common.concat([ref, '--']).concat(paths)
  /* local：「与本地比较」（文件右键菜单，61-filemenu.js）—— `git diff <提交> --
     <路径>`，提交里的版本和工作区现在的差在哪。ref 与 commit/range 同一道
     DIFF_SHA 校验（见 readFileDiff）。 */
  if (mode === 'local') return common.concat([ref, '--']).concat(paths)
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
  if (mode === 'range' && !DIFF_RANGE.test(ref)) {
    return { ok: false, error: 'invalid-ref', exitCode: null, stderr: 'ref must be base..head（两段十六进制提交 hash）' }
  }
  /* local 的 ref 就是那一个提交（「与本地比较」里比的是它）。 */
  if (mode === 'local' && !DIFF_SHA.test(ref)) {
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

/* ── the full patch text behind one row（文件右键菜单「复制完整差异」的数据）──

   readFileDiff 的同一条 diffArgv 生成器，回答的是另一句话：「把这个路径的完整
   补丁文本给我，我拿去粘给大模型解释这次修改的意义」。与展示用的那条读相比，
   两处刻意不同：

   · 不套展示用的两道截断（DIFF_LINES_MAX / DIFF_CHARS_MAX）——「完整」是这条
     命令的硬要求，半份补丁粘给 AI 不是解释这次修改，是误导。读取上限放宽到
     「命令」页同档（16MB，76-cmdlog.js 的 CMDLOG_TIMEOUT 同一档）；transport
     仍然截断时整件事不发生（ok:false，error:'patch-too-large'）—— revert-paths
     对半份补丁的同一条规矩：apply 不得半份，复制也不得半份。
   · 答复多带一份面向 AI 的头部（header）与拼好的全文（text = header + patch）：
     commit / range 路带仓库根、提交 hash、作者、日期、提交标题与正文；worktree
     路带仓库根与状态（已暂存 --cached / 未暂存 / 未跟踪 --no-index）。头部是
     普通文本行（unified diff 的正文从 `diff --git` 才开始，git apply 本来就忽略
     前面的杂行），粘进对话框不需要任何附加说明就能自解释。

   与 git/diff 同一条理由：不进读缓存、不进「命令」页 —— 这是读者正盯着的那份
   改动，读到旧的反而误事；读不记录，否则整页都是噪音。 */
const PATCH_MODES = ['commit', 'range', 'staged', 'worktree', 'untracked']
const PATCH_TEXT_MAX_BYTES = 16777216
/* 提交正文进头部的封顶：一条几万字的提交信息不该把整份复制文本撑爆。按字符截
   （头部是给人读的说明，不是要回apply的数据），截断时把话说在明处。 */
const PATCH_BODY_MAX_CHARS = 20000

/* UTF-8 字节数（答复带 bytes，客户端的成功提示按它说 KB）。Buffer 是 node 全局；
   桩环境没有时退回字符数 —— 只用于一行提示，中文字符串在那里会低估一半，无害。 */
function patchTextBytes(value) {
  if (typeof Buffer !== 'undefined' && Buffer != null && typeof Buffer.byteLength === 'function') {
    try { return Buffer.byteLength(value, 'utf8') } catch (error) { /* 退回字符数 */ }
  }
  return value.length
}

/* 一条提交的头部元数据（readCommitDetail 同一条 show -s --format 读法，只挑头部
   要用的那几格）。读不动（hash 已被改写等）不算整件事失败：头部少这几行，补丁
   照样完整 —— 头部是加餐，事实源是补丁本身。 */
async function patchCommitMeta(args, ref) {
  const meta = await git(args, ['-c', 'core.quotePath=false', 'show', '-s',
    '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b', ref], null, {})
  if (meta.exitCode !== 0) return null
  const fields = meta.stdout.split('\u001f')
  return {
    hash: fields[0] === undefined ? ref : fields[0],
    short: field(fields, 1),
    author: field(fields, 2),
    email: field(fields, 3),
    date: field(fields, 4),
    subject: field(fields, 5),
    body: field(fields, 6).replace(/\s+$/, ''),
  }
}

/* 头部的行清单。仓库根单独问一次 rev-parse --show-toplevel：多仓库分组的 repo
   参数与其它菜单动作同一条语义（argsFor 路由），但展示在头部的应该是 git 自己
   认的根（会话 cwd 与生效仓库不一定一回事）；问不出来退回请求里的仓库路径。 */
function patchHeaderOf(meta, scope, repoRoot, mode, ref, path, from) {
  const lines = []
  lines.push('Git 补丁（unified diff，完整未截断）')
  lines.push('仓库: ' + repoRoot)
  lines.push('路径: ' + (from.length > 0 ? from + ' → ' + path : path))
  if (mode === 'commit') {
    lines.push('范围: 这个提交对上面路径的完整改动（git show <提交> -- 路径）')
    if (meta != null) {
      lines.push('提交: ' + (meta.short.length > 0 ? meta.short + '（' + meta.hash + '）' : meta.hash))
      if (meta.author.length > 0) lines.push('作者: ' + meta.author + (meta.email.length > 0 ? ' <' + meta.email + '>' : ''))
      if (meta.date.length > 0) lines.push('日期: ' + meta.date)
      if (meta.subject.length > 0) lines.push('提交标题: ' + meta.subject)
      if (meta.body.length > 0) {
        const body = meta.body.length > PATCH_BODY_MAX_CHARS
          ? meta.body.slice(0, PATCH_BODY_MAX_CHARS) + '…（提交正文过长，此处截断）'
          : meta.body
        lines.push('提交正文:')
        const rows = body.split('\n')
        for (let i = 0; i < rows.length; i += 1) lines.push('  ' + rows[i])
      }
    }
  } else if (mode === 'range') {
    /* ref 是 base..head：补丁是一段连续提交的合计，头部给的是 head（最新一条）
       的元数据，并把「合计」这件事说明白 —— 不说清楚，AI 会把整段当成一条提交。 */
    lines.push('范围: 一段连续提交（' + ref + '）对上面路径的合计改动（git diff <base> <head> -- 路径）')
    if (meta != null) {
      lines.push('选区最新提交: ' + (meta.short.length > 0 ? meta.short + '（' + meta.hash + '）' : meta.hash))
      if (meta.author.length > 0) lines.push('作者: ' + meta.author + (meta.email.length > 0 ? ' <' + meta.email + '>' : ''))
      if (meta.date.length > 0) lines.push('日期: ' + meta.date)
      if (meta.subject.length > 0) lines.push('提交标题: ' + meta.subject)
      if (meta.body.length > 0) {
        const body = meta.body.length > PATCH_BODY_MAX_CHARS
          ? meta.body.slice(0, PATCH_BODY_MAX_CHARS) + '…（提交正文过长，此处截断）'
          : meta.body
        lines.push('提交正文:')
        const rows = body.split('\n')
        for (let i = 0; i < rows.length; i += 1) lines.push('  ' + rows[i])
      }
    }
  } else {
    lines.push('范围: 工作区里上面路径的改动补丁（'
      + (mode === 'staged' ? 'git diff --cached：已暂存的改动，相对 HEAD'
        : (mode === 'untracked' ? 'git diff --no-index：未跟踪的新文件，与空文件对比'
          : 'git diff：未暂存的改动，相对索引')) + '）')
  }
  if (scope.length > 0) lines.push('说明: ' + scope)
  lines.push('补丁正文如下:')
  return lines.join('\n') + '\n'
}

async function readPatchText(input) {
  const mode = input != null && isStr(input.mode) ? input.mode.trim() : ''
  if (PATCH_MODES.indexOf(mode) < 0) {
    return { ok: false, error: 'unknown-mode', exitCode: null, stderr: 'mode must be one of ' + PATCH_MODES.join(', ') }
  }
  const path = input != null && isStr(input.path) ? input.path : ''
  const bad = repoRelativePath(path)
  if (bad.length > 0) return { ok: false, error: 'invalid-path', exitCode: null, stderr: bad }

  const from = input != null && isStr(input.from) ? input.from : ''
  const ref = input != null && isStr(input.ref) ? input.ref.trim() : ''
  /* ref 校验与 readFileDiff 同一道 DIFF_SHA / DIFF_RANGE：这里只认「图上那一个
     提交」（或它的 base..head），ref 名与带 ^ 的表达式一律拒。 */
  if (mode === 'commit' && !DIFF_SHA.test(ref)) {
    return { ok: false, error: 'invalid-ref', exitCode: null, stderr: 'a commit hash is required' }
  }
  if (mode === 'range' && !DIFF_RANGE.test(ref)) {
    return { ok: false, error: 'invalid-ref', exitCode: null, stderr: 'ref must be base..head（两段十六进制提交 hash）' }
  }
  const paths = from.length > 0 && from !== path ? [from, path] : [path]

  const args = argsFor(input)
  /* 仓库根与提交元数据：两个便宜的读，各自失败都只降级头部、不拦补丁。 */
  const root = await git(args, ['rev-parse', '--show-toplevel'], null, {})
  const repoRoot = root.exitCode === 0 ? root.stdout.replace(/\s+$/, '') : String(repoFrom(input) || '')
  let meta = null
  if (mode === 'commit' || mode === 'range') {
    meta = await patchCommitMeta(args, mode === 'range' ? ref.slice(ref.indexOf('..') + 2) : ref)
  }

  const result = await git(args, diffArgv(mode, paths, ref), null, { maxBytes: PATCH_TEXT_MAX_BYTES })
  /* `git diff --no-index` says "these differ" with exit code 1 and a perfectly
     good patch on stdout; every other mode says it with exit code 0 —— 与
     readFileDiff 同一条判读。 */
  const produced = result.exitCode === 0 || (mode === 'untracked' && result.exitCode === 1 && result.stdout.length > 0)
  if (!produced) {
    return { ok: false, error: 'diff-failed', exitCode: result.exitCode, stderr: result.stderr, noGit: gitMissing(result), mode: mode, path: path }
  }
  if (result.truncated === true) {
    return {
      ok: false, error: 'patch-too-large', mode: mode, path: path, exitCode: result.exitCode,
      stderr: '这个路径的补丁太大（超过 ' + String(PATCH_TEXT_MAX_BYTES) + ' 字节），读取被截断 —— '
        + '「完整」是这条命令的硬要求，半份补丁不复制；请改用更具体的路径逐个复制。',
    }
  }

  const binary = patchLooksBinary(result.stdout)
  const counts = binary ? { added: 0, removed: 0 } : patchCounts(result.stdout)
  const patch = binary ? '' : result.stdout
  /* 空补丁与二进制都不算失败，但头部要把话说完：复制出去的文本得自解释，
     不能让读的人（或 AI）对着一段空气猜。 */
  let scope = ''
  if (binary === true) scope = '这个路径是二进制文件，git 不输出文本补丁，下面只有说明头。'
  else if (patch.replace(/\s+$/, '').length === 0) scope = 'git 没有输出任何差异：这个路径现在没有这个范围的改动（可能刚被还原/提交掉）。'
  const header = patchHeaderOf(meta, scope, repoRoot, mode, ref, path, from)
  const fullText = header + patch
  return {
    ok: true, mode: mode, path: path, from: from, ref: ref, repo: repoRoot,
    header: header, patch: patch, text: fullText, bytes: patchTextBytes(fullText),
    added: counts.added, removed: counts.removed,
    binary: binary, empty: patch.length === 0, exitCode: result.exitCode,
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
  /* 面板的变更执行进「命令」页（77-cmdrec.js）：开始先记一笔（运行中），结束补退出码。
     展示串与 result.command 同一个式子 —— gitExe 在处理函数跑之前就定好了（见 80-rpc.js
     的 onRpc），先后一致。 */
  const record = cmdrecBegin(input, opts.desc, gitExe + ' ' + argv.join(' '), requested)
  const result = await runner(argsFor(input), argv, null, opts.spawn == null ? {} : opts.spawn)
  cmdrecFinish(record, result.exitCode)
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

