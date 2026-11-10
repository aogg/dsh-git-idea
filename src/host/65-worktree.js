/* ─────────────── git worktree（只读清单）─────────────── */

/* 「工作树」块（客户端 25-worktree.js）的数据：一份 `git worktree list --porcelain`
   的翻译，口径收窄成只含 `git worktree add` 出来的链接工作区 —— 主工作区（porcelain
   的第一条记录，git 保证它排第一）与 bare 记录（也只会是主仓库）解析完即丢，不发给
   客户端。v1 是纯只读的：面板把它画出来，最多允许单击把历史按那个 worktree 的分支
   过滤 —— 不 checkout、不 prune、不碰任何 worktree 的工作区。这条边界在 v1.3 之前
   在 Host 这一层就守住了：这里只有一条读命令，没有任何写路径。

   v1.3 起多出一条、也**只有**一条写路径：worktree add（本文件中段的 addWorktree，
   RPC 名 git/worktree-add，注册在 80-rpc.js git/branch-create 附近）—— worktree 块
   「快速创建」表单的执行体，走 panelMutate（68-detail.js）：自动进「命令」页、整仓
   读缓存随之失效、noGit / sandboxDenied 各自带旗标。除此之外边界照旧：仍无 prune /
   remove / lock / move，不 checkout、不切换任何现有工作区的分支。

   走 refsSnapshot 同一套按仓库读缓存：cached(repo, 'worktrees', …) 的寿命与
   for-each-ref 那份完全相同，任何一次整仓失效（panelMutate、⟳ 的 flush、以及
   worktree 增删本身 —— 那也是对仓库的改动，watcher bump 后重读）都把它一起作废。
   因此不另立过期机制，客户端也不用理解第二种缓存语义。

   porcelain 的形状：记录之间以空行分隔；每行 `关键字 值`，值原样保留（路径可能带
   空格，取关键字之后的整行）。locked / prunable 只在成立时出现，且可以不带原因
   （光一个 `locked` 或 `prunable` 独占一行）；branch 给的是全名（refs/heads/x），
   这里剥成短名；detached 的记录没有 branch 行；bare 的记录只有 worktree / bare 两行
   —— 它和第一条主工作区一样属于旧口径的弃子，这里仍照原样解析，丢在下面统一做。 */
/* porcelain 的解析本体：记录之间以空行分隔；每行 `关键字 值`，值原样保留（路径
   可能带空格，取关键字之后的整行）。locked / prunable 只在成立时出现，且可以不带
   原因（光一个 `locked` 或 `prunable` 独占一行）；branch 给的是全名（refs/heads/x），
   这里剥成短名；detached 的记录没有 branch 行；bare 的记录只有 worktree / bare 两行
   —— 它和第一条主工作区一样属于旧口径的弃子，这里仍照原样解析，丢在调用方统一做。
   下面的 worktree 块（git/worktrees）与 git 忽略项扫描（本文件下半）共用这一份。 */
function parseWorktreeRows(stdout) {
  const out = []
  let row = null
  const lines = String(stdout).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    /* 空行是记录的分隔符；下一条 `worktree ` 行自己会开新记录，这里只把当前指针放下。 */
    if (line.length === 0) { row = null; continue }
    if (line.indexOf('worktree ') === 0) {
      row = {
        path: line.slice(9),
        head: '', branch: '',
        detached: false, bare: false,
        locked: false, lockReason: '',
        prunable: false, pruneReason: '',
      }
      out.push(row)
      continue
    }
    if (row === null) continue
    if (line.indexOf('HEAD ') === 0) row.head = line.slice(5)
    else if (line.indexOf('branch ') === 0) {
      const full = line.slice(7)
      row.branch = full.indexOf('refs/heads/') === 0 ? full.slice(11) : full
    }
    else if (line === 'detached') row.detached = true
    else if (line === 'bare') row.bare = true
    else if (line.indexOf('locked') === 0) { row.locked = true; row.lockReason = line.length > 6 ? line.slice(7) : '' }
    else if (line.indexOf('prunable') === 0) { row.prunable = true; row.pruneReason = line.length > 8 ? line.slice(9) : '' }
  }
  return out
}

async function readWorktrees(input, repo) {
  const args = argsFor(input)
  /* gitC + core.quotePath=false（66-refs.js readRefs 同一组合）：porcelain 的关键字
     本身不会被翻译，但 locked 的原因会按 quotePath 规则把非 ASCII 原因引成八进制
     （实测：`locked "\345\217\230..."`），关掉它 tooltip 里才是人话。 */
  const listed = await gitC(args, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], null, {})
  if (listed.exitCode !== 0) {
    return { ok: false, repo: repo === undefined ? null : repo, error: 'not-a-repository', stderr: listed.stderr, noGit: gitMissing(listed), worktrees: [] }
  }
  const out = parseWorktreeRows(listed.stdout)
  /* 新口径：只留 `git worktree add` 出来的链接工作区。git 保证 `worktree list`
     把主工作区排成第一条记录，直接丢头一条；bare 记录只会是主仓库（bare 的仓库
     没有工作区，add 不出来），一并丢。detached / prunable / locked 的链接工作区
     保留 —— 它们同样是 worktree add 出来的，客户端已有对应的灰行与不可点逻辑。 */
  const linked = []
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].bare === true) continue
    linked.push(out[i])
  }
  return { ok: true, repo: listed.cwd, worktrees: linked }
}

/* 与 refsSnapshot 同款的外壳：请求没点名仓库就按会话工作区直接读（git 自己会落到
   那个目录），点名了就走读缓存。 */
async function worktreesSnapshot(input) {
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readWorktrees(input, undefined)
  return await cached(repo, 'worktrees', function () { return readWorktrees(input, repo) })
}

/* ─────────────── worktree add（v1.3 起本文件唯一的写路径）─────────────── */

