    /* One component with a path table instead of a dozen components: every icon
       here is a 16-box outline glyph drawn in currentColor. */
    const ICON_PATHS = {
      search: ['M7 2.6 A4.4 4.4 0 1 0 7 11.4 A4.4 4.4 0 1 0 7 2.6', 'M10.3 10.3 L13.6 13.6'],
      /* Two glyphs, one per mode, so the button says which order is in force
         rather than only that it can be changed. */
      sortName: ['M2.4 12.2 L5.2 4.2 L8 12.2', 'M3.4 9.6 H7', 'M11.2 3.8 V12.2', 'M9.3 10.3 L11.2 12.2 L13.1 10.3'],
      sortRecent: ['M8 2.8 A5.2 5.2 0 1 0 8 13.2 A5.2 5.2 0 1 0 8 2.8', 'M8 5.4 V8.4 L10.3 9.7'],
      right: ['M6.4 3.8 L10.6 8 L6.4 12.2'],
      back: ['M9.6 3.8 L5.4 8 L9.6 12.2'],
      down: ['M3.8 6.4 L8 10.6 L12.2 6.4'],
      plus: ['M8 3.4 V12.6', 'M3.4 8 H12.6'],
      pull: ['M8 3.2 V9.8', 'M5.2 7 L8 9.8 L10.8 7', 'M3.6 11.8 V12.6 H12.4 V11.8'],
      /* 拣选/还原/标签的三个形状随那四个工具条图标键一起退役了：这些动作现在住在
         提交行的右键菜单里，菜单项是带字的按钮，不再画图标。 */
      /* An untracked directory git collapsed into one entry: the row has to say
         "directory" on its own, because there is no listing behind it until it is
         opened. */
      folder: ['M2.2 4.4 H6.4 L7.8 6.2 H13.8 V12.4 H2.2 Z'],
      /* A small cube for a repository. The repo rows and the branch rows underneath
         them used to be the same flat row, so the lists read as one; a branch row
         starts with its twisty and a repo row starts with this box, and the two
         blocks fall apart without reading a single label. */
      repo: ['M8 2.6 L13 5 L13 11 L8 13.4 L3 11 L3 5 Z', 'M3 5 L8 7.4 L13 5', 'M8 7.4 V13.4'],
      undo: ['M5.9 3.6 L2.7 6.8 L5.9 10', 'M2.7 6.8 H9.3 A3.5 3.5 0 0 1 9.3 13.8 H7.3'],
    }
    /* One field, one clear button: the × sits inside the box, where the eye
       already is, so no row of buttons has to exist for it. */
    function clearable(key, input, hasValue, onClear, variant) {
      const classes = ['dsh-git-clearable']
      if (variant != null && variant.length > 0) classes.push(variant)
      return h('div', { key: key, className: classes.join(' ') },
        input,
        hasValue === true ? h('button', {
          key: 'x', type: 'button', className: 'dsh-git-clear-x', title: '清空',
          onClick: function (event) {
            stopEvent(event)
            if (event != null && typeof event.preventDefault === 'function') event.preventDefault()
            onClear()
          },
        }, '×') : null)
    }

    function Icon(props) {
      const paths = ICON_PATHS[props.name]
      if (paths === undefined) return null
      const size = typeof props.size === 'number' ? props.size : 14
      const shapes = []
      for (let i = 0; i < paths.length; i += 1) shapes.push(h('path', { key: 'p' + i, d: paths[i] }))
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { flex: 'none', display: 'block' },
      }, shapes)
    }

