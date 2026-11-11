    function GraphCanvas(props) {
      const rows = props.rows
      const commits = props.commits
      const laneCount = Math.max(1, props.lanes)
      const width = laneCount * LANE_W + 6
      /* ── 行几何（「行：」选择器，CommitList 算好递进来）──
         rowH：固定 N 行档的统一行高；rowTops：「全部」档每行的 y 起点（前缀和，
         长度 = 行数 + 1，末项是总高）。两档都不带（默认 1 行）时公式退回
         row * ROW_H —— 与从前逐像素相同。高度全部从数据算，没有 DOM 测量。 */
      const rowH = typeof props.rowH === 'number' && props.rowH > 0 ? props.rowH : ROW_H
      const rowTops = Array.isArray(props.rowTops) ? props.rowTops : null
      const height = rowTops !== null && rowTops.length > 0 ? rowTops[rowTops.length - 1] : commits.length * rowH
      /* Only the rows inside the window are drawn, but their coordinates stay
         absolute, because the svg still spans the whole list: an edge from a
         visible row to a parent far below is still the same curve it was. */
      const first = typeof props.first === 'number' ? props.first : 0
      const last = typeof props.last === 'number' ? Math.min(props.last, rows.length) : rows.length
      /* Rebuilt only when the history itself changes. It used to be built on
         every render, and the graph re-renders on every scroll tick (the window
         edges are its props) — so scrolling a 400-commit history rebuilt a
         400-entry map per frame for the two hashes the window's edges look up. */
      const rowOf = useMemo(function () {
        const map = {}
        for (let i = 0; i < commits.length; i += 1) map[commits[i].hash] = i
        return map
      }, [commits])
      const cx = function (lane) { return lane * LANE_W + LANE_W / 2 + 3 }
      /* 一行的 y 起点；圆点对齐的 subject 行永远占这一行的头 ROW_H 像素，圆点钉在
         它的正中 —— 无论这一行总共多高（多行档）还是整行就是 26px（默认）。 */
      const top = function (row) {
        if (rowTops !== null) { const at = rowTops[row]; return at === undefined ? row * rowH : at }
        return row * rowH
      }
      const cy = function (row) { return top(row) + ROW_H / 2 }
      /* Where a line that leaves this list goes: the bottom of the rows that are
         drawn. It used to stop one row under its own dot, which is what made a
         filtered history look like a row of lollipops — every match with a
         parent the filter hid drew a ten-pixel tail and nothing else. */
      const exitY = cy(Math.max(first, last - 1)) + rowH
      const shapes = []
      for (let i = first; i < last; i += 1) {
        const row = rows[i]
        for (let k = 0; k < row.edges.length; k += 1) {
          const edge = row.edges[k]
          const target = rowOf[edge.hash]
          const x1 = cx(row.lane)
          const y1 = cy(i)
          const x2 = cx(edge.lane)
          const y2 = target === undefined ? exitY : cy(target)
          const mid = (y1 + y2) / 2
          shapes.push(h('path', {
            key: 'e' + i + '_' + k,
            d: 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + mid + ', ' + x2 + ' ' + mid + ', ' + x2 + ' ' + y2,
            fill: 'none',
            stroke: LANE_COLORS[row.lane % LANE_COLORS.length],
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            /* Dashed means the same thing IDEA means by it: this edge is real,
               but the commits along it are not in the list — a filter hid them
               (see layoutVisible in the Host half). */
            strokeDasharray: edge.dashed === true ? '3 3' : undefined,
          }))
        }
      }
      for (let i = first; i < last; i += 1) {
        shapes.push(h('circle', {
          key: 'n' + i,
          cx: cx(rows[i].lane),
          cy: cy(i),
          r: 3.6,
          fill: LANE_COLORS[rows[i].lane % LANE_COLORS.length],
          stroke: 'var(--dsw-alias-bg-layer-1)',
          strokeWidth: 1.5,
        }))
      }
      return h('svg', { className: 'dsh-git-graph', width: width, height: height }, shapes)
    }
    /* Redrawn only when the history itself changes: picking a commit, hovering a
       row or typing in the filter box does not move a single one of these lines. */
    const GraphCanvasMemo = memo(GraphCanvas)

    /* One commit, as its own component so that picking a commit repaints the two
       rows whose highlight changed instead of every row on screen. `selected` is
       a boolean rather than the picked hash for exactly that reason: the other
       rows' props are then untouched by a new selection. `multi`（Ctrl+点击挑进
       多选的那批）同理也是布尔。 */
    function CommitRow(props) {
      const commit = props.commit
      const refs = splitRefs(commit.refs)
      /* 悬浮提示第三行给完整时刻（40-format.js 的 fullDate）：列上只到
         「今天 HH:mm」这一层，哪一分钟提交的要看这里。 */
      const when = fullDate(commit.date)
      /* ── 「行：」显示行数（80-panel.js 的选择器）──
         1 = 现在的单行，DOM 与从前完全一致；固定 N（2..10）与「全部」共用同一副
         多行骨架：第一行是原班横排（subject/refs/作者/时间，仍占 26px，提交图的
         圆点对齐它），body 从第 2 行起逐行省略。固定档整行等高（信息不足 N 行就
         留白，行高不缩），「全部」按自己的信息行数定高 —— 两个高度都从
         commitMsgLines 的同一份数据算（MSG_LINE_H），虚拟窗口、垫块与图几何用的
         是同一笔账。title 无论哪档都带上完整提交信息（数据现成）。 */
      const lines = commitMsgLines(commit)
      const msgLines = props.msgLines === undefined || props.msgLines === 1 ? 1 : props.msgLines
      const tall = msgLines !== 1
      const shown = tall === false ? null : (msgLines === 'all' ? lines : lines.slice(0, msgLines))
      const height = tall === false ? ROW_H
        : (msgLines === 'all'
          ? ROW_H + (lines.length - 1) * MSG_LINE_H
          : ROW_H + (msgLines - 1) * MSG_LINE_H)
      const chips = []
      /* 浅克隆边界（git 的 grafted）：git 的原始说法换成中文小标签，并带上说明。
         同一个数组里其它装饰（HEAD -> main / origin/main / tag: v1）一个字都不动，
         只是每一项的 kind 可能变成 'shallow'（40-format.js 的 refKind）。 */
      let shallowBoundary = false
      for (let k = 0; k < refs.length; k += 1) {
        const kind = refKind(refs[k])
        if (kind === 'shallow') {
          shallowBoundary = true
          chips.push(h('span', {
            className: 'dsh-git-ref dsh-git-ref-shallow', key: 'r' + k,
            title: shallowRefTip(),
          }, SHALLOW_BADGE))
          continue
        }
        chips.push(h('span', { className: 'dsh-git-ref dsh-git-ref-' + kind, key: 'r' + k }, refs[k]))
      }
      const rowProps = {
        className: 'dsh-git-crow'
          + (props.selected === true ? ' dsh-git-crow-sel' : '')
          + (props.multi === true ? ' dsh-git-crow-multi' : '')
          + (tall === true ? ' dsh-git-crow-tall' : ''),
        /* 边界提交的行悬浮提示多说一句「为什么下面就没有了」：灰标签上的 title 要
           悬停到那个小圆标上才看得到，整行才是大家真正会停的地方。第二行起是
           完整提交信息 —— 多行档显示的正是它的前几行，单行档悬浮里也看得全。 */
        title: commit.hash + '\n' + lines.join('\n') + (when.length > 0 ? '\n' + when : '')
          + (shallowBoundary === true ? '\n' + shallowRefTip() : ''),
        /* 事件一起回给面板：Ctrl/Cmd+点击是「挑进/移出多选」，普通点击照旧单选 ——
           区分只在这一层做，行自己不解读修饰键。 */
        onClick: function (event) { props.onPick(commit.hash, event) },
        /* 右键：拦掉浏览器自己的菜单，把这条提交交给面板 —— 面板先按左键单选的同
           一条路选中它，再在光标处打开上下文菜单（拣选/还原/打标签/新建分支）。 */
        onContextMenu: function (event) {
          event.preventDefault()
          event.stopPropagation()
          props.onContext(commit.hash, event)
        },
      }
      /* 多行档才定高（行内 style，46-css.js 的 .dsh-git-crow-tall）：默认 1 行连
         这个键都不加，props 与从前逐键相同，memo 的行为一字不差。 */
      if (tall === true) rowProps.style = { height: height + 'px' }
      const firstLine = [
        h('span', { className: 'dsh-git-subject' }, commit.subject),
        chips.length > 0 ? h('span', { className: 'dsh-git-refs' }, chips) : null,
        h('span', { className: 'dsh-git-author' }, commit.author),
        h('span', { className: 'dsh-git-date' }, relativeDate(commit.date)),
      ]
      if (tall !== true) return h('div', rowProps, firstLine[0], firstLine[1], firstLine[2], firstLine[3])
      const bodyRows = []
      for (let b = 1; b < shown.length; b += 1) {
        bodyRows.push(h('span', { key: 'b' + String(b), className: 'dsh-git-crow-bodyline' }, shown[b]))
      }
      return h('div', rowProps,
        h('div', { className: 'dsh-git-crow-main' }, firstLine[0], firstLine[1], firstLine[2], firstLine[3]),
        bodyRows)
    }
    const CommitRowMemo = memo(CommitRow)

    /* 一条提交的完整信息行（subject 打头，body 逐行跟上）：行数喂给「行：全部」档
       的行高与前缀和（CommitList），内容喂给多行档的显示与整行的 title。body 由
       Host 随图带回（64-history.js 的 format 末位 %b，50-graph.js 解析）；中段的
       空行是排版的一部分照留，尾部的空行不算行数，至少一行。 */
    function commitMsgLines(commit) {
      const lines = [typeof commit.subject === 'string' ? commit.subject : '']
      const body = commit.body
      if (typeof body === 'string' && body.length > 0) {
        const parts = body.split('\n')
        for (let i = 0; i < parts.length; i += 1) lines.push(parts[i])
      }
      while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop()
      return lines
    }

    function CommitList(props) {
      const graph = props.graph
      const commits = graph != null && graph.ok === true && Array.isArray(graph.commits) ? graph.commits : null
      const count = commits === null ? 0 : commits.length
      /* ── 「行：」选择器的行几何（三档）──
         1 = 现在的等高算术，rowH 就是 ROW_H，下面每一处公式都与从前逐像素相同；
         固定 N（2..10）= 整列统一行高 ROW_H + (N-1)×MSG_LINE_H，窗口、垫块、svg
         高度、圆点全部换用这一个数；「全部」= 每行按 commitMsgLines 的行数各自
         定高，heights 交给 useVirtualWindow 做前缀和（12-window.js），rowTops
         递给 GraphCanvas 定圆点的 y。高度全部从数据算，没有 DOM 测量。 */
      const msgLines = props.msgLines === undefined || props.msgLines === null || props.msgLines === 1 ? 1 : props.msgLines
      const heights = useMemo(function () {
        if (msgLines !== 'all' || commits === null) return null
        const out = []
        for (let i = 0; i < commits.length; i += 1) out.push(ROW_H + (commitMsgLines(commits[i]).length - 1) * MSG_LINE_H)
        return out
      }, [commits, msgLines])
      const rowTops = useMemo(function () {
        if (heights === null) return null
        const tops = [0]
        for (let i = 0; i < heights.length; i += 1) tops.push(tops[i] + heights[i])
        return tops
      }, [heights])
      const rowH = typeof msgLines === 'number' && msgLines > 1 ? ROW_H + (msgLines - 1) * MSG_LINE_H : ROW_H
      /* The window has to be asked for before the two early returns below, or a
         list that is empty on one render and full on the next would change how
         many hooks this component calls. */
      const win = useVirtualWindow('log', count, rowH, heights)

      /* graph 为 null 是请求还在途，不是读取失败：先给中性 dim 提示等数据回来，
         红字 error 只留给下面三种确有返回体的失败，免得正常加载被当成报错。 */
      if (graph == null) {
        return h('div', { className: 'dsh-git-pane dsh-git-dim' }, '正在读取提交历史…')
      }
      if (commits === null) {
        const reason = graph != null && graph.noGit === true
          ? ('找不到 git：' + text(graph.repo))
          : graph != null && graph.error === 'not-a-repository'
            ? ('不是 git 仓库：' + text(graph.repo))
            : '无法读取提交历史'
        return h('div', { className: 'dsh-git-pane dsh-git-error' }, reason)
      }
      if (count === 0) {
        /* 空历史有两种：这个仓库还没有第一个提交（刚 init），和筛选没匹配到。
           前者不是「没有匹配」，说成那样会让人去清筛选。 */
        return h('div', { className: 'dsh-git-pane dsh-git-dim' },
          graph != null && graph.unborn === true ? '这个仓库还没有提交' : '没有匹配的提交')
      }

      const laneNum = Math.max(1, graph.lanes)
      const graphWidth = laneNum * LANE_W + 6
      /* 多选查表（O(1)/行）：面板给的是数组，行只要布尔 —— memo 的前提就是行的 props
         不为别的行动。 */
      const multiSet = {}
      if (Array.isArray(props.multi)) {
        for (let m = 0; m < props.multi.length; m += 1) multiSet[props.multi[m]] = true
      }
      const listRows = []
      for (let i = win.first; i < win.last; i += 1) {
        listRows.push(h(CommitRowMemo, {
          key: commits[i].hash,
          commit: commits[i],
          selected: props.selected === commits[i].hash,
          multi: multiSet[commits[i].hash] === true,
          msgLines: msgLines,
          onPick: props.onPick,
          onContext: props.onContext,
        }))
      }

      /* Two spacers carry the rows that are not built, so the scrollbar keeps
         describing the whole history and every built row lands on the pixel it
         would have had. 「全部」档的垫块从 rowTops 前缀和拿（每行高度不同），
         其余两档是同一句乘法 —— 默认档的乘数就是 ROW_H，与从前逐像素相同。 */
      const padTop = rowTops !== null ? rowTops[win.first] : win.first * rowH
      const padBottom = rowTops !== null
        ? rowTops[rowTops.length - 1] - rowTops[win.last]
        : (count - win.last) * rowH
      /* The read stops at a page. When git had one commit more than the page
         asked for, there is more history and the list offers it — the count is
         the honest one, because a repository with ten thousand commits must not
         have to say so in order to be readable. */
      const more = graph.hasMore === true && typeof props.onLoadMore === 'function'
        ? h('div', { key: 'more', className: 'dsh-git-more' },
            h('span', { key: 'n', className: 'dsh-git-dim' }, '已显示 ' + String(count) + ' 条'),
            h('button', {
              key: 'b', type: 'button', className: 'dsh-git-btn', onClick: function () { props.onLoadMore() },
            }, '加载更多'))
        : null
      /* GraphCanvas 只在多行档多拿行几何（rowH / rowTops）：默认档的 props 集合与
         从前逐键相同，memo 不因为这次改动多动一根线。 */
      const canvasProps = { rows: graph.rows, commits: commits, lanes: graph.lanes, first: win.first, last: win.last }
      if (rowTops !== null) canvasProps.rowTops = rowTops
      else if (rowH !== ROW_H) canvasProps.rowH = rowH
      return h('div', {
        className: 'dsh-git-log',
        ref: win.attach,
        onScroll: win.measure,
      },
        h('div', { className: 'dsh-git-logwrap', style: { minHeight: (rowTops !== null ? rowTops[rowTops.length - 1] : count * rowH) + 'px' } },
          h(GraphCanvasMemo, canvasProps),
          h('div', { style: { marginLeft: graphWidth + 'px' } },
            padTop > 0 ? h('div', { key: 'pad-top', style: { height: padTop + 'px' } }) : null,
            listRows,
            padBottom > 0 ? h('div', { key: 'pad-bottom', style: { height: padBottom + 'px' } }) : null)),
        more)
    }

    const NO_COLLAPSE = {}

    function RefTree(props) {
      /* The search box above the tree, where IDEA keeps it. A repository with
         more branches than the pane has rows is the normal case, and without it
         the only way to a branch is the scrollbar. */
      const [query, setQuery] = React.useState('')
      const refs = props.refs
      /* 多仓库（24-repos.js）：选中了不止一个仓库时，左栏按仓库分组各画一棵分支树。
         单仓库现状走同一条代码、前缀为空 —— 键名和手势一个字都不改。 */
      const groups = Array.isArray(props.groups) && props.groups.length > 0 ? props.groups : null
      if (groups == null && (refs == null || refs.ok !== true)) return h('div', { className: 'dsh-git-side dsh-git-dim' }, '无法读取分支')

      const needle = query.trim().toLowerCase()
      /* A branch matches on the name its row shows. While a filter is on, the
         tree is forced open: a match hidden inside a folded group is not a
         match, and nobody wants to unfold four groups to find it. */
      const collapsed = needle.length === 0 ? props.collapsed : NO_COLLAPSE
      const matching = function (entries) {
        if (needle.length === 0) return entries
        const out = []
        for (let i = 0; i < entries.length; i += 1) {
          const name = text(entries[i].data)
          if (name.toLowerCase().indexOf(needle) >= 0) out.push(entries[i])
        }
        return out
      }
      const rows = []

      /* ── 分组标题也是一行 ──
         HEAD、本地、远程 · x 都曾经是「单击就折叠」：那是这一棵树里唯一不服从树行
         手势的地方，而它的症状和别处一样 —— 想只选中这一行的人点下去，树动了，选中
         没动，看起来像点错了东西。现在它和目录行共用同一条规矩：单击只选中，双击整行
         或点左边的三角才折叠，三角也用上了目录行那一个（会拦住冒泡，所以点三角不会
         顺手把选中挪过来）。 */
      const groupTitle = function (label, key, count) {
        return h('div', {
          className: 'dsh-git-trow' + (props.selectedKey === key + ':title' ? ' dsh-git-trow-sel' : ''),
          key: key + ':title',
          style: { paddingLeft: '6px' },
          title: label + '（双击展开/折叠）',
          onClick: function () { props.onSelect(key + ':title') },
          onDoubleClick: function () { props.onToggle(key) },
        },
          twisty({ collapsed: collapsed[key] === true, onToggle: function () { props.onToggle(key) } }),
          h('span', { className: 'dsh-git-tname dsh-git-dim' }, label),
          count === undefined ? null : h('span', { className: 'dsh-git-tdim' }, count))
      }

      /* One repository's branch rows. `prefix` empties to today's single-repo
         tree: every key, collapse entry and selected-key stays exactly what it
         was, because the changes tree and these rows share one collapsed map
         and one selection. A non-empty prefix (the repository's path) keeps N
         repositories' entries from colliding inside those same maps. */
      const rowsForRefs = function (one, prefix, opts) {
        const keyOf = function (key) { return prefix.length === 0 ? key : prefix + key }
        /* Branch names are only unique inside one repository: in a grouped tree
           the selection key carries the prefix, in a single tree it stays the
           bare name the rest of the panel has always used. */
        const selOf = function (name) { return prefix.length === 0 ? name : prefix + name }
        /* What the Host knows about each local branch, by name: the HEAD rows show
           the current branch, and it is the one whose standing matters most. */
        const metaOf = {}
        for (let i = 0; i < one.local.length; i += 1) metaOf[text(one.local[i].data)] = one.local[i]
        const badgeOf = function (name) {
          const meta = metaOf[name]
          if (meta === undefined) return []
          const ahead = typeof meta.ahead === 'number' ? meta.ahead : 0
          const behind = typeof meta.behind === 'number' ? meta.behind : 0
          const out = []
          /* IDEA's two marks, and its two colours: a blue down arrow for the
             commits waiting on the remote, a green up arrow for the ones waiting
             to be pushed. The number stays because "three behind" is the question
             people actually have; IDEA answers it in the mouseover only. */
          if (behind > 0) out.push(h('span', { key: 'b', className: 'dsh-git-ab dsh-git-ab-in', title: '落后上游 ' + String(behind) + ' 个提交 —— 需要拉取' }, '↓' + (behind > 99 ? '99+' : String(behind))))
          if (ahead > 0) out.push(h('span', { key: 'a', className: 'dsh-git-ab dsh-git-ab-out', title: '领先上游 ' + String(ahead) + ' 个提交 —— 需要推送' }, '↑' + (ahead > 99 ? '99+' : String(ahead))))
          return out
        }

        /* 按仓库分组时不再单列「HEAD（当前分支）」那个标题：组头已经说了这是哪个
           仓库，当前分支那一行自己带 ★。单仓库的树保持原样。 */
        if (opts.compact !== true) rows.push(groupTitle('HEAD（当前分支）', keyOf('@head')))
        const headNames = matching(one.current.map(function (name) { return { data: name } })).map(function (entry) { return entry.data })
        if (collapsed[keyOf('@head')] !== true) {
          if (headNames.length === 0) {
            rows.push(h('div', { className: 'dsh-git-trow dsh-git-dim', key: keyOf('head-none'), style: { paddingLeft: '18px' } },
              one.current.length === 0 ? '(游离 HEAD)' : '没有匹配的分支'))
          } else {
            for (let i = 0; i < headNames.length; i += 1) {
              const name = headNames[i]
              const headMeta = metaOf[name]
              /* 小字那一行说的就是 tooltip 里那句的上游半句：有上游写上游名，没有
                 写更淡的「未跟踪」（远程组的行不加这一行，见下面 section）。 */
              const headUp = headMeta === undefined ? '' : text(headMeta.upstream)
              const headTip = [name + (opts.compact === true ? '' : '（双击只看这个分支的历史）')]
              if (headMeta !== undefined) {
                const ha = typeof headMeta.ahead === 'number' ? headMeta.ahead : 0
                const hb = typeof headMeta.behind === 'number' ? headMeta.behind : 0
                headTip.push(text(headMeta.upstream).length > 0
                  ? trackTitle(ha, hb) + ' · ' + text(headMeta.upstream)
                  : '没有上游分支')
              }
              if (opts.dirty > 0) headTip.push('工作区有 ' + String(opts.dirty) + ' 个未提交改动')
              rows.push(h('div', {
                className: 'dsh-git-trow dsh-git-trow-head'
                  + (props.selectedKey === selOf(name) ? ' dsh-git-trow-sel' : '')
                  + (prefix.length === 0 && props.activeRef === name ? ' dsh-git-trow-scope' : ''),
                key: keyOf('cur:' + name),
                style: { paddingLeft: '18px' },
                /* Single click only moves the selection: the graph follows on a
                   double click, so browsing the tree never re-reads the history
                   out from under the commit you were reading. 多选视图里双击是
                   「切到这个仓库并只看这个分支」两步一起做 —— 只选中不联动，看起来
                   就像双击坏了。 */
                title: headTip.join('\n'),
                onClick: function () { props.onSelect(selOf(name)) },
                onDoubleClick: function () { props.onSelect(selOf(name)); props.onPickBranch(opts.repo, name) },
                /* 右键：分支行的上下文菜单（复制分支名称 / 删除分支）。HEAD 组的行
                   也是分支行 —— 它就是当前分支，菜单里的删除项由面板按名字置灰；
                   末位 true 告诉菜单「这一行是当前分支」：签出项由它置灰（多选分组
                   里 currentName 是生效仓库的，认不得别的仓库的当前分支）。 */
                onContextMenu: function (event) {
                  event.preventDefault()
                  event.stopPropagation()
                  props.onBranchContext(name, 'head', opts.repo, event, true)
                },
              },
                h('span', { className: 'dsh-git-tw' }, '★'),
                /* 名字与其下的小字包在同一个纵列里：小字跟着名字同宽、一起省略，
                   行里的其余记号（●改动数、↑↓）仍待在名字右侧自己的位置。 */
                h('span', { className: 'dsh-git-tmain' },
                  h('span', { className: 'dsh-git-tname' }, name),
                  h('span', { className: 'dsh-git-tsub' + (headUp.length > 0 ? '' : ' dsh-git-tsub-none') },
                    headUp.length > 0 ? headUp : '未跟踪')),
                opts.dirty > 0
                  ? h('span', { key: 'd', className: 'dsh-git-tdirty', title: String(opts.dirty) + ' 个未提交改动' }, '●' + String(opts.dirty))
                  : null,
                badgeOf(name)))
            }
          }
        }

        const section = function (title, key, entries) {
          const shown = matching(entries)
          rows.push(groupTitle(title, keyOf(key), needle.length === 0 ? String(entries.length) : String(shown.length)))
          if (collapsed[keyOf(key)] === true) return
          /* 右键菜单的菜单项跟着这一组走：远程的分支只给「复制分支名称」（远端分支
             的删除不在这一棵树的手势里），本地的才有删除。 */
          const branchKind = key.indexOf('@remote:') === 0 ? 'remote' : 'local'
          /* 配置了但从未 fetch 过的远端（66-refs.js 并进来的 refs 为空的分组）也要
             有个说得通的组内：画一行灰色说明，而不是一个空组头吊着。折叠照旧收掉
             它（上面 collapsed 已经 return），搜索时也不会误伤 —— 组真的没有引用，
             什么都不会匹配，这句话照实说。 */
          if (branchKind === 'remote' && entries.length === 0) {
            rows.push(h('div', {
              className: 'dsh-git-trow dsh-git-dim',
              key: keyOf(key) + ':none',
              style: { paddingLeft: '18px' },
            }, '未抓取，暂无远程分支'))
            return
          }
          const tree = buildTree(shown)
          /* 末位 false：分支树不再压扁 —— `feature/a`、`feature/b` 归到可折叠的
             目录行 `feature`（treeDirRow 自带展开/收起与条数），叶子行只显示末段
             名，tooltip 与上游小字仍按完整分支名（node.data）说。PhpStorm 的分支
             树就是这么分组的；搜索时 collapsed 被上面的 NO_COLLAPSE 整棵强制展开，
             目录不会藏住任何匹配结果。 */
          const flat = flattenTree(tree, 2, keyOf(key), collapsed, [], keyOf(key), false)
          for (let i = 0; i < flat.length; i += 1) {
            const node = flat[i]
            if (node.kind === 'dir') {
              rows.push(treeDirRow(node, props, String(node.count)))
            } else {
              const branchName = text(node.data)
              /* Looked up by name rather than carried on the leaf: the tree is
                 folded and rebuilt on the way to the screen, and only the name
                 survives that. */
              const meta = metaOf[branchName] === undefined ? null : metaOf[branchName]
              const ahead = meta != null && typeof meta.ahead === 'number' ? meta.ahead : 0
              const behind = meta != null && typeof meta.behind === 'number' ? meta.behind : 0
              const upstream = meta == null ? '' : text(meta.upstream)
              const when = meta == null ? '' : branchRelative(meta.at)
              /* What the branch is worth knowing at a glance: where it stands
                 against its upstream, and — for the branch that is checked out —
                 how much is sitting uncommitted in the working tree. Both are
                 spelled out in the tooltip, because ↑2 and a bare number are only
                 legible once you have been told what they mean. */
              const tip = [branchName + '（双击只看这个分支的历史）']
              if (upstream.length > 0) tip.push(trackTitle(ahead, behind) + ' · ' + upstream)
              else tip.push('没有上游分支')
              if (when.length > 0) tip.push('最后提交 ' + when)
              const onHead = opts.headName === branchName
              if (onHead && opts.dirty > 0) tip.push('工作区有 ' + String(opts.dirty) + ' 个未提交改动')
              rows.push(h('div', {
                className: 'dsh-git-trow'
                  + (onHead ? ' dsh-git-trow-head' : '')
                  + (props.selectedKey === selOf(branchName) ? ' dsh-git-trow-sel' : '')
                  + (prefix.length === 0 && props.activeRef === branchName ? ' dsh-git-trow-scope' : ''),
                key: node.id,
                style: { paddingLeft: (6 + node.depth * 12) + 'px' },
                title: tip.join('\n'),
                onClick: function () { props.onSelect(selOf(branchName)) },
                onDoubleClick: function () { props.onSelect(selOf(branchName)); props.onPickBranch(opts.repo, branchName) },
                /* 右键：与 HEAD 组的行同一个约定（50-log.js 顶部那一处），菜单项按
                   这一组是本地还是远程收放；末位的 onHead 让「签出」在对的行上置灰。 */
                onContextMenu: function (event) {
                  event.preventDefault()
                  event.stopPropagation()
                  props.onBranchContext(branchName, branchKind, opts.repo, event, onHead)
                },
              },
                h('span', { className: 'dsh-git-tw' }),
                /* 与 HEAD 组的行同一个约定：名字下面一行小字写它跟踪的上游，没有
                   上游写更淡的「未跟踪」。远程组的行例外（branchKind === 'remote'）：
                   metaOf 只收本地分支，远程行的 upstream 恒为空，小字只可能是
                   「未跟踪」，所以干脆不渲染这一行，行保持单行只有分支名。 */
                h('span', { className: 'dsh-git-tmain' },
                  h('span', { className: 'dsh-git-tname' }, node.name),
                  branchKind === 'remote' ? null
                    : h('span', { className: 'dsh-git-tsub' + (upstream.length > 0 ? '' : ' dsh-git-tsub-none') },
                      upstream.length > 0 ? upstream : '未跟踪')),
                onHead && opts.dirty > 0
                  ? h('span', { key: 'd', className: 'dsh-git-tdirty', title: String(opts.dirty) + ' 个未提交改动' }, '●' + String(opts.dirty))
                  : null,
                badgeOf(branchName)))
            }
          }
        }

        section('本地', '@local', one.local)
        for (let i = 0; i < one.remote.length; i += 1) {
          section('远程 · ' + one.remote[i].name, '@remote:' + one.remote[i].name, one.remote[i].refs)
        }
      }

      if (groups != null) {
        /* 同名仓库的短名（24-repos.js）：分组头和切换器行取同一份 memo —— 标题行
           叫 c/d，切换器那一行也得叫 c/d，读者才认得出是同一个仓库。 */
        const repoLabels = props.repoProps == null ? null
          : repoLabelMap(reposShown(props.repoProps.list, props.repoProps.effective))
        for (let g = 0; g < groups.length; g += 1) {
          const group = groups[g]
          const one = group.refs
          const label = repoLabels == null ? repoBaseName(group.repo) : repoShortName(repoLabels, group.repo)
          const branchCount = one != null && one.ok === true ? one.local.length : 0
          /* 组头也是「单击只看这个仓库」的入口：多选视图是找东西用的，找到之后
             大多数时候要的就是钻进那一个仓库。 */
          rows.push(h('div', {
            key: 'rg:' + group.repo,
            className: 'dsh-git-rgroup',
            title: group.repo + '（单击 = 只看这个仓库）',
            onClick: function () { props.onRepoSingle(group.repo) },
          },
            h('span', { key: 'g', className: 'dsh-git-repo-glyph' }, h(Icon, { name: 'repo', size: 11 })),
            h('span', { key: 'n', className: 'dsh-git-repo-name' }, label),
            h('span', { key: 'c', className: 'dsh-git-repo-dim' }, String(branchCount))))
          if (one == null || one.ok !== true) {
            rows.push(h('div', {
              key: 'rgx:' + group.repo, className: 'dsh-git-trow dsh-git-dim', style: { paddingLeft: '18px' },
            }, one == null ? '正在读取分支…' : '无法读取分支'))
            continue
          }
          rowsForRefs(one, group.repo + '\u001f', { repo: group.repo, compact: true,
            headName: one.current.length > 0 ? one.current[0] : '', dirty: 0 })
        }
      } else {
        rowsForRefs(refs, '', { repo: '', headName: props.headName, dirty: props.dirty })
      }

      /* 仓库块与工作树块都画在分支树行之前，从粗到细一列读完：仓库（看哪个仓库）
         → 工作树（那个仓库里还开着哪几个工作区）→ 分支（看哪条历史）。两块都可能
         缺席（说明页那份仓库列表、宿主太旧没有 git/worktrees），各自判空再挂。 */
      const sideHead = []
      if (props.repoProps != null) sideHead.push(h(RepoSwitcher, props.repoProps))
      if (props.worktreeProps != null) sideHead.push(h(WorktreeBox, props.worktreeProps))
      return h('div', { className: 'dsh-git-sidewrap' },
        h('div', { className: 'dsh-git-sidehead' },
          h('span', { key: 'i', className: 'dsh-git-sidehead-ico' }, h(Icon, { name: 'search', size: 12 })),
          h('input', {
            key: 'q', className: 'dsh-git-sidehead-input', placeholder: '搜索分支', value: query,
            onChange: function (event) { setQuery(event.target.value) },
          }),
          query.length > 0 ? h('button', {
            key: 'x', type: 'button', className: 'dsh-git-sidehead-x', title: '清空搜索',
            onClick: function () { setQuery('') },
          }, '×') : null),
        /* 仓库列表区（RepoSwitcher）在「HEAD（当前分支）」上方：每个仓库一行、「全部」
           在最先，单击切生效仓库，Ctrl+单击挑进多选。放在这棵树里而不是侧栏外另开一
           列，是因为它和分支树同属「看哪一层」这个问题 —— 仓库在上面，分支在下面。 */
        h('div', { className: 'dsh-git-side' },
          sideHead.length > 0 ? sideHead.concat(rows) : rows))
    }

