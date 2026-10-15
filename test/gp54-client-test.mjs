import fs from 'node:fs'

/* ── 宿主常驻监听的浏览器半侧（98-register.js 的 liveBus 订阅）+
 *    runCompleteRefresh 的 5 秒重入护栏（92-chip.js）+
 *    client-pre.js onopen 的 live-open 分发 ──
 *
 * 自足式套件（不进 build-suites 的粘连清单）：自带 mini-React，把 client.js 连同
 * 一个 liveBus 桩一起求值 —— 桩记下订阅者，测试直接往里投递三种消息，对着 host 桩
 * 收到的调用与渲染出的 chip 断言。盯这些：
 *   1. 订阅挂在插件级：一个组件都没挂时就已订上（chip 卸载/换会话视图动不了它），
 *      卸载 effect 把订阅摘走；
 *   2. repo-changed：本地读数标成「不再完整」（chip 标题当场改口「正在核对」）+
 *      整树重读的铃 + bump（chip 这边的读数也重走一遍）；repo 空串/缺失安静忽略；
 *   3. session-complete：页面开着当场刷（git/flush 带会话与仓库）；5 秒内第二条
 *      （宿主推送与 chip 边沿各来一遍的同一份完成）被护栏吞掉；页面藏着记成欠账、
 *      live-open 补发；开关 refreshOnComplete=false 就不刷（独自一份求值：配置的
 *      采纳只在第一次挂载时拉一次，主世界里它得保持默认的开）；
 *   4. live-open：补欠账 + 对手头每个 watcher 强制走一拍签名（git/watch）；
 *   5. cmdlog 订阅方对未知 kind 安静忽略；client-pre.js（真包）onopen 向 listeners
 *      分发 {kind:'live-open'} —— 从 build-package 的渲染函数取真包源码做切片断言
 *      （GP_FRESH 下也不读盘上产物）。
 *
 * chip 的改动数文案住在按钮的 title 里（屏上只有分支名和数字药丸），所以对「工作区
 * 干净 / 正在核对改动…」的断言都看 title。「改口」要赶在整树重读落地之前断 ——
 * 重读一发出去就把 fullAt 补回去了，settle 之后再看的又是「工作区干净」。 */

