import fs from 'node:fs'
import { spawn } from 'node:child_process'

/* ── 文件右键菜单（61-filemenu.js）+ 多选提交整行高亮（46-css.js）+ Host 三条新 RPC ──
 *
 * 一个套件盯三件事（对应这次改动的三块）：
 *   1. CSS：.dsh-git-crow-multi 有与 .dsh-git-crow-sel 同色的整行背景 + hover 同色
 *      （多选的每一条都要看得见被选中，悬停不许变色）；
 *   2. Host：diff 的 local 模式（argv 与 ref 校验）；git/get-from-rev、
 *      git/clean-paths、git/revert-paths 的 argv 拼装、坏 hash/坏路径拒绝，
 *      以及 revert-paths 的真实效果（show 补丁反向 apply 回去，stdin 进 apply）；
 *   3. fileMenuItems 的启用/置灰矩阵：目录行「打开源文件」置灰、worktree 下优选
 *      置灰、未跟踪才可删除、历史树下「从修订中获取」可用；顺带 treeDirRow 的
 *      onContext 透传（不传回调 = 分支行一个字不变）。
 *
 * Host 那一半读 GP_SRC（run-all.mjs 的 GP_FRESH 会指到临时拼接）；没设时在这里用
 * build.mjs 的 render 现拼一份 —— 测的永远是 src/，仓库产物一个字节不动。 */

let failed = 0
const ok = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
const ROOT = new URL('..', import.meta.url).pathname

/* ═══ 1. CSS：多选提交整行高亮 ═══ */

console.log('')
console.log('=== CSS：.dsh-git-crow-multi 整行高亮 ===')
const css = fs.readFileSync(ROOT + 'src/client/46-css.js', 'utf8')
const multiRule = /\.dsh-git-crow-multi\{[^}]*\}/.exec(css)
ok('.dsh-git-crow-multi 规则存在', multiRule !== null)
ok('多选行有整行背景（与选中行同一个 --dsw-alias-interactive-bg-hover）',
  multiRule !== null && multiRule[0].indexOf('background:var(--dsw-alias-interactive-bg-hover)') >= 0)
ok('左缘警示竖线保留（box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary)）',
  multiRule !== null && multiRule[0].indexOf('box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary)') >= 0)
const multiHover = /\.dsh-git-crow-multi:hover\{[^}]*\}/.exec(css)
ok('hover 同色规则存在（悬停不变色，.dsh-git-crow-sel:hover 同一条规矩）',
  multiHover !== null && multiHover[0].indexOf('background:var(--dsw-alias-interactive-bg-hover)') >= 0)
ok('hover 规则写在 .dsh-git-crow:hover 之后（同权重后者赢，这是它能防闪烁的原因）',
  multiHover !== null && css.indexOf('.dsh-git-crow:hover{') < css.indexOf(multiHover[0]))
ok('选中行的背景还是原样（这条改动不许碰它）',
  /\.dsh-git-crow-sel\{background:var\(--dsw-alias-interactive-bg-hover\)\}/.test(css))

/* ═══ 3. fileMenuItems 的启用/置灰矩阵 ═══
 *
 * 61-filemenu.js 是纯函数片段，只用 h 与 text —— 用最小替身整段求值，菜单项的
 * disabled/title/onClick 直接从产物元素上读。 */

console.log('')
console.log('=== fileMenuItems：启用/置灰矩阵 ===')
const menuSrc = fs.readFileSync(ROOT + 'src/client/61-filemenu.js', 'utf8')
const treeSrc = fs.readFileSync(ROOT + 'src/client/44-treerow.js', 'utf8')
const menuApi = new Function('h', 'text', menuSrc + '\nreturn { fileMenuItems: fileMenuItems, fileMenuTarget: fileMenuTarget }')(
  (type, props) => ({ type: type, props: Object.assign({}, props) }),
  (v) => (typeof v === 'string' ? v : ''))
