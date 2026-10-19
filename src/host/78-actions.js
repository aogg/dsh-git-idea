/* ─────────────── 压缩提交 / 删除提交 / 快捷命令 / 变更页三件套 / 改写提交消息 ───────────────
 *
 * 前三个在面板「更多操作（⋯）」和「快捷命令（⚡）」按钮底下（客户端 78-actions.js），
 * 后两个是变更页「默认变更列表」那排按钮里的还原与暂存（客户端 54-changes.js）；
 * 最后一段是历史页右键的三条：git/edit-check（能不能改写的体检）、git/commit-messages
 * （整条原始消息）与 git/reword（reword 本体，安全链照 squashRun 的思路）。
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

/* ── git/branch-upstream：改一个本地分支跟踪的远端分支 ──
 *
 * 两种形状，客户端的「修改跟踪分支…」选择层（80-panel.js）各发一种：
 *   { branch, upstream: { remote, branch } } → git branch --set-upstream-to=<r>/<b> <本地分支>
 *   { branch, unset: true }                  → git branch --unset-upstream <本地分支>
 *
 * git 对非当前分支同样接受 --set-upstream-to（改的只是那条 branch.<name>.remote /
 * merge 配置），所以从分支树右键任何本地分支都能改，不需要先检出。名字的清洗沿用
 * git/pull 绑定上游那一条（80-rpc.js 的 cleanRefHalf：trim、去控制字符、拒前导 -），
 * 本地分支名与远端两半走同一套 —— argv 是数组、不过 shell，要挡的是 git 自己会误读
 * 的形状。desc 不由调用点传入（同文件其余动作的约定）而在这里按形状定 —— 与
 * git/pull 在 80-rpc.js 里内联「绑定上游」/「拉取」是同一个先例：两种形状是两件事，
 * 命令页里要认得出是哪一件。 */
async function branchUpstreamRun(input) {
  const name = cleanRefHalf(input != null && isStr(input.branch) ? input.branch : '')
  if (name === null || name.length === 0) {
    return { ok: false, error: 'bad-value', stderr: '需要一个合法的本地分支名：不能为空、不能以 - 开头、不能含控制字符' }
  }
  if (input != null && input.unset === true) {
    return panelMutate(input, ['branch', '--unset-upstream', name], { desc: '取消跟踪分支' })
  }
  const setup = input != null && input.upstream != null && typeof input.upstream === 'object' && !Array.isArray(input.upstream)
    ? input.upstream : null
  if (setup == null) {
    return { ok: false, error: 'bad-value', stderr: '要给出要跟踪的远端分支（upstream: {remote, branch}），或者 unset: true 取消跟踪' }
  }
  const remote = cleanRefHalf(setup.remote)
  const upstream = cleanRefHalf(setup.branch)
  if (remote === null || upstream === null || remote.length === 0 || upstream.length === 0) {
    return { ok: false, error: 'bad-value', stderr: '绑定上游需要合法的远端名与远端分支名：不能为空、不能以 - 开头、不能含控制字符' }
  }
  const done = await panelMutate(input, ['branch', '--set-upstream-to=' + remote + '/' + upstream, name], { desc: '修改跟踪分支' })
  if (done.ok !== true) return done
  /* 成功答复带上绑的是哪一对：客户端的提示条从参数里也拼得出同一句，答复自己
     说一遍，命令页之外读答复的人不用猜。 */
  return Object.assign({}, done, { setUpstream: { remote: remote, branch: upstream } })
}

/* ── git/branch-rename：重命名一个本地分支 ──
 *
 * { name: 旧名, to: 新名 } → git branch -m <旧> <新>。对当前分支同样成立：git 自己
 * 会把 HEAD 与它写着的旧名一起改过去，不需要先切走。名字的清洗沿用 cleanRefHalf
 * （80-rpc.js：trim、拒控制字符与前导 -，上限 300）—— 本地分支名与远端两半走同一
 * 套，argv 是数组、不过 shell，要挡的是 git 自己会误读的形状。desc 固定「重命名
 * 分支」，与 branch-delete / branch-upstream 一个先例：一件事在命令页里一个名字。
 */
