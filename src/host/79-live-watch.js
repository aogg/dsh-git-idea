/* ─────────────── 宿主常驻监听：仓库签名轮询 + 会话完成推送 ───────────────
 *
 * 「会话完成自动刷新」过去只挂在每个会话视图的 chip 上（92-chip.js，浏览器侧）：
 * 读者切走会话视图，chip 连同它的监听一起卸载，完成的那一刷就被静默丢掉，git 状态
 * 从此不再更新。这一片把两件「发现变化」的事搬进宿主进程常驻层，用 liveHub
 * （真包 pkg 前奏提供、wsUpgrade 装配的 host→client 广播）推给浏览器：
 *
 *   · repo-changed      某仓库的廉价签名变了（refs / HEAD / index / HEAD 文件戳，
 *                        watchCommand 的 shallow 半边）→ 宿主先失效自己那份读缓存
 *                        （60-reads.js 的 invalidateRepo，git/flush 同一款），再广播；
 *                        浏览器无论停在哪个会话视图都能听见，把树标成「不再完整」。
 *                        工作区里**新建**的文件签名看不见 —— 那仍由完成刷新的全树读
 *                        覆盖（session-complete 那半边）。
 *   · session-complete  某会话的 running 位 true→false 边沿（进程内读 sessions /
 *                        agents 服务，不起进程）→ 2 秒防抖吞掉 goal 续轮间隙后广播；
 *                        浏览器补的那一刷就是 92-chip.js 的 runCompleteRefresh。
 *
 * bridge 版（build.mjs 的 dist/host.js）没有 pkg 层，liveHub 不存在 —— 下面整个 effect
 * 用 typeof 守卫安静不启用，两种构建共用这一个片段。
 *
 * 两条刻意的取舍：
 *
 * · 没有浏览器连着（liveHub.sockets 空）就不花签名轮询的进程 —— 推给零个连接是纯
 *   浪费，而基线保持在断连前，重连后第一轮自会把断连期间的差异补推出去（浏览器的
 *   live-open 补核对只兜欠账，补不了「断连期间仓库变了」，这里正好接上）。
 * · 会话完成用低频轮询快照 + 本地 diff，不用 agent/status 事件订阅 —— 轮询是纯
 *   进程内读（sessions.list / agents.get），不依赖事件在 cordis 树里的传播路径，
 *   拿不到服务的部署安静跳过这半边，面板照旧靠 chip 自己的监听。 */

/* 签名轮询节奏与 77-cmdrec 的落盘定时器同理：常驻但不紧迫，unref 让宿主退出不等。 */
const LIVE_REPO_TICK_MS = 10000
const LIVE_SESSION_TICK_MS = 1500
/* 同一仓库两次 repo-changed 的最小间隔：防抖阀，正常轮询节奏（10s）下永远够用。 */
const LIVE_REPO_PUSH_GAP_MS = 2000
/* 轮询仓库清单的 LRU 上限：配置登记 ∪ 会话工作区，超出的最久未见的先让位。 */
const LIVE_REPO_MAX = 24
/* 会话完成的防抖：与 92-chip.js 的 COMPLETE_DEBOUNCE_MS 同一个数、同一个理由 ——
 * goal 自动续轮之间有一小段 running=false，2 秒内变回 true 就整轮取消。 */
const LIVE_COMPLETE_DEBOUNCE_MS = 2000

let liveSigTimer = null
let liveSessionTimer = null
let liveSigBusy = false
/* LRU：最近见过的排尾部；签名基线与上次推送时刻跟着仓库走，仓库让位时一起清。 */
let liveRepoOrder = []
const liveSigBaselines = new Map()
const liveRepoLastPush = new Map()
/* running 位的本地快照：首次见到只记基线（与 chip 的 runEdge.armed 同一条规矩，
 * 不然每次宿主起进程都会把已经在跑的会话白报一遍完成）。 */
const liveRunning = new Map()
const liveCompletePending = new Map()

/* 「服务不在」这件事本身要有声。跳过是契约 —— bridge 版与没装 sessions/agents 的
 * 部署都靠它安静退化，面板照常工作；但完全无声时，「按设计跳过」与「以为在监听、
 * 其实每一轮都在跳过」从外面无法区分，真机上为此付出过一整轮误诊（2026-10-22：
 * WS 通路、RPC、轮询进程全都活着，唯独「会话清单为空 / 会话边沿不推」查不出原因，
 * 因为跳过的一方一个字都不说）。每个服务记一份状态：缺失进门说一次、缺失转可见
 * 再说一次，同一状态不重复；effect 卸载时复位，下次上任重新学。console.error 是
 * 本文件既有的日志通道（bridge 版的 host 半同样走它）。 */
const liveServiceState = new Map()
function liveServiceMissing(name) {
  if (liveServiceState.get(name) === 'missing') return
  liveServiceState.set(name, 'missing')
  console.error('dsh-git-idea: live 监听看不到 ' + name + ' 服务（这一半静默跳过，不推送）')
}
function liveServicePresent(name) {
  const was = liveServiceState.get(name)
  liveServiceState.set(name, 'present')
  if (was === 'missing') {
    console.error('dsh-git-idea: live 监听重新看到 ' + name + ' 服务（恢复这一半的监听）')
  }
}

