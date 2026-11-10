    /* 悬停卡片低于这个可见空间就不钳：塞不下搜索行 + 几行分支 + 建行脚的卡片，
       钳了也是一张压碎的卡，不如维持自然高度（极端矮窗口下保持原行为）。 */
    const SWITCH_MIN_ROOM = 200

    /* ── 面板的崩溃护栏 ──

        open 路径上任何一个渲染或 effect 抛错，React 都会把整棵槽位子树卸掉：屏幕上
        就是「弹窗自己关了」（close 原因里的 crash 一支），而 open 状态位没人复位 ——
        chip 再点就在 true↔false 之间空转，从此「再也打不开」。护栏把错误圈在这一层：
        记 crash 日志、弹 toast（不依赖面板活着）、把 open 复位成 false（下一次点击
        是一次干净的打开），并在面板已收起后自动重新武装；重武装封顶 3 次，防一个
        「藏起来也崩」的错误把这里变成无限循环 —— 三次都崩就停在原地等下一次打开。
        单测的迷你 React 没有类组件：护栏退化为透传，行为与没有护栏一字不差。 */
    const GitCrashBoundary = (function () {
      if (typeof React.Component !== 'function') {
        return function GitCrashBoundaryPass(props) {
          return props.children != null ? props.children : null
        }
      }
      return class GitCrashBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { crashed: null, retries: 0 }
        }
        static getDerivedStateFromError(error) {
          return { crashed: error == null ? new Error('unknown panel crash') : error }
        }
        componentDidCatch(error) {
          const message = error != null && error.message !== undefined ? String(error.message) : String(error)
          const stackText = error != null && typeof error.stack === 'string' ? String(error.stack) : ''
          /* 全局兜底监听（98-register.js）见到这个记号就让路：一次崩溃只报一声。 */
          try { if (error != null) error.__dshGitIdeaSeen = true } catch (e) { /* 冻结对象也不碍事 */ }
          diagLog('crash', { message: message, stack: stackText, detail: '面板渲染/副作用抛错，已收起面板' })
          crashToast('Git 面板异常关闭', message, stackText)
          setOpen(false, 'crash')
          this.setState(function (previous) { return { retries: previous.retries + 1 } })
        }
        componentDidUpdate(previousProps) {
          /* 面板已收起（上面的 crash 处理干的）：重新武装，下一次打开按全新挂载走。 */
          if (this.state.crashed !== null && this.props.active !== true && this.state.retries <= 3) {
            this.setState({ crashed: null })
            return
          }
          /* 新的一次打开：重试账清零。 */
          if (this.props.active === true && previousProps.active !== true
            && (this.state.crashed !== null || this.state.retries !== 0)) {
            this.setState({ crashed: null, retries: 0 })
          }
        }
        render() {
          if (this.state.crashed !== null) return null
          return this.props.children
        }
      }
    })()

    /* ── 把浮层宿主提进顶层（top layer）的那一下 ──

       只做一件事、不渲染任何东西：让「宿主已可见」发生在面板子树的布局测量之前。
       挂着 useLayoutEffect 而不是 useEffect —— 进顶层必须赶在这一帧画出来之前，
       否则打开的瞬间会闪一帧「还看不见」。

       幂等：gitFloatPromote / gitFloatWithdraw 都先问一句现在是什么状态（重复
       showPopover 会抛 InvalidStateError，那两个函数各自兜着并记日志）。没有
       host（没有 portal）或宿主已经被换掉（watchdog 重建，epoch 变）时按新 host
       再来一次。 */
    function GitFloatTopLayer(props) {
      const host = props.host
      const show = props.show === true
      useLayoutEffect(function () {
        if (host == null) return undefined
        if (show === true) gitFloatPromote(host)
        else gitFloatWithdraw(host)
        return undefined
      }, [host, show, props.epoch])
      return null
    }

    function GitPopover(props) {
      const isOpen = useOpen()
      const mode = useSwitchMode()
      /* 浮层代数：看门狗修浮层时 bump 一下，这里跟着重渲染，把面板搬进（可能的）
         新 host —— 没有这一条，「无人触发重渲染」的场合就得等读者点两下图标。 */
      const floatEpoch = useGitFloatEpoch()
      /* 分支卡片上那个「几个改动」也来自全局那一份读数：同一个数字在面板、chip 和这张
         卡片上必须是同一个。 */
      useTreeVersion()
      /* ── 跳出主对话的框（16-portal.js）──

         有 portal 就把面板和悬停卡片整体搬进 body 级浮层：渲染与定位都不再受主对话
         容器的宽度/overflow 约束，better-sidebar 把主对话压多窄都裁不到它们。槽位里
         只留一只 1×1 的定位探针（floated 探锚）—— 它的 offsetParent 还是输入框卡片，
         面板和卡片照旧「贴着输入框向上长」，只是包含块换成了视口。没有 portal
         （bridge、单测的迷你 React）escape 为 null：下面每一步都按旧路走，渲染结果
         和从前一字不差。 */
      const escape = gitFloatEscape()
      const floated = escape != null
      const [probeBox] = React.useState(function () { return { node: null } })
      /* ── 顶层（top layer）：有东西要显示才进，收起就出 ──

         面板打开或悬停卡片开着时，把 body 上的浮层宿主提进 HTML 的 top layer
         （16-portal.js 的 gitFloatPromote）—— 那一层不参与 z-index 竞争，所以 DSH
         会话顶栏、以及这台机器上别的插件写的 1300 / 2147483000 都盖不到本插件的
         面板与卡片。

         只在「有东西要显示」时进：关着的时候一点也不占用顶层，DSH 自己的对话框
         （z-index 1000）、toast 与菜单照旧在最上面 —— 数字不必调大，也不会把别人
         的界面挡在上面。

         这一步交给 GitFloatTopLayer **那个空组件**做，而不是在这里写一条
         useLayoutEffect：React 的布局副作用是子先父后，父组件那一条会晚于面板
         子树自己的布局测量跑，而收起的 popover 宿主是 display:none —— 面板里
         「量容器 clientWidth 判断窄屏」（54-changes.js 的 useNarrowWidth）就会量到
         0、在打开的那一帧按宽屏画（拖窄过的面板因此会闪一下展开态）。它被放在
         portal 里、面板之前那一位：兄弟节点按次序提交，它的布局副作用因此**先于**
         面板子树的任何测量跑完，宿主在那之前就已经可见。
         没有 portal（floated=false）或没有 Popover API 时它什么都不做，行为与从前
         一字不差（z-index 95 兜底）。 */
      const surfaceShown = isOpen === true || mode === 'hover'
      const topLayerEl = h(GitFloatTopLayer, {
        key: 'top',
        host: floated === true && escape != null ? escape.host : null,
        show: surfaceShown,
        /* floatEpoch 进 props：浮层被看门狗重建过之后，新的 host 要重新进顶层，
           否则面板搬进一个还没 showPopover 的宿主里，等于没提上去。 */
        epoch: floatEpoch,
      })
      /* 悬停卡片的高度上界（像素，null = 不钳）。卡片和面板挂在同一个锚点上、
         同样 bottom:100% 向上生长，hero 相位（新会话输入框居中）时卡片顶同样会被会话
         滚动体裁掉 —— 面板是靠钳高度让列表少显示几行，卡片同款：把量到的可见空间
         写成 maxHeight，让卡片里的分支列表（本来就是滚动容器）自己缩、自己滚。
         打开那一刻量一次（useLayoutEffect + setState 发生在绘制前，不会闪一帧自然
         高度）；悬停是转瞬的手势，收起再悬停会重新量，不做逐帧跟随。 */
      const [hoverCap, setHoverCap] = React.useState(null)
      /* Unmounting on close threw away the tab, the filters, the selection and
         the scroll position, and made every reopen a fresh mount that re-read
         everything. Closing now only hides it: the panel keeps its state, and
         nothing is fetched again until something actually changes. */
      if (isOpen) everOpened = true

      useLayoutEffect(function () {
        if (mode !== 'hover' || isOpen === true) {
          /* 收起即松开钳制：下次打开按当时的几何重新量。值没变时 setter 不触发重画。 */
          setHoverCap(function (previous) { return previous === null ? previous : null })
          return undefined
        }
        /* 量的是锚点的上沿。浮层路径量入口探针：面板 display:none 也量得到，而且它
           是本挂载自己的节点，不像全局 chipNode 会被别的会话指走；旧路沿用 chip ——
           chip 挂在输入框卡片里、卡片就是定位祖先，卡片上沿 == overlayAnchor（卡片顶
           的零高锚点）的上沿 == 卡片和悬停卡片共同的锚点上沿。从 chip 量而不是从面板
           量，是因为悬停恰恰发生在面板 display:none 的时候——隐藏元素的 offsetParent
           是 null，量不出锚点；chip 永远在屏。 */
        const probeNow = floated === true ? probeBox.node : null
        const from = probeNow != null ? probeNow
          : (chipNode != null ? chipNode : panelNode)
        const doc = from != null ? from.ownerDocument : null
        const view = doc != null ? doc.defaultView : null
        /* 没有布局的环境（测试、连 rAF 都没有）不钳：卡片按 CSS 的自然高度走。 */
        if (view == null || typeof view.requestAnimationFrame !== 'function') return undefined
        const anchorBox = panelAnchorBox(from)
        const anchorTop = anchorBox != null ? parseFloat(anchorBox.top) : NaN
        if (!isFinite(anchorTop)) return undefined
        /* 浮层路径唯一的上界是视口上沿（0）：body 级浮层不吃会话滚动体的裁剪，
           clipCeiling 沿 chip 祖先量出来的那道滚动体上沿对它不再成立。 */
        let ceiling = 0
        if (floated !== true) {
          const measured = clipCeiling(from, view)
          ceiling = measured != null && isFinite(measured) ? measured : 0
        }
        const room = anchorTop - PANEL_ANCHOR_GAP - PANEL_ANCHOR_SAFETY - ceiling
        if (!isFinite(room)) return undefined
        setHoverCap(room >= SWITCH_MIN_ROOM ? Math.floor(room) : null)
        return undefined
      }, [mode, isOpen])

      React.useEffect(function () {
        if (!isOpen && mode === null) return undefined
        let doc = null
        try {
          const from = switcherNode != null ? switcherNode : (panelNode != null ? panelNode : chipNode)
          doc = from != null ? from.ownerDocument : null
        } catch (error) { doc = null }
        if (doc == null) return undefined
        const onPointerDown = function (event) {
          const target = event.target
          if (target == null || typeof target.nodeType !== 'number') return
          const inChip = chipNode != null && chipNode.contains(target)
          const inCard = switcherNode != null && switcherNode.contains(target)
          /* The panel is the thing on screen whether or not the switcher hangs
              off it. Gating this on the switcher being open was a real bug: with
              nothing open, every click inside the panel counted as an outside
              click and closed it. */
          const inPanel = panelNode != null && panelNode.contains(target)
          /* 崩溃 toast 也是本插件的面：点它（看堆栈、点 ×）不该把面板一起带走。 */
          const inToast = toastLayerContains(target)
          if (inChip || inCard || inToast) return
          if (switchMode !== null) {
            /* Clicking the panel behind the open switcher dismisses the switcher
                — and only the switcher, because the click did land on the panel. */
            setSwitchMode(null)
            if (inPanel) return
          }
          if (inPanel) return
          /* open 却查无根节点 = 面板树已死或浮层被摘（watchdog 的现场）：这一下
             不是「点在外面」，把它记成 outside-click 反而会弄脏账、还会把 open
             复位掉，让看门狗的「先复位再重开」失去诊断机会 —— 让路。 */
          if (isOpen === true && panelSurfaceAlive() !== true) return
          setOpen(false, 'outside-click')
        }
        const onKeyDown = function (event) {
          if (event.key !== 'Escape') return
          /* Escape closes the innermost thing first, so dismissing the switcher
              does not also throw away the panel behind it. */
          if (switchMode !== null) { setSwitchMode(null); return }
          setOpen(false, 'esc')
        }
        doc.addEventListener('pointerdown', onPointerDown, true)
        doc.addEventListener('keydown', onKeyDown, true)
        return function () {
          doc.removeEventListener('pointerdown', onPointerDown, true)
          doc.removeEventListener('keydown', onKeyDown, true)
        }
      }, [isOpen, mode])

      /* display:contents so the wrapper adds no box: the panel keeps positioning
         itself against the same ancestor it always did, and the hover card is an
         absolutely positioned sibling that cannot push it around. */

      /* 悬停卡片的浮层定位：老 CSS（.dsh-git-switch-hover）的 bottom:100% +
         margin-bottom:8px + left:8px 换成视口坐标的同一句几何 —— 底边钉在锚点
         （输入框卡片）上沿之上 8px、左缘从锚点左缘 +8 出发。宽度不再由 JS 钉死：
         left（锚点左缘 +8）和 right（视口右缘收 8px）双锚点把这张绝对定位的卡
         夹成 shrink-to-fit，用出来的宽 = min(内容自然宽, 左右锚点之间的可用宽,
         maxWidth) —— 最长分支名完整看得下（上限与 CSS 的 92vw/880px 同源），窄
         视口先收到可用宽；minWidth 只保住老 456 的观感地板，视口不够时地板跟着
         缩（280 兜底），绝不把卡推出视口。到上限才轮到行内的中间截断兜底。锚点
         量不到（没有布局的极端环境）时贴视口左下（left=8），右缘仍有 right:8px
         兜着，至少完整可见。 */
      let switchStyle = hoverCap !== null ? { maxHeight: hoverCap + 'px' } : undefined
      if (floated === true) {
        const probeNow = probeBox.node
        const view = gitFloatViewportOf(probeNow != null ? probeNow : chipNode)
        const anchorBox = probeNow != null ? panelAnchorBox(probeNow) : null
        const style = Object.assign(
          { position: 'absolute', margin: '0px', bottom: 'auto' },
          switchStyle !== null && switchStyle !== undefined ? switchStyle : {})
        if (view != null) {
          style.width = 'auto'
          style.maxWidth = Math.round(Math.min(view.vw - 16, 880)) + 'px'
          style.minWidth = Math.round(Math.min(456, Math.max(view.vw - 16, 280))) + 'px'
          let left = 8
          if (anchorBox != null && isFinite(parseFloat(anchorBox.left))) {
            left = parseFloat(anchorBox.left) + 8
            if (left < 8) left = 8
          }
          style.left = String(Math.round(left)) + 'px'
          style.right = '8px'
          const anchorTop = anchorBox != null && isFinite(parseFloat(anchorBox.top))
            ? parseFloat(anchorBox.top) : NaN
          style.bottom = String(Math.round(isFinite(anchorTop)
            ? Math.max(0, view.vh - anchorTop + PANEL_ANCHOR_GAP) : 8)) + 'px'
        }
        switchStyle = style
      }

      const panelEl = h(GitPanel, {
        key: 'panel', sessionId: props.sessionId, active: isOpen, ready: everOpened,
        /* 本页有没有会话状态可听（useSession 这类 props）：bridge 版没有，配置页
           拿这句话代替开关的 hint。只看 props 的存在与否，不在这里调 hook —— 真
           的听在 chip 那边（92-chip.js）。 */
        sessionAware: typeof props.useSession === 'function',
        /* 跳出主对话的两句交接：floated 告诉面板按视口坐标摆自己；anchorBox 是
           槽位里那只探针的节点盒（对象身份稳定，面板在测量与渲染时穿过它读
           .node，永远拿到当前那只 —— 首帧 ref 还没回来也不碍事）。 */
        floated: floated === true,
        anchorBox: probeBox,
      })
      const switchEl = mode === 'hover' && isOpen !== true
        ? h('div', {
            key: 'switch',
            className: 'dsh-git-switch dsh-git-switch-hover'
              + (hoverCap !== null ? ' dsh-git-switch-cap' : ''),
            /* 实测的可见空间（见上面的 useLayoutEffect）：卡片从下往上生长，
              maxHeight 收的是它自己的顶。配套的 .dsh-git-switch-cap 让分支列表
              吃掉余下高度自己滚（46-css.js）。浮层路径这里还带整套视口定位。 */
            style: switchStyle,
            ref: function (node) { switcherNode = node },
            onPointerEnter: function () { clearHoverTimer() },
            onPointerLeave: function () { hoverCloseSoon() },
          }, h(BranchPicker, {
            sessionId: props.sessionId,
            repo: chipInfoFor(props.sessionId).repo.length > 0
              ? chipInfoFor(props.sessionId).repo
              : sessionRepo(props.sessionId),
            mode: 'hover',
            dirty: treeCount(chipInfoFor(props.sessionId).repo.length > 0
              ? chipInfoFor(props.sessionId).repo
              : sessionRepo(props.sessionId)),
            onDone: function () { setSwitchMode(null) },
            onClose: function () { setSwitchMode(null) },
          }))
        : null

      /* ── open 巡检（看门狗的第二只眼）──

          打开 300ms 后问一句根节点还在不在文档里：浮层被摘走的场合 open 没变、
          信号都安静，不会有任何重渲染来救 —— 这里喊 healGitFloat，bump 浮层代数
          让本组件重渲染，escape 检出旧 host 已游离会换新的。chip 点击那条
          togglePanelOpen 是第一只眼，管「读者点图标却开不出来」；这只眼管
          「面板开着开着自己消失」。测试环境没有 document，巡检安静跳过。 */
      React.useEffect(function () {
        if (isOpen !== true) return undefined
        if (typeof document === 'undefined' || document == null) return undefined
        return timerOf().timeout(function () {
          if (open !== true) return
          if (panelSurfaceAlive() === true) return
          diagLog('watchdog-recovery', { source: 'panel-watch', detail: '打开后面板根节点不在文档里，重建浮层' })
          healGitFloat()
        }, 300)
      }, [isOpen])

      /* 崩溃护栏圈住面板与悬停卡片：树里任何一层抛错都停在护栏这一层 —— 记账、
         toast、复位 open，而不是把整个槽位子树连锅端。 */
      const guardedEl = h(GitCrashBoundary, { key: 'guard', active: isOpen }, panelEl, switchEl)

      if (floated !== true) return h('div', { className: 'dsh-git-layer' }, guardedEl)
      /* 浮层路径：面板和卡片搬进 body 级浮层；探针留在槽位里当锚 —— 它必须还在
         主对话的框里，量出来的才是输入框的位置。

         portal 的子节点是**两**个：先进顶层的那个空组件，然后才是面板与卡片。
         React 按兄弟次序提交副作用，所以「宿主可见」一定发生在面板子树的布局测量
         之前（见上面 surfaceShown 那一段）。 */
      return h('div', { className: 'dsh-git-layer' },
        h('div', {
          key: 'probe',
          ref: function (node) { probeBox.node = node },
          style: {
            position: 'absolute', left: '0px', top: '0px',
            width: '1px', height: '1px', pointerEvents: 'none',
          },
        }),
        escape.portal([topLayerEl, guardedEl], escape.host))
    }
