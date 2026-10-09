    function text(value) {
      return typeof value === 'string' ? value : ''
    }

    /* Whatever was thrown, said in one line. Every catch in this file wants the
       same sentence, and the shape it guards against — a rejection that is a
       string rather than an Error — is the one that would otherwise print
       "undefined". */
    function failureText(failure) {
      return String(failure != null && failure.message !== undefined ? failure.message : failure)
    }

    /* ── asking the Host ──

       One door to the Host, because there is one thing every call has to survive:
       the Host half of the bridge reads its own source file when the plugin
       starts, and this half can be mounted before that read lands. A call that
       arrives first is refused with "... is not registered" — it never reached a
       handler, so it is safe to ask again a moment later. Without this the panel
       mounts, every request it makes is refused once, and it stays empty until
       something happens to re-read.

       The retry is deliberately finite: a Host that is genuinely gone has to end
       as an error the reader can see, not as a request that never comes back. */
    const HOST_NOT_READY = 'is not registered'
    const HOST_RETRY_MAX = 24
    const HOST_RETRY_MS = 120

    function hostWait(ms) {
      return new Promise(function (resolve) {
        const timer = ctx.get('timer')
        if (timer === undefined) { resolve(); return }
        timer.timeout(function () { resolve() }, ms)
      })
    }

    function callHost(method, payload, left) {
      return host.call(method, payload).catch(function (failure) {
        const remaining = left === undefined ? HOST_RETRY_MAX : left
        const waiting = remaining > 0 && failureText(failure).indexOf(HOST_NOT_READY) >= 0
        if (waiting !== true) throw failure
        return hostWait(HOST_RETRY_MS).then(function () { return callHost(method, payload, remaining - 1) })
      })
    }

    /* A command that ran and failed is not a transport error either: the Host
       answers `{ok:false, stderr}` because git's own sentence is what the reader
       needs to see. So every operation had two failure paths to write — the
       `ok !== true` branch and the `catch` — and they forget different things (a
       busy flag, a reload, the armed-delete row). This collapses them: the
       failure arrives at one handler, carrying git's words as the Error message.

       The whole reply stays reachable as `failure.reply` for the callers that
       have to look further — `stashed`, `popConflict`, `error`. A transport
       failure has no `reply`, which is how `undefined` here came to mean "the
       Host never answered". (`commandDetail` is defined further down; the two are
       both function declarations in this one scope, so order does not matter.) */
    function rpc(method, payload, fallback) {
      return callHost(method, payload).then(function (result) {
        if (result != null && result.ok === true) return result
        const failure = new Error(commandDetail(result) || fallback || '操作失败')
        failure.reply = result
        failure.method = method
        throw failure
      }, function (transport) {
        const failure = new Error(failureText(transport))
        failure.method = method
        throw failure
      })
    }

    /* ── one signal, seven of them ──

       Every piece of state that two surfaces have to agree on is the same three
       things: a value, a set of listeners, and a hook that re-renders its
       component when one of them fires. Written out seven times, that is seven
       chances for a notification to be forgotten on one path and sent twice on
       another — and it was, in both directions. It is written once here; what
       differs between the seven (whether an identical value may be set again,
       where the value is persisted, whether it counts or holds) stays in the
       section that owns it.

       The reader is a function rather than a value, so the variable each section
       already keeps — `open`, `panelSize`, `gitSettings` — stays the truth and
       every existing read of it stays a plain read. */
    function createSignal(read) {
      const listeners = new Set()
      const signal = {
        /* Tell everyone. Called by whoever just changed the value, never by the
           subscribers, so a notification always follows a real change. */
        notify: function () {
          listeners.forEach(function (listener) { listener() })
        },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        /* The React face of the signal: read the value when the signal fires,
           never the one this render closed over. */
        use: function () {
          const pair = React.useState(read())
          React.useEffect(function () {
            return signal.subscribe(function () { pair[1](read()) })
          }, [])
          return pair[0]
        },
      }
      return signal
    }

    /* ── the browser's own storage ──

       A page can refuse storage at any point — private mode, a sandboxed frame,
       a quota — and not one of the preferences below is worth breaking the panel
       over. So every read and write goes through here, the try/catch lives here,
       and the sections above only name a key.

       The first document that hands over a panel or chip node is kept, because a
       save can happen long after the node that prompted it is gone. */
    let settingsDoc = null

    function localStore(doc) {
      if (doc != null && settingsDoc == null) settingsDoc = doc
      if (settingsDoc == null) return null
      try {
        const view = settingsDoc.defaultView
        return view != null ? view.localStorage : null
      } catch (error) {
        return null
      }
    }

    function readStored(key) {
      const store = localStore(null)
      if (store == null) return null
      try {
        return store.getItem(key)
      } catch (error) {
        return null
      }
    }

    function writeStored(key, value) {
      const store = localStore(null)
      if (store == null) return
      try {
        store.setItem(key, value)
      } catch (error) {
        /* a refused preference is not worth breaking the panel over */
      }
    }

    function readStoredJSON(key, fallback) {
      const raw = readStored(key)
      if (raw == null) return fallback
      try {
        return JSON.parse(raw)
      } catch (error) {
        return fallback
      }
    }

    function writeStoredJSON(key, value) {
      writeStored(key, JSON.stringify(value))
    }

    /* Whether the panel is open at all: the composer chip and the panel are two
       components racing to be the same answer. */
    let open = false
    const openSignal = createSignal(function () { return open })
    const setOpen = function (next) {
      if (open === next) return
      open = next
      openSignal.notify()
    }
    const useOpen = openSignal.use

    let chipNode = null
    let panelNode = null
    let everOpened = false

    /* One version counter for "the repository moved", shared by every surface
       that shows it. A switch made from the hover card happens while the panel
       is closed and the chip is the only thing on screen, so a counter owned by
       one component would leave the other one naming the branch it used to be
       on; and the panel itself stays mounted now, so it has to hear about a
       change that happened while it was hidden. */
    let dataVersion = 0
    const dataSignal = createSignal(function () { return dataVersion })
    const bumpData = function () {
      dataVersion += 1
      dataSignal.notify()
    }
    const useDataVersion = dataSignal.use

    /* ── 「有会话刚跑完，去把整棵树重新量一遍」的那声铃 ──

       chip 听 DSH 的会话状态（92-chip.js），但「整棵树重读」的原语一半住在面板里
       （panelBox.needFull 才决定下一次读是全树还是只问屏上那几条路径）：铃只负责
       喊，面板听见后自己把 needFull 立起来、走 ⟳ 同一条读路。计一个数而不是布爾，
       连着的两次完成才不会被合并成一次没喊过。 */
    let treeReloadBell = 0
    const treeReloadSignal = createSignal(function () { return treeReloadBell })
    const ringTreeReload = function () {
      treeReloadBell += 1
      treeReloadSignal.notify()
    }
    const useTreeReload = treeReloadSignal.use

    /* ── 最近一次自动推送 ──

       「所有会话都完成」那一推（92-chip.js）在面板关着时也会发生，而结果要说给
       「配置」页的那行状态听 —— 两头不住在同一个组件里，所以是模块级的一份：
       {time, ok, detail}，null = 从来没推过。 */
    let autoPush = null
    const autoPushSignal = createSignal(function () { return autoPush })
    const setAutoPush = function (next) {
      autoPush = next
      autoPushSignal.notify()
    }
    const useAutoPush = autoPushSignal.use

    /* ── a read that is no longer wanted ──

       A read takes as long as the mount makes it take — seconds, on the reader's
       — and the reader can act while it is in flight. The reply that lands
       afterwards describes the repository as it was BEFORE that action, so
       painting it undoes what the reader just did: the box they ticked goes back
       to empty, which reads as "点一下没反应" and then as the tick being lost.

       Every mutation bumps this counter for its workspace, and a read remembers
       the number it started with. A reply whose number has moved on is dropped;
       the read that replaces it starts after the mutation and is wanted. */
    const repoEpochs = {}
    function repoEpochKey(repo, sessionId) {
      return text(repo) + '\u0000' + text(sessionId)
    }
    function repoEpoch(repo, sessionId) {
      const value = repoEpochs[repoEpochKey(repo, sessionId)]
      return value === undefined ? 0 : value
    }
    function bumpRepoEpoch(repo, sessionId) {
      repoEpochs[repoEpochKey(repo, sessionId)] = repoEpoch(repo, sessionId) + 1
    }

    /* ── 工作区读数：整个插件只有一份 ──

       `git status` 全树在这台机器上就是几秒（读者那个 /mnt/d 工作区、5093 个文件：
       8.1s 冷，`-uno` 也要 5.3s），而这条 RPC 通道一次只跑一个处理函数 —— 一次全树读
       在飞的时候，屏幕上每一次点击、另一块屏幕的每一次读，全都排在它后面。真机上量到
       的是：终端里提交一次（引用变了），队列 18–21s 才排空，其中 13s 是两次全树读；
       面板关着时那一次也要 10.6s，而屏幕上看到的就是「点了没反应」。

       所以「工作区现在什么样」全局只留一份：谁读到的都写在这里，面板和 chip 都从这一
       份渲染 —— 两块屏幕于是不可能各说各话，也不会各量一遍（同一个问题在 Host 那边本来
       也只会起一个进程）。一条记录里四样东西各有各的用处：

         status  最后一次合并好的工作区快照（和面板「变更」页上那份是同一个东西）
         at      最后一次**任何**读数的时刻（全树，或只问屏上那几条路径）
         fullAt  最后一次**全树**读数的时刻：只有它证明这份快照是完整的
         costMs  那次全树读占住通道多久；下一次该隔多久由它决定                      */
    const treeReads = {}
    let treeVersion = 0
    const treeSignal = createSignal(function () { return treeVersion })
    const useTreeVersion = treeSignal.use

    function treeRecord(repo) {
      const found = treeReads[repo]
      return found === undefined ? null : found
    }

    function treeCount(repo) {
      const record = treeRecord(repo)
      return record === null ? 0 : record.count
    }

    /* ── 换会话时，先铺上已经知道的那一份 ──

       面板属于会话，DSH 在换会话时会把整个 session 作用域的 slot 子树重挂（组件
       state 从头来，见 dsh-client-ui-renderer 的 SessionMaybeEntry / StrictSessionEntry）。
       但"重挂"不等于"要重新测"：这份工作区读数按**仓库**记在这里，Host 那边每一次读
       也是按仓库缓存的 —— 同一个工作区里换会话，拿到的本来就是同一份答案。

       所以重挂时先把记忆里的快照交出去，屏幕上就不会先闪一帧「正在读取仓库…」再换成
       同样的东西；挂载时那次读照旧发出，用它的答复确认或纠正（见 80-panel.js）。

       只有过一次**整树**读的记录才算数（fullAt !== 0）：只问了几条路径的读不足以
       证明这份快照的其余部分是完整的，那种情况宁可照旧从空的开始。仓库的路径取这个
       会话真正会请求的那个 —— 应用过的路径优先，其次才是 Host 上次解析出来的工作区。 */
    function rememberedPanel(sessionId) {
      const applied = sessionRepo(sessionId)
      const repo = applied.length > 0 ? applied : chipInfoFor(sessionId).repo
      if (repo.length === 0) return null
      const record = treeRecord(repo)
      if (record === null || record.status == null || record.fullAt === 0) return null
      return { repo: repo, status: record.status, costMs: record.costMs }
    }

    function publishTreeRead(repo, status, full, costMs) {
      if (repo == null || repo.length === 0 || status == null || status.ok !== true) return
      const previous = treeRecord(repo)
      const now = Date.now()
      treeReads[repo] = {
        status: status,
        count: mergeChanges(status).length,
        at: now,
        fullAt: full === true ? now : (previous === null ? 0 : previous.fullAt),
        costMs: typeof costMs === 'number' && isFinite(costMs) && costMs >= 0
          ? costMs
          : (previous === null ? 0 : previous.costMs),
      }
      treeVersion += 1
      treeSignal.notify()
    }

    /* 一次全树读之后，隔多久才值得再来一次：它占住整条通道 costMs 毫秒，那就让空档至少
       是它的 8 倍。量得快的仓库照旧 30 秒一次；慢挂载上不会每 30 秒冻 8 秒（上限 5 分钟）。 */
    const FULL_READ_FLOOR_MS = 30000
    const FULL_READ_CEIL_MS = 300000
    const FULL_READ_FACTOR = 8
    function fullReadGapMs(costMs) {
      const cost = typeof costMs === 'number' && isFinite(costMs) && costMs > 0 ? costMs : 0
      const wanted = Math.round(cost * FULL_READ_FACTOR)
      if (wanted <= FULL_READ_FLOOR_MS) return FULL_READ_FLOOR_MS
      return wanted > FULL_READ_CEIL_MS ? FULL_READ_CEIL_MS : wanted
    }

    /* 这份快照还完整吗：true 表示该有人再整棵树量一次。 */
    function treeReadDue(repo) {
      const record = treeRecord(repo)
      if (record === null || record.fullAt === 0) return true
      return Date.now() - record.fullAt >= fullReadGapMs(record.costMs)
    }

    /* 会话刚动过这个仓库（92-chip.js 的完成监听）：那份全树读数从这一刻起不再能
       证明自己是完整的 —— 会话新建的文件只有全树读看得见，而快照里的脏路径清单
       还是旧的。把 fullAt 记成 0 就是这个意思（treeReadDue 因此答 true，chip 也照
       实改口「正在核对」），比丢掉整份快照好：屏上那些旧路径仍然问得动，整树读
       落地之前界面不至于闪一帧空。 */
    function markTreePartial(repo) {
      const record = treeRecord(repo)
      if (record === null || record.fullAt === 0) return
      treeReads[repo] = Object.assign({}, record, { fullAt: 0 })
      treeVersion += 1
      treeSignal.notify()
    }

    /* 有一次**会改变那个数字**的读正在飞（这个仓库）—— 全树读，或者只问几条路径的那种
       都算。它落地之前，屏幕上那个数字不能当成「刚刚核对过」：chip 这时说的是
       「正在核对」，而不是继续报一个它还没验证过的数字。 */
    const treeReadings = {}
    function treeCountReadStart(repo) {
      if (repo == null || repo.length === 0) return function () {}
      treeReadings[repo] = (treeReadings[repo] === undefined ? 0 : treeReadings[repo]) + 1
      treeVersion += 1
      treeSignal.notify()
      let done = false
      return function () {
        if (done) return
        done = true
        if (treeReadings[repo] > 0) treeReadings[repo] -= 1
        treeVersion += 1
        treeSignal.notify()
      }
    }

    function treeCountReading(repo) {
      return repo != null && repo.length > 0 && treeReadings[repo] !== undefined && treeReadings[repo] > 0
    }

    /* 上一次全树读里那些脏路径。一次 bump 之后拿它问一次（0.2s）就能把屏幕上那份快照
       更新掉 —— 提交之后那几个文件就是这样立刻消失的，而不是等一次新的全树读。 */
    function treeReadPaths(repo) {
      const record = treeRecord(repo)
      if (record === null || record.status == null) return []
      return pathsOfInterest(record.status, repo)
    }

    /* 一条路径读比这个还贵，就说明父目录那一层把大树扫进去了：这个仓库从此只问那几条
       路径本身。读者那个仓库（Windows 挂载）上，12 条含父目录 6138ms、9 条不含 295ms。 */
    const PATHS_READ_MAX_MS = 1500

    /* 一次「只问屏上那几条路径」的读花了多久。父目录那一层（为了「改动文件旁边新出现的
       文件」）在某些仓库上会把旁边整棵大树扫一遍 —— 量到一次超时就收窄，只问那几条路径
       本身（见 52-detail.js 里的数）。 */
    const treeNarrowed = {}
    function treeWide(repo) {
      return treeNarrowed[repo] !== true
    }

    function pathsReadSpent(repo, ms) {
      if (repo == null || repo.length === 0 || treeNarrowed[repo] === true) return
      if (!(typeof ms === 'number' && isFinite(ms) && ms >= PATHS_READ_MAX_MS)) return
      treeNarrowed[repo] = true
      treeVersion += 1
      treeSignal.notify()
    }

    /* Which switcher is showing, if either: the dropdown hanging off the panel
       header's branch chip ('panel'), or the card the composer chip opens on
       hover ('hover'). One at a time, never both with the panel. */
    let switchMode = null
    let switcherNode = null
    const switchSignal = createSignal(function () { return switchMode })
    const setSwitchMode = function (next) {
      if (switchMode === next) return
      switchMode = next
      switchSignal.notify()
    }
    const useSwitchMode = switchSignal.use

    /* Hover is a promise the pointer can break at any moment, so opening waits
       (a pointer crossing the composer on its way somewhere else must not open
       anything) and closing waits too, or the card would vanish in the gap
       between the chip and itself. */
    let hoverTimer = null
    function clearHoverTimer() {
      if (hoverTimer != null) { hoverTimer(); hoverTimer = null }
    }
    function hoverOpenSoon() {
      clearHoverTimer()
      if (switchMode !== null) return
      const timer = ctx.get('timer')
      if (timer === undefined) return
      hoverTimer = timer.timeout(function () {
        hoverTimer = null
        if (switchMode === null) setSwitchMode('hover')
      }, 180)
    }
    /* ── the branch being switched to ──

       A signal, unlike `switchBusy` below: the composer chip and the panel's branch
       chip have to *repaint* while the switch is in flight, and a module-level flag
       reaches nobody. Null means nothing is moving; a name means that is where we
       are going. */
    let switchingTo = null
    const switchingSignal = createSignal(function () { return switchingTo })
    const setSwitchingTo = function (next) {
      if (switchingTo === next) return
      switchingTo = next
      switchingSignal.notify()
    }
    const useSwitchingTo = switchingSignal.use

    /* Set by the switcher while one of its operations is in flight. Clicking
       "check out" collapses the flyout under the pointer, which counts as
       leaving the card — without this the card closed itself 200ms later and
       the checkout's own answer (the new branch, or why it failed) was thrown
       away unread, which looks exactly like the click doing nothing. */
    let switchBusy = false

    function hoverCloseSoon() {
      clearHoverTimer()
      if (switchMode !== 'hover') return
      if (switchBusy === true) return
      const timer = ctx.get('timer')
      if (timer === undefined) { setSwitchMode(null); return }
      hoverTimer = timer.timeout(function () {
        hoverTimer = null
        if (switchMode === 'hover') setSwitchMode(null)
      }, 200)
    }

    /* The applied repository path is remembered per session, never in one
       global slot: one page can host several sessions, and a path applied in
       one workspace must not decide what the chip asks about in another. An
       empty entry means "nothing was applied here", which makes the Host fall
       back to that session's own working directory. */
    const sharedRepos = {}
    /* …and a signal for "that changed", because the panel keeps its own copy in
       state while the chip and the hover card read this one: a surface that keeps
       rendering a value no signal carries on about keeps reading and watching the
       workspace it was first told about. */
    let repoApplied = 0
    const repoAppliedSignal = createSignal(function () { return repoApplied })
    const useRepoApplied = repoAppliedSignal.use

    /* The same answer for the one surface that has no session of its own: the
       settings page is global, so it cannot name a session — and it must not name
       a *path* either, because the Host is the one that resolves a session's
       workspace (see `repoFrom` in the Host half). So what is remembered here is
       only the id, and the settings page hands that back to the Host: the same
       resolution, the same sandbox policy, one source of truth. */
    let lastSessionId = ''
    const lastSessionSignal = createSignal(function () { return lastSessionId })
    const useLastSession = lastSessionSignal.use

    function rememberSession(sessionId) {
      if (sessionId === undefined || sessionId === null) return
      const one = String(sessionId)
      if (one.length === 0 || one === lastSessionId) return
      lastSessionId = one
      lastSessionSignal.notify()
    }

    function sessionRepo(sessionId) {
      if (sessionId === undefined || sessionId === null) return ''
      const value = sharedRepos[sessionId]
      return typeof value === 'string' ? value : ''
    }
    function rememberRepo(sessionId, next) {
      if (sessionId === undefined || sessionId === null) return
      const previous = sessionRepo(sessionId)
      if (next.length > 0) sharedRepos[sessionId] = next
      else delete sharedRepos[sessionId]
      if (previous === next) return
      repoApplied += 1
      repoAppliedSignal.notify()
    }

    /* ── panel geometry ──

       Zero means "follow the composer width / 74vh", which stays the default;
       the first drag switches to explicit pixels, and the size is remembered
       through localStorage when the page exposes one. */
    const PANEL_SIZE_KEY = 'dsh.git-idea.panel'
    let panelSize = { w: 0, h: 0 }
    let panelSizeLoaded = false
    const panelSizeSignal = createSignal(function () { return panelSize })

    function publishPanelSize(next) {
      panelSize = next
      panelSizeSignal.notify()
    }

    function loadPanelSize(doc) {
      if (panelSizeLoaded) return
      panelSizeLoaded = true
      localStore(doc)
      const parsed = readStoredJSON(PANEL_SIZE_KEY, null)
      if (parsed != null && typeof parsed.w === 'number' && typeof parsed.h === 'number') {
        panelSize = { w: parsed.w, h: parsed.h }
      }
    }

    function savePanelSize() {
      writeStoredJSON(PANEL_SIZE_KEY, panelSize)
    }
