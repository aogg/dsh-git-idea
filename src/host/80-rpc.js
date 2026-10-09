/* Every request the Client can make, in one table. Each handler is registered
   through `ctx.effect` so it belongs to this fiber: stopping or updating the
   Package removes all of them, which is what makes the bridge's reload safe.

   Each one waits for the plugin config before the handler runs, because the
   config decides which binary every command in this plugin starts with
   (`gitExe` — see 72-gitbin.js) and command lines are built synchronously inside
   the handlers. One cached read for the life of the process: the first request
   pays for it, and a "which git" answer can never be half-applied. */
function onRpc(name, handler) {
  ctx.effect(function () {
    return harness.handle(name, function (input) {
      return readConfigFile()
        .then(function () { return withSessionRepo(input) })
        .then(function (resolved) { return handler(resolved) })
    })
  }, 'dsh-git-idea rpc ' + name)
}

onRpc('git/panel', function (input) { return panelSnapshot(input) })

onRpc('git/init', function (input) { return initSnapshot(input, '初始化仓库') })

/* The client's refresh button must be able to force a re-read; without this it
   would only repaint whatever the read cache already held. */
onRpc('git/flush', function (input) {
  invalidateRepo(repoFrom(input, null))
  return { ok: true }
})

onRpc('git/config', function () {
  return configPath().then(function (path) {
    return readConfigFile().then(function (config) {
      return { ok: true, path: path, config: config }
    })
  })
})

onRpc('git/config-save', function (input) {
  /* 带上会话：这份文件在任何工作区之外，写它的策略来自这个会合（`sandboxFor`）。
     没有会话时拿到的是部署默认那份（workspace-write），写到 ~/.dsh 会被拒 —— 而现在
     被拒会在答复里说出来，不再是一个安静的 no-op。 */
  return writeConfigFile(input != null ? input.config : null, argsAt(input, null))
})

/* The two machine-level questions the settings page asks: which git, and who
   commits. Both are reads of the world outside the repository and neither is
   cached — the reader opening this page is asking "now", not "a moment ago". */
onRpc('git/toolchain', function () { return toolchainSnapshot() })

onRpc('git/identity', function (input) { return identitySnapshot(input) })

/* The one mutation that is not about the repository at all: it writes the
   reader's own name and address into git's configuration. Explicit button, named
   scope, and nothing is written for a box left empty. */
onRpc('git/identity-save', function (input) { return identitySave(input) })

/* 本项目的 git 配置（面板「配置」页，74-identity.js）：四个键各答 local / global /
   生效与来源；写只进这个仓库的 .git/config。两条都是设置类动作，不进「命令」页
   （git/identity-save 同一个先例）：写的是 git 的配置而不是仓库内容，watcher 也不
   会看见它，记进命令页只是噪音。 */
onRpc('git/project-config', function (input) { return projectConfigSnapshot(input) })

onRpc('git/project-config-save', function (input) { return projectConfigSave(input) })

/* Never cached: its whole purpose is to observe change. `paths` narrows the
   working-tree half of the signature to what is on screen — see watchCommand for
   what a whole-tree status costs on a slow mount. */
onRpc('git/watch', function (input) {
  const target = repoFrom(input, null)
  if (target === undefined) return { ok: false, repo: null, sig: '' }
  const deep = input != null && input.deep === true
  const paths = deep ? readPaths(input) : []
  return probeShell(input, watchCommand(target, deep, paths)).then(function (probe) {
    return { ok: true, repo: target, sig: probe.stdout, paths: paths }
  })
})

onRpc('git/graph', function (input) { return graphSnapshot(input) })

onRpc('git/authors', function (input) { return authorsSnapshot(input) })

onRpc('git/refs', function (input) { return refsSnapshot(input) })

onRpc('git/branches', function (input) { return branchesSnapshot(input) })

/* 多仓库（61-repos.js）：扫描不进读缓存 —— 它自己的去重（客户端每个工作区只问一次）
   就是缓存，而手动清单那一半每次都该重新核对「还在不在」。 */
onRpc('git/repos', function (input) { return readWorkspaceRepos(input) })

onRpc('git/repos-save', function (input) { return saveWorkspaceRepo(input) })

/* 面板「命令」页：这个工作区里执行过的所有 git 命令，数据源是 DSH 的会话记录
   而不是仓库（76-cmdlog.js）。和上面两个 repos 读一样按工作区走，不进读缓存 ——
   它要的就是「刚刚又跑了什么」，每次都重读一遍会话文件。 */
onRpc('git/command-log', function (input) { return commandLogSnapshot(input) })

onRpc('git/commit-detail', function (input) { return commitDetailSnapshot(input) })

