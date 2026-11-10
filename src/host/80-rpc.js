/* Every request the Client can make, in one table. Each handler is registered
   through `ctx.effect` so it belongs to this fiber: stopping or updating the
   Package removes all of them, which is what makes the bridge's reload safe.

   Each one waits for the plugin config before the handler runs, because the
   config decides which binary every command in this plugin starts with
   (`gitExe` — see 72-gitbin.js) and command lines are built synchronously inside
   the handlers. One cached read for the life of the process: the first request
   pays for it, and a "which git" answer can never be half-applied. */
/* ── 宿主读耗时观测日志（~/.dsh/logs/dsh-git-idea-host.log）──
 *
 * 「慢」的定位以前只能靠猜：整树 4–6s、命令页全扫 4s+、路径读 1.5s——到底是哪条
 * 命令哪个仓库慢，没有账可翻。这里给每一个 RPC 调用记一行：时刻、方法名、仓库
 * （payload.repo 或解析到的会话 cwd，拿不到记 -）、paths 条数（有则记）、耗时
 * ms、ok / 错误摘要。落盘复用 client-log（src/pkg/host-pre.js）的轮转思路：
 * 5MB 一转、.1 覆盖旧的；但 host 片段碰不到 fs，追加走 invoke（77-cmdrec.js 的
 * cmdrecAppendLines 同一条路）。
 *
 * 防刷屏规则（写死在这里，改规则改这里）：`git/watch` 成功且耗时 < 200ms 的跳过，
 * 其余全记。watcher 是这条通道上最高频的调用（每仓库每 3 秒一条），而它成功时
 * 几乎永远在几十 ms 内 —— 全记的话日志里九成是它的成功行，把真正慢的那几条淹没。
 * 它失败（拒绝、超时、shell 层报错）或变慢（≥200ms，9p 盘上整树时就有这么大）时
 * 恰恰是最值得看的信号，一条不落。
 *
 * 追加必须异步且失败安静：日志挂在每一次读的路上，写不动（盘满、目录没了）时
 * 只能记一条 console.error，绝不能让读本身跟着失败 —— 这是对「禁止空 catch 裸吞」
 * 的例外，理由就是这句：观测不许反过来伤害被观测的东西。 */
const RPCLOG_BASENAME = '/logs/dsh-git-idea-host.log'
const RPCLOG_MAX_BYTES = 5 * 1024 * 1024
const RPCLOG_FLUSH_MS = 2000
const RPCLOG_QUEUE_MAX = 1000
const RPCLOG_WATCH_SKIP_MS = 200
const rpclogQueue = []
let rpclogTimer = null
let rpclogDirTried = false
let rpclogDropped = 0

function rpclogField(value, cap) {
  const raw = typeof value === 'string' ? value : String(value)
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return cleaned.length > cap ? cleaned.slice(0, cap) + '…' : cleaned
}

function rpclogNote(name, input, elapsedMs, error, value) {
  /* 防刷屏：git/watch 成功且 <200ms 跳过，其余全记（理由见上面那块注释）。 */
  if (name === 'git/watch' && error == null && elapsedMs < RPCLOG_WATCH_SKIP_MS) return
  const repoRaw = repoFrom(input)
  const repo = isStr(repoRaw) && repoRaw.length > 0 ? rpclogField(repoRaw, 300) : '-'
  const paths = input != null && Array.isArray(input.paths) ? String(input.paths.length) : '-'
  /* 三种结局分开记：err = promise 拒了（transport 层的失败）；no = 答复自身带
     ok:false（git 拒绝、不是仓库……领域层的「办不成」——查「为什么这条失败」
     大半查的是它）；ok = 干净答复。摘要都是一行以内。 */
  let outcome = 'ok'
  if (error != null) outcome = 'err ' + rpclogField(error.message !== undefined ? error.message : error, 200)
  else if (value != null && typeof value === 'object' && value.ok === false) {
    outcome = 'no ' + rpclogField(value.error !== undefined ? value.error : value.stderr, 200)
  }
  const line = new Date().toISOString() + '\t' + name + '\t' + repo + '\tpaths=' + paths
    + '\t' + String(elapsedMs) + 'ms\t' + outcome + '\n'
  rpclogQueue.push(line)
  while (rpclogQueue.length > RPCLOG_QUEUE_MAX) {
    rpclogQueue.shift()
    rpclogDropped += 1
  }
  if (rpclogTimer !== null) return
  rpclogTimer = setTimeout(function () { rpclogTimer = null; rpclogFlush() }, RPCLOG_FLUSH_MS)
  if (typeof rpclogTimer.unref === 'function') rpclogTimer.unref()
}

/* 攒批冲刷：2 秒的行一次追加完（一条 printf、一次进程）。cmdlogHome() 顺带给出
 * DSH_HOME —— 日志跟 client-log / 面板命令记录住同一个家（$DSH_HOME/logs/）。
 * 轮转检查每次冲刷都带上：`stat -c %s` 只问元数据不读内容（client-log 的 fsp.stat
 * 同一个思路，9p 上也就一两 ms），比「攒 256KB 才查一次」的记账法可靠 —— 外部把
 * 文件写大（别的工具、手工）也逃不掉。 */
function rpclogFlush() {
  if (rpclogQueue.length === 0) return
  const lines = rpclogQueue.splice(0, rpclogQueue.length)
  const dropped = rpclogDropped
  rpclogDropped = 0
  cmdlogHome().then(function (home) {
    if (home === null) return
    const file = home + RPCLOG_BASENAME
    const first = rpclogDirTried !== true
    rpclogDirTried = true
    const text = lines.join('') + (dropped > 0 ? '…\t队列溢出，丢了 ' + String(dropped) + ' 行\n' : '')
    return invoke(
      (first === true ? 'mkdir -p ' + shq(home + '/logs') + ' && ' : '')
        + 's=$(stat -c %s ' + shq(file) + ' 2>/dev/null || echo 0); if [ "$s" -gt ' + String(RPCLOG_MAX_BYTES) + ' ]; then mv ' + shq(file) + ' ' + shq(file + '.1') + '; fi; '
        + 'printf %s ' + shq(text) + ' >> ' + shq(file) + '\n',
      {}, null, { timeoutMs: 10000 }).then(function (wrote) {
        if (wrote.exitCode !== 0) {
          console.error('dsh-git-idea: 宿主读耗时日志写不进 ' + file + '（读本身不受影响）', wrote.stderr.slice(0, 200))
        }
      })
  }).catch(function (error) {
    console.error('dsh-git-idea: 宿主读耗时日志冲刷失败（读本身不受影响）', String(error))
  })
}

