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
      /* 窗口镜像与「刚自提交过一窗」的记号，挂盒不挂 state（client 侧没有 useRef，
         80-panel.js 的 draftBox 同一个先例）：镜像让 measure 在 setState 之前就能
         判等，记号让布局副作用知道自己上一趟是不是刚换过窗。 */
      const [box] = React.useState(function () { return { win: null, settle: false } })
      /* One identity for the life of the list: a ref callback rebuilt on every
         render makes React detach it and re-attach the node, which would blank
         the measurement in between for no reason at all. */
      const attach = useCallback(function (node) { scrollNodes[id] = node }, [id])
      /* 提交一窗。判等挪到 setState 之前做（原来写在 setWin 的 updater 里，靠
         React 对同值 updater 的 bail-out；行为等价）—— 镜像与 state 只经这一个
         入口更新，不会漂移。真的要换窗时顺手立起 settle，见下面布局副作用。 */
      const commit = function (next) {
        const previous = box.win
        if (previous === null && next === null) return
        if (previous !== null && next !== null
          && previous.first === next.first && previous.last === next.last) return
        box.win = next
        box.settle = true
        setWin(next)
      }
      const measure = function () {
        const node = scrollNodes[id]
        const viewport = node != null && typeof node.clientHeight === 'number' ? node.clientHeight : 0
        if (viewport <= 0) {
          commit(null)
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
        commit({ first: first, last: last })
      }
      /* Deliberately no dependency list: measuring is idempotent and costs two
         numbers, and re-taking it after every render is what keeps the window
         honest when the panel is resized, a filter shortens the list, or the
         rows are suddenly laid out at a different size.

         但「复量幂等所以不会循环」只对「两次复量同值」成立，换几何的那一帧它不
         成立：「行：」换档整列一起改行高，真浏览器在渲染间那几次强制布局里还夹
         着滚动锚定/截断的调整，连续两趟复量可能各得一个不同的窗；measure 的
         setState 又立刻引来下一趟同步复量 —— A→B→A 无限嵌套，50 层后 React 以
         #185（Maximum update depth exceeded）收掉整棵面板树，护栏（94-popover.js
         的 GitCrashBoundary）弹「面板异常关闭」（2026-11-16 历史 tab 换档崩溃，
         落盘堆栈实证循环走的就是这条 measure 链）。所以 measure 每次真的换窗后
         立起 settle，紧随其后那趟布局副作用跳过一次复量：自己引发的同步链就此
         截断，终止不再依赖「复量必同值」；窗口的后续纠正交给下一趟渲染与滚动
         事件 —— onScroll 仍即时复量，滚动中的窗口照旧逐像素诚实。 */
      useLayoutEffect(function () {
        if (box.settle === true) {
          box.settle = false
          return undefined
        }
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
