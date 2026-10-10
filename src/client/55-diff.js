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
        viewFile,
        diffIconButton('again', '⟳', '重新读取这个文件的差异', props.onRefresh),
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
        for (let i = 0; i < rows.length; i += 1) sections.push(h(DiffSection, { key: 's' + i, row: rows[i], labeled: labeled }))
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
