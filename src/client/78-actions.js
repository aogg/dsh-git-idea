    /* ── 「更多操作（⋯）」与「快捷命令（⚡）」：两个下拉、执行确认框、编辑器 ──

       工具栏里 branch 按钮右边那两个图标按钮的下拉内容都在这里（按钮本体在 80-panel.js
       的 toolbar 里）。快捷命令的编辑器是同一个组件的两处使用：面板里的覆盖层，和设置页
       （90-settings.js）里的管理组 —— 片段共享作用域，直接引用，不需要再开一条通道。

       按钮的类名刻意不用 dsh-git-tool / dsh-git-tool-ico：样式照着它画（见 46-css.js），
       但那两个类是「作用于选中提交的那四个工具」的语义，测试套件也按个数认它们 —— 新
       按钮是「打开一个菜单」，不是「对选中项做事」，名字分开对两边都诚实。 */

    /* ── 变量代值 ──

       模板里只有认识的变量才代值：awk 的 '{print}'、shell 的 ${X} 之类不认识的花括号
       原样留在命令里 —— 一条把读者命令改写过的「快捷」命令比报错危险得多。 */
    const QUICK_VARS = [
      { key: 'branch', label: '{branch}', desc: '当前分支名' },
      { key: 'upstream', label: '{upstream}', desc: '当前分支的上游（如 origin/main）' },
      { key: 'hash', label: '{hash}', desc: '选中的提交 hash' },
      { key: 'hashes', label: '{hashes}', desc: '多选提交的 hash（空格分隔；没有多选时就是选中的那一条）' },
      { key: 'subject', label: '{subject}', desc: '选中提交的标题' },
      { key: 'author', label: '{author}', desc: '选中提交的作者' },
      { key: 'email', label: '{email}', desc: '选中提交的作者邮箱' },
      { key: 'date', label: '{date}', desc: '选中提交的时间' },
      { key: 'tags', label: '{tags}', desc: '选中提交上的标签（逗号分隔）' },
    ]
    const QUICK_INPUT_LABEL = '{input:提示语|默认值}'
    const QUICK_INPUT_DESC = '执行时弹出的输入：确认框里按提示语给框、预填默认值（“|默认值”可省略）'

    /* 代不了值时确认框里那句「为什么」——按变量说人话，而不是报变量名了事。 */
    const QUICK_MISSING_WHY = {
      branch: '这个会话还没读到分支名', upstream: '当前分支没有上游（或还没读到）',
      hash: '先在历史里点选一个提交', hashes: '先在历史里点选提交（Ctrl+点击可以多选）',
      subject: '先在历史里点选一个提交', author: '先在历史里点选一个提交',
      email: '先在历史里点选一个提交', date: '先在历史里点选一个提交', tags: '先在历史里点选一个提交',
    }

    function quickMissingWhy(key) {
      const said = QUICK_MISSING_WHY[key]
      return said !== undefined ? said : '缺少这个变量的上下文'
    }

    /* {input:提示语|默认值} → {hint, fallback}。提示语为空的写法不认识（省略号级噪音）。 */
    function parseQuickToken(token) {
      for (let i = 0; i < QUICK_VARS.length; i += 1) {
        if (QUICK_VARS[i].key === token) return { kind: 'var', key: token }
      }
      if (token.indexOf('input:') === 0) {
        const rest = token.slice(6)
        const bar = rest.indexOf('|')
        const hint = bar >= 0 ? rest.slice(0, bar) : rest
        const fallback = bar >= 0 ? rest.slice(bar + 1) : ''
        if (hint.trim().length === 0) return null
        return { kind: 'input', hint: hint.trim(), fallback: fallback }
      }
      return null
    }

    /* 模板里所有 {input:…}，按出现次序 —— 确认框里输入框的顺序就是它。 */
    function quickInputsOf(template) {
      const out = []
      let at = 0
      while (at < template.length) {
        const open = template.indexOf('{', at)
        if (open < 0) break
        const close = template.indexOf('}', open + 1)
        if (close < 0) break
        const parsed = parseQuickToken(template.slice(open + 1, close))
        if (parsed != null && parsed.kind === 'input') out.push({ hint: parsed.hint, fallback: parsed.fallback })
        at = close + 1
      }
      return out
    }

    /* 代值。values 是 {input:…} 的已填值（按出现次序）；null 表示用默认值 —— 菜单里那行
       预览与 title 都是按默认值算的。代不了的变量留在原地并记进 missing：预览里看得见
       是哪个变量没着落，确认框据此禁掉「执行」并说明缺什么。 */
    function resolveQuickCommand(template, ctx, values) {
      const out = []
      const missing = []
      let inputAt = 0
      let at = 0
      while (at < template.length) {
        const open = template.indexOf('{', at)
        if (open < 0) { out.push(template.slice(at)); break }
        out.push(template.slice(at, open))
        const close = template.indexOf('}', open + 1)
        if (close < 0) { out.push(template.slice(open)); break }
        const token = template.slice(open + 1, close)
        const parsed = parseQuickToken(token)
        if (parsed == null) {
          /* 不认识的花括号：awk、${X}、JSON…… 原样保留。 */
          out.push('{' + token + '}')
        } else if (parsed.kind === 'input') {
          const filled = values != null && values[inputAt] != null && values[inputAt].length > 0
            ? values[inputAt] : parsed.fallback
          out.push(filled)
          inputAt += 1
        } else if (ctx != null && typeof ctx[parsed.key] === 'string' && ctx[parsed.key].length > 0) {
          out.push(ctx[parsed.key])
        } else {
          if (missing.indexOf(parsed.key) < 0) missing.push(parsed.key)
          out.push('{' + parsed.key + '}')
        }
        at = close + 1
      }
      return { command: out.join(''), missing: missing }
    }

    /* 菜单里那行灰色预览：代值后的命令压成一行、截断 —— 它只负责「认得出这条是哪条」，
       完整的命令在确认框里逐字展示。 */
    function quickPreviewOf(template, ctx) {
      const resolved = resolveQuickCommand(template, ctx, null)
      const oneLine = resolved.command.replace(/\s+/g, ' ').trim()
      return oneLine.length > 64 ? oneLine.slice(0, 63) + '…' : oneLine
    }

    /* 新快捷命令的稳定 id：名称+时间戳（同一毫秒里连按两次保存也各有各的序号）。 */
    let quickCommandSeq = 0
    function quickCommandId(name) {
      quickCommandSeq += 1
      return name.trim().slice(0, 40) + '-' + String(Date.now()) + '-' + String(quickCommandSeq)
    }

    /* ── 下拉的开合：点外面 / Esc 关掉 ──

       面板在 panelNode 的 document 上收捕获阶段的 pointerdown 与 Escape。boxes 是视为
       「里面」的节点盒（菜单自己 + 触发按钮）：按钮必须算里面，否则点它会先被这里关掉、
       随后的 click 又把它打开，菜单就永远关不上了。effect 只随 open 重挂，所以 onClose
       里只允许调用稳定的 setState。 */
    function useOutsideDismiss(open, onClose, boxes) {
      React.useEffect(function () {
        if (open !== true) return undefined
        const doc = panelNode != null ? panelNode.ownerDocument : null
        if (doc == null || typeof doc.addEventListener !== 'function') return undefined
        const inside = function (target) {
          if (target == null || typeof target.nodeType !== 'number') return false
          for (let i = 0; i < boxes.length; i += 1) {
            const node = boxes[i] != null ? boxes[i].node : null
            if (node != null && typeof node.contains === 'function' && node.contains(target)) return true
          }
          return false
        }
        const onDown = function (event) { if (inside(event.target) !== true) onClose() }
        const onKey = function (event) { if (event.key === 'Escape') onClose() }
        doc.addEventListener('pointerdown', onDown, true)
        doc.addEventListener('keydown', onKey, true)
        return function () {
          doc.removeEventListener('pointerdown', onDown, true)
          doc.removeEventListener('keydown', onKey, true)
        }
      }, [open])
    }

    /* ── ⋯ 菜单：压缩提交 + 删除提交 + 删除分支 ──

       压缩/删除的区间由面板算（它才有图、单选和多选），这里只放入口；删除分支照
       branchpicker 的成熟交互：-d 被拒（提交没合并到别处）才给出 -D，两段式确认。 */
    function MoreActionsMenu(props) {
      const [box] = React.useState(function () { return { node: null } })
      const [delOpen, setDelOpen] = React.useState(false)
      /* 两段式确认记的是「哪一行、哪一段」：'name' = 删除已 armed，'force:name' = 强删已 armed。 */
      const [delArm, setDelArm] = React.useState('')
      /* -d 被拒后为那个分支给出的「强制删除（-D）」通道；别的时候不出现。 */
      const [delForce, setDelForce] = React.useState('')
      const [delBusy, setDelBusy] = React.useState(false)
      useOutsideDismiss(props.open, props.onClose, [box, props.trigger])
      if (props.open !== true) return null

      const remove = function (name, force) {
        if (delBusy === true || props.busy === true) return
        setDelBusy(true)
        rpc('git/branch-delete', Object.assign({}, props.reqBase, { name: name, force: force === true }), '删除分支失败')
          .then(function () {
            setDelBusy(false)
            bumpData()
            setDelArm('')
            setDelForce('')
            props.onNote('已删除分支 ' + name + (force === true ? '（强制 -D，未合并的提交已随分支丢弃）' : ''))
            props.onClose()
          }, function (failure) {
            const detail = failureText(failure)
            setDelBusy(false)
            bumpData()
            if (force !== true && detail.indexOf('not fully merged') >= 0) {
              /* 和 branchpicker 同一句话：拒绝的原因说清楚，-D 的决定留给读者。 */
              setDelForce(name)
              setDelArm('')
              props.onError('git 拒绝安全删除 ' + name + '：它的提交还没有合并到别处。')
              return
            }
            props.onError(detail)
          })
      }

      const locals = props.refs != null && props.refs.ok === true && Array.isArray(props.refs.local)
        ? props.refs.local : null
      const branchRows = []
      if (locals == null) {
        branchRows.push(h('div', { key: 'r:none', className: 'dsh-git-menu-dim dsh-git-menu-pad' }, '无法读取分支'))
      } else if (locals.length === 0) {
        branchRows.push(h('div', { key: 'r:none', className: 'dsh-git-menu-dim dsh-git-menu-pad' }, '这个仓库还没有本地分支'))
      } else {
        for (let i = 0; i < locals.length; i += 1) {
          const name = text(locals[i].data)
          if (name === props.current) {
            /* 当前分支也列出来（看得见它为什么不能删），但禁用并说明。 */
            branchRows.push(h('button', {
              key: 'r:' + name, type: 'button', className: 'dsh-git-menu-item dsh-git-menu-branch',
              disabled: true, title: '当前所在的分支，git 不删除自己',
            }, name, h('span', { key: 'c', className: 'dsh-git-menu-dim' }, '当前分支')))
            continue
          }
          if (delForce === name) {
            const armed = delArm === 'force:' + name
            branchRows.push(h('button', {
              key: 'r:' + name, type: 'button',
              className: 'dsh-git-menu-item dsh-git-menu-branch dsh-git-menu-danger',
              title: armed ? 'git branch -D ' + name + ' —— 没合并的提交会随分支丢弃'
                : 'git branch -d 被拒：这些提交还没有合并到别处，只有 -D 能删',
              disabled: delBusy === true || props.busy === true,
              onClick: function (event) {
                stopEvent(event)
                if (armed === true) remove(name, true)
                else setDelArm('force:' + name)
              },
            }, armed ? '确认强制删除 ' + name : '强制删除（-D）'))
            continue
          }
          if (delArm === name) {
            branchRows.push(h('button', {
              key: 'r:' + name, type: 'button',
              className: 'dsh-git-menu-item dsh-git-menu-branch dsh-git-menu-danger',
              title: 'git branch -d ' + name,
              disabled: delBusy === true || props.busy === true,
              onClick: function (event) { stopEvent(event); remove(name, false) },
            }, '确认删除 ' + name))
            continue
          }
          branchRows.push(h('button', {
            key: 'r:' + name, type: 'button', className: 'dsh-git-menu-item dsh-git-menu-branch',
            title: 'git branch -d ' + name + '（再点一次确认）',
            disabled: delBusy === true || props.busy === true,
            onClick: function (event) { stopEvent(event); setDelArm(name); setDelForce('') },
          }, name, h('span', { key: 'a', className: 'dsh-git-menu-dim' }, '删除')))
        }
      }

      return h('div', { className: 'dsh-git-menu', ref: function (node) { box.node = node } },
        h('button', {
          key: 'squash', type: 'button', className: 'dsh-git-menu-item',
          disabled: props.count < 2,
          title: props.count >= 2
            ? '把从 HEAD 到最旧所选的整段区间压成一个提交（soft reset 到最旧选中项的父提交，再提交；须在当前分支的无筛选视图里选）'
            : 'Ctrl+点击提交行选择多个提交（至少 2 个，最新端要选到列表第一行的 HEAD）',
          onClick: function (event) { stopEvent(event); if (props.count >= 2) props.onSquash() },
        }, '压缩提交' + (props.count >= 2 ? '（已选 ' + String(props.count) + ' 个）' : '')),
        /* 删除与压缩同一个区间语义（HEAD 到最旧所选的整段），差别只在 reset 的 soft/hard：
           压缩把整段收进一个新提交，删除连提交带改动一起丢。生效集合比压缩宽一档 ——
           没有多选时作用于单选那条（和左边那四个工具一致），所以 N≥1 就能点。 */
        h('button', {
          key: 'drop', type: 'button', className: 'dsh-git-menu-item',
          disabled: props.dropCount < 1,
          title: props.dropCount >= 1
            ? '把从 HEAD 到最旧所选的整段区间连提交带改动一起从分支尖端丢弃（hard reset 到最旧选中项的父提交；改动不保留，须在当前分支的无筛选视图里选）'
            : '先在历史里点选一个提交，或 Ctrl+点击 选一段（最新端要选到列表第一行的 HEAD）',
          onClick: function (event) { stopEvent(event); if (props.dropCount >= 1) props.onDrop() },
        }, '删除提交' + (props.dropCount >= 1 ? '（已选 ' + String(props.dropCount) + ' 个）' : '')),
        h('div', { key: 's1', className: 'dsh-git-menu-sep' }),
        h('button', {
          key: 'delh', type: 'button', className: 'dsh-git-menu-item',
          title: '删除这个仓库的本地分支（当前分支除外）',
          onClick: function (event) {
            stopEvent(event)
            setDelOpen(delOpen !== true)
            setDelArm('')
            setDelForce('')
          },
        }, '删除分支' + (delOpen ? ' ▴' : ' ▾')),
        delOpen === true ? h('div', { key: 'del', className: 'dsh-git-menu-sub' }, branchRows) : null,
        delBusy === true ? h('div', { key: 'w', className: 'dsh-git-menu-dim dsh-git-menu-pad' }, '正在删除…') : null)
    }

    /* ── ⚡ 菜单：快捷命令列表 + 新建/管理 ── */
    function QuickCommandsMenu(props) {
      const [box] = React.useState(function () { return { node: null } })
      useOutsideDismiss(props.open, props.onClose, [box, props.trigger])
      if (props.open !== true) return null
      const items = []
      if (props.commands.length === 0) {
        items.push(h('div', { key: 'none', className: 'dsh-git-menu-dim dsh-git-menu-pad' },
          '还没有快捷命令。第一条可以是：git log --oneline -20 {branch}'))
      } else {
        for (let i = 0; i < props.commands.length; i += 1) {
          const one = props.commands[i]
          items.push(h('button', {
            key: 'c:' + one.id, type: 'button', className: 'dsh-git-menu-item dsh-git-menu-cmd',
            /* title 给完整的代值结果（预览那行是截断的），确认框里还有逐字的一份。 */
            title: resolveQuickCommand(text(one.command), props.ctx, null).command,
            onClick: function (event) { stopEvent(event); props.onPick(one) },
          },
            h('span', { key: 'n', className: 'dsh-git-menu-name' }, text(one.name)),
            h('span', { key: 'p', className: 'dsh-git-menu-dim' }, quickPreviewOf(text(one.command), props.ctx))))
        }
      }
      return h('div', { className: 'dsh-git-menu', ref: function (node) { box.node = node } },
        items,
        h('div', { key: 's', className: 'dsh-git-menu-sep' }),
        h('button', {
          key: 'new', type: 'button', className: 'dsh-git-menu-item',
          title: '新建一条命令模板（变量按当前分支和选中的提交代值）',
          onClick: function (event) { stopEvent(event); props.onCreate() },
        }, '新建快捷命令…'),
        h('button', {
          key: 'edit', type: 'button', className: 'dsh-git-menu-item',
          title: '列出全部快捷命令，编辑或删除',
          onClick: function (event) { stopEvent(event); props.onManage() },
        }, '管理快捷命令…'))
    }

    /* ── 统一执行确认框：无论有没有输入变量 ──

       完整解析后的命令逐字展示（等宽、pre-wrap、不截断）；有 {input:…} 就在上面按提示语
       逐个给输入框（预填默认值，输入变化实时重算预览）；变量代不了值时红字说明缺什么、
       「执行」禁用。Enter 执行、Esc 取消。 */
    function QuickCommandConfirm(props) {
      const def = props.def
      const inputs = quickInputsOf(text(def.command))
      const [values, setValues] = React.useState(function () {
        const seed = []
        for (let i = 0; i < inputs.length; i += 1) seed.push(inputs[i].fallback)
        return seed
      })
      const resolved = resolveQuickCommand(text(def.command), props.ctx, values)
      const blocked = resolved.missing.length > 0
      const run = function () {
        if (blocked === true) return
        props.onExecute(resolved.command)
      }
      const onKey = function (event) {
        if (event.key === 'Enter') { event.preventDefault(); run() }
        if (event.key === 'Escape') { event.preventDefault(); props.onClose() }
      }
      const change = function (at, value) {
        setValues(function (previous) {
          const next = previous.slice()
          next[at] = value
          return next
        })
      }
      return h('div', { className: 'dsh-git-qc-box', onKeyDown: onKey },
        h('div', { key: 'h', className: 'dsh-git-qc-head' }, '执行快捷命令：' + text(def.name)),
        inputs.map(function (one, at) {
          return h('label', { key: 'i' + at, className: 'dsh-git-qc-inrow' },
            h('span', { key: 'l', className: 'dsh-git-qc-inhint' }, one.hint),
            h('input', {
              key: 'v', className: 'dsh-git-input', autoFocus: at === 0,
              value: values[at] === undefined ? '' : values[at],
              onChange: function (event) { change(at, event.target.value) },
              onKeyDown: onKey,
            }))
        }),
        h('div', { key: 'p', className: 'dsh-git-qc-pre', title: '变量代值后的整条命令' }, resolved.command),
        blocked === true
          ? h('div', { key: 'm', className: 'dsh-git-error' },
              '还代不了值：' + resolved.missing.map(function (key) { return '{' + key + '}' }).join('、')
              + ' —— ' + quickMissingWhy(resolved.missing[0]))
          : null,
        h('div', { key: 'a', className: 'dsh-git-qc-actions' },
          h('button', {
            key: 'ok', type: 'button', className: 'dsh-git-btn dsh-git-primary',
            disabled: blocked === true, onClick: function (event) { stopEvent(event); run() },
            /* 没有 {input:…} 输入框时聚焦这里：Enter 要有人接着才按得动（键从焦点冒泡
               到 onKeyDown，Esc 的关闭同理）。 */
            autoFocus: inputs.length === 0,
          }, '执行'),
          h('button', {
            key: 'no', type: 'button', className: 'dsh-git-btn',
            onClick: function (event) { stopEvent(event); props.onClose() },
          }, '取消')))
    }

    /* ── 快捷命令编辑器：列表态 + 编辑态 ──

       面板（覆盖层）与设置页（管理组）共用。配置读写走 usePluginConfig / savePluginConfig
       —— 那一层已经有 400ms 去抖和 Host 的归一化，这里不另开炉灶。上限 50 条：超出的那次
       新增不保存，并把原因说在编辑器里（归一化里的截断只是兜底）。 */
    function QuickCommandsEditor(props) {
      const plugin = usePluginConfig()
      const commands = plugin != null && Array.isArray(plugin.quickCommands) ? plugin.quickCommands : []
      const [mode, setMode] = React.useState(props.initial === 'edit' ? 'edit' : 'list')
      const [draft, setDraft] = React.useState({ id: null, name: '', command: '' })
      const [problem, setProblem] = React.useState('')
      const [armDel, setArmDel] = React.useState('')
      const [areaBox] = React.useState(function () { return { node: null } })

      const startNew = function () {
        setDraft({ id: null, name: '', command: '' })
        setProblem('')
        setArmDel('')
        setMode('edit')
      }
      const startEdit = function (one) {
        setDraft({ id: one.id, name: text(one.name), command: text(one.command) })
        setProblem('')
        setArmDel('')
        setMode('edit')
      }
      const backToList = function () {
        setProblem('')
        setArmDel('')
        setMode('list')
      }

      const save = function () {
        const name = draft.name.trim()
        const command = draft.command
        if (name.length === 0 || command.trim().length === 0) { setProblem('名称和命令模板都要填'); return }
        if (command.length > QUICK_TEMPLATE_MAX) {
          setProblem('命令模板太长（' + String(command.length) + ' / ' + String(QUICK_TEMPLATE_MAX) + ' 字符）')
          return
        }
        const list = commands.slice()
        let at = -1
        for (let i = 0; i < list.length; i += 1) if (list[i].id === draft.id) { at = i; break }
        if (at < 0) {
          if (list.length >= QUICK_COMMANDS_MAX) {
            setProblem('最多 ' + String(QUICK_COMMANDS_MAX) + ' 条 —— 先删掉几条再新增，这条没有保存')
            return
          }
          list.push({ id: quickCommandId(name), name: name, command: command })
        } else {
          list[at] = { id: draft.id, name: name, command: command }
        }
        savePluginConfig(Object.assign({}, plugin, { quickCommands: list }))
        setProblem('')
        setMode('list')
      }

      /* 删除也走两段式：第一次点把按钮换成「确认删除」，配置只在第二次点时写。 */
      const drop = function (one) {
        if (armDel !== one.id) { setArmDel(one.id); return }
        const next = []
        for (let i = 0; i < commands.length; i += 1) if (commands[i].id !== one.id) next.push(commands[i])
        savePluginConfig(Object.assign({}, plugin, { quickCommands: next }))
        setArmDel('')
      }

      /* 变量 chip：插进光标处；拿不到光标（还没聚焦过）就追加到末尾。 */
      const insertToken = function (label) {
        const node = areaBox.node
        if (node == null || typeof node.selectionStart !== 'number') {
          setDraft(function (previous) {
            return { id: previous.id, name: previous.name, command: previous.command + label }
          })
          return
        }
        const at = node.selectionStart
        const end = node.selectionEnd
        const command = draft.command.slice(0, at) + label + draft.command.slice(end)
        setDraft({ id: draft.id, name: draft.name, command: command })
        /* 光标挪到刚插的变量后面，连续插两个变量不用手动挪；没有这个 API 的环境跳过
           （值本身已经写进去了）。 */
        if (typeof node.setSelectionRange === 'function') node.setSelectionRange(at + label.length, at + label.length)
      }

      if (mode === 'edit') {
        const chips = []
        for (let i = 0; i < QUICK_VARS.length; i += 1) {
          const one = QUICK_VARS[i]
          chips.push(h('button', {
            key: 'v' + i, type: 'button', className: 'dsh-git-qc-chip', title: one.desc,
            onClick: function (event) { stopEvent(event); insertToken(one.label) },
          }, one.label))
        }
        chips.push(h('button', {
          key: 'vin', type: 'button', className: 'dsh-git-qc-chip', title: QUICK_INPUT_DESC,
          onClick: function (event) { stopEvent(event); insertToken(QUICK_INPUT_LABEL) },
        }, QUICK_INPUT_LABEL))
        const varRows = []
        for (let i = 0; i < QUICK_VARS.length; i += 1) {
          varRows.push(h('div', { key: 't' + i, className: 'dsh-git-qc-varrow' },
            h('span', { key: 'l', className: 'dsh-git-qc-varname' }, QUICK_VARS[i].label),
            h('span', { key: 'd', className: 'dsh-git-menu-dim' }, QUICK_VARS[i].desc)))
        }
        varRows.push(h('div', { key: 'tin', className: 'dsh-git-qc-varrow' },
          h('span', { key: 'l', className: 'dsh-git-qc-varname' }, QUICK_INPUT_LABEL),
          h('span', { key: 'd', className: 'dsh-git-menu-dim' }, QUICK_INPUT_DESC)))
        return h('div', { className: 'dsh-git-qc-box' },
          h('div', { key: 'h', className: 'dsh-git-qc-head' }, draft.id == null ? '新建快捷命令' : '编辑快捷命令'),
          h('label', { key: 'n', className: 'dsh-git-qc-field' },
            h('span', { key: 'k', className: 'dsh-git-qc-k' }, '名称'),
            clearable('ni', h('input', {
              className: 'dsh-git-input', placeholder: '显示在 ⚡ 菜单里的名字', autoFocus: true,
              value: draft.name,
              onChange: function (event) {
                setDraft({ id: draft.id, name: event.target.value, command: draft.command })
              },
            }), draft.name.length > 0, function () {
              setDraft({ id: draft.id, name: '', command: draft.command })
            })),
          h('label', { key: 'c', className: 'dsh-git-qc-field' },
            h('span', { key: 'k', className: 'dsh-git-qc-k' }, '命令模板'),
            clearable('ci', h('textarea', {
              className: 'dsh-git-input', rows: 4,
              placeholder: '例：git log --oneline -20 {branch}\n或：git push --force-with-lease {upstream}',
              value: draft.command,
              ref: function (node) { areaBox.node = node },
              onChange: function (event) {
                setDraft({ id: draft.id, name: draft.name, command: event.target.value })
              },
            }), draft.command.length > 0, function () {
              setDraft({ id: draft.id, name: draft.name, command: '' })
            }, 'dsh-git-clearable-area')),
          h('div', { key: 'p', className: 'dsh-git-qc-hint' }, '点一个变量插到光标处：'),
          h('div', { key: 'ch', className: 'dsh-git-qc-chips' }, chips),
          h('div', { key: 'vt', className: 'dsh-git-qc-vars' }, varRows),
          problem.length > 0 ? h('div', { key: 'er', className: 'dsh-git-error' }, problem) : null,
          h('div', { key: 'a', className: 'dsh-git-qc-actions' },
            h('button', { key: 'ok', type: 'button', className: 'dsh-git-btn dsh-git-primary', onClick: save }, '保存'),
            h('button', { key: 'no', type: 'button', className: 'dsh-git-btn', onClick: backToList }, '取消')))
      }

      const rows = []
      if (commands.length === 0) {
        rows.push(h('div', { key: 'none', className: 'dsh-git-menu-dim dsh-git-qc-empty' },
          '还没有快捷命令。建一条试试，变量按当前分支和选中的提交代值：',
          h('br'), 'git log --oneline -20 {branch}',
          h('br'), 'git push --force-with-lease {upstream}'))
      } else {
        for (let i = 0; i < commands.length; i += 1) {
          const one = commands[i]
          rows.push(h('div', { key: one.id, className: 'dsh-git-qc-row' },
            h('span', { key: 'n', className: 'dsh-git-qc-name', title: text(one.name) }, text(one.name)),
            h('span', { key: 'c', className: 'dsh-git-qc-cmd', title: text(one.command) }, text(one.command)),
            h('button', {
              key: 'e', type: 'button', className: 'dsh-git-btn', title: '编辑这条快捷命令',
              onClick: function (event) { stopEvent(event); startEdit(one) },
            }, '编辑'),
            h('button', {
              key: 'd', type: 'button',
              className: 'dsh-git-btn' + (armDel === one.id ? ' dsh-git-danger' : ''),
              title: armDel === one.id ? '再点一次确认删除' : '删除这条快捷命令',
              onClick: function (event) { stopEvent(event); drop(one) },
            }, armDel === one.id ? '确认删除' : '删除')))
        }
      }
      return h('div', { className: 'dsh-git-qc-box' },
        h('div', { key: 'h', className: 'dsh-git-qc-head' },
          '快捷命令' + (commands.length > 0
            ? '（' + String(commands.length) + '/' + String(QUICK_COMMANDS_MAX) + '）' : ''),
          props.onClose != null ? h('button', {
            key: 'x', type: 'button', className: 'dsh-git-qc-x', title: '关闭编辑器',
            onClick: function (event) { stopEvent(event); props.onClose() },
          }, '×') : null),
        rows,
        h('div', { key: 'a', className: 'dsh-git-qc-actions' },
          h('button', { key: 'new', type: 'button', className: 'dsh-git-btn', onClick: startNew }, '新增'),
          h('span', { key: 'n', className: 'dsh-git-menu-dim' }, '保存在插件配置里，面板和设置页共用同一份')))
    }
