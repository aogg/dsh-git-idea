    /* ── 面板「命令」页：这个工作区里执行过的 git 命令 ──

       数据源不是仓库，而是 DSH 自己的会话记录（Host 侧 76-cmdlog.js 扫
       `$DSH_HOME/sessions/<工作区 slug>/…` 里的 bash 调用），所以这一页是纯只读
       展示：不碰索引、不碰引用，连一个 git 进程都不起 —— 「重新读取」重读的也是
       会话文件，不是仓库。

       读数的生死放在 GitPanel（80-panel.js）而不是这里：这一页要「第一次切到才
       读、切走再切回不重读」，列表得比这一页的挂载活得长。这里只管怎么画 ——
       过滤、展开、复制。 */

    /* 时间列：今天只说几点几分，别的日子带上日期 —— 一屏命令几乎都是刚跑的，
       日期那几格只在翻到旧命令时才值得占。Date 的 getHours/getMonth 走的就是
       宿主环境的本地时区。 */
    function cmdClock(value) {
      const at = new Date(parseFloat(value))
      if (isNaN(at.getTime())) return ''
      const two = function (n) { return (n < 10 ? '0' : '') + String(n) }
      const clock = two(at.getHours()) + ':' + two(at.getMinutes())
      const now = new Date()
      if (at.getFullYear() === now.getFullYear()
        && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) return clock
      /* 跨年的命令不带年份就没法读：去年 10-07 和今年 10-07 在列表里长得一样。 */
      const day = two(at.getMonth() + 1) + '-' + two(at.getDate())
      return at.getFullYear() === now.getFullYear()
        ? day + ' ' + clock
        : String(at.getFullYear()) + '-' + day + ' ' + clock
    }

    /* 悬浮提示里给完整时刻（到秒）：列上省掉的那部分总得有个地方看得见。 */
    function cmdClockFull(value) {
      const at = new Date(parseFloat(value))
      if (isNaN(at.getTime())) return ''
      const two = function (n) { return (n < 10 ? '0' : '') + String(n) }
      return String(at.getFullYear()) + '-' + two(at.getMonth() + 1) + '-' + two(at.getDate())
        + ' ' + two(at.getHours()) + ':' + two(at.getMinutes()) + ':' + two(at.getSeconds())
    }

    function CommandLogPane(props) {
      const log = props.log
      const [filter, setFilter] = React.useState('')
      /* 展开状态按**整份列表里的下标**记，不按过滤后的位置：过滤词一变，过滤列表
         的第 3 行就是另一条命令了，而下标永远指着同一条。 */
      const [open, setOpen] = React.useState({})
      /* { key, text }：复制那一下的结果，说在那颗按钮旁边。 */
      const [note, setNote] = React.useState(null)
      /* 展开行的 <pre> 节点按行键记：剪贴板被浏览器拒绝时的退路是「把这段文本
         选成选区」，选区要拿得到节点才行。 */
      const [pres] = React.useState(function () { return {} })

      const loading = log == null || log.loading === true
      const commands = log != null && Array.isArray(log.commands) ? log.commands : []

      /* 剪贴板的退路：writeText 用不了（非安全上下文、权限被收）时，把展开的
         命令文本选成选区 —— Ctrl+C 还在读者手里，比一句「复制失败」有用。DOM
         不可用（无布局的测试环境）就老实说做不到，不装成功。 */
      const selectFallback = function (key) {
        const node = pres[key]
        const doc = node != null ? node.ownerDocument : null
        const view = doc != null ? doc.defaultView : null
        if (node == null || doc == null || typeof doc.createRange !== 'function'
          || view == null || typeof view.getSelection !== 'function') return false
        const range = doc.createRange()
        range.selectNodeContents(node)
        const selection = view.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        return true
      }

      const copyCommand = function (key, command) {
        if (typeof navigator !== 'undefined' && navigator.clipboard != null
          && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(command).then(function () {
            setNote({ key: key, text: '已复制' })
          }, function (failure) {
            /* 拒绝的原因留一条日志（好查为什么总是走退路），屏幕上给的是能用的下一步 */
            console.error('dsh-git-idea: clipboard write refused', failureText(failure))
            setNote({ key: key, text: selectFallback(key) ? '已选中命令文本，按 Ctrl+C 复制' : '复制失败：浏览器拒绝了剪贴板' })
          })
          return
        }
        setNote({ key: key, text: selectFallback(key) ? '已选中命令文本，按 Ctrl+C 复制' : '复制失败：这个环境没有剪贴板' })
      }

      /* 过滤只筛手里这份列表（命令与描述两处都找），不发请求：会话记录是快照，
         不是能再问一遍的实时状态。 */
      const needle = filter.trim().toLowerCase()
      const rows = []
      let shownCount = 0
      for (let i = 0; i < commands.length; i += 1) {
        const one = commands[i]
        const command = text(one.command)
        if (needle.length > 0
          && command.toLowerCase().indexOf(needle) < 0
          && text(one.description).toLowerCase().indexOf(needle) < 0) continue
        shownCount += 1
        const key = 'c' + String(i)
        const exit = one.exitCode
        const sid = text(one.sessionId)
        rows.push(h('div', {
          key: key,
          className: 'dsh-git-cmdline',
          title: command,
          onClick: function () {
            setOpen(function (previous) {
              const next = Object.assign({}, previous)
              if (next[key] === true) delete next[key]
              else next[key] = true
              return next
            })
            /* 展开/收起时，上一次复制的反馈不再属于屏幕上任何东西 */
            setNote(null)
          },
        },
          h('span', { key: 't', className: 'dsh-git-cmdtime', title: cmdClockFull(one.time) }, cmdClock(one.time)),
          h('span', { key: 'x', className: 'dsh-git-cmdtext' }, command),
          text(one.description).length > 0
            ? h('span', { key: 'd', className: 'dsh-git-cmdesc', title: text(one.description) }, text(one.description))
            : null,
          typeof exit === 'number' && parseFloat(exit) > 0
            ? h('span', { key: 'e', className: 'dsh-git-cmdfail', title: '退出码 ' + String(parseInt(exit, 10)) }, '✗' + String(parseInt(exit, 10)))
            : null,
          sid.length > 0
            ? h('span', { key: 's', className: 'dsh-git-cmdsrc', title: '来自会话 ' + sid }, sid.slice(0, 8))
            : null))
        if (open[key] === true) {
          rows.push(h('div', { key: key + ':open', className: 'dsh-git-cmdopen' },
            /* pre-wrap：会话里一条命令带换行的地方，就是它本来换行的地方 */
            h('pre', { key: 'p', className: 'dsh-git-cmdpre', ref: function (node) { pres[key] = node } }, command),
            h('button', {
              key: 'c', type: 'button', className: 'dsh-git-btn',
              onClick: function (event) {
                event.stopPropagation()
                copyCommand(key, command)
              },
            }, '复制'),
            note != null && note.key === key ? h('span', { key: 'n', className: 'dsh-git-cmdnote' }, note.text) : null))
        }
      }

      const bar = h('div', { key: 'bar', className: 'dsh-git-cmdbar' },
        h('button', {
          key: 'r', type: 'button', className: 'dsh-git-btn', disabled: loading,
          title: '重新读一遍这个工作区的会话记录（不碰仓库）', onClick: props.onReload,
        }, '重新读取'),
        h('input', {
          key: 'f', className: 'dsh-git-cmdfilter',
          placeholder: '过滤命令…',
          title: '按子串过滤当前列表（命令与描述都找，忽略大小写，不发请求）',
          value: filter,
          onChange: function (event) { setFilter(event.target.value) },
        }),
        loading ? null : h('span', {
          key: 'n', className: 'dsh-git-dim',
          title: needle.length > 0 ? '当前过滤词命中的条数 / 列表总数' : '列表里的命令条数',
        }, needle.length > 0
          ? '匹配 ' + String(shownCount) + ' / ' + String(commands.length) + ' 条'
          : String(commands.length) + ' 条'),
        /* Host 那边按 limit 截过尾：不说的话，「最近怎么会只有 500 条」就成了悬案 */
        loading !== true && log != null && log.truncated === true
          ? h('span', { key: 't', className: 'dsh-git-cmdtrunc', title: '会话记录里的命令比这多，只取了最近这些' },
              '只显示最近 ' + String(commands.length) + ' 条')
          : null)

      if (loading) {
        return h('div', { className: 'dsh-git-cmd' }, bar,
          h('div', { key: 'w', className: 'dsh-git-pane dsh-git-dim' }, '正在读取会话记录…'))
      }
      if (log != null && log.error != null) {
        /* ok:false 的原话（沙箱拒绝、没有 node、超时……）必须原样说出来 —— 折成
           空列表就成了「这个项目没跑过 git」，那是另一个问题的答案。 */
        return h('div', { className: 'dsh-git-cmd' }, bar,
          h('div', { key: 'e', className: 'dsh-git-pane dsh-git-error', style: { whiteSpace: 'pre-wrap' } }, log.error))
      }
      return h('div', { className: 'dsh-git-cmd' }, bar,
        h('div', { key: 'list', className: 'dsh-git-cmdlist' },
          commands.length === 0
            ? h('div', { key: 'empty', className: 'dsh-git-pane dsh-git-dim' }, '还没有执行过 git 命令')
            : rows.length === 0
              ? h('div', { key: 'none', className: 'dsh-git-pane dsh-git-dim' }, '没有匹配的命令')
              : rows))
    }