/* git/worktree-add：worktree 块「快速创建」表单（客户端 25-worktree.js 的
   dsh-git-wt-form）的执行体。入参 {sessionId, repo?, mode, name?, at?, path, force?}：
     · mode: 'new'（新建分支 -b）/ 'checkout'（检出已有分支，含远端分支的 dwim）/
       'detach'（游离检出 --detach）三选一；
     · path: 新工作区的绝对路径（判据与 saveWorktreeMain 的 repo 相同：charAt(0)==='/'，
       相对路径 git 会落在 cwd 底下，读者根本追不到它落哪了 —— 必须在这里挡死）；
     · name: new / checkout 必填（checkout 收本地分支短名或完整的远端分支名
       origin/feat/x —— 检出远端分支时 git 自己的 dwim 会建同名本地跟踪分支）；
     · at: 起点可空。new 空 = 从 HEAD 起；detach 空 = 显式给 'HEAD'（git 对
       `worktree add --detach <path>` 会拒收，起点必须说出口）；checkout **不收**
       at —— 要检出的那个分支名本身就是起点（客户端 checkout 模式根本不发 at；
       真收到了就答人话，不静默丢掉读者的输入）；
     · force: 客户端「强制覆盖」勾选 → --force（目录已存在且非空 / 分支已被别的
       worktree 占用 / 目录是已登记但丢失的 worktree，这三种 git 默认都拒）。
   校验失败一律 {ok:false, error:'人话'}（git/branch-create 同一个形状，80-rpc.js）；
   名字与起点过一遍 cleanRefHalf（80-rpc.js，把前导 - 与控制字符挡在 argv 外面 ——
   argv 全数组、不过 shell（panelMutate 同一规矩），要挡的是 git 自己会误读的形状）。

   argv 顺序照 git worktree add 的手册：`git worktree add [--force] [--detach]
   [-b <新分支>] <path> [<commit-ish>]` —— 旗标全部在 path 前面，path 后面只跟
   起点位那一个 <commit-ish>：
     · new      → `-b <新分支> <path> [<起点>]`（起点空 = 从 HEAD 起，git 默认）；
     · detach   → `--detach <path> <起点|HEAD>`；
     · checkout → `<path> <要检出的分支>`：检出已有分支，分支名就落在手册的
       <commit-ish> 位上（本地短名与远端全名 origin/feat/x 都放这里，后者交给 git
       的 dwim 建同名本地跟踪分支）。反例（本次修的就是它）：分支名只进了校验、
       不进 argv 的话，实际跑的是 `worktree add <path>` —— 变成 HEAD 的游离检出，
       根本不是「检出读者点名的那个分支」。
   执行走 panelMutate(input, argv, { desc: '新建 worktree' })（68-detail.js：自动进
   「命令」页 + 无条件整仓读缓存失效 + sandboxDenied / noGit 旗标），与本插件其它
   变更类 RPC 同一条路。

   成功答复把 panelMutate 结果与 worktreesSnapshot(input)（上面的现成函数）合并：
   panelMutate 已经把整仓读缓存作废，这次快照必是新账 —— 客户端一次往返同时拿到
   「创建成了」与「最新的 worktree 清单」，不必再发一次 git/worktrees。快照那半边
   万一读不出来不抹掉 add 的成功：worktrees 折成空数组、原因放在 wtError 里随行。 */
async function addWorktree(input) {
  const asked = input != null ? input : {}
  const mode = isStr(asked.mode) ? asked.mode.trim() : ''
  const path = isStr(asked.path) ? asked.path.trim() : ''
  const force = asked.force === true
  if (mode !== 'new' && mode !== 'checkout' && mode !== 'detach') {
    return { ok: false, error: 'mode 必须是 new（新建分支）/ checkout（检出分支）/ detach（游离检出）三选一' }
  }
  if (path.length === 0) return { ok: false, error: '放置目录必填：新工作区要落在哪个绝对路径（以 / 开头）' }
  if (isStoredPath(path) !== true) return { ok: false, error: '放置目录必须是绝对路径（本地以 / 开头，ssh:// 远程写成 ssh://alias/…），相对路径不收', path: path }
  const name = isStr(asked.name) ? asked.name.trim() : ''
  if (mode !== 'detach' && name.length === 0) {
    return { ok: false, error: mode === 'new' ? '新分支名必填' : '要检出的分支名必填', path: path }
  }
  const cleanedName = mode === 'detach' ? '' : cleanRefHalf(name)
  if (cleanedName === null) {
    return { ok: false, error: '分支名不合法：不能为空、不能以 - 开头、不能含控制字符', path: path }
  }
  const cleanedAt = cleanRefHalf(isStr(asked.at) ? asked.at.trim() : '')
  if (cleanedAt === null) {
    return { ok: false, error: '起点不合法：不能以 - 开头、不能含控制字符', path: path }
  }
  /* checkout 的起点位是被检出的分支名本身（手册的 <commit-ish>），没有第二个起点
     可放；客户端那个模式也不发 at。真收到就明说，不悄悄丢掉读者的输入。 */
  if (mode === 'checkout' && cleanedAt.length > 0) {
    return { ok: false, error: '检出分支模式不接受起点：要检出的分支名本身就是起点', path: path }
  }
  const argv = ['worktree', 'add']
  if (force === true) argv.push('--force')
  if (mode === 'detach') argv.push('--detach')
  if (mode === 'new') argv.push('-b', cleanedName)
  argv.push(path)
  if (mode === 'detach') argv.push(cleanedAt.length > 0 ? cleanedAt : 'HEAD')
  else if (mode === 'checkout') argv.push(cleanedName)
  else if (cleanedAt.length > 0) argv.push(cleanedAt)
  const done = await panelMutate(input, argv, { desc: '新建 worktree' })
  if (done.ok !== true) return done
  const snap = await worktreesSnapshot(input)
  const reply = Object.assign({}, done, { path: path, worktrees: snap.ok === true ? snap.worktrees : [] })
  if (snap.ok === true) reply.repo = snap.repo
  else reply.wtError = snap.error
  return reply
}

/* ─────────────── worktree 的主目录（读 + 配置）─────────────── */

/* 「这个 worktree 属于哪个主仓库」的读数（git/wt-main）与配置（git/wt-main-save）。

   背景（真机实测）：dsh 把一个 worktree 目录当会话工作区打开时，目录里的 .git 是
   一个**文件**（gitlink，内容 `gitdir: <主目录>/.git/worktrees/<名>`）。主仓库被删
   /搬走后 rev-parse 直接失败（fatal: not a git repository），而 62-panel.js 的
   repoHere 只判 `[ -e dir/.git ]` —— 判真，git 却读不动，面板于是落到说明页的
   'not-a-repo'，那一页 editable:false：读者既看不出这是 worktree，也没有任何地方
   能把「主目录现在在哪」告诉面板。这两条 RPC 就是补那个洞：读的那条把目录身份
   （linked / main / bare / plain / broken-gitlink / missing / file）、gitlink 原文、
   git 与文件系统各答的主目录候选一次带回；写的那条把读者纠正过的主目录存进插件
   配置（70-config.js 的 worktreeMains，按 worktree 绝对路径一钩一份），下次读数
   的 mainSource 就是 'config'，git 那头死活都不影响面板认路。

   同一个洞还有第二种来路（session-f8763151 抓到的）：整棵目录树从别的机器拷来
   —— 在 Windows 上建好的 worktree 拿到 Linux 机器上用 —— gitlink 里记的主目录是
   **那台机器的路径**（`gitdir: D:/code/www/gs/…/.git/worktrees/x`），文件在、字也
   对，只是这台机器上没有 D: 盘。读者比谁都知道目录搬到了哪（类似虚拟机挂载的
   目录映射：宿主的 D:\\code 挂成了客机的 /code），所以全局配置（70-config.js 的
   worktreeDirMappings，配置页「全局配置 → worktree」组编辑）允许他把它写成规则：
   识别主目录时，候选路径以「原目录」开头的那一段整段替换成「替换目录」——下面
   的 mapWorktreeDirWithRule 就是那条规则的全部。范围只到「识别」：主目录候选、身份判定
   与显示；.git 文件本身一个字节不改（Linux 的 git 依旧读不动它，面板照旧落说明页
   —— 但说明页上的主目录已经是本机真在的那份，跟着「打开这个目录」就能用），
   git 调用也照旧路由到被探测的目录。

   边界（one directory, no discovery，62-panel.js 的教条）：只看 target 这**一个**
   目录，绝不向上找父目录 —— git rev-parse 在非仓库目录里会替你找爸爸，答出另一个
   项目的分支，所以 git 那一半全部用 `-C <target>` 显式钉死；gitlink 的文本解析也
   只匹配 `^(.*)/\.git/worktrees/[^/]+$` 这一种形状，配不上就 null，不猜。 */

