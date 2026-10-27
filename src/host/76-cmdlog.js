/* ─────────────── 这个工作区里执行过的 git 命令 ───────────────
 *
 * 面板「命令」页的数据源不是仓库，而是 DSH 自己的会话记录：每个会话完整落在
 * `${DSH_HOME:-$HOME/.dsh}/sessions/<workspace-slug>/<sessionId>/session.v4.jsonl.zstd`，
 * bash 调用（tool/call）和它的输出（tool/result，尾部可能带 "[exit code: N]"）都在里面。
 *
 * 两个事实决定了这里的样子：
 *
 * · host 片段不能 require 任何 node 模块，而会话文件是多帧 zstd —— 所以扫描本体
 *   是下面 CMDLOG_SCRIPT 那段独立脚本，由 `node -e` 在会话沙箱里跑。它和这个插件
 *   的其它读走同一条 invoke：workdir、超时、沙箱策略都跟其它 RPC 一致，被拒绝时
 *   答复里说得出来，而不是拿一个空列表假装「这个项目没跑过 git」。
 * · 会话记录按工作区分目录（slug = 工作区 cwd 的 '/' 换成 '-' 再前后包 '--'），
 *   所以先按 slug 直接定位；slug 目录不存在时（规则变过、目录被改名）退化为逐目录
 *   读第一条 session 记录的 cwd 比对 —— 只认完全一致的工作区，别的 workspace 的
 *   记录一个字节也不读。
 * · 全量重扫在慢盘上是秒级开销（459 个文件、129MB 的真实工作区实测 4s 上下），而
 *   绝大多数会话文件几周不变 —— 所以扫描结果按文件记一本 (mtimeMs, size) 账
 *   （文件尾「扫描账本」一块）：账热时命令页立即用账答复，stat 扫描 + 只解析
 *   变化文件的增量刷新放后台，变了把增量推回去；「重新读取」仍是强制全量。
 *
 * 这一页的数据源不止会话一份：面板自己经 RPC 跑的 git 记在 77-cmdrec.js（内存 +
 * JSONL 文件），commandLogSnapshot 在出口处把两路合并、按 id 去重、套 limit ——
 * 详见文件尾那个函数的注释。 */

/* 沙箱拒绝、node 不在、脚本没跑成，各自要一句说得出来的话；绝不能把它们折叠成
 * 「commands: []」—— 那是「这个项目没执行过 git」的答案，而这三种情况是「读不了」。 */

/* DSH_HOME 的取法和 configPath（70-config.js）是同一个问题，所以是同一个问法：
 * `printf %s "${DSH_HOME:-$HOME/.dsh}"`。缓存一份 —— 每次读都问一遍 shell，只是
 * 把同一次 spawn 的答案换个地方存。 */
let cmdlogHomeCache

async function cmdlogHome() {
  if (cmdlogHomeCache !== undefined) return cmdlogHomeCache
  const probe = await invoke('printf %s "${DSH_HOME:-$HOME/.dsh}"', {}, null, { timeoutMs: 10000 })
  const home = probe.exitCode === 0 ? probe.stdout.trim() : ''
  cmdlogHomeCache = home.length > 0 ? home : null
  return cmdlogHomeCache
}

/* workspace-slug：cwd 里每个 '/' 换成 '-'，前后各包一段 '--'。
 * 例：/code/www/my/github/dsh-git-idea → --code-www-my-github-dsh-git-idea-- */
function cmdlogSlug(cwd) {
  return '--' + cwd.split('/').join('-') + '--'
}

const CMDLOG_DEFAULT_LIMIT = 500
/* limit 封顶：这条通道一次只跑一个处理函数，而单条 command 已截到 2000 字符，
 * 一个没上限的 limit 能把整块 UI 按在这里。2000 条 × 约 2KB 仍在 16MB 的
 * stdout 上限之内。 */
const CMDLOG_LIMIT_MAX = 2000
const CMDLOG_TIMEOUT = { timeoutMs: 60000, maxBytes: 16777216 }
/* node 缺席的判据照抄 gitGuard（10-shell.js）的思路：先问 `command -v`，用 marker
 * 词 + 127 回答，而不是去匹配 bash 那句会被翻译的话。 */
const CMDLOG_NO_NODE = 'dsh-git-idea: no node on PATH'

