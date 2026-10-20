    /* ── 面板能长多高：跟着输入框的位置走 ──

       新会话的输入框垂直居中于屏幕，而面板从输入框上沿向上生长（bottom:100%），
       74vh 的默认高度会把头部（.dsh-git-top）整个顶出视口上沿。面板打开期间，实际
       渲染的高度被「输入框上沿之上的空间」钳制；日志列表本身是虚拟滚动
       （12-window.js 按容器 clientHeight 算可见行），容器一矮显示条数自动变少，
       列表那半边不用动。 */
    const PANEL_DEFAULT_VH = 0.74    /* 与 46-css.js 里 .dsh-git-pop 的 74vh 是同一个数 */
    const PANEL_ANCHOR_GAP = 8       /* .dsh-git-pop 的 margin-bottom：面板与输入框的间距 */
    const PANEL_ANCHOR_SAFETY = 1    /* 亚像素取整的余量：头部差 1px 被裁也看得难受 */
    const PANEL_MIN_HEIGHT = 160     /* 下限：极端情况下宁可顶部被裁一点，也不能面板缩没 */

    /* 面板 absolute 定位在输入区 overlay 槽位的容器里，那个容器随输入框移动（新会话
       居中、发送第一条消息后落底）。可用高度要量它，不能量面板自己：面板的 top 会随
       钳制后的高度变化，拿自己当锚点就成了自我反馈。offsetParent 会跳过不生成盒子的
       display:contents 包裹层（.dsh-git-layer）直达真正的定位容器；实在问不到容器
       （没有布局的环境）就退化为面板自己 —— 面板贴着容器上沿（bottom:100% 加
       margin-bottom:8px），容器上沿 ≈ 面板 top + 面板高 + 8。 */
    /* ── 历史页多选与右键的三个纯函数 ──

       Shift+点击的范围、右键动作的目标集、多选合并查看的连续性，都是「对着眼前
       graph.commits」的纯计算 —— 放在组件外面，单测可以从产物里整段抽出来验。

       图上的 commits 永远按新→旧排（git log 的顺序），下面所有「顺序」说的都是它。 */

    /* 右键动作的目标集（PhpStorm：动作作用于 selection）：右键行在多选里且多选
       多于一条时 = 整份 multiSel（按图序，新→旧）；否则就是右键那一条。 */
    function ctxTargetHashes(hash, multi) {
      if (Array.isArray(multi) && multi.length > 1 && multi.indexOf(hash) >= 0) return multi.slice()
      return [hash]
    }

    /* Shift+点击的范围：锚点行到本次点击行（谁新谁旧都行），按图顺序整段（含两端）。
       任一行不在眼前这份列表里（筛选变了、图重读了）返回 null —— 调用方退化为
       普通单选，不猜。 */
    function graphSliceBetween(commits, from, to) {
      if (!Array.isArray(commits)) return null
      let a = -1
      let b = -1
      for (let i = 0; i < commits.length; i += 1) {
        const hash = commits[i] != null ? commits[i].hash : undefined
        if (hash === from && a < 0) a = i
        if (hash === to && b < 0) b = i
      }
      if (a < 0 || b < 0) return null
      const out = []
      if (a <= b) {
        for (let i = a; i <= b; i += 1) out.push(commits[i].hash)
      } else {
        for (let i = b; i <= a; i += 1) out.push(commits[i].hash)
      }
      return out
    }

    /* 多选的「段」：按图序挑出选区行（新→旧），并回答合并查看/整段改写关心的三件事：
       contiguous —— 相邻两条里，较新一条的 hash 必须出现在较旧一条的 parents 里
       （这才是「可以整段重写」的一条链）；base —— 最旧一条的第一父提交（squash /
       drop 的区间起点）；head —— 最新一条（它同时是 HEAD 才能动整段）。选区里有行
       已不在图上、或不足两条，返回 null。 */
    function selectionSpan(commits, multi) {
      if (!Array.isArray(multi) || multi.length < 2 || !Array.isArray(commits)) return null
      const picked = []
      for (let i = 0; i < commits.length; i += 1) {
        const row = commits[i]
        const hash = row != null ? row.hash : undefined
        if (typeof hash !== 'string' || multi.indexOf(hash) < 0 || picked.indexOf(hash) >= 0) continue
        picked.push(hash)
      }
      if (picked.length !== multi.length) return null
      const byHash = {}
      for (let i = 0; i < commits.length; i += 1) {
        const row = commits[i]
        if (row != null && typeof row.hash === 'string') byHash[row.hash] = row
      }
      let contiguous = true
      for (let i = 0; i + 1 < picked.length; i += 1) {
        const newer = byHash[picked[i]]
        const parents = newer != null && Array.isArray(newer.parents) ? newer.parents : []
        if (parents.indexOf(picked[i + 1]) < 0) { contiguous = false; break }
      }
      const oldest = byHash[picked[picked.length - 1]]
      const base = oldest != null && Array.isArray(oldest.parents) && oldest.parents.length > 0
        ? oldest.parents[0] : ''
      return { targets: picked, contiguous: contiguous, base: base, head: picked[0] }
    }

    /* hash 的短写：菜单与提示条里的「短 hash」就是前 7 位（git 的默认短写）。 */
    function hashShort(hash) {
      return typeof hash === 'string' && hash.length > 7 ? hash.slice(0, 7) : text(hash)
    }

    const panelAnchorBox = function (node) {
      if (node == null) return null
      const host = node.offsetParent != null ? node.offsetParent : node.parentElement
      if (host != null && typeof host.getBoundingClientRect === 'function') {
        const box = host.getBoundingClientRect()
        /* 有宽或高才可信：display:none（面板藏着时）与无布局环境里 rect 全是 0，
           那个 0 不能当成「输入框贴着视口顶」。 */
        if (parseFloat(box.width) > 0 || parseFloat(box.height) > 0) return box
      }
      if (typeof node.getBoundingClientRect === 'function') {
        const own = node.getBoundingClientRect()
        if (parseFloat(own.height) > 0) {
          return { top: parseFloat(own.top) + parseFloat(own.height) + PANEL_ANCHOR_GAP }
        }
      }
      return null
    }

    /* ── 面板的「配置」页：项目配置与全局配置 ──

       这一页分两档作用域，切换排在页首（记号用头部视图切换同一套 dsh-git-cview）：

       · 项目配置 —— 排两块：插件级的「会话完成」一组留在外框之外（它 setPlugin，
         不跟本页编辑目标走）；之后「仓库」一大组 —— 顶部用 24-repos.js 的受控单选
         变体挑本页在编辑哪个仓库（多仓库时列出工作区扫到与手动登记的全部仓库，
         默认当前生效仓库），受切换仓库影响的三组收在它里面做下级（缩进 + 左侧
         竖线，46-css.js 的 dsh-git-set-scope / -scope-body，组头点名目标仓库）：
         只写该仓库 .git/config 的提交身份、git 自己管换行符的两个键
         （core.autocrlf / core.safecrlf）、远端表（长在 .git/config 里，走
         git remote 自己的三条子命令，74-identity.js）。最末一组「git 忽略项」
         （GitIgnoredScanGroup）是例外：只读、不跟本页编辑目标走 —— 一口扫描
         shown 清单里的全部仓库、每个仓库再逐个 worktree 工作树（主/链接都标），
         列出被 git 忽略的文件与目录。
       · 全局配置 —— 跟着插件与这台机器走（79-globalconfig.js 的 GitGlobalConfigPane，
         原先是 DSH 设置面板里的「dsh-git-idea配置」页，2026-10 起搬到这里）：初始化
         分支、远程同步实参、快捷命令、git 位置、提交身份（--global）、换行符
         （--global）、以及只属于本浏览器的外观与节奏。

       两档共用同一套 dsh-git-set-* 排版（沿袭自原先那页设置页的样式）。 */

    /* ── 右键菜单（ContextMenu）：提交行与分支行共用的一块浮层 ──

       与 ⚡ 下拉不同，它锚的是**光标**而不是触发按钮，所以没有「触发按钮也算
       里面」这回事：点在菜单外（document 捕获阶段的 pointerdown）、Escape、滚动、
       resize 都关。开合走 78-actions.js 的 useOutsideDismiss（它管前两样）；滚动与
       resize 在这里补 —— 菜单自己内部的滚动不算滚走，长菜单才读得下去。 */
    function ContextMenu(props) {
      const [box] = React.useState(function () { return { node: null } })
      useOutsideDismiss(props.open, props.onClose, [box])
      React.useEffect(function () {
        if (props.open !== true) return undefined
        const doc = panelNode != null ? panelNode.ownerDocument : null
        if (doc == null || typeof doc.addEventListener !== 'function') return undefined
        const gone = function (event) {
          const target = event != null && event.target != null ? event.target : null
          const self = box.node
          if (self != null && typeof self.contains === 'function' && target != null
            && typeof target.nodeType === 'number' && self.contains(target) === true) return
          props.onClose()
        }
        doc.addEventListener('scroll', gone, true)
        const view = doc.defaultView
        if (view != null && typeof view.addEventListener === 'function') view.addEventListener('resize', gone)
        return function () {
          doc.removeEventListener('scroll', gone, true)
          if (view != null && typeof view.removeEventListener === 'function') view.removeEventListener('resize', gone)
        }
      }, [props.open])
      if (props.open !== true) return null
      return h('div', {
        className: 'dsh-git-menu', ref: function (node) { box.node = node },
        style: { position: 'fixed', left: String(props.x) + 'px', top: String(props.y) + 'px', right: 'auto' },
      }, props.children)
    }

    /* ── 远程签出的二选一确认框（qc-overlay 里那块 qc-box）──

       右键「远程」组的分支点「签出」、本地同名分支已存在时开它。两个出口都切到
       本地分支，区别只在本地分支要指向哪：保守的一边原地不动（本地提交保留），
       激进的一边 reset --hard 到远端 —— 本地独有的提交与未提交改动一并丢弃，这份
       危险写不进弹层正文那么长的话，就写全在按钮 title 里（命令 + 丢什么），按钮
       本身给 danger 红（远端删除二次确认的同一个语义）。Esc 与点在底板上都关：
       Esc 走 78-actions.js 的 useOutsideDismiss（捕获阶段 document 监听，不依赖
       焦点在层里 —— 读者多半刚点完右键，焦点还不在框内）；底板那下由外层 overlay
       的 onClick 接。 */
    function RemoteExistsConfirm(props) {
      const pick = props.pick
      const [box] = React.useState(function () { return { node: null } })
      useOutsideDismiss(props.open, props.onClose, [box])
      if (props.open !== true) return null
      return h('div', { key: 'box', className: 'dsh-git-qc-box', ref: function (node) { box.node = node } },
        h('div', { key: 'h', className: 'dsh-git-qc-head' },
          '本地已有分支 ' + pick.local + '，远端 ' + pick.name + ' 也在 —— 选择这次的签出动作'),
        h('div', { key: 'hint', className: 'dsh-git-hint' },
          '两个选择都会切到 ' + pick.local + '，区别只在本地分支要指向哪：保留它现在的提交，还是改成远端那份。'),
        h('div', { key: 'a', className: 'dsh-git-qc-actions' },
          h('button', {
            key: 'local', type: 'button', className: 'dsh-git-btn dsh-git-primary',
            disabled: props.busy === true,
            title: 'git switch ' + pick.local + ' —— 本地分支与它已有的提交原样保留',
            onClick: function (event) { stopEvent(event); props.onLocal() },
          }, '切换到本地分支'),
          h('button', {
            key: 'reset', type: 'button', className: 'dsh-git-btn dsh-git-danger',
            disabled: props.busy === true,
            title: 'git switch ' + pick.local + ' + git reset --hard ' + pick.name
              + ' —— 本地分支改成与远端完全一致：本地独有的提交与未提交的改动都会被丢弃，找不回来',
            onClick: function (event) { stopEvent(event); props.onReset() },
          }, '用远端覆盖'),
          h('button', {
            key: 'no', type: 'button', className: 'dsh-git-btn',
            disabled: props.busy === true,
            onClick: function (event) { stopEvent(event); props.onClose() },
          }, '取消')))
    }

    /* ── 推送确认弹窗（两段式推送的第一段；qc-overlay 里那块 qc-box）──

       用户主动发起的推送都先过这里：git/push-preview 把将要推的提交列出来
       （短 hash、说明、作者、相对时间），点「推送」才发真正的 git/push。
       props.state 是面板那份 pushConfirm（branch/repo/setUpstream/preview/
       loading/running/error），预览的读在面板自己的 effect 里 —— 组件只管画与手势。

       几种形状：读取中一行灰字；预览失败把原话说在框内；上游已知列出提交行
       （ahead 为 0 时没有可推的，按钮换成「关闭」）；没有上游翻成「设置上游并
       推送」的说明态 —— 远端已在打开前挑好的（右键推送 / 横幅那两条，setUpstream
       带着）直接说将执行什么；顶栏 ↑ 这条要到预览答复才知道，远端由面板按
       guessPushRemote 同一套规矩猜好传进来（props.guess），猜不出时按钮不出、
       props.guessNote 把出路（「修改跟踪分支…」）说出来。

       推送中（running）按钮全禁、Esc 与点遮罩一起失效 —— 推到一半的推送没有
       「取消」可言。useOutsideDismiss 的 onClose 闭包停在 open 翻真的那一帧
       （effect 依赖只有 [open]），running 后来的变化它看不见，所以经 guard 盒子
       每帧刷新最新的 onClose，旧闭包照样走到新判断（BranchPicker 的 live 盒子
       同一个做法）。 */
    function PushConfirmBox(props) {
      const state = props.state
      const preview = state.preview
      const running = state.running === true
      const loading = state.loading === true
      const commits = preview != null && preview.ok === true && Array.isArray(preview.commits) ? preview.commits : []
      const ahead = preview != null && typeof preview.ahead === 'number' ? preview.ahead : commits.length
      const behind = preview != null && typeof preview.behind === 'number' ? preview.behind : 0
      const noUpstream = preview != null && preview.ok === true && preview.upstream == null
      const guess = text(props.guess)
      /* 这次推送最终会以什么命令形状执行（按钮 title 与「将执行」那行都从这来）。
         带 -u 的两个来处：打开前就定好的（setUpstream），与顶栏 ↑ 读完预览才发现
         没有上游、按老规矩现猜的（guess）。 */
      const command = state.setUpstream != null
        ? 'git push -u ' + state.setUpstream.remote + ' ' + state.setUpstream.branch
        : (noUpstream === true && guess.length > 0 ? 'git push -u ' + guess + ' ' + text(state.branch) : (noUpstream === true ? '' : 'git push'))
      const upName = preview != null && text(preview.upstream).length > 0
        ? text(preview.upstream)
        : (state.setUpstream != null ? state.setUpstream.remote + '/' + state.setUpstream.branch : '')
      const canPush = loading !== true && running !== true && command.length > 0
        && (noUpstream === true || ahead > 0)
      const [guard] = React.useState(function () { return { onClose: null } })
      guard.onClose = props.onClose
      useOutsideDismiss(props.open === true, function () {
        if (typeof guard.onClose === 'function') guard.onClose()
      }, [props.box])
      if (props.open !== true) return null

      const rows = []
      for (let i = 0; i < commits.length; i += 1) {
        const one = commits[i]
        rows.push(h('div', {
          key: text(one.hash) + ':' + String(i), className: 'dsh-git-trow',
          title: text(one.hash) + (text(one.subject).length > 0 ? '\n' + text(one.subject) : ''),
        },
          h('span', { key: 'h', className: 'dsh-git-phash' }, text(one.short)),
          h('span', { key: 's', className: 'dsh-git-psub' }, text(one.subject)),
          h('span', { key: 'a', className: 'dsh-git-pwho' }, text(one.author)),
          h('span', { key: 'd', className: 'dsh-git-pwhen' }, relativeDate(one.date))))
      }

      /* 标题与正文按读到的形状说：读取中、读失败、没有上游、没有可推的、正常列表。 */
      const head = loading === true && preview == null
        ? '推送：正在读取要推的提交…'
        : (noUpstream === true
            ? '「' + (text(state.branch).length > 0 ? text(state.branch) : 'HEAD') + '」还没有上游 —— 先设置上游并推送'
            : (preview != null && preview.ok !== true
                ? '推送：读不到要推的提交'
                : (ahead === 0
                    ? '推送 ' + (upName.length > 0 ? upName : '上游')
                    : '推送 ' + String(ahead) + ' 个提交到 ' + (upName.length > 0 ? upName : '上游'))))
      const body = []
      if (loading === true && preview == null) {
        body.push(h('div', { key: 'wait', className: 'dsh-git-hint' }, '正在读取要推送的提交…'))
      } else if (preview != null && preview.ok !== true) {
        const said = text(preview.stderr)
        body.push(h('div', { key: 'bad', className: 'dsh-git-error', style: { whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: '16px' } },
          said.length > 0 ? said : '读不到推送预览（git/push-preview 失败）'))
      } else if (noUpstream === true) {
        body.push(h('div', { key: 'cmd', className: 'dsh-git-hint' },
          command.length > 0
            ? '将执行 ' + command + '（绑定上游并推送）。确认后才会真正推送。'
            : text(props.guessNote)))
      } else {
        if (ahead === 0) {
          body.push(h('div', { key: 'none', className: 'dsh-git-hint' },
            '当前分支与上游一致，没有要推送的提交'
            + (behind > 0 ? '；本地同时落后上游 ' + String(behind) + ' 个提交 —— 推送会被拒绝，先 ↓ 拉取' : '')))
        }
        if (commits.length > 0) {
          body.push(h('div', { key: 'list', className: 'dsh-git-pushlist' }, rows))
          if (preview != null && preview.hasMore === true) {
            body.push(h('div', { key: 'more', className: 'dsh-git-hint' },
              '提交较多，只列出最新的 ' + String(commits.length) + ' 条 —— 确认后仍然全部推送'))
          }
        }
        if (ahead > 0 && behind > 0) {
          body.push(h('div', { key: 'behind', className: 'dsh-git-hint' },
            '注意：本地同时落后上游 ' + String(behind) + ' 个提交，远端没动过才推得上去 —— 需要时先 ↓ 拉取再推'))
        }
      }
      if (running === true) {
        body.push(h('div', { key: 'run', className: 'dsh-git-hint' }, '推送中… 完成前这个框不会关，也不用再做别的。'))
      }
      if (text(state.error).length > 0) {
        body.push(h('div', { key: 'err', className: 'dsh-git-error', style: { whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: '16px' } }, text(state.error)))
      }

      /* head / 正文各行 / 按钮排都是 qc-box 的直接孩子 —— 那块盒子是 flex 列、
         gap:8px，中间不再垫一层（垫了就把行距全挤没了）。 */
      const kids = [h('div', { key: 'h', className: 'dsh-git-qc-head' },
        running === true ? h('span', { key: 'spin', className: 'dsh-git-spin' }, '↑') : null,
        head)].concat(body)
      kids.push(h('div', { key: 'a', className: 'dsh-git-qc-actions' },
        canPush === true
          ? h('button', {
              key: 'go', type: 'button', className: 'dsh-git-btn dsh-git-primary',
              disabled: running === true,
              title: command + (noUpstream === true ? ' —— 绑定上游并推送' : ''),
              onClick: function (event) { stopEvent(event); props.onPush(noUpstream === true) },
            },
              running === true
                ? [h('span', { key: 's', className: 'dsh-git-spin' }, '↑'), ' 推送中…']
                : (noUpstream === true ? '推送并设为上游（' + guess + '）' : '推送'))
          : (loading !== true && running !== true
              ? (preview != null && preview.ok !== true
                  ? h('span', { key: 'idle', className: 'dsh-git-hint' }, '稍后重试')
                  : (noUpstream === true
                      ? null  /* 出路已经说在正文那行，按钮排不再补一句。 */
                      : h('span', { key: 'idle', className: 'dsh-git-hint' }, '现在没有要推送的东西')))
              : null),
        h('button', {
          key: 'no', type: 'button', className: 'dsh-git-btn',
          disabled: running === true,
          title: running === true ? '推送进行中，不能取消' : '关闭弹窗，不推送',
          onClick: function (event) { stopEvent(event); props.onClose() },
        }, running === true ? '推送中…' : (canPush === true ? '取消' : '关闭'))))
      return h('div', { className: 'dsh-git-qc-box', ref: props.boxRef }, kids)
    }

    /* ── 「编辑提交消息…」对话框（reword）──

       qc-box 覆盖层家族的一块（qc-overlay 里那块 qc-box）：打开时原始消息已经由
       面板的 seed effect 预填进 textarea；Ctrl/Cmd+Enter 保存、Esc 取消（Esc 走
       useOutsideDismiss，捕获阶段的 document 监听 —— 读者多半刚点完右键，焦点
       还不在框内）；保存中按钮全禁，错误说在框内。 */
    function RewordMessageBox(props) {
      const state = props.state
      const running = state.running === true
      const canSave = running !== true && text(state.message).trim().length > 0
      const [box] = React.useState(function () { return { node: null } })
      useOutsideDismiss(true, function () {
        if (running !== true) props.onClose()
      }, [box])
      const onKey = function (event) {
        if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
          event.preventDefault()
          if (canSave === true) props.onSave()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (running !== true) props.onClose()
        }
      }
      return h('div', { className: 'dsh-git-qc-box', ref: function (node) { box.node = node }, onKeyDown: onKey },
        h('div', { key: 'h', className: 'dsh-git-qc-head' },
          '编辑提交消息 ' + hashShort(state.hash),
          running === true ? h('span', { key: 's', className: 'dsh-git-spin' }, '…') : null),
        h('div', { key: 'hint', className: 'dsh-git-hint' },
          '改写会换掉这个提交（以及它之后所有提交）的 hash —— 已推送的提交改写要强推。保存前一个字节都不会动。'),
        h('textarea', {
          key: 'ta', className: 'dsh-git-input', rows: 8,
          value: text(state.message),
          disabled: running === true,
          placeholder: '这条提交的完整消息（标题 + 空行 + 正文）',
          onChange: function (event) { props.onMessage(event.target.value) },
        }),
        text(state.error).length > 0
          ? h('div', { key: 'err', className: 'dsh-git-error', style: { whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: '16px' } }, text(state.error))
          : null,
        h('div', { key: 'a', className: 'dsh-git-qc-actions' },
          h('button', {
            key: 'ok', type: 'button', className: 'dsh-git-btn dsh-git-primary',
            disabled: canSave !== true,
            title: 'git ' + (running === true ? '正在改写…' : 'commit --amend / rebase -i，把这条消息写进提交'),
            onClick: function (event) { stopEvent(event); if (canSave === true) props.onSave() },
          }, running === true ? '改写中…' : '保存'),
          h('button', {
            key: 'no', type: 'button', className: 'dsh-git-btn',
            disabled: running === true,
            onClick: function (event) { stopEvent(event); props.onClose() },
          }, '取消')))
    }

    /* ── 「合并提交… / 批量删除提交…」的确认框（作用于整个选区）──

       列出选区提交（消息由 git/commit-messages 取，合并消息从它们预填、可编辑）；
       删除那档把「连同改动一并丢弃」说在前头。确认即关框发动作（拣选/还原同一条
       「动作发起即关」的规矩），失败错误条可见。 */
    function SelRewriteBox(props) {
      const state = props.state
      const squash = state.mode === 'squash'
      const rows = Array.isArray(state.list) ? state.list.slice().reverse() : []
      const [box] = React.useState(function () { return { node: null } })
      useOutsideDismiss(true, props.onClose, [box])
      const onKey = function (event) {
        if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
          event.preventDefault()
          props.onConfirm()
          return
        }
        if (event.key === 'Escape') { event.preventDefault(); props.onClose() }
      }
      return h('div', { className: 'dsh-git-qc-box', ref: function (node) { box.node = node }, onKeyDown: onKey },
        h('div', { key: 'h', className: 'dsh-git-qc-head' },
          squash === true
            ? '合并选中的 ' + String(state.targets.length) + ' 条提交'
            : '删除选中的 ' + String(state.targets.length) + ' 条提交'),
        state.loading === true
          ? h('div', { key: 'wait', className: 'dsh-git-hint' }, '正在读取选区提交…')
          : h('div', { key: 'list', className: 'dsh-git-pushlist' }, rows.map(function (one, at) {
              return h('div', {
                key: text(one.hash) + ':' + String(at), className: 'dsh-git-trow',
                title: text(one.hash) + (text(one.message).length > 0 ? '\n' + text(one.message) : ''),
              },
                h('span', { key: 'h', className: 'dsh-git-phash' }, hashShort(one.hash)),
                h('span', { key: 's', className: 'dsh-git-psub' }, text(one.subject)))
            })),
        squash === true
          ? h('textarea', {
              key: 'ta', className: 'dsh-git-input', rows: 6,
              value: text(state.message),
              placeholder: '合并后这一条的完整消息（已按各提交的消息拼好，可以改）',
              onChange: function (event) { props.onMessage(event.target.value) },
            })
          : h('div', { key: 'warn', className: 'dsh-git-hint' },
              '删除会把这些提交**连同它们带来的改动一并丢弃** —— 工作区里将看不到这些改动。提交本身在 reflog 里还能找约 30 天，成功后成功条会把找回的命令给全。'),
        text(state.error).length > 0
          ? h('div', { key: 'err', className: 'dsh-git-error', style: { whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: '16px' } }, text(state.error))
          : null,
        h('div', { key: 'a', className: 'dsh-git-qc-actions' },
          h('button', {
            key: 'ok', type: 'button',
            className: 'dsh-git-btn dsh-git-primary' + (squash !== true ? ' dsh-git-danger' : ''),
            disabled: state.loading === true || (squash === true && text(state.message).trim().length === 0),
            title: squash === true
              ? 'git reset --soft 到选区最旧一条的父提交，再把合计改动提交为一条'
              : 'git reset --hard 到选区最旧一条的父提交 —— 提交与改动一起消失',
            onClick: function (event) { stopEvent(event); props.onConfirm() },
          }, squash === true ? '合并为一条' : '确认删除'),
          h('button', {
            key: 'no', type: 'button', className: 'dsh-git-btn',
            onClick: function (event) { stopEvent(event); props.onClose() },
          }, '取消')))
    }

    /* ── 「git 忽略项」分组（配置页「仓库」组的第四个下级组）──

       与收在它前面的三个下级组（提交身份 / 远端 / 换行符）不是一类账：那三组读写
       「本页正在编辑的那个仓库」的 .git/config，这一组是**只读扫描**，吃的是页首
       仓库清单里的**全部**可选仓库（shown 清单：工作区扫到 + 手动登记，missing
       不在列）—— 被忽略的文件是每个工作树各一份的，所以每个仓库还要逐个 worktree
       工作树（主工作区 + git worktree add 出来的链接工作区）列一遍，行上标主/链接
       与分支。数据来自 Host 的 git/ignored-scan（65-worktree.js 下半，不进读缓存
       —— 要的就是「现在点、现在看」），点按钮才发，结果只住 React state：不持久化、
       不自动刷新，换会话面板重挂即清零。

       纯只读也写在明面上：扫描不写 .git/config、不动文件系统、更不删任何被忽略的
       项，分组说明与按钮 tooltip 都这么说。

       交互防重入：扫描在飞时按钮禁用（再点无效），单飞不排队 —— 结果回来整份替换
       上一次的。展示按 仓库 → 工作树 → 条目 三层折叠：仓库组头可收起（折叠惯例与
       RepoSwitcher / WorktreeBox 同一家：标题行即折叠开关、跟着组件挂载走）；工作树
       行默认收起、单击展开条目（2000 条的清单不该开门就糊一脸）。类名另起
       dsh-git-ign- 前缀，不混 dsh-git-repo-* / -wt-* —— 那两批是测试按个数认的
       控件（46-css.js 的说明），折叠三角这类没人按个数认的小记号才借。 */
    function GitIgnoredScanGroup(props) {
      const sessionId = props.sessionId
      const repos = Array.isArray(props.repos) ? props.repos : []
      const labels = props.labels != null ? props.labels : {}
      const [scan, setScan] = React.useState(null)
      const [scanning, setScanning] = React.useState(false)
      const [problem, setProblem] = React.useState('')
      /* 折叠账：仓库按路径、工作树按「仓库路径 \0 工作树路径」，一只 state 收两本。
         默认仓库全展开、工作树全收起 —— 第一次看到的是「有多少、在哪个仓库」，
         条目要一层层点开看。 */
      const [folded, setFolded] = React.useState(function () { return { repos: {}, trees: {} } })
      /* 宿主旧版（git/ignored-scan 还没注册）：与「远端」组的 remoteHostOld 同一个
         判据 —— callHost 把 HOST_NOT_READY 重试耗尽的原话带回来，那与仓库、与 git
         都无关，甩原文只会把读者引去查仓库。 */
      const hostOld = problem.indexOf(HOST_NOT_READY) >= 0

      const toggle = function (book, key) {
        setFolded(function (prev) {
          const next = { repos: Object.assign({}, prev.repos), trees: Object.assign({}, prev.trees) }
          next[book][key] = next[book][key] !== true
          return next
        })
      }

      const runScan = function () {
        if (scanning === true) return
        setScanning(true)
        setProblem('')
        const body = sessionId.length > 0 ? { sessionId: sessionId } : {}
        body.repos = repos.slice()
        callHost('git/ignored-scan', body).then(function (data) {
          setScanning(false)
          if (data == null || data.ok !== true) {
            setProblem(commandDetail(data) || '扫描失败')
            return
          }
          setScan(data)
        }, function (failure) {
          setScanning(false)
          setProblem(failureText(failure))
        })
      }

      const rows = []
      /* 组头行：标题吃剩余宽度，主视觉扫描按钮贴行尾 —— 与「远端」组头挂 ⟳ 同一个
         group-row 画法，按钮用这一页的主按钮长相（这一页不新造按钮长相）。 */
      rows.push(h('div', { key: 'head', className: 'dsh-git-set-group dsh-git-set-group-row' },
        h('span', null, 'git 忽略项（只读）'),
        h('button', {
          type: 'button', className: 'dsh-git-btn dsh-git-primary',
          disabled: scanning === true || repos.length === 0,
          title: repos.length === 0
            ? '上面还没有可选的仓库 —— 先把仓库加进清单再来扫描'
            : '列出清单里全部仓库（含每个 worktree 工作树）被 git 忽略的文件与目录。只读：不写 .git、不动文件、不删任何被忽略的项',
          onClick: function () { runScan() },
        }, scanning === true ? '扫描中…' : '扫描忽略项')))

      rows.push(h('div', { key: 'hint', className: 'dsh-git-set-hint' },
        '扫的是上面仓库清单里的全部仓库（不只是本页正在编辑的那个），每个仓库再逐个 worktree 工作树列：忽略规则按 .gitignore、.git/info/exclude 与全局排除一起算，整个被忽略的目录折成一行带尾斜杠。结果不保存、不自动刷新，每次都是点了按钮现扫；扫描只读，不会改任何文件。'))

      if (repos.length === 0) {
        rows.push(h('div', { key: 'norepos', className: 'dsh-git-set-hint' },
          '这个工作区还没有可选的仓库 —— 先在上面把仓库加进清单，再来扫忽略项。'))
        return h('div', { className: 'dsh-git-ign' }, rows)
      }

      if (problem.length > 0) {
        rows.push(h('div', { key: 'problem', className: 'dsh-git-set-hint dsh-git-warn' },
          hostOld === true
            ? '忽略项扫描要在重启 DSH、加载新版宿主之后才可用 —— 现在运行的宿主进程还是旧版；重启后回到这里再点一次扫描'
            : '扫描失败：' + problem))
      }

      if (scan == null) {
        if (problem.length === 0) {
          rows.push(h('div', { key: 'unscanned', className: 'dsh-git-set-hint' },
            scanning === true ? '正在扫描…' : '还没扫描过 —— 点右上角的「扫描忽略项」开始。'))
        }
        return h('div', { className: 'dsh-git-ign' }, rows)
      }

      /* 两把闸的汇总说明（Host 的 truncated / timedOut）：先讲「数字为什么少」，
         再讲「哪些格子没扫」—— 都说清楚边界，不装作结果完整。 */
      if (scan.truncated === true) {
        rows.push(h('div', { key: 'truncated', className: 'dsh-git-set-hint dsh-git-warn' },
          '忽略项太多，清单在 2000 条处截断 —— 数字比实际少。'))
      }
      if (scan.timedOut === true) {
        rows.push(h('div', { key: 'timedout', className: 'dsh-git-set-hint dsh-git-warn' },
          '扫描总时长到了上限（约 30 秒）：标着「没有扫」的仓库与工作树是到点后停下来的，再点一次扫描可以重试。'))
      }

      const reports = Array.isArray(scan.repos) ? scan.repos : []
      if (reports.length === 0) {
        rows.push(h('div', { key: 'empty', className: 'dsh-git-set-hint' }, '清单里没有可扫描的仓库。'))
        return h('div', { className: 'dsh-git-ign' }, rows)
      }

      /* 单棵工作树条目区的展示上限：拿到 2000 条也只展开渲染 300 条，更多的一句话
         交代 —— 一次糊几千行 DOM 谁都不好受，要看的那几条多半在前排。 */
      const ITEM_SHOW_MAX = 300

      for (let i = 0; i < reports.length; i += 1) {
        const one = reports[i]
        const repoPath = text(one.path)
        const repoFolded = folded.repos[repoPath] === true
        const trees = Array.isArray(one.worktrees) ? one.worktrees : []
        let count = 0
        for (let t = 0; t < trees.length; t += 1) {
          count += Array.isArray(one.worktrees[t].items) ? one.worktrees[t].items.length : 0
        }
        rows.push(h('div', {
          key: 'repo:' + repoPath,
          className: 'dsh-git-ign-repo-head',
          title: repoPath + (repoFolded === true ? '\n单击展开这个仓库的工作树' : '\n单击收起这个仓库的工作树'),
          onClick: function () { toggle('repos', repoPath) },
        },
          h('span', { className: 'dsh-git-repo-caret' + (repoFolded === true ? ' dsh-git-repo-caret-off' : '') },
            h(Icon, { name: 'down', size: 10 })),
          h('span', { className: 'dsh-git-ign-repo-name' }, repoShortName(labels, repoPath)),
          h('span', { className: 'dsh-git-ign-count' },
            one.ok === true ? trees.length + ' 个工作树 · ' + count + ' 项' : '扫描失败')))
        if (repoFolded === true) continue
        if (one.ok !== true) {
          rows.push(h('div', { key: 'repofail:' + repoPath, className: 'dsh-git-ign-wt dsh-git-ign-gone' },
            h('span', { className: 'dsh-git-ign-note' }, '这个仓库没扫出来：' + text(one.reason))))
          continue
        }
        if (trees.length === 0) {
          rows.push(h('div', { key: 'nobare:' + repoPath, className: 'dsh-git-ign-wt dsh-git-ign-gone' },
            h('span', { className: 'dsh-git-ign-note' }, '这个仓库没有可用的工作树（bare 仓库只有版本库，扫不了忽略项）')))
          continue
        }
        for (let t = 0; t < trees.length; t += 1) {
          const wt = trees[t]
          const wtPath = text(wt.path)
          const isMain = wt.main === true
          const branch = text(wt.branch)
          const wtKey = repoPath + '\u0000' + wtPath
          const wtOpen = folded.trees[wtKey] === true
          const okWt = wt.ok !== false
          const items = Array.isArray(wt.items) ? wt.items : []
          const wtTitle = [wtPath, isMain ? '主工作区' : 'git worktree add 出来的链接工作区',
            wt.detached === true ? '游离 HEAD（不站任何分支）' : (branch.length > 0 ? '分支：' + branch : '——')]
          if (okWt === true) {
            wtTitle.push(wtOpen === true ? '单击收起条目清单' : '单击展开条目清单')
          }
          rows.push(h('div', {
            key: 'wt:' + wtKey,
            className: 'dsh-git-ign-wt' + (okWt === true ? '' : ' dsh-git-ign-gone'),
            title: wtTitle.join('\n'),
            onClick: okWt === true ? function () { toggle('trees', wtKey) } : undefined,
          },
            h('span', { className: 'dsh-git-repo-caret' + (wtOpen === true ? '' : ' dsh-git-repo-caret-off') },
              okWt === true ? h(Icon, { name: 'down', size: 10 }) : null),
            h('span', { className: 'dsh-git-ign-tag' + (isMain === true ? '' : ' dsh-git-ign-tag-link') },
              isMain === true ? '主' : '链接'),
            h('span', { className: 'dsh-git-ign-branch' },
              wt.detached === true ? '游离 HEAD' : (branch.length > 0 ? branch : '——')),
            h('span', { className: 'dsh-git-ign-count' },
              okWt === true
                ? (items.length === 0 ? '没有忽略项' : items.length + ' 项' + (wt.truncated === true ? '（不完整）' : ''))
                : '没有扫')))
          if (okWt !== true) {
            rows.push(h('div', { key: 'wtfail:' + wtKey, className: 'dsh-git-ign-wt dsh-git-ign-gone' },
              h('span', { className: 'dsh-git-ign-note' }, '读取失败：' + text(wt.reason))))
            continue
          }
          if (wtOpen !== true) continue
          const itemRows = []
          if (items.length === 0) {
            itemRows.push(h('div', { key: 'none', className: 'dsh-git-ign-item dsh-git-ign-note' },
              '这个工作树没有被 git 忽略的文件'))
          } else {
            for (let k = 0; k < items.length && k < ITEM_SHOW_MAX; k += 1) {
              const item = items[k]
              itemRows.push(h('div', {
                key: 'it:' + k,
                className: 'dsh-git-ign-item' + (item.dir === true ? ' dsh-git-ign-item-dir' : ''),
              }, text(item.path)))
            }
            if (items.length > ITEM_SHOW_MAX) {
              itemRows.push(h('div', { key: 'more', className: 'dsh-git-ign-item dsh-git-ign-note' },
                '…还有 ' + (items.length - ITEM_SHOW_MAX) + ' 项没有显示（这个工作树共 ' + items.length + ' 项）'))
            }
          }
          rows.push(h('div', { key: 'items:' + wtKey, className: 'dsh-git-ign-items' }, itemRows))
        }
      }

      return h('div', { className: 'dsh-git-ign' }, rows)
    }

    function GitConfigPane(props) {
      const sessionId = props.sessionId
      /* 两档作用域：项目（本仓库的 .git/config）与全局（插件与这台机器，79-globalconfig.js）。
         选哪档是「这个浏览器怎么用这一页」的偏好，落在浏览器本地那份 settings 里，
         下次打开还在；首次进来是项目 —— 面板本来就是对着当前仓库说话的。 */
      const prefs = useGitSettings()
      const [scope, setScope] = React.useState(prefs.configScope === 'global' ? 'global' : 'project')
      const pickScope = function (next) {
        setScope(next)
        if (prefs.configScope !== next) saveSettings(Object.assign({}, prefs, { configScope: next }))
      }
      const scopeTab = function (id, label, hint) {
        return h('button', {
          key: id, type: 'button',
          className: 'dsh-git-cview' + (scope === id ? ' dsh-git-cview-on' : ''),
          title: hint,
          onClick: function () { pickScope(id) },
        }, label)
      }
      const scopeTabs = h('div', { className: 'dsh-git-cfg-tabs' },
        scopeTab('project', '项目配置', '关于哪个仓库由页首「仓库」组挑（默认当前生效仓库）：会话完成后自动刷新/推送、只写 --local 的提交身份、换行符与远端'),
        scopeTab('global', '全局配置', '跟着插件与这台机器走：初始化分支、远程同步、快捷命令、git 位置、提交身份（--global）、换行符（--global）与本浏览器的外观'))
      const plugin = usePluginConfig()
      const autoPushNote = useAutoPush()
      const [snap, setSnap] = React.useState(null)
      const [name, setName] = React.useState('')
      const [email, setEmail] = React.useState('')
      /* 「远端」组的另一份读数（git/remotes）：身份/换行符的快照里没有它，单独问。
         rName/rUrl 是添加区的两个草稿框；editRemote/editUrl 是行内「改地址」的那一格
         （null = 没有行在编辑）；armRemote 记着删除按钮已上膛的那一行（再点一次才是
         git remote remove）。 */
      const [remoteSnap, setRemoteSnap] = React.useState(null)
      const [rName, setRName] = React.useState('')
      const [rUrl, setRUrl] = React.useState('')
      const [editRemote, setEditRemote] = React.useState(null)
      const [editUrl, setEditUrl] = React.useState('')
      const [armRemote, setArmRemote] = React.useState('')
      /* 组头 ⟳ 那次重读的在飞标记，与 busy 分开：busy 说的是「在写 .git/config」，
         重读只是读，不该顺带把整页输入禁掉 —— 禁的只有这枚键自己。 */
      const [remoteRefreshing, setRemoteRefreshing] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [problem, setProblem] = React.useState('')

      /* ── 多仓库：这一页在编辑哪个仓库（24-repos.js 的同一份清单）──

         项目配置过去只发会话 id，仓库由宿主从会话工作区解；一个工作区嵌着好几个
         仓库之后，「眼前这个仓库」成了可挑的 —— 页首这组「仓库」复用历史/变更页
         那份清单（扫描 + 手动 + missing），单击行只换**本页**的编辑目标。选择态按
         repoViews 的先例按会话 + pane（'config'）独立记，绝不调 applyRepo：配置页
         改哪个仓库的 .git/config，不该反过来改面板在看哪个仓库。默认目标 = 当前
         生效仓库；请求显式带 repo: <路径>（宿主 repoFrom 显式路径优先，缺省才回退
         会话工作区），sessionId 照旧带上 —— 写配置的沙箱策略跟着这个会话走。 */
      useRepoViews()
      const effective = text(props.effective)
      const repoList = props.repoList != null ? props.repoList : repoListEmpty()
      const pickable = reposShown(repoList, effective)
      const storedPick = repoSelection(sessionId, 'config')
      /* 清单里已经没有的旧选择（手动仓库被移除、或扫描还没落地）不作数：退回生效
         仓库。missing 行不可选，所以只对 shown 这半边核对。 */
      const targetRepo = storedPick.length > 0 && pickable.indexOf(storedPick[0]) >= 0
        ? storedPick[0]
        : effective
      /* 写答复落地时要问「目标现在还是不是它」：run/runRemote 的回调闭着的是发起
         那次渲染的旧值，比不得 —— 这里放一只随渲染更新的小盒子（draftBox /
         cmdLogBox 同款），回调时读到的永远是当前目标。 */
      const [targetBox] = React.useState(function () { return { repo: '' } })
      targetBox.repo = targetRepo

      /* 换编辑目标共用的一步：上一目标的半截话一并放下。名字/邮箱草稿是「对着眼下
         这个仓库要说的话」，仓库换了话就换了对象，留着只会被写进别的仓库；远端行
         的编辑与上膛、两条提示同理由。快照与远端表也清掉 —— 下面的读认 targetRepo，
         会立刻重读，别让读者盯着上一个仓库的值以为是这一个的。 */
      const adoptTarget = function (one) {
        setRepoSelection(sessionId, 'config', [one])
        setSnap(null)
        setRemoteSnap(null)
        setName(''); setEmail(''); setRName(''); setRUrl('')
        setEditRemote(null); setEditUrl(''); setArmRemote('')
        setNote(''); setProblem('')
      }
      const pickRepo = function (path) {
        const one = text(path)
        if (one.length === 0 || one === targetRepo) return
        adoptTarget(one)
      }

      /* ── 三个下级组的组头：点名当前编辑目标的短名 ──

         「这三组写的是哪个仓库」是它们最要紧的一句话，收进「仓库」组之后由组头自己
         回答：短名取 24-repos.js 的同一份清单、同一份标签（repoLabelMap / repoShortName，
         与切换器行、两处分组头同一个来源），仓库一换组头跟着换。目标还没读到
         （effective 没回来、也没存过选择）时没有短名可点，退回原来的泛称文案。 */
      const cfgLabels = repoLabelMap(pickable)
      const targetShortName = targetRepo.length > 0 ? repoShortName(cfgLabels, targetRepo) : ''
      const identGroupTitle = targetShortName.length > 0
        ? '提交身份（只写 ' + targetShortName + ' 的 .git/config）'
        : '提交身份（只写这个项目的 .git/config）'
      const remoteGroupTitle = targetShortName.length > 0
        ? '远端（' + targetShortName + ' 的 remote 清单）'
        : '远端（这个仓库的 remote 清单）'
      const crlfGroupTitle = targetShortName.length > 0
        ? '换行符（' + targetShortName + ' 的 git 换行配置）'
        : '换行符（git 自己的换行配置）'

      /* 只把 session id 交给 Host（全局配置 GitIdentityGroup 同一条路）：路径由 Host
          从会话的工作区解出来，写配置的沙箱策略也跟着这个会话走。多仓库之后这页
          在编辑哪个仓库就明说哪条路径 —— 显式路径优先，缺省（还没读到生效仓库时）
          照旧回退会话工作区。 */
      const request = function () {
        const body = sessionId.length > 0 ? { sessionId: sessionId } : {}
        if (targetRepo.length > 0) body.repo = targetRepo
        return body
      }
      React.useEffect(function () {
        let alive = true
        callHost('git/project-config', request()).then(function (data) {
          if (alive !== true) return
          setSnap(data)
          setProblem('')
        }, function (failure) {
          if (alive !== true) return
          setProblem(failureText(failure))
        })
        return function () { alive = false }
      }, [sessionId, targetRepo])

      /* 远端清单单独读（Host 每次都真跑 git remote -v，不进缓存）：失败落在这个组
         自己的说明行里（「远端列表没读出来：…」），不去占页面底部那条 problem ——
         那条是身份/换行符写失败的位置，两组互不遮蔽。读法只有一份（readRemotes），
         挂载与组头的 ⟳（remoteReload）各自发起：只读且幂等，答复按落地顺序覆盖，
         正好是「最后一次读算数」。 */
      const readRemotes = function (land) {
        callHost('git/remotes', request()).then(land, function (failure) {
          land({ ok: false, stderr: failureText(failure) })
        })
      }
      React.useEffect(function () {
        let alive = true
        readRemotes(function (snap) { if (alive === true) setRemoteSnap(snap) })
        return function () { alive = false }
      }, [sessionId, targetRepo])

      /* 组头的 ⟳：只重发上面那次读。busy 期间禁用 —— 同一页可能正在写 .git/config，
         先让写动作把话（note/problem）说完。它自己也不碰那两条：note/problem 是写
         动作的位置，一次刷新不该把它们抹掉。宿主还是旧版时它会一直失败（10-state.js
         的 HOST_NOT_READY 重试耗尽原话，见 remoteHostOld），灰字说明行把出路讲清；
         哪天重启了 DSH 加载了新版宿主，点它就能把清单读出来。 */
      const remoteReload = function () {
        if (busy === true || remoteRefreshing === true) return
        setRemoteRefreshing(true)
        readRemotes(function (snap) {
          setRemoteSnap(snap)
          setRemoteRefreshing(false)
        })
      }

      const configOf = function (key) {
        const one = snap != null && snap.config != null ? snap.config[key] : null
        return one != null ? one : { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' }
      }

      /* 写（或清）之后 Host 读回来的是新快照：照它重画。只重画摸过的那几格 —— 只动
         换行符不该把读者打到一半的名字弄没。 */
      const run = function (payload, said) {
        if (busy) return
        setBusy(true)
        setNote('')
        setProblem('')
        const body = request()
        if (payload != null) Object.assign(body, payload)
        const forRepo = targetBox.repo
        callHost('git/project-config-save', body).then(function (result) {
          setBusy(false)
          /* 编辑目标已经切走：这份答复属于上一个仓库，一个字节都不上屏 ——
             setSnap 会把新目标的读数顶掉（与 10-state.js 的 repoEpoch 同一个问题）。 */
          if (targetBox.repo !== forRepo) return
          if (result == null || result.ok !== true) {
            setProblem(commandDetail(result) || '保存失败')
            return
          }
          setSnap(result)
          const written = Array.isArray(result.written) ? result.written : []
          const unset = Array.isArray(result.unset) ? result.unset : []
          if (written.indexOf('user.name') >= 0 || unset.indexOf('user.name') >= 0) setName(text(result.config['user.name'].local))
          if (written.indexOf('user.email') >= 0 || unset.indexOf('user.email') >= 0) setEmail(text(result.config['user.email'].local))
          setNote(text(said).length > 0 ? said : '已写进 ' + text(result.repo) + ' 的 .git/config')
        }, function (failure) {
          setBusy(false)
          setProblem(failureText(failure))
        })
      }

      /* 全局配置 setPlugin 的同款：草稿即时、落盘有 400ms 去抖（20-prefs.js）。 */
      const setPlugin = function (key, value) {
        const next = Object.assign({}, plugin)
        next[key] = value
        savePluginConfig(next)
      }

      /* 全局配置 GitIdentityGroup 的 source() 同款：值 + 它来自哪个文件。 */
      const source = function (value, origin) {
        const one = text(value)
        if (one.length === 0) return '没有配'
        const from = text(origin)
        return from.length === 0 ? one : (one + '（来自 ' + from + '）')
      }
      const globalPlaceholder = function (value) {
        const one = text(value)
        return one.length > 0 ? '留空 = 用全局（' + one + '）' : '留空 = 用全局（当前全局也未配置）'
      }

      const nameNow = configOf('user.name')
      const emailNow = configOf('user.email')
      const autocrlf = configOf('core.autocrlf')
      const safecrlf = configOf('core.safecrlf')
      const inside = snap != null && snap.insideRepo === true
      const nameMissing = inside && text(nameNow.effective).length === 0
      const emailMissing = inside && text(emailNow.effective).length === 0
      const identMissing = nameMissing || emailMissing
      /* 「清掉本项目覆盖」作用的那几个键：填过（local 有值）的才在列。 */
      const localKeys = []
      const ALL_KEYS = ['user.name', 'user.email', 'core.autocrlf', 'core.safecrlf']
      for (let i = 0; i < ALL_KEYS.length; i += 1) {
        if (text(configOf(ALL_KEYS[i]).local).length > 0) localKeys.push(ALL_KEYS[i])
      }
      const nameDraft = text(name).trim()
      const emailDraft = text(email).trim()

      /* 换行符那两行的通用画法：下拉第一项固定是「跟随全局」（括号里带全局当前值，
          没配就说没配），右边一句话答「此刻生效」。选中即写（或即清）—— 这两个键
          没有草稿可言，选错一次的成本由 git 自己的语义兜着，而清掉随时可回。 */
      const lineSelect = function (key, entry, choices, title) {
        const value = text(entry.local)
        const options = [h('option', {
          key: 'follow', value: '',
          title: '清掉本项目的 ' + key + '，用回全局那份（本来没配也算成功）',
        }, '跟随全局' + (text(entry.global).length > 0 ? '（全局当前：' + entry.global + '）' : '（全局未配置）'))]
        for (let i = 0; i < choices.length; i += 1) {
          options.push(h('option', { key: choices[i], value: choices[i] }, choices[i]))
        }
        return h('div', { className: 'dsh-git-set-row', key: key },
          h('span', { className: 'dsh-git-set-label' }, key),
          h('select', {
            className: 'dsh-git-set-select', value: value, title: title,
            disabled: busy || inside !== true,
            onChange: function (event) {
              const next = event.target.value
              if (next.length === 0) run({ unset: [key] }, '已清掉 ' + key + ' 的本项目覆盖，用回全局')
              else {
                const setPayload = {}
                setPayload[key] = next
                run({ set: setPayload }, '已把 ' + key + ' = ' + next + ' 写进' + (targetRepo.length > 0 ? ' ' + targetRepo : '本项目'))
              }
            },
          }, options),
          h('span', { className: 'dsh-git-set-hint' },
            '此刻生效：' + (text(entry.effective).length > 0
              ? entry.effective + '（来自 ' + (text(entry.effectiveOrigin).length > 0 ? entry.effectiveOrigin : '全局') + '）'
              : '未配置')))
      }

      /* ── 「远端」组 ──

         三个动作各是各的 payload（Host 一次只收一个：add / setUrl / remove）。成功
         答复带的是 Host 重新读出的远端表 —— 照它重画（读回来而不是回显输入，与身份
         /换行符两组同一条原则），提示行的地址也从表里取（git 此刻的答案，不是打进去
         的那串）；然后 props.onChanged() 把面板整体刷新一遍 —— 分支树的「远程」分组
         跟着变。 */
      const remoteInside = remoteSnap != null && remoteSnap.ok === true && remoteSnap.insideRepo === true
      const remotes = remoteSnap != null && remoteSnap.ok === true && Array.isArray(remoteSnap.remotes) ? remoteSnap.remotes : []
      const remoteUrlNow = function (result, name) {
        const list = result != null && Array.isArray(result.remotes) ? result.remotes : []
        for (let i = 0; i < list.length; i += 1) {
          if (list[i] != null && text(list[i].name) === name) return text(list[i].url)
        }
        return ''
      }
      const runRemote = function (payload, onOk) {
        if (busy) return
        setBusy(true)
        setNote('')
        setProblem('')
        const body = request()
        Object.assign(body, payload)
        const forRepo = targetBox.repo
        callHost('git/remotes-save', body).then(function (result) {
          setBusy(false)
          /* 同 run：目标切走后落地的旧答复不上屏，onChanged 也不再整面板刷 ——
             那次改动发生在别的仓库，与眼下正在看的没有关系。 */
          if (targetBox.repo !== forRepo) return
          if (result == null || result.ok !== true) {
            setProblem(commandDetail(result) || '远端操作失败')
            return
          }
          setRemoteSnap(result)
          setEditRemote(null)
          setEditUrl('')
          setArmRemote('')
          if (typeof onOk === 'function') onOk(result)
          if (typeof props.onChanged === 'function') props.onChanged()
        }, function (failure) {
          setBusy(false)
          setProblem(failureText(failure))
        })
      }
      const remoteAdd = function () {
        const wanted = { name: rName.trim(), url: rUrl.trim() }
        if (wanted.name.length === 0 || wanted.url.length === 0) return
        runRemote({ add: wanted }, function (result) {
          setRName('')
          setRUrl('')
          /* 可连续添加：框一清就能添下一个；提示行带上 git 记下的地址。 */
          const now = remoteUrlNow(result, wanted.name)
          setNote('已添加远端 ' + wanted.name + (now.length > 0 ? ' → ' + now : ''))
        })
      }
      const remoteSetUrl = function (name) {
        const wanted = editUrl.trim()
        if (name.length === 0 || wanted.length === 0) return
        runRemote({ setUrl: { name: name, url: wanted } }, function (result) {
          const now = remoteUrlNow(result, name)
          setNote('已把远端 ' + name + ' 的地址改为 ' + (now.length > 0 ? now : wanted))
        })
      }
      const remoteRemove = function (name) {
        if (name.length === 0) return
        runRemote({ remove: { name: name } }, function () {
          setNote('已删除远端 ' + name)
        })
      }
      const remoteEditStart = function (name, url) {
        setArmRemote('')
        setEditRemote(name)
        setEditUrl(url)
      }
      const remoteEditStop = function () {
        setEditRemote(null)
        setEditUrl('')
      }

      /* 远端每一行的画法：名字 + fetch 地址（push 不同才一并显示）。改地址是行内
         编辑（回车保存、Esc 退出，不弹层 —— 这一页没有弹层的先例）；删除两段式
         确认，第二次点才是 git remote remove（78-actions.js 删快捷命令同款 arm）。
         不是仓库时全部按钮禁用，说明行解释为什么。 */
      const remoteRows = []
      for (let i = 0; i < remotes.length; i += 1) {
        const one = remotes[i]
        const remoteName = one != null ? text(one.name) : ''
        if (remoteName.length === 0) continue
        const fetchUrl = one != null ? text(one.url) : ''
        const pushUrl = one != null ? text(one.pushUrl) : ''
        const editing = editRemote === remoteName
        remoteRows.push(h('div', { className: 'dsh-git-set-row', key: remoteName },
          h('span', { className: 'dsh-git-set-label', title: remoteName }, remoteName),
          editing
            ? h('input', {
                className: 'dsh-git-input dsh-git-set-input', autoFocus: true,
                placeholder: '新地址（URL）', value: editUrl, disabled: busy,
                onChange: function (event) { setEditUrl(event.target.value) },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') remoteSetUrl(remoteName)
                  if (event.key === 'Escape') remoteEditStop()
                },
              })
            : h('span', { className: 'dsh-git-set-hint dsh-git-set-url', title: fetchUrl },
                fetchUrl.length > 0 ? fetchUrl + (pushUrl.length > 0 ? '（push：' + pushUrl + '）' : '') : '（没有地址）'),
          editing
            ? h('button', {
                key: 'save', type: 'button', className: 'dsh-git-btn dsh-git-primary',
                disabled: busy || editUrl.trim().length === 0,
                title: 'git remote set-url ' + remoteName + ' <地址>',
                onClick: function () { remoteSetUrl(remoteName) },
              }, '保存')
            : h('button', {
                key: 'edit', type: 'button', className: 'dsh-git-btn',
                disabled: busy || remoteInside !== true,
                title: '改这个远端的地址（git remote set-url）',
                onClick: function () { remoteEditStart(remoteName, fetchUrl) },
              }, '改地址'),
          editing
            ? h('button', {
                key: 'cancel', type: 'button', className: 'dsh-git-btn',
                disabled: busy,
                onClick: function () { remoteEditStop() },
              }, '取消')
            : (armRemote === remoteName
              ? h('button', {
                  key: 'del', type: 'button', className: 'dsh-git-btn dsh-git-danger',
                  disabled: busy || remoteInside !== true,
                  title: '再点一次确认删除（git remote remove ' + remoteName + '）',
                  onClick: function () { remoteRemove(remoteName) },
                }, '确认删除')
              : h('button', {
                  key: 'del', type: 'button', className: 'dsh-git-btn',
                  disabled: busy || remoteInside !== true,
                  title: '删除这个远端（git remote remove ' + remoteName + '）—— 删除前会先确认一次',
                  onClick: function () { remoteEditStop(); setArmRemote(remoteName) },
                }, '删除'))))
      }

      /* 宿主还没加载新版的那一种失败：git/remotes 这条路由在旧宿主进程里不存在，
         callHost 把 10-state.js HOST_NOT_READY 重试耗尽后的原话（is not registered
         原样带回）抛到这里 —— 它与这个仓库、与 git 都无关，甩原文只会把读者引去查
         仓库；照上面 insideRepo:false 那行灰字的说法讲出路（重启 DSH 加载新版宿主，
         回来点组头的 ⟳ 重读一次），不带错误原文。其余失败（git 真的失败了）照旧
         给原文。 */
      const remoteHostOld = remoteSnap != null && remoteSnap.ok !== true
        && text(remoteSnap.stderr).indexOf(HOST_NOT_READY) >= 0

      /* 组头的说明行：宿主旧版、读不出来、不是仓库、空表、正常，各说各的话。 */
      const remoteGroupHint = remoteSnap == null
        ? '正在读取…'
        : (remoteHostOld === true
          ? '远端管理要在重启 DSH、加载新版宿主之后才生效 —— 现在运行的宿主进程还是旧版，读不到远端清单；重启 DSH 后回到这里点组头的 ⟳ 重读一次'
          : (remoteSnap.ok !== true
            ? '远端列表没读出来：' + (text(remoteSnap.stderr).length > 0 ? text(remoteSnap.stderr) : 'git remote -v 失败')
            : (remoteInside !== true
              ? '这个会话的工作区还不是 Git 仓库 —— 远端加不了也改不了'
              : (remotes.length === 0
                ? '还没有配置任何远端 —— 添加一个之后，fetch / pull / push 与分支树的「远程」分组才有内容'
                : 'fetch / pull / push 推向谁、分支树「远程」分组里有什么，都跟着这份清单走；名字之外每个远端还各有 push 地址'))))

      const rNameDraft = rName.trim()
      const rUrlDraft = rUrl.trim()

      const sessionHint = props.sessionAware === true
        ? '会话跑完那一刻自动做一次 ⟳ 级别的整棵树刷新：chip 的分支名/改动数、变更/历史页跟着更新，命令页若开着也重读 —— 刚被会话新建的文件只有全树读能看见，这正是它该刷的时机。'
        : '当前环境不支持会话状态监听（bridge 版没有会话状态的 props），这两条开关不起作用。'

      /* 全局那一档整个交给 79-globalconfig.js：项目这半的快照（身份/换行符/远端）
         与它的草稿状态都还留在这只组件里，切回来不必重读。 */
      if (scope === 'global') {
        return h('div', { className: 'dsh-git-set dsh-git-config' },
          scopeTabs,
          h(GitGlobalConfigPane, { key: 'global', sessionId: sessionId }))
      }

      return h('div', { className: 'dsh-git-set dsh-git-config' },
        scopeTabs,

        /* ── 会话完成（插件级）：setPlugin 写的是插件自己的配置，不跟本页编辑目标
           走 —— 留在「仓库」组外、放最前；自动推送提示里照实说「作用于生效仓库、
           不随本页正在编辑的仓库走」。 ── */
        h('div', { className: 'dsh-git-set-group' }, '会话完成'),
        h('div', { className: 'dsh-git-set-hint' }, sessionHint),

        h('div', { className: 'dsh-git-set-row' },
          h('label', { className: 'dsh-git-set-check' },
            h('input', {
              type: 'checkbox', checked: plugin.refreshOnComplete !== false,
              onChange: function (event) { setPlugin('refreshOnComplete', event.target.checked) },
            }),
            h('span', null, '会话完成时刷新 git 状态'))),

        h('div', { className: 'dsh-git-set-row' },
          h('label', { className: 'dsh-git-set-check' },
            h('input', {
              type: 'checkbox', checked: plugin.pushOnAllComplete === true,
              onChange: function (event) { setPlugin('pushOnAllComplete', event.target.checked) },
            }),
            h('span', null, '所有会话都完成时自动推送')),
          h('span', { className: 'dsh-git-set-hint' },
            '本页所有会话（含子代理会话）都停止运行且稳定 5 秒后，对当前生效仓库执行一次 push（等同顶栏 ↑；生效仓库是页首「仓库」列表里带 ● 的那行，不随本页正在编辑的仓库走）；只推「领先远端且没有未解决冲突」的分支，失败只记录不重试。')),

        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '最近一次自动推送'),
          h('span', { className: 'dsh-git-set-hint' },
            autoPushNote == null ? '还没有自动推送过'
              : (cmdClock(autoPushNote.time) + ' · ' + (autoPushNote.ok === true ? '成功' : '失败') + '：' + text(autoPushNote.detail)))),

        /* ── 「仓库」一组：顶部挑本页编辑目标（受控单选，行为不动），受切换仓库影响
           的三组收在外框里做下级 —— 缩进 + 左侧竖线（46-css.js 的 dsh-git-set-scope
           / -scope-body），一眼读出「这三块属于上面选中的那个仓库」；组头点名目标
           短名（identGroupTitle / remoteGroupTitle / crlfGroupTitle）。 ── */
        h('div', { className: 'dsh-git-set-scope' },
          h('div', { className: 'dsh-git-set-group' }, '仓库（这一页在编辑哪个仓库）'),
          h('div', { className: 'dsh-git-set-hint' },
            '收在本组内的提交身份、远端、换行符三个下级组，读写的都是这里选中的仓库，默认是当前生效仓库（带 ● 的行）。单击行只换本页的编辑目标 —— 面板的生效仓库（历史、提交、推送用的那个）不跟着换，要换生效仓库去「历史」或「变更」页的仓库列表。会话工作区本身不是仓库时这组照常可用：把仓库目录「＋ 添加目录」登记进来，就能直接配置它。最末的「git 忽略项」是只读扫描，不跟这里的单选走 —— 它扫的是整份清单里的全部仓库。'),
          h(RepoSwitcher, {
            key: 'cfg-repos',
            sessionId: sessionId, pane: 'config', list: repoList, effective: effective,
            pick: targetRepo,
            onSingle: function (path) { pickRepo(path) },
            /* 「＋ 添加目录」与历史页是同一份持久清单、同一套报错话术（saveManualRepo /
               repoSaveProblem 都在 24-repos.js）；加成功的那一下顺手把新仓库选为本页
               目标 —— 读者加它就是要在它身上做配置。移除的正好是本页目标时退回
               生效仓库，别留在一条刚被移除的路径上。 */
            onAdd: function (path) {
              return saveManualRepo(sessionId, { add: path }).then(function (data) {
                adoptTarget(text(path))
                return data
              })
            },
            onRemove: function (path) {
              return saveManualRepo(sessionId, { remove: path }).then(function (data) {
                if (text(path) === targetRepo) adoptTarget('')
                return data
              })
            },
          }),

          /* 下面三个下级组读写的都是这里选中的仓库。 */
          h('div', { className: 'dsh-git-set-scope-body' },
            h('div', { className: 'dsh-git-set-group' }, identGroupTitle),
            h('div', { className: 'dsh-git-set-hint' },
              '这里只写 --local，全局那份不受影响。要改这台机器的那一份，切到上面的「全局配置 → 提交身份」—— 那边才选得到写进哪台机器。'),

            h('div', { className: 'dsh-git-set-row' },
              h('span', { className: 'dsh-git-set-label' }, '此刻生效'),
              h('span', { className: identMissing === true ? 'dsh-git-set-hint dsh-git-warn' : 'dsh-git-set-hint' },
                snap == null ? '正在读取…'
                  : (inside !== true
                    ? '这个会话的工作区还不是 Git 仓库 —— 下面只能看全局那份'
                    : (identMissing === true
                      ? '还缺：' + (nameMissing === true ? '名字' : '') + (nameMissing === true && emailMissing === true ? '/' : '') + (emailMissing === true ? '邮箱' : '') + ' —— 提交会被 git 拒绝'
                      : (source(nameNow.effective, nameNow.effectiveOrigin) + ' · ' + source(emailNow.effective, emailNow.effectiveOrigin)))))),

            h('div', { className: 'dsh-git-set-row' },
              h('span', { className: 'dsh-git-set-label' }, '名字（user.name）'),
              h('input', {
                className: 'dsh-git-input dsh-git-set-input',
                placeholder: globalPlaceholder(nameNow.global),
                value: name,
                disabled: inside !== true,
                onChange: function (event) { setName(event.target.value) },
              })),

            h('div', { className: 'dsh-git-set-row' },
              h('span', { className: 'dsh-git-set-label' }, '邮箱（user.email）'),
              h('input', {
                className: 'dsh-git-input dsh-git-set-input',
                placeholder: globalPlaceholder(emailNow.global),
                value: email,
                disabled: inside !== true,
                onChange: function (event) { setEmail(event.target.value) },
              })),

            h('div', { className: 'dsh-git-set-row' },
              h('button', {
                type: 'button', className: 'dsh-git-btn dsh-git-primary',
                disabled: busy || inside !== true || (nameDraft.length === 0 && emailDraft.length === 0),
                title: '把填了的键写进' + (targetRepo.length > 0 ? ' ' + targetRepo + ' ' : '本项目')
                  + '的 .git/config；空着的框一个字节都不写',
                onClick: function () {
                  const setPayload = {}
                  if (nameDraft.length > 0) setPayload['user.name'] = nameDraft
                  if (emailDraft.length > 0) setPayload['user.email'] = emailDraft
                  /* 提示行点名落点：多仓库之后「本项目」不再只有一个候选，写到哪要说全。 */
                  run({ set: setPayload }, '已写进 ' + (targetRepo.length > 0 ? targetRepo : '本项目') + ' 的 .git/config')
                },
              }, busy ? '写入中…' : '写入本项目'),
              h('button', {
                type: 'button', className: 'dsh-git-btn',
                disabled: busy || inside !== true || localKeys.length === 0,
                title: '对填过的键执行 git config --local --unset（本来就没配也算成功）',
                onClick: function () { run({ unset: localKeys }, '已清掉本项目覆盖，用回全局') },
              }, '清掉本项目覆盖，用回全局'),
              h('span', { className: 'dsh-git-set-hint' },
                localKeys.length > 0 ? '本项目覆盖了：' + localKeys.join('、') : '本项目没有覆盖任何键')),

            /* 组头行：标题吃剩余宽度，⟳ 贴行尾。不管读数成没成、宿主新不新版它都在 ——
               宿主旧版时它就是重启 DSH 之后的那把重试钥匙（remoteReload）；busy 或自己
               在飞时禁用。画法用差异头部同款的图标键（.dsh-git-tool-ico，55-diff.js 的
               diffIconButton 同一套类），这一页不新造按钮长相。 */
            h('div', { className: 'dsh-git-set-group dsh-git-set-group-row' },
              h('span', null, remoteGroupTitle),
              h('button', {
                type: 'button', className: 'dsh-git-tool dsh-git-tool-ico',
                disabled: busy || remoteRefreshing,
                title: '重新读取远端清单（git remote -v，不进缓存）—— 宿主旧版时报错属预期，重启 DSH 后这里能把清单读出来',
                onClick: function () { remoteReload() },
              }, '⟳')),
            h('div', { className: 'dsh-git-set-hint' }, remoteGroupHint),

            remoteRows,

            h('div', { className: 'dsh-git-set-row' },
              h('span', { className: 'dsh-git-set-label' }, '新远端'),
              h('input', {
                className: 'dsh-git-input dsh-git-set-input',
                placeholder: '名字（如 origin / upstream）',
                value: rName,
                disabled: busy || remoteInside !== true,
                onChange: function (event) { setRName(event.target.value) },
                onKeyDown: function (event) { if (event.key === 'Enter') remoteAdd() },
              }),
              h('input', {
                className: 'dsh-git-input dsh-git-set-input',
                placeholder: '地址（https://… 或 git@…）',
                value: rUrl,
                disabled: busy || remoteInside !== true,
                onChange: function (event) { setRUrl(event.target.value) },
                onKeyDown: function (event) { if (event.key === 'Enter') remoteAdd() },
              }),
              h('button', {
                type: 'button', className: 'dsh-git-btn dsh-git-primary',
                disabled: busy || remoteInside !== true || rNameDraft.length === 0 || rUrlDraft.length === 0,
                title: 'git remote add <名字> <地址>；成功后框清空，可以接着添下一个',
                onClick: function () { remoteAdd() },
              }, '添加远端'),
              h('span', { className: 'dsh-git-set-hint' }, '名字不能有空白；地址删除后就没了，git 不会替你记住。')),

            h('div', { className: 'dsh-git-set-group' }, crlfGroupTitle),
            h('div', { className: 'dsh-git-set-hint' },
              '两条都是 git 的换行符配置，同样只写上面选中的仓库（--local）：autocrlf=true 检出转 CRLF、提交转回 LF，input 只在提交时转 LF，false 不转；safecrlf 是把关开关，换行转换不可逆（行尾抹过一遍还原不回去）时 true 让 git 拒绝、warn 只警告、false 不把关。改动立即写进该仓库的 .git/config；选「跟随全局」= 清掉该仓库的这条（不存在算成功）。'),

            lineSelect('core.autocrlf', autocrlf, ['true', 'false', 'input'], '检出时把 LF 转 CRLF、提交时转回 LF（input 只在提交时转 LF，false 什么都不转）'),
            lineSelect('core.safecrlf', safecrlf, ['true', 'false', 'warn'], '换行转换不可逆（会丢字）时的把关开关：true 让 git 拒绝这次操作、warn 只警告照做、false 不把关'),

            /* 「git 忽略项」：第四个下级组，只读、不跟本页编辑目标走 —— 扫的是
               整份 shown 清单（pickable）里全部仓库的每个工作树，仓库短名也用
               同一份标签账（cfgLabels），分组头与切换器里叫的是同一个名字。 */
            h(GitIgnoredScanGroup, { key: 'ignored-scan', sessionId: sessionId, repos: pickable, labels: cfgLabels }))),

        note.length > 0 ? h('div', { className: 'dsh-git-set-row dsh-git-set-hint' }, note) : null,
        problem.length > 0 ? h('div', { className: 'dsh-git-set-row dsh-git-error' }, problem) : null)
    }

    function GitPanel(props) {
      const plugin = usePluginConfig()
      const prefs = useGitSettings()
      const sessionId = props.sessionId
      const switcher = useSwitchMode()
      const switching = useSwitchingTo()
      const [tab, setTab] = React.useState('log')
      /* Which repository this panel shows is not a panel setting: it is the
         session's workspace, and the Host resolves it from the session. The one
         exception is a path the reader picked on the setup page after the
         workspace turned out not to be a repository yet. */
      const [appliedRepo, setAppliedRepo] = React.useState(sessionRepo(sessionId))
      /* 这个会话的工作区，上一次读到的样子（如果还在记忆里）。DSH 换会话时这里会
         整个重挂，但"重挂"不等于"要重新测"——同一个工作区里换会话，Host 和全局读数
         拿到的本来就是同一份答案（见 10-state.js 的 rememberedPanel）。先把它铺上，
         挂载时那次读照旧发出，用答复确认或纠正。 */
      const [remembered] = React.useState(function () { return rememberedPanel(sessionId) })
      const [refs, setRefs] = React.useState(null)
      const [authors, setAuthors] = React.useState(null)
      const [graph, setGraph] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      /* ── 历史页右栏（CommitDetail）的窄屏折叠 ──
         narrowBody 量的是 .dsh-git-body 这块地（54-changes.js 的 useNarrowWidth，
         同一张槽表、同一个 560px 阈值：280 的详情栏 + 主列表至少还要留一列读得
         动的）；detailOpen 是读者的意愿 —— null＝没动过手时折叠与否跟 narrow 走
         （窄=折叠、宽=展开即现状），动过手以后 resize 只更新事实。与变更页提交栏
         的 commitOpen 互不干扰：两块地各量各的，两只开关各记各的。 */
      const narrowBody = useNarrowWidth('logbody')
      const [detailOpen, setDetailOpen] = React.useState(null)
      const [work, setWork] = React.useState(remembered === null ? null : remembered.status)
      /* The working tree, read separately from the repository's identity: on a
         Windows-mounted worktree that part alone costs seconds, and nothing on
         screen needs it before the frame is drawn. */
      const [status, setStatus] = React.useState(remembered === null ? null : remembered.status)
      const [maxCount, setMaxCount] = React.useState(PAGE_COMMITS)
      const [message, setMessage] = React.useState('')
      /* ── 提交信息草稿的账本（信息本体在 Host 的插件配置里，70-config.js 的 drafts）
         repo：这只输入框此刻属于哪个仓库（null = 还没有仓库落到它头上）；
         timer：挂着的防抖保存定时器；value：输入框此刻的内容镜像 —— 草稿读回来
         时要回答「框是不是空的」，而 that 回答不能靠闭包里的 message（effect 跑的
         那一刻拍下来的旧值，答复落地时早就过期了）。client 侧没有 useRef，沿 box
         模式（57-cmdlog.js 的 cmdLogBox、55-diff.js 的 rowBox 同款）。 */
      const [draftBox] = React.useState(function () { return { repo: null, timer: null, value: '' } })
      const [selected, setSelected] = React.useState(null)
      const [selectedKey, setSelectedKey] = React.useState(null)
      const [activeRef, setActiveRef] = React.useState('')
      const [allRefs, setAllRefs] = React.useState(false)
      const [searchDraft, setSearchDraft] = React.useState('')
      const [search, setSearch] = React.useState('')
      /* IDEA's two switches beside the log search: `.*` reads the text as a
         regular expression, `Cc` makes it case sensitive. Both are off by
         default, which is exactly the search this panel had before they
         existed — literal text, ignoring case. */
      const [regexSearch, setRegexSearch] = React.useState(false)
      const [caseSensitive, setCaseSensitive] = React.useState(false)
      const [author, setAuthor] = React.useState('')
      const [datePreset, setDatePreset] = React.useState('all')
      const [pathDraft, setPathDraft] = React.useState('')
      const [pathFilter, setPathFilter] = React.useState('')
      const [collapsed, setCollapsed] = React.useState({})
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      /* ── 头部同步组（⟳⇣↓↑）各自的运行中标记 ──

         busy 是面板级的：一抬起来四个键一起 40% 透明、提交框/右键菜单/快捷命令全部
         锁死。同步组的一次点击只有那一个键在干活，不该连坐整个面板 —— 所以各记各的
         （函数式更新，一次只翻一个键），按钮的禁用与转圈都从这份算；fetch/pull/push
         另外彼此串行（panelBox.syncs 那条链），⟳ 等它自己触发的全树读落地。 */
      const [syncRunning, setSyncRunning] = React.useState({})
      const setSyncKey = function (key, on) {
        setSyncRunning(function (previous) {
          if (previous[key] === on) return previous
          const nextRun = Object.assign({}, previous)
          if (on) nextRun[key] = true
          else delete nextRun[key]
          return nextRun
        })
      }
      /* Shared with the chip and the switcher rather than local: a switch made
         from the hover card happens while this panel is hidden, and it must not
         come back to the foreground still showing the branch it used to be on. */
      const reloadAt = useDataVersion()
      const [size, setSize] = React.useState(panelSize)
      /* 锚点容器（输入区 overlay 槽位）量到的 {top, ceiling, vh}。null = 还没量过
         （首帧、或没有布局的环境），此时不钳制，维持 CSS 的 74vh / 记忆的 size.h。
         top 是锚点上沿（面板下沿就在它上面 8px）；ceiling 是真实上界（14-geometry.js
         的 clipCeiling：沿祖先量到的最近裁剪边界——会话滚动体的可见上沿——比视口
         上沿低，量不到时为 null，钳制按 0 处理，即 15ab5a3 的旧边界）。vh、top、
         ceiling 一起量、一起进变化判据：默认期望高度是 74% 个视口，只盯 top 的话
         纵向 resize 就漏掉了；只盯 top+vh 的话，滚动体自己的位移（页头伸缩、布局
         变化、滚动位置）也会漏。 */
      const [anchor, setAnchor] = React.useState(null)
      /* 这个挂载自己的面板节点。panelNode 是全局单值，同一页挂着多个会话时，别的
         会话一重画它就被指到别人的节点上；量锚点必须认自己这一块。 */
      const [nodeBox] = React.useState(function () { return { node: null } })
      const [armed, setArmed] = React.useState('')
      const [prompt, setPrompt] = React.useState(null)
      /* ── Ctrl+点击的多选提交 ──

         与单选（selected）独立并存：普通点击照旧单选+读详情，Ctrl/Cmd+点击把那一行
         挑进/移出这份集合；拣选/还原/标签/分支按钮仍作用于单选那条。存的是 hash 数组，
         顺序跟着图走（图重读后会按眼前的列表修剪一次）。 */
      const [multiSel, setMultiSel] = React.useState([])
      /* ── Shift+点击范围多选的锚点行 ──

         锚点 = 最近一次普通点击或 Ctrl 点击的那行；Shift 点击以它为起点扩一段，
         且不动锚点（可以连续扩）。挂箱不挂 state（pushBox.resolve 同一个先例）：
         pickCommit 是 memo 化提交行共用的 useCallback，锚点若进 state 就得进依赖，
         行级记忆全被打破 —— 箱子让回调永远读到最新的那一个，回调本身保持稳定。 */
      const [pickAnchor] = React.useState(function () { return { hash: null } })
      /* 渲染期现成的 graph.commits 交给箱子，Shift 扩选时回调读它（panelBox.status
         同一个写法）：回调不依赖 graph，重读历史不会重建任何一行的回调。 */
      const [graphBox] = React.useState(function () { return { commits: null } })
      /* ⚡（快捷命令）下拉的开合：null = 关着。 */
      const [menuOpen, setMenuOpen] = React.useState(null)
      /* ── 右键菜单（提交行 / 分支行共用）──

         ctxMenu 存 {kind, x, y, …}：kind='commit' 带 hash（动作目标就是右键那一条，
         与 Ctrl 多选无关）；kind='branch' 带名字、是否远程、属于哪个仓库。arm/force
         是分支删除的两段式确认（-d 被拒才给 -D），busy 是它在飞的那一下。 */
      const [ctxMenu, setCtxMenu] = React.useState(null)
      const [ctxArm, setCtxArm] = React.useState('')
      const [ctxForce, setCtxForce] = React.useState('')
      const [ctxBusy, setCtxBusy] = React.useState(false)
      /* 快捷命令的统一执行确认框（拿着哪条定义）与编辑器覆盖层（'new' 直接进编辑态、
         'list' 进列表态）。 */
      const [qcConfirm, setQcConfirm] = React.useState(null)
      const [qcEditor, setQcEditor] = React.useState(null)
      /* 绿色成功条（快捷命令的输出、删除分支的结果句）：和 error 同一个提示位，下一次
         操作开始时一起清掉 —— 提示位的规矩是一次只说一件事。 */
      const [okNote, setOkNote] = React.useState('')
      /* 下拉按钮的节点盒：「点外面关掉」要把触发按钮算在里面（见 78-actions.js
         的 useOutsideDismiss），否则点按钮会先被关一次、又被 click 开一次。 */
      const [quickBox] = React.useState(function () { return { node: null } })
      const [needsUpstream, setNeedsUpstream] = React.useState(false)
      /* pull 的上游选择层：null 是关着，非 null（{}）是开着 —— 开着时正文上面盖一层
         远端分支选择（RemotePickList，70-branchpicker.js）。点行 = runOp('git/pull',
         {setUpstream})，成功后 runOp 自己关掉它并写成功条。 */
      const [pullPick, setPullPick] = React.useState(null)
      /* 右键远程分支「签出」遇本地同名分支的二选一层：null 关着；非 null 是
         { name, repo, local } —— name 是完整远端名（origin/feat/x）、local 是去掉
         远端前缀的本地名、repo 是右键那一行自己的仓库（空串就随 ctxRun 落回生效
         仓库）。原先只报一句错误条把读者支去「本地」组，现在开着时正文上面盖一块
         确认框：直切本地分支，或用远端覆盖本地分支。 */
      const [remotePick, setRemotePick] = React.useState(null)
      /* 「修改跟踪分支」的选择层：null 关着；非 null 是 {name, repo} —— 右键的那个
         本地分支（HEAD 组与「本地」组的行都算，远程组的行没有这一项）。开着时正文
         上面盖一层远端分支选择（RemotePickList，70-branchpicker.js，与 pull 的上游
         选择同一块板子）：点行 = ctxSetUpstream 绑定，层里的「取消跟踪」走 unset。 */
      const [upstreamPick, setUpstreamPick] = React.useState(null)
      /* ── 推送确认弹窗（两段式推送的第一段；PushConfirmBox 渲染）──

         用户主动发起的推送（顶栏 ↑、分支行右键「推送」、右栏「推送并设为上游」）
         都改成两段式：先开这个框列出将推的提交，点「推送」才发真正的 git/push。
         null 关着；非 null 是 { branch, repo, setUpstream, note, preview, loading,
         running, error }：branch/repo 是要推的分支与它的仓库（空串 = 生效仓库的
         当前分支）；setUpstream 非 null = 这次推的是 push -u（右键推送 / 横幅在
         打开前就把远端挑好了，顶栏 ↑ 要等预览答复才知道有没有上游）；note 是成功
         后上成功条的话（顶栏 ↑ 与老路一致不上条）；preview / loading / running /
         error 是框自己的读与推。92-chip.js 的「所有会话完成自动推送」是后台自动化，
         不开这个框 —— 两段式只管人点的推送。

         pushBox.resolve 挂着 openPushConfirm 那个 promise 的出口：顶栏 ↑ 的
         runSync 链靠它在弹窗收起的那一刻熄灯 —— ↑ 的转圈因此跨满整个弹窗生命期
         （转着就点不动，顺手挡住了「弹窗开着再点一次 ↑」）；其余入口没人等这个
         promise，接住丢掉即可。挂箱不挂 state：resolve 要在关闭动作的那一帧被
         找到，而不是跟着某次渲染走（panelBox.refreshDone 同一个道理）。 */
      const [pushConfirm, setPushConfirm] = React.useState(null)
      /* 「编辑提交消息…」的对话框（reword）：null 关着；非 null 是 { hash, head,
         message, loaded, running, error } —— head 是菜单体检答复里那份 HEAD（reword
         的 expect），message 是 git/commit-messages 取回的原始消息（开框即预填，
         读回来前 loaded=false），error 说在框内。seed 比对与 pushConfirm 同款：
         关掉重开之后，迟到的答复不许盖到新框上。 */
      const [rewordBox, setRewordBox] = React.useState(null)
      /* 「合并提交… / 批量删除提交…」的确认框（作用于整个选区）：null 关着；非 null
         是 { mode: 'squash'|'drop', targets, base, expect, list, loading, message,
         error } —— targets 按图序（新→旧），base/expect 是 git/squash、git/drop
         要的区间起点与读图时 HEAD；list 是 commit-messages 取回的消息（squash 的
         合并消息从它预填）。 */
      const [selRewrite, setSelRewrite] = React.useState(null)
      const [pushBox] = React.useState(function () { return { resolve: null } })
      /* 弹窗自己的节点盒：「点外面关掉」要把框算在里面（useOutsideDismiss 的
         boxes），qc-box 的 ref 由 PushConfirmBox 的 boxRef 写进来。 */
      const [pushBoxDom] = React.useState(function () { return { node: null } })
      /* 弹窗的预览读：seed 一立（loading 且 preview 还空）就发 git/push-preview，
         答复按发出时的那份 state 记名落座 —— 函数式更新里对不上号的直接丢，读者
         已经关掉重开过一次的话，迟到的答复不许盖到新弹窗上。失败也折成 ok:false
         落在框内：覆盖层把外面那条错误条盖住了，框必须自己会说。上游缺失那次推送
         失败后的重读（pushConfirmRun 里把 preview 拍回 null）也走这一条。 */
      React.useEffect(function () {
        if (pushConfirm === null || pushConfirm.preview !== null || pushConfirm.loading !== true) return undefined
        const seed = pushConfirm
        const request = base(seed.repo)
        if (seed.branch.length > 0) request.branch = seed.branch
        let alive = true
        rpc('git/push-preview', request, '读不到推送预览').then(function (reply) {
          if (alive !== true) return
          setPushConfirm(function (previous) {
            if (previous !== seed) return previous
            return Object.assign({}, previous, { preview: reply, loading: false })
          })
        }, function (failure) {
          if (alive !== true) return
          const said = failureText(failure)
          setPushConfirm(function (previous) {
            if (previous !== seed) return previous
            return Object.assign({}, previous, { preview: { ok: false, stderr: said }, loading: false })
          })
        })
        return function () { alive = false }
      }, [pushConfirm])
      /* The file whose patch is on screen, and a counter the refresh button
         bumps. Null means the list the reader came from is on screen — the two
         lists that can open a diff (the changes tree, a commit's file list) both
         end in this one view, which is why it lives here and not in either. */
      const [diffTarget, setDiffTarget] = React.useState(null)
      const [diffAt, setDiffAt] = React.useState(0)
      /* 三方合并冲突界面（59-merge.js）：与 diffTarget 同一个「占满正文的下钻」
         形状 —— 从变更页的冲突行进来，回去也是变更页。谁开着以最后点的那行为准，
         两把状态互斥（打开一个就清另一个），正文永远只有一块屏。 */
      const [mergeTarget, setMergeTarget] = React.useState(null)
      /* ── 命令页的读数（57-cmdlog.js 只管画）──

         null = 这个会话还没有任何读数：第一次生成发生在弹窗打开那一刻的后台预读里。
         读数里记着它属于哪个会话 —— 组件没重挂而 sessionId 变了的场合（防御；DSH
         换会话通常是整块重挂），旧列表不当作「已读」，也不当作「自己人」（合并时
         sessionId 对不上原样返回，57-cmdlog.js）。 */
      const [cmdLog, setCmdLog] = React.useState(null)
      /* 在飞的那次读取的序号：连续两次「重新读取」时，旧答复不许翻盘（和
         repoEpoch 是同一个问题，见 10-state.js）。opens 数面板打开过几次 —— 每次
         打开都算一次刷新时机，读数里记下自己是在第几次打开时发起的；open 只是
         「此刻开着吗」的备忘，面板藏起来时放掉，下次再开 opens 才会加一。 */
      const [cmdLogBox] = React.useState(function () { return { seq: 0, opens: 0, open: false } })
      /* 合并后的长度上限：两次读之间命令再多，列表也不无限长 —— 与 Host 侧一页的
         量级（limit 500）比留足了余量，截掉的只是排序后最旧的尾巴。读的答复与
         liveBus 的推送走同一条合并路（57-cmdlog.js 的 cmdlogMergeRows）。 */
      const CMDLOG_LIVE_MAX = 600
      /* Which collapsed untracked directories are open, and what is inside the
         ones that have been read. Keyed by the directory's path; the read happens
         on the click that opens one, never for the whole tree up front. */
      const [untrackedOpen, setUntrackedOpen] = React.useState({})
      const [untrackedFiles, setUntrackedFiles] = React.useState({})
      /* ── the working tree, read by pathspec ──

         `git status` stats every tracked file and walks every untracked
         directory. Measured on this reader's repository (a Windows-mounted
         worktree): 7.4s for the whole tree, 13.6s cold, 13.0s with
         `--untracked-files=all` — and **0.5s** for the same command asked about
         the 36 paths the changes tree was showing. They are the same answer for
         everything that is on screen.

         So the whole tree is read on its own clock (opening a repository the
         plugin has not read yet, the refresh button, and once every fullReadGapMs
         while the changes tab is on screen), and everything the reader does
         between those — a tick, an edit to a file that is already listed, a stage,
         a commit — is confirmed by a read of the paths involved. A file that was
         clean and is now modified is the one thing a pathspec read cannot see; the
         whole-tree read is what catches it, which is why it still happens on a
         clock.

         The snapshot, the cost of the last whole-tree read and whether the next
         read has to be a whole one live in one object rather than in the state
         alone: an effect keeps the render it was created in, so a callback
         registered once would otherwise read a stale `status` for as long as its
         dependencies do not move. */
      const [panelBox] = React.useState(function () {
        return {
          status: remembered === null ? null : remembered.status,
          /* 记忆里那份先当屏上的快照用，挂载时的那次全树读照旧发出：要么命中 Host 的
             按仓库缓存（同一个工作区，几毫秒），要么给出真正的新答案。 */
          needFull: remembered !== null,
          repo: '',
          costMs: remembered === null ? 0 : remembered.costMs,
          lastFull: false,
          mutations: Promise.resolve(),
          /* 同步组（⇣↓↑）自己的串行链，画法同 mutations：键进了这条链的动作一个跑完
             再轮下一个，链不因失败中毒。⟳ 是纯读触发，不进这条链。 */
          syncs: Promise.resolve(),
          /* ⟳ 点击时挂上的一次性完成回调（见 refresh / settleRefresh）：那一次重读
             真正落地（或读失败）时由 loadWork 调掉并摘下 —— 时钟驱动的自动重读
             不挂也不调，所以那条路点不亮按钮。挂箱不挂 state：回调要在读落地的那
             一帧被找到，而不是跟着某次渲染走。 */
          refreshDone: null,
        }
      })
      panelBox.status = status
      /* Shift 扩选的回调从箱子里读图（见 graphBox 的注释）。 */
      graphBox.commits = graph != null && graph.ok === true && Array.isArray(graph.commits) ? graph.commits : null
      /* 一次全树读占住整条通道多久 —— 下一次该隔多久再量一遍由它决定（fullReadGapMs）。
         进 state 的原因只有一个：间隔变了要把那个时钟重新起一遍。记忆里那份带着上次
         实测的代价，第一帧就把时钟的间隔定对。 */
      const [treeCost, setTreeCost] = React.useState(remembered === null ? 0 : remembered.costMs)

      /* work is the only truth about whether this path is a usable repository.
         Everything that reads refs, history or the index is gated on it, so a
         non-repository shows one purposeful setup page instead of three panes
         that each report a different flavour of failure. */
      const repoOk = work != null && work.ok === true
      const needsSetup = work != null && work.ok !== true

      /* 读数按答复里的仓库记，不是按这次请求写的那个：请求里常常只有会话 id（Host 才知道
         这个会话的工作区在哪）。收窄与否也是按这个路径记的。 */
      const treeKey = function (status, fallback) {
        const resolved = status != null ? text(status.repo) : ''
        return resolved.length > 0 ? resolved : fallback
      }

      const base = function (repo) {
        const request = { sessionId: sessionId }
        if (repo.length > 0) request.repo = repo
        return request
      }

      /* ⟳ 的运行中怎么熄灯：refresh() 把一次性回调挂在箱上，loadWork 里每一条会终止
         的路都来调它 —— 全树读正常落地、答复被 epoch 作废、读到「不是仓库」、读失败，
         全都算落地。调一次就摘：早熄一帧只是少转半圈，长转不熄才是事故。 */
      const settleRefresh = function () {
        const done = panelBox.refreshDone
        if (done == null) return
        panelBox.refreshDone = null
        done()
      }

      /* Identity first, working tree after. The identity answer is what decides
         whether this path is a repository at all, so waiting for `git status`
         before drawing anything made every switch to an unused workspace feel
         like the panel had hung. `paths` names the paths a partial read is
         about; null asks for the whole working tree. */
      const loadWork = function (repo, paths) {
        const request = base(repo)
        const asked = request.repo === undefined ? '' : request.repo
        const epoch = repoEpoch(asked, sessionId)
        callHost('git/panel', Object.assign({ quick: true }, request)).then(function (data) {
          /* A mutation since this read started makes the answer describe the
             repository before it — see repoEpoch. */
          if (epoch !== repoEpoch(asked, sessionId)) { settleRefresh(); return }
          setWork(data)
          if (data == null || data.ok !== true) { settleRefresh(); setStatus(null); return }
          const full = paths == null || paths.length === 0
          const work = Object.assign({}, request)
          if (!full) work.paths = paths
          const started = Date.now()
          /* 全树那一次在飞的时候，全局那份读数就是「还没核对过」：chip 这时说的是
             「正在核对」，而不是继续报一个它没验证过的数字。 */
          /* 读数按**答复里的仓库**记，不是按这次请求写的那个：请求里常常只有会话 id
             （Host 才知道这个会话的工作区在哪），而读数要能被 chip 按路径查到。 */
          const resolved = text(data.repo).length > 0 ? text(data.repo) : asked
          const finished = treeCountReadStart(resolved)
          callHost('git/panel', work).then(function (reply) {
            finished()
            /* ⟳ 的熄灯点放在 finished() 后面、早退判断前面：这一次读不管算不算数
               （epoch 作废、仓库切走）都算落地，别让按钮替一次作废的读长转。 */
            settleRefresh()
            /* A read that came back after the path changed is not this path's
               answer; the effect below will load the new one anyway. */
            if (asked !== appliedRepo && asked.length > 0) return
            if (epoch !== repoEpoch(asked, sessionId)) return
            panelBox.lastFull = full
            /* 只问几条路径的那种读有多贵：贵到一定程度就说明父目录扫进了大树，这个仓库
               从此收窄（见 pathsOfInterest）。 */
            if (full !== true) pathsReadSpent(resolved, Math.round(Date.now() - started))
            if (full) {
              /* 全树那一次花了多久，读数记下来。 */
              const cost = Math.round(Date.now() - started)
              panelBox.needFull = false
              panelBox.costMs = cost
              setTreeCost(cost)
              setStatus(reply != null && reply.ok === true ? reply : null)
              return
            }
            /* A partial answer says nothing about the rest of the tree: it is
               folded into the snapshot on screen, never put in its place. */
            setStatus(function (previous) { return mergePanelStatus(previous, reply) })
          }).catch(function () { finished(); settleRefresh(); setStatus(null) })
        }).catch(function (failure) {
          setError(failureText(failure))
          settleRefresh()
        })
      }

      /* 快照能站多久。便宜的签名和路径读合起来覆盖了「已经显示着的那些路径」，它们
         看不见的只有一件事：**本来干净、刚刚被改**的文件（或者一个干净目录里新出现的
         文件）。那一次全树读在这台机器上是 5–8s，而且占住整条通道，所以它挂在时钟上，
         而且间隔按上一次实测的代价来定（fullReadGapMs：至少 30s，最多 5 分钟）。 */
      /* 量完就写进全局那一份读数（见 10-state.js）：面板是唯一既读全树、又读屏上那些
         路径的地方，chip 上那个数字就来自这里 —— 两块屏幕于是不会各说各话。乐观的
         tick（点击就地改的那份快照）也走这里，所以 chip 上的数字跟着手指走。 */
      React.useEffect(function () {
        if (status == null || status.ok !== true) return
        /* 按答复里的仓库记：没应用过路径时请求里只有会话 id，而这份读数要能被 chip
           按它查到的那个路径找到（Host 在答复里把会话的工作区解析成了路径）。 */
        publishTreeRead(treeKey(status, appliedRepo), status, panelBox.lastFull === true, panelBox.costMs)
      }, [status, appliedRepo])

      /* Whether this read may be about the paths on screen instead of the whole
         tree: whenever there is a snapshot to fold it into. */
      const readChanges = function () {
        const snapshot = panelBox.status
        /* 屏上有快照，问的就是屏上那些路径（0.2s）；换仓库、或明确要求整棵树时才重读
           全部。一次「提交」之后的读因此也是 0.3s，而不是 8–10s。 */
        const whole = panelBox.needFull === true || snapshot == null || snapshot.ok !== true
        loadWork(appliedRepo, whole ? null : pathsOfInterest(snapshot, treeKey(snapshot, appliedRepo)))
      }

      /* Read the whole tree again, now. The flush is what makes it a read rather
         than a repaint of the Host's cache; the refresh button and the clock both
         go through here. */
      const reloadChanges = function () {
        panelBox.needFull = true
        callHost('git/flush', base(appliedRepo)).then(bump, bump)
      }

      /* ── 面板成为屏上的那块面时，↑ 的数不许是 Host 缓存里的旧答案 ──

         读缓存在 Host 手里从不过期（60-reads.js），新鲜度全靠有人先 flush：轮询的
         签名（30-watch.js）、会话完成那一刷（92-chip.js）、⟳，都是「先 flush 再读」。
         但三条路都会断 —— 轮询要时钟（无 timer 服务的前端组合里整条不存在）、完成的
         一刷页面藏着时记成欠账要等回可见、⟳ 要人点。真机的现场就是：agent 连提十来
         个提交，面板关了再开，↑ 上的待推送数还停在几个提交之前 —— 因为重开重发的
         身份读命中了那份没人 flush 过的缓存。
         所以「面板变成屏上的那块面」本身就是一次 flush 时机：只作废身份与分支两格
         （tags，几十微秒），再补一次 0.1–0.4s 的身份读把 work.ahead 校正回来。图、
         作者、refs、整树读的缓存一格不动 —— 重开面板照旧接近零成本，只有那个必须
         新鲜的数字重新问了一遍。开着的期间切仓库也算一次「成为」（新仓库同名格
         同样作废）；在飞期间的一次变更（repoEpoch）照旧让迟到的答复作废。 */
      const [openBox] = React.useState(function () { return { flushedFor: null } })
      React.useEffect(function () {
        if (props.active !== true) { openBox.flushedFor = null; return undefined }
        const request = base(appliedRepo)
        const key = request.repo === undefined ? '\u0000' + sessionId : request.repo
        if (openBox.flushedFor === key) return undefined
        openBox.flushedFor = key
        const asked = request.repo === undefined ? '' : request.repo
        const epoch = repoEpoch(asked, sessionId)
        callHost('git/flush', Object.assign({ tags: ['panel-ident', 'branches'] }, request)).catch(function () {})
        callHost('git/panel', Object.assign({ quick: true }, request)).then(function (data) {
          if (data == null || data.ok !== true) return
          if (epoch !== repoEpoch(asked, sessionId)) return
          setWork(data)
        }, function () {})
        return undefined
      }, [props.active, appliedRepo, sessionId])

      const resetFilters = function () {
        setActiveRef('')
        setAllRefs(false)
        setSearch('')
        setSearchDraft('')
        setRegexSearch(false)
        setCaseSensitive(false)
        setAuthor('')
        setDatePreset('all')
        setPathDraft('')
        setPathFilter('')
      }

      const applyRepo = function (next) {
        rememberRepo(sessionId, next)
        setAppliedRepo(next)
        setStatus(null)
        panelBox.status = null
        panelBox.needFull = true
        panelBox.repo = ''
        setMaxCount(PAGE_COMMITS)
        resetFilters()
        setSelected(null)
        setSelectedKey(null)
        setDetail(null)
        setDiffTarget(null)
        setMergeTarget(null)
        /* 多选、下拉、覆盖层都是「对着眼前这份列表」的状态：仓库一换全部作废。 */
        setMultiSel([])
        setMenuOpen(null)
        setCtxMenu(null)
        setQcConfirm(null)
        setQcEditor(null)
        setPullPick(null)
        setRewordBox(null)
        setSelRewrite(null)
        setOkNote('')
        setUntrackedOpen({})
        setUntrackedFiles({})
      }

      const bump = bumpData

      /* ── 多仓库（24-repos.js）：这个工作区里的仓库清单，和两块侧栏各自的选择 ──

         清单在面板首帧**之后**异步落地：ensureWorkspaceRepos 只发起，落地靠 signal
         让正在渲染的树重画 —— 首帧一个字节都不为它等。生效仓库（effectiveRepo）永远
         只跟仓库行的单击走：多选和「全部」是所在那一栏的显示方式，历史、chip、提交、
         推送继续用 effectiveRepo，这是有意的设计 —— 把几个仓库的提交历史并进同一张
         图，排序、分页和筛选都得重新发明，而读者要找的那一个提交只会在一个仓库里。 */
      useRepoList()
      useRepoViews()
      /* 多选的变更分组，每组的快照来自全局那份工作区读数（10-state.js）：读数动了
         的 signal 这里也得听，否则 chip 那边量完，分组里的数字不跟着动。 */
      useTreeVersion()
      const repoList = repoListForSession(sessionId)
      const effectiveRepo = appliedRepo.length > 0 ? appliedRepo : (repoOk ? text(work.repo) : '')
      const shownRepos = reposShown(repoList, effectiveRepo)
      const logSel = repoSelection(sessionId, 'log')
      const changeSel = repoSelection(sessionId, 'changes')
      const logSelKey = logSel.join('\u0000')
      const changeSelKey = changeSel.join('\u0000')

      /* ── 提交信息草稿：按生效仓库存在 Host 的插件配置里 ──

         提交信息过去只活在浏览器的内存里，提交成功那一刻就被清空 —— 换个浏览器、
         换台机器打开同一个工作区，写到一半的那条信息就没了。现在它按生效仓库的根
         路径一仓一份存进 Host（git/draft-read / git/draft-save，70-config.js 的
         drafts），打开面板、切仓库时读回来，输入停手约一秒自动存。两个数与两条
         纪律：

           · DRAFT_LEN_MAX 与 Host 的上限同款（4000）：Host 是最后一道关卡，但
             客户端先把超长的截掉，省一次注定被截的往返；
           · 防抖 900ms（配置页那份整配置保存是 400ms，见 20-prefs.js）：草稿的
             保存多得多（每一段连续输入一次），再快就要在连续输入时排队写盘；
           · 保存的 repo 在排程那一刻就闭上：读者打完字立刻切仓库，挂着的保存
             仍写到**原来那个**仓库名下 —— 内容是它的，不能记到新仓库头上；
           · 只 console，不上错误条：草稿服务的是「下次还能看见」，存不进去
             不值得挤掉提示位上真正的错误（error 一次只说一件事的规矩），
             更不能让提交、暂存这些主流程沾光。 */
      const DRAFT_LEN_MAX = 4000
      const DRAFT_SAVE_MS = 900

      const saveDraft = function (repo, value) {
        if (repo.length === 0) return
        /* 带上会话：配置文件在任何工作区之外，写它的沙箱策略来自这个会话
           （70-config.js 写文件那一段的说明），不带就落到部署默认那份、被拒。 */
        callHost('git/draft-save', { repo: repo, message: value, sessionId: sessionId })
          .then(null, function (failure) {
            console.error('dsh-git-idea: 提交信息草稿保存失败:', failureText(failure))
          })
      }

      const scheduleDraftSave = function (repo, value) {
        if (repo.length === 0) return
        if (draftBox.timer !== null) { draftBox.timer(); draftBox.timer = null }
        draftBox.timer = timerOf().timeout(function () {
          draftBox.timer = null
          saveDraft(repo, value)
        }, DRAFT_SAVE_MS)
      }

      /* 提交这类「马上要用」的时刻不等防抖：挂着的保存立刻落一次。 */
      const flushDraftSave = function (repo, value) {
        if (draftBox.timer !== null) { draftBox.timer(); draftBox.timer = null }
        saveDraft(repo, value)
      }

      /* 输入框的每一次变化都从这里走：先上屏，再排一次防抖的草稿保存。清空（
         clearable 的 ×）也走它 —— 「空」同样要记到 Host，否则清掉的草稿会在
         下次打开时从配置里长回来。镜像跟着记一笔：草稿读回来时判断「框是不是
         空的」用的就是它（见下面那个 effect）。 */
      const changeMessage = function (next) {
        draftBox.value = next
        setMessage(next)
        scheduleDraftSave(effectiveRepo, next)
      }

      /* ── 草稿什么时候读：生效仓库头一次落定、或切到另一个仓库的那一次 ──

         「藏着不发读、重开零成本」是面板自己的规矩（6aede2c），草稿这一份读
         （Host 的读缓存，毫秒级）也不该例外：仓库已经在框的名下时，重开面板
         一个字节都不读。换浏览器、换页面是组件新挂，draftBox.repo 还是 null，
         第一次打开正好落在「仓库头一次落定」这一格 —— 跨浏览器的那一次读
         就是它。同一仓库重开也不重读：框里这份就是最新的（每次输入都在往
         Host 存），读回来反而是拿旧答案覆盖新输入。

         填入的规矩：**仅空框才填入** —— 读回来的草稿只填得进一只空框，框里已经
         有字（上一个仓库留下的、或读者刚敲的）就一个字节不动：读者看得见的那行
         字，不许被一次网络答复悄悄换掉。答复落地时仓库又切走了（draftBox.repo
         不再是当时问的那个）：那是别的仓库的草稿，一个字节不填。读失败安静放过：
         空框照旧，主流程与此无关。 */
      React.useEffect(function () {
        if (props.active !== true) return undefined
        const repo = effectiveRepo
        if (repo.length === 0) return undefined
        if (draftBox.repo === repo) return undefined
        draftBox.repo = repo
        let alive = true
        callHost('git/draft-read', { repo: repo }).then(function (reply) {
          if (alive !== true || draftBox.repo !== repo) return
          if (draftBox.value.length > 0) return
          const next = reply != null && typeof reply.message === 'string'
            ? reply.message.slice(0, DRAFT_LEN_MAX) : ''
          draftBox.value = next
          setMessage(next)
        }, function () {})
        return function () { alive = false }
      }, [effectiveRepo, props.active])

      React.useEffect(function () {
        if (props.ready !== true) return
        /* 每个工作区只扫一次（24-repos.js 里按会话去重）。工作区本身是不是仓库不
           用来判断要不要扫 —— 嵌着好几个仓库的普通目录，恰恰是最需要这份清单的地方
           （「未检测到仓库」的说明页下面就挂着同一份列表）。 */
        ensureWorkspaceRepos(sessionId)
      }, [sessionId, props.ready])

      /* 仓库行的单击：切生效仓库 + 清掉这一栏的多选（树跟着生效仓库走回单仓库现状）。
         和说明页「打开这个目录」同一条路径，chip、历史、提交全都跟着换。 */
      const repoSingle = function (pane, path) {
        setRepoSelection(sessionId, pane, [])
        if (path === appliedRepo) return
        applyRepo(path)
        loadWork(path)
      }

      const repoAll = function (pane) {
        setRepoSelection(sessionId, pane, shownRepos)
      }

      const repoAdd = function (path) { return saveManualRepo(sessionId, { add: path }) }
      const repoRemove = function (path) { return saveManualRepo(sessionId, { remove: path }) }

      /* 两块侧栏的属性包：组件本身由 RefTree / ChangesPane 用 h() 挂（RepoSwitcher 有
         自己的 useState —— 当函数直接调会把它的钩子混进父组件的钩子序列，换页时数量
         一变就是坏状态）。 */
      const repoPropsFor = function (pane) {
        return {
          sessionId: sessionId, pane: pane, list: repoList, effective: effectiveRepo,
          onSingle: function (path) { repoSingle(pane, path) },
          onAll: function () { repoAll(pane) },
          onAdd: repoAdd, onRemove: repoRemove,
        }
      }

      /* ── what a hidden panel costs ──

         The panel stays mounted when it is closed, so a change in the repository
         used to make it re-read the history, the author list, the refs and the
         commit detail while nobody was looking — and then re-render a few hundred
         rows it was about to show anyway. Every one of those reads is cheap when
         the Host cache is warm, but the re-render is not, and none of it was
         visible.

         So a hidden panel does not re-read: it keeps the version it last
         rendered, and the moment it becomes visible again its reads jump to the
         current version and run once, in one pass. Opening a panel that owes
         nothing costs no request and no re-render at all. */
      const [rendered, setRendered] = React.useState(reloadAt)
      const freshAt = props.active === true ? reloadAt : rendered
      React.useEffect(function () {
        if (props.active === true && rendered !== reloadAt) setRendered(reloadAt)
        return undefined
      }, [props.active, reloadAt, rendered])

      /* Refresh has to actually re-read. The Host memoises reads per repository,
         so the button first drops that repository's cached entries and only then
         bumps the counter every read effect below depends on. Without the flush
         it would repaint stale data and look like nothing happened.

         ── ⟳ 与屏上打开的差异 ──

         差异头部那只 ⟳（55-diff.js 的「重新读取这个文件的差异」）只换补丁：视图
         不动、补丁重读。工具条这只 ⟳ 过去只管整棵树：落地后变更列表是**新账**，
         可打开的那块补丁原样停在刷新前 —— diffSig 只在「这一行的样子变了」时才动，
         一行没变补丁就不重读；选区/多选又被下面清掉，选区合并查看开出来的差异连
         右列与来路一起没了。读者看到的正是「点仓库时差异是新的，⟳ 之后差异就没了
         （不再是对的东西）」——两只刷新键在「读者正盯着的那块屏」上各说各话。

         统一的语义按差异头部那只来：⟳ 落地的那一拍把 diffAt 也 +1（diffSig 随之
         变，DiffView 的读取 effect 按新账重发 git/diff），视图本身不关 —— diffTarget
         原样留着，这一行还在变更列表里的话，由「打开的差异跟着这一行现在的样子走」
         那段按新行重对；选区视图（kind 'range'）的 ref 是 base..head，同样重读得动。
         +1 放在挂箱的落地回调里而不是点击那一刻：转圈停了看到的就是新补丁，而且
         那时整树读已落地，行的新样子已定，一次 ⟳ 至多重读一遍补丁。函数式更新：
         刷新期间读者若点过差异头部的 ⟳，两下各加各的，不互相顶掉。 */
      const refresh = function () {
        setArmed('')
        /* 刷新 = 整棵树重读：多选对着的是旧列表，一并清掉（见下面那个筛选 effect 的
           注释）。差异视图不在这行里清 —— 见上面的「⟳ 与屏上打开的差异」。 */
        setMultiSel([])
        setOkNote('')
        /* ⟳ 的熄灯时机是这次重读真正落地，不是 flush 回来 —— flush 只保证下一读不作弊。
           回调挂 panelBox.refreshDone，loadWork 的落地点（settleRefresh）调掉；熄灯的
           同一拍把打开的差异换新账（见上面的注释）。 */
        panelBox.refreshDone = function () {
          setSyncKey('refresh', false)
          setDiffAt(function (previous) { return previous + 1 })
        }
        setSyncKey('refresh', true)
        reloadChanges()
      }

      /* ── 同步组的运行中包装器（⇣↓↑，⟳ 纯读不进链）──

         先立标记再发起：动作排在链里等前一个跑完时，按钮已经在转了 —— 点下去的那
         一帧就得到「收到了」的反馈，而不是等前一个结束才亮。防抖在这里：转着的键
         再点直接忽略。链画法同 queueMutation：上一次 fetch 失败不许把排在后面的
         pull 毒死；标记在这次动作自己的 promise 落地时熄，不是整条链跑完才熄。 */
      const runSync = function (key, go) {
        if (syncRunning[key] === true) return
        setSyncKey(key, true)
        if (key === 'refresh') { go(); return }
        const next = panelBox.syncs.then(go, go)
        panelBox.syncs = next.then(function () { setSyncKey(key, false) }, function () { setSyncKey(key, false) })
      }

      /* ── 「有会话刚跑完」的那声铃（92-chip.js 敲，这里听）──

         只把 needFull 立起来，读仍然走下面那条 [freshAt] 的老路 —— 铃和 chip 的
         bump 本来就是同一次完成里的两下，读者看到的仍是**一次**整树读，而不是两个
         组件各读各的。面板关着时读不动（freshAt 冻结），但 needFull 留着：下次打开
         那一帧补上 —— 那时读者正要看，正该是完整的。 */
      const [bellBox] = React.useState(function () { return { at: 0 } })
      const bell = useTreeReload()
      React.useEffect(function () {
        if (bell === bellBox.at) return undefined
        bellBox.at = bell
        panelBox.needFull = true
        return undefined
      }, [bell])

      /* 哪些操作能把整棵树改掉：切分支、pull、merge/cherry-pick/revert（开始、继续、
         跳过、中止都算）会重写工作区/引用，它们的答案必须是一次全树读。别的（提交、
         暂存、取消暂存、fetch、push、tag、建/删分支）只动索引或引用 —— 那里用屏上
         那些路径确认就够了。真机上量到的是：一次全树读 8–10s，而且这期间整条 RPC
         通道都被它占着，为一次「提交」让读者等十秒、十秒内点什么都要排队，是没有
         道理的。文件右键菜单的三件（从修订中获取 / 还原所选更改 / 删除所选更改，
         61-filemenu.js）落在这张表上：它们动的路径恰恰多半**不在**变更页的屏上
         （checkout / clean 尤其）—— 路径收窄的确认读看不见那些路径，答案必须
         是一次全树读。 */
      const REWRITES_TREE = ['git/checkout', 'git/pull', 'git/sequence', 'git/init',
        'git/get-from-rev', 'git/revert-paths', 'git/clean-paths']

      /* One path for every panel operation. A failed operation still re-reads,
         because the failures that matter — a conflicting cherry-pick, merge or
         revert — leave the repository in a different state than they found it. */
      /* ── pull 的上游兜底 ──

         这个分支还没有 upstream 时，pull 本来只会以 git 的「no tracking
         information」收场。这里替它把这一步做完：refs 里查得到同名远端分支 →
         带 setUpstream 直接跑（Host 先 set-upstream-to 再 pull）；查不到 → 打开
         选择层（pullPick），一条 pull 都不发。其余情况 —— 已有 upstream、
         detached、分支未出生、refs 读不动 —— 照旧原样发 pull，行为一字不变。 */
      /* 第三参 syncKey 是同步组的键（'fetch'/'pull'/'push'）：头部四键点击进来的路
         不抬面板级 busy（那件事只有那一个键在跑，syncRunning 各记各的就够，其余 UI
         照常可交互），promise 要返回去 —— runSync 的串行链靠它等这次动作落地。没传
         键的既有调用方（右键菜单、选择层、sequencer）一字不变，仍用全局 busy。 */
      const runOpApply = function (method, payload, syncKey) {
        const ownRun = syncKey != null && syncKey !== ''
        if (ownRun !== true) {
          if (busy) return
          setBusy(true)
        }
        setArmed('')
        setError(null)
        setOkNote('')
        setNeedsUpstream(false)
        panelBox.needFull = REWRITES_TREE.indexOf(method) >= 0
        const request = base(appliedRepo)
        if (payload != null) Object.assign(request, payload)
        return rpc(method, request).then(function (reply) {
          if (ownRun !== true) setBusy(false)
          if (method === 'git/pull' && reply != null && reply.upstreamSet === true && reply.setUpstream != null) {
            /* 绑定+拉取这一次成功（两个入口共用 runOp）：成功条写明绑到了哪。 */
            setOkNote('已绑定上游 ' + text(reply.setUpstream.remote) + '/' + text(reply.setUpstream.branch) + ' 并拉取')
            setPullPick(null)
          }
          bump()
        }, function (failure) {
          if (ownRun !== true) setBusy(false)
          if (method === 'git/pull' && payload != null && payload.setUpstream != null) {
            const said = failureText(failure)
            /* 绑定这一步发现远端分支其实不在（refs 数据过期，git 的原话是
               "the requested upstream branch 'x/y' does not exist"）：回落到选择层
               让读者挑一个真的在的，不把这句裸着甩出来。其余失败（绑定成功而 pull
               撞上冲突等）把层关掉 —— upstream 已经留着，错误条要看得见。 */
            if (said.indexOf('does not exist') >= 0) { setPullPick({}); bump(); return }
            setPullPick(null)
          }
          setError(failureText(failure))
          if (method === 'git/push' && failureText(failure).indexOf('upstream') >= 0) {
            /* 「这个分支还没有上游」是一次可以自己走完的失败：设置里开了这一条时，
               就把横幅本来要问的那一步直接做掉（同一个请求，带上 setUpstream）。问过
               的那一次不再自动重试 —— 它要是也失败，横幅照旧出现，读者还有得按。
               远端不取 refs.remote[0]：ctxPush 的同一条规则（guessPushRemote，origin
               优先 → 唯一远端 → 都不满足就不猜）—— 多远端而无 origin 的仓库里，
               瞎猜会把 -u 绑到一个读者没挑过的远端；这时不自动补推，横幅照旧出现。 */
            const retry = payload == null || payload.setUpstream !== true
            const remote = guessPushRemote(refs)
            if (plugin.pushSetUpstream === true && retry && remote.length > 0 && currentName.length > 0) {
              /* 重试把键带下去、promise 接回来：链上的等待以重试落地为准，别让 ⟳⇣↓↑
                 的运行中标记在重试还没跑时就熄掉。 */
              return runOp('git/push', { setUpstream: true, remote: remote, branch: currentName }, syncKey)
            }
            setNeedsUpstream(true)
          }
          bump()
        })
      }

      /* 判断本身只吃一份 refs 答复：refs 还没读到过（首帧、刚换仓库、上次读失败）
         时由 runOp 先补一次读再进来，别因为缓存未到就弹层。syncKey 只是过路键，
         原样交给 runOpApply —— 走到「打开选择层、不发 rpc」的分支时什么也不返回，
         同步组的运行中标记随即熄（选择层本身就是下一步反馈）。 */
      const decidePull = function (refsData, payload, syncKey) {
        const current = refsData != null && refsData.ok === true && Array.isArray(refsData.current) && refsData.current.length > 0
          ? text(refsData.current[0]) : ''
        /* detached：refs.current 空、work.detached 是 true —— 两道都挡。 */
        if (work == null || work.ok !== true || work.detached === true || current.length === 0) {
          runOpApply('git/pull', payload, syncKey)
          return
        }
        /* 未出生分支（unborn）：refs.current 说得出名字，但 refs/heads 里没有它 ——
           set-upstream 无从谈起，照旧。 */
        const local = Array.isArray(refsData.local) ? refsData.local : []
        let born = false
        for (let i = 0; i < local.length; i += 1) {
          if (text(local[i].data) === current) { born = true; break }
        }
        if (born !== true) { runOpApply('git/pull', payload, syncKey); return }
        const match = upstreamMatchInRefs(refsData, current)
        if (match != null) {
          runOpApply('git/pull', Object.assign({}, payload == null ? {} : payload, { setUpstream: match }), syncKey)
          return
        }
        setPullPick({})
      }

      const runOp = function (method, payload, syncKey) {
        if (method !== 'git/pull' || (payload != null && payload.setUpstream != null)) {
          return runOpApply(method, payload, syncKey)
        }
        /* work 还没读到（面板首帧）：上游未知，照旧直接 pull —— 别在旧数据上猜。 */
        if (work == null || work.ok !== true || text(work.upstream).length > 0) {
          return runOpApply(method, payload, syncKey)
        }
        /* refs 还没读到过（或上次读失败）：先读一次再判断（别弹空窗）；读不动就按
           老路直接 pull，git 的拒绝原话照旧上屏。 */
        if (refs == null || refs.ok !== true) {
          return callHost('git/refs', base(appliedRepo)).then(function (data) {
            setRefs(data)
            decidePull(data, payload, syncKey)
          }, function () {
            runOpApply(method, payload, syncKey)
          })
        }
        return decidePull(refs, payload, syncKey)
      }

      const startDrag = function (axis) {
        return function (event) {
          if (event.button != null && event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          const node = panelNode
          if (node == null) return
          const doc = node.ownerDocument
          const view = doc != null ? doc.defaultView : null
          const startX = event.clientX
          const startY = event.clientY
          const startW = node.offsetWidth
          const startH = node.offsetHeight
          const maxW = view != null ? view.innerWidth - 24 : 2400
          const maxH = view != null ? view.innerHeight - 24 : 1600
          const clampW = function (value) { return Math.round(value < 420 ? 420 : (value > maxW ? maxW : value)) }
          const clampH = function (value) { return Math.round(value < 220 ? 220 : (value > maxH ? maxH : value)) }
          const onMove = function (move) {
            const next = { w: panelSize.w, h: panelSize.h }
            /* the panel stays centred, so one pixel of edge travel is two pixels
               of width */
            if (axis === 'w' || axis === 'e' || axis === 'nw' || axis === 'ne') {
              const delta = (axis === 'e' || axis === 'ne' ? move.clientX - startX : startX - move.clientX) * 2
              next.w = clampW(startW + delta)
            }
            if (axis === 'n' || axis === 'nw' || axis === 'ne') {
              next.h = clampH(startH + (startY - move.clientY))
            }
            publishPanelSize(next)
          }
          const onUp = function () {
            if (doc != null) {
              doc.removeEventListener('pointermove', onMove)
              doc.removeEventListener('pointerup', onUp)
              doc.removeEventListener('pointercancel', onUp)
            }
            savePanelSize(doc)
          }
          if (doc != null) {
            doc.addEventListener('pointermove', onMove)
            doc.addEventListener('pointerup', onUp)
            doc.addEventListener('pointercancel', onUp)
          }
        }
      }

      const submitPrompt = function () {
        if (prompt == null) return
        const kind = prompt.kind
        const value = prompt.value.trim()
        if (value.length === 0) return
        /* 分支行右键菜单的两个输入框：「新建分支…」以右键那条为起点（prompt.at 钉着
            它），确认即建好并切过去（git/branch-create 的 at 形状）；「重命名分支…」
            的旧名钉在 prompt.name 上 —— 输入框改的只是 value，旧名不能跟着漂。两个
            动作的仓库都随 prompt.repo 落回右键那一行自己的仓库（ctxRun 同一条路）。 */
        if (kind === 'branch-at') {
          setPrompt(null)
          ctxRun('git/branch-create', { name: value, at: text(prompt.at) }, text(prompt.repo), '新建分支失败', function () {
            setOkNote('已新建分支 ' + value + '（以 ' + text(prompt.at) + ' 为起点）并切了过去')
          })
          return
        }
        if (kind === 'branch-rename') {
          setPrompt(null)
          ctxRun('git/branch-rename', { name: text(prompt.name), to: value }, text(prompt.repo), '重命名分支失败', function () {
            setOkNote('已把分支 ' + text(prompt.name) + ' 重命名为 ' + value)
          })
          return
        }
        const at = selected !== null ? selected : ''
        setPrompt(null)
        if (kind === 'tag') runOp('git/tag', { name: value, at: at })
        else runOp('git/branch-create', { name: value, at: at })
      }

      React.useEffect(function () {
        if (!repoOk || props.ready !== true) return undefined
        let alive = true
        callHost('git/refs', base(appliedRepo)).then(function (data) {
          if (alive) setRefs(data)
        }).catch(function (failure) {
          if (alive) setError(failureText(failure))
        })
        return function () { alive = false }
      }, [appliedRepo, repoOk, freshAt, props.ready])

      /* 多选时左栏按仓库分组，每个选中仓库各要一份自己的 ref 表。Host 那边按仓库缓存
         这份读（invalidateRepo 同一套失效），所以这里每次 selection/refresh 直接问，
         便宜的命中不用省。 */
      const [repoRefs, setRepoRefs] = React.useState({})
      React.useEffect(function () {
        if (tab !== 'log' || props.ready !== true || logSelKey.length === 0) return undefined
        let alive = true
        const repos = logSelKey.split('\u0000')
        for (let i = 0; i < repos.length; i += 1) {
          const repo = repos[i]
          callHost('git/refs', { sessionId: sessionId, repo: repo }).then(function (data) {
            if (alive !== true) return
            setRepoRefs(function (previous) {
              const next = Object.assign({}, previous)
              next[repo] = data
              return next
            })
          }).catch(function (failure) {
            /* 一份 ref 表读不动不该连别的组也不画：记进日志，那一组显示「无法读取
               分支」。 */
            console.error('dsh-git-idea: could not read refs of ' + repo, failureText(failure))
            if (alive !== true) return
            setRepoRefs(function (previous) {
              const next = Object.assign({}, previous)
              next[repo] = { ok: false, local: [], current: [], remote: [] }
              return next
            })
          })
        }
        return function () { alive = false }
      }, [logSelKey, tab, freshAt, props.ready])

      /* ── 工作树块（25-worktree.js）的读数：永远跟随生效仓库 ──

         依赖与上面 git/refs 那条 effect 同一组：
           · appliedRepo —— 一切「切生效仓库」的路径（仓库块单击行、说明页「打开这个
             目录」、多选分组头单击、分支行双击的 pickBranch）最后都落在 setAppliedRepo
             上，这里跟着换仓库重读，整块换数据；
           · freshAt（reloadAt 的可见版）—— ⟳、变更 git 命令后的 bump、watcher 签名
             变化都推它；Host 那边每次整仓失效本来就把 'worktrees' 一格一起作废
             （65-worktree.js），重读拿到的必是新账；
           · repoOk / props.ready —— 不是仓库、面板没就绪时不读。
         失败不上横幅：答复 ok:false（非仓库、git 读不动）与运输层失败都折成
         ok:false 的占位，块自己退化成灰说明行 —— 工作树是辅助信息，error 位一次
         只说一件事的规矩不给它挤（catch 里只留一行控制台）。 */
      const [worktrees, setWorktrees] = React.useState(null)
      React.useEffect(function () {
        if (!repoOk || props.ready !== true) return undefined
        let alive = true
        callHost('git/worktrees', base(appliedRepo)).then(function (data) {
          if (alive) setWorktrees(data)
        }).catch(function (failure) {
          console.error('dsh-git-idea: could not read worktrees', failureText(failure))
          if (alive) setWorktrees({ ok: false, repo: appliedRepo.length > 0 ? appliedRepo : null, error: 'unavailable', worktrees: [] })
        })
        return function () { alive = false }
      }, [appliedRepo, repoOk, freshAt, props.ready])

      /* 分支树里双击分支。repo 为空 = 今天的单仓库树，行为一字不差；带仓库 = 多选
         分组里双击「切到那个仓库并只看这个分支」—— 两步并成一步，否则在多选视图里
         双击一个分支什么都不发生，看起来就像双击坏了。 */
      const pickBranch = function (repo, name) {
        if (repo.length === 0) {
          setAllRefs(false)
          setActiveRef(name)
          return
        }
        setRepoSelection(sessionId, 'log', [])
        applyRepo(repo)
        loadWork(repo)
        setAllRefs(false)
        setActiveRef(name)
      }

      /* shortlog walks the entire history, so it is deferred until the history
         tab can actually show the author dropdown. The changes tab never needs
         it, and the Host caches it once fetched. */
      React.useEffect(function () {
        if (!repoOk || props.ready !== true || tab !== 'log') return undefined
        let alive = true
        callHost('git/authors', base(appliedRepo)).then(function (data) {
          if (alive) setAuthors(data)
        }).catch(function () {
          if (alive) setAuthors(null)
        })
        return function () { alive = false }
      }, [appliedRepo, repoOk, tab, freshAt, props.ready])

      /* ── 命令页的读数：弹窗打开就预读，之后所有刷新都走后台异步 + 增量合并 ──

         过去是「第一次切到那页才读，每次重读整表翻新」：读者切过来先看一页
         「正在读取命令记录…」，答复到了 500 条列表整个重摆一遍。现在生成挪到弹窗
         打开那一刻（后台、不等切页），之后的每个刷新时机（切到命令页、这页开着时
         仓库 bump、点「重新读取」）都走同一条后台路：手里已有这个会话的列表就绝不
         清空、绝不置 loading，读完按行身份增量合并 —— 屏上只多出新的几行、正在跑的
         行补上退出码。

         与其它「切到那页才读」的读一样，这里不因切走页签作废在飞的那次读：扫一遍
         不该白扫。答复落地全走函数式 setState，基于**最新**的 state 合并 —— 在飞
         期间 liveBus 插进来的行不会被旧闭包里的旧列表覆盖回去；sessionId 对不上时
         原样返回（那是换会话前留下的读数，谁也不许动它）。 */
      const readCmdLog = function (at, opens) {
        cmdLogBox.seq += 1
        const seq = cmdLogBox.seq
        setCmdLog(function (previous) {
          if (previous == null || previous.sessionId !== sessionId) {
            return { sessionId: sessionId, loading: true, at: at, opens: opens }
          }
          /* 同一会话手里已有列表 → 后台刷新：列表原样留着，只挂 refreshing。
             还没有任何列表（第一次生成）才整页「正在读取命令记录…」。 */
          if (Array.isArray(previous.commands) === true) {
            return Object.assign({}, previous, { at: at, opens: opens, refreshing: true })
          }
          return { sessionId: sessionId, loading: true, at: at, opens: opens }
        })
        callHost('git/command-log', { sessionId: sessionId, limit: 500 }).then(function (data) {
          if (seq !== cmdLogBox.seq) return
          setCmdLog(function (previous) {
            if (previous == null || previous.sessionId !== sessionId) return previous
            /* ok:false（沙箱拒绝、PATH 上没有 node、超时……）是「读得了答复、读不了
               记录」：原话在 data.error 里，折成空列表就成了「这个项目没跑过 git」。 */
            if (data == null || data.ok !== true) {
              const said = data != null && text(data.error).length > 0 ? text(data.error) : '读不了会话记录'
              /* 手里有列表：错误不顶掉列表 —— 原话记进读数，画的事归 57-cmdlog.js
                 （挂在列表上方）；只有首读就失败才整页只显错误。 */
              if (Array.isArray(previous.commands) !== true) {
                return { sessionId: sessionId, error: said, at: at, opens: opens }
              }
              return Object.assign({}, previous, { at: at, opens: opens, refreshing: false, error: said })
            }
            return {
              sessionId: sessionId,
              /* 增量合并，不是整表翻新：同 key 新答复为准，旧独有的行保留 */
              commands: cmdlogMergeRows(previous.commands, Array.isArray(data.commands) ? data.commands : [], CMDLOG_LIVE_MAX),
              truncated: data.truncated === true,
              /* 会话扫描那一路读不了（没有 node、被沙箱拒了……）而面板记录给得出来时，
                 Host 把原话放在 warning 里随行 —— 折成空字段就成了没说过。 */
              warning: text(data.warning),
              at: at,
              opens: opens,
              refreshing: false,
            }
          })
        }, function (failure) {
          if (seq !== cmdLogBox.seq) return
          setCmdLog(function (previous) {
            if (previous == null || previous.sessionId !== sessionId) return previous
            const said = failureText(failure)
            if (Array.isArray(previous.commands) !== true) {
              return { sessionId: sessionId, error: said, at: at, opens: opens }
            }
            return Object.assign({}, previous, { at: at, opens: opens, refreshing: false, error: said })
          })
        })
      }

      /* 什么时候该发读：手里那份读数「过期」了才发 —— 过期有三种形状，各有各的
         时机。换会话（对不上 sessionId）：当作未读，重新生成；新的一次打开（读数
         是在第几次打开时发起的，比不上当前的次数）：每次打开都算一次刷新时机，预读
         就从这里发生，不等读者切页 —— 这两条都不看页签，面板默认开在「历史」，预读
         要照发；打开之后过的期（at 落后于 freshAt，即仓库 bump 过）：只有命令页
         开着才补读 —— 读者没在看这一页，就让它一直旧着，切过来那一刻自然补上。
         切走再切回、期间没有 bump 也没有重开：读数既新又是这次打开里发起的，什么
         都不发。 */
      React.useEffect(function () {
        if (props.active !== true || props.ready !== true) {
          /* 藏着不发读；把「开着」放掉，下次再打开又算一次新的刷新时机。 */
          cmdLogBox.open = false
          return undefined
        }
        if (cmdLogBox.open !== true) {
          cmdLogBox.open = true
          cmdLogBox.opens += 1
        }
        if (cmdLog === null || cmdLog.sessionId !== sessionId) {
          readCmdLog(freshAt, cmdLogBox.opens)
          return undefined
        }
        if (cmdLog.opens !== cmdLogBox.opens) {
          readCmdLog(freshAt, cmdLogBox.opens)
          return undefined
        }
        if (cmdLog.at !== freshAt && tab === 'cmdlog') {
          readCmdLog(freshAt, cmdLogBox.opens)
          return undefined
        }
        return undefined
      }, [props.active, props.ready, sessionId, cmdLog, freshAt, tab])

      /* ── 命令页的实时推送（真包的 client-pre.js 提供 liveBus；bridge 版没有，
         typeof 守卫让它安静跳过，面板照旧靠整读）──

         Host 在面板每次变更命令开始/结束时广播（77-cmdrec.js），这里把消息缝进手里
         的列表：cmdlog-start 走和答复同一条增量合并路（57-cmdlog.js 的
         cmdlogMergeRows，按行身份去重/原地更新）—— 不再无条件 unshift：刚开的命令
         多半已经在最近一次答复里了，再前插一次就是两行；合并还会把它摆到 time 降序
         该在的位置（最新，自然在最前）。cmdlog-exit 按 id 就地改退出码。函数式
         setState 保证缝合落在最新的列表上，不与在飞的答复互相覆盖。 */
      React.useEffect(function () {
        if (typeof liveBus === 'undefined' || liveBus == null || typeof liveBus.subscribe !== 'function') return undefined
        return liveBus.subscribe(function (message) {
          if (message == null || typeof message !== 'object') return
          setCmdLog(function (previous) {
            if (previous == null || previous.sessionId !== sessionId) return previous
            if (message.kind === 'cmdlog-start') {
              const entry = message.entry
              if (entry == null || typeof entry !== 'object' || entry.id == null) return previous
              if (Array.isArray(previous.commands) !== true) return previous
              return Object.assign({}, previous,
                { commands: cmdlogMergeRows(previous.commands, [entry], CMDLOG_LIVE_MAX) })
            }
            if (message.kind === 'cmdlog-exit') {
              if (Array.isArray(previous.commands) !== true) return previous
              let moved = false
              const next = previous.commands.map(function (one) {
                if (one == null || one.id !== message.id) return one
                moved = true
                return Object.assign({}, one, { exitCode: typeof message.exitCode === 'number' ? message.exitCode : null })
              })
              return moved === true ? Object.assign({}, previous, { commands: next }) : previous
            }
            return previous
          })
        })
      }, [sessionId])

      React.useEffect(function () {
        if (props.ready !== true) return undefined
        /* 换了仓库：屏幕上那份快照是别人的，只能整棵树重读一次。同一个仓库上的一次
           bump（仓库在屏幕底下动过了）问的是屏上那些路径 —— 见 readChanges。标签页
           不进这个判据：从「历史」切到「变更」不改变工作区是什么样。 */
        if (panelBox.repo !== appliedRepo) {
          panelBox.repo = appliedRepo
          panelBox.needFull = true
        }
        readChanges()
        return undefined
      }, [appliedRepo, tab, freshAt, props.ready, sessionId])

      /* A read that came back “not a repository” while the session was still
         being resolved must not be the last word: closing and reopening the
         panel asks again. A working repository keeps its snapshot — that is
         what makes reopening instant — so only a failed verdict is retried. */
      React.useEffect(function () {
        if (props.active !== true || props.ready !== true) return
        if (work == null || work.ok === true) return
        readChanges()
      }, [props.active, props.ready])

      /* ── the whole tree, on a clock ──

         Nothing else notices a file that was clean and has just been modified,
         or a new file in a directory with nothing changed in it. That read is
         seconds on a slow mount, so it happens while the changes tab is the thing
         on screen and nowhere else. */
      React.useEffect(function () {
        if (!repoOk || props.ready !== true || props.active !== true || tab !== 'changes') return undefined
        return timerOf().interval(function () { reloadChanges() }, fullReadGapMs(treeCost))
      }, [appliedRepo, repoOk, props.active, props.ready, tab, treeCost])

      /* ── 多选的变更分组：每个选中仓库一份工作区快照 ──

         快照全部走全局那份读数（publishTreeRead/treeRecord）：读过的仓库在这里是
         免费的，chip 和单仓库面板量过的都能直接用；没有快照、或这份快照过期
         （treeReadDue）的仓库才发一次全树读。一次全树读是这条通道上最贵的东西，
         多选不改变这一点 —— 所以只补缺的，不在每次重画时全量重读。 */
      React.useEffect(function () {
        if (tab !== 'changes' || props.ready !== true || changeSelKey.length === 0) return undefined
        let alive = true
        const repos = changeSelKey.split('\u0000')
        for (let i = 0; i < repos.length; i += 1) {
          const repo = repos[i]
          const record = treeRecord(repo)
          if (record !== null && record.status != null && treeReadDue(repo) !== true) continue
          const started = Date.now()
          const finished = treeCountReadStart(repo)
          callHost('git/panel', { sessionId: sessionId, repo: repo }).then(function (reply) {
            finished()
            if (alive !== true || reply == null || reply.ok !== true) return
            publishTreeRead(repo, reply, true, Date.now() - started)
          }, function (failure) {
            finished()
            /* 快照读不下来那一组显示「无法读取这个仓库的变更」，别的组照画；失败
               记进日志，不升到面板的错误横幅 —— 横幅说的是生效仓库的事。 */
            console.error('dsh-git-idea: could not read the working tree of ' + repo, failureText(failure))
          })
        }
        return function () { alive = false }
      }, [changeSelKey, tab, props.ready, freshAt, sessionId])

      /* 多选时只 watch 选中的那几个仓库（不是清单里的全部 —— watcher 是真的在跑
         git 的，多一个仓库就多一份轮询）。深度那半和单仓库一样只在变更页正在被看
         时开，问的路径也是那个仓库自己的脏路径。 */
      React.useEffect(function () {
        if (props.ready !== true || props.active !== true || tab !== 'changes' || changeSelKey.length === 0) return undefined
        const repos = changeSelKey.split('\u0000')
        const stops = []
        for (let i = 0; i < repos.length; i += 1) {
          stops.push(watchRepo(repos[i], sessionId, bump, true, true))
          setWatchPaths(repos[i], sessionId, treeReadPaths(repos[i]))
        }
        return function () { for (let i = 0; i < stops.length; i += 1) stops[i]() }
      }, [changeSelKey, tab, props.active, props.ready, sessionId])

      React.useEffect(function () {
        if (!repoOk || props.ready !== true || tab !== 'log') return undefined
        let alive = true
        const request = base(appliedRepo)
        request.maxCount = maxCount
        if (allRefs) request.allRefs = true
        else if (activeRef.length > 0) request.ref = activeRef
        if (search.length > 0) {
          request.search = search
          if (regexSearch === true) request.regex = true
          if (caseSensitive === true) request.caseSensitive = true
        }
        if (author.length > 0) request.author = author
        const since = dateSince(datePreset)
        if (since.length > 0) request.since = since
        if (pathFilter.length > 0) request.path = pathFilter
        callHost('git/graph', request).then(function (data) {
          if (!alive) return
          setGraph(data)
          /* Nothing is selected until a commit is clicked. Re-reading the history
             keeps whatever was picked if it is still in the new list, and drops it
             otherwise — the list must never pick for the reader. */
          const commits = data != null && data.ok === true && Array.isArray(data.commits) ? data.commits : []
          let keep = ''
          for (let i = 0; i < commits.length; i += 1) {
            if (text(commits[i].hash) === pickedCommit) { keep = pickedCommit; break }
          }
          setSelected(keep.length > 0 ? keep : null)
          if (keep.length === 0) {
            pickedCommit = ''
            setDetail(null)
            return
          }
          const detailRequest = base(appliedRepo)
          detailRequest.hash = keep
          callHost('git/commit-detail', detailRequest).then(function (chosen) {
            if (alive) setDetail(chosen)
          }).catch(function () {})
        }).catch(function (failure) {
          if (alive) setError(failureText(failure))
        })
        return function () { alive = false }
      }, [appliedRepo, activeRef, allRefs, search, regexSearch, caseSensitive, author, datePreset, pathFilter, maxCount, tab, repoOk, freshAt, props.ready])

      /* The panel node exists by the time effects run, so its document is the
         first place a remembered size or preference can be read from. */
      React.useEffect(function () {
        const node = panelNode
        const doc = node != null ? node.ownerDocument : null
        loadPanelSize(doc)
        loadSettings(doc)
        /* 面板首帧的 appliedRepo 是渲染期从 sessionRepo 拿的快照：平时账早被 chip
           读好了（它每页必挂），这里补一次 doc 交接兜底 —— 万一面板先于 chip 到场
           （单测直接挂面板、或未来的挂载顺序变化），账也赶在下次询问前就位。 */
        loadAppliedRepos(doc)
        loadPluginConfig()
        if (panelSize.w > 0 || panelSize.h > 0) setSize({ w: panelSize.w, h: panelSize.h })
      }, [])

      /* the settings page can reset the geometry while this panel is open */
      React.useEffect(function () {
        return panelSizeSignal.subscribe(function () {
          setSize({ w: panelSize.w, h: panelSize.h })
        })
      }, [])

      /* ── 面板打开期间，跟着输入框量 ──

         「发送第一条消息后输入框立刻从居中落到底部」这种 DOM 位移对插件没有事件
         可听，只能自己量：active 期间用一个 rAF 循环每帧读一次锚点容器的 rect.top
         与真实上界（clipCeiling），与上次差超过 1px 才 setState —— 没动的帧只读
         一个 rect 加十几个 computedStyle、零渲染；窗口 resize（rect 会变）也顺带被
         覆盖。active 变 false 时取消循环。

         上界必须和锚点同帧同量：hero→settling→active 的相位切换没有事件，居中的
         输入框落底、页头伸缩、滚动体自己被滚，全都是「下一帧 rect 就不一样」的事，
         rAF 循环是唯一靠得住的跟随方式。

         用 useLayoutEffect 是为了让「打开面板」的那一帧就把高度钳住：先画一帧
         74vh、下一帧再缩回来，正好闪一下头部跑出视口的样子。 */
      useLayoutEffect(function () {
        if (props.active !== true) return undefined
        const doc = nodeBox.node != null ? nodeBox.node.ownerDocument : null
        const view = doc != null ? doc.defaultView : null
        let raf = 0
        let lastTop = NaN
        let lastVh = NaN
        let lastCeiling = NaN
        const readAnchor = function () {
          /* 跳出主对话（floated）后，面板本体住进了 body 级浮层，offsetParent 是
             浮层自己，量它就成了「以视口为锚」。改量入口探针（GitPopover 留在槽位
             里的那只 1×1 盒）：它的 offsetParent 还是输入框卡片，和旧面板量到的是
             同一个锚。穿过 anchorBox 读 .node，首帧 ref 没回来就先按面板自己量。 */
          const probeNow = props.floated === true && props.anchorBox != null
            ? props.anchorBox.node : null
          const box = panelAnchorBox(probeNow != null ? probeNow : nodeBox.node)
          const top = box == null ? NaN : parseFloat(box.top)
          const vh = view != null ? parseFloat(view.innerHeight) : NaN
          if (!isFinite(top)) return
          /* 真实上界：会话滚动体（或任何会裁竖向溢出的祖先）的可见上沿。量不到
             （没有布局的环境、祖先全不裁）时是 null，钳制按 0 —— 即视口上沿。
             浮层路径没有滚动体祖先，唯一的界就是视口上沿：这格直接空着（NaN），
             与「量不到」同义。 */
          let ceilingNum = NaN
          if (props.floated !== true) {
            const ceiling = clipCeiling(nodeBox.node, view)
            ceilingNum = isFinite(ceiling) ? ceiling : NaN
          }
          /* 「上次」是 NaN 的第一帧必须判成动过 —— 比较式 `Math.abs(x - NaN) > 1`
             恒为 false，把第一帧也算「没动」的话，一次都不会 setState，钳制就永远
             不生效（15ab5a3 正是栽在这里：锚点从没写进 state，hero 相位照旧显示
             不全）。上界/vh 的「有没有」变化（NaN↔数值）也算动过。 */
          const ceilingMoved = isFinite(ceilingNum) !== isFinite(lastCeiling)
            || (isFinite(ceilingNum) && Math.abs(ceilingNum - lastCeiling) > 1)
          if (!isFinite(lastTop) || Math.abs(top - lastTop) > 1
            || isFinite(vh) !== isFinite(lastVh) || (isFinite(vh) && Math.abs(vh - lastVh) > 1)
            || ceilingMoved) {
            lastTop = top
            lastVh = vh
            lastCeiling = ceilingNum
            setAnchor({ top: lastTop, ceiling: isFinite(ceilingNum) ? ceilingNum : null, vh: lastVh })
          }
        }
        readAnchor()
        if (view == null || typeof view.requestAnimationFrame !== 'function') return undefined
        const tick = function () {
          readAnchor()
          raf = view.requestAnimationFrame(tick)
        }
        raf = view.requestAnimationFrame(tick)
        return function () { view.cancelAnimationFrame(raf) }
      }, [props.active])

      /* The panel watches fast only while it is the thing on screen; closed, it
         falls back to the chip's slow lane and shares that poller. */
      React.useEffect(function () {
        if (!repoOk || props.ready !== true) return undefined
        /* The deep signature is the one that notices edits inside files, and it
           is the expensive one; it is worth paying only while the changes tab is
           the thing being looked at. */
        return watchRepo(appliedRepo, sessionId, bump, props.active === true, tab === 'changes')
      }, [appliedRepo, repoOk, sessionId, props.active, props.ready, tab])

      /* The watcher's deep tick asks about the paths on screen, so it has to be
         told which ones they are. Nothing else drives this: a snapshot that
         changed is exactly a change in what is worth watching. Declared after the
         registration above, so on the render where it first fires there is an
         entry to write into. */
      React.useEffect(function () {
        if (status == null || status.ok !== true) return
        setWatchPaths(appliedRepo, sessionId, pathsOfInterest(status, treeKey(status, appliedRepo)))
      }, [status, appliedRepo, sessionId])

      /* One identity for as long as the repository does not change: the commit
         rows are memoised, and a handler rebuilt on every render would defeat
         every one of them — including for the rows whose own state did not move. */
      const openCommit = useCallback(function (hash) {
        setSelected(hash)
        pickedCommit = hash
        const request = base(appliedRepo)
        request.hash = hash
        rpc('git/commit-detail', request).then(function (data) {
          setDetail(data)
        }, function (failure) {
          setError(failureText(failure))
        })
      }, [appliedRepo, sessionId])

      /* 提交行的点击入口：普通点击照旧走 openCommit；Ctrl/Cmd+点击只动多选；Shift+点击
         扩一段（见 pickCommit 本体与 pickAnchor 的注释）。用函数式 setState 与箱子
         （graphBox / pickAnchor）喂图，所以这个回调不依赖 multiSel 与 graph ——
         行级 memo 仍然成立。 */
      const pickCommit = useCallback(function (hash, event) {
        const shift = event != null && event.shiftKey === true
        const ctrl = event != null && (event.ctrlKey === true || event.metaKey === true)
        if (shift === true && ctrl !== true) {
          /* Shift+点击要 preventDefault：浏览器把它当「扩展文字选区」，不拦的话
             一划就把提交行的文字选蓝了。 */
          if (event != null && typeof event.preventDefault === 'function') event.preventDefault()
          const slice = graphSliceBetween(graphBox.commits, pickAnchor.hash, hash)
          if (slice !== null && slice.length > 1) {
            /* 整段（含两端）按图序写入；selected/openCommit 跟点击行；锚点不动 ——
               连着扩两次，第二段从同一个锚点算起（IDEA 同款）。 */
            setMultiSel(slice)
            openCommit(hash)
            return
          }
          /* 无锚点（或锚点行已不在眼前这份列表里）：退化为普通单选，并把这一行
             立成新锚点。 */
          pickAnchor.hash = hash
          openCommit(hash)
          return
        }
        /* 普通点击与 Ctrl 点击都把锚点挪到这一行：下一次 Shift 点击从它算起。 */
        pickAnchor.hash = hash
        if (ctrl === true) {
          setMultiSel(function (previous) {
            const at = previous.indexOf(hash)
            if (at >= 0) {
              const next = previous.slice()
              next.splice(at, 1)
              return next
            }
            return previous.concat([hash])
          })
          return
        }
        openCommit(hash)
      }, [openCommit])

      /* ── 右键菜单的两个人口 ──

         提交行：右键 = 先按左键单选的同一条路选中（openCommit），再在光标处开菜单；
         Ctrl 多选不动，菜单里的「拣选/还原」作用于整个选区（PhpStorm：动作作用于
         selection，见 ctxTargetHashes），其余项仍对右键那一条。分支行：带这一组的
         种类（本地/远程/HEAD）与所属仓库（多选分组里的分支删除要落在它自己的仓库
         上）。开新菜单时把上一次的两段式确认作废。传给 memo 化提交行的回调必须
         稳定，否则行级记忆全被打破 —— 所以 openCommitMenu 是 useCallback。
         check: null 是菜单体检（git/edit-check）的「还没回」占位，seed 比对见下面
         那条 effect —— 迟到的答复不许盖到新菜单上（pushConfirm 的预览同一个做法）。 */
      const openCommitMenu = useCallback(function (hash, event) {
        openCommit(hash)
        setCtxMenu({
          kind: 'commit', hash: hash, check: null,
          x: event != null && typeof event.clientX === 'number' ? event.clientX : 0,
          y: event != null && typeof event.clientY === 'number' ? event.clientY : 0,
        })
      }, [openCommit])

      /* ── 菜单体检：菜单开着就问一次「能不能改写」 ──

         git/edit-check 对目标集（右键行 ∈ multiSel 且多选>1 时是整份 multiSel，
         否则是右键那一条）逐条答 reachable / pushed / isHead / isRoot，外带此刻的
         HEAD。菜单项的置灰与 title 说的原因（已推送要强推 / 不在当前分支历史上 /
         根提交暂不支持）全从这份答复读；没回来之前「编辑提交消息…」等改写项一律
         置灰 —— 菜单先开、体检后到，置灰变可用是肉眼可见的一帧，比放行一个查
         过会失败的动作诚实。只读不进「命令」页；失败折成 {ok:false} 存着，菜单
         项照旧置灰并说「检查没通过」的原因。 */
      React.useEffect(function () {
        if (ctxMenu === null || ctxMenu.kind !== 'commit' || ctxMenu.check !== null) return undefined
        const seed = ctxMenu
        const request = base(appliedRepo)
        request.hashes = ctxTargetHashes(seed.hash, multiSel)
        let alive = true
        callHost('git/edit-check', request).then(function (reply) {
          if (alive !== true) return
          setCtxMenu(function (previous) {
            if (previous !== seed) return previous
            const check = reply != null && reply.ok === true ? reply : { ok: false, stderr: reply != null ? text(reply.stderr) : '' }
            return Object.assign({}, previous, { check: check })
          })
        }, function (failure) {
          if (alive !== true) return
          setCtxMenu(function (previous) {
            if (previous !== seed) return previous
            return Object.assign({}, previous, { check: { ok: false, stderr: failureText(failure) } })
          })
        })
        return function () { alive = false }
      }, [ctxMenu])

      /* head（可选）：右键的这行是不是它所在仓库的当前分支。HEAD 组的行天然是，
         「本地」组里由树按各仓库自己的 current 认（多选分组里生效仓库的 currentName
         认不得别的仓库的当前分支）—— 签出项的置灰认它，不认名字巧不巧相同。 */
      const openBranchMenu = function (name, kind, repo, event, head) {
        setCtxArm('')
        setCtxForce('')
        setCtxMenu({
          kind: 'branch', name: name, remote: kind === 'remote', head: head === true, repo: text(repo),
          x: event != null && typeof event.clientX === 'number' ? event.clientX : 0,
          y: event != null && typeof event.clientY === 'number' ? event.clientY : 0,
        })
      }

      /* ── 文件（与目录）行的右键菜单（61-filemenu.js 的菜单本体）──

         五棵文件树（单提交详情 / 合并视图 / 差异右列两路 / 变更页）把「右键的是
         哪一行」拼成 target 递上来；这里只记光标坐标与 target。两段式确认沿用
         ctxArm 那一格（键串带路径 —— 武装之后换行再右键，旧武装对不上新键，自然
         失效），开新菜单先作废上一次的武装，与 openBranchMenu 同一条规矩。 */
      const openFileMenu = function (target, event) {
        setCtxArm('')
        setCtxMenu({
          kind: 'file', target: target, repo: target != null ? text(target.repo) : '',
          x: event != null && typeof event.clientX === 'number' ? event.clientX : 0,
          y: event != null && typeof event.clientY === 'number' ? event.clientY : 0,
        })
      }

      /* 分支行的删除：两段式确认 —— -d 被拒（提交没合并到别处）才给出 -D，-D
         也要再确认一次。成功后关菜单、提示条说一声；失败菜单留着（强制删除
         那一项要在这里出现）。 */
      const ctxBranchRemove = function (name, force) {
        if (ctxBusy === true || busy === true) return
        setCtxBusy(true)
        const scope = ctxMenu != null && text(ctxMenu.repo).length > 0 ? base(ctxMenu.repo) : base(appliedRepo)
        rpc('git/branch-delete', Object.assign({}, scope, { name: name, force: force === true }), '删除分支失败')
          .then(function () {
            setCtxBusy(false)
            bump()
            setCtxArm('')
            setCtxForce('')
            setOkNote('已删除分支 ' + name + (force === true ? '（强制 -D，未合并的提交已随分支丢弃）' : ''))
            setCtxMenu(null)
          }, function (failure) {
            const detail = failureText(failure)
            setCtxBusy(false)
            bump()
            if (force !== true && detail.indexOf('not fully merged') >= 0) {
              setCtxForce(name)
              setCtxArm('')
              setError('git 拒绝安全删除 ' + name + '：它的提交还没有合并到别处。')
              return
            }
            setError(detail)
          })
      }

      /* ── 修改跟踪分支 ──

         右键菜单「修改跟踪分支…」的两步动作：绑定（git/branch-upstream 带
         {name, upstream:{remote,branch}}，Host 拼的是 git branch
         --set-upstream-to=<remote>/<branch> <本地分支>）与取消（{name, unset:true}，
         --unset-upstream）。成功后 bump 刷新 refs、提示条说绑到了哪；失败把层关掉、
         错误条说 git 的原话 —— 覆盖层把提示位也盖住了，留着层错误就看不见。 */
      const upstreamOfBranch = function (branch, repo) {
        /* 这个分支现在的上游，从树用的同一份 refs 数据里读（单仓库树是 refs，
           多选分组树是 repoRefs 按仓库那几份）。读不到（还没读到 / 那份失败）返回
           null —— 「取消跟踪」不禁用，让 git 用它的原话再挡一次。 */
        const data = text(repo).length > 0 ? repoRefs[repo] : refs
        if (data == null || data.ok !== true || !Array.isArray(data.local)) return null
        for (let i = 0; i < data.local.length; i += 1) {
          const row = data.local[i]
          if (row != null && text(row.data) === branch) return text(row.upstream)
        }
        return ''
      }
      const ctxSetUpstream = function (name, repo, pick) {
        if (busy === true) return
        /* 多选分组里右键的分支要落回它自己的仓库（ctxBranchRemove 同一个算法）。 */
        const scope = text(repo).length > 0 ? base(repo) : base(appliedRepo)
        const payload = pick === null
          ? { name: name, unset: true }
          : { name: name, upstream: { remote: pick.remote, branch: pick.branch } }
        setBusy(true)
        rpc('git/branch-upstream', Object.assign({}, scope, payload), '修改跟踪分支失败').then(function () {
          setBusy(false)
          bump()
          setUpstreamPick(null)
          setOkNote(pick === null
            ? '已取消 ' + name + ' 的上游跟踪'
            : '已把 ' + name + ' 的上游设为 ' + pick.remote + '/' + pick.branch)
        }, function (failure) {
          setBusy(false)
          bump()
          setUpstreamPick(null)
          setError(failureText(failure))
        })
      }

      /* ── 分支行右键菜单的动作（签出 / 新建分支 / 推送 / 重命名 / 远程签出）──

         与 ctxBranchRemove / ctxSetUpstream 同一条路：rpc 直发、仓库落在右键那一行
         自己的仓库上（多选分组里每个仓库各是各的）、成功失败都 bump。菜单项的
         onClick 先 setCtxMenu(null) 再进来 —— 动作没有两段式，错误条直接可见。
         needFull 沿 runOpApply 的同一张表：签出会整棵改写工作区，要的是一次全树读。 */
      const ctxRun = function (method, payload, repo, said, onOk) {
        if (busy === true || ctxBusy === true) return
        const scope = text(repo).length > 0 ? base(repo) : base(appliedRepo)
        setBusy(true)
        setArmed('')
        setError(null)
        setOkNote('')
        panelBox.needFull = REWRITES_TREE.indexOf(method) >= 0
        rpc(method, Object.assign({}, scope, payload), said).then(function (reply) {
          setBusy(false)
          bump()
          if (typeof onOk === 'function') onOk(reply)
        }, function (failure) {
          setBusy(false)
          bump()
          setError(failureText(failure))
        })
      }

      /* 签出本地分支：git switch <分支>。上游状态、菜单收放都不用这里管 ——
         树的 ★ 与 tsub 小字跟着 bump 后的 refs 自己挪。 */
      const ctxCheckout = function (name, repo) {
        ctxRun('git/checkout', { name: name }, repo, '签出失败', function () {
          setOkNote('已切到分支 ' + name)
        })
      }

      /* 签出远程分支：本地名取去掉远端前缀的那一段（origin/feat/x → feat/x）。
         本地同名分支已存在时不发请求 —— 开二选一确认层（remotePick）：两个出口都
         切到本地那份，区别只在本地分支要指向哪。refs 数据过期漏了同名分支的话，
         git 自己的拒绝（a branch named 'feat/x' already exists）会把原话带上错误
         条，两道都明确。 */
      const ctxCheckoutRemote = function (name, repo) {
        const slash = name.indexOf('/')
        const local = slash > 0 ? name.slice(slash + 1) : name
        const data = text(repo).length > 0 ? repoRefs[repo] : refs
        if (data != null && data.ok === true && Array.isArray(data.local)) {
          for (let i = 0; i < data.local.length; i += 1) {
            const row = data.local[i]
            if (row != null && text(row.data) === local) {
              setRemotePick({ name: name, repo: text(repo), local: local })
              return
            }
          }
        }
        ctxRun('git/checkout', { name: name, asNewLocal: true }, repo, '签出失败', function () {
          setOkNote('已把 ' + name + ' 签出为本地分支 ' + local + '，并跟踪 ' + name)
        })
      }

      /* 二选一层的两个出口。都先关层再走 ctxRun：动作发起即关（busy 是 ctxRun 自己
         置的），与右键菜单动作「没有两段式」同一规矩 —— 失败时错误条在层底下直接
         可见，成功写成功条。
         · 直切：本地分支与其提交原样保留，等价于右键「本地」组的那一行。
         · 覆盖：切过去之后把本地分支重置到远端 —— 本地独有的提交与未提交改动都会
           被丢弃，这份危险写在按钮 title 里，确认靠读者自己这一下。 */
      const ctxCheckoutRemoteLocal = function (pick) {
        setRemotePick(null)
        ctxRun('git/checkout', { name: pick.local }, pick.repo, '签出失败', function () {
          setOkNote('已切到分支 ' + pick.local)
        })
      }
      const ctxCheckoutRemoteReset = function (pick) {
        setRemotePick(null)
        ctxRun('git/checkout', { name: pick.name, resetLocal: true }, pick.repo, '签出失败', function () {
          setOkNote('已把 ' + pick.local + ' 重置到 ' + pick.name + ' 并切换过去（本地独有的提交已丢弃）')
        })
      }

      /* 推送：有上游 → 按上游的远端 -u 重申着推（无害）；无上游 → 远端取 origin
         （若存在）否则仓库唯一远端，同样 -u 推送并把上游绑过去（与「修改跟踪分支…」
         呼应）。仓库没有远端、或多远端而分支没有上游时，不发请求 —— 这两件事
         菜单替读者猜不出来，提示条把出路（「修改跟踪分支…」）指给他。远端清单从
         树同源的那份 refs 数据里拿，不为这一次推送新发请求。 */
      /* ── 两段式推送：先弹确认框，点「推送」才真推 ──

         四个入口都汇到 openPushConfirm：顶栏 ↑（当前分支、生效仓库）、分支行右键
         「推送」的两条路（有上游按上游的远端 -u 重申；无上游挑好远端 -u 绑定）、
         右栏横幅「推送并设为上游」。打开前就知道远端的入口把 setUpstream 带着进来
         （PushConfirmBox 直接说将执行什么）；顶栏 ↑ 不带 —— 有没有上游要等预览
         答复。返回的 promise 在弹窗收起时才落定：顶栏 ↑ 的 runSync 链等它熄灯，
         其余入口没人等。

         「没有上游」时框里按 ctxPush 原来那套规矩现猜远端（guessPushRemote：origin
         优先 → 唯一远端 → 都不满足就不猜）：猜得出就给「推送并设为上游」的确认
         按钮；猜不出把出路说成一句话（与 ctxPush 的两句提示同款话术），不开天窗、
         也不发请求。 */
      const pushConfirmData = pushConfirm === null ? null
        : (text(pushConfirm.repo).length > 0 ? (repoRefs[pushConfirm.repo] !== undefined ? repoRefs[pushConfirm.repo] : null) : refs)
      const pushGuessRemote = pushConfirm !== null && pushConfirm.setUpstream === null ? guessPushRemote(pushConfirmData) : ''
      const pushGuessNote = (function () {
        if (pushConfirm === null || pushConfirm.setUpstream !== null) return ''
        if (pushConfirmData == null || pushConfirmData.ok !== true) return '读不到分支数据，无法判断往哪个远端推 —— 等分支列表读出来再试'
        const remotes = Array.isArray(pushConfirmData.remote) ? pushConfirmData.remote : []
        if (remotes.length === 0) return '这个仓库没有配置远端，无法推送'
        return '该分支没有上游，仓库有多个远端，请先用分支行右键「修改跟踪分支…」指定远端'
      })()

      const closePushConfirm = function () {
        setPushConfirm(null)
        const done = pushBox.resolve
        pushBox.resolve = null
        if (typeof done === 'function') done()
      }

      const openPushConfirm = function (branch, repo, setUpstream, note) {
        if (pushBox.resolve !== null) return Promise.resolve()
        const seed = {
          branch: text(branch), repo: text(repo),
          setUpstream: setUpstream != null && typeof setUpstream === 'object'
            ? { remote: text(setUpstream.remote), branch: text(setUpstream.branch) } : null,
          note: text(note),
          preview: null, loading: true, running: false, error: '',
        }
        setPushConfirm(seed)
        return new Promise(function (resolve) { pushBox.resolve = resolve })
      }

      /* 第二段：真推。弹窗不关，进推送中态（按钮全禁、转圈、Esc/遮罩一起失效）；
         成功关框 + bump + 成功条（note 为空 = 顶栏 ↑ 这条路，老行为本来就不上条）。
         失败把 git 的原话留在框内，外面的错误条同步写一份 —— 弹窗一关它还在老
         位置，失败后的补救与从前同一个地方。上游缺失的那次失败（预览之后上游被人
         摘了这类竞态）把预览作废重读：读到没有上游，框自己翻出「推送并设为上游」
         的重试按钮；setNeedsUpstream 一并立着，弹窗关掉后横幅照旧在 —— 横幅那条
         老补救原样保留，只是推的动作进了框。 */
      const pushConfirmRun = function (withUpstream) {
        if (pushConfirm === null) return
        const state = pushConfirm
        if (state.running === true || state.loading === true) return
        const setUpstream = withUpstream === true
          ? (state.setUpstream != null ? state.setUpstream
              : (pushGuessRemote.length > 0 ? { remote: pushGuessRemote, branch: state.branch } : null))
          : null
        /* 猜不出远端还硬来就是盲推 —— 按钮在这种情况下本来就不出现，这里再挡一道。 */
        if (withUpstream === true && setUpstream == null) return
        const payload = setUpstream != null
          ? { setUpstream: true, remote: setUpstream.remote, branch: setUpstream.branch }
          : {}
        setPushConfirm(function (previous) {
          return Object.assign({}, previous, { running: true, error: '' })
        })
        rpc('git/push', Object.assign({}, base(state.repo), payload), '推送失败').then(function () {
          bump()
          if (state.note.length > 0) setOkNote(state.note)
          closePushConfirm()
        }, function (failure) {
          const said = failureText(failure)
          bump()
          setError(said)
          const plainPush = setUpstream === null
          const upstreamMiss = plainPush === true && said.indexOf('upstream') >= 0
          if (upstreamMiss === true) setNeedsUpstream(true)
          setPushConfirm(function (previous) {
            /* 只有拿「没有上游」怪不了别人的那次失败才翻预览：带 -u 的推送失败
               另有原因，框里已经有原话，重读只会把错误行顶掉。 */
            return Object.assign({}, previous, {
              running: false, error: said,
              preview: upstreamMiss === true ? null : previous.preview,
            })
          })
        })
      }

      /* ── 「编辑提交消息…」（reword） ──

         菜单项点开对话框：先按菜单体检答复里的 HEAD 定下 expect，再由下面那条
         seed effect 取原始消息预填。保存走 rpc 直发（不进 runOp 的全局错误条）——
         错误要说在框内，保存中禁按钮，成功关框 + 选中新 hash（newHead）。 */
      const openReword = function (hash) {
        const check = ctxMenu != null && ctxMenu.check != null && ctxMenu.check.ok === true ? ctxMenu.check : null
        setCtxMenu(null)
        setRewordBox({
          hash: hash,
          /* expect：体检那刻的 HEAD。体检没回/失败就是空串 —— reword 的防呆在
             Host 还有最后一道（head-moved），这里空着只是少一层提前的比对。 */
          head: check != null ? text(check.head) : '',
          message: '', loaded: false, running: false, error: '',
        })
      }

      React.useEffect(function () {
        if (rewordBox === null || rewordBox.loaded === true || rewordBox.running === true) return undefined
        const seed = rewordBox
        const request = base(appliedRepo)
        request.hashes = [seed.hash]
        callHost('git/commit-messages', request).then(function (reply) {
          const row = reply != null && reply.ok === true && Array.isArray(reply.messages) && reply.messages.length > 0
            ? reply.messages[0] : null
          setRewordBox(function (previous) {
            if (previous !== seed) return previous
            return Object.assign({}, previous, {
              loaded: true,
              message: row != null ? text(row.message) : '',
              error: row != null ? previous.error : '读不到这条提交的原始消息，只能从空白写起',
            })
          })
        }, function (failure) {
          setRewordBox(function (previous) {
            if (previous !== seed) return previous
            return Object.assign({}, previous, { loaded: true, error: '读不到这条提交的原始消息：' + failureText(failure) })
          })
        })
        return undefined
      }, [rewordBox])

      const rewordSave = function () {
        if (rewordBox === null || rewordBox.running === true) return
        const seed = rewordBox
        if (seed.message.trim().length === 0) return
        setRewordBox(function (previous) { return Object.assign({}, previous, { running: true, error: '' }) })
        const request = base(appliedRepo)
        request.hash = seed.hash
        request.message = seed.message
        request.expect = seed.head
        rpc('git/reword', request, '改写提交消息失败').then(function (reply) {
          bump()
          setRewordBox(null)
          const newHead = reply != null ? text(reply.newHead) : ''
          setOkNote('已修改提交消息 ' + hashShort(newHead.length > 0 ? newHead : seed.hash))
          /* 改写换了 hash：选中新行，详情跟着新提交走。 */
          if (newHead.length > 0) openCommit(newHead)
        }, function (failure) {
          bump()
          setRewordBox(function (previous) {
            if (previous !== seed) return previous
            return Object.assign({}, previous, { running: false, error: failureText(failure) })
          })
        })
      }

      /* ── 「合并提交… / 批量删除提交…」（作用于整个选区） ──

         菜单项点开确认框：列出选区提交（seed effect 取消息），合并消息从各提交的
         消息拼接预填（空行分隔、可编辑）。确认即关框发动作（拣选/还原同一条「动作
         发起即关」的规矩），失败错误条可见；删除成功的话成功条把 reflog 的找回
         通道说全（preHead 在答复里）。 */
      const openSelRewrite = function (mode, span, expectHead) {
        setCtxMenu(null)
        setSelRewrite({
          mode: mode,
          targets: span.targets,
          base: span.base,
          expect: expectHead,
          list: null, loading: true, message: '', error: '',
        })
      }

      React.useEffect(function () {
        if (selRewrite === null || selRewrite.list !== null) return undefined
        const seed = selRewrite
        const request = base(appliedRepo)
        /* commit-messages 一次最多 20 条：超出的选区只预填前 20 条的消息，框里
           说一声（squash 本身对条数没有限制）。 */
        const capped = seed.targets.slice(0, 20)
        request.hashes = capped.slice().reverse()
        let alive = true
        callHost('git/commit-messages', request).then(function (reply) {
          if (alive !== true) return
          const rows = reply != null && reply.ok === true && Array.isArray(reply.messages) ? reply.messages : null
          setSelRewrite(function (previous) {
            if (previous !== seed) return previous
            if (rows === null) {
              return Object.assign({}, previous, {
                loading: false,
                error: '读不到选区提交的消息：' + (reply != null ? text(reply.stderr) : ''),
              })
            }
            /* rows 按请求的顺序回来（最旧→最新）；合并消息按最旧→最新拼，读起来
               才是一条提交史。 */
            const parts = []
            for (let i = 0; i < rows.length; i += 1) {
              const said = text(rows[i].message).trim()
              if (said.length > 0) parts.push(said)
            }
            return Object.assign({}, previous, {
              loading: false,
              list: rows,
              message: parts.join('\n\n'),
              error: rows.length < capped.length || seed.targets.length > 20
                ? '选区超过 20 条，合并消息只预填了最旧的 20 条' : previous.error,
            })
          })
        }, function (failure) {
          if (alive !== true) return
          setSelRewrite(function (previous) {
            if (previous !== seed) return previous
            return Object.assign({}, previous, { loading: false, error: '读不到选区提交的消息：' + failureText(failure) })
          })
        })
        return function () { alive = false }
      }, [selRewrite])

      const selRewriteRun = function () {
        if (selRewrite === null || busy === true) return
        const seed = selRewrite
        if (seed.mode === 'squash' && seed.message.trim().length === 0) return
        setSelRewrite(null)
        setBusy(true)
        setError(null)
        setOkNote('')
        if (seed.mode === 'squash') {
          /* git/squash 的语义就是 base..HEAD 整段合一 —— 这里的 base 是最旧选中项
             的父提交，expect 是菜单体检那刻的 HEAD（要求它就是选区最新一条才开的项）。 */
          rpc('git/squash', { base: seed.base, message: seed.message, expect: seed.expect }, '合并提交失败')
            .then(function () {
              setBusy(false)
              setMultiSel([])
              bump()
              setOkNote('已把 ' + String(seed.targets.length) + ' 条提交合并为一条新提交')
            }, function (failure) {
              setBusy(false)
              bump()
              setError(failureText(failure))
            })
          return
        }
        rpc('git/drop', { base: seed.base, expect: seed.expect }, '删除提交失败')
          .then(function (reply) {
            setBusy(false)
            setMultiSel([])
            bump()
            const preHead = reply != null ? text(reply.preHead) : ''
            setOkNote('已删除 ' + String(seed.targets.length) + ' 条提交（连同它们的改动一并丢弃）。'
              + (preHead.length > 0 ? '误删可在 reflog 里找回：git reset --hard ' + preHead
                : '误删可在 reflog 里找回（约 30 天内）。'))
          }, function (failure) {
            setBusy(false)
            bump()
            setError(failureText(failure))
          })
      }

      /* 推送：两段式之后这里不再直接推。远端挑好就开确认框（openPushConfirm），
          真正的推送在读者点「推送」之后由 pushConfirmRun 发 —— 命令与从前一次
          不差，只是隔了一道确认。 */
      const ctxPush = function (name, repo) {
        const data = text(repo).length > 0 ? repoRefs[repo] : refs
        const upstream = upstreamOfBranch(name, repo)
        /* null 是「refs 这份读数根本没读到」：上游与远端都无从判断，说清楚原因比
           硬挑一个远端（可能挑错、还 -u 改绑）诚实。 */
        if (upstream === null) {
          setError('读不到分支数据，无法判断 ' + name + ' 的上游 —— 等分支列表读出来再推')
          return
        }
        if (upstream.length > 0) {
          const slash = upstream.indexOf('/')
          const remote = slash > 0 ? upstream.slice(0, slash) : upstream
          openPushConfirm(name, repo, { remote: remote, branch: name }, '已推送 ' + name + ' 到 ' + upstream)
          return
        }
        const remotes = data != null && data.ok === true && Array.isArray(data.remote) ? data.remote : []
        let chosen = ''
        for (let i = 0; i < remotes.length; i += 1) {
          if (text(remotes[i].name) === 'origin') { chosen = 'origin'; break }
        }
        if (chosen.length === 0 && remotes.length === 1) chosen = text(remotes[0].name)
        if (chosen.length === 0) {
          setError(remotes.length === 0
            ? '这个仓库没有配置远端，无法推送 ' + name
            : '该分支没有上游，仓库有多个远端，请先用「修改跟踪分支…」指定远端')
          return
        }
        openPushConfirm(name, repo, { remote: chosen, branch: name }, '已推送 ' + name + ' 并绑定上游 ' + chosen + '/' + name)
      }

      /* ── 多选的清空与修剪 ──

         多选是「对着眼前这份列表」选出来的：分支范围、筛选、搜索一变，所选的那段就
         不再是眼前这段；仓库切换、⟳、切页签各自在自己的路径上清（applyRepo /
         refresh / 下面这个 tab effect）。 */
      React.useEffect(function () { setMultiSel([]) }, [activeRef, allRefs, search, regexSearch, caseSensitive, author, datePreset, pathFilter])
      React.useEffect(function () { setMultiSel([]) }, [tab])
      /* 图重读之后把多选里已不在列表上的提交剪掉：多选高亮与 {hashes} 变量代值说的
         都得是眼前真实存在的行，顺序也顺手换成图上的顺序（{hashes} 变量按它代值）。 */
      React.useEffect(function () {
        if (multiSel.length === 0) return
        if (graph == null || graph.ok !== true || !Array.isArray(graph.commits)) return
        setMultiSel(function (previous) {
          const keep = []
          for (let i = 0; i < graph.commits.length; i += 1) {
            const hash = text(graph.commits[i].hash)
            if (previous.indexOf(hash) >= 0) keep.push(hash)
          }
          return keep.length === previous.length ? previous : keep
        })
      }, [graph])

      /* ── 选区的「段」：多选合并查看与整段改写（合并提交/批量删除）的共同判据 ──

         多选多于一条时按图与 multiSel 算一次（纯函数 selectionSpan）：连续与否、
         区间起点 base、最新一条 head。连续且 base 有着落（最旧一条不是根提交）才有
         base..head 可言 —— 视图的读、菜单里「合并提交… / 批量删除提交…」的可用
         条件都从这一份来，两处说的是同一件事。 */
      const selSpan = multiSel.length > 1 && graphBox.commits !== null ? selectionSpan(graphBox.commits, multiSel) : null
      const selSpanKey = selSpan != null && selSpan.contiguous === true && selSpan.base.length > 0
        ? selSpan.base + '..' + selSpan.head
        : null
      /* 选区视图的读：只在连续时发（git/commit-detail 的 {base, head} 形态）。
         答复带着发出时的 key 回家，渲染只认眼前这份 key —— 选区换段的迟到答复
         不会盖到新段上（pushConfirm 的 seed 比对同一个问题）。 */
      const [rangeRead, setRangeRead] = React.useState(null)
      React.useEffect(function () {
        if (selSpanKey === null) return undefined
        let alive = true
        const request = base(appliedRepo)
        request.base = selSpan.base
        request.head = selSpan.head
        callHost('git/commit-detail', request).then(function (reply) {
          if (alive) setRangeRead({ key: selSpanKey, reply: reply })
        }, function (failure) {
          if (alive) setRangeRead({ key: selSpanKey, reply: { ok: false, stderr: failureText(failure) } })
        })
        return function () { alive = false }
      }, [selSpanKey])

      const toggle = function (path) {
        setCollapsed(function (previous) {
          const next = Object.assign({}, previous)
          if (next[path] === true) delete next[path]
          else next[path] = true
          return next
        })
      }

      /* Opening a collapsed untracked directory: the list of files inside is one
         read, asked for at that moment and not before. The entry for this path is
         dropped first so the rows say "正在读取…" instead of showing the previous
         listing — after a stage or a commit that listing is what changed.
         `at` 多选分组里带过来：读哪个仓库的目录、展开状态按哪个仓库记 —— 两个仓库
         里同名目录各开各的，互不顶掉。 */
      const toggleUntracked = function (dir, at) {
        const repo = at != null && at.length > 0 ? at : ''
        const key = repo.length > 0 ? repo + '\u001f' + dir : dir
        if (untrackedOpen[key] === true) {
          const closed = Object.assign({}, untrackedOpen)
          delete closed[key]
          setUntrackedOpen(closed)
          return
        }
        const opened = Object.assign({}, untrackedOpen)
        opened[key] = true
        setUntrackedOpen(opened)
        setUntrackedFiles(function (previous) {
          const next = Object.assign({}, previous)
          delete next[key]
          return next
        })
        const request = base(repo.length > 0 ? repo : appliedRepo)
        request.dir = dir
        callHost('git/untracked', request).then(function (data) {
          const files = data != null && data.ok === true && Array.isArray(data.files) ? data.files : []
          setUntrackedFiles(function (previous) {
            const next = Object.assign({}, previous)
            next[key] = files
            return next
          })
        }).catch(function (failure) {
          setError(failureText(failure))
          setUntrackedFiles(function (previous) {
            const next = Object.assign({}, previous)
            next[key] = []
            return next
          })
        })
      }

      /* The mutation's own answer. Asked about the paths that changed, it costs a
         fraction of a whole-tree read, so the tick the reader just made is
         confirmed while they are still looking at it — and if another click has
         happened since, this reply is not about the state on screen any more and
         is dropped. `at` names the repository the paths belong to; empty means
         the applied one, which is the only case this ever was. */
      const confirmStaged = function (paths, at) {
        const repo = at != null && at.length > 0 ? at : appliedRepo
        const request = base(repo)
        request.paths = paths
        const epoch = repoEpoch(repo, sessionId)
        const finished = treeCountReadStart(repo)
        callHost('git/panel', request).then(function (reply) {
          finished()
          if (epoch !== repoEpoch(repo, sessionId)) return
          if (reply == null || reply.ok !== true) return
          /* 只有生效仓库的快照在这块屏上（setStatus）；别的仓库的确认读并进全局那份
             读数 —— 多选的变更分组和 chip 都从那里画。 */
          if (repo !== appliedRepo) {
            const record = treeRecord(repo)
            if (record != null && record.status != null) {
              publishTreeRead(repo, mergePanelStatus(record.status, reply), false, null)
            }
            return
          }
          setStatus(function (previous) { return mergePanelStatus(previous, reply) })
        }, function () { finished() })
      }

      /* ── one mutation after another, and none of them dims the panel ──

         A tick used to raise the panel's `busy` flag for as long as `git add`
         took (98–236ms measured, plus the read behind it), and `busy` is a
         panel-wide thing: the four header tools and the commit button render at
         40–45% opacity while it is up, and the commit button's own label swaps to
         `处理中…`, so the row's box moving was accompanied by the toolbar and the
         commit pane blinking on every single tick. What the flag was also buying
         is bought here instead: the two things a burst of clicks needs are order
         (the reader's calls reach git in the order they made them, so a tick and
         the untick after it cannot land reversed) and a commit that sees the
         index the reader sees (`git add` and `git commit` are separate processes,
         and a commit that starts before the add has finished commits the index
         from before the tick). */
      const queueMutation = function (run) {
        const next = panelBox.mutations.then(run, run)
        /* The chain itself must not carry a rejection forward: a failed `git add`
           is reported on screen, not by poisoning every mutation after it. */
        panelBox.mutations = next.then(function () {}, function () {})
        return next
      }

      const setStaged = function (files, staged, at) {
        if (files.length === 0) return
        const repo = at != null && at.length > 0 ? at : appliedRepo
        const paths = []
        for (let i = 0; i < files.length; i += 1) {
          const path = text(files[i].path)
          if (path.length > 0) paths.push(path)
        }
        if (paths.length === 0) return
        /* Everything already in flight describes the index before this call; one
           of those replies landing after it would paint the tick back to empty. */
        bumpRepoEpoch(repo, sessionId)
        const epoch = repoEpoch(repo, sessionId)
        const before = panelBox.status
        /* 乐观补丁只打在生效仓库那份屏上快照（panelBox.status 是它的）；多选分组里
           别的仓库没有本地快照可打，那一格等确认读回来再亮。 */
        const patched = repo === appliedRepo ? stageLocally(before, files, staged) : null
        if (patched !== null) {
          panelBox.status = patched
          setStatus(patched)
        }
        const request = base(repo)
        request.paths = paths
        queueMutation(function () {
          return rpc(staged ? 'git/stage' : 'git/unstage', request).then(function () {
            setError(null)
            /* Only the newest click may paint from a read. A reply about a state
               the reader has already moved past — the tick this one replaced —
               would put that box back where it was for a frame. */
            if (epoch === repoEpoch(repo, sessionId)) confirmStaged(paths, repo)
          }, function (failure) {
            setError(failureText(failure))
            /* git did not do it, so those paths go back to what git last said —
               read, not from a snapshot that a later click has already moved on
               from. The newest click's own read is the one that answers. */
            if (epoch === repoEpoch(repo, sessionId)) confirmStaged(paths, repo)
          })
        })
      }

      /* ── 默认变更列表的三件套：还原 / 暂存（54-changes.js 的工具条）──

         「添加」那一件就是 git add，走上面那个 setStaged —— 勾选==已暂存，所以它幂等，
         不需要自己的处理器。这两件不同：restore 把路径从索引和工作区一起抹回 HEAD，
         stash 把它们收进 stash 栈，答案都是「那几个路径现在干净了」，善后因此照
         setStaged 的样子：只问那几条路径的确认读（confirmStaged，0.2s 那条路），列表里
         那几行立刻消失，不为它们排一次全树读。

         与 tick 不同，这两个要动面板的 busy：它们各只有一次点击、没有乐观补丁可打
         （git 说了算），点下去到读回来之间，按钮自己得看得见在忙 —— tick 那条
         「不许让面板闪」的规矩（见 queueMutation 的注释）买的是连点，这里没有连点。 */
      const pickedPaths = function (files) {
        const paths = []
        for (let i = 0; i < files.length; i += 1) {
          const path = text(files[i].path)
          if (path.length > 0) paths.push(path)
        }
        return paths
      }

      const runGroupOp = function (method, files, at, extra, note) {
        const paths = pickedPaths(files)
        if (paths.length === 0) return
        const repo = at != null && at.length > 0 ? at : appliedRepo
        setBusy(true)
        setError(null)
        setOkNote('')
        /* 与 setStaged 同一个理由：在飞的读描述的是这次操作之前的仓库。 */
        bumpRepoEpoch(repo, sessionId)
        const epoch = repoEpoch(repo, sessionId)
        const request = base(repo)
        request.paths = paths
        if (extra != null) Object.assign(request, extra)
        queueMutation(function () {
          return rpc(method, request).then(function () {
            setBusy(false)
            setError(null)
            setOkNote(note(paths.length))
            if (epoch === repoEpoch(repo, sessionId)) confirmStaged(paths, repo)
          }, function (failure) {
            setBusy(false)
            setError(failureText(failure))
            /* git 没做成也要重读那几条路径：失败的原因（比如 stash 拒绝）常常已经改了
               它们的状态，屏幕不能停留在操作前的那一份上。 */
            if (epoch === repoEpoch(repo, sessionId)) confirmStaged(paths, repo)
          })
        })
      }

      /* 还原：git restore --source=HEAD --staged --worktree。破坏性，客户端已经两段式
         确认过；成功的话把「做了什么」说在成功条里，读者不用猜那几个文件去了哪。 */
      const revertPicked = function (files, at) {
        runGroupOp('git/restore', files, at, null, function (n) {
          return '已还原 ' + String(n) + ' 项：索引和工作区都回到 HEAD（被删的文件也已恢复）。'
        })
      }

      /* 暂存（stash）：非破坏，成功条里得说怎么拿回来 —— 不说的话 stash 就是黑洞。 */
      const stashPicked = function (files, at) {
        const count = pickedPaths(files).length
        runGroupOp('git/stash', files, at,
          { message: 'dsh-git-idea：暂存 ' + String(count) + ' 个文件' },
          function (n) {
            return '已收进 stash：' + String(n) + ' 项。git stash pop 可找回（git stash list 里能看到这一次）。'
          })
      }

      const changes = status != null && status.ok === true ? mergeChanges(status) : []
      let stagedCount = 0
      for (let i = 0; i < changes.length; i += 1) if (changes[i].staged === true) stagedCount += 1

      /* 多选时页签上的数字是**所有选中仓库**的合计（合计的每份都来自全局读数，
         treeCount）；没有多选时就是生效仓库那一个 —— 和今天一样。 */
      let changesBadge = changes.length
      if (changeSel.length > 0) {
        changesBadge = 0
        for (let i = 0; i < changeSel.length; i += 1) changesBadge += treeCount(changeSel[i])
      }
      /* 变更分组的每一组：{repo, status}，status 为 null 表示那次全树读还在飞。 */
      const changeGroups = changeSel.length > 0 ? changeSel.map(function (repo) {
        const record = treeRecord(repo)
        return { repo: repo, status: record === null ? null : record.status }
      }) : null

      const setStagedAll = function () {
        setStaged(changes, stagedCount === 0)
      }

      const commit = function () {
        setBusy(true)
        const request = base(appliedRepo)
        request.message = message.trim()
        if (stagedCount === 0) request.stageAll = true
        /* 提交用的就是屏上这一条：不等防抖，先把它按生效仓库存进 Host，草稿与
           这次提交才不会各说各话（同值在 Host 那边不写盘，多这一次往返都没有）。 */
        flushDraftSave(effectiveRepo, message)
        /* Behind the ticks rather than racing them: the button is no longer
           disabled while an `git add` is in flight, so the queue is what keeps
           the commit from describing an index the reader has already moved
           past. */
        queueMutation(function () {
          return rpc('git/commit', request, '提交失败').then(function () {
            setBusy(false)
            setError(null)
            /* 提交成功不再清空信息。清空买不到任何东西：git 已经把这条信息写进
               提交对象，输入框里那一份只是屏上的草稿；而连续提交（拆几次提交、
               或紧接着再提一次）恰恰要沿用同一条信息。它已经随 flush 存进 Host
               按这个仓库记着 —— 真想要空框，clearable 的 × 一下，那也是一条被
               记下来的「空」。 */
            panelBox.needFull = false
            bump()
          }, function (failure) {
            setBusy(false)
            setError(failureText(failure))
          })
        })
      }

      const currentBranch = graph != null && graph.ok === true ? text(graph.currentBranch) : (refs != null && refs.ok === true && refs.current.length > 0 ? refs.current[0] : '')
      const branchValue = allRefs ? '@all' : (activeRef.length > 0 ? activeRef : '@current')
      /* Short labels: this select now sits inside an inline "分支：…" trigger, so
         "当前分支（main）" would be the widest thing in the toolbar. */
      /* A native select cannot ellipsize — it cuts the glyph in half — so a long
         branch name is shortened in the label itself, with the full name in the
         option's title. */
      const shortRef = function (name) { return name.length > 12 ? name.slice(0, 11) + '…' : name }
      const branchOptions = [
        { value: '@current', label: '当前' + (currentBranch.length > 0 ? ' ' + shortRef(currentBranch) : ''), title: currentBranch },
        { value: '@all', label: '所有分支', title: '所有分支' },
      ]
      if (refs != null && refs.ok === true) {
        for (let i = 0; i < refs.local.length; i += 1) {
          branchOptions.push({ value: refs.local[i].data, label: shortRef(refs.local[i].data), title: refs.local[i].data })
        }
        for (let i = 0; i < refs.remote.length; i += 1) {
          for (let k = 0; k < refs.remote[i].refs.length; k += 1) {
            branchOptions.push({ value: refs.remote[i].refs[k].data, label: shortRef(refs.remote[i].refs[k].data), title: refs.remote[i].refs[k].data })
          }
        }
      }

      const authorLabels = { '': '作者' }
      const authorOptions = [h('option', { key: '__all', value: '' }, '作者')]
      if (authors != null && authors.ok === true) {
        for (let i = 0; i < authors.authors.length; i += 1) {
          const who = authors.authors[i]
          const value = who.email.length > 0 ? who.email : who.name
          authorLabels[value] = who.name
          authorOptions.push(h('option', {
            key: 'a' + i, value: value, title: who.name + ' · ' + String(who.count) + ' 个提交',
          }, who.name))
        }
      }

      const filterCount = (allRefs || activeRef.length > 0 ? 1 : 0)
        + (author.length > 0 ? 1 : 0)
        + (datePreset !== 'all' ? 1 : 0)
        + (pathFilter.length > 0 ? 1 : 0)
      const hasFilter = filterCount > 0 || search.length > 0
      const commitCount = graph != null && graph.ok === true ? graph.commits.length : 0
      const selectedCommit = selected !== null ? text(selected) : ''
      const canAct = repoOk && busy !== true && selectedCommit.length > 0
      const currentName = refs != null && refs.ok === true && refs.current.length > 0 ? refs.current[0] : ''
      const ahead = work != null && work.ok === true ? work.ahead : 0
      const behind = work != null && work.ok === true ? work.behind : 0
      const sequencer = work != null && work.ok === true ? text(work.sequencer) : ''
      const conflicts = status != null && status.ok === true ? status.unmerged.length : 0

      /* ── 快捷命令：变量上下文 + 执行 ──

         单选/详情属于「选中的那一条」（detail 就是它），{hashes} 属于多选（无多选退化为
         选中单条）。执行成功给绿色成功条（stdout 尾部 ~400 字符），失败进 error 区说
         「命令 + 原话」；两条路都照 runOp 的善后 bump 一次 —— 自定义命令可能动了 refs，
         Host 那边也把读缓存作废了（78-actions.js 的 quickRun）。放在 currentBranch /
         selectedCommit / detail 都已就位的地方：上下文是每帧现算的字面量。 */
      const quickCommands = plugin != null && Array.isArray(plugin.quickCommands) ? plugin.quickCommands : []
      const quickCtx = {
        branch: currentBranch,
        upstream: work != null && work.ok === true ? text(work.upstream) : '',
        hash: selectedCommit,
        hashes: multiSel.length > 0 ? multiSel.join(' ') : selectedCommit,
        subject: detail != null && detail.ok === true ? text(detail.subject) : '',
        author: detail != null && detail.ok === true ? text(detail.author) : '',
        email: detail != null && detail.ok === true ? text(detail.email) : '',
        date: detail != null && detail.ok === true ? text(detail.date) : '',
        tags: detail != null && detail.ok === true && Array.isArray(detail.tags) ? detail.tags.join(',') : '',
      }
      const runQuick = function (command) {
        if (busy) return
        setBusy(true)
        setQcConfirm(null)
        setQcEditor(null)
        setMenuOpen(null)
        setError(null)
        setOkNote('')
        const request = base(appliedRepo)
        request.command = command
        rpc('git/quick', request, '快捷命令执行失败').then(function (result) {
          setBusy(false)
          const raw = text(result.stdout).replace(/\s+$/, '')
          const shown = raw.length > 400 ? '…' + raw.slice(raw.length - 400) : raw
          setOkNote('$ ' + command + '\n' + (shown.length > 0 ? shown : '（没有输出）'))
          bump()
        }, function (failure) {
          setBusy(false)
          const said = commandDetail(failure.reply)
          setError('$ ' + command + '\n' + (said.length > 0 ? said : failureText(failure)))
          bump()
        })
      }

      const tool = function (key, label, title, onClick, options) {
        const opts = options == null ? {} : options
        const classes = ['dsh-git-tool']
        if (opts.danger === true) classes.push('dsh-git-danger')
        if (opts.on === true) classes.push('dsh-git-tool-on')
        /* 运行中的键（同步组专用，见 syncGroup）：字符转起来、title 说一声、按钮
           自身禁用防重复点击 —— 只锁自己，旁边的键照常可点。转的是包字符的 span
           而不是按钮：transform 对按钮的文字节点不生效，inline-block 的 span 才
           吃得到（CSS 里补，BranchIcon 是 svg 天生就吃）。 */
        const running = opts.running === true
        if (running) classes.push('dsh-git-tool-run')
        /* 图标键的 -ico 变体不再由这里出：拣选/还原/标签/分支搬进右键菜单后，这条
           工具条上只剩带字（或带字符图形）的键 —— 26px 方块的画法只属于差异头部。 */
        const parts = [running ? h('span', { key: 'l', className: 'dsh-git-spin' }, label) : label]
        if (typeof opts.badge === 'number' && opts.badge > 0) {
          parts.push(h('span', { key: 'b', className: 'dsh-git-tool-badge' }, String(opts.badge)))
        }
        return h('button', {
          key: key, type: 'button', className: classes.join(' '),
          disabled: opts.disabled === true,
          title: running ? title + '（运行中…）' : title,
          onClick: onClick,
        }, parts)
      }

      /* Syncing is a repository-level act, so it belongs in the panel header
         beside the branch it acts on — not in the commit graph's own toolbar,
         which is about the selected commit. The middle toolbar keeps only what
         the selection scopes. */
      /* 四个键的禁用只看「自己是不是在跑」，不再看面板级 busy：一个键转圈时，其余
         三个照常可点（点了进 panelBox.syncs 排队），提交框、右键菜单、快捷命令也
         全程照常 —— busy 不再为这四个动作抬起来。 */
      const syncRunningKey = function (key) { return syncRunning[key] === true }
      const syncGroup = h('div', { className: 'dsh-git-sync' },
        tool('refresh', '⟳', '重新读取仓库（忽略缓存）', function () { runSync('refresh', refresh) },
          { disabled: !repoOk || syncRunningKey('refresh'), running: syncRunningKey('refresh') }),
        tool('fetch', '⇣', 'fetch：从所有远端取回最新引用', function () { runSync('fetch', function () { return runOp('git/fetch', null, 'fetch') }) },
          { disabled: !repoOk || syncRunningKey('fetch'), running: syncRunningKey('fetch') }),
        tool('pull', '↓', 'pull：拉取并合入当前分支', function () { runSync('pull', function () { return runOp('git/pull', null, 'pull') }) },
          { disabled: !repoOk || syncRunningKey('pull'), running: syncRunningKey('pull'), badge: behind }),
        /* 两段式：↑ 先开推送确认框（openPushConfirm 的 promise 在弹窗收起时才落定，
            runSync 链因此把 ↑ 的转圈与再点保护跨满整个弹窗生命期）。detached 时
            没有分支名可确认，预览也无从谈起 —— 照旧直接推，git 自己的原话
            （You are not currently on a branch）上错误条，行为一字不变。 */
        tool('push', '↑', 'push：推送当前分支（先弹确认框列出要推的提交）', function () {
          runSync('push', function () {
            if (currentName.length === 0) return runOp('git/push', null, 'push')
            return openPushConfirm(currentName, '', null, '')
          })
        },
          { disabled: !repoOk || syncRunningKey('push'), running: syncRunningKey('push'), badge: ahead }))

      const branchTitle = (currentName.length > 0 ? currentName : 'HEAD')
        + (ahead > 0 ? ' · 领先 ' + String(ahead) : '')
        + (behind > 0 ? ' · 落后 ' + String(behind) : '')
      /* The branch chip is the switcher's handle: the name is already the thing
         the eye goes to, so making it the button saves a trip to the sidebar for
         the most frequent branch operation there is. */
      const branchChip = h('button', {
        key: 'chip', type: 'button',
        className: 'dsh-git-branch-chip' + (switcher === 'panel' ? ' dsh-git-branch-chip-on' : ''),
        title: switching !== null ? '正在切到 ' + switching + '…' : branchTitle + ' · 点击切换分支',
        onClick: function () { setSwitchMode(switcher === 'panel' ? null : 'panel') },
      },
        h(BranchIcon, { key: 'i', size: 13, spin: switching !== null }),
        h('span', { key: 'n', className: 'dsh-git-branch-name' }, currentName.length > 0 ? currentName : 'HEAD'),
        ahead > 0 ? h('span', { key: 'a', className: 'dsh-git-ab' }, '↑' + String(ahead)) : null,
        behind > 0 ? h('span', { key: 'b', className: 'dsh-git-ab' }, '↓' + String(behind)) : null)

      /* Inside the header, which spans the panel: the card then starts at the
         panel's left margin however many rows the header wraps to, and there is
         no measured offset to keep in sync. */
      const switchCard = switcher === 'panel'
        ? h('div', {
            key: 'sw', className: 'dsh-git-switch dsh-git-switch-panel',
            /* The same mark the hover card carries. Without it the card counts as
               "the panel behind the switcher", so pressing a branch row dismissed
               the card on pointerdown and the click never reached the row. */
            ref: function (node) { switcherNode = node },
          },
            h(BranchPicker, {
              sessionId: sessionId,
              repo: appliedRepo,
              mode: 'panel',
              dirty: status != null && status.ok === true
                ? status.staged.length + status.unstaged.length + status.untracked.length + status.unmerged.length
                : 0,
              onDone: function () { setSwitchMode(null) },
              onClose: function () { setSwitchMode(null) },
            }))
        : null

      /* The log toolbar follows IDEA's: the commit actions stay where they were,
         then one search box, then every filter as an inline "name: value"
         trigger that clears itself. No bordered select boxes and no second row,
         so the graph keeps the height that row used to cost. */
      const lfCaret = h('span', { key: 'c', className: 'dsh-git-lf-caret' }, h(Icon, { name: 'down', size: 10 }))
      /* A native select is as wide as its WIDEST option, not the value it is
         showing: with the arrow suppressed that left "作者：mays" floating in a
         112px box with the caret and the × parked at the far end. Sizing the
         control to the label it currently displays keeps the three together.
         cap 是每条控件自己的上限：作者/时间还是 132；分支范围单独放宽到 300 ——
         分支名动辄二十几个字符，132px 只装得下一个省略号，而原生下拉弹层的宽度
         跟着 select 走，弹层里一样读不全。 */
      const labelWidth = function (label, cap) {
        let w = 0
        for (let i = 0; i < label.length; i += 1) w += label.charCodeAt(i) > 0x2e80 ? 11.5 : 6.3
        /* +6 of slack: a select that is a hair too narrow clips its own text, and
           a clipped branch name is worse than six spare pixels. */
        return Math.min(cap != null ? cap : 132, Math.max(16, Math.round(w) + 6))
      }
      const lfWidth = function (label, cap) { return { width: String(labelWidth(label, cap)) + 'px' } }
      const lfClear = function (key, name, onClear) {
        return h('button', {
          key: key, type: 'button', className: 'dsh-git-lf-x', title: '清除' + name + '筛选',
          onClick: function (event) {
            stopEvent(event)
            /* The trigger is a <label> around a <select>: without preventDefault
               the click would also fall through and open the dropdown we are
               clearing. */
            if (event != null && typeof event.preventDefault === 'function') event.preventDefault()
            onClear()
          },
        }, '×')
      }

      const searchBox = h('div', {
        key: 'search', className: 'dsh-git-logsearch',
        title: '按提交信息筛选（字面量匹配），回车生效',
      },
        h('span', { key: 'i', className: 'dsh-git-logsearch-ico' }, h(Icon, { name: 'search', size: 13 })),
        h('input', {
          key: 'q', className: 'dsh-git-logsearch-input',
          placeholder: '搜索提交信息…',
          value: searchDraft,
          onChange: function (event) { setSearchDraft(event.target.value) },
          onKeyDown: function (event) { if (event.key === 'Enter') setSearch(searchDraft.trim()) },
        }),
        /* Shown as soon as there is anything to clear, applied or not: the box
           holds the draft, so an un-applied query is still one click from gone. */
        searchDraft.length > 0 || search.length > 0 ? h('button', {
          key: 'x', type: 'button', className: 'dsh-git-logsearch-x', title: '清空搜索',
          onClick: function () { setSearchDraft(''); setSearch('') },
        }, '×') : null)

      let branchLabel = branchOptions[0].label
      let branchFull = branchOptions[0].title
      for (let i = 0; i < branchOptions.length; i += 1) {
        if (branchOptions[i].value === branchValue) {
          branchLabel = branchOptions[i].label
          branchFull = branchOptions[i].title
          break
        }
      }
      const branchScoped = allRefs || activeRef.length > 0
      const branchFilter = h('label', {
        key: 'f:branch', className: 'dsh-git-lf dsh-git-lf-on', title: '分支范围：历史只显示这个分支能到达的提交',
      },
        h('span', { key: 'k', className: 'dsh-git-lf-k' }, '分支：'),
        h('select', {
          key: 's', className: 'dsh-git-lf-select',
          /* 分支范围单独放宽（见 labelWidth 的 cap）：作者/时间仍是 132。关着时长名
             以省略号收尾（CSS 的 text-overflow:ellipsis），悬停这里能看到完整名。 */
          style: lfWidth(branchLabel, 300), value: branchValue,
          title: branchFull != null && branchFull.length > 0 ? branchFull : '当前分支',
          onChange: function (event) {
            const next = event.target.value
            setSelectedKey(null)
            if (next === '@all') { setAllRefs(true); setActiveRef('') }
            else if (next === '@current') { setAllRefs(false); setActiveRef('') }
            else { setAllRefs(false); setActiveRef(next) }
          },
        }, branchOptions.map(function (option) {
          return h('option', { key: option.value, value: option.value, title: option.title }, option.label)
        })),
        lfCaret,
        /* × returns the graph to its default scope — the current branch — rather
           than to "everything": that is the view the panel opens with. */
        branchScoped ? lfClear('x', '分支', function () {
          setSelectedKey(null); setAllRefs(false); setActiveRef('')
        }) : null)

      const authorOn = author.length > 0
      const authorFilter = h('label', {
        key: 'f:author', className: 'dsh-git-lf' + (authorOn ? ' dsh-git-lf-on' : ''), title: '作者',
      },
        authorOn ? h('span', { key: 'k', className: 'dsh-git-lf-k' }, '作者：') : null,
        h('select', {
          key: 's', className: 'dsh-git-lf-select', value: author,
          style: lfWidth(authorLabels[author] !== undefined ? authorLabels[author] : '作者'),
          onChange: function (event) { setAuthor(event.target.value) },
        }, authorOptions),
        lfCaret,
        authorOn ? lfClear('x', '作者', function () { setAuthor('') }) : null)

      let dateLabel = '时间'
      for (let i = 0; i < DATE_PRESETS.length; i += 1) {
        if (DATE_PRESETS[i].id === datePreset) dateLabel = DATE_PRESETS[i].id === 'all' ? '时间' : DATE_PRESETS[i].label
      }
      const dateOn = datePreset !== 'all'
      const dateFilter = h('label', {
        key: 'f:date', className: 'dsh-git-lf' + (dateOn ? ' dsh-git-lf-on' : ''), title: '时间范围',
      },
        dateOn ? h('span', { key: 'k', className: 'dsh-git-lf-k' }, '时间：') : null,
        h('select', {
          key: 's', className: 'dsh-git-lf-select', value: datePreset,
          style: lfWidth(dateLabel),
          onChange: function (event) { setDatePreset(event.target.value) },
        }, DATE_PRESETS.map(function (preset) {
          /* Unset reads as the field's own name, the way IDEA's toolbar does. */
          return h('option', { key: preset.id, value: preset.id }, preset.id === 'all' ? '时间' : preset.label)
        })),
        lfCaret,
        dateOn ? lfClear('x', '时间', function () { setDatePreset('all') }) : null)

      const pathOn = pathDraft.length > 0 || pathFilter.length > 0
      const pathFilterNode = h('label', {
        key: 'f:path', className: 'dsh-git-lf' + (pathOn ? ' dsh-git-lf-on' : ''), title: '只看某个路径的历史，回车生效',
      },
        pathOn ? h('span', { key: 'k', className: 'dsh-git-lf-k' }, '路径：') : null,
        h('input', {
          key: 'i', className: 'dsh-git-lf-input',
          /* Grows with what is typed, so a draft never scrolls inside 44px. */
          style: { width: String(Math.min(110, Math.max(pathOn ? 40 : 46, 24 + pathDraft.length * 6))) + 'px' },
          placeholder: pathOn ? '' : '路径',
          value: pathDraft,
          onChange: function (event) { setPathDraft(event.target.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter') setPathFilter(pathDraft.trim())
            if (event.key === 'Escape') { setPathDraft(''); setPathFilter('') }
          },
        }),
        pathOn ? lfClear('x', '路径', function () { setPathDraft(''); setPathFilter('') }) : null)

      /* IDEA's arrangement of this strip: what you filter with on the left,
         what you do with the result on the right. */
      const toolbar = h('div', { className: 'dsh-git-tools' },
        searchBox,
        h('button', {
          key: 're', type: 'button', className: 'dsh-git-lf-flag' + (regexSearch === true ? ' dsh-git-lf-on' : ''),
          title: '正则表达式：把搜索词按正则解释（默认按字面匹配）',
          onClick: function () { setRegexSearch(regexSearch !== true) },
        }, '.*'),
        h('button', {
          key: 'cs', type: 'button', className: 'dsh-git-lf-flag' + (caseSensitive === true ? ' dsh-git-lf-on' : ''),
          title: '区分大小写（默认忽略大小写）',
          onClick: function () { setCaseSensitive(caseSensitive !== true) },
        }, 'Cc'),
        branchFilter,
        authorFilter,
        dateFilter,
        pathFilterNode,
        filterCount >= 2 ? h('button', {
          key: 'clear', type: 'button', className: 'dsh-git-lclear', title: '清除全部筛选',
          onClick: function () { resetFilters() },
        }, '全部清除') : null,
        h('span', { key: 'grow', className: 'dsh-git-grow' }),
        h('span', { key: 'sep', className: 'dsh-git-tsep' }),
        /* 拣选/还原/标签/分支那四个「作用于选中提交」的图标键不在这里了：它们搬进了
           提交行的右键菜单（对右键那条生效，见 ContextMenu），分支的复制/新建/删除
           也住进了分支行的右键菜单 —— 工具条只留过滤器和右边这个开菜单的按钮。 */
        h('span', { key: 'acts', className: 'dsh-git-acts' },
          h('button', {
            key: 'quick', type: 'button',
            className: 'dsh-git-acts-btn' + (menuOpen === 'quick' ? ' dsh-git-acts-btn-on' : ''),
            title: '快捷命令：一键执行自定义的命令模板（变量按当前分支和选中的提交代值）',
            disabled: !repoOk,
            ref: function (node) { quickBox.node = node },
            onClick: function (event) {
              stopEvent(event)
              setMenuOpen(menuOpen === 'quick' ? null : 'quick')
            },
          }, '⚡'),
          menuOpen === 'quick'
            ? h(QuickCommandsMenu, {
                key: 'q', open: true,
                onClose: function () { setMenuOpen(null) },
                trigger: quickBox,
                commands: quickCommands, ctx: quickCtx,
                onPick: function (one) { setMenuOpen(null); setQcConfirm(one) },
                onCreate: function () { setMenuOpen(null); setQcEditor('new') },
                onManage: function () { setMenuOpen(null); setQcEditor('list') },
              })
            : null),
        /* Pinned to the right end of the strip, and short: the room it reserves
           is room the filters cannot use, and "200 条" says as much as
           "200 条匹配" once the filters above it are visible. */
        h('span', {
          key: 'count', className: 'dsh-git-count dsh-git-dim',
          title: String(commitCount) + (hasFilter ? ' 条匹配当前筛选' : ' 条提交'),
        }, String(commitCount)))

      /* 内联输入行：打标签 / 从提交新建分支（提交行右键）、以某分支为起点新建分支 /
         重命名分支（分支行右键）共用这一行。Enter 确认、Esc 取消。 */
      const promptRow = prompt === null ? null
        : h('div', { className: 'dsh-git-prompt' },
        h('span', { key: 'l', className: 'dsh-git-hint' },
          prompt.kind === 'tag' ? '标签名'
            : prompt.kind === 'branch-rename' ? '新名字'
            : (prompt.kind === 'branch-at' ? '新分支名（起点 ' + text(prompt.at) + '）' : '新分支名')),
        clearable('i', h('input', {
          key: 'i', className: 'dsh-git-input', autoFocus: true, value: prompt.value,
          placeholder: prompt.kind === 'tag' ? '例如 v1.0.0' : '例如 feature/login',
          /* 这几种 prompt 身上带着动作要用的格子（起点分支 / 旧名 / 仓库）：输入与
             清空只能换 value，其余字段一个都不能丢 —— 旧写法整包换掉（只留 kind），
             在只有 kind+value 的年代无所谓，branch-at / branch-rename 进来后就会
             把起点和旧名忘在第一次按键里。 */
          onChange: function (event) { setPrompt(Object.assign({}, prompt, { value: event.target.value })) },
          onKeyDown: function (event) {
            if (event.key === 'Enter') submitPrompt()
            if (event.key === 'Escape') setPrompt(null)
          },
        }), prompt.value.length > 0, function () { setPrompt(Object.assign({}, prompt, { value: '' })) }),
        h('button', {
          key: 'ok', type: 'button', className: 'dsh-git-btn dsh-git-primary',
          disabled: prompt.value.trim().length === 0, onClick: submitPrompt,
        }, prompt.kind === 'branch-rename' ? '重命名' : '创建'),
        h('button', {
          key: 'no', type: 'button', className: 'dsh-git-btn',
          onClick: function () { setPrompt(null) },
        }, '取消'))

      const SEQ_LABELS = { 'cherry-pick': '拣选', 'revert': '还原', 'merge': '合并', 'rebase': '变基' }
      const seqLabel = SEQ_LABELS[sequencer] !== undefined ? SEQ_LABELS[sequencer] : sequencer
      const doAbort = function () {
        setArmed('')
        runOp('git/sequence', { op: sequencer, action: 'abort' })
      }
      const banner = sequencer.length === 0 ? null : h('div', { className: 'dsh-git-banner' },
        h('span', { key: 't', className: 'dsh-git-banner-text' },
          '正在' + seqLabel + '：' + (conflicts > 0 ? String(conflicts) + ' 个文件冲突' : '等待提交')),
        tool('seq-cont', sequencer === 'merge' ? '提交合并' : '继续',
          sequencer === 'merge' ? '冲突解决并暂存后提交这次合并' : '冲突解决并暂存后继续',
          function () { runOp('git/sequence', { op: sequencer, action: 'continue' }) },
          { disabled: busy }),
        sequencer === 'merge' ? null : tool('seq-skip', '跳过', '跳过这个提交',
          function () { runOp('git/sequence', { op: sequencer, action: 'skip' }) },
          { disabled: busy }),
        armed === 'abort'
          ? tool('seq-abort', '确认中止', '放弃本次' + seqLabel + '，回到操作前的状态', doAbort, { disabled: busy, danger: true })
          : tool('seq-abort', '中止', '放弃本次' + seqLabel,
              function () { setArmed('abort') }, { disabled: busy }))

      /* 「推送并设为上游」的横幅。远端不取 refs.remote[0]：ctxPush 的同一条规则
         （guessPushRemote）—— origin 优先 → 仓库唯一远端 → 都不满足就不渲染自动推
         的按钮，横幅还在（「忽略」），话换成 ctxPush 那句：替读者挑一个远端并 -u
         绑上去，赌错的成本是上游指向一个他没想过的远端，出路是右键「修改跟踪分支…」
         自己指定（选择层按远端分组，多远端都能挑）。 */
      const upstreamBanner = needsUpstream === true && refs != null && refs.ok === true
        && Array.isArray(refs.remote) && refs.remote.length > 0
      const upstreamGuess = upstreamBanner ? guessPushRemote(refs) : ''
      const upstreamHint = upstreamBanner !== true ? null : h('div', { className: 'dsh-git-prompt' },
        h('span', { key: 'l', className: 'dsh-git-hint' },
          upstreamGuess.length > 0
            ? '这个分支还没有上游'
            : '该分支没有上游，仓库有多个远端 —— 请先用分支行右键「修改跟踪分支…」指定远端'),
        upstreamGuess.length > 0 ? h('button', {
          key: 'u', type: 'button', className: 'dsh-git-btn dsh-git-primary', disabled: busy,
          title: 'git push -u ' + upstreamGuess + ' ' + currentName + '（先弹确认框，点「推送」才真推）',
          onClick: function () {
            /* 两段式：远端在这里挑好带进确认框，框里点「推送」才发（pushConfirmRun
               发的命令与这行 title 一字不差）。横幅先留着 —— 确认成功关框时
               setNeedsUpstream 还立着的话横幅还在，读者可以「忽略」掉它。 */
            openPushConfirm(currentName, '', { remote: upstreamGuess, branch: currentName }, '')
          },
        }, '推送并设为上游（' + upstreamGuess + '）') : null,
        h('button', { key: 'n', type: 'button', className: 'dsh-git-btn', onClick: function () { setNeedsUpstream(false) } }, '忽略'))

      const shownRef = allRefs ? '' : (activeRef.length > 0 ? activeRef : (graph != null && graph.ok === true ? text(graph.ref) : ''))
      const effectiveSelection = selectedKey !== null ? selectedKey : shownRef

      /* ── the view switch lives in the header ──

         IDEA keeps this switch in the tool window's own toolbar, and that is
         where it belongs: it changes how the pane below is read. On a row of its
         own above the list it was a full line of the panel's height spent on two
         words, so it rides here instead — and only while the changes tab is the
         one on screen, because on the history it would toggle nothing. */
      const changesView = prefs.changesView === 'flat' ? 'flat' : 'tree'
      const viewButton = function (id, name, hint) {
        return h('button', {
          key: id,
          type: 'button',
          className: 'dsh-git-cview' + (changesView === id ? ' dsh-git-cview-on' : ''),
          title: hint,
          onClick: function () { saveSettings(Object.assign({}, prefs, { changesView: id })) },
        }, name)
      }
      const viewSwitch = needsSetup || tab !== 'changes' ? null : h('span', {
        key: 'views', className: 'dsh-git-cviews',
      },
        viewButton('tree', '树', '文件树视图：按目录折叠'),
        viewButton('flat', '扁平', '扁平文件视图：每个文件一行，名字在前、目录压暗，按路径排序'))

      const header = h('div', { className: 'dsh-git-top' },
        h('span', { className: 'dsh-git-title' }, 'Git'),
        needsSetup
          ? h('span', { className: 'dsh-git-hint' }, '未检测到仓库')
          : h('div', { className: 'dsh-git-tabs' },
              /* The count on 变更 is what makes the changed files findable at
                 all: the panel opens on the history, and a tab that only says
                 "变更" gives no sign that anything is waiting behind it. */
              h('button', { type: 'button', className: 'dsh-git-tab' + (tab === 'changes' ? ' dsh-git-tab-on' : ''),
                title: changeSel.length > 0
                  ? String(changesBadge) + ' 个未提交改动（' + String(changeSel.length) + ' 个仓库的合计，点开逐仓库看）'
                  : (changesBadge > 0
                    ? String(changesBadge) + ' 个文件有未提交的改动，点开可以逐个看差异'
                    : '未提交的改动'),
                onClick: function () { setTab('changes'); setDiffTarget(null); setMergeTarget(null) } },
                '变更',
                changesBadge > 0 ? h('span', { key: 'n', className: 'dsh-git-tool-badge' }, String(changesBadge)) : null),
              h('button', { type: 'button', className: 'dsh-git-tab' + (tab === 'log' ? ' dsh-git-tab-on' : ''),
                title: '提交历史', onClick: function () { setTab('log'); setDiffTarget(null); setMergeTarget(null) } }, '历史'),
              /* 命令页不带数字角标：会话记录里有多少条 git 命令，这个数既不稳定也
                 不指导任何操作，放在页签上只是噪音；数量在读进来之后说在页面里。 */
              h('button', { type: 'button', className: 'dsh-git-tab' + (tab === 'cmdlog' ? ' dsh-git-tab-on' : ''),
                title: '这个项目执行过的 git 命令（来自 DSH 会话记录）',
                onClick: function () { setTab('cmdlog'); setDiffTarget(null); setMergeTarget(null) } }, '命令'),
              /* 配置页分两档：项目配置只关于眼前这个仓库（只写 --local 的提交身份、
                 git 自己的两个换行键、远端清单），全局配置（79-globalconfig.js）管
                 插件与这台机器 —— 原先 DSH 设置面板里的那一页搬到了这里。 */
              h('button', { type: 'button', className: 'dsh-git-tab' + (tab === 'config' ? ' dsh-git-tab-on' : ''),
                title: '项目配置与全局配置：项目管眼前这个仓库（会话完成后自动刷新/推送、提交身份、换行符与远端），全局管插件与这台机器（初始化分支、远程同步、快捷命令、git 位置、提交身份、本浏览器外观）',
                onClick: function () { setTab('config'); setDiffTarget(null); setMergeTarget(null) } }, '配置')),
        needsSetup ? null : syncGroup,
        needsSetup ? null : branchChip,
        h('span', { key: 'grow', className: 'dsh-git-grow' }),
        viewSwitch,
        switchCard)

      /* What the diff on screen was read from. The file's own state as the last
         workspace read reported it, so staging it (from here or from the tree)
         re-reads the patch instead of leaving the old one up, plus the counter
         the refresh button bumps. */
      let diffSig = String(diffAt)
      if (diffTarget !== null && diffTarget.kind === 'file' && status != null && status.ok === true) {
        for (let i = 0; i < changes.length; i += 1) {
          if (changes[i].path === diffTarget.path) {
            diffSig += '|' + (changes[i].staged === true ? 'S' : '-') + text(changes[i].indexCode) + text(changes[i].workCode)
            break
          }
        }
      }

      let body
      /* 多选分组里点开的差异属于**那个**仓库的文件：diff 请求和它的暂存都带着仓库
         走；单仓库的 target 没有这一格，照旧落在生效仓库上。 */
      const diffRepo = diffTarget !== null && text(diffTarget.repo).length > 0 ? text(diffTarget.repo) : appliedRepo
      if (work == null) {
        body = h('div', { className: 'dsh-git-pane dsh-git-dim' }, '正在读取仓库…')
      } else if (needsSetup) {
        /* 说明页下面挂同一份仓库清单：工作区本身不是仓库时，这份清单恰恰是出路 ——
           里面嵌着的仓库点一下就打开（单击 = 切生效仓库，与左栏那条同一手势）。 */
        body = h('div', { key: 'setupwrap', className: 'dsh-git-setupwrap' },
          h(RepoSetup, {
            key: 'setup:' + appliedRepo + '|' + text(work.repo),
          sessionId: sessionId,
          initial: text(work.repo),
          reason: text(work.reason),
          /* git's own stderr only adds information when git itself misbehaved.
             For "no repository here" the explanation above already says it, and
             the raw fatal: line would just be noise. */
          stderr: text(work.reason) === 'git-error' ? text(work.stderr).slice(0, 400) : '',
          onOpen: function (next) {
            applyRepo(next)
            loadWork(next)
          },
        }),
        h('div', { key: 'setup-repos', className: 'dsh-git-setup-repos' }, h(RepoSwitcher, repoPropsFor('log'))))
      } else if (mergeTarget !== null) {
        /* 三方合并冲突界面占正文（和 diff 同一个下钻形状）。应用成功走既有刷新路：
           ⟳ 级整树重读（冲突组的消失、提交区警告的撤下都由它带出来），成功条说一句
           人话 —— 注意顺序：refresh() 自己会清 okNote，所以先刷新再记。 */
        body = h(MergeView, {
          key: 'merge',
          target: mergeTarget,
          sessionId: sessionId,
          onBack: function () { setMergeTarget(null) },
          onApplied: function (reply) {
            setMergeTarget(null)
            refresh()
            setOkNote('已解决 ' + mergeTarget.path + ' 的冲突并标记已解决'
              + (reply != null && reply.repo != null ? '（' + text(reply.repo) + '）' : ''))
          },
          /* ⚙ 的落点：面板自己的「配置」页。DSH 全局设置面板没有受支持的编程打开
             入口（59-merge.js 顶部说明过），面板内能到的设置类页面就是这一页。 */
          onSettings: function () { setMergeTarget(null); setTab('config') },
        })
      } else if (diffTarget !== null) {
        /* The diff takes the body, whichever list opened it, and the way back is
           the arrow in its own header — a drill-down rather than a third pane,
           because a pane narrow enough to fit beside two other columns is not
           wide enough to read a patch in. */
        /* ── 右列的数据：这个补丁是从哪个列表点开的，那个列表就跟过来 ──

           提交那一路直接用当前 detail 的文件（没有多仓库问题：一次提交属于它自己
           的仓库）；变更那一路是工作区快照 —— 多选分组里点开的文件属于**它自己
           那个**仓库，右列得是那个仓库的变更（全局那份读数，10-state.js 的
           treeRecord），拿屏上生效仓库的列表凑数会把两个仓库的路径混在一列。 */
        let diffRail = null
        /* railChanges 提升到这一层：下面「打开的差异跟着这一行现在的样子走」要在
           kind === 'file' 且 diffRepo !== appliedRepo 时去这一份读数里找那行现在的
           样子，而它只在变更那一路才有值 —— 声明留在 if/else 的哪一半里，这一层就
           够不着（半个代理的旧稿在这里留过一个 ReferenceError，多仓库分组点开的
           diff 一渲染就炸）。提交那一路它保持 changes 原值，没人读它。 */
        let railChanges = changes
        /* 右列也带 listKind / rev / repo（61-filemenu.js 的菜单在右列行的挂点上要
           用 —— rev 是「这棵文件树所属的提交」，range 那路取 selSpan.head 而不是
           base..head 表达式：菜单的从修订中获取 / 与本地比较都要单个 hash）。 */
        if (diffTarget.kind === 'commit') {
          if (detail != null && detail.ok === true && Array.isArray(detail.files) && detail.files.length > 0) {
            diffRail = { kind: 'commit', files: detail.files, listKind: 'commit', rev: text(detail.hash), repo: '' }
          }
        } else if (diffTarget.kind === 'range') {
          /* 选区视图点开的差异：右列是同一份合计清单（selectionSpan 的读，key 在
             眼前才算数）—— 退路也是它，与单提交那一路同一个形状。 */
          const rangeRail = rangeRead != null && rangeRead.key === selSpanKey ? rangeRead.reply : null
          if (rangeRail != null && rangeRail.ok === true && Array.isArray(rangeRail.files) && rangeRail.files.length > 0) {
            diffRail = { kind: 'commit', files: rangeRail.files, listKind: 'range', rev: selSpan != null ? text(selSpan.head) : '', repo: '' }
          }
        } else if (diffTarget.kind === 'local') {
          /* 「与本地比较」（文件右键菜单开的新 diff）：右列还是它的来处那棵文件树
             —— 提交详情在场用提交的，选区读在场用选区的。换文件走 diffRailOpen
             的 local 分支，kind 与 ref 不丢。 */
          if (detail != null && detail.ok === true && Array.isArray(detail.files) && detail.files.length > 0) {
            diffRail = { kind: 'commit', files: detail.files, listKind: 'commit', rev: text(detail.hash), repo: '' }
          } else {
            const rangeRail = rangeRead != null && rangeRead.key === selSpanKey ? rangeRead.reply : null
            if (rangeRail != null && rangeRail.ok === true && Array.isArray(rangeRail.files) && rangeRail.files.length > 0) {
              diffRail = { kind: 'commit', files: rangeRail.files, listKind: 'range', rev: selSpan != null ? text(selSpan.head) : '', repo: '' }
            }
          }
        } else {
          if (diffRepo !== appliedRepo) {
            const record = treeRecord(diffRepo)
            railChanges = record != null && record.status != null && record.status.ok === true
              ? mergeChanges(record.status) : []
          }
          diffRail = { kind: 'changes', changes: railChanges, listKind: 'worktree', rev: '', repo: diffRepo }
        }
        /* ── 打开的差异跟着这一行现在的样子走 ──

           diffTarget 记的是点开那一刻那一行的快照；可头部那只勾选框（55-diff.js 的
           stageToggle）和「暂存」按钮要回答的是「此刻这条路径的改动在不在索引里」，
           而勾一下、乐观补丁与确认读先后改掉 status 里的这一行 —— 拿点开时的旧
           快照画，框就勾了不亮、亮了不灭。这里不写 state（渲染途中不许 set）：
           从同一份变更读数里把这一行现在的样子合出一枚新 target 交给 DiffView，
           补丁的分节（diffRequests 吃 target.staged）因此也跟着对；diffTarget
           本身原样留着 —— 右列导航、返回键要的还是「当初点开的那一行」。
           多选分组里点开的文件属于它自己的仓库，找这一行得去那一仓的读数
           （railChanges）里找，生效仓库的 changes 里没有它。找不到（未跟踪目录
           展开后点开的文件、文件已被提交或还原掉）就照旧用旧快照 —— 和今天
           一字不差。 */
        let diffTargetNow = diffTarget
        if (diffTarget.kind === 'file') {
          const source = diffRepo !== appliedRepo ? railChanges : changes
          for (let i = 0; i < source.length; i += 1) {
            if (source[i].path === diffTarget.path) {
              diffTargetNow = changeDiffTarget(source[i], text(diffTarget.repo))
              break
            }
          }
        }
        /* 右列换文件：提交那一路 ref 不动、只换 path/from/status（和提交详情里
           点开一个文件是同一条路，diffSig 随 shape 变化自动重读补丁）；选区那一路
           同理，ref 钉在 base..head 上；与本地比较那一路 ref 钉在提交上（换一个
           文件继续比本地）；变更那一路走 changeDiffTarget，仓库跟着文件原来的
           那一格走。 */
        const diffRailOpen = diffRail === null ? undefined : function (file) {
          if (diffTarget.kind === 'commit') {
            setDiffTarget({
              kind: 'commit',
              path: text(file.path),
              from: text(file.from),
              ref: text(diffTarget.ref),
              status: text(file.status),
            })
            return
          }
          if (diffTarget.kind === 'range') {
            setDiffTarget({
              kind: 'range',
              path: text(file.path),
              from: text(file.from),
              ref: text(diffTarget.ref),
              status: text(file.status),
            })
            return
          }
          if (diffTarget.kind === 'local') {
            setDiffTarget({
              kind: 'local',
              path: text(file.path),
              from: '',
              ref: text(diffTarget.ref),
              status: text(file.status),
            })
            return
          }
          setDiffTarget(changeDiffTarget(file, text(diffTarget.repo)))
        }
        body = h(DiffView, {
          key: 'diff',
          target: diffTargetNow,
          repo: diffRepo,
          /* 「查看文件」的路径根：diff 有自己的仓库（多仓库分组里点开的）就用它，
             没有才落生效仓库 —— 后者兜住「还没应用过任何路径、appliedRepo 还是空」
             的首屏，work.repo 是 Host 解出来的仓库绝对路径。viewFileButton 拿它拼
             绝对路径再对照会话工作区。 */
          repoRoot: diffRepo.length > 0 ? diffRepo : effectiveRepo,
          sessionId: sessionId,
          sig: diffSig,
          busy: busy,
          rail: diffRail,
          onOpenFile: diffRailOpen,
          onFileContext: openFileMenu,
          collapsed: collapsed,
          onToggle: toggle,
          onBack: function () { setDiffTarget(null) },
          onRefresh: function () { setDiffAt(diffAt + 1) },
          onStage: diffTarget.kind === 'file'
            ? function (staged) { setStaged([{ path: diffTarget.path }], staged, diffRepo) }
            : undefined,
        })
      } else if (tab === 'changes') {
        body = h(ChangesPane, {
          work: status,
          collapsed: collapsed,
          busy: busy,
          message: message,
          selectedKey: selectedKey,
          onToggle: toggle,
          onSelect: function (key) { setSelectedKey(key) },
          onSetStaged: setStaged,
          onSetStagedAll: setStagedAll,
          /* 提交信息的变化都从 changeMessage 走（含 clearable 的清空）：上屏之外
             还要排一次防抖的草稿保存 —— 见上面草稿那一块。 */
          onMessage: changeMessage,
          onCommit: commit,
          /* 默认变更列表工具条的还原/暂存：与 onSetStaged 同一套「单仓库不带仓库、多仓库
             带仓库」的接法（见 makeScope 的转发）。 */
          onRevert: revertPicked,
          onStash: stashPicked,
          /* 多仓库：侧栏、分组、按仓库落下去的四个回调。分组为 null 时（单选/没多选）
             变更树与今天完全一样 —— 分组、键名、勾选手势一字不差。 */
          repoProps: repoPropsFor('changes'),
          /* 工作树块（25-worktree.js）：数据复用面板级 worktrees/refs 读数 —— 那
             两条 effect 的依赖是 [appliedRepo, repoOk, freshAt, props.ready]，不分
             tab，变更页白拿，不为此多发一次读数。这里的行点击不是过滤历史而是
             「切生效仓库」：走 repoSingle —— 多选时先收拢回单仓库再切到那个工作
             区，变更列表跟着新仓库重读；点的就是当前生效工作区时 repoSingle 原地
             返回，无副作用。只给 onPickWorktree、不给 onPickBranch/activeRef/repo，
             WorktreeBox 自己退回按路径高亮的仓库模式（25-worktree.js 顶部注释）。 */
          worktreeProps: {
            data: worktrees,
            refs: refs,
            effective: effectiveRepo,
            onPickWorktree: function (path) { repoSingle('changes', path) },
          },
          groups: changeGroups,
          onRepoSingle: function (path) { repoSingle('changes', path) },
          onSetStagedAt: function (repo, files, staged) { setStaged(files, staged, repo) },
          onRevertAt: function (repo, files) { revertPicked(files, repo) },
          onStashAt: function (repo, files) { stashPicked(files, repo) },
          onToggleUntrackedAt: function (repo, dir) { toggleUntracked(dir, repo) },
          onOpenDiffAt: function (repo, file) { setDiffTarget(changeDiffTarget(file, repo)) },
          /* 冲突行：点开的是三方合并界面（59-merge.js），不是 diff —— 双码红色那批
             行的活儿是「做选择」，普通补丁给不了。仓库跟着行走（多仓库分组里点开的
             冲突属于它自己那个仓库），单仓库的调用不带仓库 = 生效仓库。 */
          onOpenConflictAt: function (repo, file) {
            setMergeTarget({ repo: text(repo), path: text(file.path), code: text(file.workCode) })
          },
          /* 文件右键菜单（61-filemenu.js）：仓库跟着行走 —— 菜单里的还原/删除/
             显示历史都要落在这一行自己那个仓库上，与 onOpenDiffAt 同一条规矩。
             target 由行那一侧拼好（repo 为空 = 组仓库由这里盖章）。 */
          onFileContextAt: function (repo, target, event) {
            openFileMenu(Object.assign({}, target, { repo: text(repo) }), event)
          },
          /* One click on a file row, in either list, is what opens the patch —
             selecting a row in IDEA's commit window and getting its diff on the
             right is the same gesture, and a row that only highlights leaves the
             reader with no way to the text at all. */
          onOpenDiff: function (file) { setDiffTarget(changeDiffTarget(file)) },
          /* 单仓库那份的冲突行点击（54-changes.js 的 scope 转发）；与 onOpenDiff 的
             关系同上 —— 这一条只服务「冲突组」的行，别的行不会走到它。 */
          onOpenConflict: function (file) {
            setMergeTarget({ repo: '', path: text(file.path), code: text(file.workCode) })
          },
          untrackedOpen: untrackedOpen,
          untrackedFiles: untrackedFiles,
          onToggleUntracked: toggleUntracked,
        })
      } else if (tab === 'cmdlog') {
        /* 只读页：列表是上面那条后台路攒下的读数。点「重新读取」也是同一条路：
           不清列表、不置 loading，读完增量合并 —— 和弹窗打开、bump 一个待遇。 */
        body = h(CommandLogPane, {
          log: cmdLog,
          onReload: function () { readCmdLog(freshAt, cmdLogBox.opens) },
        })
      } else if (tab === 'config') {
        /* 远端表一变就当作仓库动过一次：分支树的「远程」分组、顶栏 ↑ 的数都从
           refs 来（Host 那边 panelMutate 已失效读缓存），bump 走 ⟳ 同一条读路
           把它们刷新。 */
        body = h(GitConfigPane, {
          sessionId: sessionId, sessionAware: props.sessionAware === true,
          /* 多仓库：项目档页首的「仓库」组吃的就是侧栏这份清单，默认编辑目标 =
             生效仓库 —— 都从这里递进去，配置页自己不再解一遍。 */
          repoList: repoList, effective: effectiveRepo,
          onChanged: function () { bump() },
        })
      } else {
        /* ── 右栏（CommitDetail）的窄屏折叠：三种形态，宽屏只有第三种 ──
           折叠（窄屏默认）：CommitDetail 整个不渲染，右缘一条竖向展开条
             dsh-git-detailbar（竖排「提交详情 ▸」，已选中提交附文件数），点了展开；
           窄屏展开：详情栏照旧渲染，顶上加一条收起键 dsh-git-detailfold —— 与折叠
             条是同一只开关（detailOpen）的两副面孔；外面包一层 dsh-git-detailwrap
             纵排，CommitDetail 本体与 .dsh-git-detail 一个字没动（52-detail.js 没
             改），group-title 的文字原样；
           宽屏（含量不到宽度的替身）：detailNode 原样直挂 —— .dsh-git-body 的
             className、子节点与改动前逐字节一致（ref 不进渲染结果），这是不变量。 */
        const detailCollapsed = detailOpen === null ? narrowBody.narrow : detailOpen === false
        /* ── 选区视图：多选连续时详情栏换成「n 条提交合并视图」 ──

           rangeRead 只认眼前的段（key 比对，见 selSpanKey 的注释）；不连续的多选
           维持单提交详情，顶部给一条置灰入口说清为什么点不动。 */
        const rangeNow = rangeRead != null && rangeRead.key === selSpanKey ? rangeRead.reply : null
        const rangeActive = selSpan != null && selSpan.contiguous === true && selSpan.base.length > 0
        const rangeBlocked = selSpan != null && selSpan.contiguous !== true
        const detailNode = rangeActive === true
          ? h(RangeDetail, {
              span: selSpan,
              reply: rangeNow,
              collapsed: collapsed,
              selectedKey: selectedKey,
              onToggle: toggle,
              onSelect: function (key) { setSelectedKey(key) },
              baseShort: hashShort(selSpan.base),
              headShort: hashShort(selSpan.head),
              rangeLabel: '（' + hashShort(selSpan.base) + '..' + hashShort(selSpan.head) + ' 的合计）',
              onOpenDiff: function (file) {
                setDiffTarget({
                  kind: 'range',
                  path: text(file.path),
                  from: text(file.from),
                  ref: selSpanKey,
                  status: text(file.status),
                })
              },
              /* 文件右键菜单（61-filemenu.js 的 target 由 52-detail.js 拼好）。 */
              onFileContext: openFileMenu,
              onExit: function () { setMultiSel([]) },
            })
          : h(CommitDetail, {
              detail: detail, collapsed: collapsed, selectedKey: selectedKey,
              onToggle: toggle, onSelect: function (key) { setSelectedKey(key) },
              /* A file in a commit is the commit's own read: same path, but the
                 two states are that commit and its first parent. */
              onOpenDiff: function (file) {
                setDiffTarget({
                  kind: 'commit',
                  path: text(file.path),
                  from: text(file.from),
                  ref: detail != null ? text(detail.hash) : '',
                  status: text(file.status),
                })
              },
              /* 文件右键菜单：target 的 rev 是 detail.hash（52-detail.js 拼好）。 */
              onFileContext: openFileMenu,
            })
        /* 不连续多选的置灰入口：解释为什么不能合并查看（选区不连续）。 */
        const rangeAside = rangeBlocked === true
          ? h('div', {
              className: 'dsh-git-rangeblock',
              title: '选区不连续，不能合并查看：中间隔着未选中的提交，base..head 的合计改动会把它们也算进来',
            }, '已选中 ' + String(selSpan.targets.length) + ' 条提交 —— 选区不连续，不能合并查看（Ctrl+点击把中间的行补上，或逐条移出）')
          : null
        const detailSide = narrowBody.narrow === true
          ? h('div', { className: 'dsh-git-detailwrap' },
            h('div', {
              className: 'dsh-git-detailfold',
              title: '收起提交详情（收起后从右缘那条「提交详情」展开条再展开）',
              onClick: function () { setDetailOpen(false) },
            },
              h('span', { className: 'dsh-git-detailfold-label' }, '提交详情'),
              h('span', { className: 'dsh-git-detailfold-glyph' }, '▾')),
            rangeAside,
            detailNode)
          : (rangeAside !== null ? [rangeAside, detailNode] : detailNode)
        /* 折叠态的那一条：已选中提交时附文件数，空态/错态只写「提交详情」——
           空着还报数是噪音。 */
        const detailBar = h('div', {
          className: 'dsh-git-detailbar',
          title: '展开提交详情（提交的文件列表与信息收在这里）',
          onClick: function () { setDetailOpen(true) },
        },
          h('span', { className: 'dsh-git-detailbar-label' }, '提交详情'),
          h('span', { className: 'dsh-git-detailbar-glyph' }, '▸'),
          detail != null && detail.ok === true && detail.files.length > 0
            ? h('span', { className: 'dsh-git-detailbar-count' }, String(detail.files.length) + ' 个文件')
            : null)
        body = h('div', { className: 'dsh-git-body', ref: narrowBody.attach },
          h('div', { className: 'dsh-git-left' },
            h(RefTree, {
              refs: refs, collapsed: collapsed, selectedKey: effectiveSelection,
              headName: currentName,
              /* The changes that are not committed yet, shown on the branch they
                 would be committed to. Zero until the working-tree read lands,
                 which is why the badge appears a moment after the tree. */
              dirty: status != null && status.ok === true
                ? status.staged.length + status.unstaged.length + status.untracked.length + status.unmerged.length
                : 0,
              onToggle: toggle, onSelect: function (key) { setSelectedKey(key) },
              activeRef: shownRef,
              /* 多仓库：仓库列表区（HEAD 分组上方）与多选时的按仓库分组。groups 为
                 null 时这棵树和今天是同一棵 —— 同一函数、空前缀。 */
              repoProps: repoPropsFor('log'),
              /* 工作树块（25-worktree.js）：数据永远跟生效仓库（上面那条 effect 的
                 依赖就是 appliedRepo + freshAt）。refs 递分支树同一份 —— 徽章按分支
                 名免费查，不为块单独读数；activeRef 与分支树的 scope 高亮同一个值，
                 两边的「选中」因此说的是同一个分支。repo 是 pickBranch 的仓库参数：
                 单仓库历史传 ''（今天的主路，只 setActiveRef）；多选分组里传生效
                 仓库，让 pickBranch「先 applyRepo 再 setActiveRef」那支跑 —— 单击
                 即收拢回单仓库并按该分支过滤历史。 */
              worktreeProps: {
                data: worktrees,
                refs: refs,
                effective: effectiveRepo,
                activeRef: shownRef,
                repo: logSel.length > 0 ? effectiveRepo : '',
                onPickBranch: pickBranch,
              },
              groups: logSel.length > 0 ? logSel.map(function (repo) {
                return { repo: repo, refs: repoRefs[repo] === undefined ? null : repoRefs[repo] }
              }) : null,
              onRepoSingle: function (path) { repoSingle('log', path) },
              onPickBranch: pickBranch,
              onBranchContext: openBranchMenu,
            })),
          h('div', { className: 'dsh-git-main' },
            toolbar,
            promptRow,
            upstreamHint,
            h(CommitList, {
              graph: graph,
              selected: selected,
              multi: multiSel,
              onPick: pickCommit,
              onContext: openCommitMenu,
              /* Functional, not `maxCount + PAGE_COMMITS`: two clicks before the
                 next render would otherwise both read the same old value and lose
                 a page. */
              onLoadMore: function () { setMaxCount(function (n) { return n + PAGE_COMMITS }) },
            })),
          detailCollapsed === true ? detailBar : detailSide)
      }

      const popProps = {
        className: 'dsh-git-pop' + (props.active === true ? '' : ' dsh-git-hidden')
          + (switcher === 'panel' ? ' dsh-git-pop-overflow' : ''),
        ref: function (node) { panelNode = node; nodeBox.node = node },
      }
      if (props.floated === true) {
        /* ── 跳出主对话：视口坐标定位（16-portal.js 的 body 级浮层）──

           老几何原句照搬，只是包含块从输入区槽位换成了视口大小的浮层：底边钉在
           锚点（输入框卡片）上沿之上 8px（= bottom:100% + margin-bottom:8px）、
           水平贴着锚点居中（= translateX(-50%)）。宽度不再受主对话约束 ——
           better-sidebar 把主对话压窄也压不到面板：拖过的记忆宽度优先（钳进视口），
           没拖过 = 锚点宽 - 16（老 left:8/right:8 的自然宽），下限 GIT_FLOAT_MIN_W。
           两端一律收进视口 8px；不写 transform（右键菜单那套「面板带 transform 时
           坐标换算」就不用走）。 */
        const probeNow = props.anchorBox != null ? props.anchorBox.node : null
        const measureFrom = probeNow != null ? probeNow : nodeBox.node
        const view = gitFloatViewportOf(measureFrom)
        const box = panelAnchorBox(measureFrom)
        const vw = view != null ? view.vw : NaN
        const vh = view != null ? view.vh : NaN
        const anchorTop = box != null && isFinite(parseFloat(box.top)) ? parseFloat(box.top) : NaN
        const anchorLeft = box != null && isFinite(parseFloat(box.left)) ? parseFloat(box.left) : NaN
        const anchorW = box != null && isFinite(parseFloat(box.width)) ? parseFloat(box.width) : NaN
        let w = size.w > 0
          ? size.w
          : (isFinite(anchorW) ? Math.max(anchorW - 16, GIT_FLOAT_MIN_W) : GIT_FLOAT_MIN_W)
        if (isFinite(vw)) w = Math.min(w, Math.max(vw - 16, 280))
        let left = NaN
        if (isFinite(vw)) {
          if (isFinite(anchorLeft) && isFinite(anchorW)) {
            left = anchorLeft + (anchorW - w) / 2
            if (left + w > vw - 8) left = vw - 8 - w
            if (left < 8) left = 8
          } else {
            left = (vw - w) / 2
          }
        }
        const bottom = isFinite(vh)
          ? (isFinite(anchorTop) ? Math.max(0, vh - anchorTop + PANEL_ANCHOR_GAP) : 8)
          : NaN
        const floatStyle = { right: 'auto', margin: '0px' }
        if (isFinite(w)) floatStyle.width = String(Math.round(w)) + 'px'
        if (isFinite(left)) floatStyle.left = String(Math.round(left)) + 'px'
        if (isFinite(bottom)) floatStyle.bottom = String(Math.round(bottom)) + 'px'
        popProps.style = floatStyle
      } else if (size.w > 0) {
        popProps.style = { width: size.w + 'px', left: '50%', right: 'auto', transform: 'translateX(-50%)' }
      }
      /* 高度：记忆的 size.h（没有就是默认 74vh）是「期望」，实际渲染时再被「锚点
         上沿之上的可见空间」钳一道 —— 只改这一个 style，size / panelSize 的记忆语义
         完全不动，空间恢复后自然回到期望值（拖拽记下的期望高度也照此被钳制但不丢）。
         没量到锚点（anchor 为 null）时一行都不写，维持原样。
         可见空间的上界不是视口上沿（0），是真实上界 ceiling（14-geometry.js 的
         clipCeiling）：面板长在会话滚动体里面，超出滚动体上沿的部分永远滚不回来。
         hero 相位输入框垂直居中、锚点上沿在屏幕中段，旧算法会把面板顶推到视口顶
         附近，正好整条头部落在滚动体上沿之上被裁 —— ceiling 就是量给它的。 */
      const sizeH = parseFloat(size.h)
      const wantH = sizeH > 0 ? sizeH
        : (anchor != null && parseFloat(anchor.vh) > 0 ? Math.round(parseFloat(anchor.vh) * PANEL_DEFAULT_VH) : 0)
      const ceilingH = anchor != null && anchor.ceiling != null && isFinite(parseFloat(anchor.ceiling))
        ? parseFloat(anchor.ceiling)
        : 0
      const availH = anchor != null && isFinite(anchor.top)
        ? Math.floor(parseFloat(anchor.top) - PANEL_ANCHOR_GAP - PANEL_ANCHOR_SAFETY - ceilingH)
        : 0
      let panelH = 0
      /* 记忆过高度就照旧写 inline（哪怕空间够，也维持和从前一样的渲染路径）；没记忆
         时只有默认 74vh 真的放不下才写 —— 平时仍交给 CSS，跟随窗口。 */
      if (wantH > 0 && (sizeH > 0 || availH < wantH)) {
        panelH = wantH
        if (availH > 0 && availH < panelH) panelH = availH
        if (panelH < PANEL_MIN_HEIGHT) panelH = PANEL_MIN_HEIGHT
        popProps.style = Object.assign({}, popProps.style, { height: panelH + 'px' })
      }

      /* ── 右键菜单的两份内容与它的坐标 ──

         坐标：position:fixed 写的是视口坐标，但面板根节点在宽度记忆过时带着
         translateX(-50%) 的 transform —— 带 transform 的祖先会成了 fixed 后代的
         包含块，那时坐标得换成「相对面板」的那一套，否则菜单错位一个面板左上角。
         量得到（getComputedStyle 在）就换，量不到（测试、无布局环境）原样用视口
         坐标。内容：提交菜单四项的禁用条件与原四个图标键一致（!canAct 置灰），动作
         目标是右键那一条（ctxMenu.hash，与单选此时恰好是同一个）；分支菜单按远程/
         本地收放，删除走两段式确认（ctxArm/ctxForce，见 ctxBranchRemove）。 */
      const ctxMenuPos = function () {
        const x = ctxMenu.x
        const y = ctxMenu.y
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
      /* ── 提交行右键菜单的内容 ──

         目标集（PhpStorm：动作作用于 selection）：右键行在多选里且多选>1 时，
         拣选/还原/合并提交/批量删除作用于整份选区（按图序、执行时最旧→最新）；
         其余项（打标签/新建分支/编辑消息/复制）永远对右键那一条。
         改写类三项（编辑消息/合并提交/批量删除）的置灰与原因话术都读菜单体检
         （ctxMenu.check）：已推送到远端（改写要强推）、不在当前分支历史上、根
         提交、体检没回 —— 各说各的原因；多选时话术把「这 n 条」说进。 */
      const ctxMenuTargets = ctxMenu === null || ctxMenu.kind !== 'commit'
        ? [] : ctxTargetHashes(ctxMenu.hash, multiSel)
      const ctxMany = ctxMenuTargets.length > 1
      const ctxSaid = ctxMany === true ? '这 ' + String(ctxMenuTargets.length) + ' 条' : '这个提交'
      /* 菜单体检的几格里找右键那条（编辑消息永远只改右键那一条）。 */
      const ctxSelfCheck = ctxMenu === null || ctxMenu.check == null || ctxMenu.check.ok !== true
        || !Array.isArray(ctxMenu.check.checks)
        ? null
        : ctxMenu.check.checks.find(function (one) { return one != null && one.hash === ctxMenu.hash }) || null
      /* 编辑消息的不可编辑原因（IDEA 同款话术，一条一条说清楚）。两个 why 在每次
         渲染都算一遍（不挑菜单种类），而 check 这个字段只有提交行菜单才有 ——
         分支行菜单上是 undefined。所以「还没体检」的判定要用 == null：null 是
         提交行菜单「体检没回」的占位，undefined 是分支行菜单「根本没有体检」；
         两种都走「正在检查」的置灰话术（分支行菜单不用这三项，话术不会被看见，
         但读它的时候不能炸）。 */
      const ctxRewordWhy = (function () {
        if (canAct !== true) return '当前有操作在跑，等它结束'
        if (ctxMenu === null || ctxMenu.check == null) return '正在检查这个提交能不能改写…'
        if (ctxMenu.check.ok !== true) return '检查没通过：' + (text(ctxMenu.check.stderr).length > 0 ? text(ctxMenu.check.stderr) : '读不到仓库状态')
        if (ctxSelfCheck === null) return '检查没通过：没拿到这个提交的体检结果'
        if (ctxSelfCheck.reachable !== true) return '不在当前分支历史上，改写它不会生效'
        if (ctxSelfCheck.isRoot === true) return '根提交暂不支持改写消息'
        if (ctxSelfCheck.pushed === true) return '已推送到远端，改写要强推'
        return ''
      })()
      /* 整段改写（合并提交/批量删除）的可用条件与原因：目标集 ≥2 且连续、最新
         一条就是当前 HEAD、选区未推送、最旧一条有父提交（squash/drop 的区间起点）。 */
      const ctxSelWhy = (function () {
        if (canAct !== true) return '当前有操作在跑，等它结束'
        if (selSpan === null || selSpan.targets.length < 2) return '先按住 Ctrl/Shift 选中连续的提交（至少 2 条），再右键其中一条'
        if (selSpan.contiguous !== true) return '选区不连续（中间隔着别的提交）—— 只有连成一条链的提交才能整段' + (ctxMany === true ? '' : '')
        if (selSpan.base.length === 0) return '选区里最旧一条是根提交，它之前没有提交了，整段无从谈起'
        if (ctxMenu === null || ctxMenu.check == null) return '正在检查这个提交能不能改写…'
        if (ctxMenu.check.ok !== true) return '检查没通过：' + (text(ctxMenu.check.stderr).length > 0 ? text(ctxMenu.check.stderr) : '读不到仓库状态')
        /* 答复形状也要守：ok 为真但没有 checks 清单（应答被裁过、旧宿主）与「没拿到
           结果」同罪 —— 不能拿 undefined 去 find。 */
        if (Array.isArray(ctxMenu.check.checks) !== true) return '检查没通过：没拿到选区最新一条的体检结果'
        const headCheck = ctxMenu.check.checks.find(function (one) { return one != null && one.hash === selSpan.head })
        if (headCheck === undefined || headCheck === null) return '检查没通过：没拿到选区最新一条的体检结果'
        if (headCheck.isHead !== true) return '最新选中的要就是当前 HEAD（整段改写从它往前生效）'
        for (let i = 0; i < ctxMenu.check.checks.length; i += 1) {
          const one = ctxMenu.check.checks[i]
          if (one != null && one.pushed === true && selSpan.targets.indexOf(one.hash) >= 0) {
            return '选区里有已推送到远端的提交，改写要强推'
          }
        }
        return ''
      })()
      const ctxCommitItems = ctxMenu === null ? [] : ctxMenu.kind === 'commit' ? [
        h('button', {
          key: 'pick', type: 'button', className: 'dsh-git-menu-item', disabled: !canAct,
          title: '拣选：cherry-pick，把' + ctxSaid + '依次应用到当前分支（最旧的先落）',
          onClick: function (event) {
            stopEvent(event)
            setCtxMenu(null)
            runOp('git/sequence', {
              op: 'cherry-pick', action: 'start',
              /* 执行顺序最旧→最新：图序（新→旧）反过来交出去。 */
              targets: ctxMenuTargets.slice().reverse(),
              record: plugin.cherryPickRecord === true,
            })
          },
        }, '拣选' + (ctxMany === true ? '（' + String(ctxMenuTargets.length) + ' 条）' : '')),
        h('button', {
          key: 'revert', type: 'button', className: 'dsh-git-menu-item', disabled: !canAct,
          title: '还原：revert，为' + ctxSaid + '各生成一个反向提交来撤销（最旧的先落）',
          onClick: function (event) {
            stopEvent(event)
            setCtxMenu(null)
            runOp('git/sequence', {
              op: 'revert', action: 'start',
              targets: ctxMenuTargets.slice().reverse(),
            })
          },
        }, '还原' + (ctxMany === true ? '（' + String(ctxMenuTargets.length) + ' 条）' : '')),
        h('button', {
          key: 'tag', type: 'button', className: 'dsh-git-menu-item', disabled: !canAct,
          title: '标签：在这个提交上打标签',
          onClick: function (event) {
            stopEvent(event)
            setCtxMenu(null)
            setArmed('')
            setPrompt({ kind: 'tag', value: '' })
          },
        }, '打标签…'),
        h('button', {
          key: 'branch', type: 'button', className: 'dsh-git-menu-item', disabled: !canAct,
          title: '分支：从这个提交新建分支并切过去',
          onClick: function (event) {
            stopEvent(event)
            setCtxMenu(null)
            setArmed('')
            setPrompt({ kind: 'branch', value: '' })
          },
        }, '从这个提交新建分支…'),
        h('div', { key: 'sep-rewrite', className: 'dsh-git-menu-sep' }),
        h('button', {
          key: 'reword', type: 'button', className: 'dsh-git-menu-item',
          disabled: !canAct || ctxRewordWhy.length > 0,
          title: ctxRewordWhy.length > 0
            ? '编辑提交消息：' + ctxRewordWhy
            : '编辑提交消息：改写这个提交的完整消息（未推送的提交才安全 —— 改写会换掉它和它之后所有提交的 hash）',
          onClick: function (event) {
            stopEvent(event)
            openReword(ctxMenu.hash)
          },
        }, '编辑提交消息…'),
        h('button', {
          key: 'squash', type: 'button', className: 'dsh-git-menu-item',
          disabled: !canAct || ctxSelWhy.length > 0,
          title: ctxSelWhy.length > 0
            ? '合并提交：' + ctxSelWhy
            : '合并提交：把选中的 ' + String(selSpan.targets.length) + ' 条连续提交压成一条（改动合计，消息可编辑）',
          onClick: function (event) {
            stopEvent(event)
            openSelRewrite('squash', selSpan, ctxMenu.check != null && ctxMenu.check.ok === true ? text(ctxMenu.check.head) : '')
          },
        }, '合并提交…'),
        h('button', {
          key: 'drop', type: 'button', className: 'dsh-git-menu-item dsh-git-menu-danger',
          disabled: !canAct || ctxSelWhy.length > 0,
          title: ctxSelWhy.length > 0
            ? '批量删除提交：' + ctxSelWhy
            : '批量删除提交：把选中的 ' + String(selSpan.targets.length) + ' 条连续提交连同它们的改动一并丢弃（reflog 里还能找一段时间）',
          onClick: function (event) {
            stopEvent(event)
            openSelRewrite('drop', selSpan, ctxMenu.check != null && ctxMenu.check.ok === true ? text(ctxMenu.check.head) : '')
          },
        }, '批量删除提交…'),
        h('div', { key: 'sep-copy', className: 'dsh-git-menu-sep' }),
        h('button', {
          key: 'copyhash', type: 'button', className: 'dsh-git-menu-item',
          title: '把完整 hash 写进剪贴板',
          onClick: function (event) {
            stopEvent(event)
            setCtxMenu(null)
            copyTextToClipboard(ctxMenu.hash, function () {
              setOkNote('已复制完整 hash ' + hashShort(ctxMenu.hash))
            }, function () {
              setOkNote('无法写入剪贴板，请手动复制完整 hash：' + ctxMenu.hash)
            })
          },
        }, '复制 Hash'),
      ] : [
        /* ── 分支行右键菜单（PhpStorm 的分栏顺序：动作在上，元信息居中，破坏性在下）──

           本地（含 HEAD 组的行）：签出 → 新建分支… → 推送 → 重命名分支… → 分隔线 →
           复制分支名称 → 修改跟踪分支… → 分隔线 → 删除分支。远程行只有签出与复制 ——
           远程分支没有「跟踪谁 / 重命名」这些本地才有的事；它的「签出」是 DWIM 的
           显式形（git/checkout 的 asNewLocal）：建同名本地分支并建立跟踪。签出的
           置灰认 ctxMenu.head（这一行是不是它所在仓库的当前分支 —— 多选分组里
           生效仓库的 currentName 认不得别的仓库的当前分支）。 */
        ctxMenu.remote === true
          ? h('button', {
              key: 'checkout', type: 'button', className: 'dsh-git-menu-item',
              title: 'git switch -c <本地名> --track ' + ctxMenu.name
                + ' —— 建同名本地分支（去掉远端前缀）并跟踪它',
              disabled: busy === true,
              onClick: function (event) {
                stopEvent(event)
                setCtxMenu(null)
                ctxCheckoutRemote(ctxMenu.name, ctxMenu.repo)
              },
            }, '签出（检出为本地分支）')
          : h('button', {
              key: 'checkout', type: 'button', className: 'dsh-git-menu-item',
              title: ctxMenu.head === true
                ? '已经在这个分支上'
                : 'git switch ' + ctxMenu.name + '：切到这个分支，工作区跟着变',
              disabled: ctxMenu.head === true || busy === true,
              onClick: function (event) {
                stopEvent(event)
                setCtxMenu(null)
                ctxCheckout(ctxMenu.name, ctxMenu.repo)
              },
            }, '签出'),
        ctxMenu.remote === true ? null : h('button', {
          key: 'newat', type: 'button', className: 'dsh-git-menu-item',
          title: '以 ' + ctxMenu.name + ' 为起点新建分支并切过去',
          disabled: busy === true,
          onClick: function (event) {
            stopEvent(event)
            setCtxMenu(null)
            setPrompt({ kind: 'branch-at', value: '', at: ctxMenu.name, repo: ctxMenu.repo })
          },
        }, '新建分支…'),
        ctxMenu.remote === true ? null : h('button', {
          key: 'push', type: 'button', className: 'dsh-git-menu-item',
          title: 'git push -u <远端> ' + ctxMenu.name
            + '：有上游按上游的远端推；没有上游绑 origin（或唯一远端）推'
            + ' —— 先弹确认框列出要推的提交，点「推送」才真推',
          disabled: busy === true,
          onClick: function (event) {
            stopEvent(event)
            setCtxMenu(null)
            ctxPush(ctxMenu.name, ctxMenu.repo)
          },
        }, '推送'),
        ctxMenu.remote === true ? null : h('button', {
          key: 'rename', type: 'button', className: 'dsh-git-menu-item',
          title: 'git branch -m ' + ctxMenu.name + ' <新名字>'
            + '（当前分支也能改名，git 会把 HEAD 一起改过去）',
          disabled: busy === true,
          onClick: function (event) {
            stopEvent(event)
            setCtxMenu(null)
            setPrompt({ kind: 'branch-rename', value: ctxMenu.name, name: ctxMenu.name, repo: ctxMenu.repo })
          },
        }, '重命名分支…'),
        h('div', { key: 'sep1', className: 'dsh-git-menu-sep' }),
        h('button', {
          key: 'copy', type: 'button', className: 'dsh-git-menu-item',
          title: '把 ' + ctxMenu.name + ' 写进剪贴板',
          onClick: function (event) {
            stopEvent(event)
            setCtxMenu(null)
            copyTextToClipboard(ctxMenu.name, function () {
              setOkNote('已复制分支名 ' + ctxMenu.name)
            }, function () {
              setOkNote('无法写入剪贴板，请手动复制分支名：' + ctxMenu.name)
            })
          },
        }, '复制分支名称'),
        /* 修改跟踪分支：只有本地分支（含 HEAD 组的行）有 —— 远程分支自己没有
           「跟踪谁」这件事。打开远端分支选择层，菜单先收起。 */
        ctxMenu.remote === true ? null : h('button', {
          key: 'upstream', type: 'button', className: 'dsh-git-menu-item',
          title: 'git branch --set-upstream-to=<远端>/<分支> ' + ctxMenu.name
            + '（当前分支不在检出状态也可以改）',
          disabled: busy === true,
          onClick: function (event) {
            stopEvent(event)
            setCtxMenu(null)
            setUpstreamPick({ name: ctxMenu.name, repo: ctxMenu.repo })
          },
        }, '修改跟踪分支…'),
        ctxMenu.remote === true ? null : h('div', { key: 'sep2', className: 'dsh-git-menu-sep' }),
        ctxMenu.remote === true ? null
          : ctxForce === ctxMenu.name
            ? h('button', {
                key: 'force', type: 'button',
                className: 'dsh-git-menu-item dsh-git-menu-danger',
                title: ctxArm === 'force:' + ctxMenu.name
                  ? 'git branch -D ' + ctxMenu.name + ' —— 没合并的提交会随分支丢弃'
                  : 'git branch -d 被拒：这些提交还没有合并到别处，只有 -D 能删',
                disabled: ctxBusy === true || busy === true,
                onClick: function (event) {
                  stopEvent(event)
                  if (ctxArm === 'force:' + ctxMenu.name) ctxBranchRemove(ctxMenu.name, true)
                  else setCtxArm('force:' + ctxMenu.name)
                },
              }, ctxArm === 'force:' + ctxMenu.name ? '确认强制删除 ' + ctxMenu.name : '强制删除（-D）')
            : ctxArm === ctxMenu.name
              ? h('button', {
                  key: 'del', type: 'button', className: 'dsh-git-menu-item dsh-git-menu-danger',
                  title: 'git branch -d ' + ctxMenu.name,
                  disabled: ctxBusy === true || busy === true,
                  onClick: function (event) { stopEvent(event); ctxBranchRemove(ctxMenu.name, false) },
                }, '确认删除 ' + ctxMenu.name)
              : h('button', {
                  key: 'del', type: 'button', className: 'dsh-git-menu-item',
                  title: ctxMenu.name === currentName
                    ? '当前所在的分支，git 不删除自己'
                    : 'git branch -d ' + ctxMenu.name + '（再点一次确认）',
                  disabled: ctxMenu.name === currentName || ctxBusy === true || busy === true,
                  onClick: function (event) { stopEvent(event); setCtxArm(ctxMenu.name); setCtxForce('') },
                }, '删除分支'),
      ]

      /* ── 文件右键菜单的内容（kind === 'file'）──

         菜单项由 61-filemenu.js 的 fileMenuItems 造，这里只递 acts：动作全部接到
         面板既有的通道（ctxRun / revertPicked / runOp / setDiffTarget / setTab），
         「打开源文件」用 55-diff.js 的 viewFileGuard 预检三道守卫 —— 按钮和菜单
         审的是同一套，答案不会分叉。两段式确认的武装在 ctxArm（键串带路径，见
         openFileMenu）。 */
      const ctxFileTarget = ctxMenu !== null && ctxMenu.kind === 'file' ? ctxMenu.target : null
      const ctxFileItems = ctxFileTarget === null ? [] : (function () {
        const repoNow = text(ctxFileTarget.repo).length > 0 ? text(ctxFileTarget.repo) : appliedRepo
        const list = Array.isArray(ctxFileTarget.paths) ? ctxFileTarget.paths : []
        const first = list.length > 0 ? list[0] : null
        const openGuard = first == null
          ? { ok: false, why: '这一行没有路径' }
          : viewFileGuard({ path: text(first.path) }, sessionId, repoNow)
        /* 显示历史记录的仓库核对：历史页只显示生效仓库的图 —— 多仓库分组里点了
           别的仓库的行，先把生效仓库切过去才有得看。 */
        const historyOk = text(ctxFileTarget.repo).length === 0 || text(ctxFileTarget.repo) === appliedRepo
        const cleanPaths = function () {
          const out = []
          for (let i = 0; i < list.length; i += 1) {
            const path = text(list[i].path).replace(/\/+$/, '')
            if (path.length > 0) out.push(path)
          }
          return out
        }
        return fileMenuItems(ctxFileTarget, {
          busy: busy === true,
          arm: ctxArm,
          setArm: setCtxArm,
          setCtxMenu: setCtxMenu,
          canOpenFile: openGuard.ok === true,
          openWhy: openGuard.why,
          historyOk: historyOk,
          historyWhy: '在左栏的仓库行上单击切到它',
          onCompareLocal: function (paths) {
            if (paths.length === 0 || text(ctxFileTarget.rev).length === 0) return
            setDiffTarget({
              kind: 'local',
              path: paths[0],
              from: '',
              ref: text(ctxFileTarget.rev),
              status: first != null && first.raw != null ? text(first.raw.status) : '',
            })
          },
          onOpenFile: function (paths) {
            if (paths.length === 0) return
            const again = viewFileGuard({ path: paths[0] }, sessionId, repoNow)
            if (again.ok !== true) { setError('打不开源文件：' + again.why); return }
            openDiffFile(sessionId, again.absolute)
          },
          onShowDiff: function (one) {
            const raw = one != null && one.raw != null ? one.raw : null
            if (ctxFileTarget.listKind === 'commit') {
              setDiffTarget({
                kind: 'commit',
                path: one != null ? text(one.path) : '',
                from: raw != null ? text(raw.from) : '',
                ref: detail != null ? text(detail.hash) : '',
                status: raw != null ? text(raw.status) : '',
              })
              return
            }
            if (ctxFileTarget.listKind === 'range') {
              setDiffTarget({
                kind: 'range',
                path: one != null ? text(one.path) : '',
                from: raw != null ? text(raw.from) : '',
                ref: selSpanKey,
                status: raw != null ? text(raw.status) : '',
              })
              return
            }
            /* worktree：既有 changeDiffTarget —— 目录行没有现成的 entry，按「目录
               pathspec 的未暂存聚合」拼一枚最小 entry（git diff -- 目录）。 */
            const entry = raw != null && (one == null || one.dir !== true)
              ? raw
              : { path: one != null ? text(one.path).replace(/\/+$/, '') : '',
                  staged: false, workCode: ' M', untracked: false, displayCode: '' }
            setDiffTarget(changeDiffTarget(entry, text(ctxFileTarget.repo)))
          },
          onRevert: function (paths) {
            if (ctxFileTarget.listKind === 'worktree') {
              revertPicked(paths.map(function (path) { return { path: path } }), text(ctxFileTarget.repo))
              return
            }
            ctxRun('git/revert-paths', { ref: text(ctxFileTarget.rev), paths: paths }, text(ctxFileTarget.repo),
              '还原所选更改失败', function () {
                setOkNote('已撤销 ' + hashShort(ctxFileTarget.rev) + ' 对 ' + String(paths.length) + ' 项的改动：'
                  + (paths.length === 1 ? paths[0] : String(paths.length) + ' 条路径')
                  + '（反向补丁应用到工作区和索引）')
              })
          },
          onCherryPick: function () {
            /* 合并视图 = 整份 multiSel（图序新→旧，反转为旧→新交给 git）；单提交
               文件树 = 右键那一条。与提交行右键菜单的拣选是同一条 runOp 路。 */
            const targets = ctxFileTarget.listKind === 'range' && multiSel.length > 1
              ? multiSel.slice().reverse()
              : [text(ctxFileTarget.rev)]
            runOp('git/sequence', {
              op: 'cherry-pick', action: 'start',
              targets: targets,
              record: plugin.cherryPickRecord === true,
            })
          },
          onClean: function (paths) {
            ctxRun('git/clean-paths', { paths: paths }, text(ctxFileTarget.repo), '删除所选更改失败', function () {
              setOkNote('已删除 ' + String(paths.length) + ' 项未跟踪的'
                + (paths.length === 1 && first != null && first.dir === true ? '目录（git clean -fd）' : '路径（git clean -fd）'))
            })
          },
          onGetFromRev: function (paths) {
            ctxRun('git/get-from-rev', { ref: text(ctxFileTarget.rev), paths: paths }, text(ctxFileTarget.repo),
              '从修订中获取失败', function () {
                setOkNote('已从 ' + hashShort(ctxFileTarget.rev) + ' 取回 ' + String(paths.length) + ' 项'
                  + '（覆盖工作区并放进索引）')
              })
          },
          onShowHistory: function (paths) {
            if (paths.length === 0) return
            setPathDraft(paths[0])
            setPathFilter(paths[0])
            setTab('log')
          },
        })
      })()
      const ctxPos = ctxMenu === null ? { left: 0, top: 0 } : ctxMenuPos()
      /* 选择层标题行里的「现在跟的是谁」：渲染期算一次，选择层开着时每帧都新鲜。 */
      const upPickNow = upstreamPick === null ? null : upstreamOfBranch(upstreamPick.name, upstreamPick.repo)

      return h('div', popProps,
        h('div', { key: 'gn', className: 'dsh-git-grip dsh-git-grip-n', title: '拖动调整高度', onPointerDown: startDrag('n') }),
        h('div', { key: 'gw', className: 'dsh-git-grip dsh-git-grip-w', title: '拖动调整宽度', onPointerDown: startDrag('w') }),
        h('div', { key: 'ge', className: 'dsh-git-grip dsh-git-grip-e', title: '拖动调整宽度', onPointerDown: startDrag('e') }),
        h('div', { key: 'gnw', className: 'dsh-git-grip dsh-git-grip-nw', title: '拖动调整宽高', onPointerDown: startDrag('nw') }),
        h('div', { key: 'gne', className: 'dsh-git-grip dsh-git-grip-ne', title: '拖动调整宽高', onPointerDown: startDrag('ne') }),
        header,
        banner,
        /* 成功条与 error 同一个提示位（一次只说一件事，下一次操作开始时一起清）。也
           pre-wrap：快捷命令的输出本来就是多行的。 */
        okNote.length > 0 ? h('div', { className: 'dsh-git-oknote', style: { padding: '4px 10px', whiteSpace: 'pre-wrap' } }, okNote) : null,
        /* pre-wrap：这条里出现换行的地方都是「那就是两条命令」，折成一行读起来是
           一句话里塞了两条命令。git 自己的多行原话也顺便能按原样读。 */
        error !== null ? h('div', { className: 'dsh-git-error', style: { padding: '4px 10px', whiteSpace: 'pre-wrap' } }, error) : null,
        body,
        /* 快捷命令的确认框与编辑器：面板内覆盖层（盖住正文、不盖掉面板本体），关掉即
           卸载 —— 它们自己的草稿不需要在关掉后还活着。 */
        qcConfirm !== null
          ? h('div', { key: 'qcc', className: 'dsh-git-qc-overlay' },
              h(QuickCommandConfirm, {
                key: 'c', def: qcConfirm, ctx: quickCtx,
                onExecute: runQuick,
                onClose: function () { setQcConfirm(null) },
              }))
          : null,
        qcEditor !== null
          ? h('div', { key: 'qce', className: 'dsh-git-qc-overlay' },
              h(QuickCommandsEditor, {
                key: qcEditor, initial: qcEditor,
                onClose: function () { setQcEditor(null) },
              }))
          : null,
        /* pull 的上游选择层（点 ↓ 时这个分支还没有 upstream、远端也没有同名分支）：
           同一个覆盖层形状，点外（点在底板上）与 Esc 都关；点行走 runOp 的
           setUpstream 路 —— 成功后 runOp 关层并写成功条，远端分支其实不在的失败
           （refs 过期）层照旧开着重挑。 */
        pullPick !== null
          ? h('div', {
              key: 'pullpick', className: 'dsh-git-qc-overlay',
              onClick: function (event) { if (event != null && event.target === event.currentTarget) setPullPick(null) },
            },
              h('div', { key: 'box', className: 'dsh-git-qc-box' },
                h('div', { key: 'h', className: 'dsh-git-qc-head' },
                  '「' + (currentName.length > 0 ? currentName : 'HEAD') + '」还没有上游 —— 选择要跟的远端分支（选中后绑定并拉取）'),
                h(RemotePickList, {
                  key: 'pick', sessionId: sessionId, repo: appliedRepo,
                  busy: busy === true,
                  onPick: function (match) { runOp('git/pull', { setUpstream: match }) },
                  onClose: function () { setPullPick(null) },
                })))
          : null,
        /* 「修改跟踪分支」的选择层：形状与 pull 的上游选择同款（点外/Esc 关，列表
           现读 git/refs、可搜索、点行即选中）。标题行下面一行说这个分支现在跟的是
           谁，右边是「取消跟踪」—— 读不到上游信息时不禁用，git 的原话会再挡一次。
           手输的兜底就是列表的搜索框：打字过滤、回车选高亮那一项，不用手拼完整
           远端名。 */
        upstreamPick !== null
          ? h('div', {
              key: 'upstreampick', className: 'dsh-git-qc-overlay',
              onClick: function (event) { if (event != null && event.target === event.currentTarget) setUpstreamPick(null) },
            },
              h('div', { key: 'box', className: 'dsh-git-qc-box' },
                h('div', { key: 'h', className: 'dsh-git-qc-head' },
                  '修改「' + upstreamPick.name + '」跟踪的远端分支 —— 点击列表中的一项设为它的上游'),
                h('div', { key: 'cur', className: 'dsh-git-qc-row' },
                  h('span', { key: 't', className: 'dsh-git-qc-hint' },
                    upPickNow === null ? '当前跟踪的上游：读取中…'
                      : (upPickNow.length > 0 ? '当前跟踪：' + upPickNow : '这个分支还没有跟踪任何上游')),
                  h('button', {
                    key: 'unset', type: 'button', className: 'dsh-git-btn',
                    title: 'git branch --unset-upstream ' + upstreamPick.name,
                    disabled: busy === true,
                    onClick: function () { ctxSetUpstream(upstreamPick.name, upstreamPick.repo, null) },
                  }, '取消跟踪')),
                h(RemotePickList, {
                  key: 'pick', sessionId: sessionId,
                  repo: text(upstreamPick.repo).length > 0 ? upstreamPick.repo : appliedRepo,
                  busy: busy === true,
                  pickTip: function (full) { return '把 ' + upstreamPick.name + ' 的上游设为 ' + full },
                  onPick: function (match) { ctxSetUpstream(upstreamPick.name, upstreamPick.repo, match) },
                  onClose: function () { setUpstreamPick(null) },
                })))
          : null,
        /* 远程签出遇本地同名分支的二选一层：与 pull 的上游选择同一块板子（qc-overlay
           盖住正文、不盖掉面板本体）。点外（点在底板上）由这里关，Esc 由框内的
           useOutsideDismiss 关；两个动作按钮发起即关层（setRemotePick 在 ctxRun 之前），
           失败时错误条在层底下直接可见，成功写成功条。 */
        remotePick !== null
          ? h('div', {
              key: 'remotepick', className: 'dsh-git-qc-overlay',
              onClick: function (event) { if (event != null && event.target === event.currentTarget) setRemotePick(null) },
            },
              h(RemoteExistsConfirm, {
                key: 'c', open: true, pick: remotePick, busy: busy === true,
                onLocal: function () { ctxCheckoutRemoteLocal(remotePick) },
                onReset: function () { ctxCheckoutRemoteReset(remotePick) },
                onClose: function () { setRemotePick(null) },
              }))
          : null,
        /* 推送确认弹窗（两段式推送的第一段）：同一块 qc-overlay 板子。点外（点在
            底板上）与 Esc 都关 —— 推送中两道都失效（onClose 里挡），推到一半没有
            「取消」可言；成功关框走 closePushConfirm，runSync 链在那一刻熄灯。 */
        pushConfirm !== null
          ? h('div', {
              key: 'pushconfirm', className: 'dsh-git-qc-overlay',
              onClick: function (event) {
                if (event != null && event.target === event.currentTarget && pushConfirm.running !== true) closePushConfirm()
              },
            },
              h(PushConfirmBox, {
                key: 'box', open: true, state: pushConfirm,
                box: pushBoxDom, boxRef: function (node) { pushBoxDom.node = node },
                guess: pushGuessRemote, guessNote: pushGuessNote,
                onPush: pushConfirmRun,
                onClose: function () {
                  if (pushConfirm.running === true) return
                  closePushConfirm()
                },
              }))
          : null,
        /* 「编辑提交消息…」的对话框（reword）与「合并提交… / 批量删除提交…」的确认框：
            同一块 qc-overlay 板子。点外与 Esc 都由框里自己的 useOutsideDismiss 关
            （reword 保存中两道都失效，框内挡）；确认/保存按钮发起即关（openReword /
            openSelRewrite 的对面那一头），失败错误条说在框内。 */
        rewordBox !== null
          ? h('div', { key: 'rewordbox', className: 'dsh-git-qc-overlay' },
              h(RewordMessageBox, {
                key: 'box', state: rewordBox,
                onMessage: function (value) {
                  setRewordBox(function (previous) { return Object.assign({}, previous, { message: value }) })
                },
                onSave: rewordSave,
                onClose: function () { setRewordBox(null) },
              }))
          : null,
        selRewrite !== null
          ? h('div', { key: 'selrewrite', className: 'dsh-git-qc-overlay' },
              h(SelRewriteBox, {
                key: 'box', state: selRewrite,
                onMessage: function (value) {
                  setSelRewrite(function (previous) { return Object.assign({}, previous, { message: value }) })
                },
                onConfirm: selRewriteRun,
                onClose: function () { setSelRewrite(null) },
              }))
          : null,
        /* 右键菜单：光标锚的浮层（position:fixed）。挂在面板根部 —— 与 ⚡ 的下拉
            不同它不属于任何一格，开关只随 ctxMenu。内容按种类二选一：提交行菜单
            （ctxCommitItems）与文件/目录行菜单（ctxFileItems，61-filemenu.js 造）。 */
        ctxMenu !== null
          ? h(ContextMenu, {
              key: 'ctx', open: true, x: ctxPos.left, y: ctxPos.top,
              onClose: function () { setCtxMenu(null) },
            }, ctxMenu.kind === 'file' ? ctxFileItems : ctxCommitItems)
          : null)
    }