/* 配置里的目录映射（70-config.js 的 normalizeWorktreeDirMappings 已经洗过一遍形状：
   数组、{id,from,to}、非空、不超限）。这里再守一次「非空字符串」的底 —— readWtMain
   吃的是 readConfigFile 的缓存，这份函数对任何输入都得答一份能安全遍历的清单，
   而不是假设上游永远干净（normalizeConfig 自己的老规矩：Host 是最后一道关卡）。 */
function worktreeDirMappingsOf(config) {
  const list = config != null && Array.isArray(config.worktreeDirMappings) ? config.worktreeDirMappings : []
  const out = []
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i]
    if (one == null || typeof one !== 'object') continue
    const from = isStr(one.from) ? one.from.trim() : ''
    const to = isStr(one.to) ? one.to.trim() : ''
    if (from.length === 0 || to.length === 0) continue
    out.push({ from: from, to: to })
  }
  return out
}

/* 目录映射的前缀替换：path 以某条映射的 from 开头（按整段：要么恰好等于整条
   路径，要么后面紧跟一个分隔符 —— /data 不会配上 /database）就把那一段换成 to，
   命中第一条就停（清单的顺序就是优先级）；一条都配不上就原样送回。返回值同时带
   命中的那条规则原文（rule: {from,to}，清单里那两条的字面量，未做分隔符归一）：
   答复的 mappedRule 与自动记录（worktreeMainsMeta 的 from / to）都要写「当时命中
   的是哪条」—— 只回换算结果的话，「换算成了什么」说得清、「按哪条换算的」说不清，
   读者想改规则时没处对账；没命中 rule 为 null。

   Windows 的两种分隔符写法（gitdir 里的 D:/code/… 与 D:\\code\\…）在这里归一成
   同一种再比：\\ 与 / 都是路径分隔符，别的字符照原样（包括大小写 —— 项目里没有
   大小写不敏感的路径工具先例，D:/ 与 d:/ 就是两个目录，读者配哪个算哪个）。
   替换侧的 to 只去尾部多余的分隔符、分隔符不做归一：它是这台机器上的路径，
   读者怎么写的就怎么用（UNC 的 \\\\server\\share 若真被写进来，替他把 \\ 换成 /
   反而是改了他的地址）。 */
function mapWorktreeDirWithRule(path, mappings) {
  if (!isStr(path) || path.length === 0 || mappings.length === 0) return { path: path, rule: null }
  const slashes = path.replace(/\\/g, '/')
  for (let i = 0; i < mappings.length; i += 1) {
    const from = mappings[i].from.replace(/\\/g, '/').replace(/\/+$/, '')
    if (from.length === 0) continue
    if (slashes !== from && slashes.indexOf(from + '/') !== 0) continue
    const to = mappings[i].to.replace(/[\/\\]+$/, '')
    return { path: to + slashes.slice(from.length), rule: { from: mappings[i].from, to: mappings[i].to } }
  }
  return { path: path, rule: null }
}

/* 一次 spawn 答完所有问题（62-panel.js pathShell 同款的多路复用 stdout 标记风格；
   通道一次只跑一个处理函数，两趟便宜的不如一趟全的）。分段：
     K:   目标存在性（dir/file/none，口径同 pathShell）
     GT:  .git 的类型（dir=目录 / file=gitlink / none=没有）
     G:   gitlink 文件的第一行原文（只有 GT:file 才有；一个字节不改，Windows 的
          D:\ 反斜杠写法也照原样发回）
     AM:  从 gitlink 文本解出的主目录候选（`^(.*)/\.git/worktrees/[^/]+$` 第 1 组。
          反斜杠分隔符在解析前先归一成斜杠 —— Windows 的两种写法都得能配上目录
          映射，见函数体里那行循环的注释；G: 行不受影响）
     AC:  [ -e "$AM/.git" ] 的答案（broken-gitlink 时 mainOk 的依据；目录映射换过
          前缀的候选不在这行里 —— 它的存在性由 readWtMain 的补问回答）
     MC:  [ -e "<配置里记的主目录>/.git" ] 的答案（只在配置里真有值时才发这一行）
     N:   机器上没有 git（PANEL_NO_GIT 同一个标记字）
     GD:  `git rev-parse --absolute-git-dir` 的答案；GRC: 带出它的退出码
     CD:  `--path-format=absolute --git-common-dir`，失败退化 `--git-common-dir`
          后手动绝对化（老 git 不认 --path-format，实测 2.25 一类直接报 unknown
          option，stdout 为空正好落进退化分支）
     LC:  CD 去尾部 /.git 之后的那个目录 [ -e <它>/.git ] 的答案（linked 时 mainOk）
     TL:  `git rev-parse --show-toplevel` 的答案（bare 仓库没有，空串）
     WT-BEGIN … WT-END:<rc>：`git worktree list --porcelain` 的原文（porcelain 的
          行只会以 worktree /HEAD /branch /bare /detached /locked /prunable 开头或
          为空，撞不上上面任何标记；rc 非 0 整段作废）。
   git 那一半只在「目录存在且里面有 .git」时才跑（missing/file/plain 不必跑，省
   一趟；file 目标里不可能有 .git，条件自然盖住）。git 的报错走 stderr 原样带回，
   不 2>&1 混进值里。 */