const labelOf = (el) => {
  const kids = el.props.children
  return typeof kids === 'string' ? kids : String(kids)
}

const itemsOf = (target, acts) => menuApi.fileMenuItems(target, acts)
const find = (items, key) => items.find((el) => el.props.key === key)
const COMMIT = { listKind: 'commit', repo: '', rev: 'abc1234def', paths: [{ path: 'src/a.js', dir: false }] }
const COMMIT_DIR = { listKind: 'commit', repo: '', rev: 'abc1234def', paths: [{ path: 'src', dir: true }] }
const RANGE = { listKind: 'range', repo: '', rev: 'def5678abc', paths: [{ path: 'src/a.js', dir: false }] }
const WORK_FILE = { listKind: 'worktree', repo: '', rev: '', paths: [{ path: 'a.js', dir: false, untracked: false, staged: false }] }
const WORK_NEW = { listKind: 'worktree', repo: '', rev: '', paths: [{ path: 'new.js', dir: false, untracked: true, staged: false }] }
const WORK_NEW_DIR = { listKind: 'worktree', repo: '', rev: '', paths: [{ path: 'newdir/', dir: true, untracked: true, staged: false }] }

const baseActs = () => ({
  busy: false, arm: '', setArm: () => {}, setCtxMenu: () => {},
  canOpenFile: true, openWhy: '', historyOk: true, historyWhy: '',
  onCompareLocal: () => {}, onOpenFile: () => {}, onShowDiff: () => {}, onRevert: () => {},
  onCherryPick: () => {}, onClean: () => {}, onGetFromRev: () => {}, onShowHistory: () => {},
})

/* 历史提交文件树：八项全在场，看的三项与「从修订中获取」都可用。 */
let items = itemsOf(COMMIT, baseActs())
ok('历史树下八项齐全（与本地比较/打开源文件/显示差异/还原/优选/删除/从修订中获取/显示历史）',
  ['compare-local', 'open-file', 'show-diff', 'revert', 'cherry-pick', 'clean', 'get-from-rev', 'history']
    .every((k) => find(items, k) !== undefined))
ok('历史树下「从修订中获取」可用', find(items, 'get-from-rev').props.disabled !== true)
ok('历史树下「与本地比较」可用', find(items, 'compare-local').props.disabled !== true)
ok('历史树下「删除所选更改」置灰，title 指回还原/提交行菜单',
  find(items, 'clean').props.disabled === true
  && String(find(items, 'clean').props.title).indexOf('还原所选更改') >= 0)
ok('历史树下「显示差异」可用（目录聚合走同一条 onShowDiff）',
  find(items, 'show-diff').props.disabled !== true)

/* 目录行：打开源文件置灰，且 title 说话。 */
items = itemsOf(COMMIT_DIR, baseActs())
ok('目录行「打开源文件」置灰', find(items, 'open-file').props.disabled === true)
ok('目录行「打开源文件」的 title 说「目录没有对应的源文件」',
  String(find(items, 'open-file').props.title).indexOf('目录没有对应的源文件') >= 0)
ok('目录行其余项不受连坐（与本地比较/显示差异/还原仍可用）',
  find(items, 'compare-local').props.disabled !== true
  && find(items, 'show-diff').props.disabled !== true
  && find(items, 'revert').props.disabled !== true)

/* 合并视图：与本地比较可用（rev = selSpan.head），拣选可用（整段选区）。 */
items = itemsOf(RANGE, baseActs())
ok('合并视图「与本地比较」可用', find(items, 'compare-local').props.disabled !== true)
ok('合并视图「优选所选更改」可用', find(items, 'cherry-pick').props.disabled !== true)
ok('合并视图「从修订中获取」可用', find(items, 'get-from-rev').props.disabled !== true)

