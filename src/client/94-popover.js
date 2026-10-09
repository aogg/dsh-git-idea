    /* 悬停卡片低于这个可见空间就不钳：塞不下搜索行 + 几行分支 + 建行脚的卡片，
       钳了也是一张压碎的卡，不如维持自然高度（极端矮窗口下保持原行为）。 */
    const SWITCH_MIN_ROOM = 200

    function GitPopover(props) {
      const isOpen = useOpen()
      const mode = useSwitchMode()
      /* 分支卡片上那个「几个改动」也来自全局那一份读数：同一个数字在面板、chip 和这张
         卡片上必须是同一个。 */
      useTreeVersion()
      /* 悬停卡片的高度上界（像素，null = 不钳）。卡片和面板挂在同一个锚点上、同样
         bottom:100% 向上生长，hero 相位（新会话输入框居中）时卡片顶同样会被会话
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
        /* 量的是 chip 的定位祖先（panelAnchorBox 通用：offsetParent 的 rect）：chip
           挂在输入框卡片里、卡片就是定位祖先，卡片上沿 == overlayAnchor（卡片顶的
           零高锚点）的上沿 == 卡片和悬停卡片共同的锚点上沿。从 chip 量而不是从面板
           量，是因为悬停恰恰发生在面板 display:none 的时候——隐藏元素的 offsetParent
           是 null，量不出锚点；chip 永远在屏。 */
        const from = chipNode != null ? chipNode : panelNode
        const doc = from != null ? from.ownerDocument : null
        const view = doc != null ? doc.defaultView : null
        /* 没有布局的环境（测试、连 rAF 都没有）不钳：卡片按 CSS 的自然高度走。 */
        if (view == null || typeof view.requestAnimationFrame !== 'function') return undefined
        const anchorBox = panelAnchorBox(from)
        const anchorTop = anchorBox != null ? parseFloat(anchorBox.top) : NaN
        if (!isFinite(anchorTop)) return undefined
        const ceiling = clipCeiling(from, view)
        const room = anchorTop - PANEL_ANCHOR_GAP - PANEL_ANCHOR_SAFETY
          - (ceiling != null && isFinite(ceiling) ? ceiling : 0)
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
      return h('div', { className: 'dsh-git-layer' },
        h(GitPanel, {
          key: 'panel', sessionId: props.sessionId, active: isOpen, ready: everOpened,
          /* 本页有没有会话状态可听（useSession 这类 props）：bridge 版没有，配置页
             拿这句话代替开关的 hint。只看 props 的存在与否，不在这里调 hook —— 真
             的听在 chip 那边（92-chip.js）。 */
          sessionAware: typeof props.useSession === 'function',
        }),
        mode === 'hover' && isOpen !== true
          ? h('div', {
              key: 'switch',
              className: 'dsh-git-switch dsh-git-switch-hover'
                + (hoverCap !== null ? ' dsh-git-switch-cap' : ''),
              /* 实测的可见空间（见上面的 useLayoutEffect）：卡片从下往上生长，
                maxHeight 收的是它自己的顶。配套的 .dsh-git-switch-cap 让分支列表
                吃掉余下高度自己滚（46-css.js）。 */
              style: hoverCap !== null ? { maxHeight: hoverCap + 'px' } : undefined,
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
          : null)
    }
