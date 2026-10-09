    /* ── diff3：三方合并的纯函数，与 UI 完全解耦 ──
     *
     * 冲突界面的全部算力都在这一片里：给 base/ours/theirs 三份行数组，产出「哪些
     * 区域三方一致、哪些只有一侧改了、哪些撞成了冲突」的分块（chunks），以及把
     * 分块拼回文本的读法。UI（59-merge.js）只负责把这些块画出来、把读者的决定写
     * 回去 —— 分块算错或拼错的任何一种，单测都能拿这三个数组直接问这片文件。
     *
     * 合成语义照 git 的 xdl_merge（xmerge.c），有一条是拿 git merge-file 逐例对出
     * 来的：两侧改动的 base 区间「贴着也算重叠」，重叠的合成一块冲突，只有隔了至
     * 少一行未动上下文的改动才各自干净落地 —— 相邻两行各改各的、插入紧贴改动区，
     * 命令行 git merge 全部判冲突，界面若自作聪明合成 A、B，读者把它提交上去就会
     * 撞上 git 自己的冲突。分块三步：每侧对 base 做行级对齐 → 由匹配表提成改动
     * hunk（base 区间 × 侧区间，纯插入是 base 空区间）→ 两侧 hunk 按区间分组，
     * 每组按三侧内容分类（只有一侧改 = 那一侧；改得一样 = both；否则冲突）。
     *
     * 行级对齐用的是 patience diff 而不是教科书 LCS 动态规划，是一个刻意的取舍：
     * DP 需要 n×m 的回溯表，一万行对一万行就是一张亿格的表，只为一个合并界面不
     * 值得；patience（公共行里两边都唯一的那些当锚点，对锚点做最长递增子序列，
     * 锚点之间的缝隙递归）内存 O(n)、单调性由构造保证，最坏情况只是把更大的区
     * 域整段算成「改动」—— 对合并语义永远正确，只是块更粗。git 自己的 merge 也
     * 不是追求最小 diff 的那一路。
     *
     * 行数组刻意保留每行末尾的 \r（CRLF 文件按 \n 切开后 \r 留在行里）：split/
     * join 逐字节还原原文，写回时一个字节都不漂移。所有函数都不碰 h/host/React。
     */

    /* 切行。结尾的空串（文本以 \n 收尾时 split 留下的那个）是真实的一行：拼回去
       正好还原结尾换行，「有没有结尾换行」因此不需要任何额外状态。 */
    function merge3SplitLines(content) {
      if (content.length === 0) return []
      return content.split('\n')
    }

    function merge3JoinLines(lines) {
      return lines.join('\n')
    }

    function merge3SameRegion(x, y) {
      if (x.length !== y.length) return false
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false
      return true
    }

    /* ── patience 对齐：a、b 两份行的匹配对（双方下标都严格递增）──
     *
     * 每一层：掐掉公共前后缀（它们直接是匹配对），剩下的在「两边都只出现一次的
     * 行」里挑锚点，对锚点按 a 的顺序求 b 下标的最长递增子序列（patience 扑克
     * 堆，二分，O(n log n)），选中的锚点是匹配对，锚点之间的缝隙再递归。某层一
     * 个锚点都没有就把整层当作「改过」返回 —— 这就是最坏情况的退化形状。 */
    function merge3MatchPairs(a, b) {
      const pairs = []
      merge3MatchRange(a, 0, a.length, b, 0, b.length, pairs)
      return pairs
    }

    function merge3MatchRange(a, ai, aj, b, bi, bj, out) {
      while (ai < aj && bi < bj && a[ai] === b[bi]) { out.push([ai, bi]); ai += 1; bi += 1 }
      const suffix = []
      while (aj > ai && bj > bi && a[aj - 1] === b[bj - 1]) { suffix.push([aj - 1, bj - 1]); aj -= 1; bj -= 1 }
      /* 锚点：行内容在 b 这一段里唯一，在 a 这一段里也唯一。两个唯一合起来，锚点
         对按 a 排序后 a 下标天然严格递增，LIS 只需要管 b 下标。唯一行的位置顺手
         记成一张表 —— 每个锚点一次 O(n) 的 indexOf 会把整个对齐拖回平方。 */
      const count = new Map()
      for (let j = bi; j < bj; j += 1) count.set(b[j], (count.get(b[j]) || 0) + 1)
      const uniqueB = new Map()
      count.forEach(function (times, line) {
        if (times === 1) uniqueB.set(line, b.indexOf(line, bi))
      })
      const anchors = []
      const seen = new Map()
      for (let i = ai; i < aj; i += 1) {
        if (seen.has(a[i])) continue
        const at = uniqueB.get(a[i])
        if (at === undefined) continue
        /* a 侧唯一性这里补上：同一行在 a 出现两次时只认第一处，确定性优先。 */
        seen.set(a[i], true)
        anchors.push([i, at])
      }
      if (anchors.length > 0) {
        /* LIS（patience）：piles[k] = 以「长度 k+1 的递增链」结尾的锚点下标；
           back 记每个锚点的前驱，收尾回溯出整条链。 */
        const piles = []
        const back = new Array(anchors.length)
        for (let k = 0; k < anchors.length; k += 1) {
          const value = anchors[k][1]
          let lo = 0
          let hi = piles.length
          while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (anchors[piles[mid]][1] < value) lo = mid + 1
            else hi = mid
          }
          back[k] = lo > 0 ? piles[lo - 1] : -1
          if (lo === piles.length) piles.push(k)
          else piles[lo] = k
        }
        const chosen = []
        for (let k = piles.length > 0 ? piles[piles.length - 1] : -1; k >= 0; k = back[k]) chosen.push(k)
        chosen.reverse()
        /* 缝隙递归：相邻两个选中锚点之间（以及开头到第一个、最后一个到结尾）。
           锚点自身已被消费，递归区间严格变小，不会打转。 */
        let prevA = ai
        let prevB = bi
        for (let k = 0; k < chosen.length; k += 1) {
          const pair = anchors[chosen[k]]
          merge3MatchRange(a, prevA, pair[0], b, prevB, pair[1], out)
          out.push(pair)
          prevA = pair[0] + 1
          prevB = pair[1] + 1
        }
        merge3MatchRange(a, prevA, aj, b, prevB, bj, out)
      }
      for (let k = suffix.length - 1; k >= 0; k -= 1) out.push(suffix[k])
    }

    /* base 的每一行在 side 里的落点（没匹配到是 -1）。 */
    function merge3MapOf(base, side) {
      const map = new Array(base.length)
      for (let i = 0; i < base.length; i += 1) map[i] = -1
      const pairs = merge3MatchPairs(base, side)
      for (let i = 0; i < pairs.length; i += 1) map[pairs[i][0]] = pairs[i][1]
      return map
    }

    /* ── 分块 ──
     *
     * 每块带三侧的区域行和各自的起始下标（画行号用），type：
     *   same     三方一致（未被动过的上下文）；
     *   ours     只有 ours 改了 → 自动合并取 ours；
     *   theirs   只有 theirs 改了 → 取 theirs；
     *   both     两侧改得一样 → 取那一份；
     *   conflict 两侧改得不一样 → 冲突块，merged 为 null。
     * 非冲突块都有 merged（该进结果区的行）；冲突块的三侧区域原样带着。
     * base 为空的 AA（两侧各自新增）走单独入口：对齐算法以 base 为轴，轴空了
     * 后面的合成一次都不会跑，而 UI 恰恰需要拿到那一个整文件冲突块。
     *
     * 合成语义与 git 的 xdl_merge 同一口径，而不是「两行都稳才稳」的粗粒度 diff3：
     * 先按每侧自己的匹配表把改动提成 hunk（base 区间 × 侧区间，纯插入是 base 空
     * 区间），再把两侧的 hunk 按 base 区间「重叠」分组 —— 重叠（含同点的两处插入）
     * 的合成一块按上面四类判，不重叠的各自干净落地。教科书 diff3 以「两侧都匹配
     * 的行」为界，ours 改第 1 行、theirs 改第 2 行这种不搭界的编辑会被并成一个
     * 大冲突；git 的答案（也是读者期待的「应用不冲突的更改」）是 A、B 各自落地。 */
    function merge3Runs(map, baseLen) {
      const runs = []
      let i = 0
      while (i < baseLen) {
        if (map[i] < 0) { i += 1; continue }
        const b0 = i
        const s0 = map[i]
        let len = 1
        while (i + len < baseLen && map[i + len] === s0 + len) len += 1
        runs.push({ b0: b0, b1: b0 + len, s0: s0, s1: s0 + len })
        i += len
      }
      return runs
    }

    /* 一侧的改动 hunk：相邻两个锁定段之间的 base 区间 × 侧区间。两头与段间都算，
       纯插入（base 空区间）与纯删除（侧空区间）都是合法 hunk。 */
    function merge3Hunks(runs, baseLen, sideLen) {
      const hunks = []
      let expectB = 0
      let expectS = 0
      for (let r = 0; r <= runs.length; r += 1) {
        const head = r < runs.length ? runs[r] : { b0: baseLen, s0: sideLen, b1: baseLen, s1: sideLen }
        if (head.b0 > expectB || head.s0 > expectS) {
          hunks.push({ baseStart: expectB, baseEnd: head.b0, sideStart: expectS, sideEnd: head.s0 })
        }
        expectB = head.b1
        expectS = head.s1
      }
      return hunks
    }

    /* 每个边界「外侧最近的一次匹配」：区域里没有改动的那一侧，它的内容就是这两
       个匹配点夹出来的区间 —— 与 base 区间逐行相同，等值比较因此落在「确实没改」
       上，不需要单独判断「这一侧有没有 hunk」。 */
    function merge3Bounds(map, baseLen, sideLen) {
      const before = new Array(baseLen + 1)
      const after = new Array(baseLen + 1)
      let last = -1
      for (let i = 0; i <= baseLen; i += 1) {
        before[i] = last
        if (i < baseLen && map[i] >= 0) last = map[i]
      }
      let next = sideLen
      for (let i = baseLen; i >= 0; i -= 1) {
        after[i] = next
        if (i > 0 && map[i - 1] >= 0) next = map[i - 1]
      }
      return { before: before, after: after }
    }

    function merge3Chunks(base, ours, theirs) {
      if (base.length === 0) {
        const only = { type: 'conflict', base: [], ours: ours, theirs: theirs,
          baseStart: 0, oursStart: 0, theirsStart: 0, merged: null }
        if (merge3SameRegion(ours, theirs) === true) {
          only.type = 'both'
          only.merged = ours
        }
        return [only]
      }
      const mo = merge3MapOf(base, ours)
      const mt = merge3MapOf(base, theirs)
      const bo = merge3Bounds(mo, base.length, ours.length)
      const bt = merge3Bounds(mt, base.length, theirs.length)
      const hunksO = merge3Hunks(merge3Runs(mo, base.length), base.length, ours.length)
      const hunksT = merge3Hunks(merge3Runs(mt, base.length), base.length, theirs.length)
      for (let i = 0; i < hunksO.length; i += 1) hunksO[i].side = 'ours'
      for (let i = 0; i < hunksT.length; i += 1) hunksT[i].side = 'theirs'
      const all = hunksO.concat(hunksT)
      all.sort(function (a, b) { return a.baseStart - b.baseStart || a.baseEnd - b.baseEnd })

      /* 按 base 区间把 hunk 并成区域。分组条件是「贴着也算重叠」（baseStart ≤ 区
         域末尾），不是严格相交 —— 与 git merge-file 的真实行为对过：相邻两行各改
         各的、插入紧贴改动区、同点双插，git 全部判冲突（xdl_merge 的不重叠条件是
         严格小于，贴着即冲突），教科书 diff3 的「不相交就干净合」和读者从命令行
         得到的结果对不上。区域内容相等时的 both 分类自然覆盖「同点双插且内容相同
         → 干净落地」这一种。 */
      const regions = []
      let k = 0
      while (k < all.length) {
        const first = all[k]
        const region = { rs: first.baseStart, re: first.baseEnd, hasO: false, hasT: false }
        let k2 = k
        while (k2 < all.length && all[k2].baseStart <= region.re) {
          if (all[k2].side === 'ours') region.hasO = true
          else region.hasT = true
          if (all[k2].baseEnd > region.re) region.re = all[k2].baseEnd
          k2 += 1
        }
        k = k2
        regions.push(region)
      }

      const chunks = []
      const pushRegion = function (rs, re) {
        const chunk = {
          base: base.slice(rs, re),
          ours: ours.slice(bo.before[rs] + 1, bo.after[re]),
          theirs: theirs.slice(bt.before[rs] + 1, bt.after[re]),
          baseStart: rs, oursStart: bo.before[rs] + 1, theirsStart: bt.before[rs] + 1,
          merged: null,
        }
        if (merge3SameRegion(chunk.ours, chunk.theirs) === true) { chunk.type = 'both'; chunk.merged = chunk.ours }
        else if (merge3SameRegion(chunk.ours, chunk.base) === true) { chunk.type = 'theirs'; chunk.merged = chunk.theirs }
        else if (merge3SameRegion(chunk.theirs, chunk.base) === true) { chunk.type = 'ours'; chunk.merged = chunk.ours }
        else chunk.type = 'conflict'
        chunks.push(chunk)
      }
      let pos = 0
      for (let r = 0; r < regions.length; r += 1) {
        const region = regions[r]
        if (region.rs > pos) {
          const run = base.slice(pos, region.rs)
          chunks.push({ type: 'same', base: run, ours: run, theirs: run,
            baseStart: pos, oursStart: mo[pos], theirsStart: mt[pos], merged: run })
        }
        pushRegion(region.rs, region.re)
        pos = region.re
      }
      if (pos < base.length) {
        const run = base.slice(pos)
        chunks.push({ type: 'same', base: run, ours: run, theirs: run,
          baseStart: pos, oursStart: mo[pos], theirsStart: mt[pos], merged: run })
      }
      return chunks
    }

    /* 冲突块的三个标记行。CRLF 文件的标记也带 \r（跟 ours 侧的口径走，调用方传），
       这样整个结果文件的换行不至于混出第三种。 */
    function merge3Markers(crlf) {
      const tail = crlf === true ? '\r' : ''
      return { open: '<<<<<<<' + tail, sep: '=======' + tail, close: '>>>>>>>' + tail }
    }

    /* 非冲突块取 merged，冲突块以三行标记夹住两侧原样呈现 —— 这就是「应用不冲突
       的更改」语义的初始形态，进界面时的预填就是它。 */
    function merge3PrefillLines(chunks, markers) {
      const out = []
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]
        if (chunk.type !== 'conflict') {
          for (let k = 0; k < chunk.merged.length; k += 1) out.push(chunk.merged[k])
          continue
        }
        out.push(markers.open)
        for (let k = 0; k < chunk.ours.length; k += 1) out.push(chunk.ours[k])
        out.push(markers.sep)
        for (let k = 0; k < chunk.theirs.length; k += 1) out.push(chunk.theirs[k])
        out.push(markers.close)
      }
      return out
    }

    /* ── 标记行识别 ──
     *
     * 开头七个字符说了算，后面只容忍「空格标签」和 CRLF 的 \r：git 自己写的就是
     * 裸七个字符（或 <<<<<<< HEAD），正文里恰好以七个 < 开头的行不该被误当标记。
     * 分隔线只认纯 =======（git 的写法）；尾巴上多打了空格的也放行，人手删块时
     * 半个字符的较真不该让一块冲突永远「未解决」。 */
    function merge3IsOpen(line) {
      if (line.indexOf('<<<<<<<') !== 0) return false
      const tail = line.charAt(7)
      return line.length === 7 || tail === ' ' || tail === '\r'
    }

    function merge3IsSep(line) {
      if (line.indexOf('=======') !== 0) return false
      for (let i = 7; i < line.length; i += 1) {
        const c = line.charAt(i)
        if (c !== ' ' && c !== '\r') return false
      }
      return true
    }

    function merge3IsClose(line) {
      if (line.indexOf('>>>>>>>') !== 0) return false
      const tail = line.charAt(7)
      return line.length === 7 || tail === ' ' || tail === '\r'
    }

    /* 扫结果区文本里的冲突块：start=开标记行，mid=分隔行（缺了是 -1），close=闭
       标记行（缺了是 -1，end 兜到最后一行）。没闭合的块照样在列 —— 它是最需要
       被数进「未解决」的那种。块里再出现开标记按正文处理（git 不产嵌套块）。 */
    function merge3ScanBlocks(lines) {
      const blocks = []
      let start = -1
      let mid = -1
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        if (start < 0) {
          if (merge3IsOpen(line) === true) { start = i; mid = -1 }
          continue
        }
        if (mid < 0 && merge3IsSep(line) === true) { mid = i; continue }
        if (merge3IsClose(line) === true) {
          blocks.push({ start: start, mid: mid, close: i, end: i })
          start = -1
          mid = -1
        }
      }
      if (start >= 0) blocks.push({ start: start, mid: mid, close: -1, end: lines.length - 1 })
      return blocks
    }

    /* 一块的左右两半：标记之间夹着的就是。分隔或闭合缺失时那一侧算空 —— 与
       「接受该侧 = 删除整块」的结果一致。 */
    function merge3BlockHalves(lines, block) {
      const ours = block.mid > block.start ? lines.slice(block.start + 1, block.mid) : []
      const theirs = block.mid >= 0 && block.close > block.mid ? lines.slice(block.mid + 1, block.close) : []
      return { ours: ours, theirs: theirs }
    }

    /* 结果区里每一块冲突对应的两侧内容。第 n 块对第 n 个冲突块（顺序是两者唯一
       共享的坐标系）；对不上号的块（读者手删过标记之后剩下的）退回块自己夹着的
       内容 —— 那是屏幕上看得见的左右两半，用它比用猜的诚实。 */
    function merge3BlockSides(lines, blocks, chunks) {
      const conflicts = []
      for (let i = 0; i < chunks.length; i += 1) if (chunks[i].type === 'conflict') conflicts.push(chunks[i])
      const sides = []
      for (let i = 0; i < blocks.length; i += 1) {
        const chunk = i < conflicts.length ? conflicts[i] : null
        const halves = merge3BlockHalves(lines, blocks[i])
        sides.push({
          ours: chunk !== null ? chunk.ours : halves.ours,
          theirs: chunk !== null ? chunk.theirs : halves.theirs,
        })
      }
      return sides
    }

    /* 把 [start, end] 行整段换成 replacement（可以是空数组 —— 「接受删除的一侧」
       就是把整块连标记一起删掉）。返回新数组，不改入参。 */
    function merge3ReplaceBlock(lines, block, replacement) {
      const out = lines.slice(0, block.start)
      for (let i = 0; i < replacement.length; i += 1) out.push(replacement[i])
      for (let i = block.end + 1; i < lines.length; i += 1) out.push(lines[i])
      return out
    }

    /* ── 「应用不冲突的更改」──
     *
     * 预填本来就是全量自动合并，所以结果区的排版还跟分块对得上（块数等于冲突块
       数）时，这个按钮的正确行为恰恰是什么都不动：非冲突区域已经在结果里，读者
       手改过的和已经做过的选择都原样保留。对不上了（手动删过标记）才按顺序重排：
       留下来的块按次序对回冲突块，没块可对的位置补一块新鲜的标记预填 —— 内容只
       会回来，不会被静默丢掉；非冲突区域以重新合并的为准（排版已经碎了，位置对
       不出「哪段手改过」，此时按钮声明的语义就是重新自动合并）。 */
    function merge3ApplyNonConflicts(chunks, lines, markers) {
      const blocks = merge3ScanBlocks(lines)
      let conflicts = 0
      for (let i = 0; i < chunks.length; i += 1) if (chunks[i].type === 'conflict') conflicts += 1
      if (blocks.length === conflicts) return lines.slice()
      const out = []
      let cursor = 0
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]
        if (chunk.type !== 'conflict') {
          for (let k = 0; k < chunk.merged.length; k += 1) out.push(chunk.merged[k])
          continue
        }
        if (cursor < blocks.length) {
          const block = blocks[cursor]
          for (let k = block.start; k <= block.end; k += 1) out.push(lines[k])
          cursor += 1
          continue
        }
        out.push(markers.open)
        for (let k = 0; k < chunk.ours.length; k += 1) out.push(chunk.ours[k])
        out.push(markers.sep)
        for (let k = 0; k < chunk.theirs.length; k += 1) out.push(chunk.theirs[k])
        out.push(markers.close)
      }
      return out
    }

    /* 三栏只读区的行模型：行号（1 起头、各侧自己的坐标系）+ 文本 + 是否着色。
     * 着色口径与需求一致：左右栏的「改动」= 该侧动过的区域（含两侧同改与冲突），
     * 基线栏着色的只有冲突区域的 base 行 —— 读者扫一眼就知道撞在哪里。 */
    function merge3SideRows(chunks, side) {
      const rows = []
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]
        const lines = side === 'base' ? chunk.base : (side === 'ours' ? chunk.ours : chunk.theirs)
        const start = side === 'base' ? chunk.baseStart : (side === 'ours' ? chunk.oursStart : chunk.theirsStart)
        const mark = side === 'base'
          ? chunk.type === 'conflict'
          : (side === 'ours'
            ? chunk.type === 'ours' || chunk.type === 'both' || chunk.type === 'conflict'
            : chunk.type === 'theirs' || chunk.type === 'both' || chunk.type === 'conflict')
        for (let k = 0; k < lines.length; k += 1) {
          rows.push({ line: start + k + 1, text: lines[k], mark: mark })
        }
      }
      return rows
    }
