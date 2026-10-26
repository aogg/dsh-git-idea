/* ═══ gp74：分支按钮两层 localStorage 垫底账（客户端这一半）═══
 *
 * a239bbc 落了「chip 分支名 + 分支列表」的 localStorage 垫底层（62-branchstate.js
 * 的 chip-labels / branch-lists 两个键）。这里把它的行为契约钉在 node 模拟上：
 *
 *   A 层（dsh.git-idea.chip-labels，{[sessionId]:{label,repo,ahead,behind,at}}）：
 *   1. 写入唯一入口是 apply 的 ok===true → storedChipLabelPut（label/repo/ahead/behind 齐）；
 *   2. 刷新后 chipLabelFor 内存无格回落盘账：phase 'repo'、label 命中、pending 恒 0；
 *   3. apply 的 ok!==true → storedChipLabelDrop，该会话条目从盘账删除（不许还魂）；
 *   4. 读入逐条清洗：label 空 / 非对象等畸形条目被丢弃，不喂给画；
 *   5. LRU 50：先删再插队尾，队首（最久未用）淘汰；
 *   6. localStorage 拒绝（store 拿不到 / 读写抛异常）：只留内存、不崩、行为与没有这层一致。
 *
 *   B 层（dsh.git-idea.branch-lists，{[repo]:{data,at}}）：
 *   7. rememberBranches 落盘；BranchPicker 首帧 useState 内存无账回落 restoreBranches
 *      命中画列表；restoreBranches 纯读绝不写回 branchCache —— 盘账存在时
 *      prefetchBranches 仍发 git/branches（守卫只认内存新账）；
 *   8. 快读照发：盘账命中不省挂载 git/panel quick 读。
 *
 * 「刷新页面」的模拟沿用 gp50 的先例：用同一份 fakeDoc/localStorage 把 CLIENT_SRC
 * **再求值一遍** —— 模块内存（chipLabels / branchCache / 已懒加载的盘账映射）全部
 * 归零，store 这份盘账原样还在，正是刷新的语义。每节一个全新实例（evalInstance74），
 * 盘账按节铺好或清空；账本检查直接读 harness 的 store。 */

const A_KEY74 = 'dsh.git-idea.chip-labels'
const B_KEY74 = 'dsh.git-idea.branch-lists'
const OK74 = OK_PANEL
const NOT_A_REPO74 = { ok: false, reason: 'not-a-repo', repo: '/tmp/ws' }
const CLIENT74 = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')

/* 再求值一遍 CLIENT_SRC = 一次「刷新」：模块内存全新，localStorage（store）原样。
 * override(method, args) 回一个 Promise 就把这个读扣下（首帧断言的冻结探针），
 * 回 null 就放行给 harness 的 host 桩。 */
function evalInstance74(override) {
  const registered74 = []
  const slots74 = { inject: (k, cb) => cb(), register: (o, c) => { registered74.push({ options: o, component: c }); return () => {} } }
  const ctx74 = {
    get(n) {
      if (n === 'slots') return slots74
      if (n === 'timer') return ctx.get('timer')
      return undefined
    },
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
  }
  const calls74 = []
  const host74 = {
    call(method, args) {
      calls74.push({ method: method, args: args })
      const held = override !== undefined ? override(method, args) : null
      return held != null ? held : host.call(method, args)
    },
  }
  new Function('ctx', 'React', 'host', 'styles', 'console', CLIENT74)(
    ctx74, React, host74, { insert: () => () => {} }, console).apply(ctx74)
  return {
    calls: calls74,
    chip: registered74.find((r) => r.options.id === 'dsh-git-idea-chip').component,
    popover: registered74.find((r) => r.options.id === 'dsh-git-idea-panel').component,
  }
}