/* ── 扫描本体：一条在独立 node 进程里跑的脚本 ──
 *
 * 引号是这里唯一的坑：脚本经 shq 单引号包裹交给 shell，所以脚本自身一个 ASCII
 * 单引号都不能出现（注释也一样），字符串一律用双引号。风格与 host 片段一致：
 * const + function 表达式，不用箭头函数。
 *
 * 两个模式（账本化，见下面「扫描账本」一块）：
 * · scan —— 全量扫：账本播种与「重新读取」的强制全量走这里，每个会话文件都读。
 * · incr —— 增量刷新：argv[5] 带账本地图 {文件路径: [mtimeMs, size]}，stat 与账
 *   对上的文件直接跳过（不读、不解压、不解析），只重扫新增/变化的文件。
 *
 * 输出统一为一行 JSON：{ok:true, files:[…]}，files 每格是一个会话文件的身份
 * （file/sessionId/mtimeMs/size）加它的行（changed:true 才带 commands/total，
 * changed:false 表示「与账本对上了，行在宿主那边」）；排序与 limit 截取都由宿主
 * 做 —— 账内旧行不经过脚本，宿主必须自己合成完整的一份。进程退出码恒为 0 ——
 * 「脚本没跑成」（退出码非 0，由 host 判断）和「跑成了、但读不了」（ok:false，
 * 由脚本自己说原因）是两件事，不会混在一起。 */
