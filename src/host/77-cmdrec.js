/* ─────────────── 面板自己的命令记录器 ───────────────
 *
 * 「命令」页原来只看得见 AI 会话里的 git（76-cmdlog.js 扫会话文件），面板自己经 RPC
 * 跑的 git 一条都不在里面 —— 因为面板走的不是 bash tool，会话文件里根本没有它。这一片
 * 把面板的变更类执行记下来：内存环形缓冲是本会话的事实源，旁边那份 JSONL 是尽力而为的
 * 持久化（换会话/重启之后还能翻到），liveHub（真包的 pkg 前奏，src/pkg/host-pre.js）
 * 把开始/结束实时推给浏览器。
 *
 * 三个刻意的取舍：
 *
 * · 只记变更，不记读 —— 读被 watcher 每 3 秒刷一次，记下来整页都是噪音。写读分离的
 *   分界线就是 panelMutate / quickRun / switchBranch 这些变更入口（见 68/70/78/80 各片）。
 * · 持久化经 invoke（shell）而不是文件服务 —— 与 70-config.js 的配置文件同一个理由：
 *   这份文件住在部署的配置目录（任何工作区之外），按工作区发策略的文件服务写不进去。
 *   追加失败只记日志，内存照常工作 —— 持久化本来就是尽力而为。
 * · 退出码不重写原行，追加一条 {cmdrec:'exit', id, exitCode} 更新行 —— 追加是这条通道
 *   唯一的写法（并发安全、不用读改写），读侧（cmdrecParseTail）把同 id 的更新合回起点行。
 * · 落盘不在变更执行的路上 —— 写一行就是多付一个 shell 进程，而面板的变更命令个个都
 *   在读者盯着的时候跑，记录不该收命令的过路费（测试套件也在数变更路径上的进程，
 *   「一次都不多花」是它们的判据）。行先进待写队列，由两个免费时机冲出去：下一次读
 *   命令记录（cmdrecPanelRows）顺手冲一次，或 10 秒没有新记录的定时器到点 —— 宿主
 *   常驻时最多晚 10 秒，等不等到都不影响内存这份事实源。 */

/* 环形上限与会话扫描（76-cmdlog.js 的 CMDLOG_LIMIT_MAX）同一个数：一页最多也就看这么
   多，再多是给合并去重留的余量，不是给屏幕的。 */
const CMDREC_MAX = 2000
const CMDREC_COMMAND_MAX = 2000
const CMDREC_DESC_MAX = 120
/* 持久化文件的体积管理：超过约 600KB 就截回最近 400KB（tail 保尾，旧命令让位）；平时
   不查体积 —— 每累计写了约 256KB 才问一次，省得每条记录多付一个进程。 */
const CMDREC_FILE_MAX_BYTES = 614400
const CMDREC_FILE_KEEP_BYTES = 409600
const CMDREC_TRIM_CHECK_BYTES = 262144
/* 读侧一次最多带多少行：去重靠它和内存对齐，也给 limit 的合并留出余量。 */
const CMDREC_TAIL_LINES = 2000

const cmdrecRing = []
let cmdrecSeq = 0
let cmdrecWritten = 0
let cmdrecFileCache
let cmdrecDirTried = false

/* 待写队列与它的单例定时器：10 秒没有新记录就把攒下的行一次冲出去。unref 让宿主
   进程退出时不为它等待 —— 记录的持久化不值得拖住任何人。 */
const CMDREC_FLUSH_MS = 10000
let cmdrecPending = []
let cmdrecFlushTimer = null

function cmdrecQueue(line) {
  cmdrecPending.push(line)
  if (cmdrecFlushTimer !== null) return
  cmdrecFlushTimer = setTimeout(function () { cmdrecFlushTimer = null; cmdrecFlush() }, CMDREC_FLUSH_MS)
  if (typeof cmdrecFlushTimer.unref === 'function') cmdrecFlushTimer.unref()
}

/* liveHub 由真包的 pkg 前奏提供；bridge 版（build.mjs 的 host.js）没有 pkg 层，这里
   靠 typeof 守卫安静地退化成无推送 —— 面板记录本身两种构建都在。 */
function liveSend(payload) {
  if (typeof liveHub === 'undefined' || liveHub == null) return
  liveHub.send(payload)
}

/* 记录文件与插件配置文件（70-config.js 的 configPath）同目录：记录跟着部署走，
   而不是跟着某个工作区。 */
async function cmdrecFile() {
  if (cmdrecFileCache !== undefined) return cmdrecFileCache
  const path = await configPath()
  cmdrecFileCache = path === null ? null : path.slice(0, path.lastIndexOf('/')) + '/dsh-git-idea.commands.jsonl'
  return cmdrecFileCache
}

