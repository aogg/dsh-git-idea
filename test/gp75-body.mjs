/* ═══ gp75：历史页左栏三列表的 localStorage 垫底账 + 内容级去重（客户端这一半）═══
 *
 * b257b50 把 62-branchstate.js 那两层手写的垫底账提炼成通用工厂
 * createStoredListLayer（63-storedlists.js），给历史页左栏的三份列表各立一层：
 *
 *   · dsh.git-idea.refs-tree   按仓库存 git/refs 的 ok 答复原样（LRU 10）；
 *   · dsh.git-idea.worktrees   按仓库存 git/worktrees 的 ok 答复原样（LRU 10）；
 *   · dsh.git-idea.repo-lists  按会话 id 存 git/repos 规范化清单（LRU 50）。
 *
 * 钉住的契约（三层同一套）：
 *   1. ok 答复落盘成 {data, at}；重求值模拟刷新后 effect 垫底命中 —— RPC 仍照发
 *      （「盘账存在不省读、新答复必到」），答复一到整个盖掉；
 *   2. 内容级去重：与现账逐字一致的答复不换内存账（useState 里还是同一个对象）、
 *      不重写盘（setItem 计数不动）；内容变了才写；
 *   3. 失效：答复 ok!==true 删该仓/该会话条目；运输层失败（catch）不删；
 *   4. 内存已有同仓 ok 账时不被盘账盖：⟳ 重读后屏上仍是内存那份，盘上的陈旧
 *      字节既不画上来也不触发重写；
 *   5. LRU：refs-tree/worktrees 写满 10、repo-lists 写满 50 后队首淘汰；
 *   6. localStorage 拒绝（store 拿不到 / 读写抛异常）：不崩、只留内存、盘上
 *      字节不动；
 *   7. 读入清洗：畸形条目（ok!==true、该有数组的地方不是数组、非对象）读入即
 *      丢弃，重写时不复活；repo-lists 缺省字段按空补齐照常保留；
 *   8. repo-lists 层的接入点：扫描前把 'session:'+id 占位种成 ready（首帧不闪
 *      「正在扫描」）、adopt 落盘、saveManualRepo 的答复走同一个 choke point。
 *
 * 「刷新页面」的模拟沿用 gp74 的先例：用同一份 fakeDoc/localStorage 把
 * CLIENT_SRC **再求值一遍** —— 模块内存全部归零，store 这份盘账原样还在。
 * 「⟳ 重读」用工具条那只刷新键（reloadChanges → git/flush → bump → freshAt），
 * 不用换仓库就能让 refs / worktrees 两条 effect 原地重跑。
 * 「写没写盘」用一只 setItem 计数视图换上 fakeDoc.defaultView 来数：内容去重的
 * 「没写」是「连写动作都没有」，光比字节是分不出「没写」和「写了同样的字节」的。 */

const K_REFS75 = 'dsh.git-idea.refs-tree'
const K_WT75 = 'dsh.git-idea.worktrees'
const K_RL75 = 'dsh.git-idea.repo-lists'
const K_APPLIED75 = 'dsh.git-idea.applied-repos'
const CLIENT75 = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')

/* 形状固定的小答复：refs 要 ok:true + current/local/remote 三个数组、worktrees 要
   ok:true + worktrees 数组（sanitize 的读入合同，见第 9 节）；名字都带各自前缀，
   分支树的行与工作树块的行共用 dsh-git-tname，靠名字互不撞车来分清谁是谁。 */
const refsReply75 = function (repo, names) {
  return {
    ok: true, repo: repo,
    current: names.length > 0 ? [names[0]] : [],
    local: names.map(function (n) { return { segments: [n], data: n } }),
    remote: [],
  }
}
const wtReply75 = function (repo, dirs) {
  return {
    ok: true, repo: repo,
    worktrees: dirs.map(function (d) {
      return { path: d, branch: d.slice(d.lastIndexOf('/') + 1) + '-branch', head: '', detached: false, bare: false, prunable: false, locked: false }
    }),
  }
}
const reposReply75 = function (workspace, repos) {
  return { ok: true, workspace: workspace, repos: repos, manual: [], missing: [], links: [], truncated: false }
}
const readAccount75 = function (key) {
  try { const raw = store[key]; return raw == null ? null : JSON.parse(raw) } catch (error) { return null }
}
const pend75 = function () {
  let settle = null
  const promise = new Promise(function (resolve) { settle = resolve })
  return { promise: promise, resolve: settle }
}
/* 首帧断言用的冻结闸：hold 期间这几个方法的读一律扣成欠账，屏上那份就只能是盘账。 */
const gate75 = function (methods) {
  const state = { hold: true, pendings: [], replies: {} }
  return {
    state: state,
    override: function (method) {
      if (methods.indexOf(method) < 0) return null
      if (state.hold === true) {
        const p = pend75()
        state.pendings.push({ method: method, p: p })
        return p.promise
      }
      const reply = state.replies[method]
      return reply === undefined ? null : Promise.resolve(reply)
    },
    release: function (replies) {
      state.replies = replies || {}
      state.hold = false
      for (const one of state.pendings.splice(0)) one.p.resolve(state.replies[one.method])
    },
  }
}

