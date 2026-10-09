    /* ── 三方合并冲突解决界面（PHPStorm 风格）──
     *
     * 变更页「冲突」组的行，过去点开走的是普通 diff（55-diff.js）：单文件的补丁
     * 只回答「现在长什么样」，回答不了「两边各改了什么、我该留哪边」。冲突行改走
     * 这一个界面：顶部工具栏、三栏只读对比（左 ours / 中 base / 右 theirs）、下方
     * 可编辑的结果区、底部应用与取消。非冲突行的点击一字不改（54-changes.js 里
     * 分流）。
     *
     * 刻意的差异，与 PHPStorm 不一致的地方都在这里说清：
     * · 本插件不拥有合并过程 —— merge/cherry-pick/stash pop 是读者在命令行或面板
     *   别处发起的，这里只管「一个路径的三个版本」。所以「取消」只关界面，绝不执
     *   行 git merge --abort；「应用更改」写回这一个文件并 git add，也不替读者
     *   继续合并（继续/中止在顶栏横幅上）。
     * · ⚙ 落在面板自己的「配置」页：DSH 的全局设置面板（设置 → dsh-git-idea配置）
     *   的打开状态是 shell 私有的 store，插件没有任何受支持的编程入口能打开它
     *   （settings.launcher 槽位被自带账户菜单占用，抢注等于顶掉自带 UI）。面板
     *   内能到的设置类页面就是「配置」页，⚙ 关掉本界面并切过去。
     *
     * 结果区是一支普通 textarea，冲突块的底色画在它身后一层按「行号 × 行高」定位
     * 的色块层里（行高固定，几何是算术，不需要逐行镜像 DOM）—— 这样中文输入法、
     * 原生撤销、选区都还是 textarea 自己的，色块只是背景。手动删掉某块的三行标记
     * ＝手动解决，计数随之减少；计数口径就是结果区扫出来的块数（53-merge3.js）。 */

    /* 与 46-css.js 里 .dsh-git-mrg-* 的行高/内边距同一个数：色块按它定位。 */
    const MERGE_ROW_H = 18
    const MERGE_PAD_TOP = 4
    const MERGE_UNDO_MAX = 200
    /* 连续键入合并成一步撤销：每个字符一步是噪音，500ms 内的连击算同一次编辑。 */
    const MERGE_UNDO_GAP_MS = 500

    /* 把 git/conflict 的答复折成界面要用的形状：分块、预填全文、三栏行模型。
     *
     * 换行符在这里过一道闸：行尾的 \r 全部剥掉再进 diff 和编辑器 —— textarea 的
     * 值本来就按 HTML 规范把 \r\n 规范成 \n，留着 \r 只会在第一次编辑时被静默吃
     * 掉，混进第三种换行；剥掉之后，diff 对「同一行、换行不同」也能对上。写回时
     * 按 ours 侧的口径（meta.crlf）把 \n 整体还原成 \r\n —— 整文件统一，不再有
     * 混排。 */
    function mergeStripCr(line) {
      return line.replace(/\r+$/, '')
    }

    function mergeBuild(reply) {
      const crlf = reply.ours.present === true ? reply.ours.crlf
        : (reply.base.present === true ? reply.base.crlf : reply.theirs.crlf)
      const markers = merge3Markers(false)
      const linesOf = function (side) {
        const raw = merge3SplitLines(side.present === true ? side.text : '')
        const out = []
        for (let i = 0; i < raw.length; i += 1) out.push(mergeStripCr(raw[i]))
        return out
      }
      const chunks = merge3Chunks(linesOf(reply.base), linesOf(reply.ours), linesOf(reply.theirs))
      let conflicts = 0
      for (let i = 0; i < chunks.length; i += 1) if (chunks[i].type === 'conflict') conflicts += 1
      return {
        chunks: chunks,
        markers: markers,
        conflicts: conflicts,
        crlf: crlf === true,
        initial: merge3JoinLines(merge3PrefillLines(chunks, markers)),
        rows: {
          ours: merge3SideRows(chunks, 'ours'),
          base: merge3SideRows(chunks, 'base'),
          theirs: merge3SideRows(chunks, 'theirs'),
        },
      }
    }

    /* 三栏同步滚动：谁滚了，另两栏跟上（值相等时不再写，滚动事件自然止住）。 */
    function mergeSyncPanes(box, kind) {
      return function () {
        const source = box[kind].node
        if (source == null) return
        const kinds = ['ours', 'base', 'theirs']
        for (let i = 0; i < kinds.length; i += 1) {
          const one = box[kinds[i]].node
          if (one == null || one === source) continue
          if (one.scrollTop !== source.scrollTop) one.scrollTop = source.scrollTop
          if (one.scrollLeft !== source.scrollLeft) one.scrollLeft = source.scrollLeft
        }
      }
    }

    /* 结果区：色块层跟随 textarea 的滚动（transform 平移），宽度铺到内容宽。
       style 问不到（无布局环境/测试桩）就跳过 —— 色块只是背景，不该为它抛错。 */
    function mergeSyncLayer(box, ta) {
      const layer = box.layer
      if (layer == null || layer.style == null) return
      layer.style.transform = 'translate(' + String(-ta.scrollLeft) + 'px,' + String(-ta.scrollTop) + 'px)'
      layer.style.width = String(Math.max(ta.scrollWidth, ta.clientWidth)) + 'px'
      layer.style.height = String(Math.max(ta.scrollHeight, ta.clientHeight)) + 'px'
    }

    function MergeResultEditor(props) {
      const [box] = React.useState(function () { return { ta: null, layer: null } })
      const bands = props.bands
      const jump = props.jump
      React.useEffect(function () {
        const ta = box.ta
        if (ta == null || jump == null || jump.tick === 0) return
        const band = bands[jump.index]
        if (band == null) return
        ta.scrollTop = Math.max(0, band.top - ta.clientHeight / 3)
        mergeSyncLayer(box, ta)
        /* 依赖只有 tick：index 是它当时的伴侣，tick 动一次滚一次。 */
      }, [jump === null ? 0 : jump.tick])
      const nodes = []
      for (let i = 0; i < bands.length; i += 1) {
        nodes.push(h('div', {
          key: 'b' + i,
          className: bands[i].cls,
          style: { top: bands[i].top + 'px', height: bands[i].height + 'px' },
        }))
      }
      return h('div', { key: 'editor', className: 'dsh-git-mrg-editor' },
        h('div', {
          key: 'layer', className: 'dsh-git-mrg-layer',
          ref: function (node) { box.layer = node },
        }, nodes),
        h('textarea', {
          key: 'ta', className: 'dsh-git-mrg-input', value: props.text,
          wrap: 'off', spellCheck: false,
          onChange: function (event) { props.onChange(event.target.value) },
          onScroll: function (event) { mergeSyncLayer(box, event.target) },
          ref: function (node) { box.ta = node },
        }))
    }

    /* 一栏只读对比。行虚拟窗口与提交历史同一个机制（12-window.js）：几千行的
       冲突文件不该一次画几万个节点。 */
    function MergePane(props) {
      const rows = props.rows
      const win = useVirtualWindow('mrg:' + props.id, rows.length, MERGE_ROW_H)
      const shown = []
      for (let i = win.first; i < win.last; i += 1) {
        const row = rows[i]
        shown.push(h('div', {
          key: 'r' + i,
          className: 'dsh-git-mrg-lrow' + (row.mark === true ? ' dsh-git-mrg-m-' + props.kind : ''),
        },
          h('span', { key: 'n', className: 'dsh-git-mrg-lno' }, String(row.line)),
          h('span', { key: 't', className: 'dsh-git-mrg-ltext' }, row.text)))
      }
      const padTop = win.first * MERGE_ROW_H
      const padBottom = (rows.length - win.last) * MERGE_ROW_H
      return h('div', { key: props.id, className: 'dsh-git-mrg-pane' },
        h('div', { key: 'h', className: 'dsh-git-mrg-panehead', title: props.label }, props.label),
        props.emptyText != null
          ? h('div', { key: 'empty', className: 'dsh-git-mrg-rows dsh-git-mrg-emptyp' }, props.emptyText)
          : h('div', {
              key: 'rows', className: 'dsh-git-mrg-rows',
              ref: function (node) { win.attach(node); props.box.node = node },
              onScroll: function () { win.measure(); props.onScroll() },
            },
              h('div', {
                key: 'wrap', className: 'dsh-git-mrg-wrap',
                style: { minHeight: (rows.length * MERGE_ROW_H) + 'px' },
              },
                padTop > 0 ? h('div', { key: 'pt', style: { height: padTop + 'px' } }) : null,
                shown,
                padBottom > 0 ? h('div', { key: 'pb', style: { height: padBottom + 'px' } }) : null)))
    }

    function MergeView(props) {
      const target = props.target
      const shape = text(target.repo) + '\u0000' + text(target.path)
      const [loaded, setLoaded] = React.useState(null)      /* null 在读；{reply} / {failure} 已答 */
      const [meta, setMeta] = React.useState(null)
      /* 结果区全文（结果区的唯一事实源）。刻意不叫 text：全局的 text() 帮助函数
         在这个作用域里还要用（10-state.js），别让一个 state 把它遮了。 */
      const [draft, setDraft] = React.useState('')
      const [active, setActive] = React.useState(0)         /* 当前冲突块的下标 */
      const [jump, setJump] = React.useState(null)          /* {tick, index}：让结果区滚到某一块 */
      const [jumpAt] = React.useState(function () { return { tick: 0 } })
      const [undoBox] = React.useState(function () { return { stack: [], last: 0 } })
      const [saving, setSaving] = React.useState(false)
      const [confirming, setConfirming] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [paneBox] = React.useState(function () {
        return { ours: { node: null }, base: { node: null }, theirs: { node: null } }
      })

      React.useEffect(function () {
        let alive = true
        setLoaded(null)
        setMeta(null)
        setDraft('')
        setActive(0)
        setNote('')
        const payload = { sessionId: props.sessionId, path: target.path }
        if (text(target.repo).length > 0) payload.repo = target.repo
        callHost('git/conflict', payload).then(function (reply) {
          if (alive !== true) return
          setLoaded({ reply: reply })
          if (reply != null && reply.ok === true) {
            const built = mergeBuild(reply)
            setMeta(built)
            setDraft(built.initial)
            if (built.conflicts > 0) {
              setActive(0)
              /* 打开就落到第一块冲突上：读进来的是活儿，不是风景。 */
              jumpAt.tick += 1
              setJump({ tick: jumpAt.tick, index: 0 })
            }
          }
        }, function (failure) {
          if (alive === true) setLoaded({ failure: failureText(failure) })
        })
        return function () { alive = false }
        /* shape 换了 = 换了文件或仓库，重读；sessionId 换了同理。 */
      }, [shape, props.sessionId])

      const lines = meta !== null ? draft.split('\n') : []
      const blocks = meta !== null ? merge3ScanBlocks(lines) : []
      const count = blocks.length
      const edited = meta !== null && draft !== meta.initial
      const activeAt = active < blocks.length ? active : blocks.length - 1
      const canNav = meta !== null && count > 0
      const countText = meta === null ? '读取中…'
        : count === 0 ? '全部已解决（0 个冲突）'
          : (edited === true ? String(count) + ' 个冲突' : '没有更改，' + String(count) + ' 个冲突')

      /* 撤销快照只装结果区文本：左右两栏本来就只读，没有可撤销的东西。 */
      const pushUndo = function (snapshot, force) {
        const now = Date.now()
        if (force !== true && undoBox.stack.length > 0 && now - undoBox.last < MERGE_UNDO_GAP_MS) {
          undoBox.last = now
          return
        }
        undoBox.stack.push(snapshot)
        if (undoBox.stack.length > MERGE_UNDO_MAX) undoBox.stack.shift()
        undoBox.last = now
      }
      const mutateText = function (next, force) {
        pushUndo(draft, force)
        setDraft(next)
      }
      const undoEdit = function () {
        const previous = undoBox.stack.pop()
        if (previous === undefined) return
        undoBox.last = 0
        setDraft(previous)
      }

      const jumpTo = function (index) {
        setActive(index)
        jumpAt.tick += 1
        setJump({ tick: jumpAt.tick, index: index })
      }
      /* 循环跳转：从头往前是 -1 取模绕回，从尾往后同理。 */
      const stepConflict = function (delta) {
        if (canNav !== true) return
        const from = activeAt >= 0 ? activeAt : (delta > 0 ? -1 : 0)
        jumpTo(((from + delta) % count + count) % count)
      }

      /* 接受一侧：整块（含三行标记）换成那一侧的内容；删除的一侧内容是空数组，
          换上去等于把块从结果里抹掉 —— DU/UD 的「接受删除侧」就是这个形状。 */
      const acceptSide = function (side, all) {
        if (canNav !== true) return
        const sides = merge3BlockSides(lines, blocks, meta.chunks)
        let next = lines
        if (all === true) {
          for (let i = blocks.length - 1; i >= 0; i -= 1) next = merge3ReplaceBlock(next, blocks[i], sides[i][side])
        } else {
          const block = blocks[activeAt]
          if (block != null) next = merge3ReplaceBlock(next, block, sides[activeAt][side])
        }
        mutateText(merge3JoinLines(next), true)
        const left = merge3ScanBlocks(next).length
        if (activeAt >= left) setActive(left > 0 ? left - 1 : 0)
      }

      const applyNonConflicts = function () {
        if (meta === null) return
        const next = merge3JoinLines(merge3ApplyNonConflicts(meta.chunks, lines, meta.markers))
        /* 排版还对得上时答案就是「原样」：不产生一步看不见的撤销。 */
        if (next !== draft) mutateText(next, true)
      }

      const doApply = function () {
        if (saving === true || meta === null) return
        setConfirming(false)
        setSaving(true)
        /* 编辑器里是 LF（textarea 的规范行为），写回按 ours 侧口径整体还原。 */
        const payload = { sessionId: props.sessionId, path: target.path, content: meta.crlf === true ? draft.replace(/\n/g, '\r\n') : draft }
        if (text(target.repo).length > 0) payload.repo = target.repo
        callHost('git/conflict-save', payload).then(function (reply) {
          setSaving(false)
          if (reply == null || reply.ok !== true) {
            setNote(commandDetail(reply) || '写回失败')
            return
          }
          props.onApplied(reply)
        }, function (failure) {
          setSaving(false)
          setNote(failureText(failure))
        })
      }
      /* 有未解决的块不拦人，但要确认：那些块会以 <<<<<<< ======= >>>>>>> 原样写
         回文件 —— 这句话必须出现在读者按下去之前，而不是写完之后。 */
      const applyChanges = function () {
        if (meta === null || saving === true) return
        if (count > 0) { setConfirming(true); return }
        doApply()
      }

      const reply = loaded !== null && loaded.reply != null ? loaded.reply : null
      /* 仓库名优先用答复里解析出的那份：单仓库路径下 target.repo 是空的，Host 从
         会话工作区解析出来的仓库才是标题该说的那个。 */
      const repoName = reply != null && text(reply.repo).length > 0 ? repoBaseName(reply.repo)
        : (text(target.repo).length > 0 ? repoBaseName(target.repo) : '仓库')
      const titleText = '合并 ' + repoName + ' 的 ' + target.path + ' 的修订'

      const head = h('div', { key: 'head', className: 'dsh-git-mrg-head' },
        diffIconButton('back', '←', '返回变更列表（不写任何字节）', props.onBack),
        h('span', { key: 't', className: 'dsh-git-mrg-title', title: titleText }, titleText),
        target.code !== undefined && target.code !== ''
          ? h('span', { key: 'c', className: 'dsh-git-st dsh-git-st-CF', title: '未解决的冲突（' + target.code + '）' }, target.code)
          : null,
        h('span', { key: 'grow', className: 'dsh-git-mrg-grow' }),
        h('span', {
          key: 'n', className: 'dsh-git-mrg-count',
          title: '口径：结果区里还没做出选择的冲突块数（手动删掉一块的标记＝已解决）',
        }, countText))

      const oursLabel = reply != null && text(reply.oursLabel).length > 0 ? reply.oursLabel : '本地更改'
      const theirsLabel = reply != null && text(reply.theirsLabel).length > 0 ? reply.theirsLabel : '传入的更改'

      const tools = h('div', { key: 'tools', className: 'dsh-git-mrg-tools' },
        diffIconButton('prev', '↓', '上一个冲突（循环，结果区滚到那一块并高亮）', function () { stepConflict(-1) }, { disabled: !canNav }),
        diffIconButton('next', '↑', '下一个冲突（循环，结果区滚到那一块并高亮）', function () { stepConflict(1) }, { disabled: !canNav }),
        diffIconButton('undo', '↶', '撤销结果区的上一次编辑（只作用于结果区；左右两栏只读，本就没有可撤销的内容）', undoEdit,
          { disabled: undoBox.stack.length === 0 || saving === true }),
        h('button', {
          key: 'nc', type: 'button', className: 'dsh-git-btn', disabled: meta === null || saving === true,
          title: '把 base→ours 与 base→theirs 无冲突的区域重新自动合并进结果区；只填非冲突区域，'
            + '已做的选择（冲突块的现状）原样保留',
          onClick: applyNonConflicts,
        }, '应用不冲突的更改'),
        h('button', {
          key: 'al', type: 'button', className: 'dsh-git-btn', disabled: !canNav || saving === true,
          title: '当前冲突块采用左栏（' + oursLabel + '）的内容并去掉标记',
          onClick: function () { acceptSide('ours', false) },
        }, '<< 左侧'),
        h('button', {
          key: 'ala', type: 'button', className: 'dsh-git-btn', disabled: !canNav || saving === true,
          title: '所有冲突块都采用左栏（' + oursLabel + '）的内容并去掉标记',
          onClick: function () { acceptSide('ours', true) },
        }, '所有 << 左侧'),
        h('button', {
          key: 'ar', type: 'button', className: 'dsh-git-btn', disabled: !canNav || saving === true,
          title: '当前冲突块采用右栏（' + theirsLabel + '）的内容并去掉标记',
          onClick: function () { acceptSide('theirs', false) },
        }, '右侧 >>'),
        h('button', {
          key: 'ara', type: 'button', className: 'dsh-git-btn', disabled: !canNav || saving === true,
          title: '所有冲突块都采用右栏（' + theirsLabel + '）的内容并去掉标记',
          onClick: function () { acceptSide('theirs', true) },
        }, '所有 >> 右侧'),
        h('span', { key: 'grow', className: 'dsh-git-mrg-grow' }),
        diffIconButton('settings', '⚙', '打开面板的「配置」页（本界面关闭）', props.onSettings))

      /* 提示行：结构性的事实（缺 base、缺一侧、换行符不一致）在这里说，一次一行话。 */
      const hints = []
      if (reply != null && reply.ok === true) {
        if (reply.base.present !== true) hints.push('两侧各自新增，没有基准版本：整个文件就是一块冲突')
        if (reply.ours.present !== true) hints.push(oursLabel + ' 一侧已删除此文件：接受这一侧＝整块删除')
        if (reply.theirs.present !== true) hints.push(theirsLabel + ' 一侧已删除此文件：接受这一侧＝整块删除')
        if (reply.ours.present === true && reply.theirs.present === true && reply.ours.crlf !== reply.theirs.crlf) {
          hints.push('两侧换行符不一致（CRLF / LF）：编辑器里按 LF 显示，写回时按 ours 侧的口径整体还原')
        }
      }

      /* 结果区色块：一块三层 —— 整块淡红，左右两半各覆盖一栏同色（与三栏的着色
         同一个读法），当前块整体加重。行高固定，几何是行号 × 行高 + 内边距。 */
      const bands = []
      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i]
        const on = i === activeAt
        const base = on === true ? ' dsh-git-mrg-band-block-on' : ' dsh-git-mrg-band-block'
        bands.push({
          top: MERGE_PAD_TOP + block.start * MERGE_ROW_H,
          height: (block.end - block.start + 1) * MERGE_ROW_H,
          cls: 'dsh-git-mrg-band' + base,
        })
        if (block.mid > block.start + 1) {
          bands.push({
            top: MERGE_PAD_TOP + (block.start + 1) * MERGE_ROW_H,
            height: (block.mid - block.start - 1) * MERGE_ROW_H,
            cls: 'dsh-git-mrg-band' + (on === true ? ' dsh-git-mrg-band-left-on' : ' dsh-git-mrg-band-left'),
          })
        }
        if (block.mid >= 0 && block.close > block.mid + 1) {
          bands.push({
            top: MERGE_PAD_TOP + (block.mid + 1) * MERGE_ROW_H,
            height: (block.close - block.mid - 1) * MERGE_ROW_H,
            cls: 'dsh-git-mrg-band' + (on === true ? ' dsh-git-mrg-band-right-on' : ' dsh-git-mrg-band-right'),
          })
        }
      }

      let body
      if (loaded === null) {
        body = h('div', { key: 'wait', className: 'dsh-git-pane dsh-git-dim' }, '正在读取三个版本…')
      } else if (loaded.failure !== undefined) {
        body = h('div', { key: 'bad', className: 'dsh-git-pane dsh-git-error' }, loaded.failure)
      } else if (reply == null || reply.ok !== true) {
        const said = reply != null ? text(reply.stderr) : ''
        body = h('div', { key: 'bad', className: 'dsh-git-pane dsh-git-error' },
          said.length > 0 ? said : '无法读取这个路径的冲突版本')
      } else {
        body = [
          h('div', { key: 'panes', className: 'dsh-git-mrg-panes' },
            h(MergePane, {
              key: 'ours', id: 'ours:' + shape, kind: 'ours',
              label: '来自 ' + oursLabel + ' 的更改',
              rows: meta.rows.ours,
              emptyText: reply.ours.present !== true ? '（该侧已删除此文件）' : null,
              box: paneBox.ours, onScroll: mergeSyncPanes(paneBox, 'ours'),
            }),
            h(MergePane, {
              key: 'base', id: 'base:' + shape, kind: 'base',
              label: '基准版本',
              rows: meta.rows.base,
              emptyText: reply.base.present !== true ? '（两侧各自新增，无基准版本）' : null,
              box: paneBox.base, onScroll: mergeSyncPanes(paneBox, 'base'),
            }),
            h(MergePane, {
              key: 'theirs', id: 'theirs:' + shape, kind: 'theirs',
              label: '来自 ' + theirsLabel + ' 的更改',
              rows: meta.rows.theirs,
              emptyText: reply.theirs.present !== true ? '（该侧已删除此文件）' : null,
              box: paneBox.theirs, onScroll: mergeSyncPanes(paneBox, 'theirs'),
            })),
          h(MergeResultEditor, {
            key: 'editor', text: draft, bands: bands, jump: jump,
            onChange: function (next) { mutateText(next, false) },
          }),
        ]
      }

      const foot = h('div', { key: 'foot', className: 'dsh-git-mrg-foot' },
        h('span', { key: 'hint', className: 'dsh-git-hint' },
          '结果区的全文就是要写回文件的内容；删掉一块的三行标记＝手动解决这一块。'),
        h('span', { key: 'gap', className: 'dsh-git-mrg-grow' }),
        h('button', {
          key: 'no', type: 'button', className: 'dsh-git-btn', disabled: saving === true,
          title: '直接关闭：不写入任何字节，也不执行 git merge --abort —— 合并是你在命令行或面板别处发起的，这里只管这一个文件',
          onClick: props.onBack,
        }, '取消'),
        h('button', {
          key: 'ok', type: 'button', className: 'dsh-git-btn dsh-git-primary',
          disabled: saving === true || meta === null,
          title: count > 0
            ? '有 ' + String(count) + ' 处未解决的冲突 —— 点下去会先向你确认'
            : '把结果区全文写回文件，git add 标记已解决，然后回到变更列表',
          onClick: applyChanges,
        }, saving === true ? '写入中…' : '应用更改'))

      return h('div', { key: 'merge', className: 'dsh-git-mrg' },
        head,
        tools,
        hints.length > 0 ? h('div', { key: 'warn', className: 'dsh-git-diffwarn' }, hints.join(' · ')) : null,
        note.length > 0
          ? h('div', {
              key: 'note', className: 'dsh-git-error dsh-git-mrg-note',
              title: '点一下清掉这条提示', onClick: function () { setNote('') },
            }, note)
          : null,
        body,
        foot,
        confirming === true
          ? h('div', { key: 'confirm', className: 'dsh-git-qc-overlay' },
              h('div', { className: 'dsh-git-qc-box dsh-git-mrg-confirm' },
                h('div', { key: 'h', className: 'dsh-git-qc-head' }, '还有 ' + String(count) + ' 处未解决的冲突'),
                h('div', { key: 's', className: 'dsh-git-hint' },
                  '应用后这些块会以 <<<<<<< ======= >>>>>>> 标记原样写回文件，并 git add 标记为已解决。确认写入吗？'),
                h('div', { key: 'a', className: 'dsh-git-qc-actions' },
                  h('button', {
                    type: 'button', className: 'dsh-git-btn dsh-git-primary',
                    disabled: saving === true, onClick: doApply,
                  }, saving === true ? '写入中…' : '确认写入'),
                  h('button', {
                    type: 'button', className: 'dsh-git-btn', disabled: saving === true,
                    onClick: function () { setConfirming(false) },
                  }, '取消'))))
          : null)
    }
