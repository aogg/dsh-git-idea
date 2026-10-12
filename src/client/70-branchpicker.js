    /* One branch row. Its own component so that a hover, a keystroke in the
       filter or a new keyboard highlight repaints the rows whose state actually
       changed instead of the whole list. */
    function BranchRow(props) {
      const row = props.row
      const name = text(row.name)
      const isCurrent = props.current === true
      const ahead = typeof row.ahead === 'number' ? row.ahead : 0
      const behind = typeof row.behind === 'number' ? row.behind : 0
      const upstream = text(row.upstream)
      const where = text(props.where)
      const when = branchRelative(row.committedAt)
      const tip = []
      if (text(row.subject).length > 0) tip.push(text(row.subject))
      if (when.length > 0) tip.push(when)
      tip.push(trackTitle(ahead, behind))
      return h('div', {
        className: 'dsh-git-bs-row' + (props.active === true ? ' dsh-git-bs-row-on' : '') + (isCurrent ? ' dsh-git-bs-row-cur' : '')
          + (props.busy === true ? ' dsh-git-bs-busy' : '') + (props.flying === true ? ' dsh-git-bs-row-fly' : ''),
        title: tip.join('\n'),
        onMouseEnter: function (event) { props.onEnter(props.rowKey, props.at, event) },
        onMouseLeave: function () { props.onLeave() },
        onClick: function (event) { props.onPick(name, isCurrent, props.rowKey, event) },
      },
        /* 行首那一列和面板左栏表达同一件事、用的是同一个记号：当前分支是 ★
           （文本，面板的 HEAD 行就是这个），其余留空。每一行的分支图标都一
           个样，不再有「只有当前分支换个铅笔」那种例外。 */
        h('span', { key: 'c', className: 'dsh-git-bs-cur', title: isCurrent ? '当前分支' : '' }, isCurrent ? '★' : ''),
        h('span', { key: 'i', className: 'dsh-git-bs-ico' }, h(BranchIcon, { size: 13 })),
        h('span', { key: 'n', className: 'dsh-git-bs-name' }, name),
        behind > 0 ? h('span', { key: 'b', className: 'dsh-git-bs-ab dsh-git-ab-in', title: '落后上游 ' + String(behind) + ' 个提交 —— 需要拉取' }, '↓' + (behind > 99 ? '99+' : String(behind))) : null,
        ahead > 0 ? h('span', { key: 'a', className: 'dsh-git-bs-ab dsh-git-ab-out', title: '领先上游 ' + String(ahead) + ' 个提交 —— 需要推送' }, '↑' + (ahead > 99 ? '99+' : String(ahead))) : null,
        upstream.length > 0 ? h('span', { key: 'u', className: 'dsh-git-bs-up' }, upstream)
          : (where.length > 0 ? h('span', { key: 'u', className: 'dsh-git-bs-up' }, where) : null),
        /* 行尾只剩下「这个分支能做的事」。收藏挪到了上面那排动作里（一行一个
           星，浅底上几乎看不见；而且它和行首表示「当前分支」的 ★ 是两个意思，
           挤在同一行里更容易读错）。 */
        h('button', {
          key: 'm', type: 'button', className: 'dsh-git-bs-more',
          title: '这个分支能做的事（鼠标停留即展开，点击可以钉住）',
          onClick: function (event) { props.onMenu(props.rowKey, event) },
        }, h(Icon, { name: 'right', size: 14 })))
    }
    const BranchRowMemo = memo(BranchRow)

    /* ── pull 时为当前分支挑「同名远端分支」──

       git/refs 的答复里 remote 是按远端分组的表（{name, refs:[{segments,data}]}，
       segments 是去掉远端名后的路径段）。多个远端都有同名时 origin 优先，没有
       origin 取字母序第一个 —— 面板覆盖层与分支卡两条 pull 入口共用这一条规则。
       命中返回 {remote, branch}，没有返回 null。 */
    function upstreamMatchInRefs(refs, current) {
      if (refs == null || refs.ok !== true || !Array.isArray(refs.remote)) return null
      if (typeof current !== 'string' || current.length === 0) return null
      let fallback = null
      for (let i = 0; i < refs.remote.length; i += 1) {
        const group = refs.remote[i]
        if (group == null || typeof group.name !== 'string' || !Array.isArray(group.refs)) continue
        for (let k = 0; k < group.refs.length; k += 1) {
          const row = group.refs[k]
          if (row == null || !Array.isArray(row.segments) || row.segments.length === 0) continue
          /* 整段同名才算：origin/feature/x 的 segments 是 ['feature','x']，与本地
             feature/x 对得上；origin/x 遇上本地 feature/x 不算（绑定一个读者没
             指名的分支比不绑更糟）。 */
          if (row.segments.join('/') !== current) continue
          if (group.name === 'origin') return { remote: group.name, branch: current }
          if (fallback === null || group.name < fallback.remote) fallback = { remote: group.name, branch: current }
        }
      }
      return fallback
    }

    /* ── 远端分支选择列表（pull 绑定上游的第二步）──

       两处用它：面板的覆盖层（80-panel.js）与分支卡内嵌。数据现读 git/refs ——
       「选择」这件事要的是现在的远端表，触发它的那件事（pull 说没有 upstream）
       往往正说明手头那份数据是旧的。按远端分组、可搜索，画法就是分支卡那套
       （dsh-git-bs-*）；点行 = 选中（onPick 收 {remote, branch}），Esc 退出。
       busy 时行点不动；读失败把原话说在列表里。 */
    function RemotePickList(props) {
      const [data, setData] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [error, setError] = React.useState(null)
      const [index, setIndex] = React.useState(0)
      React.useEffect(function () {
        let alive = true
        const request = { sessionId: props.sessionId }
        if (props.repo != null && props.repo.length > 0) request.repo = props.repo
        rpc('git/refs', request, '读不到远端分支').then(function (result) {
          if (alive !== true) return
          setData(result)
          setIndex(0)
        }, function (failure) {
          if (alive !== true) return
          setError(failureText(failure))
        })
        return function () { alive = false }
      }, [props.repo, props.sessionId])
      const needle = query.trim().toLowerCase()
      const groups = []
      if (data != null && data.ok === true && Array.isArray(data.remote)) {
        for (let i = 0; i < data.remote.length; i += 1) {
          const group = data.remote[i]
          if (group == null || typeof group.name !== 'string' || !Array.isArray(group.refs)) continue
          const rows = []
          for (let k = 0; k < group.refs.length; k += 1) {
            const row = group.refs[k]
            if (row == null || !Array.isArray(row.segments) || row.segments.length === 0) continue
            const branch = row.segments.join('/')
            if (needle.length > 0 && (group.name + '/' + branch).toLowerCase().indexOf(needle) < 0) continue
            rows.push({ remote: group.name, branch: branch })
          }
          if (rows.length > 0) groups.push({ name: group.name, rows: rows })
        }
      }
      const flat = []
      for (let g = 0; g < groups.length; g += 1) {
        for (let r = 0; r < groups[g].rows.length; r += 1) flat.push(groups[g].rows[r])
      }
      const onKey = function (event) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setIndex(function (n) { return Math.min(n + 1, flat.length - 1) })
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setIndex(function (n) { return Math.max(n - 1, 0) })
        } else if (event.key === 'Enter') {
          event.preventDefault()
          const one = flat[index]
          if (one != null && props.busy !== true) props.onPick(one)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          props.onClose()
        }
      }
      const items = []
      let at = 0
      for (let g = 0; g < groups.length; g += 1) {
        const group = groups[g]
        items.push(h('div', { key: 'g:' + group.name, className: 'dsh-git-bs-group' },
          h('span', { key: 'i', className: 'dsh-git-bs-ico' }, h(BranchIcon, { size: 12 })),
          h('span', { key: 'l' }, group.name),
          h('span', { key: 'n', className: 'dsh-git-bs-count' }, String(group.rows.length))))
        for (let r = 0; r < group.rows.length; r += 1) {
          const row = group.rows[r]
          const mine = at
          at += 1
          items.push(h('div', {
            key: 'r:' + group.name + '/' + row.branch,
            className: 'dsh-git-bs-row' + (mine === index ? ' dsh-git-bs-row-on' : '') + (props.busy === true ? ' dsh-git-bs-busy' : ''),
            title: '绑定上游 ' + group.name + '/' + row.branch + ' 并拉取',
            onClick: function () { if (props.busy !== true) props.onPick(row) },
          },
            h('span', { key: 'i', className: 'dsh-git-bs-ico' }, h(BranchIcon, { size: 13 })),
            h('span', { key: 'n', className: 'dsh-git-bs-name' }, row.branch)))
        }
      }
      return h('div', { className: 'dsh-git-picklist' },
        h('div', { key: 'h', className: 'dsh-git-bs-head' },
          h('span', { key: 'i', className: 'dsh-git-bs-mag' }, h(Icon, { name: 'search', size: 12 })),
          h('input', {
            key: 'q', className: 'dsh-git-bs-search', autoFocus: true,
            placeholder: '搜索远端分支（回车选高亮，Esc 退出）',
            value: query,
            onChange: function (event) { setQuery(event.target.value); setIndex(0) },
            onKeyDown: onKey,
          })),
        h('div', { key: 'l', className: 'dsh-git-bs-list' },
          items.length > 0 ? items : h('div', { key: 'none', className: 'dsh-git-bs-empty' },
            error !== null ? '读不到远端分支：' + error
              : (data == null ? '正在读取远端分支…' : (needle.length > 0 ? '没有匹配的远端分支' : '这个仓库还没有远端分支')))))
    }


    function BranchPicker(props) {
      const version = useDataVersion()
      useBranchPrefs()
      const [data, setData] = React.useState(branchCache[props.repo] !== undefined ? branchCache[props.repo] : null)
      const [error, setError] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      /* Mirrored outside React because the decision to close the card is taken
         above this component, in the popover's pointer handling. */
      switchBusy = busy
      React.useEffect(function () {
        return function () { switchBusy = false }
      }, [])
      const [query, setQuery] = React.useState('')
      const [index, setIndex] = React.useState(0)
      const [stash, setStash] = React.useState(false)
      const [pending, setPending] = React.useState('')
      const [collapsed, setCollapsed] = React.useState({})
      /* The IDEA submenu. `pinned` separates the two ways in: hovering opens it
         and leaving closes it, clicking › keeps it until it is clicked again. */
      const [fly, setFly] = React.useState(null)
      const [creating, setCreating] = React.useState(null)
      const [armedDelete, setArmedDelete] = React.useState('')
      /* pull 的「选远端分支」态：false 是正常的分支列表，true 表示当前分支还没有
         上游、远端又没有同名分支 —— 列表区域整个换成远端分支选择（Esc 退回）。 */
      const [pick, setPick] = React.useState(false)

      /* Where the flyout hangs: the row's own offset inside the scrolling list,
         translated into the card's coordinates. Rows are offset from the list
         (which is positioned) and the list from the card (also positioned). */
      const rowTop = function (event) {
        const node = event != null ? event.currentTarget : null
        if (node == null || typeof node.offsetTop !== 'number') return 0
        const base = pickerList != null && typeof pickerList.offsetTop === 'number' ? pickerList.offsetTop : 0
        const scrolled = pickerList != null && typeof pickerList.scrollTop === 'number' ? pickerList.scrollTop : 0
        return base + node.offsetTop - scrolled - 4
      }
      const flyOpenSoon = function (key, top) {
        clearFlyTimer()
        const timer = ctx.get('timer')
        const reveal = function () {
          setFly(function (prev) {
            if (prev !== null && prev.pinned === true) return prev
            return { key: key, top: top, pinned: false }
          })
        }
        if (timer === undefined) { reveal(); return }
        flyTimer = timer.timeout(function () { flyTimer = null; reveal() }, FLY_OPEN_MS)
      }
      const flyCloseSoon = function () {
        clearFlyTimer()
        const timer = ctx.get('timer')
        const dismiss = function () {
          setFly(function (prev) { return prev !== null && prev.pinned === true ? prev : null })
        }
        if (timer === undefined) { dismiss(); return }
        flyTimer = timer.timeout(function () { flyTimer = null; dismiss() }, FLY_CLOSE_MS)
      }
      const flyPin = function (key, top) {
        clearFlyTimer()
        setFly(function (prev) {
          if (prev !== null && prev.key === key && prev.pinned === true) return null
          return { key: key, top: top, pinned: true }
        })
      }

      const request = function (extra) {
        const built = { sessionId: props.sessionId }
        if (props.repo != null && props.repo.length > 0) built.repo = props.repo
        if (extra != null) Object.assign(built, extra)
        return built
      }

      React.useEffect(function () {
        const node = pickerInputNode
        loadBranchPrefs(node != null && node.ownerDocument != null
          ? node.ownerDocument
          : (chipNode != null ? chipNode.ownerDocument : null))
        /* Hover mode never focuses the filter: taking the caret out of the
           composer because a pointer crossed the toolbar would be worse than
           clicking the box yourself, so the card stays passive until it is
           clicked. */
        if (props.mode === 'panel' && node != null && typeof node.focus === 'function') node.focus()
        return undefined
      }, [])

      React.useEffect(function () {
        let alive = true
        rpc('git/branches', request(null), '读不到分支列表').then(function (result) {
          if (!alive) return
          rememberBranches(props.repo, result)
          setData(result)
          setIndex(0)
        }, function (failure) {
          if (!alive) return
          if (failure.reply !== undefined) setData({ ok: false })
          setError('读不到分支列表：' + failureText(failure))
        })
        return function () { alive = false }
      }, [props.repo, props.sessionId, version])

      const choose = function (name, useStash) {
        if (busy === true || name.length === 0) return
        clearHoverTimer()
        setBusy(true)
        setError(null)
        setNote(null)
        setPending('')
        setFly(null)
        /* Said out loud, because the flyout collapsing under the pointer makes
           it look as if the click was never heard. The chips say it too — their
           branch icon turns while this is in flight, so the wait is visible even
           after the card is gone. */
        setNote(useStash === true ? '正在暂存改动并切到 ' + name + '…' : '正在切到 ' + name + '…')
        setSwitchingTo(name)
        rpc('git/checkout', request({ name: name, stash: useStash === true }), '切换失败').then(function (result) {
          setBusy(false)
          setSwitchingTo(null)
          bumpData()
          rememberBranch(name)
          if (result.popConflict === true) {
            setNote('已切到 ' + name + '，但你的改动恢复时发生冲突，stash 条目还留着（git stash list）。')
            return
          }
          props.onDone()
        }, function (failure) {
          const reply = failure.reply
          const detail = failureText(failure)
          setBusy(false)
          setSwitchingTo(null)
          if (reply != null && reply.stashed === true && reply.restored === true) {
            setError('切到 ' + name + ' 失败，你的改动已经放回工作区。' + (detail.length > 0 ? ' ' + detail : ''))
          } else if (reply != null && reply.stashed === true) {
            setError('切到 ' + name + ' 失败，而且改动没能放回工作区 —— 它们在 stash 里，用 git stash list 找回。')
          } else if (reply != null && reply.error === 'stash-failed') {
            setError('暂存改动失败：' + (detail.length > 0 ? detail : 'git stash 没能执行'))
          } else {
            setError(detail.length > 0 ? detail : '切换失败')
            /* Not necessarily a dirty tree — but that is the one cause the user
               can fix from here, and the button explains itself if it does not. */
            setPending(name)
          }
          bumpData()
        })
      }

      /* The repository-wide actions live in the same palette, so "fetch" or "push"
         can be typed rather than hunted for in the toolbar. They keep the card
         open and report inline, which is what makes them safe to fire off in a
         row. */
      const act = function (method, payload, label) {
        if (busy === true) return
        setBusy(true)
        setError(null)
        setNote(null)
        rpc(method, request(payload), label + ' 失败').then(function () {
          setBusy(false)
          bumpData()
          setNote(label + ' 完成')
        }, function (failure) {
          setBusy(false)
          if (failure.reply !== undefined) bumpData()
          setError(failureText(failure))
        })
      }

      /* ── 拉取（这张卡里的 ↓）──

         已有 upstream 照旧直接 pull，一字不变。没有时先问一次 refs：远端有同名
         分支就带 setUpstream 一次跑完（绑定 + 拉取，set-upstream-to 的 argv 在
         Host 那半）；没有同名就把列表区域换成远端分支选择（pick），点行绑定并
         拉取。refs 读不动就按老路裸 pull —— git 的拒绝原话照旧上屏。 */
      const pullBound = function (match) {
        if (busy === true) return
        setBusy(true)
        setError(null)
        setNote('正在绑定上游 ' + match.remote + '/' + match.branch + ' 并拉取…')
        rpc('git/pull', request({ setUpstream: match }), '拉取失败').then(function () {
          setBusy(false)
          bumpData()
          setPick(false)
          setNote('已绑定上游 ' + match.remote + '/' + match.branch + ' 并拉取')
        }, function (failure) {
          setBusy(false)
          bumpData()
          const said = failureText(failure)
          /* 远端分支其实不在（refs 数据过期，git 说 "does not exist"）：不裸报错，
             落到选择层让读者挑一个真的在的。 */
          if (said.indexOf('does not exist') >= 0) {
            setError('上游 ' + match.remote + '/' + match.branch + ' 在远端已经不存在（列表过期），请在下面重新选择：')
            setPick(true)
            return
          }
          setError(said)
        })
      }
      const pullAction = function () {
        if (busy === true) return
        const row = all.find(function (one) { return one.current === true })
        /* 已有 upstream：行为一字不变，照旧直接 pull。 */
        if (row != null && text(row.upstream).length > 0) { act('git/pull', {}, 'pull'); return }
        /* 没有当前行：detached（没有名字）或还没出生（unborn，这张卡列表不收它）
           —— set-upstream 无从谈起，照旧直接 pull。 */
        if (row == null) { act('git/pull', {}, 'pull'); return }
        const current = text(row.name)
        setBusy(true)
        rpc('git/refs', request(null), '读不到分支列表').then(function (refsData) {
          setBusy(false)
          const match = upstreamMatchInRefs(refsData, current)
          if (match != null) { pullBound(match); return }
          setPick(true)
        }, function () {
          setBusy(false)
          act('git/pull', {}, 'pull')
        })
      }

      const submitNew = function (draft) {
        const name = (draft != null && typeof draft.value === 'string' ? draft.value : '').trim()
        const at = draft != null && typeof draft.at === 'string' ? draft.at.trim() : ''
        setCreating(null)
        if (name.length === 0 || busy === true) return
        setBusy(true)
        setError(null)
        setNote(null)
        const payload = { name: name }
        if (at.length > 0) payload.at = at
        rpc('git/branch-create', request(payload), '新建分支失败').then(function () {
          setBusy(false)
          bumpData()
          rememberBranch(name)
          props.onDone()
        }, function (failure) {
          setBusy(false)
          if (failure.reply !== undefined) bumpData()
          setError(failureText(failure))
        })
      }

      const remove = function (name, force) {
        if (busy === true) return
        setBusy(true)
        setError(null)
        setNote(null)
        rpc('git/branch-delete', request({ name: name, force: force === true }), '删除分支失败').then(function () {
          setBusy(false)
          bumpData()
          setArmedDelete('')
          setNote('已删除分支 ' + name)
        }, function (failure) {
          const detail = failureText(failure)
          setBusy(false)
          bumpData()
          if (force !== true && detail.indexOf('not fully merged') >= 0) {
            /* -d refused because the commits are not merged anywhere else; the
               row grows a force button rather than hiding the reason. */
            setArmedDelete(name)
            setError('git 拒绝安全删除 ' + name + '：它的提交还没有合并到别处。')
            return
          }
          setError(detail)
        })
      }

      const all = data != null && data.ok === true ? data.branches : []
      const remoteAll = data != null && data.ok === true && Array.isArray(data.remotes) ? data.remotes : []
      const needle = query.trim().toLowerCase()
      const hit = function (label) { return needle.length === 0 || label.toLowerCase().indexOf(needle) >= 0 }

      const byDate = function (a, b) { return (b.committedAt || 0) - (a.committedAt || 0) }
      const byName = function (a, b) {
        const x = text(a.name).toLowerCase()
        const y = text(b.name).toLowerCase()
        if (x === y) return 0
        return x < y ? -1 : 1
      }
      /* Favourites float to the top of their group and keep the chosen order
         among themselves, the way a starred row does in IDEA. */
      const ordered = function (list) {
        const kept = []
        for (let i = 0; i < list.length; i += 1) if (hit(text(list[i].name))) kept.push(list[i])
        kept.sort(branchSort === 'name' ? byName : byDate)
        const starred = []
        const rest = []
        for (let i = 0; i < kept.length; i += 1) {
          if (starredBranches.indexOf(text(kept[i].name)) >= 0) starred.push(kept[i])
          else rest.push(kept[i])
        }
        return starred.concat(rest)
      }

      const localRows = ordered(all)
      const remoteRows = ordered(remoteAll)
      const recentRows = []
      if (needle.length === 0) {
        for (let i = 0; i < recentBranches.length && recentRows.length < MRU_MAX; i += 1) {
          for (let k = 0; k < all.length; k += 1) {
            if (text(all[k].name) === recentBranches[i] && recentRows.indexOf(all[k]) < 0) { recentRows.push(all[k]); break }
          }
        }
      }

      /* "push" and "pull" say how far the current branch has drifted from its
         upstream, so the chip is worth reading before it is clicked. */
      let aheadNow = 0
      let behindNow = 0
      for (let i = 0; i < all.length; i += 1) {
        if (all[i].current === true) {
          aheadNow = typeof all[i].ahead === 'number' ? all[i].ahead : 0
          behindNow = typeof all[i].behind === 'number' ? all[i].behind : 0
          break
        }
      }

      /* short is the chip text, label is the full sentence kept for the tooltip
         and for what typing in the filter box can match. */
      /* 记号跟面板一致：面板头部的同步组就是 ⇣ / ↓ / ↑ 这几个字符，这里不再
         另画一套 SVG。一个动作一种画法，两个地方看起来才是同一套。 */
      const actionDefs = [
        { id: 'fetch', glyph: '⇣', short: '获取', label: '获取远端最新（fetch）', run: function () { act('git/fetch', {}, 'fetch') } },
        { id: 'pull', glyph: '↓', short: '拉取', badge: behindNow > 0 ? (behindNow > 99 ? '99+' : String(behindNow)) : undefined, label: '拉取当前分支（pull）', run: function () { pullAction() } },
        { id: 'push', glyph: '↑', short: '推送', badge: aheadNow > 0 ? (aheadNow > 99 ? '99+' : String(aheadNow)) : undefined, label: '推送当前分支（push）', run: function () { act('git/push', {}, 'push') } },
      ]
      actionDefs.push({ id: 'new', glyph: '+', short: '新建分支', label: '新建分支…', run: function () { setCreating({ at: '', value: '' }) } })
      const actions = []
      for (let i = 0; i < actionDefs.length; i += 1) if (hit(actionDefs[i].label) || hit(actionDefs[i].short)) actions.push(actionDefs[i])

      const groups = []
      if (recentRows.length > 0) groups.push({ id: 'recent', label: '最近', rows: recentRows, remote: false })
      groups.push({ id: 'local', label: '本地', rows: localRows, remote: false })
      if (remoteRows.length > 0) groups.push({ id: 'remote', label: '远端', rows: remoteRows, remote: true })

      /* Keyboard order is the visual order: the action rows first, then every
         group's rows, skipping whatever is collapsed. */
      const nav = []
      /* row → its place in the keyboard order. The row loop below used to search
         for it with findIndex, which is a scan of the whole list per row: three
         hundred branches meant ninety thousand comparisons on every render, for
         an answer that is already known while the list is being built. */
      const navAt = new Map()
      for (let i = 0; i < actions.length; i += 1) nav.push({ kind: 'action', def: actions[i] })
      for (let g = 0; g < groups.length; g += 1) {
        if (collapsed[groups[g].id] === true) continue
        for (let i = 0; i < groups[g].rows.length; i += 1) {
          navAt.set(groups[g].rows[i], nav.length)
          const rowName = text(groups[g].rows[i].name)
          nav.push({
            kind: 'row', row: groups[g].rows[i], remote: groups[g].remote, group: groups[g].id,
            /* The highlight is an index, the list is re-ordered by favourites and
               sort order, and a row that moves takes its index with it. The key is
               how the panel finds the same row again afterwards. */
            key: (groups[g].remote === true ? 'r:' : 'l:') + rowName,
          })
        }
      }

      /* The submenu IDEA opens beside a hovered branch. It keeps the same
         capabilities the inline strip had, in IDEA's order, with the destructive
         one last and behind the same two-step arm the strip used. */
      /* ── the rows are memoised, so their props must not change for nothing ──

         Moving the pointer down three hundred branches used to rebuild all three
         hundred of them, because the keyboard highlight is state and every row
         re-rendered when it moved. Handing each row its own component fixes that
         only if the handlers it receives keep one identity across renders — and
         the handlers above close over the state of the render that made them.

         So they are rebuilt once and read the current state out of `live`, which
         every render refreshes. `useState` is the holder because the box has to
         belong to this component rather than to the file: two switchers in two
         sessions must not share one. */
      const [live] = React.useState(function () { return {} })
      live.setIndex = setIndex
      live.choose = choose
      live.rowTop = rowTop
      live.flyOpenSoon = flyOpenSoon
      live.flyCloseSoon = flyCloseSoon
      live.flyPin = flyPin
      live.busy = busy
      live.stash = stash

      const onRowEnter = useCallback(function (rowKey, at, event) {
        if (at >= 0) live.setIndex(at)
        if (live.busy !== true) live.flyOpenSoon(rowKey, live.rowTop(event))
      }, [])
      const onRowLeave = useCallback(function () { live.flyCloseSoon() }, [])
      const onRowClick = useCallback(function (name, isCurrent, rowKey, event) {
        /* The current branch has nothing to check out, so the row click pins its
           submenu — the touch/keyboard way to the same panel the pointer gets by
           hovering. */
        if (isCurrent === true) { live.flyPin(rowKey, live.rowTop(event)); return }
        live.choose(name, live.stash)
      }, [])
      const onRowMenu = useCallback(function (rowKey, event) {
        stopEvent(event)
        live.flyPin(rowKey, live.rowTop(event))
      }, [])

      const rowActions = function (name, remote, isCurrent) {
        const items = []
        if (remote === true) {
          items.push(h('button', {
            key: 'sw', type: 'button', className: 'dsh-git-bs-fly-item',
            title: 'git switch ' + name + ' —— 会在本地建一个跟踪分支',
            onClick: function (event) { stopEvent(event); choose(name, stash) },
          }, h('span', { key: 'i', className: 'dsh-git-bs-fly-ico' }, h(Icon, { name: 'right', size: 12 })), '检出为本地分支'))
        } else if (isCurrent !== true) {
          items.push(h('button', {
            key: 'sw', type: 'button', className: 'dsh-git-bs-fly-item',
            title: 'git switch ' + name,
            onClick: function (event) { stopEvent(event); choose(name, stash) },
          }, h('span', { key: 'i', className: 'dsh-git-bs-fly-ico' }, h(Icon, { name: 'right', size: 12 })),
            stash === true ? '暂存并切换' : '检出'))
        }
        items.push(h('button', {
          key: 'nb', type: 'button', className: 'dsh-git-bs-fly-item',
          title: '以 ' + name + ' 为起点新建分支并切过去',
          onClick: function (event) { stopEvent(event); setFly(null); setCreating({ at: name, value: '' }) },
        }, h('span', { key: 'i', className: 'dsh-git-bs-fly-ico' }, h(Icon, { name: 'plus', size: 12 })),
          '从此分支新建分支…'))
        if (remote !== true && isCurrent !== true) {
          items.push(h('div', { key: 's1', className: 'dsh-git-bs-fly-sep' }))
          items.push(h('button', {
            key: 'mg', type: 'button', className: 'dsh-git-bs-fly-item',
            title: 'git merge ' + name + ' —— 合入当前分支',
            onClick: function (event) { stopEvent(event); setFly(null); act('git/sequence', { op: 'merge', action: 'start', target: name }, '合并 ' + name) },
          }, h('span', { key: 'i', className: 'dsh-git-bs-fly-ico' }, h(Icon, { name: 'pull', size: 12 })), '合并到当前分支'))
          items.push(h('div', { key: 's2', className: 'dsh-git-bs-fly-sep' }))
          if (armedDelete === name) {
            items.push(h('button', {
              key: 'dx', type: 'button', className: 'dsh-git-bs-fly-item dsh-git-bs-fly-danger',
              title: 'git branch -D ' + name + ' —— 丢弃没合并的提交',
              onClick: function (event) { stopEvent(event); remove(name, true) },
            }, h('span', { key: 'i', className: 'dsh-git-bs-fly-ico' }, h(Icon, { name: 'undo', size: 12 })), '强制删除'))
          } else {
            items.push(h('button', {
              key: 'dl', type: 'button', className: 'dsh-git-bs-fly-item dsh-git-bs-fly-danger',
              onClick: function (event) { stopEvent(event); remove(name, false) },
            }, h('span', { key: 'i', className: 'dsh-git-bs-fly-ico' }, h(Icon, { name: 'undo', size: 12 })), '删除'))
          }
        }
        return items
      }

      /* The chips own the same nav slots the action rows used to, so arrow-key
         order still runs top to bottom: chips, then every visible group row. */
      /* 收藏哪一个：列表里当前高亮的那一行。跟着指针/键盘走，所以「不切过去
         也能收藏」这条能力还在，而按钮只有一个。 */
      const picked = nav[index] !== undefined && nav[index].kind === 'row' ? nav[index] : null
      const pickedName = picked === null ? '' : text(picked.row.name)
      const pickedStarred = pickedName.length > 0 && starredBranches.indexOf(pickedName) >= 0
      const pickedKey = picked === null ? '' : text(picked.key)
      /* 收藏会把那一行排到最前面，而高亮记的是序号：不按名字重新对一次，收藏完
         高亮就落到别的分支上 —— 这个按钮（还有下面展开的那一栏）跟着改了主语。 */
      const [reveal, setReveal] = React.useState(null)
      React.useEffect(function () {
        if (reveal === null) return
        for (let i = 0; i < nav.length; i += 1) {
          if (nav[i].kind === 'row' && nav[i].key === reveal) { setIndex(i); break }
        }
        setReveal(null)
      })

      const chips = []
      for (let i = 0; i < actions.length; i += 1) {
        const def = actions[i]
        const on = nav[index] !== undefined && nav[index].kind === 'action' && nav[index].def === def
        /* 只留记号（⇣/↓/↑/+），文字进了 title：面板头部那几个 tool 就是这么画
           的，两处一致，也省下一整行宽度。 */
        const parts = [
          h('span', { key: 'i', className: 'dsh-git-bs-glyph' }, def.glyph),
        ]
        /* 面板那几个 tool 的角标就是一个数字药丸，这里也照那个样子：记号已经
           是 ⇣/↓/↑ 了，角标再带一个箭头就成了「↓拉取↓1」。 */
        if (def.badge !== undefined) parts.push(h('span', { key: 'b', className: 'dsh-git-bs-chip-n' }, def.badge))
        chips.push(h('button', {
          key: 'a:' + def.id, type: 'button',
          className: 'dsh-git-bs-chip'
            + (on ? ' dsh-git-bs-chip-on' : '')
            + (def.id === 'new' ? ' dsh-git-bs-chip-new' : ''),
          title: def.label,
          disabled: busy === true,
          onMouseEnter: function () { setIndex(i) },
          onClick: function (event) { stopEvent(event); def.run() },
        }, parts))
      }
      chips.push(h('button', {
        key: 'a:fav', type: 'button',
        className: 'dsh-git-bs-chip dsh-git-bs-fav' + (pickedStarred ? ' dsh-git-bs-fav-on' : ''),
        title: pickedName.length === 0
          ? '把鼠标停在一个分支上（或用键盘移过去），这里就是收藏它的按钮'
          : (pickedStarred ? '取消收藏 ' : '收藏 ') + pickedName,
        disabled: pickedName.length === 0 || busy === true,
        onClick: function (event) {
          stopEvent(event)
          if (pickedName.length === 0) return
          toggleStar(pickedName)
          setReveal(pickedKey)
        },
      }, h('span', { key: 'i', className: 'dsh-git-bs-glyph dsh-git-bs-glyph-star' }, pickedStarred ? '★' : '☆')))
      const items = []

      /* 分组头那一行的折叠：箭头和整行点哪都算。箭头本身是面板左栏那个 twisty，
         它自己会 stopPropagation，所以点箭头只折一次。 */
      const toggleGroup = function (id) {
        setCollapsed(function (prev) {
          const next = Object.assign({}, prev)
          next[id] = prev[id] !== true
          return next
        })
      }

      for (let g = 0; g < groups.length; g += 1) {
        const group = groups[g]
        const shut = collapsed[group.id] === true
        items.push(h('div', {
          key: 'g:' + group.id, className: 'dsh-git-bs-group',
          onClick: function () { toggleGroup(group.id) },
        },
          twisty({ collapsed: shut, onToggle: function () { toggleGroup(group.id) } }),
          h('span', { key: 'l' }, group.label),
          h('span', { key: 'n', className: 'dsh-git-bs-count' }, String(group.rows.length))))
        if (shut) continue
        if (group.rows.length === 0) {
          /* 一个本地分支都没有有两种：真的没有，和「当前这个分支还没有第一个提交」
             —— 后者嘴里得说出它叫什么，不然 chip 上写着 main，卡片却说没有分支。 */
          const empty = needle.length > 0
            ? '没有匹配的分支'
            : (data != null && data.unborn === true && text(data.current).length > 0
                ? '当前在 ' + text(data.current) + '，还没有第一个提交'
                : '这个仓库还没有本地分支')
          items.push(h('div', { key: 'g:' + group.id + ':none', className: 'dsh-git-bs-empty' }, empty))
          continue
        }
        for (let r = 0; r < group.rows.length; r += 1) {
          const row = group.rows[r]
          const name = text(row.name)
          const rowKey = (group.remote === true ? 'r:' : 'l:') + name
          const at = navAt.has(row) ? navAt.get(row) : -1
          items.push(h(BranchRowMemo, {
            key: 'r:' + (group.remote === true ? text(row.remote) + '/' : '') + name,
            row: row,
            rowKey: rowKey,
            where: group.remote === true ? text(row.remote) : '',
            at: at,
            active: at >= 0 && at === index,
            current: row.current === true,
            busy: busy === true,
            flying: fly !== null && fly.key === rowKey,
            onEnter: onRowEnter,
            onLeave: onRowLeave,
            onPick: onRowClick,
            onMenu: onRowMenu,
          }))
        }
      }

      if (data == null) items.push(h('div', { key: 'wait', className: 'dsh-git-bs-empty' }, '正在读取分支…'))

      const foot = []
      if (pending.length > 0) {
        foot.push(h('button', {
          key: 'rescue', type: 'button', className: 'dsh-git-bs-rescue',
          onClick: function () { setStash(true); choose(pending, true) },
        }, '先暂存本地改动，再切到 ' + pending))
      }
      /* 还没有第一个提交的仓库里 `git stash` 必然失败（"You do not have the initial
         commit yet"），所以这一个勾选框不能出现 —— 「切完自动恢复」在这里是一句
         兑现不了的承诺。改动本身不会丢：切分支时 git 会自己拒绝或带过去。 */
      if (props.dirty > 0 && (data == null || data.unborn !== true)) {
        foot.push(h('label', {
          key: 'stash', className: 'dsh-git-bs-check',
          title: '把本地改动 stash 起来，切过去之后再自动 pop 回来',
        },
          h('input', { key: 'c', type: 'checkbox', checked: stash === true, onChange: function (event) { setStash(event.target.checked) } }),
          h('span', { key: 't' }, '有 ' + String(props.dirty) + ' 个未提交改动 —— 先暂存再切（切完自动恢复）')))
      }

      const createRow = creating === null ? null : h('div', { key: 'create', className: 'dsh-git-bs-create' },
        clearable('i', h('input', {
          key: 'i', className: 'dsh-git-input dsh-git-bs-new',
          placeholder: creating.at.length > 0 ? '以 ' + creating.at + ' 为起点的新分支名' : '新分支名，回车创建',
          value: creating.value,
          autoFocus: true,
          onChange: function (event) { setCreating({ at: creating.at, value: event.target.value }) },
          onKeyDown: function (event) {
            if (event.key === 'Enter') { event.preventDefault(); submitNew(creating) }
            else if (event.key === 'Escape') { event.preventDefault(); setCreating(null) }
          },
        }), creating.value.length > 0, function () { setCreating({ at: creating.at, value: '' }) }),
        h('button', { key: 'ok', type: 'button', className: 'dsh-git-btn', onClick: function () { submitNew(creating) } }, '创建并切换'),
        h('button', { key: 'no', type: 'button', className: 'dsh-git-btn', onClick: function () { setCreating(null) } }, '取消'))

      /* The submenu element: which branch it belongs to is read back from the
         key the row handed us, so nothing has to be kept in sync by hand. */
      let flyNode = null
      if (fly !== null) {
        let foundRow = null
        let foundRemote = false
        for (let g = 0; g < groups.length && foundRow === null; g += 1) {
          for (let r = 0; r < groups[g].rows.length; r += 1) {
            const key = (groups[g].remote === true ? 'r:' : 'l:') + text(groups[g].rows[r].name)
            if (key === fly.key) { foundRow = groups[g].rows[r]; foundRemote = groups[g].remote === true; break }
          }
        }
        if (foundRow !== null) {
          const flyName = text(foundRow.name)
          const flyCurrent = foundRow.current === true
          flyNode = h('div', {
            key: 'fly', className: 'dsh-git-bs-fly',
            style: { top: String(Math.max(0, fly.top)) + 'px' },
            /* Crossing from the row into the panel must not count as leaving —
               in hover mode the card closes itself on pointerleave, so both
               timers have to be cancelled, not just this one. */
            onPointerEnter: function () { clearFlyTimer(); clearHoverTimer() },
            onPointerLeave: function () { flyCloseSoon() },
          },
            h('div', { key: 'h', className: 'dsh-git-bs-fly-head' },
              h('span', { key: 'n', className: 'dsh-git-bs-name' }, flyName),
              flyCurrent === true ? h('span', { key: 'c' }, '（当前）') : null),
            rowActions(flyName, foundRemote, flyCurrent))
        }
      }

      const keyboard = function (event) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setIndex(function (n) { return Math.min(n + 1, nav.length - 1) })
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setIndex(function (n) { return Math.max(n - 1, 0) })
        } else if (event.key === 'Enter') {
          event.preventDefault()
          const entry = nav[index]
          if (entry === undefined) return
          if (entry.kind === 'action') entry.def.run()
          else choose(text(entry.row.name), stash)
        } else if (event.key === 'Tab') {
          event.preventDefault()
          setBranchSort(branchSort === 'name' ? 'recent' : 'name')
        } else if (event.key === 'Escape') {
          event.preventDefault()
          if (pick === true) setPick(false)
          else if (creating !== null) setCreating(null)
          else props.onClose()
        }
      }

      /* 选择态：搜索行与列表区域整个换成远端分支选择 —— 卡里其余的东西（动作、
         收藏、flyout、脚注）都是「对着分支列表」的，这时候没有意义。Esc 退回
         （键盘那一段），点行绑定并拉取。 */
      if (pick === true) {
        return h('div', { className: 'dsh-git-bs' },
          h('div', { key: 'cap', className: 'dsh-git-hint', style: { padding: '6px 10px 0' } },
            '当前分支还没有上游 —— 选择要跟的远端分支（选中后绑定并拉取）'),
          h(RemotePickList, {
            key: 'pick', sessionId: props.sessionId, repo: props.repo,
            busy: busy === true,
            onPick: pullBound,
            onClose: function () { setPick(false) },
          }),
          note !== null ? h('div', { key: 'n', className: 'dsh-git-hint dsh-git-warn' }, note) : null,
          error !== null ? h('div', { key: 'e', className: 'dsh-git-hint dsh-git-error' }, error) : null)
      }

      return h('div', { className: 'dsh-git-bs' },
        h('div', { key: 'h', className: 'dsh-git-bs-head' },
          h('span', { key: 'i', className: 'dsh-git-bs-mag' }, h(Icon, { name: 'search', size: 12 })),
          h('input', {
            key: 'q', className: 'dsh-git-bs-search',
            placeholder: '搜索分支',
            value: query,
            ref: function (node) { pickerInputNode = node },
            onChange: function (event) { setQuery(event.target.value); setIndex(0) },
            onKeyDown: keyboard,
          }),
          /* The repository-wide actions share the header line with the search
             box instead of owning a row of their own below it. */
          chips.length > 0 ? h('div', { key: 'acts', className: 'dsh-git-bs-head-acts' }, chips) : null,
          h('button', {
            key: 'sort', type: 'button', className: 'dsh-git-bs-icon dsh-git-bs-sort',
            title: branchSort === 'name'
              ? '当前按名称排序（A→Z），点击改为按最近提交'
              : '当前按最近提交排序，点击改为按名称（A→Z）',
            onClick: function () { setBranchSort(branchSort === 'name' ? 'recent' : 'name') },
          }, h(Icon, { name: branchSort === 'name' ? 'sortName' : 'sortRecent', size: 13 }))),
        h('div', {
          key: 'l', className: 'dsh-git-bs-list',
          ref: function (node) { pickerList = node },
          /* A flyout is anchored to a row's screen position, so a scroll would
             leave it pointing at the wrong one. */
          onScroll: function () { clearFlyTimer(); setFly(null) },
        }, items),
        flyNode,
        note !== null ? h('div', { key: 'n', className: 'dsh-git-hint dsh-git-warn' }, note) : null,
        error !== null ? h('div', { key: 'e', className: 'dsh-git-hint dsh-git-error' }, error) : null,
        createRow,
        foot.length > 0 ? h('div', { key: 'f', className: 'dsh-git-bs-foot' }, foot) : null)
    }

