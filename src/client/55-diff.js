    /* ── one file's change, on screen ──

       The two lists that say a file changed — the changes tree, and the file list
       under a commit — used to end there: the row could be selected and nothing
       followed. This is what follows: the patch, asked for by path, opened in
       place of the list with a way back.

       The patch arrives as git printed it and is read line by line here rather
       than being handed to a diff library: the four things a reader needs — which
       side a line belongs to, the two line numbers, the hunk headings, and the
       `@@` counters that make the gutters right — are all in the text already. */

    const DIFF_ROW_H = 18

    /* A row of the changes tree, as the diff view needs to see it. Written here
       rather than in the panel because it is the diff's own vocabulary: which
       reads this row implies, and which of them has anything to say. One of the
       two sections is skipped outright when the row already knows it is empty,
       which is the difference between one child process and two. */
    function changeDiffTarget(file, repo) {
      return {
        kind: 'file',
        path: text(file.path),
        from: '',
        staged: file.staged === true,
        workCode: text(file.workCode),
        untracked: file.untracked === true,
        status: text(file.displayCode),
        /* 多仓库的变更分组里，这个文件属于它自己那个仓库；单仓库的调用方不传，
           空 = 生效仓库。 */
        repo: text(repo),
      }
    }

    /* What the Host is asked for, from what the row that opened this knows.

       A file in the changes tree can be in two states at once — staged, and
       changed again after that — and IDEA answers that with two sections rather
       than one merged patch, so both reads are asked for and each is shown under
       its own heading. A commit's file is one read; an untracked file has no
       HEAD side at all. */
    function diffRequests(target) {
      if (target.kind === 'commit') return [{ key: 'commit', label: '', mode: 'commit', ref: target.ref }]
      if (target.untracked === true) return [{ key: 'untracked', label: '新文件', mode: 'untracked' }]
      const out = []
      if (target.staged === true) out.push({ key: 'staged', label: '已暂存', mode: 'staged' })
      if (text(target.workCode).length > 0) out.push({ key: 'worktree', label: '未暂存', mode: 'worktree' })
      if (out.length === 0) out.push({ key: 'worktree', label: '', mode: 'worktree' })
      return out
    }

    /* The identity of one request set, as a string: the effect below has to
       re-read when the file, the mode or the rename's other path changes, and an
       array rebuilt on every render would look like a change every time. The path
       is in it and not only in the mode list: two files of one commit are the
       same request shape, and a view that kept the first file's patch under the
       second file's name would be the worst kind of wrong — plausible. */
    function diffShape(requests, target) {
      const parts = [text(target.path), text(target.from), text(target.ref)]
      for (let i = 0; i < requests.length; i += 1) {
        parts.push(requests[i].key + ':' + requests[i].mode + ':' + text(requests[i].ref))
      }
      return parts.join('|')
    }

    /* `@@ -12,7 +12,9 @@ optional heading` — where the two gutters start counting. */
    function hunkHeader(line) {
      const found = /^@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @+/.exec(line)
      if (found === null) return null
      return { old: parseInt(found[1], 10), next: parseInt(found[2], 10) }
    }

    /* A patch as rows. Everything git prints is one of: a `diff --git`/`index`/
       `---`/`+++` header, a `@@` hunk heading, a context line, an added line, a
       removed line, or a "\ No newline at end of file" note. */
    function diffRows(patch) {
      const lines = text(patch).split('\n')
      const out = []
      let oldNo = 0
      let nextNo = 0
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        if (i === lines.length - 1 && line.length === 0) break
        const head = line.charAt(0)
        if (head === '@') {
          const at = hunkHeader(line)
          if (at !== null) { oldNo = at.old; nextNo = at.next }
          out.push({ kind: 'hunk', text: line })
          continue
        }
        if (head === '+' && line.indexOf('+++') !== 0) {
          out.push({ kind: 'add', sign: '+', old: '', next: String(nextNo), text: line.slice(1) })
          nextNo += 1
          continue
        }
        if (head === '-' && line.indexOf('---') !== 0) {
          out.push({ kind: 'del', sign: '-', old: String(oldNo), next: '', text: line.slice(1) })
          oldNo += 1
          continue
        }
        if (head === ' ') {
          out.push({ kind: 'ctx', sign: ' ', old: String(oldNo), next: String(nextNo), text: line.slice(1) })
          oldNo += 1
          nextNo += 1
          continue
        }
        out.push({ kind: head === '\\' ? 'note' : 'meta', sign: '', old: '', next: '', text: line })
      }
      return out
    }

    /* ── 词级（行内）差异 ──

       配上对的一行往往只差几个词：整行底色里再标出片段，改动一眼就在。token 切分
       保留空白连续段（/(\s+|\w+|.)/g：空白一段一个、单词一段一个、其余逐字符 ——
       对中文正好退化为逐字对比），两边求 LCS，不在公共子序列里的 token 就是各自
       要包起来的片段。

       护栏：任一侧超长（>1000 字符）或 token 超过上限就放弃、整行原样 —— 一个
       几千行的补丁配一个 O(n·m) 的 DP，不能让打开差异变卡；两道线都是给最坏情形
       的，常见的一行代码只有十几个 token。行尾的 \r 也按 token 参与：CRLF↔LF 的
       差别因此能被词级高亮标出来。 */
    const WORD_MAX_CHARS = 1000
    const WORD_MAX_TOKENS = 220
    const CR_GLYPH = '⏎'

    function wordTokens(line) {
      return line.match(/(\s+|\w+|.)/g) || []
    }

    /* 标记走到段落：相邻的同记号 token 合成一段，一段只花一个 <span>。 */
    function wordSegments(tokens, marks) {
      const out = []
      for (let i = 0; i < tokens.length; i += 1) {
        const miss = marks[i] === true
        const last = out.length > 0 ? out[out.length - 1] : null
        if (last !== null && last.m === miss) last.t += tokens[i]
        else out.push({ t: tokens[i], m: miss })
      }
      return out
    }

    /* 两边各返回 [{t, m}]（m = 不在公共子序列里，要上底色）；null = 放弃高亮。 */
    function wordDiff(leftText, rightText) {
      if (leftText === rightText) return null
      if (leftText.length > WORD_MAX_CHARS || rightText.length > WORD_MAX_CHARS) return null
      const a = wordTokens(leftText)
      const b = wordTokens(rightText)
      if (a.length > WORD_MAX_TOKENS || b.length > WORD_MAX_TOKENS) return null
      const n = a.length
      const m = b.length
      /* 表只有 (n+1)×(m+1) 格，一个 Int32Array 装下；从后往前填，dp[i][j] 是
         a[i..] 与 b[j..] 的公共子序列长。 */
      const width = m + 1
      const dp = new Int32Array((n + 1) * width)
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[i * width + j] = a[i] === b[j]
            ? dp[(i + 1) * width + j + 1] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
        }
      }
      const left = new Array(n)
      const right = new Array(m)
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (a[i] === b[j]) { i += 1; j += 1 }
        else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { left[i] = true; i += 1 }
        else { right[j] = true; j += 1 }
      }
      while (i < n) { left[i] = true; i += 1 }
      while (j < m) { right[j] = true; j += 1 }
      return { left: wordSegments(a, left), right: wordSegments(b, right) }
    }

    /* ── 配对：diffRows 的统一行数组 → 左右对比的行数组 ──

       连续的 del 块与紧随的 add 块按下标配对（第 i 个 del 配第 i 个 add），多出的
       del 左半有内容右半留空，多出的 add 相反；ctx 行左右 1:1；hunk / meta / note
       横跨两列整行显示。夹在块中间的「\ No newline at end of file」不拆散配对
       （它正是 EOF 的差异：先成对，再整行补在块尾）。词级差异在这里一次算好，
       PatchBody 的渲染循环里不再碰它 —— 虚拟窗口滑到哪就画哪，算却只算一遍。 */
    function pairRows(raw, showCr) {
      const out = []
      let i = 0
      while (i < raw.length) {
        const row = raw[i]
        if (row.kind === 'del' || row.kind === 'add') {
          const dels = []
          const adds = []
          const notes = []
          while (i < raw.length && (raw[i].kind === 'del' || raw[i].kind === 'add' || raw[i].kind === 'note')) {
            if (raw[i].kind === 'del') dels.push(raw[i])
            else if (raw[i].kind === 'add') adds.push(raw[i])
            else notes.push(raw[i])
            i += 1
          }
          const paired = Math.min(dels.length, adds.length)
          for (let k = 0; k < paired; k += 1) out.push(pairRow(dels[k], adds[k], showCr))
          for (let k = paired; k < dels.length; k += 1) out.push(halfRow('del', dels[k], showCr))
          for (let k = paired; k < adds.length; k += 1) out.push(halfRow('add', adds[k], showCr))
          for (let k = 0; k < notes.length; k += 1) out.push({ kind: 'note', full: true, text: notes[k].text })
          continue
        }
        if (row.kind === 'ctx') {
          const shown = crText(row.text, showCr)
          out.push({
            kind: 'ctx',
            left: { no: row.old, sign: ' ', text: shown, miss: null },
            right: { no: row.next, sign: ' ', text: shown, miss: null },
          })
        } else {
          out.push({ kind: row.kind, full: true, text: row.text })
        }
        i += 1
      }
      return out
    }

    /* 行尾的 \r：勾上就留着（渲染时画成 ⏎，且参与词级对比）；没勾就剥掉。
       white-space:pre 下裸 \r 会被浏览器当换行、撑破 18px 的行高，所以无论勾不勾
       它都不能以文本的形式进 DOM —— 不勾时剥掉，勾上时由 crChildren 画成字形。 */
    function crText(line, showCr) {
      return showCr === true ? line : line.replace(/\r$/, '')
    }

    function pairRow(del, add, showCr) {
      const leftText = crText(del.text, showCr)
      const rightText = crText(add.text, showCr)
      const words = wordDiff(leftText, rightText)
      return {
        kind: 'pair',
        left: { no: del.old, sign: '-', text: leftText, miss: words === null ? null : words.left },
        right: { no: add.next, sign: '+', text: rightText, miss: words === null ? null : words.right },
      }
    }

    /* 多出的那半：有内容的一侧整行底色，另一侧留空（没有行号、没有记号）。 */
    function halfRow(kind, row, showCr) {
      const cell = { no: kind === 'del' ? row.old : row.next, sign: row.sign, text: crText(row.text, showCr), miss: null }
      const empty = { no: '', sign: '', text: '', miss: null }
      return kind === 'del'
        ? { kind: 'del', left: cell, right: empty }
        : { kind: 'add', left: empty, right: cell }
    }

    /* 一格的底色归属跟着记号走：+ 绿、- 红、空格上下文、空串是留空的半列。 */
    function halfMark(cell) {
      if (cell.sign === '+') return ' dsh-git-dhalf-add'
      if (cell.sign === '-') return ' dsh-git-dhalf-del'
      if (cell.sign === ' ') return ' dsh-git-dhalf-ctx'
      return ' dsh-git-dhalf-empty'
    }

    /* 一格的文字：\r 一律画成暗色 ⏎（裸 \r 不能进 DOM 文本）；带词级记号的段落
       包一层浅底 span —— 底色由左右半列的类各给各的，字形与文字共用一套类名。 */
    function crChildren(cell) {
      const out = []
      const segments = cell.miss !== null ? cell.miss : [{ t: cell.text, m: false }]
      for (let s = 0; s < segments.length; s += 1) {
        const seg = segments[s]
        const parts = seg.t.split('\r')
        for (let p = 0; p < parts.length; p += 1) {
          if (p > 0) {
            out.push(h('span', { key: 'cr' + s + '-' + p, className: 'dsh-git-dcr' + (seg.m === true ? ' dsh-git-dmiss' : '') }, CR_GLYPH))
          }
          if (parts[p].length > 0) {
            out.push(seg.m === true
              ? h('span', { key: 'w' + s + '-' + p, className: 'dsh-git-dmiss' }, parts[p])
              : parts[p])
          }
        }
      }
      return out
    }

    /* One section's body. A patch can be thousands of lines and the pane shows
       twenty-odd of them, so it is windowed exactly like the history list: same
       arithmetic, same spacers, and "everything" while no height can be
       measured. The rows it paints are the paired ones: the pairing and the
       word-level marks are computed once per (patch, 回车符开关) in the memo —
       toggling the checkbox repaints what is already in hand and never re-asks
       git. */
    function PatchBody(props) {
      const showCr = props.showCr === true
      const rows = useMemo(function () { return pairRows(diffRows(props.patch), showCr) }, [props.patch, showCr])
      const win = useVirtualWindow('diff:' + props.id, rows.length, DIFF_ROW_H)
      const shown = []
      for (let i = win.first; i < win.last; i += 1) {
        const row = rows[i]
        if (row.full === true) {
          /* hunk / meta / note：一格横跨两列整行。 */
          shown.push(h('div', { key: 'r' + i, className: 'dsh-git-dline dsh-git-dl-' + row.kind },
            h('div', { key: 'f', colSpan: 2, className: 'dsh-git-dfull' }, row.text)))
          continue
        }
        shown.push(h('div', { key: 'r' + i, className: 'dsh-git-dline dsh-git-dl-' + row.kind },
          h('div', { key: 'o', className: 'dsh-git-dhalf dsh-git-dhalf-old' + halfMark(row.left) },
            h('span', { key: 'no', className: 'dsh-git-dno' }, row.left.no),
            h('span', { key: 'sg', className: 'dsh-git-dsign' }, row.left.sign),
            h('span', { key: 'tx', className: 'dsh-git-dtext' }, crChildren(row.left))),
          h('div', { key: 'n', className: 'dsh-git-dhalf dsh-git-dhalf-new' + halfMark(row.right) },
            h('span', { key: 'no', className: 'dsh-git-dno' }, row.right.no),
            h('span', { key: 'sg', className: 'dsh-git-dsign' }, row.right.sign),
            h('span', { key: 'tx', className: 'dsh-git-dtext' }, crChildren(row.right)))))
      }
      const padTop = win.first * DIFF_ROW_H
      const padBottom = (rows.length - win.last) * DIFF_ROW_H
      return h('div', { className: 'dsh-git-diff', ref: win.attach, onScroll: win.measure },
        h('div', { className: 'dsh-git-diffwrap', style: { minHeight: (rows.length * DIFF_ROW_H) + 'px' } },
          padTop > 0 ? h('div', { key: 'pad-top', style: { height: padTop + 'px' } }) : null,
          /* 行放进一张表：列宽由整张表按内容分，左右两列的边界才逐行对齐 —— 每行
             各排各的（flex / 各自的 50%）做不到，谁的内容长边界就歪到谁那边。 */
          h('div', { key: 'table', className: 'dsh-git-dtable' }, shown),
          padBottom > 0 ? h('div', { key: 'pad-bottom', style: { height: padBottom + 'px' } }) : null))
    }

    /* The two icon buttons this view needs, in the panel's own vocabulary: the
       same classes as the toolbar's icon tools (so they are the same hit area and
       the same hover), the mirror of the chevron the branch rows use for "go
       there", and the glyph the panel's own refresh already draws. */
    function diffIconButton(key, glyph, title, onClick, options) {
      const opts = options == null ? {} : options
      const classes = ['dsh-git-tool', 'dsh-git-tool-ico']
      /* 显隐开关要看得见自己现在的状态：和面板头部工具条同一个「按亮」的读法。 */
      if (opts.on === true) classes.push('dsh-git-tool-on')
      return h('button', {
        key: key, type: 'button', className: classes.join(' '),
        disabled: opts.disabled === true, title: title, onClick: onClick,
      }, glyph)
    }

    function DiffSection(props) {
      const row = props.row
      const reply = row.reply
      let body
      if (row.failure !== undefined) {
        body = h('div', { className: 'dsh-git-pane dsh-git-error' }, row.failure)
      } else if (reply == null || reply.ok !== true) {
        const said = reply != null ? text(reply.stderr) : ''
        body = h('div', { className: 'dsh-git-pane dsh-git-error' }, said.length > 0 ? said : '无法读取差异')
      } else if (reply.binary === true) {
        body = h('div', { className: 'dsh-git-pane dsh-git-dim' }, '二进制文件，没有可显示的差异')
      } else if (reply.empty === true) {
        body = h('div', { className: 'dsh-git-pane dsh-git-dim' }, '没有差异')
      } else {
        body = h(PatchBody, { id: row.req.key, patch: reply.text, showCr: props.showCr })
      }
      return h('div', { key: 'sec-' + row.req.key, className: 'dsh-git-diffsec-wrap' },
        props.labeled === true && row.req.label.length > 0
          ? h('div', { key: 'h', className: 'dsh-git-diffsec' },
              row.req.label,
              reply != null && reply.ok === true
                ? h('span', { key: 'c', className: 'dsh-git-diffcount' }, diffCounts(reply))
                : null)
          : null,
        body)
    }

    function diffCounts(reply) {
      return [
        h('span', { key: 'a', className: 'dsh-git-diffadd' }, '+' + String(reply.added)),
        ' ',
        h('span', { key: 'd', className: 'dsh-git-diffdel' }, '−' + String(reply.removed)),
      ]
    }

    /* ── the diff's right rail: the list this patch came from ──

       补丁回答的是一个文件，而点开它的那个列表（一次提交的文件、变更页的改动）
       几乎从来不止一个文件 —— 退回去再点下一个是两步，右列把它并成一步。两路
       都走 CommitDetail 同一棵树（同一套 buildTree/flattenTree、同一个
       '@files' 前缀：在详情里折起来的目录，右列里仍然折着）；变更那一路的叶子
       行尾仍带上 暂存/未跟踪 的标记（状态字母复用 statusClass/statusLabel，和
       变更页是同一个读法），git 折叠的未跟踪目录不进树。 */

    function DiffFileRail(props) {
      const rail = props.rail
      const current = text(props.current)
      /* 目录行自己的选中：右列是导航列表，面板那格 selectedKey 管的是被这块屏
         替换掉的两块列表，不该被这里的单击挪走。 */
      const [dirKey, setDirKey] = React.useState(null)
      /* 当前文件那一行的节点：换文件时把它滚进视野。block:'nearest' —— 已经在
         屏上就一个像素都不动，读者不会被突然的滚动带走。 */
      const [rowBox] = React.useState(function () { return { node: null } })
      React.useEffect(function () {
        if (rowBox.node != null && typeof rowBox.node.scrollIntoView === 'function') {
          rowBox.node.scrollIntoView({ block: 'nearest' })
        }
      }, [current])

      /* 目录行复用 treeDirRow（44-treerow.js）那份唯一的构造，两边长得一样；
         折叠沿用面板的 collapsed 表 —— 键名与 CommitDetail 的树相同。 */
      const dirHandle = { selectedKey: dirKey, onSelect: setDirKey, onToggle: props.onToggle }
      let title = ''
      const rows = []
      if (rail.kind === 'commit') {
        const entries = []
        for (let i = 0; i < rail.files.length; i += 1) {
          const path = text(rail.files[i].path)
          if (path.length === 0) continue
          entries.push({ segments: path.split('/'), data: rail.files[i] })
        }
        title = String(rail.files.length) + ' 个文件'
        const tree = buildTree(entries)
        /* 末位 false：文件树不压扁，每个目录段独立一行（见 42-tree.js flattenTree）。 */
        const flat = flattenTree(tree, 0, '@files', props.collapsed, [], '@files', false)
        for (let i = 0; i < flat.length; i += 1) {
          const node = flat[i]
          if (node.kind === 'dir') {
            rows.push(treeDirRow(node, dirHandle, String(node.count) + ' 个文件'))
            continue
          }
          const file = node.data || {}
          const mine = text(file.path) === current
          rows.push(h('div', {
            className: 'dsh-git-trow' + (mine ? ' dsh-git-trow-sel' : ''),
            key: node.id,
            style: { paddingLeft: (6 + node.depth * 12) + 'px' },
            title: text(file.path) + '（点开看差异）',
            ref: mine === true ? function (node) { rowBox.node = node } : undefined,
            onClick: function () { if (typeof props.onOpenFile === 'function') props.onOpenFile(file) },
          },
            h('span', { className: 'dsh-git-tw' }),
            h('span', { className: 'dsh-git-st' + statusClass(file.status) }, statusLabel(file.status)),
            h('span', { className: 'dsh-git-tname' }, node.name)))
        }
      } else {
        /* 变更那一路：和提交那一路走同一棵树（同一套 buildTree/flattenTree、
           同一个 '@files' 前缀），只有叶子行不同 —— 行尾仍带 暂存/未跟踪/未暂存
           的标记，目录已经画在树上了，行内不再铺目录压暗。git 折叠成一条的未
           跟踪目录（路径以 / 结尾）不是文件，点它也没有差异，不进树。 */
        title = '变更文件'
        const entries = []
        const sorted = rail.changes.slice()
        sorted.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0) })
        for (let i = 0; i < sorted.length; i += 1) {
          const entry = sorted[i]
          const path = text(entry.path)
          if (path.length === 0 || path.slice(-1) === '/') continue
          entries.push({ segments: path.split('/'), data: entry })
        }
        const tree = buildTree(entries)
        /* 末位 false：文件树不压扁，每个目录段独立一行（见 42-tree.js flattenTree）。 */
        const flat = flattenTree(tree, 0, '@files', props.collapsed, [], '@files', false)
        for (let i = 0; i < flat.length; i += 1) {
          const node = flat[i]
          if (node.kind === 'dir') {
            rows.push(treeDirRow(node, dirHandle, String(node.count) + ' 个文件'))
            continue
          }
          const entry = node.data || {}
          const path = text(entry.path)
          const mine = path === current
          const mark = entry.staged === true ? '已暂存' : (entry.untracked === true ? '未跟踪' : '未暂存')
          rows.push(h('div', {
            className: 'dsh-git-trow' + (mine ? ' dsh-git-trow-sel' : ''),
            key: node.id,
            style: { paddingLeft: (6 + node.depth * 12) + 'px' },
            title: path + '（点开看差异）',
            ref: mine === true ? function (node) { rowBox.node = node } : undefined,
            onClick: function () { if (typeof props.onOpenFile === 'function') props.onOpenFile(entry) },
          },
            h('span', { className: 'dsh-git-tw' }),
            h('span', { className: 'dsh-git-st' + statusClass(entry.displayCode) }, statusLabel(entry.displayCode)),
            h('span', { className: 'dsh-git-tname' }, node.name),
            h('span', {
              key: 'm', className: 'dsh-git-diffrail-mark',
              title: entry.staged === true ? '已暂存（改动在索引里）'
                : (entry.untracked === true ? '未跟踪（git 还没见过这个路径）' : '未暂存（改动在工作区）'),
            }, mark)))
        }
      }

      return h('div', { className: 'dsh-git-diffrail' },
        h('div', { key: 'h', className: 'dsh-git-diffrail-head' }, title),
        h('div', { key: 'l', className: 'dsh-git-diffrail-list' }, rows))
    }

    /* ── 「查看文件」：把这一个文件交给 DSH 官方的右侧文件页 ──

       补丁回答的是「改成了什么样」，有时读者要的是整个文件。DSH 官方的右侧文件页
       （sidebar-right 包提供的 controller，ctx.reflect 里的 'sidebarRight'）本来就是
       干这个的 —— 接它的 openResource 即可，这里不再自己画一个阅读器，也不传行号：
       打开的就是工作区里的当前内容。地址的拼法照官方 sidebar-files 的
       sessionFileAddress 逐字对齐：反斜杠归一为 /、去掉前导 ./，sessionId 与路径
       按 / 分段 encodeURIComponent 并把 %3A 还原为 ':'（盘符的冒号保持字面，官方
       的注释就是这么写的）—— 拼法差一个字符 Host 就会当成另一个资源。

       按钮画不画有三道守卫，任何一道不过就不画，而不是画一个点了必败的按钮：
       官方服务不在（bridge 版没有 pkg 层；老版 dsh —— engines 声明 >=0.1.5-rc.1
       那个年代也还没有这个口子）；会话工作区未知（24-repos.js 的 workspaceOf，
       扫描没落地就答不出「这个文件在不在里面」）；绝对路径越出工作区（官方 Host
       拒绝读工作区外的路径，点开只会是一个错误页）。多仓库的分组里 diff 属于
       target.repo 那个仓库，所以路径的根由调用方按 diffRepo/effectiveRepo 传进来
       （repoRoot），不能拿「屏上生效仓库」凑数。 */

    /* 官方口径的地址段编码：encodeURIComponent 之后把 %3A 还原成 ':'。 */
    function encodeFileSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':')
    }

    /* dsh-resource://file/session/<sessionId>/<路径>。官方实现先归一路径再分段
       编码，这里同样把两步写在一起，省得调用点各自归一。 */
    function diffFileAddress(sessionId, path) {
      const normalized = text(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return 'dsh-resource://file/session/' + encodeFileSegment(text(sessionId)) + '/'
        + normalized.split('/').map(encodeFileSegment).join('/')
    }

    /* 点击的全部动作。openResource 是官方服务自己的路，它抛什么都不是这个面板
       的错 —— 只把原话送进控制台，界面一个字节不动。 */
    function openDiffFile(sessionId, path) {
      try {
        ctx.get('sidebarRight').openResource(diffFileAddress(sessionId, path))
      } catch (failure) {
        console.error('dsh-git-idea:', failure)
      }
    }

    /* 三道守卫全过才返回按钮，否则 null。绝对路径在这里拼成，点击时原样用它：
       守卫审过的地址和真正打开的地址必须是同一个。 */
    function viewFileButton(target, sessionId, repoRoot) {
      const side = ctx.get('sidebarRight')
      if (side == null || typeof side.openResource !== 'function') return null
      const root = workspaceOf(sessionId).replace(/\\/g, '/').replace(/\/+$/, '')
      const repo = text(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '')
      if (root.length === 0 || repo.length === 0) return null
      const absolute = (repo + '/' + text(target.path)).replace(/\\/g, '/')
      if (absolute !== root && absolute.indexOf(root + '/') !== 0) return null
      return h('button', {
        key: 'viewfile', type: 'button', className: 'dsh-git-btn',
        title: '在右侧文件页打开完整文件（工作区当前内容；提交那一路打开的也是工作区里的这一版）',
        onClick: function () { openDiffFile(sessionId, absolute) },
      }, '查看文件')
    }

    function DiffView(props) {
      const target = props.target
      /* 回车符开关是这个浏览器自己的显示偏好（20-prefs.js 的 settings 层）。在
         这里读一次、往下传到 PatchBody：勾选只把已拿到的补丁换个画法（配对与词级
         差异在同一个 useMemo 里重算），一个 git/diff 都不会重发。 */
      const settings = useGitSettings()
      const showCr = settings.diffShowCr === true
      const requests = diffRequests(target)
      const shape = diffShape(requests, target)
      const [rows, setRows] = React.useState(null)
      /* 右列默认在：要看的是「这一批修改」，藏起来才是少数场合 —— 头部那个按钮
         一下把它收掉，补丁区拿回整宽。 */
      const [railOpen, setRailOpen] = React.useState(true)

      React.useEffect(function () {
        let alive = true
        setRows(null)
        const jobs = []
        const list = diffRequests(target)
        for (let i = 0; i < list.length; i += 1) {
          const req = list[i]
          const payload = { sessionId: props.sessionId, mode: req.mode, path: target.path }
          if (props.repo.length > 0) payload.repo = props.repo
          if (text(target.from).length > 0) payload.from = target.from
          if (req.ref !== undefined) payload.ref = req.ref
          jobs.push(callHost('git/diff', payload).then(function (reply) {
            return { req: req, reply: reply }
          }, function (failure) {
            return { req: req, failure: failureText(failure) }
          }))
        }
        Promise.all(jobs).then(function (answered) {
          if (alive) setRows(answered)
        })
        return function () { alive = false }
        /* `sig` is the row's own state as the last workspace read reported it:
           staging a file, or letting it be staged, changes it, and the patch
           behind this view has to follow that. An edit nobody told the panel
           about does not move it — that is what the refresh button is for. */
      }, [shape, props.repo, props.sessionId, props.sig])

      const loaded = rows !== null ? rows : []
      let added = 0
      let removed = 0
      let truncated = false
      let binary = false
      let empty = false
      for (let i = 0; i < loaded.length; i += 1) {
        const reply = loaded[i].reply
        if (reply == null || reply.ok !== true) continue
        added += reply.added
        removed += reply.removed
        if (reply.truncated === true) truncated = true
        if (reply.binary === true) binary = true
        if (reply.empty === true) empty = true
      }

      /* A file git has never seen is exactly the one a reader most wants to put
         in the index from here, so the untracked case gets the button too. */
      const staged = target.kind !== 'commit' && typeof props.onStage === 'function'
        ? h('button', {
            key: 'stage', type: 'button', className: 'dsh-git-btn',
            disabled: props.busy === true,
            title: target.staged === true ? '从索引里撤下这个文件' : '把这个文件的改动放进索引',
            onClick: function () { props.onStage(target.staged !== true) },
          }, target.staged === true ? '取消暂存' : '暂存')
        : null

      /* 「查看文件」跟着「暂存」走文字按钮那一排，⟳/☰ 之前 —— 三道守卫任何一道
         不过就是 null，头部比过去短一块，别的地方一字不动。 */
      const viewFile = viewFileButton(target, props.sessionId, props.repoRoot)

      /* ── 头部的勾选框：变更列表那一只，跟到差异视图里来 ──

         变更树的每一行都有勾选框（勾 = 这条路径的改动进了索引，点一下就是
         setStaged 那条路），单击行打开差异之后那只框就看不见了 —— 而读补丁的
         时候恰恰经常要顺手决定「这个文件进不进这次提交」。头部画的就是列表那一只：
         stageBox 同一份构造（54-changes.js，模块层那一个定义，两处调用），class、
         字形、悬停话术与点击手势一字不差；语义也是列表的语义 —— 框只回答「这条
         路径的改动现在在不在索引里」，文件暂存之后又改过（staged 与 workCode
         并存，列表里那只框照样是勾着的）也一样照列表勾。

         两道守卫任何一道不过就返回 null 不画（viewFileButton 的同一条规矩）：
         提交详情那一路（kind === 'commit'）读的是某一次提交的补丁，「暂存」对它
         无从谈起，框不画；宿主没接 onStage 时画一只点不动的框比不画更糟。
         点一下就是 props.onStage(!staged)，80-panel.js 把它接成
         setStaged([{path}], staged, diffRepo) —— 与列表同一个通道、同一个乐观补丁。
         头部右侧那个「暂存/取消暂存」文字按钮原样保留：它的历史比框长，守护它的
         断言（gp42 第 16 节的头部排序）也在，没有理由在这次改动里动它。 */
      const stageToggle = target.kind !== 'file' || typeof props.onStage !== 'function'
        ? null
        : stageBox('stagebox', target.staged === true ? 'all' : 'none',
          target.staged === true ? '取消暂存' : '暂存',
          function () { props.onStage(target.staged !== true) })

      const head = h('div', { key: 'head', className: 'dsh-git-diffhead' },
        diffIconButton('back', h(Icon, { name: 'back', size: 14 }), '返回文件列表', props.onBack),
        /* 框在路径之前 —— 和列表行同一个读法：先框，再状态，再名字（54-changes.js
           的 fileRow 把框放在行首就是为这一眼）。 */
        stageToggle,
        h('span', { key: 'p', className: 'dsh-git-diffpath', title: target.path }, target.path),
        target.status !== undefined
          ? h('span', { key: 'st', className: 'dsh-git-st' + statusClass(target.status) }, statusLabel(target.status))
          : null,
        rows === null
          ? h('span', { key: 'c', className: 'dsh-git-diffcount' }, '读取中…')
          : h('span', { key: 'c', className: 'dsh-git-diffcount' }, diffCounts({ added: added, removed: removed })),
        staged,
        viewFile,
        diffIconButton('again', '⟳', '重新读取这个文件的差异', props.onRefresh),
        /* ── 回车符开关 ──

           勾选框就是变更树那只（stageBox，同一份构造：class、字形、点击不惊动行），
           文案跟在框后面，点框或点文案都翻。勾上后行尾的 \r 画成暗色 ⏎ 并参与词级
           高亮 —— 「内容相同、只有行尾 CRLF↔LF 差别」的一对行，有 \r 的那一侧的 ⏎
           会被标出来；不勾时行尾 \r 一律剥掉（裸 \r 在 white-space:pre 下是换行，
           撑破行高）。状态存进 settings 层（diffShowCr），刷新后还在。放在 ⟳ 之后、
           ☰ 之前，跟视图开关聚在一起；提交那一路同样有用，所以不受暂存框那两道守卫
           管。 */
        h('span', {
          key: 'cr', className: 'dsh-git-diffcr',
          title: '显示行尾的回车符（CR，\\r）：行尾画成 ⏎ 并参与词级高亮；状态记在这个浏览器里',
          onClick: function () { saveSettings(Object.assign({}, settings, { diffShowCr: showCr !== true })) },
        },
          stageBox('crbox', showCr === true ? 'all' : 'none',
            showCr === true ? '隐藏回车符' : '显示回车符（\\r）',
            function () { saveSettings(Object.assign({}, settings, { diffShowCr: showCr !== true })) }),
          '回车符'),
        /* 有来源列表可列时才给这个开关：没有列表的 diff（详情已不在、快照没到），
           按下去也没有东西会响应。 */
        props.rail != null
          ? diffIconButton('rail', '☰', '文件列表', function () { setRailOpen(railOpen !== true) }, { on: railOpen === true })
          : null)

      const warn = []
      if (truncated) warn.push('差异过长，只显示了开头一部分')
      if (binary) warn.push('二进制文件')
      if (warn.length === 0 && empty === true && loaded.length > 0) warn.push('没有差异')

      let body
      if (rows === null) body = h('div', { key: 'wait', className: 'dsh-git-pane dsh-git-dim' }, '正在读取差异…')
      else {
        const labeled = rows.length > 1
        const sections = []
        for (let i = 0; i < rows.length; i += 1) sections.push(h(DiffSection, { key: 's' + i, row: rows[i], labeled: labeled, showCr: showCr }))
        body = h('div', { key: 'body', className: 'dsh-git-diffbody' }, sections)
      }

      return h('div', { className: 'dsh-git-diffview' },
        head,
        warn.length > 0 ? h('div', { key: 'warn', className: 'dsh-git-diffwarn' }, warn.join(' · ')) : null,
        /* 补丁区拿剩余宽度（flex:1），右列固定 240px 贴在右边；右列收起时这一层
           只剩补丁，布局回到原来的样子。 */
        h('div', { key: 'split', className: 'dsh-git-diffsplit' },
          body,
          railOpen === true && props.rail != null
            ? h(DiffFileRail, {
                key: 'rail',
                rail: props.rail,
                current: target.path,
                onOpenFile: props.onOpenFile,
                collapsed: props.collapsed,
                onToggle: props.onToggle,
              })
            : null))
    }
