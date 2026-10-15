/* ─────────────── 宿主常驻监听：内置编辑器保存文件 → git 状态刷新 ───────────────
 *
 * DSH-better-sidebar（对话侧栏插件）v0.27.0+ 在内置编辑器保存成功（/sidebar/write
 * 落盘、应答写回之后）会 emit cordis 事件 better-sidebar/file-saved，payload 是
 * { sessionId, cwd, path, size?, mtimeMs?, at }。这里订阅它，把「读者刚在编辑器里
 * 存了盘」接进 git 状态刷新：
 *
 *   · 命中已知仓库先 invalidateRepo（60-reads.js 的读缓存，删几个 Map 键的便宜
 *     操作，不参与防抖）—— 防抖到点前后浏览器来的任何读都拿得到新答案；
 *   · 再按仓库做尾沿防抖，到点广播 repo-changed（79-live-watch.js 已有的消息种类），
 *     client 半的现成 handler（98-register.js：markTreePartial + ringTreeReload +
 *     bumpData）接手整树刷新 —— 客户端一行不用改。
 *
 * 暴露面刻意选在 host：订阅一个 cordis 字符串事件不需要 inject better-sidebar，
 * 它未安装或 <0.27.0 时没人 emit 这个事件，listener 永不触发、零报错、面板照旧。
 * client 面做不到这一点：声明 inject 'betterSidebar'，better-sidebar 缺失时整个
 * git 插件会被 cordis 停等、面板直接消失 —— 不可接受；自己探测加重试则复杂且收益
 * 为零（宿主广播毫秒级到达，还天然覆盖所有浏览器）。
 *
 * 与 79-live-watch.js 的分工：那边是轮询发现变化（签名比对），这边是事件驱动的
 * 即时通知；模型用工具改文件不走 /sidebar/write，仍由 session-complete 与客户端
 * watcher 轮询那两条现有通道覆盖，这一片不替代它们。 */

/* 保存的防抖：编辑器里连续 Ctrl+S 是一波，不必每下都让浏览器整树重读 —— 同一仓库
 * 1.5 秒内的后续保存只把定时器往后推，停手 1.5 秒后才广播一次。 */
const LIVE_SAVE_DEBOUNCE_MS = 1500

/* 挂着的防抖定时器，键是仓库绝对路径 —— 与 79-live-watch.js 的 liveCompletePending
 * 同一形状：挂着先拆再挂，卸载时一次拆光。 */
const liveSavePending = new Map()

/* 比较用的小归一：反斜杠统一成正斜杠（保存路径与仓库清单在 Windows 工作区可能各带
 * 各的分隔符），尾部斜杠不作数 —— 与 77-cmdrec.js 的 cmdrecTrimSlash 同一个问题。 */
function liveSaveNorm(path) {
  const slashed = path.replace(/\\/g, '/')
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
}

/* payload.path 是保存时的原样路径（better-sidebar 不归一化、不拼 cwd）：相对的与
 * payload.cwd（会话根，activeWorktreeRoot）拼成绝对路径，绝对的照用。拼法是纯字符
 * 串手法 —— 片段里没有 node:path（import 只能放在 pkg 前奏的文件头，拼接后放中部
 * 是语法错误）；两种分隔符混排无妨，比较前反正要过 liveSaveNorm。拼不成（没有
 * cwd）返回空串，调用方安静放弃。 */
function liveSaveAbsPath(payload) {
  const path = payload.path
  if (path.charAt(0) === '/' || path.charAt(0) === '\\') return path
  if (path.length > 1 && path.charAt(1) === ':') return path
  const cwd = payload.cwd
  if (!isStr(cwd) || cwd.length === 0) return ''
  if (cwd.charAt(cwd.length - 1) === '/' || cwd.charAt(cwd.length - 1) === '\\') return cwd + path
  return cwd + '/' + path
}