/* 与 76-cmdlog.js 扫描脚本里的 trimSlash 同一个问题：比较目录时尾部斜杠不作数。 */
function cmdrecTrimSlash(path) {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/* 冲刷：把队列里攒下的行一次追加完（一条 printf、一次进程），然后照旧问一次体积。
   读侧（cmdrecPanelRows）进来先冲，文件与内存不脱节；这里的任何故障都只记日志 ——
   读命令记录不该被一条写失败的记录绊倒，内存照常工作。 */
async function cmdrecFlush() {
  if (cmdrecPending.length === 0) return
  if (cmdrecFlushTimer !== null) {
    clearTimeout(cmdrecFlushTimer)
    cmdrecFlushTimer = null
  }
  const lines = cmdrecPending
  cmdrecPending = []
  try {
    await cmdrecAppendLines(lines)
  } catch (error) {
    console.error('dsh-git-idea: 面板命令记录写盘失败（内存记录不受影响）', String(error))
  }
}

/* 追加若干行 JSONL。配置目录大概率已经在（配置文件就住在那里）；第一次写顺手
   mkdir -p 一回，之后不再付这个进程。 */
async function cmdrecAppendLines(lines) {
  const file = await cmdrecFile()
  if (file === null) return
  const text = lines.join('')
  const first = cmdrecDirTried !== true
  cmdrecDirTried = true
  const wrote = await invoke(
    (first === true ? 'mkdir -p ' + shq(file.slice(0, file.lastIndexOf('/'))) + ' && ' : '')
      + 'printf %s ' + shq(text) + ' >> ' + shq(file) + '\n',
    {}, null, { timeoutMs: 10000 })
  if (wrote.exitCode !== 0) {
    console.error('dsh-git-idea: 面板命令记录写不进 ' + file + '（内存记录不受影响）', wrote.stderr.slice(0, 200))
    return
  }
  cmdrecWritten += text.length
  if (cmdrecWritten >= CMDREC_TRIM_CHECK_BYTES) {
    cmdrecWritten = 0
    await cmdrecTrimFile(file, {})
  }
}

/* 体积检查：`cat | wc -c` 而不是 `wc -c <` —— 文件不在时前者安静地给 0，后者往外蹦
   一句错。超限就 tail 保尾，mv 原子替换；截不动（只读目录）只记日志，继续追加。 */
async function cmdrecTrimFile(file, args) {
  const trimmed = await invoke(
    's=$(cat ' + shq(file) + ' 2>/dev/null | wc -c); if [ "$s" -gt ' + String(CMDREC_FILE_MAX_BYTES) + ' ]; then '
      + 'tail -c ' + String(CMDREC_FILE_KEEP_BYTES) + ' ' + shq(file) + ' > ' + shq(file + '.t')
      + ' && mv ' + shq(file + '.t') + ' ' + shq(file) + '; fi\n',
    args, null, { timeoutMs: 10000 })
  if (trimmed.exitCode !== 0) {
    console.error('dsh-git-idea: 面板命令记录截断失败（继续追加）', trimmed.stderr.slice(0, 200))
  }
}

/* 命令开始：进内存、广播、起点行进待写队列（此刻就定稿 —— exitCode 为 null 的
   「运行中」行，不随 entry 之后被 cmdrecFinish 改写）。 */
function cmdrecBegin(input, desc, command, cwd) {
  cmdrecSeq += 1
  const entry = {
    id: 'p' + String(Date.now()) + '-' + String(cmdrecSeq) + '-' + Math.random().toString(36).slice(2, 6),
    time: Date.now(),
    command: isStr(command) ? (command.length > CMDREC_COMMAND_MAX ? command.slice(0, CMDREC_COMMAND_MAX) : command) : '',
    description: isStr(desc) && desc.length > 0 ? (desc.length > CMDREC_DESC_MAX ? desc.slice(0, CMDREC_DESC_MAX) : desc) : '面板操作',
    cwd: isStr(cwd) && cwd.length > 0 ? cwd : '',
    exitCode: null,
    source: 'panel',
    sessionId: input != null && isStr(input.sessionId) ? input.sessionId : '',
  }
  cmdrecRing.push(entry)
  if (cmdrecRing.length > CMDREC_MAX) cmdrecRing.splice(0, cmdrecRing.length - CMDREC_MAX)
  liveSend(JSON.stringify({ kind: 'cmdlog-start', entry: entry }))
  cmdrecQueue(JSON.stringify(entry))
  return entry
}

/* 命令结束：补退出码、广播、退出码更新行进待写队列（同 id 合回起点行由读侧做）。 */
function cmdrecFinish(entry, exitCode) {
  if (entry == null) return
  entry.exitCode = typeof exitCode === 'number' ? exitCode : null
  liveSend(JSON.stringify({ kind: 'cmdlog-exit', id: entry.id, exitCode: entry.exitCode }))
  cmdrecQueue(JSON.stringify({ cmdrec: 'exit', id: entry.id, exitCode: entry.exitCode }))
}

/* switchBranch（66-refs.js）这类不经 panelMutate 的变更入口：把它们手里那次 git 调用
   原样包上记录 —— 跑什么、结果是什么都由调用方说了算，这里只管开始/结束两笔。 */
async function cmdrecGit(input, desc, argv, run) {
  const entry = cmdrecBegin(input, desc, gitExe + ' ' + argv.join(' '), repoFrom(input, null))
  const result = await run()
  cmdrecFinish(entry, result != null ? result.exitCode : null)
  return result
}

/* ── 读侧：把三个来源合成一份 ── */

/* 持久化文件的尾部 + 内存缓冲。同一 id 两边都有时以内存为准（它带着本会话最新的
   退出码），文件只补内存里没有的旧记录。 */
async function cmdrecPanelRows() {
  const rows = []
  for (let i = 0; i < cmdrecRing.length; i += 1) rows.push(Object.assign({}, cmdrecRing[i]))
  const file = await cmdrecFile()
  if (file === null) return { rows: rows, clipped: false }
  /* 读之前先把待写队列冲出去：文件尽快跟上内存，尾部这份也读到最新的行。冲刷失败
     不拦读 —— 它自己的失败已经记过日志了。 */
  await cmdrecFlush()
  /* `C:` 头一行带文件总行数（tail 之前先数一遍），tail 给尾部 2000 行 —— 尾部截过
     没截过（clipped）由这两个数对比得出，与 72-gitbin.js 面板脚本的 marker 约定同款。 */
  const probe = await invoke(
    'printf \'C:%s\\n\' "$(cat ' + shq(file) + ' 2>/dev/null | wc -l)"\n'
      + 'tail -n ' + String(CMDREC_TAIL_LINES) + ' ' + shq(file) + ' 2>/dev/null\n',
    {}, null, { timeoutMs: 10000 })
  if (probe.exitCode !== 0 || probe.stdout.length === 0) return { rows: rows, clipped: false }
  const tail = cmdrecParseTail(probe.stdout)
  const seen = {}
  for (let i = 0; i < rows.length; i += 1) seen[rows[i].id] = true
  for (let i = 0; i < tail.rows.length; i += 1) {
    if (seen[tail.rows[i].id] !== true) rows.push(tail.rows[i])
  }
  return { rows: rows, clipped: tail.clipped }
}

/* 尾部文本 → 记录行。宽容解析：半行、坏 JSON 一律跳过（追加写入断在半路是这条通道
   的常态，不是错误）；退出码更新行合回同 id 的起点行，合成最终态。 */
function cmdrecParseTail(stdout) {
  const lines = stdout.split('\n')
  let total = -1
  const starts = []
  const exits = {}
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.length === 0) continue
    if (line.indexOf('C:') === 0) {
      const asked = parseInt(line.slice(2), 10)
      if (isNaN(asked) === false) total = asked
      continue
    }
    let raw = null
    try {
      raw = JSON.parse(line)
    } catch (error) {
      raw = null
    }
    if (raw == null || typeof raw !== 'object') continue
    if (raw.cmdrec === 'exit' && isStr(raw.id)) {
      exits[raw.id] = typeof raw.exitCode === 'number' ? raw.exitCode : null
      continue
    }
    if (isStr(raw.id) === false) continue
    starts.push({
      id: raw.id,
      time: typeof raw.time === 'number' ? raw.time : (Date.parse(raw.time) || 0),
      command: isStr(raw.command) ? raw.command : '',
      description: isStr(raw.description) ? raw.description : '',
      cwd: isStr(raw.cwd) ? raw.cwd : '',
      exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
      source: 'panel',
      sessionId: isStr(raw.sessionId) ? raw.sessionId : '',
    })
  }
  for (let i = 0; i < starts.length; i += 1) {
    if (Object.prototype.hasOwnProperty.call(exits, starts[i].id)) starts[i].exitCode = exits[starts[i].id]
  }
  return { rows: starts, clipped: total > CMDREC_TAIL_LINES }
}