/* 再求值一遍 CLIENT_SRC = 一次「刷新」：模块内存全新，localStorage（store）原样。 */
function evalInstance75(override) {
  const registered75 = []
  const slots75 = { inject: (k, cb) => cb(), register: (o, c) => { registered75.push({ options: o, component: c }); return () => {} } }
  const ctx75 = {
    get(n) {
      if (n === 'slots') return slots75
      if (n === 'timer') return ctx.get('timer')
      return undefined
    },
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
  }
  const calls75 = []
  const host75 = {
    call(method, args) {
      calls75.push({ method: method, args: args })
      const held = override !== undefined ? override(method, args) : null
      return held != null ? held : host.call(method, args)
    },
  }
  new Function('ctx', 'React', 'host', 'styles', 'console', CLIENT75)(
    ctx75, React, host75, { insert: () => () => {} }, console).apply(ctx75)
  const found75 = function (id) { return registered75.find((r) => r.options.id === id).component }
  return {
    calls: calls75,
    chip: found75('dsh-git-idea-chip'),
    panel: found75('dsh-git-idea-panel'),
  }
}
const panelTree75 = async function (inst, sessionId, label) {
  let tree = null
  for (let i = 0; i < 4; i += 1) {
    tree = await renderUntilStable(makeElement(inst.panel, { sessionId: sessionId, active: true, ready: true }), label)
    await wait(10)
  }
  return tree
}
/* 面板的开关住在模块级的 open / everOpened 里（GitPopover 给 GitPanel 的是
   active: isOpen, ready: everOpened，不吃外面的 props），所以每次挂载都要先挂
   chip、点开面板，再渲染 popover —— gp74 的 openPanel 同一条路。 */
const chipTree75 = function (inst, sessionId, label) {
  return renderUntilStable(makeElement(inst.chip, { sessionId: sessionId }), label)
}
const openPanel75 = async function (inst, sessionId, label) {
  const t = await chipTree75(inst, sessionId, label + '-chip')
  if (String(t.props.className).indexOf('dsh-git-chip-open') < 0) { t.props.onClick(); await wait(10) }
  return await panelTree75(inst, sessionId, label)
}

/* 某个答复对象是否还被哪根 fiber 的 useState 持着：内容去重「没换内存账」的直接
   证据 —— 换了就有新对象进 hook、旧对象出来。 */
const hookHolds75 = function (value) {
  for (const fiber of fibers.values()) {
    if (Array.isArray(fiber.hooks) && fiber.hooks.indexOf(value) >= 0) return true
  }
  return false
}
/* setItem 计数视图：换上它之后每层写没写盘、写了几次，逐键有账（读照旧走 store）。 */
const spyView75 = function () {
  const counts = {}
  const view = { localStorage: {
    getItem: function (k) { return k in store ? store[k] : null },
    setItem: function (k, v) { counts[k] = (counts[k] || 0) + 1; store[k] = String(v) },
  } }
  view.counts = counts
  return view
}
const countOf75 = function (view, key) { return view.counts[key] || 0 }
/* 工具条那只 ⟳：reloadChanges → git/flush → bump → freshAt，refs / worktrees
   两条 effect 原地重跑（RPC 照发），不必换仓库。 */
const refresh75 = async function (inst, sessionId, label) {
  const before = inst.calls.length
  let tree = null
  let clicked = false
  for (let i = 0; i < 4 && clicked === false; i += 1) {
    tree = await renderUntilStable(makeElement(inst.panel, { sessionId: sessionId, active: true, ready: true }), label)
    const btn = buttons(tree).find(function (b) { return b.props.title === '重新读取仓库（忽略缓存）' })
    if (btn !== undefined) { btn.props.onClick(); clicked = true }
  }
  if (clicked === false) throw new Error('gp75: ⟳ 按钮没找到')
  await wait(30)
  tree = await panelTree75(inst, sessionId, label)
  return { tree: tree, clicked: inst.calls.length > before }
}
const tnames75 = function (tree) { return byClass(tree, 'dsh-git-tname').map(textOf) }
const hasBranch75 = function (tree, name) { return tnames75(tree).indexOf(name) >= 0 }
const hasWtRow75 = function (tree, dir) {
  return byClass(tree, 'dsh-git-wt-row').some(function (r) { return textOf(r).indexOf(dir) >= 0 })
}
const clearKeys75 = function () {
  delete store[K_REFS75]
  delete store[K_WT75]
  delete store[K_RL75]
  delete store[K_APPLIED75]
}

console.log('')
console.log('=== 1｜refs-tree：ok 答复落盘 {data,at}；刷新后垫底命中；RPC 照发，新答复整个盖掉 ===')
clearKeys75()
store[K_APPLIED75] = JSON.stringify({ 's-75a': '/tmp/ws' })
store[K_REFS75] = JSON.stringify({ '/tmp/ws': { data: refsReply75('/tmp/ws', ['stale-branch']), at: 1 } })
fibers.clear()
const gate75a = gate75(['git/refs'])
const inst75a = evalInstance75(function (method) {
  if (method === 'git/repos') return Promise.resolve(reposReply75('/tmp/ws', ['/tmp/ws']))
  return gate75a.override(method)
})
let tree75a = await openPanel75(inst75a, 's-75a', 'pop-75a')
ok('盘账存在时 git/refs 照发不省（新答复必到），请求带着会话与生效仓库',
  inst75a.calls.some(function (c) { return c.method === 'git/refs' && c.args != null && c.args.repo === '/tmp/ws' && c.args.sessionId === 's-75a' }))
ok('git/refs 还扣着没回，首帧已画上盘账的分支树：stale-branch 在屏上',
  hasBranch75(tree75a, 'stale-branch'))
