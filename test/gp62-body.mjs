/* ═══ gp62：生效仓库的后端账（客户端这一半）═══
 *
 * 宿主半侧在 gp62-host-test.mjs（真 git 夹具的清洗矩阵、saveAppliedRepo 与
 * appliedRepoSnapshot）；这里用罐头答复钉浏览器这一半：
 *   1. chip 挂载发一问 git/repo-applied（10-state.js 的 ensureAppliedRepo）：每个会话只问
 *      一次 —— 同会话重挂不补问；不同会话各问各的；面板先于 / 后于 chip 到场共用同一份
 *      appliedAsked 去重（92-chip.js 与 80-panel.js 两个挂载点）。
 *   2. 收养（adoptHostRepo）：账上记着 /ws/b → sessionRepo 跟着换、watcher 重新盯上它、
 *      localStorage 快速通道落盘；空 repo 与 stale:true 安静放过；收养不回写后端
 *      （git/repo-applied-save 一次都不发）。
 *   3. rememberRepo 的回写：单击切换每次都递 git/repo-applied-save（payload 带 sessionId
 *      + repo）；同值重申第一次（收养来的值、本页第一次亲手点到 —— 说明页「打开这个
 *      目录」这条路绕开了 repoSingle 的 UI 同值短路）同值也递；重申第二次（liveRepos
 *      已立）早退不再递。
 *   4. 面板收养 effect（80-panel.js）：本页没点过 + 账不一致 → 走 applyRepo 整套重置
 *      （生效仓库换过去，读全带上新仓库）；本页亲手点过后到的账让路。
 *   5. 20-prefs.js：整份插件配置归一化原样搬运 appliedRepos —— 配置页改一个开关触发的
 *      整份保存必须把它一字不改地送回 git/config-save（drafts 老先例同批对照）。
 * localStorage 桩用 harness 的 store/fakeDoc（gp61-body 同一条）：chip 挂载把 doc 交进来，
 * 账本检查直接读 store。「后到的答复」用可扣住的答复桩模拟：扣住 → 本页先动手 → 再放行。 */

/* ── mock：git/repo-applied 罐头 + 可扣住的答复；save / config-save 记账；repos 给仓库行 ── */
const APPLIED_KEY = 'dsh.git-idea.applied-repos'
const EMPTY_APPLIED62 = { ok: true, workspace: '/ws', repo: '' }
const REPOS62 = { ok: true, workspace: '/ws', repos: ['/ws/a', '/ws/b'], manual: [], missing: [], links: [], truncated: false }
const CONFIG62 = {
  ok: true, path: '/home/u/.dsh/dsh-git-idea.json',
  config: { initBranch: 'main', cherryPickRecord: false, drafts: { '/ws/b': '写到一半' }, appliedRepos: { '/ws': '/ws/b' } },
}
const SETUP62 = { ok: false, repo: '/ws/b', error: 'not-a-repository', reason: 'not-a-repo', stderr: '', staged: [], unstaged: [], untracked: [], unmerged: [] }
const appliedCalls62 = []
const saveCalls62 = []
const configSaves62 = []
const parked62 = []
let holdApplied62 = false
let setupMode62 = false
let repos62 = REPOS62
const realCall62 = host.call
host.call = function (method, args) {
  if (method === 'git/repo-applied') {
    calls.push({ method: method, args: args })
    appliedCalls62.push(args)
    if (holdApplied62 === true) return new Promise(function (resolve) { parked62.push(resolve) })
    return Promise.resolve(EMPTY_APPLIED62)
  }
  if (method === 'git/repo-applied-save') {
    calls.push({ method: method, args: args })
    saveCalls62.push(args)
    return Promise.resolve({ ok: true, workspace: '/ws', repo: args != null && typeof args.repo === 'string' ? args.repo : '' })
  }
  if (method === 'git/repos') { calls.push({ method: method, args: args }); return Promise.resolve(repos62) }
  if (method === 'git/config') return Promise.resolve(CONFIG62)
  if (method === 'git/config-save') {
    const saved = args != null && args.config != null ? args.config : {}
    configSaves62.push(saved)
    return Promise.resolve({ ok: true, path: CONFIG62.path, config: saved })
  }
  if (method === 'git/panel' && setupMode62 === true) {
    calls.push({ method: method, args: args })
    return Promise.resolve(SETUP62)
  }
  return realCall62(method, args)
}
/* 放行扣住的答复：在途的那几问各得一份（放行后新来的问回到空罐头，不再收养） */
const releaseApplied62 = function (reply) {
  holdApplied62 = false
  const waiting = parked62.splice(0)
  for (let i = 0; i < waiting.length; i += 1) waiting[i](reply)
}

