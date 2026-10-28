    /* ── 一个工作区里的所有仓库：清单、选择态、切换器 ──

       「一个会话工作区 = 一个仓库」是这个面板原来的模型；这里的每一样东西都是为
       「一个工作区里可能嵌着好几个仓库」补的那一块：

         · 清单 —— Host 扫一遍工作区（git/repos），外加这个工作区手动登记过的仓库
           （git/repos-save，存在插件配置里，见 61-repos.js 的说明）；
         · 选择态 —— 左栏分支树和变更页各自记住「当前在看哪几个仓库」；配置页的项目档
           另有一格「本页在编辑哪个仓库」（单选，见 repoViewsOf）；
         · RepoSwitcher —— 两块侧栏共用的那列仓库行（配置页用它的受控单选变体）。

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
      return { repos: [], manual: [], missing: [], links: [], dirs: [], dirRepos: {}, phase: 'idle', note: '' }
    }

    /* 「目录 → 子孙仓库」的清洗：答复/盘账里谁都能塞东西，只收「对象 → 字符串
       数组」的形状，其余当没有 —— 与 sanitizeRepoListStoredEntry 同一条宁少勿错。 */
    function repoDirReposOf(raw) {
      const out = {}
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out
      const keys = Object.keys(raw)
      for (let i = 0; i < keys.length; i += 1) {
        const list = raw[keys[i]]
        if (Array.isArray(list) && list.length > 0) out[keys[i]] = list.map(text)
      }
      return out
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
       错误横幅的事 —— 仓库清单是辅助信息，坏掉它不该坏掉面板（RepoSetup 那套 reason
       的完整句子留给了「仓库本身读不动」这种情况）。 */
    function adoptReposReply(sessionId, data) {
      let changed = false
      if (data != null && data.ok === true && text(data.workspace).length > 0) {
        const workspace = text(data.workspace)
        const fresh = {
          repos: Array.isArray(data.repos) ? data.repos.map(text) : [],
          manual: Array.isArray(data.manual) ? data.manual.map(text) : [],
          missing: Array.isArray(data.missing) ? data.missing.map(text) : [],
          /* links：.git 是文件的仓库根（worktree / 子模块）。Host 旧版没有这一格
             （答复缺字段），缺省空数组 —— 行上不画小标，一切照旧。 */
          links: Array.isArray(data.links) ? data.links.map(text) : [],
          /* dirs/dirRepos：登记的「含仓库目录」与「目录 → 子孙仓库」（v0.2.9）。
             Host 旧版没有这两格时缺省空 —— 分组函数拿到空 dirs 照旧平铺，一切照旧。 */
          dirs: Array.isArray(data.dirs) ? data.dirs.map(text) : [],
          dirRepos: repoDirReposOf(data.dirRepos),
          phase: 'ready',
          note: data.truncated === true ? '仓库太多，只显示前 ' + String(Array.isArray(data.repos) ? data.repos.length : 0) + ' 个' : '',
        }
        /* 内容级去重（63-storedlists.js）：会话映射没换、工作区名下又已有一份
           ready 且清单逐字一致（内容原样的重新 adopt）就不重写内存账、不 bump
           重画、也不落盘 —— 映射换过（刷新后首次 adopt 把会话认到工作区名下）则
           照旧整套落账，渲染按新映射找清单。 */
        const previous = repoLists[workspace]
        const same = repoSessions[sessionId] === workspace
          && previous !== undefined
          && previous.phase === 'ready'
          && storedRepoListFieldsSame(previous, fresh)
        repoSessions[sessionId] = workspace
        if (same !== true) {
          repoLists[workspace] = fresh
          /* 盘账跟着落一份（63-storedlists.js，按会话一格；put 内部对盘上现账再做
             一次内容去重，一致就不写盘）。 */
          repoListsStored.put(text(sessionId), {
            repos: fresh.repos,
            manual: fresh.manual,
            missing: fresh.missing,
            links: fresh.links,
            dirs: fresh.dirs,
            dirRepos: fresh.dirRepos,
            note: fresh.note,
          })
          changed = true
        }
      } else if (sessionId != null) {
        /* 没扫出来（或 Host 还没有这个方法）：清单保持空白，但「扫过了」要记下，
           免得每次重渲染都再问一遍。生效仓库那一行由调用方补种，列表依然可用。 */
        repoLists['session:' + text(sessionId)] = Object.assign(repoListEmpty(), { phase: 'failed' })
        /* 扫描答复不是 ok：这份清单已经不可信，删掉该会话的盘账条目并落盘 ——
           仓库没了/读不动了，不许在下一次刷新还魂（chip 的分支名同一套失效规矩）。 */
        repoListsStored.drop(text(sessionId))
        changed = true
      }
      if (changed) bumpRepoList()
    }

    /* 面板打开时叫一次。异步、不阻塞首帧：这里只发起，回复通过
       signal 让正在渲染的面板重画。失败只落进 phase，不再抛给调用者。

       去重按**会话**记（repoScanAsked）：面板重开、切页签都不再扫 —— 「每个工作区
       只扫一次」在常见形态（一页一会话）下因此成立。刻意不做成跨会话合并的单飞：
       一页可以挂几个会话、各在各的工作区，搭同一趟往返会把 A 工作区的清单安到 B
       头上；而这条 find 本身是毫秒级的，各扫各的才是对的。 */
    function ensureWorkspaceRepos(sessionId) {
      if (sessionId == null || repoScanAsked[sessionId] === true) return
      repoScanAsked[sessionId] = true
      /* 首帧垫底（63-storedlists.js 的盘账）：这个会话盘上有上次的清单，就先把
         'session:'+id 的占位种成 ready + 那份清单 —— 扫描答复回来之前左栏就有得
         画，不再闪「正在扫描」。扫描照发（去重键仍是会话），答复一到照旧 adopt
         整个盖掉；盘账只管「首帧不空」，绝不拦读、绝不省读。 */
      const storedList = repoListsStored.get(text(sessionId))
      repoLists['session:' + text(sessionId)] = storedList != null
        ? Object.assign(repoListEmpty(), storedList, { phase: 'ready' })
        : Object.assign(repoListEmpty(), { phase: 'scanning' })
      bumpRepoList()
      callHost('git/repos', { sessionId: sessionId }).then(function (data) {
        adoptReposReply(sessionId, data)
      }).catch(function (failure) {
        /* 运输层断了（Host 重启中 callHost 自己会重试）才会走到这：记成失败，面板
           那一栏说「扫描失败」，而不是永远「正在扫描」。盘账不删 —— 没有答复说清
           单错了，Host 回来后下一次刷新垫底还有得上（chip 的分支名同一套规矩）。 */
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
      if (code === 'no-path') return '这个会话的工作区还没确定，先在面板的仓库说明页里填一个目录'
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
      /* config 这一格是配置页「本页在编辑哪个仓库」的：单选，但存的也是一维数组
         （setRepoSelection 的过滤与比较对它同样成立），所以不走第二套账。 */
      const fresh = { log: [], changes: [], config: [] }
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

    /* ── 同名仓库的短名：同一份清单，同一份标签 ──

       一个工作区里嵌两个同目录名的仓库（/a/b/d 和 /a/b/c/d）时，裸 basename 分不清
       谁是谁。规则按读路径的习惯来：路径最浅的那个保住裸名（d），其余向上补父目录、
       补到刚好不重名为止（c/d）；补完仍撞（/x/y/d 对 /z/y/d，第一层都是 y/d）就继续
       加段，加到整条路径为止 —— 两个仓库的完整路径不会相同，所以总有一步能停下来。

       标签的依据是**这份清单**（reposShown 那份，见下）而不是某个渲染点自己看到的
       几行：切换器行、分支分组头、变更分组头都从同一次 memo 里取，一个仓库在面板里
       只有一个短名。memo 按清单内容记 —— 清单只在扫描落地、手动增删时才变，重渲染
       不该重算。 */
    const repoLabelMemo = { key: null, map: null }

    function repoPathParts(path) {
      const trimmed = text(path).replace(/\/+$/, '')
      const body = trimmed.indexOf('/') === 0 ? trimmed.slice(1) : trimmed
      return body.length === 0 ? [] : body.split('/')
    }

    function computeRepoLabels(shown) {
      const partsOf = []
      const baseCount = {}
      for (let i = 0; i < shown.length; i += 1) {
        const parts = repoPathParts(shown[i])
        partsOf.push(parts)
        const base = parts.length > 0 ? parts[parts.length - 1] : text(shown[i])
        baseCount[base] = (baseCount[base] === undefined ? 0 : baseCount[base]) + 1
      }
      const labels = {}
      const taken = {}
      /* 不冲突的先定裸名；冲突的按 basename 归堆，堆内再排 —— 裸名只有堆里最浅的
         那个能保住，其余都在堆内扩展，所以跨堆的扩展名（总以别的 basename 结尾）不
         可能互相撞上，贪心地一个个定就够了。 */
      const conflicted = {}
      for (let i = 0; i < shown.length; i += 1) {
        const parts = partsOf[i]
        const base = parts.length > 0 ? parts[parts.length - 1] : text(shown[i])
        if (baseCount[base] === 1) {
          labels[shown[i]] = base
          taken[base] = true
        } else if (conflicted[base] === undefined) {
          conflicted[base] = [i]
        } else {
          conflicted[base].push(i)
        }
      }
      const names = Object.keys(conflicted)
      for (let c = 0; c < names.length; c += 1) {
        const base = names[c]
        const members = conflicted[base].slice()
        /* 浅的在前（保裸名的是它）；一样深时按路径排 —— 结果因此是确定的，清单
           没变，两次算出的标签就不会变。 */
        members.sort(function (a, b) {
          const byDepth = partsOf[a].length - partsOf[b].length
          if (byDepth !== 0) return byDepth
          return shown[a] < shown[b] ? -1 : (shown[a] > shown[b] ? 1 : 0)
        })
        labels[shown[members[0]]] = base
        taken[base] = true
        for (let m = 1; m < members.length; m += 1) {
          const parts = partsOf[members[m]]
          /* 兜底是整条路径：每一层都试过了还撞，就没有再可加的段了。 */
          let label = parts.join('/')
          for (let k = 1; k < parts.length; k += 1) {
            const candidate = parts.slice(parts.length - 1 - k).join('/')
            if (taken[candidate] !== true) { label = candidate; break }
          }
          labels[shown[members[m]]] = label
          taken[label] = true
        }
      }
      return labels
    }

    function repoLabelMap(shown) {
      const key = shown.join('\u0000')
      if (repoLabelMemo.key === key && repoLabelMemo.map != null) return repoLabelMemo.map
      const map = computeRepoLabels(shown)
      repoLabelMemo.key = key
      repoLabelMemo.map = map
      return map
    }

    /* 不在清单里的路径（missing 那几行、扫描落地前留下的旧选择）退回裸 basename：
       标签的依据是清单，清单里没有它，就没有「和谁冲突」可解。 */
    function repoShortName(labels, path) {
      const found = labels[text(path)]
      return found === undefined ? repoBaseName(path) : found
    }

    /* 切换器要画的那几行（也是「全部」的语义边界）：扫描结果 + 生效仓库兜底。生效
       仓库要种进去，因为扫描还没回来（或失败）时列表也得有它 —— 它是唯一确定存在
       的仓库，「切回主仓库」恰恰是最常用的那一格。 */
    function reposShown(list, effective) {
      const out = list.repos.slice()
      if (effective.length > 0 && out.indexOf(effective) < 0) out.push(effective)
      return out
    }

    /* ── 分组：把清单里的每个仓库归到且只归到一组 ──

       归组按「离仓库最近的登记容器」判，三步：
         a) 路径等于某个登记目录或是它的子孙（前缀 = 目录 + '/'；多组命中取最长
            前缀 —— 嵌套登记时里层的赢）→ 那个目录的组；
         b) 否则在会话工作区下 → 「工作区」组；
         c) 否则（工作区外的手动登记）→ 「手动登记」组。
       组序：工作区 → 登记目录（按路径排序）→ 手动登记。空组只丢伪组：登记目录组
       一个仓库都没扫到（仓库被跳过名单挡掉、超出每目录 head 封顶等）也要留 ——
       paths 给空数组，组头照画、× 照在，登记项才不会变成「界面上看不见也删不掉」
       的幽灵。两个伪组的键带一个路径里不可能出现的 \u0000 前缀，永远不和登记目录
       （真实路径）撞名。

       平铺与否由调用方按「list.dirs.length > 0 || 组数 > 1」判：没登记任何目录、
       仓库也全在工作区下（最常见的形态）照旧一张组头都不画 —— 零视觉回归的那条
       线；登记过目录就一定走分组，组头是登记项唯一的可见落点。 */
    const GROUP_WS_KEY = '\u0000ws'
    const GROUP_MANUAL_KEY = '\u0000manual'

    /* 分组用的路径比较统一先去尾斜杠：登记目录是读者手填的，「/a/b/」和「/a/b」
       得是同一个前缀；根目录去完变空串，回到「/」。与 Host 的 repoKeyOf 同一口径。 */
    function repoGroupPath(path) {
      const trimmed = text(path).replace(/\/+$/, '')
      return trimmed.length > 0 ? trimmed : '/'
    }

    function repoGroupUnder(path, root) {
      if (root === '/') return true
      return path === root || path.indexOf(root + '/') === 0
    }

    function repoGroupsOf(workspace, list, shown) {
      const dirs = (Array.isArray(list.dirs) ? list.dirs : []).map(repoGroupPath)
      dirs.sort()
      const ws = repoGroupPath(workspace)
      const order = [GROUP_WS_KEY].concat(dirs).concat([GROUP_MANUAL_KEY])
      const buckets = {}
      for (let i = 0; i < order.length; i += 1) buckets[order[i]] = []
      for (let i = 0; i < shown.length; i += 1) {
        const path = repoGroupPath(shown[i])
        let best = ''
        let bestLen = -1
        for (let d = 0; d < dirs.length; d += 1) {
          if (repoGroupUnder(path, dirs[d]) && dirs[d].length > bestLen) { bestLen = dirs[d].length; best = dirs[d] }
        }
        if (bestLen >= 0) { buckets[best].push(shown[i]); continue }
        if (workspace.length > 0 && repoGroupUnder(path, ws)) { buckets[GROUP_WS_KEY].push(shown[i]); continue }
        buckets[GROUP_MANUAL_KEY].push(shown[i])
      }
      const out = []
      for (let i = 0; i < order.length; i += 1) {
        const key = order[i]
        const pseudo = key === GROUP_WS_KEY || key === GROUP_MANUAL_KEY
        /* 只丢伪组的空桶：伪组（工作区/手动登记）是分组的衍生物、不是登记项，空了
           没有可画的；登记目录组空了也留 —— 组头是登记项在界面上唯一的落点。 */
        if (pseudo && buckets[key].length === 0) continue
        out.push({
          key: key,
          /* 伪组（工作区/手动登记）dir 记 null：组头不按路径取名、也不带 ×。 */
          dir: pseudo ? null : key,
          paths: buckets[key],
        })
      }
      return out
    }

    /* props: sessionId、pane（'log'|'changes' 多选模式；'config' 受控单选）、
       list（repoListFor 的那份）、effective（当前生效仓库路径；种进行当第一行之后的行）、
       pick（受控单选才给：本页正在编辑的仓库路径。给了它，单击行 = 换编辑目标，
       不碰多选也不给「全部」；不给 = 两块侧栏的多选模式，行为与从前一字不差）、
       onSingle(path)、onAll()、onAdd(path)→Promise、onRemove(path)→Promise */
    function RepoSwitcher(props) {
      const sessionId = props.sessionId
      const pane = props.pane
      const list = props.list
      const effective = text(props.effective)
      /* 受控单选（配置页在用）：选择态不住 repoViews 的多选账里，由调用方把 pick
         传进来 —— 单击行只换本页的编辑目标，绝不改生效仓库。两块侧栏不传 pick，
         走原来的多选。 */
      const picking = props.pick !== undefined
      const picked = text(props.pick)
      const shown = reposShown(list, effective)
      /* 同名仓库的短名（上面的 memo）：这一栏画行用它，两处分组头（50-log.js、
         54-changes.js）按同一份清单取同一个 map —— 一个仓库在面板里只有一个短名。 */
      const labels = repoLabelMap(shown)
      const selection = picking
        ? (picked.length > 0 ? [picked] : [])
        : repoSelection(sessionId, pane).filter(function (path) {
          return shown.indexOf(path) >= 0 || list.missing.indexOf(path) >= 0
        })
      const allOn = selection.length >= shown.length && shown.length > 0
      const [adding, setAdding] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [problem, setProblem] = React.useState('')
      /* 折叠只收起这一块的行，不碰任何仓库选择，跟着组件挂载走（换会话面板重挂、
         折叠复位）就够了 —— 存模块层反而要在换工作区时多清一份。 */
      const [folded, setFolded] = React.useState(false)

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
      /* 标题行就是折叠开关，也是折叠后唯一剩下的一行。收起后中间那格记谁分模式：
         多选（log/changes）照旧记生效仓库（●，和行里同一个记号）—— 收起来了也知
         道面板在哪个仓库上；受控单选（配置页）记**本页编辑目标**（✎）—— 这一格在
         配置页的语义是「本页在编辑哪个」，写的是上面选中的仓库，不是生效仓库；目标
         还没读到（picked 还是空串）就不记。 */
      /* 收起时标题行要挂的那格「现在在哪」：见上面的说明 —— 记号分模式（● / ✎）。 */
      const foldNow = picking
        ? (folded && picked.length > 0
          ? h('span', { key: 'now', className: 'dsh-git-repo-now', title: picked + '\n本页正在编辑的仓库（提交身份、远端、换行符都改它；不改生效仓库）' },
            '✎ ' + repoShortName(labels, picked))
          : null)
        : (folded && effective.length > 0
          ? h('span', { key: 'now', className: 'dsh-git-repo-now', title: effective + '\n当前生效仓库' },
            '● ' + repoShortName(labels, effective))
          : null)
      rows.push(h('div', {
        key: 'repo-head',
        className: 'dsh-git-repo-head',
        title: folded ? '展开仓库列表' : '收起仓库列表（' + (picking ? '本页正在编辑的仓库' : '当前生效仓库') + '仍显示在标题行）',
        onClick: function () { setFolded(!folded) },
      },
        h('span', { key: 'c', className: 'dsh-git-repo-caret' + (folded ? ' dsh-git-repo-caret-off' : '') },
          h(Icon, { name: 'down', size: 10 })),
        h('span', { key: 'i', className: 'dsh-git-repo-head-ico' }, h(Icon, { name: 'repo', size: 12 })),
        h('span', { key: 't', className: 'dsh-git-repo-head-name' }, '仓库 ' + String(shown.length)),
        foldNow,
        list.phase === 'scanning' || list.phase === 'idle'
          ? h('span', { key: 's', className: 'dsh-git-repo-note' }, '正在扫描…')
          : (list.phase === 'failed'
            ? h('span', { key: 'f', className: 'dsh-git-repo-note' }, '扫描失败')
            : (list.note.length > 0 ? h('span', { key: 'n', className: 'dsh-git-repo-note', title: list.note }, '…') : null))))

      if (folded) return h('div', { className: 'dsh-git-repo-box' }, rows)

      /* 「全部」在列表最前面。单击和 Ctrl+单击都是全选语义（需求如此：多选时再点
         「全部」就是全选）；它永远不改生效仓库 —— 生效仓库只跟某个仓库行的单击走。
         受控单选没有「一起看」的形态（配置一次只写得了一个仓库），整行不给。 */
      if (!picking) rows.push(h('div', {
        key: 'repo-all',
        className: 'dsh-git-repo-row' + (allOn ? ' dsh-git-repo-sel' : ''),
        title: '一起显示列表里所有仓库' + (pane === 'log' ? '的分支' : '的变更')
          + '（Ctrl+单击仓库行可以只挑几个；不改变当前生效仓库）',
        onClick: function () { props.onAll() },
      },
        h('span', { key: 'm', className: 'dsh-git-repo-mark' }),
        /* 图标列空着占位：「全部」不是仓库，不配仓库图标，但名字要和下面仓库行的
           名字对齐成一列。 */
        h('span', { key: 'g', className: 'dsh-git-repo-glyph' }),
        h('span', { key: 'n', className: 'dsh-git-repo-name' }, '全部'),
        h('span', { key: 'c', className: 'dsh-git-repo-dim' }, String(shown.length))))

      /* 一行仓库的画法抽成一个局部函数：平铺与分组两条路径共用同一份行构造，
         行本身的行为（点选、Ctrl 多选、wt 小标、× 删除）与从前一字不差。 */
      const repoRowEl = function (path) {
        const isCur = path === effective
        const picked = selection.indexOf(path) >= 0
        const manual = list.manual.indexOf(path) >= 0
        /* .git 是文件的仓库（worktree / 子模块）：名字旁一枚暗色「wt」小标 —— 它
            不是独立仓库，配置它的提交身份/远端会改到链接那头的版本库，扫一眼分得清。
            missing 行（目录已不在）不加：那一行说的已经是另一件事。 */
        const linked = list.links.indexOf(path) >= 0
        return h('div', {
          key: 'repo:' + path,
          className: 'dsh-git-repo-row'
            + (isCur ? ' dsh-git-repo-cur' : '')
            + (picked ? ' dsh-git-repo-sel' : ''),
          title: path + (isCur ? '\n当前生效仓库：历史、提交、推送都作用在这里' : '')
            + (linked ? '\n.git 是链接文件（git worktree 或子模块）' : '')
            + (picking
              ? '\n单击 = 选中为本页正在编辑的仓库（提交身份、远端、换行符都改它；不改生效仓库）'
              : '\n单击 = 切换为生效仓库；Ctrl+单击 = 加入/移出多选'),
          onClick: function (event) {
            if (picking) { props.onSingle(path); return }
            if (event != null && (event.ctrlKey === true || event.metaKey === true)) {
              toggleRepoSelection(sessionId, pane, path)
              return
            }
            props.onSingle(path)
          },
        },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }, isCur ? '●' : ''),
          h('span', { key: 'g', className: 'dsh-git-repo-glyph' }, h(Icon, { name: 'repo', size: 12 })),
          h('span', { key: 'n', className: 'dsh-git-repo-name' }, repoShortName(labels, path)),
          linked ? h('span', {
            key: 'wt', className: 'dsh-git-repo-wt',
            title: '.git 是链接文件（git worktree 或子模块）',
          }, 'wt') : null,
          manual ? h('button', {
            key: 'x', type: 'button', className: 'dsh-git-repo-x',
            title: '从列表移除（手动登记的仓库才能移除）',
            onClick: function (event) { stopEvent(event); removeOne(path) },
          }, '×') : null)
      }

      /* 组头行：压暗小字 + 文件夹图标 + 短名（title=完整路径）。登记目录的组头是
         持久登记项，带一枚 × 就地可移除 —— 走的还是 git/repos-save 的 remove，
         Host 会从两份清单里幂等地删；「工作区」「手动登记」只是分组的衍生物、不是
         登记项，组头不带 ×。 */
      const groupHeadEl = function (group) {
        const isDir = group.dir !== null
        const isWs = group.key === GROUP_WS_KEY
        return h('div', {
          key: 'ghead:' + group.key,
          className: 'dsh-git-repo-ghead',
          title: isDir ? group.dir
            : (isWs ? workspaceOf(sessionId) : '工作区之外手动登记的仓库'),
        },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }),
          h('span', { key: 'g', className: 'dsh-git-repo-glyph' }, h(Icon, { name: 'folder', size: 11 })),
          h('span', { key: 'n', className: 'dsh-git-repo-gname' },
            isDir ? repoBaseName(group.dir) : (isWs ? '工作区' : '手动登记')),
          isDir ? h('button', {
            key: 'x', type: 'button', className: 'dsh-git-repo-x',
            title: '移除这个登记目录（分组随之取消；手动登记过的仓库不受影响）',
            onClick: function (event) { stopEvent(event); removeOne(group.dir) },
          }, '×') : null)
      }

      /* 登记目录组一个仓库都没扫到时的占位行：压暗一句说明，不是仓库行 —— 没有
         onClick、没有 ×（移除登记走组头那枚），样式也不给手型与 hover
         （.dsh-git-repo-gempty）。没有它，「目录登记了但仓库没扫到」就只剩组头
         孤零零一行，读者分不清底下是空的还是漏画的。 */
      const groupEmptyEl = function (group) {
        return h('div', {
          key: 'gempty:' + group.key,
          className: 'dsh-git-repo-gempty',
          title: group.dir + '\n这个登记目录下没扫到 git 仓库（可能被扫描跳过名单挡掉，或超出数量上限）',
        },
          h('span', { key: 'm', className: 'dsh-git-repo-mark' }),
          h('span', { key: 'g', className: 'dsh-git-repo-glyph' }),
          h('span', { key: 'n', className: 'dsh-git-repo-name' }, '没扫到仓库'))
      }

      /* 平铺还是分组：登记过「含仓库目录」就走分组 —— 组头是登记项在界面上唯一的
         落点，一个仓库都没扫到时它也必须画得出来（空组组头底下跟一行压暗的占位，
         见 groupEmptyEl）；没登记目录时与从前同一条线：两组起才出现组头，≤1 组
         照旧平铺、一字不差（零视觉回归）。组内行的顺序仍是清单本身的顺序。 */
      const groups = repoGroupsOf(workspaceOf(sessionId), list, shown)
      if (list.dirs.length > 0 || groups.length > 1) {
        for (let g = 0; g < groups.length; g += 1) {
          rows.push(groupHeadEl(groups[g]))
          const paths = groups[g].paths
          if (paths.length === 0) { rows.push(groupEmptyEl(groups[g])); continue }
          for (let i = 0; i < paths.length; i += 1) rows.push(repoRowEl(paths[i]))
        }
      } else {
        for (let i = 0; i < shown.length; i += 1) rows.push(repoRowEl(shown[i]))
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
          h('span', { key: 'g', className: 'dsh-git-repo-glyph' }, h(Icon, { name: 'repo', size: 12 })),
          h('span', { key: 'n', className: 'dsh-git-repo-name' }, repoShortName(labels, path)),
          h('span', { key: 'gone', className: 'dsh-git-repo-dim' }, '已不存在'),
          h('span', {
            key: 'x', className: 'dsh-git-repo-x', title: '从列表移除',
            onClick: function (event) { stopEvent(event); removeOne(path) },
          }, '×')))
      }

      rows.push(adding
        ? h('div', { key: 'repo-add-row', className: 'dsh-git-repo-addrow' },
            h('input', {
              key: 'i', className: 'dsh-git-repo-input', autoFocus: true,
              placeholder: '仓库或含仓库的目录，绝对路径',
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
            key: 'repo-add', className: 'dsh-git-repo-add', title: '把一个 git 仓库、或一个里面嵌着仓库的目录加进这个项目的列表（持久保存；目录自己不必是仓库）',
            onClick: function () { setAdding(true); setProblem('') },
          },
            h('span', { key: 'p', className: 'dsh-git-repo-mark' }, '＋'),
            h('span', { key: 'n', className: 'dsh-git-repo-name dsh-git-dim' }, '添加目录')))

      if (problem.length > 0) {
        rows.push(h('div', { key: 'repo-problem', className: 'dsh-git-repo-problem' }, problem))
      }
      /* 整块收进一个容器（.dsh-git-repo-box，46-css.js）：仓库行和下面分支树的行
         原来是同一种平铺行，读者分不出「上面在切仓库、下面在看分支」。 */
      return h('div', { className: 'dsh-git-repo-box' }, rows)
    }
