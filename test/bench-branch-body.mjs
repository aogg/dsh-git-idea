/* ── 性能基准：300 个分支的切换器 ──

   跑法：node test/bench-branch.mjs
         GP_SRC=<旧版 client.js> node test/bench-branch.mjs
   输出：列表 DOM 节点、分支行数、稳定后单遍重渲染耗时，以及
         「鼠标扫过一行」之后的单遍重渲染耗时与 memo 命中次数。 */

const COUNT = 300
const manyBranches = []
for (let i = 0; i < COUNT; i += 1) {
  manyBranches.push({
    name: 'feature/branch-' + String(i),
    current: i === 0,
    committedAt: nowSec - i * 3600,
    upstream: i % 4 === 0 ? 'origin/feature/branch-' + String(i) : '',
    track: i % 4 === 0 ? '>' : '',
    ahead: i % 4 === 0 ? i % 5 : 0,
    behind: 0,
    head: 'h' + String(i),
    subject: 'tip of branch ' + String(i),
  })
}
const realBranches = host.call
host.call = function (method, args) {
  if (method === 'git/branches') {
    calls.push({ method, args })
    return Promise.resolve({ ok: true, repo: '/tmp/ws', current: 'feature/branch-0', previous: '', branches: manyBranches, remotes: [] })
  }
  return realBranches.call(host, method, args)
}

await openSwitcher()
const label = 'bench-branch'
const element = makeElement(popover, { sessionId: 's-1' })
await renderUntilStable(element, label)
await wait(20)
const tree = await renderUntilStable(element, label)

const branchRowEls = rows(tree).filter((r) => String(r.props.className).indexOf('dsh-git-bs-row') >= 0)
const timePasses = function (rounds) {
  let total = 0
  for (let i = 0; i < rounds; i += 1) {
    const t = process.hrtime.bigint()
    renderRoot(element, label)
    total += Number(process.hrtime.bigint() - t) / 1e6
  }
  return total / rounds
}

const idle = timePasses(20)

/* 鼠标从第 3 行扫到第 12 行：每一行都会 setIndex，真实使用里就是连续重渲染 */
const before = memoSkips
for (let i = 3; i < 12; i += 1) {
  const node = branchRowEls[i]
  if (node !== undefined) node.props.onMouseEnter({ currentTarget: { offsetTop: i * 30 }, button: 0 })
  renderRoot(element, label)
}
const hover = timePasses(20)
const skips = memoSkips - before

console.log('  源文件        ' + String(process.env.GP_SRC || 'dist/client.js'))
console.log('  分支数        ' + COUNT)
console.log('  DOM 节点      ' + collect(tree).length)
console.log('  分支行        ' + branchRowEls.length)
console.log('  单遍渲染      ' + idle.toFixed(3) + 'ms')
console.log('  扫过 9 行后   ' + hover.toFixed(3) + 'ms  （memo 命中 ' + skips + ' 次）')