gate75a.release({ 'git/refs': refsReply75('/tmp/ws', ['fresh-one', 'fresh-two']) })
await wait(20)
tree75a = await panelTree75(inst75a, 's-75a', 'pop-75a')
ok('新答复落地后垫底被整个盖掉：屏上换成 fresh-one，stale-branch 消失',
  hasBranch75(tree75a, 'fresh-one') && !hasBranch75(tree75a, 'stale-branch'))
const acct75a = readAccount75(K_REFS75)
ok('ok 答复按 {data,at} 落盘：data 是答复原样，at 是写入时刻',
  acct75a !== null && acct75a['/tmp/ws'] !== undefined
  && JSON.stringify(acct75a['/tmp/ws'].data) === JSON.stringify(refsReply75('/tmp/ws', ['fresh-one', 'fresh-two']))
  && typeof acct75a['/tmp/ws'].at === 'number' && isFinite(acct75a['/tmp/ws'].at))

console.log('')
console.log('=== 2｜worktrees 层：同款落盘、刷新垫底、RPC 照发、新答复盖掉 ===')
clearKeys75()
store[K_APPLIED75] = JSON.stringify({ 's-75w': '/tmp/ws' })
store[K_WT75] = JSON.stringify({ '/tmp/ws': { data: wtReply75('/tmp/ws', ['/tmp/wt-stale-dir']), at: 1 } })
fibers.clear()
const gate75w = gate75(['git/worktrees'])
const inst75w = evalInstance75(function (method) {
  if (method === 'git/repos') return Promise.resolve(reposReply75('/tmp/ws', ['/tmp/ws']))
  return gate75w.override(method)
})
let tree75w = await openPanel75(inst75w, 's-75w', 'pop-75w')
ok('worktrees 盘账存在时 git/worktrees 照发不省',
  inst75w.calls.some(function (c) { return c.method === 'git/worktrees' && c.args != null && c.args.repo === '/tmp/ws' }))
ok('git/worktrees 还扣着没回，工作树块首帧已画上盘账的 wt-stale-dir',
  hasWtRow75(tree75w, 'wt-stale-dir'))
gate75w.release({ 'git/worktrees': wtReply75('/tmp/ws', ['/tmp/wt-live-dir']) })
await wait(20)
tree75w = await panelTree75(inst75w, 's-75w', 'pop-75w')
ok('新答复落地后垫底被整个盖掉：屏上换成 wt-live-dir',
  hasWtRow75(tree75w, 'wt-live-dir') && !hasWtRow75(tree75w, 'wt-stale-dir'))
const acct75w = readAccount75(K_WT75)
ok('worktrees 的 ok 答复同样按 {data,at} 落盘',
  acct75w !== null && acct75w['/tmp/ws'] !== undefined
  && JSON.stringify(acct75w['/tmp/ws'].data) === JSON.stringify(wtReply75('/tmp/ws', ['/tmp/wt-live-dir']))
  && typeof acct75w['/tmp/ws'].at === 'number' && isFinite(acct75w['/tmp/ws'].at))

console.log('')
console.log('=== 3｜失效：答复 ok!==true → 该仓条目从盘账删除（canary 不陪葬）===')
clearKeys75()
store[K_APPLIED75] = JSON.stringify({ 's-75b': '/tmp/ws' })
store[K_REFS75] = JSON.stringify({
  '/tmp/ws': { data: refsReply75('/tmp/ws', ['doomed-branch']), at: 1 },
  '/canary/ws': { data: refsReply75('/canary/ws', ['canary-branch']), at: 2 },
})
store[K_WT75] = JSON.stringify({
  '/tmp/ws': { data: wtReply75('/tmp/ws', ['/tmp/wt-doomed']), at: 1 },
  '/canary/ws': { data: wtReply75('/canary/ws', ['/canary/wt']), at: 2 },
})
fibers.clear()
const inst75b = evalInstance75(function (method, args) {
  if (method === 'git/refs') return Promise.resolve({ ok: false, error: 'not a repository', repo: (args != null ? args.repo : '') || '/tmp/ws' })
  if (method === 'git/worktrees') return Promise.resolve({ ok: false, error: 'not a repository', repo: (args != null ? args.repo : '') || '/tmp/ws' })
  if (method === 'git/repos') return Promise.resolve(reposReply75('/tmp/ws', ['/tmp/ws']))
  return null
})
await openPanel75(inst75b, 's-75b', 'pop-75b')
await wait(20)
const refsB75 = readAccount75(K_REFS75)
const wtB75 = readAccount75(K_WT75)
ok('ok!==true 的答复把 refs-tree 与 worktrees 两层的该仓条目都删了，canary 原样还在',
  refsB75 !== null && wtB75 !== null && !('/tmp/ws' in refsB75) && !('/tmp/ws' in wtB75)
  && refsB75['/canary/ws'] !== undefined && wtB75['/canary/ws'] !== undefined)
ok('失效发生在答复之后：git/refs 与 git/worktrees 都照发过（不因盘账存在而省读）',
  inst75b.calls.some(function (c) { return c.method === 'git/refs' && c.args != null && c.args.repo === '/tmp/ws' })
  && inst75b.calls.some(function (c) { return c.method === 'git/worktrees' && c.args != null && c.args.repo === '/tmp/ws' }))

