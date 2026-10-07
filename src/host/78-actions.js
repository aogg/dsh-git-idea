/* ─────────────── 压缩提交 / 快捷命令 ───────────────
 *
 * 两个都在面板「更多操作（⋯）」和「快捷命令（⚡）」按钮底下（客户端 78-actions.js）。
 * 放在 80-rpc.js 前面只影响阅读顺序：squashRun 用到的 commitMutation 声明在那儿，
 * 而这些函数只在 RPC 处理函数被调用时才运行 —— 同一个函数作用域里声明提升已经把它们
 * 备好了。 */

/* ── git/squash：把一段提交压成一个 ──
 *
 * 语义（客户端算好、这里照办）：soft reset 到最旧选中项的父提交，再 commit —— 于是
 * 从那个父提交到当前 HEAD 的整段进了同一个新提交。安全顺序一条不能换：
 *
 *   1. 身份预检（git var GIT_AUTHOR_IDENT，和 commitMutation 失败后问的是同一个问题）。
 *      身份缺失时**一个字节都不动**就答复 needsIdentity —— 先 reset 后发现提交不了，
 *      再 reset 回去，是拿读者的分支指针玩了两个来回。
 *   2. 防呆：expect 是客户端读图时的 HEAD，先 rev-parse 比对；对不上说明列表读数过期
 *      （HEAD 已经被别的窗口动了），拒绝，同样什么都不动。
 *   3. 工作区干净检查：`git status --porcelain` 里只允许「未跟踪」（'??'）一种行。
 *      reset --soft 不动索引，所以已暂存的改动会被随后的 commit 一起收进新提交；
 *      未暂存的改动则会悬在新提交底下 —— 两种都让「压这几个提交」变成「压这几个
 *      再捎上工作区」，全都拒绝。未跟踪文件谁也不碰。
 *   4. soft reset，然后 commit。
 *   5. commit 失败的兜底：尽力 `reset --soft` 回压缩前的 HEAD。部分成功是读者必须知道
 *      的事，答复里如实说 reset 回没回得去、git 原话是什么。 */

const SQUASH_STDOUT_MAX = 2000

async function squashRun(input) {
  const base = input != null && isStr(input.base) ? input.base.trim() : ''
  const message = input != null && isStr(input.message) ? input.message.trim() : ''
  const expect = input != null && isStr(input.expect) ? input.expect.trim() : ''
  if (base.length === 0) return { ok: false, error: 'a base commit is required' }
  if (message.length === 0) return { ok: false, error: 'a commit message is required' }
  const args = argsFor(input)

  /* 1. 身份：没有就到此为止，仓库原样。 */
  if (await identityMissing(args)) {
    return {
      ok: false, error: 'needsIdentity', needsIdentity: true, repo: args.repo || null,
      stderr: 'git 不知道这次提交该署谁的名字，压缩没有开始，仓库一个字节都没动。',
    }
  }

  /* 2. 防呆 + 压缩前 HEAD：一次 rev-parse 两用（比对 expect、失败兜底要指回去的位置）。 */
  const head = await git(args, ['rev-parse', 'HEAD'], null, {})
  const preHead = head.stdout.trim()
  if (head.exitCode !== 0 || preHead.length === 0) {
    return { ok: false, error: 'no-head', repo: args.repo || null, stderr: head.stderr, noGit: gitMissing(head) }
  }
  if (expect.length > 0 && preHead !== expect && preHead.indexOf(expect) !== 0) {
    /* expect 允许是短 hash：答复里给两个都能读的写法。 */
    return {
      ok: false, error: 'head-moved', repo: args.repo || null,
      stderr: '压缩前的 HEAD 是 ' + preHead.slice(0, 12) + '，现在已经是别的提交（期望 ' + expect.slice(0, 12)
        + '）—— 列表读数过期了。重新读一次再选，没有做任何改动。',
    }
  }

  /* 3. 工作区干净：只放行「未跟踪」。 */
  const status = await gitC(args, ['--no-optional-locks', '-c', 'core.quotePath=false',
    'status', '--porcelain', '--untracked-files=normal'], null, { maxBytes: SQUASH_STDOUT_MAX })
  if (status.exitCode !== 0) {
    return { ok: false, error: 'status-failed', repo: args.repo || null, stderr: status.stderr, noGit: gitMissing(status) }
  }
  const rows = status.stdout.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.length < 2) continue
    /* v1 porcelain 的前两列就是 index/worktree 状态；'??' 是未跟踪（唯一放行的写法），
       其余 —— 已暂存、未暂存、冲突中 —— 都是还悬在工作区/索引里的改动。 */
    if (row.charAt(0) !== '?' || row.charAt(1) !== '?') {
      return {
        ok: false, error: 'dirty-tree', repo: args.repo || null,
        stderr: '工作区还有已暂存或未暂存的改动（' + row.slice(3).slice(0, 120) + '）—— 先提交或 stash 掉它们再压缩，'
          + '未跟踪文件不受影响。没有做任何改动。',
      }
    }
  }

  /* 4. soft reset 到最旧选中项的父提交，再 commit。 */
  const reset = await panelMutate(input, ['reset', '--soft', '--', base])
  if (reset.ok !== true) return reset
  const commit = await commitMutation(input, ['commit', '-m', message])
  if (commit.ok === true) return commit

  /* 5. commit 没成：把分支 soft reset 回压缩前的 HEAD，成没成都要说清楚。 */
  const rollback = await panelMutate(input, ['reset', '--soft', '--', preHead])
  const said = isStr(commit.stderr) ? commit.stderr.replace(/\s+$/, '').slice(0, 400) : ''
  const story = rollback.ok === true
    ? '压缩里的 commit 这一步失败了，已把分支 soft reset 回压缩前的 ' + preHead.slice(0, 12)
      + '（暂存区里留着这段合计的改动，改好提交信息后可以直接再提交）。'
    : '压缩里的 commit 这一步失败了，而且把分支 soft reset 回压缩前位置（' + preHead.slice(0, 12)
      + '）的尝试也没有成功：' + (isStr(rollback.stderr) ? rollback.stderr.replace(/\s+$/, '').slice(0, 200) : '')
      + ' —— 现在分支停在 reset 之后的位置，暂存区里是这段的合计，请用 git log 确认现状。'
  return {
    ok: false, error: 'squash-commit-failed', repo: commit.repo,
    exitCode: commit.exitCode, command: commit.command,
    rolledBack: rollback.ok === true,
    needsIdentity: commit.needsIdentity === true,
    sandboxDenied: commit.sandboxDenied === true,
    noGit: commit.noGit === true,
    stderr: (said.length > 0 ? story + '\n' + said : story),
  }
}

