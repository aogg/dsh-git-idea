    /* ── 文件（与目录）行的右键菜单 ──

        PhpStorm 的文件树每一行都有一个上下文菜单：与本地比较、打开源文件、显示
        差异、还原 / 优选 / 删除所选更改、从修订中获取、显示历史记录。这个面板的
        五棵文件树（单提交详情、多选合并视图、差异右列的 commit / changes 两路、
        变更页）都从这一份构造菜单 —— 行那一侧只负责把「右键的是哪一行」拼成
        target，动作全部由面板经 acts 递进来，菜单本体不碰状态、不发请求。

        target（fileMenuTarget 的产出）：
          listKind — 'commit' 历史提交文件树（单提交详情 / 差异右列 commit 路）
                     'range'  多选合并视图（一段提交的合计清单）
                     'worktree' 变更页与差异右列的 changes 路
          repo     — 这一行属于哪个仓库（多仓库分组的组仓库；'' = 生效仓库）
          rev      — 这棵文件树所属的提交（range = selSpan.head，整段最新一条）
          paths    — [{path, dir, untracked, staged, conflict, from, raw}]；右键
                     一次只落在一行上，数组留成清单形是为了与面板的既有动作
                     （吃 paths 数组的那批 RPC）同一个口径，目录也算一条
                     pathspec（git 的聚合补丁本来就认目录）。

        置灰用 disabled + title 说原因（提交行右键菜单 ctxCommitItems 的既有做法）：
        一项点不动的时候，「为什么」必须就写在悬停里，而不是让读者试出来。 */

    /* 行那一侧拼 target 的唯一入口：五棵树各带自己的 listKind / rev，路径一条。
       extra 里放这一行已知的标记（dir/untracked/staged/conflict/from/raw），菜单
       的启用矩阵全从这些标记读 —— 不再去猜「这行是什么」。 */
    function fileMenuTarget(listKind, rev, repo, path, extra) {
      const one = extra == null ? {} : extra
      return {
        listKind: listKind,
        repo: text(repo),
        rev: text(rev),
        paths: [Object.assign({ path: path, dir: false }, one)],
      }
    }

    /* 菜单项本体。返回元素数组（button + 分隔线），顺序照 PhpStorm：
       与本地比较、打开源文件、显示差异 | 还原、优选、删除 | 从修订中获取、显示历史。
       acts（面板递进）：
          busy        — 面板级在忙，全部动作跟着置灰（ctxCommitItems 的 !canAct 同款）
          arm / setArm— 两段式确认的当前武装键（分支删除的 ctxArm 同一条交互）
          canOpenFile — 「打开源文件」的三道守卫预检结果（55-diff.js viewFileGuard）
          openWhy     — 预检没过时 title 里那句人话
          historyOk   — 「显示历史记录」的仓库核对（多仓库分组 vs 生效仓库）
          historyWhy  — 核对没过时 title 里那句人话
          其余 on*    — 动作本体，由面板接各自的 RPC / 视图切换。 */
    function fileMenuItems(target, acts) {
      const listKind = target != null ? target.listKind : ''
      const inHistory = listKind === 'commit' || listKind === 'range'
      const first = target != null && Array.isArray(target.paths) && target.paths.length > 0 ? target.paths[0] : null
      const isDir = first != null && first.dir === true
      const isUntracked = first != null && first.untracked === true
      /* git 把没跟踪的目录折叠成一条以 / 结尾的路径：路径尾的 / 才是「这是目录」的
         硬凭据（untracked 单独出现时也可能是一个目录的折叠条）。两者分开算 ——
         「显示差异」只对折叠的未跟踪目录置灰（文件有 --no-index 可读），删除/
         历史只看「未跟踪与否」。 */
      const isUntrackedDir = first != null && isUntracked === true
        && (isDir === true || text(first.path).slice(-1) === '/')
      const onePath = function () { return first == null ? '' : text(first.path) }
      const pathsArg = function () {
        /* clean / revert / checkout 的 pathspec：目录折叠条目的尾 / 去掉 ——
           `git clean -fd -- dir/` 与 `-- dir` 等价，但落进「命令」页的记录里
           光秃一条路径更好读。 */
        const out = []
        const list = target != null && Array.isArray(target.paths) ? target.paths : []
        for (let i = 0; i < list.length; i += 1) {
          const path = text(list[i].path)
          if (path.length === 0) continue
          out.push(path.replace(/\/+$/, ''))
        }
        return out.length > 0 ? out : [onePath()]
      }
      const said = isDir === true ? '这个目录' : '这个文件'
      const whyBusy = '当前有操作在跑，等它结束'
      const busyBlock = acts != null && acts.busy === true
      /* 两段式：第一次点只武装（acts.setArm(key)），第二次点才动手。键串里带上
         路径——武装之后读者换了一行再右键，旧武装对不上新键，自然失效。 */
      const armKeyOf = function (key) { return 'file:' + key + ':' + onePath() }
      const armedOf = function (key) {
        return acts != null && acts.arm === armKeyOf(key)
      }
      const clickArm = function (key, run) {
        return function (event) {
          if (event != null && typeof event.stopPropagation === 'function') event.stopPropagation()
          if (acts == null || typeof acts.setArm !== 'function') return
          if (armedOf(key) !== true) { acts.setArm(armKeyOf(key)); return }
          acts.setArm('')
          if (typeof acts.setCtxMenu === 'function') acts.setCtxMenu(null)
          run()
        }
      }
      const clickPlain = function (run) {
        return function (event) {
          if (event != null && typeof event.stopPropagation === 'function') event.stopPropagation()
          if (acts != null && typeof acts.setCtxMenu === 'function') acts.setCtxMenu(null)
          run()
        }
      }
      const item = function (key, label, title, options) {
        const opts = options == null ? {} : options
        return h('button', {
          key: key, type: 'button', className: 'dsh-git-menu-item'
            + (opts.danger === true ? ' dsh-git-menu-danger' : ''),
          disabled: opts.disabled === true,
          title: title,
          onClick: opts.onClick,
        }, label)
      }

      /* ── 第一组：看 ── */

      /* 与本地比较：新 diff 目标 git diff <rev> -- <路径>。只对提交那两棵树有意义
         —— 工作区里的文件本来就在「本地」，自己跟自己比是一句废话，整项不画。 */
      const compareLocal = inHistory !== true ? null
        : item('compare-local', '与本地比较',
          '与本地比较：git diff <提交> -- ' + (isDir === true ? '这个目录' : '这个文件')
          + ' —— 看' + said + '在提交里的版本和工作区现在的版本差在哪'
          + (isDir === true ? '（目录按路径聚合，里面所有改动一并出补丁）' : ''),
          { disabled: busyBlock, onClick: clickPlain(function () { if (typeof acts.onCompareLocal === 'function') acts.onCompareLocal(pathsArg()) }) })

      /* 打开源文件：只认文件行 —— 目录没有「源文件」可比。三道守卫（官方文件页
         在不在、会话工作区读没读出来、仓库是否越出工作区）由面板用 viewFileGuard
         预检好，结果在 acts.canOpenFile / acts.openWhy。 */
      const openFile = item('open-file', '打开源文件',
        isDir === true
          ? '目录没有对应的源文件 —— 展开后对里面的文件用'
          : (acts != null && acts.canOpenFile === true
            ? '在右侧文件页打开工作区里的这个文件（是当前内容，不是提交里的那一版）'
            : '打不开：' + (acts != null && typeof acts.openWhy === 'string' && acts.openWhy.length > 0 ? acts.openWhy : '右侧文件页现在不可用')),
        {
          disabled: isDir === true || busyBlock || acts == null || acts.canOpenFile !== true,
          onClick: clickPlain(function () { if (typeof acts.onOpenFile === 'function') acts.onOpenFile(pathsArg()) }),
        })

      /* 显示差异：commit/range 接各自的既有差异（父..该提交 / base..head），
         worktree 接 worktree/staged/untracked 三态；未跟踪目录没有可比较的版本
         （git 还没见过里面的文件，--no-index 对目录也讲不通），置灰说原因。 */
      const showDiffWhy = isUntrackedDir === true
        ? '未跟踪的目录还没有可比较的版本 —— 展开后对里面的文件用'
        : (inHistory === true
          ? '显示差异：' + said + '在这段提交里的合计改动（' + said + '整行点开是同一个视图）'
          : '显示差异：' + said + '现在的改动（已暂存/未暂存/未跟踪按行上的状态走）')
      const showDiff = item('show-diff', '显示差异', showDiffWhy,
        {
          disabled: isUntrackedDir === true || busyBlock,
          onClick: clickPlain(function () { if (typeof acts.onShowDiff === 'function') acts.onShowDiff(first) }),
        })

      /* ── 第二组：改 ── */

      /* 还原所选更改。提交那两棵树：新 RPC git/revert-paths（show 补丁反向
         apply）—— 撤销的是「这个提交对这些路径做的改动」，不是「取回提交里的
         版本」（那是下一组的「从修订中获取」）；本地内容跟提交对不上时 Host 会
         按内容三方合，真合不上留冲突标记。工作区：既有 git/restore（变更页工具条
         同一条路）。都是破坏性，两段式。未跟踪的行没有「改动」可还原（git restore
         会以 pathspec 不匹配拒绝），置灰并把人支去「删除所选更改」。 */
      const revertTitle = busyBlock === true ? whyBusy
        : (listKind === 'worktree' && isUntracked === true
          ? '未跟踪的文件没有改动可还原 —— 要把它删掉用「删除所选更改」'
          : (armedOf('revert') === true
            ? '再点一次执行：撤销' + (inHistory === true ? '这个提交对' + said + '做的改动' : '这段提交对' + said + '做的合计改动')
              + '（反向补丁应用到工作区和索引；本地改动会被覆盖，不可撤销）'
            : (inHistory === true
              ? '还原所选更改：撤销' + (listKind === 'range' ? '这段提交' : '这个提交') + '对' + said + '做的改动（反向补丁；破坏性，需再点一次确认）'
              : '还原所选更改：git restore --source=HEAD --staged --worktree —— 索引和工作区一起回到 HEAD，被删的文件也恢复（破坏性，需再点一次确认）')))
      const revert = item('revert', '还原所选更改', revertTitle,
        {
          danger: armedOf('revert') === true,
          disabled: busyBlock || (listKind === 'worktree' && isUntracked === true),
          onClick: clickArm('revert', function () { if (typeof acts.onRevert === 'function') acts.onRevert(pathsArg()) }),
        })

      /* 优选所选更改：拣选只对提交生效 —— 工作区里的行没有「提交」可拣。 */
      const cherry = item('cherry-pick', '优选所选更改',
        listKind === 'worktree'
          ? '拣选只对提交生效 —— 先在历史里选中提交（变更页没有可拣的东西）'
          : '优选所选更改：cherry-pick，把'
            + (listKind === 'range' ? '这段选区里的提交逐条' : '这个提交')
            + '应用到当前分支（最旧的先落）',
        {
          disabled: listKind === 'worktree' || busyBlock,
          onClick: clickPlain(function () { if (typeof acts.onCherryPick === 'function') acts.onCherryPick() }),
        })

      /* 删除所选更改。提交里：删除的是「提交」而不是更改 —— 那是提交行右键菜单的
         活，这里置灰说清分工。工作区：只对未跟踪的行可用（新 RPC git/clean-paths，
         git clean -fd，找不回，危险红 + 两段式）；已跟踪的改动请走「还原所选更改」。 */
      const cleanWhy = inHistory === true
        ? '提交里的更改请用「还原所选更改」；删除整条提交在提交行的右键菜单里'
        : (isUntracked === true
          ? (armedOf('clean') === true
            ? '再点一次执行：git clean -fd 删掉这些未跟踪的' + (isDir === true ? '目录（连同里面的文件）' : '文件') + ' —— 找不回'
            : '删除所选更改：git clean -fd 删掉这些未跟踪的' + (isDir === true ? '目录（连同里面的文件）' : '文件')
              + '（已忽略的不动）；找不回，需再点一次确认')
          : '只对未跟踪的文件/目录可用 —— 已跟踪的改动请用「还原所选更改」')
      const clean = item('clean', '删除所选更改', cleanWhy,
        {
          /* 危险红跟着「可用」走：这一项只有未跟踪的行才点得动，而 clean 找不回
             —— 可用即危险，不等武装（武装后 title 换成「再点一次执行」）。 */
          danger: listKind === 'worktree' && (isUntracked === true || isUntrackedDir === true),
          disabled: inHistory === true || busyBlock || (listKind === 'worktree' && isUntracked !== true && isUntrackedDir !== true),
          onClick: clickArm('clean', function () { if (typeof acts.onClean === 'function') acts.onClean(pathsArg()) }),
        })

      /* ── 第三组：提交与历史 ── */

      /* 从修订中获取：git checkout <rev> -- <路径>，提交里的版本覆盖工作区并进
         索引 —— 会丢本地改动，两段式。工作区没有「修订」可取，整项不画。 */
      const getFromRev = inHistory !== true ? null
        : item('get-from-rev',
          armedOf('get') === true ? '确认从修订中获取' : '从修订中获取',
          busyBlock === true ? whyBusy
            : (armedOf('get') === true
              ? '再点一次执行：git checkout <提交> -- ' + said + ' —— 用提交里的版本覆盖工作区并放进索引，本地的改动会丢弃'
              : '从修订中获取：git checkout <提交> -- ' + said + '，把提交里那一版取回来（覆盖工作区并进索引；破坏性，需再点一次确认）'),
          {
            danger: armedOf('get') === true,
            disabled: busyBlock,
            onClick: clickArm('get', function () { if (typeof acts.onGetFromRev === 'function') acts.onGetFromRev(pathsArg()) }),
          })

      /* 显示历史记录：把路径设进历史页的路径筛选并切过去（筛选变化自动清多选，
         面板那条 effect 管）。未跟踪的行 git 从没见过，没有历史可言，置灰；
         多仓库分组里不属于生效仓库的行，历史页显示的是生效仓库，也置灰说去哪切。 */
      const historyWhy = acts != null && typeof acts.historyWhy === 'string' && acts.historyWhy.length > 0
        ? acts.historyWhy : '先切到那个仓库再看'
      const history = item('history', '显示历史记录',
        isUntracked === true || isUntrackedDir === true
          ? 'git 还没见过这个路径（未跟踪），它还没有历史'
          : (acts != null && acts.historyOk !== true
            ? '这个文件属于另一个仓库，历史页显示的是生效仓库 —— ' + historyWhy
            : '只看' + said + '的历史（切到历史页，并把' + said + '设为路径筛选）'),
        {
          disabled: isUntracked === true || isUntrackedDir === true || busyBlock
            || acts == null || acts.historyOk !== true,
          onClick: clickPlain(function () { if (typeof acts.onShowHistory === 'function') acts.onShowHistory(pathsArg()) }),
        })

      const out = []
      if (compareLocal !== null) out.push(compareLocal)
      out.push(openFile, showDiff)
      out.push(h('div', { key: 'sep-1', className: 'dsh-git-menu-sep' }))
      out.push(revert, cherry, clean)
      if (getFromRev !== null) {
        out.push(h('div', { key: 'sep-2', className: 'dsh-git-menu-sep' }))
        out.push(getFromRev)
      }
      out.push(h('div', { key: 'sep-3', className: 'dsh-git-menu-sep' }))
      out.push(history)
      return out
    }
