/* ─────────────── 压缩提交 / 删除提交 / 快捷命令 / 变更页三件套 ───────────────
 *
 * 前三个在面板「更多操作（⋯）」和「快捷命令（⚡）」按钮底下（客户端 78-actions.js），
 * 后两个是变更页「默认变更列表」那排按钮里的还原与暂存（客户端 54-changes.js）。
 * 放在 80-rpc.js 前面只影响阅读顺序：squashRun 用到的 commitMutation、restoreRun
 * 和 stashRun 用到的 panelMutate / panelPaths 都声明在那儿，而这些函数只在 RPC
 * 处理函数被调用时才运行 —— 同一个函数作用域里声明提升已经把它们备好了。 */

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

/* desc：这次 RPC 在「命令」页（77-cmdrec.js）里的中文名，由 80-rpc.js 的调用点传入，
   一路转给内部每次真正的 git 执行（压缩是多步改写，每一步都记，归属同一个名字）。 */
async function squashRun(input, desc) {
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

  /* 4. soft reset 到最旧选中项的父提交，再 commit。base 前不放 '--'：git 把 '--'
     之后的一切当 pathspec，`reset --soft -- <sha>` 只会得到 fatal: Cannot do soft
     reset with paths（hard 款同理）—— base 是图读给的全十六进制父提交 hash，不是
     路径，本来就没有歧义要防。 */
  const reset = await panelMutate(input, ['reset', '--soft', base], { desc: desc })
  if (reset.ok !== true) return reset
  const commit = await commitMutation(input, ['commit', '-m', message], { desc: desc })
  if (commit.ok === true) return commit

  /* 5. commit 没成：把分支 soft reset 回压缩前的 HEAD，成没成都要说清楚。 */
  const rollback = await panelMutate(input, ['reset', '--soft', preHead], { desc: desc })
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

/* ── git/drop：把从 HEAD 到最旧所选的整段区间连提交带改动一起丢弃 ──
 *
 * 与压缩对称但语义更狠：压缩是 reset --soft + 重新提交（整段的改动收进一个新提交，
 * 东西还在）；删除是 reset --hard —— 分支尖端挪到最旧选中项的父提交，那一段提交
 * **连同它们带来的改动**一起从工作区消失。客户端的确认框已把「改动一并丢弃」说在
 * 前头，这里再把安全顺序走完（骨架照 squashRun，差异就两处：不创建提交，所以没有
 * 身份预检；reset 是 hard，所以干净检查的理由更硬）：
 *
 *   1. 防呆：expect 是客户端读图时的 HEAD，先 rev-parse 比对（允许短 hash 前缀，
 *      同 squashRun）；对不上说明列表读数过期，拒绝，同样什么都不动。
 *   2. 工作区干净检查：`git status --porcelain` 里只允许「未跟踪」（'??'）一种行。
 *      reset --hard 会把已暂存/未暂存的改动一起卷掉 —— 对压缩那只是「捎带」，对
 *      删除是必然发生，必须先挡；未跟踪文件 reset --hard 不动，放行。
 *   3. hard reset 到 base。成功答复附加 preHead（删除前的 HEAD）：被删的提交在
 *      reflog 里还有约 30 天，`git reset --hard <preHead>` 是唯一的找回通道，必须
 *      随成功一起送到读者眼前。 */
async function dropRun(input, desc) {
  const base = input != null && isStr(input.base) ? input.base.trim() : ''
  const expect = input != null && isStr(input.expect) ? input.expect.trim() : ''
  if (base.length === 0) return { ok: false, error: 'a base commit is required' }
  const args = argsFor(input)

  /* 1. 防呆 + 删除前 HEAD：一次 rev-parse 两用（比对 expect、成功答复里的找回位置）。 */
  const head = await git(args, ['rev-parse', 'HEAD'], null, {})
  const preHead = head.stdout.trim()
  if (head.exitCode !== 0 || preHead.length === 0) {
    return { ok: false, error: 'no-head', repo: args.repo || null, stderr: head.stderr, noGit: gitMissing(head) }
  }
  if (expect.length > 0 && preHead !== expect && preHead.indexOf(expect) !== 0) {
    /* expect 允许是短 hash：答复里给两个都能读的写法。 */
    return {
      ok: false, error: 'head-moved', repo: args.repo || null,
      stderr: '删除前的 HEAD 是 ' + preHead.slice(0, 12) + '，现在已经是别的提交（期望 ' + expect.slice(0, 12)
        + '）—— 列表读数过期了。重新读一次再选，没有做任何改动。',
    }
  }

  /* 2. 工作区干净：只放行「未跟踪」（上限沿用 squash 的那份：同一条 status，同样
     的体积顾虑）。 */
  const status = await gitC(args, ['--no-optional-locks', '-c', 'core.quotePath=false',
    'status', '--porcelain', '--untracked-files=normal'], null, { maxBytes: SQUASH_STDOUT_MAX })
  if (status.exitCode !== 0) {
    return { ok: false, error: 'status-failed', repo: args.repo || null, stderr: status.stderr, noGit: gitMissing(status) }
  }
  const rows = status.stdout.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.length < 2) continue
    if (row.charAt(0) !== '?' || row.charAt(1) !== '?') {
      return {
        ok: false, error: 'dirty-tree', repo: args.repo || null,
        stderr: '工作区还有已暂存或未暂存的改动（' + row.slice(3).slice(0, 120) + '）—— 先提交或 stash 掉它们再删除：'
          + '删除会把这段提交连同工作区的改动一并丢弃，未跟踪文件不受影响。没有做任何改动。',
      }
    }
  }

  /* 3. hard reset：段连提交带改动一起从分支尖端消失。base 前不放 '--'，原因同上：
     git 把 '--' 之后的一切当 pathspec，`reset --hard -- <sha>` 会被 fatal: Cannot
     do hard reset with paths 拒掉；base 是全十六进制的父提交 hash，不是路径。 */
  const reset = await panelMutate(input, ['reset', '--hard', base], { desc: desc })
  if (reset.ok !== true) return reset
  return Object.assign({}, reset, { preHead: preHead })
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

