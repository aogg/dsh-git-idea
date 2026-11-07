    /* ─────────────── GitHub Actions 页签（客户端半）───────────────

       「Actions」tab 的正文。数据的门只有一条 RPC（git/gh-actions）：宿主按
       「ghRepos 覆盖 → origin 解析」定 owner/repo、替这里去问 api.github.com，答复
       带 runs（每行的 path 是 workflow yaml 的路径 —— ghWorkflows 的过滤就用它与
       这份配置里的路径做等值比较，零额外请求）、配额剩余与授权状态。

       刷新只挂在两个事件上（宿主半没有定时器，这里也没有 interval）：
         · 打开页签时自动刷一次 —— 且仅在已授权时（ghToken 有哨兵或真值）；
           未授权时只有手动 ⟳，匿名读公共仓库（60 次/小时）。
         · 会话完成时刷一次 —— 98-register.js 的 liveBus 订阅在 session-complete
           分支里调 ghCompleteRefresh()，面板没开着它就是空操作。
       设备码「网页授权」的节奏同样由读者的手指驱动：每点一次「继续」问一次
       GitHub，pending 就再点、slow_down 就等一等 —— 没有后台常驻轮询。 */

    /* client 半没有 host 那个 isStr（10-shell.js 的，两个构建不共作用域）；这里
       给一个同款，只服务 GitHub 这几个文件（71-gh-pane.js 与 80-panel.js 里
       GitHub 那几段）。 */
    function ghIsStr(value) {
      return typeof value === 'string'
    }

    /* 授权判定：ghToken 是非空字符串（手贴的真值，保存前的瞬时态）或哨兵对象
       （{saved:true, tail} —— 宿主存着 token 的样子）都算已授权。 */
    function ghTokenAuthorized(config) {
      const token = config != null ? config.ghToken : null
      if (typeof token === 'string') return token.length > 0
      if (token != null && typeof token === 'object' && typeof token.saved === 'boolean') return token.saved === true
      return false
    }

    /* token 的展示形态：哨兵带尾 4 位。 */
    function ghTokenTail(config) {
      const token = config != null ? config.ghToken : null
      if (token != null && typeof token === 'object' && ghIsStr(token.tail) && token.tail.length > 0) return token.tail
      if (typeof token === 'string' && token.length >= 4) return token.slice(-4)
      return ''
    }

    /* 「origin 是不是 github.com」：Actions 页签显不显示的判定。这里只判主机形状
       （三种远端写法都认），owner/repo 的拆解归宿主 —— 解析只有一份（host
       71-gh-http.js 的 ghOwnerRepoOfUrl），两边不会漂移。 */
    function ghRemoteIsGithub(url) {
      const raw = ghIsStr(url) ? url.trim() : ''
      if (raw.length === 0) return false
      const at = raw.indexOf('github.com/')
      if (at >= 0 && (at === 0 || /[:/@]/.test(raw.charAt(at - 1)))) return true
      return raw.indexOf('github.com:') >= 0
    }

    /* remotesSnapshot 的清单里有没有 GitHub 远端：origin 优先，没有再试其余。 */
    function ghRemotesHaveGithub(remotes) {
      const list = Array.isArray(remotes) ? remotes : []
      const originRows = []
      const otherRows = []
      for (let i = 0; i < list.length; i += 1) {
        const one = list[i]
        if (one == null || typeof one !== 'object') continue
        const holder = one.name === 'origin' ? originRows : otherRows
        if (ghIsStr(one.url) && ghRemoteIsGithub(one.url)) holder.push(one.url)
        if (ghIsStr(one.pushUrl) && one.pushUrl !== one.url && ghRemoteIsGithub(one.pushUrl)) holder.push(one.pushUrl)
      }
      return originRows.length > 0 || otherRows.length > 0
    }

    /* ghRepos 里这个工作区配的覆盖（空串 = 没配）。键照 appliedRepos 的口径 ——
       生效仓库的绝对路径（repoKeyOf 式的尾斜杠在客户端不裁，配置页写入时已经是
       Host 解出的仓库根；读不到时两个写法各查一次，都能中）。 */
    function ghOverrideOfConfig(config, workspace) {
      const map = config != null && config.ghRepos != null && typeof config.ghRepos === 'object' && !Array.isArray(config.ghRepos) ? config.ghRepos : {}
      const key = ghIsStr(workspace) ? workspace : ''
      if (key.length === 0) return ''
      const direct = map[key]
      if (typeof direct === 'string' && direct.length > 0) return direct
      const trimmed = map[key.replace(/\/+$/, '')]
      return typeof trimmed === 'string' ? trimmed : ''
    }

    function ghWorkflowsOfConfig(config, workspace) {
      const map = config != null && config.ghWorkflows != null && typeof config.ghWorkflows === 'object' && !Array.isArray(config.ghWorkflows) ? config.ghWorkflows : {}
      const list = typeof workspace === 'string' && workspace.length > 0 ? map[workspace] : null
      return Array.isArray(list) ? list : []
    }

    /* 相对时间：created_at 是 ISO 串。今天的几秒前到几天前都说人话，更老落到
       cmdClock 的「年-月-日 时:分」（同一把钳子，两页长得一样）。 */
    function ghRelTime(value) {
      if (typeof value !== 'string' || value.length === 0) return ''
      const at = new Date(value)
      if (isNaN(at.getTime())) return ''
      const diff = Date.now() - at.getTime()
      if (diff < 0) return '刚刚'
      const seconds = Math.floor(diff / 1000)
      if (seconds < 60) return String(seconds) + ' 秒前'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return String(minutes) + ' 分钟前'
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return String(hours) + ' 小时前'
      const days = Math.floor(hours / 24)
      if (days < 30) return String(days) + ' 天前'
      return cmdClock(at.getTime())
    }

    /* 一次 run 的徽标：status 是「现在」，conclusion 是「跑完了」。先看跑完没有，
       再看还在不在跑。 */
    function ghBadgeOf(run) {
      const status = run != null && ghIsStr(run.status) ? run.status : ''
      const conclusion = run != null && ghIsStr(run.conclusion) ? run.conclusion : ''
      if (conclusion === 'success') return { label: '成功', cls: 'ok' }
      if (conclusion === 'failure') return { label: '失败', cls: 'fail' }
      if (conclusion === 'timed_out') return { label: '超时', cls: 'fail' }
      if (conclusion === 'cancelled') return { label: '已取消', cls: 'cancel' }
      if (conclusion === 'skipped') return { label: '跳过', cls: 'skip' }
      if (conclusion === 'action_required' || conclusion === 'neutral') return { label: '待处理', cls: 'queue' }
      if (status === 'in_progress') return { label: '运行中', cls: 'run' }
      if (status === 'queued' || status === 'waiting' || status === 'requested' || status === 'pending') return { label: '排队', cls: 'queue' }
      if (status === 'completed') return { label: '完成', cls: 'ok' }
      return { label: status.length > 0 ? status : (conclusion.length > 0 ? conclusion : '未知'), cls: '' }
    }

    /* 答复 error 的人话。404 的这句是定稿的（任务口径）：私有仓库匿名一律 404。 */
    function ghProblemOf(data) {
      const kind = data != null && ghIsStr(data.error) ? data.error : ''
      const detail = data != null && ghIsStr(data.detail) ? data.detail : ''
      if (kind === 'unauthorized') return 'GitHub 说这个 token 无效（401）：去全局配置档「GitHub 授权」里换一个有效的 token'
      if (kind === 'forbidden') return 'GitHub 拒绝了这次请求（403）：token 可能没有这个仓库的权限，或者它还没有被授权给这个组织的 SSO'
      if (kind === 'rate-limited') {
        const reset = data != null && ghIsStr(data.rateReset) && data.rateReset.length > 0 ? parseFloat(data.rateReset) : NaN
        const when = isNaN(reset) === false && reset > 0 ? new Date(reset * 1000).toLocaleTimeString() : ''
        return 'GitHub API 配额已用尽' + (when.length > 0 ? '，' + when + ' 重置' : '') + '（匿名 60 次/小时，带 token 5000 次/小时）'
      }
      if (kind === 'not-found') return '读不到该仓库：可能是私有仓库（去全局配置加授权）或路径不存在'
      if (kind === 'http') return 'GitHub 返回了 HTTP ' + (data != null && typeof data.httpStatus === 'number' ? String(data.httpStatus) : '错误')
      if (kind === 'network') return '连不上 api.github.com' + (detail.length > 0 ? '：' + detail : '')
      if (kind === 'timeout') return 'GitHub 的答复超时了，再试一次'
      if (kind === 'remote-failed') return '远端清单没读出来：' + (data != null && ghIsStr(data.stderr) ? data.stderr : '未知原因')
      return detail.length > 0 ? detail : 'GitHub 的这次请求没有成功'
    }

    /* ── 会话完成的钩子（98-register.js 的 session-complete 分支调）──

       面板开着（Actions 页签在屏上）时 ghPaneArmRefresh 挂着一只回调箱；没开就是
       null，这道闸一分钱不花。已授权的判定在跑的那一刻读模块层的 pluginConfig
       （92-chip.js 读 refreshOnComplete 的同一口井），关掉授权或清掉 token 都即时
       生效。 */
    const ghPaneRefreshBox = { fn: null }
    function ghPaneArmRefresh(fn) {
      ghPaneRefreshBox.fn = typeof fn === 'function' ? fn : null
    }
    function ghCompleteRefresh() {
      const fn = ghPaneRefreshBox.fn
      if (fn === null) return
      if (ghTokenAuthorized(pluginConfig) !== true) return
      fn()
    }

    /* ── Actions 页签本体 ── */
    function GhActionsPane(props) {
      const sessionId = props.sessionId
      const effective = text(props.effective)
      const plugin = usePluginConfig()
      const committed = usePluginConfigCommitted()
      const [snap, setSnap] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [problem, setProblem] = React.useState('')
      const [filter, setFilter] = React.useState(null)
      const [device, setDevice] = React.useState(null)

      const base = function () {
        const request = { sessionId: sessionId, workspace: effective }
        if (effective.length > 0) request.repo = effective
        return request
      }
      const loadBox = React.useState(function () { return { fn: null, ws: '' } })[0]
      const load = function () {
        if (effective.length === 0) return
        setLoading(true)
        const forWs = effective
        /* 发起那一刻就把在飞请求的仓库盖进箱子：中途切了仓库又发起的，新请求会
           覆盖戳，旧仓库的答复回来时对不上戳就被丢掉（draftBox / targetBox 的同
           一条规矩）。 */
        loadBox.ws = forWs
        callHost('git/gh-actions', base()).then(function (data) {
          /* 仓库已经换了的旧答复不落地。 */
          if (loadBox.ws !== forWs) return
          setSnap(data)
          setLoading(false)
          if (data != null && data.ok === true) setProblem('')
          else setProblem(ghProblemOf(data))
        }, function (failure) {
          if (loadBox.ws !== forWs) return
          setLoading(false)
          setProblem(failureText(failure))
        })
      }
      loadBox.fn = load

      /* 打开页签（本组件挂载）时的自动刷新：已授权才发（任务口径：未授权不做任何
         自动刷新）。committed 让「宿主确认过的配置」参与依赖 —— 设备码流程存完
         token 的那次配置确认落地后，这里跟着刷出已授权的数据。 */
      React.useEffect(function () {
        if (effective.length === 0) return undefined
        if (ghTokenAuthorized(plugin) !== true) return undefined
        loadBox.fn()
        return undefined
      }, [effective, committed])

      /* 会话完成的钩子：挂载时把「刷一次」递给模块层，卸载时摘掉。 */
      React.useEffect(function () {
        ghPaneArmRefresh(function () { if (loadBox.fn != null) loadBox.fn() })
        return function () { ghPaneArmRefresh(null) }
      }, [])

      const refresh = function () {
        if (loading === true) return
        setDevice(null)
        load()
      }

      /* ── 设备码「网页授权」：按钮出现的前提是 ghOAuthClientId 已配置 ── */
      const clientId = plugin != null && typeof plugin.ghOAuthClientId === 'string' ? plugin.ghOAuthClientId : ''
      const deviceStart = function () {
        setDevice({ phase: 'busy', userCode: '', verificationUri: '', deviceCode: '', note: '正在向 GitHub 申请设备码…', status: '' })
        callHost('git/gh-device-start', base()).then(function (data) {
          if (data == null || data.ok !== true) {
            setDevice({ phase: 'idle', userCode: '', verificationUri: '', deviceCode: '', note: data != null && ghIsStr(data.stderr) ? data.stderr : '设备码申请没有成功', status: '' })
            return
          }
          setDevice({ phase: 'awaiting', userCode: data.userCode, verificationUri: data.verificationUri, deviceCode: data.deviceCode, note: '', status: '' })
        }, function (failure) {
          setDevice({ phase: 'idle', userCode: '', verificationUri: '', deviceCode: '', note: failureText(failure), status: '' })
        })
      }
      const deviceContinue = function () {
        const current = device
        if (current == null || current.phase === 'busy' || !ghIsStr(current.deviceCode) || current.deviceCode.length === 0) return
        setDevice(Object.assign({}, current, { phase: 'busy', status: '正在询问 GitHub…' }))
        const body = base()
        body.deviceCode = current.deviceCode
        callHost('git/gh-device-poll', body).then(function (data) {
          const status = data != null && ghIsStr(data.status) ? data.status : ''
          if (data == null || data.ok !== true) {
            const saved = data != null && data.error === 'save-failed'
            setDevice(Object.assign({}, current, { phase: saved ? 'idle' : 'awaiting', status: saved ? '' : '授权询问没有完成：' + (data != null && ghIsStr(data.stderr) ? data.stderr : '未知原因'), note: saved ? 'token 拿到了，但没写进配置：' + (data != null && ghIsStr(data.stderr) ? data.stderr : '') : '' }))
            return
          }
          if (status === 'granted') {
            /* token 已经在宿主落盘。配置重读一轮（拿新哨兵），数据跟着刷一遍；
               授权状态行、自动刷新的判据全都从新配置出发。 */
            setDevice({ phase: 'done', userCode: '', verificationUri: '', deviceCode: '', note: '授权完成，token 已保存（尾号 ' + (ghIsStr(data.tail) ? data.tail : '----') + '）', status: '' })
            callHost('git/config', {}).then(adoptPluginConfig, function () { /* 配置重读失败不打断：下一次保存或重开面板还会读到 */ })
            load()
            return
          }
          if (status === 'pending') {
            setDevice(Object.assign({}, current, { phase: 'awaiting', status: 'GitHub 还没看到授权 —— 在网页上完成输入与确认后，再点一次「继续」' }))
            return
          }
          if (status === 'slow_down') {
            const wait = data != null && typeof data.interval === 'number' && isFinite(data.interval) ? parseInt(data.interval, 10) : 10
            setDevice(Object.assign({}, current, { phase: 'awaiting', status: 'GitHub 要求放慢节奏：等 ' + String(isNaN(wait) ? 10 : wait) + ' 秒后再点「继续」' }))
            return
          }
          if (status === 'expired') {
            setDevice(Object.assign({}, current, { phase: 'idle', status: '', note: '设备码过期了：点「用 GitHub 网页授权」重新开始' }))
            return
          }
          if (status === 'denied') {
            setDevice(Object.assign({}, current, { phase: 'idle', status: '', note: '这次授权被拒绝（access_denied）：重新点「用 GitHub 网页授权」可以再来' }))
            return
          }
          setDevice(Object.assign({}, current, { phase: 'awaiting', status: 'GitHub 说：' + (ghIsStr(data.error) ? data.error : '未知错误') }))
        }, function (failure) {
          setDevice(Object.assign({}, current, { phase: 'awaiting', status: '授权询问没有完成：' + failureText(failure) }))
        })
      }

      const authorized = ghTokenAuthorized(plugin)
      const tail = ghTokenTail(plugin)
      const override = ghOverrideOfConfig(plugin, effective)
      const workflowFilters = ghWorkflowsOfConfig(plugin, effective)
      const runs = snap != null && snap.ok === true && Array.isArray(snap.runs) ? snap.runs : []
      const shown = filter !== null ? runs.filter(function (one) { return one != null && one.path === filter }) : runs
      const rateRemaining = snap != null && ghIsStr(snap.rateRemaining) && snap.rateRemaining.length > 0 ? parseInt(snap.rateRemaining, 10) : NaN
      const rateReset = snap != null && ghIsStr(snap.rateReset) && snap.rateReset.length > 0 ? parseFloat(snap.rateReset) : NaN
      const proxyConfigured = snap != null && snap.proxyConfigured === true

      /* 页首说明：目标仓库从哪来、授权状态、配额。 */
      const targetLine = snap != null && ghIsStr(snap.ownerRepo) && snap.ownerRepo.length > 0
        ? h('span', { className: 'dsh-git-hint' },
          '仓库 ' + snap.ownerRepo,
          snap.source === 'override' ? '（项目配置的覆盖）' : '（来自 origin）',
          filter !== null && ghIsStr(filter) ? ' · 只看 ' + filter : '')
        : null
      const quotaLine = isNaN(rateRemaining) === false
        ? (rateRemaining <= 0
          ? (isNaN(rateReset) === false && rateReset > 0 ? '配额已用尽，' + new Date(rateReset * 1000).toLocaleTimeString() + ' 重置' : '配额已用尽')
          : 'API 配额剩余 ' + String(rateRemaining) + ' 次')
        : null

      const rows = []
      for (let i = 0; i < shown.length; i += 1) {
        const one = shown[i]
        const badge = ghBadgeOf(one)
        const sha = one != null && ghIsStr(one.headSha) && one.headSha.length >= 7 ? one.headSha.slice(0, 7) : ''
        rows.push(h('button', {
          key: one != null && one.id != null ? String(one.id) : 'run-' + String(i),
          type: 'button',
          className: 'dsh-git-gh-row',
          title: (one != null && ghIsStr(one.htmlUrl) && one.htmlUrl.length > 0 ? one.htmlUrl : '') + (one != null && ghIsStr(one.event) && one.event.length > 0 ? '（' + one.event + '）' : ''),
          onClick: function () {
            if (one == null || !ghIsStr(one.htmlUrl) || one.htmlUrl.length === 0) return
            window.open(one.htmlUrl, '_blank', 'noopener')
          },
        },
          h('span', { key: 'b', className: 'dsh-git-gh-badge dsh-git-gh-badge-' + badge.cls }, badge.label),
          h('span', { key: 'n', className: 'dsh-git-gh-row-name' }, one != null && ghIsStr(one.name) && one.name.length > 0 ? one.name : (one != null && ghIsStr(one.path) ? one.path : 'workflow')),
          h('span', { key: 'br', className: 'dsh-git-gh-row-meta' }, one != null && ghIsStr(one.headBranch) && one.headBranch.length > 0 ? one.headBranch : ''),
          h('span', { key: 'no', className: 'dsh-git-gh-row-meta' }, '#' + String(one != null && typeof one.runNumber === 'number' ? one.runNumber : 0)),
          sha.length > 0 ? h('span', { key: 'sha', className: 'dsh-git-gh-row-meta dsh-git-gh-row-sha' }, sha) : null,
          h('span', { key: 't', className: 'dsh-git-gh-row-time' }, ghRelTime(one != null && ghIsStr(one.createdAt) ? one.createdAt : ''))))
      }

      const chips = workflowFilters.length > 0
        ? h('div', { className: 'dsh-git-gh-chips' },
          h('button', {
            key: 'all', type: 'button',
            className: 'dsh-git-gh-chip' + (filter === null ? ' dsh-git-gh-chip-on' : ''),
            title: '显示全部 workflow 的 runs',
            onClick: function () { setFilter(null) },
          }, '全部'),
          workflowFilters.map(function (path, index) {
            return h('button', {
              key: path + '-' + String(index), type: 'button',
              className: 'dsh-git-gh-chip' + (filter === path ? ' dsh-git-gh-chip-on' : ''),
              title: path + '（在项目配置档「GitHub Actions」里改这份清单）',
              onClick: function () { setFilter(filter === path ? null : path) },
            }, path)
          }))
        : null

      const deviceNode = device == null ? null : h('div', { className: 'dsh-git-gh-device' },
        device.userCode.length > 0
          ? h('div', { className: 'dsh-git-gh-device-code' },
            h('span', { className: 'dsh-git-hint' }, '一次性代码：'),
            h('span', { className: 'dsh-git-gh-usercode' }, device.userCode))
          : null,
        device.verificationUri.length > 0
          ? h('div', { className: 'dsh-git-gh-device-open' },
            h('button', {
              type: 'button', className: 'dsh-git-btn',
              onClick: function () { window.open(device.verificationUri, '_blank', 'noopener') },
            }, '打开 ' + device.verificationUri),
            h('span', { className: 'dsh-git-hint' }, '在上面那个网页输入一次性代码并授权'))
          : null,
        device.note.length > 0 ? h('div', { className: 'dsh-git-hint' }, device.note) : null,
        device.status.length > 0 ? h('div', { className: 'dsh-git-hint' }, device.status) : null,
        device.phase === 'awaiting'
          ? h('div', { className: 'dsh-git-gh-device-go' },
            h('button', { type: 'button', className: 'dsh-git-btn dsh-git-primary', onClick: deviceContinue }, '继续'),
            h('span', { className: 'dsh-git-hint' }, '每点一次问一次 GitHub —— 授权还没生效就再点，不需要刷新页面'))
          : null)

      return h('div', { className: 'dsh-git-pane dsh-git-gh' },
        h('div', { className: 'dsh-git-gh-top' },
          h('button', { type: 'button', className: 'dsh-git-btn', disabled: loading === true || effective.length === 0, title: '重新读一次这个仓库的 Actions runs', onClick: refresh }, loading === true ? '读取中…' : '⟳ 刷新'),
          authorized === true
            ? h('span', { className: 'dsh-git-gh-auth dsh-git-gh-auth-ok' }, '已授权' + (tail.length > 0 ? '（token 尾号 ' + tail + '）' : ''))
            : h('span', { className: 'dsh-git-gh-auth dsh-git-gh-auth-no' }, '未授权：公共仓库可匿名查看（每小时 60 次）；私有仓库去全局配置档「GitHub 授权」加 token'),
          targetLine,
          quotaLine != null ? h('span', { className: 'dsh-git-hint' }, quotaLine) : null,
          proxyConfigured === true ? h('span', { className: 'dsh-git-hint' }, 'ghProxy 已配置，但当前版本仅作占位（仍是直连）；要走环境代理，给 DSH 进程设 NODE_USE_ENV_PROXY=1') : null),
        clientId.length > 0 && authorized !== true
          ? h('div', { className: 'dsh-git-gh-authrow' },
            h('button', { type: 'button', className: 'dsh-git-btn', onClick: deviceStart }, '用 GitHub 网页授权'),
            h('span', { className: 'dsh-git-hint' }, '设备码方式：浏览器不碰密码，GitHub 发一个一次性代码，你在网页上确认后 token 由宿主直接收进配置'))
          : null,
        deviceNode,
        problem.length > 0 ? h('div', { className: 'dsh-git-gh-problem' }, problem) : null,
        chips,
        effective.length === 0
          ? h('div', { className: 'dsh-git-pane dsh-git-dim' }, '正在读取仓库…')
          : snap != null && snap.ok === true && (!ghIsStr(snap.ownerRepo) || snap.ownerRepo.length === 0)
            ? h('div', { className: 'dsh-git-pane dsh-git-dim' },
              '这个仓库的远端不是 github.com，也没有为它配 owner/repo 覆盖 —— 在项目配置档「GitHub Actions」里填一个 owner/repo，就能看那个仓库的 Actions。')
            : (rows.length > 0
              ? h('div', { className: 'dsh-git-gh-list' }, rows)
              : (loading === true || snap == null
                ? h('div', { className: 'dsh-git-pane dsh-git-dim' }, '正在读取 GitHub Actions…')
                : h('div', { className: 'dsh-git-pane dsh-git-dim' },
                  problem.length > 0 ? '没有可显示的 runs。' : (filter !== null ? '这个 workflow 还没有 runs（过滤：' + filter + '）。' : '这个仓库还没有 Actions runs。')))))
    }