/* 时钟优先走 timer 服务（cordis 的 fiber 级定时器，插件卸载自动回收），没有就落回
 * 裸 setInterval/setTimeout（unref，宿主退出不为它等）—— 与客户端 10-state.js 的
 * timerOf 同一条兜底思路，两种形状都回拆销函数。 */
function liveTimers() {
  const service = ctx.get('timer')
  if (service !== undefined && service != null
    && typeof service.interval === 'function' && typeof service.timeout === 'function') return service
  return {
    timeout: function (callback, delay) {
      const handle = setTimeout(callback, delay)
      if (typeof handle.unref === 'function') handle.unref()
      return function () { clearTimeout(handle) }
    },
    interval: function (callback, delay) {
      const handle = setInterval(callback, delay)
      if (typeof handle.unref === 'function') handle.unref()
      return function () { clearInterval(handle) }
    },
  }
}

/* 这一轮该看哪些仓库：插件配置里手动登记的（70-config.js 的 repos，键是工作区、值是
 * 绝对路径清单）∪ 各 live 会话的 header.cwd。去重就好，顺序不装作有意义 —— 真正的
 * 「最近」由下面的 LRU 记。 */
async function liveRepoList() {
  const fresh = []
  const push = function (repo) {
    if (!isStr(repo) || repo.length === 0) return
    if (fresh.indexOf(repo) >= 0) return
    fresh.push(repo)
  }
  try {
    const config = await readConfigFile()
    const map = config != null && config.repos != null ? config.repos : null
    if (map != null) {
      for (const workspace in map) {
        if (!Object.prototype.hasOwnProperty.call(map, workspace)) continue
        const list = map[workspace]
        if (Array.isArray(list) !== true) continue
        for (let i = 0; i < list.length; i += 1) push(list[i])
      }
    }
  } catch (error) {
    console.error('dsh-git-idea: live 监听读不到插件配置（这一轮只看会话工作区）', String(error))
  }
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && sessions != null && typeof sessions.list === 'function') {
    liveServicePresent('sessions')
    try {
      const rows = sessions.list()
      if (Array.isArray(rows)) {
        for (let i = 0; i < rows.length; i += 1) {
          const header = rows[i] != null ? rows[i].header : null
          push(header != null && isStr(header.cwd) ? header.cwd : '')
        }
      }
    } catch (error) {
      console.error('dsh-git-idea: live 监听枚举会话失败（这一轮只看配置登记的仓库）', String(error))
    }
  } else {
    liveServiceMissing('sessions')
  }
  return fresh
}

/* 见过的记成「最近」，没见过的原地老化，超上限从最久未见的开始让位。 */
function liveRepoRemember(fresh) {
  for (let i = 0; i < fresh.length; i += 1) {
    const at = liveRepoOrder.indexOf(fresh[i])
    if (at >= 0) liveRepoOrder.splice(at, 1)
    liveRepoOrder.push(fresh[i])
  }
  while (liveRepoOrder.length > LIVE_REPO_MAX) {
    const dropped = liveRepoOrder.shift()
    liveSigBaselines.delete(dropped)
    liveRepoLastPush.delete(dropped)
  }
  return liveRepoOrder.slice()
}

/* 一个仓库的签名轮询。watchCommand 的 shallow 半边全是读命令（for-each-ref /
 * rev-parse --verify / 对 gitdir 三个文件的 stat），不碰 index.lock；deep=false 也
 * 正好避开每 10 秒一次的全树 status。路径已从配置或会话头里来，invoked 直接以它为
 * workdir（目录已不存在时 spawn 本身失败 —— 和 60-reads.js 的 probe 教训同一条），
 * 空签名（非仓库 / git 报错 / 目录消失）只记基线，从不推送。 */
async function livePollRepo(repo) {
  let sig = ''
  try {
    const probe = await invoke(watchCommand(repo, false, []), { repo: repo }, null, { timeoutMs: 20000 })
    sig = probe != null && probe.exitCode === 0 ? String(probe.stdout == null ? '' : probe.stdout) : ''
  } catch (error) {
    console.error('dsh-git-idea: live 签名读不动 ' + repo + '（按空签名记基线）', String(error))
    sig = ''
  }
  const previous = liveSigBaselines.get(repo)
  if (previous === sig) return
  if (sig.length === 0) { liveSigBaselines.set(repo, sig); return }
  if (previous === undefined) { liveSigBaselines.set(repo, sig); return }
  /* 最小推送间隔：压着间隔的第二次变化保留旧基线不推，下一轮还会看到差异再推 ——
   * 变化本身不被吞掉，只是延后一次轮询。 */
  const now = Date.now()
  const last = liveRepoLastPush.get(repo)
  if (last !== undefined && now - last < LIVE_REPO_PUSH_GAP_MS) return
  liveSigBaselines.set(repo, sig)
  liveRepoLastPush.set(repo, now)
  /* 先失效宿主自己的读缓存再广播：浏览器收到后立刻来的读必须拿得到新答案，
   * 不能是缓存里那份旧的（git/flush 的 handler 调的就是这一个函数）。 */
  invalidateRepo(repo)
  liveSend(JSON.stringify({ kind: 'repo-changed', repo: repo }))
}