async function quickRun(input, desc) {
  const command = input != null && isStr(input.command) ? input.command.trim() : ''
  if (command.length === 0) return { ok: false, error: 'a command is required' }
  if (command.length > QUICK_COMMAND_MAX) {
    return { ok: false, error: 'command-too-long', stderr: '命令太长（' + String(command.length) + ' 字符，上限 ' + String(QUICK_COMMAND_MAX) + '）' }
  }
  const requested = repoFrom(input, null)
  /* 快捷命令不走 panelMutate（它执行的是读者写的整条命令行，不限于 git），但同样是
     面板发起的变更 —— 记进「命令」页（77-cmdrec.js），展示串就是读者写的那条。 */
  const record = cmdrecBegin(input, desc, command, requested)
  const run = await invoke(command + '\n', argsAt(input, requested), null, QUICK_TIMEOUT)
  cmdrecFinish(record, run.exitCode)
  invalidateRepo(requested)
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

/* ── git/restore 与 git/stash：变更页「默认变更列表」的工具条 ──
 *
 * 那排按钮（客户端 54-changes.js）作用于组里勾选的路径，两条 RPC 的形状因此和
 * git/stage 一样：panelPaths 校验路径数组，panelMutate 跑命令 —— 读缓存的无条件
 * 失效、noGit、sandboxDenied 这些每条写命令都要带的字段都由它统一给出，错误也把
 * git 的原话原样带回。
 *
 * restore 是三件套里唯一破坏性的一件：`--source=HEAD --staged --worktree` 把索引和
 * 工作区**一起**拉回 HEAD —— 被删的文件也由此恢复，这正是「还原」要的意思。客户端
 * 已经用两段式确认挡过一次，这里照办不再多问（会挡两次的还是同一个读者）。
 *
 * stash 不破坏任何东西：`push -m <说明> -- <paths>` 只把勾选的路径收进 stash 栈，
 * `git stash pop` 就能拿回来。说明由客户端写好带来（带个数，`git stash list` 里认得出
 * 是哪一次）；缺了就让 git 自己写它的 WIP 句子 —— 这不是一个值得拒绝读者的错误。 */
async function restoreRun(input, desc) {
  const paths = panelPaths(input)
  if (paths.length === 0) return { ok: false, error: 'no paths given' }
  return panelMutate(input, ['restore', '--source=HEAD', '--staged', '--worktree', '--'].concat(paths), { desc: desc })
}

async function stashRun(input, desc) {
  const paths = panelPaths(input)
  if (paths.length === 0) return { ok: false, error: 'no paths given' }
  const message = input != null && isStr(input.message) ? input.message.trim() : ''
  const said = message.length > 0 ? ['-m', message] : []
  return panelMutate(input, ['stash', 'push'].concat(said, ['--'], paths), { desc: desc })
}