const readAccount74 = function (key) {
  try { const raw = store[key]; return raw == null ? null : JSON.parse(raw) } catch (error) { return null }
}
const labelEntry74 = function (label, repo, ahead, behind) {
  return { label: label, repo: repo, ahead: ahead, behind: behind, at: 1700000000000 }
}
const chipTree74 = (inst, sessionId, label) => renderUntilStable(makeElement(inst.chip, { sessionId: sessionId }), label)
const panelTree74 = async function (inst, sessionId, label) {
  let tree = null
  for (let i = 0; i < 4; i += 1) {
    tree = await renderUntilStable(makeElement(inst.popover, { sessionId: sessionId, active: true, ready: true }), label)
    await wait(10)
  }
  return tree
}
/* 把 git/panel 扣成欠账的实例：首帧断言期间快读永远回不来，屏上那份只能是盘账。 */
const holdPanel74 = function () {
  const held = []
  const inst = evalInstance74(function (method, args) {
    if (method === 'git/panel') {
      let settleReply = null
      const p = new Promise(function (resolve) { settleReply = resolve })
      held.push({ sessionId: args != null ? args.sessionId : undefined, resolve: settleReply })
      return p
    }
    return null
  })
  inst.held = held
  return inst
}
const release74 = function (held, replyFor) {
  for (const one of held.splice(0)) one.resolve(replyFor(one.sessionId))
}

console.log('')
console.log('=== 1｜A 层写入：快读 ok 答复经 apply 落盘（唯一写入点）===')
delete store[A_KEY74]
delete store[B_KEY74]
fibers.clear()
let tree74 = await chipTree74({ chip: chip }, 's-74a', 'chip-74a')
await wait(30)
tree74 = await chipTree74({ chip: chip }, 's-74a', 'chip-74a')
const put74 = readAccount74(A_KEY74)
ok('快读 ok（branch=main, /tmp/ws, ↑2 ↓1）→ 盘账出现该会话条目，label/repo/ahead/behind/at 一样不缺',
  put74 !== null && put74['s-74a'] !== undefined
  && put74['s-74a'].label === 'main' && put74['s-74a'].repo === '/tmp/ws'
  && put74['s-74a'].ahead === 2 && put74['s-74a'].behind === 1
  && typeof put74['s-74a'].at === 'number' && isFinite(put74['s-74a'].at))
const bPut74 = readAccount74(B_KEY74)
ok('同一次 apply 的预取让 rememberBranches 落盘：/tmp/ws 的分支列表（ok 答复原样）进了 B 层',
  bPut74 !== null && bPut74['/tmp/ws'] !== undefined
  && bPut74['/tmp/ws'].data != null && bPut74['/tmp/ws'].data.ok === true
  && Array.isArray(bPut74['/tmp/ws'].data.branches) && bPut74['/tmp/ws'].data.branches.length === 4)
ok('屏上那一份照旧来自新答复（chip 画上 main）',
  byClass(tree74, 'dsh-git-chip-label').length === 1 && textOf(byClass(tree74, 'dsh-git-chip-label')[0]) === 'main')

console.log('')
console.log('=== 2｜刷新模拟：内存无格回落盘账（phase repo / label 命中 / pending 恒 0）===')
delete store[A_KEY74]
store[A_KEY74] = JSON.stringify({ 's-74r': labelEntry74('refreshed-branch', '/tmp/ws', 2, 1) })
fibers.clear()
const inst74r = holdPanel74()
let tree74r = await chipTree74(inst74r, 's-74r', 'chip-74r')
const labels74r = byClass(tree74r, 'dsh-git-chip-label')
const nums74r = byClass(tree74r, 'dsh-git-chip-n').map(textOf)
ok('快读扣着没回，首帧已画上盘账的分支名：phase repo（chip-repo 类）、label 命中、↑2 ↓1 也从盘账来',
  String(tree74r.props.className).indexOf('dsh-git-chip-repo') >= 0
  && labels74r.length === 1 && textOf(labels74r[0]) === 'refreshed-branch'
  && nums74r.indexOf('2') >= 0 && nums74r.indexOf('1') >= 0)
ok('pending 恒 0：改动数不从盘账画（没有 badge，标题如实说「正在核对改动」）',
  byClass(tree74r, 'dsh-git-badge').length === 0
  && String(tree74r.props.title).indexOf('正在核对改动') >= 0)
