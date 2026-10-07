    /* ── preferences, layer one: this browser ──

       Appearance and cadence only. Anything that describes what Git should DO
       lives in layer two below, because it is a property of the plugin rather
       than of whoever is looking at it. The harness Host does expose a
       `settings` service, but registering a namespace there needs a schemastery
       schema and a dynamic Host half gets no schemastery; the slot contract for
       a contributed settings entry also says outright that copy, current value
       and write path belong to the contributor. */

    const SETTINGS_KEY = 'dsh.git-idea.settings'
    const SETTINGS_DEFAULTS = {
      watchEnabled: true,
      watchChip: true,
      watchFastSec: 3,
      /* 面板关着时 chip 那条慢 lane。它现在只发一次便宜签名（真机上 0.12s），所以可以
         问得比过去勤：15s 的话，终端里提交完要过十几秒 chip 才改口。 */
      watchSlowSec: 5,
      hoverSwitch: true,
      /* Which of the two changes views the panel opens in: the directory tree
         (IDEA's default) or the flat list of paths. A preference of this browser
         rather than of the plugin — it is about how someone reads a diff, not
         about what git should do. */
      changesView: 'tree',
    }
    let gitSettings = Object.assign({}, SETTINGS_DEFAULTS)
    let settingsLoaded = false
    const settingsSignal = createSignal(function () { return gitSettings })
    const useGitSettings = settingsSignal.use

    function clampInt(value, min, max, fallback) {
      const n = typeof value === 'number' && isFinite(value) ? Math.round(value) : NaN
      if (isNaN(n)) return fallback
      if (n < min) return min
      if (n > max) return max
      return n
    }

    function normalizeSettings(raw) {
      const out = Object.assign({}, SETTINGS_DEFAULTS)
      if (raw == null || typeof raw !== 'object') return out
      out.watchEnabled = raw.watchEnabled !== false
      out.watchChip = raw.watchChip !== false
      out.watchFastSec = clampInt(raw.watchFastSec, 1, 120, SETTINGS_DEFAULTS.watchFastSec)
      out.watchSlowSec = clampInt(raw.watchSlowSec, 2, 600, SETTINGS_DEFAULTS.watchSlowSec)
      out.hoverSwitch = raw.hoverSwitch !== false
      out.changesView = raw.changesView === 'flat' ? 'flat' : 'tree'
      if (out.watchSlowSec < out.watchFastSec) out.watchSlowSec = out.watchFastSec
      return out
    }

    /* Called by every surface that has just been handed a document, so a later
       save finds a store even if the surface that changed something is gone. */
    function loadSettings(doc) {
      localStore(doc)
      if (settingsLoaded) return
      settingsLoaded = true
      gitSettings = normalizeSettings(readStoredJSON(SETTINGS_KEY, null))
    }

    function saveSettings(next) {
      gitSettings = normalizeSettings(next)
      writeStoredJSON(SETTINGS_KEY, gitSettings)
      settingsSignal.notify()
      rescheduleWatchers()
    }

    /* ── preferences, layer two: the plugin ──

       Kept apart from the browser-local half above, because these are properties
       of the plugin and not of whoever is looking at it: which branch a new
       repository starts on, and whether cherry-pick records its origin. They
       live in a file beside the deployment's own settings, owned by the Host
       half, so they travel across browsers and machines. As an ordinary plugin
       this is exactly what its config section would hold. */

    const PLUGIN_CONFIG_DEFAULTS = {
      initBranch: 'main', cherryPickRecord: false,
      /* 空 = 用部署 PATH 里的 git。 */
      gitPath: '',
      /* 这三条是插件自己给 git 的实参，不是 git 设置的副本。 */
      fetchPrune: true, pullRebase: false, pushSetUpstream: false,
      /* 手动登记的仓库清单（按工作区分组，24-repos.js / 61-repos.js）。这里必须跟着
         带上：设置页保存的是**整份**配置，客户端的归一化把它丢了的话，读者在设置页
         改一次 git 路径，手动仓库清单就没了。原样搬运、不做清洗 —— 那是 Host 那边
         normalizeConfig 的职责，两边各写一份迟早漂移。 */
      repos: {},
      /* 快捷命令（面板 ⚡ 按钮，客户端 78-actions.js / host 78-actions.js）。和 repos
         不同，这一项两边都做归一化：它是读者直接编辑的清单，编辑器保存前要拿「合法
         条目 + 条数」做校验，Host 那份 normalizeConfig 是落盘前的最后一道关卡。 */
      quickCommands: [],
    }
    let pluginConfig = Object.assign({}, PLUGIN_CONFIG_DEFAULTS)
    let pluginConfigPath = ''
    let pluginConfigLoaded = false
    let pluginConfigError = ''
    const pluginConfigSignal = createSignal(function () { return pluginConfig })
    const usePluginConfig = pluginConfigSignal.use

    /* 每次**Host 确认过**的配置计数。屏幕上那份草稿是即时的（`savePluginConfig` 当场
       改内存，400ms 后才落盘），所以「问 Host 一件事」不能挂在草稿上：挂上去的话每敲
       一个键都是一次询问，而且问到的是 Host 手里那份还没更新的配置 —— 真机上量到的
       是界面永远慢一步。这个计数只在答复带着配置回来时才动（初次读取、保存成功）。 */
    let pluginConfigCommitted = 0
    const pluginConfigCommittedSignal = createSignal(function () { return pluginConfigCommitted })
    const usePluginConfigCommitted = pluginConfigCommittedSignal.use

    function normalizePluginConfig(raw) {
      const out = Object.assign({}, PLUGIN_CONFIG_DEFAULTS)
      if (raw == null || typeof raw !== 'object') return out
      if (typeof raw.initBranch === 'string') out.initBranch = raw.initBranch.trim().slice(0, 120)
      out.cherryPickRecord = raw.cherryPickRecord === true
      if (typeof raw.gitPath === 'string') out.gitPath = raw.gitPath.trim().slice(0, 400)
      out.fetchPrune = raw.fetchPrune !== false
      out.pullRebase = raw.pullRebase === true
      out.pushSetUpstream = raw.pushSetUpstream === true
      /* repos 见上面 PLUGIN_CONFIG_DEFAULTS 里的说明：原样搬运，Host 那边负责清洗。 */
      out.repos = raw.repos != null && typeof raw.repos === 'object' && !Array.isArray(raw.repos) ? raw.repos : {}
      out.quickCommands = normalizeQuickCommands(raw.quickCommands)
      return out
    }

    /* 快捷命令清单的形状：[{id,name,command}]。与 host 70-config.js 的 normalizeConfig
       是同一条规矩的两半 —— 客户端这份管「屏幕上见到的」，编辑器靠它数清条数（上限
       50，超出的那次保存由编辑器自己拦下并说明，这里静默截断只作兜底）。 */
    const QUICK_COMMANDS_MAX = 50
    const QUICK_NAME_MAX = 120
    const QUICK_TEMPLATE_MAX = 2000
    function normalizeQuickCommands(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (let i = 0; i < raw.length && out.length < QUICK_COMMANDS_MAX; i += 1) {
        const one = raw[i]
        if (one == null || typeof one !== 'object') continue
        const name = typeof one.name === 'string' ? one.name.trim().slice(0, QUICK_NAME_MAX) : ''
        const command = typeof one.command === 'string' ? one.command.slice(0, QUICK_TEMPLATE_MAX) : ''
        if (name.length === 0 || command.trim().length === 0) continue
        const id = typeof one.id === 'string' && one.id.trim().length > 0 ? one.id.trim().slice(0, 200)
          : (name + '-' + String(Date.now()))
        out.push({ id: id, name: name, command: command })
      }
      return out
    }

    function adoptPluginConfig(data) {
      if (data != null) {
        if (typeof data.path === 'string') pluginConfigPath = data.path
        if (data.config !== undefined) pluginConfig = normalizePluginConfig(data.config)
        pluginConfigError = ''
      }
      pluginConfigCommitted += 1
      pluginConfigSignal.notify()
      pluginConfigCommittedSignal.notify()
    }

    function loadPluginConfig() {
      if (pluginConfigLoaded) return
      pluginConfigLoaded = true
      callHost('git/config', {}).then(adoptPluginConfig).catch(function (failure) {
        pluginConfigError = failureText(failure)
        pluginConfigSignal.notify()
      })
    }

    /* What is on screen is the draft and updates at once; the file follows when
       the typing stops. Every keystroke of a branch name used to be its own RPC
       and its own write of the config file, and the settings page asks for one on
       each `onChange`. */
    const CONFIG_SAVE_MS = 400
    let configSaveTimer = null

    function writePluginConfig() {
      const request = { config: pluginConfig }
      /* 写在部署的配置目录里，也就是任何工作区之外：带上这个页面在哪个会话里，Host
         才能用这个会话的沙箱策略去写（没有会话时写不出去，而那种失败必须说得出来）。 */
      if (lastSessionId.length > 0) request.sessionId = lastSessionId
      callHost('git/config-save', request).then(function (result) {
        if (result == null || result.ok !== true) {
          /* git 那套「这台机器 / 这个沙箱不让我做这件事」的说法是同一份（见
             commandDetail）：这里也走它，免得写不进去时屏幕上什么都没有。 */
          pluginConfigError = commandDetail(result) || text(result != null ? result.error : '') || '保存失败'
          pluginConfigSignal.notify()
          return
        }
        adoptPluginConfig(result)
      }).catch(function (failure) {
        pluginConfigError = failureText(failure)
        pluginConfigSignal.notify()
      })
    }

    function savePluginConfig(next) {
      pluginConfig = normalizePluginConfig(next)
      pluginConfigError = ''
      pluginConfigSignal.notify()
      if (configSaveTimer != null) { configSaveTimer(); configSaveTimer = null }
      const timer = ctx.get('timer')
      if (timer === undefined) { writePluginConfig(); return }
      configSaveTimer = timer.timeout(function () {
        configSaveTimer = null
        writePluginConfig()
      }, CONFIG_SAVE_MS)
    }