function wtMainProbeCommand(target, configured) {
  const lines = [
    'T=' + shq(target),
    'if [ -d "$T" ]; then printf \'K:dir\\n\'',
    'elif [ -f "$T" ]; then printf \'K:file\\n\'',
    'else printf \'K:none\\n\'',
    'fi',
    'gt=\'\'',
    'if [ -d "$T/.git" ]; then gt=\'dir\'; printf \'GT:dir\\n\'',
    'elif [ -f "$T/.git" ]; then gt=\'file\'; printf \'GT:file\\n\'',
    'else gt=\'none\'; printf \'GT:none\\n\'',
    'fi',
    'am=\'\'',
    'if [ "$gt" = \'file\' ]; then',
    '  gl=$(head -n 1 "$T/.git" 2>/dev/null)',
    '  printf \'G:%s\\n\' "$gl"',
    '  q=\'\'',
    '  case "$gl" in',
    '    \'gitdir: \'*) p=${gl#gitdir: }',
    /* 反斜杠也是分隔符（Windows 的 gitdir 可能整条是 D:\code\… 的写法）：
       逐个换成 / 再走下面的解析 —— 纯 shell 内建（case 的方括号模式认字面
       反斜杠），不给探针添任何外部命令（「机器上没有 git」那节的夹具只给
       head/cat）。归一只喂给 AM 的解析，上面 G: 行发的仍是文件里的原文。 */
    '      while :; do case "$p" in *[\\\\]*) p="${p%%[\\\\]*}/${p#*[\\\\]}" ;; *) break ;; esac; done',
    '      case "$p" in */*) q=${p%/*} ;; esac',
    '    ;;',
    '  esac',
    '  case "$q" in */.git/worktrees) am=${q%/.git/worktrees} ;; esac',
    'fi',
    'printf \'AM:%s\\n\' "$am"',
    'if [ -n "$am" ] && [ -e "$am/.git" ]; then printf \'AC:1\\n\'; else printf \'AC:0\\n\'; fi',
  ]
  /* 配置里的主目录是「读者亲自纠正过的答案」：它的存在性必须按它自己验，不能拿
     gitlink 推出来的候选冒充 —— 两者完全可以不同（主仓库搬走后配置指向新家）。 */
  if (isStr(configured) && configured.length > 0) {
    lines.push('if [ -e ' + shq(configured) + '/.git ]; then printf \'MC:1\\n\'; else printf \'MC:0\\n\'; fi')
  }
  lines.push(
    'if command -v ' + gitCmd() + ' >/dev/null 2>&1; then',
    '  if [ "$gt" != \'none\' ]; then',
    '    gd=$(' + gitCmd() + ' -C "$T" rev-parse --absolute-git-dir 2>/dev/null); grc=$?',
    '    printf \'GD:%s\\n\' "$gd"',
    '    printf \'GRC:%s\\n\' "$grc"',
    '    cdp=$(' + gitCmd() + ' -C "$T" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)',
    '    case "$cdp" in',
    '      /*) ;;',
    '      \'\')',
    '        cdp=$(' + gitCmd() + ' -C "$T" rev-parse --git-common-dir 2>/dev/null)',
    '        case "$cdp" in /*) ;; \'\') ;; *) cdp="$T/$cdp" ;; esac',
    '      ;;',
    '      *) cdp="$T/$cdp" ;;',
    '    esac',
    '    printf \'CD:%s\\n\' "$cdp"',
    '    lm=\'\'',
    '    case "$cdp" in */.git) lm=${cdp%/.git} ;; esac',
    '    if [ -n "$lm" ] && [ -e "$lm/.git" ]; then printf \'LC:1\\n\'; else printf \'LC:0\\n\'; fi',
    '    tl=$(' + gitCmd() + ' -C "$T" rev-parse --show-toplevel 2>/dev/null)',
    '    printf \'TL:%s\\n\' "$tl"',
    '    if [ "$grc" = \'0\' ]; then',
    '      printf \'WT-BEGIN\\n\'',
    '      ' + gitCmd() + ' -C "$T" -c core.quotePath=false worktree list --porcelain',
    '      printf \'WT-END:%s\\n\' "$?"',
    '    fi',
    '  fi',
    'else',
    '  printf \'N:nogit\\n\'',
    'fi',
    'exit 0',
  )
  return lines.join('\n')
}

/* kind 判定与答复的拼装（wtMainProbeCommand 的 stdout → 答复）。固定口径：
     · target 非目录 → 'missing'（是文件 → 'file'）——都到不了 git 那一段；
     · .git 是目录 → 'main'（mainDir auto=target；不需要 git 认同）；
     · .git 是文件且 git 读得动：commonDir === gitdir → 'main'（子模块就是这种，
       主目录=它自己）；commonDir 以 /.git 结尾 → 'linked'（mainDir auto = 去掉
       尾巴的那段）；否则 → 'bare'（mainDir auto=null）；
     · .git 是文件但 git 读不动（命令不存在 / rev-parse 失败）→ 'broken-gitlink'
       （mainDir auto = gitlink 文本配得上的第 1 组，配不上=null；这一组先过一遍
       目录映射 —— gitlink 记的别机路径换成本机路径再当候选，见下面那段）；
     · 目录在、里面没有 .git → 'plain'。
   绝不向上找父目录；mainDir = 配置里的 ?? 自动找到的，mainSource 相应取
   'config'/'auto'，两边都没有就 null。答复另带映射四件套：mappedRule（broken-gitlink
   下映射真的换了前缀时命中的那条规则）、mainVia（'config' 来源下 'manual' /
   'mapping' 二选一）、autoRecorded（这一读顺手把换算候选自动写进了配置）、
   mappingSuggestion（手动答案失效、而映射换算候选存在时的顺手指路）。 */
