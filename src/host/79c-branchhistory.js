/* ─────────────── 分支会话历史：按分支自动记录 + 宿主注入 ───────────────
 *
 *   这个插件对会话一直只算「哪个工作区」，但同一工作区底下不同分支往来的对话是
 *   两摊事：回到一条老分支上想接着上次的话题聊，却没有任何地方说「这个分支底下
 *   都有过哪些会话」。这一片做三件事：
 *
 *   · 自动记录   每个（非子代理）会话的第一条消息发出时，把会话 id 按工作区 ×
 *                当前分支记进配置（70-config.js 的 branchSessions）。无条件记 ——
 *                「记」是账，「注入」才是开关，关着注入账也照记。
 *   · 宿主注入   开关打开（工作区显式值 ?? 全局 defaultOn）时，同一条消息上再
 *                附加一段说明：本分支下的历史会话 id 列表（不含当前会话，最多
 *                maxSessions 条）。该分支在 branchPrompts 里配了专用提示词时，
 *                正文换成那份全文、后接同一份列表。
 *   · 三条 RPC   git/branch-history-config（读，chip 滑块与配置页的数据）、
 *                git/branch-history-switch（写工作区开关 / reset 回全局默认）、
 *                git/branch-prompt-save（写当前分支的专用提示词，空文本 = 删除）。
 *
 *   宿主注入的结构完全照 dsh-ao-local 的 project-prompt 注入（ctx.on
 *   "agent/pre-step"：先 await next() 拿底层决策、仅 step===1 处理、整个 try/catch
 *   任何异常 console.warn 后放行原 decision，绝不炸宿主）。一处刻意不同：decision
 *   是 reject 或本轮 messages 为空时直接放行、**不做 inbox 兜底** —— project-prompt
 *   兜底是因为那段提示词丢了就永远丢了；这里丢掉的那一轮本就没有历史可注（新会话
 *   第一轮历史必然为空），下一轮步骤还会带着完整账重来，为它维护一份 inbox 挂账
 *   只多一种坏掉的形状。
 *
 *   bridge 版的老 ctx façade 没有 on 时安静不启用（79b-file-save.js 的守卫先例，
 *   守卫写在 80-rpc.js 的调用点）。本片段必须排在 80-rpc.js **之前**：apply(ctx)
 *   的花括号在 80-rpc.js 末尾才合上，排在它后面的片段就落在了 apply 作用域之外，
 *   摸不到 shell / invoke / 配置读写的任何一个字。 */

/* 注入消息的 source.kind（同时用于防重复识别，与 source.workspace / source.branch
 * 一起排查用）。 */
const BRANCH_HISTORY_SOURCE_KIND = 'dsh-git-idea-branch-history'
/* 注入文本字节上限：超出截断并在结尾注明（照 project-prompt 的做法；这份说明是给
 * 模型看的上下文，不是给人读的文档，32K 足够放下 50 条 id 与一份 4000 字的专用
 * 提示词，再长就该是配置写坏了）。 */
const BRANCH_HISTORY_MAX_INJECTION_BYTES = 32768
/* branchSessions 每分支会话条数上限（70-config.js 归一化同款，登记处就地裁尾）。 */
const BRANCH_HISTORY_SESSIONS_MAX = 200

/* 注入消息 id 的唯一串：node 的全局 crypto.randomUUID 可用就用；个别环境（桩、
 * 老进程）没有全局 crypto 就手写一个随机串 —— 只用于消息去重与排查，唯一即可。 */
function branchHistoryMessageId() {
  try {
    const c = typeof crypto !== 'undefined' ? crypto : null
    if (c != null && typeof c.randomUUID === 'function') return c.randomUUID()
  } catch (error) { /* 落到手写串 */ }
  return 'bh-' + String(Date.now()) + '-' + String(Math.floor(Math.random() * 4294967296)) + '-' + String(Math.floor(Math.random() * 4294967296))
}

/* UTF-8 字节数。Buffer 是 node 全局；桩环境没有时退回字符数 —— 它只用于截断预算
 * 与一行日志，中文字符串在那里会低估一半，最坏是少截了一行，无害。 */
function branchHistoryBytes(value) {
  if (typeof Buffer !== 'undefined' && Buffer != null && typeof Buffer.byteLength === 'function') {
    try { return Buffer.byteLength(value, 'utf8') } catch (error) { /* 退回字符数 */ }
  }
  return value.length
}

