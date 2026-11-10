import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ═══ gp85：worktree 目录映射的「命中自动记录」（65-worktree.js + 70-config.js）═══
 *
 * 钉 0.5.0 的四件事（gp72 同一副骨架：整份 host.js 求值，shell Service 换成听命令
 * 的桩 —— 但配置文件与存在性补问这两类**真做**，其余罐头）：
 *   1. 命中自动记录：broken-gitlink（D:/ 风格 gitlink）+ 一条映射 → git/wt-main
 *      答 mainMapped / mappedRule / mainDir，autoRecorded=true；worktreeMains 与
 *      worktreeMainsMeta 一次写盘都落进 dsh-git-idea.json；同一 body 第二次读：
 *      mainSource='config'、mainVia='mapping'、autoRecorded=false、mappedRule=null，
 *      且配置文件一个字节没变（防循环：第二次读不再写盘）；
 *   2. 手动答案永远赢：预置手动 worktreeMains → 换算照跑但不覆盖、不写盘
 *      （autoRecorded=false、mainVia='manual'、配置零写盘）；
 *   3. 来源账跟着手动操作走：手动 add 同值 → meta 清空（本体同值不写盘，只清账）；
 *      remove:true → worktreeMains 与 meta 两键一起删（同一次写盘）；
 *   4. mappingSuggestion：配置的主目录已不在 + 映射换算候选存在 → 答复带
 *      {path, from, to}，不覆盖配置、不自动保存（零写盘）。
 * 铁律断言：整个测试从头到尾，worktree 的 .git gitlink 文件一个字节没变 ——
 * 目录映射只动插件自己的配置文件，git 的任何配置一个字节不写（桩里压根没有
 * 能写 git 配置的命令通道，写盘只发生在 dsh-git-idea.json 上）。
 */

const body = fs.readFileSync(process.env.GP_SRC || new URL('../dist/host.js', import.meta.url).pathname, 'utf8')

/* ── 真文件系统的最小舞台 ──
 * WT 的 .git 是 gitlink 文件（内容是别的机器的 D:/ 路径）；MAIN 是映射换算会落到
 * 的本机主目录（真存在、有 .git，补问 `[ -e …/.git ]` 才答得出 repo）；GONE 是
 * 配置里指向、磁盘上不存在的主目录（mappingSuggestion 用例）。 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gp85-'))
const WT = path.join(ROOT, 'wt')
const MAIN = path.join(ROOT, 'main')
const GONE = path.join(ROOT, 'gone-main')
const HOME = path.join(ROOT, 'home')
fs.mkdirSync(WT, { recursive: true })
fs.mkdirSync(path.join(MAIN, '.git'), { recursive: true })
fs.mkdirSync(HOME, { recursive: true })
const GITLINK = 'gitdir: D:/code/www/gs/zuodian/main/.git/worktrees/zuodian-temp\n'
fs.writeFileSync(path.join(WT, '.git'), GITLINK)
fs.writeFileSync(path.join(MAIN, '.git', 'HEAD'), 'ref: refs/heads/main\n')
const GITLINK_BYTES = fs.readFileSync(path.join(WT, '.git'))

/* 探测罐头的三件套：gitlink 原文（G:）、它解出的主目录候选（AM）、映射规则。
 * from = 'D:/code/www/gs/zuodian' 换算 AM 的前缀 → to = ROOT，落点恰好是 MAIN。 */
const AM = 'D:/code/www/gs/zuodian/main'
const RULE_FROM = 'D:/code/www/gs/zuodian'
const RULE_TO = ROOT
const CFG_PATH = path.join(HOME, 'dsh-git-idea.json')

function writeConfigFile(obj) {
  fs.writeFileSync(CFG_PATH, JSON.stringify(obj, null, 2) + '\n')
}
function readConfigFromDisk() {
  return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
}

