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

       ── 冲突那组 ──

       合并、拣选、stash pop 留下的 unmerged 路径（porcelain v2 的 `u` 行，双码
       UU/AA/DU…）不进 staged/unstaged，mergeChanges 给它们打了 `conflict` 标。
       分桶先看这个标再看新增：冲突行的框语义和别组不同 —— 勾＝`git add` 标记
       **已解决**，不是普通的「进索引」—— 混进别的组，读者就会在错误的理解下勾框。
       没有冲突时这组整个不出现，树和从前一字不差。

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

    /* ── the one checkbox, drawn once ──

       列表行、目录行、组头、（55-diff.js 的）差异头部 —— 到处都是同一只框，所以它
       只能有一份构造：class（dsh-git-cbox，勾上再挂 dsh-git-cbox-on，部分勾选挂
       dsh-git-cbox-part）、字形（☑ / ▣ / ☐）、悬停话术与「点了不惊动行」的
       stopPropagation 都住在这里。谁再抄一份回去，两处框迟早长得不一样 —— 就像
       treeDirRow 当年被抄成两份一样。 */

    /* 挂在模块层而不是 ChangesPane 里的原因只有一个：55-diff.js 在本片段之后拼接、
       共享同一个作用域，差异头部的勾选框要用的正是这一份（段落的拼接顺序见
       build.mjs 的 TARGETS）。它只用 h 和自己的参数，不读任何组件状态。 */
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

    /* ── 窄屏判定：量容器自己，不量视口 ──

       面板是浮在页面上的可拖拽弹层，「手机窄屏」对它来说不是视口有多宽，而是
       折叠要管的那块地有多宽 —— 视口很宽、面板被拖到 500px 时提交栏（304px）和
       详情栏（280px）照样占掉大半；matchMedia 只认视口，量不到「面板被拖窄」
       这回事。所以判定用容器的 clientWidth：挂载后量（useLayoutEffect 在排版后、
       绘制前跑，不会先闪一帧宽屏），window resize 时复量 —— 面板跟着窗口变的最
       后一环仍落在这个容器上，一条监听就够。

       阈值 560px，两个折叠位共用一条线：
         变更页：提交栏固定 304px，树那侧还得装下「勾选框 14 + 状态字母 12 +
           缩进 + 一截名字」，560 = 304 + 256，再窄名字就只剩省略号；
         历史页：详情栏 280px，主列表至少还要留一列读得动的（80-panel.js 量
           .dsh-git-body 用的也是这里），560 = 280 + 280。
       两个推导落在同一个数上，一张表一个常量就够。

       量不到（clientWidth<=0：测试替身没有布局、真实页面还没排版的一瞬）一律按
       宽屏 —— 和 12-window.js 量不到高度就把窗口当「全部」是同一条底线：判定
       失效的代价绝不能是少渲染一块。宽屏渲染的就是现状 DOM，这条同时把不变量
       焊死了：判定瞎了，页面也和从前一字不差（测试按 dsh-git-commitpane 里的
       textarea 找输入框，替身环境正好落在这条宽屏分支上）。 */
    const CHANGES_NARROW_PX = 560
    /* 按 id 的测量槽表（12-window.js 的 scrollNodes 同款）：.dsh-git-changes 与
       .dsh-git-body 各挂一个 id，测量逻辑共用下面这一份。React 卸载时 ref 回调
       收到 null，槽位清掉、再量回宽屏 —— 和「量不到按宽屏」是同一条路。 */
    const narrowNodes = {}
    const measureNarrow = function (id, setNarrow) {
      const node = narrowNodes[id]
      /* clientWidth 本该是整数，parseInt 把「万一不是数」挡在比较门外（数值对比
         两边都过一次转换的规矩）；量不到按 0，0 走宽屏。 */
      const width = node != null && typeof node.clientWidth === 'number' ? parseInt(node.clientWidth, 10) : 0
      setNarrow(function () { return width > 0 && width < CHANGES_NARROW_PX })
    }
    /* 每个要判窄的容器一个 hook：attach 给 JSX 的 ref（useCallback 钉住身份，
       ref 回调不因重渲染被拆了再装 —— 12-window.js 同一条讲究），narrow 是量出
       来的事实。量本身无依赖、每次渲染后复一遍 —— 幂等，宽度没变时 setter 原值
       退回、不会循环；面板拖拽、展开/收起引起的重排都靠这一眼兜住。resize 监听
       只活到组件卸载：setNarrow 与 attach 身份稳定，依赖给 [] 挂一次就好，之后
       每次变化由上面那眼复量接手。测试替身没有 window，typeof 挡一下。 */
    function useNarrowWidth(id) {
      const [narrow, setNarrow] = React.useState(false)
      const attach = useCallback(function (node) { narrowNodes[id] = node }, [id])
      useLayoutEffect(function () {
        measureNarrow(id, setNarrow)
        return undefined
      })
      React.useEffect(function () {
        if (typeof window === 'undefined' || window === null || typeof window.addEventListener !== 'function') return undefined
        const onResize = function () { measureNarrow(id, setNarrow) }
        window.addEventListener('resize', onResize)
        return function () { window.removeEventListener('resize', onResize) }
      }, [])
      return { narrow: narrow, attach: attach }
    }

    function ChangesPane(props) {
      /* Read before the early returns: a hook cannot be skipped by a branch. */
      const settings = useGitSettings()
      /* ── 默认变更列表工具条的两段式确认 ──
         还原是破坏性操作，第一次点只把按钮换成「确认还原 n 项」（78-actions.js 里删除
         分支的 delArm 是同一个交互）。记的是「哪个仓库、勾了几项」这个键，而不是一个
         布尔：勾选数一变或换了仓库，armed 自动失效 —— 第二次点确认的永远是读者正看着
         的那一组，而不是点击之间被换掉的一组。同样必须在早退之前读（hook 的规矩）。 */
      const [revertArm, setRevertArm] = React.useState('')
      /* ── 折叠：事实与意愿，两个状态 ──
         narrow 是量出来的「事实」（useNarrowWidth('changes')：这块地窄不窄）；
         commitOpen 是读者的「意愿」—— null＝没动过手，折叠与否跟事实走（窄=折叠、
         宽=展开，量不到=宽屏即现状）；点过展开/收起之后意愿留下，之后 resize 只
         更新事实，不再替读者做主（「不强行改用户的展开态」）。会话内记忆，不进
         prefs：面板宽窄随手势变，记住一个旧判定反而是错。历史页详情栏那份同款
         在 80-panel.js（detailOpen），两只开关互不干扰。两个 hook 都在早退之前
         —— hook 不能被分支跳过的规矩。 */
      const narrowSlot = useNarrowWidth('changes')
      const narrow = narrowSlot.narrow
      const [commitOpen, setCommitOpen] = React.useState(null)
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
      /* stageBox 在模块层（见文件头），列表行、目录行、组头与差异头部共用这一份。 */

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
        /* 右键菜单的落仓：与 onOpenDiffAt 同一条规矩 —— 行长在哪个仓库的组里，
            动作就落在那个仓库上（多仓库分组的菜单动作带组自己的 repo）。 */
        const fileCtx = typeof props.onFileContextAt === 'function'
          ? function (target, event) { props.onFileContextAt(text(repo), target, event) }
          : null
        if (repo == null || repo.length === 0) {
          return {
            repo: '', prefix: '', work: one,
            selectedKey: props.selectedKey, collapsed: props.collapsed,
            onSelect: props.onSelect, onToggle: props.onToggle,
            onSetStaged: props.onSetStaged, onOpenDiff: props.onOpenDiff,
            onOpenConflict: props.onOpenConflict,
            onRevert: props.onRevert, onStash: props.onStash,
            untrackedOpen: props.untrackedOpen, untrackedFiles: props.untrackedFiles,
            onToggleUntracked: props.onToggleUntracked,
            onFileContext: fileCtx,
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
             add 到 repo-b，而不是悄悄进了生效仓库的索引。工具条的还原/暂存是同一件
             事 —— 按钮长在哪个仓库的组里，就动哪个仓库。 */
          onSetStaged: function (entries, staged) { props.onSetStagedAt(repo, entries, staged) },
          onOpenDiff: function (entry) { props.onOpenDiffAt(repo, entry) },
          /* 冲突行点击进三方合并界面：与 onOpenDiffAt 同一条「落回文件自己的仓库」
              的规矩 —— 多选视图里点 repo-b 的冲突，界面问的就是 repo-b 的三个版本。 */
          onOpenConflict: function (entry) { props.onOpenConflictAt(repo, entry) },
          onRevert: function (entries) { props.onRevertAt(repo, entries) },
          onStash: function (entries) { props.onStashAt(repo, entries) },
          untrackedOpen: localView(props.untrackedOpen),
          untrackedFiles: localView(props.untrackedFiles),
          onToggleUntracked: function (dir) { props.onToggleUntrackedAt(repo, dir) },
          onFileContext: fileCtx,
        }
      }

      const rowClass = function (scope, key, extra) {
        return 'dsh-git-trow' + (extra === undefined ? '' : ' ' + extra)
          + (scope.selectedKey === key ? ' dsh-git-trow-sel' : '')
      }

      /* 右键挂点（61-filemenu.js 的菜单）：worktree 语境没有 rev；这一行已知的
         标记（暂存/未跟踪/冲突）原样带进 target，菜单的启用矩阵全从这些读。
         scope.onFileContext 没接（旧宿主/测试替身）时行上不挂右键，与从前一字不差。 */
      const rowCtx = function (scope, path, extra) {
        if (scope.onFileContext == null) return undefined
        return function (event) {
          scope.onFileContext(fileMenuTarget('worktree', '', '', path, extra), event)
        }
      }

      /* One tracked change: box, status letter, name. In either view the click
         opens the patch (IDEA's commit window previews the selection too); the
         tree adds the indent the flat list does not have.

         未解决的冲突（打了 conflict 标的 unmerged 路径）不走 statusClass 的单字母：
         `UU` 在那里落进黄色 M 桶，和一次普通修改长得一样，读者看不出有活要干。
         这里改画红色加粗的完整双码（git 的 X/Y：UU/AA/DU…），勾选框的措辞也换成
         「标记已解决」—— `git add` 在冲突路径上的含义是「我解决完了」，不是普通
         的「进索引」，所以框的悬停话不能照抄。

         冲突行的点击也不进 diff（59-merge.js 的三方合并界面）：普通 diff 只有
         「现在长什么样」，冲突要的是「两边各改了什么、我留哪边」。分流点就在这
         一步——typeof 守卫与 onOpenDiff 同款，宿主没有新回调时不至于把点行点坏。 */
      const fileRow = function (scope, entry, key, depth, flat, label) {
        const conflict = entry.conflict === true
        return h('div', {
          className: rowClass(scope, key),
          key: key,
          title: conflict === true
            ? text(entry.path) + '（未解决的合并冲突：点击打开三方合并界面逐块解决；解决后勾选＝git add 标记已解决）'
            : text(entry.path) + '（点开看差异）',
          onClick: function () {
            scope.onSelect(key)
            if (conflict === true && typeof scope.onOpenConflict === 'function') {
              scope.onOpenConflict(entry)
              return
            }
            if (typeof scope.onOpenDiff === 'function') scope.onOpenDiff(entry)
          },
          onContextMenu: rowCtx(scope, text(entry.path), {
            untracked: entry.untracked === true, staged: entry.staged === true,
            conflict: conflict, from: '', raw: entry,
          }),
        },
          stageBox('box', entry.staged === true ? 'all' : 'none',
            entry.staged === true ? '取消暂存' : (conflict === true ? '标记已解决（git add）' : '暂存'),
            function () { scope.onSetStaged([entry], entry.staged !== true) }),
          indentPad(depth),
          h('span', { className: 'dsh-git-tw' }),
          conflict === true
            ? h('span', { className: 'dsh-git-st dsh-git-st-CF', title: '未解决的冲突（' + text(entry.workCode) + '）' }, text(entry.workCode))
            : h('span', { className: 'dsh-git-st' + statusClass(entry.displayCode) }, statusLabel(entry.displayCode)),
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
          onContextMenu: rowCtx(scope, path, { dir: true, untracked: true, raw: entry }),
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
                onContextMenu: rowCtx(scope, inside, {
                  untracked: true, staged: false, conflict: false,
                  raw: { path: inside, workCode: '??', untracked: true, staged: false, displayCode: '?' },
                }),
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
        /* 末位 false：文件树不压扁，每个目录段独立一行、独立缩进 —— 深层目录
           不许被合成一行（见 42-tree.js flattenTree）。 */
        const flat = flattenTree(tree, 0, groupKey, scope.collapsed, [], groupKey, false)
        const rows = []
        for (let i = 0; i < flat.length; i += 1) {
          const node = flat[i]
          if (node.kind === 'dir') {
            const child = node.data
            const total = child.total === undefined ? 0 : child.total
            const stagedCount = child.staged === undefined ? 0 : child.staged
            const allStaged = total > 0 && stagedCount === total
            const someStaged = stagedCount > 0 && stagedCount < total
            /* 目录行的 node.path 带着树自己的组前缀（'@tracked/a/b'）—— 折叠键认
               前缀，菜单的 pathspec 不认：剥出仓库里的真实相对路径再拼 target。 */
            const barePath = node.path.indexOf(groupKey + '/') === 0
              ? node.path.slice(groupKey.length + 1) : node.path
            rows.push(h('div', {
              className: rowClass(scope, node.id),
              key: node.id,
              title: node.name + '（双击展开/折叠）',
              onClick: function () { scope.onSelect(node.id) },
              onDoubleClick: function () { scope.onToggle(node.path) },
              onContextMenu: rowCtx(scope, barePath, { dir: true, untracked: false, raw: child }),
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
      const groupTitle = function (scope, label, key, hint, entries, tickTitle) {
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
            /* tickTitle：组自己那句话（冲突组说「标记已解决」），不给就用默认文案。 */
            allStaged ? '把这一组全部撤出索引' : (tickTitle == null ? '把这一组全部暂存' : tickTitle),
            function () { scope.onSetStaged(entries, !allStaged) }),
          twisty({ collapsed: scope.collapsed[key] === true, onToggle: function () { scope.onToggle(key) } }),
          h('span', { className: 'dsh-git-tname' }, label),
          h('span', { className: 'dsh-git-tdim' }, countText(kindOf(entries))))
      }

      /* ── 默认变更列表的工具条：添加 / 还原 / 暂存，都对着勾选项 ──

         勾选==已暂存（见上面 fileRow 的框），所以三个按钮的对象就是组里
         staged===true 的那些条目，一个都没勾时禁用并说明。只加在 @tracked 这一组：
         用户要的是「默认变更列表」的工具条，而「新增的文件」那组的语义不同 —— HEAD
         里还没有那些路径，还原和暂存对它们都说不通。它是组的内容而不是标题的一部分，
         组一折叠就跟着文件行一起藏起来。

         「添加」走 onSetStaged：和勾一个框完全是同一条路（乐观补丁 + 路径确认读），
         幂等，重复点没有副作用。「还原」是破坏性的，两段式确认 —— arm 键的构成见
         ChangesPane 开头那个 useState 的注释。「暂存」收进 stash，非破坏，单击即可。 */
      const trackedTools = function (scope, entries) {
        const picked = []
        for (let i = 0; i < entries.length; i += 1) if (entries[i].staged === true) picked.push(entries[i])
        const count = picked.length
        const idle = props.busy === true
        const whyNone = '先勾选这一组里的文件（勾上就是已暂存），这三个按钮都对勾选项做事'
        const armKey = (scope.repo.length > 0 ? scope.repo + '\u001f' : '') + '@revert:' + String(count)
        const armed = revertArm === armKey
        return h('div', { key: '@tracked:tools', className: 'dsh-git-ctools' },
          h('button', {
            key: 'add', type: 'button', className: 'dsh-git-ctool',
            disabled: count === 0 || idle,
            title: count === 0 ? whyNone
              : 'git add 勾选的 ' + String(count) + ' 项（勾选即已暂存，重复执行没有副作用）',
            onClick: function (event) {
              stopEvent(event)
              if (count === 0 || idle) return
              scope.onSetStaged(picked, true)
            },
          }, '添加'),
          h('button', {
            key: 'revert', type: 'button',
            className: 'dsh-git-ctool' + (armed ? ' dsh-git-ctool-danger' : ''),
            disabled: count === 0 || idle,
            title: count === 0 ? whyNone
              : (armed
                ? '再点一次执行：' + String(count) + ' 项的索引和工作区一起回到 HEAD —— 改动将丢弃，不可撤销'
                : '丢弃勾选的 ' + String(count) + ' 项改动：git restore --source=HEAD --staged --worktree（索引+工作区回 HEAD，被删的文件也恢复；破坏性，需再点一次确认）'),
            onClick: function (event) {
              stopEvent(event)
              if (count === 0 || idle) return
              /* 第一次点只武装；第二次点才动手，动完把武装清掉（成没成都清 —— 失败的
                 重试也要从第一步重新来）。 */
              if (armed !== true) { setRevertArm(armKey); return }
              setRevertArm('')
              scope.onRevert(picked)
            },
          }, armed ? '确认还原 ' + String(count) + ' 项' : '还原'),
          h('button', {
            key: 'stash', type: 'button', className: 'dsh-git-ctool',
            disabled: count === 0 || idle,
            title: count === 0 ? whyNone
              : 'git stash push 收起勾选的 ' + String(count) + ' 项（非破坏：git stash pop 可找回）',
            onClick: function (event) {
              stopEvent(event)
              if (count === 0 || idle) return
              scope.onStash(picked)
            },
          }, '暂存'),
          h('span', { key: 'n', className: 'dsh-git-tdim' }, '已勾选 ' + String(count) + ' 项'))
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
        /* 冲突桶在最前：先判 conflict 再判 isNewFile —— 冲突行的框是「标记已解决」，
           和新增/修改的「进索引」不是一个动作，绝不能让一条冲突被别的关系领走。 */
        const conflicted = []
        const tracked = []
        const fresh = []
        for (let i = 0; i < changes.length; i += 1) {
          const entry = changes[i]
          if (entry.path.length === 0) continue
          if (entry.conflict === true) conflicted.push(entry)
          else if (isNewFile(entry)) fresh.push(entry)
          else tracked.push(entry)
        }
        const byPath = function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0) }
        conflicted.sort(byPath)
        tracked.sort(byPath)
        fresh.sort(byPath)

        const rows = []
        /* 冲突组排第一（要处理的活顶在最上面），entries 为空时下面的循环直接跳过，
           所以没有冲突时这组不存在，列表和从前一字不差。 */
        const scopedGroups = [
          { key: '@conflict', label: '冲突', hint: '合并/拣选/stash pop 留下的未解决冲突，勾上＝git add 标记已解决', tickTitle: '把这一组全部标记已解决（git add）', entries: conflicted },
          { key: '@tracked', label: '默认变更列表', hint: 'git 管着的改动，框勾上就是进了索引', entries: tracked },
          { key: '@new', label: '新增的文件', hint: 'git 还没提交过的文件：勾上就是加入索引，但留在这一组里，直到提交', entries: fresh },
        ]
        let shown = 0
        for (let g = 0; g < scopedGroups.length; g += 1) {
          const group = scopedGroups[g]
          if (group.entries.length === 0) continue
          shown += 1
          rows.push(groupTitle(scope, group.label, group.key, group.hint, group.entries, group.tickTitle))
          if (scope.collapsed[group.key] === true) continue
          if (group.key === '@conflict') {
            /* 组头之下一行灰字指引，不占别的组：冲突文件该干什么（找标记、勾选的
               含义）第一次见的人未必知道。键带 repo —— 多仓库时每组各来一行，别撞。 */
            rows.push(h('div', {
              key: 'guide:' + repo, className: 'dsh-git-trow dsh-git-dim', style: { paddingLeft: '18px' },
            }, '点击冲突文件打开三方合并界面（比对三个版本、逐块解决）；解决后勾选暂存＝git add 标记已解决'))
          }
          /* 工具条只属于默认变更列表那一组（理由见 trackedTools 的注释），且跟着组的
             展开走：折叠时它和文件行一起收起，组头还留着。 */
          if (group.key === '@tracked') rows.push(trackedTools(scope, group.entries))
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
        /* 同名仓库的短名（24-repos.js）：分组头和切换器行、分支树那边的分组头取
           同一份 memo —— 面板里一个仓库只有一个短名。 */
        const repoLabels = props.repoProps == null ? null
          : repoLabelMap(reposShown(props.repoProps.list, props.repoProps.effective))
        for (let g = 0; g < groups.length; g += 1) {
          const group = groups[g]
          const count = group.status != null && group.status.ok === true ? mergeChanges(group.status).length : 0
          rows.push(h('div', {
            key: 'rg:' + group.repo,
            className: 'dsh-git-rgroup',
            title: group.repo + '（单击 = 只看这个仓库）',
            onClick: function () { props.onRepoSingle(group.repo) },
          },
            h('span', { key: 'g', className: 'dsh-git-repo-glyph' }, h(Icon, { name: 'repo', size: 11 })),
            h('span', { key: 'n', className: 'dsh-git-repo-name' },
              repoLabels == null ? repoBaseName(group.repo) : repoShortName(repoLabels, group.repo)),
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
      /* 冲突数和上面同源（同一份 mergeChanges(work)）：side 永远属于生效仓库，多选
         视图里别的仓库不进这个数 —— 提交按钮提交的是生效仓库的索引，警告也只说
         它的冲突（防的正是「直接提交被 git 拒」那一次白点）。 */
      let conflictCount = 0
      for (let i = 0; i < changes.length; i += 1) if (changes[i].conflict === true) conflictCount += 1
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
         一起提交了。勾选框则各落各的仓库（见 makeScope 的 onSetStaged）。

         ── 折叠的两种形态（第二轮起不再分宽窄）──
         stacked：整页切纵列（树在上、提交在下），dsh-git-changes-narrow 只在这一态挂。
         折叠与否：没动过手（commitOpen===null）时跟 narrow 走，动过手以后听读者的
         —— 宽窄只决定「默认哪边」，不决定读者改过的意愿。折叠后的展开条无论宽窄
         都会出现：窄屏是树底下一横条，宽屏是右缘一竖条（46-css.js 的 :not 变体）。 */
      const stacked = narrow === true
      const commitCollapsed = commitOpen === null ? narrow : commitOpen === false
      /* 折叠态的那一条：点一下把提交栏还回来。已暂存计数只在有活时出现（「已暂存
         0」是噪音）；写了草稿就亮一枚 ● —— 栏收起来了，「这里有没写完的话」这件事
         不能跟着收走。元素两种宽窄共用一份（类名、子节点一样），横竖两个长相由
         CSS 的容器选择器分管。 */
      const commitBar = h('div', {
        key: 'commitbar',
        className: 'dsh-git-commitbar',
        title: '展开提交栏（提交信息与提交按钮收在这里）',
        onClick: function () { setCommitOpen(true) },
      },
        h('span', { key: 'l', className: 'dsh-git-commitbar-label' }, '提交信息'),
        h('span', { key: 'g', className: 'dsh-git-commitbar-glyph' }, '▸'),
        props.message.length > 0
          ? h('span', { key: 'd', className: 'dsh-git-commitbar-dirty', title: '提交信息已写，还没提交' }, '●')
          : null,
        stagedCount > 0
          ? h('span', { key: 'c', className: 'dsh-git-commitbar-count' }, '已暂存 ' + String(stagedCount) + ' 项')
          : null)
      /* 提交栏本体：栏头是可点的「▾ 提交信息」收起键，无论宽窄（第二轮起常驻 ——
         宽屏此前没有任何收起入口）。▾ = 点我收起；收起后从「提交信息」展开条再
         展开，和折叠条是同一只开关（commitOpen）的两副面孔。警告条、输入框、已
         暂存计数与按钮所有宽度完全共用 —— 测试按这里面的 textarea 找输入框，
         替身环境的宽屏分支不能有第二套结构。 */
      const side = h('div', { className: 'dsh-git-commitpane' },
        h('div', {
          className: 'dsh-git-group-title dsh-git-commitpane-fold',
          title: '收起提交栏（收起后从「提交信息」展开条再展开）',
          onClick: function () { setCommitOpen(false) },
        }, '▾ 提交信息'),
        /* 先说出来，而不是等读者写完提交信息再被 git 拒一次。两条路都留着：面板
           「配置」页里能填的那个地方，和在终端里跑的两条命令（面板不一定开着）。 */
        props.work.needsIdentity === true
          ? h('div', { key: 'ident', className: 'dsh-git-hint dsh-git-warn' },
            '这台机器还没配 git 提交身份，提交会被 git 拒绝。面板「配置 → 全局配置 → 提交身份」里能填，'
            + '或在终端里跑：git config --global user.name "你的名字"、git config --global user.email "你的邮箱"。')
          : null,
        /* 同一件事也说在提交前：带未解决冲突的索引 `git commit` 会直接拒（「cannot
           commit a merge」/ unmerged files），让读者先看见路，而不是先撞一次墙。 */
        conflictCount > 0
          ? h('div', { key: 'conflict', className: 'dsh-git-hint dsh-git-warn' },
            '有 ' + String(conflictCount) + ' 个冲突未解决，直接提交会被 git 拒绝；在变更页编辑文件解决 '
            + '<<<<<<< ======= >>>>>>> 标记后，勾选暂存（标记已解决）再提交。')
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
         理由见 24-repos.js。ref 挂在容器上（useNarrowWidth('changes') 量的就是它）；
         ref 不是 DOM 属性，不出现在渲染结果里 —— 窄屏类只挂在量出窄的那一态。 */
      return h('div', {
        className: 'dsh-git-changes' + (stacked === true ? ' dsh-git-changes-narrow' : ''),
        ref: narrowSlot.attach,
      },
        props.repoProps == null ? null : h('div', { key: 'repos', className: 'dsh-git-reposide' },
          h(RepoSwitcher, props.repoProps)),
        h('div', { className: 'dsh-git-changes-tree' },
          h('div', { key: 'list', className: 'dsh-git-clist' }, rows.length > 0 ? rows : h('div', { className: 'dsh-git-pane dsh-git-ok' }, '工作区干净'))),
        commitCollapsed === true ? commitBar : side)
    }

    /* 多仓库 scope 的选中键也带前缀：剥出前缀之后的那个键，行里的比较才对得上。 */
    function localViewOne(key, prefix) {
      const raw = text(key)
      return raw.indexOf(prefix) === 0 ? raw.slice(prefix.length) : '\u0000'
    }