async function branchRenameRun(input) {
  const name = cleanRefHalf(input != null && isStr(input.name) ? input.name : '')
  const to = cleanRefHalf(input != null && isStr(input.to) ? input.to : '')
  if (name === null || to === null || name.length === 0 || to.length === 0) {
    return { ok: false, error: 'bad-value', stderr: '重命名需要合法的旧名字与新名字：不能为空、不能以 - 开头、不能含控制字符' }
  }
  return panelMutate(input, ['branch', '-m', name, to], { desc: '重命名分支' })
}

/* ─────────────── 历史页右键与多选：体检 / 原始消息 / 改写提交消息 ───────────────
 *
 * 三条都是给「提交行右键菜单」服务的（客户端 80-panel.js 的 ctxCommitItems 与
 * 菜单开着时那条 edit-check 读）：
 *
 * · git/edit-check —— 对每个 hash 答四个问题：reachable（在不在当前分支历史上）、
 *   pushed（进没进远端分支，改写它就意味着强推）、isHead（是不是当前 HEAD）、
 *   isRoot（是不是根提交）。答复外带 head（此刻 HEAD 的完整 hash）—— 客户端开
 *   「编辑提交消息」框时拿它当 expect。纯只读，不进「命令」页。
 * · git/commit-messages —— 逐条读整条原始消息（%B）。上限 20 条：确认框里「列出
 *   选区提交」与消息预填都吃它，超出就明说拒绝，别让一条 RPC 悄悄读半份。
 * · git/reword —— 改写一条提交的消息。安全链的顺序照 squashRun 的思路：任何一步
 *   失败都一个字节不动，见 rewordRun 自己的注释。 */

/* 清洗客户端带来的一个 hash：trim 后只放行 7–40 位十六进制（短/全 hash 都收，
   其余形状 —— ref 名、带 ^ 修饰的表达式 —— 一律拒：这几条 RPC 只认「图上那一条」。 */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/

function cleanCommitHash(value) {
  const one = isStr(value) ? value.trim() : ''
  return COMMIT_SHA.test(one) === true ? one : ''
}

/* 一串 hash 的公共入口（edit-check 与 commit-messages）：清洗、去重、保序、封顶。
   超限不算错误由调用方按各自的话说 —— 这里只把干净的清单交回去。 */
function cleanHashList(input, max) {
  const raw = input != null && Array.isArray(input.hashes) ? input.hashes : []
  const out = []
  for (let i = 0; i < raw.length && out.length < max; i += 1) {
    const one = cleanCommitHash(raw[i])
    if (one.length === 0 || out.indexOf(one) >= 0) continue
    out.push(one)
  }
  return { list: out, given: raw.length }
}

/* `git rev-list --parents -1 <hash>` 一行：hash 加上它的父提交们。只有 hash 自己
   一个词 = 根提交。读不动（坏 hash、没这个提交）返回 -1，调用方按「找不到」说。 */
async function parentCountOf(args, hash) {
  const asked = await gitC(args, ['rev-list', '--parents', '-1', hash], null, {})
  if (asked.exitCode !== 0) return -1
  const words = asked.stdout.trim().split(/\s+/).filter(function (word) { return word.length > 0 })
  return words.length
}

