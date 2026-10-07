    /* The section's name in the settings rail, and the page's own heading. The
       rail's glyph for it stays the shell's gear: the registration contract is
       id/order/label with no icon field, and swapping a glyph the shell owns
       would be a workaround around its own tree, not a feature. */
    const SETTINGS_NAV_LABEL = 'dsh-git-idea配置'

    /* ── 提交身份：写在 git 自己的配置里 ──

       这一组和上面那个插件配置文件不是一回事：`user.name` / `user.email` 是 git 的
       设置，写进去以后终端里的 git、IDEA、钩子看到的都是同一个作者。所以这里既读又
       写，而且写什么由读者挑：这台机器的所有仓库（`--global`），还是只这一个仓库
       （`--local`）。

       面板不替你署名：空着的框一个字节都不写（`git config user.name ''` 正是「empty
       ident name」那个错误的来路），两个都空就什么也不做并说清楚。 */
    function GitIdentityGroup() {
      const sessionId = useLastSession()
      const [state, setState] = React.useState(null)
      const [name, setName] = React.useState('')
      const [email, setEmail] = React.useState('')
      const [scope, setScope] = React.useState('global')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [problem, setProblem] = React.useState('')

      /* 只把 session id 交给 Host，路径由它自己从会话的工作区解出来 —— 和面板、
         chip 走的是同一条路，也就落在这个会话的沙箱策略里。 */
      const request = function () {
        return sessionId.length > 0 ? { sessionId: sessionId } : {}
      }
      const load = function () {
        callHost('git/identity', request()).then(function (data) {
          setState(data)
          setProblem('')
          /* 预填：先给此刻生效的那一份，没有再给机器上的那一份。读者要改的就是它。 */
          const effectiveName = text(data.name)
          const effectiveEmail = text(data.email)
          setName(effectiveName.length > 0 ? effectiveName : text(data.globalName))
          setEmail(effectiveEmail.length > 0 ? effectiveEmail : text(data.globalEmail))
        }, function (failure) { setProblem(failureText(failure)) })
      }
      React.useEffect(function () { load() }, [sessionId])

      const save = function () {
        if (busy) return
        setBusy(true)
        setNote('')
        setProblem('')
        const payload = { scope: scope, name: name, email: email }
        if (sessionId.length > 0) payload.sessionId = sessionId
        callHost('git/identity-save', payload).then(function (result) {
          setBusy(false)
          setState(result)
          setNote(result.scope === 'local'
            ? ('已写进 ' + text(result.repo) + ' 的 .git/config：' + result.written.join('、'))
            : ('已写进这台机器的 git 配置：' + result.written.join('、')))
        }, function (failure) {
          setBusy(false)
          setProblem(failureText(failure))
        })
      }

      const ready = state != null
      const missing = ready && state.needsIdentity === true
      const source = function (value, origin) {
        const one = text(value)
        if (one.length === 0) return '没有配'
        const from = text(origin)
        return from.length === 0 ? one : (one + '（来自 ' + from + '）')
      }
      const toggle = function (next) {
        return h('label', { className: 'dsh-git-set-check' },
          h('input', {
            type: 'radio', checked: scope === next, name: 'dsh-git-ident-scope',
            onChange: function () { setScope(next) },
          }),
          h('span', null, next === 'global' ? '这台机器的所有仓库（--global）' : '只对这个仓库（--local）'))
      }

      return h('div', null,
        h('div', { className: 'dsh-git-set-group' }, '提交身份（写在 git 自己的配置里）'),
        h('div', { className: 'dsh-git-set-hint' },
          'git 不知道作者是谁时会拒绝提交，而这台机器上终端里的 git 也用同一份配置。面板空着的框一个字节都不写。'),

        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '此刻生效'),
          h('span', { className: missing === true ? 'dsh-git-set-hint dsh-git-warn' : 'dsh-git-set-hint' },
            ready !== true ? '正在读取…'
              : (missing === true
                ? '还缺：' + (state.nameMissing === true ? '名字' : '邮箱') + ' —— 提交会被 git 拒绝'
                : (source(state.name, state.nameOrigin) + ' · ' + source(state.email, state.emailOrigin))))),

        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '名字'),
          h('input', {
            className: 'dsh-git-input dsh-git-set-input',
            placeholder: '提交里显示的名字',
            value: name,
            onChange: function (event) { setName(event.target.value) },
          })),

        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '邮箱'),
          h('input', {
            className: 'dsh-git-input dsh-git-set-input',
            placeholder: 'you@example.com',
            value: email,
            onChange: function (event) { setEmail(event.target.value) },
          })),

        h('div', { className: 'dsh-git-set-row' }, h('span', { className: 'dsh-git-set-label' }, '写进哪里'), toggle('global')),
        h('div', { className: 'dsh-git-set-row' }, h('span', { className: 'dsh-git-set-label' }, ''), toggle('local')),
        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, ''),
          h('span', { className: 'dsh-git-set-hint' },
            text(state != null ? state.repo : '').length > 0
              ? ('这个仓库 = ' + state.repo)
              : '这个页面还不知道是哪个会话的仓库 —— 先打开一次面板（或输入框旁的 Git 按钮），或只写全局那一份')),

        h('div', { className: 'dsh-git-set-row' },
          h('button', {
            type: 'button', className: 'dsh-git-btn dsh-git-primary',
            disabled: busy || (scope === 'local' && text(state != null ? state.repo : '').length === 0),
            onClick: save,
          }, busy ? '写入中…' : '写入 git 配置'),
          h('span', { className: 'dsh-git-set-hint' }, '写进去就是以后所有提交的作者，别的工具也看得到')),

        note.length > 0 ? h('div', { className: 'dsh-git-set-row dsh-git-set-hint' }, note) : null,
        problem.length > 0 ? h('div', { className: 'dsh-git-set-row dsh-git-error' }, problem) : null)
    }

    /* ── git 位置：这台机器上的哪个 git ──

       每一行命令都以同一个词开头，而那个词默认来自部署的 PATH。装在不在这条 PATH 上的
       地方（Homebrew 前缀、IDE 自带的 git、nix profile）时，面板以前只会说「这台机器
       上找不到 git」—— 既是错的，也没给出下一步。所以它是个设置。 */
    function GitToolchainGroup() {
      const plugin = usePluginConfig()
      const committed = usePluginConfigCommitted()
      const [draftPath, setDraftPath] = React.useState(plugin.gitPath)
      const [tool, setTool] = React.useState(null)
      React.useEffect(function () { setDraftPath(plugin.gitPath) }, [plugin.gitPath])

      const probe = function () {
        callHost('git/toolchain', {}).then(function (data) { setTool(data) }, function (failure) {
          setTool({ ok: false, path: '', version: '', found: false, reason: 'probe-failed', error: failureText(failure) })
        })
      }
      /* 问的时机是**Host 确认过之后**，不是敲键的时候：草稿是即时的，而
         `savePluginConfig` 有 400ms 去抖，落盘之后 Host 才回话。挂在草稿上问，
         问到的是上一份配置 —— 真机上量到的就是界面永远慢一步（写入坏路径之后那一行
         还说「来自 PATH」，要等下一次改动才改口）；挂在每次按键上还会把一次询问变成
         每个字符一次。`committed` 只在答复带着配置回来时动。 */
      React.useEffect(function () { probe() }, [committed])

      const commitPath = function (value) {
        setDraftPath(value)
        const next = Object.assign({}, plugin)
        next.gitPath = value
        savePluginConfig(next)
      }
      const found = tool != null && tool.found === true
      const reason = tool == null ? '' : text(tool.reason)
      const verdict = tool == null
        ? '正在检查…'
        : (found
          ? ('现在用的是 ' + tool.path + (tool.fromPath === true ? '（来自 PATH）' : '（设置里写的就是它）')
            + ' · ' + text(tool.version))
          : (reason === 'configured-missing'
            ? '设置里写的这个路径不可用：它不存在，或者不是可执行文件。面板里的每条命令都会失败。'
            : '这台机器的 PATH 上没有 git。装上它，或者在下面写一个绝对路径。'))

      return h('div', null,
        h('div', { className: 'dsh-git-set-group' }, 'git 位置'),
        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '可执行文件'),
          h('input', {
            className: 'dsh-git-input dsh-git-set-input',
            placeholder: '留空 = 用 PATH 里的 git',
            value: draftPath,
            onChange: function (event) { commitPath(event.target.value) },
          })),
        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, ''),
          h('span', { className: found === true ? 'dsh-git-set-hint' : 'dsh-git-set-hint dsh-git-warn' }, verdict)),
        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, ''),
          h('button', { type: 'button', className: 'dsh-git-btn', onClick: probe }, '再检查一次'),
          h('span', { className: 'dsh-git-set-hint' }, '面板读、写、初始化用的都是这一个')))
    }

    function GitSettingsSection(props) {
      const settings = useGitSettings()
      const [draft, setDraft] = React.useState(settings)
      const plugin = usePluginConfig()
      const [pdraft, setPdraft] = React.useState(plugin)

      React.useEffect(function () { setDraft(settings) }, [settings])
      React.useEffect(function () { setPdraft(plugin) }, [plugin])

      const setPlugin = function (key, value) {
        const next = Object.assign({}, pdraft)
        next[key] = value
        setPdraft(next)
        savePluginConfig(next)
      }

      const apply = function (next) {
        setDraft(next)
        saveSettings(next)
      }
      const set = function (key, value) {
        const next = Object.assign({}, draft)
        next[key] = value
        apply(next)
      }
      const num = function (key, value, min, max) {
        const n = parseInt(value, 10)
        set(key, isNaN(n) ? min : n)
      }
      const watchOff = draft.watchEnabled !== true

      return h('div', {
        className: 'dsh-git-set',
        ref: function (node) {
          loadSettings(node != null ? node.ownerDocument : null)
          loadPluginConfig()
        },
      },
        h('div', { className: 'dsh-git-set-h' }, SETTINGS_NAV_LABEL),
        h('div', { className: 'dsh-git-set-hint' }, '分两层：跟随插件的配置，和只影响本浏览器的外观与节奏。'),

        h('div', { className: 'dsh-git-set-group' }, '插件配置'),
        h('div', { className: 'dsh-git-set-hint' },
          pluginConfigPath.length > 0
            ? ('保存在 ' + pluginConfigPath + ' —— 换浏览器也一致')
            : '保存在部署配置目录旁的 dsh-git-idea.json —— 换浏览器也一致'),

        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '初始化仓库的默认分支'),
          clearable('init', h('input', {
            className: 'dsh-git-input dsh-git-set-input',
            placeholder: 'main',
            value: pdraft.initBranch,
            onChange: function (event) { setPlugin('initBranch', event.target.value) },
          }), pdraft.initBranch.length > 0, function () { setPlugin('initBranch', '') }, 'dsh-git-clearable-set'),
          h('span', { className: 'dsh-git-set-hint' }, '引导页「在此初始化仓库」会用它执行 git init -b；留空则用 git 自己的默认值')),

        h('div', { className: 'dsh-git-set-row' },
          h('label', { className: 'dsh-git-set-check' },
            h('input', {
              type: 'checkbox', checked: pdraft.cherryPickRecord === true,
              onChange: function (event) { setPlugin('cherryPickRecord', event.target.checked) },
            }),
            h('span', null, 'cherry-pick 时记录来源（-x）'))),

        h('div', { className: 'dsh-git-set-group' }, '远程同步'),
        h('div', { className: 'dsh-git-set-hint' },
          '这三条是面板给 git 的实参，不是 git 自己的设置：下面没勾的，就是 git 原本的行为（`push.default`、`pull.rebase` 照旧生效）。'),

        h('div', { className: 'dsh-git-set-row' },
          h('label', { className: 'dsh-git-set-check' },
            h('input', {
              type: 'checkbox', checked: pdraft.fetchPrune !== false,
              onChange: function (event) { setPlugin('fetchPrune', event.target.checked) },
            }),
            h('span', null, 'fetch 时删掉远端已经删了的远程分支（--prune）'))),

        h('div', { className: 'dsh-git-set-row' },
          h('label', { className: 'dsh-git-set-check' },
            h('input', {
              type: 'checkbox', checked: pdraft.pullRebase === true,
              onChange: function (event) { setPlugin('pullRebase', event.target.checked) },
            }),
            h('span', null, 'pull 用 rebase 而不是 merge（--rebase）'))),

        h('div', { className: 'dsh-git-set-row' },
          h('label', { className: 'dsh-git-set-check' },
            h('input', {
              type: 'checkbox', checked: pdraft.pushSetUpstream === true,
              onChange: function (event) { setPlugin('pushSetUpstream', event.target.checked) },
            }),
            h('span', null, '推送没有上游的分支时直接推上去并设上游（push -u）'))),

        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '也就是'),
          h('span', { className: 'dsh-git-set-hint' },
            'git fetch --all' + (pdraft.fetchPrune !== false ? ' --prune' : '')
            + ' · git pull' + (pdraft.pullRebase === true ? ' --rebase' : '')
            + ' · ' + (pdraft.pushSetUpstream === true ? 'git push -u <remote> <branch>（没有上游时）' : 'git push（没有上游时由面板问一句）'))),

        /* 快捷命令的管理组：和面板 ⚡ 菜单里的编辑器是同一个组件（78-actions.js）——
           同一份配置、同一套校验，两处改的都是同一样东西。 */
        h('div', { className: 'dsh-git-set-group' }, '快捷命令'),
        h('div', { className: 'dsh-git-set-hint' },
          '自定义命令模板，面板历史的 ⚡ 按钮一键执行；{branch}、{hash} 这类变量按当前分支和选中的提交代值。与面板共用同一份（也保存在上面那个 json 里）。'),
        h(QuickCommandsEditor, { key: 'qc', initial: 'list' }),

        h(GitToolchainGroup),

        pluginConfigError.length > 0
          ? h('div', { className: 'dsh-git-set-row dsh-git-error' }, '保存失败：' + pluginConfigError)
          : null,

        h(GitIdentityGroup),

        h('div', { className: 'dsh-git-set-group' }, '本浏览器'),
        h('div', { className: 'dsh-git-set-hint' }, '这些只是外观和使用节奏，换浏览器各管各的。'),

        h('div', { className: 'dsh-git-set-row' },
          h('label', { className: 'dsh-git-set-check' },
            h('input', {
              type: 'checkbox', checked: draft.watchEnabled === true,
              onChange: function (event) { set('watchEnabled', event.target.checked) },
            }),
            h('span', null, '后台监测仓库变化，发现变化就自动刷新'))),

        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '面板打开时每'),
          h('input', {
            className: 'dsh-git-input dsh-git-set-num', type: 'number', min: 1, max: 120,
            disabled: watchOff,
            value: String(draft.watchFastSec),
            onChange: function (event) { num('watchFastSec', event.target.value, 1, 120) },
          }),
          h('span', { className: 'dsh-git-set-hint' }, '秒检查一次')),

        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '只有按钮时每'),
          h('input', {
            className: 'dsh-git-input dsh-git-set-num', type: 'number', min: 2, max: 600,
            disabled: watchOff,
            value: String(draft.watchSlowSec),
            onChange: function (event) { num('watchSlowSec', event.target.value, 2, 600) },
          }),
          h('span', { className: 'dsh-git-set-hint' }, '秒检查一次')),

        h('div', { className: 'dsh-git-set-row' },
          h('label', { className: 'dsh-git-set-check' },
            h('input', {
              type: 'checkbox', checked: draft.watchChip === true, disabled: watchOff,
              onChange: function (event) { set('watchChip', event.target.checked) },
            }),
            h('span', null, '面板关着时也监测，让按钮上的分支名和改动数保持实时'))),

        h('div', { className: 'dsh-git-set-row' },
          h('label', { className: 'dsh-git-set-check' },
            h('input', {
              type: 'checkbox', checked: draft.hoverSwitch === true,
              onChange: function (event) { set('hoverSwitch', event.target.checked) },
            }),
            h('span', null, '鼠标停在输入框旁的 Git 按钮上，弹出分支切换卡片（点一下就切）'))),

        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '面板尺寸'),
          h('span', { className: 'dsh-git-set-hint' },
            panelSize.w > 0 || panelSize.h > 0
              ? (String(panelSize.w) + ' × ' + String(panelSize.h) + ' 像素')
              : '跟随输入框宽度 / 74vh'),
          h('button', {
            type: 'button', className: 'dsh-git-btn',
            onClick: function () { publishPanelSize({ w: 0, h: 0 }); savePanelSize() },
          }, '恢复默认尺寸')),

        h('div', { className: 'dsh-git-set-row' },
          h('span', { className: 'dsh-git-set-label' }, '切换器的记忆'),
          h('span', { className: 'dsh-git-set-hint' }, '最近使用与收藏只写在这个浏览器里'),
          h('button', {
            type: 'button', className: 'dsh-git-btn',
            onClick: function () { clearBranchMemory() },
          }, '清除最近使用与收藏')),

        h('div', { className: 'dsh-git-set-row' },
          h('button', {
            type: 'button', className: 'dsh-git-btn',
            onClick: function () { apply(Object.assign({}, SETTINGS_DEFAULTS)) },
          }, '本浏览器全部恢复默认')))
    }