const CMDLOG_SCRIPT = [
  'const fs = require("fs")',
  'const zlib = require("zlib")',
  '/* argv：模式 / sessions 根目录 / 期望的工作区 cwd / slug 目录名 / [账本地图]。',
  '   下标从 1 开始 —— `node -e` 的 argv 里没有脚本文件名，参数整体前移一格。 */',
  'const mode = process.argv[1]',
  'const root = process.argv[2]',
  'const wantCwd = process.argv[3]',
  'const slugDir = process.argv[4]',
  'const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])',
  '/* 只认输出文本尾部的标记：正文中提到 "[exit code: N]"（比如复述别的命令的输出）',
  '   不算这条命令的退出码 —— 实测会话里两种都出现。 */',
  'const EXIT_TAIL = /\\[exit code: (\\d+)\\]\\s*$/',
  '/* 「以 git 开头」按词算：git、git status 算，github、gitx 不算。判断只用来过滤，',
  '   展示始终保留整条原始 command。 */',
  'const GIT_HEAD = /^git(?:\\s|$)/',
  'const zstd = zlib.zstdDecompressSync',
  'const noZstd = typeof zstd !== "function"',
  'const say = function (o) { process.stdout.write(JSON.stringify(o) + "\\n") }',
  'const trimSlash = function (p) { return p.length > 1 ? p.replace(/\\/+$/, "") : p }',
  '',
  '/* 多帧 zstd：帧边界没有目录，只能按魔数扫。压缩数据里碰巧出现的魔数会切出一个',
  '   解不开的假帧 —— 解压失败的帧跳过就是，一行都不丢真的。 */',
  'function magicOffsets(buf) {',
  '  const offsets = []',
  '  let pos = 0',
  '  for (;;) {',
  '    const at = buf.indexOf(MAGIC, pos)',
  '    if (at < 0) break',
  '    offsets.push(at)',
  '    pos = at + 1',
  '  }',
  '  return offsets',
  '}',
  '/* visit 返回 false 表示不用再往后解了（firstSessionCwd 找到 session 记录就是）。 */',
  'function framesOf(buf, visit) {',
  '  const offsets = magicOffsets(buf)',
  '  for (let i = 0; i < offsets.length; i += 1) {',
  '    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length',
  '    let text = null',
  '    try { text = zstd(buf.subarray(offsets[i], end)).toString("utf8") } catch (e) { text = null }',
  '    if (text !== null && visit(text) === false) return',
  '  }',
  '}',
  'function recordsOf(text, visit) {',
  '  const lines = text.split("\\n")',
  '  for (let i = 0; i < lines.length; i += 1) {',
  '    if (lines[i].length === 0) continue',
  '    let rec = null',
  '    try { rec = JSON.parse(lines[i]) } catch (e) { rec = null }',
  '    if (rec !== null) visit(rec)',
  '  }',
  '}',
  '',
  '/* 这个文件的第一条 session 记录里的 cwd。文件头几帧里就有，找到即停。 */',
  'function firstSessionCwd(file) {',
  '  let buf = null',
  '  try { buf = fs.readFileSync(file) } catch (e) { return null }',
  '  let cwd = null',
  '  framesOf(buf, function (text) {',
  '    recordsOf(text, function (rec) {',
  '      if (cwd === null && rec.type === "session" && typeof rec.cwd === "string") cwd = rec.cwd',
  '    })',
  '    if (cwd !== null) return false',
  '  })',
  '  return cwd',
  '}',
  '',
  '/* 目录里所有会话文件，按目录名排序求稳定。会话 id 就是目录名 —— 有些带',
  '   session- 前缀，原样返回。原来 existsSync + readFileSync 是两次系统调用，',
  '   现在 statSync 一次带回存在性与 (mtimeMs, size) —— 账本对账正要的就是这两',
  '   个数，9p 盘上少一半往返。 */',
  'function sessionFiles(base) {',
  '  let entries',
  '  try { entries = fs.readdirSync(base, { withFileTypes: true }) } catch (e) { return null }',
  '  const out = []',
  '  for (let i = 0; i < entries.length; i += 1) {',
  '    if (entries[i].isDirectory() !== true) continue',
  '    const file = base + "/" + entries[i].name + "/session.v4.jsonl.zstd"',
  '    let st = null',
  '    try { st = fs.statSync(file) } catch (e) { st = null }',
  '    if (st !== null && st.isFile() === true) out.push({ sessionId: entries[i].name, file: file, mtimeMs: st.mtimeMs, size: st.size })',
  '  }',
  '  return out',
  '}',
  '',
  '/* 只保留 git 命令：整条以 git 开头，或按 &&、;、|、换行切开之后任何一段以',
  '   git 开头（"cd /x && git log" 因此算，"ls" 不算）。 */',
  'function isGitCommand(command) {',
  '  const parts = command.split(/&&|;|\\||\\n/)',
  '  for (let i = 0; i < parts.length; i += 1) {',
  '    if (GIT_HEAD.test(parts[i].replace(/^\\s+/, ""))) return true',
  '  }',
  '  return false',
  '}',
  '',
  '/* 一个会话文件 → 这个会话里所有 git 命令（行数组；读不了返回 null）。callId',
  '   把 tool/call 和它的 tool/result 连起来；退出码从输出尾部解析，拿不到就是',
  '   null（成功命令的记录里本来就没有这个标记）。耗时用两端记录各自的 time',
  '   （v4 记录里 tool/call 与 tool/result 都是纪元毫秒数）相减 —— 哪一端拿不到',
  '   （time 缺失/非数、结果比调用还早的钟偏）就 null，不猜。 */',
  'function scanFile(item) {',
  '  let buf = null',
  '  try { buf = fs.readFileSync(item.file) } catch (e) { return null }',
  '  const calls = []',
  '  const ends = new Map()',
  '  framesOf(buf, function (text) {',
  '    recordsOf(text, function (rec) {',
  '      const data = rec != null ? rec.data : null',
  '      if (data == null) return',
  '      if (rec.type === "tool/call" && data.name === "bash") {',
  '        let a = null',
  '        try { a = JSON.parse(data.arguments) } catch (e) { a = null }',
  '        if (a == null || typeof a.command !== "string") return',
  '        if (isGitCommand(a.command) !== true) return',
  '        calls.push({',
  '          callId: data.callId,',
  '          time: rec.time,',
  '          command: a.command.length > 2000 ? a.command.slice(0, 2000) : a.command,',
  '          description: typeof a.description === "string" ? a.description.slice(0, 500) : "",',
  '          cwd: typeof a.workdir === "string" && a.workdir.length > 0 ? a.workdir : null,',
  '        })',
  '      } else if (rec.type === "tool/result" && data.message != null) {',
  '        const id = data.message.toolCallId',
  '        if (typeof id !== "string" || ends.has(id)) return',
  '        const content = data.message.content',
  '        let text = ""',
  '        if (Array.isArray(content)) {',
  '          for (let i = 0; i < content.length; i += 1) {',
  '            if (content[i] != null && content[i].type === "text" && typeof content[i].text === "string") text += content[i].text',
  '          }',
  '        }',
  '        const found = text.match(EXIT_TAIL)',
  '        ends.set(id, { exit: found !== null ? parseInt(found[1], 10) : null, at: parseFloat(rec.time) })',
  '      }',
  '    })',
  '  })',
  '  const rows = []',
  '  for (let i = 0; i < calls.length; i += 1) {',
  '    const c = calls[i]',
  '    const end = ends.get(c.callId)',
  '    const beganAt = parseFloat(c.time) || 0',
  '    const doneAt = end != null ? end.at : NaN',
  '    rows.push({',
  '      time: c.time,',
  '      command: c.command,',
  '      description: c.description,',
  '      sessionId: item.sessionId,',
  '      cwd: c.cwd,',
  '      exitCode: end != null ? end.exit : null,',
  '      durationMs: !isNaN(doneAt) && doneAt >= beganAt && beganAt > 0 ? doneAt - beganAt : null,',
  '    })',
  '  }',
  '  return rows',
  '}',
  '',
  'function main() {',
  '  if (mode !== "scan" && mode !== "incr") { say({ ok: false, error: "未知的扫描模式：" + String(mode) }) ; return }',
  '  let ledgerFiles = {}',
  '  if (mode === "incr") {',
  '    try { ledgerFiles = JSON.parse(process.argv[5] || "{}") } catch (e) { ledgerFiles = {} }',
  '    if (ledgerFiles == null || typeof ledgerFiles !== "object" || Array.isArray(ledgerFiles)) ledgerFiles = {}',
  '  }',
  '  if (fs.existsSync(root) !== true) {',
  '    /* 整个机器还没有任何会话记录 —— 这不是错误，是「一条也没执行过」。 */',
  '    say({ ok: true, files: [] })',
  '    return',
  '  }',
  '  const targets = []',
  '  const slugPath = root + "/" + slugDir',
  '  if (fs.existsSync(slugPath) === true) {',
  '    /* 优先按 slug 定位。slug 目录本身读不了（比如权限）必须报出来，否则主路',
  '       径会安静地变成空列表。 */',
  '    const found = sessionFiles(slugPath)',
  '    if (found === null) { say({ ok: false, error: "会话目录读不了：" + slugPath }) ; return }',
  '    targets.push.apply(targets, found)',
  '  } else {',
  '    let entries = null',
  '    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch (e) { entries = null }',
  '    if (entries === null) { say({ ok: false, error: "会话根目录读不了：" + root }) ; return }',
  '    for (let i = 0; i < entries.length; i += 1) {',
  '      if (entries[i].isDirectory() !== true) continue',
  '      const base = root + "/" + entries[i].name',
  '      const found = sessionFiles(base)',
  '      if (found === null) continue',
  '      for (let j = 0; j < found.length; j += 1) {',
  '        const cwd = firstSessionCwd(found[j].file)',
  '        if (cwd !== null && trimSlash(cwd) === trimSlash(wantCwd)) {',
  '          targets.push.apply(targets, found)',
  '          break',
  '        }',
  '      }',
  '    }',
  '  }',
  '  if (noZstd === true && targets.length > 0) {',
  '    /* 每个 zstd 文件都被「跳过」的话，空列表就成了谎话 —— 这里明确说读不了。 */',
  '    say({ ok: false, error: "这个 node 没有 zstd 解压支持（需要 Node >= 22.15），读不了会话记录" })',
  '    return',
  '  }',
  '  const files = []',
  '  let openedAny = false',
  '  for (let i = 0; i < targets.length; i += 1) {',
  '    const item = targets[i]',
  '    const known = ledgerFiles[item.file]',
  '    if (mode === "incr" && Array.isArray(known) && known.length === 2',
  '      && parseFloat(known[0]) === item.mtimeMs && parseFloat(known[1]) === item.size) {',
  '      /* stat 与账本对上了：不读不解不析，行在宿主的账里。 */',
  '      files.push({ file: item.file, sessionId: item.sessionId, mtimeMs: item.mtimeMs, size: item.size, changed: false })',
  '      openedAny = true',
  '      continue',
  '    }',
  '    const rows = scanFile(item)',
  '    if (rows === null) {',
  '      files.push({ file: item.file, sessionId: item.sessionId, mtimeMs: item.mtimeMs, size: item.size, changed: true, failed: true })',
  '      continue',
  '    }',
  '    openedAny = true',
  '    files.push({ file: item.file, sessionId: item.sessionId, mtimeMs: item.mtimeMs, size: item.size, changed: true, commands: rows, total: rows.length })',
  '  }',
  '  if (targets.length > 0 && openedAny !== true) {',
  '    /* 全量模式下一个都打不开、或增量模式下变化过的全打不开 —— 这是「读不了」，',
  '       不是「没执行过」。账里对上的文件算开过：它们在上一轮就打开成功过。 */',
  '    say({ ok: false, error: "会话文件一个也打不开（" + targets.length + " 个）" })',
  '    return',
  '  }',
  '  say({ ok: true, files: files })',
  '}',
  '',
  'try { main() } catch (e) { say({ ok: false, error: "扫描会话记录时出错了：" + String(e && e.message ? e.message : e) }) }',
].join('\n')

