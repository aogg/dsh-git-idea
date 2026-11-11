    const LANE_COLORS = ['#4a86e8', '#22a06b', '#d98e04', '#9b59b6', '#d64545', '#0e9aa7', '#b8860b', '#c2478f']
    const ROW_H = 26
    /* 多行提交信息（80-panel.js 的「行：」选择器）的 body 行高：11px 字号 +
       15px 行距（46-css.js 的 .dsh-git-crow-bodyline 是同一个 15px）。固定 N 行档
       的统一行高 = ROW_H + (N-1) × 这个数；「全部」档按每条提交自己的信息行数用
       同一个常数累计 —— 行高、垫块、虚拟窗口的前缀和、提交图圆点的 y 全部从这
       两个常数算出来，不做任何 DOM 测量。 */
    const MSG_LINE_H = 15
    /* One page of history. Big enough that nobody scrolls to the end of it by
       accident, small enough that the first paint of a large repository is a
       single read; `git log` says whether there is more. */
    const PAGE_COMMITS = 200
    const LANE_W = 14

    const DATE_PRESETS = [
      { id: 'all', label: '全部时间', since: '' },
      { id: 'today', label: '今天', since: 'midnight' },
      { id: 'week', label: '最近 7 天', since: '7 days ago' },
      { id: 'month', label: '最近 30 天', since: '30 days ago' },
      { id: 'quarter', label: '最近 90 天', since: '90 days ago' },
    ]

    function dateSince(id) {
      for (let i = 0; i < DATE_PRESETS.length; i += 1) if (DATE_PRESETS[i].id === id) return DATE_PRESETS[i].since
      return ''
    }

    /* git 给的是带时区偏移的 ISO 串（%aI），new Date 解析成绝对时刻后按浏览器
       本地时区显示 —— 原来按字符串切片取年月日，作者时区和本地不同时会把
       「今天」认错。解析不出来回退 text(iso)，让原串自己说话。 */
    function parseDate(iso) {
      if (typeof iso !== 'string' || iso.length < 16) return null
      const at = new Date(iso)
      return isNaN(at.getTime()) ? null : at
    }

    /* 列上的时刻都精确到分钟：今天/昨天按本地零点算天数差（保持原语义），
       今年更早给「MM-DD HH:mm」，跨年带上年份才读得懂 —— 和 57-cmdlog.js 的
       cmdClock 是同一个约定，两位数补零也照它写。 */
    function relativeDate(iso) {
      const at = parseDate(iso)
      if (at === null) return text(iso)
      const two = function (n) { return (n < 10 ? '0' : '') + String(n) }
      const clock = two(at.getHours()) + ':' + two(at.getMinutes())
      const now = new Date()
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const that = new Date(at.getFullYear(), at.getMonth(), at.getDate())
      const days = Math.round((today.getTime() - that.getTime()) / 86400000)
      if (days === 0) return '今天 ' + clock
      if (days === 1) return '昨天 ' + clock
      const day = two(at.getMonth() + 1) + '-' + two(at.getDate())
      return at.getFullYear() === now.getFullYear()
        ? day + ' ' + clock
        : String(at.getFullYear()) + '-' + day + ' ' + clock
    }

    /* 行悬浮提示用的完整时刻（到分钟）：列上省掉的部分总得有个地方看得见。
       解析失败返回空串，调用方就不加这一行。 */
    function fullDate(iso) {
      const at = parseDate(iso)
      if (at === null) return ''
      const two = function (n) { return (n < 10 ? '0' : '') + String(n) }
      return String(at.getFullYear()) + '-' + two(at.getMonth() + 1) + '-' + two(at.getDate())
        + ' ' + two(at.getHours()) + ':' + two(at.getMinutes())
    }

    /* ── 命令页耗时列的形状（57-cmdlog.js 的行内徽标）──

       三个刻度，一个未知：<1s 给毫秒原样（820ms，亚秒的命令占绝大多数，ms 才有
       分辨率）；1s 到 1min 给秒、一位小数（3.2s；10s 以上小数位只是噪音，取整）；
       超过 1min 给分秒（1m24s）。拿不到（null / 负数 / 非数 —— 两端时间戳缺了任何
       一端）是「不知道」，不是 0：画 —。parseFloat 与宿主、排序同一个口径。 */
    function durationText(ms) {
      const n = parseFloat(ms)
      if (isNaN(n) || n < 0) return '—'
      if (n < 1000) return String(Math.round(n)) + 'ms'
      if (n < 60000) {
        const seconds = n / 1000
        return (seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1)) + 's'
      }
      const total = Math.round(n / 1000)
      return String(Math.floor(total / 60)) + 'm' + String(total % 60) + 's'
    }

    function statusClass(status) {
      const head = text(status).charAt(0)
      if (head === 'A') return ' dsh-git-st-A'
      if (head === 'D') return ' dsh-git-st-D'
      if (head === 'R') return ' dsh-git-st-R'
      if (head === 'C') return ' dsh-git-st-C'
      if (head === '?') return ' dsh-git-st-U'
      return ' dsh-git-st-M'
    }

    function statusLabel(status) {
      const head = text(status).charAt(0)
      if (head === 'A' || head === 'D' || head === 'R' || head === 'C' || head === 'U') return head
      if (head === '?') return '?'
      return 'M'
    }

    /* ── "this path is an addition" is one question, asked in one place ──

       `git status --porcelain=v2` prints the index letter and the worktree letter
       together, so a path the index has added reads `A.` (added, unchanged since)
       or `AM` (added, then edited) — a bare `A` is a shape this code base only
       ever made up itself. Two places ask the question: which changelist a row
       belongs to, and what an untick is about to turn this path back into. They
       answered it differently — one took the first letter, the other compared the
       whole string to `A` — and the second one was wrong, so unticking a new file
       (already confirmed by a read, and therefore carrying `A.`) was predicted as
       "modified in the worktree": the row jumped into 默认变更列表 for as long as
       `git restore --staged` and the read behind it took, then jumped back. Asked
       once, the two cannot drift apart again. */
    function addedInIndex(code) {
      return text(code).slice(0, 1) === 'A'
    }

    function splitRefs(value) {
      const raw = text(value)
      if (raw.length === 0) return []
      const parts = raw.split(', ')
      const out = []
      for (let i = 0; i < parts.length; i += 1) if (parts[i].length > 0) out.push(parts[i])
      return out
    }

    function refKind(label) {
      if (label.indexOf('HEAD') === 0) return 'head'
      if (label.indexOf('tag: ') === 0) return 'tag'
      if (label === SHALLOW_REF) return 'shallow'
      return 'remote'
    }

    /* ── `grafted`：git 的浅克隆边界标记，不是引用 ──

       `%D`（git log --pretty=format:%D）在浅克隆的边界提交上会多带一项 `grafted`
       —— 它不是分支也不是标签，是「这条提交的父提交这次克隆没取回来」的记号。
       以前它就和 origin/main 一起进了那排小圆标，屏幕上出现一个英文的灰色小标签，
       谁也说不清那是什么意思。

       所以：**认得它、说中文、说清楚怎么办**。三项一起换 ——
         · 文本：「浅克隆」（列上一眼看得懂，且不挤掉同一行的 ref 装饰）；
         · 类名：dsh-git-ref-shallow（虚线边的灰色药丸，与 remote/tag 都不撞）；
         · 悬浮：一句话讲透含义与出路（那一行自己的 title 里也会再说一次，
           见 50-log.js 的 shallowRefTip）。
       识别只认同名整串（git 自己写的就是这一串），别的引用名一个字都不动。 */
    const SHALLOW_REF = 'grafted'
    const SHALLOW_BADGE = '浅克隆'
    const SHALLOW_REF_TIP = '浅克隆边界提交：更早的提交这次克隆没有取回来，本地历史到这里为止'
      + '（git log 的 grafted 标记）。要看到更早的提交，用面板顶栏 ⇣ 取回按钮右键「取全量历史」'

    function shallowRefTip() {
      return SHALLOW_REF_TIP
    }