/* ── 罐头 + 真做的 shell 桩 ──
 * 四类命令各走各的路：
 *   · DSH_HOME 探测 → 答测试的 home；
 *   · 配置读写（[ -f … ] && cat / mkdir -p … printf %s … > …）→ 真读真写磁盘，
 *     写盘计数（防循环断言数的就是它）；
 *   · 存在性补问（`if [ -e …/.git ]…` 两句形状）→ 真问文件系统；
 *   · wtMainProbeCommand 的大探测脚本（认 `--absolute-git-dir`）→ 罐头：K/GT/G/
 *     AM/AC 照 broken-gitlink 场景给，MC 行按磁盘配置与真存在性现生成（第二次读
 *     时配置里已有主目录，罐头自然带上 MC:1 —— 与真机语义一致）。 */
function makeBody() {
  const runs = []
  let writes = 0
  const shellService = {
    resolve: (r) => r,
    run: (spec) => {
      runs.push(spec)
      const cmd = String(spec.command)
      if (cmd.indexOf('printf %s "${DSH_HOME:-$HOME/.dsh}"') >= 0) {
        return Promise.resolve({ exitCode: 0, stdout: { text: HOME }, stderr: { text: '' } })
      }
      if (cmd.indexOf("] && cat '") >= 0) {
        const m = cmd.match(/cat '([^']*)'/)
        const file = m ? m[1] : ''
        if (fs.existsSync(file)) {
          return Promise.resolve({ exitCode: 0, stdout: { text: fs.readFileSync(file, 'utf8') }, stderr: { text: '' } })
        }
        return Promise.resolve({ exitCode: 1, stdout: { text: '' }, stderr: { text: '' } })
      }
      const write = cmd.match(/^mkdir -p '[^']*' && printf %s '([\s\S]*)' > '([^']*)'\n$/)
      if (write !== null) {
        const json = write[1].replace(/'\\''/g, "'")
        cfgMirror = JSON.parse(json)
        fs.mkdirSync(path.dirname(write[2]), { recursive: true })
        fs.writeFileSync(write[2], json + '\n')
        writes += 1
        return Promise.resolve({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
      }
      const mappedCheck = cmd.match(/^if \[ -e '([^']*)'\/\.git \]; then echo repo; else echo gone; fi\n?$/)
      if (mappedCheck !== null) {
        const there = fs.existsSync(path.join(mappedCheck[1], '.git'))
        return Promise.resolve({ exitCode: 0, stdout: { text: there ? 'repo\n' : 'gone\n' }, stderr: { text: '' } })
      }
      const addCheck = cmd.match(/^if \[ -e '([^']*)'\/\.git \]; then echo repo; elif \[ -d '([^']*)' \]; then echo norepo; else echo none; fi\n?$/)
      if (addCheck !== null) {
        const verdict = fs.existsSync(path.join(addCheck[1], '.git')) ? 'repo'
          : (fs.existsSync(addCheck[2]) && fs.statSync(addCheck[2]).isDirectory() ? 'norepo' : 'none')
        return Promise.resolve({ exitCode: 0, stdout: { text: verdict + '\n' }, stderr: { text: '' } })
      }
      if (cmd.indexOf('--absolute-git-dir') >= 0) {
        const t = cmd.match(/^T='([^']*)'/)
        const target = t ? t[1] : ''
        let mc = null
        try {
          const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
          const main = cfg.worktreeMains != null ? cfg.worktreeMains[target] : undefined
          if (typeof main === 'string' && main.length > 0) mc = fs.existsSync(path.join(main, '.git')) ? 'MC:1' : 'MC:0'
        } catch (e) { mc = null }
        const lines = ['K:dir', 'GT:file', 'G:' + GITLINK.trim(), 'AM:' + AM, 'AC:0']
        if (mc !== null) lines.push(mc)
        /* GRC 非 0 → git 读不动 → broken-gitlink；gitlink 候选本身不在本机（AC:0）。 */
        lines.push('GD:', 'GRC:128', 'CD:', 'LC:0', 'TL:')
        return Promise.resolve({ exitCode: 0, stdout: { text: lines.join('\n') + '\n' }, stderr: { text: '' } })
      }
      return Promise.resolve({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
    },
  }
  const handlers = new Map()
  const ctx = { get: (n) => (n === 'shell' ? shellService : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  let cfgMirror = null
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
    ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'),
    s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return { H: (n) => handlers.get(n), runs: runs, writes: () => writes, mirror: () => cfgMirror }
}

let failed = 0
const check = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const gitlinkUnchanged = () => fs.readFileSync(path.join(WT, '.git')).equals(GITLINK_BYTES)

console.log('')
console.log('=== 1｜映射命中：自动记录 + 答复带规则 + 防循环 ===')
{
  writeConfigFile({ worktreeDirMappings: [{ id: 'wdm-1', from: RULE_FROM, to: RULE_TO }] })
  const a = makeBody()
  const first = await a.H('git/wt-main')({ sessionId: 's', repo: WT })
  check('第一次读：ok:true、kind=broken-gitlink',
    first != null && first.ok === true && first.kind === 'broken-gitlink')
  check('mainMapped=true、mainSource=auto、mainOk=true、mainDir=换算后的主目录',
    first.mainMapped === true && first.mainSource === 'auto' && first.mainOk === true && first.mainDir === MAIN)
  check('mappedRule 带命中规则原文 {from,to}',
    first.mappedRule != null && first.mappedRule.from === RULE_FROM && first.mappedRule.to === RULE_TO)
  check('autoRecorded=true（这一读顺手写进了配置）', first.autoRecorded === true)
  check('写盘恰好一次（worktreeMains + worktreeMainsMeta 同一次 writeConfigFile）', a.writes() === 1)
  const onDisk = readConfigFromDisk()
  check('配置里 worktreeMains[wt]=主目录',
    onDisk.worktreeMains != null && onDisk.worktreeMains[WT] === MAIN)
  check('配置里 worktreeMainsMeta[wt]={via:mapping, from, to, at}',
    onDisk.worktreeMainsMeta != null && onDisk.worktreeMainsMeta[WT] != null
    && onDisk.worktreeMainsMeta[WT].via === 'mapping'
    && onDisk.worktreeMainsMeta[WT].from === RULE_FROM
    && onDisk.worktreeMainsMeta[WT].to === RULE_TO
    && typeof onDisk.worktreeMainsMeta[WT].at === 'number')
  const afterFirst = fs.readFileSync(CFG_PATH)

  const second = await a.H('git/wt-main')({ sessionId: 's', repo: WT })
  check('第二次读：mainSource=config、mainVia=mapping（来源账说话）',
    second.ok === true && second.mainSource === 'config' && second.mainVia === 'mapping')
  check('第二次读：autoRecorded=false、mappedRule=null（换算没被采用，配置答案在）',
    second.autoRecorded === false && second.mappedRule === null)
  check('第二次读：mainDir 不变、mainOk=true', second.mainDir === MAIN && second.mainOk === true)
  check('防循环：第二次读没有再写盘', a.writes() === 1)
  check('防循环：配置文件一个字节没变', fs.readFileSync(CFG_PATH).equals(afterFirst))
  check('.git gitlink 文件一个字节没变（映射只动插件自己的配置）', gitlinkUnchanged())
}

console.log('')
console.log('=== 2｜手动答案永远赢：预置 worktreeMains → 不覆盖、不写盘 ===')
{
  writeConfigFile({
    worktreeMains: { [WT]: MAIN },
    worktreeDirMappings: [{ id: 'wdm-1', from: RULE_FROM, to: RULE_TO }],
  })
  const a = makeBody()
  const reply = await a.H('git/wt-main')({ sessionId: 's', repo: WT })
  check('mainSource=config、mainVia=manual（meta 缺席 = 手动）',
    reply.ok === true && reply.mainSource === 'config' && reply.mainVia === 'manual')
  check('不覆盖：autoRecorded=false、mainMapped=false、mappedRule=null',
    reply.autoRecorded === false && reply.mainMapped === false && reply.mappedRule === null)
  check('一个字节没写盘（映射换算照跑，但配置已有人答）', a.writes() === 0)
  const onDisk = readConfigFromDisk()
  check('worktreeMains 原样、meta 仍没有这条',
    onDisk.worktreeMains[WT] === MAIN
    && (onDisk.worktreeMainsMeta == null || onDisk.worktreeMainsMeta[WT] === undefined))
  check('.git gitlink 文件一个字节没变', gitlinkUnchanged())
}

console.log('')
console.log('=== 3｜来源账跟着手动操作走（saveWorktreeMain 维护 meta）===')
{
  writeConfigFile({
    worktreeMains: { [WT]: MAIN },
    worktreeMainsMeta: { [WT]: { via: 'mapping', from: RULE_FROM, to: RULE_TO, at: 1 } },
    worktreeDirMappings: [{ id: 'wdm-1', from: RULE_FROM, to: RULE_TO }],
  })
  const a = makeBody()
  const addSame = await a.H('git/wt-main-save')({ sessionId: 's', repo: WT, add: MAIN })
  check('手动 add 同值：ok:true、mainVia=manual（来源账被手动认领）',
    addSame != null && addSame.ok === true && addSame.mainSource === 'config' && addSame.mainVia === 'manual')
  let onDisk = readConfigFromDisk()
  check('同值本体没动、meta 已清空（一次写盘只清账）',
    onDisk.worktreeMains[WT] === MAIN
    && (onDisk.worktreeMainsMeta == null || onDisk.worktreeMainsMeta[WT] === undefined))
  check('写盘恰好一次（同值不写本体，只写清账的那次）', a.writes() === 1)

  const removed = await a.H('git/wt-main-save')({ sessionId: 's', repo: WT, remove: true })
  check('remove:true：ok:true、主目录回到自动识别',
    removed != null && removed.ok === true && removed.mainSource !== 'config')
  onDisk = readConfigFromDisk()
  check('两键一起删：worktreeMains 与 meta 里都没有这个 worktree 了',
    (onDisk.worktreeMains == null || onDisk.worktreeMains[WT] === undefined)
    && (onDisk.worktreeMainsMeta == null || onDisk.worktreeMainsMeta[WT] === undefined))
  const writesBeforeAdd = a.writes()

  const addFresh = await a.H('git/wt-main-save')({ sessionId: 's', repo: WT, add: MAIN })
  check('add 新配置：ok:true、mainSource=config、mainVia=manual',
    addFresh != null && addFresh.ok === true && addFresh.mainSource === 'config' && addFresh.mainVia === 'manual')
  onDisk = readConfigFromDisk()
  check('新配置写进本体、meta 没有跟着长出来（手动保存不留映射账）',
    onDisk.worktreeMains[WT] === MAIN
    && (onDisk.worktreeMainsMeta == null || onDisk.worktreeMainsMeta[WT] === undefined))
  check('add 新配置恰好再写盘一次', a.writes() === writesBeforeAdd + 1)
  check('.git gitlink 文件一个字节没变', gitlinkUnchanged())
}

console.log('')
console.log('=== 4｜mappingSuggestion：手动答案失效 + 换算候选存在 → 顺手指路，不写盘 ===')
{
  writeConfigFile({
    worktreeMains: { [WT]: GONE },
    worktreeDirMappings: [{ id: 'wdm-1', from: RULE_FROM, to: RULE_TO }],
  })
  const a = makeBody()
  const reply = await a.H('git/wt-main')({ sessionId: 's', repo: WT })
  check('mainSource=config、mainOk=false（配置的主目录已不在）',
    reply.ok === true && reply.mainSource === 'config' && reply.mainOk === false && reply.mainDir === GONE)
  check('mappingSuggestion={path:换算候选, from, to}',
    reply.mappingSuggestion != null && reply.mappingSuggestion.path === MAIN
    && reply.mappingSuggestion.from === RULE_FROM && reply.mappingSuggestion.to === RULE_TO)
  check('autoRecorded=false（有手动答案就绝不自动记录）', reply.autoRecorded === false)
  check('一个字节没写盘（只指路，不替读者改配置）', a.writes() === 0)
  const onDisk = readConfigFromDisk()
  check('配置原样：worktreeMains[wt] 还是那个已失效的路径',
    onDisk.worktreeMains[WT] === GONE)
  check('.git gitlink 文件一个字节没变', gitlinkUnchanged())
}

if (failed > 0) {
  console.error('gp85-wtmap-host: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
