/* ── 面板与悬停卡片在会话滚动体里的真实上界（hero 相位显示不全的回归）──
 *
 * 根因（见 src/client/14-geometry.js 头注释）：面板和 chip 悬停卡片都 absolute 挂在
 * 输入框卡片上沿、向上生长，而输入框整棵子树住在会话滚动体（overflow-y:auto）里；
 * 滚动容器只会向下扩展可滚动区域，超出滚动体上沿的部分永远滚不回来。15ab5a3 按
 * 「视口上沿」钳高，hero 相位（新会话输入框垂直居中）面板顶被推到视口顶附近，整条
 * 头部恰好落在滚动体上沿之上被裁 —— 显示不全。
 *
 * 这一套用假的祖先链（有 rect、有 computedStyle.overflowY 的纯对象）把官方那几层
 * 结构摆出来，断言三件事：
 *   1. hero：钳制的上界是滚动体的可见上沿，不是视口上沿 —— 面板顶必须落在它之下；
 *   2. 跟随：rAF 循环里锚点和上界一起量，相位切换（居中→落底）、滚动体位移、多道
 *      裁剪祖先（取最靠下的一道）都实时跟着变；
 *   3. 退路：上界一环都量不到（没有 getComputedStyle）时退回视口上沿 —— 即 15ab5a3
 *      的旧边界，不比它更差。
 * 悬停卡片同款：钳出来的空间写成 maxHeight（列表自己滚），空间小到会压碎卡片就不钳。
 * 乘法口诀：availH = 锚点上沿 − 8(间距) − 1(余量) − 上界。 */

const fakeView = fakeDoc.defaultView
fakeView.getComputedStyle = function (node) {
  return {
    overflowY: node.__overflowY !== undefined ? node.__overflowY : 'visible',
    borderTopWidth: (node.__borderTop != null ? node.__borderTop : 0) + 'px',
  }
}
let rafQueue = []
fakeView.requestAnimationFrame = function (cb) { rafQueue.push(cb); return rafQueue.length }
fakeView.cancelAnimationFrame = function (id) { rafQueue[id - 1] = null }
const fireFrame = function () {
  const queue = rafQueue
  rafQueue = []
  for (const cb of queue) if (typeof cb === 'function') cb()
}
const fireTimers = function (delay) {
  for (const t of timers) {
    if (t.kind === 'timeout' && !t.dead && (delay === undefined || t.delay === delay)) { t.dead = true; t.cb() }
  }
}

/* 假的祖先链：面板 ← 0×0 的 auto 层（display:contents 那类，必须被跳过）
   ← visible 行 ← 会话滚动体（auto，可见上沿 scrollTop）← 根（visible/hidden）。
   元素都带 ownerDocument —— clipCeiling 靠它找到 getComputedStyle 的 window。 */
let anchorTop = 400
let scrollTop = 76
let rootTop = 0
let rootClip = 'visible'
const anchorObj = { ownerDocument: fakeDoc, getBoundingClientRect: () => ({ top: anchorTop, left: 100, width: 760, height: 0 }) }
const zeroBox = { ownerDocument: fakeDoc, __overflowY: 'auto', getBoundingClientRect: () => ({ top: 0, width: 0, height: 0 }) }
const rowBox = { ownerDocument: fakeDoc, __overflowY: 'visible', getBoundingClientRect: () => ({ top: 60, width: 1000, height: 700 }) }
const scrollBody = { ownerDocument: fakeDoc, __overflowY: 'auto', getBoundingClientRect: () => ({ top: scrollTop, width: 1000, height: 824 }) }
const rootBox = { ownerDocument: fakeDoc, get __overflowY() { return rootClip }, getBoundingClientRect: () => ({ top: rootTop, width: 1400, height: 900 }) }
zeroBox.parentElement = rowBox
rowBox.parentElement = scrollBody
scrollBody.parentElement = rootBox
/* 生产里：面板的定位祖先是卡片顶的零高锚点；chip 的定位祖先是输入框卡片（同一个
   上沿）。测试里两者共用 anchorObj —— 钳制只读它的 top。chip 自己也在滚动体里，
   parentElement 接同一条祖先链。 */
panelNodeObj.offsetParent = anchorObj
panelNodeObj.parentElement = zeroBox
chipNodeObj.offsetParent = anchorObj
chipNodeObj.parentElement = rowBox

const popOf = (tree) => byClass(tree, 'dsh-git-pop')[0]
const heightOf = (tree) => {
  const pop = popOf(tree)
  const style = pop !== undefined ? pop.props.style : undefined
  return style != null && style.height !== undefined ? parseFloat(style.height) : null
}
async function closePanel() {
  const t = await chipTree()
  if (t.props.className.indexOf('dsh-git-chip-open') >= 0) { t.props.onClick(); await wait(10) }
  return await chipTree()
}