/* ── mini-React + 一整套世界（多份求值互不串线：fiber/脏标记都收在闭包里）── */
function makeWorld54(config) {
  let dirty = false
  let currentFiber = null
  const fibers = new Map()

  function makeElement(type, props, ...children) {
    const flat = []
    const push = (c) => {
      if (c === null || c === undefined || c === false || c === true) return
      if (Array.isArray(c)) { c.forEach(push); return }
      flat.push(c)
    }
    children.forEach(push)
    const merged = Object.assign({}, props)
    merged.children = flat
    return { type: type, key: merged.key === undefined ? null : merged.key, props: merged }
  }
  const React = {
    createElement: makeElement,
    memo(component) { return { $$memo: true, render: component } },
    useCallback(fn, deps) {
      const fiber = currentFiber
      const index = fiber.cursor
      fiber.cursor += 1
      const previous = fiber.memos === undefined ? undefined : fiber.memos[index]
      if (previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps)
        && deps.length === previous.deps.length && deps.every((d, i) => d === previous.deps[i])) return previous.fn
      if (fiber.memos === undefined) fiber.memos = []
      fiber.memos[index] = { deps: deps, fn: fn }
      return fn
    },
    useMemo(factory) { return factory() },
    useState(initial) {
      const fiber = currentFiber
      const index = fiber.cursor
      fiber.cursor += 1
      if (fiber.hooks.length <= index) fiber.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        const value = typeof next === 'function' ? next(fiber.hooks[index]) : next
        if (fiber.hooks[index] !== value) { fiber.hooks[index] = value; dirty = true }
      }
      return [fiber.hooks[index], setter]
    },
    useEffect(effect, deps) {
      const fiber = currentFiber
      const index = fiber.cursor
      fiber.cursor += 1
      const previous = fiber.effects[index]
      const same = previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps)
        && deps.length === previous.deps.length && deps.every((d, i) => d === previous.deps[i])
      if (same) return
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      fiber.effects[index] = { deps: deps, cleanup: undefined }
      fiber.pending.push(() => {
        const cleanup = effect()
        fiber.effects[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined
      })
    },
  }
  function textOf(node) {
    if (node === null || node === undefined) return ''
    if (typeof node === 'string') return node
    if (typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (node.props === undefined) return ''
    return textOf(node.props.children)
  }

  const store = {}
  const doc = {
    defaultView: {
      innerWidth: 1400, innerHeight: 900,
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v) },
      },
    },
    hidden: false,
    _listeners: {},
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f) },
    removeEventListener(t, f) { this._listeners[t] = (this._listeners[t] || []).filter((x) => x !== f) },
    fire(t, e) { (this._listeners[t] || []).slice().forEach((f) => f(e)) },
  }
  const chipNodeObj = { ownerDocument: doc, contains: () => false }

  function renderRoot(element, label) {
    const pending = []
    const render = (node, path) => {
      if (node === null || node === undefined) return null
      if (typeof node === 'string' || typeof node === 'number') return node
      if (Array.isArray(node)) return node.map((c, i) => render(c, path + '.' + i))
      const type = node.type
      if (type != null && typeof type === 'object' && type.$$memo === true) {
        return render({ type: type.render, props: node.props, key: node.key }, path)
      }
      if (typeof type !== 'function') {
        const kids = (node.props.children || []).map((c, i) => render(c, path + '/' + i))
        const out = { type: type, key: node.key, props: Object.assign({}, node.props, { children: kids }) }
        if (typeof node.props.ref === 'function') node.props.ref(chipNodeObj)
        return out
      }
      const fiberKey = path + '#' + (type.name || 'anon') + '#' + (node.key === null ? '' : node.key)
      let fiber = fibers.get(fiberKey)
      if (fiber === undefined) { fiber = { hooks: [], memos: [], effects: [], cursor: 0, pending: [] }; fibers.set(fiberKey, fiber) }
      fiber.cursor = 0
      fiber.pending = []
      const previous = currentFiber
      currentFiber = fiber
      let out
      try { out = type(node.props) } finally { currentFiber = previous }
      pending.push(fiber)
      return render(out, path + '/' + (type.name || 'anon'))
    }
    const tree = render(element, label)
    for (const fiber of pending) for (const job of fiber.pending.splice(0)) job()
    return tree
  }
  async function renderUntilStable(element, label) {
    let tree = null
    for (let i = 0; i < 40; i += 1) {
      dirty = false
      tree = renderRoot(element, label)
      await new Promise((r) => setTimeout(r, 0))
      if (!dirty) return tree
    }
    throw new Error('render did not settle for ' + label)
  }

  const calls = []
  const OK_PANEL = { ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] }
  const nowSec = Math.floor(Date.now() / 1000)
  const host = {
    call(method, args) {
      calls.push({ method: method, args: args })
      if (method === 'git/panel') return Promise.resolve(OK_PANEL)
      if (method === 'git/flush') return Promise.resolve({ ok: true })
      if (method === 'git/watch') return Promise.resolve({ ok: true, repo: (args && args.repo) || '/tmp/ws', sig: 'SIG' })
      if (method === 'git/branches') return Promise.resolve({ ok: true, repo: '/tmp/ws', current: 'main', previous: '', branches: [
        { name: 'main', current: true, committedAt: nowSec - 5, upstream: 'origin/main', track: '=', ahead: 0, behind: 0, head: 'aaa', subject: 'tip' },
      ], remotes: [] })
      if (method === 'git/config') return Promise.resolve({ ok: true, path: '/home/u/.dsh/dsh-git-idea.json', config: config })
      return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
    },
  }
  const registered = []
  const slots = { inject: (k, cb) => cb(), register: (o, c) => { registered.push({ options: o, component: c }); return () => {} } }
  const timers = []
  const disposers = []
  const ctx = {
    get(n) {
      if (n === 'slots') return slots
      if (n === 'timer') return {
        interval(cb, delay) { const t = { kind: 'interval', cb, delay, dead: false }; timers.push(t); return () => { t.dead = true } },
        timeout(cb, delay) { const t = { kind: 'timeout', cb, delay, dead: false }; timers.push(t); return () => { t.dead = true } },
      }
      return undefined
    },
    effect(cb) { const d = cb(); if (typeof d === 'function') disposers.push(d); return typeof d === 'function' ? d : () => {} },
  }
  const liveBus = {
    listeners: new Set(),
    subscribe(fn) { liveBus.listeners.add(fn); return () => { liveBus.listeners.delete(fn) } },
    open() {},
    close() {},
    dispatch(message) { liveBus.listeners.forEach(function (listener) { listener(message) }) },
  }

  new Function('ctx', 'React', 'host', 'styles', 'console', 'liveBus', CLIENT_SRC)(
    ctx, React, host, { insert: () => () => {} }, console, liveBus).apply(ctx)

  const chip = registered.find((r) => r.options.id === 'dsh-git-idea-chip').component
  const wait = (ms) => new Promise((r) => setTimeout(r, ms || 15))
  const countOf = (method) => calls.filter((c) => c.method === method).length
  const flushOf = (sessionId) => calls.filter((c) => c.method === 'git/flush' && c.args && c.args.sessionId === sessionId)
  async function settleChip(label, sessionId) {
    let tree = null
    for (let i = 0; i < 5; i += 1) {
      tree = await renderUntilStable(makeElement(chip, { sessionId: sessionId }), label)
      await wait(15)
    }
    return tree
  }
  return {
    React: React, makeElement: makeElement, renderRoot: renderRoot, renderUntilStable: renderUntilStable,
    doc: doc, chip: chip, liveBus: liveBus, calls: calls, timers: timers, disposers: disposers,
    wait: wait, countOf: countOf, flushOf: flushOf, settleChip: settleChip, textOf: textOf,
  }
}

