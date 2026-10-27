/* ── gp69 / gp70 共用的客户端测试环境 ──
 *
 * 这两场要测的东西（98-register 的 window 监听、02-toast 的纯 DOM、05-telemetry
 * 的 document/localStorage 降级与 fetch 批量上传）都要求「document / window 在
 * 插件 apply 之前就位」——它们是 ctx.effect 在 apply 时注册的，胶合套件的公用
 * harness（gp37-harness.part）装完才轮到 body，赶不上这一趟。所以照 gp34b 的
 * 先例：独立求值、环境自带 —— 迷你 React + 一只够用的假 document（可造元素、
 * body 可插拔子节点、事件可手工派发）+ 假 window（监听可枚举、翻账口子可见）+
 * 定时器双轨（ctx.timer 服务给面板动效与 telemetry 节流；toast 用的是裸
 * setTimeout，走另一条手工队列）+ fetch 桩（应答由用例手工放行）。
 *
 * 客户端源按 GP_SRC 约定读（run-all 的 GP_FRESH 场合给的是现拼的 client 半），
 * 经 new Function 以参数名遮蔽 document / window / fetch / setTimeout —— 参数
 * 在就是「有」，显式传 undefined 就是「没有」，降级路因此可测。
 */

export function makeEnv(options) {
  const opts = options == null ? {} : options
  const withDoc = opts.document !== false
  const withWindow = opts.window !== false
  const withFetch = opts.fetch === true

  /* ── 假 DOM：createElement 出来的元素挂在真容器上才谈得上 isConnected / contains ── */
  function makeElementNode(tag) {
    return {
      nodeName: String(tag).toUpperCase(),
      className: '',
      children: [],
      parentNode: null,
      isConnected: true,
      ownerDocument: null,
      textContent: '',
      title: '',
      _listeners: {},
      appendChild(child) { child.parentNode = this; this.children.push(child); return child },
      insertBefore(child, ref) {
        const at = this.children.indexOf(ref)
        child.parentNode = this
        if (at < 0) this.children.push(child)
        else this.children.splice(at, 0, child)
        return child
      },
      removeChild(child) {
        const at = this.children.indexOf(child)
        if (at >= 0) this.children.splice(at, 1)
        child.parentNode = null
        return child
      },
      get firstChild() { return this.children.length > 0 ? this.children[0] : null },
      get lastChild() { return this.children.length > 0 ? this.children[this.children.length - 1] : null },
      contains(target) {
        for (let at = target; at != null; at = at.parentNode) { if (at === this) return true }
        return false
      },
      addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn) },
      removeEventListener(name, fn) {
        this._listeners[name] = (this._listeners[name] || []).filter(function (one) { return one !== fn })
      },
      fire(name, event) { (this._listeners[name] || []).slice().forEach(function (fn) { fn(event) }) },
    }
  }

  const store = {}
  const storeWrites = []
  const fakeDoc = makeElementNode('#document')
  fakeDoc.body = makeElementNode('body')
  fakeDoc.head = makeElementNode('head')
  fakeDoc.ownerDocument = null
  fakeDoc.visibilityState = 'visible'
  fakeDoc.createElement = function (tag) {
    const node = makeElementNode(tag)
    node.ownerDocument = fakeDoc
    return node
  }
  fakeDoc.defaultView = {
    innerWidth: 1400,
    innerHeight: 900,
    localStorage: {
      getItem: function (key) { return key in store ? store[key] : null },
      setItem: function (key, value) { storeWrites.push({ key: key, value: String(value) }); store[key] = String(value) },
    },
  }
  fakeDoc.addEventListener = makeElementNode('_doc').addEventListener
  fakeDoc.removeEventListener = makeElementNode('_doc').removeEventListener
  /* 事件要能派发到 document 级监听上（94-popover 的 outside/esc 挂在
     ownerDocument —— 测试里那正是这只假 doc）。 */
  const docListeners = {}
  fakeDoc.addEventListener = function (name, fn) { (docListeners[name] = docListeners[name] || []).push(fn) }
  fakeDoc.removeEventListener = function (name, fn) { docListeners[name] = (docListeners[name] || []).filter(function (one) { return one !== fn }) }
  fakeDoc.fire = function (name, event) { (docListeners[name] || []).slice().forEach(function (fn) { fn(event) }) }

  const windowListeners = {}
  const fakeWindow = {
    addEventListener: function (name, fn) { (windowListeners[name] = windowListeners[name] || []).push(fn) },
    removeEventListener: function (name, fn) { windowListeners[name] = (windowListeners[name] || []).filter(function (one) { return one !== fn }) },
    fire: function (name, event) { (windowListeners[name] || []).slice().forEach(function (fn) { fn(event) }) },
  }
  /* react-dom 在真包里才拿得到；测试给一只假门：portal 元素原样透传，渲染器
     认得 $$portal 就把 children 画进当前容器。 */
  fakeWindow.ReactDOM = {
    createPortal: function (children, host) { return { $$portal: true, props: { children: children }, host: host } },
  }

  /* ── ctx.timer 服务的桩：面板动效、telemetry 的 1s 镜像 / 4s 攒批 / 退避都走它 ── */
  const timers = []
  const timerService = {
    interval: function (cb, delay) { const t = { kind: 'interval', cb: cb, delay: delay, dead: false }; timers.push(t); return function () { t.dead = true } },
    timeout: function (cb, delay) { const t = { kind: 'timeout', cb: cb, delay: delay, dead: false }; timers.push(t); return function () { t.dead = true } },
  }
  function fireTimers(delay) {
    const list = timers.filter(function (t) { return t.kind === 'timeout' && t.dead !== true && (delay === undefined || t.delay === delay) })
    for (const t of list) { t.dead = true; t.cb() }
  }
  function pendingTimers() {
    return timers.filter(function (t) { return t.kind === 'timeout' && t.dead !== true })
  }

  /* ── 裸 setTimeout 的桩：02-toast 的自动收 / 悬停收走的是全局时钟，与服务桩分开记 ── */
  const rawTimers = new Map()
  let rawSeq = 0
  const fakeSetTimeout = function (cb, delay) {
    rawSeq += 1
    rawTimers.set(rawSeq, { cb: cb, delay: delay })
    return rawSeq
  }
  const fakeClearTimeout = function (id) { rawTimers.delete(id) }
  function fireRawTimers(delay) {
    const hits = []
    for (const row of rawTimers) {
      if (delay === undefined || row[1].delay === delay) hits.push(row[0])
    }
    for (const id of hits) {
      const t = rawTimers.get(id)
      rawTimers.delete(id)
      if (t !== undefined) t.cb()
    }
    return hits.length
  }
  function rawTimersWith(delay) {
    const out = []
    for (const row of rawTimers) { if (delay === undefined || row[1].delay === delay) out.push(row[1]) }
    return out
  }

  /* ── fetch 桩：请求记下、应答由用例手工放行（telemetry 的批/限频/退避都吃它）── */
  const fetchCalls = []
  const fakeFetch = function (path, init) {
    const call = { path: path, init: init }
    fetchCalls.push(call)
    return new Promise(function (resolve, reject) { call.resolve = resolve; call.reject = reject })
  }

  /* ── console 桩：crash 走 error、watchdog 走 warn，记账断言在这里翻 ── */
  const consoleLines = []
  const consoleSpy = {
    log: function () {},
    info: function () {},
    warn: function () { consoleLines.push({ level: 'warn', args: Array.prototype.slice.call(arguments) }) },
    error: function () { consoleLines.push({ level: 'error', args: Array.prototype.slice.call(arguments) }) },
  }

  /* ── 假 liveBus：98-register 的连接与订阅 effect 认它 ── */
  const liveSubs = []
  const liveBusCalls = []
  const liveBus = {
    open: function () { liveBusCalls.push('open') },
    close: function () { liveBusCalls.push('close') },
    subscribe: function (cb) { liveSubs.push(cb); return function () { const at = liveSubs.indexOf(cb); if (at >= 0) liveSubs.splice(at, 1) } },
  }

  /* ── 迷你 React（gp37-harness 同源）+ 槽位捕捉 ── */
  const fibers = new Map()
  let currentFiber = null
  let dirty = false
  function makeElement(type, props) {
    const rest = []
    for (let i = 2; i < arguments.length; i += 1) rest.push(arguments[i])
    const merged = Object.assign({}, props)
    if (opts.arrayByRef === true && rest.length === 1 && Array.isArray(rest[0])) {
      /* React 同款语义：children 是单个数组实参时，children 就是那个数组本身 ——
         元素创建之后再 rows.push(...) 对渲染可见（25-worktree.js 的 withTail 先
         h(box, rows) 再塞动作行，靠的正是这个）。展开语义留给其余套件。 */
      merged.children = rest[0]
    } else {
      const children = []
      for (const one of rest) {
        if (one === null || one === undefined || one === false || one === true) continue
        if (Array.isArray(one)) { for (const kid of one) children.push(kid); continue }
        children.push(one)
      }
      merged.children = children
    }
    return { type: type, key: merged.key === undefined ? null : merged.key, props: merged }
  }
  const React = {
    createElement: makeElement,
    memo: function (component) { return { $$memo: true, render: component } },
    useCallback: function (fn, deps) {
      const fiber = currentFiber
      const index = fiber.cursor
      fiber.cursor += 1
      const previous = fiber.memos[index]
      if (previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps)
        && deps.length === previous.deps.length && deps.every(function (d, i) { return d === previous.deps[i] })) return previous.fn
      fiber.memos[index] = { deps: deps, fn: fn }
      return fn
    },
    useMemo: function (factory) { return factory() },
    useState: function (initial) {
      const fiber = currentFiber
      const index = fiber.cursor
      fiber.cursor += 1
      if (fiber.hooks.length <= index) fiber.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setter = function (next) {
        const value = typeof next === 'function' ? next(fiber.hooks[index]) : next
        if (fiber.hooks[index] !== value) { fiber.hooks[index] = value; dirty = true }
      }
      return [fiber.hooks[index], setter]
    },
    useEffect: function (effect, deps) {
      const fiber = currentFiber
      const index = fiber.cursor
      fiber.cursor += 1
      const previous = fiber.effects[index]
      const same = previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps)
        && deps.length === previous.deps.length && deps.every(function (d, i) { return d === previous.deps[i] })
      if (same === true) return
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      fiber.effects[index] = { deps: deps, cleanup: undefined }
      fiber.pending.push(function () {
        const cleanup = effect()
        fiber.effects[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined
      })
    },
    /* 真包里 GitCrashBoundary 是 class；迷你渲染器不跑类实例，但构造出这个记号
       （function 就行）让它走真护栏那一支，用例才能把类提取出来直驱。 */
    Component: function Component() {},
  }
  /* 直驱护栏类方法时用得上 setState（componentDidCatch / componentDidUpdate 都调它）。 */
  React.Component.prototype.setState = function (update) {
    const patch = typeof update === 'function' ? update(this.state) : update
    if (patch != null) Object.assign(this.state, patch)
  }

  const registered = []
  const slots = {
    inject: function (key, cb) { return cb() },
    register: function (o, c) { registered.push({ options: o, component: c }); return function () {} },
  }
  const ctx = {
    get: function (name) {
      if (name === 'slots') return slots
      if (name === 'timer') return timerService
      return undefined
    },
    effect: function (cb) { const d = cb(); return typeof d === 'function' ? d : function () {} },
  }

  /* host 桩：面板一开就是一串读数，罐头答齐（gp37-harness 同一份的窄版）。 */
  const calls = []
  const nowSec = Math.floor(Date.now() / 1000)
  const host = {
    call: function (method, args) {
      calls.push({ method: method, args: args })
      if (method === 'git/panel') return Promise.resolve({ ok: true, repo: '/tmp/ws', branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, sequencer: null, staged: [], unstaged: [], untracked: [], unmerged: [] })
      if (method === 'git/branches') return Promise.resolve({ ok: true, repo: '/tmp/ws', current: 'main', previous: '', branches: [{ name: 'main', current: true, committedAt: nowSec - 5, upstream: 'origin/main', track: '=', ahead: 0, behind: 0, head: 'aaa', subject: 'tip main' }], remotes: [] })
      if (method === 'git/refs') return Promise.resolve({ ok: true, repo: '/tmp/ws', current: ['main'], local: [{ segments: ['main'], data: 'main' }], remote: [] })
      if (method === 'git/worktrees') return Promise.resolve({ ok: true, repo: '/tmp/ws', worktrees: [] })
      if (method === 'git/graph') return Promise.resolve({ ok: true, repo: '/tmp/ws', ref: 'main', currentBranch: 'main', commits: [], rows: [], lanes: 1 })
      if (method === 'git/authors') return Promise.resolve({ ok: true, repo: '/tmp/ws', authors: [{ name: 'mays', email: 'm@example.com', count: 1 }] })
      if (method === 'git/watch') return Promise.resolve({ ok: true, repo: '/tmp/ws', sig: 'SIG' })
      if (method === 'git/config') return Promise.resolve({ ok: true, path: '/home/u/.dsh/dsh-git-idea.json', config: {} })
      if (method === 'git/repo-applied') return Promise.resolve({ ok: true, workspace: '/tmp/ws', repo: '' })
      if (method === 'git/repo-applied-save') return Promise.resolve({ ok: true, workspace: '/tmp/ws', repo: '', unchanged: true })
      return Promise.resolve({ ok: true, repo: '/tmp/ws', stdout: '', stderr: '', exitCode: 0 })
    },
  }
  const styles = { insert: function () { return function () {} } }

  /* ── 渲染器：函数组件 + portal 透传；class 元素记下类型当不透明叶子（只为
     提取 GitCrashBoundary 的类引用，不渲染它）── */
  const capturedClasses = []
  const isClass = function (type) {
    return typeof type === 'function' && type.prototype != null
      && String(type).indexOf('class ') === 0
  }
  const textOf = function (node) {
    if (node === null || node === undefined) return ''
    if (typeof node === 'string') return node
    if (typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (node.$$portal === true) return textOf(node.props.children)
    if (node.props === undefined) return ''
    return textOf(node.props.children)
  }
  function collect(node, out) {
    if (node == null || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const one of node) collect(one, out); return out }
    out.push(node)
    const kids = node.props != null && Array.isArray(node.props.children) ? node.props.children : []
    for (const kid of kids) collect(kid, out)
    return out
  }
  const byClass = function (tree, name) {
    return collect(tree, []).filter(function (n) {
      return n.props != null && typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(name) >= 0
    })
  }
  /* 按元素类型找（datalist 一类没有 className，byClass 认不到）。 */
  const byTag = function (tree, tag) {
    return collect(tree, []).filter(function (n) { return n.type === tag })
  }
  const buttonsOf = function (tree) { return collect(tree, []).filter(function (n) { return n.type === 'button' }) }
  const inputsOf = function (tree) { return collect(tree, []).filter(function (n) { return n.type === 'input' }) }

  /* ref 派发：与 gp37-harness 同一套类名认路 —— 面板根（dsh-git-pop）给一只
     用例攥得住的节点对象，isConnected 拨成 false 就是「树崩/被摘」。
     document 不在的降级场（gp70 第 11 节）里节点没有 ownerDocument：真页面没有
     document 就不会有 DOM 节点可派 ref，localStore 也就拿不到存储 —— 这正是
     「不碰存储」那条断言要的降级，不能靠假 doc 白送一只 localStorage。 */
  const nodeDoc = withDoc ? fakeDoc : null
  const panelNodeObj = { ownerDocument: nodeDoc, isConnected: true, contains: function () { return false }, offsetWidth: 900, offsetHeight: 600 }
  const chipNodeObj = { ownerDocument: nodeDoc, isConnected: true, contains: function () { return false } }
  const cardNodeObj = { ownerDocument: nodeDoc, isConnected: true, contains: function () { return false } }
  const INSIDE = { nodeType: 1, name: 'inside-panel', ownerDocument: fakeDoc }
  const IN_CARD = { nodeType: 1, name: 'inside-card', ownerDocument: fakeDoc }
  const IN_CHIP = { nodeType: 1, name: 'inside-chip', ownerDocument: fakeDoc }
  const OUTSIDE = { nodeType: 1, name: 'outside', ownerDocument: fakeDoc }
  panelNodeObj.contains = function (t) { return t === INSIDE }
  cardNodeObj.contains = function (t) { return t === IN_CARD }
  chipNodeObj.contains = function (t) { return t === IN_CHIP }

  function renderRoot(element, label) {
    const pending = []
    const seen = new Set()
    function render(node, path) {
      if (node === null || node === undefined) return null
      if (typeof node === 'string' || typeof node === 'number') return node
      if (Array.isArray(node)) return node.map(function (c, i) { return render(c, path + '.' + i) })
      if (node.$$portal === true) return render(node.props.children, path + '/portal')
      const type = node.type
      if (type != null && typeof type === 'object' && type.$$memo === true) {
        return render({ type: type.render, props: node.props, key: node.key }, path)
      }
      if (typeof type === 'function' && isClass(type)) {
        /* 类（护栏）：迷你渲染器不实例化它，但必须透传 children —— 面板根、
           ref 派发、outside-close 的节点账都在这棵子树里；类型记下来给直驱用。 */
        capturedClasses.push(type)
        const kids = (node.props.children || []).map(function (c, i) { return render(c, path + '/guard/' + i) })
        return { type: 'div', key: node.key, props: { className: 'class-guard', children: kids } }
      }
      if (typeof type !== 'function') {
        const kids = (node.props.children || []).map(function (c, i) { return render(c, path + '/' + i) })
        const out = { type: type, key: node.key, props: Object.assign({}, node.props, { children: kids }) }
        if (typeof node.props.ref === 'function') {
          const cls = String(node.props.className || '')
          let target = null
          if (cls.indexOf('dsh-git-pop') >= 0) target = panelNodeObj
          else if (cls.indexOf('dsh-git-chip') >= 0) target = chipNodeObj
          else if (cls.indexOf('dsh-git-switch') >= 0) target = cardNodeObj
          if (target !== null) node.props.ref(target)
        }
        return out
      }
      const fiberKey = path + '#' + (type.name || 'anon') + '#' + (node.key === null ? '' : node.key)
      let fiber = fibers.get(fiberKey)
      if (fiber === undefined) { fiber = { hooks: [], memos: [], effects: [], cursor: 0, pending: [] }; fibers.set(fiberKey, fiber) }
      seen.add(fiberKey)
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
    for (const fiber of pending) { for (const job of fiber.pending.splice(0)) job() }
    /* 卸载语义：真 React 里从树上消失的组件随之销毁，状态（hooks）在下次挂载
       时从头开始 —— 25-worktree.js 的「每次展开都是一张新表单，值不跨开合保留」
       正靠这个。迷你渲染器原先只增不删，表单收起再展开会带着上一轮的
       name/manualPath 回来，整段状态链因此错位。这里按「根」清账：本次 render
       没走到的 fiber 一律删掉（连同它的 effect 清账），下次挂载就是新组件。
       只删同一个 label 根下的 —— chip 与 popover 是两只独立挂载的槽位，各自
       渲染一次时不能把对方当成「已卸载」。 */
    const prefix = String(label)
    const doomed = []
    for (const key of fibers.keys()) {
      if (key.slice(0, prefix.length) !== prefix) continue
      const sep = key.charAt(prefix.length)
      if (sep !== '#' && sep !== '/') continue
      if (seen.has(key) !== true) doomed.push(key)
    }
    for (const key of doomed) {
      const fiber = fibers.get(key)
      fibers.delete(key)
      for (let i = fiber.effects.length - 1; i >= 0; i -= 1) {
        const cleanup = fiber.effects[i] != null ? fiber.effects[i].cleanup : undefined
        if (typeof cleanup === 'function') { try { cleanup() } catch (error) { /* 卸载清账不碍事 */ } }
      }
    }
    return tree
  }
  async function renderUntilStable(element, label) {
    let tree = null
    for (let i = 0; i < 40; i += 1) {
      dirty = false
      tree = renderRoot(element, label)
      await new Promise(function (r) { setTimeout(r, 0) })
      if (dirty === false) return tree
    }
    throw new Error('render did not settle for ' + label)
  }
  const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 10) }) }

  /* ── 应用插件：参数名遮蔽环境符号，「传 undefined」就是「没有」── */
  function apply(src) {
    /* gp37-harness 同款：client.js 的求值结果就是 apply 函数，用 this=ctx 调它。 */
    new Function('ctx', 'React', 'host', 'styles', 'console', 'document', 'window', 'fetch',
      'liveBus', 'setTimeout', 'clearTimeout', src)(
      ctx, React, host, styles, consoleSpy,
      withDoc ? fakeDoc : undefined,
      withWindow ? fakeWindow : undefined,
      withFetch ? fakeFetch : undefined,
      liveBus, fakeSetTimeout, fakeClearTimeout).apply(ctx)
    return {
      chip: (registered.find(function (r) { return r.options.id === 'dsh-git-idea-chip' }) || {}).component,
      popover: (registered.find(function (r) { return r.options.id === 'dsh-git-idea-panel' }) || {}).component,
    }
  }

  return {
    opts: opts,
    apply: apply,
    React: React,
    ctx: ctx,
    host: host,
    calls: calls,
    fibers: fibers,
    registered: registered,
    makeElement: makeElement,
    renderRoot: renderRoot,
    renderUntilStable: renderUntilStable,
    wait: wait,
    textOf: textOf,
    byClass: byClass,
    byTag: byTag,
    buttonsOf: buttonsOf,
    inputsOf: inputsOf,
    capturedClasses: capturedClasses,
    fakeDoc: fakeDoc,
    fakeWindow: fakeWindow,
    windowListeners: windowListeners,
    docListeners: docListeners,
    store: store,
    storeWrites: storeWrites,
    panelNodeObj: panelNodeObj,
    chipNodeObj: chipNodeObj,
    cardNodeObj: cardNodeObj,
    INSIDE: INSIDE,
    IN_CARD: IN_CARD,
    IN_CHIP: IN_CHIP,
    OUTSIDE: OUTSIDE,
    timers: timers,
    fireTimers: fireTimers,
    pendingTimers: pendingTimers,
    rawTimers: rawTimers,
    fireRawTimers: fireRawTimers,
    rawTimersWith: rawTimersWith,
    fetchCalls: fetchCalls,
    consoleLines: consoleLines,
    liveBus: liveBus,
    liveBusCalls: liveBusCalls,
    liveSubs: liveSubs,
  }
}
