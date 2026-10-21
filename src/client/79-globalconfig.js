    /* ── 面板「配置」页的另一半：全局配置 ──

       原先这里是一页挂在 DSH 设置面板（左下角 → 设置）里的「dsh-git-idea配置」，
       2026-10 起整页搬进面板的「配置」页，作为与「项目配置」并列的一档作用域：
       插件自己的行为、git 在这台机器上的位置、提交身份与换行符，还有只属于这个
       浏览器的外观与节奏。搬动只换了住处，没换读写路径 —— 还是 20-prefs.js 那两层
       （插件配置走 Host 的 json，本浏览器走 localStorage），Host 那半一行都不用动。

       这个文件必须排在 80-panel.js 之前：GitConfigPane 在「全局」那一档渲染
       GitGlobalConfigPane（构建脚本的顺序契约：只用上面定义过的东西）。 */

    /* ── 提交身份：写在 git 自己的配置里 ──

       这一组和插件配置文件不是一回事：`user.name` / `user.email` 是 git 的
       设置，写进去以后终端里的 git、IDEA、钩子看到的都是同一个作者。所以这里既读
       又写，而且落点只有一个：这台机器的 git 配置（`--global`）—— 机器上的 git 就
       是一份，写本地那份是项目自己的事，归配置页「项目配置」档管（80-panel.js），
       两档各说各的，这里不再挑写进哪。

       面板不替你署名：空着的框一个字节都不写（`git config user.name ''` 正是「empty
       ident name」那个错误的来路），两个都空就什么也不做并说清楚。 */
    function GitIdentityGroup(props) {
      /* 面板把手里的 session id 递下来；组件单独渲染（测试）时退回
         lastSession —— chip 一直挂在输入框旁，是它把这件事记下来的那个面。 */
      const remembered = useLastSession()
      const sessionId = props != null && typeof props.sessionId === 'string' && props.sessionId.length > 0
        ? props.sessionId
        : remembered
      const [state, setState] = React.useState(null)
      const [name, setName] = React.useState('')
      const [email, setEmail] = React.useState('')
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
        /* host 的 git/identity-save 还收 scope，客户端固定发 global：这一组只管
           这台机器的那份，写本地归项目档（80-panel.js），不让读者在这里挑。 */
        const payload = { scope: 'global', name: name, email: email }
        if (sessionId.length > 0) payload.sessionId = sessionId
        callHost('git/identity-save', payload).then(function (result) {
          setBusy(false)
          setState(result)
          setNote('已写进这台机器的 git 配置：' + result.written.join('、'))
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

        h('div', { className: 'dsh-git-set-row' }, h('span', { className: 'dsh-git-set-label' }, '写进哪里'),
          h('span', { className: 'dsh-git-set-hint' }, '写进这台机器的 git 配置（--global）—— 项目自己的那份归配置页「项目配置」档')),

        h('div', { className: 'dsh-git-set-row' },
          h('button', {
            type: 'button', className: 'dsh-git-btn dsh-git-primary',
            disabled: busy,
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

    /* ── 换行符：写在 ~/.gitconfig 里的那两个键 ──

       项目档的换行组（80-panel.js）答的是「这个仓库怎么办」，这一组答的是「这台机器
       默认怎么办」：两行读写都落在 `--global` 那份（~/.gitconfig），终端里的 git 用
       同一份，没有自己答案的仓库也吃它。读写走 74-identity.js 的两条新路由
       （git/global-config 读、git/global-config-save 写），都带上 session id ——
       全局写没有仓库可指名，会话是唯一能说出该用哪份沙箱策略的东西（identitySave
       的 global 分支同一个先例）。

       每行下拉首项固定「不设置（清掉 --global 的这条）」＝ unset：项目档的「跟随
       全局」清掉的是 local、退回机器那份，这里清掉的本身就是机器那份。选中即写
       （即清），答复里的 config 为准重画、不回显输入（identitySave /
       projectConfigSave 的同一条原则）。

       宿主旧版兜底：DSH 不重启时正在运行的宿主进程没有这两条新路由，callHost 会把
       10-state.js HOST_NOT_READY 重试耗尽的原话（is not registered）带回来 —— 那与
       这个仓库、与 git 都无关，照 80-panel.js remoteHostOld 的路数给一行灰字出路
       （重启 DSH 后这里才能读写），不甩错误原文；其余失败照 GitIdentityGroup 的
       problem 路子把 git 的原话说出来。 */
    function GitCrlfGroup(props) {
      const sessionId = props != null && typeof props.sessionId === 'string' ? props.sessionId : ''
      const [snap, setSnap] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [problem, setProblem] = React.useState('')

      /* 与读同形的请求底座：读写都带上 session id（上面注释里的那条先例）。 */
      const request = function () {
        return sessionId.length > 0 ? { sessionId: sessionId } : {}
      }
      const load = function () {
        callHost('git/global-config', request()).then(function (data) {
          setSnap(data)
          setProblem('')
        }, function (failure) {
          const said = failureText(failure)
          setSnap({ ok: false, stderr: said })
          /* 宿主旧版那一种不上 problem：下面那行灰字出路替它说话，原文不上屏；
             其余失败照 GitIdentityGroup 的路子把话说出来。 */
          if (said.indexOf(HOST_NOT_READY) < 0) setProblem(said)
        })
      }
      React.useEffect(function () { load() }, [sessionId])

      const configOf = function (key) {
        const one = snap != null && snap.config != null ? snap.config[key] : null
        return one != null ? one : { global: '', globalOrigin: '' }
      }
      /* 读失败里的宿主旧版那一种：与远端组 remoteHostOld 同一条判据。 */
      const hostOld = snap != null && snap.ok !== true
        && text(snap.stderr).indexOf(HOST_NOT_READY) >= 0

      const saveLine = function (key, next) {
        if (busy) return
        setBusy(true)
        setNote('')
        setProblem('')
        const payload = request()
        if (next.length === 0) payload.unset = [key]
        else payload.set = (function () { const one = {}; one[key] = next; return one })()
        callHost('git/global-config-save', payload).then(function (result) {
          setBusy(false)
          if (result == null || result.ok !== true) {
            setProblem(commandDetail(result) || '保存失败')
            return
          }
          /* 读回来而不是回显输入：写进去的值 git 怎么记下的，以此刻的问询为准。 */
          setSnap(result)
          setNote(next.length === 0
            ? ('已清掉 --global 的 ' + key + '：这台机器不再有这条默认值')
            : ('已写进这台机器的 git 配置：' + key + ' = ' + next))
        }, function (failure) {
          setBusy(false)
          setProblem(failureText(failure))
        })
      }

      /* 一行的画法照项目档 lineSelect（80-panel.js）：标签 + 下拉 + 右边一句话。
         右边那句话答「当前全局值与来源」，宿主旧版时如实说读不到。 */
      const line = function (key, choices, title) {
        const entry = configOf(key)
        const value = text(entry.global)
        const options = [h('option', {
          key: 'unset', value: '',
          title: '清掉 --global 的 ' + key + '（本来没配也算成功）',
        }, '不设置（清掉 --global 的这条）')]
        for (let i = 0; i < choices.length; i += 1) {
          options.push(h('option', { key: choices[i], value: choices[i] }, choices[i]))
        }
        return h('div', { className: 'dsh-git-set-row', key: key },
          h('span', { className: 'dsh-git-set-label' }, key),
          h('select', {
            className: 'dsh-git-set-select', value: value, title: title,
            disabled: busy || hostOld === true,
            onChange: function (event) { saveLine(key, event.target.value) },
          }, options),
          h('span', { className: 'dsh-git-set-hint' },
            hostOld === true
              ? '宿主旧版，读不到'
              : ('当前全局：' + (value.length > 0
                ? value + (text(entry.globalOrigin).length > 0 ? '（来自 ' + entry.globalOrigin + '）' : '')
                : '未配置'))))
      }

      return h('div', null,
        h('div', { className: 'dsh-git-set-group' }, '换行符（这台机器的 git 换行配置）'),
        h('div', { className: 'dsh-git-set-hint' },
          '这两行写的是 --global 那份（~/.gitconfig），终端里的 git 用同一份。autocrlf=true 检出转 CRLF、提交转回 LF，input 只在提交时转 LF，false 不转；safecrlf 是把关开关，换行转换不可逆（行尾抹过一遍还原不回去）时 true 让 git 拒绝、warn 只警告、false 不把关。选中即写，首项「不设置」＝清掉 --global 的这条。'),

        line('core.autocrlf', ['true', 'false', 'input'], '检出时把 LF 转 CRLF、提交时转回 LF（input 只在提交时转 LF，false 什么都不转）'),
        line('core.safecrlf', ['true', 'false', 'warn'], '换行转换不可逆（会丢字）时的把关开关：true 让 git 拒绝这次操作、warn 只警告照做、false 不把关'),

        hostOld === true
          ? h('div', { className: 'dsh-git-set-row dsh-git-set-hint' },
            '换行符这两行要在重启 DSH、加载新版宿主之后才能读写 —— 现在运行的宿主进程还是旧版，没有这两条路由；重启 DSH 后回到这里，这里显示的才是一份真正的答案')
          : null,

        note.length > 0 ? h('div', { className: 'dsh-git-set-row dsh-git-set-hint' }, note) : null,
        problem.length > 0 ? h('div', { className: 'dsh-git-set-row dsh-git-error' }, problem) : null)
    }

    /* ── 全局配置这一档的整页 ──

       老设置页 GitSettingsSection 的正文，去掉页首大标题（作用域切换那排已经说了
       「全局配置」）。分组次序原样保留：插件自己的行为在前，git 与这台机器的在后，
       只关于这个浏览器的外观收尾。 */
    function GitGlobalConfigPane(props) {
      const sessionId = props != null && typeof props.sessionId === 'string' ? props.sessionId : ''
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

      return h('div', {
        className: 'dsh-git-global',
        ref: function (node) {
          loadSettings(node != null ? node.ownerDocument : null)
          loadPluginConfig()
        },
      },
        h('div', { className: 'dsh-git-set-hint' },
          '这一半不跟着仓库走：保存在部署配置目录旁的 dsh-git-idea.json，换浏览器、换仓库都一致 —— 最后一组「本浏览器」例外，只管这个浏览器自己的外观与节奏。'),

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

        /* 快捷命令的管理组：和历史页 ⚡ 菜单里的编辑器是同一个组件（78-actions.js）——
           同一份配置、同一套校验，两处改的都是同一样东西。 */
        h('div', { className: 'dsh-git-set-group' }, '快捷命令'),
        h('div', { className: 'dsh-git-set-hint' },
          '自定义命令模板，历史页的 ⚡ 按钮一键执行；{branch}、{hash} 这类变量按当前分支和选中的提交代值。与那个菜单共用同一份（也保存在上面那个 json 里）。'),
        h(QuickCommandsEditor, { key: 'qc', initial: 'list' }),

        h(GitToolchainGroup),

        h(GitCrlfGroup, { key: 'crlf', sessionId: sessionId }),

        pluginConfigError.length > 0
          ? h('div', { className: 'dsh-git-set-row dsh-git-error' }, '保存失败：' + pluginConfigError)
          : null,

        h(GitIdentityGroup, { key: 'ident', sessionId: sessionId }),

        h('div', { className: 'dsh-git-set-group' }, '本浏览器'),
        h('div', { className: 'dsh-git-set-hint' }, '这些只是外观和使用节奏，换浏览器各管各的。'),

        h('div', { className: 'dsh-git-set-row' },
          h('label', { className: 'dsh-git-set-check' },
            h('input', {
              type: 'checkbox', checked: draft.watchChip === true,
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