ok('盘账命中不省快读：挂载的 git/panel quick 照发（还扣在手里没回）',
  inst74r.calls.some((c) => c.method === 'git/panel' && c.args != null && c.args.quick === true && c.args.sessionId === 's-74r'))
release74(inst74r.held, () => OK74)
await wait(20)

console.log('')
console.log('=== 3｜A 层失效：ok!==true → 该会话条目从盘账删除（不许还魂）===')
delete store[A_KEY74]
store[A_KEY74] = JSON.stringify({
  's-74c': labelEntry74('old-branch', '/tmp/ws', 0, 0),
  'canary': labelEntry74('canary-b', '/canary/ws', 0, 0),
})
fibers.clear()
const inst74c = evalInstance74(function (method) {
  return method === 'git/panel' ? Promise.resolve(NOT_A_REPO74) : null
})
const tree74c = await chipTree74(inst74c, 's-74c', 'chip-74c')
await wait(30)
const dropped74 = readAccount74(A_KEY74)
ok('not-a-repo 答复 → s-74c 的盘账条目被删（canary 原样还在），屏上如实落回「不是 Git 仓库」',
  dropped74 !== null && !('s-74c' in dropped74) && 'canary' in dropped74
  && String(tree74c.props.className).indexOf('dsh-git-chip-idle') >= 0
  && String(tree74c.props.title).indexOf('不是 Git 仓库') >= 0)

console.log('')
console.log('=== 4｜读入清洗：畸形条目被丢弃，不喂给画，也不在重写时复活 ===')
delete store[A_KEY74]
delete store[B_KEY74]
store[A_KEY74] = JSON.stringify({
  '': labelEntry74('empty-key', '/tmp/ws', 0, 0),
  's-74m1': { label: '', repo: '/tmp/ws', ahead: 0, behind: 0, at: 1 },
  's-74m2': 'not-an-object',
  's-74m3': { label: 'no-repo', ahead: 0, behind: 0, at: 3 },
  's-74good': labelEntry74('good-branch', '/tmp/ws', 3, 4),
})
store[B_KEY74] = JSON.stringify({
  'r-bad1': { data: { ok: false, branches: [] }, at: 1 },
  'r-bad2': { data: 'nope', at: 2 },
  'r-bad3': 'plain-string',
  '/good/ws': { data: { ok: true, branches: [{ name: 'k' }], remotes: [] }, at: 3 },
})
fibers.clear()
const inst74m = holdPanel74()
let tree74g = await chipTree74(inst74m, 's-74good', 'chip-74good')
ok('好条目照常垫底：好会话首帧画上盘账的 good-branch',
  byClass(tree74g, 'dsh-git-chip-label').length === 1 && textOf(byClass(tree74g, 'dsh-git-chip-label')[0]) === 'good-branch')
fibers.clear()
const tree74m = await chipTree74(inst74m, 's-74m1', 'chip-74m1')
ok('畸形条目不喂给画：label 为空的会话首帧没有 label span（回落 loading，不冒充分支名）',
  byClass(tree74m, 'dsh-git-chip-label').length === 0
  && String(tree74m.props.className).indexOf('dsh-git-chip-repo') < 0)
release74(inst74m.held, (sid) => (sid === 's-74m1' ? NOT_A_REPO74 : OK74))
await wait(30)
const cleanA74 = readAccount74(A_KEY74)
ok('重写落盘后畸形条目全部消失（空键 / 空 label / 非对象 / 缺 repo），好条目还在',
  cleanA74 !== null && cleanA74['s-74good'] !== undefined
  && !('' in cleanA74) && !('s-74m1' in cleanA74) && !('s-74m2' in cleanA74) && !('s-74m3' in cleanA74))
const cleanB74 = readAccount74(B_KEY74)
ok('B 层同样清洗：data.ok!==true / data 非对象 / 整条非对象的都丢弃，好仓库保留',
  cleanB74 !== null && cleanB74['/good/ws'] !== undefined && cleanB74['/tmp/ws'] !== undefined
  && !('r-bad1' in cleanB74) && !('r-bad2' in cleanB74) && !('r-bad3' in cleanB74))

