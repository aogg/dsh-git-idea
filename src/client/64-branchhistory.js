    /* ── 分支会话历史：状态的客户端半 ──

       宿主半（79c-branchhistory.js）按工作区 × 分支登记会话、按开关注入历史 id；
       这里管屏幕上两个入口要的状态：

       · chip 分支名右边那只迷你滑块（92-chip.js）：本工作区开没开注入 —— 每会话
         问一次 git/branch-history-config（fire-and-forget，失败安静），答复到了
         自动翻正；点一下乐观更新 + git/branch-history-switch，失败回滚。
       · 配置页「分支会话历史」组（80-panel.js）：当前分支、生效状态、已配提示词
         的分支与每支会话数 —— 它进页时要的是「现在」，走 refresh（强制重问）。

       状态按 sessionId 记在内存（面板与 chip 本来就按会话各看各的），跨会话不共享、
       刷新页面重来 —— 真账在部署配置的 dsh-git-idea.json 里，这里只是它的一面镜子。
       通知走 10-state.js 的 createSignal：读的是版本号，谁改了账谁 bump。 */

    let branchHistoryVersion = 0
    const branchHistorySignal = createSignal(function () { return branchHistoryVersion })
    const useBranchHistoryVersion = branchHistorySignal.use

    function bumpBranchHistory() {
      branchHistoryVersion += 1
      branchHistorySignal.notify()
    }

    /* sessionId → 答复的镜像。形状：{workspace, defaultOn, maxSessions, on,
       effective, branch, prompts, counts, at}。 */
    const branchHistoryStates = new Map()
    /* 每会话只问一次的「问过了」账：成功就留着（本页生命周期内不再问），失败摘掉
       （下次挂载重试）；refresh 走旁路。 */
    const branchHistoryAsked = new Set()

    function branchHistoryGlobalDefault() {
      return pluginConfig != null && pluginConfig.branchHistory != null
        && typeof pluginConfig.branchHistory === 'object'
        && pluginConfig.branchHistory.defaultOn === true
    }

    function branchHistoryStateFor(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      const found = branchHistoryStates.get(sessionId)
      return found != null ? found : null
    }

    /* 把一次答复并进账。缺省字段沿用旧值（switch 与 prompt-save 的答复只带变化
       的那几格），首次答复落到兜底形状 —— 测试桩的通用 {ok:true} 也画得出灰态。 */
    function adoptBranchHistoryReply(sessionId, reply) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      if (reply == null || typeof reply !== 'object' || reply.ok !== true) return
      const previous = branchHistoryStates.get(sessionId)
      const fallbackDefault = branchHistoryGlobalDefault()
      const base = previous != null ? previous : {
        workspace: '', defaultOn: fallbackDefault, maxSessions: 20, on: null,
        effective: fallbackDefault, branch: '', prompts: {}, counts: {}, at: 0,
      }
      const prompts = reply.prompts != null && typeof reply.prompts === 'object' && !Array.isArray(reply.prompts)
        ? reply.prompts : base.prompts
      const counts = reply.counts != null && typeof reply.counts === 'object' && !Array.isArray(reply.counts)
        ? reply.counts : base.counts
      const on = typeof reply.on === 'boolean' ? reply.on
        : (reply.on === null || previous == null ? null : base.on)
      const defaultOn = typeof reply.defaultOn === 'boolean' ? reply.defaultOn : base.defaultOn
      const maxSessions = typeof reply.maxSessions === 'number' && isFinite(reply.maxSessions) && reply.maxSessions >= 1
        ? reply.maxSessions : base.maxSessions
      const effective = typeof reply.effective === 'boolean' ? reply.effective
        : (typeof on === 'boolean' ? on : defaultOn)
      branchHistoryStates.set(sessionId, {
        workspace: typeof reply.workspace === 'string' ? reply.workspace : base.workspace,
        defaultOn: defaultOn,
        maxSessions: maxSessions,
        on: on,
        effective: effective,
        branch: typeof reply.branch === 'string' ? reply.branch : base.branch,
        prompts: prompts,
        counts: counts,
        at: Date.now(),
      })
      bumpBranchHistory()
    }

    /* 问一次（内部共用）。asked 记号在发出前置位（一次渲染多次调用只发一条），
       失败摘掉；callHost 自己带宿主未就绪的重试，其余失败安静。 */
    function askBranchHistoryState(sessionId, markAsked) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      if (markAsked === true) {
        if (branchHistoryAsked.has(sessionId)) return
        branchHistoryAsked.add(sessionId)
      }
      let pending
      try {
        pending = callHost('git/branch-history-config', { sessionId: sessionId })
      } catch (error) {
        branchHistoryAsked.delete(sessionId)
        return
      }
      Promise.resolve(pending).then(function (reply) {
        adoptBranchHistoryReply(sessionId, reply)
      }, function () {
        branchHistoryAsked.delete(sessionId)
      })
    }

    /* chip 的入口：每会话一次，fire-and-forget。 */
    function loadBranchHistoryState(sessionId) {
      askBranchHistoryState(sessionId, true)
    }

    /* 配置页的入口：进页与保存回来后强制重问，拿「现在」的 prompts/counts。 */
    function refreshBranchHistoryState(sessionId) {
      askBranchHistoryState(sessionId, false)
    }

    /* 开关：乐观更新 → 发写 → 成功采纳答复 / 失败回滚（滑块没有报错的位置，
       静默回到点击前的样子 —— 再点一次就是重试）。next 取 true / false / 'reset'。 */
    function switchBranchHistory(sessionId, next) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const previous = branchHistoryStates.get(sessionId)
      const fallbackDefault = branchHistoryGlobalDefault()
      const reset = next === 'reset'
      const optimisticOn = reset ? null : next === true
      const optimisticEffective = reset ? fallbackDefault : optimisticOn
      const base = previous != null ? previous : {
        workspace: '', defaultOn: fallbackDefault, maxSessions: 20, on: null,
        effective: fallbackDefault, branch: '', prompts: {}, counts: {}, at: 0,
      }
      branchHistoryStates.set(sessionId, Object.assign({}, base, { on: optimisticOn, effective: optimisticEffective }))
      bumpBranchHistory()
      const payload = reset ? { sessionId: sessionId, reset: true } : { sessionId: sessionId, on: optimisticOn }
      const rollback = function () {
        if (previous != null) branchHistoryStates.set(sessionId, previous)
        else branchHistoryStates.delete(sessionId)
        bumpBranchHistory()
      }
      let pending
      try {
        pending = callHost('git/branch-history-switch', payload)
      } catch (error) {
        rollback()
        return
      }
      Promise.resolve(pending).then(function (reply) {
        if (reply != null && typeof reply === 'object' && reply.ok === true) {
          adoptBranchHistoryReply(sessionId, reply)
          return
        }
        rollback()
      }, function () {
        rollback()
      })
    }

    /* chip 滑块本体（92-chip.js 把它挂在最左、分支图标之前）：纯 span + CSS 的迷你
       开关，宽 22px 高 12px（46-css.js 的 dsh-git-chip-switch）。点击 stopPropagation
       —— chip 本体是 button，别让它把面板开合也带出来。 */
    function branchHistoryChipSwitch(sessionId) {
      const state = branchHistoryStateFor(sessionId)
      const known = state != null
      const on = known ? state.effective === true : branchHistoryGlobalDefault()
      const hasSession = typeof sessionId === 'string' && sessionId.length > 0
      const dim = known !== true || hasSession === false
      return h('span', {
        className: 'dsh-git-chip-switch' + (on ? ' dsh-git-chip-switch-on' : '')
          + (dim ? ' dsh-git-chip-switch-unknown' : ''),
        role: 'button',
        'aria-pressed': on === true,
        title: '分支会话历史（当前' + (on ? '开' : '关') + (known !== true ? '，暂按全局默认显示' : '')
          + '）：开启后本工作区每个新对话自动附带本分支的历史会话 id（跨浏览器生效）',
        onClick: function (event) {
          stopEvent(event)
          if (hasSession === false) return
          switchBranchHistory(sessionId, on !== true)
        },
      })
    }
