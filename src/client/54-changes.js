    /* ── two groups ──

       IDEA's commit window does not show one list of everything git noticed. It
       shows a changelist — the tracked changes — and under it a node of new files:
       the paths git has never committed. Two nodes, two counts, and a new file
       stays a file rather than a folder mixed in among the tracked ones.

       This pane merged all of it into one tree: an untracked directory sat among
       the tracked ones with nothing saying it was untracked, and the only way to
       tell was to read each row's status letter.

       ── which group a new file belongs to ──

       Not `untracked` alone. Ticking a box runs `git add`, and the entry comes
       back as `A.` — a path in the index that HEAD has never seen. Grouping by
       `untracked` alone therefore made a ticked file leave this group for the
       changelist, and ticking the group's own box emptied it: the reader pressed
       one checkbox and lost sight of everything they had just ticked (reported
       from the running panel: 「全选未跟踪文件列表，会导致这个未跟踪文件列表消失
       合并到默认列表中」). A file that has been *added but not committed* is still
       a new file, so it stays here, its box just moves. Un-ticking it puts it back
       in the working tree as untracked, in the same row.

       So the test is "HEAD has never had this path", in two shapes: git has not
       seen it at all (`untracked`), or it is in the index as an addition
       (`A…` — `git status --porcelain=v2` prints `A.` for added-unchanged and
       `AM` for added-then-edited, so only the first letter is the test). A rename
       is `R…` and is not a new file; nor is anything already committed. Staging an
       unversioned *directory* still expands it into the files it holds, and those
       files stay in this group too — each with its own ticked box.

       ── two views ──

       IDEA's other toggle, next to the changes: a tree of directories, or a flat
       list of paths. Same rows, same boxes, same gestures — only the label and
       the indent differ. The flat list is sorted by path, because git's own
       order (index first, then worktree, then untracked) is the order git
       happened to answer in, not an order anyone chose.

       The switch itself is not here: it lives in the panel header (80-panel.js).
       On a row of its own above the list it cost the list a full line of height
       to say two words. */

    function isNewFile(entry) {
      if (entry.untracked === true) return true
      /* The addition test lives in one place (40-format.js): the untick
         prediction asks the same question about the same letters. */
      return entry.staged === true && addedInIndex(entry.indexCode)
    }

    function ChangesPane(props) {
      /* Read before the early returns: a hook cannot be skipped by a branch. */
      const settings = useGitSettings()
      const view = settings.changesView === 'flat' ? 'flat' : 'tree'
      const work = props.work
      if (work == null) return h('div', { className: 'dsh-git-pane dsh-git-dim' }, '正在读取工作区…')
      if (work.ok !== true) {
        const reason = work.noGit === true
          ? ('找不到 git：' + text(work.repo))
          : work.error === 'not-a-repository'
            ? ('不是 git 仓库：' + text(work.repo))
            : '无法读取工作区状态'
        return h('div', { className: 'dsh-git-pane dsh-git-error' }, reason)
      }

      /* ── 多仓库：按仓库分组 ──
         变更页侧栏多选了仓库时（24-repos.js），每个选中仓库一份自己的两组结构，顶上
         加一个仓库组头；单选/没多选时 groups 为空，走**同一个**渲染函数、scope 前缀为
         空 —— 键名、折叠、手势与今天一字不差，因为折叠表和选中键是整棵树共享的，
         「多仓库只是多套前缀」才不至于把单仓库的行挪了位置。 */
      const groups = Array.isArray(props.groups) && props.groups.length > 0 ? props.groups : null

      const INDENT_W = 12
      /* ── the indent is not the row's padding ──
         A row's own padding-left moved the checkbox along with the tree, so the
         boxes marched to the right one step per level and never lined up in a
         column: measured on a screenshot of this panel at depth 5 the box sat
         60px in, and nothing could be scanned or ticked down a single edge. IDEA's
         commit window keeps the boxes in a fixed left gutter and indents what is
         left of the row, so that is what this is: the checkbox first, then a
         spacer as wide as the depth, then the twisty/status and the name. */
      const indentPad = function (depth) {
        return h('span', { key: 'pad', className: 'dsh-git-tind', style: { width: (depth * INDENT_W) + 'px' } })
      }
      const stageBox = function (key, state, title, onClick) {
        return h('span', {
          key: key,
          className: 'dsh-git-cbox' + (state === 'all' ? ' dsh-git-cbox-on' : (state === 'some' ? ' dsh-git-cbox-part' : '')),
          title: title,
          onClick: function (event) {
            event.stopPropagation()
            onClick()
          },
        }, state === 'all' ? '☑' : (state === 'some' ? '▣' : '☐'))
      }

      /* ── the name first, the folder after it ──

         The flat row used to be `folder/ + name`, so the one thing the eye is
         looking for sat at the far right of a path that can be 120 characters
         long — and the row's clip took it away first. On a screenshot of this
         panel `.../risk/eval/service/impl/` filled the whole row and the file it
         belonged to read `SignalClusterEvalReportServiceIm…`: the name had been
         pushed off the edge by the path that was only there to say where it
         lives. IDEA reads `name  folder/`, and so does this now.

         The two are still one cell, not two columns: the folder is dimmed and
         smaller, the name keeps full contrast and stays where a clip cannot
         reach it. */
      const splitPath = function (path) {
        const dir = path.slice(-1) === '/' ? path.slice(0, -1) : path
        const cut = dir.lastIndexOf('/')
        return {
          dir: cut < 0 ? '' : dir.slice(0, cut + 1),
          base: (cut < 0 ? dir : dir.slice(cut + 1)) + (path.slice(-1) === '/' ? '/' : ''),
        }
      }
      const nameCell = function (label, flat) {
        const parts = splitPath(label)
        if (flat !== true || parts.dir.length === 0) return h('span', { className: 'dsh-git-tname' }, parts.base)
        return h('span', { className: 'dsh-git-tname' },
          h('span', { key: 'b' }, parts.base),
          h('span', { key: 'd', className: 'dsh-git-tpath' }, parts.dir))
      }
      /* ── what the boxes are, and how many of them there are ──

         A row is not always a file: git collapses an untracked directory into one
         entry ending in "/", and that entry is one box standing for however many
         files are underneath it. Calling it "1 个文件" is what made the numbers
         disagree with the column of boxes — the panel said "新增的文件 7 个文件"
         about four files and three directories, and "共 10 个文件" about the ten
         boxes on screen, and staging those three directories would have reported
         "已暂存 3 个文件" for a whole subtree. So the two are counted apart, and
         the staged fraction counts **项** — the things the boxes actually are. */
      const kindOf = function (entries) {
        let files = 0
        let dirs = 0
        for (let i = 0; i < entries.length; i += 1) {
          if (text(entries[i].path).slice(-1) === '/') dirs += 1
          else files += 1
        }
        return { files: files, dirs: dirs }
      }
      const countText = function (kind) {
        if (kind.dirs === 0) return String(kind.files) + ' 个文件'
        if (kind.files === 0) return String(kind.dirs) + ' 个目录'
        return String(kind.files) + ' 个文件 + ' + String(kind.dirs) + ' 个目录'
      }

      /* One repository's corner of the tree: its own work snapshot, its own
         prefixed keys, and its own idea of which repository a tick or a diff
         belongs to. `scope.repo` empty is today's single-repository pane — every
         adapter below then forwards untouched, so the rows, their keys and their
         gestures are exactly what they were. */
      const makeScope = function (repo, one) {
        if (repo == null || repo.length === 0) {
          return {
            repo: '', prefix: '', work: one,
            selectedKey: props.selectedKey, collapsed: props.collapsed,
            onSelect: props.onSelect, onToggle: props.onToggle,
            onSetStaged: props.onSetStaged, onOpenDiff: props.onOpenDiff,
            untrackedOpen: props.untrackedOpen, untrackedFiles: props.untrackedFiles,
            onToggleUntracked: props.onToggleUntracked,
          }
        }
        const prefix = repo + '\u001f'
        /* 折叠表和未跟踪目录的展开表都按「仓库内的相对键」记：多仓库时剥出本仓库的
           那一片做成一份只读视图，写回去的回调再补上前缀 —— 单仓库的键不受影响，
           两个仓库里同名目录也各折各的。 */
        const localView = function (source) {
          const out = {}
          for (const key in source) {
            if (Object.prototype.hasOwnProperty.call(source, key) && key.indexOf(prefix) === 0) {
              out[key.slice(prefix.length)] = source[key]
            }
          }
          return out
        }
        return {
          repo: repo, prefix: prefix, work: one,
          selectedKey: localViewOne(props.selectedKey, prefix),
          collapsed: localView(props.collapsed),
          onSelect: function (key) { props.onSelect(prefix + key) },
          onToggle: function (path) { props.onToggle(prefix + path) },
          /* 勾选与差异都落回**文件自己的**仓库：多选视图里勾 repo-b 的文件得真的
             add 到 repo-b，而不是悄悄进了生效仓库的索引。 */
          onSetStaged: function (entries, staged) { props.onSetStagedAt(repo, entries, staged) },
          onOpenDiff: function (entry) { props.onOpenDiffAt(repo, entry) },
          untrackedOpen: localView(props.untrackedOpen),
          untrackedFiles: localView(props.untrackedFiles),
          onToggleUntracked: function (dir) { props.onToggleUntrackedAt(repo, dir) },
        }
      }

      const rowClass = function (scope, key, extra) {
        return 'dsh-git-trow' + (extra === undefined ? '' : ' ' + extra)
          + (scope.selectedKey === key ? ' dsh-git-trow-sel' : '')
      }

      /* One tracked change: box, status letter, name. In either view the click
         opens the patch (IDEA's commit window previews the selection too); the
         tree adds the indent the flat list does not have. */
      const fileRow = function (scope, entry, key, depth, flat, label) {
        return h('div', {
          className: rowClass(scope, key),
          key: key,
          title: text(entry.path) + '（点开看差异）',
          onClick: function () {
            scope.onSelect(key)
            if (typeof scope.onOpenDiff === 'function') scope.onOpenDiff(entry)
          },
        },
          stageBox('box', entry.staged === true ? 'all' : 'none',
            entry.staged === true ? '取消暂存' : '暂存',
            function () { scope.onSetStaged([entry], entry.staged !== true) }),
          indentPad(depth),
          h('span', { className: 'dsh-git-tw' }),
          h('span', { className: 'dsh-git-st' + statusClass(entry.displayCode) }, statusLabel(entry.displayCode)),
          nameCell(label, flat))
      }

      /* A directory git collapsed: one entry, no contents. Ticking it stages
         the whole thing (`git add -- dir` needs no listing); opening it is the
         one read that lists the files, and it happens on the click. The listing
         is a state of its own: undefined while the read is in flight — which is
         not a case the loop below may fall through to. */
      const untrackedDirRows = function (scope, entry, key, depth, flat, label) {
        const path = text(entry.path)
        const open = scope.untrackedOpen[path] === true
        const rows = [h('div', {
          className: rowClass(scope, key),
          key: key,
          title: path + '（未跟踪的目录，双击展开）',
          onClick: function () { scope.onSelect(key) },
          onDoubleClick: function () { scope.onToggleUntracked(path) },
        },
          stageBox('box', entry.staged === true ? 'all' : 'none',
            entry.staged === true ? '取消暂存' : '暂存整个目录',
            function () { scope.onSetStaged([entry], entry.staged !== true) }),
          indentPad(depth),
          twisty({ collapsed: !open, onToggle: function () { scope.onToggleUntracked(path) } }),
          h('span', { key: 'ico', className: 'dsh-git-tdir' }, h(Icon, { name: 'folder', size: 12 })),
          nameCell(label, flat))]
        if (open) {
          const list = scope.untrackedFiles[path]
          if (list === undefined) {
            rows.push(h('div', { key: key + ':wait', className: 'dsh-git-trow dsh-git-dim' },
              indentPad(depth + 1), h('span', { className: 'dsh-git-tname' }, '正在读取…')))
          } else if (list.length === 0) {
            rows.push(h('div', { key: key + ':none', className: 'dsh-git-trow dsh-git-dim' },
              indentPad(depth + 1), h('span', { className: 'dsh-git-tname' }, '（没有文件，可能都被 .gitignore 排除了）')))
          } else {
            const prefix = path.replace(/\/+$/, '') + '/'
            for (let k = 0; k < list.length; k += 1) {
              const inside = list[k]
              const relative = inside.indexOf(prefix) === 0 ? inside.slice(prefix.length) : inside
              const childKey = key + ':f:' + inside
              rows.push(h('div', {
                className: rowClass(scope, childKey),
                key: childKey,
                title: inside + '（点开看差异）',
                onClick: function () {
                  scope.onSelect(childKey)
                  scope.onOpenDiff({ path: inside, workCode: '??', untracked: true, staged: false, displayCode: '?' })
                },
              },
                stageBox('box', 'none', '暂存', function () { scope.onSetStaged([{ path: inside, untracked: true }], true) }),
                indentPad(depth + 1),
                h('span', { className: 'dsh-git-tw' }),
                h('span', { className: 'dsh-git-st dsh-git-st-U' }, '?'),
                /* The listing is flat, not a tree — a file two levels in is shown
                   as `deep/b.txt` however deep it really is — so the folder is
                   always the dimmed part, in both views. */
                nameCell(flat === true ? inside : relative, true)))
            }
          }
        }
        return rows
      }

      const treeRows = function (scope, entries, groupKey) {
        const treeEntries = []
        for (let i = 0; i < entries.length; i += 1) treeEntries.push({ segments: entries[i].path.split('/'), data: entries[i] })
        const tree = buildTree(treeEntries)
        annotateStaged(tree)
        const flat = flattenTree(tree, 0, groupKey, scope.collapsed, [], groupKey)
        const rows = []
        for (let i = 0; i < flat.length; i += 1) {
          const node = flat[i]
          if (node.kind === 'dir') {
            const child = node.data
            const total = child.total === undefined ? 0 : child.total
            const stagedCount = child.staged === undefined ? 0 : child.staged
            const allStaged = total > 0 && stagedCount === total
            const someStaged = stagedCount > 0 && stagedCount < total
            rows.push(h('div', {
              className: rowClass(scope, node.id),
              key: node.id,
              title: node.name + '（双击展开/折叠）',
              onClick: function () { scope.onSelect(node.id) },
              onDoubleClick: function () { scope.onToggle(node.path) },
            },
              stageBox('box', allStaged ? 'all' : (someStaged ? 'some' : 'none'),
                allStaged ? '取消暂存该目录' : '暂存该目录',
                function () { scope.onSetStaged(collectLeaves(child, []), !allStaged) }),
              indentPad(node.depth),
              twisty({ collapsed: node.collapsed, onToggle: function () { scope.onToggle(node.path) } }),
              h('span', { className: 'dsh-git-tname' }, node.name),
              h('span', { className: 'dsh-git-tdim' }, String(total) + ' 个文件')))
          } else if (node.dir === true) {
            rows.push.apply(rows, untrackedDirRows(scope, node.data || {}, node.id, node.depth, false, node.name))
          } else {
            rows.push(fileRow(scope, node.data || {}, node.id, node.depth, false, node.name))
          }
        }
        return rows
      }

      const flatRows = function (scope, entries, groupKey) {
        const sorted = entries.slice()
        sorted.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0) })
        const rows = []
        for (let i = 0; i < sorted.length; i += 1) {
          const entry = sorted[i]
          const key = groupKey + ':f:' + entry.path
          /* git only ever collapses a *directory* into a trailing slash, so that
             one character is the whole test for "this row can be opened". */
          if (entry.path.slice(-1) === '/') rows.push.apply(rows, untrackedDirRows(scope, entry, key, 0, true, entry.path))
          else rows.push(fileRow(scope, entry, key, 0, true, entry.path))
        }
        return rows
      }

      /* A group title is a row of the tree, so it obeys the tree's gesture:
         one click selects, the double click or the twisty folds. Its box is the
         group's own — IDEA's changelist node carries one too — and it sits in the
         same left gutter as every file row's, because it is the same act one
         level up: tick it and the whole changelist goes into the index, untick it
         and it comes back out. The untracked group's entries are by definition
         never staged, so its box only ever reads empty. */
      const groupTitle = function (scope, label, key, hint, entries) {
        let staged = 0
        for (let i = 0; i < entries.length; i += 1) if (entries[i].staged === true) staged += 1
        const allStaged = entries.length > 0 && staged === entries.length
        const someStaged = staged > 0 && staged < entries.length
        return h('div', {
          className: rowClass(scope, key + ':title', 'dsh-git-cgroup'),
          key: key + ':title',
          title: label + '（' + hint + '；双击展开/折叠）',
          onClick: function () { scope.onSelect(key + ':title') },
          onDoubleClick: function () { scope.onToggle(key) },
        },
          stageBox('box', allStaged ? 'all' : (someStaged ? 'some' : 'none'),
            allStaged ? '把这一组全部撤出索引' : '把这一组全部暂存',
            function () { scope.onSetStaged(entries, !allStaged) }),
          twisty({ collapsed: scope.collapsed[key] === true, onToggle: function () { scope.onToggle(key) } }),
          h('span', { className: 'dsh-git-tname' }, label),
          h('span', { className: 'dsh-git-tdim' }, countText(kindOf(entries))))
      }

      /* ── one repository's rows ──

         The order is a property of the paths, not of the index: `mergeChanges`
         orders entries by the list git answered in — the index entries first,
         then the worktree, then the untracked ones — so an entry's place in the
         list said which list it came from, and ticking its box moved it to the
         front of its own group. A tick must move the box and nothing else, so
         both groups are sorted by path first: two readers looking at the same
         paths see the same rows in the same places, whatever the index happens
         to say about them. */
      const scopeRows = function (repo, one) {
        const scope = makeScope(repo, one)
        if (one == null) {
          return [h('div', {
            key: 'wait:' + repo, className: 'dsh-git-trow dsh-git-dim', style: { paddingLeft: '18px' },
          }, '正在读取工作区…')]
        }
        if (one.ok !== true) {
          return [h('div', {
            key: 'bad:' + repo, className: 'dsh-git-trow dsh-git-dim', style: { paddingLeft: '18px' },
            title: text(one.repo),
          }, '无法读取这个仓库的变更')]
        }
        const changes = mergeChanges(one)
        const tracked = []
        const fresh = []
        for (let i = 0; i < changes.length; i += 1) {
          const entry = changes[i]
          if (entry.path.length === 0) continue
          if (isNewFile(entry)) fresh.push(entry)
          else tracked.push(entry)
        }
        const byPath = function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0) }
        tracked.sort(byPath)
        fresh.sort(byPath)

        const rows = []
        const scopedGroups = [
          { key: '@tracked', label: '默认变更列表', hint: 'git 管着的改动，框勾上就是进了索引', entries: tracked },
          { key: '@new', label: '新增的文件', hint: 'git 还没提交过的文件：勾上就是加入索引，但留在这一组里，直到提交', entries: fresh },
        ]
        let shown = 0
        for (let g = 0; g < scopedGroups.length; g += 1) {
          const group = scopedGroups[g]
          if (group.entries.length === 0) continue
          shown += 1
          rows.push(groupTitle(scope, group.label, group.key, group.hint, group.entries))
          if (scope.collapsed[group.key] === true) continue
          rows.push.apply(rows, view === 'flat' ? flatRows(scope, group.entries, group.key) : treeRows(scope, group.entries, group.key))
        }
        /* 多仓库视图里「干净」是某个仓库自己的事：组头底下给一行，而不是整页那句
           「工作区干净」（那句话只属于单仓库的现状）。 */
        if (shown === 0 && groups != null) {
          rows.push(h('div', {
            key: 'clean:' + repo, className: 'dsh-git-trow dsh-git-dim', style: { paddingLeft: '18px' },
          }, '工作区干净'))
        }
        return rows
      }

      const rows = []
      if (groups != null) {
        for (let g = 0; g < groups.length; g += 1) {
          const group = groups[g]
          const count = group.status != null && group.status.ok === true ? mergeChanges(group.status).length : 0
          rows.push(h('div', {
            key: 'rg:' + group.repo,
            className: 'dsh-git-rgroup',
            title: group.repo + '（单击 = 只看这个仓库）',
            onClick: function () { props.onRepoSingle(group.repo) },
          },
            h('span', { key: 'm', className: 'dsh-git-repo-mark' }, '▣'),
            h('span', { key: 'n', className: 'dsh-git-repo-name' }, repoBaseName(group.repo)),
            h('span', { key: 'c', className: 'dsh-git-repo-dim' }, count > 0 ? String(count) + ' 项' : '干净')))
          rows.push.apply(rows, scopeRows(group.repo, group.status))
        }
      } else {
        rows.push.apply(rows, scopeRows('', work))
      }

      const changes = mergeChanges(work)
      const stagedEntries = []
      for (let i = 0; i < changes.length; i += 1) if (changes[i].staged === true) stagedEntries.push(changes[i])
      const stagedCount = stagedEntries.length
      const totalChanges = changes.length
      const allKind = kindOf(changes)
      const canCommit = props.busy !== true && props.message.trim().length > 0 && totalChanges > 0
      /* The count and the button say 项 because that is what the boxes are; the
         breakdown of files against directories is in the tooltip and on the group
         titles, where each number belongs to the rows under it. */
      const kindsTitle = countText(allKind)
        + (allKind.dirs > 0 ? '；目录要展开才知道里面有多少文件' : '')
      const label = stagedCount > 0
        ? ('提交 ' + countText(kindOf(stagedEntries)))
        : ('全部暂存并提交（' + String(totalChanges) + ' 项）')

      /* 提交这一格永远只属于**生效仓库**（右侧历史、chip、推送用的那一个），多选只是
         变更树的显示方式 —— 把几个仓库的索引搅进同一次提交，等于把读者没看到的改动
         一起提交了。勾选框则各落各的仓库（见 makeScope 的 onSetStaged）。 */
      const side = h('div', { className: 'dsh-git-commitpane' },
        h('div', { className: 'dsh-git-group-title' }, '提交信息'),
        /* 先说出来，而不是等读者写完提交信息再被 git 拒一次。两条路都留着：设置页里
           能填的那个地方（面板里点得到），和在终端里跑的两条命令（面板不一定开着）。 */
        props.work.needsIdentity === true
          ? h('div', { key: 'ident', className: 'dsh-git-hint dsh-git-warn' },
            '这台机器还没配 git 提交身份，提交会被 git 拒绝。设置页「dsh-git-idea配置 → 提交身份」里能填，'
            + '或在终端里跑：git config --global user.name "你的名字"、git config --global user.email "你的邮箱"。')
          : null,
        clearable('msg', h('textarea', {
          className: 'dsh-git-input',
          rows: 6,
          placeholder: '提交信息（必填）',
          value: props.message,
          onChange: function (event) { props.onMessage(event.target.value) },
        }), props.message.length > 0, function () { props.onMessage('') }, 'dsh-git-clearable-area'),
        h('div', { key: 'k', className: 'dsh-git-dim', title: kindsTitle },
          '已暂存 ' + String(stagedCount) + ' / 共 ' + String(totalChanges) + ' 项'),
        h('button', {
          type: 'button',
          className: 'dsh-git-btn dsh-git-primary',
          disabled: !canCommit,
          onClick: props.onCommit,
        }, props.busy === true ? '处理中…' : label),
        totalChanges > 0 ? h('button', {
          type: 'button', className: 'dsh-git-btn',
          disabled: props.busy === true,
          onClick: props.onSetStagedAll,
        }, stagedCount > 0 ? '取消全部暂存' : '全部暂存') : null)

      /* 左侧那列仓库侧栏与分支树那份是同一个控件（RepoSwitcher），选择态各自独立 ——
         理由见 24-repos.js。 */
      return h('div', { className: 'dsh-git-changes' },
        props.repoProps == null ? null : h('div', { key: 'repos', className: 'dsh-git-reposide' },
          h(RepoSwitcher, props.repoProps)),
        h('div', { className: 'dsh-git-changes-tree' },
          h('div', { key: 'list', className: 'dsh-git-clist' }, rows.length > 0 ? rows : h('div', { className: 'dsh-git-pane dsh-git-ok' }, '工作区干净'))),
        side)
    }

    /* 多仓库 scope 的选中键也带前缀：剥出前缀之后的那个键，行里的比较才对得上。 */
    function localViewOne(key, prefix) {
      const raw = text(key)
      return raw.indexOf(prefix) === 0 ? raw.slice(prefix.length) : '\u0000'
    }
