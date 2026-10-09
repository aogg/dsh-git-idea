    /* ── 面板「命令」页：这个工作区里执行过的 git 命令 ──

       数据源是会话记录 + 面板执行记录两路（Host 在出口合成一份，host 侧 76-cmdlog.js
       与 77-cmdrec.js）：前者扫 `$DSH_HOME/sessions/<工作区 slug>/…` 里的 bash 调用，
       后者是面板自己经 RPC 跑的 git（source === 'panel'，右侧徽标画成「面板」）。所以
       这一页是纯只读展示：不碰索引、不碰引用，连一个 git 进程都不起 —— 「重新读取」
       重读的也是记录，不是仓库。

       读数的生死放在 GitPanel（80-panel.js）而不是这里：弹窗一打开就在后台预读，
       之后的每个刷新时机（切到这页、这页开着时仓库 bump、点「重新读取」）都走同一
       条后台路 —— 手里已有列表就绝不清空、绝不置 loading，读完按行身份增量合并，
       列表得比这一页的挂载活得长。这里除了怎么画（过滤、展开、复制），还住着行的
       身份（cmdlogRowKey）与合并（cmdlogMergeRows）：key 和合并是数据的事，画法只
       是它最大的客户，放同一片里两头都能直接用。 */

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

    /* ── 行身份：同一行在多次读、推送与合并之间必须是同一把 key ──

       整表替换的年代里 key 只是 React 的内部事务，拿个下标也能跑；改成增量合并之后
       key 成了数据的身份证 —— 去重按它、新旧行相认按它、展开状态跟着它走。两类行
       的身份来源不一样：面板行有唯一 id（77-cmdrec.js 生成）；会话行没有 id，只能
       拿「会话 + 归一化时刻 + 命令」拼一把 —— command 最长 2000 字符，当 key 太长，
       djb2 压成 base36 再带上原长。时刻用 parseFloat 归一（与宿主、排序同一个口径），
       同一行跨多少次读 key 都必须一致，这是合并正确性的全部前提。 */
    function cmdlogCommandHash(value) {
      let hash = 5381
      for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0
      return hash.toString(36)
    }

    function cmdlogRowKey(one, at) {
      /* Host 不会给出不是对象的行；真混进来就按位置给一把（只求不炸，不求是它）。 */
      if (one == null || typeof one !== 'object') return 'j' + String(at)
      if (one.id != null) return 'p' + String(one.id)
      const command = typeof one.command === 'string' ? one.command : ''
      return 's' + text(one.sessionId) + '|' + String(parseFloat(one.time) || 0) + '|'
        + cmdlogCommandHash(command) + '.' + String(command.length)
    }

    /* ── 增量合并：旧列表 + 新答复 → 一份 ──

       同 key 的行以新答复那份为准（正在跑的行退出码从 null 变成真值，就该换新的），
       旧列表独有的行原样保留（答复按 limit 截掉的和两次读之间推送补进来的都在），
       新答复独有的行收进来，最后按 time 降序排一遍、截掉最旧的尾巴。Array 的 sort
       在 ES2019 之后是稳定的：合并数组的顺序本来就是「旧行在前、新行在后」，稳定性
       正好给出「同 time 保持旧在前」。上一份合并的产物本身就是按 key 去过重的，所以
       旧列表里不会有同 key 两行；新答复内部同 key 的重复行只收第一次 —— 收两次的
       话 React 的 key 就撞了。 */
    function cmdlogMergeRows(previousRows, incomingRows, cap) {
      const oldRows = Array.isArray(previousRows) ? previousRows : []
      const freshRows = Array.isArray(incomingRows) ? incomingRows : []
      const freshByKey = {}
      for (let i = 0; i < freshRows.length; i += 1) {
        const one = freshRows[i]
        if (one == null || typeof one !== 'object') continue
        freshByKey[cmdlogRowKey(one, i)] = one
      }
      const merged = []
      const taken = {}
      for (let i = 0; i < oldRows.length; i += 1) {
        const one = oldRows[i]
        const key = cmdlogRowKey(one, i)
        if (freshByKey[key] !== undefined) {
          taken[key] = true
          merged.push(freshByKey[key])
        } else merged.push(one)
      }
      for (let i = 0; i < freshRows.length; i += 1) {
        const one = freshRows[i]
        if (one == null || typeof one !== 'object') continue
        const key = cmdlogRowKey(one, i)
        if (taken[key] === true) continue
        taken[key] = true
        merged.push(one)
      }
      merged.sort(function (a, b) { return (parseFloat(b.time) || 0) - (parseFloat(a.time) || 0) })
      if (typeof cap === 'number' && cap > 0 && merged.length > cap) merged.length = cap
      return merged
    }

    function CommandLogPane(props) {
      const log = props.log
      const [filter, setFilter] = React.useState('')
      /* 展开状态按**行身份 key** 记（上面的 cmdlogRowKey），不按下标：列表是增量
         合并来的，同一行在重读、推送前后是同一把 key —— 新行插到最前、旧行被新答复
         换新，展开着的还是原来那一行。按整份列表下标记的年代里，一行 prepend 会把
         所有展开状态错位一格（第 3 行展开的忽然变成第 4 行），这里顺带把那个缺陷
         一起埋了。 */
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
        const key = cmdlogRowKey(one, i)
        const exit = one.exitCode
        const sid = text(one.sessionId)
        /* 面板执行（source === 'panel'）的行：右侧徽标画「面板」，不画会话号 —— 它
           不是 AI 会话里跑的，会话号反而是噪音。退出码还空着的面板行是正在跑的：给
           一个会动的省略号当「运行中」，结束时由推送（80-panel.js 的 live 订阅）补上
           真退出码。 */
        const fromPanel = one.source === 'panel'
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
          fromPanel === true && exit == null
            ? h('span', { key: 'r', className: 'dsh-git-cmdrun', title: '执行中' }, '…')
            : null,
          fromPanel === true
            ? h('span', { key: 's', className: 'dsh-git-cmdsrc dsh-git-cmdpanel', title: '来自 git 面板操作' }, '面板')
            : (sid.length > 0
              ? h('span', { key: 's', className: 'dsh-git-cmdsrc', title: '来自会话 ' + sid }, sid.slice(0, 8))
              : null)))
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
          title: '重新读一遍这个工作区的会话记录与面板执行记录（不碰仓库）', onClick: props.onReload,
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
        /* 后台刷新中：列表照常画，条数旁只说一句轻的 —— 读者不该为一遍重扫付出
           一页「正在读取」的空白帧，但屏上有读在飞这件事得看得见。 */
        log != null && log.refreshing === true
          ? h('span', {
              key: 'rf', className: 'dsh-git-dim',
              title: '后台正在重新读一遍记录；列表先照旧画，读完只把新的几行并进来',
            }, '刷新中…')
          : null,
        /* Host 那边按 limit 截过尾：不说的话，「最近怎么会只有 500 条」就成了悬案 */
        loading !== true && log != null && log.truncated === true
          ? h('span', { key: 't', className: 'dsh-git-cmdtrunc', title: '会话记录里的命令比这多，只取了最近这些' },
              '只显示最近 ' + String(commands.length) + ' 条')
          : null)

      if (loading) {
        return h('div', { className: 'dsh-git-cmd' }, bar,
          h('div', { key: 'w', className: 'dsh-git-pane dsh-git-dim' }, '正在读取命令记录…'))
      }
      /* 会话扫描那一路读不了、但面板记录给得出来时，Host 给的原话在这里照实说：
         列表照常能用，但读者得知道少了一路。 */
      const warning = log != null ? text(log.warning) : ''
      const warningRow = warning.length > 0
        ? h('div', { key: 'warn', className: 'dsh-git-pane dsh-git-dim', title: warning, style: { whiteSpace: 'pre-wrap' } },
            '会话记录读不了：' + warning)
        : null
      /* 手里有列表吗：loading 的首读记录没有 commands 数组，刷新失败却留着列表。 */
      const hasList = log != null && Array.isArray(log.commands) === true
      if (log != null && log.error != null && hasList !== true) {
        /* ok:false 的原话（沙箱拒绝、没有 node、超时……）必须原样说出来 —— 折成
           空列表就成了「这个项目没跑过 git」，那是另一个问题的答案。手里没有任何
           列表（首读就失败）时才整页只显错误：没有东西可保。 */
        return h('div', { className: 'dsh-git-cmd' }, bar,
          h('div', { key: 'e', className: 'dsh-git-pane dsh-git-error', style: { whiteSpace: 'pre-wrap' } }, log.error))
      }
      /* 手里有列表时的失败（后台刷新读不动了）：列表照常能用 —— 它仍是手里最新的
         一份，整页错误等于把能用的东西藏起来；错误原话挂在列表上方，下一次读成了
         它自己会消失。 */
      const errorRow = log != null && log.error != null && hasList === true
        ? h('div', { key: 'err', className: 'dsh-git-pane dsh-git-error', style: { whiteSpace: 'pre-wrap' } }, log.error)
        : null
      return h('div', { className: 'dsh-git-cmd' }, bar, warningRow, errorRow,
        h('div', { key: 'list', className: 'dsh-git-cmdlist' },
          commands.length === 0
            ? h('div', { key: 'empty', className: 'dsh-git-pane dsh-git-dim' }, '还没有执行过 git 命令')
            : rows.length === 0
              ? h('div', { key: 'none', className: 'dsh-git-pane dsh-git-dim' }, '没有匹配的命令')
              : rows))
    }