function onRpc(name, handler) {
  ctx.effect(function () {
    return harness.handle(name, function (input) {
      const startedAt = Date.now()
      const note = function (resolved, error, value) {
        try {
          rpclogNote(name, resolved, Date.now() - startedAt, error, value)
        } catch (error2) {
          /* 记日志的代码自己出伤不能再往读上翻 —— 说一声就放下。 */
          console.error('dsh-git-idea: rpclog 内部出错', String(error2))
        }
      }
      return readConfigFile()
        .then(function () { return withSessionRepo(input) })
        .then(function (resolved) {
          /* 有的处理函数给的就是个对象（git/flush 的 {ok:true}），不是 promise ——
             Promise.resolve 把两种形状拉平，计时与记账对两种都成立。 */
          return Promise.resolve(handler(resolved)).then(
            function (value) { note(resolved, null, value); return value },
            function (error) { note(resolved, error); throw error })
        }, function (error) {
          /* config 读、会话 cwd 解析这两步失败也算这次调用的耗时与错误 —— 观测
             不只看好天气里的读。repo 此刻解析不到，rpclogNote 自己会记成 -。 */
          note(null, error)
          throw error
        })
    })
  }, 'dsh-git-idea rpc ' + name)
}

onRpc('git/panel', function (input) { return panelSnapshot(input) })

onRpc('git/init', function (input) { return initSnapshot(input, '初始化仓库') })

/* The client's refresh button must be able to force a re-read; without this it
   would only repaint whatever the read cache already held. `tags` narrows the
   invalidation to those exact cache entries — the panel's reopen-time identity
   re-verification drops only panel-ident and branches (see 80-panel.js), so
   reopening stays cheap while the ↑ count it shows can no longer be a stale
   cache answer. */
onRpc('git/flush', function (input) {
  invalidateRepo(repoFrom(input, null), input != null && Array.isArray(input.tags) ? input.tags : null)
  return { ok: true }
})

onRpc('git/config', function () {
  return configPath().then(function (path) {
    return readConfigFile().then(function (config) {
      /* ghToken 哨兵化（71-gh-http.js 的 ghConfigForClient）：浏览器只见
         {saved:true, tail}，真值一个字符都不出宿主。 */
      return { ok: true, path: path, config: ghConfigForClient(config) }
    })
  })
})

onRpc('git/config-save', function (input) {
  /* 带上会话：这份文件在任何工作区之外，写它的策略来自这个会合（`sandboxFor`）。
     没有会话时拿到的是部署默认那份（workspace-write），写到 ~/.dsh 会被拒 —— 而现在
     被拒会在答复里说出来，不再是一个安静的 no-op。客户端传回的 ghToken 哨兵在
     writeConfigFile 里换回真值（71-gh-http.js 的 ghMergeSentinelToken）；答复里的
     config 同样哨兵化 —— adoptPluginConfig 拿它更新内存里的整份配置，真值不能
     跟着答复漏出去。 */
  return writeConfigFile(input != null ? input.config : null, argsAt(input, null)).then(function (result) {
    if (result != null && result.ok === true && result.config != null) {
      return Object.assign({}, result, { config: ghConfigForClient(result.config) })
    }
    return result
  })
})

/* 提交信息草稿（70-config.js 的 drafts）：按生效仓库的根路径一仓一份，读改写都
   在 Host —— 客户端只递「哪个仓库、这条信息」，不拿整份配置来回倒（config-save
   是整份换掉的写法，防抖的草稿保存每次整体写回，会把读与写之间落进的别的键抹掉，
   理由全在 70-config.js 那一段）。保存失败不是任何主流程的失败 —— 客户端只把它
   送进控制台。 */
onRpc('git/draft-read', function (input) { return draftRead(input) })

onRpc('git/draft-save', function (input) { return draftSave(input) })

/* The two machine-level questions the settings page asks: which git, and who
   commits. Both are reads of the world outside the repository and neither is
   cached — the reader opening this page is asking "now", not "a moment ago". */
onRpc('git/toolchain', function () { return toolchainSnapshot() })

/* ssh:// 远程工作区的通道快照（11-remote.js）：这个工作区的主机、三态方言结论
   （测得 posix / 测得 cmd / 没测出来按 posix 兜底）、Git Bash 通道的解析结果与
   永久记录（remoteTransports，首次判定后按工作区落进配置）的状态。配置页的
   「远程主机」组拿它说话；refresh 让「再检查一次」作废进程内缓存重新审 ——
   cmd 记录复审 bash、没记录的重新测量，记录本身不动。本地会话答 remote:false
   —— 这条只在远程会话里有答案，本地永远是 POSIX 的老路。 */
onRpc('git/remote-transport', function (input) {
  const workdir = sessionWorkdir(input)
  const parts = remotePartsOf(workdir)
  if (parts === undefined) {
    return Promise.resolve({ ok: true, remote: false, workdir: '', alias: '', dialect: '', measured: false, origin: '', recordedAt: 0, bash: '', source: '', reason: '', detail: '' })
  }
  const args = argsAt(input, null)
  return remoteTransportSnapshot(workdir, input != null && input.refresh === true, args).then(function (snap) {
    return Object.assign({ ok: true }, snap)
  })
})

/* 清除这个工作区的判定记录（配置页「远程主机」组的按钮，host 11-remote.js 的
   clearRemoteTransport）：配置里的条目删掉、进程内缓存作废，下一读重新首次
   判定。设置类动作，不进「命令」页（identity-save 同一个先例）。 */
onRpc('git/remote-transport-clear', function (input) {
  const workdir = sessionWorkdir(input)
  const parts = remotePartsOf(workdir)
  if (parts === undefined) {
    return Promise.resolve({ ok: false, error: 'not-remote', workspace: isStr(workdir) ? workdir : '' })
  }
  return clearRemoteTransport(workdir, argsAt(input, null))
})

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

/* 全局档的换行符（74-identity.js）：与项目档并排的两条，读写都只碰 ~/.gitconfig 那份
    —— 全局档的换行符只写 --global，与目录无关、不需要仓库，写它的沙箱策略来自会话
    （git/identity-save 的 global 分支同一个先例）。 */
onRpc('git/global-config', function (input) { return globalConfigSnapshot(input) })

onRpc('git/global-config-save', function (input) { return globalConfigSave(input) })

/* 远端（74-identity.js）：读一条 `git remote -v`；写是 add / set-url / remove 三条
    子命令，走 panelMutate 进「命令」页 —— 远端表是 fetch / pull / push 都吃的仓库
    自家数据，与 stage / pull 同一条变更路（project-config-save「设置类动作不进命令
    页」是另一性质）。成功答复带重新读出的远端表（读回来而不是回显输入）。 */
