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
 *   记录一个字节也不读。 */

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
 * 约定：一切结论从 stdout 的一行 JSON 里出（{ok:true,…} 或 {ok:false,error:…}），
 * 进程退出码恒为 0 —— 这样「脚本没跑成」（退出码非 0，由 host 判断）和「跑成了、
 * 但读不了」（ok:false，由脚本自己说原因）是两件事，不会混在一起。 */
const CMDLOG_SCRIPT = [
  'const fs = require("fs")',
  'const zlib = require("zlib")',
  '/* argv：sessions 根目录 / 期望的工作区 cwd / slug 目录名 / limit。',
  '   下标从 1 开始 —— `node -e` 的 argv 里没有脚本文件名，参数整体前移一格。 */',
  'const root = process.argv[1]',
  'const wantCwd = process.argv[2]',
  'const slugDir = process.argv[3]',
  'const limit = parseInt(process.argv[4], 10)',
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
  '   session- 前缀，原样返回。 */',
  'function sessionFiles(base) {',
  '  let entries',
  '  try { entries = fs.readdirSync(base, { withFileTypes: true }) } catch (e) { return null }',
  '  const out = []',
  '  for (let i = 0; i < entries.length; i += 1) {',
  '    if (entries[i].isDirectory() !== true) continue',
  '    const file = base + "/" + entries[i].name + "/session.v4.jsonl.zstd"',
  '    if (fs.existsSync(file)) out.push({ sessionId: entries[i].name, file: file })',
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
  '/* 一个会话文件 → 这个会话里所有 git 命令。callId 把 tool/call 和它的',
  '   tool/result 连起来；退出码从输出尾部解析，拿不到就是 null（成功命令的',
  '   记录里本来就没有这个标记）。 */',
  'function scanFile(item, sink) {',
  '  let buf = null',
  '  try { buf = fs.readFileSync(item.file) } catch (e) { return false }',
  '  const calls = []',
  '  const exits = new Map()',
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
  '        if (typeof id !== "string" || exits.has(id)) return',
  '        const content = data.message.content',
  '        let text = ""',
  '        if (Array.isArray(content)) {',
  '          for (let i = 0; i < content.length; i += 1) {',
  '            if (content[i] != null && content[i].type === "text" && typeof content[i].text === "string") text += content[i].text',
  '          }',
  '        }',
  '        const found = text.match(EXIT_TAIL)',
  '        exits.set(id, found !== null ? parseInt(found[1], 10) : null)',
  '      }',
  '    })',
  '  })',
  '  for (let i = 0; i < calls.length; i += 1) {',
  '    const c = calls[i]',
  '    sink.push({',
  '      time: c.time,',
  '      command: c.command,',
  '      description: c.description,',
  '      sessionId: item.sessionId,',
  '      cwd: c.cwd,',
  '      exitCode: exits.has(c.callId) ? exits.get(c.callId) : null,',
  '    })',
  '  }',
  '  return true',
  '}',
  '',
  'function main() {',
  '  if (fs.existsSync(root) !== true) {',
  '    /* 整个机器还没有任何会话记录 —— 这不是错误，是「一条也没执行过」。 */',
  '    say({ ok: true, commands: [], truncated: false })',
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
  '  const all = []',
  '  let openedAny = false',
  '  for (let i = 0; i < targets.length; i += 1) {',
  '    if (scanFile(targets[i], all) === true) openedAny = true',
  '  }',
  '  if (targets.length > 0 && openedAny !== true) {',
  '    say({ ok: false, error: "会话文件一个也打不开（" + targets.length + " 个）" })',
  '    return',
  '  }',
  '  all.sort(function (a, b) { return (parseFloat(b.time) || 0) - (parseFloat(a.time) || 0) })',
  '  say({ ok: true, commands: all.length > limit ? all.slice(0, limit) : all, truncated: all.length > limit })',
  '}',
  '',
  'try { main() } catch (e) { say({ ok: false, error: "扫描会话记录时出错了：" + String(e && e.message ? e.message : e) }) }',
].join('\n')

/* ── RPC 本体：定位、起脚本、把结论按事实转述 ──
 *
 * 工作区是**会话自己的** cwd（不是当前生效的仓库 —— 读操作按 repo 参数化之后，
 * 面板可能正看着工作区外的路径，而命令记录跟随的是项目本身）。repo/sessionId
 * 照样随 args 走：workdir 与沙箱策略因此与其它 RPC 一致（`argsAt` 的注释说了
 * 丢掉 sessionId 会发生什么）。 */
async function commandLogSnapshot(input) {
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) return { ok: false, error: '无法确定这个会话的工作区，读不了它的命令记录' }
  const home = await cmdlogHome()
  if (home === null) return { ok: false, error: '无法确定 DSH 的会话目录（$DSH_HOME）' }
  const asked = input != null ? parseInt(input.limit, 10) : NaN
  const limit = isNaN(asked) ? CMDLOG_DEFAULT_LIMIT : Math.min(Math.max(asked, 1), CMDLOG_LIMIT_MAX)
  const probe = await invoke(
    'command -v node >/dev/null 2>&1 || { printf ' + shq(CMDLOG_NO_NODE + '\n') + ' >&2; exit 127; }\n'
      + 'node -e ' + shq(CMDLOG_SCRIPT) + ' ' + shq(home + '/sessions') + ' ' + shq(workspace)
      + ' ' + shq(cmdlogSlug(workspace)) + ' ' + String(limit) + '\n',
    argsAt(input, repoFrom(input)), null, CMDLOG_TIMEOUT)
  if (probe.sandboxDenied === true) {
    return { ok: false, error: '文件沙箱不允许读取会话记录目录（' + home + '/sessions）', sandboxDenied: true, stderr: probe.stderr.slice(0, 400) }
  }
  if (probe.exitCode === 127 && probe.stderr.indexOf(CMDLOG_NO_NODE) >= 0) {
    return { ok: false, error: '这台机器的 PATH 上找不到 node，读不了会话记录' }
  }
  if (probe.timedOut === true) return { ok: false, error: '读会话记录超时了' }
  /* exitCode 为 null 是进程根本没起来 —— 最常见的原因是工作区目录本身已经不存在
     （invoke 会把它设为 workdir），这句话不能说成「脚本没跑成」。 */
  if (probe.exitCode == null) {
    return { ok: false, error: '扫描进程没有启动起来（工作区目录可能已经不存在）', stderr: probe.stderr.slice(0, 400) }
  }
  if (probe.exitCode !== 0) {
    return { ok: false, error: '读会话记录的脚本没跑成', stderr: probe.stderr.slice(0, 400) }
  }
  if (probe.truncated === true) return { ok: false, error: '会话记录的输出太大，被截断了' }
  let parsed = null
  try {
    parsed = JSON.parse(probe.stdout)
  } catch (error) {
    console.error('dsh-git-idea: could not parse the command log reply', String(error))
  }
  if (parsed == null || typeof parsed !== 'object') {
    return { ok: false, error: '会话记录脚本没有给出可解析的结果', stderr: probe.stdout.slice(0, 200) }
  }
  if (parsed.ok !== true) {
    return { ok: false, error: isStr(parsed.error) ? parsed.error : '读会话记录失败' }
  }
  return { ok: true, commands: Array.isArray(parsed.commands) ? parsed.commands : [], truncated: parsed.truncated === true }
}
