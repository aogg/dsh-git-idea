    function CommitDetail(props) {
      const detail = props.detail
      /* IDEA's empty right pane: the hint in the middle, and the state of the
         selection along the bottom. */
      if (detail == null) {
        return h('div', { className: 'dsh-git-detail dsh-git-detail-empty' },
          h('div', { key: 'w', className: 'dsh-git-dim' }, '选择一个提交'),
          h('div', { key: 'f', className: 'dsh-git-detail-foot dsh-git-dim' }, '未选择提交'))
      }
      if (detail.ok !== true) return h('div', { className: 'dsh-git-detail dsh-git-error' }, '无法读取提交详情')

      const entries = []
      for (let i = 0; i < detail.files.length; i += 1) {
        const path = text(detail.files[i].path)
        if (path.length === 0) continue
        entries.push({ segments: path.split('/'), data: detail.files[i] })
      }
      const tree = buildTree(entries)
      /* 末位 false：文件树不压扁，每个目录段独立一行（见 42-tree.js flattenTree）。 */
      const flat = flattenTree(tree, 0, '@files', props.collapsed, [], '@files', false)
      const fileRows = []
      for (let i = 0; i < flat.length; i += 1) {
        const node = flat[i]
        if (node.kind === 'dir') {
          fileRows.push(treeDirRow(node, props, String(node.count) + ' 个文件'))
        } else {
          const file = node.data || {}
          fileRows.push(h('div', {
            className: 'dsh-git-trow' + (props.selectedKey === node.id ? ' dsh-git-trow-sel' : ''),
            key: node.id,
            style: { paddingLeft: (6 + node.depth * 12) + 'px' },
            title: text(file.path) + '（点开看差异）',
            onClick: function () {
              props.onSelect(node.id)
              if (typeof props.onOpenDiff === 'function') props.onOpenDiff(file)
            },
          },
            h('span', { className: 'dsh-git-tw' }),
            h('span', { className: 'dsh-git-st' + statusClass(file.status) }, statusLabel(file.status)),
            h('span', { className: 'dsh-git-tname' }, node.name)))
        }
      }

      const inBranches = detail.branches.length > 0 ? detail.branches.join('、') : '（没有分支引用此提交）'
      const fullMessage = (detail.subject + (detail.body.length > 0 ? '\n\n' + detail.body : '')).replace(/\n+$/, '')

      return h('div', { className: 'dsh-git-detail' },
        h('div', { className: 'dsh-git-group-title' }, String(detail.files.length) + ' 个文件'),
        fileRows,
        h('div', { className: 'dsh-git-info' },
          h('div', { className: 'dsh-git-hash' }, detail.hash),
          h('div', { className: 'dsh-git-dim' }, detail.author + ' <' + detail.email + '>'),
          h('div', { className: 'dsh-git-dim' }, detail.date.replace('T', ' ').slice(0, 16)),
          h('div', { className: 'dsh-git-dim' }, '所在分支：' + inBranches),
          h('div', { className: 'dsh-git-msg' }, fullMessage)))
    }

    /* ── one path, two shapes ──

       git's untracked list reaches this half as objects (`{path, code}`) most of
       the time — that is what the Host builds — but a bare string is still a
       legal entry, and `mergeChanges` has always accepted both. The two helpers
       that walk those lists did not: they read `entry.path` straight off, which
       is `undefined` on a string, so a pathspec answer could never drop a string
       entry from the snapshot on screen. The row stayed there *beside* the staged
       file it had just become (measured: ticking an untracked directory left its
       collapsed row in 未跟踪的文件 while its files sat staged in the changelist,
       and the count said 6 files when the boxes said 5), and `pathsOfInterest`
       silently answered "nothing to ask about" for a tree of nothing but
       untracked paths, which turned the cheap pathspec read back into a whole-tree
       `git status`. One reader, so the shapes cannot drift apart again. */
    function entryPath(entry) {
      if (typeof entry === 'string') return entry
      return entry == null ? '' : text(entry.path)
    }

    /* ── the tick, before git has answered ──

       Staging one path is a tenth of a second of git (`git add`: 98–236ms on the
       reader's repository) followed by a whole `git status` before the box moved
       (7.4s there). Clicking a box and watching nothing happen for seven seconds
       is the same experience as clicking a box that does nothing. So the tree is
       repainted from the click itself, with the lists git is about to report, and
       the read that follows only confirms it — 0.5s, because it asks about these
       paths.

       It is a prediction, not a fiction: it is built from what the row already
       says (whether the path was staged, what its index and worktree codes were),
       and a failed command puts the previous snapshot back. */
    function stageLocally(status, files, staged) {
      if (status == null || status.ok !== true || files.length === 0) return null
      const list = function (value) { return Array.isArray(value) ? value.slice() : [] }
      const next = {
        ok: true, repo: status.repo, branch: status.branch, detached: status.detached,
        upstream: status.upstream, ahead: status.ahead, behind: status.behind,
        sequencer: status.sequencer,
        staged: list(status.staged), unstaged: list(status.unstaged),
        untracked: list(status.untracked), unmerged: list(status.unmerged),
      }
      const drop = function (entries, path) {
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const other = entryPath(entries[i])
          /* A directory git collapsed answers for everything under it too. */
          if (other === path || (path.slice(-1) === '/' && other.indexOf(path) === 0)) entries.splice(i, 1)
        }
      }
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i]
        const path = text(file.path)
        if (path.length === 0) continue
        drop(next.staged, path)
        drop(next.unstaged, path)
        drop(next.untracked, path)
        drop(next.unmerged, path)
        const indexCode = text(file.indexCode)
        const workCode = text(file.workCode)
        if (staged === true) {
          /* A path the index has never seen is an addition, whatever it looked
             like before; anything else keeps the index code it had. The addition
             is spelled the way the read behind this prediction will spell it —
             the porcelain pair `A.` — because the prediction and its confirmation
             disagreeing is itself a visible thing: `diffSig` moves on the index
             code, so a patch on screen is re-read for a difference that is not a
             difference. */
          const added = file.untracked === true || addedInIndex(indexCode)
          next.staged.push({ path: path, code: added ? 'A.' : (indexCode.length > 0 ? indexCode : 'M.') })
        } else if (addedInIndex(indexCode) || file.untracked === true) {
          /* Unstaging an addition does not make it modified: HEAD has no such
             path, so it goes back to being untracked. This branch takes the first
             letter of the index code — see addedInIndex: a bare `A` is not one of
             the shapes git prints, and the whole-string test that was here sent
             every untick of a new file into the changelist for a frame. */
          next.untracked.push({ path: path, code: '??' })
        } else {
          next.unstaged.push({ path: path, code: workCode.length > 0 ? workCode : (indexCode.length > 0 ? indexCode : 'M.') })
        }
      }
      return next
    }

    /* ── folding a pathspec answer into the snapshot on screen ──

       A partial read covers the paths it was asked about and nothing else, so it
       replaces exactly those entries and leaves the rest of the tree alone: the
       lists stay the whole working tree's, and the counts on the tab keep meaning
       what they meant. The paths it names are the ones it answered for — including
       paths under an asked directory, which is how a staged untracked directory
       turns into the file rows inside it. */
    function mergePanelStatus(current, partial) {
      if (partial == null || partial.ok !== true) return current
      if (partial.partial !== true) return partial
      if (current == null || current.ok !== true) return current
      const asked = Array.isArray(partial.paths) ? partial.paths : []
      if (asked.length === 0) return current
      const covered = function (path) {
        for (let i = 0; i < asked.length; i += 1) {
          const one = text(asked[i])
          if (one.length === 0) continue
          if (path === one) return true
          if (one.slice(-1) === '/' && path.indexOf(one) === 0) return true
          if (path.indexOf(one + '/') === 0) return true
        }
        return false
      }
      const keep = function (value) {
        const entries = Array.isArray(value) ? value : []
        const out = []
        for (let i = 0; i < entries.length; i += 1) if (!covered(entryPath(entries[i]))) out.push(entries[i])
        return out
      }
      const list = function (value) { return Array.isArray(value) ? value : [] }
      return {
        ok: true, repo: partial.repo, branch: partial.branch, detached: partial.detached,
        upstream: partial.upstream, ahead: partial.ahead, behind: partial.behind,
        sequencer: partial.sequencer,
        /* 和 branch、upstream 一样来自这一次读：身份缺不缺是机器上的事实，不随路径
           部分读而改变，但也不能因为一次合并就把它丢掉（丢掉的后果是提交区那个提示
           闪一下又没了）。 */
        needsIdentity: partial.needsIdentity === true,
        staged: keep(current.staged).concat(list(partial.staged)),
        unstaged: keep(current.unstaged).concat(list(partial.unstaged)),
        untracked: keep(current.untracked).concat(list(partial.untracked)),
        unmerged: keep(current.unmerged).concat(list(partial.unmerged)),
      }
    }

    /* ── what a cheap read of the working tree is about ──

       The paths this snapshot is showing, plus the directory each one lives in:
       a new file beside a changed one is then noticed by the same read. The
       repository root is deliberately not one of them — naming it would ask for
       the whole tree again, which is the cost this is here to avoid. */
    const PATHS_MAX = 200

    /* ── 父目录那一层有多贵 ──

       「改动文件旁边新出现的文件」确实要问它所在的目录才看得见，可是**目录条目
       （`.../`，git 把没跟踪的目录折叠成一条）本身就是自己的子树**：再带上它的上一层
       就是把旁边整棵大树扫一遍。读者那个仓库上量到的是：

         7 条原始路径（其中 3 条是折叠目录）        280ms
         12 条（每条再带上父目录）                6138ms   ← `holox-modules` 一条吃掉了全部
         9 条（目录条目不带父目录）                 295ms

       所以目录条目不带上父目录；文件的父目录留着（文件旁边新出现的文件还是由它看见）。
       另外量到一次路径读本身就很贵（`PATHS_READ_MAX_MS`，见 10-state.js）时，这个仓库
       整个收窄成只问那几条路径本身 —— 那种仓库上新文件就交给整棵树的时钟。 */
    function pathsOfInterest(status, repo) {
      if (status == null || status.ok !== true) return []
      const wide = repo === undefined || repo === null || repo.length === 0 ? true : treeWide(repo) === true
      const seen = {}
      const out = []
      const add = function (path) {
        if (path.length === 0 || seen[path] === true || out.length >= PATHS_MAX) return
        seen[path] = true
        out.push(path)
      }
      const lists = [status.staged, status.unstaged, status.untracked, status.unmerged]
      for (let i = 0; i < lists.length; i += 1) {
        const entries = Array.isArray(lists[i]) ? lists[i] : []
        for (let k = 0; k < entries.length; k += 1) {
          const path = entryPath(entries[k])
          if (path.length === 0) continue
          const collapsed = path.slice(-1) === '/'
          const bare = collapsed ? path.slice(0, -1) : path
          add(bare)
          if (collapsed === true || wide !== true) continue
          const cut = bare.lastIndexOf('/')
          if (cut > 0) add(bare.slice(0, cut))
        }
      }
      out.sort()
      return out
    }

    function mergeChanges(work) {
      const byPath = {}
      const order = []
      const put = function (path, patch) {
        if (path.length === 0) return null
        if (byPath[path] === undefined) {
          byPath[path] = { path: path, staged: false, indexCode: '', workCode: '', conflict: false }
          order.push(path)
        }
        Object.assign(byPath[path], patch)
        return byPath[path]
      }
      const list = function (value) { return Array.isArray(value) ? value : [] }
      /* 四条列表都走 `entryPath`：git 那边这三种形状都可能出现（对象最常，裸字符串也
         合法），读 `entry.path` 会把裸字符串那一条**整条丢掉** —— 列表里少一行，而
         「有几个改动」那个数字（mergeChanges 的长度）也跟着少一个。 */
      const staged = list(work.staged)
      for (let i = 0; i < staged.length; i += 1) put(entryPath(staged[i]), { staged: true, indexCode: text(staged[i].code) })
      const unstaged = list(work.unstaged)
      for (let i = 0; i < unstaged.length; i += 1) put(entryPath(unstaged[i]), { workCode: text(unstaged[i].code) })
      const untracked = list(work.untracked)
      for (let i = 0; i < untracked.length; i += 1) put(entryPath(untracked[i]), { workCode: '??', untracked: true })
      const unmerged = list(work.unmerged)
      for (let i = 0; i < unmerged.length; i += 1) put(entryPath(unmerged[i]), { workCode: text(unmerged[i].code), conflict: true })
      const out = []
      for (let i = 0; i < order.length; i += 1) {
        const entry = byPath[order[i]]
        entry.displayCode = entry.staged ? text(entry.indexCode) : text(entry.workCode)
        out.push(entry)
      }
      return out
    }

