/* ─────────────── 三方合并冲突：读三个版本，写回解决结果 ───────────────
 *
 * 变更页的「冲突」组过去只有两条路：点行看普通 diff（看不出三方各是什么），或者
 * 在编辑器里手改 <<<<<<< 标记再勾选暂存。这条 RPC 是三方合并界面的地基：把同一
 * 路径的 :1:（base）/ :2:（ours）/ :3:（theirs）三个阶段一次读回来，配上界面上
 * 要说的两侧标签（merge 场景 ours=当前分支名、theirs=MERGE_HEAD 指着的分支名，
 * 拣选/stash 之类解析不出就退化成「本地更改/传入的更改」，绝不因此报错）。
 *
 * 只读，不进 cmdrec，也不进读缓存 —— 与 git/diff 同一条理由：这是读者正盯着的那
 * 份活文本，缓存它只会让「刚被解决完再点开」看到旧冲突。
 */

/* 与 diff 读同一档封顶（68-detail.js 的 maxBytes 惯例）：半个文件的三个版本拼出
 * 来的「已解决」比冲突本身危险得多，所以单侧超限就整个拒绝，让界面明说，而不是
 * 把截断的文本当成完整的三方。 */
const CONFLICT_MAX_BYTES = 1200000
/* 写回的护栏：三个 1.2MB 的版本怎么合也合不出 4MB 的结果，超了说明请求不对劲。 */
const CONFLICT_SAVE_MAX = 4000000

/* ls-files -u -z 的一行是「mode SP sha SP stage TAB path NUL」—— 路径在行内（TAB
 * 之后），NUL 只是行与行的分隔：按 \0 切开就是一行一条，逐条看即可（路径可以含
 * TAB，所以只能认第一个 TAB）。只认路径完全相等的那条：ls-files 按 pathspec 前缀
 * 匹配目录，而这里永远传的是文件本身，相等判断是双保险。
 * 返回 { 1: mode, 2: mode, 3: mode }，缺哪个阶段就没有哪个键。 */
function unmergedStagesOf(stdout, path) {
  const stages = {}
  const parts = stdout.split('\u0000')
  for (let i = 0; i < parts.length; i += 1) {
    const row = parts[i]
    const tab = row.indexOf('\t')
    if (tab < 0) continue
    if (row.slice(tab + 1) !== path) continue
    const fields = row.slice(0, tab).split(' ')
    const stage = parseInt(fields[2], 10)
    if (stage === 1 || stage === 2 || stage === 3) stages[stage] = fields[0]
  }
  return stages
}

/* 一个阶段 = 一次 git show。阶段缺失的情况调用方已经从 ls-files 知道了，不会问。 */
async function conflictStageShow(args, path, stage) {
  return await git(args, ['--no-optional-locks', '-c', 'core.quotePath=false',
    'show', ':' + String(stage) + ':' + path], null, { maxBytes: CONFLICT_MAX_BYTES })
}

/* 界面要的换行符信息：两侧一个 CRLF 一个 LF 时结果区的标记行跟谁走、要不要提醒，
 * 都由这两个布尔决定。content 已经原样在手，直接看字节。 */
function conflictSideOf(present, shown) {
  const content = shown.stdout
  return {
    present: present,
    text: content,
    truncated: shown.truncated === true,
    crlf: content.indexOf('\r\n') >= 0,
    endsWithNewline: content.length > 0 && content.charAt(content.length - 1) === '\n',
  }
}

function conflictAbsentSide() {
  return { present: false, text: '', truncated: false, crlf: false, endsWithNewline: false }
}

/* 两侧标签的三样线索，一次 shell 带回来（B=HEAD 指着的分支，M=MERGE_HEAD 的 sha，
 * C=CHERRY_PICK_HEAD 的 sha，G=MERGE_MSG 首行）。文件读不到、git 不在、分支游离，
 * 每一样都安静地给空 —— 标签是尽力而为的装饰，不是这次读取的成败条件。 */
function conflictHintsCommand(repo) {
  const at = shq(repo)
  return [
    'gd=$(' + gitCmd() + ' -C ' + at + ' rev-parse --absolute-git-dir 2>/dev/null)',
    "printf 'B:%s\\n' \"$(" + gitCmd() + ' -C ' + at + ' symbolic-ref --quiet --short HEAD 2>/dev/null)"',
    "printf 'M:%s\\n' \"$(cat \"$gd/MERGE_HEAD\" 2>/dev/null)\"",
    "printf 'C:%s\\n' \"$(cat \"$gd/CHERRY_PICK_HEAD\" 2>/dev/null)\"",
    "printf 'G:%s\\n' \"$(head -n 1 \"$gd/MERGE_MSG\" 2>/dev/null)\"",
  ].join('\n') + '\n'
}