onRpc('git/remotes', function (input) { return remotesSnapshot(input) })

onRpc('git/remotes-save', function (input) { return remotesSave(input) })

/* GitHub Actions（71-gh-http.js）：runs 的一次读取（owner/repo 按「ghRepos 覆盖 →
   origin 解析」定，带不带 token 都照发，错误已归类）与设备码两条 github.com 端点的
   单次转发。三条都是设置/读类的动作，不进「命令」页（identity-save 同一个先例）；
   轮询节奏由浏览器的用户操作驱动，宿主没有定时器也没有后台循环。 */
onRpc('git/gh-actions', function (input) { return ghActionsSnapshot(input) })

onRpc('git/gh-device-start', function (input) { return ghDeviceStart(input) })

onRpc('git/gh-device-poll', function (input) { return ghDevicePoll(input) })

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

/* 工作树清单（65-worktree.js，纯只读）：历史页左栏「工作树」块的数据。读缓存按
    仓库一格（tag 'worktrees'），失效随整仓走 —— 与 refs 同寿命，不单独失效；
    客户端永远按生效仓库来问（80-panel.js 里跟着 appliedRepo + freshAt 的 effect）。 */
onRpc('git/worktrees', function (input) { return worktreesSnapshot(input) })

/* worktree 的主目录（65-worktree.js 下半）：git/wt-main 是「这个目录是什么身份、
    它的主仓库在哪」的一次性读（读缓存 tag 'wt-main'，随整仓失效）；答复另带映射
    三件套 —— mappedRule（命中的映射规则）、mainVia（config 来源下的 'manual' /
    'mapping'）、autoRecorded（映射命中且候选存在时本次已自动写进配置）、以及手动
    答案失效时的 mappingSuggestion。git/wt-main-save 把读者纠正过的主目录写进插件
    配置（70-config.js 的 worktreeMains，来源账 worktreeMainsMeta 同一份写盘维护），
    答复带最新一份 wt-main 读数。主仓库被删/搬走的 worktree 靠这两条认路 —— 说明页
    那块 WorktreeMainSetup 与配置页的「worktree 主目录」组吃的都是它们。 */
onRpc('git/wt-main', function (input) { return wtMainSnapshot(input) })

onRpc('git/wt-main-save', function (input) { return saveWorktreeMain(input) })

/* git 忽略项扫描（65-worktree.js 下半，配置页「仓库」组里那个只读分组的数据）：
    一次吃下客户端 shown 清单的**全部仓库**（请求显式带 repos 绝对路径数组，不由
    宿主重新发现 —— 清单就是仓库组的账），逐仓库枚举全部工作树（主工作区 + 链接
    工作树，跳过 bare）逐棵跑 ls-files。刻意**不进读缓存**、与 git/worktrees 的
    cached 分道：扫描的意义就是「点按钮、看现在」，缓存旧账反而误导（git/repos
    不进缓存的同一条理由）。 */
onRpc('git/ignored-scan', function (input) { return ignoredScanSnapshot(input) })

/* 多仓库（61-repos.js）：扫描不进读缓存 —— 它自己的去重（客户端每个工作区只问一次）
   就是缓存，而手动清单那一半每次都该重新核对「还在不在」。 */
onRpc('git/repos', function (input) { return readWorkspaceRepos(input) })

onRpc('git/repos-save', function (input) { return saveWorkspaceRepo(input) })

/* 生效仓库的后端账（61-repos.js 末尾那两条）：按工作区一区一格存进插件配置 ——
    生效仓库跟的是这个工作区，不是某一次会话。读（git/repo-applied）对记下却已
    不在、或 git 已读不动的仓库（gitlink 断链的 worktree）答 stale 自愈（不套用、
    也不删账，等读者下次单击自然覆写）；写（git/repo-applied-save）同值不落盘 ——
    重申式单击常来同值，一个字节都不该碰配置文件。两条的读改写都在 Host，理由与
    drafts 一致（见 70-config.js）。 */
onRpc('git/repo-applied', function (input) { return appliedRepoSnapshot(input) })

onRpc('git/repo-applied-save', function (input) { return saveAppliedRepo(input) })

/* 面板「命令」页：这个工作区里执行过的所有 git 命令，数据源是 DSH 的会话记录
   而不是仓库（76-cmdlog.js）。和上面两个 repos 读一样按工作区走，不进读缓存 ——
   它要的就是「刚刚又跑了什么」；扫描结果由 76 的账本按会话文件 (mtimeMs,size)
   记账，账热时立即答复、增量刷新走后台，读本身不再每次付全量重扫的钱。 */
onRpc('git/command-log', function (input) { return commandLogSnapshot(input) })

onRpc('git/commit-detail', function (input) { return commitDetailSnapshot(input) })

/* The one read the panel asks for by path rather than by repository: the patch
   behind a row in the changes tree or in a commit's file list. Never cached —
   it is the live text of a file the reader is looking at. */
onRpc('git/diff', function (input) { return readFileDiff(input) })

/* 三方合并界面（客户端 59-merge.js）的两条：conflict 读 :1:/ :2:/ :3: 三个阶段加
   两侧标签（68-detail 那条 diff 的邻居，同样只读、不进缓存、不进命令页）；
   conflict-save 把解决结果写回工作区并 git add 标记已解决 —— 它是变更类动作，
   走 cmdrecGit（69-conflict.js 里的理由与先后顺序都在那儿）。 */
onRpc('git/conflict', function (input) { return conflictSnapshot(input) })

onRpc('git/conflict-save', function (input) { return conflictSave(input) })

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

/* 文件右键菜单的三件（78-actions.js，客户端 61-filemenu.js 的菜单）：从修订中获取
    （checkout <ref> -- 路径）、还原所选更改（show 补丁反向 apply）、删除所选更改
    （clean -fd，只删未跟踪）。与 restore/stash 同一条变更路：命令页、读缓存失效、
    noGit/sandboxDenied 都在各自动作里。 */
onRpc('git/get-from-rev', function (input) { return getFromRevRun(input, '从修订中获取') })

onRpc('git/revert-paths', function (input) { return revertPathsRun(input, '还原所选更改') })

