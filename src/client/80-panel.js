    /* ── 面板能长多高：跟着输入框的位置走 ──

       新会话的输入框垂直居中于屏幕，而面板从输入框上沿向上生长（bottom:100%），
       74vh 的默认高度会把头部（.dsh-git-top）整个顶出视口上沿。面板打开期间，实际
       渲染的高度被「输入框上沿之上的空间」钳制；日志列表本身是虚拟滚动
       （12-window.js 按容器 clientHeight 算可见行），容器一矮显示条数自动变少，
       列表那半边不用动。 */
    const PANEL_DEFAULT_VH = 0.74    /* 与 46-css.js 里 .dsh-git-pop 的 74vh 是同一个数 */
    const PANEL_ANCHOR_GAP = 8       /* .dsh-git-pop 的 margin-bottom：面板与输入框的间距 */
    const PANEL_ANCHOR_SAFETY = 1    /* 亚像素取整的余量：头部差 1px 被裁也看得难受 */
    const PANEL_MIN_HEIGHT = 160     /* 下限：极端情况下宁可顶部被裁一点，也不能面板缩没 */

    /* 面板 absolute 定位在输入区 overlay 槽位的容器里，那个容器随输入框移动（新会话
       居中、发送第一条消息后落底）。可用高度要量它，不能量面板自己：面板的 top 会随
       钳制后的高度变化，拿自己当锚点就成了自我反馈。offsetParent 会跳过不生成盒子的
       display:contents 包裹层（.dsh-git-layer）直达真正的定位容器；实在问不到容器
       （没有布局的环境）就退化为面板自己 —— 面板贴着容器上沿（bottom:100% 加
       margin-bottom:8px），容器上沿 ≈ 面板 top + 面板高 + 8。 */
    const panelAnchorBox = function (node) {
      if (node == null) return null
      const host = node.offsetParent != null ? node.offsetParent : node.parentElement
      if (host != null && typeof host.getBoundingClientRect === 'function') {
        const box = host.getBoundingClientRect()
        /* 有宽或高才可信：display:none（面板藏着时）与无布局环境里 rect 全是 0，
           那个 0 不能当成「输入框贴着视口顶」。 */
        if (parseFloat(box.width) > 0 || parseFloat(box.height) > 0) return box
      }
      if (typeof node.getBoundingClientRect === 'function') {
        const own = node.getBoundingClientRect()
        if (parseFloat(own.height) > 0) {
          return { top: parseFloat(own.top) + parseFloat(own.height) + PANEL_ANCHOR_GAP }
        }
      }
      return null
    }

    function GitPanel(props) {
      const plugin = usePluginConfig()
      const prefs = useGitSettings()
      const sessionId = props.sessionId
      const switcher = useSwitchMode()
      const switching = useSwitchingTo()
      const [tab, setTab] = React.useState('log')
      /* Which repository this panel shows is not a panel setting: it is the
         session's workspace, and the Host resolves it from the session. The one
         exception is a path the reader picked on the setup page after the
         workspace turned out not to be a repository yet. */
      const [appliedRepo, setAppliedRepo] = React.useState(sessionRepo(sessionId))
      /* 这个会话的工作区，上一次读到的样子（如果还在记忆里）。DSH 换会话时这里会
         整个重挂，但"重挂"不等于"要重新测"——同一个工作区里换会话，Host 和全局读数
         拿到的本来就是同一份答案（见 10-state.js 的 rememberedPanel）。先把它铺上，
         挂载时那次读照旧发出，用答复确认或纠正。 */
      const [remembered] = React.useState(function () { return rememberedPanel(sessionId) })
      const [refs, setRefs] = React.useState(null)
      const [authors, setAuthors] = React.useState(null)
      const [graph, setGraph] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [work, setWork] = React.useState(remembered === null ? null : remembered.status)
      /* The working tree, read separately from the repository's identity: on a
         Windows-mounted worktree that part alone costs seconds, and nothing on
         screen needs it before the frame is drawn. */
      const [status, setStatus] = React.useState(remembered === null ? null : remembered.status)
      const [maxCount, setMaxCount] = React.useState(PAGE_COMMITS)
      const [message, setMessage] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [selectedKey, setSelectedKey] = React.useState(null)
      const [activeRef, setActiveRef] = React.useState('')
      const [allRefs, setAllRefs] = React.useState(false)
      const [searchDraft, setSearchDraft] = React.useState('')
      const [search, setSearch] = React.useState('')
      /* IDEA's two switches beside the log search: `.*` reads the text as a
         regular expression, `Cc` makes it case sensitive. Both are off by
         default, which is exactly the search this panel had before they
         existed — literal text, ignoring case. */
      const [regexSearch, setRegexSearch] = React.useState(false)
      const [caseSensitive, setCaseSensitive] = React.useState(false)
      const [author, setAuthor] = React.useState('')
      const [datePreset, setDatePreset] = React.useState('all')
      const [pathDraft, setPathDraft] = React.useState('')
      const [pathFilter, setPathFilter] = React.useState('')
      const [collapsed, setCollapsed] = React.useState({})
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      /* Shared with the chip and the switcher rather than local: a switch made
         from the hover card happens while this panel is hidden, and it must not
         come back to the foreground still showing the branch it used to be on. */
      const reloadAt = useDataVersion()
      const [size, setSize] = React.useState(panelSize)
      /* 锚点容器（输入区 overlay 槽位）量到的 {top, vh}。null = 还没量过（首帧、或
         没有布局的环境），此时不钳制，维持 CSS 的 74vh / 记忆的 size.h。vh 和 top
         一起量、一起进变化判据：默认期望高度是 74% 个视口，只盯 top 的话纵向
         resize 就漏掉了。 */
      const [anchor, setAnchor] = React.useState(null)
      /* 这个挂载自己的面板节点。panelNode 是全局单值，同一页挂着多个会话时，别的
         会话一重画它就被指到别人的节点上；量锚点必须认自己这一块。 */
      const [nodeBox] = React.useState(function () { return { node: null } })
      const [armed, setArmed] = React.useState('')
      const [prompt, setPrompt] = React.useState(null)
      /* ── Ctrl+点击的多选提交 ──

         与单选（selected）独立并存：普通点击照旧单选+读详情，Ctrl/Cmd+点击把那一行
         挑进/移出这份集合；拣选/还原/标签/分支按钮仍作用于单选那条。存的是 hash 数组，
         顺序跟着图走（图重读后会按眼前的列表修剪一次）。 */
      const [multiSel, setMultiSel] = React.useState([])
      /* ⋯（更多操作）/ ⚡（快捷命令）两个下拉的开合：null = 都关着。 */
      const [menuOpen, setMenuOpen] = React.useState(null)
      /* 快捷命令的统一执行确认框（拿着哪条定义）与编辑器覆盖层（'new' 直接进编辑态、
         'list' 进列表态）。 */
      const [qcConfirm, setQcConfirm] = React.useState(null)
      const [qcEditor, setQcEditor] = React.useState(null)
      /* 绿色成功条（快捷命令的输出、删除分支的结果句）：和 error 同一个提示位，下一次
         操作开始时一起清掉 —— 提示位的规矩是一次只说一件事。 */
      const [okNote, setOkNote] = React.useState('')
      /* 两个下拉按钮的节点盒：「点外面关掉」要把触发按钮算在里面（见 78-actions.js
         的 useOutsideDismiss），否则点按钮会先被关一次、又被 click 开一次。 */
      const [moreBox] = React.useState(function () { return { node: null } })
      const [quickBox] = React.useState(function () { return { node: null } })
      const [needsUpstream, setNeedsUpstream] = React.useState(false)
      /* The file whose patch is on screen, and a counter the refresh button
         bumps. Null means the list the reader came from is on screen — the two
         lists that can open a diff (the changes tree, a commit's file list) both
         end in this one view, which is why it lives here and not in either. */
      const [diffTarget, setDiffTarget] = React.useState(null)
      const [diffAt, setDiffAt] = React.useState(0)
      /* ── 命令页的读数（57-cmdlog.js 只管画）──

         null = 还没读过：第一次切到那一页才发起；「重新读取」清回 null 让 effect
         再跑一次。读数里记着它属于哪个会话 —— 组件没重挂而 sessionId 变了的场合
         （防御；DSH 换会话通常是整块重挂），旧列表不当作「已读」。 */
      const [cmdLog, setCmdLog] = React.useState(null)
      /* 在飞的那次读取的序号：连续两次「重新读取」时，旧答复不许翻盘（和
         repoEpoch 是同一个问题，见 10-state.js）。 */
      const [cmdLogBox] = React.useState(function () { return { seq: 0 } })
      /* Which collapsed untracked directories are open, and what is inside the
         ones that have been read. Keyed by the directory's path; the read happens
         on the click that opens one, never for the whole tree up front. */
      const [untrackedOpen, setUntrackedOpen] = React.useState({})
      const [untrackedFiles, setUntrackedFiles] = React.useState({})
      /* ── the working tree, read by pathspec ──

         `git status` stats every tracked file and walks every untracked
         directory. Measured on this reader's repository (a Windows-mounted
         worktree): 7.4s for the whole tree, 13.6s cold, 13.0s with
         `--untracked-files=all` — and **0.5s** for the same command asked about
         the 36 paths the changes tree was showing. They are the same answer for
         everything that is on screen.

         So the whole tree is read on its own clock (opening a repository the
         plugin has not read yet, the refresh button, and once every fullReadGapMs
         while the changes tab is on screen), and everything the reader does
         between those — a tick, an edit to a file that is already listed, a stage,
         a commit — is confirmed by a read of the paths involved. A file that was
         clean and is now modified is the one thing a pathspec read cannot see; the
         whole-tree read is what catches it, which is why it still happens on a
         clock.

         The snapshot, the cost of the last whole-tree read and whether the next
         read has to be a whole one live in one object rather than in the state
         alone: an effect keeps the render it was created in, so a callback
         registered once would otherwise read a stale `status` for as long as its
         dependencies do not move. */
      const [panelBox] = React.useState(function () {
        return {
          status: remembered === null ? null : remembered.status,
          /* 记忆里那份先当屏上的快照用，挂载时的那次全树读照旧发出：要么命中 Host 的
             按仓库缓存（同一个工作区，几毫秒），要么给出真正的新答案。 */
          needFull: remembered !== null,
          repo: '',
          costMs: remembered === null ? 0 : remembered.costMs,
          lastFull: false,
          mutations: Promise.resolve(),
        }
      })
      panelBox.status = status
      /* 一次全树读占住整条通道多久 —— 下一次该隔多久再量一遍由它决定（fullReadGapMs）。
         进 state 的原因只有一个：间隔变了要把那个时钟重新起一遍。记忆里那份带着上次
         实测的代价，第一帧就把时钟的间隔定对。 */
      const [treeCost, setTreeCost] = React.useState(remembered === null ? 0 : remembered.costMs)

      /* work is the only truth about whether this path is a usable repository.
         Everything that reads refs, history or the index is gated on it, so a
         non-repository shows one purposeful setup page instead of three panes
         that each report a different flavour of failure. */
      const repoOk = work != null && work.ok === true
      const needsSetup = work != null && work.ok !== true

      /* 读数按答复里的仓库记，不是按这次请求写的那个：请求里常常只有会话 id（Host 才知道
         这个会话的工作区在哪）。收窄与否也是按这个路径记的。 */
      const treeKey = function (status, fallback) {
        const resolved = status != null ? text(status.repo) : ''
        return resolved.length > 0 ? resolved : fallback
      }

      const base = function (repo) {
        const request = { sessionId: sessionId }
        if (repo.length > 0) request.repo = repo
        return request
      }

      /* Identity first, working tree after. The identity answer is what decides
         whether this path is a repository at all, so waiting for `git status`
         before drawing anything made every switch to an unused workspace feel
         like the panel had hung. `paths` names the paths a partial read is
         about; null asks for the whole working tree. */
      const loadWork = function (repo, paths) {
        const request = base(repo)
        const asked = request.repo === undefined ? '' : request.repo
        const epoch = repoEpoch(asked, sessionId)
        callHost('git/panel', Object.assign({ quick: true }, request)).then(function (data) {
          /* A mutation since this read started makes the answer describe the
             repository before it — see repoEpoch. */
          if (epoch !== repoEpoch(asked, sessionId)) return
          setWork(data)
          if (data == null || data.ok !== true) { setStatus(null); return }
          const full = paths == null || paths.length === 0
          const work = Object.assign({}, request)
          if (!full) work.paths = paths
          const started = Date.now()
          /* 全树那一次在飞的时候，全局那份读数就是「还没核对过」：chip 这时说的是
             「正在核对」，而不是继续报一个它没验证过的数字。 */
          /* 读数按**答复里的仓库**记，不是按这次请求写的那个：请求里常常只有会话 id
             （Host 才知道这个会话的工作区在哪），而读数要能被 chip 按路径查到。 */
          const resolved = text(data.repo).length > 0 ? text(data.repo) : asked
          const finished = treeCountReadStart(resolved)
          callHost('git/panel', work).then(function (reply) {
            finished()
            /* A read that came back after the path changed is not this path's
               answer; the effect below will load the new one anyway. */
            if (asked !== appliedRepo && asked.length > 0) return
            if (epoch !== repoEpoch(asked, sessionId)) return
            panelBox.lastFull = full
            /* 只问几条路径的那种读有多贵：贵到一定程度就说明父目录扫进了大树，这个仓库
               从此收窄（见 pathsOfInterest）。 */
            if (full !== true) pathsReadSpent(resolved, Math.round(Date.now() - started))
            if (full) {
              /* 全树那一次花了多久，读数记下来。 */
              const cost = Math.round(Date.now() - started)
              panelBox.needFull = false
              panelBox.costMs = cost
              setTreeCost(cost)
              setStatus(reply != null && reply.ok === true ? reply : null)
              return
            }
            /* A partial answer says nothing about the rest of the tree: it is
               folded into the snapshot on screen, never put in its place. */
            setStatus(function (previous) { return mergePanelStatus(previous, reply) })
          }).catch(function () { finished(); setStatus(null) })
        }).catch(function (failure) {
          setError(failureText(failure))
        })
      }

      /* 快照能站多久。便宜的签名和路径读合起来覆盖了「已经显示着的那些路径」，它们
         看不见的只有一件事：**本来干净、刚刚被改**的文件（或者一个干净目录里新出现的
         文件）。那一次全树读在这台机器上是 5–8s，而且占住整条通道，所以它挂在时钟上，
         而且间隔按上一次实测的代价来定（fullReadGapMs：至少 30s，最多 5 分钟）。 */
      /* 量完就写进全局那一份读数（见 10-state.js）：面板是唯一既读全树、又读屏上那些
         路径的地方，chip 上那个数字就来自这里 —— 两块屏幕于是不会各说各话。乐观的
         tick（点击就地改的那份快照）也走这里，所以 chip 上的数字跟着手指走。 */
      React.useEffect(function () {
        if (status == null || status.ok !== true) return
        /* 按答复里的仓库记：没应用过路径时请求里只有会话 id，而这份读数要能被 chip
           按它查到的那个路径找到（Host 在答复里把会话的工作区解析成了路径）。 */
        publishTreeRead(treeKey(status, appliedRepo), status, panelBox.lastFull === true, panelBox.costMs)
      }, [status, appliedRepo])

      /* Whether this read may be about the paths on screen instead of the whole
         tree: whenever there is a snapshot to fold it into. */
      const readChanges = function () {
        const snapshot = panelBox.status
        /* 屏上有快照，问的就是屏上那些路径（0.2s）；换仓库、或明确要求整棵树时才重读
           全部。一次「提交」之后的读因此也是 0.3s，而不是 8–10s。 */
        const whole = panelBox.needFull === true || snapshot == null || snapshot.ok !== true
        loadWork(appliedRepo, whole ? null : pathsOfInterest(snapshot, treeKey(snapshot, appliedRepo)))
      }

      /* Read the whole tree again, now. The flush is what makes it a read rather
         than a repaint of the Host's cache; the refresh button and the clock both
         go through here. */
      const reloadChanges = function () {
        panelBox.needFull = true
        callHost('git/flush', base(appliedRepo)).then(bump, bump)
      }

      const resetFilters = function () {
        setActiveRef('')
        setAllRefs(false)
        setSearch('')
        setSearchDraft('')
        setRegexSearch(false)
        setCaseSensitive(false)
        setAuthor('')
        setDatePreset('all')
        setPathDraft('')
        setPathFilter('')
      }

      const applyRepo = function (next) {
        rememberRepo(sessionId, next)
        setAppliedRepo(next)
        setStatus(null)
        panelBox.status = null
        panelBox.needFull = true
        panelBox.repo = ''
        setMaxCount(PAGE_COMMITS)
        resetFilters()
        setSelected(null)
        setSelectedKey(null)
        setDetail(null)
        setDiffTarget(null)
        /* 多选、下拉、覆盖层都是「对着眼前这份列表」的状态：仓库一换全部作废。 */
        setMultiSel([])
        setMenuOpen(null)
        setQcConfirm(null)
        setQcEditor(null)
        setOkNote('')
        setUntrackedOpen({})
        setUntrackedFiles({})
      }

      const bump = bumpData

      /* ── 多仓库（24-repos.js）：这个工作区里的仓库清单，和两块侧栏各自的选择 ──

         清单在面板首帧**之后**异步落地：ensureWorkspaceRepos 只发起，落地靠 signal
         让正在渲染的树重画 —— 首帧一个字节都不为它等。生效仓库（effectiveRepo）永远
         只跟仓库行的单击走：多选和「全部」是所在那一栏的显示方式，历史、chip、提交、
         推送继续用 effectiveRepo，这是有意的设计 —— 把几个仓库的提交历史并进同一张
         图，排序、分页和筛选都得重新发明，而读者要找的那一个提交只会在一个仓库里。 */
      useRepoList()
      useRepoViews()
      /* 多选的变更分组，每组的快照来自全局那份工作区读数（10-state.js）：读数动了
         的 signal 这里也得听，否则 chip 那边量完，分组里的数字不跟着动。 */
      useTreeVersion()
      const repoList = repoListForSession(sessionId)
      const effectiveRepo = appliedRepo.length > 0 ? appliedRepo : (repoOk ? text(work.repo) : '')
      const shownRepos = reposShown(repoList, effectiveRepo)
      const logSel = repoSelection(sessionId, 'log')
      const changeSel = repoSelection(sessionId, 'changes')
      const logSelKey = logSel.join('\u0000')
      const changeSelKey = changeSel.join('\u0000')

      React.useEffect(function () {
        if (props.ready !== true) return
        /* 每个工作区只扫一次（24-repos.js 里按会话去重）。工作区本身是不是仓库不
           用来判断要不要扫 —— 嵌着好几个仓库的普通目录，恰恰是最需要这份清单的地方
           （设置页下面就挂着同一份列表）。 */
        ensureWorkspaceRepos(sessionId)
      }, [sessionId, props.ready])

      /* 仓库行的单击：切生效仓库 + 清掉这一栏的多选（树跟着生效仓库走回单仓库现状）。
         和设置页「打开这个目录」同一条路径，chip、历史、提交全都跟着换。 */
      const repoSingle = function (pane, path) {
        setRepoSelection(sessionId, pane, [])
        if (path === appliedRepo) return
        applyRepo(path)
        loadWork(path)
      }

      const repoAll = function (pane) {
        setRepoSelection(sessionId, pane, shownRepos)
      }

      const repoAdd = function (path) { return saveManualRepo(sessionId, { add: path }) }
      const repoRemove = function (path) { return saveManualRepo(sessionId, { remove: path }) }

      /* 两块侧栏的属性包：组件本身由 RefTree / ChangesPane 用 h() 挂（RepoSwitcher 有
         自己的 useState —— 当函数直接调会把它的钩子混进父组件的钩子序列，换页时数量
         一变就是坏状态）。 */
      const repoPropsFor = function (pane) {
        return {
          sessionId: sessionId, pane: pane, list: repoList, effective: effectiveRepo,
          onSingle: function (path) { repoSingle(pane, path) },
          onAll: function () { repoAll(pane) },
          onAdd: repoAdd, onRemove: repoRemove,
        }
      }

      /* ── what a hidden panel costs ──

         The panel stays mounted when it is closed, so a change in the repository
         used to make it re-read the history, the author list, the refs and the
         commit detail while nobody was looking — and then re-render a few hundred
         rows it was about to show anyway. Every one of those reads is cheap when
         the Host cache is warm, but the re-render is not, and none of it was
         visible.

         So a hidden panel does not re-read: it keeps the version it last
         rendered, and the moment it becomes visible again its reads jump to the
         current version and run once, in one pass. Opening a panel that owes
         nothing costs no request and no re-render at all. */
      const [rendered, setRendered] = React.useState(reloadAt)
      const freshAt = props.active === true ? reloadAt : rendered
      React.useEffect(function () {
        if (props.active === true && rendered !== reloadAt) setRendered(reloadAt)
        return undefined
      }, [props.active, reloadAt, rendered])

      /* Refresh has to actually re-read. The Host memoises reads per repository,
         so the button first drops that repository's cached entries and only then
         bumps the counter every read effect below depends on. Without the flush
         it would repaint stale data and look like nothing happened. */
      const refresh = function () {
        setArmed('')
        /* 刷新 = 整棵树重读：多选对着的是旧列表，一并清掉（见下面那个筛选 effect 的
           注释）。 */
        setMultiSel([])
        setOkNote('')
        reloadChanges()
      }

      /* 哪些操作能把整棵树改掉：切分支、pull、merge/cherry-pick/revert（开始、继续、
         跳过、中止都算）和压缩（soft reset 把 HEAD 挪到段首的父提交、索引变成整段的
         合计）会重写工作区/引用，它们的答案必须是一次全树读。别的（提交、暂存、取消
         暂存、fetch、push、tag、建/删分支）只动索引或引用 —— 那里用屏上那些路径确认
         就够了。真机上量到的是：一次全树读 8–10s，而且这期间整条 RPC 通道都被它占着，
         为一次「提交」让读者等十秒、十秒内点什么都要排队，是没有道理的。 */
      const REWRITES_TREE = ['git/checkout', 'git/pull', 'git/sequence', 'git/init', 'git/squash']

      /* One path for every panel operation. A failed operation still re-reads,
         because the failures that matter — a conflicting cherry-pick, merge or
         revert — leave the repository in a different state than they found it.
         onOk（可选）只在成功后跑一次：压缩用它清空多选 —— 失败时选择要留着好重试。 */
      const runOp = function (method, payload, onOk) {
        if (busy) return
        setBusy(true)
        setArmed('')
        setError(null)
        setOkNote('')
        setNeedsUpstream(false)
        panelBox.needFull = REWRITES_TREE.indexOf(method) >= 0
        const request = base(appliedRepo)
        if (payload != null) Object.assign(request, payload)
        rpc(method, request).then(function () {
          setBusy(false)
          if (typeof onOk === 'function') onOk()
          bump()
        }, function (failure) {
          setBusy(false)
          setError(failureText(failure))
          if (method === 'git/push' && failureText(failure).indexOf('upstream') >= 0) {
            /* 「这个分支还没有上游」是一次可以自己走完的失败：设置里开了这一条时，
               就把横幅本来要问的那一步直接做掉（同一个请求，带上 setUpstream）。问过
               的那一次不再自动重试 —— 它要是也失败，横幅照旧出现，读者还有得按。 */
            const retry = payload == null || payload.setUpstream !== true
            const remote = refs != null && refs.ok === true && refs.remote.length > 0 ? refs.remote[0].name : ''
            if (plugin.pushSetUpstream === true && retry && remote.length > 0 && currentName.length > 0) {
              runOp('git/push', { setUpstream: true, remote: remote, branch: currentName })
              return
            }
            setNeedsUpstream(true)
          }
          bump()
        })
      }

      const startDrag = function (axis) {
        return function (event) {
          if (event.button != null && event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          const node = panelNode
          if (node == null) return
          const doc = node.ownerDocument
          const view = doc != null ? doc.defaultView : null
          const startX = event.clientX
          const startY = event.clientY
          const startW = node.offsetWidth
          const startH = node.offsetHeight
          const maxW = view != null ? view.innerWidth - 24 : 2400
          const maxH = view != null ? view.innerHeight - 24 : 1600
          const clampW = function (value) { return Math.round(value < 420 ? 420 : (value > maxW ? maxW : value)) }
          const clampH = function (value) { return Math.round(value < 220 ? 220 : (value > maxH ? maxH : value)) }
          const onMove = function (move) {
            const next = { w: panelSize.w, h: panelSize.h }
            /* the panel stays centred, so one pixel of edge travel is two pixels
               of width */
            if (axis === 'w' || axis === 'e' || axis === 'nw' || axis === 'ne') {
              const delta = (axis === 'e' || axis === 'ne' ? move.clientX - startX : startX - move.clientX) * 2
              next.w = clampW(startW + delta)
            }
            if (axis === 'n' || axis === 'nw' || axis === 'ne') {
              next.h = clampH(startH + (startY - move.clientY))
            }
            publishPanelSize(next)
          }
          const onUp = function () {
            if (doc != null) {
              doc.removeEventListener('pointermove', onMove)
              doc.removeEventListener('pointerup', onUp)
              doc.removeEventListener('pointercancel', onUp)
            }
            savePanelSize(doc)
          }
          if (doc != null) {
            doc.addEventListener('pointermove', onMove)
            doc.addEventListener('pointerup', onUp)
            doc.addEventListener('pointercancel', onUp)
          }
        }
      }

      const submitPrompt = function () {
        if (prompt == null) return
        const value = prompt.value.trim()
        if (value.length === 0) return
        const kind = prompt.kind
        /* 压缩走自己的载荷：base 是最旧选中项的父提交，expect 是压缩前的 HEAD（防呆，
           见 host 78-actions.js 的顺序）。成功后多选清空 —— 这一段已经不存在了。 */
        if (kind === 'squash') {
          const squashPayload = { base: text(prompt.base), message: value }
          if (text(prompt.expect).length > 0) squashPayload.expect = text(prompt.expect)
          setPrompt(null)
          runOp('git/squash', squashPayload, function () { setMultiSel([]) })
          return
        }
        const at = selected !== null ? selected : ''
        setPrompt(null)
        if (kind === 'tag') runOp('git/tag', { name: value, at: at })
        else runOp('git/branch-create', { name: value, at: at })
      }

      React.useEffect(function () {
        if (!repoOk || props.ready !== true) return undefined
        let alive = true
        callHost('git/refs', base(appliedRepo)).then(function (data) {
          if (alive) setRefs(data)
        }).catch(function (failure) {
          if (alive) setError(failureText(failure))
        })
        return function () { alive = false }
      }, [appliedRepo, repoOk, freshAt, props.ready])

      /* 多选时左栏按仓库分组，每个选中仓库各要一份自己的 ref 表。Host 那边按仓库缓存
         这份读（invalidateRepo 同一套失效），所以这里每次 selection/refresh 直接问，
         便宜的命中不用省。 */
      const [repoRefs, setRepoRefs] = React.useState({})
      React.useEffect(function () {
        if (tab !== 'log' || props.ready !== true || logSelKey.length === 0) return undefined
        let alive = true
        const repos = logSelKey.split('\u0000')
        for (let i = 0; i < repos.length; i += 1) {
          const repo = repos[i]
          callHost('git/refs', { sessionId: sessionId, repo: repo }).then(function (data) {
            if (alive !== true) return
            setRepoRefs(function (previous) {
              const next = Object.assign({}, previous)
              next[repo] = data
              return next
            })
          }).catch(function (failure) {
            /* 一份 ref 表读不动不该连别的组也不画：记进日志，那一组显示「无法读取
               分支」。 */
            console.error('dsh-git-idea: could not read refs of ' + repo, failureText(failure))
            if (alive !== true) return
            setRepoRefs(function (previous) {
              const next = Object.assign({}, previous)
              next[repo] = { ok: false, local: [], current: [], remote: [] }
              return next
            })
          })
        }
        return function () { alive = false }
      }, [logSelKey, tab, freshAt, props.ready])

      /* 分支树里双击分支。repo 为空 = 今天的单仓库树，行为一字不差；带仓库 = 多选
         分组里双击「切到那个仓库并只看这个分支」—— 两步并成一步，否则在多选视图里
         双击一个分支什么都不发生，看起来就像双击坏了。 */
      const pickBranch = function (repo, name) {
        if (repo.length === 0) {
          setAllRefs(false)
          setActiveRef(name)
          return
        }
        setRepoSelection(sessionId, 'log', [])
        applyRepo(repo)
        loadWork(repo)
        setAllRefs(false)
        setActiveRef(name)
      }

      /* shortlog walks the entire history, so it is deferred until the history
         tab can actually show the author dropdown. The changes tab never needs
         it, and the Host caches it once fetched. */
      React.useEffect(function () {
        if (!repoOk || props.ready !== true || tab !== 'log') return undefined
        let alive = true
        callHost('git/authors', base(appliedRepo)).then(function (data) {
          if (alive) setAuthors(data)
        }).catch(function () {
          if (alive) setAuthors(null)
        })
        return function () { alive = false }
      }, [appliedRepo, repoOk, tab, freshAt, props.ready])

      /* ── 命令页：第一次切到才读，切走再切回不重读 ──

         会话记录要真去扫文件，和其它「切到那页才读」的读一个待遇。与 authors
         那条 effect 不同，这里**不**因切走页签作废在飞的那次读：扫一遍不该白扫，
         答复落在 state 里，读者切回来正好用上 —— 「不重新请求」因此连读还没完的
         那种场合也成立。 */
      React.useEffect(function () {
        if (tab !== 'cmdlog' || props.ready !== true) return undefined
        if (cmdLog !== null && cmdLog.sessionId === sessionId) return undefined
        cmdLogBox.seq += 1
        const seq = cmdLogBox.seq
        setCmdLog({ sessionId: sessionId, loading: true })
        callHost('git/command-log', { sessionId: sessionId, limit: 500 }).then(function (data) {
          if (seq !== cmdLogBox.seq) return
          /* ok:false（沙箱拒绝、PATH 上没有 node、超时……）是「读得了答复、读不了
             记录」：原话在 data.error 里，折成空列表就成了「这个项目没跑过 git」。 */
          if (data == null || data.ok !== true) {
            const said = data != null && text(data.error).length > 0 ? text(data.error) : '读不了会话记录'
            setCmdLog({ sessionId: sessionId, error: said })
            return
          }
          setCmdLog({
            sessionId: sessionId,
            commands: Array.isArray(data.commands) ? data.commands : [],
            truncated: data.truncated === true,
          })
        }, function (failure) {
          if (seq !== cmdLogBox.seq) return
          setCmdLog({ sessionId: sessionId, error: failureText(failure) })
        })
        return undefined
      }, [tab, sessionId, cmdLog, props.ready])

      React.useEffect(function () {
        if (props.ready !== true) return undefined
        /* 换了仓库：屏幕上那份快照是别人的，只能整棵树重读一次。同一个仓库上的一次
           bump（仓库在屏幕底下动过了）问的是屏上那些路径 —— 见 readChanges。标签页
           不进这个判据：从「历史」切到「变更」不改变工作区是什么样。 */
        if (panelBox.repo !== appliedRepo) {
          panelBox.repo = appliedRepo
          panelBox.needFull = true
        }
        readChanges()
        return undefined
      }, [appliedRepo, tab, freshAt, props.ready, sessionId])

      /* A read that came back “not a repository” while the session was still
         being resolved must not be the last word: closing and reopening the
         panel asks again. A working repository keeps its snapshot — that is
         what makes reopening instant — so only a failed verdict is retried. */
      React.useEffect(function () {
        if (props.active !== true || props.ready !== true) return
        if (work == null || work.ok === true) return
        readChanges()
      }, [props.active, props.ready])

      /* ── the whole tree, on a clock ──

         Nothing else notices a file that was clean and has just been modified,
         or a new file in a directory with nothing changed in it. That read is
         seconds on a slow mount, so it happens while the changes tab is the thing
         on screen and nowhere else. */
      React.useEffect(function () {
        if (!repoOk || props.ready !== true || props.active !== true || tab !== 'changes') return undefined
        const timer = ctx.get('timer')
        if (timer === undefined) return undefined
        return timer.interval(function () { reloadChanges() }, fullReadGapMs(treeCost))
      }, [appliedRepo, repoOk, props.active, props.ready, tab, treeCost])

      /* ── 多选的变更分组：每个选中仓库一份工作区快照 ──

         快照全部走全局那份读数（publishTreeRead/treeRecord）：读过的仓库在这里是
         免费的，chip 和单仓库面板量过的都能直接用；没有快照、或这份快照过期
         （treeReadDue）的仓库才发一次全树读。一次全树读是这条通道上最贵的东西，
         多选不改变这一点 —— 所以只补缺的，不在每次重画时全量重读。 */
      React.useEffect(function () {
        if (tab !== 'changes' || props.ready !== true || changeSelKey.length === 0) return undefined
        let alive = true
        const repos = changeSelKey.split('\u0000')
        for (let i = 0; i < repos.length; i += 1) {
          const repo = repos[i]
          const record = treeRecord(repo)
          if (record !== null && record.status != null && treeReadDue(repo) !== true) continue
          const started = Date.now()
          const finished = treeCountReadStart(repo)
          callHost('git/panel', { sessionId: sessionId, repo: repo }).then(function (reply) {
            finished()
            if (alive !== true || reply == null || reply.ok !== true) return
            publishTreeRead(repo, reply, true, Date.now() - started)
          }, function (failure) {
            finished()
            /* 快照读不下来那一组显示「无法读取这个仓库的变更」，别的组照画；失败
               记进日志，不升到面板的错误横幅 —— 横幅说的是生效仓库的事。 */
            console.error('dsh-git-idea: could not read the working tree of ' + repo, failureText(failure))
          })
        }
        return function () { alive = false }
      }, [changeSelKey, tab, props.ready, freshAt, sessionId])

      /* 多选时只 watch 选中的那几个仓库（不是清单里的全部 —— watcher 是真的在跑
         git 的，多一个仓库就多一份轮询）。深度那半和单仓库一样只在变更页正在被看
         时开，问的路径也是那个仓库自己的脏路径。 */
      React.useEffect(function () {
        if (props.ready !== true || props.active !== true || tab !== 'changes' || changeSelKey.length === 0) return undefined
        const repos = changeSelKey.split('\u0000')
        const stops = []
        for (let i = 0; i < repos.length; i += 1) {
          stops.push(watchRepo(repos[i], sessionId, bump, true, true))
          setWatchPaths(repos[i], sessionId, treeReadPaths(repos[i]))
        }
        return function () { for (let i = 0; i < stops.length; i += 1) stops[i]() }
      }, [changeSelKey, tab, props.active, props.ready, sessionId])

      React.useEffect(function () {
        if (!repoOk || props.ready !== true || tab !== 'log') return undefined
        let alive = true
        const request = base(appliedRepo)
        request.maxCount = maxCount
        if (allRefs) request.allRefs = true
        else if (activeRef.length > 0) request.ref = activeRef
        if (search.length > 0) {
          request.search = search
          if (regexSearch === true) request.regex = true
          if (caseSensitive === true) request.caseSensitive = true
        }
        if (author.length > 0) request.author = author
        const since = dateSince(datePreset)
        if (since.length > 0) request.since = since
        if (pathFilter.length > 0) request.path = pathFilter
        callHost('git/graph', request).then(function (data) {
          if (!alive) return
          setGraph(data)
          /* Nothing is selected until a commit is clicked. Re-reading the history
             keeps whatever was picked if it is still in the new list, and drops it
             otherwise — the list must never pick for the reader. */
          const commits = data != null && data.ok === true && Array.isArray(data.commits) ? data.commits : []
          let keep = ''
          for (let i = 0; i < commits.length; i += 1) {
            if (text(commits[i].hash) === pickedCommit) { keep = pickedCommit; break }
          }
          setSelected(keep.length > 0 ? keep : null)
          if (keep.length === 0) {
            pickedCommit = ''
            setDetail(null)
            return
          }
          const detailRequest = base(appliedRepo)
          detailRequest.hash = keep
          callHost('git/commit-detail', detailRequest).then(function (chosen) {
            if (alive) setDetail(chosen)
          }).catch(function () {})
        }).catch(function (failure) {
          if (alive) setError(failureText(failure))
        })
        return function () { alive = false }
      }, [appliedRepo, activeRef, allRefs, search, regexSearch, caseSensitive, author, datePreset, pathFilter, maxCount, tab, repoOk, freshAt, props.ready])

      /* The panel node exists by the time effects run, so its document is the
         first place a remembered size or preference can be read from. */
      React.useEffect(function () {
        const node = panelNode
        const doc = node != null ? node.ownerDocument : null
        loadPanelSize(doc)
        loadSettings(doc)
        loadPluginConfig()
        if (panelSize.w > 0 || panelSize.h > 0) setSize({ w: panelSize.w, h: panelSize.h })
      }, [])

      /* the settings page can reset the geometry while this panel is open */
      React.useEffect(function () {
        return panelSizeSignal.subscribe(function () {
          setSize({ w: panelSize.w, h: panelSize.h })
        })
      }, [])

      /* ── 面板打开期间，跟着输入框量 ──

         「发送第一条消息后输入框立刻从居中落到底部」这种 DOM 位移对插件没有事件
         可听，只能自己量：active 期间用一个 rAF 循环每帧读一次锚点容器的
         rect.top，与上次差超过 1px 才 setState —— 没动的帧只读一个 rect、零渲染；
         窗口 resize（rect 会变）也顺带被覆盖。active 变 false 时取消循环。

         用 useLayoutEffect 是为了让「打开面板」的那一帧就把高度钳住：先画一帧
         74vh、下一帧再缩回来，正好闪一下头部跑出视口的样子。 */
      useLayoutEffect(function () {
        if (props.active !== true) return undefined
        const doc = nodeBox.node != null ? nodeBox.node.ownerDocument : null
        const view = doc != null ? doc.defaultView : null
        let raf = 0
        let lastTop = NaN
        let lastVh = NaN
        const readAnchor = function () {
          const box = panelAnchorBox(nodeBox.node)
          const top = box == null ? NaN : parseFloat(box.top)
          const vh = view != null ? parseFloat(view.innerHeight) : NaN
          if (!isFinite(top)) return
          if (Math.abs(top - lastTop) > 1 || Math.abs(vh - lastVh) > 1) {
            lastTop = top
            if (isFinite(vh)) lastVh = vh
            setAnchor({ top: lastTop, vh: lastVh })
          }
        }
        readAnchor()
        if (view == null || typeof view.requestAnimationFrame !== 'function') return undefined
        const tick = function () {
          readAnchor()
          raf = view.requestAnimationFrame(tick)
        }
        raf = view.requestAnimationFrame(tick)
        return function () { view.cancelAnimationFrame(raf) }
      }, [props.active])

      /* The panel watches fast only while it is the thing on screen; closed, it
         falls back to the chip's slow lane and shares that poller. */
      React.useEffect(function () {
        if (!repoOk || props.ready !== true) return undefined
        /* The deep signature is the one that notices edits inside files, and it
           is the expensive one; it is worth paying only while the changes tab is
           the thing being looked at. */
        return watchRepo(appliedRepo, sessionId, bump, props.active === true, tab === 'changes')
      }, [appliedRepo, repoOk, sessionId, props.active, props.ready, tab])

      /* The watcher's deep tick asks about the paths on screen, so it has to be
         told which ones they are. Nothing else drives this: a snapshot that
         changed is exactly a change in what is worth watching. Declared after the
         registration above, so on the render where it first fires there is an
         entry to write into. */
      React.useEffect(function () {
        if (status == null || status.ok !== true) return
        setWatchPaths(appliedRepo, sessionId, pathsOfInterest(status, treeKey(status, appliedRepo)))
      }, [status, appliedRepo, sessionId])

      /* One identity for as long as the repository does not change: the commit
         rows are memoised, and a handler rebuilt on every render would defeat
         every one of them — including for the rows whose own state did not move. */
      const openCommit = useCallback(function (hash) {
        setSelected(hash)
        pickedCommit = hash
        const request = base(appliedRepo)
        request.hash = hash
        rpc('git/commit-detail', request).then(function (data) {
          setDetail(data)
        }, function (failure) {
          setError(failureText(failure))
        })
      }, [appliedRepo, sessionId])

      /* 提交行的点击入口：普通点击照旧走 openCommit；Ctrl/Cmd+点击只动多选（用函数式
         setState，所以这个回调不依赖 multiSel，行级 memo 仍然成立）。 */
      const pickCommit = useCallback(function (hash, event) {
        if (event != null && (event.ctrlKey === true || event.metaKey === true)) {
          setMultiSel(function (previous) {
            const at = previous.indexOf(hash)
            if (at >= 0) {
              const next = previous.slice()
              next.splice(at, 1)
              return next
            }
            return previous.concat([hash])
          })
          return
        }
        openCommit(hash)
      }, [openCommit])

      /* ── 多选的清空与修剪 ──

         多选是「对着眼前这份列表」选出来的：分支范围、筛选、搜索一变，所选的那段就
         不再是眼前这段；仓库切换、⟳、切页签、压缩完成各自在自己的路径上清（applyRepo /
         refresh / 下面这个 tab effect / submitPrompt 的 onOk）。 */
      React.useEffect(function () { setMultiSel([]) }, [activeRef, allRefs, search, regexSearch, caseSensitive, author, datePreset, pathFilter])
      React.useEffect(function () { setMultiSel([]) }, [tab])
      /* 图重读之后把多选里已不在列表上的提交剪掉：角标和「压缩已选 N 个」说的都得是
         眼前真实存在的行，顺序也顺手换成图上的顺序（{hashes} 变量按它代值）。 */
      React.useEffect(function () {
        if (multiSel.length === 0) return
        if (graph == null || graph.ok !== true || !Array.isArray(graph.commits)) return
        setMultiSel(function (previous) {
          const keep = []
          for (let i = 0; i < graph.commits.length; i += 1) {
            const hash = text(graph.commits[i].hash)
            if (previous.indexOf(hash) >= 0) keep.push(hash)
          }
          return keep.length === previous.length ? previous : keep
        })
      }, [graph])

      /* ── 压缩入口（⋯ 菜单点「压缩提交」后走到这里）──

         区间按**图上的顺序**算（多选记录的是点击顺序，而压缩语义是「最旧到最新这一整
         段」）：soft reset 的落点是最旧选中项的父提交，防呆的 expect 是压缩前的 HEAD。
         reset --soft 只会落在当前 HEAD 上，所以段的新端必须是 HEAD —— 两道门：
         筛过的列表（分支范围、搜索、作者、日期、路径）第一行未必是 HEAD，expect 也
         无从比对，要求在当前分支的无筛选视图里选；无筛选视图的列表第一行就是 HEAD，
         所选最新一条必须是它 —— 否则真正被压掉的区间（一直到 HEAD）比提示里说的那段
         更长，中间隔着的一段是压不掉的。 */
      const openSquash = function () {
        const scoped = allRefs || activeRef.length > 0 || search.length > 0 || author.length > 0
          || datePreset !== 'all' || pathFilter.length > 0
        if (scoped) {
          setError('压缩要对着当前分支的完整历史选：先清掉分支范围、筛选与搜索，再从列表第一行（HEAD）开始 Ctrl+点击选起')
          return
        }
        const commits = graph != null && graph.ok === true && Array.isArray(graph.commits) ? graph.commits : []
        const spots = []
        for (let i = 0; i < commits.length; i += 1) {
          if (multiSel.indexOf(text(commits[i].hash)) >= 0) spots.push(i)
        }
        if (spots.length < 2) return
        if (spots[0] !== 0) {
          setError('压缩区间的最新端必须是 HEAD（列表第一行）：把第一行也 Ctrl+点击 选进来再压 —— 列表中间的一段压不掉')
          return
        }
        const newest = commits[spots[0]]
        const oldest = commits[spots[spots.length - 1]]
        const parents = Array.isArray(oldest.parents) ? oldest.parents : []
        if (parents.length === 0 || text(parents[0]).length === 0) {
          setError('所选最旧的那个提交（' + text(oldest.short) + '）没有父提交 —— 仓库的第一个提交压不进任何区间')
          return
        }
        const count = spots[spots.length - 1] - spots[0] + 1
        /* 预填：最新一条的 subject 起头，下面缩进列出段内各条 subject，可编辑。 */
        const lines = [text(newest.subject)]
        for (let i = spots[0] + 1; i <= spots[spots.length - 1]; i += 1) {
          lines.push('* ' + text(commits[i].subject))
        }
        setPrompt({
          kind: 'squash', value: lines.join('\n'), base: text(parents[0]),
          expect: text(commits[0].hash),
          hint: '将 ' + text(oldest.short) + '…' + text(newest.short) + ' 共 ' + String(count) + ' 个提交压缩为 1 个',
        })
      }

      const toggle = function (path) {
        setCollapsed(function (previous) {
          const next = Object.assign({}, previous)
          if (next[path] === true) delete next[path]
          else next[path] = true
          return next
        })
      }

      /* Opening a collapsed untracked directory: the list of files inside is one
         read, asked for at that moment and not before. The entry for this path is
         dropped first so the rows say "正在读取…" instead of showing the previous
         listing — after a stage or a commit that listing is what changed.
         `at` 多选分组里带过来：读哪个仓库的目录、展开状态按哪个仓库记 —— 两个仓库
         里同名目录各开各的，互不顶掉。 */
      const toggleUntracked = function (dir, at) {
        const repo = at != null && at.length > 0 ? at : ''
        const key = repo.length > 0 ? repo + '\u001f' + dir : dir
        if (untrackedOpen[key] === true) {
          const closed = Object.assign({}, untrackedOpen)
          delete closed[key]
          setUntrackedOpen(closed)
          return
        }
        const opened = Object.assign({}, untrackedOpen)
        opened[key] = true
        setUntrackedOpen(opened)
        setUntrackedFiles(function (previous) {
          const next = Object.assign({}, previous)
          delete next[key]
          return next
        })
        const request = base(repo.length > 0 ? repo : appliedRepo)
        request.dir = dir
        callHost('git/untracked', request).then(function (data) {
          const files = data != null && data.ok === true && Array.isArray(data.files) ? data.files : []
          setUntrackedFiles(function (previous) {
            const next = Object.assign({}, previous)
            next[key] = files
            return next
          })
        }).catch(function (failure) {
          setError(failureText(failure))
          setUntrackedFiles(function (previous) {
            const next = Object.assign({}, previous)
            next[key] = []
            return next
          })
        })
      }

      /* The mutation's own answer. Asked about the paths that changed, it costs a
         fraction of a whole-tree read, so the tick the reader just made is
         confirmed while they are still looking at it — and if another click has
         happened since, this reply is not about the state on screen any more and
         is dropped. `at` names the repository the paths belong to; empty means
         the applied one, which is the only case this ever was. */
      const confirmStaged = function (paths, at) {
        const repo = at != null && at.length > 0 ? at : appliedRepo
        const request = base(repo)
        request.paths = paths
        const epoch = repoEpoch(repo, sessionId)
        const finished = treeCountReadStart(repo)
        callHost('git/panel', request).then(function (reply) {
          finished()
          if (epoch !== repoEpoch(repo, sessionId)) return
          if (reply == null || reply.ok !== true) return
          /* 只有生效仓库的快照在这块屏上（setStatus）；别的仓库的确认读并进全局那份
             读数 —— 多选的变更分组和 chip 都从那里画。 */
          if (repo !== appliedRepo) {
            const record = treeRecord(repo)
            if (record != null && record.status != null) {
              publishTreeRead(repo, mergePanelStatus(record.status, reply), false, null)
            }
            return
          }
          setStatus(function (previous) { return mergePanelStatus(previous, reply) })
        }, function () { finished() })
      }

      /* ── one mutation after another, and none of them dims the panel ──

         A tick used to raise the panel's `busy` flag for as long as `git add`
         took (98–236ms measured, plus the read behind it), and `busy` is a
         panel-wide thing: the four header tools and the commit button render at
         40–45% opacity while it is up, and the commit button's own label swaps to
         `处理中…`, so the row's box moving was accompanied by the toolbar and the
         commit pane blinking on every single tick. What the flag was also buying
         is bought here instead: the two things a burst of clicks needs are order
         (the reader's calls reach git in the order they made them, so a tick and
         the untick after it cannot land reversed) and a commit that sees the
         index the reader sees (`git add` and `git commit` are separate processes,
         and a commit that starts before the add has finished commits the index
         from before the tick). */
      const queueMutation = function (run) {
        const next = panelBox.mutations.then(run, run)
        /* The chain itself must not carry a rejection forward: a failed `git add`
           is reported on screen, not by poisoning every mutation after it. */
        panelBox.mutations = next.then(function () {}, function () {})
        return next
      }

      const setStaged = function (files, staged, at) {
        if (files.length === 0) return
        const repo = at != null && at.length > 0 ? at : appliedRepo
        const paths = []
        for (let i = 0; i < files.length; i += 1) {
          const path = text(files[i].path)
          if (path.length > 0) paths.push(path)
        }
        if (paths.length === 0) return
        /* Everything already in flight describes the index before this call; one
           of those replies landing after it would paint the tick back to empty. */
        bumpRepoEpoch(repo, sessionId)
        const epoch = repoEpoch(repo, sessionId)
        const before = panelBox.status
        /* 乐观补丁只打在生效仓库那份屏上快照（panelBox.status 是它的）；多选分组里
           别的仓库没有本地快照可打，那一格等确认读回来再亮。 */
        const patched = repo === appliedRepo ? stageLocally(before, files, staged) : null
        if (patched !== null) {
          panelBox.status = patched
          setStatus(patched)
        }
        const request = base(repo)
        request.paths = paths
        queueMutation(function () {
          return rpc(staged ? 'git/stage' : 'git/unstage', request).then(function () {
            setError(null)
            /* Only the newest click may paint from a read. A reply about a state
               the reader has already moved past — the tick this one replaced —
               would put that box back where it was for a frame. */
            if (epoch === repoEpoch(repo, sessionId)) confirmStaged(paths, repo)
          }, function (failure) {
            setError(failureText(failure))
            /* git did not do it, so those paths go back to what git last said —
               read, not from a snapshot that a later click has already moved on
               from. The newest click's own read is the one that answers. */
            if (epoch === repoEpoch(repo, sessionId)) confirmStaged(paths, repo)
          })
        })
      }

      /* ── 默认变更列表的三件套：还原 / 暂存（54-changes.js 的工具条）──

         「添加」那一件就是 git add，走上面那个 setStaged —— 勾选==已暂存，所以它幂等，
         不需要自己的处理器。这两件不同：restore 把路径从索引和工作区一起抹回 HEAD，
         stash 把它们收进 stash 栈，答案都是「那几个路径现在干净了」，善后因此照
         setStaged 的样子：只问那几条路径的确认读（confirmStaged，0.2s 那条路），列表里
         那几行立刻消失，不为它们排一次全树读。

         与 tick 不同，这两个要动面板的 busy：它们各只有一次点击、没有乐观补丁可打
         （git 说了算），点下去到读回来之间，按钮自己得看得见在忙 —— tick 那条
         「不许让面板闪」的规矩（见 queueMutation 的注释）买的是连点，这里没有连点。 */
      const pickedPaths = function (files) {
        const paths = []
        for (let i = 0; i < files.length; i += 1) {
          const path = text(files[i].path)
          if (path.length > 0) paths.push(path)
        }
        return paths
      }

      const runGroupOp = function (method, files, at, extra, note) {
        const paths = pickedPaths(files)
        if (paths.length === 0) return
        const repo = at != null && at.length > 0 ? at : appliedRepo
        setBusy(true)
        setError(null)
        setOkNote('')
        /* 与 setStaged 同一个理由：在飞的读描述的是这次操作之前的仓库。 */
        bumpRepoEpoch(repo, sessionId)
        const epoch = repoEpoch(repo, sessionId)
        const request = base(repo)
        request.paths = paths
        if (extra != null) Object.assign(request, extra)
        queueMutation(function () {
          return rpc(method, request).then(function () {
            setBusy(false)
            setError(null)
            setOkNote(note(paths.length))
            if (epoch === repoEpoch(repo, sessionId)) confirmStaged(paths, repo)
          }, function (failure) {
            setBusy(false)
            setError(failureText(failure))
            /* git 没做成也要重读那几条路径：失败的原因（比如 stash 拒绝）常常已经改了
               它们的状态，屏幕不能停留在操作前的那一份上。 */
            if (epoch === repoEpoch(repo, sessionId)) confirmStaged(paths, repo)
          })
        })
      }

      /* 还原：git restore --source=HEAD --staged --worktree。破坏性，客户端已经两段式
         确认过；成功的话把「做了什么」说在成功条里，读者不用猜那几个文件去了哪。 */
      const revertPicked = function (files, at) {
        runGroupOp('git/restore', files, at, null, function (n) {
          return '已还原 ' + String(n) + ' 项：索引和工作区都回到 HEAD（被删的文件也已恢复）。'
        })
      }

      /* 暂存（stash）：非破坏，成功条里得说怎么拿回来 —— 不说的话 stash 就是黑洞。 */
      const stashPicked = function (files, at) {
        const count = pickedPaths(files).length
        runGroupOp('git/stash', files, at,
          { message: 'dsh-git-idea：暂存 ' + String(count) + ' 个文件' },
          function (n) {
            return '已收进 stash：' + String(n) + ' 项。git stash pop 可找回（git stash list 里能看到这一次）。'
          })
      }

      const changes = status != null && status.ok === true ? mergeChanges(status) : []
      let stagedCount = 0
      for (let i = 0; i < changes.length; i += 1) if (changes[i].staged === true) stagedCount += 1

      /* 多选时页签上的数字是**所有选中仓库**的合计（合计的每份都来自全局读数，
         treeCount）；没有多选时就是生效仓库那一个 —— 和今天一样。 */
      let changesBadge = changes.length
      if (changeSel.length > 0) {
        changesBadge = 0
        for (let i = 0; i < changeSel.length; i += 1) changesBadge += treeCount(changeSel[i])
      }
      /* 变更分组的每一组：{repo, status}，status 为 null 表示那次全树读还在飞。 */
      const changeGroups = changeSel.length > 0 ? changeSel.map(function (repo) {
        const record = treeRecord(repo)
        return { repo: repo, status: record === null ? null : record.status }
      }) : null

      const setStagedAll = function () {
        setStaged(changes, stagedCount === 0)
      }

      const commit = function () {
        setBusy(true)
        const request = base(appliedRepo)
        request.message = message.trim()
        if (stagedCount === 0) request.stageAll = true
        /* Behind the ticks rather than racing them: this button is no longer
           disabled while an `git add` is in flight (that disabled state was half
           the blink), so the queue is what keeps the commit from describing an
           index the reader has already moved past. */
        queueMutation(function () {
          return rpc('git/commit', request, '提交失败').then(function () {
            setBusy(false)
            setError(null)
            setMessage('')
            /* 提交动的是索引和引用，屏上那些路径的读（0.3s）就是这次点击的答案：刚才
               提交掉的那几个文件会立刻从列表里消失。整棵树留给时钟和 ⟳。 */
            panelBox.needFull = false
            bump()
          }, function (failure) {
            setBusy(false)
            setError(failureText(failure))
          })
        })
      }

      const currentBranch = graph != null && graph.ok === true ? text(graph.currentBranch) : (refs != null && refs.ok === true && refs.current.length > 0 ? refs.current[0] : '')
      const branchValue = allRefs ? '@all' : (activeRef.length > 0 ? activeRef : '@current')
      /* Short labels: this select now sits inside an inline "分支：…" trigger, so
         "当前分支（main）" would be the widest thing in the toolbar. */
      /* A native select cannot ellipsize — it cuts the glyph in half — so a long
         branch name is shortened in the label itself, with the full name in the
         option's title. */
      const shortRef = function (name) { return name.length > 12 ? name.slice(0, 11) + '…' : name }
      const branchOptions = [
        { value: '@current', label: '当前' + (currentBranch.length > 0 ? ' ' + shortRef(currentBranch) : ''), title: currentBranch },
        { value: '@all', label: '所有分支', title: '所有分支' },
      ]
      if (refs != null && refs.ok === true) {
        for (let i = 0; i < refs.local.length; i += 1) {
          branchOptions.push({ value: refs.local[i].data, label: shortRef(refs.local[i].data), title: refs.local[i].data })
        }
        for (let i = 0; i < refs.remote.length; i += 1) {
          for (let k = 0; k < refs.remote[i].refs.length; k += 1) {
            branchOptions.push({ value: refs.remote[i].refs[k].data, label: shortRef(refs.remote[i].refs[k].data), title: refs.remote[i].refs[k].data })
          }
        }
      }

      const authorLabels = { '': '作者' }
      const authorOptions = [h('option', { key: '__all', value: '' }, '作者')]
      if (authors != null && authors.ok === true) {
        for (let i = 0; i < authors.authors.length; i += 1) {
          const who = authors.authors[i]
          const value = who.email.length > 0 ? who.email : who.name
          authorLabels[value] = who.name
          authorOptions.push(h('option', {
            key: 'a' + i, value: value, title: who.name + ' · ' + String(who.count) + ' 个提交',
          }, who.name))
        }
      }

      const filterCount = (allRefs || activeRef.length > 0 ? 1 : 0)
        + (author.length > 0 ? 1 : 0)
        + (datePreset !== 'all' ? 1 : 0)
        + (pathFilter.length > 0 ? 1 : 0)
      const hasFilter = filterCount > 0 || search.length > 0
      const commitCount = graph != null && graph.ok === true ? graph.commits.length : 0
      const selectedCommit = selected !== null ? text(selected) : ''
      const canAct = repoOk && busy !== true && selectedCommit.length > 0
      const currentName = refs != null && refs.ok === true && refs.current.length > 0 ? refs.current[0] : ''
      const ahead = work != null && work.ok === true ? work.ahead : 0
      const behind = work != null && work.ok === true ? work.behind : 0
      const sequencer = work != null && work.ok === true ? text(work.sequencer) : ''
      const conflicts = status != null && status.ok === true ? status.unmerged.length : 0

      /* ── 快捷命令：变量上下文 + 执行 ──

         单选/详情属于「选中的那一条」（detail 就是它），{hashes} 属于多选（无多选退化为
         选中单条）。执行成功给绿色成功条（stdout 尾部 ~400 字符），失败进 error 区说
         「命令 + 原话」；两条路都照 runOp 的善后 bump 一次 —— 自定义命令可能动了 refs，
         Host 那边也把读缓存作废了（78-actions.js 的 quickRun）。放在 currentBranch /
         selectedCommit / detail 都已就位的地方：上下文是每帧现算的字面量。 */
      const quickCommands = plugin != null && Array.isArray(plugin.quickCommands) ? plugin.quickCommands : []
      const quickCtx = {
        branch: currentBranch,
        upstream: work != null && work.ok === true ? text(work.upstream) : '',
        hash: selectedCommit,
        hashes: multiSel.length > 0 ? multiSel.join(' ') : selectedCommit,
        subject: detail != null && detail.ok === true ? text(detail.subject) : '',
        author: detail != null && detail.ok === true ? text(detail.author) : '',
        email: detail != null && detail.ok === true ? text(detail.email) : '',
        date: detail != null && detail.ok === true ? text(detail.date) : '',
        tags: detail != null && detail.ok === true && Array.isArray(detail.tags) ? detail.tags.join(',') : '',
      }
      const runQuick = function (command) {
        if (busy) return
        setBusy(true)
        setQcConfirm(null)
        setQcEditor(null)
        setMenuOpen(null)
        setError(null)
        setOkNote('')
        const request = base(appliedRepo)
        request.command = command
        rpc('git/quick', request, '快捷命令执行失败').then(function (result) {
          setBusy(false)
          const raw = text(result.stdout).replace(/\s+$/, '')
          const shown = raw.length > 400 ? '…' + raw.slice(raw.length - 400) : raw
          setOkNote('$ ' + command + '\n' + (shown.length > 0 ? shown : '（没有输出）'))
          bump()
        }, function (failure) {
          setBusy(false)
          const said = commandDetail(failure.reply)
          setError('$ ' + command + '\n' + (said.length > 0 ? said : failureText(failure)))
          bump()
        })
      }

      const tool = function (key, label, title, onClick, options) {
        const opts = options == null ? {} : options
        const classes = ['dsh-git-tool']
        if (opts.danger === true) classes.push('dsh-git-danger')
        if (opts.on === true) classes.push('dsh-git-tool-on')
        /* An icon-only tool: same hit area as the labelled ones, no text. */
        if (opts.ico === true) classes.push('dsh-git-tool-ico')
        const parts = [label]
        if (typeof opts.badge === 'number' && opts.badge > 0) {
          parts.push(h('span', { key: 'b', className: 'dsh-git-tool-badge' }, String(opts.badge)))
        }
        return h('button', {
          key: key, type: 'button', className: classes.join(' '),
          disabled: opts.disabled === true, title: title, onClick: onClick,
        }, parts)
      }

      /* Syncing is a repository-level act, so it belongs in the panel header
         beside the branch it acts on — not in the commit graph's own toolbar,
         which is about the selected commit. The middle toolbar keeps only what
         the selection scopes. */
      const syncGroup = h('div', { className: 'dsh-git-sync' },
        tool('refresh', '⟳', '重新读取仓库（忽略缓存）', refresh, { disabled: !repoOk || busy }),
        tool('fetch', '⇣', 'fetch：从所有远端取回最新引用', function () { runOp('git/fetch') }, { disabled: !repoOk || busy }),
        tool('pull', '↓', 'pull：拉取并合入当前分支', function () { runOp('git/pull') }, { disabled: !repoOk || busy, badge: behind }),
        tool('push', '↑', 'push：推送当前分支', function () { runOp('git/push') }, { disabled: !repoOk || busy, badge: ahead }))

      const branchTitle = (currentName.length > 0 ? currentName : 'HEAD')
        + (ahead > 0 ? ' · 领先 ' + String(ahead) : '')
        + (behind > 0 ? ' · 落后 ' + String(behind) : '')
      /* The branch chip is the switcher's handle: the name is already the thing
         the eye goes to, so making it the button saves a trip to the sidebar for
         the most frequent branch operation there is. */
      const branchChip = h('button', {
        key: 'chip', type: 'button',
        className: 'dsh-git-branch-chip' + (switcher === 'panel' ? ' dsh-git-branch-chip-on' : ''),
        title: switching !== null ? '正在切到 ' + switching + '…' : branchTitle + ' · 点击切换分支',
        onClick: function () { setSwitchMode(switcher === 'panel' ? null : 'panel') },
      },
        h(BranchIcon, { key: 'i', size: 13, spin: switching !== null }),
        h('span', { key: 'n', className: 'dsh-git-branch-name' }, currentName.length > 0 ? currentName : 'HEAD'),
        ahead > 0 ? h('span', { key: 'a', className: 'dsh-git-ab' }, '↑' + String(ahead)) : null,
        behind > 0 ? h('span', { key: 'b', className: 'dsh-git-ab' }, '↓' + String(behind)) : null)

      /* Inside the header, which spans the panel: the card then starts at the
         panel's left margin however many rows the header wraps to, and there is
         no measured offset to keep in sync. */
      const switchCard = switcher === 'panel'
        ? h('div', {
            key: 'sw', className: 'dsh-git-switch dsh-git-switch-panel',
            /* The same mark the hover card carries. Without it the card counts as
               "the panel behind the switcher", so pressing a branch row dismissed
               the card on pointerdown and the click never reached the row. */
            ref: function (node) { switcherNode = node },
          },
            h(BranchPicker, {
              sessionId: sessionId,
              repo: appliedRepo,
              mode: 'panel',
              dirty: status != null && status.ok === true
                ? status.staged.length + status.unstaged.length + status.untracked.length + status.unmerged.length
                : 0,
              onDone: function () { setSwitchMode(null) },
              onClose: function () { setSwitchMode(null) },
            }))
        : null

      /* The log toolbar follows IDEA's: the commit actions stay where they were,
         then one search box, then every filter as an inline "name: value"
         trigger that clears itself. No bordered select boxes and no second row,
         so the graph keeps the height that row used to cost. */
      const lfCaret = h('span', { key: 'c', className: 'dsh-git-lf-caret' }, h(Icon, { name: 'down', size: 10 }))
      /* A native select is as wide as its WIDEST option, not the value it is
         showing: with the arrow suppressed that left "作者：mays" floating in a
         112px box with the caret and the × parked at the far end. Sizing the
         control to the label it currently displays keeps the three together. */
      const labelWidth = function (label) {
        let w = 0
        for (let i = 0; i < label.length; i += 1) w += label.charCodeAt(i) > 0x2e80 ? 11.5 : 6.3
        /* +6 of slack: a select that is a hair too narrow clips its own text, and
           a clipped branch name is worse than six spare pixels. */
        return Math.min(132, Math.max(16, Math.round(w) + 6))
      }
      const lfWidth = function (label) { return { width: String(labelWidth(label)) + 'px' } }
      const lfClear = function (key, name, onClear) {
        return h('button', {
          key: key, type: 'button', className: 'dsh-git-lf-x', title: '清除' + name + '筛选',
          onClick: function (event) {
            stopEvent(event)
            /* The trigger is a <label> around a <select>: without preventDefault
               the click would also fall through and open the dropdown we are
               clearing. */
            if (event != null && typeof event.preventDefault === 'function') event.preventDefault()
            onClear()
          },
        }, '×')
      }

      const searchBox = h('div', {
        key: 'search', className: 'dsh-git-logsearch',
        title: '按提交信息筛选（字面量匹配），回车生效',
      },
        h('span', { key: 'i', className: 'dsh-git-logsearch-ico' }, h(Icon, { name: 'search', size: 13 })),
        h('input', {
          key: 'q', className: 'dsh-git-logsearch-input',
          placeholder: '搜索提交信息…',
          value: searchDraft,
          onChange: function (event) { setSearchDraft(event.target.value) },
          onKeyDown: function (event) { if (event.key === 'Enter') setSearch(searchDraft.trim()) },
        }),
        /* Shown as soon as there is anything to clear, applied or not: the box
           holds the draft, so an un-applied query is still one click from gone. */
        searchDraft.length > 0 || search.length > 0 ? h('button', {
          key: 'x', type: 'button', className: 'dsh-git-logsearch-x', title: '清空搜索',
          onClick: function () { setSearchDraft(''); setSearch('') },
        }, '×') : null)

      let branchLabel = branchOptions[0].label
      for (let i = 0; i < branchOptions.length; i += 1) {
        if (branchOptions[i].value === branchValue) { branchLabel = branchOptions[i].label; break }
      }
      const branchScoped = allRefs || activeRef.length > 0
      const branchFilter = h('label', {
        key: 'f:branch', className: 'dsh-git-lf dsh-git-lf-on', title: '分支范围：历史只显示这个分支能到达的提交',
      },
        h('span', { key: 'k', className: 'dsh-git-lf-k' }, '分支：'),
        h('select', {
          key: 's', className: 'dsh-git-lf-select', style: lfWidth(branchLabel), value: branchValue,
          onChange: function (event) {
            const next = event.target.value
            setSelectedKey(null)
            if (next === '@all') { setAllRefs(true); setActiveRef('') }
            else if (next === '@current') { setAllRefs(false); setActiveRef('') }
            else { setAllRefs(false); setActiveRef(next) }
          },
        }, branchOptions.map(function (option) {
          return h('option', { key: option.value, value: option.value, title: option.title }, option.label)
        })),
        lfCaret,
        /* × returns the graph to its default scope — the current branch — rather
           than to "everything": that is the view the panel opens with. */
        branchScoped ? lfClear('x', '分支', function () {
          setSelectedKey(null); setAllRefs(false); setActiveRef('')
        }) : null)

      const authorOn = author.length > 0
      const authorFilter = h('label', {
        key: 'f:author', className: 'dsh-git-lf' + (authorOn ? ' dsh-git-lf-on' : ''), title: '作者',
      },
        authorOn ? h('span', { key: 'k', className: 'dsh-git-lf-k' }, '作者：') : null,
        h('select', {
          key: 's', className: 'dsh-git-lf-select', value: author,
          style: lfWidth(authorLabels[author] !== undefined ? authorLabels[author] : '作者'),
          onChange: function (event) { setAuthor(event.target.value) },
        }, authorOptions),
        lfCaret,
        authorOn ? lfClear('x', '作者', function () { setAuthor('') }) : null)

      let dateLabel = '时间'
      for (let i = 0; i < DATE_PRESETS.length; i += 1) {
        if (DATE_PRESETS[i].id === datePreset) dateLabel = DATE_PRESETS[i].id === 'all' ? '时间' : DATE_PRESETS[i].label
      }
      const dateOn = datePreset !== 'all'
      const dateFilter = h('label', {
        key: 'f:date', className: 'dsh-git-lf' + (dateOn ? ' dsh-git-lf-on' : ''), title: '时间范围',
      },
        dateOn ? h('span', { key: 'k', className: 'dsh-git-lf-k' }, '时间：') : null,
        h('select', {
          key: 's', className: 'dsh-git-lf-select', value: datePreset,
          style: lfWidth(dateLabel),
          onChange: function (event) { setDatePreset(event.target.value) },
        }, DATE_PRESETS.map(function (preset) {
          /* Unset reads as the field's own name, the way IDEA's toolbar does. */
          return h('option', { key: preset.id, value: preset.id }, preset.id === 'all' ? '时间' : preset.label)
        })),
        lfCaret,
        dateOn ? lfClear('x', '时间', function () { setDatePreset('all') }) : null)

      const pathOn = pathDraft.length > 0 || pathFilter.length > 0
      const pathFilterNode = h('label', {
        key: 'f:path', className: 'dsh-git-lf' + (pathOn ? ' dsh-git-lf-on' : ''), title: '只看某个路径的历史，回车生效',
      },
        pathOn ? h('span', { key: 'k', className: 'dsh-git-lf-k' }, '路径：') : null,
        h('input', {
          key: 'i', className: 'dsh-git-lf-input',
          /* Grows with what is typed, so a draft never scrolls inside 44px. */
          style: { width: String(Math.min(110, Math.max(pathOn ? 40 : 46, 24 + pathDraft.length * 6))) + 'px' },
          placeholder: pathOn ? '' : '路径',
          value: pathDraft,
          onChange: function (event) { setPathDraft(event.target.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter') setPathFilter(pathDraft.trim())
            if (event.key === 'Escape') { setPathDraft(''); setPathFilter('') }
          },
        }),
        pathOn ? lfClear('x', '路径', function () { setPathDraft(''); setPathFilter('') }) : null)

      /* IDEA's arrangement of this strip: what you filter with on the left,
         what you do with the result on the right. */
      const toolbar = h('div', { className: 'dsh-git-tools' },
        searchBox,
        h('button', {
          key: 're', type: 'button', className: 'dsh-git-lf-flag' + (regexSearch === true ? ' dsh-git-lf-on' : ''),
          title: '正则表达式：把搜索词按正则解释（默认按字面匹配）',
          onClick: function () { setRegexSearch(regexSearch !== true) },
        }, '.*'),
        h('button', {
          key: 'cs', type: 'button', className: 'dsh-git-lf-flag' + (caseSensitive === true ? ' dsh-git-lf-on' : ''),
          title: '区分大小写（默认忽略大小写）',
          onClick: function () { setCaseSensitive(caseSensitive !== true) },
        }, 'Cc'),
        branchFilter,
        authorFilter,
        dateFilter,
        pathFilterNode,
        filterCount >= 2 ? h('button', {
          key: 'clear', type: 'button', className: 'dsh-git-lclear', title: '清除全部筛选',
          onClick: function () { resetFilters() },
        }, '全部清除') : null,
        h('span', { key: 'grow', className: 'dsh-git-grow' }),
        h('span', { key: 'sep', className: 'dsh-git-tsep' }),
        tool('pick', h(Icon, { name: 'pick', size: 15 }), '拣选：cherry-pick，把这个提交应用到当前分支',
          function () {
            runOp('git/sequence', {
              op: 'cherry-pick', action: 'start', target: selectedCommit,
              record: plugin.cherryPickRecord === true,
            })
          },
          { disabled: !canAct, ico: true }),
        tool('revert', h(Icon, { name: 'revert', size: 15 }), '还原：revert，生成一个反向提交来撤销它',
          function () { runOp('git/sequence', { op: 'revert', action: 'start', target: selectedCommit }) },
          { disabled: !canAct, ico: true }),
        tool('tag', h(Icon, { name: 'tag', size: 15 }), '标签：在这个提交上打标签',
          function () { setArmed(''); setPrompt({ kind: 'tag', value: '' }) },
          { disabled: !canAct, ico: true }),
        tool('branch', h(BranchIcon, { size: 15 }), '分支：从这个提交新建分支并切过去',
          function () { setArmed(''); setPrompt({ kind: 'branch', value: '' }) },
          { disabled: !canAct, ico: true }),
        /* branch 右边那两个图标按钮：⋯（更多操作，带 Ctrl 多选数的角标）与 ⚡（快捷
           命令）。样式照 dsh-git-tool-ico 画但类名分开 —— 见 78-actions.js 开头的说明；
           下拉浮层挂在同一格（position:relative），跟着按钮走。 */
        h('span', { key: 'acts', className: 'dsh-git-acts' },
          h('button', {
            key: 'more', type: 'button',
            className: 'dsh-git-acts-btn' + (menuOpen === 'more' ? ' dsh-git-acts-btn-on' : ''),
            title: '更多操作：压缩提交（Ctrl+点击多选）、删除分支',
            disabled: !repoOk,
            ref: function (node) { moreBox.node = node },
            onClick: function (event) {
              stopEvent(event)
              setMenuOpen(menuOpen === 'more' ? null : 'more')
            },
          }, '⋯',
            multiSel.length > 0 ? h('span', { key: 'b', className: 'dsh-git-tool-badge' }, String(multiSel.length)) : null),
          h('button', {
            key: 'quick', type: 'button',
            className: 'dsh-git-acts-btn' + (menuOpen === 'quick' ? ' dsh-git-acts-btn-on' : ''),
            title: '快捷命令：一键执行自定义的命令模板（变量按当前分支和选中的提交代值）',
            disabled: !repoOk,
            ref: function (node) { quickBox.node = node },
            onClick: function (event) {
              stopEvent(event)
              setMenuOpen(menuOpen === 'quick' ? null : 'quick')
            },
          }, '⚡'),
          menuOpen === 'more'
            ? h(MoreActionsMenu, {
                key: 'm', open: true,
                onClose: function () { setMenuOpen(null) },
                trigger: moreBox,
                count: multiSel.length,
                onSquash: function () { setMenuOpen(null); openSquash() },
                reqBase: base(appliedRepo),
                refs: refs, current: currentName, busy: busy,
                onNote: function (said) { setOkNote(said) },
                onError: function (said) { setError(said) },
              })
            : null,
          menuOpen === 'quick'
            ? h(QuickCommandsMenu, {
                key: 'q', open: true,
                onClose: function () { setMenuOpen(null) },
                trigger: quickBox,
                commands: quickCommands, ctx: quickCtx,
                onPick: function (one) { setMenuOpen(null); setQcConfirm(one) },
                onCreate: function () { setMenuOpen(null); setQcEditor('new') },
                onManage: function () { setMenuOpen(null); setQcEditor('list') },
              })
            : null),
        /* Pinned to the right end of the strip, and short: the room it reserves
           is room the filters cannot use, and "200 条" says as much as
           "200 条匹配" once the filters above it are visible. */
        h('span', {
          key: 'count', className: 'dsh-git-count dsh-git-dim',
          title: String(commitCount) + (hasFilter ? ' 条匹配当前筛选' : ' 条提交'),
        }, String(commitCount)))

      /* 压缩的内联表单：提示行说清区间（abc…def 共 N 个 → 1 个），下面是多行的提交信息
         （预填：最新 subject 起头 + 段内各条缩进列出，可编辑）。Enter 确认、Shift+Enter
         换行、Esc 取消 —— 信息本来就是多行的，Enter 直接确认与单行 prompt 一个手感。 */
      const editSquashPrompt = function (value) {
        setPrompt({ kind: 'squash', value: value, base: prompt.base, expect: prompt.expect, hint: prompt.hint })
      }
      const promptRow = prompt === null ? null : prompt.kind === 'squash'
        ? h('div', { className: 'dsh-git-prompt dsh-git-prompt-squash' },
            h('span', { key: 'l', className: 'dsh-git-hint' }, text(prompt.hint)),
            clearable('m', h('textarea', {
              key: 'm', className: 'dsh-git-input', autoFocus: true, rows: 4, value: prompt.value,
              placeholder: '压缩后的提交信息（Enter 压缩，Shift+Enter 换行）',
              onChange: function (event) { editSquashPrompt(event.target.value) },
              onKeyDown: function (event) {
                if (event.key === 'Enter' && event.shiftKey !== true) { event.preventDefault(); submitPrompt() }
                if (event.key === 'Escape') setPrompt(null)
              },
            }), prompt.value.length > 0, function () { editSquashPrompt('') }, 'dsh-git-clearable-area'),
            h('button', {
              key: 'ok', type: 'button', className: 'dsh-git-btn dsh-git-primary',
              disabled: prompt.value.trim().length === 0, onClick: submitPrompt,
            }, '压缩'),
            h('button', {
              key: 'no', type: 'button', className: 'dsh-git-btn',
              onClick: function () { setPrompt(null) },
            }, '取消'))
        : h('div', { className: 'dsh-git-prompt' },
        h('span', { key: 'l', className: 'dsh-git-hint' }, prompt.kind === 'tag' ? '标签名' : '新分支名'),
        clearable('i', h('input', {
          key: 'i', className: 'dsh-git-input', autoFocus: true, value: prompt.value,
          placeholder: prompt.kind === 'tag' ? '例如 v1.0.0' : '例如 feature/login',
          onChange: function (event) { setPrompt({ kind: prompt.kind, value: event.target.value }) },
          onKeyDown: function (event) {
            if (event.key === 'Enter') submitPrompt()
            if (event.key === 'Escape') setPrompt(null)
          },
        }), prompt.value.length > 0, function () { setPrompt({ kind: prompt.kind, value: '' }) }),
        h('button', {
          key: 'ok', type: 'button', className: 'dsh-git-btn dsh-git-primary',
          disabled: prompt.value.trim().length === 0, onClick: submitPrompt,
        }, '创建'),
        h('button', {
          key: 'no', type: 'button', className: 'dsh-git-btn',
          onClick: function () { setPrompt(null) },
        }, '取消'))

      const SEQ_LABELS = { 'cherry-pick': '拣选', 'revert': '还原', 'merge': '合并', 'rebase': '变基' }
      const seqLabel = SEQ_LABELS[sequencer] !== undefined ? SEQ_LABELS[sequencer] : sequencer
      const doAbort = function () {
        setArmed('')
        runOp('git/sequence', { op: sequencer, action: 'abort' })
      }
      const banner = sequencer.length === 0 ? null : h('div', { className: 'dsh-git-banner' },
        h('span', { key: 't', className: 'dsh-git-banner-text' },
          '正在' + seqLabel + '：' + (conflicts > 0 ? String(conflicts) + ' 个文件冲突' : '等待提交')),
        tool('seq-cont', sequencer === 'merge' ? '提交合并' : '继续',
          sequencer === 'merge' ? '冲突解决并暂存后提交这次合并' : '冲突解决并暂存后继续',
          function () { runOp('git/sequence', { op: sequencer, action: 'continue' }) },
          { disabled: busy }),
        sequencer === 'merge' ? null : tool('seq-skip', '跳过', '跳过这个提交',
          function () { runOp('git/sequence', { op: sequencer, action: 'skip' }) },
          { disabled: busy }),
        armed === 'abort'
          ? tool('seq-abort', '确认中止', '放弃本次' + seqLabel + '，回到操作前的状态', doAbort, { disabled: busy, danger: true })
          : tool('seq-abort', '中止', '放弃本次' + seqLabel,
              function () { setArmed('abort') }, { disabled: busy }))

      const upstreamHint = needsUpstream && refs != null && refs.ok === true && refs.remote.length > 0
        ? h('div', { className: 'dsh-git-prompt' },
            h('span', { key: 'l', className: 'dsh-git-hint' }, '这个分支还没有上游'),
            h('button', {
              key: 'u', type: 'button', className: 'dsh-git-btn dsh-git-primary', disabled: busy,
              onClick: function () {
                runOp('git/push', { setUpstream: true, remote: refs.remote[0].name, branch: currentName })
              },
            }, '推送并设为上游'),
            h('button', { key: 'n', type: 'button', className: 'dsh-git-btn', onClick: function () { setNeedsUpstream(false) } }, '忽略'))
        : null

      const shownRef = allRefs ? '' : (activeRef.length > 0 ? activeRef : (graph != null && graph.ok === true ? text(graph.ref) : ''))
      const effectiveSelection = selectedKey !== null ? selectedKey : shownRef

      /* ── the view switch lives in the header ──

         IDEA keeps this switch in the tool window's own toolbar, and that is
         where it belongs: it changes how the pane below is read. On a row of its
         own above the list it was a full line of the panel's height spent on two
         words, so it rides here instead — and only while the changes tab is the
         one on screen, because on the history it would toggle nothing. */
      const changesView = prefs.changesView === 'flat' ? 'flat' : 'tree'
      const viewButton = function (id, name, hint) {
        return h('button', {
          key: id,
          type: 'button',
          className: 'dsh-git-cview' + (changesView === id ? ' dsh-git-cview-on' : ''),
          title: hint,
          onClick: function () { saveSettings(Object.assign({}, prefs, { changesView: id })) },
        }, name)
      }
      const viewSwitch = needsSetup || tab !== 'changes' ? null : h('span', {
        key: 'views', className: 'dsh-git-cviews',
      },
        viewButton('tree', '树', '文件树视图：按目录折叠'),
        viewButton('flat', '扁平', '扁平文件视图：每个文件一行，名字在前、目录压暗，按路径排序'))

      const header = h('div', { className: 'dsh-git-top' },
        h('span', { className: 'dsh-git-title' }, 'Git'),
        needsSetup
          ? h('span', { className: 'dsh-git-hint' }, '未检测到仓库')
          : h('div', { className: 'dsh-git-tabs' },
              /* The count on 变更 is what makes the changed files findable at
                 all: the panel opens on the history, and a tab that only says
                 "变更" gives no sign that anything is waiting behind it. */
              h('button', { type: 'button', className: 'dsh-git-tab' + (tab === 'changes' ? ' dsh-git-tab-on' : ''),
                title: changeSel.length > 0
                  ? String(changesBadge) + ' 个未提交改动（' + String(changeSel.length) + ' 个仓库的合计，点开逐仓库看）'
                  : (changesBadge > 0
                    ? String(changesBadge) + ' 个文件有未提交的改动，点开可以逐个看差异'
                    : '未提交的改动'),
                onClick: function () { setTab('changes'); setDiffTarget(null) } },
                '变更',
                changesBadge > 0 ? h('span', { key: 'n', className: 'dsh-git-tool-badge' }, String(changesBadge)) : null),
              h('button', { type: 'button', className: 'dsh-git-tab' + (tab === 'log' ? ' dsh-git-tab-on' : ''),
                title: '提交历史', onClick: function () { setTab('log'); setDiffTarget(null) } }, '历史'),
              /* 命令页不带数字角标：会话记录里有多少条 git 命令，这个数既不稳定也
                 不指导任何操作，放在页签上只是噪音；数量在读进来之后说在页面里。 */
              h('button', { type: 'button', className: 'dsh-git-tab' + (tab === 'cmdlog' ? ' dsh-git-tab-on' : ''),
                title: '这个项目执行过的 git 命令（来自 DSH 会话记录）',
                onClick: function () { setTab('cmdlog'); setDiffTarget(null) } }, '命令')),
        needsSetup ? null : syncGroup,
        needsSetup ? null : branchChip,
        h('span', { key: 'grow', className: 'dsh-git-grow' }),
        viewSwitch,
        switchCard)

      /* What the diff on screen was read from. The file's own state as the last
         workspace read reported it, so staging it (from here or from the tree)
         re-reads the patch instead of leaving the old one up, plus the counter
         the refresh button bumps. */
      let diffSig = String(diffAt)
      if (diffTarget !== null && diffTarget.kind === 'file' && status != null && status.ok === true) {
        for (let i = 0; i < changes.length; i += 1) {
          if (changes[i].path === diffTarget.path) {
            diffSig += '|' + (changes[i].staged === true ? 'S' : '-') + text(changes[i].indexCode) + text(changes[i].workCode)
            break
          }
        }
      }

      let body
      /* 多选分组里点开的差异属于**那个**仓库的文件：diff 请求和它的暂存都带着仓库
         走；单仓库的 target 没有这一格，照旧落在生效仓库上。 */
      const diffRepo = diffTarget !== null && text(diffTarget.repo).length > 0 ? text(diffTarget.repo) : appliedRepo
      if (work == null) {
        body = h('div', { className: 'dsh-git-pane dsh-git-dim' }, '正在读取仓库…')
      } else if (needsSetup) {
        /* 设置页下面挂同一份仓库清单：工作区本身不是仓库时，这份清单恰恰是出路 ——
           里面嵌着的仓库点一下就打开（单击 = 切生效仓库，与左栏那条同一手势）。 */
        body = h('div', { key: 'setupwrap', className: 'dsh-git-setupwrap' },
          h(RepoSetup, {
            key: 'setup:' + appliedRepo + '|' + text(work.repo),
          sessionId: sessionId,
          initial: text(work.repo),
          reason: text(work.reason),
          /* git's own stderr only adds information when git itself misbehaved.
             For "no repository here" the explanation above already says it, and
             the raw fatal: line would just be noise. */
          stderr: text(work.reason) === 'git-error' ? text(work.stderr).slice(0, 400) : '',
          onOpen: function (next) {
            applyRepo(next)
            loadWork(next)
          },
        }),
        h('div', { key: 'setup-repos', className: 'dsh-git-setup-repos' }, h(RepoSwitcher, repoPropsFor('log'))))
      } else if (diffTarget !== null) {
        /* The diff takes the body, whichever list opened it, and the way back is
           the arrow in its own header — a drill-down rather than a third pane,
           because a pane narrow enough to fit beside two other columns is not
           wide enough to read a patch in. */
        /* ── 右列的数据：这个补丁是从哪个列表点开的，那个列表就跟过来 ──

           提交那一路直接用当前 detail 的文件（没有多仓库问题：一次提交属于它自己
           的仓库）；变更那一路是工作区快照 —— 多选分组里点开的文件属于**它自己
           那个**仓库，右列得是那个仓库的变更（全局那份读数，10-state.js 的
           treeRecord），拿屏上生效仓库的列表凑数会把两个仓库的路径混在一列。 */
        let diffRail = null
        if (diffTarget.kind === 'commit') {
          if (detail != null && detail.ok === true && Array.isArray(detail.files) && detail.files.length > 0) {
            diffRail = { kind: 'commit', files: detail.files }
          }
        } else {
          let railChanges = changes
          if (diffRepo !== appliedRepo) {
            const record = treeRecord(diffRepo)
            railChanges = record != null && record.status != null && record.status.ok === true
              ? mergeChanges(record.status) : []
          }
          diffRail = { kind: 'changes', changes: railChanges }
        }
        /* 右列换文件：提交那一路 ref 不动、只换 path/from/status（和提交详情里
           点开一个文件是同一条路，diffSig 随 shape 变化自动重读补丁）；变更那一
           路走 changeDiffTarget，仓库跟着文件原来的那一格走。 */
        const diffRailOpen = diffRail === null ? undefined : function (file) {
          if (diffTarget.kind === 'commit') {
            setDiffTarget({
              kind: 'commit',
              path: text(file.path),
              from: text(file.from),
              ref: text(diffTarget.ref),
              status: text(file.status),
            })
            return
          }
          setDiffTarget(changeDiffTarget(file, text(diffTarget.repo)))
        }
        body = h(DiffView, {
          key: 'diff',
          target: diffTarget,
          repo: diffRepo,
          sessionId: sessionId,
          sig: diffSig,
          busy: busy,
          rail: diffRail,
          onOpenFile: diffRailOpen,
          collapsed: collapsed,
          onToggle: toggle,
          onBack: function () { setDiffTarget(null) },
          onRefresh: function () { setDiffAt(diffAt + 1) },
          onStage: diffTarget.kind === 'file'
            ? function (staged) { setStaged([{ path: diffTarget.path }], staged, diffRepo) }
            : undefined,
        })
      } else if (tab === 'changes') {
        body = h(ChangesPane, {
          work: status,
          collapsed: collapsed,
          busy: busy,
          message: message,
          selectedKey: selectedKey,
          onToggle: toggle,
          onSelect: function (key) { setSelectedKey(key) },
          onSetStaged: setStaged,
          onSetStagedAll: setStagedAll,
          onMessage: setMessage,
          onCommit: commit,
          /* 默认变更列表工具条的还原/暂存：与 onSetStaged 同一套「单仓库不带仓库、多仓库
             带仓库」的接法（见 makeScope 的转发）。 */
          onRevert: revertPicked,
          onStash: stashPicked,
          /* 多仓库：侧栏、分组、按仓库落下去的四个回调。分组为 null 时（单选/没多选）
             变更树与今天完全一样 —— 分组、键名、勾选手势一字不差。 */
          repoProps: repoPropsFor('changes'),
          groups: changeGroups,
          onRepoSingle: function (path) { repoSingle('changes', path) },
          onSetStagedAt: function (repo, files, staged) { setStaged(files, staged, repo) },
          onRevertAt: function (repo, files) { revertPicked(files, repo) },
          onStashAt: function (repo, files) { stashPicked(files, repo) },
          onToggleUntrackedAt: function (repo, dir) { toggleUntracked(dir, repo) },
          onOpenDiffAt: function (repo, file) { setDiffTarget(changeDiffTarget(file, repo)) },
          /* One click on a file row, in either list, is what opens the patch —
             selecting a row in IDEA's commit window and getting its diff on the
             right is the same gesture, and a row that only highlights leaves the
             reader with no way to the text at all. */
          onOpenDiff: function (file) { setDiffTarget(changeDiffTarget(file)) },
          untrackedOpen: untrackedOpen,
          untrackedFiles: untrackedFiles,
          onToggleUntracked: toggleUntracked,
        })
      } else if (tab === 'cmdlog') {
        /* 只读页：列表是上面的 effect 攒下的那份快照，「重新读取」清回 null 让它
           再扫一遍会话文件。 */
        body = h(CommandLogPane, {
          log: cmdLog,
          onReload: function () { setCmdLog(null) },
        })
      } else {
        body = h('div', { className: 'dsh-git-body' },
          h('div', { className: 'dsh-git-left' },
            h(RefTree, {
              refs: refs, collapsed: collapsed, selectedKey: effectiveSelection,
              headName: currentName,
              /* The changes that are not committed yet, shown on the branch they
                 would be committed to. Zero until the working-tree read lands,
                 which is why the badge appears a moment after the tree. */
              dirty: status != null && status.ok === true
                ? status.staged.length + status.unstaged.length + status.untracked.length + status.unmerged.length
                : 0,
              onToggle: toggle, onSelect: function (key) { setSelectedKey(key) },
              activeRef: shownRef,
              /* 多仓库：仓库列表区（HEAD 分组上方）与多选时的按仓库分组。groups 为
                 null 时这棵树和今天是同一棵 —— 同一函数、空前缀。 */
              repoProps: repoPropsFor('log'),
              groups: logSel.length > 0 ? logSel.map(function (repo) {
                return { repo: repo, refs: repoRefs[repo] === undefined ? null : repoRefs[repo] }
              }) : null,
              onRepoSingle: function (path) { repoSingle('log', path) },
              onPickBranch: pickBranch,
            })),
          h('div', { className: 'dsh-git-main' },
            toolbar,
            promptRow,
            upstreamHint,
            h(CommitList, {
              graph: graph,
              selected: selected,
              multi: multiSel,
              onPick: pickCommit,
              /* Functional, not `maxCount + PAGE_COMMITS`: two clicks before the
                 next render would otherwise both read the same old value and lose
                 a page. */
              onLoadMore: function () { setMaxCount(function (n) { return n + PAGE_COMMITS }) },
            })),
          h(CommitDetail, {
            detail: detail, collapsed: collapsed, selectedKey: selectedKey,
            onToggle: toggle, onSelect: function (key) { setSelectedKey(key) },
            /* A file in a commit is the commit's own read: same path, but the
               two states are that commit and its first parent. */
            onOpenDiff: function (file) {
              setDiffTarget({
                kind: 'commit',
                path: text(file.path),
                from: text(file.from),
                ref: detail != null ? text(detail.hash) : '',
                status: text(file.status),
              })
            },
          }))
      }

      const popProps = {
        className: 'dsh-git-pop' + (props.active === true ? '' : ' dsh-git-hidden')
          + (switcher === 'panel' ? ' dsh-git-pop-overflow' : ''),
        ref: function (node) { panelNode = node; nodeBox.node = node },
      }
      if (size.w > 0) popProps.style = { width: size.w + 'px', left: '50%', right: 'auto', transform: 'translateX(-50%)' }
      /* 高度：记忆的 size.h（没有就是默认 74vh）是「期望」，实际渲染时再被输入框
         上沿之上的空间钳一道 —— 只改这一个 style，size / panelSize 的记忆语义完全
         不动，空间恢复后自然回到期望值（拖拽记下的期望高度也照此被钳制但不丢）。
         没量到锚点（anchor 为 null）时一行都不写，维持原样。 */
      const sizeH = parseFloat(size.h)
      const wantH = sizeH > 0 ? sizeH
        : (anchor != null && parseFloat(anchor.vh) > 0 ? Math.round(parseFloat(anchor.vh) * PANEL_DEFAULT_VH) : 0)
      const availH = anchor != null && isFinite(anchor.top)
        ? Math.floor(parseFloat(anchor.top) - PANEL_ANCHOR_GAP - PANEL_ANCHOR_SAFETY)
        : 0
      let panelH = 0
      /* 记忆过高度就照旧写 inline（哪怕空间够，也维持和从前一样的渲染路径）；没记忆
         时只有默认 74vh 真的放不下才写 —— 平时仍交给 CSS，跟随窗口。 */
      if (wantH > 0 && (sizeH > 0 || availH < wantH)) {
        panelH = wantH
        if (availH > 0 && availH < panelH) panelH = availH
        if (panelH < PANEL_MIN_HEIGHT) panelH = PANEL_MIN_HEIGHT
        popProps.style = Object.assign({}, popProps.style, { height: panelH + 'px' })
      }

      return h('div', popProps,
        h('div', { key: 'gn', className: 'dsh-git-grip dsh-git-grip-n', title: '拖动调整高度', onPointerDown: startDrag('n') }),
        h('div', { key: 'gw', className: 'dsh-git-grip dsh-git-grip-w', title: '拖动调整宽度', onPointerDown: startDrag('w') }),
        h('div', { key: 'ge', className: 'dsh-git-grip dsh-git-grip-e', title: '拖动调整宽度', onPointerDown: startDrag('e') }),
        h('div', { key: 'gnw', className: 'dsh-git-grip dsh-git-grip-nw', title: '拖动调整宽高', onPointerDown: startDrag('nw') }),
        h('div', { key: 'gne', className: 'dsh-git-grip dsh-git-grip-ne', title: '拖动调整宽高', onPointerDown: startDrag('ne') }),
        header,
        banner,
        /* 成功条与 error 同一个提示位（一次只说一件事，下一次操作开始时一起清）。也
           pre-wrap：快捷命令的输出本来就是多行的。 */
        okNote.length > 0 ? h('div', { className: 'dsh-git-oknote', style: { padding: '4px 10px', whiteSpace: 'pre-wrap' } }, okNote) : null,
        /* pre-wrap：这条里出现换行的地方都是「那就是两条命令」，折成一行读起来是
           一句话里塞了两条命令。git 自己的多行原话也顺便能按原样读。 */
        error !== null ? h('div', { className: 'dsh-git-error', style: { padding: '4px 10px', whiteSpace: 'pre-wrap' } }, error) : null,
        body,
        /* 快捷命令的确认框与编辑器：面板内覆盖层（盖住正文、不盖掉面板本体），关掉即
           卸载 —— 它们自己的草稿不需要在关掉后还活着。 */
        qcConfirm !== null
          ? h('div', { key: 'qcc', className: 'dsh-git-qc-overlay' },
              h(QuickCommandConfirm, {
                key: 'c', def: qcConfirm, ctx: quickCtx,
                onExecute: runQuick,
                onClose: function () { setQcConfirm(null) },
              }))
          : null,
        qcEditor !== null
          ? h('div', { key: 'qce', className: 'dsh-git-qc-overlay' },
              h(QuickCommandsEditor, {
                key: qcEditor, initial: qcEditor,
                onClose: function () { setQcEditor(null) },
              }))
          : null)
    }

