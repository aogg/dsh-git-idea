/* ── 性能基准：200 个提交的历史列表 ──

   跑法：node test/bench.mjs
         GP_SRC=<旧版 client.js> node test/bench.mjs     （对比重构前后）
   输出：无高度信息（回退到全量渲染）与 600px 视口（窗口化）两组：
         首次打开耗时、DOM 节点数、渲染行数、SVG 路径数，以及
         面板稳定之后单遍重渲染的耗时。 */

const COUNT = 200
const many = []
for (let i = 0; i < COUNT; i += 1) {
  many.push({
    hash: 'h' + String(i).padStart(6, '0'),
    subject: 'commit number ' + String(i) + ' with a reasonably long subject line',
    author: i % 3 === 0 ? 'mays' : 'jiangzx',
    date: '2026-09-16',
    committedAt: nowSec - i * 60,
    refs: i === 0 ? ['HEAD -> dev'] : (i % 40 === 0 ? ['tag: v' + String(i)] : []),
  })
}
const manyRows = []
for (let i = 0; i < COUNT; i += 1) {
  manyRows.push({ lane: 0, edges: i + 1 < COUNT ? [{ hash: 'h' + String(i + 1).padStart(6, '0'), lane: 0 }] : [] })
}
graphCommits = many
const realGraph = host.call
host.call = function (method, args) {
  if (method === 'git/graph') {
    calls.push({ method, args })
    return Promise.resolve({ ok: true, repo: '/tmp/ws', ref: 'main', currentBranch: 'main', commits: many, rows: manyRows, lanes: 1 })
  }
  return realGraph.call(host, method, args)
}

/* 先把面板点开，否则它是隐藏的、什么都不读 */
await openPanel()

/* 视口：0 = 页面不肯说高度（窗口化之前的行为），600 = 真实滚动容器 */
async function measureRun(viewport) {
  const label = 'bench-' + String(viewport)
  fakeNode.clientHeight = viewport
  fakeNode.scrollTop = 0
  const element = makeElement(popover, { sessionId: 's-1' })
  const t0 = process.hrtime.bigint()
  let tree = await renderUntilStable(element, label)
  await wait(20)
  tree = await renderUntilStable(element, label)
  const openMs = Number(process.hrtime.bigint() - t0) / 1e6

  /* 稳定之后量单遍重渲染：一次 renderRoot 就是一遍组件树，不受 settle 圈数影响 */
  let pass = 0
  for (let i = 0; i < 20; i += 1) {
    const t = process.hrtime.bigint()
    renderRoot(element, label)
    pass += Number(process.hrtime.bigint() - t) / 1e6
  }

  return {
    open: openMs,
    pass: pass / 20,
    nodes: collect(tree).length,
    rows: byClass(tree, 'dsh-git-crow').length,
    paths: collect(tree).filter((n) => n.type === 'path').length,
  }
}

const full = await measureRun(0)
const win = await measureRun(600)

/* 点一个提交：选中态变了，理想情况下只重画两行 */
fakeNode.scrollTop = 0
const selectElement = makeElement(popover, { sessionId: 's-1' })
let selectTree = await renderUntilStable(selectElement, 'bench-select')
await wait(20)
selectTree = await renderUntilStable(selectElement, 'bench-select')
const clickable = byClass(selectTree, 'dsh-git-crow')
const beforeSkips = memoSkips
clickable[2].props.onClick()
await wait(5)
let selectMs = 0
for (let i = 0; i < 10; i += 1) {
  const t = process.hrtime.bigint()
  renderRoot(selectElement, 'bench-select')
  selectMs += Number(process.hrtime.bigint() - t) / 1e6
}

/* 滚到深处：仍然只画视口里的行，而且首行要对得上 */
fakeNode.scrollTop = 2600
const scrolled = await renderUntilStable(makeElement(popover, { sessionId: 's-1' }), 'bench-2600')
const scrolledRows = byClass(scrolled, 'dsh-git-crow')
const pads = collect(scrolled).filter((n) => n.props && n.props.style && typeof n.props.style.height === 'string' && n.type === 'div' && n.props.style.height !== '26px')

const row = (label, m) => console.log('  ' + label.padEnd(14) + String(m.open.toFixed(1)).padStart(7) + 'ms' + String(m.nodes).padStart(7) + String(m.rows).padStart(7) + String(m.paths).padStart(7) + String(m.pass.toFixed(3)).padStart(9) + 'ms')
console.log('  源文件          ' + String(process.env.GP_SRC || 'dist/client.js'))
console.log('  ' + ''.padEnd(14) + '首次打开'.padStart(9) + '节点'.padStart(6) + '提交行'.padStart(6) + '路径'.padStart(6) + '单遍渲染'.padStart(11))
row('无高度信息', full)
row('600px 视口', win)
console.log('  选中一个提交后：单遍 ' + (selectMs / 10).toFixed(3) + 'ms，memo 命中 ' + String(memoSkips - beforeSkips) + ' 次（视口内 ' + clickable.length + ' 行）')
console.log('  滚到 2600px：渲染 ' + scrolledRows.length + ' 行，首行 = ' + String(textOf(scrolledRows[0]).slice(0, 18)) + '，占位块 ' + pads.length + ' 个')