async function readWtMain(input, repo, skipAutoRecord) {
  const target = repo === undefined || repo === null ? sessionWorkdir(input) : repo
  /* mappedRule / mainVia / autoRecorded / mappingSuggestion 四个键在 ok:false 的答复
     里也补齐空值：客户端按「有就画、没有就不画」读这些键，ok:false 的答复若缺键，
     客户端一处的判空写法就得为两种答复写两遍 —— 空模板补齐，读法只有一种。 */
  const empty = { kind: 'missing', gitlink: '', gitdir: '', commonDir: '', toplevel: '',
    mainDir: null, mainSource: null, configured: null, mainOk: false, mainMapped: false,
    mappedRule: null, mainVia: null, autoRecorded: false, mappingSuggestion: null,
    worktrees: [], gitMissing: false, stderr: '' }
  if (!isStr(target) || target.length === 0) {
    return Object.assign({ ok: false, error: 'no-path', repo: null }, empty)
  }
  const config = await readConfigFile()
  const raw = config != null && config.worktreeMains != null ? config.worktreeMains[repoKeyOf(target)] : undefined
  const configured = isStr(raw) && raw.trim().length > 0 ? raw.trim() : null
  /* 目录映射（全局配置 worktree 组）在读 gitlink 之前就取好：候选解出来那一刻就
     要拿它换算，与 worktreeMains 的「配置值 ?? 自动值」同一次读里各答各的账。 */
  const dirMappings = worktreeDirMappingsOf(config)
  /* cwd 是会话自己的工作区，不是被探测的路径 —— 目标不存在时 spawn 本身会先死，
     62-panel.js probeShell 的同一条规矩。 */
  const probe = await probeShell(input, wtMainProbeCommand(target, configured))
  if (probe.exitCode !== 0 && probe.stdout.length === 0) {
    return Object.assign({ ok: false, error: 'probe-failed', repo: target }, empty,
      { stderr: probe.stderr.slice(0, 400), sandboxDenied: probe.sandboxDenied === true })
  }

  let dirKind = 'none'
  let gitType = 'none'
  let gitlink = ''
  let autoFromGitlink = ''
  let autoFromGitlinkOk = false
  let configuredOk = false
  let gitdir = ''
  let gitRc = -1
  let commonDir = ''
  let linkedOk = false
  let toplevel = ''
  let gitMissing = false
  let porcelain = null
  let porcelainOpen = false
  let porcelainRc = -1
  const rows = probe.stdout.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (porcelainOpen) {
      if (row.indexOf('WT-END:') === 0) { porcelainRc = parseInt(row.slice(7), 10) || 0; porcelainOpen = false }
      else if (porcelain !== null) porcelain.push(row)
      continue
    }
    if (row.indexOf('K:') === 0) dirKind = row.slice(2)
    else if (row.indexOf('GT:') === 0) gitType = row.slice(3)
    else if (row.indexOf('G:') === 0) gitlink = row.slice(2)
    else if (row.indexOf('AM:') === 0) autoFromGitlink = row.slice(3)
    else if (row === 'AC:1') autoFromGitlinkOk = true
    else if (row === 'MC:1') configuredOk = true
    else if (row.indexOf('GD:') === 0) gitdir = row.slice(3)
    else if (row.indexOf('GRC:') === 0) gitRc = parseInt(row.slice(4), 10)
    else if (row.indexOf('CD:') === 0) commonDir = row.slice(3)
    else if (row === 'LC:1') linkedOk = true
    else if (row.indexOf('TL:') === 0) toplevel = row.slice(3)
    else if (row === 'N:nogit') gitMissing = true
    else if (row === 'WT-BEGIN') { porcelain = []; porcelainOpen = true }
  }

  const gitReadable = gitMissing !== true && gitRc === 0 && gitdir.length > 0
  let kind = 'plain'
  let autoMain = null
  let autoOk = false
  /* 主目录候选是否经过了目录映射换算（答复的 mainMapped）：只有「映射真的换了
     前缀、且换算结果被 auto 那一档采用」才置真 —— 客户端据此把「自动找到」说成
     「目录映射找到」，读者才追得到这个路径是哪来的。 */
   let mainViaMapping = false
  /* 映射真的换了前缀时命中的那条规则（{from,to}，规则原文）：自动记录的 from / to
     与顺手指路（mappingSuggestion）都用它。「答复的 mappedRule」在下面组装时按
     「换算结果真的被采用了吗」再定 —— 换算命中但没被采用（手动答案在且有效）时
     带出去，客户端就会把一条手动配置的主目录说成「按规则换算」，那是说谎。 */
  let hitRule = null
  if (dirKind === 'file') kind = 'file'
  else if (dirKind !== 'dir') kind = 'missing'
  else if (gitType === 'dir') { kind = 'main'; autoMain = target; autoOk = true }
  else if (gitType === 'file') {
    if (!gitReadable) {
      kind = 'broken-gitlink'
      /* 目录映射正是在这一格干活：gitlink 记的是别的机器的路径（Windows 的
         D:/… 整棵拷来 Linux），前缀能配上就换成本机路径。换算候选的存在性不在
         AM/AC 那两行里（探针生成时还不知道映射会换出什么），补一次一行的
         probeShell 现场问 —— 与 saveWorktreeMain 验 add 的 `[ -e <它>/.git ]`
         同一句形状。只在这里发：git 读得动的那几个 kind 里主目录是 git 自己答的
         本机路径，映射无事可做；没配映射、或前缀配不上的读者一次都不多跑。 */
      const mapped = mapWorktreeDirWithRule(autoFromGitlink, dirMappings)
      if (autoFromGitlink.length > 0) {
        if (mapped.path === autoFromGitlink) {
          autoMain = autoFromGitlink
          autoOk = autoFromGitlinkOk
        } else {
          const mappedCheck = await probeShell(input,
            'if [ -e ' + shq(mapped.path) + '/.git ]; then echo repo; else echo gone; fi')
          autoMain = mapped.path
          autoOk = mappedCheck.stdout.trim() === 'repo'
          mainViaMapping = true
          hitRule = mapped.rule
        }
      }
    } else if (commonDir.length > 0 && commonDir === gitdir) {
      /* 子模块：gitlink 指向的 modules 目录就是它唯一的版本库，commonDir 与
         gitdir 重合 —— 它自己就是「主目录」。 */
      kind = 'main'; autoMain = target; autoOk = true
    } else {
      const linked = commonDir.slice(-5) === '/.git' ? commonDir.slice(0, -5) : ''
      if (linked.length > 0) { kind = 'linked'; autoMain = linked; autoOk = linkedOk }
      else kind = 'bare'
    }
  }

  let mainDir = null
  let mainSource = null
  let mainOk = false
  if (configured !== null) { mainDir = configured; mainSource = 'config'; mainOk = configuredOk }
  else if (autoMain !== null) { mainDir = autoMain; mainSource = 'auto'; mainOk = autoOk }
  /* worktreeMains 里「读者亲自纠正过的答案」永远压过目录映射换算的那份：一条是
     对着这个 worktree 手写的，一条是对着一台机器配的通用规则，撞车时具体的那条赢
     —— 与 configured 压过 auto 同一层级的道理。 */
  const mainMapped = configured === null && mainViaMapping

  /* mainVia：worktreeMains 里那条答案的来源（meta 是自动记录时写的账）。'config'
     来源下只有两句话可说 —— 读者亲手存的（'manual'），或映射命中后 Host 自动记录
     的（'mapping'）；meta 缺席（旧数据、或读者清过又存过）按 'manual' 算 —— 那是
     它唯一确定无疑的另一种来路。其余 mainSource 下一律 null：'auto' 的来源已经由
     mainMapped 说话，不另造第三个说法。 */
  let mainVia = null
  if (mainSource === 'config') {
    const meta = config != null && config.worktreeMainsMeta != null ? config.worktreeMainsMeta[repoKeyOf(target)] : undefined
    mainVia = meta != null && meta.via === 'mapping' ? 'mapping' : 'manual'
  }

  /* 映射命中且换算候选真在时自动记录一条（配置里还没有这个 worktree 的答案）：
     把换算出的主目录与命中的规则一次写盘（worktreeMains + worktreeMainsMeta 同一份
     writeConfigFile），下次读 configured 非空走 'config'、不再写 —— 这就是「默认
     路径失败时路径替换也要试一下，命中后永久记下来方便下次识别」的落点。
     边界三条，条条是铁律：
       · configured === null 才写：worktreeMains 里已有答案（读者手写的、或既往
         自动记录的）绝不覆盖 —— 手动答案永远赢，自动记录只填空；
       · 只写插件自己的 dsh-git-idea.json：.git gitlink 文件一个字节不碰、git 的
         任何配置（仓库 --local / --global / safe.directory）一个字节不碰；
       · 写失败（沙箱拒、盘满、通道断）安静吞掉：autoRecorded=false，这次读数照常
         答出去，console 留一行 —— 读数失败比记录失败严重得多，不能让它连坐；
       · skipAutoRecord（saveWorktreeMain 的收尾快照递 true）整段跳过：读者刚亲手
         删掉配置的那一次往返，答复快照若又把映射答案记回去，「清除配置」就被
         同一次请求悄悄撤销了 —— 收据不该是一次新的自动识别。
     缓存时序：这一格是 cached(repo,'wt-main') 的 loader 在跑，cached 是「miss 存
     promise、落地写回」的形状 —— invalidateRepo 在这里删掉键之后，cached 落地时的
     写回条件（键里还是自己那个 promise）已经不成立，旧答复不会回魂占住缓存；下一读
     重新进 loader，configured 非空直接走 'config'，不再进这段 —— 无死循环。 */
  let autoRecorded = false
  if (skipAutoRecord !== true && kind === 'broken-gitlink' && configured === null && hitRule !== null && autoOk === true) {
    const key = repoKeyOf(target)
    const mains = Object.assign({}, config.worktreeMains)
    const meta = Object.assign({}, config.worktreeMainsMeta)
    /* 同值不写盘（draftSave 的同一条纪律）：meta 记录跟着本体走，本体已在（值为
       同一路径的旧记录）就不碰磁盘 —— 实际到不了这里（configured === null 已排除
       本体存在），守着它只是让「写不写盘」只有一个判据。 */
    if (mains[key] !== autoMain) {
      mains[key] = autoMain
      meta[key] = { via: 'mapping', from: hitRule.from, to: hitRule.to, at: Date.now() }
      try {
        const written = await writeConfigFile(
          Object.assign({}, config, { worktreeMains: mains, worktreeMainsMeta: meta }),
          argsAt(input, null))
        if (written.ok === true) {
          autoRecorded = true
          invalidateRepo(target, ['wt-main'])
        } else {
          console.error('dsh-git-idea: could not auto-record the mapped worktree main (' + key + '): ' + String(written.error || 'unknown'))
        }
      } catch (error) {
        console.error('dsh-git-idea: could not auto-record the mapped worktree main (' + key + '): ' + String(error))
      }
    }
  }

  /* 手动答案失效时的顺手指路（不写盘、不覆盖）：配置里的主目录已经不在了，而目录
     映射恰好能把 gitlink 的路径换算到一个**在**的目录 —— 把这条候选随答复带出去，
     客户端给一句「配置的主目录已不在；目录映射换算到 X」加一个「填入」。填不填、
     存不存都是读者的事：那格配置是他的答案，Host 只发现它旧了，不替他改。 */
  let mappingSuggestion = null
  if (configured !== null && configuredOk !== true && hitRule !== null && autoOk === true) {
    mappingSuggestion = { path: autoMain, from: hitRule.from, to: hitRule.to }
  }

  /* 答复的 mappedRule：只在「换算结果真的被面板采用」时带出 —— mainMapped（自动
     找到的那一档用了换算结果）或 mappingSuggestion（顺手指路说的正是这条换算）。
     手动答案在且有效时换算没被采用，带出去会让客户端把「手动配置」说成「按这条
     规则换算」—— 那是说谎，不如不带。 */
  const mappedRule = mainMapped === true || mappingSuggestion !== null ? hitRule : null

  /* worktrees 只在 kind 为 linked/main 且 git 读得动时解析（broken-gitlink 恒空，
     其余 kind 根本没跑 git）；main 按自动找到的主目录标（配置里改过的不参与 ——
     这一列描述的是 git 自己认的账，配置是面板认的账，两本都如实带回）。reason 把
     locked / prunable 的原因折成一句话（契约的行形状就这八个字段）。 */
  const worktrees = []
  if ((kind === 'linked' || kind === 'main') && gitReadable && porcelain !== null && porcelainRc === 0) {
    const listed = parseWorktreeRows(porcelain.join('\n'))
    for (let i = 0; i < listed.length; i += 1) {
      const row = listed[i]
      worktrees.push({
        path: row.path, head: row.head, branch: row.branch,
        detached: row.detached === true, bare: row.bare === true,
        locked: row.locked === true,
        reason: row.locked === true ? row.lockReason : (row.prunable === true ? row.pruneReason : ''),
        main: row.path === autoMain,
        current: row.path === target,
      })
    }
  }

  return Object.assign({ ok: true, repo: target }, empty, {
    kind: kind, gitlink: gitlink, gitdir: gitdir, commonDir: commonDir, toplevel: toplevel,
    mainDir: mainDir, mainSource: mainSource, configured: configured, mainOk: mainOk,
    /* mainMapped：主目录候选经过目录映射换算而来（mainSource 仍是 'auto' —— 映射
       是「怎么自动找到」的一部分，不是读者对这个 worktree 的手动答案）。mappedRule
       是当时命中的那条规则原文；mainVia 只在 'config' 来源下说话；autoRecorded 是
       「这一读顺手把映射命中的答案写进配置了」的旗标 —— 客户端据此提示「下次直接
       识别」。 */
    mainMapped: mainMapped,
    mappedRule: mappedRule,
    mainVia: mainVia,
    autoRecorded: autoRecorded,
    mappingSuggestion: mappingSuggestion,
    worktrees: worktrees, gitMissing: gitMissing, stderr: probe.stderr.slice(0, 400),
  })
}

