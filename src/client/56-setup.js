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
        problem !== null ? h('div', { className: 'dsh-git-hint dsh-git-error' }, problem) : null)
    }

