    /* ── 跳出主对话的框：body 级 portal 浮层 ──

       面板（.dsh-git-pop）和 chip 的悬停卡片（.dsh-git-switch-hover）原先 absolute
       挂在输入区的 overlay 槽位里：宽度上下文是主对话（composer 卡片），祖先链上
       还有会话滚动体在裁竖向溢出（14-geometry.js 说的那道界）。装了 DSH-better-
       sidebar 这类会压窄主对话的插件之后，主对话一窄，弹层要么被 max-width 压扁、
       要么带着记忆宽度溢出被裁 —— 显示不全。这一层把弹层的渲染搬到 document.body
       上一个视口大小的定点层（.dsh-git-float，样式在 46-css.js）：position:fixed、
       pointer-events:none（弹层自己再打开）、overflow:hidden（浮层不把 document
       撑出滚动区）。

       ── 层级：顶层（top layer，见下面的 gitFloatPromote）──
       光有 body 级 + z-index 还不够：DSH 会话自己的顶栏、以及这台机器上别的插件
       （实测 ssh-workspace 用到 1300、ao-local 用到 2147483000）都会把「挑一个大
       一点的数」变成一场赌。所以有东西要显示时把宿主提进 HTML 的 top layer
       （popover=manual + showPopover）：那一层不参与 z-index 竞争，永远在文档里所有
       z-index 之上；收起即退出顶层，DSH 自己的对话框（1000）、toast 与菜单照旧在
       最上面。z-index 95（46-css.js）只剩「没有 Popover API 的内核」的兜底，
       这个数沿用旧值，不再承担「盖过谁」的职责。

       createPortal 的来源：真包构建（dist/client/client.js）的模块表里有 react-dom
       （渲染器自己就 require 它），用 require 拿；个别环境只给了全局 ReactDOM 就
       读全局。两样都没有（bridge 动态加载、单测的迷你 React）返回 null ——
       GitPopover 据此整体回退旧的「槽位内 absolute」定位，行为一字不变。 */

    const GIT_FLOAT_MIN_W = 560     /* 主对话被挤窄时面板的宽度下限（80-panel.js 用） */

    const gitPortalOf = function () {
      try {
        if (typeof require === 'function') {
          const dom = require('react-dom')
          if (dom != null && typeof dom.createPortal === 'function') return dom.createPortal
        }
      } catch (error) { /* 模块表里没有 react-dom：落全局，再没有就回退旧路 */ }
      const scope = typeof window !== 'undefined' ? window : null
      const dom = scope != null ? scope.ReactDOM : null
      return dom != null && typeof dom.createPortal === 'function' ? dom.createPortal : null
    }

    let gitFloatLayerBox = null

    /* ── 浮层被摘走的那支「再也打不开」──

        host 是 body 上的一个普通 div，谁都动得着它：被某个重建视图的插件/框架
        remove 掉之后，React 树还活着、open 还是 true，createPortal 却一直在往一个
        游离节点里画 —— 面板「开也没看见」，点图标在 true↔false 之间空转。所以
        每次 escape 都先问一句 host 还在不在文档里（isConnected），不在就丢掉旧的
        换新的：任何一次重渲染都能把面板搬回文档。

        「没有人触发重渲染」的场合（open 没变、信号都安静）由 healGitFloat 兜底：
        看门狗（10-state.js 的 togglePanelOpen、94-popover.js 的 open 巡检）发现
        根节点不在文档里就喊它一声，bump 一次浮层代数 —— GitPopover 订阅着这个
        信号，bump 即重渲染，重渲染即自愈。bump 刻意异步（timeout 0）：escape 在
        渲染期被调用，渲染期不许通知别人的 state。 */
    let gitFloatEpochN = 0
    const gitFloatSignal = createSignal(function () { return gitFloatEpochN })
    const useGitFloatEpoch = gitFloatSignal.use

    function bumpGitFloat() {
      gitFloatEpochN += 1
      gitFloatSignal.notify()
    }

    function gitFloatHostAlive() {
      if (gitFloatLayerBox === null) return false
      try {
        return gitFloatLayerBox.host.isConnected !== false
      } catch (error) {
        return true
      }
    }

    function healGitFloat() {
      if (gitFloatLayerBox === null) return
      if (gitFloatHostAlive() === true) return
      timerOf().timeout(function () { bumpGitFloat() }, 0)
    }

    /* ── 把这一层提到「顶层」（top layer）：盖住 DSH 自己的顶栏 ──

       症状：点 chip 弹出来的面板 / 悬停卡片贴到屏幕上方时，被 DSH 会话自己的顶栏
       （.wSkVaW_header，含「对话 / 轨迹 / …」那条 tab 栏）盖掉一截。

       为什么不是把 z-index 数字再调大一点：
         · DSH 自己的内容级层已经占了一片数：会话 tab 栏 z-index:1、交互面板 30、
           菜单 100 / 1100、弹窗 1000、toast 1100（实测 dsh-web-frontend 与
           dsh-client-ui-* 的产物）；同一台机器上还装着别的插件，layer 更是各写各的
           —— 这个部署里 ssh-workspace 用到 1300、ao-local 用到 2147483000。
           挑一个比它们都大的数，只是在赌下一个插件不会写更大。
         · 反过来，数字挑大了就会盖住 DSH 自己的对话框与 toast —— 那是真的把别人的
           界面挡坏。

       HTML 的 top layer 是「不参与 z-index 竞争」的那一层（popover / dialog 用的就是
       它）：在顶层里的元素按「进入顺序」叠放，永远在文档里所有 z-index 之上，包括
       上面那些四位数五位数。所以这里给 body 上的浮层宿主加 `popover="manual"`
       并 showPopover()：
         · manual = 没有「点外面就关」（light dismiss），开合仍由本插件的 open /
           hover 状态说了算；
         · 不挡点击：宿主本身 pointer-events:none（46-css.js），能点的只有它里面
           真正打开的面板与卡片；
         · 只在**本插件有东西要显示**（面板打开 / 悬停卡片开着）时才进顶层，
           收起即 hidePopover() —— 关着的时候一点也不占用顶层，DSH 的对话框、
           toast、菜单照旧在最上面（它们晚进顶层，或者本来就在文档之上）。
       浏览器没有 Popover API（旧内核、单测的迷你 DOM）时安静退回 z-index 95 的老
       路，一个字都不会崩：能问就问，问不到就照旧。 */
    const GIT_FLOAT_POPOVER_ATTR = 'popover'

    function gitFloatTopLayerSupported(host) {
      if (host == null) return false
      if (typeof host.showPopover !== 'function' || typeof host.hidePopover !== 'function') return false
      /* 属性是这一层真正被理解的前提：老内核里 showPopover 不存在，这一句只是
         双保险。 */
      return typeof host.setAttribute === 'function'
    }

    function gitFloatIsTopLayerOpen(host) {
      try {
        return typeof host.matches === 'function' && host.matches(':popover-open') === true
      } catch (error) {
        /* 认不出 :popover-open 的内核（或测试里的假节点）：当作「没开」，于是下面
           会照常 showPopover，异常在调用处另有兜底。 */
        return false
      }
    }

    /* 进/出顶层。两个方向都幂等：重复进不会抛 InvalidStateError（那是 showPopover
       在已开时抛的），重复出也不会。 */
    function gitFloatPromote(host) {
      if (gitFloatTopLayerSupported(host) !== true) return false
      try {
        if (host.getAttribute(GIT_FLOAT_POPOVER_ATTR) !== 'manual') {
          host.setAttribute(GIT_FLOAT_POPOVER_ATTR, 'manual')
        }
        if (gitFloatIsTopLayerOpen(host) === true) return true
        host.showPopover()
        return true
      } catch (error) {
        /* 真内核里会抛的情形：宿主已经不在文档里（watchdog 会重建）、或这个元素
           不被允许进顶层。回退到 z-index 的老路 —— 但那是一次真实的状态变化，
           值得留一行日志（05-telemetry.js 的 diagLog）。 */
        diagLog('float-toplayer', {
          detail: '浮层进顶层失败，退回 z-index 95',
          message: error != null && error.message !== undefined ? String(error.message) : String(error),
        })
        return false
      }
    }

    function gitFloatWithdraw(host) {
      if (!gitFloatTopLayerSupported(host)) return false
      try {
        if (gitFloatIsTopLayerOpen(host) !== true) return false
        host.hidePopover()
        return true
      } catch (error) {
        diagLog('float-toplayer', {
          detail: '浮层退出顶层失败（留在顶层不影响点击，也不遮挡别的内容）',
          message: error != null && error.message !== undefined ? String(error.message) : String(error),
        })
        return false
      }
    }

    /* GitPopover 渲染期问一次的入口。null = 这个环境没有可用的 portal（没有
       document.body、没有 react-dom）：调用方照旧走旧路。层是惰性单例：body 上
       只挂一个，多次渲染、多个会话的弹层共用。 */
    const gitFloatEscape = function () {
      if (gitFloatLayerBox !== null && gitFloatHostAlive() !== true) {
        gitFloatLayerBox = null
      }
      if (gitFloatLayerBox !== null) return gitFloatLayerBox
      if (typeof document === 'undefined' || document == null) return null
      const body = document.body
      if (body == null || typeof body.appendChild !== 'function') return null
      const portal = gitPortalOf()
      if (portal == null) return null
      const host = document.createElement('div')
      host.className = 'dsh-git-float'
      /* popover 属性在第一帧就带上：showPopover 由 94-popover.js 的 effect 按
         「有没有东西要显示」调用（渲染期不改 DOM 的显示状态）。这里只把属性写好，
         免得第一次 showPopover 时才改属性、触发一次多余的重排。 */
      if (gitFloatTopLayerSupported(host) === true) host.setAttribute(GIT_FLOAT_POPOVER_ATTR, 'manual')
      body.appendChild(host)
      gitFloatLayerBox = { portal: portal, host: host }
      return gitFloatLayerBox
    }

    /* 浮层里的定位计算都要视口尺寸：node 用它自己的 document 来问。问不到（测试、
       无布局环境）回 null，调用方按「量不了」处理。 */
    const gitFloatViewportOf = function (node) {
      const doc = node != null && node.ownerDocument != null ? node.ownerDocument : null
      const view = doc != null ? doc.defaultView : null
      if (view == null) return null
      const vw = parseFloat(view.innerWidth)
      const vh = parseFloat(view.innerHeight)
      if (!isFinite(vw) || !isFinite(vh)) return null
      return { view: view, vw: vw, vh: vh }
    }