console.log('')
console.log('=== 4｜运输层失败（catch）：盘账不删，只记错误/占位 ===')
clearKeys75()
store[K_APPLIED75] = JSON.stringify({ 's-75t': '/tmp/ws' })
store[K_REFS75] = JSON.stringify({ '/tmp/ws': { data: refsReply75('/tmp/ws', ['kept-branch']), at: 1 } })
store[K_WT75] = JSON.stringify({ '/tmp/ws': { data: wtReply75('/tmp/ws', ['/tmp/wt-kept']), at: 1 } })
const seedRefs75t = store[K_REFS75]
const seedWt75t = store[K_WT75]
fibers.clear()
const inst75t = evalInstance75(function (method) {
  if (method === 'git/refs' || method === 'git/worktrees') return Promise.reject(new Error('transport down'))
  if (method === 'git/repos') return Promise.resolve(reposReply75('/tmp/ws', ['/tmp/ws']))
  return null
})
await openPanel75(inst75t, 's-75t', 'pop-75t')
await wait(20)
ok('git/refs / git/worktrees 运输层失败：两层盘账一个字节没动（没有答复说清单错了就不删）',
  store[K_REFS75] === seedRefs75t && store[K_WT75] === seedWt75t)
ok('失败前两条读照发过，面板没有崩（渲染落定）',
  inst75t.calls.some(function (c) { return c.method === 'git/refs' })
  && inst75t.calls.some(function (c) { return c.method === 'git/worktrees' }))

console.log('')
console.log('=== 5｜内容去重 + 内存 ok 账不被盘账盖（refs-tree 与 worktrees 两层）===')
clearKeys75()
store[K_APPLIED75] = JSON.stringify({ 's-75g': '/tmp/ws' })
store[K_REFS75] = JSON.stringify({ '/tmp/ws': { data: refsReply75('/tmp/ws', ['stale-branch']), at: 1 } })
store[K_WT75] = JSON.stringify({ '/tmp/ws': { data: wtReply75('/tmp/ws', ['/tmp/wt-stale-dir']), at: 1 } })
fibers.clear()
const gate75g = gate75(['git/refs', 'git/worktrees'])
const inst75g = evalInstance75(function (method) {
  if (method === 'git/repos') return Promise.resolve(reposReply75('/tmp/ws', ['/tmp/ws']))
  return gate75g.override(method)
})
let tree75g = await openPanel75(inst75g, 's-75g', 'pop-75g')
ok('（铺底）这一实例的垫底也在：stale-branch 与 wt-stale-dir 都上了屏',
  hasBranch75(tree75g, 'stale-branch') && hasWtRow75(tree75g, 'wt-stale-dir'))
const refsMem75 = refsReply75('/tmp/ws', ['fresh-one', 'fresh-two'])
const wtMem75 = wtReply75('/tmp/ws', ['/tmp/wt-live-dir'])
gate75g.release({ 'git/refs': refsMem75, 'git/worktrees': wtMem75 })
await wait(20)
tree75g = await panelTree75(inst75g, 's-75g', 'pop-75g')
ok('答复落地：内存账换成 fresh-one / wt-live-dir',
  hasBranch75(tree75g, 'fresh-one') && hasWtRow75(tree75g, 'wt-live-dir'))
ok('内存账真的在 hook 里（两个答复对象都还被 useState 持着）',
  hookHolds75(refsMem75) && hookHolds75(wtMem75))
const refsCalls75g = inst75g.calls.filter(function (c) { return c.method === 'git/refs' }).length
const wtCalls75g = inst75g.calls.filter(function (c) { return c.method === 'git/worktrees' }).length
const savedView75g = fakeDoc.defaultView
const spy75g = spyView75()
fakeDoc.defaultView = spy75g
await panelTree75(inst75g, 's-75g', 'pop-75g')
const baseRefs75g = countOf75(spy75g, K_REFS75)
const baseWt75g = countOf75(spy75g, K_WT75)
/* 盘上被「别处」写了更旧的账：层内的映射已懒加载过，这份字节不该被画上来，
   更不该触发任何重写。 */
store[K_REFS75] = JSON.stringify({ '/tmp/ws': { data: refsReply75('/tmp/ws', ['stale-again']), at: 42 } })
store[K_WT75] = JSON.stringify({ '/tmp/ws': { data: wtReply75('/tmp/ws', ['/tmp/wt-stale-again']), at: 42 } })
const staleRefs75g = store[K_REFS75]
const staleWt75g = store[K_WT75]
const round75g = await refresh75(inst75g, 's-75g', 'pop-75g')
tree75g = round75g.tree
ok('⟳ 重读照发不省：git/refs 与 git/worktrees 都又发了一遍',
  round75g.clicked
  && inst75g.calls.filter(function (c) { return c.method === 'git/refs' }).length > refsCalls75g
  && inst75g.calls.filter(function (c) { return c.method === 'git/worktrees' }).length > wtCalls75g)
ok('内存已有同仓 ok 账时不被盘账盖：屏上还是 fresh-one / wt-live-dir，盘上那份 stale-again 没被画上来',
  hasBranch75(tree75g, 'fresh-one') && hasWtRow75(tree75g, 'wt-live-dir')
  && !hasBranch75(tree75g, 'stale-again') && !hasWtRow75(tree75g, 'wt-stale-again'))
ok('重跑也没有碰盘：两层盘账还是「别处」写的那份陈旧字节，一个字节没动',
  store[K_REFS75] === staleRefs75g && store[K_WT75] === staleWt75g)
