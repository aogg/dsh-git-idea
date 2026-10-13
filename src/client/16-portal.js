    /* ── 跳出主对话的框：body 级 portal 浮层 ──

       面板（.dsh-git-pop）和 chip 的悬停卡片（.dsh-git-switch-hover）原先 absolute
       挂在输入区的 overlay 槽位里：宽度上下文是主对话（composer 卡片），祖先链上
       还有会话滚动体在裁竖向溢出（14-geometry.js 说的那道界）。装了 DSH-better-
       sidebar 这类会压窄主对话的插件之后，主对话一窄，弹层要么被 max-width 压扁、
       要么带着记忆宽度溢出被裁 —— 显示不全。这一层把弹层的渲染搬到 document.body
       上一个视口大小的定点层（.dsh-git-float，样式在 46-css.js）：position:fixed、
       pointer-events:none（弹层自己再打开）、overflow:hidden（浮层不把 document
       撑出滚动区）、z-index 95。

       z-index 95 的上下文（实测 better-sidebar 的源码，只读参考）：它的侧栏宿主
       [data-dsh-panel-host] 是 body 级 fixed 层 z-index 25，格内的 40/90 都被这层
       罩住；它自己 portal 到 body 的浮窗（FloatingWindow）与锚定卡（AnchoredPopover）
       是 90；DSH 的 ui-cordis 插件面板是 fixed 30；应用的对话框栈在 100+。95 恰好
       压过 better-sidebar 的一切常驻面，又不挡应用自己的对话框。

       createPortal 的来源：真包构建（client/client.js）的模块表里有 react-dom
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

    /* GitPopover 渲染期问一次的入口。null = 这个环境没有可用的 portal（没有
       document.body、没有 react-dom）：调用方照旧走旧路。层是惰性单例：body 上
       只挂一个，多次渲染、多个会话的弹层共用。 */
    const gitFloatEscape = function () {
      if (gitFloatLayerBox !== null) return gitFloatLayerBox
      if (typeof document === 'undefined' || document == null) return null
      const body = document.body
      if (body == null || typeof body.appendChild !== 'function') return null
      const portal = gitPortalOf()
      if (portal == null) return null
      const host = document.createElement('div')
      host.className = 'dsh-git-float'
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
