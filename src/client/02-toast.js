    /* ── 崩溃提示 toast（页面右上角）──

        面板突然崩溃、异常关闭时，读者面前什么都不剩 —— 「莫名其妙就没了」。这里
        补一声看得见的说明：右上角一条 toast，说清出了什么事。刻意不用 React：
        面板崩的恰恰是那棵 React 树，提示器再长在树里就跟着一起死。这里是纯 DOM，
        挂在 document.body 上，面板死活与它无关。

        规矩：多条可堆叠（新的在上，最多 4 条，挤掉最旧的）；5 秒自动关；鼠标悬停
        期间不关（留着看详情），移开后很快收掉；右上 × 可点关。样式走 46-css.js
        同一套 dsw 令牌（.dsh-git-toast 系）。 */

    const TOAST_SHOW_MS = 5000     /* 默认停留：5 秒后自动收 */
    const TOAST_HOVER_MS = 800     /* 悬停结束后的收尾：很快关，但不闪没 */
    const TOAST_MAX = 4            /* 同屏最多几条，超了挤掉最旧的 */
    const TOAST_TEXT_CAP = 2000    /* 正文上限：堆栈动辄几十行，正文只说一句 */
    const TOAST_STACK_CAP = 4000   /* 堆栈上限：够定位，不至于把 DOM 撑爆 */

    let toastHostNode = null

    function toastLayerOf() {
      if (toastHostNode != null) return toastHostNode
      if (typeof document === 'undefined' || document == null) return null
      const body = document.body
      if (body == null || typeof body.appendChild !== 'function') return null
      try {
        const host = document.createElement('div')
        host.className = 'dsh-git-toasts'
        body.appendChild(host)
        toastHostNode = host
        return host
      } catch (error) {
        return null
      }
    }

    /* 点在 toast 上不算「点在面板外」—— 94-popover.js 的 outside-close 问这一句。 */
    function toastLayerContains(target) {
      if (toastHostNode == null || target == null) return false
      if (typeof toastHostNode.contains !== 'function') return false
      try {
        return toastHostNode.contains(target) === true
      } catch (error) {
        return false
      }
    }

    function crashToast(title, message, stackText) {
      const hostLayer = toastLayerOf()
      if (hostLayer == null) return
      const doc = hostLayer.ownerDocument != null ? hostLayer.ownerDocument : document
      if (doc == null || typeof doc.createElement !== 'function') return

      let closed = false
      let timer = null
      const box = doc.createElement('div')
      box.className = 'dsh-git-toast'
      const clearTimer = function () {
        if (timer != null) { clearTimeout(timer); timer = null }
      }
      const close = function () {
        if (closed === true) return
        closed = true
        clearTimer()
        if (box.parentNode != null && typeof box.parentNode.removeChild === 'function') {
          try { box.parentNode.removeChild(box) } catch (error) { /* 已经不在了就算了 */ }
        }
      }
      box.__dshToastClose = close

      const head = doc.createElement('div')
      head.className = 'dsh-git-toast-head'
      const titleEl = doc.createElement('span')
      titleEl.className = 'dsh-git-toast-title'
      titleEl.textContent = typeof title === 'string' && title.length > 0 ? title : 'Git 面板异常关闭'
      const x = doc.createElement('button')
      x.type = 'button'
      x.className = 'dsh-git-toast-x'
      x.title = '关闭'
      x.textContent = '×'
      x.addEventListener('click', function (event) {
        if (event != null && typeof event.stopPropagation === 'function') event.stopPropagation()
        close()
      })
      head.appendChild(titleEl)
      head.appendChild(x)

      const msg = doc.createElement('div')
      msg.className = 'dsh-git-toast-msg'
      const said = typeof message === 'string' ? message.trim() : ''
      msg.textContent = said.length > 0
        ? (said.length > TOAST_TEXT_CAP ? said.slice(0, TOAST_TEXT_CAP) + '…' : said)
        : '未知错误（详情见日志）'

      box.appendChild(head)
      box.appendChild(msg)
      const stack = typeof stackText === 'string' ? stackText.trim() : ''
      if (stack.length > 0) {
        const pre = doc.createElement('pre')
        pre.className = 'dsh-git-toast-stack'
        pre.textContent = stack.length > TOAST_STACK_CAP ? stack.slice(0, TOAST_STACK_CAP) + '…' : stack
        box.appendChild(pre)
      }

      /* 悬停期间不关；移开后很快收 —— 5 秒那条是给「没人在看」的准备。 */
      box.addEventListener('pointerenter', function () { clearTimer() })
      box.addEventListener('pointerleave', function () {
        clearTimer()
        timer = setTimeout(close, TOAST_HOVER_MS)
      })

      /* 新的在上；超过上限从最旧的开始挤。 */
      if (typeof hostLayer.insertBefore === 'function' && hostLayer.firstChild != null) {
        hostLayer.insertBefore(box, hostLayer.firstChild)
      } else {
        hostLayer.appendChild(box)
      }
      while (hostLayer.children != null && hostLayer.children.length > TOAST_MAX) {
        const oldest = hostLayer.lastChild
        if (oldest == null) break
        const evict = typeof oldest.__dshToastClose === 'function' ? oldest.__dshToastClose : null
        if (evict !== null) evict()
        else if (oldest.parentNode != null) hostLayer.removeChild(oldest)
      }
      clearTimer()
      timer = setTimeout(close, TOAST_SHOW_MS)
    }

