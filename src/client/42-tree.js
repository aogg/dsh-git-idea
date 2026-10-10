    function BranchIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 14
      const shapes = [
        h('circle', { key: 'a', cx: 4, cy: 3.5, r: 1.7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'b', cx: 4, cy: 12.5, r: 1.7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'c', cx: 12, cy: 6, r: 1.7, fill: 'currentColor', stroke: 'none' }),
        h('path', { key: 'd', d: 'M4 5.4 L4 10.6' }),
        h('path', { key: 'e', d: 'M4 8 C 7.5 8, 8.5 6, 10.2 6' }),
      ]
      /* The "no repository here" mark is drawn inside the same viewBox rather
         than rendered as a second element beside the icon. Two flex siblings
         read as two buttons; one glyph reads as one button whose meaning is
         "Git, not enabled yet". The bottom-right corner is empty in the branch
         drawing, so the strokes never collide. */
      if (props.plus === true) {
        shapes.push(h('path', { key: 'ph', d: 'M10.9 12.3 L14.3 12.3', strokeWidth: 1.9 }))
        shapes.push(h('path', { key: 'pv', d: 'M12.6 10.6 L12.6 14', strokeWidth: 1.9 }))
      }
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', style: { flex: 'none', display: 'block' },
        /* 切换在飞的时候转起来：慢盘上一次切换要好几秒，卡片早就收起来了，
           能看见的只剩这个图标。 */
        className: props.spin === true ? 'dsh-git-spin' : undefined,
      }, shapes)
    }

    function buildTree(entries) {
      const root = { children: {}, leaves: [] }
      for (let i = 0; i < entries.length; i += 1) {
        const segments = entries[i].segments
        if (segments.length === 0) continue
        /* ── a directory git collapsed ──
           An untracked directory arrives as one entry ending in "/" — that is
           git saying "a directory, contents not listed". The last segment is
           then empty, and the one before it names the row; the container has to
           stop one level higher, or the row would be its own parent. Without
           this the entry was dropped on the floor: the tree quietly showed 10 of
           the 12 changes, the numbers under a folder did not add up to the count
           on the tab, and those files could not be staged from here at all. */
        const collapsed = segments[segments.length - 1].length === 0
        const stops = collapsed ? segments.length - 2 : segments.length - 1
        let node = root
        for (let k = 0; k < stops; k += 1) {
          const key = segments[k]
          if (key.length === 0) continue
          if (node.children[key] === undefined) node.children[key] = { children: {}, leaves: [] }
          node = node.children[key]
        }
        const name = collapsed ? (segments[stops] + '/') : segments[segments.length - 1]
        if (name.length === 0 || name === '/') continue
        node.leaves.push({ name: name, data: entries[i].data, dir: collapsed })
      }
      return root
    }

    function countLeaves(node) {
      let total = node.leaves.length
      const keys = Object.keys(node.children)
      for (let i = 0; i < keys.length; i += 1) total += countLeaves(node.children[keys[i]])
      return total
    }

    function annotateStaged(node) {
      let total = 0
      let staged = 0
      for (let i = 0; i < node.leaves.length; i += 1) {
        total += 1
        if (node.leaves[i].data != null && node.leaves[i].data.staged === true) staged += 1
      }
      const keys = Object.keys(node.children)
      for (let i = 0; i < keys.length; i += 1) {
        const child = node.children[keys[i]]
        const sub = annotateStaged(child)
        child.total = sub.total
        child.staged = sub.staged
        total += sub.total
        staged += sub.staged
      }
      return { total: total, staged: staged }
    }

    function collectLeaves(node, out) {
      for (let i = 0; i < node.leaves.length; i += 1) if (node.leaves[i].data != null) out.push(node.leaves[i].data)
      const keys = Object.keys(node.children)
      for (let i = 0; i < keys.length; i += 1) collectLeaves(node.children[keys[i]], out)
      return out
    }

    /* squeeze 把「自己没有叶子、只有唯一子目录」的目录链一路拼起来，
       a/b/c/file.txt 就合成一行目录 a/b/c。这是 IDEA 分支树的画法 —— 分支名
       自带 origin/feat/x 这样的层级，逐层展开会让只有目录没有分支的每一级都
       白占一行。现在只有 RefTree（50-log.js 的分支分组树）还要它；文件列表
       一律不用（flattenTree 的 squeezeOn 传 false），目录不许合并。 */
    function squeeze(node) {
      let name = ''
      let target = node
      while (target.leaves.length === 0) {
        const inner = Object.keys(target.children)
        if (inner.length !== 1) break
        name = name.length === 0 ? inner[0] : (name + '/' + inner[0])
        target = target.children[inner[0]]
      }
      return { name: name, target: target }
    }

    /* squeezeOn === true 时目录链照旧压扁成一行（仅 RefTree 在用）；false 时
       每一级目录独立成行、独立缩进，name 就是本级那一段。目录行的 path 仍由
       prefix 逐层拼出，不压扁后同一棵树的键变细（多出中间层的键）：折叠表里
       旧存档的压扁键（如 @files/a/b/c）恰好等于新树最深那层目录的键，等于旧
       折叠状态自动落到最深一层，中间层一次性回到展开 —— 不做额外迁移。 */
    function flattenTree(node, depth, prefix, collapsed, out, id, squeezeOn) {
      const keys = Object.keys(node.children).sort()
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i]
        let target = node.children[key]
        let name = key
        if (squeezeOn === true) {
          const squeezed = squeeze(target)
          target = squeezed.target
          if (squeezed.name.length > 0) name = key + '/' + squeezed.name
        }
        const total = countLeaves(target)
        if (total === 0) continue
        const path = prefix + '/' + name
        const isCollapsed = collapsed[path] === true
        out.push({
          kind: 'dir', name: name, path: path, depth: depth, collapsed: isCollapsed,
          count: total, data: target, id: id + ':d:' + path,
        })
        if (!isCollapsed) flattenTree(target, depth + 1, path, collapsed, out, id, squeezeOn)
      }
      for (let i = 0; i < node.leaves.length; i += 1) {
        const leaf = node.leaves[i]
        out.push({ kind: 'leaf', name: leaf.name, depth: depth, data: leaf.data, dir: leaf.dir === true, id: id + ':f:' + prefix + '/' + leaf.name })
      }
      return out
    }