/* 保存路径属于哪个仓库：候选集就是 79-live-watch.js 的 liveRepoList()（配置登记 ∪
 * 会话工作区），带分隔符边界的最长前缀匹配 —— /repo-x 不能吃掉 /repo-xy 的文件，
 * 仓库路径本身算命中。命不中返回 null，安静跳过。 */
async function liveSaveRepoOf(absPath) {
  const target = liveSaveNorm(absPath)
  if (target.length === 0) return null
  let best = null
  let bestLen = 0
  const repos = await liveRepoList()
  for (let i = 0; i < repos.length; i += 1) {
    const candidate = liveSaveNorm(repos[i])
    if (candidate.length === 0) continue
    const within = target === candidate
      || (target.length > candidate.length
        && target.indexOf(candidate) === 0
        && target.charAt(candidate.length) === '/')
    if (within !== true || candidate.length <= bestLen) continue
    best = repos[i]
    bestLen = candidate.length
  }
  return best
}

/* 防抖到点后的广播。bridge 版没有 liveHub（typeof 守卫安静跳过），没有浏览器连着
 * 时推给零个连接是纯浪费 —— 与 79-live-watch.js 的轮询同一条规矩。 */
function liveSaveFlush(repo) {
  if (typeof liveHub === 'undefined' || liveHub == null) return
  const sockets = liveHub.sockets != null ? liveHub.sockets : null
  if (sockets === null || sockets.size === 0) return
  liveSend(JSON.stringify({ kind: 'repo-changed', repo: repo }))
}

/* 每仓库尾沿防抖：挂着先拆再挂，定时器永远对齐最后一次保存，停手后才广播一次。 */
function liveSaveSchedule(repo) {
  const held = liveSavePending.get(repo)
  if (held !== undefined) held()
  const dispose = liveTimers().timeout(function () {
    liveSavePending.delete(repo)
    liveSaveFlush(repo)
  }, LIVE_SAVE_DEBOUNCE_MS)
  liveSavePending.set(repo, dispose)
}

/* 保存事件的处理体（async：仓库解析要读插件配置，liveRepoList 是 async）。全程
 * try/catch，任何错只记日志 —— 这是保存路径上的 listener，better-sidebar 虽会把
 * 坏 listener 的错吞掉，但这边的动静不该让一次已完成的保存沾上任何东西。 */
async function liveSaveHandle(payload) {
  try {
    const absPath = liveSaveAbsPath(payload)
    if (absPath.length === 0) return
    const repo = await liveSaveRepoOf(absPath)
    if (repo === null) return
    /* 先失效宿主自己的读缓存再排广播：浏览器收到广播后立刻来的读必须拿得到新答案，
     * 防抖期间面板自己来读也一样。便宜操作，每下都做、不参与防抖。 */
    invalidateRepo(repo)
    liveSaveSchedule(repo)
  } catch (error) {
    console.error('dsh-git-idea: 处理文件保存事件失败（忽略这一次）', String(error))
  }
}

/* 保存路径上的同步 listener：只做便宜的形状检查再点火，不做重活。payload 形状
 * 不对的安静返回。 */
function liveSaveOnEvent(payload) {
  if (payload == null || typeof payload !== 'object') return
  if (!isStr(payload.path) || payload.path.length === 0) return
  void liveSaveHandle(payload)
}

/* 生命周期与 79-live-watch.js 的 effect 同一条规矩：订阅、挂着的定时器与状态收进
 * 一个 effect，插件停更 / 卸载时一次收拾干净（退订 + 拆光防抖）。老版动态桥的
 * ctx façade 没有 on 时安静不启用。 */
ctx.effect(function () {
  if (typeof ctx.on !== 'function') return undefined
  const dispose = ctx.on('better-sidebar/file-saved', liveSaveOnEvent)
  return function () {
    if (typeof dispose === 'function') dispose()
    for (const timer of Array.from(liveSavePending.values())) timer()
    liveSavePending.clear()
  }
}, 'dsh-git-idea file-save watch')