/* ── 取景工具 ── */
const watchOf62 = (mark, repo) => calls.slice(mark).filter((c) => c.method === 'git/watch' && c.args != null && c.args.repo === repo)
const panelOf62 = (mark, repo) => calls.slice(mark).filter((c) => c.method === 'git/panel' && c.args != null && c.args.repo === repo)
const flushOf62 = (mark, repo) => calls.slice(mark).filter((c) => c.method === 'git/flush' && c.args != null && c.args.repo === repo)
const account62 = function () { try { return JSON.parse(store[APPLIED_KEY]) } catch (error) { return null } }
/* 推送化之后没有定时器一拍：核对的一拍由 live-open 触发（98-register.js） */
const tickWatchers62 = function () { livePush({ kind: 'live-open' }) }
const row62 = (t, path) => byClass(t, 'dsh-git-repo-row').find((r) => String(r.props.key) === 'repo:' + path)
const buttonsWith62 = (t, label) => buttons(t).filter((b) => textOf(b) === label)
const pop62 = (sid) => renderUntilStable(makeElement(popover, { sessionId: sid }), sid)
const chip62 = (sid) => renderUntilStable(makeElement(chip, { sessionId: sid }), 'chip-' + sid)
const settle62 = async function (sid) { let t = null; for (let i = 0; i < 4; i += 1) { t = await pop62(sid); await wait(10) } return t }
const click62 = async function (tree, label) {
  const hit = buttons(tree).find((b) => textOf(b) === label)
  if (hit === undefined) throw new Error('点不到「' + label + '」')
  hit.props.onClick()
  await wait(20)
}
const fireTimers62 = function (delay) {
  const list = timers.slice()
  for (const t of list) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}
const saveConfig62 = function () { return configSaves62.length > 0 ? configSaves62[configSaves62.length - 1] : undefined }

/* 面板得先「开」一次：everOpened 是模块级的，此后直接挂 popover 就是就绪态。
   这只开场的 chip（s-62z）也把 doc 交进来、把空账读进来（不 bump）。 */
delete store[APPLIED_KEY]
fibers.clear()
let chipT62 = await chip62('s-62z')
if (chipT62.props.className.indexOf('dsh-git-chip-open') < 0) { chipT62.props.onClick(); await wait(10) }

console.log('')
console.log('== chip 挂载发一问 git/repo-applied：每会话一次，chip 与面板共用去重 ==')
fibers.clear()
const markAsked62 = appliedCalls62.length
await chip62('s-62a')
ok('chip 挂载对后端账发了一问：payload 带会话 id',
  appliedCalls62.length === markAsked62 + 1 && appliedCalls62[markAsked62].sessionId === 's-62a')
fibers.clear()
await chip62('s-62a')
ok('同会话重挂（换会话重挂的语义）：不再问第二遍（appliedAsked 去重）',
  appliedCalls62.length === markAsked62 + 1)
fibers.clear()
await chip62('s-62b')
ok('不同会话各问各的：第二问带着自己的会话 id',
  appliedCalls62.length === markAsked62 + 2 && appliedCalls62[markAsked62 + 1].sessionId === 's-62b')
fibers.clear()
await settle62('s-62b')
ok('面板后挂同会话：与 chip 共用 appliedAsked，不加问', appliedCalls62.length === markAsked62 + 2)
fibers.clear()
await settle62('s-62c')
ok('面板先于 chip 到场的兜底：没人问过的会话由面板发问',
  appliedCalls62.length === markAsked62 + 3 && appliedCalls62[markAsked62 + 2].sessionId === 's-62c')
fibers.clear()
await chip62('s-62c')
ok('chip 随后到场：同一份去重，不补问', appliedCalls62.length === markAsked62 + 3)

console.log('')
console.log('== 收养：账落地接回本页，不回写后端 ==')
fibers.clear()
holdApplied62 = true
await chip62('s-62d')
ok('扣住的答复在途（模拟「后到」）：这一问带着会话 id',
  appliedCalls62[appliedCalls62.length - 1].sessionId === 's-62d')