console.log('')
console.log('=== 5｜LRU：A 层 50、B 层 20，队首（最久未用）先让位 ===')
delete store[A_KEY74]
delete store[B_KEY74]
const fifty74 = {}
for (let i = 0; i < 50; i += 1) fifty74['k-' + (i < 10 ? '0' + i : String(i))] = labelEntry74('b-' + String(i), '/r-' + String(i), 0, 0)
store[A_KEY74] = JSON.stringify(fifty74)
fibers.clear()
const inst74l = evalInstance74()
await chipTree74(inst74l, 's-74lru', 'chip-74lru')
await wait(30)
const lruA74 = readAccount74(A_KEY74)
ok('A 层写满 50 再写：恰好 50 条，队首 k-00 淘汰，k-01 / k-49 与新会话都在',
  lruA74 !== null && Object.keys(lruA74).length === 50
  && !('k-00' in lruA74) && ('k-01' in lruA74) && ('k-49' in lruA74) && lruA74['s-74lru'] !== undefined)
const twenty74 = {}
for (let i = 0; i < 20; i += 1) twenty74['r-' + (i < 10 ? '0' + i : String(i))] = { data: { ok: true, branches: [], remotes: [] }, at: i }
store[B_KEY74] = JSON.stringify(twenty74)
fibers.clear()
const inst74b = evalInstance74()
await chipTree74(inst74b, 's-74blru', 'chip-74blru')
await wait(30)
const lruB74 = readAccount74(B_KEY74)
ok('B 层写满 20 再写：恰好 20 个仓库，队首 r-00 淘汰，r-19 与 /tmp/ws 都在',
  lruB74 !== null && Object.keys(lruB74).length === 20
  && !('r-00' in lruB74) && ('r-19' in lruB74) && lruB74['/tmp/ws'] !== undefined)

console.log('')
console.log('=== 6｜localStorage 拒绝：只留内存、不崩、行为与没有这层一致 ===')
const savedView74 = fakeDoc.defaultView
delete store[A_KEY74]
store[A_KEY74] = JSON.stringify({
  's-74ns': labelEntry74('should-not-restore', '/tmp/ws', 0, 0),
  'canary': labelEntry74('canary-c', '/canary/ws', 0, 0),
})
const seedNs74 = store[A_KEY74]
fibers.clear()
fakeDoc.defaultView = undefined
const inst74ns = holdPanel74()
let tree74ns = await chipTree74(inst74ns, 's-74ns', 'chip-74ns')
ok('store 拿不到：不崩、盘账读不出（不还魂）、快读照发 —— 与没有这层时一字不差',
  store[A_KEY74] === seedNs74
  && byClass(tree74ns, 'dsh-git-chip-label').length === 0
  && inst74ns.calls.some((c) => c.method === 'git/panel' && c.args != null && c.args.quick === true))
release74(inst74ns.held, () => OK74)
await wait(20)
tree74ns = await chipTree74(inst74ns, 's-74ns', 'chip-74ns')
ok('store 拿不到：新答复照常落内存、照常上屏，盘上那份一个字节没动',
  store[A_KEY74] === seedNs74
  && byClass(tree74ns, 'dsh-git-chip-label').length === 1
  && textOf(byClass(tree74ns, 'dsh-git-chip-label')[0]) === 'main')
fakeDoc.defaultView = {
  localStorage: {
    getItem: function () { throw new Error('denied') },
    setItem: function () { throw new Error('denied') },
  },
}
delete store[A_KEY74]
store[A_KEY74] = JSON.stringify({
  's-74th': labelEntry74('should-not-restore', '/tmp/ws', 0, 0),
  'canary': labelEntry74('canary-d', '/canary/ws', 0, 0),
})
const seedTh74 = store[A_KEY74]
fibers.clear()
const inst74th = holdPanel74()
let tree74th = await chipTree74(inst74th, 's-74th', 'chip-74th')
ok('读写都抛异常：同样不崩、不还魂、盘账原样',
  store[A_KEY74] === seedTh74
  && byClass(tree74th, 'dsh-git-chip-label').length === 0
  && inst74th.calls.some((c) => c.method === 'git/panel' && c.args != null && c.args.quick === true))