onRpc('git/clean-paths', function (input) { return cleanRun(input, '删除所选更改') })

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
  /* 远程分支行的「用远端覆盖」（本地同名分支已存在、读者选了要远端那份）：name
     还是完整的远端分支名（origin/feat/x），拆开清洗后调两步的 resetLocalToRemote
     —— 先切到本地分支，再把它重置到远端。 */
  if (input != null && input.resetLocal === true) {
    const slash = name.indexOf('/')
    const remote = slash > 0 ? cleanRefHalf(name.slice(0, slash)) : ''
    const branch = slash > 0 ? cleanRefHalf(name.slice(slash + 1)) : ''
    if (remote === null || branch === null || remote.length === 0 || branch.length === 0) {
      return {
        ok: false, error: 'bad-value',
        stderr: '覆盖签出需要一个完整的远端分支名（如 origin/feature）：远端名与远端分支名都不能为空、不能以 - 开头、不能含控制字符',
      }
    }
    return await resetLocalToRemote(input, branch, remote + '/' + branch)
  }
  /* 远程分支行的「签出（检出为本地分支）」：name 是完整的远端分支短名
     （origin/feat/x），第一段是远端名，其余是本地分支名。走 switchBranch 的
     create 形状 → `git switch -c feat/x --track origin/feat/x`，与 git 自己的
     DWIM（--guess 默认开）等价，但两件事被说死了：本地建的是什么名字、跟的是
     哪一条 —— 本地同名分支已存在时 git 的拒绝（a branch named 'feat/x' already
     exists）就是明确的错，原话会一路带到错误条。 */
  if (input != null && input.asNewLocal === true) {
    const slash = name.indexOf('/')
    const remote = slash > 0 ? cleanRefHalf(name.slice(0, slash)) : ''
    const branch = slash > 0 ? cleanRefHalf(name.slice(slash + 1)) : ''
    if (remote === null || branch === null || remote.length === 0 || branch.length === 0) {
      return {
        ok: false, error: 'bad-value',
        stderr: '签出远程分支需要一个完整的远端分支名（如 origin/feature）：远端名与远端分支名都不能为空、不能以 - 开头、不能含控制字符',
      }
    }
    return await switchBranch(input, branch, '签出远程分支', name)
  }
  /* `-` is git's own shorthand for the previous branch; resolve it here so the
     caller never has to know that the switcher's "previous" row and this
     argument are the same idea. */
  let target = name
  if (name === '-') {
    target = await previousBranch(input)
    if (target.length === 0) return { ok: false, error: 'there is no previous branch to switch back to' }
  }
  /* 裸路在动手前先过 resolveCheckoutTarget（见下面那段注释）：目标认得是一条
     远端分支、本地又还没有这个分支时，换成 create 形状把跟踪绑定做实。解析不
     接管收尾 —— 返回 null 就是「按今天的裸 switch 走」，行为一字不变。 */
  const resolved = await resolveCheckoutTarget(input, target)
  if (resolved === null) return await switchBranch(input, target, '切换分支')
  if (resolved.fail === true) return resolved.reply
  return await switchBranch(input, resolved.name, resolved.desc, resolved.create)
})

/* 裸路（resetLocal / asNewLocal 都没带、最终落到 `git switch <target>`）的目标
   解析。需求：checkout 选的是远端分支、而本地还没有这个分支时，自动建本地分支
   并绑定跟踪。今天这条裸路有两个洞：
   · target 是完整的远端引用（origin/feat/x）→ git 直接拒绝（fatal: a branch is
     expected, got remote branch），既没检出也没绑定；
   · target 是只有远端才有的短名（feat/x）→ 靠 git 自己的 --guess DWIM 建分支，
     而 DWIM 受 branch.autoSetupMerge 等配置与版本差异左右（66-refs.js 说过不信
     它），绑不绑得上不作数。
   所以在 host 端显式解析：本地不存在、目标认得出是远端分支时，一律换成
   switchBranch 的 create 形状 —— `git switch -c <本地名> --track <远端全名>`，
   与客户端两条显式路走的是同一句命令，绑定不再靠运气。

   三次探针全是读，直接用 git()，不经 cmdrecGit —— 读不进「命令」页，页里只留
   真正动分支的那一次 switch。探针只在退出码 0（有）/ 1（没有）时给出结论，之外
   （git 缺失、不是仓库、ref 名非法）等于没答上来：不替读者猜，返回 null 落回裸
   switchBranch —— git 的原话就是事实，解析是加餐，不能变成新的门槛。

   「本地同名分支已存在」也不静默切：客户端在远程分支行上有二选一确认层（直切
   本地 / 用远端覆盖），直切保留读者手头未推的提交、覆盖会把它们丢掉，两个决定
   都只有读者本人做得了，host 挑哪个都是越权 —— 把两扇门的名字指给他。 */
async function resolveCheckoutTarget(input, target) {
  const args = argsFor(input)
  const requested = repoFrom(input, null)
  const repo = requested === undefined ? null : requested
  /* 「存在」只认精确匹配：show-ref --verify 比对的是整条 ref，不做模式展开 ——
     for-each-ref 的 refs/heads/<pattern> 会 glob（refs/heads/feat/* 撞上 feat/x
     那类），拿模式判存在会误伤。 */
  const localProbe = await git(args, ['show-ref', '--verify', '--quiet', 'refs/heads/' + target], null, {})
  if (localProbe.exitCode === 0) return { name: target, desc: '切换分支', create: undefined }
  if (localProbe.exitCode !== 1) return null

  /* target 带 '/'：可能是「远端名/分支名」的完整远端引用（origin/feat/x），按
     第一个 '/' 拆（与 asNewLocal 现有写法同一把刀），本地名是去掉第一段后剩下的
     整段（feat/x 这样本就可能含 '/'）。refs/remotes/<target> 同样按精确匹配核对；
     以 /HEAD 结尾的不算 —— origin/HEAD 是 fetch 落下的指针不是分支，-c --track
     绑它会被 git 当场拒掉。 */
  const slash = target.indexOf('/')
  if (slash > 0 && target.slice(target.length - 5) !== '/HEAD') {
    const remoteProbe = await git(args, ['show-ref', '--verify', '--quiet', 'refs/remotes/' + target], null, {})
    if (remoteProbe.exitCode === 0) {
      const local = target.slice(slash + 1)
      const existing = await git(args, ['show-ref', '--verify', '--quiet', 'refs/heads/' + local], null, {})
      if (existing.exitCode === 0) {
        return {
          fail: true,
          reply: {
            ok: false, repo: repo, error: 'local-exists',
            stderr: '本地已有同名分支 ' + local + ' —— 「本地」组里的那一行就是它；要把它重置成远端那份，用「用远端覆盖」。',
          },
        }
      }
      if (existing.exitCode !== 1) return null
      return { name: local, desc: '签出远程分支', create: target }
    }
    if (remoteProbe.exitCode !== 1) return null
  }

  /* 短名（不含 '/'，本地又没有）：到远端里找同名分支。refname 按「段」比 ——
     远端名是 refs/remotes/ 下的第一段，剩下的合起来才是分支名；整串字符串
     includes 会把 feat/x 撞上 feat/xy，refs/remotes/<远端>/HEAD 同样跳过。
     恰好一条才动手（这条的答案才没有歧义）；几条同名就把候选列全让读者挑
     （git 对这种形状的原话是 "'x' is ambiguous"，这里把候选一起说破）；一条
     都没有就落回裸路，git 自己的报错就是事实。 */
  if (slash < 0) {
    const listed = await git(args, ['for-each-ref', '--format=%(refname)', 'refs/remotes'], null, {})
    if (listed.exitCode === 0) {
      const rows = listed.stdout.split('\n')
      const candidates = []
      for (let i = 0; i < rows.length; i += 1) {
        const refname = rows[i]
        if (refname.indexOf('refs/remotes/') !== 0) continue
        const cut = refname.indexOf('/', 'refs/remotes/'.length)
        if (cut < 0) continue
        const branch = refname.slice(cut + 1)
        if (branch === 'HEAD' || branch !== target) continue
        candidates.push(refname.slice('refs/remotes/'.length))
      }
      if (candidates.length === 1) return { name: target, desc: '签出远程分支', create: candidates[0] }
      if (candidates.length > 1) {
        return {
          fail: true,
          reply: {
            ok: false, repo: repo, error: 'ambiguous',
            stderr: '分支 ' + target + ' 在 ' + candidates.length + ' 个远端都有，不猜：用完整的远端分支名再签出（如 ' + candidates[0] + '）。候选：' + candidates.join('、'),
          },
        }
      }
    }
  }
  return null
}

