/* ─────────────── git worktree（只读清单）─────────────── */

/* 「工作树」块（客户端 25-worktree.js）的数据：一份 `git worktree list --porcelain`
   的翻译。v1 是纯只读的：面板把它画出来，最多允许单击把历史按那个 worktree 的分支
   过滤 —— 不 checkout、不 prune、不碰任何 worktree 的工作区。这条边界在 Host 这一层
   就守住了：这里只有一条读命令，没有任何写路径。

   走 refsSnapshot 同一套按仓库读缓存：cached(repo, 'worktrees', …) 的寿命与
   for-each-ref 那份完全相同，任何一次整仓失效（panelMutate、⟳ 的 flush、以及
   worktree 增删本身 —— 那也是对仓库的改动，watcher bump 后重读）都把它一起作废。
   因此不另立过期机制，客户端也不用理解第二种缓存语义。

   porcelain 的形状：记录之间以空行分隔；每行 `关键字 值`，值原样保留（路径可能带
   空格，取关键字之后的整行）。locked / prunable 只在成立时出现，且可以不带原因
   （光一个 `locked` 或 `prunable` 独占一行）；branch 给的是全名（refs/heads/x），
   这里剥成短名；detached 的记录没有 branch 行；bare 的记录只有 worktree / bare 两行。 */
async function readWorktrees(input, repo) {
  const args = argsFor(input)
  /* gitC + core.quotePath=false（66-refs.js readRefs 同一组合）：porcelain 的关键字
     本身不会被翻译，但 locked 的原因会按 quotePath 规则把非 ASCII 原因引成八进制
     （实测：`locked "\345\217\230..."`），关掉它 tooltip 里才是人话。 */
  const listed = await gitC(args, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], null, {})
  if (listed.exitCode !== 0) {
    return { ok: false, repo: repo === undefined ? null : repo, error: 'not-a-repository', stderr: listed.stderr, noGit: gitMissing(listed), worktrees: [] }
  }
  const out = []
  let row = null
  const lines = listed.stdout.split('\n')
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
  return { ok: true, repo: listed.cwd, worktrees: out }
}

/* 与 refsSnapshot 同款的外壳：请求没点名仓库就按会话工作区直接读（git 自己会落到
   那个目录），点名了就走读缓存。 */
async function worktreesSnapshot(input) {
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readWorktrees(input, undefined)
  return await cached(repo, 'worktrees', function () { return readWorktrees(input, repo) })
}