/* git/wt-main 的外壳：读缓存按仓库一格（tag 'wt-main'），寿命与 refs / worktrees
   同一条 —— 任何一次整仓失效（panelMutate、⟳ 的 flush、watcher bump）都把它一起
   作废；只有 saveWorktreeMain 自己会在写完配置后按 tag 精确作废这一格（它改的是
   面板认的那本账，git 一根汗毛没动，整仓失效是浪费）。 */
async function wtMainSnapshot(input, skipAutoRecord) {
  const repo = repoFrom(input, null)
  if (repo === undefined) return await readWtMain(input, undefined, skipAutoRecord)
  return await cached(repo, 'wt-main', function () { return readWtMain(input, repo, skipAutoRecord) })
}

/* git/wt-main-save：把「这个 worktree 的主目录在哪」写进插件配置（70-config.js 的
   worktreeMains），答复是该 worktree 的最新 wtMainSnapshot —— 客户端一次往返就能
   把整块读数换成新账。写法仿 61-repos.js 的 saveWorkspaceRepo：readConfigFile 拿
   到的已是归一化过的整份配置，只动 worktreeMains 这一个键（add 设值 / remove 删键），
   其余键原样带过去，谁也抹不掉谁。来源账 worktreeMainsMeta 同一份 writeConfigFile
   一起维护（add 清该键的记录 —— 手动答案的来源是读者自己；remove 两键一起删），
   见函数体里那段。
   校验：add 与 remove 二选一（都给/都不给都是错）；repo 缺省=会话工作区，add 与
   repo 都必须绝对路径；add 用与手动登记同一判据 `[ -e add/.git ]` 现场验（目录或
   gitlink 文件都算 —— 主仓库自己也可以是另一个 worktree 的主），不存在是 'missing'、
   在了但不是仓库是 'not-a-repository'。同值不写盘：重复保存不该真碰一次磁盘。 */