/* 按字节上限安全截断 UTF-8 文本（不会把多字节字符切成半个；照 project-prompt 的
 * truncateUtf8 同一套回退：先剥掉被切断的续字节，再剥掉孤立的首字节）。 */
function branchHistoryTruncateUtf8(text, maxBytes) {
  if (typeof Buffer === 'undefined' || Buffer == null || typeof Buffer.from !== 'function') {
    return { text: text.length > maxBytes ? text.slice(0, Math.max(0, maxBytes)) : text, truncated: text.length > maxBytes }
  }
  let buffer
  try { buffer = Buffer.from(text, 'utf8') } catch (error) { return { text: text, truncated: false } }
  if (buffer.length <= maxBytes) return { text: text, truncated: false }
  let end = maxBytes
  while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80) end -= 1
  if (end > 0 && (buffer[end - 1] & 0xc0) === 0xc0) end -= 1
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true }
}

/* 本地时区的 YYYY-MM-DD HH:mm：这份账是给读者回头翻的，年月日时分够定位一场对话，
 * 秒与毫秒只会让列表更难扫。 */
function branchHistoryStamp(at) {
  const d = new Date(at)
  const p2 = function (n) { return n < 10 ? '0' + String(n) : String(n) }
  return String(d.getFullYear()) + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
    + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
}

/* 仓库短名：路径最后一段（列表说明行里点名用，完整路径在 source.workspace 里）。 */
function branchHistoryShortName(cwd) {
  const trimmed = cwd.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  const short = cut >= 0 ? trimmed.slice(cut + 1) : trimmed
  return short.length > 0 ? short : trimmed
}

/* 当前分支：`--no-optional-locks -C <目录> branch --show-current`。--no-optional-locks
 * 让这条纯读不去碰任何可选锁文件（只读会话沙箱里 index.lock 写不动时它本来就会
 * 假失败）；argv 是数组、不过 shell，目录带空格由 shq 兜住；detached HEAD 的输出
 * 为空、git 失败非 0 —— 两种都答空串，调用方跳过登记与注入（没有「当前分支」
 * 这个概念时，这笔账记到哪、注什么都是猜）。走 git() 包装：gitPath 配置与 gitGuard
 * 的「机器上没有 git」探测照常生效。 */
async function branchHistoryCurrentBranch(args, cwd) {
  const probe = await git(args, ['--no-optional-locks', '-C', cwd, 'branch', '--show-current'], null, {})
  if (probe.exitCode !== 0) return ''
  return probe.stdout.trim()
}

/* branchSessions 的三个只读取数（归一化已保证形状，这里再防一手文件被手改）： */
function branchHistoryBranchMap(map, key) {
  if (map == null || typeof map !== 'object') return {}
  const one = map[key]
  return one != null && typeof one === 'object' && !Array.isArray(one) ? one : {}
}

function branchHistorySwitchOf(history, key) {
  const workspaces = history != null && typeof history === 'object' && history.workspaces != null
    && typeof history.workspaces === 'object' ? history.workspaces : {}
  return workspaces[key]
}

/* 登记一格：头部插入 / 挪顶 {id, at}、按 id 去重、裁尾到 200。返回新映射与是否
 * 真的变了 —— 会话已在账里时原样返回（**不刷新 at**：它的「发生过」时刻就是第一
 * 次登记那一刻，重复的 pre-step 不该把账越写越新，也不该每轮都碰一次盘）。 */
function branchHistoryRegister(map, key, branch, sessionId, at) {
  const outer = Object.assign({}, map != null && typeof map === 'object' ? map : {})
  const perWorkspace = Object.assign({}, branchHistoryBranchMap(outer, key))
  const previous = Array.isArray(perWorkspace[branch]) ? perWorkspace[branch] : []
  for (let i = 0; i < previous.length; i += 1) {
    const one = previous[i]
    if (one != null && typeof one === 'object' && one.id === sessionId) {
      return { next: outer, changed: false }
    }
  }
  const kept = []
  for (let i = 0; i < previous.length && kept.length < BRANCH_HISTORY_SESSIONS_MAX; i += 1) {
    const one = previous[i]
    if (one == null || typeof one !== 'object' || !isStr(one.id) || one.id.length === 0) continue
    kept.push(one)
  }
  kept.unshift({ id: sessionId, at: typeof at === 'number' && isFinite(at) ? at : Date.now() })
  perWorkspace[branch] = kept.slice(0, BRANCH_HISTORY_SESSIONS_MAX)
  outer[key] = perWorkspace
  return { next: outer, changed: true }
}

