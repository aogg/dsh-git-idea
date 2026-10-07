    /* ── 一个工作区里的所有仓库：清单、选择态、切换器 ──

       「一个会话工作区 = 一个仓库」是这个面板原来的模型；这里的每一样东西都是为
       「一个工作区里可能嵌着好几个仓库」补的那一块：

         · 清单 —— Host 扫一遍工作区（git/repos），外加这个工作区手动登记过的仓库
           （git/repos-save，存在插件配置里，见 61-repos.js 的说明）；
         · 选择态 —— 左栏分支树和变更页各自记住「当前在看哪几个仓库」；
         · RepoSwitcher —— 两块侧栏共用的那列仓库行。

       扫描是**异步补**的：面板首帧先画它本来要画的东西，清单落地后多出一段。这里的
       状态全部住在模块层而不是 React state，理由和 10-state.js 的工作区读数相同 ——
       面板在换会话时整个重挂，而「这个工作区扫过没有」不该跟着重挂重来一遍。 */

    const repoLists = {}
    /* 扫描的去重键是会话而不是工作区：发起时客户端还不知道 Host 会把工作区解析成
       什么路径（那正是答复要带回来的），按工作区去重就得先猜路径。一个会话只问一次，
       两个会话共用同一工作区时多问的那一次，Host 那边也只是一条毫秒级的 find。 */
    const repoScanAsked = {}
    /* 答复带回来的权威路径：会话 → 工作区。面板渲染时用它找到自己那份清单。 */
    const repoSessions = {}
    let repoListVersion = 0
    const repoListSignal = createSignal(function () { return repoListVersion })
    const useRepoList = repoListSignal.use

    function repoListEmpty() {
      return { repos: [], manual: [], missing: [], phase: 'idle', note: '' }
    }

    function repoListFor(workspace) {
      const found = repoLists[workspace]
      return found === undefined ? repoListEmpty() : found
    }

    function workspaceOf(sessionId) {
      return sessionId == null ? '' : text(repoSessions[sessionId])
    }

    /* 这个会话该渲染哪份清单：优先答复带回来的工作区；扫描失败时答复里没有工作区，
       退回那条按会话记的失败占位，好让「扫描失败」这两个字有地方出现。 */
    function repoListForSession(sessionId) {
      const workspace = workspaceOf(sessionId)
      if (workspace.length > 0) return repoListFor(workspace)
      const fallback = repoLists['session:' + text(sessionId)]
      return fallback === undefined ? repoListEmpty() : fallback
    }

    function bumpRepoList() {
      repoListVersion += 1
      repoListSignal.notify()
    }

    /* 答复落进两处：这个会话的工作区路径，和那份按工作区记的清单。扫描失败不是
       错误横幅的事 —— 仓库清单是辅助信息，坏掉它不该坏掉面板（设置页那套 reason
       的完整句子留给了「仓库本身读不动」这种情况）。 */
    function adoptReposReply(sessionId, data) {
      if (data != null && data.ok === true && text(data.workspace).length > 0) {
        const workspace = text(data.workspace)
        repoSessions[sessionId] = workspace
        repoLists[workspace] = {
          repos: Array.isArray(data.repos) ? data.repos.map(text) : [],
          manual: Array.isArray(data.manual) ? data.manual.map(text) : [],
          missing: Array.isArray(data.missing) ? data.missing.map(text) : [],
          phase: 'ready',
          note: data.truncated === true ? '仓库太多，只显示前 ' + String(Array.isArray(data.repos) ? data.repos.length : 0) + ' 个' : '',
        }
      } else if (sessionId != null) {
        /* 没扫出来（或 Host 还没有这个方法）：清单保持空白，但「扫过了」要记下，
           免得每次重渲染都再问一遍。生效仓库那一行由调用方补种，列表依然可用。 */
        repoLists['session:' + text(sessionId)] = Object.assign(repoListEmpty(), { phase: 'failed' })
      }
      bumpRepoList()
    }

    /* 面板打开（或设置页挂着）时叫一次。异步、不阻塞首帧：这里只发起，回复通过
       signal 让正在渲染的面板重画。失败只落进 phase，不再抛给调用者。

       去重按**会话**记（repoScanAsked）：面板重开、切页签都不再扫 —— 「每个工作区
       只扫一次」在常见形态（一页一会话）下因此成立。刻意不做成跨会话合并的单飞：
       一页可以挂几个会话、各在各的工作区，搭同一趟往返会把 A 工作区的清单安到 B
       头上；而这条 find 本身是毫秒级的，各扫各的才是对的。 */
    function ensureWorkspaceRepos(sessionId) {
      if (sessionId == null || repoScanAsked[sessionId] === true) return
      repoScanAsked[sessionId] = true
      repoLists['session:' + text(sessionId)] = Object.assign(repoListEmpty(), { phase: 'scanning' })
      bumpRepoList()
      callHost('git/repos', { sessionId: sessionId }).then(function (data) {
        adoptReposReply(sessionId, data)
      }).catch(function (failure) {
        /* 运输层断了（Host 重启中 callHost 自己会重试）才会走到这：记成失败，面板
           那一栏说「扫描失败」，而不是永远「正在扫描」。 */
        console.error('dsh-git-idea: workspace repo scan failed', failureText(failure))
        repoLists['session:' + text(sessionId)] = Object.assign(repoListEmpty(), { phase: 'failed' })
        bumpRepoList()
      })
    }

    /* 手动登记/移除。答复带着合并后的整份清单，adopt 一次就换新；失败经 rpc()
       折成 Error 抛回，调用方（切换器的输入行）把那句话摆在输入框旁边。 */
    function saveManualRepo(sessionId, payload) {
      const request = { sessionId: sessionId }
      if (payload != null) Object.assign(request, payload)
      return rpc('git/repos-save', request, '保存失败').then(function (data) {
        adoptReposReply(sessionId, data)
        return data
      })
    }

    /* 61-repos.js 的错误码翻成读者能照着做的话。 */
    function repoSaveProblem(failure, path) {
      const reply = failure != null && failure.reply != null ? failure.reply : null
      const code = reply != null ? text(reply.error) : ''
      if (code === 'missing') return '这个目录不存在：' + path
      if (code === 'not-a-repository') return '这个目录不是 git 仓库（里面没有 .git），没法加进列表'
      if (code === 'absolute path required') return '要填绝对路径（以 / 开头）'
      if (code === 'no-path') return '这个会话的工作区还没确定，先在设置页里确定路径'
      if (reply != null && reply.sandboxDenied === true) {
        return '文件沙箱不允许写插件配置，手动仓库暂时存不下来'
      }
      return failureText(failure)
    }

    /* ── 选择态：哪几仓库的分支/变更正在左栏一起看 ──

       两块侧栏（左栏分支树、变更页）**各自**记一份，不共享。理由：它们回答的是两个
       问题 —— 「分支都在哪」和「谁的工作区在变」—— 读者在变更页按着 Ctrl 挑三个仓库
       看改动时，没有理由让历史页的分支树跟着换一批；反过来，在分支树里多选看分支，
       也不该把变更页悄悄变成三个仓库的合并视图。多选只影响所在的那一栏，生效仓库
       （历史、chip、提交、推送用的那个）永远只跟单击走。

       按会话记而不是全局：一个页面可以同时挂着两个会话，两个工作区的选择互不相干。
       空数组 = 没有多选，那一栏回到「只看生效仓库」的现状。 */
    const repoViews = {}
    let repoViewVersion = 0
    const repoViewSignal = createSignal(function () { return repoViewVersion })
    const useRepoViews = repoViewSignal.use

    function repoViewsOf(sessionId) {
      const found = repoViews[sessionId]
      if (found !== undefined) return found
      const fresh = { log: [], changes: [] }
      repoViews[sessionId] = fresh
      return fresh
    }

    function repoSelection(sessionId, pane) {
      return repoViewsOf(sessionId)[pane] === undefined ? [] : repoViewsOf(sessionId)[pane]
    }

    function setRepoSelection(sessionId, pane, repos) {
      const views = repoViewsOf(sessionId)
      const next = []
      for (let i = 0; i < repos.length; i += 1) {
        const path = text(repos[i])
        if (path.length > 0 && next.indexOf(path) < 0) next.push(path)
      }
      const same = next.length === views[pane].length && next.every(function (path, i) { return views[pane][i] === path })
      if (same) return
      views[pane] = next
      repoViewVersion += 1
      repoViewSignal.notify()
    }

    function toggleRepoSelection(sessionId, pane, path) {
      const current = repoSelection(sessionId, pane)
      const next = current.indexOf(path) >= 0
        ? current.filter(function (one) { return one !== path })
        : current.concat([path])
      setRepoSelection(sessionId, pane, next)
    }

    /* ── 切换器：两块侧栏共用的那列行 ──

       行不用 dsh-git-trow 那套类名：分支树/变更树的行有折叠、树选中和分组断言跟着
       那个类名走，仓库行是另一类控件（不折叠、不属于哪棵树），也不该被当成树行数
       进去。 */

    function repoBaseName(path) {
      const trimmed = text(path).replace(/\/+$/, '')
      const cut = trimmed.lastIndexOf('/')
      return cut < 0 ? trimmed : trimmed.slice(cut + 1)
    }

    /* 切换器要画的那几行（也是「全部」的语义边界）：扫描结果 + 生效仓库兜底。生效
       仓库要种进去，因为扫描还没回来（或失败）时列表也得有它 —— 它是唯一确定存在
       的仓库，「切回主仓库」恰恰是最常用的那一格。 */
    function reposShown(list, effective) {
      const out = list.repos.slice()
      if (effective.length > 0 && out.indexOf(effective) < 0) out.push(effective)
      return out
    }

    /* props: sessionId、pane（'log'|'changes'）、list（repoListFor 的那份）、
       effective（当前生效仓库路径；种进行当第一行之后的行）、
       onSingle(path)、onAll()、onAdd(path)→Promise、onRemove(path)→Promise */
    function RepoSwitcher(props) {
      const sessionId = props.sessionId
      const pane = props.pane
      const list = props.list
      const effective = text(props.effective)
      const shown = reposShown(list, effective)
      const selection = repoSelection(sessionId, pane).filter(function (path) {
        return shown.indexOf(path) >= 0 || list.missing.indexOf(path) >= 0
      })
      const allOn = selection.length >= shown.length && shown.length > 0
      const [adding, setAdding] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [problem, setProblem] = React.useState('')

      /* 手动加：路径交给 Host 校验（存在且是仓库）并持久化；答复里带着整份新清单。
         失败的那句话摆在输入框下面 —— 这一行错误是关于这一次输入的，不该升到面板
         顶上的错误横幅。 */
      const submitAdd = function () {
        const path = draft.trim()
        if (path.length === 0 || busy) return
        setBusy(true)
        setProblem('')
        props.onAdd(path).then(function () {
          setBusy(false)
          setAdding(false)
          setDraft('')
        }, function (failure) {
          setBusy(false)
          setProblem(repoSaveProblem(failure, path))
        })
      }

      const removeOne = function (path) {
        if (busy) return
        setBusy(true)
        setProblem('')
        props.onRemove(path).then(function () {
          setBusy(false)
        }, function (failure) {
          setBusy(false)
          setProblem(repoSaveProblem(failure, path))
        })
      }

      const rows = []
      rows.push(h('div', { key: 'repo-head', className: 'dsh-git-repo-head' },
        h('span', { key: 't', className: 'dsh-git-repo-head-name' }, '仓库'),
        list.phase === 'scanning' || list.phase === 'idle'
          ? h('span', { key: 's', className: 'dsh-git-repo-note' }, '正在扫描…')
          : (list.phase === 'failed'
            ? h('span', { key: 'f', className: 'dsh-git-repo-note' }, '扫描失败')
            : (list.note.length > 0 ? h('span', { key: 'n', className: 'dsh-git-repo-note', title: list.note }, '…') : null))))

      /* 「全部」在列表最前面。单击和 Ctrl+单击都是全选语义（需求如此：多选时再点
         「全部」就是全选）；它永远不改生效仓库 —— 生效仓库只跟某个仓库行的单击走。 */
      rows.push(h('div', {
        key: 'repo-all',
        className: 'dsh-git-repo-row' + (allOn ? ' dsh-git-repo-sel' : ''),
        title: '一起显示列表里所有仓库' + (pane === 'log' ? '的分支' : '的变更')
          + '（Ctrl+单击仓库行可以只挑几个；不改变当前生效仓库）',
        onClick: function () { props.onAll() },
      },
        h('span', { key: 'm', className: 'dsh-git-repo-mark' }),
        h('span', { key: 'n', className: 'dsh-git-repo-name' }, '全部'),
        h('span', { key: 'c', className: 'dsh-git-repo-dim' }, String(shown.length))))

      for (let i = 0; i < shown.length; i += 1) {
        const path = shown[i]
        const isCur = path === effective
        const picked = selection.indexOf(path) >= 0
        const manual = list.manual.indexOf(path) >= 0
        rows.push(h('div', {
          key: 'repo:' + path,
          className: 'dsh-git-repo-row'
            + (isCur ? ' dsh-git-repo-cur' : '')
            + (picked ? ' dsh-git-repo-sel' : ''),
          title: path + (isCur ? '\n当前生效仓库：历史、提交、推送都作用在这里' : '')
            + '\n单击 = 切换为生效仓库；Ctrl+单击 = 加入/移出多选',
          onClick: function (event) {
            if (event != null && (event.ctrlKey === true || event.metaKey === true)) {
              toggleRepoSelection(sessionId, pane, path)
              return
            }
            props.onSingle(path)
          },
        },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }, isCur ? '●' : ''),
          h('span', { key: 'n', className: 'dsh-git-repo-name' }, repoBaseName(path)),
          manual ? h('button', {
            key: 'x', type: 'button', className: 'dsh-git-repo-x',
            title: '从列表移除（手动登记的仓库才能移除）',
            onClick: function (event) { stopEvent(event); removeOne(path) },
          }, '×') : null))
      }

      /* 手动登记过、目录已经不在（或不再是仓库）的路径：留一行、压暗、能移除 ——
       持久化的清单要容错，删掉的目录不能把面板弄崩，也不该无声消失。 */
      for (let i = 0; i < list.missing.length; i += 1) {
        const path = list.missing[i]
        rows.push(h('div', {
          key: 'gone:' + path,
          className: 'dsh-git-repo-row dsh-git-repo-gone',
          title: path + '\n这个目录已经不存在（或不再是 git 仓库）',
        },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }, ''),
          h('span', { key: 'n', className: 'dsh-git-repo-name' }, repoBaseName(path)),
          h('span', { key: 'g', className: 'dsh-git-repo-dim' }, '已不存在'),
          h('span', {
            key: 'x', className: 'dsh-git-repo-x', title: '从列表移除',
            onClick: function (event) { stopEvent(event); removeOne(path) },
          }, '×')))
      }

      rows.push(adding
        ? h('div', { key: 'repo-add-row', className: 'dsh-git-repo-addrow' },
            h('input', {
              key: 'i', className: 'dsh-git-repo-input', autoFocus: true,
              placeholder: '仓库目录的绝对路径',
              value: draft,
              onChange: function (event) { setDraft(event.target.value) },
              onKeyDown: function (event) {
                if (event.key === 'Enter') submitAdd()
                if (event.key === 'Escape') { setAdding(false); setDraft(''); setProblem('') }
              },
            }),
            h('button', {
              key: 'ok', type: 'button', className: 'dsh-git-btn dsh-git-repo-ok',
              disabled: busy || draft.trim().length === 0, onClick: submitAdd,
            }, busy ? '…' : '添加'))
        : h('div', {
            key: 'repo-add', className: 'dsh-git-repo-add', title: '把一个 git 仓库目录手动加进这个项目的列表（持久保存）',
            onClick: function () { setAdding(true); setProblem('') },
          },
            h('span', { key: 'p', className: 'dsh-git-repo-mark' }, '＋'),
            h('span', { key: 'n', className: 'dsh-git-repo-name dsh-git-dim' }, '添加目录')))

      if (problem.length > 0) {
        rows.push(h('div', { key: 'repo-problem', className: 'dsh-git-repo-problem' }, problem))
      }
      return rows
    }