/* ── 扫描账本 ──
 *
 * 命令页原来每次答复都对工作区全部会话文件 readdir + 逐个 stat + 逐帧 zstd 解压
 * + 全量 JSON 解析。真实工作区（459 个会话目录、129MB，9p 慢盘）实测仅 IO 就
 * 2.2s，加解压与解析再 1–2s —— 而那 459 个文件里绝大多数几周没变过。这里按会话
 * 文件记一本账：(mtimeMs, size) 没变的文件直接复用上次解析出的行，只重扫新增/
 * 变化的文件；消失的文件从账本摘除。扫描与对账的分界在脚本：宿主把账本地图
 * {文件: [mtimeMs, size]} 交给 incr 模式，脚本 stat 完只解析对不上的那几个。
 *
 * 有界（上限的选择都写死在这里）：
 * · 一区一本，最多 CMDLOG_LEDGER_WORKSPACES_MAX 本（LRU，超出整本摘除）——宿主
 *   同时伺候的工作区就几个，8 本是宽余量；摘除只损失缓存，下次全量重扫补回。
 * · 每本最多 CMDLOG_LEDGER_FILES_MAX 个文件 —— 真实工作区实测 459 个，留三成
 *   余量；超出按「账内最新一行最旧」的文件整份摘除，下次刷新重扫它，只慢不错。
 * · 单文件账内最多 CMDLOG_LEDGER_ROWS_MAX 行、整本最多 CMDLOG_LEDGER_ROWS_MAX_TOTAL
 *   行，都只保最新（time 降序）——单页答复上限是 2000（CMDLOG_LIMIT_MAX），每
 *   文件保最新 2000 条足以让「全局最新 limit 条」永远落在账内；整本 6 万行是实
 *   测量级（459 个文件约 2–3 万行）的 2–3 倍余量，普通行几百字节，内存以十 MB 计。
 *
 * 账本只活在内存里 —— 它是缓存不是事实源，事实源永远是会话文件本身；宿主重启
 * 丢了账只慢一次（下一次冷扫描原样重建），不会错一个字。冷启动正确性是硬约束：
 * 账为空时的答复必须与全量扫描一字不差，所以播种账本用的就是同一次全量扫描的
 * 原始输出，行不经任何改写。 */