/* 收集注入用的清单：该工作区该分支的账里排除当前会话，取最近 limit 条。 */
function branchHistoryEntriesOf(map, key, branch, excludeId, limit) {
  const list = branchHistoryBranchMap(map, key)[branch]
  const rows = Array.isArray(list) ? list : []
  const out = []
  for (let i = 0; i < rows.length && out.length < limit; i += 1) {
    const one = rows[i]
    if (one == null || typeof one !== 'object' || !isStr(one.id) || one.id.length === 0) continue
    if (one.id === excludeId) continue
    out.push(one)
  }
  return out
}

/* 组装注入文本。默认模板的要素是固定的（标题标记、点名仓库与分支、编号清单、
 * 「无需回应」的收尾），措辞可微调；branchPrompts 里配了非空专用提示词时正文
 * 整体换成那份全文、后接「本分支历史会话 id：」与同一份清单。预算照 project-prompt
 * 的算法：上限先扣掉头、尾注与截断说明，正文超了才截，截了在结尾注明。 */
function branchHistoryInjectionText(config, cwd, branch, entries, maxSessions) {
  const lines = []
  for (let i = 0; i < entries.length; i += 1) {
    lines.push(String(i + 1) + '. ' + entries[i].id + ' · ' + branchHistoryStamp(entries[i].at))
  }
  const listText = lines.join('\n')
  const prompts = branchHistoryBranchMap(config.branchPrompts, repoKeyOf(cwd))
  const custom = typeof prompts[branch] === 'string' ? prompts[branch] : ''
  const hasCustom = custom.trim().length > 0
  const head = '[dsh-git-idea · 分支会话历史]\n'
  const body = hasCustom
    ? custom + '\n本分支历史会话 id：\n' + listText
    : '仓库 ' + branchHistoryShortName(cwd) + ' 的分支「' + branch + '」下的历史会话'
      + '（本插件按分支自动记录，最近优先，最多 ' + String(maxSessions) + ' 条）：\n' + listText
      + '\n用途：这些 id 用于定位本分支往来的历史对话；需要回顾先前结论时，可按会话 id'
      + '到 DSH 会话记录目录查找对应内容。本条为自动附加的上下文说明，无需回应。'
  const suffix = '\n（内容过长已截断）'
  const budget = Math.max(0, BRANCH_HISTORY_MAX_INJECTION_BYTES
    - branchHistoryBytes(head) - branchHistoryBytes(suffix))
  const cut = branchHistoryTruncateUtf8(body, budget)
  return head + cut.text + (cut.truncated ? suffix : '')
}

/* 注入消息手写（照 project-prompt 的 buildProjectPromptMessage：{id, role:'user',
 * content:[{type:'text',text}], source:{…}}，三层全部冻结 —— 会话层会把它当不可变
 * 事件收进日志）。source 带上 workspace 与 branch，排查与防重复都靠它。 */
function buildBranchHistoryMessage(text, workspace, branch) {
  const block = Object.freeze({ type: 'text', text: text })
  const source = Object.freeze({ kind: BRANCH_HISTORY_SOURCE_KIND, workspace: workspace, branch: branch })
  return Object.freeze({ id: branchHistoryMessageId(), role: 'user', content: Object.freeze([block]), source: source })
}

/* 会话历史里是否已有本插件的分支历史注入（防重复；兼容 subagent_fork 继承历史）。
 * 只认 source.kind —— 换了分支也不会再注一遍：每个会话只在第一条消息时注入一次，
 * 账是按分支记的，会话内换分支不回头补注（那一轮的决策已经做了一半）。 */
function hasPriorBranchHistoryInjection(agent, messages) {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (message != null && typeof message === 'object' && message.source != null
      && typeof message.source === 'object' && message.source.kind === BRANCH_HISTORY_SOURCE_KIND) return true
  }
  const nodes = agent != null && agent.session != null ? agent.session.surface.nodes : null
  if (Array.isArray(nodes)) {
    const eventAt = agent.session.eventAt
    for (let i = 0; i < nodes.length; i += 1) {
      let event = null
      try {
        event = typeof eventAt === 'function' ? eventAt.call(agent.session, nodes[i]) : undefined
      } catch (error) { event = null }
      const source = event != null && typeof event === 'object' && event.type === 'user/message'
        && event.data != null && typeof event.data === 'object' ? event.data.source : null
      if (source != null && typeof source === 'object' && source.kind === BRANCH_HISTORY_SOURCE_KIND) return true
    }
  }
  return false
}