/* 与现账逐字一致的答复再来一遍：先 ⟳ 让两条 effect 重跑（新欠账），再放行一份
   与现账逐字一致的答复 —— setRefs/setWorktrees 不换对象，put 不落盘。 */
gate75g.state.hold = true
const refsSame75 = refsReply75('/tmp/ws', ['fresh-one', 'fresh-two'])
const wtSame75 = wtReply75('/tmp/ws', ['/tmp/wt-live-dir'])
await refresh75(inst75g, 's-75g', 'pop-75g')
gate75g.release({ 'git/refs': refsSame75, 'git/worktrees': wtSame75 })
await wait(20)
tree75g = await panelTree75(inst75g, 's-75g', 'pop-75g')
ok('与现状逐字一致的答复：内存账没被换（hook 里还是原来那两个对象）',
  hookHolds75(refsMem75) && hookHolds75(wtMem75)
  && !hookHolds75(refsSame75) && !hookHolds75(wtSame75)
  && hasBranch75(tree75g, 'fresh-one') && hasWtRow75(tree75g, 'wt-live-dir'))
ok('与现状逐字一致的答复：两层盘账都没重写（setItem 计数一动不动）',
  countOf75(spy75g, K_REFS75) === baseRefs75g && countOf75(spy75g, K_WT75) === baseWt75g
  && store[K_REFS75] === staleRefs75g && store[K_WT75] === staleWt75g)
/* 内容真变了：该换的换、该写的写（同样先 ⟳ 重跑、再放行不一致的答复）。 */
gate75g.state.hold = true
const refsNew75 = refsReply75('/tmp/ws', ['fresh-one', 'changed-branch'])
const wtNew75 = wtReply75('/tmp/ws', ['/tmp/wt-live-dir', '/tmp/wt-added-dir'])
await refresh75(inst75g, 's-75g', 'pop-75g')
gate75g.release({ 'git/refs': refsNew75, 'git/worktrees': wtNew75 })
await wait(20)
tree75g = await panelTree75(inst75g, 's-75g', 'pop-75g')
ok('内容不一致才写（内存）：changed-branch / wt-added-dir 上屏，新对象进了 hook',
  hasBranch75(tree75g, 'changed-branch') && hasWtRow75(tree75g, 'wt-added-dir')
  && hookHolds75(refsNew75) && hookHolds75(wtNew75))
ok('内容不一致才写（盘）：两层各重写了一次，盘上能读到新内容',
  countOf75(spy75g, K_REFS75) === baseRefs75g + 1 && countOf75(spy75g, K_WT75) === baseWt75g + 1
  && store[K_REFS75].indexOf('changed-branch') >= 0
  && store[K_WT75].indexOf('wt-added-dir') >= 0)
fakeDoc.defaultView = savedView75g

console.log('')
console.log('=== 6｜repo-lists 层：扫描前 ready 占位垫底、adopt 落盘、saveManualRepo 同一 choke point ===')
clearKeys75()
store[K_APPLIED75] = JSON.stringify({ 's-75r': '/tmp/ws' })
store[K_RL75] = JSON.stringify({ 's-75r': { data: { repos: ['/seed/ws-one', '/seed/ws-two'], manual: [], missing: [], links: [], note: '' }, at: 1 } })
fibers.clear()
const holdRepos75r = pend75()
let saveReply75r = null
const inst75r = evalInstance75(function (method) {
  if (method === 'git/repos') return holdRepos75r.promise
  if (method === 'git/repos-save') return saveReply75r === null ? null : Promise.resolve(saveReply75r)
  return null
})
let tree75r = await openPanel75(inst75r, 's-75r', 'pop-75r')
const repoNames75r = byClass(tree75r, 'dsh-git-repo-name').map(textOf)
ok('git/repos 扣着没回，首帧仓库列表已是盘账那两行（ws-one / ws-two），不闪「正在扫描」',
  repoNames75r.indexOf('ws-one') >= 0 && repoNames75r.indexOf('ws-two') >= 0
  && textOf(tree75r).indexOf('正在扫描') < 0)
ok('盘账垫底不省扫描：git/repos 照发（还扣在手里没回）',
  inst75r.calls.some(function (c) { return c.method === 'git/repos' && c.args != null && c.args.sessionId === 's-75r' }))
const adopt75r = { ok: true, workspace: '/seed/ws-one', repos: ['/seed/ws-one', '/seed/ws-two'], manual: ['/manual/ws'], missing: ['/gone/ws'], links: ['/link/ws'], truncated: false }
holdRepos75r.resolve(adopt75r)
await wait(20)
tree75r = await panelTree75(inst75r, 's-75r', 'pop-75r')
const acct75r = readAccount75(K_RL75)
ok('扫描答复 adopt 落盘：{repos,manual,missing,links,dirs,dirRepos,note} 原样进 {data,at}',
  acct75r !== null && acct75r['s-75r'] !== undefined
  && JSON.stringify(acct75r['s-75r'].data) === JSON.stringify({ repos: ['/seed/ws-one', '/seed/ws-two'], manual: ['/manual/ws'], missing: ['/gone/ws'], links: ['/link/ws'], dirs: [], dirRepos: {}, note: '' })
  && typeof acct75r['s-75r'].at === 'number' && isFinite(acct75r['s-75r'].at))
