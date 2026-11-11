    /* ── long lists, short renders ──

       The history is one row per commit and can run to a few hundred of them.
       Every render of the panel used to rebuild all of them, including the ones
       scrolled far out of sight, and a panel render happens for things that have
       nothing to do with the list — a keystroke in the search box, a hover.

       A commit row is exactly ROW_H tall and rows are told apart by nothing but
       their index, so which ones are on screen is arithmetic. The one thing that
       has to come from the page is how tall the scroller is; until it says (a
       test harness reports no height, and neither does a browser that has not
       laid the panel out yet) the window is "everything", which is what this did
       before, so a failed measurement can never make a row disappear.

       The optional fourth argument lifts the equal-height rule: the history's
       「行：全部」 passes each row's own height (derived from the commit message,
       never measured), and the window edges come from prefix sums instead of
       division. The arithmetic path below stays exactly what it was. */
    const VIRTUAL_OVERSCAN = 8
    const scrollNodes = {}

    function useVirtualWindow(id, count, rowHeight, heights) {
      const [win, setWin] = React.useState(null)
      /* One identity for the life of the list: a ref callback rebuilt on every
         render makes React detach it and re-attach the node, which would blank
         the measurement in between for no reason at all. */
      const attach = useCallback(function (node) { scrollNodes[id] = node }, [id])
      const measure = function () {
        const node = scrollNodes[id]
        const viewport = node != null && typeof node.clientHeight === 'number' ? node.clientHeight : 0
        if (viewport <= 0) {
          setWin(function (previous) { return previous === null ? previous : null })
          return
        }
        const top = node != null && typeof node.scrollTop === 'number' && node.scrollTop > 0 ? node.scrollTop : 0
        let first = 0
        let last = count
        if (heights !== null && heights !== undefined) {
          /* ── 非等高（历史页的「全部」档）──
             每行自己的高度在 heights 里（CommitList 从提交信息行数算出来），
             前缀和找窗口边界：first = 第一个底边越过 scrollTop 的行，last 是第一个
             底边越过视口下沿的行 —— overscan 与两端的 clamp 和等高路径同一套。
             O(n) 的一次加法遍历，一万行也只是几微秒；等高算术一尘不动。 */
          const limit = Math.min(count, heights.length)
          let at = 0
          let acc = 0
          while (at < limit && acc + heights[at] <= top) { acc += heights[at]; at += 1 }
          first = Math.max(0, at - VIRTUAL_OVERSCAN)
          const bottom = top + viewport
          let end = at
          let seen = acc
          while (end < limit && seen < bottom) { seen += heights[end]; end += 1 }
          last = Math.max(first, Math.min(count, end + VIRTUAL_OVERSCAN))
        } else {
          /* Both ends are clamped to the list: a filter can leave the scroller
             further down than the list is long, and a window that starts past the
             end would paint a spacer taller than the list and nothing else. */
          first = Math.max(0, Math.min(count, Math.floor(top / rowHeight) - VIRTUAL_OVERSCAN))
          last = Math.max(first, Math.min(count, Math.ceil((top + viewport) / rowHeight) + VIRTUAL_OVERSCAN))
        }
        setWin(function (previous) {
          if (previous !== null && previous.first === first && previous.last === last) return previous
          return { first: first, last: last }
        })
      }
      /* Deliberately no dependency list: measuring is idempotent and costs two
         numbers, and re-taking it after every render is what keeps the window
         honest when the panel is resized, a filter shortens the list, or the
         rows are suddenly laid out at a different size. The state setter bails
         out on an unchanged window, so this cannot loop. */
      useLayoutEffect(function () {
        measure()
        return undefined
      })
      /* Clamped again on the way out, because the window was measured against the
         list as it was on the previous render: a re-read that returns a shorter
         history would otherwise ask for rows that no longer exist. The effect
         above corrects the window on the next pass; this keeps the one render in
         between honest. */
      const first = win === null ? 0 : Math.max(0, Math.min(win.first, count))
      const last = win === null ? count : Math.max(first, Math.min(win.last, count))
      return {
        first: first,
        last: last,
        measure: measure,
        attach: attach,
      }
    }