/* 登记一笔（无条件做，不看开关）：改的是 readConfigFile 缓存上 branchSessions 那一
 * 格、其余键原样带过去（draftSave / saveWorkspaceRepo 同一条路），写盘走会话沙箱
 * （args 里带 sessionId，writeConfigFile 在任何工作区之外的那段说明）。写失败
 * （只读会话沙箱等）一律安静跳过 —— 登记是背景记账，账写不进去不能变成一次对话
 * 的失败，注入也照常按内存里那份账走；没变（重复登记）就连盘都不碰。 */
async function branchHistoryRecord(sessionId, cwd, branch, at) {
  const key = repoKeyOf(cwd)
  const config = await readConfigFile()
  const registered = branchHistoryRegister(config.branchSessions, key, branch, sessionId, at)
  if (registered.changed !== true) return
  try {
    await writeConfigFile(Object.assign({}, config, { branchSessions: registered.next }), { sessionId: sessionId })
  } catch (error) {
    /* 安静：写不进去的账下一次会话再记，不影响本次对话。 */
  }
}

/* pre-step 注入与登记的注册体（80-rpc.js 在 RPC 注册之后调用）。 */
function registerBranchHistory(ctx) {
  try {
    const offPreStep = ctx.on('agent/pre-step', async function (payload, next) {
      /* 先放行底层决策（与 project-prompt 相同的瀑布顺序：都基于 next() 的结果操作，
         谁先谁后插入锚点都是最后一条 claimed 之后）。 */
      const decision = await next()
      try {
        if (payload.step !== 1) return decision
        const messages = payload.messages
        if (!Array.isArray(messages) || messages.length === 0) return decision
        const agent = payload.agent
        const session = agent != null ? agent.session : null
        const header = session != null ? session.header : null
        if (header == null) return decision
        /* 子代理会话不登记不注入：origin 标出来的，与 fork 出来带着父会话的，同算。 */
        if (header.origin === 'subagent') return decision
        if (header.parentSession != null) return decision
        const cwd = header.cwd
        /* cwd 的口径用 isStoredPath（70-config.js）：ssh:// 远程工作区的会话一样
           登记 —— 那正是这套账最有用的一类会话。 */
        if (!isStr(cwd) || cwd.length === 0 || isStoredPath(cwd) !== true) return decision
        const sessionId = session.id
        if (!isStr(sessionId) || sessionId.length === 0) return decision
        /* 防重复（每会话只走一遍）：本轮 claimed 或 surface 历史里已有本插件注入。 */
        if (hasPriorBranchHistoryInjection(agent, messages)) return decision
        const args = { sessionId: sessionId }
        const branch = await branchHistoryCurrentBranch(args, cwd)
        if (branch.length === 0) return decision
        /* 登记（无条件）→ 开关判定（工作区显式值 ?? 全局默认）→ 收集 → 注入。
           登记后再读一次配置：writeConfigFile 成功时缓存已换新，开关读的是写完
           之后的现实；失败时缓存照旧，注入按旧账走 —— 两头都不需要这里操心。 */
        await branchHistoryRecord(sessionId, cwd, branch, Date.now())
        const config = await readConfigFile()
        const history = config.branchHistory != null && typeof config.branchHistory === 'object' ? config.branchHistory : {}
        const key = repoKeyOf(cwd)
        const on = branchHistorySwitchOf(history, key)
        const effective = typeof on === 'boolean' ? on : history.defaultOn === true
        if (effective !== true) return decision
        const maxSessions = typeof history.maxSessions === 'number' && history.maxSessions >= 1
          ? history.maxSessions : BRANCH_HISTORY_MAX_SESSIONS_DEFAULT
        const entries = branchHistoryEntriesOf(config.branchSessions, key, branch, sessionId, maxSessions)
        if (entries.length === 0) return decision
        const desired = buildBranchHistoryMessage(
          branchHistoryInjectionText(config, cwd, branch, entries, maxSessions), cwd, branch)
        /* 编排（照 project-prompt 的先例，去掉 inbox 兜底，理由见文件头）： */
        const decisionMessages = decision != null && Array.isArray(decision.messages) ? decision.messages : []
        if (decision == null || decision.kind === 'reject' || decisionMessages.length === 0) return decision
        const lastClaimedIndex = decisionMessages.findLastIndex(function (message) { return messages.includes(message) })
        const entered = decisionMessages.toSpliced(lastClaimedIndex + 1, 0, desired)
        console.info('dsh-git-idea: 已注入分支会话历史（分支=' + branch + '，'
          + String(entries.length) + ' 条，'
          + String(branchHistoryBytes(desired.content[0].text)) + ' 字节）')
        return Object.assign({}, decision, { messages: entered })
      } catch (error) {
        /* 失败安全：任何异常只告警，放行原决策 —— 绝不炸宿主。 */
        console.warn('dsh-git-idea: 分支会话历史注入失败，放行原决策', String(error))
        return decision
      }
    })
    if (typeof offPreStep === 'function') {
      ctx.effect(function () {
        return function () {
          try { offPreStep() } catch (error) { console.warn('dsh-git-idea: 分支会话历史监听反注册失败', String(error)) }
        }
      }, 'dsh-git-idea branch-history pre-step')
    }
  } catch (error) {
    console.warn('dsh-git-idea: 注册分支会话历史监听失败（其余 RPC 不受影响）', String(error))
  }
}