/* The one read the panel asks for by path rather than by repository: the patch
   behind a row in the changes tree or in a commit's file list. Never cached —
   it is the live text of a file the reader is looking at. */
onRpc('git/diff', function (input) { return readFileDiff(input) })

/* git collapses an untracked directory into a single entry; this is what is
   inside it, asked for only when the reader opens that row. */
onRpc('git/untracked', function (input) { return readUntrackedTree(input) })

/* 变更类 RPC 各自带一个中文名（desc），随 panelMutate / quickRun 记进「命令」页
   （77-cmdrec.js）—— 那一页的描述列说的就是它。读类的 RPC 不带：读不记录，否则
   watcher 每 3 秒一刷，整页都是噪音。 */
onRpc('git/stage', function (input) {
  const paths = panelPaths(input)
  if (paths.length === 0) return { ok: false, error: 'no paths given' }
  return panelMutate(input, ['add', '--'].concat(paths), { desc: '暂存' })
})

onRpc('git/unstage', function (input) {
  const paths = panelPaths(input)
  if (paths.length === 0) return { ok: false, error: 'no paths given' }
  return panelMutate(input, ['restore', '--staged', '--'].concat(paths), { desc: '取消暂存' })
})

/* 变更页「默认变更列表」工具条的还原与暂存（78-actions.js 的 restoreRun/stashRun）。
    与上面 stage/unstage 同一条 panelMutate 路：读缓存的无条件失效对它们同样是必须的
    —— restore 连工作区一起动了，stash 则把路径连同索引里的那份一起收走。 */
onRpc('git/restore', function (input) { return restoreRun(input, '还原改动') })

onRpc('git/stash', function (input) { return stashRun(input, '收起改动(stash)') })

/* A failed commit is the one mutation whose failure can be about this machine
   instead of about the repository: git will not author a commit until it knows
   who the author is, and no amount of retrying here changes that. Asked of git
   itself, once, and only after the commit has already been refused — see
   `identityMissing`. The flag rides the same reply as `noGit` and
   `sandboxDenied`, so the client has one place to read all three.

   Which mutations go through here is decided at the call site, because only the
   call site knows whether the command writes a commit object. `git add`,
   `git branch -d` and the aborts all run on a machine with no identity at all —
   hanging "this machine has no identity" on one of those would send the reader
   to fix something that is not broken. */
async function commitMutation(input, argv, options) {
  const result = await panelMutate(input, argv, options)
  if (result.ok !== true) result.needsIdentity = await identityMissing(argsFor(input))
  return result
}

onRpc('git/commit', function (input) {
  const message = input != null && isStr(input.message) ? input.message.trim() : ''
  if (message.length === 0) return { ok: false, error: 'a commit message is required' }
  /* stageAll 的 add -A 与 commit 同属「提交」这一次操作，名字也跟着同一条。 */
  if (input != null && input.stageAll === true) {
    return panelMutate(input, ['add', '-A'], { desc: '提交' }).then(function (staged) {
      if (staged.ok !== true) return staged
      return commitMutation(input, ['commit', '-m', message], { desc: '提交' })
    })
  }
  return commitMutation(input, ['commit', '-m', message], { desc: '提交' })
})

onRpc('git/checkout', async function (input) {
  const name = input != null && isStr(input.name) ? input.name.trim() : ''
  if (name.length === 0) return { ok: false, error: 'a branch name is required' }
  /* `-` is git's own shorthand for the previous branch; resolve it here so the
     caller never has to know that the switcher's "previous" row and this
     argument are the same idea. */
  let target = name
  if (name === '-') {
    target = await previousBranch(input)
    if (target.length === 0) return { ok: false, error: 'there is no previous branch to switch back to' }
  }
  return await switchBranch(input, target, '切换分支')
})

const NET_SPAWN = { timeoutMs: 180000 }

/* The three arguments this plugin chooses about the network, each read from the
   plugin config at the moment it is used: `fetch --all` prunes only if asked,
   `pull` merges unless the reader prefers rebase, and a push to a branch with no
   upstream is left to the panel's own "set upstream and push" row unless the
   reader asked for it to just happen. git's own `push.default` and `pull.rebase`
   are not overridden — these are the flags this plugin adds on top. */
async function netConfig() {
  return await readConfigFile()
}

onRpc('git/fetch', async function (input) {
  const config = await netConfig()
  return panelMutate(input, config.fetchPrune === true ? ['fetch', '--all', '--prune'] : ['fetch', '--all'], { net: true, spawn: NET_SPAWN, desc: '取回' })
})

onRpc('git/pull', async function (input) {
  const config = await netConfig()
  /* A pull that merges writes a commit, so the identity can be what failed. */
  return commitMutation(input, config.pullRebase === true ? ['pull', '--rebase'] : ['pull'], { net: true, spawn: NET_SPAWN, desc: '拉取' })
})

