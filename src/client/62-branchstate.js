    function stopEvent(event) {
      if (event != null && typeof event.stopPropagation === 'function') event.stopPropagation()
    }

    /* The switcher, shared by the panel header's branch chip and the card the
       composer chip opens on hover. Same list, same keys, same rescue: they
       answer the same question, and only where they hang and whether they take
       focus differ.

       Hover mode never focuses its filter. Taking the caret out of the composer
       because a pointer crossed the toolbar would be worse than clicking the box
       yourself, so the card stays passive until it is clicked. */
    /* The last branch list per repository, held here as well as in the Host's
       cache. Opening the card must not show an empty list while a read the Host
       can answer in no time is in flight: the remembered list paints on the
       first frame and the fresh one replaces it a few milliseconds later, which
       is the difference between "waited for it" and "it was already there". */
    const branchCache = {}
    function rememberBranches(repo, data) {
      if (data == null || data.ok !== true) return
      branchCache[repo] = data
      /* 盘账跟着落一份（下面那层的同一条 LRU）：刷新后内存账全空时，分支卡首帧
         有得上次的列表。localStorage 拒绝时只留内存，与持久化层出现之前一字不差。 */
      if (repo == null || repo.length === 0) return
      const stored = branchListsStoredMap()
      if (stored === null) return
      delete stored[repo]
      stored[repo] = { data: data, at: Date.now() }
      const keys = Object.keys(stored)
      for (let i = 0; i < keys.length - BRANCH_LISTS_MAX; i += 1) delete stored[keys[i]]
      writeStoredJSON(BRANCH_LISTS_KEY, stored)
    }

    /* ── 分支列表的持久化：localStorage 一层垫底账 ──

       branchCache 纯内存，刷新后悬停卡片／面板的分支列表首帧只能画 null，要等
       git/branches 回来才有内容。同一套先例再垫一层：localStorage 一个 JSON 键存
       { [repo]: { data, at } }，data=git/branches 的 ok 答复原样，at=写入时刻；
       懒加载一次、读入逐条清洗（畸形条目丢弃）、LRU 上限 20 个仓库（先删再插队尾，
       队首淘汰）、localStorage 不可用时静默只留内存、写失败吞掉。不设 TTL ——
       正确性同样来自「新答复必到」，盘账只承担「首帧不空」。

       两条铁律（违背任何一条就是让旧账冒充新账）：
       - prefetchBranches 的守卫只认内存新账（branchCache[repo] !== undefined 才
         跳过）—— 盘上有没有这份账，挂载即预取都照发，「新答复必到」不因盘账
         存在而被省掉。
       - restoreBranches 是纯读：只服务「画」（BranchPicker 首帧 state 的垫底），
         绝不把盘账写回 branchCache —— 写回去就等于让预取跳过。 */
    const BRANCH_LISTS_KEY = 'dsh.git-idea.branch-lists'
    const BRANCH_LISTS_MAX = 20
    let branchListsStored = null

    function branchListsStoredMap() {
      if (branchListsStored !== null) return branchListsStored
      if (localStore(null) == null) return null
      const parsed = readStoredJSON(BRANCH_LISTS_KEY, null)
      const clean = {}
      if (parsed != null && typeof parsed === 'object') {
        const keys = Object.keys(parsed)
        for (let i = 0; i < keys.length; i += 1) {
          const value = parsed[keys[i]]
          /* 清洗：键（仓库绝对路径）非空，data 必须是 ok:true 的答复。畸形条目
             （别的版本、手改、半截）就当没这条，绝不把别的东西喂给列表画。 */
          if (keys[i].length === 0 || value == null || typeof value !== 'object') continue
          if (value.data == null || typeof value.data !== 'object' || value.data.ok !== true) continue
          clean[keys[i]] = {
            data: value.data,
            at: typeof value.at === 'number' && isFinite(value.at) ? value.at : 0,
          }
        }
      }
      branchListsStored = clean
      return branchListsStored
    }

    /* 首帧垫底的纯读：内存新账优先由调用方先判（BranchPicker 的 useState），
       内存没有才走到这里查盘账。不写内存、不写盘、不拦读 —— 挂载后那一次
       git/branches 照发，答复一到 setData 整个盖掉。 */
    function restoreBranches(repo) {
      if (repo == null || repo.length === 0) return null
      const stored = branchListsStoredMap()
      const hit = stored !== null ? stored[repo] : undefined
      return hit != null && hit.data != null ? hit.data : null
    }

    /* The hash the reader picked, mirrored outside React because the history read
       has to know it without depending on it: a dependency on the selection would
       make every click re-read the graph, and reading the state from the effect's
       closure would let an in-flight read undo a click that landed meanwhile. */
    let pickedCommit = ''
    let pickerInputNode = null
    let pickerList = null
    let flyTimer = null
    /* Opening waits so a pointer dragged down the list does not flash a panel at
       every row; closing waits so the trip from the row into the panel, which
       hangs just past the card's edge, does not dismiss it. */
    const FLY_OPEN_MS = 120
    const FLY_CLOSE_MS = 220
    function clearFlyTimer() {
      if (flyTimer != null) { flyTimer(); flyTimer = null }
    }
    /* Everything the composer chip knows is per SESSION, not global: switching
       workspaces used to leave the previous one's repository and branch count on
       screen until the next read came back, which is exactly the lag you feel
       when you switch. */
    const chipInfos = {}
    const chipLabels = {}
    function chipInfoFor(sessionId) {
      const found = chipInfos[sessionId]
      return found !== undefined ? found : { repo: '', pending: 0 }
    }
    function chipLabelFor(sessionId) {
      const found = chipLabels[sessionId]
      if (found !== undefined) return found
      /* 内存没有这一格（刷新后必然如此）：查盘账垫底。查到就把缓存条目还原成
         chipLabel 的形状 —— phase 直接到 'repo'，pending 恒 0（改动数不从缓存画：
         known 由页内 treeRecord 决定，刷新后自动如实显示「正在核对改动…」）。
         盘账绝不写回内存账：内存账仍是运行期的唯一真账，apply 的答复一到就整个
         盖掉，这里的回落只决定「快读回来之前那几帧画什么」。 */
      const stored = chipLabelsStoredMap()
      const hit = stored !== null && sessionId !== undefined && sessionId !== null ? stored[sessionId] : undefined
      if (hit != null) {
        return {
          phase: 'repo',
          label: hit.label,
          pending: 0,
          ahead: hit.ahead,
          behind: hit.behind,
          repo: hit.repo,
          reason: '',
        }
      }
      return { phase: 'loading', label: null, pending: 0, repo: '', reason: '' }
    }

    /* ── chip 分支名的持久化：localStorage 一层垫底账 ──

       chipLabels 是内存账，每次刷新页面都从零开始，分支名要等挂载快读回来才有
       （通道忙时是好几秒），chip 上就一直空着。照 10-state.js 生效仓库
       （dsh.git-idea.applied-repos）的同一条先例：localStorage 一个 JSON 键存
       { [sessionId]: { label, repo, ahead, behind, at } }，label=分支短名
       （detached 存 'HEAD'），at=写入时刻；懒加载一次、读入逐条清洗、LRU 上限
       50（先删再插队尾，队首淘汰）、localStorage 不可用时静默只留内存、写失败
       吞掉。刷新后首帧内存无账就按它画上次的分支名，快读回来照旧被新答复覆盖。

       这层盘账的刷新机制，五条说全：
       1. 写：身份快读每次成功 apply 覆写该会话条目（92-chip.js 的 storedChipLabelPut
          调用点，唯一写入点）；ahead/behind 随标签一起入库 —— 属同一次身份读，
          是「先画、马上被快读纠正」的显示垫底。改动数不进缓存。
       2. 读：只服务「画」（chipLabelFor 的回落），不拦读、不省读 —— 挂载快读每次
          刷新照发，缓存永不跳过、永不阻塞任何读。
       3. 触发器全部沿用现状：挂载快读、watcher 推送 bumpData、切换/提交后的 bump、
          会话完成那一刷 —— 不加任何新轮询、新定时器。
       4. 失效：apply 的 ok!==true 分支删该会话条目并落盘（仓库没了/读不动了不许在
          下一次刷新还魂）；读入清洗畸形条目；localStorage 拒绝时只留内存。
       5. 不设 TTL：分支名不腐坏（applied-repos 先例不设过期），LRU 上限防无界；
          正确性靠「新答复必到」，盘账只承担「首帧不空」。 */
    const CHIP_LABELS_KEY = 'dsh.git-idea.chip-labels'
    /* 上限 50 个会话：与 applied-repos 同一款 —— 这个键跟着浏览器走一辈子，不设
       上限的话经年攒下的旧会话 id 就永远躺在里面。 */
    const CHIP_LABELS_MAX = 50
    let chipLabelsStored = null

    /* 懒加载一次：第一次用到才碰 localStorage，之后以内存这份为准（反复解析同一
       份 JSON 没有必要）。store 拿不到（还没人交 doc、或 localStorage 被私隐模式
       拒了）回 null —— 调用方各自回落到内存账，与持久化层出现之前的行为一字不差。 */
    function chipLabelsStoredMap() {
      if (chipLabelsStored !== null) return chipLabelsStored
      if (localStore(null) == null) return null
      const parsed = readStoredJSON(CHIP_LABELS_KEY, null)
      const clean = {}
      if (parsed != null && typeof parsed === 'object') {
        const keys = Object.keys(parsed)
        for (let i = 0; i < keys.length; i += 1) {
          const value = parsed[keys[i]]
          /* 读入时清洗：键非空、label 与 repo 都得是非空字符串；ahead/behind/at
             只收有限数，缺了或畸形当 0。localStorage 是谁都能写的一块地，畸形账
             （别的版本、手改、半截）就当没这条，绝不把别的东西喂给 chip 画。 */
          if (keys[i].length === 0 || value == null || typeof value !== 'object') continue
          if (typeof value.label !== 'string' || value.label.length === 0) continue
          if (typeof value.repo !== 'string' || value.repo.length === 0) continue
          clean[keys[i]] = {
            label: value.label,
            repo: value.repo,
            ahead: typeof value.ahead === 'number' && isFinite(value.ahead) ? value.ahead : 0,
            behind: typeof value.behind === 'number' && isFinite(value.behind) ? value.behind : 0,
            at: typeof value.at === 'number' && isFinite(value.at) ? value.at : 0,
          }
        }
      }
      chipLabelsStored = clean
      return chipLabelsStored
    }

    /* 交给 doc 并当场把账读进来：chip 每页必挂、又比面板早，挂载 effect 里调它
       （92-chip.js），随后的 setInfo(chipLabelFor(...)) 走的就是已载入的账。 */
    function loadChipLabels(doc) {
      localStore(doc)
      chipLabelsStoredMap()
    }

    /* 盘账的写入（apply 每次成功都要它）：LRU 语义与 storedAppliedPut 同一条 ——
       先删再插队尾（普通对象的键序就是「最近使用」序），淘汰永远从队首开始。
       localStorage 拒绝时静默只留内存，与持久化层出现之前一字不差。 */
    function storedChipLabelPut(sessionId, label, repo, ahead, behind) {
      if (sessionId === undefined || sessionId === null) return
      const stored = chipLabelsStoredMap()
      if (stored === null) return
      delete stored[sessionId]
      stored[sessionId] = { label: label, repo: repo, ahead: ahead, behind: behind, at: Date.now() }
      const keys = Object.keys(stored)
      for (let i = 0; i < keys.length - CHIP_LABELS_MAX; i += 1) delete stored[keys[i]]
      writeStoredJSON(CHIP_LABELS_KEY, stored)
    }

    /* 盘账的失效（apply 的 ok!==true 分支）：删该会话条目并落盘。没有这一格就
       不白写一次盘 —— 大多数会话的大多数时候读到的是成功答复。 */
    function storedChipLabelDrop(sessionId) {
      if (sessionId === undefined || sessionId === null) return
      const stored = chipLabelsStoredMap()
      if (stored === null) return
      if (stored[sessionId] === undefined) return
      delete stored[sessionId]
      writeStoredJSON(CHIP_LABELS_KEY, stored)
    }
    /* One read per repository, and only until it lands: the chip warms the
       switcher's list so the first hover paints from memory instead of from a
       round trip. */
    const branchPrefetching = {}
    function prefetchBranches(sessionId, repo) {
      if (repo == null || repo.length === 0) return
      if (branchCache[repo] !== undefined || branchPrefetching[repo] === true) return
      branchPrefetching[repo] = true
      callHost('git/branches', { sessionId: sessionId, repo: repo }).then(function (list) {
        branchPrefetching[repo] = false
        rememberBranches(repo, list)
      }).catch(function () { branchPrefetching[repo] = false })
    }