const CLIENT_SRC = fs.readFileSync(process.env.GP_SRC || new URL('../client.js', import.meta.url).pathname, 'utf8')
const w = makeWorld54({})

let failed = 0
const ok = (label, value) => {
  if (value !== true) failed += 1
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label + (value ? '' : '   ← 不符合预期'))
}

console.log('')
console.log('== 订阅挂在插件级：组件没挂就已订上，卸载才摘 ==')
ok('一个组件都没渲染，liveBus 上已经有一个订阅者（98-register 的 effect，不随会话卸载）',
  w.liveBus.listeners.size === 1)

console.log('')
console.log('== repo-changed：本地读数标成「不再完整」+ 铃 + bump ==')
{
  let tree = await w.settleChip('gp54-repo', 's-1')
  ok('chip 完成首读：标题说「工作区干净」（这份读数自证完整）',
    tree.props.title.indexOf('工作区干净') >= 0)
  const baseline = w.countOf('git/panel')
  w.liveBus.dispatch({ kind: 'repo-changed', repo: '/tmp/ws' })
  const midTree = w.renderRoot(w.makeElement(w.chip, { sessionId: 's-1' }), 'gp54-repo')
  ok('推送落地：markTreePartial 让标题当场改口「正在核对改动…」',
    midTree.props.title.indexOf('正在核对改动') >= 0)
  tree = await w.settleChip('gp54-repo', 's-1')
  ok('铃 + bump：chip 这边的读数也重走了一遍（快读 + 整树读），读完自证完整',
    w.countOf('git/panel') >= baseline + 2 && tree.props.title.indexOf('工作区干净') >= 0)
  const mark = w.countOf('git/panel')
  w.liveBus.dispatch({ kind: 'repo-changed', repo: '' })
  w.liveBus.dispatch({ kind: 'repo-changed' })
  w.liveBus.dispatch({ kind: 'repo-changed', repo: 42 })
  tree = await w.settleChip('gp54-repo', 's-1')
  ok('repo 空串 / 缺失 / 非字符串：安静忽略，一拍读都不多',
    w.countOf('git/panel') === mark && tree.props.title.indexOf('工作区干净') >= 0)
}