async function liveReposRound() {
  if (typeof liveHub === 'undefined' || liveHub == null) return
  /* 没有浏览器在听：签名轮询省下，基线保持 —— 重连后第一轮自会对出断连期间的差异。 */
  const sockets = liveHub.sockets != null ? liveHub.sockets : null
  if (sockets === null || sockets.size === 0) return
  if (liveSigBusy === true) return
  liveSigBusy = true
  try {
    const repos = liveRepoRemember(await liveRepoList())
    for (let i = 0; i < repos.length; i += 1) await livePollRepo(repos[i])
  } finally {
    liveSigBusy = false
  }
}

/* 每会话的完成防抖：挂着就不重挂（长 false 期间不能被 1.5s 的轮询一推再推），
 * running 回 true 由 liveSessionTick 整轮取消。 */
function liveScheduleComplete(sessionId) {
  if (liveCompletePending.has(sessionId)) return
  const dispose = liveTimers().timeout(function () {
    liveCompletePending.delete(sessionId)
    liveSend(JSON.stringify({ kind: 'session-complete', sessionId: sessionId }))
  }, LIVE_COMPLETE_DEBOUNCE_MS)
  liveCompletePending.set(sessionId, dispose)
}

function liveCancelComplete(sessionId) {
  const dispose = liveCompletePending.get(sessionId)
  if (dispose === undefined) return
  liveCompletePending.delete(sessionId)
  dispose()
}

/* running 位的快照与边沿判定。会话从清单里消失（fiber 卸载）就当没存在过：
 * 基线和挂着的防抖一起清掉，不给一个已经不在的会话补发完成。 */
function liveSessionTick() {
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  /* 两个服务各自上报可见性再决定去留：sessions 缺席时顺带把 agents 的状态也说清
   * —— 只报第一个缺席的，另一半哑了多久照样无人知晓。 */
  const sessionsOk = sessions !== undefined && sessions != null && typeof sessions.list === 'function'
  const agentsOk = agents !== undefined && agents != null && typeof agents.get === 'function'
  if (sessionsOk === true) liveServicePresent('sessions'); else liveServiceMissing('sessions')
  if (agentsOk === true) liveServicePresent('agents'); else liveServiceMissing('agents')
  if (sessionsOk !== true || agentsOk !== true) return
  let rows
  try {
    rows = sessions.list()
  } catch (error) {
    console.error('dsh-git-idea: live 监听读会话清单失败（这一轮跳过）', String(error))
    return
  }
  if (Array.isArray(rows) !== true) return
  const alive = new Set()
  for (let i = 0; i < rows.length; i += 1) {
    const session = rows[i]
    if (session == null || !isStr(session.id) || session.id.length === 0) continue
    alive.add(session.id)
    let running = false
    try {
      const agent = agents.get(session.id)
      running = agent != null && agent.status === 'running'
    } catch (error) {
      console.error('dsh-git-idea: live 监听读会话状态失败 ' + session.id, String(error))
      running = false
    }
    const previous = liveRunning.get(session.id)
    liveRunning.set(session.id, running)
    if (running === true) { liveCancelComplete(session.id); continue }
    if (previous !== true) continue
    liveScheduleComplete(session.id)
  }
  for (const id of Array.from(liveRunning.keys())) {
    if (alive.has(id) !== true) {
      liveRunning.delete(id)
      liveCancelComplete(id)
    }
  }
}

/* 跟 80-rpc.js 的 onRpc、30-watch（客户端）的可见性监听同一条生命周期规矩：定时器
 * 与全部状态都收进一个 effect，插件停更 / 卸载时一次收拾干净。上任先各跑一轮，
 * 基线尽早立起来（会话那半是纯进程内读，先跑不花进程）。 */
ctx.effect(function () {
  /* bridge 版没有 pkg 层：liveHub 不存在，整个常驻监听安静不启用。 */
  if (typeof liveHub === 'undefined' || liveHub == null) return undefined
  const timers = liveTimers()
  liveSigTimer = timers.interval(function () { void liveReposRound() }, LIVE_REPO_TICK_MS)
  liveSessionTimer = timers.interval(liveSessionTick, LIVE_SESSION_TICK_MS)
  void liveReposRound()
  liveSessionTick()
  return function () {
    if (liveSigTimer != null) { liveSigTimer(); liveSigTimer = null }
    if (liveSessionTimer != null) { liveSessionTimer(); liveSessionTimer = null }
    for (const dispose of Array.from(liveCompletePending.values())) dispose()
    liveCompletePending.clear()
    liveRunning.clear()
    liveServiceState.clear()
    liveSigBaselines.clear()
    liveRepoLastPush.clear()
    liveRepoOrder = []
    liveSigBusy = false
  }
}, 'dsh-git-idea live watch')