async function editCheckSnapshot(input) {
  const asked = cleanHashList(input, 50)
  if (asked.list.length === 0) return { ok: false, error: 'hash is required' }
  if (asked.given > asked.list.length) {
    return { ok: false, error: 'too-many-hashes', stderr: '一次最多体检 50 个提交（去重后收到 ' + String(asked.list.length) + ' 个）' }
  }
  const args = argsFor(input)
  const head = await git(args, ['rev-parse', 'HEAD'], null, {})
  const headHash = head.stdout.trim()
  if (head.exitCode !== 0 || headHash.length === 0) {
    return { ok: false, error: 'no-head', repo: args.repo || null, stderr: head.stderr, noGit: gitMissing(head) }
  }
  const checks = []
  for (let i = 0; i < asked.list.length; i += 1) {
    const hash = asked.list[i]
    /* reachable：merge-base --is-ancestor 的退出码就是答案 —— 0 = 在 HEAD 的
       历史上，1 = 不在，>1 = 连问都问不了（坏 hash 等），后两种都按「不在」答。 */
    const ancestor = await gitC(args, ['merge-base', '--is-ancestor', hash, 'HEAD'], null, {})
    /* pushed：远端分支里有它 = 改写要强推。仓库没有远端时这条输出恒空 —— pushed
       恒 false，正是没有强推问题的仓库该得的答案。 */
    const contains = await gitC(args, ['branch', '-r', '--contains', hash], null, {})
    const parents = await parentCountOf(args, hash)
    checks.push({
      hash: hash,
      reachable: ancestor.exitCode === 0,
      pushed: contains.exitCode === 0 && contains.stdout.replace(/\s+$/, '').length > 0,
      isHead: hash === headHash || (hash.length < headHash.length && headHash.indexOf(hash) === 0),
      isRoot: parents === 1,
    })
  }
  return { ok: true, head: headHash, checks: checks }
}

const COMMIT_MESSAGES_MAX = 20
const COMMIT_MESSAGE_BYTES = 20000

async function commitMessagesSnapshot(input) {
  const asked = cleanHashList(input, COMMIT_MESSAGES_MAX)
  if (asked.list.length === 0) return { ok: false, error: 'hash is required' }
  if (asked.given > COMMIT_MESSAGES_MAX) {
    return { ok: false, error: 'too-many-hashes', stderr: '一次最多读 20 条提交消息（收到 ' + String(asked.given) + ' 个）—— 先收窄选区' }
  }
  const args = argsFor(input)
  const messages = []
  for (let i = 0; i < asked.list.length; i += 1) {
    const hash = asked.list[i]
    const one = await gitC(args, ['log', '-1', '--format=%B', hash], null, { maxBytes: COMMIT_MESSAGE_BYTES })
    if (one.exitCode !== 0) {
      return { ok: false, error: 'commit-not-found', hash: hash, stderr: one.stderr, noGit: gitMissing(one) }
    }
    const message = one.stdout.replace(/\s+$/, '')
    messages.push({ hash: hash, subject: message.split('\n')[0], message: message })
  }
  return { ok: true, messages: messages }
}

/* ── git/reword：把一条提交的消息改掉，其余一字不动 ──
 *
 * 安全链的顺序一条不能换（照 squashRun 的思路：任何一步失败都一个字节不动）：
 *
 *   1. 入参：hash 清洗、消息 trim 非空、长度上限 8000。
 *   2. 防呆：expect 是客户端开框那刻的 HEAD，先 rev-parse 比对（允许短 hash 前缀，
 *      同 squashRun）；对不上说明读数过期，拒绝。
 *   3. reachable：目标必须就在当前分支的历史上（merge-base --is-ancestor）——
 *      改写别的分支的提交本来就不会生效，挡在动手前。
 *   4. sequencer 空闲：.git 里有 cherry-pick / revert / merge / rebase 的半成品现场
 *      就拒绝（62-panel.js 的 sequencerShell 同一份探测）—— 在别人的进行时上再起
 *      一场 rebase，只会把两个现场搅在一起。
 *   5. 根提交拒绝：它没有父提交可以变基，v1 不支持（ amend 那条路对根提交同样
 *      成立，但一致性优先 —— IDEA 同样不给根提交 reword）。
 *   6. 动手，两条路：
 *      · 目标就是 HEAD：`git commit --amend --only -F <msgfile>`。--only 是关键：
 *        已有暂存的改动也不许卷进这次 amend。
 *      · 非 HEAD：`git rebase -i --autostash <hash>^`，用 sequence.editor 把 todo
 *        里目标行 `pick <short>` 后面插一行 `exec git commit --amend --only -F
 *        <msgfile>` —— rebase 走到那一行时 HEAD 恰好就是目标提交，exec 把消息
 *        换掉，其余提交原样重放。全程不需要真正的交互编辑器；todo 改写后必须
 *        校验确实命中且只命中那一行，没命中就让编辑器退出非零，rebase 随之中止。
 *   7. rebase 退出非零：立刻 `git rebase --abort`（abort 再失败也要如实回报），
 *      git 的原话带回来。
 *
 * 消息文件用 mktemp -d 建，消息经 shq 安全进 shell；改写这一步走 commitMutation
 * （「命令」页、读缓存失效、sandboxDenied/noGit 都由它统一给出），成功答复带
 * 改写后的 HEAD（newHead）。 */