const markAdopt = calls.length
const markAdoptSave = saveCalls62.length
releaseApplied62({ ok: true, workspace: '/ws', repo: '/ws/b' })
await wait(20)
await chip62('s-62d') /* 收养的 bump 在这一帧里把 watcher 换过去 */
tickWatchers62()
ok('账上的 /ws/b 接回本页：sessionRepo 换了（applied 信号响过一声），watcher 重新盯上 /ws/b',
  watchOf62(markAdopt, '/ws/b').length >= 1)
ok('快速通道跟着对齐：localStorage 那格写成 /ws/b',
  account62() !== null && account62()['s-62d'] === '/ws/b')
ok('收养不回写后端：git/repo-applied-save 一次都没发', saveCalls62.length === markAdoptSave)

console.log('')
console.log('== 不套用：空 repo 与 stale:true 都安静放过 ==')
fibers.clear()
holdApplied62 = true
await chip62('s-62e')
releaseApplied62({ ok: true, workspace: '/ws', repo: '' })
await wait(20)
ok('空 repo（后端没记）：不套用 —— 盘上没有这一格',
  account62() === null || account62()['s-62e'] === undefined)
fibers.clear()
holdApplied62 = true
await chip62('s-62f')
const markStale62 = calls.length
releaseApplied62({ ok: true, workspace: '/ws', repo: '/ws/gone-f', stale: true })
await wait(20)
await chip62('s-62f')
tickWatchers62()
ok('stale:true（账上的仓库已不在）：不套用、watcher 不指向它、盘上也没这格',
  watchOf62(markStale62, '/ws/gone-f').length === 0
  && (account62() === null || account62()['s-62f'] === undefined))

console.log('')
console.log('== rememberRepo 的回写：每次单击都递 save（含同值重申第一次）==')
fibers.clear()
const markSH62 = saveCalls62.length
let tSH = await settle62('s-62h')
await click62(tSH, '变更')
tSH = await settle62('s-62h')
ok('仓库清单落地：/ws/a 与 /ws/b 两行都在',
  row62(tSH, '/ws/a') !== undefined && row62(tSH, '/ws/b') !== undefined)
row62(tSH, '/ws/a').props.onClick({})
tSH = await settle62('s-62h')
ok('单击 /ws/a：git/repo-applied-save 发出，payload 带 sessionId 与 repo',
  saveCalls62.length === markSH62 + 1 && saveCalls62[markSH62].sessionId === 's-62h'
  && saveCalls62[markSH62].repo === '/ws/a')
ok('生效仓库真的换了：● 挪到 /ws/a',
  String(row62(tSH, '/ws/a').props.className).indexOf('dsh-git-repo-cur') >= 0)
ok('同一击也走了快速通道：localStorage 那格是 /ws/a',
  account62() !== null && account62()['s-62h'] === '/ws/a')
row62(tSH, '/ws/b').props.onClick({})
tSH = await settle62('s-62h')
ok('再单击 /ws/b：又一次 save，值跟着换（每次单击都回写后端）',
  saveCalls62.length === markSH62 + 2 && saveCalls62[markSH62 + 1].sessionId === 's-62h'
  && saveCalls62[markSH62 + 1].repo === '/ws/b')

/* 同值重申：工作区不是仓库（罐头答 not-a-repo），说明页路径框预填收养来的 /ws/b；
   点「打开这个目录」= applyRepo(同值)。repoSingle 有 UI 同值短路，这条路绕开它。 */
fibers.clear()
setupMode62 = true
holdApplied62 = true
await chip62('s-62k')
releaseApplied62({ ok: true, workspace: '/ws', repo: '/ws/b' })
await wait(20)
fibers.clear()
let tK = await settle62('s-62k')
ok('说明页在：路径框预填收养来的 /ws/b，且没有 worktree 块抢那个按钮',
  byClass(tK, 'dsh-git-setup').length > 0 && buttonsWith62(tK, '打开这个目录').length === 1
  && byClass(tK, 'dsh-git-setup-path').length > 0
  && textOf(byClass(tK, 'dsh-git-setup-path')[0]) === '/ws/b')
const markK62 = saveCalls62.length
buttonsWith62(tK, '打开这个目录')[0].props.onClick()
tK = await settle62('s-62k')
ok('同值重申第一次（sessionRepo 已是 /ws/b，本页第一次亲手点到）：同值也往后端递一次',
  saveCalls62.length === markK62 + 1 && saveCalls62[markK62].sessionId === 's-62k'
  && saveCalls62[markK62].repo === '/ws/b')