release74(inst74th.held, () => OK74)
await wait(20)
tree74th = await chipTree74(inst74th, 's-74th', 'chip-74th')
ok('读写都抛异常：新答复照常上屏（只留内存），写失败吞掉、盘上那份一个字节没动',
  store[A_KEY74] === seedTh74
  && byClass(tree74th, 'dsh-git-chip-label').length === 1
  && textOf(byClass(tree74th, 'dsh-git-chip-label')[0]) === 'main')
fakeDoc.defaultView = savedView74

console.log('')
console.log('=== 7｜B 层：restoreBranches 首帧垫底、纯读不回写、预取守卫只认内存 ===')
delete store[A_KEY74]
delete store[B_KEY74]
delete store['dsh.git-idea.applied-repos']
store[B_KEY74] = JSON.stringify({ '/tmp/ws': { data: JSON.parse(JSON.stringify(branchesReply)), at: 1700000000000 } })
store['dsh.git-idea.applied-repos'] = JSON.stringify({ 's-74sw': '/tmp/ws' })
fibers.clear()
const heldBr74 = []
const inst74sw = evalInstance74(function (method) {
  if (method === 'git/branches') {
    let settleBranch = null
    const p = new Promise(function (resolve) { settleBranch = resolve })
    heldBr74.push(settleBranch)
    return p
  }
  return null
})
let tree74sw = await chipTree74(inst74sw, 's-74sw', 'chip-74sw')
await wait(20)
const brAfterChip74 = inst74sw.calls.filter((c) => c.method === 'git/branches')
ok('盘账里有 /tmp/ws 的分支列表，chip 挂载的预取仍照发（守卫只认内存新账，restoreBranches 纯读没把它喂进 branchCache）',
  brAfterChip74.length === 1 && brAfterChip74[0].args != null && brAfterChip74[0].args.repo === '/tmp/ws'
  && heldBr74.length === 1)
let tChip74sw = tree74sw
if (String(tChip74sw.props.className).indexOf('dsh-git-chip-open') < 0) { tChip74sw.props.onClick(); await wait(10) }
tree74sw = await panelTree74(inst74sw, 's-74sw', 'pop-74sw')
const branchChipBtn74 = byClass(tree74sw, 'dsh-git-branch-chip')[0]
if (branchChipBtn74 === undefined) throw new Error('gp74: 面板头的分支 chip 没渲染出来')
branchChipBtn74.props.onClick()
await wait(10)
tree74sw = await panelTree74(inst74sw, 's-74sw', 'pop-74sw-card')
const restoredRows74 = branchRows(tree74sw)
ok('刷新后分支卡首帧就画上盘账的列表：main / solo / feature/one / remote-only 全在（git/branches 还扣着没回）',
  rowWith(tree74sw, 'main') !== undefined
  && rowWith(tree74sw, 'solo') !== undefined
  && rowWith(tree74sw, 'feature/one') !== undefined
  && rowWith(tree74sw, 'remote-only') !== undefined
  && restoredRows74.length >= 4
  && heldBr74.length >= 2)
ok('分支卡自己那次 git/branches 也照发（挂载读不省，答复一到整表盖掉垫底）',
  inst74sw.calls.filter((c) => c.method === 'git/branches').length >= 2)
for (const release of heldBr74.splice(0)) release(JSON.parse(JSON.stringify(branchesReply)))
await wait(20)
tree74sw = await panelTree74(inst74sw, 's-74sw', 'pop-74sw-fresh')
ok('新答复落地后列表照常（垫底被同形的新账覆盖，不残不闪）',
  rowWith(tree74sw, 'feature/one') !== undefined && rowWith(tree74sw, 'remote-only') !== undefined)
