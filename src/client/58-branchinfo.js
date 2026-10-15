    /* git puts what is worth reading in stderr for one command and stdout for
       the next — `switch` narrates itself on stderr while a conflicting
       `stash pop` narrates the merge on stdout — so callers show whichever has
       something in it rather than picking one and showing nothing. */
    function commandDetail(result) {
      if (result == null) return ''
      /* 和下面沙箱那条同一类：失败的原因不在仓库里，而在机器上。这次 git 一个字
         都没说 —— 它根本没被启动 —— 所以这里给整句话，不留 bash 的原话：原话是
         `bash: git: command not found`，而读者已经从上面那行知道这件事了。 */
      if (result.noGit === true) {
        return '这台机器上找不到 git：面板读它、改它都要调用 git。'
          + '装上 git，或让它出现在 dsh 进程的 PATH 里，再试一次。'
      }
      const err = text(result.stderr).replace(/\s+$/, '')
      const detail = err.length > 0 ? err.slice(0, 400) : text(result.stdout).replace(/\s+$/, '').slice(0, 400)
      /* git 在这件事上说八行，其中七行是建议（"Run git config --global ..."），最后
         一行才是拒绝本身。这里说的是同一件事，但先说面板里能点的那个地方（配置页
         全局那一档的提交身份），再给能照抄的命令 —— 两条路都留着，因为面板并不总是
         开着的。 */
      if (result.needsIdentity === true) {
        const lines = err.length > 0 ? err.split('\n') : []
        let last = ''
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          if (lines[i].trim().length > 0) { last = lines[i].trim(); break }
        }
        const why = 'git 不知道这次提交该署谁的名字，所以把它拒了 —— 作者身份写在 git 的配置里，'
          + '不在这个仓库里。面板「配置 → 全局配置 → 提交身份」里可以填，'
          + '或者在终端里跑一遍：\n'
          + '  git config --global user.name "你的名字"\n'
          + '  git config --global user.email "你的邮箱"\n'
          + '不加 --global 只对这个仓库生效。'
        /* git 的原话照旧留在下面一行：身份缺失是这次提交过不去的一道坎，但不一定是
           唯一一道 —— 一个失败的钩子、一次没解决的冲突各自另有话说，把那句话丢掉就是
           同一类误诊（"这台机器上没有 git" 曾经也这样盖掉过真正的答案）。 */
        return last.length > 0 ? why + '\n' + last : why
      }
      /* pull 在没有 upstream 的分支上的拒绝（"There is no tracking information for
          the current branch" / "no upstream configured for branch"）。正常情况下面板
          点 pull 时已经先把这一步做完（同名远端分支自动绑定、没有就弹选择层），这句
          只在 refs 数据过期之类的缝隙里漏出来 —— 说人话并指出路，git 的原话照旧留下。
          与上面沙箱那条同一类：先接住结果，再判一次可修复的失败，最后才是原样转述。 */
      if (/no tracking information|no upstream configured/.test(err + '\n' + text(result.stdout))) {
        const why = '这个分支还没有上游：pull 不知道要跟哪个远端分支比较。'
          + '面板点「拉取」时会先尝试绑定同名远端分支；也可以在分支卡（点分支名出来的卡片）里点 ↓ 选一个远端分支来绑定。'
        return detail.length > 0 ? why + '\n' + detail : why
      }
      /* git says "Unable to create ... .git/index.lock: Permission denied", which
         reads as a broken repository. It is the file sandbox refusing the write,
         and the reader can act on that (widen the session's file policy, or move
         the workspace) — so say it, and keep git's own line underneath. */
      if (result.sandboxDenied !== true) return detail
      const why = '文件沙箱不允许写这个仓库：读取没问题，暂存、提交、切换、初始化这类写操作需要这个目录在会话的可写范围内。'
      return detail.length > 0 ? why + '\n' + detail : why
    }

    function branchRelative(seconds) {
      if (!(seconds > 0)) return ''
      const now = Math.floor(Date.now() / 1000)
      if (!(now > 0) || now < seconds) return ''
      const diff = now - seconds
      if (diff < 60) return '刚刚'
      if (diff < 3600) return String(Math.floor(diff / 60)) + ' 分钟前'
      if (diff < 86400) return String(Math.floor(diff / 3600)) + ' 小时前'
      if (diff < 2592000) return String(Math.floor(diff / 86400)) + ' 天前'
      if (diff < 31536000) return String(Math.floor(diff / 2592000)) + ' 个月前'
      return String(Math.floor(diff / 31536000)) + ' 年前'
    }

    /* What the ↙/↗ numbers beside a branch mean, spelled out for the tooltip. The
       numbers themselves come from the Host, which pins git's locale so the
       counts can be read out of %(upstream:track) at all. */
    function trackTitle(ahead, behind) {
      if (ahead > 0 && behind > 0) return '与上游分岔：领先 ' + String(ahead) + '，落后 ' + String(behind)
      if (ahead > 0) return '领先上游 ' + String(ahead) + ' 个提交'
      if (behind > 0) return '落后上游 ' + String(behind) + ' 个提交'
      return '与上游一致'
    }

    /* ── how this browser likes the branch list ──

       Recently used, favourites and the order are all presentation, so they live
       in the same browser-local storage as the rest of layer one — in their own
       keys rather than inside the settings object, because they are written on
       every switch rather than when someone opens the settings page. */
    const MRU_KEY = 'dsh.git-idea.mru'
    const STARS_KEY = 'dsh.git-idea.stars'
    const SORT_KEY = 'dsh.git-idea.sort'
    const MRU_MAX = 8
    const STARS_MAX = 40

    let recentBranches = []
    let starredBranches = []
    let branchSort = 'recent'
    let branchPrefsLoaded = false
    /* A counter rather than a value: the two consumers of this signal are the
       switcher and the settings page, and both want a fresh render after any of
       the three lists changed, not the list itself. */
    let branchPrefVersion = 0
    const branchPrefSignal = createSignal(function () { return branchPrefVersion })
    const useBranchPrefs = branchPrefSignal.use

    function bumpBranchPrefs() {
      branchPrefVersion += 1
      branchPrefSignal.notify()
    }
    function stringList(raw, max) {
      const out = []
      if (!Array.isArray(raw)) return out
      for (let i = 0; i < raw.length && out.length < max; i += 1) {
        if (typeof raw[i] === 'string' && raw[i].length > 0 && out.indexOf(raw[i]) < 0) out.push(raw[i])
      }
      return out
    }
    function loadBranchPrefs(doc) {
      localStore(doc)
      if (branchPrefsLoaded) return
      branchPrefsLoaded = true
      recentBranches = stringList(readStoredJSON(MRU_KEY, null), MRU_MAX)
      starredBranches = stringList(readStoredJSON(STARS_KEY, null), STARS_MAX)
      const sort = readStored(SORT_KEY)
      if (sort === 'name' || sort === 'recent') branchSort = sort
    }
    function saveBranchPrefs() {
      writeStoredJSON(MRU_KEY, recentBranches)
      writeStoredJSON(STARS_KEY, starredBranches)
      writeStored(SORT_KEY, branchSort)
    }
    function rememberBranch(name) {
      if (name.length === 0) return
      const next = [name]
      for (let i = 0; i < recentBranches.length && next.length < MRU_MAX; i += 1) {
        if (recentBranches[i] !== name) next.push(recentBranches[i])
      }
      recentBranches = next
      saveBranchPrefs()
      bumpBranchPrefs()
    }
    function toggleStar(name) {
      const at = starredBranches.indexOf(name)
      if (at >= 0) starredBranches.splice(at, 1)
      else starredBranches = [name].concat(starredBranches).slice(0, STARS_MAX)
      saveBranchPrefs()
      bumpBranchPrefs()
    }
    function setBranchSort(next) {
      branchSort = next
      saveBranchPrefs()
      bumpBranchPrefs()
    }
    function clearBranchMemory() {
      recentBranches = []
      starredBranches = []
      saveBranchPrefs()
      bumpBranchPrefs()
    }