/* worktree：与本地比较、从修订中获取整项隐藏；优选置灰。 */
items = itemsOf(WORK_FILE, baseActs())
ok('worktree 下没有「与本地比较」（自己跟自己比是废话）', find(items, 'compare-local') === undefined)
ok('worktree 下没有「从修订中获取」（没有修订可取）', find(items, 'get-from-rev') === undefined)
ok('worktree 下「优选所选更改」置灰，title「拣选只对提交生效」',
  find(items, 'cherry-pick').props.disabled === true
  && String(find(items, 'cherry-pick').props.title).indexOf('拣选只对提交生效') >= 0)
ok('worktree 已跟踪行「删除所选更改」置灰，title 指回「还原所选更改」',
  find(items, 'clean').props.disabled === true
  && String(find(items, 'clean').props.title).indexOf('还原所选更改') >= 0)
ok('worktree 已跟踪行「还原所选更改」可用（两段式武装前不红）',
  find(items, 'revert').props.disabled !== true
  && String(find(items, 'revert').props.className).indexOf('dsh-git-menu-danger') < 0)

/* worktree 未跟踪：只有「删除所选更改」可用（危险红），还原与历史置灰。 */
items = itemsOf(WORK_NEW, baseActs())
ok('未跟踪行「删除所选更改」可用且危险红',
  find(items, 'clean').props.disabled !== true
  && String(find(items, 'clean').props.className).indexOf('dsh-git-menu-danger') >= 0)
ok('未跟踪行「还原所选更改」置灰（没有改动可还原，title 指去删除）',
  find(items, 'revert').props.disabled === true
  && String(find(items, 'revert').props.title).indexOf('删除所选更改') >= 0)
ok('未跟踪行「显示历史记录」置灰（git 还没见过它）',
  find(items, 'history').props.disabled === true
  && String(find(items, 'history').props.title).indexOf('还没有历史') >= 0)
ok('未跟踪行「显示差异」仍可用（untracked 差异是既有能力）',
  find(items, 'show-diff').props.disabled !== true)

/* 未跟踪目录（git 折叠的 newdir/）：同未跟踪文件，且「打开源文件」因目录置灰。 */
items = itemsOf(WORK_NEW_DIR, baseActs())
ok('未跟踪目录「删除所选更改」可用、title 说连同里面的文件',
  find(items, 'clean').props.disabled !== true
  && String(find(items, 'clean').props.title).indexOf('连同里面的文件') >= 0)
ok('未跟踪目录「打开源文件」置灰（目录）', find(items, 'open-file').props.disabled === true)
ok('未跟踪目录「显示差异」置灰（目录没有可比较的版本）',
  find(items, 'show-diff').props.disabled === true)

/* 打开源文件的守卫结果由面板预检递进来：没过就置灰 + 原因在 title。 */
items = itemsOf(WORK_FILE, Object.assign(baseActs(), { canOpenFile: false, openWhy: '右侧文件页不在' }))
ok('守卫没过时「打开源文件」置灰且 title 带面板给的原因',
  find(items, 'open-file').props.disabled === true
  && String(find(items, 'open-file').props.title).indexOf('右侧文件页不在') >= 0)

/* 多仓库分组：行属于别的仓库时「显示历史记录」置灰。 */
items = itemsOf({ listKind: 'worktree', repo: '/ws/beta', rev: '', paths: [{ path: 'a.js', dir: false }] },
  Object.assign(baseActs(), { historyOk: false, historyWhy: '在左栏的仓库行上单击切到它' }))
ok('别的仓库的行「显示历史记录」置灰，title 说去哪切',
  find(items, 'history').props.disabled === true
  && String(find(items, 'history').props.title).indexOf('另一个仓库') >= 0)