/* saveManualRepo：切换器「添加目录」那行进去，答复走 adopt → 同一个 choke point 落盘。 */
const addRow75r = byClass(tree75r, 'dsh-git-repo-add')[0]
if (addRow75r === undefined) throw new Error('gp75: 「添加目录」行没渲染出来')
addRow75r.props.onClick()
tree75r = await panelTree75(inst75r, 's-75r', 'pop-75r')
const input75r = byClass(tree75r, 'dsh-git-repo-input')[0]
if (input75r === undefined) throw new Error('gp75: 仓库路径输入框没渲染出来')
input75r.props.onChange({ target: { value: '/added/ws' } })
tree75r = await panelTree75(inst75r, 's-75r', 'pop-75r')
const okBtn75r = byClass(tree75r, 'dsh-git-repo-ok')[0]
if (okBtn75r === undefined) throw new Error('gp75: 「添加」按钮没渲染出来')
saveReply75r = { ok: true, workspace: '/seed/ws-one', repos: ['/seed/ws-one', '/seed/ws-two', '/added/ws'], manual: ['/manual/ws', '/added/ws'], missing: [], links: ['/link/ws'], truncated: false }
okBtn75r.props.onClick()
await wait(20)
tree75r = await panelTree75(inst75r, 's-75r', 'pop-75r')
const saved75r = readAccount75(K_RL75)
ok('saveManualRepo 的答复走同一个 choke point 落盘：/added/ws 进了 repos 与 manual，形状还是 {data,at}',
  saved75r !== null && saved75r['s-75r'] !== undefined
  && saved75r['s-75r'].data.repos.indexOf('/added/ws') >= 0
  && saved75r['s-75r'].data.manual.indexOf('/added/ws') >= 0
  && typeof saved75r['s-75r'].at === 'number')
/* 内容级去重的另一半：Host 对重复添加回一份与现账逐字一致的清单 → adopt 不重写。 */
const spy75r = spyView75()
const savedView75r = fakeDoc.defaultView
fakeDoc.defaultView = spy75r
await panelTree75(inst75r, 's-75r', 'pop-75r')
const baseRL75r = countOf75(spy75r, K_RL75)
const bytesRL75r = store[K_RL75]
const addRow75r2 = byClass(tree75r, 'dsh-git-repo-add')[0]
addRow75r2.props.onClick()
tree75r = await panelTree75(inst75r, 's-75r', 'pop-75r')
byClass(tree75r, 'dsh-git-repo-input')[0].props.onChange({ target: { value: '/added/ws' } })
tree75r = await panelTree75(inst75r, 's-75r', 'pop-75r')
saveReply75r = { ok: true, workspace: '/seed/ws-one', repos: ['/seed/ws-one', '/seed/ws-two', '/added/ws'], manual: ['/manual/ws', '/added/ws'], missing: [], links: ['/link/ws'], truncated: false }
byClass(tree75r, 'dsh-git-repo-ok')[0].props.onClick()
await wait(20)
await panelTree75(inst75r, 's-75r', 'pop-75r')
ok('与现账逐字一致的 repos-save 答复：adopt 不落盘（repo-lists 的 setItem 计数一动不动、字节不变）',
  countOf75(spy75r, K_RL75) === baseRL75r && store[K_RL75] === bytesRL75r)
fakeDoc.defaultView = savedView75r

console.log('')
console.log('=== 7｜repo-lists 层失效：扫描答复 ok!==true → 该会话条目删除、「扫描失败」上屏 ===')
clearKeys75()
store[K_RL75] = JSON.stringify({
  's-75f': { data: { repos: ['/doomed/ws'], manual: [], missing: [], links: [], note: '' }, at: 1 },
  'canary': { data: { repos: ['/canary/ws'], manual: [], missing: [], links: [], note: '' }, at: 2 },
})
fibers.clear()
const inst75f = evalInstance75(function (method) {
  if (method === 'git/repos') return Promise.resolve({ ok: false, error: 'scan failed' })
  return null
})
let tree75f = await openPanel75(inst75f, 's-75f', 'pop-75f')
await wait(20)
const acct75f = readAccount75(K_RL75)
ok('ok!==true 的扫描答复删掉该会话盘账条目，canary 留着',
  acct75f !== null && !('s-75f' in acct75f) && acct75f['canary'] !== undefined)
tree75f = await panelTree75(inst75f, 's-75f', 'pop-75f')
ok('扫描照发过，面板如实说「扫描失败」（不崩、不冒充空清单）',
  inst75f.calls.some(function (c) { return c.method === 'git/repos' && c.args != null && c.args.sessionId === 's-75f' })
  && textOf(tree75f).indexOf('扫描失败') >= 0)