const CMDLOG_LEDGER_WORKSPACES_MAX = 8
const CMDLOG_LEDGER_FILES_MAX = 600
const CMDLOG_LEDGER_ROWS_MAX = 2000
const CMDLOG_LEDGER_ROWS_MAX_TOTAL = 60000
/* 后台刷新完成时给命令页推送的行数上限：与客户端的合并容量（CMDLOG_LIVE_MAX）
 * 同一个数 —— 推再多也只会被截掉。 */
const CMDLOG_LIVE_PUSH_MAX = 600
const cmdlogLedgers = new Map()
const cmdlogLedgerBusy = new Set()

function cmdlogLedgerGet(workspace) {
  const ledger = cmdlogLedgers.get(workspace)
  if (ledger === undefined) return null
  /* Map 的迭代顺序即插入序：删了再插回队尾就是 LRU 的「摸一下」。 */
  cmdlogLedgers.delete(workspace)
  cmdlogLedgers.set(workspace, ledger)
  return ledger
}

function cmdlogLedgerSet(workspace, ledger) {
  cmdlogLedgers.delete(workspace)
  cmdlogLedgers.set(workspace, ledger)
  while (cmdlogLedgers.size > CMDLOG_LEDGER_WORKSPACES_MAX) {
    const oldest = cmdlogLedgers.keys().next().value
    cmdlogLedgers.delete(oldest)
  }
}

