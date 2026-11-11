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
      /* 选区视图（多选合并查看）的一只文件：base..head 整段。 */
      if (target.kind === 'range') return [{ key: 'range', label: '', mode: 'range', ref: target.ref }]
      if (target.kind === 'commit') return [{ key: 'commit', label: '', mode: 'commit', ref: target.ref }]
      /* 「与本地比较」（文件右键菜单，61-filemenu.js）：ref 是提交本身，读的是
         git diff <ref> -- 路径 —— 提交里的版本和工作区现在的差在哪。 */
      if (target.kind === 'local') return [{ key: 'local', label: '', mode: 'local', ref: target.ref }]
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
            kind: 'ctx', cls: ' dsh-git-dl-ctx',
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
        /* 配对行同时是一删一加：行类把两个都挂上（底色在半列上，行类只管身份）。 */
        kind: 'pair', cls: ' dsh-git-dl-del dsh-git-dl-add',
        left: { no: del.old, sign: '-', text: leftText, miss: words === null ? null : words.left },
        right: { no: add.next, sign: '+', text: rightText, miss: words === null ? null : words.right },
      }
    }

    /* 多出的那半：有内容的一侧整行底色，另一侧留空（没有行号、没有记号）。 */
    function halfRow(kind, row, showCr) {
      const cell = { no: kind === 'del' ? row.old : row.next, sign: row.sign, text: crText(row.text, showCr), miss: null }
      const empty = { no: '', sign: '', text: '', miss: null }
      return kind === 'del'
        ? { kind: 'del', cls: ' dsh-git-dl-del', left: cell, right: empty }
        : { kind: 'add', cls: ' dsh-git-dl-add', left: empty, right: cell }
    }

    /* 一格的底色归属跟着记号走：+ 绿、- 红、空格上下文、空串是留空的半列。 */
    function halfMark(cell) {
      if (cell.sign === '+') return ' dsh-git-dhalf-add'
      if (cell.sign === '-') return ' dsh-git-dhalf-del'
      if (cell.sign === ' ') return ' dsh-git-dhalf-ctx'
      return ' dsh-git-dhalf-empty'
    }

    /* ── 一格正文的显示层加工（行号右键菜单的两个外观开关，80-panel.js 递进来）──

       cellChildren 是原 crChildren 的扩展：词级 miss 段落与回车符字形照旧，往上
       叠两件纯显示层的事 ——
       · 空白可视化（view.ws）：空格画中点、制表符画箭头。字形用 ::after 覆盖在
         原字符上（span.dsh-git-wsp 原文仍在 DOM 里），复制到的还是原字符 —— 只
         改显示，不改补丁数据。
       · 缩进参考线（view.guides）：把**第一段开头**的前导空白剥出来按缩进单位
         （4 个空格 / 一个制表符）切段，每段左缘画一条竖线（第 0 列不画）。前导
         空白优先给参考线 —— 段内的线就是缩进本身，两开关不打架；段中后继的空白
         仍归 view.ws 管。正文与两个开关全部无关：关掉任何一个，字符原样回来。 */
    function guideSpans(key, run) {
      const out = []
      let chunk = ''
      let first = true
      const flush = function (withLine) {
        if (chunk.length === 0) return
        out.push(h('span', { key: key + String(out.length), className: 'dsh-git-dguide' + (withLine ? ' dsh-git-dguide-line' : '') }, chunk))
        chunk = ''
      }
      for (let i = 0; i < run.length; i += 1) {
        const ch = run.charAt(i)
        if (ch === '\t') {
          flush(first !== true)
          out.push(h('span', { key: key + String(out.length), className: 'dsh-git-dguide' + (first ? '' : ' dsh-git-dguide-line') }, ch))
          first = false
          continue
        }
        chunk += ch
        if (chunk.length === 4) { flush(first !== true); first = false }
      }
      flush(first !== true)
      return out
    }

    function textChildren(key, text, miss, ws) {
      if (ws !== true) return [miss === true ? h('span', { key: key, className: 'dsh-git-dmiss' }, text) : text]
      const out = []
      const parts = text.split(/([ \t]+)/)
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i]
        if (part.length === 0) continue
        if (i % 2 === 1) {
          for (let c = 0; c < part.length; c += 1) {
            const ch = part.charAt(c)
            out.push(h('span', {
              key: key + 'w' + i + '-' + String(c),
              className: 'dsh-git-wsp dsh-git-wsp-' + (ch === '\t' ? 'tab' : 'sp') + (miss === true ? ' dsh-git-dmiss' : ''),
            }, ch))
          }
          continue
        }
        out.push(miss === true ? h('span', { key: key + 't' + i, className: 'dsh-git-dmiss' }, part) : part)
      }
      return out
    }

    function cellChildren(cell, view, keyPrefix) {
      const out = []
      const segs = cell.miss !== null ? cell.miss : [{ t: cell.text, m: false }]
      const queue = segs.slice()
      if (view.guides === true && queue.length > 0) {
        const head = /^([ \t]+)/.exec(queue[0].t)
        if (head !== null) {
          const rest = queue[0].t.slice(head[1].length)
          queue[0] = { t: rest, m: queue[0].m }
          const guides = guideSpans(keyPrefix + 'g', head[1])
          for (let g = 0; g < guides.length; g += 1) out.push(guides[g])
        }
      }
      for (let s = 0; s < queue.length; s += 1) {
        const seg = queue[s]
        const parts = seg.t.split('\r')
        for (let p = 0; p < parts.length; p += 1) {
          if (p > 0) {
            out.push(h('span', { key: keyPrefix + 'cr' + s + '-' + p, className: 'dsh-git-dcr' + (seg.m === true ? ' dsh-git-dmiss' : '') }, CR_GLYPH))
          }
          if (parts[p].length === 0) continue
          const children = textChildren(keyPrefix + 'x' + s + '-' + p, parts[p], seg.m, view.ws)
          for (let c = 0; c < children.length; c += 1) out.push(children[c])
        }
      }
      return out
    }

    /* blame 注解的一格：短 hash（边界提交带 ^ 前缀）+ 作者 + 短日期。窄条挂在
       右半行号旁边（注解按右栏那棵树的版本问），没有注解的行留空条占位 —— 宽度
       由 CSS 钉住，行与行之间文字起点才不会跳。 */
    function blameCell(blameMap, no, keyPrefix) {
      const one = no !== '' && no !== undefined && blameMap != null ? blameMap[String(no)] : undefined
      if (one === undefined) return h('span', { key: keyPrefix + 'bl', className: 'dsh-git-dblame' }, '')
      const at = parseDate(one.date)
      const when = at !== null ? relativeDate(one.date) : text(one.date)
      return h('span', {
        key: keyPrefix + 'bl', className: 'dsh-git-dblame' + (one.boundary === true ? ' dsh-git-dblame-b' : ''),
        title: (one.boundary === true ? '边界提交（更早的历史这次没有取回来）：' : '')
          + text(one.short) + ' ' + text(one.author) + ' ' + when
          + ' —— 右键行号可关闭注解',
      }, text(one.short) + ' ' + text(one.author) + ' ' + when)
    }

    /* One section's body. A patch can be thousands of lines and the pane shows
       twenty-odd of them, so it is windowed exactly like the history list: same
       arithmetic, same spacers, and "everything" while no height can be
       measured. The rows it paints are the paired ones: the pairing and the
       word-level marks are computed once per (patch, 回车符开关) in the memo —
       toggling the checkbox repaints what is already in hand and never re-asks
       git.

       行号右键菜单的三件事也在这里落地（开关都从面板递进来）：
       · 左半栏的行号画在半列末尾（分隔线内侧）—— 两个行号隔着分隔线并排；
       · 行号/记号格挂 onContextMenu（面板的行号菜单）， blame 窄条挂在右半行号旁；
       · 「收起未更改的片段」：连续上下文行超过阈值的段落折成一条「⋯ 展开未更改
         的 N 行」（再点收起）。折叠只是把已配好的行视觉上收起来 —— 行号是配对时
         逐行算好的，折与不折都不重算。默认收起（IDEA 同款）；普通 -U3 的读里
         没有超阈值的段落，画面与从前一字不差，展开读（大上下文）落地后条才出现。 */
    const FOLD_MIN = 10

    function PatchBody(props) {
      const showCr = props.showCr === true
      const collapse = props.collapse === true
      const wrap = props.wrap === true
      const view = { showCr: showCr, ws: props.ws === true, no: props.no !== false, guides: props.guides === true }
      const paired = useMemo(function () { return pairRows(diffRows(props.patch), showCr) }, [props.patch, showCr])
      const [expandedRuns, setExpandedRuns] = React.useState({})
      /* 换补丁或全局收放时，逐段展开的记录作废 —— 与 IDEA 的「收起」同一条语义。 */
      React.useEffect(function () { setExpandedRuns({}) }, [props.patch, collapse])

      const model = useMemo(function () {
        if (collapse !== true) return paired
        const out = []
        let run = null
        const flush = function () {
          if (run === null) return
          if (run.rows.length > FOLD_MIN) {
            out.push({ kind: 'foldbar', full: true, count: run.rows.length, open: expandedRuns[run.start] === true, at: run.start })
            if (expandedRuns[run.start] === true) {
              for (let k = 0; k < run.rows.length; k += 1) out.push(run.rows[k])
            }
          } else {
            for (let k = 0; k < run.rows.length; k += 1) out.push(run.rows[k])
          }
          run = null
        }
        for (let i = 0; i < paired.length; i += 1) {
          const row = paired[i]
          if (row.kind === 'ctx') {
            if (run === null) run = { start: i, rows: [] }
            run.rows.push(row)
            continue
          }
          flush()
          out.push(row)
        }
        flush()
        return out
      }, [paired, collapse, expandedRuns])

      const blameMap = useMemo(function () {
        const map = {}
        const lines = props.blame != null && Array.isArray(props.blame.lines) ? props.blame.lines : []
        for (let i = 0; i < lines.length; i += 1) {
          const one = lines[i]
          if (one != null && typeof one.no === 'number' && map[String(one.no)] === undefined) map[String(one.no)] = one
        }
        return map
      }, [props.blame])

      /* 自动换行时行高不定（19px 的整数倍假设破产），虚拟窗口整体让位：全量渲染。
         补丁本身有展示上限（6000 行 / 400KB），全量的 DOM 是封顶的。 */
      const winRaw = useVirtualWindow('diff:' + props.id, wrap === true ? 0 : model.length, DIFF_ROW_H)
      const win = wrap === true ? { first: 0, last: model.length } : winRaw
      const shown = []
      for (let i = win.first; i < win.last; i += 1) {
        const row = model[i]
        if (row.full === true) {
          if (row.kind === 'foldbar') {
            shown.push(h('div', { key: 'r' + i, className: 'dsh-git-dline dsh-git-dl-fold' },
              h('button', {
                key: 'fb', type: 'button', className: 'dsh-git-dfold',
                title: row.open === true
                  ? '收起这 ' + String(row.count) + ' 行未更改的内容（再点展开条恢复）'
                  : '展开这 ' + String(row.count) + ' 行未更改的内容',
                onClick: function () {
                  setExpandedRuns(function (previous) {
                    const next = Object.assign({}, previous)
                    if (next[row.at] === true) delete next[row.at]
                    else next[row.at] = true
                    return next
                  })
                },
              }, row.open === true ? '⌃ 收起未更改的 ' + String(row.count) + ' 行' : '⋯ 展开未更改的 ' + String(row.count) + ' 行')))
            continue
          }
          /* hunk / meta / note：一格横跨两列整行。 */
          shown.push(h('div', { key: 'r' + i, className: 'dsh-git-dline dsh-git-dl-' + row.kind },
            h('div', { key: 'f', colSpan: 2, className: 'dsh-git-dfull' }, row.text)))
          continue
        }
        shown.push(h('div', { key: 'r' + i, className: 'dsh-git-dline' + row.cls },
          /* 左半：记号、正文、行号（行号贴分隔线内侧 —— 与右半行号并排，见顶部
             注释）。行号与记号格都挂行号菜单：隐藏行号后右键记号还在。 */
          h('div', { key: 'o', className: 'dsh-git-dhalf dsh-git-dhalf-old' + halfMark(row.left) },
            h('span', { key: 'sg', className: 'dsh-git-dsign', onContextMenu: props.onGutterMenu }, row.left.sign),
            h('span', { key: 'tx', className: 'dsh-git-dtext' }, cellChildren(row.left, view, 'l' + i)),
            view.no === true
              ? h('span', { key: 'no', className: 'dsh-git-dno', onContextMenu: props.onGutterMenu }, row.left.no)
              : null),
          h('div', { key: 'n', className: 'dsh-git-dhalf dsh-git-dhalf-new' + halfMark(row.right) },
            view.no === true
              ? h('span', { key: 'no', className: 'dsh-git-dno', onContextMenu: props.onGutterMenu }, row.right.no)
              : null,
            props.blame != null ? blameCell(blameMap, row.right.no, 'r' + i) : null,
            h('span', { key: 'sg', className: 'dsh-git-dsign', onContextMenu: props.onGutterMenu }, row.right.sign),
            h('span', { key: 'tx', className: 'dsh-git-dtext' }, cellChildren(row.right, view, 'r' + i)))))
      }
      const padTop = wrap === true ? 0 : win.first * DIFF_ROW_H
      const padBottom = wrap === true ? 0 : (model.length - win.last) * DIFF_ROW_H
      return h('div', { className: 'dsh-git-diff', ref: wrap === true ? undefined : win.attach, onScroll: wrap === true ? undefined : win.measure },
        /* wrap 类同时加在 wrap 容器上：基类的 width:max-content 是给横向滚动用的，
           折行档必须退回 100% 宽，内容才折得动（46-css.js 的 dsh-git-diffwrap-wrap）。 */
        h('div', { className: 'dsh-git-diffwrap' + (wrap === true ? ' dsh-git-diffwrap-wrap' : ''),
          style: wrap === true ? undefined : { minHeight: (model.length * DIFF_ROW_H) + 'px' } },
          padTop > 0 ? h('div', { key: 'pad-top', style: { height: padTop + 'px' } }) : null,
          /* 行放进一张表：列宽由整张表按内容分，左右两列的边界才逐行对齐 —— 每行
             各排各的（flex / 各自的 50%）做不到，谁的内容长边界就歪到谁那边。
             自动换行时表上加 wrap 类（pre→pre-wrap），行高交给内容自适应。 */
          h('div', { key: 'table', className: 'dsh-git-dtable' + (wrap === true ? ' dsh-git-dtable-wrap' : '') }, shown),
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
        body = h(PatchBody, {
          id: row.req.key, patch: reply.text, showCr: props.showCr,
          ws: props.ws, no: props.no, guides: props.guides, wrap: props.wrap,
          blame: props.blame, collapse: props.collapse, onGutterMenu: props.onGutterMenu,
        })
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
      /* 右键挂点：rail 上带 listKind / rev（面板在构造 rail 时写好 —— 提交那一路
         rev 是 detail.hash，选区那一路是 selSpan.head），别在这里再发读。面板没接
         onFileContext 时行上不挂右键，行为与从前一字不差。 */
      const dirHandle = { selectedKey: dirKey, onSelect: setDirKey, onToggle: props.onToggle }
      if (typeof props.onFileContext === 'function') {
        dirHandle.onContext = function (node, event) {
          props.onFileContext(fileMenuTarget(rail.listKind, rail.rev, rail.repo, node.path, { dir: true }), event)
        }
      }
      /* 叶子行的右键：同一份 target 拼法，带上这一行已知的标记（暂存/未跟踪/改名
         来源），菜单的启用矩阵全从这些标记读。 */
      const rowContext = typeof props.onFileContext === 'function'
        ? function (path, extra) {
            return function (event) {
              props.onFileContext(fileMenuTarget(rail.listKind, rail.rev, rail.repo, path, extra), event)
            }
          }
        : null
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
            onContextMenu: rowContext === null ? undefined : rowContext(text(file.path),
              { untracked: false, staged: false, conflict: false, from: text(file.from), raw: file }),
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
            onContextMenu: rowContext === null ? undefined : rowContext(path,
              { untracked: entry.untracked === true, staged: entry.staged === true,
                conflict: entry.conflict === true, from: '', raw: entry }),
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

    /* 三道守卫，一次说清。过了返回 {ok:true, absolute}（绝对路径，调用方原样用它
       —— 守卫审过的地址和真正打开的地址必须是同一个）；不过返回 {ok:false, why}，
       why 是一句人话，右键菜单的置灰 title 直接引用它（viewFileButton 那边不过就
       不画按钮，用不上 why，但一条守卫只该有一份答案）。 */
    function viewFileGuard(target, sessionId, repoRoot) {
      const side = ctx.get('sidebarRight')
      if (side == null || typeof side.openResource !== 'function') {
        return { ok: false, why: '这个 DSH 版本没有右侧文件页（sidebarRight 服务不在）' }
      }
      const root = workspaceOf(sessionId).replace(/\\/g, '/').replace(/\/+$/, '')
      const repo = text(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '')
      if (root.length === 0) return { ok: false, why: '会话工作区还没读出来，说不出这个文件在不在里面' }
      if (repo.length === 0) return { ok: false, why: '还不知道这个仓库的根路径' }
      const absolute = (repo + '/' + text(target.path)).replace(/\\/g, '/')
      if (absolute !== root && absolute.indexOf(root + '/') !== 0) {
        return { ok: false, why: '仓库在会话工作区之外，官方文件页拒绝打开工作区外的路径' }
      }
      return { ok: true, absolute: absolute }
    }

    /* 三道守卫全过才返回按钮，否则 null。 */
    function viewFileButton(target, sessionId, repoRoot) {
      const guarded = viewFileGuard(target, sessionId, repoRoot)
      if (guarded.ok !== true) return null
      return h('button', {
        key: 'viewfile', type: 'button', className: 'dsh-git-btn',
        title: '在右侧文件页打开完整文件（工作区当前内容；提交那一路打开的也是工作区里的这一版）',
        onClick: function () { openDiffFile(sessionId, guarded.absolute) },
      }, '查看文件')
    }

    function DiffView(props) {
      const target = props.target
      /* 回车符开关是这个浏览器自己的显示偏好（20-prefs.js 的 settings 层）。在
         这里读一次、往下传到 PatchBody：勾选只把已拿到的补丁换个画法（配对与词级
         差异在同一个 useMemo 里重算），一个 git/diff 都不会重发。行号菜单那组外观
         开关（空格可视化 / 行号 / 缩进参考线 / 自动换行）同层同读法。 */
      const settings = useGitSettings()
      const showCr = settings.diffShowCr === true
      const requests = diffRequests(target)
      const shape = diffShape(requests, target)
      const [rows, setRows] = React.useState(null)
      /* 右列默认在：要看的是「这一批修改」，藏起来才是少数场合 —— 头部那个按钮
         一下把它收掉，补丁区拿回整宽。 */
      const [railOpen, setRailOpen] = React.useState(true)
      /* ── 「收起未更改的片段」的大上下文读 ──

         默认收起（fragOpen=false）走的是普通 -U3 读，画面与从前一字不差，不发额外
         的读。读者第一次展开（fragOpen=true）时置 bigEver，这里照同一批请求按
         -U 大上下文 + 免字符截断再读一次；读到的整补丁从此留在手里 —— 收放只换
         画法（折叠条的出现/消失、逐段展开），一个字节都不重读。换文件（shape 变）
         按同一形状重读大上下文的那批。行数上限宿主照旧封着（6000 行），超限按
         「差异过长」警告，不给截过的账冒充完整折叠。 */
      const foldContext = 100000
      const [big, setBig] = React.useState(null)
      const [bigEver, setBigEver] = React.useState(false)
      React.useEffect(function () {
        if (props.fragOpen === true && bigEver !== true) setBigEver(true)
      }, [props.fragOpen, bigEver])
      React.useEffect(function () {
        if (bigEver !== true) return undefined
        let alive = true
        const jobs = []
        const list = diffRequests(target)
        for (let i = 0; i < list.length; i += 1) {
          const req = list[i]
          const payload = { sessionId: props.sessionId, mode: req.mode, path: target.path, context: foldContext, full: true }
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
          if (alive) setBig({ shape: shape, rows: answered })
        })
        return function () { alive = false }
      }, [shape, props.repo, props.sessionId, props.sig, bigEver])

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
      /* 大上下文读数就手时，各分节的补丁换用它（同一批请求、同一形状）—— 收放与
         逐段展开只换画法。某个分节的大读失败（截断/异常）就退回普通那份，分节各自
         独立判断；普通读还没落地时先等它（大读通常更慢，这个先后几乎不会反）。 */
      const bigReady = rows !== null && big !== null && big.shape === shape
      const sectionRows = loaded.map(function (one, i) {
        if (bigReady !== true) return one
        const bigRow = big.rows[i]
        if (bigRow == null || bigRow.reply == null || bigRow.reply.ok !== true) return one
        return bigRow
      })
      let added = 0
      let removed = 0
      let truncated = false
      let binary = false
      let empty = false
      for (let i = 0; i < sectionRows.length; i += 1) {
        const reply = sectionRows[i].reply
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
        for (let i = 0; i < rows.length; i += 1) {
          sections.push(h(DiffSection, {
            key: 's' + i, row: sectionRows[i], labeled: labeled, showCr: showCr,
            ws: settings.diffShowWs === true, no: settings.diffShowNo !== false,
            guides: settings.diffIndentGuides === true, wrap: settings.diffWrap === true,
            blame: props.blame, collapse: props.fragOpen !== true, onGutterMenu: props.onGutterMenu,
          }))
        }
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
                onFileContext: props.onFileContext,
              })
            : null))
    }