/* 「用远端覆盖」的两步：先 `git switch <local>` 切到本地分支，再
   `git reset --hard <remote>/<branch>` 把它重置到远端。分两步而不是一步，是因为
   reset --hard 只作用于「当前所在」的分支 —— 先 switch 保证被重置的一定是读者点的
   那个本地分支，哪怕他此刻正站在别的分支上。所以第一步失败就不走第二步：分支没切
   过去就硬重置，丢的会是别的分支的提交，这种错一次都不能犯 —— 第一步的答复原样
   带回（switchBranch 的 finish 同一形状），错误条上是 switch 自己的原话。
   两步各自进「命令」页（desc 区分），读者能在记录里看到这次覆盖到底动了什么。
   读者本来就在该本地分支上时 switch 原地成功、reset 照跑 —— 这是有意的：此时他
   要的就是「把手头这份丢掉、改成远端那份」。 */
async function resetLocalToRemote(input, local, upstream) {
  const args = argsFor(input)
  const requested = repoFrom(input, null)
  const moved = await cmdrecGit(input, '签出远程分支', ['switch', local], function () {
    return git(args, ['switch', local], null, {})
  })
  if (moved.exitCode !== 0) {
    return {
      ok: false, repo: moved.cwd, stdout: moved.stdout, stderr: moved.stderr,
      exitCode: moved.exitCode, command: moved.command, sandboxDenied: moved.sandboxDenied === true,
    }
  }
  const done = await cmdrecGit(input, '重置到远端', ['reset', '--hard', upstream], function () {
    return git(args, ['reset', '--hard', upstream], null, {})
  })
  /* switch 与 reset 都改了工作区和分支指向，缓存必须整仓失效 —— 读侧拿到的 refs
     与状态才不会是重置前的旧账（switchBranch 的 finish 同一条规矩）。 */
  invalidateRepo(requested !== undefined ? requested : done.cwd)
  return {
    ok: done.exitCode === 0, repo: done.cwd, stdout: done.stdout, stderr: done.stderr,
    exitCode: done.exitCode, command: done.command, sandboxDenied: done.sandboxDenied === true,
    resetTo: upstream,
  }
}

const NET_SPAWN = { timeoutMs: 180000 }

/* 「绑定上游再拉取」的两个名字各占 ref 的一半（--set-upstream-to=<remote>/<branch>）。
   argv 是数组、不过 shell，切不开命令；要挡的是 git 自己会误读的形状 —— 前导 - 与
   控制字符（cleanIdentValue 同一套规矩，74-identity.js），上限放宽到 ref 名该有的
   长度。空串与非法都算「没给对」。 */
function cleanRefHalf(value) {
  const raw = isStr(value) ? value : ''
  const trimmed = raw.trim().slice(0, 300)
  if (trimmed.length === 0) return ''
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (trimmed.charAt(0) === '-') return null
  return trimmed
}

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
  /* ── 三个变体，同一条命令 ──

     左键 ⇣ 一直是 `fetch --all`（开了 fetchPrune 再加 --prune）。浅克隆仓库还需要
     另外两条 git 自己才有的动作，它们是 ⇣ 右键菜单的两项（客户端只说「要什么」，
     argv 在这里才成形 —— 与 pull 的几个变体同一个规矩）：

       · unshallow（取全量历史）→ `fetch --all --unshallow`：把 .git/shallow 里那些
         边界补齐，本地从此有全部历史。实测（--depth=1 克隆的仓库）一条命令就从
         rev-list --count 2 涨到 277，并清空 shallow 文件。
       · depth === N（浅取近 N 条）→ `fetch --all --depth=N`：把深度改写成 N。
       · 都没有（默认）→ 原样，一个字不改。

     --unshallow 与 --depth 互斥（git 自己会拒绝），两个都给时以 unshallow 为准：
     读者点的是「取全量」，那才是意图。depth 只认正整数，其余一律拒绝 —— 不把
     一个来路不明的数喂进 argv（这里是数组，切不开命令，但 git 会把 --depth=0 当
     合法值并做出读者没要的事）。 */
  const prune = config.fetchPrune === true
  const unshallow = input != null && input.unshallow === true
  if (unshallow) {
    return panelMutate(input, prune ? ['fetch', '--all', '--unshallow', '--prune'] : ['fetch', '--all', '--unshallow'],
      { net: true, spawn: NET_SPAWN, desc: '取全量历史' })
  }
  if (input != null && input.depth !== undefined && input.depth !== null) {
    const depth = typeof input.depth === 'number' ? input.depth : NaN
    if (!isFinite(depth) || depth < 1 || Math.floor(depth) !== depth || depth > 1000000) {
      return { ok: false, error: 'bad-value', repo: repoFrom(input, null), stdout: '', stderr: '浅取的深度要是一个正整数（1..1000000）', exitCode: null }
    }
    const argv = prune ? ['fetch', '--all', '--depth=' + String(depth), '--prune'] : ['fetch', '--all', '--depth=' + String(depth)]
    return panelMutate(input, argv, { net: true, spawn: NET_SPAWN, desc: '浅取近 ' + String(depth) + ' 条' })
  }
  return panelMutate(input, config.fetchPrune === true ? ['fetch', '--all', '--prune'] : ['fetch', '--all'], { net: true, spawn: NET_SPAWN, desc: '取回' })
})