const REWORD_MESSAGE_MAX = 8000

/* sequence.editor 的真身：把 todo 里的目标行找出来、恰好在它后面插 exec 行。
 * 不用 sed/awk（插件至今只依赖 grep 与 POSIX 内建），一段 while 读行足够 —— todo
 * 文件就几十行。三道闸：目标行恰好 1 条、插进去的 exec 行恰好 1 条、最后整份写回；
 * 任何一道不对就退出非零，git 因此中止这次 rebase（「没命中就不动」由编辑器的
 * 非零退出表达，比改坏一份 todo 再回滚可靠）。
 *
 * 最后一行必须是 exit 0：git 调编辑器是 `sh -c '<这段> "$@"' … <todo路径>` —— 追加
 * 的 "$@" 跟在整段脚本末尾，最后一条若是 `rm -f "$todo"`，它就成了
 * `rm -f "$todo" <todo路径>`，把自己的劳动成果连同 git 的 todo 一起删掉（git 回头
 * 读 todo 就是 No such file）。exit 让追加的那截永远轮不到执行。 */
function rewordEditorSnippet(shortHash, msgfile) {
  const want = 'pick ' + shortHash
  const execLine = 'exec git commit --amend --only -F ' + shq(msgfile)
  return [
    'f="$1"',
    'todo="$f.dshgit"',
    'want=' + shq(want),
    'exec_line=' + shq(execLine),
    'hits=0',
    ': > "$todo"',
    'while IFS= read -r line || [ -n "$line" ]; do',
    '  printf \'%s\\n\' "$line" >> "$todo"',
    '  case "$line" in',
    '    "$want" | "$want "*) hits=$((hits+1)); printf \'%s\\n\' "$exec_line" >> "$todo" ;;',
    '  esac',
    'done < "$f"',
    'if [ "$hits" != "1" ]; then',
    '  rm -f "$todo"',
    '  printf \'%s\\n\' "dsh-git-idea: todo 里应当恰好一条 $want，实际 $hits 条 —— 放弃这次改写" >&2',
    '  exit 1',
    'fi',
    'execs=$(grep -c -F -x "$exec_line" "$todo")',
    'if [ "$execs" != "1" ]; then',
    '  rm -f "$todo"',
    '  printf \'%s\\n\' "dsh-git-idea: exec 行没有恰好写进一条 —— 放弃这次改写" >&2',
    '  exit 1',
    'fi',
    'cat "$todo" > "$f"',
    'rm -f "$todo"',
    'exit 0',
  ].join('\n')
}

/* sequencer 空闲吗：一把探测（62-panel.js 的 sequencerShell 原样复用），有半成品
   现场就返回它的名字（cherry-pick / revert / merge / rebase），空闲返回空串。
   git 都不在 / 不是仓库返回空串 —— 那不是「忙」，后面的 git 步骤自己会挡。 */
async function sequencerBusy(args) {
  const probe = await invoke(
    gitGuard()
      + 'gd=$(' + gitCmd() + ' rev-parse --absolute-git-dir 2>/dev/null)\n'
      + 'if [ -z "$gd" ]; then exit 0; fi\n'
      + sequencerShell() + '\n',
    args, null, { timeoutMs: 10000 })
  const lines = probe.stdout.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].indexOf('S:') === 0) return lines[i].slice(2)
  }
  return ''
}