/* ── 三条 RPC 的处理体（注册在 80-rpc.js）── */

/* 读：chip 滑块与配置页「分支会话历史」组的数据源。工作区 = 会话 cwd（onRpc 前置
 * 的 withSessionRepo 已解到 input.sessionCwd，sessionWorkdir 优先读它）；拿不到
 * 工作区时其余字段答全局默认、workspace:null —— 客户端据此画灰态。prompts/counts
 * 都只答**本工作区**那格（别的仓库的提示词与账与这里无关）。branch 拿不到（不是
 * 仓库 / detached / git 失败）答空串，客户端说明「当前分支读不到」。 */
async function branchHistorySnapshot(input) {
  const workspace = sessionWorkdir(input)
  const config = await readConfigFile()
  const history = config.branchHistory != null && typeof config.branchHistory === 'object' ? config.branchHistory : {}
  const key = workspace !== undefined ? repoKeyOf(workspace) : null
  let branch = ''
  if (workspace !== undefined) branch = await branchHistoryCurrentBranch(argsAt(input, null), workspace)
  const counts = {}
  if (key !== null) {
    const sessions = branchHistoryBranchMap(config.branchSessions, key)
    for (const name in sessions) {
      if (!Object.prototype.hasOwnProperty.call(sessions, name)) continue
      counts[name] = Array.isArray(sessions[name]) ? sessions[name].length : 0
    }
  }
  const on = key !== null ? branchHistorySwitchOf(history, key) : undefined
  return {
    ok: true,
    workspace: workspace !== undefined ? workspace : null,
    defaultOn: history.defaultOn === true,
    maxSessions: typeof history.maxSessions === 'number' && history.maxSessions >= 1 ? history.maxSessions : BRANCH_HISTORY_MAX_SESSIONS_DEFAULT,
    on: typeof on === 'boolean' ? on : null,
    effective: typeof on === 'boolean' ? on : history.defaultOn === true,
    branch: branch,
    prompts: key !== null ? branchHistoryBranchMap(config.branchPrompts, key) : {},
    counts: counts,
  }
}

/* 写工作区开关：on:true|false 写一格；reset:true 删掉该格（回退全局默认）。
 * 同值不落盘（saveAppliedRepo 同一条纪律 —— 重申式点击常来同值）。答复带写完
 * 之后读回来的 on / effective：写失败时缓存没动，答复照旧诚实。 */