onRpc('git/pull', async function (input) {
  const config = await netConfig()
  /* 「rebase 更新」的语义（顶部 ↷、分支行右键「变基」的当前分支那条）：更新即变基
     —— input.rebase === true 时无条件 ['pull','--rebase']，把 pullRebase 配置盖过去
     （配置只回答「普通 ↓ 默认哪种形状」，不该能反过来压住按钮明说的要求）。
     setUpstream 的绑定流程与这个开关无关 —— 先绑后拉的顺序照旧。 */
  const argv = (input != null && input.rebase === true) || config.pullRebase === true ? ['pull', '--rebase'] : ['pull']
  /* 分支行右键「拉取」落在别的分支上（input.branch 给了、又不等于当前分支）：
     普通 pull 只作用于当前分支，HEAD 不许动 —— 「把那个分支拉一下」要的是把它
     快进(fast-forward)到它的上游，形状是 `git fetch <远端> <远端分支>:<分支>`：
     不带 + 前缀，非快进的更新 git 自己就拒绝，快进语义不用这里再造。上游先问
     <分支>@{u}：没有上游直说（绑一个的出路写在话里），不猜要跟谁。上游没有斜杠
     = 它不是「远端/分支」形状，是本地分支当上游 —— 从「.」（本仓库自己）fetch
     同一条 refspec，语义不变。这个 fetch 是网络动作（net 的理由与 git/fetch 同
     一条），desc 跟普通 pull 共用「拉取」—— 命令页里读者认动作，不认 argv。
     detached 时 HEAD 答不上来、current 是空串，同样走这条 —— 反正也不是「站在
     某个分支上拉它自己的上游」。 */
  const branch = input != null && isStr(input.branch) && input.branch.trim().length > 0 ? input.branch.trim() : ''
  if (branch.length > 0) {
    const asked = cleanRefHalf(branch)
    if (asked === null || asked.length === 0) {
      return { ok: false, error: 'bad-value', stderr: '拉取需要一个合法的分支名：不能为空、不能以 - 开头、不能含控制字符' }
    }
    const args = argsFor(input)
    const head = await git(args, ['symbolic-ref', '--quiet', '--short', 'HEAD'], null, {})
    const current = head.exitCode === 0 ? head.stdout.trim() : ''
    if (current !== asked) {
      const upstream = await git(args, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', asked + '@{u}'], null, {})
      if (upstream.exitCode !== 0) {
        return {
          ok: false, error: 'no-upstream', repo: upstream.cwd,
          stderr: '「' + asked + '」还没有上游 —— 拉取不知道要跟谁比。先用分支行右键「修改跟踪分支…」绑一个。',
        }
      }
      const up = upstream.stdout.trim()
      /* 远端分支名可能含斜杠（origin/feat/x）：远端名是第一段，剩下的整段是远端
         分支名 —— 与 checkout 的 asNewLocal 拆 origin/feat/x 是同一把刀。 */
      const slash = up.indexOf('/')
      return panelMutate(input, slash > 0
        ? ['fetch', up.slice(0, slash), up.slice(slash + 1) + ':' + asked]
        : ['fetch', '.', up + ':' + asked], { net: true, spawn: NET_SPAWN, desc: '拉取' })
    }
  }
  const setup = input != null && input.setUpstream != null && typeof input.setUpstream === 'object' && !Array.isArray(input.setUpstream) ? input.setUpstream : null
  if (setup == null) {
    /* A pull that merges writes a commit, so the identity can be what failed. */
    return commitMutation(input, argv, { net: true, spawn: NET_SPAWN, desc: '拉取' })
  }
  /* 客户端在点 pull 时发现这个分支还没有 upstream，替读者挑好了要跟的远端分支：
     先把当前分支的上游绑到 <remote>/<branch>（不给尾参 —— git 默认作用于当前分支，
     detached 时它自己会拒绝），成功后再跑原来的 pull。绑定失败 pull 不跑 —— 远端
     分支其实不存在（refs 数据过期）就是这一类，客户端拿答复里的原话回落到选择层；
     绑定成功而 pull 失败（冲突等）时 upstream 留着，那一步已经完成了。两步各自进
     「命令」页（desc 区分「绑定上游」与「拉取」），答复带 upstreamSet / pulled 与
     每步自己的 exitCode / stderr。 */
  const remote = cleanRefHalf(setup.remote)
  /* 叫 upBranch 而不是 branch：函数前半已经用 branch 这个名字装「右键拉取的目标
     分支」了（同一个函数体，两个 const branch 撞名）—— 这里绑的是上游的远端分支
     名，名字跟着语义走。 */
  const upBranch = cleanRefHalf(setup.branch)
  if (remote === null || upBranch === null || remote.length === 0 || upBranch.length === 0) {
    return { ok: false, error: 'bad-value', upstreamSet: false, pulled: false, stderr: '绑定上游需要合法的远端名与远端分支名：不能为空、不能以 - 开头、不能含控制字符' }
  }
  const bound = await panelMutate(input, ['branch', '--set-upstream-to=' + remote + '/' + upBranch], { desc: '绑定上游' })
  const upstream = { remote: remote, branch: upBranch, exitCode: bound.exitCode, stderr: bound.stderr }
  if (bound.ok !== true) {
    return Object.assign(bound, { error: 'set-upstream-failed', upstreamSet: false, pulled: false, setUpstream: upstream })
  }
  const pulled = await commitMutation(input, argv, { net: true, spawn: NET_SPAWN, desc: '拉取' })
  return Object.assign(pulled, { upstreamSet: true, pulled: true, setUpstream: upstream })
})

/* 推送前的预览（66-refs.js 的 pushPreviewSnapshot）：两段式推送第一段要的「将推
    哪些提交」清单。只读、进读缓存（寿命与 refs 同一条，理由在那边）；不带 desc
    —— 读不进「命令」页，与 stage 那条注释说的是同一句。 */
onRpc('git/push-preview', function (input) { return pushPreviewSnapshot(input) })

onRpc('git/push', async function (input) {
  /* force === true → --force-with-lease 插在 argv 头部（普通 / refspec / -u 三条
     路都认）。选 --force-with-lease 而不是裸 --force：它带着「我出发时看到的远端
     现状」去推，远端在这之后又被人推过（别人的新提交上来了）就当场拒绝 —— 强推
     会覆盖远端历史，覆盖必须是一次知情的决定；租约让这次决定撞上新事实时停下来
     重看一眼，比裸 --force 一把梭诚实。 */
  const forced = input != null && input.force === true
  const argv = forced ? ['push', '--force-with-lease'] : ['push']
  if (input != null && input.setUpstream === true) {
    const remote = input != null && isStr(input.remote) && input.remote.trim().length > 0 ? input.remote.trim() : ''
    const branch = input != null && isStr(input.branch) ? input.branch.trim() : ''
    if (remote.length === 0) return { ok: false, error: 'no remote is configured to push to' }
    if (branch.length === 0) return { ok: false, error: 'a branch is required to set an upstream' }
    /* 推送前先问一句「本地真有这个分支吗」：show-ref --verify 精确比对整条 ref，
       与 resolveCheckoutTarget 的 localProbe 同一把刀（不 glob、不替读者猜）。
       2026-10-15 的事故：dsh 工作区本身是个没有远端的 git 仓库、项目仓库嵌在它
       里面一层，插件对着一个本地不存在的分支跑了 `git push -u origin <分支>`，
       git 报 `error: src refspec ... does not match any` —— 这句天书翻译过来就是
       「本地没有这个分支」，但读者得先懂 refspec 才看得懂；而且无远端的仓库里
       它也先报这一条，把「分支不存在」引向「远端有问题」的错误方向。探针答得出
       来的失败就该在动手前用人数的话说出来：只认退出码 1（show-ref 对「没有这个
       ref」的既定答案）；其余退出码（git 缺失、不是仓库、ref 名非法）不替读者下
       结论，落回原样推 —— git 的原话就是事实，预检是加餐，不能变成新的门槛。
       不带 setUpstream 的普通推送不预检：它推的是当前分支，HEAD 站在哪、有没有
       上游，git 自己的原话说得一样清。 */
    const probe = await git(argsFor(input), ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch], null, {})
    if (probe.exitCode === 1) {
      return {
        ok: false, error: 'branch-missing', repo: probe.cwd,
        stderr: '本地没有分支 ' + branch + ' —— 它可能已被删除、或只在远端存在，也可能当前打开的不是项目所在仓库。请在分支列表右键它选「签出」建本地分支后再推。',
      }
    }
    return panelMutate(input, forced ? ['push', '--force-with-lease', '-u', remote, branch] : ['push', '-u', remote, branch], { net: true, spawn: NET_SPAWN, desc: '推送' })
  }
  /* refspec 推送（分支行右键「直接推送 / 强制推送」）：setUpstream 不是 true、但
     remote 与 branch 都给了 → `git push <remote> <branch>` —— 推哪个分支、推给谁
     都说死了，不碰上游绑定（-u 是「显示待推送列表」那条确认路的专属，直接推不顺
     手改别人的跟踪关系）。两个名字各过一遍 cleanRefHalf（-u 路同一把刀）：非法给
     bad-value 的人话，不甩 refspec 天书。只给了 remote / branch 中的一个也进这里
     挡下来 —— 剩下那个被悄悄丢掉、请求退化成「推当前分支」比拒绝更骗人。本地没有
     这个分支的预检沿用 -u 路那条 show-ref：refspec 的第一参数就是分支名，缺了它
     git 报的还是 `src refspec ... does not match any` 那句天书 —— 2026-10-15 的
     事故同一课，探针答得出来的失败先用人话说。 */
  if (input != null && (input.remote != null || input.branch != null)) {
    const remote = isStr(input.remote) ? cleanRefHalf(input.remote) : ''
    const branch = isStr(input.branch) ? cleanRefHalf(input.branch) : ''
    if (remote === null || branch === null || remote.length === 0 || branch.length === 0) {
      return { ok: false, error: 'bad-value', stderr: '按远端推送需要合法的远端名与分支名：两者都要给、不能为空、不能以 - 开头、不能含控制字符' }
    }
    const probe = await git(argsFor(input), ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch], null, {})
    if (probe.exitCode === 1) {
      return {
        ok: false, error: 'branch-missing', repo: probe.cwd,
        stderr: '本地没有分支 ' + branch + ' —— 它可能已被删除、或只在远端存在，也可能当前打开的不是项目所在仓库。请在分支列表右键它选「签出」建本地分支后再推。',
      }
    }
    return panelMutate(input, argv.concat([remote, branch]), { net: true, spawn: NET_SPAWN, desc: '推送' })
  }
  return panelMutate(input, argv, { net: true, spawn: NET_SPAWN, desc: '推送' })
})

