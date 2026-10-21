    /* ── 输入框旁边那个 chip ──

       屏幕上那个数字不是这块地方自己量的，它来自全局那一份工作区读数（10-state.js）。
       一次全树读在这台机器上 8–10s，而且占住整条通道（一次只跑一个处理函数）：每次
       醒过来都量一遍，面板那条 0.3s 的路径读就排在它后面 —— 屏幕上就是「面板反应过来了，
       chip 还没反应过来」。所以这里只做三件事：问身份（0.1–0.4s）、把上次那些脏路径
       重新问一次（0.2s，和面板问的是同一个问题，Host 那边只起一个进程），以及在这份
       读数确实该完整重来一遍时发一次全树读（压后 2 秒，让这次点击的反馈先走）。 */

    /* 全树读压后多久：屏幕上先有这一帧的反馈，再让那条 8–10s 的读去占通道。 */
    const COUNT_FULL_DELAY_MS = 2000

    /* ── 会话完成监听 ──

       DSH 的 web 端给 session 作用域的 slot 组件注入了现成的会话状态 hook
       （useSession / useSessionStatus / useSessions，见 dsh-client-ui-session 的
       BUILTIN_SOURCE 与 provideRoot；hook 名转 prop 名的规则是 use+首字母大写）。
       chip 是唯一挂在每个会话输入框旁、面板关着也常驻的面，所以监听点在这里而不是
       面板里。bridge 版／老版本没有这些 props：下面全部 typeof 守卫，没有就静默不
       启用 —— 配置页会在两条开关的 hint 位置说明「当前环境不支持会话状态监听」。

       两个开关都关着时，这段代码照常挂着但一分钱都不花：边沿判定只是读一眼手边
       已经算好的布爾，不开任何轮询（会话状态的推送是 DSH 自己的事）。 */

    /* 完成的判据都是「边沿 + 稳定窗」：goal 自动续轮之间会有一小段 running=false，
       2 秒的防抖把那种间隙吞掉（期间又变回 running 就整轮取消）；「所有会话都停
       了」要稳 5 秒才动身 —— 推送是往远端发读者的工作，宁可晚一分钟也不推一半。 */
    const COMPLETE_DEBOUNCE_MS = 2000
    const ALL_IDLE_STABLE_MS = 5000

    /* 这一页还有几个会话在跑。hook 的真契约（dsh-client-ui-renderer 的
       observableHook → useSyncExternalStoreWithSelector）是「选择器进、选择器的
       返回值出」：hook 不把快照交给调用方，不传选择器当场就是渲染期 TypeError
       （0.2.0-rc.2 实测如此，官方包全是 useSessions((s) => …) 的用法）。选择器
       就地数出 running 的个数、回原始类型 —— 快照换新而计数没变时 React 不重渲染，
       「无关的状态字段翻动不重置稳定窗」由选择器免费拿到。两个来源二选一：
       useSessionStatus 的快照是 Map（每会话一行 {running,...}，含子代理会话），
       useSessions 的快照是列表状态（.ids 的行在 .byId 里，行里也有 running）。 */
    function sessionsRunningCountOf(snapshot) {
      if (snapshot != null && typeof snapshot.forEach === 'function') {
        let running = 0
        snapshot.forEach(function (row) {
          if (row != null && row.running === true) running += 1
        })
        return running
      }
      if (snapshot != null && snapshot.byId != null && typeof snapshot.byId === 'object') {
        let running = 0
        const ids = Array.isArray(snapshot.ids) && snapshot.ids.length > 0 ? snapshot.ids : Object.keys(snapshot.byId)
        for (let i = 0; i < ids.length; i += 1) {
          const row = snapshot.byId[ids[i]]
          if (row != null && row.running === true) running += 1
        }
        return running
      }
      return -1
    }

    /* hook 回什么算什么：真环境选择器生效，回的是数字；个别环境（旧桩、老版本）
       忽略选择器把快照原样带回 —— 那就地再数一遍。数不出形状回 null，null 的意思
       是「不知道」（bridge 版也落到这里），绝不能冒充 0（「都停了」），否则一挂上
       来就会白推一次。 */
    function runningTotalOf(value) {
      if (typeof value === 'number') return isFinite(value) && value >= 0 ? value : null
      if (value == null) return null
      const counted = sessionsRunningCountOf(value)
      return counted >= 0 ? counted : null
    }

    /* 从 git/panel 的答复判定能不能自动推：领先远端、且没有未解决的冲突。冲突推
       上去就是推一半历史；不领先时推了也只是远端的一句 Everything up-to-date ——
       两种都当场放弃，把原因写进「最近一次自动推送」那行状态。 */
    function autoPushDecision(reply) {
      if (reply == null || reply.ok !== true) return { push: false, why: '读不到仓库状态' }
      const ahead = typeof reply.ahead === 'number' && isFinite(reply.ahead) ? reply.ahead : 0
      if (ahead <= 0) return { push: false, why: '没有领先远端的提交，不需要推' }
      const unmerged = Array.isArray(reply.unmerged) ? reply.unmerged.length : 0
      if (unmerged > 0) return { push: false, why: '有 ' + String(unmerged) + ' 个未解决的冲突，不自动推' }
      return { push: true, why: '' }
    }

    /* 这个会话名得出来的仓库清单：工作区扫描 + 手动登记 + 生效仓库 + chip 记下的
       那个。完成刷新逐个 flush 的就是它 —— 会话可能在其中任何一个里动了文件，而
       只有全树读能看见新建的文件。 */
    function completionReposOf(sessionId) {
      const out = []
      const push = function (repo) {
        const one = text(repo)
        if (one.length === 0 || out.indexOf(one) >= 0) return
        out.push(one)
      }
      const list = repoListForSession(sessionId)
      if (list != null) {
        const scanned = Array.isArray(list.repos) ? list.repos : []
        for (let i = 0; i < scanned.length; i += 1) push(scanned[i])
        const manual = Array.isArray(list.manual) ? list.manual : []
        for (let i = 0; i < manual.length; i += 1) push(manual[i])
      }
      push(sessionRepo(sessionId))
      push(chipInfoFor(sessionId).repo)
      return out
    }

    /* 完成的那一刷的本体。独立成模块函数（不闭包在组件里），因为它有两个调用时机
       都在组件之外：页面藏着时的那一刷记成欠账（30-watch.js 的 oweCompleteRefresh），
       回可见时由可见性处理函数补发 —— 那一刻完成它的那棵 chip 可能早就重挂过了。
       本体做的事：对本会话名得出来的每个仓库失效 Host 的读缓存（git/flush 只删缓存
       条目，不起进程），把本地那份读数标成「不再证明完整」，然后铃 + bump —— 面板
       开着就把 needFull 立起来、走 ⟳ 同一条整树路重读并重画；关着则 chip 自己的
       label、分支预取和压后的整树读都在同一次 bump 里走完。刚被会话新建的文件只有
       全树读能看见，这正是它该刷的时机。

       入口的 5 秒重入护栏：同一次完成现在有两条路都会走到这里 —— chip 自己的
       running 边沿（本文件的 completeRefresh）和宿主推来的 session-complete
       （98-register.js 的 liveBus 订阅）。两边各挂着一个 2 秒防抖，起点又差着一次
       轮询间隔，对同一次完成各跑一遍就是两次全树读、两次把通道占满 8–10s。

       护栏的形状是「每会话 5 秒一戳，只有推送路径让路」：chip 边沿与欠账补发
       （30-watch.js 的 settleOwedCompleteRefresh）永远照跑、只盖戳 —— 一次真实的
       完成边沿必须刷一遍，这是既有契约（gp52：两次挨得很近的完成各自都刷、藏着
       的欠账回可见必补）；而推送天生是同一次完成的第二名（chip 在场时它必然晚
       chip 一步到），让路即可。推送自己重复来的那一份（5 秒内第二条
       session-complete）也由这道闸压住。 */
    const COMPLETE_REFRESH_GUARD_MS = 5000
    const completeRefreshGuard = new Map()
    function runCompleteRefresh(sessionId, suppressible) {
      const now = Date.now()
      const last = completeRefreshGuard.get(sessionId)
      const blocked = last !== undefined && now - last < COMPLETE_REFRESH_GUARD_MS
      /* 戳谁都要盖：护栏压的是「推送别再跑一遍」，不是「谁都不许跑」。 */
      completeRefreshGuard.set(sessionId, now)
      /* Map 不许无界长：条目多过一屏会话时把过了护栏期的摘掉。 */
      if (completeRefreshGuard.size > 64) {
        completeRefreshGuard.forEach(function (at, key) {
          if (now - at >= COMPLETE_REFRESH_GUARD_MS) completeRefreshGuard.delete(key)
        })
      }
      if (blocked === true && suppressible === true) return
      const repos = completionReposOf(sessionId)
      /* flush 只是删 Host 的缓存条目；运输层断了的这一次安静放过（30-watch.js 的
         watcherTick 同款）—— 下一读拿旧答案，再下一次读自会跟上。 */
      callHost('git/flush', { sessionId: sessionId }).catch(function () {})
      for (let i = 0; i < repos.length; i += 1) {
        callHost('git/flush', { sessionId: sessionId, repo: repos[i] }).catch(function () {})
        markTreePartial(repos[i])
      }
      ringTreeReload()
      bumpData()
    }

    function GitChip(props) {
      const isOpen = useOpen()
      const switching = useSwitchingTo()
      const [info, setInfo] = React.useState(function () { return chipLabelFor(props.sessionId) })
      const reloadAt = useDataVersion()
      /* 谁写了那份读数都要重画：面板量完一次，chip 上的数字跟着变。 */
      useTreeVersion()
      /* Applying a directory in the panel changes which repository this chip is
         about, and this signal is how the chip hears about it: without the render
         it went on reading — and watching — the workspace it started with. */
      const repoVersion = useRepoApplied()
      const watched = sessionRepo(props.sessionId)
      const sessionId = props.sessionId
      const repo = info.repo.length > 0 ? info.repo : watched
      const record = treeRecord(repo)
      const known = record !== null
      const pending = record === null ? 0 : record.count
      /* 上游读数来自挂载时那次快读（Host 的 readPanelIdentity 本来就带 ahead/behind）：
         ↓/↑ 两组和 tooltip 那句话都用它。答复里没有（老版本、失败路径）就当 0，两组不画。 */
      const ahead = typeof info.ahead === 'number' && isFinite(info.ahead) ? info.ahead : 0
      const behind = typeof info.behind === 'number' && isFinite(info.behind) ? info.behind : 0
      /* 正在核对：这份读数该重新完整量一次，或者那一次正在飞（几秒）。 */
      const due = treeReadDue(repo) === true || treeCountReading(repo) === true

      React.useEffect(function () {
        loadSettings(chipNode != null ? chipNode.ownerDocument : null)
        /* 生效仓库的持久化账也在这里交 doc：chip 每页必挂、又比面板早，页面刷新后
           第一个把 localStorage 里的账读进来的就是它 —— 账非空时它 bump 一次
           applied 信号，上面渲染期读过的 sessionRepo 重算一遍，watcher 跟着指回
           恢复出来的那个仓库（10-state.js 的 loadAppliedRepos）。 */
        loadAppliedRepos(chipNode != null ? chipNode.ownerDocument : null)
        loadPluginConfig()
      }, [])

      /* A new session gets its own remembered label straight away, so the chip
         shows the right workspace's branch while the fresh read is in flight
         instead of the workspace you just left. */
      React.useEffect(function () {
        setInfo(chipLabelFor(sessionId))
      }, [sessionId])

      /* The chip's own listener: with the panel closed it is the only one
         watching this workspace, so the branch label and change count stay
         current off the Host's pushes. */
      React.useEffect(function () {
        if (gitSettings.watchChip !== true) return undefined
        return watchRepo(watched, sessionId, bumpData)
      }, [watched, repoVersion, sessionId, isOpen])

      /* 这个页面在哪个会话里 —— chip 一直挂在输入框旁边，所以它是把这件事记下来的
         那个面（配置页「全局配置」的提交身份组没有自己的会话，读的就是这份记忆）。
         放在 effect 里而不是渲染里：渲染期间通知订阅者就是渲染期间改别人的 state。 */
      React.useEffect(function () { rememberSession(sessionId) }, [sessionId])

      /* 生效仓库的后端账（跨浏览器那份）：chip 每个会话必挂、又比面板早，由它发这一问
         （ensureAppliedRepo 每会话只问一次）。后端记了哪个仓库，就把它接回本页 ——
         新会话、换浏览器、刷新页面都还是读者上次选定的那个，不再回落到工作区默认仓库。 */
      React.useEffect(function () {
        ensureAppliedRepo(sessionId)
      }, [sessionId])

      /* ── 会话状态（有则用之，bridge 版这些 props 不存在）──

         hook props 是 DSH 注入的固定席位，同一个挂载上在不在是定死的，所以按存在
         与否走两条稳定不变的调用序列是安全的。runningNow 只读本会话；runningTotal
         读整页（含子代理会话）。两个 hook 都按真契约传选择器：不传选择器的
         useSessionStatus() 在真 shell 里是渲染期 TypeError，chip 整个挂不上 ——
         这正是 2026-10-09 那次 chip 从 composer 里消失的根因。 */
      const runningNow = typeof props.useSession === 'function'
        ? props.useSession(function (snapshot) { return snapshot != null && snapshot.running === true })
        : false
      const statusTotal = typeof props.useSessionStatus === 'function'
        ? runningTotalOf(props.useSessionStatus(sessionsRunningCountOf))
        : null
      const listTotal = statusTotal == null && typeof props.useSessions === 'function'
        ? runningTotalOf(props.useSessions(sessionsRunningCountOf))
        : null
      const runningTotal = statusTotal != null ? statusTotal : listTotal

      const [runEdge] = React.useState(function () { return { armed: false, was: false, timer: null } })
      const [idleEdge] = React.useState(function () { return { armed: false, was: null, timer: null } })

      /* 完成的那一刷：页面开着就当场跑（本体在模块层的 runCompleteRefresh）；
         页面藏着时过去是直接丢掉，指望「回可见时 watcherTickAll 补读兜底」—— 但那条
         兜底自己会断（第一次 tick 只记基线，30-watch.js），真机上整整一段 agent 干活
         时间的提交就都丢了。所以藏着时把这一刷记成欠账，回可见时补发。 */
      const completeRefresh = function () {
        if (watchPageDoc != null && watchPageDoc.hidden === true) { oweCompleteRefresh(sessionId); return }
        runCompleteRefresh(sessionId)
      }

      /* 「所有会话都停满 5 秒」的那一推。只推「领先远端且没有未解决冲突」的当前
         生效仓库（与顶栏 ↑ 同参：sessionId + repo）；失败只写进「最近一次自动推送」
         那行状态，不重试 —— 自动的事必须有界，重试是读者自己点 ↑ 的事。 */
      const autoPushRun = function () {
        const applied = sessionRepo(sessionId)
        const repo = applied.length > 0 ? applied : chipInfoFor(sessionId).repo
        const request = { sessionId: sessionId }
        if (repo.length > 0) request.repo = repo
        const noted = function (ok, detail) {
          setAutoPush({ time: Date.now(), ok: ok === true, detail: detail })
        }
        callHost('git/panel', request).then(function (reply) {
          const verdict = autoPushDecision(reply)
          if (verdict.push !== true) { noted(false, verdict.why); return }
          const where = reply != null && text(reply.repo).length > 0 ? text(reply.repo) : repo
          const pushRequest = { sessionId: sessionId }
          if (where.length > 0) pushRequest.repo = where
          const tryPush = function (payload, setUpstream) {
            callHost('git/push', payload).then(function (result) {
              if (result != null && result.ok === true) {
                noted(true, '已推送 ' + (where.length > 0 ? where : '当前仓库') + (setUpstream === true ? '，并设了上游' : ''))
                return
              }
              const detail = commandDetail(result)
              /* 「还没有上游」是一次能自己走完的失败：设置里开了自动设上游、refs 又
                 答得出当前分支时，按面板 runOp 的老路补一次 setUpstream:true 的
                 推送；问过这一次就到头。远端不取 refs.remote[0]：ctxPush 的同一条
                 规则（guessPushRemote，origin 优先 → 唯一远端 → 都不满足就不猜）
                 —— 多远端而无 origin 时补推会把上游绑到读者没挑过的远端，原因
                 写进「最近一次自动推送」，不推。 */
              if (setUpstream !== true && pluginConfig.pushSetUpstream === true && detail.indexOf('upstream') >= 0) {
                callHost('git/refs', payload).then(function (refs) {
                  const remote = guessPushRemote(refs)
                  const branch = refs != null && refs.ok === true && Array.isArray(refs.current) && refs.current.length > 0 ? text(refs.current[0]) : ''
                  if (remote.length === 0) {
                    noted(false, '没有自动设上游：仓库有多个远端且没有 origin —— 在面板里用分支行右键「修改跟踪分支…」指定后再推')
                    return
                  }
                  if (branch.length === 0) { noted(false, detail); return }
                  tryPush(Object.assign({}, payload, { setUpstream: true, remote: remote, branch: branch }), true)
                }, function (refsFailure) { noted(false, failureText(refsFailure)) })
                return
              }
              noted(false, detail.length > 0 ? detail : '推送失败')
            }, function (failure) { noted(false, failureText(failure)) })
          }
          tryPush(pushRequest, false)
        }, function (failure) { noted(false, failureText(failure)) })
      }

      /* 本会话 running 的 true→false 边沿（初始挂载读到的不算 —— 不然每次刷新页面
         都会白刷一遍）→ 2 秒防抖 → 刷新。 */
      React.useEffect(function () {
        const previous = runEdge.was
        runEdge.was = runningNow === true
        if (runEdge.armed !== true) { runEdge.armed = true; return undefined }
        if (previous !== true || runningNow === true) return undefined
        runEdge.timer = timerOf().timeout(function () {
          runEdge.timer = null
          /* 开关在开跑那一刻再读模块层那份（随时是新的）：挂起的这两秒里读者把它
             关掉，这一轮就不该再跑。 */
          if (pluginConfig.refreshOnComplete !== true) return
          completeRefresh()
        }, COMPLETE_DEBOUNCE_MS)
        /* running 又变回 true（goal 自动续轮）时 effect 重跑，清理函数拆掉挂起的那轮。 */
        return function () {
          if (runEdge.timer != null) { runEdge.timer(); runEdge.timer = null }
        }
      }, [runningNow])

      /* 「至少一个在跑」→「一个都不在跑」的边沿起 5 秒稳定窗；期间任何会话恢复运行
         就取消。窗口不因无关的状态字段翻动而重置：Map 快照换了新但计数没变时，正在
         计的那轮接着计。 */
      React.useEffect(function () {
        const previous = idleEdge.was
        idleEdge.was = runningTotal
        if (idleEdge.armed !== true) { idleEdge.armed = true; return undefined }
        if (runningTotal === null || runningTotal > 0) {
          if (idleEdge.timer != null) { idleEdge.timer(); idleEdge.timer = null }
          return undefined
        }
        if (previous !== null && previous > 0 && idleEdge.timer == null) {
          idleEdge.timer = timerOf().timeout(function () {
            idleEdge.timer = null
            if (pluginConfig.pushOnAllComplete !== true) return
            autoPushRun()
          }, ALL_IDLE_STABLE_MS)
        }
        return undefined
      }, [runningTotal])

      /* 卸载（换会话时 DSH 会整块重挂）把手里的两个稳定窗都拆掉。 */
      React.useEffect(function () {
        return function () {
          if (runEdge.timer != null) { runEdge.timer(); runEdge.timer = null }
          if (idleEdge.timer != null) { idleEdge.timer(); idleEdge.timer = null }
        }
      }, [])

      React.useEffect(function () {
        let alive = true
        let stopFull = null
        const request = { sessionId: sessionId }
        const mine = watched
        if (mine.length > 0) request.repo = mine
        /* Started before the panel read, so both round trips overlap rather than
           queue: coming back to a workspace you have used should not feel like
           waiting for the branch list twice. */
        prefetchBranches(sessionId, mine)

        const apply = function (data) {
          if (data != null && data.ok === true) {
            const branch = text(data.branch)
            const detached = data.detached === true
            const repo = text(data.repo)
            /* 数字来自全局那一份读数，不是这一次读算出来的：快读（身份）根本不带工作区，
               它的「没有改动」意思是「没问过」。 */
            const pending = treeCount(repo)
            const ahead = typeof data.ahead === 'number' && isFinite(data.ahead) ? data.ahead : 0
            const behind = typeof data.behind === 'number' && isFinite(data.behind) ? data.behind : 0
            /* Kept outside React state because the hover card needs the count and
               hangs in a different subtree; a switch offer should not have to
               re-derive it with another read. */
            chipInfos[sessionId] = { repo: repo, pending: pending, ahead: ahead, behind: behind }
            prefetchBranches(sessionId, repo.length > 0 ? repo : mine)
            chipLabels[sessionId] = {
              phase: 'repo',
              label: detached ? 'HEAD' : (branch.length > 0 ? branch : 'HEAD'),
              pending: pending,
              ahead: ahead,
              behind: behind,
              repo: repo,
              reason: '',
            }
          } else {
            chipInfos[sessionId] = { repo: data != null ? text(data.repo) : '', pending: 0, ahead: 0, behind: 0 }
            chipLabels[sessionId] = {
              phase: 'none', label: null, pending: 0, ahead: 0, behind: 0,
              repo: data != null ? text(data.repo) : '',
              reason: data != null ? text(data.reason) : '',
            }
          }
          setInfo(chipLabels[sessionId])
        }

        /* 数字怎么来：
           1. 这份读数在这个仓库上还没有过 → 整棵树量一次（不量 chip 上就一个数字都没有）；
           2. 有过、而且上次那些脏路径还在 → 只问那些路径（0.2s）。提交之后那几个文件
              就是这样立刻消失的，而且和面板屏幕上那份快照是同一个问题；
           3. 没有脏路径可以问（上一次量出来是干净的），或者这份读数确实该完整重来一遍
              （fullAt 太旧）→ 整棵树量一次；已经有数字时压后 2 秒，让这次点击的反馈先走。

           一次 bump 意味着仓库动过（引用、索引或 HEAD）：干净的那份读数这时不能继续当
           「现在也干净」用 —— 所以第 3 条也在每次 bump 时成立。 */
        const refreshCount = function (repoNow) {
          const current = treeRecord(repoNow)
          const paths = treeReadPaths(repoNow)
          if (current !== null && paths.length > 0) {
            const finished = treeCountReadStart(repoNow)
            const started = Date.now()
            callHost('git/panel', Object.assign({ paths: paths }, request)).then(function (reply) {
              finished()
              /* 这一次路径读有多贵 —— 贵到一定程度就说明父目录扫进了大树，这个仓库从此
                 收窄成只问那几条路径本身（见 pathsOfInterest）。 */
              pathsReadSpent(repoNow, Math.round(Date.now() - started))
              if (alive !== true || reply == null || reply.ok !== true) return
              publishTreeRead(repoNow, mergePanelStatus(current.status, reply), false, null)
            }, function () { finished() })
          }
          const nothingToAsk = current === null || paths.length === 0
          if (treeReadDue(repoNow) !== true && nothingToAsk !== true) return
          const wholeTree = function () {
            const started = Date.now()
            const finished = treeCountReadStart(repoNow)
            callHost('git/panel', request).then(function (full) {
              finished()
              if (alive !== true || full == null || full.ok !== true) return
              publishTreeRead(repoNow, full, true, Date.now() - started)
            }, function () { finished() })
          }
          /* 没有数字可以报（这个仓库还没量过）：现在就得量，8–10s 也认了。上一次量出来
             是干净的、或者按间隔该完整重来一遍：那次全树读压后 2 秒，让这次点击的反馈
             （分支名、面板那条 0.2s 的路径读）先走。 */
          const defer = current !== null && nothingToAsk !== true
          if (defer !== true) { wholeTree(); return }
          stopFull = timerOf().timeout(function () {
            /* 开跑之前再问一遍该不该跑：这 2 秒里面板的全树读可能已经把这份读数补
               完整了（会话完成那一刷就是这么接力的 —— 面板听见铃先读，chip 让路），
               再跑一次就是让最贵的那条路排两遍队。 */
            if (treeReadDue(repoNow) !== true) return
            wholeTree()
          }, COUNT_FULL_DELAY_MS)
        }

        /* The identity read answers in about a fifth of a second on a repository
           where the full one takes eight, and it carries everything the chip shows
           except the change count — so the workspace you switched to is named
           immediately and the badge follows from the shared reading. */
        callHost('git/panel', Object.assign({ quick: true }, request)).then(function (data) {
          if (alive !== true) return
          apply(data)
          const repoNow = data != null && data.ok === true ? text(data.repo) : ''
          if (repoNow.length === 0) return
          prefetchBranches(sessionId, repoNow)
          refreshCount(repoNow)
        }).catch(function () {
          if (alive === true) setInfo({ phase: 'none', label: null, pending: 0, ahead: 0, behind: 0, repo: '', reason: '' })
        })
        return function () { alive = false; if (stopFull !== null) stopFull() }
      }, [watched, repoVersion, isOpen, sessionId, reloadAt])

      const isRepo = info.phase === 'repo'
      const where = info.repo.length > 0 ? info.repo : '当前会话工作区'
      /* 数字来自全局那一份读数，而不是这次快读 —— 快读根本不带工作区。还没量过就说
         「正在核对」，不说「工作区干净」：没量出来和没改动是两件事。读数该完整重来
         一遍时（due）也这么说，因为那一次全树读确实正在排。 */
      const count = known !== true
        ? '正在核对改动…'
        : (pending > 0
          ? String(pending) + ' 个改动' + (due === true ? '（正在核对）' : '')
          : (due === true ? '正在核对改动…' : '工作区干净'))
      let title = 'Git'
      if (info.phase === 'loading') title = 'Git'
      else if (isRepo) title = info.label + ' · ' + info.repo + ' · ' + count
        + (ahead > 0 || behind > 0 ? ' · ' + trackTitle(ahead, behind) : '')
      else if (info.reason === 'missing') title = '目录不存在：' + where + ' —— 点击修改路径'
      else if (info.reason === 'file') title = '这不是一个目录：' + where + ' —— 点击修改路径'
      else if (info.reason === 'git-error') title = where + ' 读取失败 —— 点击查看原因'
      else if (info.reason === 'no-git') title = where + '：这台机器上找不到 git —— 点击查看'
      /* 路径还没定：这一页要人填一个目录，所以这里得说「填」，不能说「这个目录不是
         仓库」—— 那时候连是哪个目录都还不知道。 */
      else if (info.reason === 'no-path') title = '还没确定看哪个目录 —— 点击填写'
      /* 「这个目录不是 Git 仓库」那一页没有路径框（路径不是问题，没什么可填的），
         所以这里也不再承诺「点击选择路径」—— 承诺一个点不到的东西比不承诺更坏。 */
      else if (info.reason === 'not-a-repo') title = where + ' 这个目录不是 Git 仓库 —— 点击查看'
      /* 属主被 git 拒了：能自动修好的根本不会停在这个状态，标题里就别再说成
         「不是仓库」—— 仓库明明就在那里。 */
      else if (info.reason === 'unsafe-owner') title = where + ' 的目录属主不同，git 拒绝读取 —— 点击查看'
      else if (info.reason === '') title = 'Git —— 点击打开面板'
      else title = where + ' 读不动这个目录 —— 点击查看'

      const children = [h(BranchIcon, {
        key: 'icon', size: 14, plus: !isRepo && info.phase === 'none',
        spin: switching !== null,
      })]
      if (isRepo) children.push(h('span', { className: 'dsh-git-chip-label', key: 'label' }, info.label))
      /* 「字符 + 数字」的三小组都收进同一个 wrapper（dsh-git-chip-grp，组内 3px），
         字符不带类、色随 chip 文字。改动数药丸及其变淡态原样照旧，只是前面多了 ●。 */
      if (isRepo && known === true && pending > 0) {
        children.push(h('span', { className: 'dsh-git-chip-grp', key: 'pend' },
          h('span', { key: 'pend-sym' }, '●'),
          h('span', {
            className: 'dsh-git-badge' + (due === true ? ' dsh-git-badge-stale' : ''),
            key: 'badge',
          }, String(pending))))
      }
      /* ↓/↑ 画的是快读带回来的上游读数：落后才画 ↓、领先才画 ↑，0 不占位 —— 没有上游
         或 detached HEAD 时 Host 本来就回 0，自然藏起来。数字 99+ 封顶，同 50-log.js。 */
      if (behind > 0) {
        children.push(h('span', { className: 'dsh-git-chip-grp', key: 'behind' },
          h('span', { key: 'behind-sym' }, '↓'),
          h('span', { className: 'dsh-git-chip-n', key: 'behind-n' }, behind > 99 ? '99+' : String(behind))))
      }
      if (ahead > 0) {
        children.push(h('span', { className: 'dsh-git-chip-grp', key: 'ahead' },
          h('span', { key: 'ahead-sym' }, '↑'),
          h('span', { className: 'dsh-git-chip-n', key: 'ahead-n' }, ahead > 99 ? '99+' : String(ahead))))
      }

      return h('button', {
        type: 'button',
        className: 'dsh-git-chip'
          + (isRepo ? ' dsh-git-chip-repo' : ' dsh-git-chip-idle')
          + (isOpen ? ' dsh-git-chip-open' : ''),
        title: switching !== null
          ? '正在切到 ' + switching + '…'
          : (isRepo ? title + ' · 悬停可直接切换分支' : title),
        ref: function (node) { chipNode = node },
        onClick: function () { clearHoverTimer(); setSwitchMode(null); setOpen(!isOpen) },
        /* Hover rather than right-click: the chip already names the branch, so
           hovering it to change it is the shortest path, and a context menu would
           hide a frequent action behind a gesture nothing else here uses. Outside
           a repository there is nothing to switch, so nothing pops up. */
        onPointerEnter: function () {
          if (gitSettings.hoverSwitch === true && isOpen !== true && isRepo === true) hoverOpenSoon()
        },
        onPointerLeave: function () {
          if (switchMode === 'hover') hoverCloseSoon()
        },
      }, children)
    }

