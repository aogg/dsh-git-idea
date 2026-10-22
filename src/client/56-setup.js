    const SETUP_REASONS = {
      'no-path': { title: '无法确定要查看的仓库路径', hint: '会话工作区未知，请在下面手动填写一个目录。' },
      'missing': { title: '目录不存在', hint: '填写的路径在当前文件系统上找不到。改成一个存在的目录。' },
      'file': { title: '这不是一个目录', hint: '该路径指向一个文件，而 Git 仓库必须是一个目录。' },
      /* 路径已经确定，只是这里没有仓库：没有要解释的规则，也没有要填的东西。
         不劝人换目录，也不让人把已经显示在上面的路径再抄一遍。 */
      'not-a-repo': { title: '这个目录不是 Git 仓库', hint: '', editable: false },
      /* 目录是对的，机器上少了东西：这个页面不能改路径，也不能初始化 —— 两件事
         都救不了这个状态，而 `git init` 只会再失败一次。留一个「打开这个目录」
         当作装好 git 之后的重试。 */
      'no-git': {
        title: '这台机器上找不到 git',
        hint: '上面这个目录本身是仓库，但面板读它、改它都要调用 git。'
          + '装上 git，或让它出现在 dsh 进程的 PATH 里，再点一次「打开这个目录」。',
        editable: false,
        init: false,
      },
      /* 仓库就在这个路径上，git 却拒读它：目录属主不是运行 dsh 的那个用户，
         safe.directory 保护挡在前面（fatal: detected dubious ownership）。
         面板读到时已经自动把路径写进过 global 配置并重试 —— 写成功就根本到不了
         这一页；写不进去（只读的会话/沙箱）才落到这里。所以这一页不许再说
         「不是 Git 仓库」：要给读者自己就能执行的完整命令。safe.directory 只认
         system/global 配置，-c 与仓库内配置 git 一律忽略，所以命令必须是 --global。
         路径每个仓库不同，hint 在 setupReason 里按当前路径补全。 */
      'unsafe-owner': {
        title: 'git 拒绝读取这个仓库（目录属主不同）',
        editable: false,
        init: false,
        hintFor: function (path) {
          return '目录属主与运行 dsh 的用户不同，git 出于保护拒绝读取；面板自动写入 '
            + 'safe.directory 没有成功（可能是只读的会话或沙箱）。可以在终端自己执行下面这句，'
            + '然后点「打开这个目录」重试：git config --global --add safe.directory ' + path
        },
      },
      'git-error': { title: 'git 命令执行失败', hint: '目录存在，但 git 没能读取它。下方是 git 的原话。' },
    }

    function setupReason(id, path) {
      const found = SETUP_REASONS[id]
      if (found === undefined) return { title: '这里还不是 Git 仓库', hint: '' }
      /* 只有 safe.directory 这一页的提示里带着仓库自己的路径，其余页都是静态的。 */
      if (found.hintFor !== undefined) return Object.assign({}, found, { hint: found.hintFor(path) })
      return found
    }

    /* ── 说明页里的「worktree 主目录」块（v1.2）──

       会话工作区是一个 worktree、而主仓库那头读不动（被删/搬走）时，说明页的 reason
       是 'not-a-repo'，那一页 editable:false —— 但这个目录恰恰**有**要配置的东西：
       把主目录的新位置告诉面板。这块不受 editable / init 开关管（用户点名的要求），
       挂载时对 initial 发一次 git/wt-main（Host 答身份与主目录候选），kind 是
       linked / broken-gitlink 才渲染；找到的主目录可以直接「打开这个目录」（与
       RepoSetup 的 onOpen 同一条路），主目录不合适就手填一个存进插件配置
       （git/wt-main-save），错误话术沿用 24-repos.js 的 repoSaveProblem。 */
    function WorktreeMainSetup(props) {
      const sessionId = props.sessionId
      const target = text(props.initial)
      const [snap, setSnap] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [problem, setProblem] = React.useState('')
      /* 挂载（或 initial 变了）发一次读。失败静默 null：说明页的主流程是「认路、
          开目录」，这块是补充身份说明，它自己读不出来不该变成一条新错误。 */
      React.useEffect(function () {
        if (target.length === 0) return undefined
        let alive = true
        const request = target.length > 0 ? { repo: target } : {}
        if (sessionId.length > 0) request.sessionId = sessionId
        callHost('git/wt-main', request).then(function (data) {
          if (alive !== true) return
          setSnap(data)
          /* 草稿预填 configured ?? auto mainDir：读者多数时候只需要改一两个字。 */
          const prefill = data != null && data.ok === true && text(data.mainDir).length > 0 ? text(data.mainDir) : ''
          setDraft(function (previous) { return previous.length > 0 ? previous : prefill })
        }, function () {
          if (alive === true) setSnap(null)
        })
        return function () { alive = false }
      }, [target, sessionId])

      const saveMain = function () {
        const dir = draft.trim()
        if (dir.length === 0 || busy === true) return
        setBusy(true)
        setNote('')
        setProblem('')
        const request = { repo: target, add: dir }
        if (sessionId.length > 0) request.sessionId = sessionId
        rpc('git/wt-main-save', request, '保存失败').then(function (reply) {
          setBusy(false)
          setSnap(reply)
          setNote('已配置主目录（手动配置）：' + text(reply.mainDir))
        }, function (failure) {
          setBusy(false)
          setProblem(repoSaveProblem(failure, dir))
        })
      }

      const clearMain = function () {
        if (busy === true) return
        setBusy(true)
        setNote('')
        setProblem('')
        const request = { repo: target, remove: true }
        if (sessionId.length > 0) request.sessionId = sessionId
        rpc('git/wt-main-save', request, '清除失败').then(function (reply) {
          setBusy(false)
          setSnap(reply)
          setNote('已清除配置：主目录回到自动识别' + (text(reply.mainDir).length > 0 ? '（' + text(reply.mainDir) + '）' : '（暂无）'))
        }, function (failure) {
          setBusy(false)
          setProblem(repoSaveProblem(failure, target))
        })
      }

      if (target.length === 0) return null
      const kind = snap != null && snap.ok === true ? text(snap.kind) : ''
      if (kind !== 'linked' && kind !== 'broken-gitlink') return null
      const mainDir = text(snap.mainDir)
      const configured = text(snap.configured)
      const gitlink = text(snap.gitlink)
      const broken = kind === 'broken-gitlink'
      /* 目录映射命中的 broken（host 65-worktree.js 的 mainMapped）：.git 记的是别的
         机器的目录，主目录是按全局配置「worktree → 目录映射」换算到本机的 —— 这时
         「多半被删了或搬走了」不是事实，话得换成「另一台机器的目录已换算」，
         出路（打开主目录）也已经摆在下面。 */
      const viaMapping = snap.mainMapped === true
      return h('div', { className: 'dsh-git-setup-sub' },
        h('div', { className: 'dsh-git-setup-h' }, '这是一个 worktree（链接工作区）'),
        h('div', { className: 'dsh-git-hint' },
          broken
            ? (viaMapping
              ? '这个目录的 .git 是一个链接文件' + (gitlink.length > 0 ? '（' + gitlink + '）' : '')
                + '，里面记的是另一台机器的目录路径 —— 面板按全局配置「worktree → 目录映射」把它换算成了本机路径，主目录在下面；点「打开这个目录」即可照常使用。'
              : '这个目录的 .git 是一个链接文件' + (gitlink.length > 0 ? '（' + gitlink + '）' : '')
                + '，它指向的主仓库读不到 —— 多半被删了或搬走了。下面的主目录配置告诉面板这个工作区属于谁；'
                + '配置之后历史、变更、提交都照常可用，读的是配置里那个主仓库的版本库。')
            : '这个目录的 .git 是一个链接文件' + (gitlink.length > 0 ? '（' + gitlink + '）' : '')
              + '，它自己不是独立仓库 —— 读写的都是下面这个主仓库的版本库。'),
        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, broken ? '找到的主目录' : '主目录'),
          mainDir.length > 0
            ? h('span', { className: 'dsh-git-setup-path dsh-git-wtmain-path', title: mainDir }, mainDir)
            : h('span', { className: 'dsh-git-hint' }, '读不到：gitlink 配不上一个存在的目录（配置一个现存的目录即可）'),
          mainDir.length > 0 && typeof props.onOpen === 'function'
            ? h('button', {
              type: 'button', className: 'dsh-git-btn',
              title: '把生效仓库切到主目录 ' + mainDir + '（与仓库行单击同一手势）',
              onClick: function () { props.onOpen(mainDir) },
            }, '打开这个目录')
            : null),
        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '配置主目录'),
          clearable('wtmain', h('input', {
            className: 'dsh-git-input dsh-git-set-input',
            placeholder: '主仓库目录的绝对路径',
            value: draft,
            onChange: function (event) { setDraft(event.target.value); setNote('') },
            onKeyDown: function (event) { if (event.key === 'Enter') saveMain() },
          }), draft.length > 0, function () { setDraft('') }),
          h('button', {
            type: 'button', className: 'dsh-git-btn dsh-git-primary',
            disabled: busy === true || draft.trim().length === 0,
            title: '把这个目录记成 ' + target + ' 的主仓库（存进插件配置，换浏览器/换机器都在）',
            onClick: saveMain,
          }, busy === true ? '保存中…' : '保存'),
          configured.length > 0
            ? h('button', {
              type: 'button', className: 'dsh-git-btn',
              disabled: busy === true,
              title: '删掉这条配置，主目录回到自动识别（git 与 gitlink 文本）',
              onClick: clearMain,
            }, '清除配置')
            : null,
          note.length > 0 ? h('span', { className: 'dsh-git-hint' }, note) : null),
        problem.length > 0 ? h('div', { className: 'dsh-git-hint dsh-git-error' }, problem) : null)
    }

    function RepoSetup(props) {
      const plugin = usePluginConfig()
      const [draft, setDraft] = React.useState(props.initial)
      const [armed, setArmed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [problem, setProblem] = React.useState(null)
      const info = setupReason(props.reason, props.initial)
      /* 只有「路径还没定」或「这个路径有问题」时才需要人改路径。
         路径本身没错、只是这里没有仓库时，上面那行已经说清是哪个目录了。 */
      const editable = info.editable !== false
      /* 初始化是「这里还没有仓库」的出路。没有 git 的时候它不是出路，是同一个
         失败再演一次。 */
      const canInit = info.init !== false
      const target = draft.trim()

      const open = function () {
        if (target.length === 0) return
        setArmed(false)
        props.onOpen(target)
      }

      const doInit = function () {
        if (target.length === 0 || busy) return
        setBusy(true)
        setProblem(null)
        const request = { sessionId: props.sessionId, repo: target }
        if (plugin.initBranch.length > 0) request.branch = plugin.initBranch
        rpc('git/init', request, '初始化失败').then(function () {
          setBusy(false)
          setArmed(false)
          props.onOpen(target)
        }, function (failure) {
          setBusy(false)
          setArmed(false)
          setProblem(failureText(failure))
        })
      }

      return h('div', { className: 'dsh-git-setup' },
        h('div', { className: 'dsh-git-setup-h' }, info.title),
        h('div', { className: 'dsh-git-setup-path' }, props.initial.length > 0 ? props.initial : '（没能确定路径）'),
        info.hint.length > 0 ? h('div', { className: 'dsh-git-hint' }, info.hint) : null,
        props.stderr.length > 0 ? h('div', { className: 'dsh-git-hint dsh-git-error dsh-git-mono' }, props.stderr) : null,
        editable ? clearable('path', h('input', {
          className: 'dsh-git-input',
          placeholder: '仓库目录的绝对路径',
          autoFocus: true,
          value: draft,
          onChange: function (event) { setDraft(event.target.value); setArmed(false) },
          onKeyDown: function (event) { if (event.key === 'Enter') open() },
        }), draft.length > 0, function () { setDraft(''); setArmed(false) }) : null,
        h('div', { className: 'dsh-git-setup-actions' },
          h('button', {
            type: 'button', className: 'dsh-git-btn dsh-git-primary',
            disabled: target.length === 0,
            onClick: open,
          }, '打开这个目录'),
          armed
            ? h('button', {
                type: 'button', className: 'dsh-git-btn dsh-git-danger',
                disabled: busy || target.length === 0,
                onClick: doInit,
              }, busy ? '正在初始化…' : '确认初始化（会写入 .git）')
            : (canInit ? h('button', {
                type: 'button', className: 'dsh-git-btn',
                disabled: busy || target.length === 0,
                onClick: function () { setArmed(true); setProblem(null) },
              }, '在此初始化仓库') : null),
          armed ? h('button', {
            type: 'button', className: 'dsh-git-btn',
            disabled: busy,
            onClick: function () { setArmed(false) },
          }, '取消') : null),
        armed ? h('div', { className: 'dsh-git-hint dsh-git-danger' },
          '将在 ' + target + ' 下执行 git init' + (plugin.initBranch.length > 0 ? ' -b ' + plugin.initBranch : '') + ' —— 这会创建一个 .git 目录并写入文件，无法通过界面撤销。') : null,
        problem !== null ? h('div', { className: 'dsh-git-hint dsh-git-error' }, problem) : null,
        /* worktree 主目录块（上面的 WorktreeMainSetup）：不受 editable / init 开关
           管 —— 「not-a-repo」那一页正是 worktree 主仓库读不动时落的那一页，这里
           恰恰是唯一能配置它的地方。它自己认 kind，不是 worktree 就什么都不画。 */
        h(WorktreeMainSetup, { key: 'wtmain', sessionId: props.sessionId, initial: props.initial, onOpen: props.onOpen }))
    }

