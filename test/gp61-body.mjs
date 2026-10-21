/* ═══ gp61：worktree 主目录的客户端三处挂点（56-setup / 25-worktree / 24-repos / 20-prefs）═══
 *
 * 宿主半侧在 gp61-host-test.mjs（真 git 夹具的 kind 全谱系与 saveWorktreeMain）；
 * 这里用罐头答复钉浏览器这一半：
 *   1. 25-worktree.js 的「主目录」行（props.wtMain，面板级 git/wt-main 读数）：
 *      kind 是 linked / broken-gitlink 才出现；linked 时短名+来源小字、tooltip 带
 *      全路径与 kind 含义、行尾「打开主目录」（onOpenMain(mainDir)，与仓库行单击
 *      同一条 repoSingle 路）与「配置…」（onConfigure → 配置页且编辑目标对到生效
 *      仓库）；mainDir 配不上时只剩「配置…」且行带 dsh-git-wt-gone；mainSource=
 *      'config' 说「手动配置」、mainOk=false 说「目录不在了」；wtMain 为空 /
 *      ok:false / kind=main 时整行不出现；类名 dsh-git-wt-mainrow 不进
 *      dsh-git-wt-row 的个数账（25-worktree.js 顶部注释的既有断言口径）。
 *   2. 56-setup.js 的 WorktreeMainSetup（说明页）：not-a-repo 那一页挂载时对
 *      initial 发一次 git/wt-main；linked 渲染身份说明与找到的主目录行，「打开这个
 *      目录」= props.onOpen(mainDir)；broken-gitlink 说「主仓库那头读不到」；保存走
 *      git/wt-main-save（add）且成功显示手动配置来源，失败沿用 repoSaveProblem 的
 *      话术；清除走 remove:true 且只在配置过之后出现；kind=main / 读失败整块安静。
 *   3. 24-repos.js 的 wt 小标：links 里的仓库行挂 dsh-git-repo-wt（title 说明
 *      .git 是链接文件），missing 行不挂；Host 旧版答复缺 links 字段时不炸、不挂标。
 *   4. 20-prefs.js：整份插件配置归一化原样搬运 worktreeMains —— 全局配置页改一个
 *      开关触发的整份保存（400ms 去抖）必须把 Host 给的 worktreeMains 一字不改地
 *      送回 git/config-save（草稿同批对照，老的先例不许被这次改动打破）。 */