console.log('')
console.log('=== 8｜LRU：refs-tree / worktrees 写满 10、repo-lists 写满 50 后队首淘汰 ===')
clearKeys75()
const seedRefsLRU75 = {}
for (let i = 0; i < 10; i += 1) seedRefsLRU75['/r-' + (i < 10 ? '0' + i : String(i))] = { data: refsReply75('/r-' + (i < 10 ? '0' + i : String(i)), ['b']), at: i }
const seedWtLRU75 = {}
for (let i = 0; i < 10; i += 1) seedWtLRU75['/w-' + (i < 10 ? '0' + i : String(i))] = { data: wtReply75('/w-' + (i < 10 ? '0' + i : String(i)), ['/w-' + (i < 10 ? '0' + i : String(i)) + '/x']), at: i }
const seedRL75 = {}
for (let i = 0; i < 50; i += 1) seedRL75['k-' + (i < 10 ? '0' + i : String(i))] = { data: { repos: ['/k'], manual: [], missing: [], links: [], note: '' }, at: i }
store[K_REFS75] = JSON.stringify(seedRefsLRU75)
store[K_WT75] = JSON.stringify(seedWtLRU75)
store[K_RL75] = JSON.stringify(seedRL75)
store[K_APPLIED75] = JSON.stringify({ 's-75lru': '/tmp/ws' })
fibers.clear()
const inst75l = evalInstance75(function (method, args) {
  if (method === 'git/refs') return Promise.resolve(refsReply75((args != null ? args.repo : '') || '/tmp/ws', ['lru-branch']))
  if (method === 'git/worktrees') return Promise.resolve(wtReply75('/tmp/ws', ['/tmp/wt-lru']))
  if (method === 'git/repos') return Promise.resolve(reposReply75('/tmp/ws', ['/tmp/ws']))
  return null
})
await openPanel75(inst75l, 's-75lru', 'pop-75lru')
await wait(20)
const lruRefs75 = readAccount75(K_REFS75)
const lruWt75 = readAccount75(K_WT75)
const lruRL75 = readAccount75(K_RL75)
ok('refs-tree 写满 10 再写：恰好 10 条，队首 /r-00 淘汰，/r-09 与新仓 /tmp/ws 都在',
  lruRefs75 !== null && Object.keys(lruRefs75).length === 10
  && !('/r-00' in lruRefs75) && ('/r-09' in lruRefs75) && ('/tmp/ws' in lruRefs75))
ok('worktrees 写满 10 再写：恰好 10 条，队首 /w-00 淘汰，/w-09 与 /tmp/ws 都在',
  lruWt75 !== null && Object.keys(lruWt75).length === 10
  && !('/w-00' in lruWt75) && ('/w-09' in lruWt75) && ('/tmp/ws' in lruWt75))
ok('repo-lists 写满 50 再写：恰好 50 条，队首 k-00 淘汰，k-49 与新会话 s-75lru 都在',
  lruRL75 !== null && Object.keys(lruRL75).length === 50
  && !('k-00' in lruRL75) && ('k-49' in lruRL75) && ('s-75lru' in lruRL75))

console.log('')
console.log('=== 9｜localStorage 拒绝：不崩、只留内存、盘上字节不动 ===')
clearKeys75()
store[K_APPLIED75] = JSON.stringify({ 's-75ns': '/tmp/ws' })
store[K_REFS75] = JSON.stringify({ '/tmp/ws': { data: refsReply75('/tmp/ws', ['should-not-restore']), at: 1 } })
const seedNs75 = store[K_REFS75]
fibers.clear()
const savedView75n = fakeDoc.defaultView
fakeDoc.defaultView = undefined
const gate75n = gate75(['git/refs'])
const inst75n = evalInstance75(function (method) {
  if (method === 'git/repos') return Promise.resolve(reposReply75('/tmp/ws', ['/tmp/ws']))
  return gate75n.override(method)
})
let tree75n = await openPanel75(inst75n, 's-75ns', 'pop-75ns')
ok('store 拿不到：不崩、盘账读不出（不还魂）、git/refs 照发，盘上字节不动',
  store[K_REFS75] === seedNs75 && !hasBranch75(tree75n, 'should-not-restore')
  && inst75n.calls.some(function (c) { return c.method === 'git/refs' }))
gate75n.release({ 'git/refs': refsReply75('/tmp/ws', ['live-branch']) })
await wait(20)
tree75n = await panelTree75(inst75n, 's-75ns', 'pop-75ns')
ok('store 拿不到：新答复照常上屏（只留内存），写不进去也不崩，盘上那份一个字节没动',
  hasBranch75(tree75n, 'live-branch') && store[K_REFS75] === seedNs75)
fakeDoc.defaultView = {
  localStorage: {
    getItem: function () { throw new Error('denied') },
    setItem: function () { throw new Error('denied') },
  },
}
clearKeys75()
store[K_APPLIED75] = JSON.stringify({ 's-75th': '/tmp/ws' })
store[K_REFS75] = JSON.stringify({ '/tmp/ws': { data: refsReply75('/tmp/ws', ['should-not-restore-2']), at: 1 } })
const seedTh75 = store[K_REFS75]
fibers.clear()
const gate75th = gate75(['git/refs'])
const inst75th = evalInstance75(function (method) {
  if (method === 'git/repos') return Promise.resolve(reposReply75('/tmp/ws', ['/tmp/ws']))
  return gate75th.override(method)
})
let tree75th = await openPanel75(inst75th, 's-75th', 'pop-75th')
ok('读写都抛异常：同样不崩、不还魂、git/refs 照发、盘账原样',
  store[K_REFS75] === seedTh75 && !hasBranch75(tree75th, 'should-not-restore-2')
  && inst75th.calls.some(function (c) { return c.method === 'git/refs' }))
gate75th.release({ 'git/refs': refsReply75('/tmp/ws', ['live-branch-2']) })
await wait(20)
tree75th = await panelTree75(inst75th, 's-75th', 'pop-75th')
ok('读写都抛异常：新答复照常上屏（只留内存），写失败吞掉、盘上字节不动',
  hasBranch75(tree75th, 'live-branch-2') && store[K_REFS75] === seedTh75)
fakeDoc.defaultView = savedView75n

