    /* ── 客户端诊断日志（面板生命周期可观测性）──

        「弹窗打开后莫名其妙自己关了、然后再也打不开」这类问题，过去没有任何账可查：
        关在哪条路上、open 状态位卡在什么值，屏幕上什么都不说，控制台里也多半什么
        都没有。这里补一本账。三类事件：

          open               面板打开（source：谁开的 —— 'chip' / 'programmatic'…）
          close              面板收起（reason 枚举：user-toggle / outside-click /
                             esc / crash / programmatic；blur 与 live-bus 这两条
                             路今天并不存在，占位只为读账时不猜）
          crash              插件自己的渲染/副作用抛错（message + stack）
          watchdog-recovery  看门狗发现「open 但面板根节点不在文档里」，复位重开

        账本三处落地，各管一边：
          · 内存环形缓冲（200 条封顶），并镜像进 localStorage（同 key，1 秒节流写，
            防 quota 抖动也防膨胀）—— 刷新后最近的账还在；
          · console：crash 走 error、watchdog-recovery 走 warn（开/收是高频事件，
            打满控制台只会把真错淹掉，它们只进环与文件）；
          · 批量 POST 到宿主 /api/dsh-git-idea/client-log（host-post.js 注册），
            追加写宿主侧 ~/.dsh/logs/dsh-git-idea-client.log —— 刷新页面日志也不丢。
            遵守插件规范：跟随 dsh 本身端口、不开独立端口、不轮询 —— 攒批事件驱动
            地发（满 20 条立刻发；不足则末次事件 4 秒后发一次），两条限频闸：两次
            上传至少隔 2 秒、失败后退避 30 秒，待发队列 500 条封顶丢最旧。

        没有文档的环境（单测的迷你 React、桥版无 body）自动降级：只记内存环，不碰
        localStorage、不排上传 —— 账本永远不许反过来碍着面板。控制台要整本翻账时
        调 window.__dshGitIdeaLogs()。 */

    const DIAG_RING_MAX = 200
    const DIAG_STORE_KEY = 'dsh.git-idea.client-log'
    const DIAG_POST_PATH = '/api/dsh-git-idea/client-log'
    const DIAG_POST_BATCH = 20       /* 攒够一批：立刻发 */
    const DIAG_POST_DELAY_MS = 4000  /* 不足一批：末次事件 4 秒后发（事件驱动，非轮询） */
    const DIAG_POST_GAP_MS = 2000    /* 两次上传最小间隔（限频） */
    const DIAG_POST_MAX = 500        /* 待发队列上限，超出丢最旧 */
    const DIAG_FAIL_BACKOFF_MS = 30000
    const DIAG_SAVE_DELAY_MS = 1000

    let diagRing = null
    let diagRingDirty = false
    let diagSaveTimer = null
    let diagOutbox = []
    let diagPostTimer = null
    let diagPosting = false
    let diagLastPostAt = 0
    let diagFailAt = 0

    function diagNow() {
      try {
        return new Date().toISOString()
      } catch (error) {
        return String(Date.now())
      }
    }

    /* 真浏览器才有 document；测试与桥版没有，账本就地降级。 */
    function diagView() {
      try {
        if (typeof document !== 'undefined' && document != null && document.body != null) return document
      } catch (error) { /* 就当没有 */ }
      return null
    }

    function diagRingLoad() {
      if (diagRing !== null) return diagRing
      diagRing = []
      const stored = readStoredJSON(DIAG_STORE_KEY, null)
      if (Array.isArray(stored)) {
        for (let i = 0; i < stored.length; i += 1) {
          const one = stored[i]
          if (one != null && typeof one === 'object') diagRing.push(one)
        }
        while (diagRing.length > DIAG_RING_MAX) diagRing.shift()
      }
      return diagRing
    }

    function diagField(value, cap) {
      if (value === undefined || value === null) return undefined
      const raw = typeof value === 'string' ? value : String(value)
      return raw.length > cap ? raw.slice(0, cap) + '…' : raw
    }

    function diagPersistNow() {
      if (diagRingDirty !== true) return
      diagRingDirty = false
      writeStoredJSON(DIAG_STORE_KEY, diagRingLoad())
    }

    function diagScheduleSave() {
      if (diagSaveTimer != null || diagView() == null) return
      diagSaveTimer = timerOf().timeout(function () {
        diagSaveTimer = null
        diagPersistNow()
      }, DIAG_SAVE_DELAY_MS)
    }

    /* crash 要一眼看见，watchdog 要留个痕；open/close 是高频事件，只进环与文件。 */
    function diagConsoleFor(entry) {
      if (entry.kind === 'crash') {
        console.error('dsh-git-idea [crash]', entry.message != null ? entry.message : '', entry.stack != null ? '\n' + entry.stack : '')
        return
      }
      if (entry.kind === 'watchdog-recovery') {
        console.warn('dsh-git-idea [watchdog-recovery]', entry.detail != null ? entry.detail : '', entry.source != null ? '(来源 ' + entry.source + ')' : '')
      }
    }

    function diagLog(kind, fields) {
      const entry = { t: diagNow(), kind: typeof kind === 'string' && kind.length > 0 ? kind : 'unknown' }
      if (fields != null && typeof fields === 'object') {
        const source = diagField(fields.source, 60)
        const reason = diagField(fields.reason, 60)
        const message = diagField(fields.message, 2000)
        const stack = diagField(fields.stack, 4000)
        const detail = diagField(fields.detail, 300)
        if (source !== undefined) entry.source = source
        if (reason !== undefined) entry.reason = reason
        if (message !== undefined) entry.message = message
        if (stack !== undefined) entry.stack = stack
        if (detail !== undefined) entry.detail = detail
      }
      const ring = diagRingLoad()
      ring.push(entry)
      while (ring.length > DIAG_RING_MAX) ring.shift()
      diagRingDirty = true
      diagScheduleSave()
      diagConsoleFor(entry)
      diagEnqueue(entry)
      return entry
    }

    /* ── 批量上传：攒批 → 限频 → 宿主落盘。失败安静重试（退避），永不影响主流程。 */
    function diagEnqueue(entry) {
      if (diagView() == null) return
      diagOutbox.push(entry)
      if (diagOutbox.length > DIAG_POST_MAX) diagOutbox.splice(0, diagOutbox.length - DIAG_POST_MAX)
      if (diagOutbox.length >= DIAG_POST_BATCH) { diagFlush(); return }
      if (diagPostTimer != null) return
      diagPostTimer = timerOf().timeout(function () {
        diagPostTimer = null
        diagFlush()
      }, DIAG_POST_DELAY_MS)
    }

    function diagArmRetry(delay) {
      if (diagPostTimer != null) return
      diagPostTimer = timerOf().timeout(function () {
        diagPostTimer = null
        diagFlush()
      }, delay > 0 ? delay : DIAG_POST_DELAY_MS)
    }

    function diagFlush() {
      if (diagPosting === true || diagOutbox.length === 0) return
      if (typeof fetch !== 'function') { diagOutbox = []; return }
      const sinceFail = Date.now() - diagFailAt
      if (diagFailAt !== 0 && sinceFail < DIAG_FAIL_BACKOFF_MS) { diagArmRetry(DIAG_FAIL_BACKOFF_MS - sinceFail); return }
      const sincePost = Date.now() - diagLastPostAt
      if (diagLastPostAt !== 0 && sincePost < DIAG_POST_GAP_MS) { diagArmRetry(DIAG_POST_GAP_MS - sincePost); return }
      const events = diagOutbox.slice()
      diagPosting = true
      let settled = false
      const settle = function (ok) {
        if (settled === true) return
        settled = true
        diagPosting = false
        if (ok === true) {
          diagOutbox.splice(0, events.length)
          diagLastPostAt = Date.now()
          diagFailAt = 0
          if (diagOutbox.length > 0) diagArmRetry(DIAG_POST_GAP_MS)
          return
        }
        diagFailAt = Date.now()
        diagArmRetry(DIAG_FAIL_BACKOFF_MS)
      }
      try {
        fetch(DIAG_POST_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ events: events }),
          /* pagehide 那一把（页面正在卸载）也要尽量发得出去 */
          keepalive: events.length <= 50,
        }).then(function (response) {
          settle(response != null && response.status >= 200 && response.status < 300)
        }, function () { settle(false) })
      } catch (error) {
        settle(false)
      }
    }

    /* 页面藏着/正在卸载时把环与待发队列都冲一遍 —— 最后一批不等到期。 */
    function diagFlushNow() {
      diagPersistNow()
      if (diagPostTimer != null) { diagPostTimer(); diagPostTimer = null }
      diagFlush()
    }

    /* 控制台翻账：window.__dshGitIdeaLogs() 返回环形缓冲的副本。 */
    function diagDump() {
      return diagRingLoad().slice()
    }

    /* 全局兜底上报（98-register.js）的身份过滤：堆栈/消息里带着本插件的记号才算
       自家的 —— 报错文本含 'dsh-git'（覆盖 dsh-git-idea / dsh.git-idea 键名、
       /api/dsh-git-idea/* 路由、'dsh-git-idea:' 控制台前缀）。宁少报不误报：宿主与
       别的插件的错一个都不劫持；面板树内的错本来就有护栏精确接住，不靠这条猜。 */
    function diagLooksOurs(text) {
      const raw = typeof text === 'string' ? text : String(text == null ? '' : text)
      return raw.indexOf('dsh-git') >= 0 || raw.indexOf('dsh.git-idea') >= 0
    }