/* cherry-pick, revert, merge and rebase share one entry point because they also
   share the way they stop half-done: continue, skip or abort has to be reachable
   or a conflicted panel would trap the user with no way back. */
const SEQUENCER_OPS = ['cherry-pick', 'revert', 'merge', 'rebase']

/* 右键菜单「作用于整个选区」（PhpStorm 同款）的目标集：客户端把选区按要应用的
   顺序（最旧→最新）放进 targets 数组，这里逐项清洗。目标不限于 hash —— revert /
   cherry-pick 要认 'HEAD'，merge 的目标本来就是分支名 —— 所以这里只挡 git 会误读
   的形状：trim 后为空、前导 -（argv 是数组、不过 shell，与 cleanRefHalf 同一套
   精神），其余原样放行；去重、封顶 50；旧形状（单 target 字符串）兼容成单元素
   清单。顺序原样保留交给 git：cherry-pick / revert 都按 argv 顺序逐个应用，谁在
   前谁先落。真正只认 hash 的地方（edit-check / commit-messages / reword /
   detail-range）各自仍走 78-actions.js 的 COMMIT_SHA 清洗，不在这里。 */
const SEQUENCE_TARGETS_MAX = 50

function sequenceTargets(input) {
  const raw = input != null && Array.isArray(input.targets)
    ? input.targets
    : [input != null ? input.target : undefined]
  const out = []
  for (let i = 0; i < raw.length && out.length < SEQUENCE_TARGETS_MAX; i += 1) {
    const one = isStr(raw[i]) ? raw[i].trim() : ''
    if (one.length === 0 || one.charAt(0) === '-' || out.indexOf(one) >= 0) continue
    out.push(one)
  }
  return out
}