/* 两段式：第一次点只武装（setArm），第二次才发动作；危险项武装后变红。 */
{
  let armKey = ''
  let fired = 0
  const acts = Object.assign(baseActs(), {
    setArm: (key) => { armKey = key },
    onClean: (paths) => { fired += 1 },
  })
  items = itemsOf(WORK_NEW, acts)
  const clean = find(items, 'clean')
  clean.props.onClick({ stopPropagation: () => {} })
  ok('第一次点「删除所选更改」只武装（不发动作）', fired === 0 && armKey.indexOf('file:clean:new.js') === 0)
  const armed = find(itemsOf(WORK_NEW, Object.assign(acts, { arm: armKey })), 'clean')
  ok('武装后按钮变红、label 不变（title 说再点一次执行）',
    String(armed.props.className).indexOf('dsh-git-menu-danger') >= 0
    && String(armed.props.title).indexOf('再点一次执行') >= 0)
  armed.props.onClick({ stopPropagation: () => {} })
  ok('第二次点执行动作（onClean 收到去尾斜杠的路径）', fired === 1)
}

/* treeDirRow 的 onContext 透传：传了挂右键、不传一字不变（分支树那条底线）。 */
{
  const treeApi = new Function('h', 'twisty', 'text', treeSrc + '\nreturn treeDirRow')(
    (type, props) => ({ type: type, props: Object.assign({}, props) }),
    (props) => ({ type: 'span', props: { title: props.title } }),
    (v) => (typeof v === 'string' ? v : ''))
  const node = { kind: 'dir', name: 'src', path: '@files/src', depth: 1, collapsed: false, count: 2, id: '@files:d:@files/src' }
  const bare = { selectedKey: null, onSelect: () => {}, onToggle: () => {} }
  ok('分支树的目录行（不传 onContext）没有 onContextMenu —— 行为一字不变',
    treeApi(node, bare, '2').props.onContextMenu === undefined)
  let seen = null
  const withCtx = Object.assign({}, bare, { onContext: (n, e) => { seen = { node: n, event: e } } })
  const row = treeApi(node, withCtx, '2')
  row.props.onContextMenu({ preventDefault: () => {}, stopPropagation: () => {} })
  ok('传了 onContext 的目录行右键把整个 node 交出去', seen !== null && seen.node === node)
}

/* ═══ 2. Host：local diff 模式与三条新 RPC ═══ */

console.log('')
console.log('=== Host：diff local 模式 / 三条新 RPC ===')

let hostBody = process.env.GP_SRC || null
if (hostBody === null) {
  const built = await import(ROOT + 'build.mjs')
  hostBody = built.render(built.TARGETS.find((t) => t.out === 'host.js'))
} else {
  hostBody = fs.readFileSync(hostBody, 'utf8')
}

/* 记账式 shell 替身：被测命令逐条记下来；配置探针（readConfigFile 的 DSH_HOME
 * 一问）单独答、不记 —— 它不属于被测命令，混进 calls 只会让下标说谎。 */
function makeHost(run) {
  const handlers = new Map()
  const ctx = {
    get: (n) => (n === 'shell' ? { resolve: (r) => r, run: run } : undefined),
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
  }
  const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
  new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', hostBody)(
    ctx, harness, console, (s) => Buffer.from(s, 'binary').toString('base64'),
    (s) => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
  return (n) => handlers.get(n)
}

const FAKE_DIFF = 'diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+a2\n'
/* 探针 = 不带 git 命令的 invoke（readConfigFile 的 DSH_HOME 一问与 cat 配置文件）。
 * shellGit 拼出的每条被测命令里都有 `git '`，以此分账。 */
const isConfigProbe = (spec) => String(spec.command).indexOf("git '") < 0
/* 配置探针的两问各答各的：DSH_HOME 一问答家，cat 配置文件一问答 '{}' —— 返回
 * 家目录会让 readConfigFile 的 JSON.parse 白报一次错，输出全是噪音。 */
const probeAnswer = (spec) => (String(spec.command).indexOf('DSH_HOME') >= 0
  ? '/tmp/gp59-home' : '{}')