console.log('')
console.log('== session-complete：当场刷 + 5 秒护栏共用 ==')
{
  const mark = w.flushOf('s-1').length
  w.liveBus.dispatch({ kind: 'session-complete', sessionId: 's-1' })
  const midTree = w.renderRoot(w.makeElement(w.chip, { sessionId: 's-1' }), 'gp54-s1')
  ok('页面开着当场刷：git/flush 带会话，生效仓库也逐个失效',
    w.flushOf('s-1').length >= mark + 2
    && w.flushOf('s-1')[mark].repo === undefined
    && w.flushOf('s-1').some((c, i) => i > mark && c.args.repo === '/tmp/ws'))
  ok('完成那一刷把读数标成待整树重读（标题当场改口「正在核对改动…」）',
    midTree.props.title.indexOf('正在核对改动') >= 0)
  await w.settleChip('gp54-s1', 's-1')
  const after = w.flushOf('s-1').length
  w.liveBus.dispatch({ kind: 'session-complete', sessionId: 's-1' })
  await w.settleChip('gp54-s1', 's-1')
  ok('5 秒内第二条推送被护栏吞掉（chip 边沿与宿主推送同一次完成只刷一遍）',
    w.flushOf('s-1').length === after)
  w.liveBus.dispatch({ kind: 'session-complete', sessionId: '' })
  w.liveBus.dispatch({ kind: 'session-complete' })
  await w.settleChip('gp54-s1', 's-1')
  ok('sessionId 空串 / 缺失：安静忽略', w.flushOf('s-1').length === after)
}

console.log('')
console.log('== session-complete：页面藏着记欠账，live-open 补发 ==')
{
  w.doc.hidden = true
  const markS9 = w.flushOf('s-9').length
  w.liveBus.dispatch({ kind: 'session-complete', sessionId: 's-9' })
  await w.wait(30)
  ok('页面藏着：不当场刷（记成欠账），git/flush 一次都没发', w.flushOf('s-9').length === markS9)
  w.doc.hidden = false
  const markWatch = w.countOf('git/watch')
  w.liveBus.dispatch({ kind: 'live-open' })
  await w.settleChip('gp54-s9', 's-9')
  ok('live-open 补发欠账：s-9 的那一刷落了地', w.flushOf('s-9').length === markS9 + 1)
  ok('live-open 还对手头每个 watcher 强制走一拍签名（git/watch 多了）',
    w.countOf('git/watch') > markWatch)
  const after = w.flushOf('s-9').length
  w.liveBus.dispatch({ kind: 'live-open' })
  await w.settleChip('gp54-s9', 's-9')
  ok('第二条 live-open：欠账为空，什么都没刷', w.flushOf('s-9').length === after)
  /* 欠账补发不吃 5 秒护栏：它替的是一次没有任何一刷覆盖过的完成（gp52 的契约）。 */
  w.doc.hidden = true
  const beforeOwe = w.flushOf('s-1').length
  w.liveBus.dispatch({ kind: 'session-complete', sessionId: 's-1' })
  await w.wait(20)
  ok('5 秒内藏着时的第二条完成推送：只记欠账，不跑', w.flushOf('s-1').length === beforeOwe)
  w.doc.hidden = false
  w.liveBus.dispatch({ kind: 'live-open' })
  await w.settleChip('gp54-s1', 's-1')
  ok('回可见补账：5 秒护栏不拦欠账那一刷（会话本身 + 生效仓库两个 flush 都发了）',
    w.flushOf('s-1').length === beforeOwe + 2)
  const afterSettle = w.flushOf('s-1').length
  w.liveBus.dispatch({ kind: 'session-complete', sessionId: 's-1' })
  await w.settleChip('gp54-s1', 's-1')
  ok('补账盖了新戳：紧跟着的推送仍在 5 秒护栏内让路', w.flushOf('s-1').length === afterSettle)
}