/* ── git/quick：跑读者自定义的一条命令行 ──
 *
 * 快捷命令模板里的变量在客户端代值，这里拿到的是一条可以直接交给 shell 的命令行 ——
 * 和 configPath / 命令页扫描同一个先例：invoke 本来就是执行 shell 行的。workdir 是
 * 仓库、沙箱随会话（sandboxFor），所以一条 `git push` 在只读会话里会被拒，答复里带着
 * sandboxDenied 说得出来。
 *
 * 跑完无条件 invalidateRepo：命令内容不受这个插件约束，refs 完全可能被它动过，缓存
 * 不作废的话面板下一次读还是旧答案。 */
const QUICK_COMMAND_MAX = 8000
const QUICK_CLIP = 4000
const QUICK_TIMEOUT = { timeoutMs: 120000 }

function quickClip(value) {
  const raw = isStr(value) ? value : ''
  /* 尾部而不是头部：命令输出里读者要看的多半在结尾（日志的最后几行、构建的结果），
     而 invoke 的 stdoutMaxBytes 已经给了绝对上限，这里只是答复的礼貌截断。 */
  if (raw.length <= QUICK_CLIP) return { text: raw, truncated: false }
  return { text: raw.slice(raw.length - QUICK_CLIP), truncated: true }
}

async function quickRun(input) {
  const command = input != null && isStr(input.command) ? input.command.trim() : ''
  if (command.length === 0) return { ok: false, error: 'a command is required' }
  if (command.length > QUICK_COMMAND_MAX) {
    return { ok: false, error: 'command-too-long', stderr: '命令太长（' + String(command.length) + ' 字符，上限 ' + String(QUICK_COMMAND_MAX) + '）' }
  }
  const run = await invoke(command + '\n', argsAt(input, repoFrom(input)), null, QUICK_TIMEOUT)
  invalidateRepo(repoFrom(input))
  const out = quickClip(run.stdout)
  const err = quickClip(run.stderr)
  return {
    ok: run.exitCode === 0,
    repo: run.cwd,
    exitCode: run.exitCode,
    command: command,
    stdout: out.text,
    stderr: err.text,
    stdoutTruncated: out.truncated === true || run.truncated === true,
    stderrTruncated: err.truncated === true,
    sandboxDenied: run.sandboxDenied === true,
    timedOut: run.timedOut === true,
  }
}
