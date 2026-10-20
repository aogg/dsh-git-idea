    /* ── worktree 块：历史页左栏、仓库块正下方的那列 git worktree（v1，纯只读）──

       数据来自 Host 的 git/worktrees（65-worktree.js，refs 同一套按仓库读缓存），
       永远描述**当前生效仓库**：读数住在 80-panel.js 里，跟着 appliedRepo + freshAt
       走 —— 切仓库、⟳、任何变更 git 命令之后整块跟着换。组件自己不发读数。

       v1 的边界刻意窄：行只「看」和「选分支」。单击一行 = 复用 pickBranch 的语义
       （80-panel.js），历史立即按那个 worktree 的分支过滤重读 —— 仅此而已：
       不 checkout、不切换分支、不动任何 worktree 的工作区，tooltip 里也这么说。
       detached / bare / prunable 的行退成灰行（仓库块「已不存在」同一个压暗读法），
       其中 detached 与 bare 没有分支可选，单击不动；bare 的分支留作防御 —— Host
       只发 `git worktree add` 出来的链接工作区，主目录与 bare 不在列。

       v1.1 起有第二种用法（变更页左栏）：props 里给了 onPickWorktree 就是「仓库
       模式」—— 单击一行 = 80-panel.js 的 repoSingle，把生效仓库切到那个工作区
       目录，变更列表跟着新仓库重读。这个模式下「选中」按路径算（path == 生效
       仓库亮 ●，折叠后标题行记的也是它），detached 也算可点的行（变更页看的是
       工作区改动，与站在哪个分支无关），bare / prunable 仍不可点；↑↓ 徽章照旧
       按分支名从 refs 免费查。不给 onPickWorktree 就是上面那段历史模式，逐行
       不差 —— 同一个组件两种语义，全看这一个 prop 给没给。

       视觉与仓库块同族：容器、标题行、行的 CSS 规则在 46-css.js 里与 .dsh-git-repo-box
       / -head / -row 那几条**共用同一组声明**（分组选择器），观感逐像素一致；类名却
       刻意另起 dsh-git-wt- 前缀 —— 仓库行/仓库块是测试按个数认的控件（gp44 数
       repo-box / repo-row 的个数），worktree 块混进同一批类名就会把那些账搅乱。行内的
       记号仍直接复用没人按个数认的小类：dsh-git-repo-mark（●）、dsh-git-repo-glyph、
       dsh-git-tmain/tname/tsub（分支树的两段式）、dsh-git-ab（↑↓ 徽章）。

       徽章数据不另读：按分支名从面板已经读好的那份 refs（分支树 metaOf 同源的那份）
       免费查，查不到就不画 —— worktree 块的往返只有 git/worktrees 这一条。 */
    function WorktreeBox(props) {
      const data = props.data
      const refs = props.refs
      const effective = text(props.effective)
      const activeRef = text(props.activeRef)
      /* 仓库模式（变更页）：给了 onPickWorktree 就是「单击 = 切生效仓库到这个
         工作区」（顶部注释的第二种用法）；没给就是历史页的分支过滤，逐行照旧。 */
      const repoMode = typeof props.onPickWorktree === 'function'
      /* 折叠只收起这一块的行，不碰任何选择，跟着组件挂载走 —— 与 RepoSwitcher 的
         折叠同一个约定（折叠后标题行仍记着当前选中的那一个）。 */
      const [folded, setFolded] = React.useState(false)

      /* 分支树的 metaOf 同一份账：本地分支按短名各留 ahead/behind/upstream。refs
         还没读到（首帧、刚切仓库）时账是空的，徽章自然不画 —— 不等它、不为它
         多发一次读数。 */
      const metaOf = {}
      if (refs != null && refs.ok === true) {
        for (let i = 0; i < refs.local.length; i += 1) metaOf[text(refs.local[i].data)] = refs.local[i]
      }

      const list = data != null && Array.isArray(data.worktrees) ? data.worktrees : []
      /* 选中联动，两种口径：仓库模式按路径（path == 生效仓库，即「变更列表正
         看着这个工作区」，bare 行本来就进不了数据，不用挑）；历史模式按分支
         （这个 worktree 的分支 == 面板传进来的 activeRef，与分支树
         dsh-git-trow-scope 高亮用的同一个值）。行首亮 ● 与折叠后标题行记的
         都是这一个。 */
      let current = null
      if (repoMode) {
        for (let i = 0; i < list.length; i += 1) {
          const one = list[i]
          if (one != null && text(one.path) === effective) { current = one; break }
        }
      } else {
        for (let i = 0; i < list.length; i += 1) {
          const one = list[i]
          if (one != null && one.bare !== true && one.detached !== true
            && text(one.branch).length > 0 && text(one.branch) === activeRef) { current = one; break }
        }
      }

      /* 标题行同时是折叠开关，与仓库块同一副长相：三角、图标、名字、计数。 */
      const rows = [h('div', {
        key: 'wt-head',
        className: 'dsh-git-wt-head',
        title: folded ? '展开 worktree 列表' : '收起 worktree 列表（当前选中的 worktree 仍显示在标题行）',
        onClick: function () { setFolded(!folded) },
      },
        h('span', { key: 'c', className: 'dsh-git-repo-caret' + (folded ? ' dsh-git-repo-caret-off' : '') },
          h(Icon, { name: 'down', size: 10 })),
        h('span', { key: 'i', className: 'dsh-git-repo-head-ico' }, h(Icon, { name: 'folder', size: 12 })),
        h('span', { key: 't', className: 'dsh-git-repo-head-name' },
          data != null && data.ok === true ? 'worktree ' + String(list.length) : 'worktree'),
        current != null
          ? h('span', { key: 'now', className: 'dsh-git-repo-now', title: text(current.path) + '\n' + (repoMode ? '变更列表正看着这个工作区' : '历史正按这个 worktree 的分支过滤') },
            '● ' + repoBaseName(text(current.path)))
          : null,
        data == null
          ? h('span', { key: 's', className: 'dsh-git-repo-note' }, '正在读取…')
          : (data.ok !== true ? h('span', { key: 'f', className: 'dsh-git-repo-note' }, '读取失败') : null))]

      if (folded) return h('div', { className: 'dsh-git-wt-box' }, rows)

      if (data == null) {
        rows.push(h('div', { key: 'wt-loading', className: 'dsh-git-wt-row dsh-git-wt-gone' },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }),
          h('span', { key: 'n', className: 'dsh-git-dim' }, '正在读取 worktree…')))
        return h('div', { className: 'dsh-git-wt-box' }, rows)
      }
      if (data.ok !== true || list.length === 0) {
        /* 读取失败（不是仓库 / git 读不动）或一个 worktree 都没添加（新口径不含
           主目录）：整块退化成一行灰说明
           —— worktree 是辅助信息，它的失败不上面板顶上的错误横幅（error 位一次只说
           一件事的规矩），跟仓库块「扫描失败」的处理同一格调。 */
        rows.push(h('div', { key: 'wt-none', className: 'dsh-git-wt-row dsh-git-wt-gone' },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }),
          h('span', { key: 'n', className: 'dsh-git-dim' },
            data.ok === true ? '没有通过 git worktree 添加的工作区（主目录不算）' : '无法读取 worktree（这里可能不是 git 仓库）')))
        return h('div', { className: 'dsh-git-wt-box' }, rows)
      }

      for (let i = 0; i < list.length; i += 1) {
        const one = list[i]
        if (one == null) continue
        const path = text(one.path)
        const branch = text(one.branch)
        const bare = one.bare === true
        const detached = one.detached === true
        const prunable = one.prunable === true
        const locked = one.locked === true
        const lockReason = text(one.lockReason)
        const pruneReason = text(one.pruneReason)
        /* 「这一行不完整」才压暗。历史模式：bare / detached / prunable 都算 ——
            detached 与 bare 没有分支可选，单击不动；分支还在的 prunable 行仍可点
            （单击只是过滤历史，不碰 git 状态，目录丢了不影响这件事）。仓库模式：
            只有 bare / prunable 算 —— detached 的工作区照常能看变更，行不灰、
            单击切过去（灰行配「可点」的说法就自相矛盾了）。 */
        const dim = repoMode ? (bare || prunable) : (bare || detached || prunable)
        const selectable = repoMode
          ? path.length > 0 && bare !== true && prunable !== true
          : bare !== true && detached !== true && branch.length > 0
        const isCur = selectable && (repoMode ? path === effective : branch === activeRef)
        const meta = metaOf[branch] === undefined ? null : metaOf[branch]
        const ahead = meta != null && typeof meta.ahead === 'number' ? meta.ahead : 0
        const behind = meta != null && typeof meta.behind === 'number' ? meta.behind : 0
        const upstream = meta == null ? '' : text(meta.upstream)
        /* tooltip 的三件事是约定：完整路径、归属仓库、点击语义；后面的几行按状况追加。 */
        const tip = [path, '归属仓库：' + (effective.length > 0 ? effective : '（本会话工作区）')]
        if (text(one.head).length > 0) tip.push('HEAD ' + text(one.head))
        if (selectable) {
          tip.push(repoMode
            ? '单击 = 变更列表切到这个工作区（只切查看的仓库：不 checkout、不切分支、不动任何工作区）'
            : '单击 = 历史按分支 ' + branch + ' 过滤（只改历史视图：不 checkout、不切换分支、不动任何工作区）')
          /* 仓库模式里 detached 是可点的行，click 行之外补一句它为什么叫「游离」
             —— 历史模式 selectable 本来就排除 detached，这句在那边永远不触发。 */
          if (repoMode && detached) tip.push('游离 HEAD：这个 worktree 停在具体提交上、不站任何分支；不影响切过去看工作区改动')
          if (upstream.length > 0) tip.push(trackTitle(ahead, behind) + ' · ' + upstream)
        } else if (detached) {
          tip.push('游离 HEAD：这个 worktree 停在具体提交上，没有选中分支，单击不选分支')
        } else if (bare) {
          tip.push('bare 仓库：只有版本库没有工作区，不可选分支')
        }
        if (prunable) {
          tip.push('目录已丢失，可 prune 清理' + (pruneReason.length > 0 ? '（' + pruneReason + '）' : '') + '；本版没有 prune 动作')
        }
        if (locked) tip.push('已锁定' + (lockReason.length > 0 ? '：' + lockReason : ''))
        rows.push(h('div', {
          key: 'wt:' + path,
          className: 'dsh-git-wt-row' + (dim ? ' dsh-git-wt-gone' : ''),
          title: tip.join('\n'),
          onClick: selectable
            ? (repoMode
              ? function () { props.onPickWorktree(path) }
              : function () { props.onPickBranch(props.repo, branch) })
            : undefined,
        },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }, isCur ? '●' : ''),
          h('span', { key: 'g', className: 'dsh-git-repo-glyph' }, h(Icon, { name: 'folder', size: 12 })),
          /* 名字（目录短名）与小字（它站着的分支）两段式借分支树的那套类：读法一致
             —— 大字是这个目录，小字是里面的分支。 */
          h('span', { key: 'n', className: 'dsh-git-tmain' },
            h('span', { className: 'dsh-git-tname' }, repoBaseName(path)),
            h('span', { className: 'dsh-git-tsub' + (branch.length > 0 ? '' : ' dsh-git-tsub-none') },
              detached ? '游离 HEAD' : (bare ? 'bare' : (branch.length > 0 ? branch : '——')))),
          /* 行尾右侧一簇：↑↓ 徽章（refs 里免费查的）、prunable / locked 的记号。
             徽章的字符与配色就是分支树那两个（dsh-git-ab），tooltip 同一句。 */
          h('span', { key: 'r', className: 'dsh-git-wt-right' },
            behind > 0 ? h('span', { key: 'b', className: 'dsh-git-ab dsh-git-ab-in', title: '落后上游 ' + String(behind) + ' 个提交 —— 需要拉取' }, '↓' + (behind > 99 ? '99+' : String(behind))) : null,
            ahead > 0 ? h('span', { key: 'a', className: 'dsh-git-ab dsh-git-ab-out', title: '领先上游 ' + String(ahead) + ' 个提交 —— 需要推送' }, '↑' + (ahead > 99 ? '99+' : String(ahead))) : null,
            prunable ? h('span', { key: 'p', className: 'dsh-git-wt-mark', title: '目录已丢失，可 prune 清理；本版没有 prune 动作' }, '⚠') : null,
            locked ? h('span', { key: 'l', className: 'dsh-git-wt-mark', title: '已锁定' + (lockReason.length > 0 ? '：' + lockReason : '') }, '🔒') : null)))
      }

      return h('div', { className: 'dsh-git-wt-box' }, rows)
    }