function cmdlogNewestOf(rows) {
  let newest = 0
  for (let i = 0; i < rows.length; i += 1) {
    const at = parseFloat(rows[i] != null ? rows[i].time : null) || 0
    if (at > newest) newest = at
  }
  return newest
}

/* 脚本的 files 输出 + 上一本账 → 新账。changed:false 的整格沿用旧账（那几个文件
 * 这一轮一个字节都没重算，账里没有却报「没变」属于脚本与账本脱节，宁可缺一格
 * 也不凭空造行）；changed:true 的换新行（time 降序只留最新 CMDLOG_LEDGER_ROWS_MAX
 * 条，total 记截前的全量，给 truncated 用）；failed:true（打开失败）不进账 ——
 * 与全量扫描对打不开的文件同一个答案：那一轮它就是没有行。 */
function cmdlogLedgerApply(previous, files) {
  const next = { files: new Map(), totalRows: 0 }
  if (Array.isArray(files) === false) return next
  for (let i = 0; i < files.length; i += 1) {
    const one = files[i]
    if (one == null || typeof one !== 'object' || !isStr(one.file)) continue
    if (one.changed !== true) {
      const old = previous !== null && previous.files.has(one.file) ? previous.files.get(one.file) : null
      if (old === null) continue
      next.files.set(one.file, old)
      next.totalRows += old.total
      continue
    }
    if (one.failed === true) continue
    const rows = Array.isArray(one.commands) ? one.commands.slice(0) : []
    rows.sort(function (a, b) { return (parseFloat(b.time) || 0) - (parseFloat(a.time) || 0) })
    const total = typeof one.total === 'number' ? one.total : rows.length
    next.files.set(one.file, {
      mtimeMs: one.mtimeMs,
      size: one.size,
      sessionId: isStr(one.sessionId) ? one.sessionId : '',
      rows: rows.length > CMDLOG_LEDGER_ROWS_MAX ? rows.slice(0, CMDLOG_LEDGER_ROWS_MAX) : rows,
      total: total,
    })
    next.totalRows += total
  }
  /* 有界的执行：先文件数、后总行数，都按「最新一行最旧」先摘。摘整份而不是裁
     单行，为的是「(mtimeMs,size) 没变 = 行照旧」这条恒等式不被打破 —— 被摘的
     文件不在下一次交给脚本的账本地图里，自然整份重扫。 */
  if (next.files.size > CMDLOG_LEDGER_FILES_MAX || next.totalRows > CMDLOG_LEDGER_ROWS_MAX_TOTAL) {
    const ordered = []
    for (const pair of next.files) ordered.push({ file: pair[0], entry: pair[1] })
    ordered.sort(function (a, b) { return cmdlogNewestOf(a.entry.rows) - cmdlogNewestOf(b.entry.rows) })
    for (let i = 0; i < ordered.length; i += 1) {
      if (next.files.size <= CMDLOG_LEDGER_FILES_MAX && next.totalRows <= CMDLOG_LEDGER_ROWS_MAX_TOTAL) break
      next.totalRows -= ordered[i].entry.total
      next.files.delete(ordered[i].file)
    }
  }
  return next
}

/* 账本 → 一次答复的「会话扫描那一半」：所有文件的行并起来按 time 降序、截 limit。
   与全量扫描出口同一个比较器、同一个切法 —— 账热与账冷的差别只在等不等 IO，
   不在结果的形状。 */
function cmdlogLedgerRows(ledger, limit) {
  const all = []
  for (const entry of ledger.files.values()) {
    for (let i = 0; i < entry.rows.length; i += 1) all.push(entry.rows[i])
  }
  all.sort(function (a, b) { return (parseFloat(b.time) || 0) - (parseFloat(a.time) || 0) })
  return { rows: all.length > limit ? all.slice(0, limit) : all, total: ledger.totalRows }
}

