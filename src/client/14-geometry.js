    /* ── 向上生长的浮层：真实上界 ──

       面板（.dsh-git-pop）和 chip 的悬停卡片（.dsh-git-switch-hover）都 absolute 挂在
       输入框卡片上沿（官方 overlayAnchor：height:0、absolute、贴着卡片顶），一律
       bottom:100% 向上生长。而输入框整棵子树住在会话的滚动体里（官方 .scrollBody，
       overflow-y:auto，它上面还有一截页头）—— 滚动容器只会向**下**扩展可滚动区域，
       超出滚动体上沿的那部分永远滚不回来，是被直接裁掉的。所以「不越过视口上沿」
       不等于「看得见」：新会话（hero 相位）输入框垂直居中时，按视口上沿钳出来的
       面板顶恰好落在滚动体上沿之上，头部整条被裁且无法滚出 —— 这就是 15ab5a3 只按
       视口钳高之后，hero 相位仍然显示不全的根因。

       上界因此全部实测，不认官方类名：从浮层节点沿 parentElement 向上走，凡是
       overflow-y 会裁剪（auto/scroll/hidden/clip）的祖先，它的可见上沿（border 盒
       top 加上边框宽度）就是一道上界，取其中最靠下的（max），再和视口上沿（0）取
       max。官方结构怎么变都不影响；哪一环量不出来（没有布局的环境、display:contents
       的 0×0 包裹层、拿不到 getComputedStyle）就跳过那一环，一环都量不到时退回视口
       上沿 —— 与不知道有滚动体时（15ab5a3 的行为）完全一致。

       沿 parentElement 而不是 offsetParent（containing block 链）走是有意的：滚动体
       常常不是定位元素，不在浮层的 CB 链上，却实实在在地裁掉「CB 在它里面的定位
       后代」；把一道不可能生效的上界多算进来，代价只是面板矮几像素，漏掉真正裁人
       的那一道，代价是头部整个不见了。 */
    const CLIP_OVERFLOW_Y = { auto: true, scroll: true, hidden: true, clip: true }

    /* 内容挂在 node 所在的锚点之上时，还能露出的最高一处的纵坐标（视口坐标）。
       view 是 node 所在的 window：有它才有「视口上沿 = 0」这道最后的上界；
       没有可量的一切时返回 null，调用方按「不知道上界」处理。 */
    const clipCeiling = function (node, view) {
      let ceiling = view != null && isFinite(parseFloat(view.innerHeight)) ? 0 : null
      let current = node != null ? node.parentElement : null
      /* 64 层封顶：正常的会话树到 html 也就十几层，这个数只为防意外的环。 */
      for (let depth = 0; current != null && depth < 64; depth += 1) {
        const doc = current.ownerDocument
        /* 节点自己问不到 document 时退回调用方给的 window：真实 DOM 里元素都有
           ownerDocument，这一手只伺候没有布局环境的替身节点。 */
        const win = doc != null && doc.defaultView != null ? doc.defaultView : view
        const style = win != null && typeof win.getComputedStyle === 'function'
          ? win.getComputedStyle(current)
          : null
        const overflowY = style != null ? String(style.overflowY || '') : ''
        if (CLIP_OVERFLOW_Y[overflowY] === true && typeof current.getBoundingClientRect === 'function') {
          const box = current.getBoundingClientRect()
          /* 0×0 的盒子（display:contents 的包裹层、还没布局的元素）不是边界：
             把它的 0 当成「贴着视口顶」和 15ab5a3 犯的是同一个错。 */
          if (parseFloat(box.width) > 0 || parseFloat(box.height) > 0) {
            const top = parseFloat(box.top) + (style != null ? parseFloat(style.borderTopWidth) || 0 : 0)
            if (isFinite(top) && (ceiling === null || top > ceiling)) ceiling = top
          }
        }
        current = current.parentElement
      }
      return ceiling
    }