async function branchHistorySwitchSave(input) {
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) return { ok: false, error: 'no-path', workspace: null }
  const key = repoKeyOf(workspace)
  const config = await readConfigFile()
  const history = config.branchHistory != null && typeof config.branchHistory === 'object' ? config.branchHistory : {}
  const previous = branchHistorySwitchOf(history, key)
  let on
  let sameNow
  if (input != null && input.reset === true) {
    on = null
    sameNow = previous === undefined
  } else {
    on = input != null ? input.on : undefined
    if (on !== true && on !== false) {
      return { ok: false, error: 'bad-value', workspace: workspace, stderr: 'on 必须是 true 或 false（回退全局默认请带 reset:true）' }
    }
    sameNow = previous === on
  }
  if (sameNow !== true) {
    const workspaces = Object.assign({}, history.workspaces != null && typeof history.workspaces === 'object' ? history.workspaces : {})
    if (on === null) delete workspaces[key]
    else workspaces[key] = on
    const written = await writeConfigFile(
      Object.assign({}, config, { branchHistory: Object.assign({}, history, { workspaces: workspaces }) }),
      argsAt(input, null))
    if (written.ok !== true) return written
  }
  const fresh = await readConfigFile()
  const freshHistory = fresh.branchHistory != null && typeof fresh.branchHistory === 'object' ? fresh.branchHistory : {}
  const freshOn = branchHistorySwitchOf(freshHistory, key)
  return {
    ok: true,
    on: typeof freshOn === 'boolean' ? freshOn : null,
    effective: typeof freshOn === 'boolean' ? freshOn : freshHistory.defaultOn === true,
    workspace: workspace,
  }
}

/* 写当前分支的专用提示词：branch trim 非空 ≤200；text ≤4000、trim 后空 = 删除该
 * 分支条目（「清空了输入框」也是一条答案，与 drafts 同一条规矩）。答复带本工作区
 * 写完之后的 prompts 与 counts，客户端拿它刷新收纳列表。 */
async function branchPromptSave(input) {
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) return { ok: false, error: 'no-path', workspace: null, prompts: {}, counts: {} }
  const branch = input != null && isStr(input.branch) ? input.branch.trim() : ''
  if (branch.length === 0 || branch.length > BRANCH_PROMPT_BRANCH_LEN_MAX) {
    return { ok: false, error: 'bad-value', workspace: workspace, stderr: '分支名不能为空、不能超过 ' + String(BRANCH_PROMPT_BRANCH_LEN_MAX) + ' 字符', prompts: {}, counts: {} }
  }
  const raw = input != null && isStr(input.text) ? input.text : ''
  if (raw.length > BRANCH_PROMPT_TEXT_MAX) {
    return { ok: false, error: 'bad-value', workspace: workspace, stderr: '提示词最长 ' + String(BRANCH_PROMPT_TEXT_MAX) + ' 字符', prompts: {}, counts: {} }
  }
  const text = raw.slice(0, BRANCH_PROMPT_TEXT_MAX)
  const key = repoKeyOf(workspace)
  const config = await readConfigFile()
  const promptsAll = Object.assign({}, config.branchPrompts != null && typeof config.branchPrompts === 'object' ? config.branchPrompts : {})
  const previousMap = branchHistoryBranchMap(promptsAll, key)
  const perWorkspace = Object.assign({}, previousMap)
  if (text.trim().length === 0) delete perWorkspace[branch]
  else {
    if (perWorkspace[branch] === undefined && Object.keys(perWorkspace).length >= BRANCH_PROMPT_BRANCH_MAX) {
      return { ok: false, error: 'too many branch prompts', workspace: workspace, stderr: '这个工作区最多给 ' + String(BRANCH_PROMPT_BRANCH_MAX) + ' 个分支配提示词', prompts: previousMap, counts: {} }
    }
    perWorkspace[branch] = text
  }
  if (perWorkspace[branch] !== previousMap[branch]) {
    if (Object.keys(perWorkspace).length === 0) delete promptsAll[key]
    else promptsAll[key] = perWorkspace
    const written = await writeConfigFile(Object.assign({}, config, { branchPrompts: promptsAll }), argsAt(input, null))
    if (written.ok !== true) return written
  }
  const fresh = await readConfigFile()
  const freshKey = repoKeyOf(workspace)
  const counts = {}
  const sessions = branchHistoryBranchMap(fresh.branchSessions, freshKey)
  for (const name in sessions) {
    if (!Object.prototype.hasOwnProperty.call(sessions, name)) continue
    counts[name] = Array.isArray(sessions[name]) ? sessions[name].length : 0
  }
  return { ok: true, workspace: workspace, branch: branch, prompts: branchHistoryBranchMap(fresh.branchPrompts, freshKey), counts: counts }
}