async function saveWorktreeMain(input) {
  const add = input != null && isStr(input.add) ? input.add.trim() : ''
  const remove = input != null && input.remove === true
  if ((add.length > 0) === remove) {
    return { ok: false, error: 'exactly one of add or remove is required' }
  }
  const repo = input != null && isStr(input.repo) && input.repo.trim().length > 0 ? input.repo.trim() : (sessionWorkdir(input) || '')
  if (repo.length === 0) return { ok: false, error: 'no-path' }
  if (isStoredPath(repo) !== true) return { ok: false, error: 'absolute path required', path: repo }
  const key = repoKeyOf(repo)
  const config = await readConfigFile()
  const mains = Object.assign({}, config.worktreeMains)
  /* 来源账（worktreeMainsMeta）与本体同一个文件进出，绝不写两次盘：add 把该键的
     记录删掉 —— 手动保存之后这个答案的来源就是读者自己，不再是「映射命中后的
     自动记录」；remove 连账一起删 —— 本体没了来源账留着就是一条悬空记录。 */
  const meta = Object.assign({}, config.worktreeMainsMeta)
  if (add.length > 0) {
    if (isStoredPath(add) !== true) return { ok: false, error: 'absolute path required', path: add }
    if (mains[key] !== add) {
      const check = await probeShell(input, 'if [ -e ' + shq(add) + '/.git ]; then echo repo; elif [ -d ' + shq(add) + ' ]; then echo norepo; else echo none; fi')
      const kind = check.stdout.trim()
      if (kind === 'none') return { ok: false, error: 'missing', path: add }
      if (kind !== 'repo') return { ok: false, error: 'not-a-repository', path: add }
      mains[key] = add
      delete meta[key]
      const written = await writeConfigFile(Object.assign({}, config, { worktreeMains: mains, worktreeMainsMeta: meta }), argsAt(input, null))
      if (written.ok !== true) return written
    } else if (meta[key] !== undefined) {
      /* 同值不写本体的盘（防抖的老规矩），但来源记录仍要清：读者亲手把映射自动
         记录的那条答案又「保存」了一遍，就是在亲自认领它 —— 来源从此是手动。 */
      delete meta[key]
      const written = await writeConfigFile(Object.assign({}, config, { worktreeMainsMeta: meta }), argsAt(input, null))
      if (written.ok !== true) return written
    }
  } else {
    if (mains[key] !== undefined || meta[key] !== undefined) {
      delete mains[key]
      delete meta[key]
      const written = await writeConfigFile(Object.assign({}, config, { worktreeMains: mains, worktreeMainsMeta: meta }), argsAt(input, null))
      if (written.ok !== true) return written
    }
  }
  /* 只作废这一格再读：git 那头没动，refs / worktrees / 图的缓存都还是新账。
     收尾读直走 readWtMain 并递 skipAutoRecord（「刚亲手写下的答案不在同一次往返
     里被自动记录改写」的边界，见 readWtMain）：刻意**不**走 cached —— 这个答复若
     进缓存，「不自动记录」的形状会跟着条目一起住进去，下一次普通读命中缓存就
     再也不自动记录了；缓存留空，下一次 RPC 重新加载， configured 有值（add 之后的
     正常形状）或重新自动识别（remove 之后回到的正是「默认路径失败、映射再试一次」
     的状态）。 */
  invalidateRepo(repo, ['wt-main'])
  return await readWtMain(Object.assign({}, input, { repo: repo }), repo, true)
}


/* ─────────────── git 忽略项扫描（只读，多仓库 × 多 worktree）─────────────── */

/* 配置页「仓库」组里「git 忽略项」分组的数据（80-panel.js GitIgnoredScanGroup）。
   与上面的 worktree 块不是一回事：那边只描述当前生效仓库，这份扫描一次吃下客户端
   shown 清单里的**全部仓库**（工作区扫到 + 手动登记，missing 不在列），并逐仓库
   枚举它的**全部工作树** —— 被忽略的文件是工作树局部的（.gitignore 站在工作树里，
   被忽略的产物也只存在于某棵工作树），不逐工作树问，链接工作树里的忽略项会整个
   漏掉。纯只读，三条边界在这里守死：

     · 只有两条读命令（worktree list --porcelain、ls-files --others --ignored
       --exclude-standard --directory），没有任何写路径，也**不进读缓存** —— 扫描
       的意义就是「点按钮、看现在」，缓存一份旧账反而误导；
     · 路径只进 workdir（每工作树一次 spawn，workdir=工作树根），argv 全是常量，
       没有 shell 拼接面；
     · 上限口径（ao-local 同款）：单次 10s、输出 16MB、总量 2000 条截断、整次约
       30s 软截止；一个仓库或一个工作树失败只标它自己（ok:false + reason），
       不拖垮其余。 */

const IGNORED_SCAN_TIMEOUT_MS = 10000
const IGNORED_SCAN_MAX_BYTES = 16 * 1024 * 1024
const IGNORED_SCAN_MAX_ITEMS = 2000
const IGNORED_SCAN_TOTAL_BUDGET_MS = 30000
/* 与 61-repos.js 的 REPO_LIST_MAX 同一个边界：shown 清单本身就到不了 64 个以上，
   这里照抄封顶，一个怪物请求也进不了 spawn 循环。 */
const IGNORED_SCAN_MAX_REPOS = 64

/* 一次失败的人话（runGitIgnoredListing 的同款折法，换成这个插件的旗标）：没有 git、
   被沙箱拒了、超时，都说它自己的话；其余用 stderr 首行 —— git 的原话在哪个 locale
   都比「退出码 128」有用。 */
function ignoredFailureReason(result) {
  if (result == null) return 'git 没有给出原因'
  if (gitMissing(result) === true) return 'git 命令不存在（这台机器的 PATH 里没有可用的 git）'
  if (result.sandboxDenied === true) return '文件沙箱拒绝了这次读取'
  if (result.timedOut === true) return '读取超时（10 秒上限）'
  const lines = String(result.stderr == null ? '' : result.stderr).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line.length > 0) return line
  }
  return 'git 读取失败（退出码 ' + String(result.exitCode) + '）'
}

/* 仓库路径先校验（一次 shell 问完所有仓库，61-repos.js 合成一次 spawn 的同一手法）：
   存在、是目录、里面有没有 .git（目录或 worktree gitlink 文件都算，与手动登记同一
   判据）。cwd 是会话自己的工作区，不是被探测的路径 —— 62-panel.js probeShell 的
   同一条规矩。 */
function ignoredValidateCommand(repos) {
  const lines = []
  for (let i = 0; i < repos.length; i += 1) {
    const quoted = shq(repos[i])
    lines.push('if [ -d ' + quoted + ' ]; then '
      + 'if [ -e ' + quoted + '/.git ]; then printf ' + shq('V:' + i + ':ok\n')
      + '; else printf ' + shq('V:' + i + ':nogit\n') + '; fi; '
      + 'else printf ' + shq('V:' + i + ':nodir\n') + '; fi')
  }
  return lines.join('\n')
}