onRpc('git/push', function (input) {
  if (input != null && input.setUpstream === true) {
    const remote = input != null && isStr(input.remote) && input.remote.trim().length > 0 ? input.remote.trim() : ''
    const branch = input != null && isStr(input.branch) ? input.branch.trim() : ''
    if (remote.length === 0) return { ok: false, error: 'no remote is configured to push to' }
    if (branch.length === 0) return { ok: false, error: 'a branch is required to set an upstream' }
    return panelMutate(input, ['push', '-u', remote, branch], { net: true, spawn: NET_SPAWN, desc: '推送' })
  }
  return panelMutate(input, ['push'], { net: true, spawn: NET_SPAWN, desc: '推送' })
})

/* cherry-pick, revert and merge share one entry point because they also share
   the way they stop half-done: continue, skip or abort has to be reachable or a
   conflicted panel would trap the user with no way back. */
const SEQUENCER_OPS = ['cherry-pick', 'revert', 'merge']

onRpc('git/sequence', function (input) {
  const op = input != null && isStr(input.op) ? input.op : ''
  const action = input != null && isStr(input.action) ? input.action : ''
  const target = input != null && isStr(input.target) ? input.target.trim() : ''
  if (SEQUENCER_OPS.indexOf(op) < 0) return { ok: false, error: 'unknown operation ' + op }
  /* 拣选 / 还原 / 合并三件事共用一个入口，命令页里也共用一个名字 —— 读者在那一页
     认操作，不认 argv 的拼写。 */
  const said = '拣选·还原·合并'

  if (op === 'merge') {
    if (action === 'start') {
      if (target.length === 0) return { ok: false, error: 'a branch or commit is required to merge' }
      return commitMutation(input, ['merge', '--no-edit', target], { desc: said })
    }
    if (action === 'continue') return commitMutation(input, ['commit', '--no-edit'], { desc: said })
    if (action === 'abort') return panelMutate(input, ['merge', '--abort'], { desc: said })
    return { ok: false, error: 'merge supports start, continue and abort' }
  }

  if (action === 'start') {
    if (target.length === 0) return { ok: false, error: 'a commit is required' }
    if (op === 'revert') return commitMutation(input, ['revert', '--no-edit', target], { desc: said })
    if (input != null && input.record === true) return commitMutation(input, ['cherry-pick', '-x', target], { desc: said })
    return commitMutation(input, ['cherry-pick', target], { desc: said })
  }
  if (action === 'continue') return commitMutation(input, ['-c', 'core.editor=true', op, '--continue'], { desc: said })
  if (action === 'abort') return panelMutate(input, [op, '--abort'], { desc: said })
  if (action === 'skip') return panelMutate(input, [op, '--skip'], { desc: said })
  return { ok: false, error: op + ' does not support ' + action }
})

onRpc('git/branch-create', function (input) {
  const name = input != null && isStr(input.name) ? input.name.trim() : ''
  if (name.length === 0) return { ok: false, error: 'a branch name is required' }
  const at = input != null && isStr(input.at) ? input.at.trim() : ''
  if (at.length > 0) return panelMutate(input, ['switch', '-c', name, at], { desc: '新建分支' })
  return panelMutate(input, ['switch', '-c', name], { desc: '新建分支' })
})

onRpc('git/branch-delete', function (input) {
  const name = input != null && isStr(input.name) ? input.name.trim() : ''
  if (name.length === 0) return { ok: false, error: 'a branch name is required' }
  const force = input != null && input.force === true
  return panelMutate(input, ['branch', force ? '-D' : '-d', name], { desc: '删除分支' })
})

onRpc('git/tag', function (input) {
  const name = input != null && isStr(input.name) ? input.name.trim() : ''
  if (name.length === 0) return { ok: false, error: 'a tag name is required' }
  const at = input != null && isStr(input.at) ? input.at.trim() : ''
  if (at.length > 0) return panelMutate(input, ['tag', name, at], { desc: '打标签' })
  return panelMutate(input, ['tag', name], { desc: '打标签' })
})

/* 压缩、删除与快捷命令（78-actions.js）：压缩是多步改写（身份预检 → 防呆 → 干净
   检查 → soft reset → commit，失败兜底回滚）；删除是它的 hard 款（防呆 → 干净检查
   → hard reset，成功答复带删除前 HEAD 供找回）；快捷命令把读者自定义的命令行原样
   交给会话沙箱里的 shell。 */
onRpc('git/squash', function (input) { return squashRun(input, '压缩提交') })

onRpc('git/drop', function (input) { return dropRun(input, '删除提交') })

onRpc('git/quick', function (input) { return quickRun(input, '快捷命令') })

  },
}