console.log('')
console.log('=== 10｜读入清洗：畸形条目丢弃，好条目（含缺省字段）保留，重写时不复活 ===')
clearKeys75()
store[K_APPLIED75] = JSON.stringify({ 's-75m': '/tmp/ws' })
store[K_REFS75] = JSON.stringify({
  'm1': { data: { ok: false, current: [], local: [], remote: [] }, at: 1 },
  'm2': { data: { ok: true, current: 'nope', local: [], remote: [] }, at: 2 },
  'm3': { data: { ok: true, local: [], remote: [] }, at: 3 },
  'm4': 'plain-string',
  'm5': { data: null, at: 4 },
  '/canary/ws': { data: refsReply75('/canary/ws', ['canary-branch']), at: 5 },
})
store[K_WT75] = JSON.stringify({
  'm1': { data: { ok: false, worktrees: [] }, at: 1 },
  'm2': { data: { ok: true }, at: 2 },
  'm3': 'nope',
  '/canary/ws': { data: wtReply75('/canary/ws', ['/canary/wt']), at: 5 },
})
store[K_RL75] = JSON.stringify({
  'm1': { data: {}, at: 1 },
  'm2': { data: { repos: 'nope' }, at: 2 },
  'm3': 42,
  'k-good': { data: { repos: ['/rl-keep'] }, at: 9 },
})
fibers.clear()
const inst75m = evalInstance75(function (method, args) {
  if (method === 'git/refs') return Promise.resolve(refsReply75((args != null ? args.repo : '') || '/tmp/ws', ['clean-branch']))
  if (method === 'git/worktrees') return Promise.resolve(wtReply75('/tmp/ws', ['/tmp/wt-clean']))
  if (method === 'git/repos') return Promise.resolve(reposReply75('/tmp/ws', ['/tmp/ws']))
  return null
})
await openPanel75(inst75m, 's-75m', 'pop-75m')
await wait(20)
const cleanRefs75 = readAccount75(K_REFS75)
const cleanWt75 = readAccount75(K_WT75)
const cleanRL75 = readAccount75(K_RL75)
ok('refs-tree：ok!==true / current 不是数组 / 缺 current / 非对象 / data 为空 全部丢弃，canary 与新仓保留',
  cleanRefs75 !== null && !('m1' in cleanRefs75) && !('m2' in cleanRefs75) && !('m3' in cleanRefs75)
  && !('m4' in cleanRefs75) && !('m5' in cleanRefs75)
  && cleanRefs75['/canary/ws'] !== undefined && cleanRefs75['/tmp/ws'] !== undefined)
ok('worktrees：ok!==true / 缺 worktrees 数组 / 非对象 丢弃，canary 与新仓保留',
  cleanWt75 !== null && !('m1' in cleanWt75) && !('m2' in cleanWt75) && !('m3' in cleanWt75)
  && cleanWt75['/canary/ws'] !== undefined && cleanWt75['/tmp/ws'] !== undefined)
ok('repo-lists：缺 repos / repos 不是数组 / 非对象 丢弃；缺 manual/missing/links/note 的好条目按空补齐照常保留',
  cleanRL75 !== null && !('m1' in cleanRL75) && !('m2' in cleanRL75) && !('m3' in cleanRL75)
  && cleanRL75['k-good'] !== undefined && cleanRL75['k-good'].data.repos[0] === '/rl-keep'
  && JSON.stringify(cleanRL75['k-good'].data.manual) === '[]'
  && cleanRL75['s-75m'] !== undefined)

console.log('')
console.log('=== 11｜多选逐仓垫底：repoRefs 每仓先画盘账那份，git/refs 照发 ===')
clearKeys75()
store[K_APPLIED75] = JSON.stringify({ 's-75ms': '/tmp/ws' })
store[K_REFS75] = JSON.stringify({ '/tmp/ws2': { data: refsReply75('/tmp/ws2', ['ms-seed-branch']), at: 1 } })
fibers.clear()
const holdMs75 = pend75()
const inst75ms = evalInstance75(function (method, args) {
  if (method === 'git/refs') {
    if (args != null && args.repo === '/tmp/ws2') return holdMs75.promise
    return Promise.resolve(refsReply75('/tmp/ws', ['ws-branch']))
  }
  if (method === 'git/repos') return Promise.resolve(reposReply75('/tmp/ws', ['/tmp/ws', '/tmp/ws2']))
  return null
})
let tree75ms = await openPanel75(inst75ms, 's-75ms', 'pop-75ms')
const rowWs2_75 = byClass(tree75ms, 'dsh-git-repo-row').find(function (r) { return textOf(r).indexOf('ws2') >= 0 })
if (rowWs2_75 === undefined) throw new Error('gp75: ws2 的仓库行没渲染出来')
rowWs2_75.props.onClick({ ctrlKey: true })
tree75ms = await panelTree75(inst75ms, 's-75ms', 'pop-75ms')
ok('多选组里 ws2 首帧画上盘账的 ms-seed-branch（git/refs 还扣着没回），组头也在',
  byClass(tree75ms, 'dsh-git-rgroup').some(function (g) { return textOf(g).indexOf('ws2') >= 0 })
  && hasBranch75(tree75ms, 'ms-seed-branch')
  && textOf(tree75ms).indexOf('无法读取分支') < 0)
ok('多选垫底不省读：ws2 自己那次 git/refs 照发（还扣在手里没回）',
  inst75ms.calls.some(function (c) { return c.method === 'git/refs' && c.args != null && c.args.repo === '/tmp/ws2' }))