console.log('')
console.log('== hero 相位：钳制的上界是滚动体上沿，不是视口上沿 ==')
let tree = await openPanel()
ok('面板打开着', popOf(tree) !== undefined && String(popOf(tree).props.className).indexOf('dsh-git-hidden') < 0)
ok('高度 = 400−8−1−76 = 315（15ab5a3 的旧边界给 391，头部会整体越过滚动体上沿）', heightOf(tree) === 315)
ok('面板顶（锚点−8−高）落在滚动体上沿之下：400−8−315=77 ≥ 76', 400 - 8 - 315 >= 76)

console.log('')
console.log('== 相位切换（居中→落底）：rAF 一帧内跟上，且空间够时不再钳 ==')
anchorTop = 760
fireFrame()
tree = await settle()
ok('锚点落到 760 后，余量 675 ≥ 期望 666，高度交还 CSS（不写 inline）', heightOf(tree) === null)

console.log('')
console.log('== 滚动体自己的位移：上界跟着量 ==')
scrollTop = 120
anchorTop = 700
fireFrame()
tree = await settle()
ok('高度 = 700−8−1−120 = 571', heightOf(tree) === 571)
ok('面板顶 700−8−571=121 ≥ 120，仍在滚动体内', 700 - 8 - 571 >= 120)

console.log('')
console.log('== 多道裁剪祖先：取最靠下的一道 ==')
rootClip = 'hidden'
rootTop = 200
fireFrame()
tree = await settle()
ok('根（hidden，top 200）比滚动体（120）更靠下，上界取 200：高度 = 700−9−200 = 491', heightOf(tree) === 491)

console.log('')
console.log('== 上界一环都量不到：退回视口上沿（15ab5a3 的行为，不更差）==')
delete fakeView.getComputedStyle
anchorTop = 400
fireFrame()
tree = await settle()
ok('没有 getComputedStyle 时按视口上沿（0）钳：高度 = 400−9 = 391', heightOf(tree) === 391)
fakeView.getComputedStyle = function (node) {
  return {
    overflowY: node.__overflowY !== undefined ? node.__overflowY : 'visible',
    borderTopWidth: (node.__borderTop != null ? node.__borderTop : 0) + 'px',
  }
}
rootClip = 'visible'
rootTop = 0
scrollTop = 76

console.log('')
console.log('== 悬停卡片：同一套上界，钳出来的空间写成 maxHeight ==')
await closePanel()
let chipTreeNow = await chipTree()
chipTreeNow.props.onPointerEnter()
fireTimers(180)
let hover = await settle('pop')
let card = byClass(hover, 'dsh-git-switch-hover')[0]
ok('悬浮 chip 后出现 hover 卡片', card !== undefined)
ok('卡片带着钳制类（.dsh-git-switch-cap）', card !== undefined && String(card.props.className).indexOf('dsh-git-switch-cap') >= 0)
ok('maxHeight = 同一个可见空间 315', card !== undefined && card.props.style != null && card.props.style.maxHeight === '315px')

console.log('')
console.log('== 悬停卡片：收起再悬停按新几何重量 ==')
card.props.onPointerLeave()
fireTimers(200)
/* 收起也要让 popover 看见（mode=null → 钳制松开）：真实 React 里 signal 一通知就
   重画，这个迷你 React 得显式渲染一轮。 */
await settle('pop')
anchorTop = 500
chipTreeNow = await chipTree()
chipTreeNow.props.onPointerEnter()
fireTimers(180)
hover = await settle('pop')
card = byClass(hover, 'dsh-git-switch-hover')[0]
ok('锚点落到 500 后重新量：maxHeight = 500−8−1−76 = 415', card !== undefined && card.props.style != null && card.props.style.maxHeight === '415px')

console.log('')
console.log('== 悬停卡片：空间小到会压碎卡片就不钳 ==')
card.props.onPointerLeave()
fireTimers(200)
await settle('pop')
anchorTop = 250
chipTreeNow = await chipTree()
chipTreeNow.props.onPointerEnter()
fireTimers(180)
hover = await settle('pop')
card = byClass(hover, 'dsh-git-switch-hover')[0]
ok('可见空间只剩 165（< 200）时不钳：没有 cap 类、没有 maxHeight', card !== undefined
  && String(card.props.className).indexOf('dsh-git-switch-cap') < 0
  && (card.props.style == null || card.props.style.maxHeight === undefined))

console.log('')
console.log('== 量不到锚点的环境（无 rect 的测试环境、面板未量过）维持原样 ==')
panelNodeObj.offsetParent = null
panelNodeObj.parentElement = null
chipNodeObj.offsetParent = null
chipNodeObj.parentElement = null
anchorTop = 400
await closePanel()
let chipTreeFresh = await chipTree()
chipTreeFresh.props.onClick()
/* 换个 fiber（label 变了）= 一块全新挂载的面板，等价于其它套件所处的无布局环境：
   锚点从没量到过，state 里的 anchor 保持 null，不写 inline 高度。同一块 fiber 里
   残留的上一次量测是另一回事 —— 真机上打开面板的那一刻必然量得到锚点。 */
tree = await settle('pop-fresh')
ok('锚点量不到 → 不钳制、不写 inline 高度（既有套件依赖的这一路）', heightOf(tree) === null)