/* ── mock：git/wt-main 罐头按场景换（wt61），save 答复按请求现做 ── */
const LINKED61 = {
  ok: true, repo: '/tmp/ws', kind: 'linked',
  gitlink: 'gitdir: /tmp/main61/.git/worktrees/ws',
  gitdir: '/tmp/main61/.git/worktrees/ws', commonDir: '/tmp/main61/.git', toplevel: '/tmp/ws',
  mainDir: '/tmp/main61', mainSource: 'auto', configured: null, mainOk: true,
  worktrees: [], gitMissing: false, stderr: '',
}
const WT61 = {
  ok: true, repo: '/tmp/ws',
  worktrees: [
    { path: '/tmp/lab/wt one', head: 'aaa', branch: 'main', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
    { path: '/tmp/lab/wt two', head: 'bbb', branch: 'solo', detached: false, bare: false, locked: false, lockReason: '', prunable: false, pruneReason: '' },
  ],
}
const REPOS61 = {
  ok: true, workspace: '/tmp/ws',
  repos: ['/tmp/ws/alpha', '/tmp/ws/beta', '/tmp/ws/wtone'],
  manual: ['/tmp/ws/beta'], missing: ['/tmp/ws/gone'],
  links: ['/tmp/ws/wtone'], truncated: false,
}
const CONFIG61 = {
  ok: true, path: '/home/u/.dsh/dsh-git-idea.json',
  config: { initBranch: 'main', cherryPickRecord: false, worktreeMains: { '/tmp/wt61': '/tmp/main61' }, drafts: { '/tmp/ws': '写到一半' } },
}
const PROJECT61 = function (repo) {
  return { ok: true, repo: repo, insideRepo: true, config: {
    'user.name': { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' },
    'user.email': { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' },
    'core.autocrlf': { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' },
    'core.safecrlf': { local: '', global: '', effective: '', localOrigin: '', globalOrigin: '', effectiveOrigin: '' },
  } }
}
const SETUP61 = { ok: false, repo: '/tmp/wt-broken', error: 'not-a-repository', reason: 'not-a-repo', stderr: '', staged: [], unstaged: [], untracked: [], unmerged: [] }
const OK61 = function (repo) {
  return { ok: true, repo: repo || '/tmp/ws', branch: 'main', detached: false, upstream: '', ahead: 0, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] }
}

let wt61 = LINKED61 /* git/wt-main 的下一份答复（对象） */
let setupMode61 = false /* true = git/panel 对缺省请求答 not-a-repo（说明页场景） */
const wtCalls61 = []
const wtSaveCalls61 = []
const saveArgs61 = []
const realCall61 = host.call
host.call = function (method, args) {
  calls.push({ method: method, args: args })
  if (method === 'git/wt-main') { wtCalls61.push(args); return Promise.resolve(wt61) }
  if (method === 'git/wt-main-save') {
    wtSaveCalls61.push(args)
    saveArgs61.push(args)
    if (wtSave61 !== null) return Promise.resolve(wtSave61)
    /* 与宿主同一条「写后回读」约定：答复就是最新一份 wt-main 读数 */
    const repo = args != null && typeof args.repo === 'string' ? args.repo : '/tmp/wt-broken'
    if (args != null && args.remove === true) {
      return Promise.resolve(Object.assign({}, LINKED61, { repo: repo, mainDir: '/tmp/main61', mainSource: 'auto', configured: null, mainOk: true }))
    }
    return Promise.resolve(Object.assign({}, LINKED61, { repo: repo, mainDir: args != null ? args.add : '', mainSource: 'config', configured: args != null ? args.add : '', mainOk: true }))
  }
  if (method === 'git/config') return Promise.resolve(CONFIG61)
  if (method === 'git/config-save') {
    const saved = args != null && args.config != null ? args.config : {}
    saveArgs61.push({ method: 'config-save', config: saved })
    return Promise.resolve({ ok: true, path: CONFIG61.path, config: saved })
  }
  if (method === 'git/repos') return Promise.resolve(repos61)
  if (method === 'git/worktrees') return Promise.resolve(WT61)
  if (method === 'git/refs') return realCall61(method, args)
  if (method === 'git/project-config') return Promise.resolve(PROJECT61(args != null ? args.repo : undefined))
  if (method === 'git/remotes') return Promise.resolve({ ok: true, repo: args != null ? args.repo : null, insideRepo: true, remotes: [] })
  if (method === 'git/panel') {
    if (args != null && typeof args.repo === 'string' && args.repo.length > 0) return Promise.resolve(OK61(args.repo))
    if (setupMode61 === true) return Promise.resolve(SETUP61)
    return Promise.resolve(OK61(undefined))
  }
  return realCall61(method, args)
}
let wtSave61 = null /* 设了就原样答（ok:false 的固定答复用） */
let repos61 = REPOS61

/* ── 取景工具 ── */
const hasClass61 = (n, s) => n.props != null && typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(s) >= 0
const mainrow61 = (t) => byClass(t, 'dsh-git-wt-mainrow')[0]
const wtRows61 = (t) => byClass(t, 'dsh-git-wt-row')
const wtBox61 = (t) => byClass(t, 'dsh-git-wt-box')[0]
const buttonsWith61 = (t, label) => buttons(t).filter((b) => textOf(b) === label)
const setupSub61 = (t) => byClass(t, 'dsh-git-setup-sub')[0]
const setupPath61 = (t) => byClass(t, 'dsh-git-wtmain-path')[0]
const rowByKey61 = (t, key) => byClass(t, 'dsh-git-repo-row').find((r) => String(r.props.key) === key)
const badge61 = (row) => byClass(row, 'dsh-git-repo-wt')[0]
const fireTimers61 = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}
const saveConfig61 = function () {
  for (let i = saveArgs61.length - 1; i >= 0; i -= 1) {
    if (saveArgs61[i] != null && saveArgs61[i].method === 'config-save') return saveArgs61[i].config
  }
  return undefined
}
/* 换场景 = 清掉 fiber 再换会话挂（openConfig 的同一条老规矩） */
const pop61 = (sid) => renderUntilStable(makeElement(popover, { sessionId: sid }), sid)
async function settle61(sid) { let t = null; for (let i = 0; i < 4; i += 1) { t = await pop61(sid); await wait(10) } return t }

/* 面板得先「开」一次：everOpened 是模块级的，此后直接挂 popover 就是就绪态。 */
fibers.clear()
let chipT = await renderUntilStable(makeElement(chip, { sessionId: 's-61z' }), 'chip-61z')
if (chipT.props.className.indexOf('dsh-git-chip-open') < 0) { chipT.props.onClick(); await wait(10) }

console.log('')
console.log('== 25-worktree 主目录行：linked 的长相与两个动作 ==')
fibers.clear()
const markWt61 = wtCalls61.length
let tree = await settle61('s-61a')
ok('面板对生效仓库发了一次 git/wt-main，单仓库请求只带会话不带 repo',
  wtCalls61.length === markWt61 + 1 && wtCalls61[markWt61].sessionId === 's-61a' && wtCalls61[markWt61].repo === undefined)
ok('kind=linked：块头之下出现 dsh-git-wt-mainrow，短名 + 「自动找到」小字都在',
  mainrow61(tree) !== undefined
  && textOf(mainrow61(tree)).indexOf('main61') >= 0 && textOf(mainrow61(tree)).indexOf('自动找到') >= 0)
ok('tooltip 三件事：主目录全路径（自动找到）、kind 含义、打开主目录的手势说明',
  String(mainrow61(tree).props.title).indexOf('主目录：/tmp/main61（自动找到）') === 0
  && String(mainrow61(tree).props.title).indexOf('本目录是链接工作区') >= 0
  && String(mainrow61(tree).props.title).indexOf(LINKED61.gitlink) >= 0
  && String(mainrow61(tree).props.title).indexOf('单击「打开主目录」') >= 0)
ok('行尾两个动作都在：「打开主目录」与「配置…」',
  buttonsWith61(mainrow61(tree), '打开主目录').length === 1
  && buttonsWith61(mainrow61(tree), '配置…').length === 1)
ok('主目录行不进 wt-row 的个数账：罐头两条清单行，计数仍是 2（身份行另算）',
  wtRows61(tree).length === 2 && byClass(wtBox61(tree), 'dsh-git-wt-row').length === 2)
ok('mainOk=true：行不带 dsh-git-wt-gone',
  hasClass61(mainrow61(tree), 'dsh-git-wt-gone') === false)

console.log('')
console.log('== 25-worktree 主目录行：onConfigure / onOpenMain 的落点 ==')
const markCfg = calls.length
buttonsWith61(mainrow61(tree), '配置…')[0].props.onClick()
tree = await settle61('s-61a')
ok('「配置…」：切到配置页，且本页编辑目标对到生效仓库（git/project-config 带 repo）',
  buttons(tree).some((b) => textOf(b) === '全局配置') === true
  && calls.slice(markCfg).some((c) => c.method === 'git/project-config' && c.args != null && c.args.repo === '/tmp/ws'))
fibers.clear()
tree = await settle61('s-61b')
const markOpen = calls.length
buttonsWith61(mainrow61(tree), '打开主目录')[0].props.onClick()
tree = await settle61('s-61b')
ok('「打开主目录」：用 mainDir 走 repoSingle —— git/panel 带着主目录路径重读',
  calls.slice(markOpen).some((c) => c.method === 'git/panel' && c.args != null && c.args.repo === '/tmp/main61'))

console.log('')
console.log('== 25-worktree 主目录行：config 来源、目录不在、配不上、整行不出现 ==')
fibers.clear()
wt61 = Object.assign({}, LINKED61, { mainSource: 'config', configured: '/tmp/main61' })
tree = await settle61('s-61c')
ok('mainSource=config：小字换「手动配置」，tooltip 的括号也跟着换',
  textOf(mainrow61(tree)).indexOf('手动配置') >= 0
  && String(mainrow61(tree).props.title).indexOf('主目录：/tmp/main61（手动配置）') === 0)
fibers.clear()
wt61 = Object.assign({}, LINKED61, { mainDir: '/tmp/main61', mainOk: false })
tree = await settle61('s-61c2')
ok('mainOk=false（目录不在了）：行压暗、小字带「目录不在了」、tooltip 教读者去配置',
  hasClass61(mainrow61(tree), 'dsh-git-wt-gone') === true
  && textOf(mainrow61(tree)).indexOf('目录不在了') >= 0
  && String(mainrow61(tree).props.title).indexOf('这个主目录现在不存在') >= 0)
fibers.clear()
wt61 = { ok: true, repo: '/tmp/ws', kind: 'broken-gitlink', gitlink: 'gitdir: /tmp/gone61/.git/modules/sub', gitdir: '', commonDir: '', toplevel: '', mainDir: null, mainSource: null, configured: null, mainOk: false, worktrees: [], gitMissing: false, stderr: '' }
tree = await settle61('s-61d')
ok('mainDir 配不上（broken-gitlink）：行在、压暗、说「主目录读不到」，只剩「配置…」一个动作',
  mainrow61(tree) !== undefined && hasClass61(mainrow61(tree), 'dsh-git-wt-gone') === true
  && textOf(mainrow61(tree)).indexOf('主目录读不到') >= 0
  && buttonsWith61(mainrow61(tree), '打开主目录').length === 0
  && buttonsWith61(mainrow61(tree), '配置…').length === 1
  && String(mainrow61(tree).props.title).indexOf('主仓库那头读不到') >= 0)
fibers.clear()
wt61 = Object.assign({}, LINKED61, { kind: 'main', mainDir: '/tmp/ws' })
tree = await settle61('s-61e')
ok('kind=main（普通仓库）：整行不出现', mainrow61(tree) === undefined)
fibers.clear()
wt61 = Object.assign({}, LINKED61, { kind: 'plain' })
tree = await settle61('s-61e2')
ok('kind=plain：整行不出现', mainrow61(tree) === undefined)
fibers.clear()
wt61 = { ok: false, repo: '/tmp/ws', error: 'unavailable' }
tree = await settle61('s-61e3')
ok('读失败（ok:false）：整行不出现，worktree 块照常', mainrow61(tree) === undefined && wtBox61(tree) !== undefined)
fibers.clear()
wt61 = null
tree = await settle61('s-61e4')
ok('还没读到（null）：整行不出现，不占位', mainrow61(tree) === undefined)
wt61 = LINKED61

console.log('')
console.log('== 24-repos wt 小标：links 里的行挂、missing 行不挂、旧版没这字段也不炸 ==')
fibers.clear()
tree = await settle61('s-61f')
const linkRow = rowByKey61(tree, 'repo:/tmp/ws/wtone')
const plainRow = rowByKey61(tree, 'repo:/tmp/ws/alpha')
const goneRow = rowByKey61(tree, 'gone:/tmp/ws/gone')
ok('links 里的仓库行：名字旁一枚暗色「wt」小标，行 title 说明 .git 是链接文件',
  linkRow !== undefined && badge61(linkRow) !== undefined && textOf(badge61(linkRow)) === 'wt'
  && String(badge61(linkRow).props.title).indexOf('.git 是链接文件') >= 0
  && String(linkRow.props.title).indexOf('.git 是链接文件（git worktree 或子模块）') >= 0)
ok('普通仓库行与 missing 行都不挂',
  badge61(plainRow) === undefined && goneRow !== undefined && badge61(goneRow) === undefined)
fibers.clear()
repos61 = { ok: true, workspace: '/tmp/ws', repos: REPOS61.repos, manual: REPOS61.manual, missing: REPOS61.missing, truncated: false }
tree = await settle61('s-61f2')
ok('Host 旧版答复缺 links 字段：不炸、一个标都不挂（照旧清单照旧行）',
  mainrow61 !== undefined && tree !== null
  && rowByKey61(tree, 'repo:/tmp/ws/wtone') !== undefined
  && byClass(tree, 'dsh-git-repo-wt').length === 0)
repos61 = REPOS61

console.log('')
console.log('== 56-setup WorktreeMainSetup：说明页上的身份块（linked）==')
fibers.clear()
setupMode61 = true
const markSetupWt = wtCalls61.length
tree = await settle61('s-61g')
ok('not-a-repo 的说明页：WorktreeMainSetup 对 initial 发了一次 git/wt-main（带 repo 与会话）',
  wtCalls61.length === markSetupWt + 1
  && wtCalls61[wtCalls61.length - 1].repo === '/tmp/wt-broken'
  && wtCalls61[wtCalls61.length - 1].sessionId === 's-61g')
ok('linked：身份块出现，标题与身份说明都在（gitlink 原文进提示）',
  setupSub61(tree) !== undefined
  && byClass(tree, 'dsh-git-setup-h').some((n) => textOf(n) === '这是一个 worktree（链接工作区）')
  && textOf(setupSub61(tree)).indexOf(LINKED61.gitlink) >= 0)
ok('找到的主目录行：路径全量上屏，「打开这个目录」在',
  setupPath61(tree) !== undefined && textOf(setupPath61(tree)) === '/tmp/main61'
  && buttonsWith61(setupSub61(tree), '打开这个目录').length === 1)
const markSetupOpen = calls.length
/* 说明页自己也有一个「打开这个目录」（对路径框里的值）；worktree 块的那一个要在
   dsh-git-setup-sub 里找，点错了点中的是 RepoSetup 的（对 initial 原地重读）。 */
buttonsWith61(setupSub61(tree), '打开这个目录')[0].props.onClick()
tree = await settle61('s-61g')
ok('「打开这个目录」= props.onOpen(mainDir)：git/panel 带主目录重读，说明页随之退场',
  calls.slice(markSetupOpen).some((c) => c.method === 'git/panel' && c.args != null && c.args.repo === '/tmp/main61')
  && setupSub61(tree) === undefined)

console.log('')
console.log('== 56-setup WorktreeMainSetup：保存 / 失败话术 / 清除 ==')
fibers.clear()
setupMode61 = true
tree = await settle61('s-61h')
const draftInput = collect(setupSub61(tree)).find((n) => n.type === 'input' && String(n.props.placeholder) === '主仓库目录的绝对路径')
ok('配置主目录输入行在，草稿预填自动找到的主目录',
  draftInput !== undefined && draftInput.props.value === '/tmp/main61')
draftInput.props.onChange({ target: { value: '/tmp/new-main61' } })
tree = await settle61('s-61h')
const markSave = wtSaveCalls61.length
buttonsWith61(tree, '保存')[0].props.onClick()
tree = await settle61('s-61h')
ok('保存走 git/wt-main-save：repo=说明页这个目录、add=输入框里的绝对路径、会话带上',
  wtSaveCalls61.length === markSave + 1 && wtSaveCalls61[markSave].repo === '/tmp/wt-broken'
  && wtSaveCalls61[markSave].add === '/tmp/new-main61' && wtSaveCalls61[markSave].sessionId === 's-61h')
ok('成功答复回填读数：提示「已配置主目录（手动配置）」+ 新路径，「清除配置」随之出现',
  textOf(setupSub61(tree)).indexOf('已配置主目录（手动配置）：/tmp/new-main61') >= 0
  && buttonsWith61(tree, '清除配置').length === 1)
const markClear = wtSaveCalls61.length
buttonsWith61(tree, '清除配置')[0].props.onClick()
tree = await settle61('s-61h')
ok('清除走 remove:true，提示主目录回到自动识别',
  wtSaveCalls61.length === markClear + 1 && wtSaveCalls61[markClear].repo === '/tmp/wt-broken'
  && wtSaveCalls61[markClear].remove === true && wtSaveCalls61[markClear].add === undefined
  && textOf(setupSub61(tree)).indexOf('已清除配置：主目录回到自动识别') >= 0)

fibers.clear()
wtSave61 = { ok: false, error: 'not-a-repository' }
tree = await settle61('s-61i')
const failInput = collect(setupSub61(tree)).find((n) => n.type === 'input' && String(n.props.placeholder) === '主仓库目录的绝对路径')
failInput.props.onChange({ target: { value: '/tmp/wrong61' } })
tree = await settle61('s-61i')
buttonsWith61(tree, '保存')[0].props.onClick()
tree = await settle61('s-61i')
ok('保存被拒（not-a-repository）：话术沿用 repoSaveProblem 那句，路径点名读者填的',
  byClass(tree, 'dsh-git-error').some((n) => textOf(n).indexOf('这个目录不是 git 仓库') >= 0))
wtSave61 = null

console.log('')
console.log('== 56-setup WorktreeMainSetup：broken-gitlink 与整块安静 ==')
fibers.clear()
wt61 = { ok: true, repo: '/tmp/wt-broken', kind: 'broken-gitlink', gitlink: 'gitdir: /tmp/gone61/.git/worktrees/gone', gitdir: '', commonDir: '', toplevel: '', mainDir: null, mainSource: null, configured: null, mainOk: false, worktrees: [], gitMissing: false, stderr: '' }
tree = await settle61('s-61j')
ok('broken-gitlink：身份块说「主仓库那头读不到」，label 换「找到的主目录」，读不到时块里不给「打开这个目录」',
  setupSub61(tree) !== undefined
  && textOf(setupSub61(tree)).indexOf('指向的主仓库读不到') >= 0
  && textOf(setupSub61(tree)).indexOf('找到的主目录') >= 0
  && textOf(setupSub61(tree)).indexOf('读不到：gitlink 配不上一个存在的目录') >= 0
  && buttonsWith61(setupSub61(tree), '打开这个目录').length === 0)
fibers.clear()
wt61 = Object.assign({}, LINKED61, { kind: 'main', mainDir: '/tmp/wt-broken' })
tree = await settle61('s-61k')
ok('kind=main：整块不出现（普通仓库没有主目录可配）', setupSub61(tree) === undefined)
fibers.clear()
wt61 = null
tree = await settle61('s-61k2')
ok('读失败静默（snap=null）：整块不出现，也不把说明页主流程顶掉',
  setupSub61(tree) === undefined && byClass(tree, 'dsh-git-setup').length > 0)
wt61 = LINKED61
setupMode61 = false

console.log('')
console.log('== 20-prefs：整份归一化把 worktreeMains 原样送回（全局配置页的一次整份保存）==')
fibers.clear()
tree = await openConfig('global', 'cfg-61')
ok('全局配置页开了，插件配置分组在（loadPluginConfig 走的是 mock 的 git/config）',
  byClass(tree, 'dsh-git-global').length > 0)
const cherryRow = collect(tree).find((n) => n.type === 'label' && textOf(n).indexOf('cherry-pick 时记录来源') >= 0)
const flip = cherryRow !== undefined ? collect(cherryRow).find((n) => n.type === 'input' && n.props.type === 'checkbox') : undefined
ok('插件行为的开关找到了（cherry-pick 记录来源，初值来自 mock 配置的 false）',
  flip !== undefined && flip.props.checked === false)
flip.props.onChange({ target: { checked: true } })
await wait(10)
fireTimers61(400)
await wait(10)
const savedOnce = saveConfig61()
ok('开关触发的整份保存：worktreeMains 一字不改地送回（这正是「手工主目录不再被抹」的口子）',
  savedOnce != null && JSON.stringify(savedOnce.worktreeMains) === JSON.stringify({ '/tmp/wt61': '/tmp/main61' }))
ok('同一次保存里草稿也还在（既有先例不回归），开关的值真的翻了',
  savedOnce.drafts != null && savedOnce.drafts['/tmp/ws'] === '写到一半'
  && savedOnce.cherryPickRecord === true)
const cherryRowAgain = collect(tree).find((n) => n.type === 'label' && textOf(n).indexOf('cherry-pick 时记录来源') >= 0)
const flipAgain = cherryRowAgain !== undefined ? collect(cherryRowAgain).find((n) => n.type === 'input' && n.props.type === 'checkbox') : undefined
flipAgain.props.onChange({ target: { checked: false } })
await wait(10)
fireTimers61(400)
await wait(10)
const savedTwice = saveConfig61()
ok('答复 adopt 后再存一次：worktreeMains 仍在（写盘→回读→再写的闭环不丢它）',
  savedTwice != null && JSON.stringify(savedTwice.worktreeMains) === JSON.stringify({ '/tmp/wt61': '/tmp/main61' }))