/* 一棵工作树的忽略项清单：cwd=工作树根跑 ls-files --others --ignored
   --exclude-standard --directory（--exclude-standard 含 .gitignore + .git/info/
   exclude + 全局排除；--directory 把整个被忽略目录折叠成一行带尾斜杠的目录）。
   刻意不带 -z、改用 core.quotePath=false + 按行分割：本插件走 shell 通道而不是
   直接 spawn，\0 能不能活着穿过通道没有保证；quotePath 关掉后 git 仍会把换行等
   控制字符引成 C 转义（65-worktree 头部对 locked 原因的实测同一规则），行分割
   因此永远安全，而非 ASCII 文件名保持原样 —— 忽略项是给人看的清单，中文文件名
   不该变成八进制。 */
async function ignoredWorktreeScan(input, worktreePath) {
  const listed = await gitC(argsAt(input, worktreePath),
    ['-c', 'core.quotePath=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    null, { timeoutMs: IGNORED_SCAN_TIMEOUT_MS, maxBytes: IGNORED_SCAN_MAX_BYTES })
  if (listed.exitCode !== 0) {
    return { ok: false, reason: ignoredFailureReason(listed), items: [], truncated: false }
  }
  /* 通道在 16MB 处截断输出时 stdout 会被掐短（truncated 标志）：照实说「不完整」，
     装作完整反而是害人。 */
  const truncated = listed.truncated === true
  const items = []
  const lines = listed.stdout.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.length === 0) continue
    items.push({ path: line, dir: line.slice(-1) === '/' })
  }
  return { ok: true, reason: '', items: items, truncated: truncated }
}

/* git/ignored-scan 的执行体（80-rpc.js 注册）：入参 {sessionId, repos:[绝对路径]}。
   逐仓库：worktree list 解析出全部工作树（含主工作区，跳过 bare）→ 逐工作树跑
   上面的 ignoredWorktreeScan。总量 2000 条截断（截到点后不再启动新的工作树读取，
   没扫的格子 ok:false 说明原因）；整次 30s 软截止在每次 spawn 之前看表，到点同样
   不再启动新读取、timedOut:true —— 两把闸都只在「启动前」拦，绝不半路掐断一个
   正在读的工作树（半份输出比没有更误导）。 */
async function ignoredScanSnapshot(input) {
  const startedAt = Date.now()
  const requested = input != null && Array.isArray(input.repos) ? input.repos : []
  const repos = []
  for (let i = 0; i < requested.length && repos.length < IGNORED_SCAN_MAX_REPOS; i += 1) {
    const one = isStr(requested[i]) ? requested[i].trim() : ''
    if (one.length === 0 || isStoredPath(one) !== true || repos.indexOf(one) >= 0) continue
    repos.push(one)
  }
  if (repos.length === 0) {
    return { ok: false, error: 'no-repos', repos: [], truncated: false, timedOut: false }
  }

  const checked = await probeShell(input, ignoredValidateCommand(repos))
  if (checked.exitCode !== 0 && checked.stdout.length === 0) {
    return { ok: false, error: 'validate-failed', stderr: checked.stderr.slice(0, 400),
      sandboxDenied: checked.sandboxDenied === true, repos: [], truncated: false, timedOut: false }
  }
  const verdict = {}
  const rows = checked.stdout.split('\n')
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.indexOf('V:') !== 0) continue
    const parts = row.split(':')
    verdict[parts[1]] = parts[2]
  }

  const reports = []
  let totalItems = 0
  let truncated = false
  let timedOut = false

  for (let r = 0; r < repos.length; r += 1) {
    const repoPath = repos[r]
    const report = { path: repoPath, ok: true, reason: '', worktrees: [] }
    reports.push(report)
    if (timedOut === true || Date.now() - startedAt >= IGNORED_SCAN_TOTAL_BUDGET_MS) {
      timedOut = true
      report.ok = false
      report.reason = '扫描总时长到了上限（30 秒），这个仓库没有扫'
      continue
    }
    const kind = verdict[String(r)]
    if (kind !== 'ok') {
      report.ok = false
      report.reason = kind === 'nogit'
        ? '这个目录存在，但不是 git 仓库（里面没有 .git）'
        : '这个目录不存在（或不是目录）'
      continue
    }
    const listed = await gitC(argsAt(input, repoPath),
      ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], null,
      { timeoutMs: IGNORED_SCAN_TIMEOUT_MS })
    if (listed.exitCode !== 0) {
      report.ok = false
      report.reason = ignoredFailureReason(listed)
      continue
    }
    const treeRows = parseWorktreeRows(listed.stdout)
    /* 主工作区 = porcelain 里第一条非 bare 记录（git 保证它排第一；bare 仓库的主
       记录是 bare，没有工作区可言），其余非 bare 记录都是 git worktree add 出来的
       链接工作区 —— 行上的 main 就是按这个位置标的。 */
    let mainIndex = -1
    for (let w = 0; w < treeRows.length; w += 1) {
      if (treeRows[w].bare === true) continue
      mainIndex = w
      break
    }
    for (let w = 0; w < treeRows.length; w += 1) {
      const row = treeRows[w]
      if (row.bare === true) continue
      const worktree = {
        path: row.path,
        main: w === mainIndex,
        branch: row.branch,
        detached: row.detached === true,
        ok: true,
        reason: '',
        items: [],
      }
      report.worktrees.push(worktree)
      if (timedOut === true || Date.now() - startedAt >= IGNORED_SCAN_TOTAL_BUDGET_MS) {
        timedOut = true
        worktree.ok = false
        worktree.reason = '扫描总时长到了上限（30 秒），这个工作树没有扫'
        continue
      }
      if (totalItems >= IGNORED_SCAN_MAX_ITEMS) {
        worktree.ok = false
        worktree.reason = '忽略项总量到了上限（' + String(IGNORED_SCAN_MAX_ITEMS) + ' 条），这里没有再扫'
        continue
      }
      const outcome = await ignoredWorktreeScan(input, row.path)
      if (outcome.ok !== true) {
        worktree.ok = false
        worktree.reason = outcome.reason
        continue
      }
      /* 全局 2000 条硬截断（ao-local 同一口径）：装填到点就停 —— 这棵工作树剩下
         的条目不再收，排在后面的工作树也不再启动（上面那道闸），truncated 说话。
         装填途中被截的那棵，行上的条数因此比实际少。 */
      for (let k = 0; k < outcome.items.length; k += 1) {
        if (totalItems >= IGNORED_SCAN_MAX_ITEMS) { truncated = true; break }
        worktree.items.push(outcome.items[k])
        totalItems += 1
      }
      if (outcome.truncated === true) {
        worktree.truncated = true
        truncated = true
      }
    }
  }

  const reply = { ok: true, repos: reports, truncated: truncated, timedOut: timedOut }
  return reply
}