function conflictHintsParse(stdout) {
  const found = { branch: '', mergeHead: '', cherryPick: '', mergeMsg: '' }
  const lines = stdout.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.length < 2) continue
    const head = line.charAt(0)
    const rest = line.slice(2)
    if (head === 'B') found.branch = rest
    else if (head === 'M') found.mergeHead = rest
    else if (head === 'C') found.cherryPick = rest
    else if (head === 'G') found.mergeMsg = rest
  }
  return found
}

/* theirs 侧标签的解析顺序：MERGE_HEAD 指着的本地分支名（name-rev，限 refs/heads，
 * 游离或只有远程时它答 undefined）→ MERGE_MSG 首行的「Merge branch 'xxx'」→
 * 退化「传入的更改」。拣选场景给个带说法的退化值，读者至少知道这不是一次 merge。 */
async function conflictLabels(args, repo) {
  const probe = await invoke(conflictHintsCommand(repo), args, null, { timeoutMs: 10000 })
  const hints = conflictHintsParse(probe.stdout)
  const ours = hints.branch.trim().length > 0 ? hints.branch.trim() : '本地更改'
  let theirs = ''
  const sha = hints.mergeHead.trim()
  if (sha.length > 0) {
    const named = await gitC(args, ['name-rev', '--name-only', '--refs=refs/heads/*', sha], null, {})
    const said = named.stdout.trim()
    if (named.exitCode === 0 && said.length > 0 && said !== 'undefined') theirs = said
  }
  if (theirs.length === 0 && hints.mergeMsg.length > 0) {
    const said = /^Merge (?:branch|remote-tracking branch|commit) '([^']+)'/.exec(hints.mergeMsg)
    if (said !== null) theirs = said[1]
  }
  if (theirs.length === 0) theirs = hints.cherryPick.trim().length > 0 ? '传入的更改（拣选）' : '传入的更改'
  return { ours: ours, theirs: theirs, merging: sha.length > 0, cherryPicking: hints.cherryPick.trim().length > 0 }
}

async function conflictSnapshot(input) {
  const path = input != null && isStr(input.path) ? input.path : ''
  const bad = repoRelativePath(path)
  if (bad.length > 0) return { ok: false, error: 'invalid-path', stderr: bad }
  const repo = repoFrom(input, null)
  if (repo === undefined) return { ok: false, error: 'no-path', stderr: '不知道是哪个仓库：这个会话没有工作区，也没有指定路径' }
  const args = argsFor(input)

  const list = await git(args, ['--no-optional-locks', '-c', 'core.quotePath=false',
    'ls-files', '-u', '-z', '--', path], null, { maxBytes: 200000 })
  if (list.exitCode !== 0) {
    return { ok: false, error: 'ls-files-failed', exitCode: list.exitCode, stderr: list.stderr, noGit: gitMissing(list), path: path }
  }
  const stages = unmergedStagesOf(list.stdout, path)
  if (stages[1] === undefined && stages[2] === undefined && stages[3] === undefined) {
    /* 打开前已被解决 / 仓库已经变过：必须是一句明确的话，而不是一片空白 —— 空白
       读起来像「读坏了」，这句话读起来像「你已经做完了」。 */
    return {
      ok: false, error: 'not-unmerged', path: path,
      stderr: '这个路径已经不在冲突列表里（ls-files -u 没有它）：它可能已经被解决，或者仓库已经变过。',
    }
  }

  const sides = {}
  for (let stage = 1; stage <= 3; stage += 1) {
    if (stages[stage] === undefined) { sides[stage] = conflictAbsentSide(); continue }
    /* gitlink（子模块）冲突没有可合并的文本：三个「版本」里那侧是一个 commit sha。 */
    if (stages[stage] === '160000') {
      return { ok: false, error: 'submodule', path: path, stderr: '这是一个子模块（gitlink）冲突，没有可合并的文本 —— 请在命令行解决它。' }
    }
    const shown = await conflictStageShow(args, path, stage)
    if (shown.exitCode !== 0) {
      return { ok: false, error: 'read-failed', stage: stage, exitCode: shown.exitCode, stderr: shown.stderr, noGit: gitMissing(shown), path: path }
    }
    if (shown.truncated === true) {
      return {
        ok: false, error: 'too-large', path: path,
        stderr: '这个文件超过合并界面的大小上限（' + String(Math.round(CONFLICT_MAX_BYTES / 1000)) + ' KB），只读回了一部分 ——'
          + ' 拒绝把半份内容当成三个完整版本，请在编辑器里解决这个冲突。',
      }
    }
    if (patchLooksBinary(shown.stdout) === true) {
      return { ok: false, error: 'binary', path: path, stderr: '这是一个二进制文件的冲突，合并界面只处理文本 —— 请用 git checkout --ours/--theirs 或专用工具解决。' }
    }
    sides[stage] = conflictSideOf(true, shown)
  }

  const labels = await conflictLabels(args, repo)
  return {
    ok: true, repo: repo, path: path,
    base: sides[1], ours: sides[2], theirs: sides[3],
    oursLabel: labels.ours, theirsLabel: labels.theirs,
    merging: labels.merging, cherryPicking: labels.cherryPicking,
  }
}

