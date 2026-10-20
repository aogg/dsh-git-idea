    function twisty(props) {
      return h('span', {
        className: 'dsh-git-tw',
        title: props.collapsed === true ? '展开' : '折叠',
        onClick: function (event) {
          event.stopPropagation()
          props.onToggle()
        },
      }, props.collapsed === true ? '▶' : '▼')
    }

    /* The directory row, drawn the same way by every tree in the plugin: the log
       sidebar, a commit's file list, the changes tree, the untracked directory's
       own listing. One element, one set of classes, one gesture — a click selects
       the row, a double click folds it, and the twisty is the second way to fold
       the same thing.

       Only the dim text at the right edge differs, and what it counts depends on
       what the tree is a tree of ("12" branches, "3 个文件"), so that is the one
       argument.

       props.onContext（可选）：文件右键菜单的挂点（61-filemenu.js 的 fileMenuItems
       在面板那一侧吃它的产出）。传了的树，目录行右键把整个 node 交给它；分支树
       （50-log.js）不传 —— onContextMenu 就地 undefined，行为与从前一字不差。
       preventDefault + stopPropagation 是提交行右键同一条规矩：拦掉浏览器自己的
       菜单，也不让这一下顺手把行选中。 */
    function treeDirRow(node, props, dim) {
      return h('div', {
        className: 'dsh-git-trow' + (props.selectedKey === node.id ? ' dsh-git-trow-sel' : ''),
        key: node.id,
        style: { paddingLeft: (6 + node.depth * 12) + 'px' },
        title: node.name + '（双击展开/折叠）',
        onClick: function () { props.onSelect(node.id) },
        onDoubleClick: function () { props.onToggle(node.path) },
        onContextMenu: typeof props.onContext === 'function'
          ? function (event) {
              event.preventDefault()
              event.stopPropagation()
              props.onContext(node, event)
            }
          : undefined,
      },
        twisty({ collapsed: node.collapsed, onToggle: function () { props.onToggle(node.path) } }),
        h('span', { className: 'dsh-git-tname' }, node.name),
        h('span', { className: 'dsh-git-tdim' }, dim))
    }
