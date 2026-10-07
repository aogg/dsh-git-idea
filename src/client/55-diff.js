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

    /* One section's body. A patch can be thousands of lines and the pane shows
       twenty-odd of them, so it is windowed exactly like the history list: same
       arithmetic, same spacers, and "everything" while no height can be
       measured. */
    function PatchBody(props) {
      const rows = useMemo(function () { return diffRows(props.patch) }, [props.patch])
      const win = useVirtualWindow('diff:' + props.id, rows.length, DIFF_ROW_H)
      const shown = []
      for (let i = win.first; i < win.last; i += 1) {
        const row = rows[i]
        shown.push(h('div', { key: 'r' + i, className: 'dsh-git-dline dsh-git-dl-' + row.kind },
          h('span', { key: 'o', className: 'dsh-git-dno' }, row.old),
          h('span', { key: 'n', className: 'dsh-git-dno' }, row.next),
          h('span', { key: 's', className: 'dsh-git-dsign' }, row.sign),
          h('span', { key: 't', className: 'dsh-git-dtext' }, row.text)))
      }
      const padTop = win.first * DIFF_ROW_H
      const padBottom = (rows.length - win.last) * DIFF_ROW_H
      return h('div', { className: 'dsh-git-diff', ref: win.attach, onScroll: win.measure },
        h('div', { className: 'dsh-git-diffwrap', style: { minHeight: (rows.length * DIFF_ROW_H) + 'px' } },
          padTop > 0 ? h('div', { key: 'pad-top', style: { height: padTop + 'px' } }) : null,
          shown,
          padBottom > 0 ? h('div', { key: 'pad-bottom', style: { height: padBottom + 'px' } }) : null))
    }

    /* The two icon buttons this view needs, in the panel's own vocabulary: the
       same classes as the toolbar's icon tools (so they are the same hit area and
       the same hover), the mirror of the chevron the branch rows use for "go
       there", and the glyph the panel's own refresh already draws. */
    function diffIconButton(key, glyph, title, onClick, options) {
      const opts = options == null ? {} : options
      return h('button', {
        key: key, type: 'button', className: 'dsh-git-tool dsh-git-tool-ico',
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
        body = h(PatchBody, { id: row.req.key, patch: reply.text })
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

    function DiffView(props) {
      const target = props.target
      const requests = diffRequests(target)
      const shape = diffShape(requests, target)
      const [rows, setRows] = React.useState(null)

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

      const head = h('div', { key: 'head', className: 'dsh-git-diffhead' },
        diffIconButton('back', h(Icon, { name: 'back', size: 14 }), '返回文件列表', props.onBack),
        h('span', { key: 'p', className: 'dsh-git-diffpath', title: target.path }, target.path),
        target.status !== undefined
          ? h('span', { key: 'st', className: 'dsh-git-st' + statusClass(target.status) }, statusLabel(target.status))
          : null,
        rows === null
          ? h('span', { key: 'c', className: 'dsh-git-diffcount' }, '读取中…')
          : h('span', { key: 'c', className: 'dsh-git-diffcount' }, diffCounts({ added: added, removed: removed })),
        staged,
        diffIconButton('again', '⟳', '重新读取这个文件的差异', props.onRefresh))

      const warn = []
      if (truncated) warn.push('差异过长，只显示了开头一部分')
      if (binary) warn.push('二进制文件')
      if (warn.length === 0 && empty === true && loaded.length > 0) warn.push('没有差异')

      let body
      if (rows === null) body = h('div', { key: 'wait', className: 'dsh-git-pane dsh-git-dim' }, '正在读取差异…')
      else {
        const labeled = rows.length > 1
        const sections = []
        for (let i = 0; i < rows.length; i += 1) sections.push(h(DiffSection, { key: 's' + i, row: rows[i], labeled: labeled }))
        body = h('div', { key: 'body', className: 'dsh-git-diffbody' }, sections)
      }

      return h('div', { className: 'dsh-git-diffview' },
        head,
        warn.length > 0 ? h('div', { key: 'warn', className: 'dsh-git-diffwarn' }, warn.join(' · ')) : null,
        body)
    }