/* ── git/conflict-save：把解决结果写回并标记已解决 ──
 *
 * 顺序是一件安全事：先核对路径**仍是** unmerged（ls-files -u 还答得出它），不是就
 * 一个字节都不写 —— 打开界面到点按钮之间，冲突可能已经在别处被解决，此刻把一份旧
 * 结果盖过去、再 git add 一次，就是把读者的解决成果冲掉。写盘用 stdin 过 cat：
 * 内容原样落盘，不加也不吃结尾换行（换行的有无由客户端按三个版本的口径拼好带来）。
 * 成功后 git add 标记已解决。整件事包进 cmdrecGit（命令页里是一行「git add -- 路径」，
 * 动作名列写的是人话「标记冲突已解决」）；答复形状照其它变更 RPC（ok/exitCode/
 * stderr/sandboxDenied/noGit + path），刷新走客户端既有的 ⟳ 路。 */
async function conflictSave(input) {
  const path = input != null && isStr(input.path) ? input.path : ''
  const bad = repoRelativePath(path)
  if (bad.length > 0) return { ok: false, error: 'invalid-path', stderr: bad }
  if (input == null || isStr(input.content) !== true) return { ok: false, error: 'bad-content', stderr: 'content 必须是字符串' }
  if (input.content.length > CONFLICT_SAVE_MAX) {
    return { ok: false, error: 'too-large', stderr: '结果内容超过写回上限（' + String(Math.round(CONFLICT_SAVE_MAX / 1000000)) + ' MB），没有写入。' }
  }
  const repo = repoFrom(input, null)
  if (repo === undefined) return { ok: false, error: 'no-path', stderr: '不知道是哪个仓库：这个会话没有工作区，也没有指定路径' }
  const args = argsFor(input)

  const list = await git(args, ['--no-optional-locks', '-c', 'core.quotePath=false',
    'ls-files', '-u', '-z', '--', path], null, { maxBytes: 200000 })
  if (list.exitCode !== 0) {
    return { ok: false, error: 'ls-files-failed', exitCode: list.exitCode, stderr: list.stderr, noGit: gitMissing(list), path: path }
  }
  const stages = unmergedStagesOf(list.stdout, path)
  if (stages[1] === undefined && stages[2] === undefined && stages[3] === undefined) {
    return {
      ok: false, error: 'not-unmerged', path: path,
      stderr: '这个路径已经不在冲突列表里（可能已经在别处被解决）—— 没有写入任何字节，也没有执行 git add。',
    }
  }

  const cut = path.lastIndexOf('/')
  const dir = cut > 0 ? path.slice(0, cut) : ''
  /* mkdir -p 兜的是 UD（本侧删除）这种工作区里文件连同目录一起没了的情况。 */
  const writeCommand = (dir.length > 0 ? 'mkdir -p ' + shq(dir) + ' && ' : '') + 'cat > ' + shq(path) + '\n'
  const result = await cmdrecGit(input, '标记冲突已解决', ['add', '--', path], async function () {
    /* 内容走 stdin（invoke 的 opts.stdin → 执行器 spec.stdin），不走命令行：
       几百 KB 的文本塞进 argv 会撞 ARG_MAX，而且命令页的展示串也不该是它。 */
    const wrote = await invoke(writeCommand, args, null, { stdin: input.content })
    if (wrote.exitCode !== 0) {
      return {
        exitCode: 1, stdout: '', stderr: wrote.stderr,
        command: 'cat > ' + path,
        sandboxDenied: wrote.sandboxDenied === true, noGit: false,
      }
    }
    return await git(args, ['add', '--', path], null, {})
  })
  invalidateRepo(repo)
  return {
    ok: result.exitCode === 0, repo: result.cwd != null ? result.cwd : repo, path: path,
    exitCode: result.exitCode, command: result.command,
    stdout: result.stdout, stderr: result.stderr,
    sandboxDenied: result.sandboxDenied === true, noGit: gitMissing(result),
  }
}
