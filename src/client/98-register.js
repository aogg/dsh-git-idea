
    ctx.effect(function () {
      return slots.inject('conversation.input.left', function () {
        return slots.register({ name: 'conversation.input.left', id: 'dsh-git-idea-chip', order: 10 }, GitChip)
      })
    }, 'dsh-git-idea composer chip')

    ctx.effect(function () {
      return slots.inject('conversation.input.overlay', function () {
        return slots.register({ name: 'conversation.input.overlay', id: 'dsh-git-idea-panel', order: 10 }, GitPopover)
      })
    }, 'dsh-git-idea composer panel')

    /* host→client 的实时通道（真包的 client-pre.js 提供 liveBus）：插件活着连接就活着，
       插件卸载连接断开。bridge 版没有 liveBus（也没有 WS 路由可连），typeof 守卫让它
       安静跳过 —— 没有连接就没有推送，读数的新旧由手动刷新与回可见核对兜住。 */
    ctx.effect(function () {
      if (typeof liveBus !== 'undefined' && liveBus != null && typeof liveBus.open === 'function') liveBus.open()
      return function () {
        if (typeof liveBus !== 'undefined' && liveBus != null && typeof liveBus.close === 'function') liveBus.close()
      }
    }, 'dsh-git-idea live connection')

    /* ── 宿主常驻监听的推送（79-live-watch.js 广播，插件级订阅）──

       完成刷新与仓库变化的「发现」已搬进宿主进程：无论浏览器停在哪个会话视图、
       chip 挂没挂着，这里的订阅都在（它挂在插件生命周期上，不随会话切换卸载）。
       bridge 版没有 liveBus，typeof 守卫安静跳过 —— 三种推送都收不到，chip 自己的
       会话监听照旧，其余靠手动刷新与回可见核对。三种消息：

       · repo-changed：宿主已经失效过自己的读缓存并广播，这里把本地那份读数标成
         「不再证明完整」（markTreePartial）、敲整树重读的铃、bump —— 面板开着就走
         ⟳ 同一条整树路，关着则 chip 的压后全树读接手。repo 形状不对的安静忽略。
       · session-complete：页面藏着记成欠账（30-watch.js），回可见由可见性处理或
         live-open 补发；开着当场跑 runCompleteRefresh —— 与 chip 边沿路径共用同一
         个函数；护栏（92-chip.js）让推送给 5 秒内刚跑过的 chip 那一刷让路，同一次
         完成不会刷两遍。开关（refreshOnComplete）在跑的那一刻再读，与 chip 路径
         同一口径。
       · live-open：连接（重）连上 = 断线期间宿主推的消息丢过 —— 先补欠账，再对
         手头每个 watcher 强制走一拍签名（第一拍只记基线，第二拍起才对比，无害）。 */
    ctx.effect(function () {
      if (typeof liveBus === 'undefined' || liveBus == null || typeof liveBus.subscribe !== 'function') return undefined
      return liveBus.subscribe(function (message) {
        if (message == null || typeof message !== 'object') return
        if (message.kind === 'repo-changed') {
          const repo = typeof message.repo === 'string' ? message.repo : ''
          if (repo.length === 0) return
          markTreePartial(repo)
          ringTreeReload()
          bumpData()
          return
        }
        if (message.kind === 'session-complete') {
          const sessionId = typeof message.sessionId === 'string' ? message.sessionId : ''
          if (sessionId.length === 0) return
          if (pluginConfig.refreshOnComplete !== true) return
          if (livePageHidden() === true) { oweCompleteRefresh(sessionId); return }
          /* suppressible：推送是同一次完成的第二名 —— chip 在场时它必然晚 chip 一步
             到，5 秒内 chip 边沿（或欠账补发）刚刷过就让路（92-chip.js 的护栏）。 */
          runCompleteRefresh(sessionId, true)
          return
        }
        if (message.kind === 'live-open') {
          settleOwedCompleteRefresh()
          watcherTickAll()
          return
        }
      })
    }, 'dsh-git-idea live watch push')
  },
}