console.log('')
console.log('== refreshOnComplete 关掉：推送到了也不刷 ==')
{
  /* 配置只在第一次挂载时拉一次（20-prefs 的 loadPluginConfig 一次性），所以要一份
     独立的世界：带 refreshOnComplete:false 的配置、自己的 liveBus 桩。 */
  const g = makeWorld54({ refreshOnComplete: false })
  await g.settleChip('gp54-gate', 's-3')
  const mark = g.flushOf('s-3').length
  g.liveBus.dispatch({ kind: 'session-complete', sessionId: 's-3' })
  await g.settleChip('gp54-gate', 's-3')
  ok('开关在跑的那一刻再读：refreshOnComplete=false 就不刷', g.flushOf('s-3').length === mark)
}

console.log('')
console.log('== 老订阅者与真包 onopen ==')
{
  /* cmdlog 订阅者（80-panel.js）对未知 kind 的合同：落到 return previous，状态
     原样 —— 三种新消息里它不认得的都从那里滑过去，不打扰命令页。 */
  const panelLiveStart = CLIENT_SRC.indexOf("message.kind === 'cmdlog-start'")
  const panelLive = CLIENT_SRC.slice(
    panelLiveStart,
    CLIENT_SRC.indexOf('}, [sessionId])', panelLiveStart))
  ok('cmdlog 订阅者对未知 kind 落到 return previous（安静忽略）',
    panelLive.indexOf("message.kind === 'cmdlog-start'") >= 0
    && panelLive.indexOf("message.kind === 'cmdlog-exit'") >= 0
    && panelLive.indexOf('return previous') >= 0)
  /* 真包的 client-pre（client/client.js 的前奏）在 onopen 分发 live-open —— 从
     build-package 的渲染函数取源码切片，GP_FRESH 下也不依赖盘上产物。 */
  const pkg = await import('../build-package.mjs')
  const target = pkg.PACKAGE_TARGETS.find((t) => t.out === 'client/client.js')
  const pkgSrc = pkg.render(target)
  const onopen = pkgSrc.slice(pkgSrc.indexOf('ws.onopen = function () {'), pkgSrc.indexOf('ws.onmessage = function (event) {'))
  ok('client-pre 的 onopen：向 listeners 分发 {kind:"live-open"}，逐订阅者 try/catch',
    onopen.indexOf("kind: 'live-open'") >= 0
    && onopen.indexOf('liveBus.listeners.forEach') >= 0
    && onopen.indexOf('try {') >= 0 && onopen.indexOf('console.error') >= 0)
  w.liveBus.dispatch({ kind: 'cmdlog-exit', id: 'nope', exitCode: 0 })
  w.liveBus.dispatch({ kind: 'totally-unknown' })
  ok('往订阅者们投未知 kind：不抛错（套件没崩），插件级订阅者原样还在',
    w.liveBus.listeners.size === 1)
}

console.log('')
console.log('== 卸载：订阅跟着 effect 摘走 ==')
{
  for (const dispose of w.disposers) dispose()
  ok('全部 effect 卸载后 liveBus 上没有订阅者了', w.liveBus.listeners.size === 0)
}

if (failed > 0) {
  console.error('gp54-client: ' + String(failed) + ' check(s) failed')
  process.exit(1)
}