{
  const calls = []
  let answer = () => ({ exitCode: 0, stdout: { text: FAKE_DIFF }, stderr: { text: '' } })
  const run = (spec) => {
    if (isConfigProbe(spec)) return Promise.resolve({ exitCode: 0, stdout: { text: probeAnswer(spec) }, stderr: { text: '' } })
    calls.push(spec)
    return Promise.resolve(answer())
  }
  const H = makeHost(run)

  const diff = await H('git/diff')({ repo: '/r', mode: 'local', path: 'a.txt', ref: 'abc1234def' })
  /* shellGit 拼的整行以 --no-optional-locks -c core.quotePath=false 开头（插件级
     前缀），子命令从 'diff' 起 —— 断言从子命令往后对。 */
  ok('diff local：ok，argv 是 git diff --no-color --no-ext-diff <ref> -- <path>',
    diff.ok === true && calls.length === 1
    && calls[0].command.indexOf("'diff' '--no-color' '--no-ext-diff' 'abc1234def' '--' 'a.txt'") >= 0)
  ok('diff local：只读（--no-optional-locks 在最前）', calls[0].command.indexOf("'--no-optional-locks'") >= 0)

  calls.length = 0
  const badRef = await H('git/diff')({ repo: '/r', mode: 'local', path: 'a.txt', ref: 'main' })
  ok('diff local：ref 不是 7–40 位十六进制被拒（main 是分支名，不放行）',
    badRef.ok !== true && badRef.error === 'invalid-ref' && calls.length === 0)
  const badMode = await H('git/diff')({ repo: '/r', mode: 'nope', path: 'a.txt' })
  ok('diff：未知模式照旧拒绝（名单里有 local 了，但没放开别的）',
    badMode.ok !== true && String(badMode.stderr).indexOf('worktree, staged, commit, untracked, range, local') >= 0)

  calls.length = 0
  const rev = await H('git/revert-paths')({ repo: '/r', ref: 'abc1234def', paths: ['a.txt'] })
  ok('revert-paths：先 show 拿补丁（-m --first-parent --format=）',
    calls.length === 2 && calls[0].command.indexOf("'show' '-m' '--first-parent' '--format=' 'abc1234def' '--' 'a.txt'") >= 0)
  ok('revert-paths：再 apply -R --whitespace=nowarn（第一刀素的成了就不补 --3way），补丁走 stdin',
    calls[1].command.indexOf("git 'apply' '-R' '--index' '--whitespace=nowarn'") >= 0
    && calls[1].command.indexOf("'--3way'") < 0 && calls[1].stdin === FAKE_DIFF)
  ok('revert-paths：答复 ok 并带 ref/paths', rev.ok === true && rev.ref === 'abc1234def' && JSON.stringify(rev.paths) === '["a.txt"]')

  calls.length = 0
  const got = await H('git/get-from-rev')({ repo: '/r', ref: 'abc1234def', paths: ['a.txt', 'b.txt'] })
  ok('get-from-rev：argv 是 checkout <ref> -- 路径',
    got.ok === true && calls.length === 1
    && calls[0].command.indexOf("git 'checkout' 'abc1234def' '--' 'a.txt' 'b.txt'") >= 0)
  calls.length = 0
  const cleaned = await H('git/clean-paths')({ repo: '/r', paths: ['newdir/', 'new.txt'] })
  ok('clean-paths：argv 是 clean -fd -- 路径（尾斜杠由客户端去，Host 照收）',
    cleaned.ok === true && calls.length === 1
    && calls[0].command.indexOf("git 'clean' '-fd' '--' 'newdir/' 'new.txt'") >= 0)

  calls.length = 0
  const badHash = await H('git/get-from-rev')({ repo: '/r', ref: 'HEAD', paths: ['a.txt'] })
  ok('get-from-rev：ref 不是十六进制 hash 被拒，一个命令都没跑',
    badHash.ok !== true && badHash.error === 'bad-value' && calls.length === 0)
  const badHash2 = await H('git/revert-paths')({ repo: '/r', ref: 'zzz', paths: ['a.txt'] })
  ok('revert-paths 同样', badHash2.ok !== true && badHash2.error === 'bad-value' && calls.length === 0)
  const badPath = await H('git/clean-paths')({ repo: '/r', paths: ['/etc/passwd'] })
  ok('clean-paths：绝对路径被拒（repoRelativePath 同一条关卡），一个命令都没跑',
    badPath.ok !== true && badPath.error === 'invalid-path' && calls.length === 0)
  const upPath = await H('git/get-from-rev')({ repo: '/r', ref: 'abc1234def', paths: ['../x'] })
  ok('get-from-rev：「..」同样被拒', upPath.ok !== true && upPath.error === 'invalid-path' && calls.length === 0)
  const noPaths = await H('git/clean-paths')({ repo: '/r' })
  ok('clean-paths：没给路径拒绝（restore/stash 同一句 error）',
    noPaths.ok !== true && noPaths.error === 'no paths given')

  calls.length = 0
  answer = () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
  const empty = await H('git/revert-paths')({ repo: '/r', ref: 'abc1234def', paths: ['a.txt'] })
  ok('revert-paths：补丁为空（提交没碰这些路径）= 拒绝且不跑 apply',
    empty.ok !== true && empty.error === 'empty-patch' && calls.length === 1)
}