buttonsWith62(tK, '打开这个目录')[0].props.onClick()
tK = await settle62('s-62k')
ok('同值重申第二次（liveRepos 已立）：早退，save 不再发', saveCalls62.length === markK62 + 1)
setupMode62 = false

console.log('')
console.log('== 面板收养 effect：没点过跟着账整套重置；点过让路 ==')
fibers.clear()
holdApplied62 = true
let tI = await settle62('s-62i')
await click62(tI, '变更')
tI = await settle62('s-62i')
ok('面板先挂好（账的答复还扣着）：两行仓库都在',
  row62(tI, '/ws/a') !== undefined && row62(tI, '/ws/b') !== undefined)
const markI62 = calls.length
const markISave62 = saveCalls62.length
releaseApplied62({ ok: true, workspace: '/ws', repo: '/ws/b' })
tI = await settle62('s-62i')
ok('没点过 + 账不一致：面板跟着账换过去（applyRepo 生效——flush 与读全带上 /ws/b）',
  flushOf62(markI62, '/ws/b').length > 0 && panelOf62(markI62, '/ws/b').length > 0)
ok('● 挪到了 /ws/b：仓库行的当前标记跟着换',
  row62(tI, '/ws/b') !== undefined
  && String(row62(tI, '/ws/b').props.className).indexOf('dsh-git-repo-cur') >= 0)
ok('这一路也不回写后端：save 没有因收养多一次', saveCalls62.length === markISave62)
ok('收养同样落了快速通道：localStorage 那格是 /ws/b',
  account62() !== null && account62()['s-62i'] === '/ws/b')

fibers.clear()
holdApplied62 = true
let tJ = await settle62('s-62j')
await click62(tJ, '变更')
tJ = await settle62('s-62j')
row62(tJ, '/ws/a').props.onClick({})
tJ = await settle62('s-62j')
ok('本页亲手点了 /ws/a：save 递了、● 在 /ws/a',
  saveCalls62.some((c) => c.sessionId === 's-62j' && c.repo === '/ws/a')
  && String(row62(tJ, '/ws/a').props.className).indexOf('dsh-git-repo-cur') >= 0)
const markJ62 = calls.length
releaseApplied62({ ok: true, workspace: '/ws', repo: '/ws/b' })
tJ = await settle62('s-62j')
ok('后到的账想让面板去 /ws/b：让路 —— 没有带 /ws/b 的读、● 没挪、盘上还是 /ws/a、save 没多',
  panelOf62(markJ62, '/ws/b').length === 0 && watchOf62(markJ62, '/ws/b').length === 0
  && String(row62(tJ, '/ws/a').props.className).indexOf('dsh-git-repo-cur') >= 0
  && account62() !== null && account62()['s-62j'] === '/ws/a'
  && saveCalls62.filter((c) => c.sessionId === 's-62j').length === 1)

console.log('')
console.log('== 20-prefs：整份归一化把 appliedRepos 原样送回（配置页一次整份保存）==')
fibers.clear()
const tCfg62 = await openConfig('global', 'cfg-62')
ok('全局配置页开了，插件配置分组在（loadPluginConfig 吃的是 mock 的 git/config）',
  byClass(tCfg62, 'dsh-git-global').length > 0)
const cherryRow62 = collect(tCfg62).find((n) => n.type === 'label' && textOf(n).indexOf('cherry-pick 时记录来源') >= 0)
const flip62 = cherryRow62 !== undefined ? collect(cherryRow62).find((n) => n.type === 'input' && n.props.type === 'checkbox') : undefined
ok('插件行为的开关找到了（cherry-pick 记录来源，初值来自 mock 配置的 false）',
  flip62 !== undefined && flip62.props.checked === false)
flip62.props.onChange({ target: { checked: true } })
await wait(10)
fireTimers62(400)
await wait(10)
const savedOnce62 = saveConfig62()
ok('开关触发的整份保存：appliedRepos 一字不改地送回（「跨浏览器的账不再被抹」的口子）',
  savedOnce62 != null && JSON.stringify(savedOnce62.appliedRepos) === JSON.stringify({ '/ws': '/ws/b' }))
ok('同一次保存里草稿也还在（既有先例不回归），开关的值真的翻了',
  savedOnce62.drafts != null && savedOnce62.drafts['/ws/b'] === '写到一半'
  && savedOnce62.cherryPickRecord === true)
