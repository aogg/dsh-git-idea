    /* ── 历史页左栏三份列表的 localStorage 垫底账（62-branchstate.js 同款先例的通用化）──

       分支树（git/refs）、worktree 列表（git/worktrees）、仓库清单（git/repos）与
       chip 的分支名/分支列表是同一类账：内存里的 React state / 模块账每次刷新都从
       零开始，首帧只能画「空 / 正在扫描」，要等答复回来才有内容。这里把 62 里那两
       层手写的「localStorage 一格 JSON + 懒加载一次 + 读入清洗 + LRU + 写失败吞掉」
       提炼成一个小工厂 createStoredListLayer，三份列表各立一层（62 已有的两层不回
       头重构，测试已钉住它们）：

         · dsh.git-idea.refs-tree   按仓库路径存 git/refs 的 ok 答复原样，LRU 10；
         · dsh.git-idea.worktrees   按仓库路径存 git/worktrees 的 ok 答复原样，LRU 10；
         · dsh.git-idea.repo-lists  按会话 id 存 git/repos 规范化后的清单，LRU 50。

       存储形状三层一致：{ [键]: { data, at } }，data=答复/清单本体，at=写入时刻。
       与先例相同的铁律一条不少：懒加载一次、读入逐条清洗（畸形条目丢弃）、LRU 先
       删再插队尾、队首淘汰、localStorage 拿不到 / 写失败静默只留内存、不设 TTL。
       正确性来源仍是「新答复必到」—— 读盘账的地方照发 RPC（不拦读、不省读），答
       复一到整个盖掉，盘账只承担「首帧不空」。

       本层还多做半件事（内容级去重，「有变化才」的前端半边）：put 先和盘上现账比
       内容，一致就不落盘；各接入点的答复也先和内存现账比内容，一致就不 setState
       —— WS 推送面维持原样（宿主 79-live-watch.js 本来就只在仓库签名变化时才广播
       repo-changed），这里保证同一份内容反复读回来时不再引发重画与无谓写盘。 */
    function createStoredListLayer(key, cap, sanitize) {
      let map = null
      /* 懒加载一次：第一次用到才碰 localStorage，之后以内存这份为准（反复解析同一
         份 JSON 没有必要）。store 拿不到（doc 还没交接、或 localStorage 被私隐模式
         拒了）回 null —— 调用方各自回落到内存账，与持久化层出现之前一字不差。 */
      function readMap() {
        if (map !== null) return map
        if (localStore(null) == null) return null
        const parsed = readStoredJSON(key, null)
        const clean = {}
        if (parsed != null && typeof parsed === 'object') {
          const keys = Object.keys(parsed)
          for (let i = 0; i < keys.length; i += 1) {
            const value = sanitize(parsed[keys[i]])
            if (value != null) clean[keys[i]] = value
          }
        }
        map = clean
        return map
      }
      /* 交给 doc 并当场把账读进来（loadChipLabels 同一条先例）：挂载 effect 里调它，
         随后的首帧垫底读就能命中。 */
      function load(doc) {
        localStore(doc)
        readMap()
      }
      /* 纯读：只服务「画」（首帧垫底），不写内存、不写盘、不拦读。 */
      function get(name) {
        if (name == null || typeof name !== 'string' || name.length === 0) return null
        const stored = readMap()
        const hit = stored !== null ? stored[name] : undefined
        return hit != null && hit.data != null ? hit.data : null
      }
      /* 写入（LRU：先删再插队尾，普通对象的键序就是「最近使用」序，淘汰从队首开
         始）。内容级去重在这里收口：和盘上现账逐字比，一致就不写盘 —— 连 LRU 位置
         都不动（盘不是竞争资源，少一次序列化就少一次）。 */
      function put(name, data) {
        if (name == null || typeof name !== 'string' || name.length === 0 || data == null) return
        const stored = readMap()
        if (stored === null) return
        const existing = stored[name]
        if (existing != null && existing.data != null && sameStoredJSON(existing.data, data)) return
        delete stored[name]
        stored[name] = { data: data, at: Date.now() }
        const keys = Object.keys(stored)
        for (let i = 0; i < keys.length - cap; i += 1) delete stored[keys[i]]
        writeStoredJSON(key, stored)
      }
      /* 失效（答复 ok!==true 时调用）：删该条并落盘；没有这一格就不白写一次盘。 */
      function drop(name) {
        if (name == null || typeof name !== 'string' || name.length === 0) return
        const stored = readMap()
        if (stored === null) return
        if (stored[name] === undefined) return
        delete stored[name]
        writeStoredJSON(key, stored)
      }
      return { load: load, get: get, put: put, drop: drop }
    }

    /* 内容比较：两边都是「宿主答复原样」的已解析 JSON（内存一份来自 RPC、盘上一份
       来自 localStorage），宿主按同样的键序构造答复、JSON 序列化保序，逐字比较因此
       是可靠的 —— 比逐字段枚举少一张「新加字段忘了比」的清单要养。 */
    function sameStoredJSON(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /* ── 三层各自的读入清洗 ──

       清洗即读入的合同：条目必须是「ok:true 且该有数组的字段真是数组」的答复 ——
       localStorage 是谁都能写的一块地，畸形账（别的版本、手改、半截）就当没这条，
       绝不把别的东西喂给列表画。repo-lists 的其余字段缺省空（旧版本答复缺 links
       时行上不画小标，一切照旧）。 */
    function sanitizeRefsStoredEntry(value) {
      if (value == null || typeof value !== 'object') return null
      const data = value.data
      if (data == null || typeof data !== 'object' || data.ok !== true) return null
      if (!Array.isArray(data.current) || !Array.isArray(data.local) || !Array.isArray(data.remote)) return null
      return { data: data, at: typeof value.at === 'number' && isFinite(value.at) ? value.at : 0 }
    }

    function sanitizeWorktreesStoredEntry(value) {
      if (value == null || typeof value !== 'object') return null
      const data = value.data
      if (data == null || typeof data !== 'object' || data.ok !== true) return null
      if (!Array.isArray(data.worktrees)) return null
      return { data: data, at: typeof value.at === 'number' && isFinite(value.at) ? value.at : 0 }
    }

    function sanitizeRepoListStoredEntry(value) {
      if (value == null || typeof value !== 'object') return null
      const data = value.data
      if (data == null || typeof data !== 'object' || !Array.isArray(data.repos)) return null
      return {
        data: {
          repos: data.repos.map(text),
          manual: Array.isArray(data.manual) ? data.manual.map(text) : [],
          missing: Array.isArray(data.missing) ? data.missing.map(text) : [],
          links: Array.isArray(data.links) ? data.links.map(text) : [],
          note: typeof data.note === 'string' ? data.note : '',
        },
        at: typeof value.at === 'number' && isFinite(value.at) ? value.at : 0,
      }
    }

    const refsTreeStored = createStoredListLayer('dsh.git-idea.refs-tree', 10, sanitizeRefsStoredEntry)
    const worktreesStored = createStoredListLayer('dsh.git-idea.worktrees', 10, sanitizeWorktreesStoredEntry)
    const repoListsStored = createStoredListLayer('dsh.git-idea.repo-lists', 50, sanitizeRepoListStoredEntry)

    /* 仓库清单的内容比较：字段投影后逐字比（内存账上还有 phase 一格，不参与 ——
       它说的是「这份账可不可信」，不是清单内容）。 */
    function storedRepoListFieldsSame(a, b) {
      return sameStoredJSON(
        { repos: a.repos, manual: a.manual, missing: a.missing, links: a.links, note: a.note },
        { repos: b.repos, manual: b.manual, missing: b.missing, links: b.links, note: b.note })
    }

    /* 面板挂载时把三层的账一次读进来（80-panel.js 的挂载 effect，loadAppliedRepos
       同一排）：doc 交接 + 懒加载，随后的首帧垫底读就能命中。 */
    function loadStoredLists(doc) {
      refsTreeStored.load(doc)
      worktreesStored.load(doc)
      repoListsStored.load(doc)
    }