onRpc('git/sequence', function (input) {
  const op = input != null && isStr(input.op) ? input.op : ''
  const action = input != null && isStr(input.action) ? input.action : ''
  if (SEQUENCER_OPS.indexOf(op) < 0) return { ok: false, error: 'unknown operation ' + op }
  /* 拣选 / 还原 / 合并 / 变基四件事共用一个入口，命令页里也各用各的名字 —— 读者在
     那一页认操作，不认 argv 的拼写；变基单给「变基」二字，与它右键菜单/横幅上的
     按钮用词一致。 */
  const said = op === 'rebase' ? '变基' : '拣选·还原·合并'

  if (op === 'merge') {
    if (action === 'start') {
      const targets = sequenceTargets(input)
      if (targets.length === 0) return { ok: false, error: 'a branch or commit is required to merge' }
      /* noFf（分支行右键「合并到当前分支（--no-ff）」）：能快进也造一个合并提交
         —— 分叉的历史在图上一眼看得出来处，代价是多一条提交，决定权在按钮。 */
      return commitMutation(input, (input != null && input.noFf === true
        ? ['merge', '--no-ff', '--no-edit']
        : ['merge', '--no-edit']).concat(targets), { desc: said })
    }
    if (action === 'continue') return commitMutation(input, ['commit', '--no-edit'], { desc: said })
    if (action === 'abort') return panelMutate(input, ['merge', '--abort'], { desc: said })
    return { ok: false, error: 'merge supports start, continue and abort' }
  }

  /* 变基（分支行右键「变基」落在非当前分支上）：`git rebase <分支>` —— 把当前
     分支的提交摘下来重放到 <分支> 之后。与 merge start 一样会写提交（重放的每一
     条都是新对象），所以走 commitMutation，身份缺失那次失败照样说得清。start 只
     收一个目标：git rebase 本来就吃一个 <upstream>，多目标没有意义，宁可拒绝。
     --continue 之后的提交可能要过编辑器：消息编辑器是 core.editor 那层（与
     cherry-pick / revert 的 continue 同一个压法），todo 编辑器是 sequence.editor
     这层（78-actions.js 的 rebase -i 用它插 exec 行 —— 同一个配置键的两副面孔），
     两层都压成 `true`（true 这个「编辑器」原样退出 0），面板里没有终端给它弹。 */
  if (op === 'rebase') {
    if (action === 'start') {
      const targets = sequenceTargets(input)
      if (targets.length !== 1) {
        return { ok: false, error: 'rebase needs exactly one branch', stderr: '变基恰好需要一个分支：git rebase <分支>，把当前分支的提交重放到它之后' }
      }
      return commitMutation(input, ['rebase', targets[0]], { desc: said })
    }
    if (action === 'continue') return commitMutation(input, ['-c', 'core.editor=true', '-c', 'sequence.editor=true', 'rebase', '--continue'], { desc: said })
    if (action === 'skip') return panelMutate(input, ['rebase', '--skip'], { desc: said })
    if (action === 'abort') return panelMutate(input, ['rebase', '--abort'], { desc: said })
    return { ok: false, error: 'rebase supports start, continue, skip and abort' }
  }

  if (action === 'start') {
    const targets = sequenceTargets(input)
    if (targets.length === 0) return { ok: false, error: 'a commit is required' }
    if (op === 'revert') return commitMutation(input, ['revert', '--no-edit'].concat(targets), { desc: said })
    if (input != null && input.record === true) return commitMutation(input, ['cherry-pick', '-x'].concat(targets), { desc: said })
    return commitMutation(input, ['cherry-pick'].concat(targets), { desc: said })
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

/* worktree 块「快速创建」（客户端 25-worktree.js 的 dsh-git-wt-form）：worktree add
    是 v1.3 起 65-worktree.js 唯一的写路径，入参 {sessionId, repo?, mode, name?, at?,
    path, force?}（mode = new / checkout / detach），校验、argv 组装（旗标全在 path
    前、path 后只跟起点）与成功答复（panelMutate 结果 + 最新 worktreesSnapshot 一次
    带回）都在 addWorktree（65-worktree.js 中段）。走 panelMutate 与 branch-create
    同一条变更路：进「命令」页（desc「新建 worktree」）、整仓读缓存失效、noGit /
    sandboxDenied 旗标。prune / remove / lock / move 仍无 —— 65-worktree.js 头部的
    边界说明是同一句话。 */
onRpc('git/worktree-add', function (input) { return addWorktree(input) })

onRpc('git/branch-delete', function (input) {
  const name = input != null && isStr(input.name) ? input.name.trim() : ''
  if (name.length === 0) return { ok: false, error: 'a branch name is required' }
  const force = input != null && input.force === true
  return panelMutate(input, ['branch', force ? '-D' : '-d', name], { desc: '删除分支' })
})

/* 修改一个本地分支跟踪的远端分支（78-actions.js 的 branchUpstreamRun）：客户端分支
    行右键「修改跟踪分支…」的选择层发的就是这一条。 */
onRpc('git/branch-upstream', function (input) { return branchUpstreamRun(input) })

/* 重命名一个本地分支（78-actions.js 的 branchRenameRun）：客户端分支行右键
    「重命名分支…」的输入框发的就是这一条（{name: 旧名, to: 新名}）。 */
onRpc('git/branch-rename', function (input) { return branchRenameRun(input) })

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

/* 历史页右键的三条（78-actions.js 底下那一段）：edit-check 与 commit-messages 是
    只读的体检与取消息（不进「命令」页，与所有读同一个规矩）；reword 是改写，
    安全链与命令页记录都在 rewordRun 里，desc 是它在「命令」页的名字。 */
onRpc('git/edit-check', function (input) { return editCheckSnapshot(input) })

onRpc('git/commit-messages', function (input) { return commitMessagesSnapshot(input) })

onRpc('git/reword', function (input) { return rewordRun(input, '改写提交消息') })

onRpc('git/quick', function (input) { return quickRun(input, '快捷命令') })

/* 分支会话历史（79c-branchhistory.js）的三条：读（chip 滑块与配置页「分支会话历史」
    组的数据源，prompts/counts 只答本工作区那格）、写工作区开关（reset 回全局默认、
    同值不落盘）、写当前分支的专用提示词（空文本 = 删除该分支条目）。读改写都在
    Host，与 drafts / appliedRepos 同一条理由：config-save 是「整份换掉」的写法，
    客户端只递「这个会话、开还是关、哪条提示词」，谁也抹不掉谁。 */
onRpc('git/branch-history-config', function (input) { return branchHistorySnapshot(input) })

onRpc('git/branch-history-switch', function (input) { return branchHistorySwitchSave(input) })

onRpc('git/branch-prompt-save', function (input) { return branchPromptSave(input) })

/* 分支会话历史的宿主监听（pre-step 登记 + 注入）。守卫写在 effect 里：bridge 版的
    老 ctx façade 没有 on 时安静不启用（79b-file-save.js 的守卫先例）。 */
ctx.effect(function () {
  if (typeof ctx.on !== 'function') return undefined
  registerBranchHistory(ctx)
  return undefined
}, 'dsh-git-idea branch-history register')

  },
}
