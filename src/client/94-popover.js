    /* 悬停卡片低于这个可见空间就不钳：塞不下搜索行 + 几行分支 + 建行脚的卡片，
       钳了也是一张压碎的卡，不如维持自然高度（极端矮窗口下保持原行为）。 */
    const SWITCH_MIN_ROOM = 200

    function GitPopover(props) {
      const isOpen = useOpen()
      const mode = useSwitchMode()
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
          if (inChip || inCard) return
          if (switchMode !== null) {
            /* Clicking the panel behind the open switcher dismisses the switcher
               — and only the switcher, because the click did land on the panel. */
            setSwitchMode(null)
            if (inPanel) return
          }
          if (inPanel) return
          setOpen(false)
        }
        const onKeyDown = function (event) {
          if (event.key !== 'Escape') return
          /* Escape closes the innermost thing first, so dismissing the switcher
             does not also throw away the panel behind it. */
          if (switchMode !== null) { setSwitchMode(null); return }
          setOpen(false)
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

      if (floated !== true) return h('div', { className: 'dsh-git-layer' }, panelEl, switchEl)
      /* 浮层路径：面板和卡片搬进 body 级浮层；探针留在槽位里当锚 —— 它必须还在
         主对话的框里，量出来的才是输入框的位置。 */
      return h('div', { className: 'dsh-git-layer' },
        h('div', {
          key: 'probe',
          ref: function (node) { probeBox.node = node },
          style: {
            position: 'absolute', left: '0px', top: '0px',
            width: '1px', height: '1px', pointerEvents: 'none',
          },
        }),
        escape.portal([panelEl, switchEl], escape.host))
    }
