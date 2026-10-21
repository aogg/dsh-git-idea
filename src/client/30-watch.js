    /* ── change monitoring ──

        Freshness is pushed, not polled: the Host watches the repositories and
        announces every change over the live WS channel (src/host/79-live-watch.js
        → the subscription in 98-register.js: repo-changed, session-complete,
        cmdlog-start/exit, live-open). This file only keeps the registry of who
        is listening, plus the one-shot reconciliation tick: watcherTick asks the
        Host for the current signature once and, on a change, flushes the read
        cache and calls the listeners. Ticks fire only from events — a live-open
        (re)connect and the page becoming visible again — never from a timer.
        There is deliberately no interval anywhere and no polling fallback while
        the WS is down (by design): while disconnected the surfaces simply do
        not update by themselves, and the manual refresh keeps working. */

    const repoWatchers = {}
    let watchPageDoc = null

    /* One watcher per *workspace*, and an empty path means "this session's own
        workspace" — the state every panel and chip starts in. Keyed by the path
        alone, that state was a single shared entry: two sessions in one page both
        wrote their id into it, the last one won, and the other session then
        reconciled a stranger's workspace — never noticing its own changes and
        reloading on someone else's. The key says which workspace an entry is,
        and the entry carries what a tick has to ask about, so no tick needs to
        be told. */
    function watcherKey(repo, sessionId) {
      return repo.length > 0 ? repo : 'session:' + text(sessionId)
    }

    function watcherFor(repo, sessionId) {
      const key = watcherKey(repo, sessionId)
      if (repoWatchers[key] === undefined) {
        repoWatchers[key] = {
          key: key, repo: repo, sessionId: sessionId,
          /* Keyed by a token per registration, never by the listener: the chip and
             the panel both want `bumpData` called, and keyed by the function the
             two registrations collapsed into one — so whichever surface was torn
             down first deleted the other's notification too. */
          listeners: new Map(), deep: 0, sig: null, busy: false, paths: null,
        }
      }
      return repoWatchers[key]
    }

    /* What a deep tick asks about. The surface that shows the working tree says
        which paths it is showing (`pathsOfInterest`), and the tick turns that into
        a pathspec: measured on the reader's repository, a whole-tree `git status`
        is 7.4s and the same command over the 36 paths the changes tree was showing
        is 0.5s — the difference between a reconciliation that rests the mount and
        one that pins it for seconds. A watcher that has not been told stays out
        of the working tree until the reader's own full read has something to
        watch. */
    function setWatchPaths(repo, sessionId, paths) {
      const entry = repoWatchers[watcherKey(repo, sessionId)]
      if (entry === undefined) return
      entry.paths = paths != null && paths.length > 0 ? paths.slice() : null
    }

    function watcherTick(entry) {
      if (entry.busy) return
      if (watchPageDoc != null && watchPageDoc.hidden === true) return
      entry.busy = true
      const request = entry.repo.length > 0 ? { repo: entry.repo } : {}
      if (request.repo === undefined && entry.sessionId !== undefined) request.sessionId = entry.sessionId
      /* Only while something is showing the working tree, and only about the
         paths it is showing: the deep signature is the one that notices edits
         inside files, and asked for the whole tree it is seconds on a slow
         mount, every time a tick fires. With nothing to watch the deep half
         stays out of it — the panel reads the whole tree on its own, slower
         clock — and the cheap signature above still carries commits, switches
         and the index. */
      if (entry.deep > 0 && entry.paths != null) {
        request.deep = true
        request.paths = entry.paths
      }
      callHost('git/watch', request).then(function (data) {
        entry.busy = false
        if (data == null || data.ok !== true) return
        const next = text(data.sig)
        if (entry.sig === null || entry.sig === next) { entry.sig = next; return }
        entry.sig = next
        callHost('git/flush', request).catch(function () {})
        /* Map.forEach hands over (value, key): the value is the listener. */
        entry.listeners.forEach(function (listener) { listener() })
      }).catch(function () { entry.busy = false })
    }

    /* Every repository that has someone watching it, right now. Fired only from
        events — the page coming back into view, the live connection (re)opening
        (98-register.js) — to reconcile each watcher against the Host's signature
        once, in case something moved while the tab was hidden or the connection
        was down. The forced tick still asks the signature first, so a page that
        was hidden over lunch reads nothing unless the repository actually
        moved. */
    function watcherTickAll() {
      Object.keys(repoWatchers).forEach(function (key) {
        const entry = repoWatchers[key]
        if (entry.listeners.size > 0) watcherTick(entry)
      })
    }

    /* ── 「会话完成的那一刷」欠着的账（92-chip.js 记，这里在回可见时补）──

        页面藏着时完成的那一刷过去是直接丢掉，理由是「回可见时靠 watcherTickAll 补读
        兜底」。但那条兜底路自己会断：它走 watcherTick 的签名比对，而第一次 tick 只记
        基线不做任何事 —— 一个页面若在整个 agent 干活期间都藏着（真机常态：读者在编辑
        器里，浏览器缩在后台），回可见的那一次 tick 记下的就是提交之后的基线，之前
        丢了什么永远追不回来；真机上 Host 缓存里 ahead 停在十个提交之前的现场，就有
        这一条的份。所以藏起来的那一刷在这里记成欠账（记着是哪个会话完成的），回可见
        先补账、再对签名。 */
    let completeRefreshOwedFor = null
    function oweCompleteRefresh(forSession) {
      completeRefreshOwedFor = forSession
    }
    function settleOwedCompleteRefresh() {
      if (completeRefreshOwedFor == null) return
      const forSession = completeRefreshOwedFor
      completeRefreshOwedFor = null
      runCompleteRefresh(forSession)
    }

    /* 页面此刻藏没藏。watchPageDoc 要等第一个 watcher 挂上才有（watchRepo 记下的
        ownerDocument），在那之前是「不知道」—— 按可见算：宁多刷一遍，不丢一刷。
        宿主推来的 session-complete（98-register.js）在判断页面藏不藏时用的就是它。 */
    function livePageHidden() {
      const doc = watchPageDoc != null ? watchPageDoc : (typeof document !== 'undefined' && document != null ? document : null)
      return doc != null && doc.hidden === true
    }

    function watchRepo(repo, sessionId, listener, deep) {
      const entry = watcherFor(repo, sessionId)
      const token = {}
      entry.listeners.set(token, listener)
      if (deep === true) entry.deep += 1
      if (watchPageDoc == null) {
        const node = chipNode != null ? chipNode : panelNode
        const doc = node != null ? node.ownerDocument : null
        if (doc != null) {
          watchPageDoc = doc
          /* Bound once, with the plugin, so stopping or updating the Package
             takes the listener with it. */
          if (typeof doc.addEventListener === 'function') {
            ctx.effect(function () {
              const onVisibility = function () {
                if (doc.hidden === true) return
                settleOwedCompleteRefresh()
                watcherTickAll()
              }
              doc.addEventListener('visibilitychange', onVisibility)
              return function () { doc.removeEventListener('visibilitychange', onVisibility) }
            }, 'dsh-git-idea visibility watch')
          }
        }
      }
      return function () {
        entry.listeners.delete(token)
        if (deep === true && entry.deep > 0) entry.deep -= 1
        /* Nobody watches this workspace any more: the entry goes with the last
           listener, so a page that walks through many worktrees (the setup page
           tries one path after another) does not keep every one of them. */
        if (entry.listeners.size === 0) delete repoWatchers[entry.key]
      }
    }