/* ── RPC 本体：定位、起脚本、把结论按事实转述 ──
 *
 * 工作区是**会话自己的** cwd（不是当前生效的仓库 —— 读操作按 repo 参数化之后，
 * 面板可能正看着工作区外的路径，而命令记录跟随的是项目本身）。repo/sessionId
 * 照样随 args 走：workdir 与沙箱策略因此与其它 RPC 一致（`argsAt` 的注释说了
 * 丢掉 sessionId 会发生什么）。
 *
 * 数据源是三份的合并（77-cmdrec.js）：会话扫描（上面那段脚本）+ 面板记录的持久化
 * 文件尾部 + 面板记录的内存缓冲。冷扫描失败不再一句 ok:false 定生死 —— 面板这边
 * 有记录可给时照样给（原话转成 warning 随行），两路都空着才把原话当错误交出去。
 * 账热时答复立即可给，后台刷新失败只记日志、旧账原样留着（后台刷新的性质决定
 * 的例外：它交付的本来就不是这次答复，理由同 rpclog —— 加速不许反过来伤害主
 * 流程），三路原话都在 console.error 里。 */

/* 跑一段扫描（scan 或 incr），把答复按事实洗出来：沙箱拒绝、node 不在、超时、
 * 进程没起来、输出截断、不可解析，各回各的话，绝不折叠成「commands: []」——
 * 那是「这个项目没执行过 git」的答案，而这些是「读不了」。 */
async function cmdlogRunScan(mode, ledgerPayload, input, workspace, home) {
  const ledgerArg = mode === 'incr' ? ' ' + shq(JSON.stringify(ledgerPayload)) : ''
  const probe = await invoke(
    'command -v node >/dev/null 2>&1 || { printf ' + shq(CMDLOG_NO_NODE + '\n') + ' >&2; exit 127; }\n'
      + 'node -e ' + shq(CMDLOG_SCRIPT) + ' ' + shq(mode) + ' ' + shq(home + '/sessions') + ' ' + shq(workspace)
      + ' ' + shq(cmdlogSlug(workspace)) + ledgerArg + '\n',
    argsAt(input, repoFrom(input)), null, CMDLOG_TIMEOUT)
  if (probe.sandboxDenied === true) {
    return { ok: false, reason: '文件沙箱不允许读取会话记录目录（' + home + '/sessions）', denied: true }
  }
  if (probe.exitCode === 127 && probe.stderr.indexOf(CMDLOG_NO_NODE) >= 0) {
    return { ok: false, reason: '这台机器的 PATH 上找不到 node，读不了会话记录' }
  }
  if (probe.timedOut === true) return { ok: false, reason: '读会话记录超时了' }
  /* exitCode 为 null 是进程根本没起来 —— 最常见的原因是工作区目录本身已经不存在
     （invoke 会把它设为 workdir），这句话不能说成「脚本没跑成」。 */
  if (probe.exitCode == null) return { ok: false, reason: '扫描进程没有启动起来（工作区目录可能已经不存在）' }
  if (probe.exitCode !== 0) return { ok: false, reason: '读会话记录的脚本没跑成' }
  if (probe.truncated === true) return { ok: false, reason: '会话记录的输出太大，被截断了' }
  let parsed = null
  try {
    parsed = JSON.parse(probe.stdout)
  } catch (error) {
    console.error('dsh-git-idea: could not parse the command log reply', String(error))
  }
  if (parsed == null || typeof parsed !== 'object') {
    return { ok: false, reason: '会话记录脚本没有给出可解析的结果' }
  }
  if (parsed.ok !== true) return { ok: false, reason: isStr(parsed.error) ? parsed.error : '读会话记录失败' }
  return { ok: true, files: Array.isArray(parsed.files) ? parsed.files : [] }
}

/* 全量扫描的 files 输出 → 扁平的行表 + 截前的总行数（truncated 的判据，与老脚本
 * 「all.length > limit」同一个数）。 */
function cmdlogScanRowsOf(files) {
  const all = []
  let total = 0
  for (let i = 0; i < files.length; i += 1) {
    const one = files[i]
    if (one == null || typeof one !== 'object' || Array.isArray(one.commands) !== true) continue
    for (let j = 0; j < one.commands.length; j += 1) all.push(one.commands[j])
    total += typeof one.total === 'number' ? one.total : one.commands.length
  }
  all.sort(function (a, b) { return (parseFloat(b.time) || 0) - (parseFloat(a.time) || 0) })
  return { rows: all, total: total }
}

/* 账本的后台刷新：stat 扫描 + 只解析变化的文件。同一工作区已在跑的不叠加（(stat
 * 扫描在 9p 上是秒级，连开几次读不连开几次刷新）；完成后账若变了经 live 推送
 * （cmdlog-refresh）并回开着的命令页，把增量并回客户端手里那份列表 —— 走的和
 * 答复合并是同一条路。 */
