    /* ── 工作树页签（tab id 'wtree'）：每个仓库一组的 worktree 全景树 ──

       数据来自 Host 的 git/worktree-tree（host 65-worktree.js 下半）：仓库清单
       （git/repos 同源的那份账）里的每个仓库各一行组 —— 组头 = 仓库，组内第一行 =
       该仓库主目录（当前检出分支），其后 = 它经 git worktree add 建出的链接工作树
       （各自分支 + 路径）。读数的编排住在 80-panel.js（命令页同一套：面板打开后台
       预读、切到本页画手里的数据、⟳ / 变更命令后的 bump / 切生效仓库后重读），
       组件自身不发读数 —— 与 25-worktree.js 同一条纪律。

       v1 的边界刻意窄（任务口径）：纯展示 + **单击任意行 = 把生效仓库切到该行
       路径**（复用变更页 worktree 块 onPickWorktree / repoSingle 的既有语义，
       tooltip 里说清）—— 不 checkout、不切分支、不动任何工作区；本页不做新建 /
       清除 worktree 入口、不做右键菜单。bare（没有工作区可言）与 prunable（目录
       已丢失）的行退灰且不可点；locked 的行退灰带 🔒 但仍可点（目录还在，切过去
       看是安全的）；游离（detached）的行不灰、小字给短哈希。

       行图标两枚可区分：主目录行 = 立方体（repo，仓库本体的那颗），链接行 = 分支叉
       （wtlink，60-icons.js 同族画法的新字形）。「当前」徽标画在主目录行（= 主
       工作区；tooltip 说清该目录当前检出的分支）；生效仓库所在行（主目录或链接行
       都可能）= 高亮底色 + ● 徽标（与变更页 worktree 块的 ● 同语义）。

       ↑↓ 领先/落后徽章只对生效仓库那一组画：按分支名从面板已有 refs（分支树
       metaOf 同源的那份）免费查，查不到不画，不另发读取。

       组头名称的显示风格与仓库清单同族：同名仓库的短名（24-repos.js 的
       repoLabelMap / repoShortName，一个仓库在面板里只有一个短名）+ 悬停给全路径。

       组可折叠，折叠态记忆：localStorage 一格（键 dsh.git-idea.wtree-folded，按
       工作区分键、仓库存折叠与否）—— 62-branchstate / 63-storedlists 同一套先例：
       懒加载一次、写失败安静只留内存、不设 TTL。折叠是「这个浏览器怎么读」的偏好，
       不进 Host 配置。

       CSS 纪律：结构类名全部 dsh-git-wtree- 前缀 —— dsh-git-repo-row / dsh-git-wt-row
       的个数是测试按个数认账的（gp44 / gp57 / gp60），这一页的行一个都不混进去；
       观感与仓库块 / worktree 块同族靠 46-css.js 的分组选择器共用声明；行内小记号
       仍复用没人按个数认的小类（dsh-git-repo-mark / -glyph、dsh-git-tmain/-tname/
       -tsub、dsh-git-ab、dsh-git-repo-caret）—— 25-worktree.js 的同一条先例。 */

    /* 折叠账（按工作区分键的 localStorage 一格）：{ [工作区]: { [仓库]: true } }。
       键用 repoGroupPath（24-repos.js）归一过的工作区 / 仓库路径 —— 同一个目录
       两种写法（尾斜杠）要落进同一格。 */
    const WTREE_FOLD_KEY = 'dsh.git-idea.wtree-folded'
    let wtreeFoldMap = null

    function wtreeFoldAll() {
      if (wtreeFoldMap !== null) return wtreeFoldMap
      const parsed = readStoredJSON(WTREE_FOLD_KEY, null)
      wtreeFoldMap = parsed != null && typeof parsed === 'object' && Array.isArray(parsed) !== true ? parsed : {}
      return wtreeFoldMap
    }

    function wtreeGroupFolded(workspace, repo) {
      const one = wtreeFoldAll()[repoGroupPath(workspace)]
      return one != null && typeof one === 'object' && one[repoGroupPath(repo)] === true
    }

    function wtreeSetGroupFolded(workspace, repo, folded) {
      const map = wtreeFoldAll()
      const wsKey = repoGroupPath(workspace)
      const repoKey = repoGroupPath(repo)
      const current = map[wsKey] != null && typeof map[wsKey] === 'object' ? Object.assign({}, map[wsKey]) : {}
      if (folded === true) current[repoKey] = true
      else delete current[repoKey]
      const next = Object.assign({}, map)
      /* 空的工作区一并删键：账不积灰。 */
      if (Object.keys(current).length > 0) next[wsKey] = current
      else delete next[wsKey]
      wtreeFoldMap = next
      writeStoredJSON(WTREE_FOLD_KEY, next)
    }

    /* 单组读取失败的人话（65-worktree.js 的 ignoredFailureReason 同一折法的客户端半）：
       noGit 说机器、read-failed 说通道（note 是当时那条 Error 的原话）、其余按
       「这里可能不是 git 仓库」答。 */
    function wtreeGroupFailText(group) {
      if (group != null && group.noGit === true) return '这台机器上找不到 git：读取要调用 git'
      const said = group != null ? text(group.note) : ''
      if (said.length > 0) return said
      if (group != null && text(group.error) === 'not-a-repository') return '无法读取 worktree（这里可能不是 git 仓库）'
      return '读取失败'
    }

    /* props：data（面板级 git/worktree-tree 读数）、refs（生效仓库那份分支表 ——
        徽章免费查）、effective（生效仓库路径）、workspace（会话工作区路径 —— 折叠
        账的分键）、labels（repoLabelMap 的短名表 —— 组头与仓库清单同名同标）、
        onPick(path)（单击行：80-panel.js 传 repoSingle('changes', …)）。 */
    function WtreePane(props) {
      const data = props.data
      const refs = props.refs
      const workspace = text(props.workspace)
      const labels = props.labels != null && typeof props.labels === 'object' ? props.labels : {}
      const pick = typeof props.onPick === 'function' ? props.onPick : null
      /* 折叠账本体住在 localStorage（上面的模块层），组件里只留一个计数器触发
         重画 —— 与「折叠跟着组件挂载走」的仓库块不同：这一页的组多、跨刷新还在
         看的是同一批仓库，记忆更值钱（任务口径：折叠态记忆）。 */
      const [foldVer, setFoldVer] = React.useState(0)
      const toggleFold = function (repo) {
        wtreeSetGroupFolded(workspace, repo, wtreeGroupFolded(workspace, repo) !== true)
        setFoldVer(function (n) { return n + 1 })
      }

      /* 分支树的 metaOf 同一份账（25-worktree.js 同款）：本地分支短名 → ahead /
         behind / upstream。refs 还没读到时账是空的，徽章自然不画。 */
      const metaOf = {}
      if (refs != null && refs.ok === true && Array.isArray(refs.local)) {
        for (let i = 0; i < refs.local.length; i += 1) metaOf[text(refs.local[i].data)] = refs.local[i]
      }

      const groups = data != null && Array.isArray(data.groups) ? data.groups : []

      /* 一行工作树（主目录行 / 链接行同一副骨架）：行内按 isEffective 亮 ● 与高亮
         底色，生效组且带分支名的行才查 ↑↓ 徽章；pick 为空（理论不上屏）时行不挂
         单击。 */
      const rowEl = function (group, row) {
        const path = text(row.path)
        const branch = text(row.branch)
        const head = text(row.head)
        const detached = row.detached === true
        const bare = row.bare === true
        const prunable = row.prunable === true
        const locked = row.locked === true
        const isMain = row.isMain === true
        const isHit = row.isEffective === true
        /* bare 没有工作区、prunable 目录已丢失 —— 两类不可点；locked 只是 git 侧
           上锁，目录还在，退灰但可点。 */
        const dead = bare === true || prunable === true
        const dimmed = dead === true || locked === true
        const tip = [path, '归属仓库：' + text(group.repo)]
        if (head.length > 0) tip.push('HEAD ' + head)
        if (isMain === true) {
          tip.push('主目录：这个仓库的主工作区（当前检出：'
            + (detached === true ? '游离 HEAD' : (branch.length > 0 ? branch : '未知')) + '）')
        }
        if (pick !== null && dead !== true) {
          tip.push('单击 = 把生效仓库切到这个目录（与变更页 worktree 块同一手势：只切查看的仓库，不 checkout、不切分支、不动任何工作区）')
        }
        if (detached === true) tip.push('游离 HEAD：这个工作树停在具体提交上、不站分支 —— 小字给的是短哈希')
        if (bare === true) tip.push('bare 仓库：只有版本库没有工作区，不可点')
        if (prunable === true) {
          tip.push('目录已丢失，可 prune 清理' + (text(row.pruneReason).length > 0 ? '（' + text(row.pruneReason) + '）' : ''))
        }
        if (locked === true) tip.push('已锁定' + (text(row.lockReason).length > 0 ? '：' + text(row.lockReason) : ''))
        /* ↑↓ 徽章：生效仓库那一组、有分支名的行才查 refs（免费），查不到不画。 */
        const badgeable = isHit === true && branch.length > 0
        const meta = badgeable === true && metaOf[branch] !== undefined ? metaOf[branch] : null
        const ahead = meta != null && typeof meta.ahead === 'number' ? meta.ahead : 0
        const behind = meta != null && typeof meta.behind === 'number' ? meta.behind : 0
        const upstream = meta == null ? '' : text(meta.upstream)
        if (upstream.length > 0) tip.push(trackTitle(ahead, behind) + ' · ' + upstream)
        const label = detached === true
          ? (head.length > 0 ? head.slice(0, 7) : '游离 HEAD')
          : (bare === true ? 'bare' : (branch.length > 0 ? branch : '——'))
        return h('div', {
          key: 'wtr:' + text(group.repo) + '>' + path,
          className: 'dsh-git-wtree-row'
            + (isHit === true ? ' dsh-git-wtree-hit' : '')
            + (dimmed === true ? ' dsh-git-wtree-gone' : '')
            + (dead === true ? ' dsh-git-wtree-dead' : ''),
          title: tip.join('\n'),
          onClick: pick !== null && dead !== true
            ? function () { pick(path) }
            : undefined,
        },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }, isHit === true ? '●' : ''),
          h('span', { key: 'g', className: 'dsh-git-repo-glyph' },
            h(Icon, { name: isMain === true ? 'repo' : 'wtlink', size: 12 })),
          h('span', { key: 'n', className: 'dsh-git-tmain' },
            h('span', { className: 'dsh-git-tname' }, repoBaseName(path)),
            h('span', { className: 'dsh-git-tsub' + (detached === true || branch.length > 0 ? '' : ' dsh-git-tsub-none') }, label)),
          isMain === true
            ? h('span', {
              key: 'now', className: 'dsh-git-wtree-now',
              title: '主目录：主工作区（当前检出：'
                + (detached === true ? '游离 HEAD' : (branch.length > 0 ? branch : '未知')) + '）',
            }, '当前')
            : null,
          h('span', { key: 'p', className: 'dsh-git-wtree-path' }, path),
          h('span', { key: 'r', className: 'dsh-git-wtree-right' },
            behind > 0 ? h('span', { key: 'b', className: 'dsh-git-ab dsh-git-ab-in', title: '落后上游 ' + String(behind) + ' 个提交 —— 需要拉取' }, '↓' + (behind > 99 ? '99+' : String(behind))) : null,
            ahead > 0 ? h('span', { key: 'a', className: 'dsh-git-ab dsh-git-ab-out', title: '领先上游 ' + String(ahead) + ' 个提交 —— 需要推送' }, '↑' + (ahead > 99 ? '99+' : String(ahead))) : null,
            prunable === true ? h('span', { key: 'pr', className: 'dsh-git-wt-mark', title: '目录已丢失，可 prune 清理；本版没有 prune 动作' }, '⚠') : null,
            locked === true ? h('span', { key: 'lk', className: 'dsh-git-wt-mark', title: '已锁定' + (text(row.lockReason).length > 0 ? '：' + text(row.lockReason) : '') }, '🔒') : null))
      }

      const parts = []
      /* 页首一行说明（空态也不空），右侧挂刷新中的轻提示（命令页同一格调）。 */
      parts.push(h('div', { key: 'wtree-intro', className: 'dsh-git-wtree-intro' },
        h('span', { key: 't' }, '工作树全景：每个仓库一组 —— 主目录与它经 git worktree add 建出的链接工作树；单击行 = 把生效仓库切到该行'),
        data != null && data.refreshing === true
          ? h('span', { key: 'rf', className: 'dsh-git-wtree-refreshing', title: '后台正在重读；手里这份清单先照旧画' }, '刷新中…')
          : null))

      if (data == null) {
        parts.push(h('div', { key: 'wtree-loading', className: 'dsh-git-pane dsh-git-dim' }, '正在读取仓库清单…'))
        return h('div', { className: 'dsh-git-wtree' }, parts)
      }
      /* 读失败且手里没有清单可画：错误原话照实说（折成空图就成了「没有仓库」，
          那是另一个问题的答案 —— 命令页首读失败的同一处理）。 */
      if (data.ok !== true && groups.length === 0) {
        const said = text(data.error)
        parts.push(h('div', { key: 'wtree-error', className: 'dsh-git-pane dsh-git-error', style: { whiteSpace: 'pre-wrap' } },
          said.length > 0 ? said : '读不了仓库清单'))
        return h('div', { className: 'dsh-git-wtree' }, parts)
      }
      /* 空态（会话工作区不是仓库、也没扫到 / 登记过任何仓库）：只给文字说明，
         不挂仓库清单入口（任务口径）。 */
      if (groups.length === 0) {
        parts.push(h('div', { key: 'wtree-empty', className: 'dsh-git-pane dsh-git-dim' },
          '这里还没有可显示的仓库：会话工作区不是 git 仓库，也没有扫到或登记过仓库'))
        return h('div', { className: 'dsh-git-wtree' }, parts)
      }
      /* 手里有清单、这次读失败（后台刷新读不动）：清单照常能用，错误挂在上方，
         下一次读成了它自己消失（命令页同一条规矩）。 */
      if (data.ok !== true) {
        parts.push(h('div', { key: 'wtree-err', className: 'dsh-git-pane dsh-git-error', style: { whiteSpace: 'pre-wrap' } }, text(data.error)))
      }

      const list = []
      for (let g = 0; g < groups.length; g += 1) {
        const group = groups[g]
        if (group == null) continue
        const repoPath = text(group.repo)
        const rows = Array.isArray(group.rows) ? group.rows : []
        const folded = wtreeGroupFolded(workspace, repoPath)
        const rowsOut = []
        rowsOut.push(h('div', {
          key: 'wtg:' + repoPath,
          className: 'dsh-git-wtree-ghead',
          title: repoPath + (folded === true ? '\n单击展开这一组' : '\n单击折叠这一组（折叠状态记在这个浏览器里）'),
          onClick: function () { toggleFold(repoPath) },
        },
          h('span', { key: 'c', className: 'dsh-git-repo-caret' + (folded === true ? ' dsh-git-repo-caret-off' : '') },
            h(Icon, { name: 'down', size: 10 })),
          h('span', { key: 'g', className: 'dsh-git-repo-glyph' }, h(Icon, { name: 'repo', size: 12 })),
          h('span', { key: 'n', className: 'dsh-git-wtree-gname' }, repoShortName(labels, repoPath)),
          group.ok === true
            ? h('span', { key: 'k', className: 'dsh-git-repo-dim', title: '工作树总数（主目录 + 链接工作树）' }, String(rows.length) + ' 个工作树')
            : h('span', { key: 'k', className: 'dsh-git-repo-dim' }, '读取失败')))
        if (folded !== true) {
          if (group.ok === true) {
            for (let i = 0; i < rows.length; i += 1) {
              const row = rows[i]
              if (row == null) continue
              rowsOut.push(rowEl(group, row))
            }
            if (rows.length === 0) {
              rowsOut.push(h('div', { key: 'wtge:' + repoPath, className: 'dsh-git-wtree-gnote' }, '没有工作树'))
            }
          } else {
            rowsOut.push(h('div', {
              key: 'wtge:' + repoPath,
              className: 'dsh-git-wtree-gnote',
              title: wtreeGroupFailText(group),
            }, wtreeGroupFailText(group)))
          }
        }
        list.push(h('div', { key: 'wtgroup:' + repoPath, className: 'dsh-git-wtree-group' }, rowsOut))
      }
      parts.push(h('div', { key: 'wtree-list', className: 'dsh-git-wtree-list' }, list))
      return h('div', { className: 'dsh-git-wtree' }, parts)
    }