async function rewordRun(input, desc) {
  const hash = cleanCommitHash(input != null ? input.hash : null)
  const message = input != null && isStr(input.message) ? input.message : ''
  const trimmed = message.trim()
  const expect = input != null && isStr(input.expect) ? input.expect.trim() : ''
  if (hash.length === 0) {
    return { ok: false, error: 'bad-value', stderr: '需要一个合法的提交 hash（7–40 位十六进制）—— 没有做任何改动' }
  }
  if (trimmed.length === 0) {
    return { ok: false, error: 'a commit message is required', stderr: '提交消息不能为空 —— 没有做任何改动' }
  }
  if (message.length > REWORD_MESSAGE_MAX) {
    return { ok: false, error: 'message-too-long', stderr: '提交消息太长（' + String(message.length) + ' 字符，上限 ' + String(REWORD_MESSAGE_MAX) + '）—— 没有做任何改动' }
  }
  const args = argsFor(input)

  /* 1. 防呆 + 改写前 HEAD：一次 rev-parse 两用（expect 比对、HEAD 与否的分路）。 */
  const head = await git(args, ['rev-parse', 'HEAD'], null, {})
  const preHead = head.stdout.trim()
  if (head.exitCode !== 0 || preHead.length === 0) {
    return { ok: false, error: 'no-head', repo: args.repo || null, stderr: head.stderr, noGit: gitMissing(head) }
  }
  if (expect.length > 0 && preHead !== expect && preHead.indexOf(expect) !== 0) {
    /* expect 允许是短 hash：答复里给两个都能读的写法（squashRun 同一句话）。 */
    return {
      ok: false, error: 'head-moved', repo: args.repo || null,
      stderr: '改写前的 HEAD 是 ' + preHead.slice(0, 12) + '，现在已经是别的提交（期望 ' + expect.slice(0, 12)
        + '）—— 列表读数过期了。重新读一次再选，没有做任何改动。',
    }
  }

  /* 2. reachable：只改写当前分支走过的提交。 */
  const ancestor = await gitC(args, ['merge-base', '--is-ancestor', hash, 'HEAD'], null, {})
  if (ancestor.exitCode !== 0) {
    return {
      ok: false, error: 'not-reachable', repo: args.repo || null,
      stderr: '这个提交不在当前分支的历史上（git merge-base --is-ancestor 退出码 '
        + String(ancestor.exitCode) + '）—— 改写它不会出现在任何分支上。没有做任何改动。',
    }
  }

  /* 3. sequencer 空闲：拣选/还原/合并/变基的半成品现场一个都不能有。 */
  const busyOp = await sequencerBusy(args)
  if (busyOp.length > 0) {
    const SEQ_BUSY_LABELS = { 'cherry-pick': '拣选', 'revert': '还原', 'merge': '合并', 'rebase': '变基' }
    const said = SEQ_BUSY_LABELS[busyOp] !== undefined ? SEQ_BUSY_LABELS[busyOp] : busyOp
    return {
      ok: false, error: 'sequencer-busy', repo: args.repo || null,
      stderr: '上一次的「' + said + '」还没有结束（.git 里有它留下的现场）—— 先继续或中止它，再改写提交消息。没有做任何改动。',
    }
  }

  /* 4. 根提交拒绝：它没有父提交，rebase 那条路无从谈起。 */
  const parents = await parentCountOf(args, hash)
  if (parents < 0) {
    return { ok: false, error: 'commit-not-found', repo: args.repo || null, stderr: '读不到这条提交（git rev-list 失败）—— 它可能已经不在了。没有做任何改动。' }
  }
  if (parents === 1) {
    return {
      ok: false, error: 'is-root', repo: args.repo || null,
      stderr: '这是这条分支的第一个提交（根提交），它没有父提交可以变基 —— 暂不支持改写根提交。没有做任何改动。',
    }
  }

  /* 5. 消息文件：mktemp -d 建目录，消息经 shq 安全写进去。目录路径先落地，两条
     动手路（amend / rebase 的 exec 行）都要用它。 */
  const made = await invoke(
    'd=$(mktemp -d) || exit 9\n[ -n "$d" ] || exit 9\nprintf \'%s\\n\' ' + shq(message) + ' > "$d/msg" || exit 9\nprintf %s "$d"\n',
    args, null, { timeoutMs: 10000 })
  const dir = made.stdout.replace(/\s+$/, '')
  if (made.exitCode !== 0 || dir.length === 0) {
    return {
      ok: false, error: 'temp-failed', repo: args.repo || null,
      stderr: '建临时目录失败了，消息文件没有落地' + (made.sandboxDenied === true ? '（被文件沙箱拒绝）' : '')
        + ' —— 没有做任何改动。',
      sandboxDenied: made.sandboxDenied === true,
    }
  }
  const msgfile = dir + '/msg'

  /* 6. 动手。amend 与 rebase 都走 commitMutation：进「命令」页、失效读缓存、
     sandboxDenied / noGit 自报（squashRun 同一条变更路）。 */
  let done
  const isHead = hash === preHead || (hash.length < preHead.length && preHead.indexOf(hash) === 0)
  if (isHead === true) {
    /* --only 是关键：已有暂存的改动也不许卷进这次 amend（--amend 默认吃索引）。 */
    done = await commitMutation(input, ['commit', '--amend', '--only', '-F', msgfile], { desc: desc })
  } else {
    /* short hash 先算好：todo 里 git 写的就是短 hash，编辑器按它找目标行。 */
    const shortAsk = await gitC(args, ['rev-parse', '--short', hash], null, {})
    const shortHash = shortAsk.exitCode === 0 ? shortAsk.stdout.replace(/\s+$/, '').split('\n')[0] : ''
    if (COMMIT_SHA.test(shortHash) !== true) {
      await invoke('rm -rf ' + shq(dir) + '\n', args, null, { timeoutMs: 10000 })
      return { ok: false, error: 'short-hash-failed', repo: args.repo || null, stderr: shortAsk.stderr, noGit: gitMissing(shortAsk) }
    }
    const editor = rewordEditorSnippet(shortHash, msgfile)
    done = await commitMutation(input, ['-c', 'sequence.editor=' + editor, 'rebase', '-i', '--autostash', hash + '^'], { desc: desc })
    if (done.ok !== true) {
      /* rebase 没走完：现场还在（撞了冲突等）就立刻 `rebase --abort` 收干净；
         现场已经不在（编辑器退出非零时 git 自己就中止了）就不补一刀 —— 那样只会
         得到一句 No rebase in progress，还把读者吓一分。两条路都把 git 的原话带回，
         abort 再失败也要如实回报。 */
      const stillBusy = await sequencerBusy(args)
      const aborted = stillBusy.length > 0
        ? await panelMutate(input, ['rebase', '--abort'], { desc: desc })
        : null
      await invoke('rm -rf ' + shq(dir) + '\n', args, null, { timeoutMs: 10000 })
      const raw = isStr(done.stderr) ? done.stderr.replace(/\s+$/, '').slice(0, 400) : ''
      const story = stillBusy.length === 0
        ? '改写消息的 rebase 没有走完，git 已自行收场，分支还在改写前的位置。git 的原话：'
        : (aborted.ok === true
            ? '改写消息的 rebase 没有走完，已中止（rebase --abort），分支回到了改写前的样子。git 的原话：'
            : '改写消息的 rebase 没有走完，而且中止它的尝试也失败了 —— 分支可能还停在 rebase 中间，请先看 git status 再操作。git 的原话：')
      return {
        ok: false, error: 'rebase-failed', repo: done.repo,
        exitCode: done.exitCode, command: done.command,
        aborted: aborted === null ? true : aborted.ok === true,
        sandboxDenied: done.sandboxDenied === true,
        noGit: done.noGit === true,
        stderr: (raw.length > 0 ? story + '\n' + raw : story),
      }
    }
  }
  await invoke('rm -rf ' + shq(dir) + '\n', args, null, { timeoutMs: 10000 })
  if (done.ok !== true) return done
  /* 成功答复带改写后的 HEAD：amend 换了 hash，客户端要据此选中新行。 */
  const after = await git(args, ['rev-parse', 'HEAD'], null, {})
  return Object.assign({}, done, { newHead: after.exitCode === 0 ? after.stdout.trim() : '' })
}