function cmdlogLedgerRefresh(input, workspace, home, before) {
  if (cmdlogLedgerBusy.has(workspace) === true) return
  cmdlogLedgerBusy.add(workspace)
  const known = {}
  for (const pair of before.files) known[pair[0]] = [pair[1].mtimeMs, pair[1].size]
  const run = async function () {
    try {
      const reply = await cmdlogRunScan('incr', known, input, workspace, home)
      if (reply.ok !== true) {
        console.error('dsh-git-idea: 命令页账本的后台刷新失败（旧账保留）', reply.reason)
        return
      }
      const after = cmdlogLedgerApply(before, reply.files)
      cmdlogLedgerSet(workspace, after)
      let changed = after.files.size !== before.files.size
      if (changed !== true) {
        for (let i = 0; i < reply.files.length; i += 1) {
          const one = reply.files[i]
          if (one != null && typeof one === 'object' && one.changed === true) { changed = true; break }
        }
      }
      if (changed === true) {
        const scan = cmdlogLedgerRows(after, CMDLOG_LIVE_PUSH_MAX)
        liveSend(JSON.stringify({ kind: 'cmdlog-refresh', workspace: workspace, commands: scan.rows }))
      }
    } catch (error) {
      console.error('dsh-git-idea: 命令页账本的后台刷新失败（旧账保留）', String(error))
    } finally {
      cmdlogLedgerBusy.delete(workspace)
    }
  }
  run()
}

async function commandLogSnapshot(input) {
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) return { ok: false, error: '无法确定这个会话的工作区，读不了它的命令记录' }
  const home = await cmdlogHome()
  if (home === null) return { ok: false, error: '无法确定 DSH 的会话目录（$DSH_HOME）' }
  const asked = input != null ? parseInt(input.limit, 10) : NaN
  const limit = isNaN(asked) ? CMDLOG_DEFAULT_LIMIT : Math.min(Math.max(asked, 1), CMDLOG_LIMIT_MAX)
  /* 「重新读取」是强制全量：full === true 时不看账本，同步整扫一遍 —— 全量的
     结果顺手就是最准的新账，播种照做。 */
  const full = input != null && input.full === true
  const ledger = full === true ? null : cmdlogLedgerGet(workspace)
  /* 面板这一半：文件尾部 + 内存，按本会话/本工作区归位后参与合并。 */
  const panel = await cmdrecPanelRows()
  const panelRows = cmdrecScopeRows(panel.rows, input != null && isStr(input.sessionId) ? input.sessionId : '', workspace)
  if (ledger !== null) {
    /* 账已热：立即用账本答复（零 IO、零解压），stat 扫描 + 增量解析放到后台跑，
       完成后账若变了推增量回去。 */
    const scan = cmdlogLedgerRows(ledger, limit)
    const merged = cmdrecMerge([scan.rows, panelRows])
    cmdlogLedgerRefresh(input, workspace, home, ledger)
    return {
      ok: true,
      commands: merged.length > limit ? merged.slice(0, limit) : merged,
      truncated: scan.total > limit || panel.clipped === true || merged.length > limit,
      workspace: workspace,
    }
  }
  const reply = await cmdlogRunScan('scan', null, input, workspace, home)
  if (reply.ok !== true && panelRows.length === 0) {
    return { ok: false, error: reply.reason, sandboxDenied: reply.denied === true }
  }
  if (reply.ok !== true) {
    /* 冷扫描失败但面板记录给得出来：列表照给，原话转 warning 随行。 */
    const merged = cmdrecMerge([[], panelRows])
    return {
      ok: true,
      commands: merged.length > limit ? merged.slice(0, limit) : merged,
      truncated: panel.clipped === true || merged.length > limit,
      workspace: workspace,
      warning: reply.reason,
    }
  }
  const scan = cmdlogScanRowsOf(reply.files)
  cmdlogLedgerSet(workspace, cmdlogLedgerApply(null, reply.files))
  const merged = cmdrecMerge([scan.rows, panelRows])
  return {
    ok: true,
    commands: merged.length > limit ? merged.slice(0, limit) : merged,
    truncated: scan.total > limit || panel.clipped === true || merged.length > limit,
    workspace: workspace,
  }
}