/* 真实 git：revert-paths 的两步真的把工作区拉回提交里的样子（gp45-host-test 的
 * 真仓库模式 —— 假替身验形状，真仓库验效果）。 */
const hasGit = await new Promise((res) => {
  const c = spawn('sh', ['-c', 'command -v git >/dev/null 2>&1 && echo yes || echo no'])
  let out = ''
  c.stdout.on('data', (b) => { out += b })
  c.on('close', () => res(out.trim() === 'yes'))
})
if (hasGit !== true) {
  console.log('  （这台机器没有 git，revert-paths 的真实效果一段跳过）')
} else {
  const sh = (cmd, cwd) => new Promise((res) => {
    const c = spawn('sh', ['-c', cmd], { cwd })
    let o = '', e = ''
    c.stdout.on('data', (b) => { o += b })
    c.stderr.on('data', (b) => { e += b })
    c.on('error', (er) => res({ code: null, out: o, err: String(er.message) }))
    c.on('close', (x) => res({ code: x, out: o, err: e }))
  })
  const R = '/tmp/gp59-repo'
  fs.rmSync('/tmp/gp59-home', { recursive: true, force: true })
  /* 两条提交：base 是「以前的样子」，tweak 把两个路径改成「现在提交里的样子」。
     revert-paths 对 tweak 反向应用，答案就是 base 的内容 —— 根提交没有父提交，
     show 出来的是「新文件」补丁，反向应用是删文件，不是这里要验的语义。 */
  await sh(`rm -rf ${R} && mkdir -p ${R} && cd ${R} && git init -q -b main && git config user.email t@t && git config user.name T`
    + ` && printf 'a\\n' > a.txt && mkdir -p sub && printf 's\\n' > sub/s.txt && git add -A && git commit -qm base`
    + ` && printf 'a0\\n' > a.txt && printf 's0\\n' > sub/s.txt && git add -A && git commit -qm tweak`, '/tmp')
  const head = (await sh('git rev-parse HEAD', R)).out.trim()

  const calls = []
  const run = (spec) => new Promise((res) => {
    if (isConfigProbe(spec)) {
      return res({ exitCode: 0, stdout: { text: probeAnswer(spec) }, stderr: { text: '' } })
    }
    calls.push(spec)
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: Object.assign({}, process.env, { DSH_HOME: '/tmp/gp59-home' }) })
    let o = '', e = ''
    c.stdout.on('data', (b) => { o += b })
    c.stderr.on('data', (b) => { e += b })
    c.on('error', (er) => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', (x) => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
    /* stdin 只喂给会读它的那条命令（apply）：git show 不读 stdin，往里写只会等来
       一场 EPIPE。 */
    if (typeof spec.stdin === 'string' && spec.command.indexOf("'apply'") >= 0) {
      c.stdin.on('error', () => {})
      c.stdin.write(spec.stdin)
      c.stdin.end()
    }
  })
  const H = makeHost(run)

  /* 场景一（历史页的常态）：工作区干净地站在 HEAD（=tweak）上，还原 tweak 对
     两个路径做的改动 —— 素的 apply -R 就成立（工作区内容正是 rev 的），结果是
     base 的内容。 */
  const reverted = await H('git/revert-paths')({ repo: R, ref: head, paths: ['a.txt', 'sub'] })
  if (reverted.ok !== true) console.log('  [revert reply]', JSON.stringify(reverted).slice(0, 400))
  ok('revert-paths（真仓库）：ok，tweak 带来的改动被撤销，两个路径回到 base 的内容',
    reverted.ok === true && reverted.threeWay === false
    && (await sh('cat a.txt', R)).out.trim() === 'a'
    && (await sh('cat sub/s.txt', R)).out.trim() === 's')
  /* 撤销一个已提交的改动，这些路径自然与 HEAD 不同（不然撤的是什么）—— 真正要
     验的是「索引和工作区一起回去」：两者一致（git diff 为空），状态行是有的。 */
  ok('revert-paths（真仓库）：索引和工作区一起回去（两者一致，不再有暂存/未暂存的分裂）',
    (await sh('git diff --stat', R)).out.trim() === ''
    && (await sh('git status --porcelain', R)).out.trim().length > 0)
  ok('revert-paths（真仓库）：命令页记的是 git apply -R --whitespace=nowarn（补丁走 stdin）',
    calls.length === 2 && calls[1].command.indexOf("git 'apply' '-R' '--index' '--whitespace=nowarn'") >= 0
    && typeof calls[1].stdin === 'string' && calls[1].stdin.indexOf('diff --git') === 0)

  /* 场景二：本地又改了这些路径（未暂存），还原 tweak —— 反向补丁的上下文对不上，
     --3way 也会因为「工作区与索引不一致」拒绝；两次都是 git 自己的原话，答复
     如实 ok:false。这不是缺陷，是同一份确认下的诚实答案：本地改过的路径该用
     「从修订中获取」整版覆盖，或先处理本地改动。 */
  await sh(`printf 'a2\\n' > a.txt`, R)
  calls.length = 0
  const edited = await H('git/revert-paths')({ repo: R, ref: head, paths: ['a.txt'] })
  ok('revert-paths（真仓库）：本地有未暂存改动时如实失败，git 的原话带回',
    edited.ok !== true && edited.threeWay === true
    && String(edited.stderr).indexOf('a.txt') >= 0 && calls.length === 3
    && calls[2].command.indexOf("'--3way'") >= 0)

  await sh(`printf 'a3\\n' > a.txt`, R)
  const gotBack = await H('git/get-from-rev')({ repo: R, ref: head, paths: ['a.txt'] })
  /* head 是 tweak，它里面 a.txt 的内容是 a0 —— 从修订中获取取的就是这一版。 */
  ok('get-from-rev（真仓库）：工作区回到修订里的内容', gotBack.ok === true && (await sh('cat a.txt', R)).out.trim() === 'a0')

  await sh(`mkdir -p junk && printf 'j\\n' > junk/j.txt && printf 'n\\n' > new.txt`, R)
  const cleaned = await H('git/clean-paths')({ repo: R, paths: ['junk', 'new.txt'] })
  ok('clean-paths（真仓库）：未跟踪的目录和文件都没了',
    cleaned.ok === true && (await sh('test ! -e junk && test ! -e new.txt && echo gone', R)).out.trim() === 'gone')
  ok('clean-paths（真仓库）：已跟踪的 a.txt 不受影响', (await sh('cat a.txt', R)).out.trim() === 'a0')
}

console.log('')
if (failed > 0) {
  console.error('gp59-filemenu: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
console.log('gp59-filemenu: all checks passed')
