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
       免费查，查不到就不画 —— worktree 块的往返只有 git/worktrees 这一条。

       v1.2 起块头行下面多一行「主目录」（props.wtMain，git/wt-main 的答复）：本目录
       的 .git 是链接文件、git 又读不动主仓库那一头时（主仓库被删/搬走），worktree
       清单必然是空的，面板原来只能给一行「无法读取」—— 这一行补上「这个目录其实
       是谁的一份链接工作区」与两条出路（打开主目录、去配置）。它插在折叠判断**之前**
       是有意的：broken 的那一刻恰恰是清单读不出来的时候，若跟着折叠/失败分支一起
       消失，读者就只剩一句读不动的灰字。类名另起 dsh-git-wt-mainrow —— dsh-git-wt-row
       的个数是测试按清单行认的（gp57/gp60），这一行是身份行，不进那个账。

       v1.3 起块底多一行「＋ 新建 worktree」动作行（样式对齐仓库块「＋ 添加目录」
       那行的写法，类名 dsh-git-wt-add、声明与 .dsh-git-repo-add 共组），读取中 /
       读取失败 / 空清单 / 有清单四种状态都在，与列表并存；折叠态不显示（收进折叠
       里）。点击在块内展开一张内联表单（下面的 WorktreeAddForm，类名 dsh-git-wt-form
       前缀族 —— 刻意不碰 dsh-git-wt-row：那一个类的个数是 gp57/gp60 按清单行认的
       账，表单行混进去就会把账搅乱；再点动作行或「取消」收起，展开态不影响原清单
       行的渲染）。三种模式：新建分支（-b，「起点」可空、以远端分支为起点时 git
       自动建立跟踪，不需要跟踪开关）、检出分支（datalist 提示 = 本地 ∪ 远端分支，
       远端分支走 git 的 dwim：检出 origin/x 自动建同名本地跟踪分支；已被其他
       worktree 占用的本地分支照常列出但标注「已占用」）、游离检出（--detach，起点
       默认 HEAD）。提交前用已加载的数据做免费预检（绝对路径 / 空字段 / 目录撞已
       登记 worktree / 检出已被占用的本地分支 / 新分支撞已有本地分支名；勾了
       「强制覆盖」目录与分支冲突全部放行，空字段与相对路径照拦 —— git 也填不了），
       预检不过红字拦下、请求不出门；过了才发 props.onWorktreeAdd（80-panel.js 统一
       发 git/worktree-add），失败把 host 的 stderr 首行折成人话（noGit /
       sandboxDenied 各有专门话术，65-worktree.js 的 ignoredFailureReason 同一折法），
       成功收起表单；「创建后切到新工作区」勾着时：变更页切 onPickWorktree(路径)，
       历史页按答复清单里那个工作区实际站着的分支调 onPickBranch（游离 / 无分支时
       onPickWorktree，没给就只刷新 —— bumpData 已由 80-panel.js 那侧做过）。

       v1.4 起有清除能力（总开关 = props.onWorktreeRemove 给没给 —— 调用方没传时
       整段 UI 一个都不出现，行为与 v1.3 逐字节相同，与 onWorktreeAdd 同一先例）：
       「清除」是删掉整个工作区目录（git worktree remove），破坏性动作，菜单项全按
       armed 二段确认先例做（第一次点变红字「确认清除」，再点才发 —— 80-panel.js
       分支删除菜单的 ctxArm 同一条）：
         · 游离（detached === true）与目录已失联（prunable === true）的行右键弹行
           菜单（「清除这个 worktree」）；bare 没有工作区可删、🔒 locked 的 git 会拒
           （fatal: is locked），都不挂右键，locked 的 tooltip 说明原因；不游离不
           失联的行一个手势都不加。
         · 块头行右端多一枚「…」触发器（dsh-git-wt-more，单击开块级菜单、click 不
           冒泡进折叠 toggle），块头整行右键也开同一张菜单（contextmenu 事件本来就
           不触发 onClick，折叠 toggle 天然不受扰）—— 菜单里「一键清除（N）」，
           N = 游离 + 失联的人数，N=0 置灰并在 title 说明没有可清的；菜单底部一行
           小字说清除语义（删除该工作区目录，git 侧登记一并移除；不碰主工作区）。
         · 执行体 props.onWorktreeRemove（80-panel.js 统一发 git/worktree-remove +
           bump 重读，与 worktreeAdd 同一条手势）；答复清单客户端不再自己刷 ——
           bump 已推 freshAt，读 effect 按新账重读。一键清除逐个发、不连坐：单个
           失败不影响其余，最后把「成了几个、谁没成、为什么」一次汇总进块内 note
           （worktree 块辅助信息的格调：它的失败不上面板顶部错误横幅，与「读取
           失败」同一落点；红/绿两色，点一下收起）。默认不带 --force：有未提交
           改动 git 会拒，stderr 首行折成人话（wtRemoveFailureText，add 的折法）
           并说明要强删得手动 git worktree remove --force —— 面板不给强删入口，
           保守；宿主进程还是旧版（RPC 不在册，is not registered）时照远端表
           remoteHostOld 的先例说「重启 DSH 加载新版宿主」。
         · 菜单浮层复用 80-panel.js 的 ContextMenu（拼接 bundle 全局函数，render 期
           都在；光标锚定、点外/Esc/滚动/resize 关闭白拿），状态（开合、武装、
           busy、note）由 WorktreeBox 本地持有 —— 浮层样式与面板右键菜单同款，不
           另造第二套；坐标的 transform 换算抄 80-panel.js ctxMenuPos 同一套
           （wtMenuPos，panelNode 是 10-state.js 的全局）。 */
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
      /* v1.3 的「快速创建」表单开没开：只管收与展，字段住在 WorktreeAddForm 自己
         身上（每次展开都是一张新表单，值不跨开合保留 —— 与仓库块「添加目录」的
         输入行同一个约定）。 */
      const [adding, setAdding] = React.useState(false)

      /* ── v1.4 清除能力的本地状态（hooks 必须无条件调用，状态照建；画不画全看
         下面的 canRemove —— onWorktreeRemove 没传时整段 UI 一个都不出现，渲染
         结果与 v1.3 逐字节相同）──
         menu：块级菜单的开合（null = 关着；{kind:'row'|'head', path, x, y}），浮层
         是 80-panel.js 的 ContextMenu；arm：菜单项的 armed 二段确认（键 'row:<path>'
         与 'batch'，与 80-panel.js ctxArm 同一条先例：开新菜单先作废上一次的武装）；
         busy：清除在飞（菜单项一并禁用）；note：块内辅助信息格 —— 清除的成败汇总，
         红字/绿字各一格，不上面板顶部错误横幅（worktree 块辅助信息的格调）。 */
      const [menu, setMenu] = React.useState(null)
      const [arm, setArm] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)

      /* 仓库一换，对着旧仓库说的话（note）、上了膛的菜单项与开着的菜单一并放下 ——
         与 80-panel.js applyRepo 清 ctxMenu 同一条规矩。 */
      React.useEffect(function () {
        setNote(null); setArm(''); setMenu(null)
      }, [effective])

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

      /* ── v1.4 清除的总开关与「可清除」账本 ──
          canRemove：调用方给了 onWorktreeRemove 才有这一段（行右键、块头「…」、
          两张菜单，给没给决定整个 v1.4 UI 出不出现）。removable：可清除行的路径
          清单 —— 游离（detached）或目录已失联（prunable）的链接工作区；bare 没有
          工作区可删，🔒 locked 的 git 会拒（fatal: is locked），都不算。行右键挂
          不挂、块头「一键清除（N）」的人数，吃的是同一本账。 */
      const canRemove = typeof props.onWorktreeRemove === 'function'
      const removable = []
      if (canRemove && data != null && data.ok === true) {
        for (let i = 0; i < list.length; i += 1) {
          const one = list[i]
          if (one == null || one.bare === true || one.locked === true) continue
          if (one.detached === true || one.prunable === true) removable.push(text(one.path))
        }
      }

      /* 菜单的坐标：ContextMenu 落 position:fixed 的视口坐标，但面板根节点在宽度
         记忆过时带着 translateX(-50%) 的 transform —— 带 transform 的祖先成了
         fixed 后代的包含块，那时坐标得换成「相对面板」的那一套，否则错位一个面板
         左上角（80-panel.js ctxMenuPos 同一套换法，wtMenuPos 在文件尾部：panelNode
         是 10-state.js 的全局，量不到就原样用视口坐标，与那边的兜底一致）。 */
      const menuPos = menu === null ? { left: 0, top: 0 } : wtMenuPos(menu.x, menu.y)

      /* 开菜单（行 / 块头两处入口）：拦掉浏览器自带菜单的规矩与提交行/分支行同一
         条（preventDefault + stopPropagation），先作废上一次的武装再开。右键不触发
         onClick，块头的折叠 toggle 天然不受扰。 */
      const openMenu = function (kind, path, event) {
        if (event != null) {
          event.preventDefault()
          event.stopPropagation()
        }
        setArm('')
        setMenu({
          kind: kind, path: path,
          x: event != null && typeof event.clientX === 'number' ? event.clientX : 0,
          y: event != null && typeof event.clientY === 'number' ? event.clientY : 0,
        })
      }

      /* ── 清除的执行：逐个发，不连坐，结果一次汇总 ──
          每个目标一发 props.onWorktreeRemove（80-panel.js 统一发 git/worktree-remove
          + bump 重读，与 worktreeAdd 同一条手势）；单个失败不影响其余，全部发完后
          把「成了几个、谁没成、为什么」一次写进块内 note（红字/绿字）。清的是当前
          生效仓库时菜单的确认文案已额外警告过（下面 rowMenuItems），这里照单执行。 */
      const runClear = function (targets) {
        if (busy === true || canRemove !== true || targets.length === 0) return
        setBusy(true)
        setNote(null)
        let index = 0
        const doneNames = []
        const failed = []
        const finish = function () {
          setBusy(false)
          if (failed.length === 0) {
            setNote({ ok: true, text: targets.length === 1
              ? '已清除 worktree ' + repoBaseName(targets[0])
              : '已清除 ' + String(targets.length) + ' 个 worktree：'
                + targets.map(function (one) { return repoBaseName(one) }).join('、') })
            return
          }
          const lines = []
          for (let i = 0; i < failed.length; i += 1) {
            lines.push('· ' + repoBaseName(failed[i].path) + ' —— ' + failed[i].why)
          }
          setNote({ ok: false, text: (doneNames.length > 0
            ? '清除了 ' + String(doneNames.length) + ' 个（' + doneNames.join('、') + '），'
              + String(failed.length) + ' 个没成：'
            : '一个都没清成：') + '\n' + lines.join('\n') })
        }
        const step = function () {
          if (index >= targets.length) { finish(); return }
          const path = targets[index]
          index += 1
          props.onWorktreeRemove({ path: path }).then(function () {
            doneNames.push(repoBaseName(path))
            step()
          }, function (failure) {
            failed.push({ path: path, why: wtRemoveFailureText(failure) })
            step()
          })
        }
        step()
      }

      /* 标题行同时是折叠开关，与仓库块同一副长相：三角、图标、名字、计数。
         v1.4：canRemove 时右端多一枚「…」触发器（单击开块级菜单，stopEvent 拦住
         冒泡 —— 不触发折叠），整行右键也开同一张菜单；没给 onWorktreeRemove 时
         这两样都不出现，title 与逐键不变。 */
      const rows = [h('div', {
        key: 'wt-head',
        className: 'dsh-git-wt-head',
        title: (folded ? '展开 worktree 列表' : '收起 worktree 列表（当前选中的 worktree 仍显示在标题行）')
          + (canRemove ? '；右键块头或点右端「…」：清除游离 / 目录已失联的工作区' : ''),
        onClick: function () { setFolded(!folded) },
        onContextMenu: canRemove
          ? function (event) { openMenu('head', '', event) }
          : undefined,
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
          : (data.ok !== true ? h('span', { key: 'f', className: 'dsh-git-repo-note' }, '读取失败') : null),
        canRemove
          ? h('button', {
            key: 'more', type: 'button', className: 'dsh-git-wt-more',
            title: 'worktree 清除：一键清掉游离 / 目录已失联的工作区（当前 '
              + String(removable.length) + ' 个可清）—— 右键块头开的是同一张菜单',
            onClick: function (event) {
              stopEvent(event)
              openMenu('head', '', event)
            },
          }, '…')
          : null)]

      /* ── 「主目录」行（v1.2）：本目录是链接工作区时，说清主仓库在哪、还能不能救 ──
          只在 wtMain 的 kind 是 linked / broken-gitlink 时出现；mainDir 为空（bare
          或 gitlink 配不上）时文字改说「读不到」，只留「配置…」一个动作。 */
      const wtMainNow = props.wtMain != null && props.wtMain.ok === true ? props.wtMain : null
      const wtMainKind = wtMainNow != null ? text(wtMainNow.kind) : ''
      if (wtMainNow != null && (wtMainKind === 'linked' || wtMainKind === 'broken-gitlink')) {
        const mainDir = text(wtMainNow.mainDir)
        const hasMain = mainDir.length > 0
        const fromConfig = wtMainNow.mainSource === 'config'
        /* mainMapped（host 65-worktree.js 的目录映射）：主目录是 gitlink 里那台别的
           机器的路径按映射规则换算来的 —— 来源说「目录映射」而不是「自动找到」，
           读者才追得到这个路径是哪来的（去全局配置的 worktree 组看/改规则）。 */
        const viaMapping = wtMainNow.mainMapped === true
        const mainOk = wtMainNow.mainOk === true
        const gitlink = text(wtMainNow.gitlink)
        /* kind 含义的一句话（说明页 WorktreeMainSetup 同一文案的短版）。 */
        const kindSaid = wtMainKind === 'linked'
          ? '本目录是链接工作区：.git 是一个链接文件（' + (gitlink.length > 0 ? gitlink : 'gitlink') + '），读写的都是主仓库那头的版本库'
          : (viaMapping && hasMain
            ? '主仓库那头 git 读不到：.git 记的是另一台机器的目录（' + (gitlink.length > 0 ? gitlink : 'gitlink') + '），主目录已按全局配置的「目录映射」换算到本机'
            : '主仓库那头读不到（多半被删了或搬走了）：.git 还指着老地方')
        const tip = [
          hasMain ? '主目录：' + mainDir + (fromConfig ? '（手动配置）' : (viaMapping ? '（目录映射找到）' : '（自动找到）')) : '主目录读不到：gitlink 配不上一个存在的目录',
          kindSaid,
        ]
        if (hasMain && mainOk !== true) tip.push('这个主目录现在不存在（或里面没有 .git）—— 用「配置…」把正确路径告诉面板')
        if (hasMain) tip.push('单击「打开主目录」= 把生效仓库切到主目录（与仓库行单击同一手势）')
        rows.push(h('div', {
          key: 'wt-main',
          className: 'dsh-git-wt-mainrow' + (hasMain && mainOk ? '' : ' dsh-git-wt-gone'),
          title: tip.join('\n'),
        },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }),
          h('span', { key: 'g', className: 'dsh-git-repo-glyph' }, h(Icon, { name: 'repo', size: 12 })),
          h('span', { key: 'n', className: 'dsh-git-tmain' },
            h('span', { className: 'dsh-git-tname' }, hasMain ? repoBaseName(mainDir) : '主目录读不到'),
            h('span', { className: 'dsh-git-tsub' + (hasMain ? '' : ' dsh-git-tsub-none') },
              hasMain
                ? (fromConfig ? '手动配置' : (viaMapping ? '目录映射' : '自动找到')) + (mainOk ? '' : ' · 目录不在了')
                : (wtMainKind === 'broken-gitlink' ? '主目录读不到' : 'bare：没有工作区可言'))),
          h('span', { key: 'r', className: 'dsh-git-wt-right' },
            hasMain && typeof props.onOpenMain === 'function'
              ? h('button', {
                key: 'open', type: 'button', className: 'dsh-git-wt-main-act',
                title: '把生效仓库切到主目录 ' + mainDir + '（不 checkout、不切分支、不动任何工作区）',
                onClick: function () { props.onOpenMain(mainDir) },
              }, '打开主目录')
              : null,
            typeof props.onConfigure === 'function'
              ? h('button', {
                key: 'cfg', type: 'button', className: 'dsh-git-wt-main-act',
                title: '配置这个 worktree 的主目录（告诉面板主仓库现在在哪）',
                onClick: function () { props.onConfigure() },
              }, '配置…')
              : null)))
      }

      /* ── v1.4 清除的菜单与块内 note（canRemove 才出现，拼在下面的尾巴里）──
          菜单浮层是 80-panel.js 的 ContextMenu（光标锚定、点外/Esc/滚动/resize 关闭
          白拿），项按行菜单 / 块头菜单两副；武装键 arm（'row:<path>' / 'batch'）：
          第一次点变红字「确认清除」（dsh-git-menu-danger，分支删除菜单同一先例），
          再点才发。被清的是当前生效仓库（path == effective）时，确认文案额外警告
          「这是变更列表正看着的工作区」。菜单底部一行小字说清除语义（两副菜单都带
          —— 破坏性动作的语义跟着菜单走，不靠读者记住）。 */
      const rowMenuItems = menu === null || menu.kind !== 'row' ? [] : (function () {
        const path = menu.path
        const armed = arm === 'row:' + path
        const isEffective = path.length > 0 && path === effective
        return [
          h('button', {
            key: 'rm', type: 'button',
            className: 'dsh-git-menu-item' + (armed ? ' dsh-git-menu-danger' : ''),
            title: (armed
              ? (isEffective ? '⚠ 这是变更列表正看着的工作区 —— 清掉它，变更列表就没有仓库可看了。' : '')
                + 'git worktree remove ' + path
              : 'git worktree remove ' + path + ' —— 删除这个工作区目录，git 侧登记一并移除；主工作区不受影响（再点一次确认）'),
            disabled: busy === true,
            onClick: function (event) {
              stopEvent(event)
              if (armed !== true) { setArm('row:' + path); return }
              setMenu(null)
              setArm('')
              runClear([path])
            },
          }, armed ? '确认清除这个 worktree' : '清除这个 worktree'),
          h('div', { key: 'sep', className: 'dsh-git-menu-sep' }),
          h('div', { key: 'say', className: 'dsh-git-menu-dim dsh-git-menu-pad' },
            '清除 = 删除该工作区目录，git 侧登记一并移除；不碰主工作区。有未提交改动时 git 会拒绝 —— 面板不给强删入口（需要时手动 git worktree remove --force）。'),
        ]
      })()
      const headMenuItems = menu === null || menu.kind !== 'head' ? [] : (function () {
        const count = removable.length
        const armed = arm === 'batch'
        const said = count === 0
          ? '没有可清除的 worktree：只有「游离 HEAD」（不站分支）或「目录已丢失」（⚠）的行能清；🔒 锁定的 git 也会拒，bare 没有工作区可言'
          : removable.map(function (one) { return repoBaseName(one) }).join('、')
        return [
          h('button', {
            key: 'rm-all', type: 'button',
            className: 'dsh-git-menu-item' + (armed ? ' dsh-git-menu-danger' : ''),
            title: count === 0
              ? said
              : (armed
                ? 'git worktree remove ×' + String(count) + '：' + said + ' —— 逐个执行，单个失败不影响其余'
                : '逐个清除：' + said + '（再点一次确认）'),
            disabled: count === 0 || busy === true,
            onClick: function (event) {
              stopEvent(event)
              if (count === 0) return
              if (armed !== true) { setArm('batch'); return }
              setMenu(null)
              setArm('')
              runClear(removable.slice())
            },
          }, armed ? '确认清除（' + String(count) + '）' : '一键清除（' + String(count) + '）'),
          h('div', { key: 'sep', className: 'dsh-git-menu-sep' }),
          h('div', { key: 'say', className: 'dsh-git-menu-dim dsh-git-menu-pad' },
            count === 0
              ? said
              : '清除 = 删除该工作区目录，git 侧登记一并移除；不碰主工作区。有未提交改动时 git 会拒绝 —— 面板不给强删入口；逐个执行，单个失败不影响其余。'),
        ]
      })()
      /* 清除结果的块内 note：与「读取失败」的灰行同一落点（辅助信息不上顶部横幅），
         红/绿两色，点一下收起。 */
      const wtNoteRow = note === null ? null : h('div', {
        key: 'wt-note',
        className: 'dsh-git-wt-note ' + (note.ok === true ? 'dsh-git-wt-note-ok' : 'dsh-git-wt-note-bad'),
        title: note.ok === true ? '清除完成（点一下收起这句话）' : '有没清成的（点一下收起这句话）',
        onClick: function () { setNote(null) },
      }, note.text)
      const wtMenuNode = menu === null ? null : h(ContextMenu, {
        key: 'wt-menu', open: true, x: menuPos.left, y: menuPos.top,
        onClose: function () { setMenu(null) },
      }, menu.kind === 'row' ? rowMenuItems : headMenuItems)

      /* ── 块底的表单 + 动作行（v1.3）：三种数据状态共享的尾巴 ──
          读取中 / 失败或空 / 有清单三条路都以各自的提前 return 收场，把「展开的
          表单 + ＋ 新建 worktree」折成这个函数在每处 return 前垫一遍 —— 清单本体
          的渲染一行不动。没给 onWorktreeAdd 的调用方（老用法）整段不出现，行为
          与 v1.2 逐字节相同。折叠态在更早的 return 里，天然不带尾巴。
          v1.4 的 note 与菜单浮层垫在同一个位置（canRemove 才出现）：note 垫在表单 /
          动作行之前（清除的账跟着清单走，不挤动作行），菜单浮层垫最后（fixed 定位，
          挂哪都不占版面）。 */
      const withTail = function (box) {
        if (canRemove && wtNoteRow !== null) rows.push(wtNoteRow)
        if (typeof props.onWorktreeAdd === 'function') {
          if (adding) {
            rows.push(h(WorktreeAddForm, {
              key: 'wt-form',
              data: data,
              refs: refs,
              effective: effective,
              wtMain: props.wtMain,
              repoMode: repoMode,
              repo: text(props.repo),
              activeRef: activeRef,
              onWorktreeAdd: props.onWorktreeAdd,
              onPickBranch: props.onPickBranch,
              onPickWorktree: props.onPickWorktree,
              onClose: function () { setAdding(false) },
            }))
          }
          rows.push(h('div', {
            key: 'wt-add',
            className: 'dsh-git-wt-add',
            title: '新建 worktree（git worktree add）：指定分支与放置目录，在块内展开表单',
            onClick: function () { setAdding(!adding) },
          },
            h('span', { key: 'p', className: 'dsh-git-repo-mark' }, '＋'),
            h('span', { key: 'n', className: 'dsh-git-repo-name dsh-git-dim' }, '新建 worktree')))
        }
        if (canRemove && wtMenuNode !== null) rows.push(wtMenuNode)
        return box
      }

      if (folded) {
        /* 折叠态：清单行全收起，但清除的入口与结果不收 —— 块头的「…」/右键照样
           开菜单（v1.4），note 也要有地方说话。 */
        if (canRemove && wtNoteRow !== null) rows.push(wtNoteRow)
        if (canRemove && wtMenuNode !== null) rows.push(wtMenuNode)
        return h('div', { className: 'dsh-git-wt-box' }, rows)
      }

      if (data == null) {
        rows.push(h('div', { key: 'wt-loading', className: 'dsh-git-wt-row dsh-git-wt-gone' },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }),
          h('span', { key: 'n', className: 'dsh-git-dim' }, '正在读取 worktree…')))
        return withTail(h('div', { className: 'dsh-git-wt-box' }, rows))
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
        return withTail(h('div', { className: 'dsh-git-wt-box' }, rows))
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
        /* v1.4 清除的行级说明：locked 的不给清（git 会拒），tooltip 说明原因；
           可清除的行补一句右键语义 —— 菜单里还有详情，这里只指路。 */
        if (locked) tip.push('已锁定' + (lockReason.length > 0 ? '：' + lockReason : '')
          + (canRemove ? '；已锁定的工作区不能在这里清除（git 会拒绝）' : ''))
        const rowClearable = canRemove && removable.indexOf(path) >= 0
        if (rowClearable) {
          tip.push('右键：清除这个 worktree（git worktree remove）—— 删除这个目录，git 侧的登记一并移除；不碰主工作区')
        }
        rows.push(h('div', {
          key: 'wt:' + path,
          className: 'dsh-git-wt-row' + (dim ? ' dsh-git-wt-gone' : ''),
          title: tip.join('\n'),
          onClick: selectable
            ? (repoMode
              ? function () { props.onPickWorktree(path) }
              : function () { props.onPickBranch(props.repo, branch) })
            : undefined,
          onContextMenu: rowClearable
            ? function (event) { openMenu('row', path, event) }
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

      return withTail(h('div', { className: 'dsh-git-wt-box' }, rows))
    }

    /* ── v1.3「快速创建」：表单与它的几个免费小工具 ──

       表单（WorktreeAddForm）住在 WorktreeBox 块底「＋ 新建 worktree」展开的位置，
       数据全用已加载的那几份（worktrees / refs / wtMain / 生效仓库），自己不发任何
       读数；唯一的出口是 props.onWorktreeAdd（80-panel.js 统一发 git/worktree-add）。
       字段与预检的完整说明见文件头 v1.3 那段，这里只记实现里容易读歪的三处：

         · 「放置目录」的建议值是派生的：manualPath === null（没动过输入框）时每次
           渲染都按「基准目录 + 仓库名短名 + - + 分支短名」现算 —— wtMain 读数晚到、
           读者改了分支名，建议都跟着走；一旦亲手改过就冻结，不再替他改。分支短名的
           兜底链：输入的分支名 → 当前分支（activeRef）→ 'HEAD'（游离是起点 → 'HEAD'），
           兜底只为「建议永远不撞仓库目录自己」，不是猜。
         · datalist 的 id 与 radio 组的 name 都要全场唯一：面板与 chip 可能同时各挂
           一张表单，撞了 id 的 datalist 会互相喂错清单 —— 用模块级计数发号。
         · 失败折话（wtAddFailureText）照 65-worktree.js ignoredFailureReason 的折法：
           noGit / sandboxDenied 各说各的话，其余取 stderr 首行 —— git 的原话在哪个
           locale 都比「退出码 128」有用；host 校验层的拒绝没有 stderr，落到
           reply.error 那句人话。 */

    /* 分支短名进目录名的唯一一步：[^A-Za-z0-9._-]+ 折成 '-'，两端折出来的空档裁掉。 */
    function wtDirSlug(raw) {
      return String(raw == null ? '' : raw).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-]+|[-]+$/g, '')
    }

    /* 目录的父目录（尾部多余的 / 先裁掉；根与无斜杠都答 ''，由建议值那边兜成 '/…'）。 */
    function wtParentOf(dir) {
      const trimmed = String(dir == null ? '' : dir).replace(/\/+$/, '')
      const cut = trimmed.lastIndexOf('/')
      return cut < 0 ? '' : trimmed.slice(0, cut)
    }

    /* 建议值：仓库父目录 + / + 仓库名短名 + - + 分支短名（slug 空就不挂尾巴）。 */
    function wtSuggestDir(baseDir, repoShort, branchPart) {
      if (baseDir.length === 0) return ''
      const slug = wtDirSlug(branchPart)
      const name = repoShort + (slug.length > 0 ? '-' + slug : '')
      const parent = wtParentOf(baseDir)
      return (parent.length > 0 ? parent : '') + '/' + name
    }

    /* 预检要的两本账，从已加载的 read 数一次折出：paths = 已登记的 worktree 目录
       （含目录已丢失的 prunable 行 —— 那正是 --force 的第三种场景），branches = 正被
       检出的本地分支短名 → 检出它的那个工作区目录（报错时说得出去）。清单只含链接
       工作区，所以生效目录自己站着的那个分支（refs.current，同样是已加载的数据）
       要在这里并进来 —— 不然「检出分支」里挑当前分支建 worktree，预检放行、git 必拒。 */
    function wtOccupiedOf(data, refs, effective) {
      const out = { paths: {}, branches: {} }
      if (data != null && data.ok === true && Array.isArray(data.worktrees)) {
        for (let i = 0; i < data.worktrees.length; i += 1) {
          const one = data.worktrees[i]
          if (one == null || one.bare === true) continue
          const path = text(one.path)
          if (path.length > 0) out.paths[path] = true
          const branch = one.detached === true ? '' : text(one.branch)
          if (branch.length > 0) out.branches[branch] = path
        }
      }
      if (refs != null && refs.ok === true && Array.isArray(refs.current)) {
        for (let i = 0; i < refs.current.length; i += 1) {
          const branch = text(refs.current[i])
          if (branch.length > 0 && out.branches[branch] === undefined) out.branches[branch] = effective
        }
      }
      return out
    }

    /* 成功答复里「落在 path 的那个工作区」站着的分支：游离 / bare 没有分支，答 ''。
       答复没带清单（host 那头快照恰好读不动）也答 '' —— 调用方落到「只刷新」。 */
    function wtBranchAtPath(reply, path) {
      if (reply == null || Array.isArray(reply.worktrees) !== true) return ''
      for (let i = 0; i < reply.worktrees.length; i += 1) {
        const one = reply.worktrees[i]
        if (one == null || text(one.path) !== path) continue
        return one.detached === true || one.bare === true ? '' : text(one.branch)
      }
      return ''
    }

    /* 失败的人话：优先从 host 的原始答复折（noGit / sandboxDenied 有专门话术，其余
       stderr 首行 —— ignoredFailureReason 同一折法），校验层拒绝落到 reply.error；
       真没答复（运输层失败）才用 rpc 抛上来的那句话。 */
    function wtAddFailureText(failure) {
      const reply = failure != null && failure.reply != null ? failure.reply : null
      if (reply != null) {
        if (reply.noGit === true) {
          return '这台机器上找不到 git：新建 worktree 要调用 git。装上 git，或让它出现在 dsh 进程的 PATH 里，再试一次。'
        }
        if (reply.sandboxDenied === true) {
          return '文件沙箱不允许这次创建（新目录多半在会话工作区的可写范围之外）：把 worktree 建到会话工作区里，或放宽沙箱策略再试'
        }
        const lines = String(reply.stderr == null ? '' : reply.stderr).split('\n')
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i].trim()
          if (line.length > 0) return line
        }
        if (typeof reply.error === 'string' && reply.error.length > 0) return reply.error
      }
      return failureText(failure)
    }

    let wtFormSeq = 0

    function WorktreeAddForm(props) {
      const refs = props.refs
      const effective = text(props.effective)
      const activeRef = text(props.activeRef)
      const repoMode = props.repoMode === true
      const [mode, setMode] = React.useState('new')
      const [name, setName] = React.useState('')
      const [at, setAt] = React.useState('')
      /* 「放置目录」：null = 还没亲手改过、跟着建议值走；改过就冻结（见上面的说明）。 */
      const [manualPath, setManualPath] = React.useState(null)
      const [force, setForce] = React.useState(false)
      const [jump, setJump] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [uid] = React.useState(function () { wtFormSeq += 1; return 'dsh-git-wt-f' + String(wtFormSeq) })

      /* 基准目录：worktree 主目录（linked/main 且 git 认它存在）优先，否则生效仓库。
          两个都没读到时建议值为空 —— 绝对路径只能读者自己给。 */
      const wtMainNow = props.wtMain
      const baseDir = wtMainNow != null && wtMainNow.ok === true
        && (wtMainNow.kind === 'linked' || wtMainNow.kind === 'main')
        && wtMainNow.mainOk === true && text(wtMainNow.mainDir).length > 0
        ? text(wtMainNow.mainDir)
        : effective
      const branchHint = mode === 'detach'
        ? (at.trim().length > 0 ? at.trim() : 'HEAD')
        : (name.trim().length > 0 ? name.trim() : (activeRef.length > 0 ? activeRef : 'HEAD'))
      const dir = manualPath !== null ? manualPath : wtSuggestDir(baseDir, repoBaseName(baseDir), branchHint)

      /* 预检的两本账与检出的本地分支名集合（datalist 的「已占用」标注同源）。 */
      const occupied = wtOccupiedOf(props.data, refs, effective)
      const localNames = {}
      const options = []
      if (refs != null && refs.ok === true) {
        if (Array.isArray(refs.local)) {
          for (let i = 0; i < refs.local.length; i += 1) {
            const one = refs.local[i]
            const short = one != null ? text(one.data) : ''
            if (short.length === 0) continue
            localNames[short] = true
            options.push(h('option', {
              key: 'l:' + short, value: short,
              label: occupied.branches[short] !== undefined ? short + '（已占用）' : short,
            }))
          }
        }
        if (Array.isArray(refs.remote)) {
          for (let r = 0; r < refs.remote.length; r += 1) {
            const group = refs.remote[r]
            const rows = group != null && Array.isArray(group.refs) ? group.refs : []
            for (let i = 0; i < rows.length; i += 1) {
              const full = rows[i] != null ? text(rows[i].data) : ''
              if (full.length === 0) continue
              options.push(h('option', { key: 'r:' + full, value: full, label: full }))
            }
          }
        }
      }

      const preflight = function () {
        const finalDir = dir.trim()
        const finalName = name.trim()
        if (finalDir.length === 0) return '放置目录必填：新工作区要落在哪个绝对路径（以 / 开头）'
        if (finalDir.charAt(0) !== '/') return '放置目录必须是绝对路径（以 / 开头），相对路径不收'
        if (mode !== 'detach' && finalName.length === 0) {
          return mode === 'new' ? '新分支名必填' : '要检出的分支名必填'
        }
        if (force === true) return ''
        if (occupied.paths[finalDir] === true) {
          return '这个目录已登记为本仓库的 worktree（' + finalDir + '）：换一个目录，或勾「强制覆盖」'
        }
        if (mode === 'checkout' && occupied.branches[finalName] !== undefined) {
          return '分支 ' + finalName + ' 已被 worktree ' + occupied.branches[finalName] + ' 检出：换一个分支，或勾「强制覆盖」'
        }
        if (mode === 'new' && localNames[finalName] === true) {
          return '本地已有同名分支 ' + finalName + '：换一个名字，或勾「强制覆盖」'
        }
        return ''
      }

      const submit = function () {
        if (busy === true || typeof props.onWorktreeAdd !== 'function') return
        const problem = preflight()
        if (problem.length > 0) { setError(problem); return }
        setError('')
        setBusy(true)
        const finalDir = dir.trim()
        const fields = { mode: mode, path: finalDir, force: force === true }
        if (mode !== 'detach') fields.name = name.trim()
        if (mode !== 'checkout' && at.trim().length > 0) fields.at = at.trim()
        props.onWorktreeAdd(fields).then(function (reply) {
          setBusy(false)
          props.onClose()
          if (jump !== true) return
          /* 「创建后切到新工作区」：变更页直接切过去（repoSingle 那条现成路）；历史页
              按答复清单里这个工作区实际站着的分支过滤 —— 分支答不上来（游离 / 清单没
              带回）落 onPickWorktree，没给就只剩 80-panel.js 那次 bump 刷新。 */
          if (repoMode === true) {
            if (typeof props.onPickWorktree === 'function') props.onPickWorktree(finalDir)
            return
          }
          const branch = wtBranchAtPath(reply, finalDir)
          if (branch.length > 0 && typeof props.onPickBranch === 'function') {
            props.onPickBranch(text(props.repo), branch)
            return
          }
          if (typeof props.onPickWorktree === 'function') props.onPickWorktree(finalDir)
        }, function (failure) {
          setBusy(false)
          setError(wtAddFailureText(failure))
        })
      }

      /* 输入行的公共手势：Enter 提交（24-repos.js 登记行同一约定）、Escape 收起。 */
      const keyHand = function (event) {
        if (event.key === 'Enter') submit()
        if (event.key === 'Escape') props.onClose()
      }

      const modes = [
        { id: 'new', label: '新建分支', tip: 'git worktree add -b <新分支> <目录> [<起点>]：从「起点」（默认 HEAD）建一个新分支并检出，不碰任何现有工作区' },
        { id: 'checkout', label: '检出分支', tip: 'git worktree add <目录> <分支>：检出已有分支。本地分支短名或远端分支全名（origin/x）都收 —— 远端走 git 的 DWIM，自动建同名本地跟踪分支' },
        { id: 'detach', label: '游离检出', tip: 'git worktree add --detach <目录> [<起点>]：停在具体提交上、不占分支名，起点可以是分支 / commit / tag' },
      ]

      return h('div', { className: 'dsh-git-wt-form' },
        h('div', { key: 'modes', className: 'dsh-git-wt-form-modes' },
          modes.map(function (one) {
            return h('label', { key: one.id, className: 'dsh-git-wt-form-mode', title: one.tip },
              h('input', {
                type: 'radio', name: uid + '-m', checked: mode === one.id,
                onChange: function () { setMode(one.id); setError('') },
              }),
              h('span', null, one.label))
          })),
        mode !== 'detach'
          ? h('div', { key: 'name', className: 'dsh-git-wt-form-row' },
            h('span', { className: 'dsh-git-wt-form-label' }, mode === 'new' ? '新分支' : '分支'),
            h('input', {
              className: 'dsh-git-repo-input', autoFocus: true, value: name,
              list: mode === 'checkout' ? uid + '-branches' : undefined,
              placeholder: mode === 'new' ? '要创建的分支名' : 'feat/x 或 origin/feat/x',
              title: mode === 'new'
                ? '新分支的名字：从「起点」（可空 = HEAD）创建并检出到下面的目录'
                : '本地分支短名，或远端分支全名（origin/x）：检出远端分支时 git 自动建同名本地跟踪分支（DWIM）。已被其他 worktree 检出的本地分支照常列出、标「已占用」',
              onChange: function (event) { setName(event.target.value) },
              onKeyDown: keyHand,
            }),
            mode === 'checkout' ? h('datalist', { key: 'dl', id: uid + '-branches' }, options) : null)
          : null,
        mode !== 'checkout'
          ? h('div', { key: 'at', className: 'dsh-git-wt-form-row' },
            h('span', { className: 'dsh-git-wt-form-label' }, '起点'),
            h('input', {
              className: 'dsh-git-repo-input',
              autoFocus: mode === 'detach',
              value: at, placeholder: 'HEAD',
              title: mode === 'new'
                ? '可空，默认 HEAD。给远端分支（如 origin/x）当起点时，git 会自动为新分支建立跟踪（与 git switch -c 同一规矩）'
                : '分支 / commit / tag，默认 HEAD：新工作区停在它指向的提交上，不占分支名',
              onChange: function (event) { setAt(event.target.value) },
              onKeyDown: keyHand,
            }))
          : null,
        h('div', { key: 'dir', className: 'dsh-git-wt-form-row' },
          h('span', { className: 'dsh-git-wt-form-label' }, '目录'),
          h('input', {
            className: 'dsh-git-repo-input', value: dir,
            placeholder: '新工作区的绝对路径',
            title: '新工作区的绝对路径。默认建议 = 仓库父目录 + / + 仓库名短名 + - + 分支短名（非法字符折成 -）；基准目录优先用 worktree 主目录，不在时用当前生效仓库。改过就不再自动跟',
            onChange: function (event) { setManualPath(event.target.value) },
            onKeyDown: keyHand,
          })),
        h('label', {
          key: 'force', className: 'dsh-git-wt-form-check',
          title: '勾上后给 git 带 --force：目标目录已存在且非空、分支已被其他 worktree 检出、目录是已登记但已丢失的 worktree —— 这三种 git 默认都拒，勾了才放行',
        },
          h('input', { type: 'checkbox', checked: force, onChange: function (event) { setForce(event.target.checked) } }),
          h('span', null, '强制覆盖（--force）')),
        h('label', {
          key: 'jump', className: 'dsh-git-wt-form-check',
          title: repoMode
            ? '创建成功后变更列表切到新工作区（只切查看的仓库，不动任何现有工作区）'
            : '创建成功后历史按新工作区站着的分支过滤；游离检出没有分支，只刷新清单',
        },
          h('input', { type: 'checkbox', checked: jump, onChange: function (event) { setJump(event.target.checked) } }),
          h('span', null, '创建后切到新工作区')),
        error.length > 0 ? h('div', { key: 'err', className: 'dsh-git-wt-form-error' }, error) : null,
        h('div', { key: 'btns', className: 'dsh-git-wt-form-btns' },
          h('button', {
            key: 'ok', type: 'button', className: 'dsh-git-btn',
            disabled: busy === true || dir.trim().length === 0,
            title: 'git worktree add：旗标（--force / --detach / -b）全在目录前，目录后只跟起点；提交前预检不过会被红字拦下',
            onClick: submit,
          }, busy === true ? '…' : '创建'),
          h('button', {
            key: 'no', type: 'button', className: 'dsh-git-btn',
            title: '收起表单，不发送任何请求',
            onClick: function () { props.onClose() },
          }, '取消')))
    }

    /* ── v1.4 清除的两个模块级小工具 ──
       菜单坐标的 transform 换算与失败话术的折法，都从既有先例原样借来 —— 借的是
       判法与话术，不是再造一套。 */

    /* 菜单坐标：ContextMenu 落 position:fixed 的视口坐标，但面板根节点在宽度记忆过
       时带着 translateX(-50%) 的 transform —— 带 transform 的祖先成了 fixed 后代的
       包含块，那时坐标要换成「相对面板」的那一套，否则菜单错位一个面板左上角。
       80-panel.js 的 ctxMenuPos（提交行/分支行右键菜单）就是这一套；那支活在面板
       组件的闭包里，这里按同一判法重写一遍（panelNode 是 10-state.js 的全局，指向
       当前挂着的面板根）。量不到（测试、无布局环境）原样用视口坐标 —— getComputed
       Style 不在时按「没 transform」处理，与那边 ctxMenuPos 的兜底一致：这是尽力
       量的探针，量不动就退回最朴素也正确的视口坐标，不必为它抛错。 */
    function wtMenuPos(x, y) {
      const node = panelNode
      if (node == null || typeof node.getBoundingClientRect !== 'function') return { left: x, top: y }
      let shifted = false
      try {
        const doc = node.ownerDocument
        const view = doc != null ? doc.defaultView : null
        if (view != null && typeof view.getComputedStyle === 'function') {
          shifted = view.getComputedStyle(node).transform !== 'none'
        }
      } catch (error) { shifted = false }
      if (shifted !== true) return { left: x, top: y }
      const rect = node.getBoundingClientRect()
      return { left: x - rect.left, top: y - rect.top }
    }

    /* 清除失败的人话：wtAddFailureText 同一条折法 —— noGit / sandboxDenied 各说各的
       专门话术，其余取 stderr 首行（git 的原话在哪个 locale 都比「退出码 128」有用；
       host 校验层的拒绝没有 stderr，落到 reply.error 那句人话）；真没答复（运输层
       失败）才用 rpc 抛上来的那句话。清除专属的两条：
         · git 拒收且原话里点了 --force（有未提交改动 / 目录非空）：面板不给强删
           入口，说清要强删得手动 git worktree remove --force；
         · 宿主进程还是旧版（git/worktree-remove 这条路由不存在，is not registered
           的运输层失败）：照 GitConfigPane remoteHostOld 的先例说出路 —— 重启 DSH
           加载新版宿主，与这个仓库、与 git 都无关，不甩原文。 */
    function wtRemoveFailureText(failure) {
      const reply = failure != null && failure.reply != null ? failure.reply : null
      if (reply == null) {
        const raw = failureText(failure)
        return raw.indexOf(HOST_NOT_READY) >= 0
          ? '清除要在重启 DSH、加载新版宿主之后才生效 —— 现在运行的宿主进程还是旧版，git/worktree-remove 这条命令它还不认识'
          : raw
      }
      if (reply.noGit === true) {
        return '这台机器上找不到 git：清除 worktree 要调用 git。装上 git，或让它出现在 dsh 进程的 PATH 里，再试一次。'
      }
      if (reply.sandboxDenied === true) {
        return '文件沙箱不允许这次清除（要删的目录多半在会话工作区的可写范围之外）：放宽沙箱策略再试，或手动删除'
      }
      const lines = String(reply.stderr == null ? '' : reply.stderr).split('\n')
      let said = ''
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim()
        if (line.length > 0) { said = line; break }
      }
      if (said.length === 0 && typeof reply.error === 'string') said = reply.error
      if (said.length === 0) return '清除失败（git 没有给出原因）'
      if (said.indexOf('--force') >= 0) {
        said += ' —— 面板不给强删入口：确认这个工作区没有要留的东西后，手动执行 git worktree remove --force '
          + (typeof reply.path === 'string' && reply.path.length > 0 ? reply.path : '')
      }
      return said
    }