/* 命令页按工作区看，面板行却可能落在多仓库清单里的任何一个仓库上：本会话发的一律
   算（sessionId 对得上），别的工作区面板发的只按目录归位 —— 两个都套不上才丢。 */
function cmdrecScopeRows(rows, sessionId, workspace) {
  const out = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (isStr(sessionId) && sessionId.length > 0 && row.sessionId === sessionId) {
      out.push(row)
      continue
    }
    const at = isStr(row.cwd) ? row.cwd.trim() : ''
    /* 目录量不出来的行不悄悄吞：宁可多显示一条，不无故少一条。 */
    if (at.length === 0 || cmdrecTrimSlash(at) === cmdrecTrimSlash(workspace)) out.push(row)
  }
  return out
}

/* 若干份列表 → 一份：按 time 降序（与会话扫描同一个比较器），有 id 的按 id 去重
   （文件与内存各一份是常态；会话扫描出来的行没有 id，照单全收），排序在前、去重
   在后，留的永远是新的那条。 */
function cmdrecMerge(lists) {
  const all = []
  for (let i = 0; i < lists.length; i += 1) {
    const list = lists[i]
    if (Array.isArray(list) === false) continue
    for (let j = 0; j < list.length; j += 1) all.push(list[j])
  }
  all.sort(function (a, b) { return (parseFloat(b.time) || 0) - (parseFloat(a.time) || 0) })
  const seen = {}
  const out = []
  for (let i = 0; i < all.length; i += 1) {
    const one = all[i]
    if (one != null && isStr(one.id)) {
      if (seen[one.id] === true) continue
      seen[one.id] = true
    }
    out.push(one)
  }
  return out
}
