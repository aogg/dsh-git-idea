    ctx.effect(function () {
      return styles.insert(`
.dsh-git-chip{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:264px;padding:0 10px;border:none;border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;flex:none}
.dsh-git-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-chip-open{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-git-chip-repo{color:var(--dsw-alias-label-primary)}
.dsh-git-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.dsh-git-chip-idle{opacity:.72}
/* 切换分支的时候图标转起来：慢盘上一次切换好几秒，卡片早就收起来了，能看见的
   只剩这个图标。只转，不改尺寸，所以没有任何布局位移。 */
@keyframes dsh-git-spin{to{transform:rotate(360deg)}}
.dsh-git-spin{animation:dsh-git-spin .9s linear infinite;transform-origin:50% 50%}
.dsh-git-badge{display:inline-grid;place-items:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:10px;line-height:1;flex:none}
/* 上一个测量值还在，新的还没回来：留个位置，但看得出来还没核对 */
.dsh-git-badge-stale{opacity:.45}
/* chip 上「字符 + 数字」的三小组（● 改动数、↓ 落后上游、↑ 领先上游）：组内贴得比
   chip 本身的 6px 更紧（3px，同顶部同步组 tool 键 4px 一档），字符色跟随 chip 文字色。 */
.dsh-git-chip-grp{display:inline-flex;align-items:center;gap:3px;flex:none}
.dsh-git-chip-n{display:inline-grid;place-items:center;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:9px;line-height:1;flex:none}
.dsh-git-pop{position:absolute;left:8px;right:8px;bottom:100%;margin-bottom:8px;z-index:30;pointer-events:auto;box-sizing:border-box;height:74vh;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);font-size:12px}
.dsh-git-top{display:flex;align-items:center;gap:8px;row-gap:6px;flex-wrap:wrap;flex:none;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);position:relative}
.dsh-git-tabs{display:flex;gap:2px;flex:none}
.dsh-git-tab{border:none;background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer}
.dsh-git-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-tab-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-git-title{font-weight:600;flex:none}
.dsh-git-dim{color:var(--dsw-alias-label-secondary)}
.dsh-git-body{flex:1;display:flex;min-height:0}
.dsh-git-side{width:200px;flex:none;overflow:auto;padding:4px 0;border-right:1px solid var(--dsw-alias-border-l1)}
.dsh-git-main{flex:1;min-width:0;display:flex;flex-direction:column}
.dsh-git-detail{width:280px;flex:none;overflow:auto;padding:6px 8px;border-left:1px solid var(--dsw-alias-border-l1)}
.dsh-git-detail-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative}
.dsh-git-detail-foot{position:absolute;left:0;right:0;bottom:8px;text-align:center;font-size:11px}
/* IDEA's log toolbar: a bordered search box, then the filters as inline
   "name: value" triggers that each clear themselves. Nothing else is a box, and
   there is no second filter row, so the graph keeps that height. */
.dsh-git-logsearch{display:inline-flex;align-items:center;gap:4px;flex:1 1 120px;min-width:80px;max-width:240px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-base)}
.dsh-git-logsearch:focus-within{border-color:var(--dsw-alias-brand-primary)}
.dsh-git-logsearch-ico{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.dsh-git-logsearch-input{flex:1 1 auto;width:auto;min-width:0;border:0;background:transparent;outline:none;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);padding:2px 0}
.dsh-git-logsearch-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dsh-git-logsearch-x{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;line-height:1}
.dsh-git-logsearch-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-git-tsep{flex:none;width:1px;height:14px;margin:0 3px;background:var(--dsw-alias-border-l1)}
.dsh-git-lf{display:inline-flex;align-items:center;gap:2px;flex:0 1 auto;min-width:0;height:22px;padding:0 4px;border-radius:5px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-git-lf:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-lf-on{color:var(--dsw-alias-brand-primary)}
.dsh-git-lf-k{flex:none;color:inherit;opacity:.85}
.dsh-git-lf-select{appearance:none;-webkit-appearance:none;-moz-appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-family:inherit;padding:0;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;cursor:pointer;outline:none}
.dsh-git-lf-select option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-git-lf-caret{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary);pointer-events:none}
.dsh-git-lf-input{flex:0 1 auto;min-width:0;border:0;background:transparent;outline:none;font:inherit;font-size:11px;font-family:inherit;color:var(--dsw-alias-label-primary);padding:0}
.dsh-git-lf-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dsh-git-lf-x{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;padding:0;border:0;border-radius:3px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:1}
.dsh-git-lf-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-git-lf-flag{flex:none;padding:1px 5px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;cursor:pointer}
.dsh-git-lf-flag:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-lf-flag.dsh-git-lf-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-git-lclear{flex:none;padding:1px 6px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.dsh-git-lclear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-git-count{position:absolute;right:8px;top:5px;flex:none;font-size:11px;line-height:26px}
.dsh-git-log{flex:1;overflow:auto}
.dsh-git-trow{display:flex;align-items:center;gap:6px;padding:2px 6px 2px 6px;cursor:pointer;white-space:nowrap;border-radius:4px;-webkit-user-select:none;user-select:none}
.dsh-git-trow:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-git-trow-sel{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-trow-sel:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 树的缩进是行内的一个空块，不是行的 padding：勾选框要留在最左边一列才对得齐
   （见 54-changes.js 里的注释）。 */
.dsh-git-tind{flex:none;height:1px}
.dsh-git-tdir{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
/* The branch the graph is currently scoped to. Distinct from the selection: the
   selection moves on a single click, this only moves on a double click. */
.dsh-git-tdirty{flex:none;margin-left:auto;padding:0 4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-warn-primary);font-size:10px;line-height:15px}
.dsh-git-trow-head .dsh-git-tname{font-weight:600}
.dsh-git-trow-scope{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.dsh-git-trow-scope .dsh-git-tname{color:var(--dsw-alias-brand-primary)}
.dsh-git-tw{flex:none;width:10px;color:var(--dsw-alias-label-secondary);font-size:9px;cursor:pointer}
.dsh-git-tname{overflow:hidden;text-overflow:ellipsis;min-width:0}
/* 分支行名字下面的一行小字（50-log.js）：这个分支跟踪的上游名。纵向列包住名字与
    小字，两者同宽、一起省略；行高压到 12px 让行只多出一小截，树不至于胖一圈。 */
.dsh-git-tmain{display:flex;flex-direction:column;justify-content:center;min-width:0}
.dsh-git-tsub{max-width:100%;overflow:hidden;text-overflow:ellipsis;font-size:10px;line-height:12px;color:var(--dsw-alias-label-secondary)}
/* 没有上游的「未跟踪」再淡一档：它是「这里什么都没有」，不该和真有个名字的上游
    抓一样的眼。 */
.dsh-git-tsub-none{opacity:.55}
/* 扁平视图里跟在文件名后面的目录：压暗、小一号。名字必须排在前面，否则一条 120 字
   的路径先把自己铺满，被裁掉的正好是文件名（见 54-changes.js 的注释）。 */
.dsh-git-tpath{color:var(--dsw-alias-label-secondary);font-size:11px;margin-left:8px}
/* The count belongs to the name it counts, not to the right-hand edge of the
   row: "本地 5" reads as one thing, "本地 … 5" makes the eye travel. */
.dsh-git-tdim{flex:none;padding-right:6px;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-git-st{flex:none;width:12px;font-family:ui-monospace,monospace;font-weight:700}
.dsh-git-st-M{color:var(--dsw-alias-state-warn-primary)}
.dsh-git-st-A{color:var(--dsw-alias-state-success-primary)}
.dsh-git-st-D{color:var(--dsw-alias-state-error-primary)}
.dsh-git-st-R{color:var(--dsw-alias-brand-primary)}
.dsh-git-st-C{color:var(--dsw-alias-brand-primary)}
.dsh-git-st-U{color:var(--dsw-alias-state-error-primary)}
/* 未解决的合并冲突（UU/AA/DU…）：红色加粗的双码，和修改的黄色单字母一眼分开。
   槽位只有 12px（装一个字母的），双码还回 width:auto 才装得下两个字。 */
.dsh-git-st-CF{color:var(--dsw-alias-state-error-primary);font-weight:700;width:auto}
.dsh-git-cbox{flex:none;width:14px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-git-cbox-on{color:var(--dsw-alias-brand-primary)}
.dsh-git-cbox-part{color:var(--dsw-alias-state-warn-primary)}
.dsh-git-changes{flex:1;display:flex;min-height:0}
.dsh-git-changes-tree{flex:1;min-width:0;display:flex;flex-direction:column}
/* ── 树 / 扁平：视图开关 ──
   只在变更页出现，住在面板头部，和 IDEA 把这一组放在工具窗自己的工具条上一样。
   它以前在列表上方单独占一行：两个词花掉列表一整行的高度。现在那点高度还给行。
   两个按钮做成一段凹槽里的选择，和头部那两个页签区分开 —— 页签换的是「看哪一页」，
   这个换的是「这一页怎么读」。 */
.dsh-git-cviews{display:inline-flex;flex:none;gap:2px;margin-left:auto;padding:2px;border-radius:7px;background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-cview{border:none;background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;line-height:16px;padding:1px 8px;border-radius:5px;cursor:pointer}
.dsh-git-cview:hover{color:var(--dsw-alias-label-primary)}
.dsh-git-cview-on{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-git-clist{flex:1;overflow:auto;padding:4px 0}
/* 分组标题（默认变更列表 / 未跟踪的文件）读起来得像标题，但它仍然是树里的一行：
   同样的手势、同样的悬停与选中。 */
.dsh-git-cgroup{margin-top:4px}
.dsh-git-cgroup .dsh-git-tname{font-weight:600}
/* ── 默认变更列表的工具条（54-changes.js）：添加 / 还原 / 暂存 ──
    类名刻意不用 dsh-git-tool：那个类说的是「作用于选中提交的工具」（拣选/还原/标签/
    分支——现在住在提交行的右键菜单里，同步组 ⟳⇣↓↑ 也还在用），测试也按个数认它
    （78-actions.js 开头说明了原因）——这一排是对一组勾选做事，名字分开对两边都诚实。
    左边 20px 让按钮避开勾选框那一列，和组里的行对得上。 */
.dsh-git-ctools{display:flex;align-items:center;gap:4px;flex:none;padding:1px 6px 3px 20px}
.dsh-git-ctool{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);border-radius:4px;padding:1px 8px;font-size:11px;font-family:inherit;line-height:16px;cursor:pointer;flex:none}
.dsh-git-ctool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-ctool:disabled{opacity:.45;cursor:default}
/* 还原的两段式确认：第一次点之后按钮变红（和删除分支的确认同一个 danger 语义 ——
    下一次点击不可撤销）。 */
.dsh-git-ctool-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-git-commitpane{width:304px;flex:none;border-left:1px solid var(--dsw-alias-border-l1);padding:8px;display:flex;flex-direction:column;gap:8px}
/* ── 窄屏的提交栏折叠（54-changes.js useNarrowWidth 判定，阈值 560px）──
    手机窄屏上 304px 的提交栏占掉大半宽度，默认整个收成一条，点了才全宽展开。
    这组选择器全部带 .dsh-git-changes-narrow 前缀、只挂在窄屏：宽屏一条都不命中，
    DOM 与样式和从前一字不差 —— 本功能的不变量（测试按 dsh-git-commitpane 里的
    textarea 找输入框，量不到宽度的环境一律走宽屏分支）。 */
.dsh-git-changes-narrow{flex-direction:column}
/* 纵列之后树靠 min-height:0 才肯把高度让出来：横排时宽度方向的 min-width:0 已
    写在 .dsh-git-changes-tree 上，纵排还差高度这一眼 —— 没有它树不缩、clist 不
    滚，展开的提交栏会把文件树挤出面板。 */
.dsh-git-changes-narrow .dsh-git-changes-tree{min-height:0}
/* 提交栏全宽：宽度交还布局（width:auto），与树的分隔线从左缘改到上缘（它在纵列
    的树下面）。max-height 60%：6 行的 textarea 加警告条和按钮比矮面板还高，不钳
    的话树被挤成一条缝；六成之外整块还给树，树自己滚。 */
.dsh-git-changes-narrow .dsh-git-commitpane{width:auto;max-height:60%;border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}
/* 折叠态那条展开条：与树之间也是上缘分隔线（同在纵列里）；高度对着头部 chip 的
    28px —— 手机上拇指点得中的最小一档。 */
.dsh-git-commitbar{flex:none;display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-top:1px solid var(--dsw-alias-border-l1);cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsh-git-commitbar:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-git-commitbar-label{font-weight:600}
.dsh-git-commitbar-glyph{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px}
/* 草稿非空的 ●：栏收起来了，「有没写完的话」还得看得见 —— 品牌色，和提交按钮
    同一源。 */
.dsh-git-commitbar-dirty{flex:none;color:var(--dsw-alias-brand-primary);font-size:10px}
.dsh-git-commitbar-count{flex:none;margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px}
/* 窄屏展开态的栏头收起键：同一只开关的另一副面孔（▾ = 点我收起）。字级字重仍是
    group-title 的，读起来还是那个标题，只是可点 —— cursor 与悬停变亮说明这件事。 */
.dsh-git-commitpane-fold{cursor:pointer}
.dsh-git-commitpane-fold:hover{color:var(--dsw-alias-label-primary)}
/* ── 宽屏的提交栏折叠（第二轮：收起键常驻，不再只窄屏有）──
    宽屏的 .dsh-git-changes 是横排，折叠态的展开条不在树底下，而是右缘一条竖条：
    28px 宽、左缘分隔线，vertical-rl 让「提交信息 ▸」顺着条竖着读，● 与计数跟着
    竖排（base 的 margin-left:auto 是横排把计数推到远端的推法，竖条里归零）；base
    那条 border-top 是窄屏纵列的上缘分隔线，宽屏变体里归零。选择器带
    :not(.dsh-git-changes-narrow)，窄屏一条都不命中 —— 窄屏行为与上一版完全一致。 */
.dsh-git-changes:not(.dsh-git-changes-narrow) .dsh-git-commitbar{width:28px;height:auto;align-self:stretch;padding:8px 0;border-top:0;border-left:1px solid var(--dsw-alias-border-l1);writing-mode:vertical-rl;justify-content:center}
.dsh-git-changes:not(.dsh-git-changes-narrow) .dsh-git-commitbar-count{margin-left:0}
/* ── 历史页右栏的窄屏折叠（80-panel.js 量 .dsh-git-body，阈值同 560px）──
    dsh-git-detailbar：折叠态右缘那条竖向展开条，与宽屏的 commitbar 同一副骨架
    （28px、左缘线、竖排文字）；dsh-git-detailwrap / dsh-git-detailfold：窄屏展开
    态的纵排容器与顶上那条收起键 —— 同一只开关（detailOpen）的两副面孔。这些类
    只在窄屏由 JS 挂上，宽屏 DOM 里根本不出现；CommitDetail 与 .dsh-git-detail
    原样，detail 自己的 border-left 和 280px 都在。 */
.dsh-git-detailbar{width:28px;flex:none;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px 0;border-left:1px solid var(--dsw-alias-border-l1);cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none;font-size:12px;color:var(--dsw-alias-label-primary);writing-mode:vertical-rl}
.dsh-git-detailbar:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-git-detailbar-label{font-weight:600}
.dsh-git-detailbar-glyph{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px}
.dsh-git-detailbar-count{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-git-detailwrap{flex:none;display:flex;flex-direction:column;min-height:0}
/* 详情栏在本就有的 overflow:auto 之外补上「肯缩」的两眼：flex:1 占满包裹层的余高、
    min-height:0 允许被顶上的收起键压矮 —— 没有它们内容比栏高时整块往下溢。 */
.dsh-git-detailwrap .dsh-git-detail{flex:1;min-height:0}
/* 收起键（▾ = 点我收起）：28px 高对齐头部 chip，横排 —— 它站在详情栏顶上。 */
.dsh-git-detailfold{flex:none;display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsh-git-detailfold:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-git-detailfold-label{font-weight:600}
.dsh-git-detailfold-glyph{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px}
.dsh-git-crow{display:flex;align-items:center;gap:8px;height:26px;box-sizing:border-box;padding:0 8px;cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none}
.dsh-git-crow:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-git-crow-sel{background:var(--dsw-alias-interactive-bg-hover)}
/* 选中的那一行悬浮上去仍然是选中色：两条规则权重一样（一个类 + 一个伪类），
   谁写在后面谁赢 —— 少了这一条，鼠标一放上去选中色就被悬停色顶掉，看起来
   就像选中丢了。分支树的行一直是这个规矩。 */
.dsh-git-crow-sel:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-subject{flex:1;overflow:hidden;text-overflow:ellipsis}
.dsh-git-author{flex:none;width:84px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-git-date{flex:none;width:112px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-git-refs{display:flex;gap:4px;flex:none;max-width:240px;overflow:hidden}
.dsh-git-ref{border-radius:999px;padding:0 6px;font-size:10px;line-height:16px;font-weight:600;white-space:nowrap}
.dsh-git-ref-head{background:var(--dsw-alias-brand-primary);color:#fff}
.dsh-git-ref-remote{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}
.dsh-git-ref-tag{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-border-l1)}
.dsh-git-logwrap{position:relative}
.dsh-git-more{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px;font-size:11px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsh-git-graph{position:absolute;left:0;top:0;pointer-events:none}
.dsh-git-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;font-family:inherit;flex:none}
.dsh-git-btn:disabled{opacity:.45;cursor:default}
.dsh-git-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dsh-git-clearable{position:relative;display:inline-flex;align-items:center;min-width:0;flex:1 1 auto}
.dsh-git-clearable-set{flex:1 1 160px;max-width:260px}
.dsh-git-clearable-area{flex:0 0 auto;align-items:flex-start}
.dsh-git-clearable > input,.dsh-git-clearable > textarea{padding-right:22px}
.dsh-git-clear-x{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.dsh-git-clear-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-git-clearable-area .dsh-git-clear-x{top:5px;transform:none}
.dsh-git-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:4px;padding:4px 6px;font-size:12px;font-family:inherit;width:100%}
textarea.dsh-git-input{resize:vertical}
.dsh-git-info{border-top:1px solid var(--dsw-alias-border-l1);margin-top:8px;padding-top:6px;display:flex;flex-direction:column;gap:3px}
/* 选区视图（多选合并查看）的标题行：「n 条提交合并视图」要一眼认得出这不是单提交
   详情，退出的按钮就住同一行。 */
.dsh-git-rangehead{display:flex;align-items:center;gap:8px;padding:2px 0 4px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-git-rangetitle{font-weight:600;font-size:12px}
/* 选区不连续时详情栏顶部那条置灰入口（多选合并查看的「为什么点不动」）。 */
.dsh-git-rangeblock{flex:none;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;background:var(--dsw-alias-bg-layer-1)}
.dsh-git-hash{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all}
.dsh-git-msg{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px;white-space:pre-wrap;font-size:11px;max-height:120px;overflow:auto}
.dsh-git-error{color:var(--dsw-alias-state-error-primary)}
.dsh-git-ok{color:var(--dsw-alias-state-success-primary)}
.dsh-git-group-title{color:var(--dsw-alias-label-secondary);font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:2px 0}
.dsh-git-mono{font-family:ui-monospace,monospace}
.dsh-git-pane{padding:10px}
.dsh-git-setup{flex:1;display:flex;flex-direction:column;gap:10px;padding:16px 20px;overflow:auto}
.dsh-git-setup-h{font-size:14px;font-weight:600}
.dsh-git-setup-path{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px}
.dsh-git-setup-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* 说明页里的「worktree 主目录」块（56-setup.js WorktreeMainSetup）：说明页本体是
   一个 gap:10 的纵列，这块作为它的最后一格，顶上一道分隔线把自己和上面的
   初始化/打开目录动作隔开；内部自成一个 gap:8 的小纵列，行内布局全部借用
   .dsh-git-set-row / .dsh-git-set-label（配置页同一套），不再另写一套行样式。 */
.dsh-git-setup-sub{display:flex;flex-direction:column;gap:8px;margin-top:6px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-git-setup-sub .dsh-git-setup-h{font-size:12px}
.dsh-git-wtmain-path{flex:0 1 auto;min-width:0;max-width:100%;overflow:auto;white-space:nowrap}
.dsh-git-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-git-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-git-tools{position:relative;flex:none;display:flex;align-items:center;gap:3px;flex-wrap:nowrap;padding:5px 52px 5px 7px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
/* Every part of this strip is fixed-width except the search box and the filters,
   and the two menu buttons at the end are the last thing that should ever move:
   when a branch name makes the row too long, the things that can give way do —
   the search shrinks and the filter chips clip — rather than the buttons
   dropping onto a second line under the filters they belong beside. */
.dsh-git-logsearch{flex:0 1 170px}
/* 「作用于选中提交」的拣选/还原/标签/分支四个键已经搬进提交行的右键菜单，这条
   工具条上不再有它们；.dsh-git-tool 现在的面孔是面板头部的同步组（⟳⇣↓↑）、
   序列器横幅上的 继续/跳过/中止，以及差异头部那三个图标键（见 -ico 一行）。 */
.dsh-git-tool{display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;background:0 0;color:var(--dsw-alias-label-primary);border-radius:5px;padding:3px 7px;font-size:11px;font-family:inherit;cursor:pointer;flex:none;line-height:16px}
.dsh-git-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-tool:disabled{opacity:.4;cursor:default}
/* 同步组四键的「运行中」：键自己的圈自己转，其余三个照常可点。:disabled 的 .4 透明
   会把转动淹掉 —— 这条用同级选择器（同为 0,2,0）压在它后面盖过去；描边和字色借
   品牌色，并排四键里「哪一个在跑」一眼可辨。 */
.dsh-git-tool.dsh-git-tool-run{opacity:1;border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);cursor:default}
/* transform 对行内文本不生效：转的是包字符的 span，给它 inline-block 才转得动
   （BranchIcon 那个是 svg，天生吃 transform，只有这里要补）。 */
.dsh-git-tool-run .dsh-git-spin{display:inline-block}
.dsh-git-tool-on{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1)}
/* 图标键（55-diff.js 的 diffIconButton：返回/⟳/☰）只在这个家族里：26px 的方块
   命中区、图标居中——没有文字，padding 不再撑它。 */
.dsh-git-tool-ico{justify-content:center;width:26px;height:26px;padding:0}
.dsh-git-tool-badge{display:inline-grid;place-items:center;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:9px;line-height:1}
.dsh-git-grow{flex:0 1 auto;min-width:0}
.dsh-git-banner{flex:none;display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px}
.dsh-git-banner-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-warn-primary)}
.dsh-git-left{width:208px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1)}
.dsh-git-sidewrap{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
.dsh-git-sidehead{display:flex;align-items:center;gap:4px;flex:none;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsh-git-sidehead-ico{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.dsh-git-sidehead-input{flex:1;min-width:0;border:0;background:0 0;font-family:inherit;font-size:11px;color:var(--dsw-alias-label-primary);outline:none}
.dsh-git-sidehead-x{flex:none;border:0;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:14px;padding:0 2px;border-radius:4px;cursor:pointer}
.dsh-git-sidehead-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-git-left .dsh-git-side{width:auto;flex:1;min-height:0;border-right:0}
.dsh-git-prompt{flex:none;display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-git-prompt .dsh-git-input{flex:1 1 auto;width:auto}
.dsh-git-grip{position:absolute;z-index:40;touch-action:none}
.dsh-git-grip-n{top:0;left:10px;right:10px;height:5px;cursor:ns-resize}
.dsh-git-grip-w{left:0;top:10px;bottom:10px;width:5px;cursor:ew-resize}
.dsh-git-grip-e{right:0;top:10px;bottom:10px;width:5px;cursor:ew-resize}
.dsh-git-grip-nw{left:0;top:0;width:12px;height:12px;cursor:nwse-resize}
.dsh-git-grip-ne{right:0;top:0;width:12px;height:12px;cursor:nesw-resize}
.dsh-git-grip:hover{background:var(--dsw-alias-brand-primary);opacity:.3}
.dsh-git-sync{display:flex;align-items:center;gap:2px;flex:none}
.dsh-git-branch-chip{display:inline-flex;align-items:center;gap:4px;max-width:220px;flex:none;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px}
.dsh-git-branch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.dsh-git-ab{flex:none;font-size:10px;font-weight:600}
/* IDEA's key, and now its colours: a branch with commits waiting on the remote
   carries a blue down arrow, one with commits waiting to be pushed carries a
   green up arrow. */
.dsh-git-ab-in{color:var(--dsw-alias-brand-primary)}
.dsh-git-ab-out{color:var(--dsw-alias-state-success)}
.dsh-git-set{display:flex;flex-direction:column;gap:14px;padding:4px 2px;max-width:660px}
.dsh-git-set-h{font-size:14px;font-weight:600}
/* 面板的「配置」页（80-panel.js）住在面板正文里：设置页那套排版照搬，外层改成
   「占满正文、自己滚」—— 面板的高度是钳出来的，内容超出时滚，不把面板撑变形。 */
.dsh-git-config{flex:1;min-height:0;overflow:auto;padding:10px 12px}
/* 「配置」页顶部的作用域切换（80-panel.js GitConfigPane）：项目配置 / 全局配置。
   记号用头部视图切换同一套 .dsh-git-cview，只是这一排自己占一行、贴左，不再
   margin-left:auto 挤到行尾。 */
.dsh-git-cfg-tabs{display:inline-flex;flex:none;gap:2px;padding:2px;border-radius:7px;background:var(--dsw-alias-interactive-bg-hover);align-self:flex-start}
/* 全局配置那一档的正文（79-globalconfig.js GitGlobalConfigPane）：与 .dsh-git-set
   同一套纵向节奏，但它是嵌在外层滚动容器里的第二层，不再自带 padding 与宽度上限。 */
.dsh-git-global{display:flex;flex-direction:column;gap:14px}
.dsh-git-set-select{box-sizing:border-box;flex:0 1 auto;min-width:0;max-width:260px;border:1px solid var(--dsh-alias-border-l1);border-radius:4px;background:var(--dsh-alias-bg-base);color:var(--dsh-alias-label-primary);font:inherit;font-size:12px;font-family:inherit;padding:4px 6px}
.dsh-git-set-select:disabled{opacity:.45;cursor:default}
.dsh-git-set-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-git-set-label{flex:none;min-width:170px;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsh-git-set-input{flex:1 1 160px;width:auto;max-width:260px}
.dsh-git-set-num{flex:none;width:74px}
.dsh-git-set-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}
.dsh-git-set-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-git-set-group{margin-top:6px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
/* 「远端」组头（80-panel.js GitConfigPane）：组头原本只是一行字，现在行尾要挂一枚
    ⟳ 图标键（同款 .dsh-git-tool-ico 画法，这一页不新造按钮长相）—— 标题吃剩余
    宽度、键贴行尾；26px 的方块比组头字高一点，align-items 居中后仍是同一行。 */
.dsh-git-set-group-row{display:flex;align-items:center;gap:8px}
.dsh-git-set-group-row > span{flex:1 1 auto;min-width:0}
/* 「远端」组的地址文本（80-panel.js GitConfigPane）：URL 常比名字长得多，吃掉行内
    剩余宽度、可断行 —— 断不开的长地址会把行尾那排按钮挤出面板。等宽字体与分支名、
    提交哈希同一习惯。 */
.dsh-git-set-url{flex:1 1 200px;min-width:0;word-break:break-all;font-family:ui-monospace,monospace}
/* ── 项目档的「仓库」外框（80-panel.js GitConfigPane）──
    受切换仓库影响的三组（提交身份 / 远端 / 换行符）收进「仓库」一组内：外框只是
    一道描边、底色不填 —— 里面的仓库列表（dsh-git-repo-box）自带 layer-2 浅底，外框
    再填一层浅底两块就糊在一起了。切换器在外框里当头一块；三个下级组再收进
    scope-body：左缩进一道竖线，树子级的读法 —— 这三块属于上面选中的那个仓库。
    组头原本有 margin/padding/border-top 三件套分隔，在外框与 scope-body 的首行
    （紧贴自己容器的上缘）会画出双线，:first-child 让掉；其余组头照旧，下级组之间
    的分隔线原样保留。缩进只吃 padding 不吃 min-width，面板拖窄时行照旧换行不破。 */
.dsh-git-set-scope{display:flex;flex-direction:column;gap:14px;margin-top:6px;padding:10px 10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.dsh-git-set-scope-body{display:flex;flex-direction:column;gap:14px;margin-top:2px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2)}
.dsh-git-set-scope > .dsh-git-set-group:first-child,
.dsh-git-set-scope-body > .dsh-git-set-group:first-child{margin-top:0;padding-top:0;border-top:0}
/* 配置页「worktree 主目录」下级组（80-panel.js wtGroupNode）：整组条件渲染，画出来
   时是 scope-body 里与提交身份/远端/换行符同级的一格 —— 外面再包一层自己的纵列
   （scope-body 的 gap 对包装层是一个整体），内部节奏与同级组一致（组头 → 说明 →
   两行）。首组让双线的 :first-child 规则同样适用于这层包装。 */
.dsh-git-wtmain{display:flex;flex-direction:column;gap:8px}
.dsh-git-set-scope-body > .dsh-git-wtmain > .dsh-git-set-group:first-child{margin-top:0;padding-top:0;border-top:0}
/* ── 配置页「仓库」组内「git 忽略项」分组（80-panel.js GitIgnoredScanGroup）──
    工作树 → 条目 两层的只读清单（单仓库结果里没有仓库这层）。类名另起
    dsh-git-ign- 前缀，不混仓库块 / 工作树块的 dsh-git-repo-box/-row、
    dsh-git-wt-box/-row —— 那两批是测试按个数认的
    控件（gp44 数 repo-box / repo-row 的个数，25-worktree.js 的注释说明），混进来会
    把那些账搅乱；折叠三角这类没人按个数认的小记号才借现成的（dsh-git-repo-caret）。
    「主 / 链接」徽标是同一枚小签的两种画法：主工作区浅底实签，链接工作区描边空签
    —— 分支树「本地 / 远程」同一种读法。条目用等宽字体（与远端地址、提交哈希同一
    习惯），目录条目（带尾斜杠，git --directory 折叠的整个目录）压暗一级 —— 尾斜杠
    加颜色，目录与文件扫一眼就分得开。变量统一用全页主流的 dsw-alias 那组（306 行
    set-select 的 --dsh-alias-* 是历史笔误，那几个键在主题里没有定义，不跟）。 */
.dsh-git-ign{display:flex;flex-direction:column;gap:4px}
.dsh-git-ign-wt{display:flex;align-items:center;gap:6px;min-height:20px;padding:1px 5px;border-radius:5px;font-size:11px;color:var(--dsw-alias-label-primary);white-space:nowrap;-webkit-user-select:none;user-select:none}
.dsh-git-ign-wt:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-ign-wt{cursor:pointer}
.dsh-git-ign-tag{flex:none;padding:0 4px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);font-size:10px;line-height:15px;color:var(--dsw-alias-label-primary)}
.dsh-git-ign-tag-link{background:transparent;border:1px solid var(--dsw-alias-border-l1);padding:0 3px;color:var(--dsw-alias-label-secondary)}
.dsh-git-ign-branch{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.dsh-git-ign-count{margin-left:auto;flex:none;font-size:10px;color:var(--dsw-alias-label-secondary)}
.dsh-git-ign-note{color:var(--dsw-alias-label-secondary)}
.dsh-git-ign-gone{opacity:.55}
.dsh-git-ign-items{display:flex;flex-direction:column;margin:1px 0 3px 24px;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l2)}
.dsh-git-ign-item{font-size:11px;line-height:16px;font-family:ui-monospace,monospace;word-break:break-all;color:var(--dsw-alias-label-primary)}
.dsh-git-ign-item-dir{color:var(--dsw-alias-label-secondary)}
.dsh-git-hidden{display:none}
/* Only while the header's switcher is open: the card hangs off the header and
   must be allowed past the panel's own clip, or a panel dragged short enough
   would cut the branch list in half. Nothing else overflows, so the rounded
   corners still look the same. */
.dsh-git-pop-overflow{overflow:visible}

/* ── branch switcher ──
   One card in two places: hanging under the panel header's chip, and floating
   above the composer when the chip is hovered. The layer wrapper generates no
   box, so the panel still positions itself against the slot's own container. */
.dsh-git-layer{display:contents}
/* ── body 级浮层（16-portal.js）──
   弹层「跳出主对话的框」的落点：portal 挂到 body 的视口定点层，主对话的宽度与
   overflow 从此与它无关。宽高写死 100vw/100vh 而不是 inset:0 —— 页面级 transform/
   filter（玻璃皮肤）会把 fixed 的 inset 尺寸换成祖先 padding 盒、层塌成 0
   （better-sidebar 在 [data-dsh-panel-host] 上踩过并在注释里记下的同一个坑）。
   z-index 95 的上下文（实测 better-sidebar 源码，只读参考）：它的 body 级侧栏宿主
   [data-dsh-panel-host] 是 25（格内 40/90 都被罩住）、它 portal 到 body 的浮窗/
   锚定卡是 90、DSH 的 ui-cordis 插件面板是 30，应用的对话框栈在 100+ —— 95 压过
   侧栏一切常驻面，又不挡应用自己的对话框。overflow:hidden 只防浮层把 document 撑出
   滚动区；pointer-events:none 让空层不挡点击 —— 面板自带 pointer-events:auto，
   悬停卡片在这里补一句。 */
.dsh-git-float{position:fixed;left:0;top:0;right:0;height:100vh;overflow:hidden;pointer-events:none;z-index:95}
.dsh-git-float .dsh-git-switch{pointer-events:auto}
.dsh-git-branch-chip{display:inline-flex;align-items:center;gap:4px;max-width:220px;flex:none;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;cursor:pointer;font-family:inherit}
.dsh-git-branch-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-branch-chip-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-git-switch{position:absolute;z-index:40;width:456px;display:flex;flex-direction:column;overflow:visible;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);font-size:12px}
/* Hung off the header box, not off the chip: the header spans the whole panel, so
   the card starts at the panel's own left margin however the header wraps. It is
   also capped to that box, or a panel dragged to its 420px minimum would push the
   card past its own right edge. */
.dsh-git-switch-panel{top:calc(100% + 6px);left:8px;max-width:calc(100% - 16px)}
.dsh-git-switch-hover{left:8px;bottom:100%;margin-bottom:8px;max-width:calc(100% - 16px)}
/* 悬停卡片被钳住时（.dsh-git-switch-cap，maxHeight 由 94-popover.js 实测写入）：
   卡片是 bottom:100% 从下往上长的，收的是它自己的顶。头部行和建行脚不缩，
   分支列表吃掉余下的高度自己滚 —— 列表本来就是滚动容器（max-height:330 放开，
   由钳出来的空间接管）。flyout 仍挂在卡片外，卡片照旧不裁剪。 */
.dsh-git-switch-cap .dsh-git-bs{flex:0 1 auto;min-height:0}
.dsh-git-switch-cap .dsh-git-bs-list{max-height:none;flex:0 1 auto;min-height:0}
.dsh-git-bs{display:flex;flex-direction:column;min-height:0;position:relative}
.dsh-git-bs-head{display:flex;align-items:center;flex-wrap:wrap;gap:5px;padding:6px 9px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-git-bs-mag{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
/* A borderless search line, the way a switcher's filter reads: the box itself
   would compete with the list for attention. */
.dsh-git-bs-search{flex:1 1 120px;width:auto;min-width:84px;border:0;background:transparent;outline:none;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);padding:2px 0}
.dsh-git-bs-search::placeholder{color:var(--dsw-alias-label-secondary)}
.dsh-git-bs-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-git-bs-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* The repository-wide actions are chips on the search line, not rows inside the
   list: they cost no vertical space that way, and they stay reachable while the
   branch tree is scrolled. */
.dsh-git-bs-head-acts{display:flex;align-items:center;flex-wrap:wrap;gap:4px;flex:none}
/* 图标按钮，不带文字：文字进了 title。宽度按图标定，几个按钮一排刚好和搜索框同高。 */
.dsh-git-bs-chip{display:inline-flex;align-items:center;justify-content:center;gap:3px;height:22px;min-width:24px;padding:0 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:1;cursor:pointer;white-space:nowrap}
.dsh-git-bs-chip:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dsh-git-bs-chip-on{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary)}
.dsh-git-bs-chip:disabled{opacity:.45;cursor:default}
.dsh-git-bs-chip .dsh-git-bs-ico{width:12px}
.dsh-git-bs-chip .dsh-git-bs-name{flex:0 1 auto;max-width:120px}
.dsh-git-bs-chip .dsh-git-bs-ab{font-size:10px}
.dsh-git-bs-chip-new{border-style:dashed}
.dsh-git-bs-chip-n{display:inline-grid;place-items:center;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:9px;line-height:1}
.dsh-git-bs-sort{margin-left:auto}
.dsh-git-bs-list{position:relative;max-height:330px;overflow:auto;padding:4px 4px 6px}
.dsh-git-bs-row{display:flex;align-items:center;gap:7px;min-height:30px;padding:3px 8px 3px 4px;border-radius:6px;cursor:pointer;border:0;background:transparent;font:inherit;font-size:12px;color:inherit;text-align:left;width:100%;box-sizing:border-box}
.dsh-git-bs-row-on{background:var(--dsw-alias-interactive-bg-hover)}
/* the row the open submenu belongs to */
.dsh-git-bs-row-fly{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-bs-row-cur .dsh-git-bs-name{font-weight:600}
.dsh-git-bs-busy{opacity:.6}
.dsh-git-bs-ico{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;color:var(--dsw-alias-brand-primary)}
.dsh-git-bs-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-git-bs-up{flex:none;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-git-bs-ab{flex:none;font-size:11px;font-weight:600}
/* 收藏：一个按钮，指的是高亮那一行。选中态用 warn 色，和别处的「已收藏」一致。 */
.dsh-git-bs-fav-on{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dsh-git-bs-glyph-star{width:13px;font-size:12px}
/* 「这个分支能做的事」。原来和收藏并排、都是 border 色（几乎是看不见的），现在
   它一个按钮独占行尾，用可读的次级色，hover 再亮一档并有一块底色。 */
.dsh-git-bs-more{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-git-bs-more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-git-bs-group{display:flex;align-items:center;gap:5px;padding:6px 8px 3px 6px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
/* 动作 chip 的记号：和面板头部的同步组一样是字符（⇣ ↓ ↑ +），11px */
.dsh-git-bs-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;width:13px;font-size:13px;line-height:1}
/* 行首那一列：当前分支的 ★，和面板左栏的 twisty 槽同宽（10px） */
.dsh-git-bs-cur{flex:none;width:10px;font-size:9px;line-height:1;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsh-git-bs-count{flex:none;color:var(--dsw-alias-border-l2)}
/* IDEA's branch submenu: hovering a row opens its actions to the right of the
   tree. The card is only 420px wide, so the flyout hangs past its edge, the way
   the real one hangs over the editor; the card therefore no longer clips. */
.dsh-git-bs-fly{position:absolute;left:calc(100% - 6px);z-index:6;width:198px;padding:4px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
.dsh-git-bs-fly-head{display:flex;align-items:center;gap:5px;padding:3px 8px 6px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-git-bs-fly-sep{height:1px;margin:3px 6px;background:var(--dsw-alias-border-l1)}
.dsh-git-bs-fly-item{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;padding:5px 8px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer}
.dsh-git-bs-fly-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-bs-fly-item:disabled{opacity:.45;cursor:default}
.dsh-git-bs-fly-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-git-bs-fly-ico{display:inline-flex;flex:none;width:14px;color:var(--dsw-alias-label-secondary)}
.dsh-git-bs-empty{padding:8px 10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-git-bs-foot{display:flex;flex-direction:column;gap:6px;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-git-bs-create{display:flex;align-items:center;gap:6px;padding:7px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-git-bs-new{flex:1 1 auto;width:auto;min-width:0}
.dsh-git-bs-check{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-git-bs-rescue{align-self:flex-start;padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-state-warn-primary);background:transparent;color:var(--dsw-alias-state-warn-primary);font:inherit;font-size:11px;cursor:pointer}
.dsh-git-warn{color:var(--dsw-alias-state-warn-primary)}
/* ── 一个文件的差异 ──
   等宽字体、两列行号、三个记号（+ - 空格），和 IDEA 的 diff 一个读法。加/删的
   底色用固定 rgba 而不是主题令牌：主题里没有「淡绿的一块」这种令牌，而 14% 的
   透明色在浅色和深色底上都读得出来（取自 LANE_COLORS 里的 #22a06b / #d64545）。

   布局是左右对比：所有行放进一张表（dsh-git-dtable），左列旧行、右列新行，各带
   自己的行号沟 —— 列宽由整张表按内容自动分，左右两列的边界才逐行对齐（每行各排
   各的 flex 做不到：谁的内容长，边界就歪到谁那边）。hunk / meta / note 是一格
   colspan=2 的整行（dsh-git-dfull）。词级高亮（dsh-git-dmiss）是行底色同色系更浓
   的一档（.30 上下），底色跟半列走：左列红系、右列绿系。行尾回车符画成暗色 ⏎
   （dsh-git-dcr）：裸 \r 在 white-space:pre 下是换行，永远不能进 DOM 文本。 */
.dsh-git-diffview{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0}
.dsh-git-diffhead{display:flex;align-items:center;gap:6px;flex:none;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsh-git-diffpath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.dsh-git-diffcount{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-git-diffadd{color:var(--dsw-alias-state-success-primary)}
.dsh-git-diffdel{color:var(--dsw-alias-state-error-primary)}
.dsh-git-diffwarn{flex:none;padding:3px 10px;font-size:11px;color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-git-diffbody{flex:1;display:flex;flex-direction:column;min-height:0}
.dsh-git-diffsec-wrap{flex:1;display:flex;flex-direction:column;min-height:0}
.dsh-git-diffsec{display:flex;align-items:center;gap:8px;flex:none;padding:3px 8px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-git-diff{flex:1;min-height:0;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:18px}
.dsh-git-diffwrap{min-width:100%;width:max-content}
.dsh-git-dtable{display:table;table-layout:auto;width:100%}
.dsh-git-dline{display:table-row;height:18px}
.dsh-git-dhalf{display:table-cell;white-space:pre;vertical-align:top}
.dsh-git-dhalf-old{border-right:1px solid var(--dsw-alias-border-l1)}
.dsh-git-dfull{display:table-cell;white-space:pre;vertical-align:top}
.dsh-git-dno{display:inline-block;width:44px;padding-right:8px;text-align:right;color:var(--dsw-alias-label-secondary);opacity:.6;-webkit-user-select:none;user-select:none}
.dsh-git-dsign{display:inline-block;width:12px;color:var(--dsw-alias-label-secondary);-webkit-user-select:none;user-select:none}
.dsh-git-dtext{padding-right:10px}
.dsh-git-dhalf-add{background:rgba(34,160,107,.14)}
.dsh-git-dhalf-add .dsh-git-dsign{color:var(--dsw-alias-state-success-primary)}
.dsh-git-dhalf-del{background:rgba(214,69,69,.14)}
.dsh-git-dhalf-del .dsh-git-dsign{color:var(--dsw-alias-state-error-primary)}
.dsh-git-dmiss{border-radius:2px}
.dsh-git-dhalf-del .dsh-git-dmiss{background:rgba(214,69,69,.30)}
.dsh-git-dhalf-add .dsh-git-dmiss{background:rgba(34,160,107,.32)}
.dsh-git-dcr{color:var(--dsw-alias-label-secondary);opacity:.7;font-size:10px}
.dsh-git-dl-hunk{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-git-dl-meta{color:var(--dsw-alias-label-secondary)}
.dsh-git-dl-note{color:var(--dsw-alias-label-secondary)}
/* 头部的回车符开关：框是 stageBox 那只，文案跟在后面，点文案也翻。 */
.dsh-git-diffcr{display:inline-flex;align-items:center;gap:1px;flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none}

/* ── 仓库切换列表 ──
    一个工作区里嵌着多个仓库时，左栏分支树和变更页各有一列这样的行。它刻意不用
    dsh-git-trow 那套类名：树行带着折叠、树选中和一串跟着类名走的断言，仓库行是
    另一类控件 —— 不折叠、不属于哪棵树，被当成树行数进去只会搅浑两边。

    整块是一个 inset 容器：仓库行和下面分支树的行原来是同一种平铺行（同高、同字
    号、直接铺在侧栏底上），读者分不出「上面在切仓库、下面在看分支」。浅底 + 描边
    + 圆角 + 与树之间的留白把两块隔开；行里再小一号字号、每行一个仓库图标，不读
    字也认得出哪块是哪块。 */
.dsh-git-repo-box{flex:none;margin:6px 6px 10px;padding:2px 3px 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
/* 标题行同时是折叠开关，也是折叠后唯一剩下的一行：加重的字重 + 常规色 —— 原来那
   行是次级色的小号大写，读起来像树的分组标题而不是一块的题目。 */
.dsh-git-repo-head{display:flex;align-items:center;gap:5px;min-height:20px;padding:3px 5px;border-radius:5px;color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none}
.dsh-git-repo-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-repo-head-ico{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.dsh-git-repo-head-name{flex:none}
.dsh-git-repo-caret{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.dsh-git-repo-caret-off{transform:rotate(-90deg)}
/* 折叠后当前生效仓库要还看得见：● 和仓库行里同一个记号（品牌色圆点 = 生效仓库）。 */
.dsh-git-repo-now{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-brand-primary);font-weight:600}
.dsh-git-repo-note{margin-left:auto;flex:none;font-size:10px;color:var(--dsw-alias-label-secondary)}
/* 行比树行更紧凑（min-height 20px、11px 字号）：块本身的密度和树不同，也是区分
   的一部分。 */
.dsh-git-repo-row{display:flex;align-items:center;gap:5px;min-height:20px;padding:1px 5px;border-radius:5px;font-size:11px;cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none}
/* 容器底是 bg-layer-2，悬停/选中就得再亮一档 —— 和头部工具条上的按钮同一个搭配。 */
.dsh-git-repo-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-repo-mark{flex:none;width:9px;font-size:9px;text-align:center;color:var(--dsw-alias-brand-primary)}
/* 每行一个小仓库图标（60-icons.js 的 repo 立方）：分支行的行首是折叠箭头，仓库行
   的行首是这个盒子。固定宽度，「全部」那行空着占位，名字仍对齐成一列。 */
.dsh-git-repo-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;width:13px;height:13px;color:var(--dsw-alias-label-secondary)}
/* 名字可收缩：同名仓库补了父目录（c/d）之后标签会变长，行不能被它撑爆 —— dim 和
   × 是 flex:none，让出来的只能是名字自己（省略号在名字上）。 */
.dsh-git-repo-name{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dsh-git-repo-dim{flex:none;margin-left:auto;padding-right:4px;color:var(--dsw-alias-label-secondary);font-size:10px}
/* 生效仓库：名字加粗、左缘一道品牌色竖线 —— 和分支树里「筛选范围」那一格同一个
   读法（dsh-git-trow-scope），见过一次就不用再学。图标跟着上品牌色：● + 竖线 + 图
   标一起说「就是这一行」。 */
.dsh-git-repo-cur{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.dsh-git-repo-cur .dsh-git-repo-name{font-weight:600;color:var(--dsw-alias-brand-primary)}
.dsh-git-repo-cur .dsh-git-repo-glyph{color:var(--dsw-alias-brand-primary)}
/* Ctrl+单击挑中的仓库 */
.dsh-git-repo-sel{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-repo-sel:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 手动登记过、目录已经不在的那行：留得住也删得掉，但看得出它失效了 */
.dsh-git-repo-gone{opacity:.55}
.dsh-git-repo-x{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;padding:0 2px;border-radius:3px;cursor:pointer}
.dsh-git-repo-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 仓库行的「wt」小标（24-repos.js，.git 是文件的仓库根）：描边空签、压暗一档 ——
   与 git 忽略项扫描的「链接」徽标（.dsh-git-ign-tag-link）同一读法，字号再小一号，
   它只是个提醒，不能和行名抢眼。 */
.dsh-git-repo-wt{flex:none;padding:0 3px;border-radius:3px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:9px;line-height:13px;cursor:default}
.dsh-git-repo-add{display:flex;align-items:center;gap:5px;margin-top:2px;min-height:20px;padding:1px 5px;border-radius:5px;font-size:11px;cursor:pointer;white-space:nowrap}
.dsh-git-repo-add:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-repo-addrow{display:flex;gap:4px;padding:2px 5px}
.dsh-git-repo-input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:2px 4px;outline:none}
.dsh-git-repo-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-git-repo-ok{flex:none}
.dsh-git-repo-problem{padding:2px 6px 3px;font-size:10px;line-height:14px;color:var(--dsw-alias-state-error-primary)}
/* 「未检测到仓库」的说明页下面挂的那份仓库清单：RepoSetup 自己是可滚动的整页，
   清单跟在它下面同页滚动，一条细线隔开。 */
.dsh-git-setupwrap{flex:1;display:flex;flex-direction:column;min-height:0;overflow:auto}
.dsh-git-setupwrap .dsh-git-setup{flex:none;overflow:visible}
.dsh-git-setup-repos{padding:0 20px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
/* 变更页左侧那列仓库侧栏：宽度对着分支树那栏（208px）收窄一点 —— 变更树本身还有
   一列目录缩进要放。容器（.dsh-git-repo-box）自带的外边距在这里同样成立。 */
.dsh-git-reposide{width:168px;flex:none;overflow:auto;padding:2px 0 6px;border-right:1px solid var(--dsw-alias-border-l1)}
/* 按仓库分组的组头：左栏分支树（多选时）和变更树（多选时）共用。点它就是「只看
   这个仓库」，所以它是可点的，但样式是标题 —— 组里那些行才是内容。行首是和切换
   器同一个仓库图标：两处的「同一个仓库」长得也一样。 */
.dsh-git-rgroup{display:flex;align-items:center;gap:5px;margin-top:4px;padding:3px 6px;border-radius:4px;font-weight:600;cursor:pointer;white-space:nowrap}
.dsh-git-rgroup:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-git-rgroup .dsh-git-repo-dim{margin-left:0;padding-left:4px}

/* ── 工作树块（25-worktree.js，历史页左栏、仓库块正下方）──
    视觉与仓库块同族的实现方式：容器、标题行、行、灰行这四条与 .dsh-git-repo-box
    / -head / -row / -gone **共用同一组声明**（分组选择器），观感逐像素一致；类名
    却另起 dsh-git-wt- 前缀 —— 仓库块的行数是测试按个数认的（gp44 数 repo-box /
    repo-row），工作树块混进同一批类名就会把那些账搅乱。行内的小记号（●、图标、
    三角、↑↓）直接复用没人按个数认的类。 */
.dsh-git-repo-box,.dsh-git-wt-box{flex:none;margin:6px 6px 10px;padding:2px 3px 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dsh-git-repo-head,.dsh-git-wt-head{display:flex;align-items:center;gap:5px;min-height:20px;padding:3px 5px;border-radius:5px;color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none}
.dsh-git-repo-head:hover,.dsh-git-wt-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-repo-row,.dsh-git-wt-row{display:flex;align-items:center;gap:5px;min-height:20px;padding:1px 5px;border-radius:5px;font-size:11px;cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none}
.dsh-git-repo-row:hover,.dsh-git-wt-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-repo-gone,.dsh-git-wt-gone{opacity:.55}
/* 行尾右侧的一簇（↑↓ 徽章、⚠、🔒）：贴右缘、不抢名字的宽度 —— 名字那格是 flex
    收缩的第一顺位，徽章数字再多也只是挤名字的省略号，不把行撑爆。 */
.dsh-git-wt-right{margin-left:auto;display:inline-flex;align-items:center;gap:4px;flex:none}
/* ⚠（目录已丢失）与 🔒（已锁定）这两个行尾小记号：本版没有 prune / 解锁的动作，
    它们只是「这条有状况」的眼标，详情全在行 tooltip 里，所以压一点透明度。 */
.dsh-git-wt-mark{flex:none;font-size:9px;line-height:1;opacity:.85}
/* worktree 块的「主目录」行（25-worktree.js v1.2）：块头正下方的一行身份说明。
   刻意不叫 dsh-git-wt-row —— 那个类名是测试按清单行认的（gp57/gp60 数个数），
   这一行说的是目录身份不是清单行；左缩进对齐行名的 18px，读起来是头行的从属。 */
.dsh-git-wt-mainrow{display:flex;align-items:center;gap:5px;min-height:20px;padding:1px 5px 1px 18px;font-size:11px;white-space:nowrap;-webkit-user-select:none;user-select:none}
.dsh-git-wt-mainrow .dsh-git-tsub{flex:none}
.dsh-git-wt-main-act{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;line-height:14px;padding:0 5px;cursor:pointer}
.dsh-git-wt-main-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

/* ── 差异页右列：这批修改的来源文件列表 ──
   补丁区 flex:1、右列固定 240px。右列的行复用树行那套类名（dsh-git-trow），
   悬停/选中/省略号因此和别处的树一个读法；min-width:0 是给补丁区的 —— 行方向
   的 flex 里默认 min-width:auto，一条 200 字的补丁行会把整块撑到列外而不是在
   自己的滚动容器里横滚。 */
.dsh-git-diffsplit{flex:1;display:flex;min-height:0;min-width:0}
.dsh-git-diffsplit>.dsh-git-diffbody,.dsh-git-diffsplit>.dsh-git-pane{flex:1;min-width:0}
.dsh-git-diffsplit .dsh-git-diffsec-wrap{min-width:0}
.dsh-git-diffrail{width:240px;flex:none;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-git-diffrail-head{flex:none;padding:4px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-git-diffrail-list{flex:1;min-height:0;overflow:auto;padding:4px 0}
/* 变更右列行尾的 暂存/未跟踪 标记：右对齐、小一号，不与路径抢地方（名字那格
   才是要读的）。 */
.dsh-git-diffrail-mark{flex:none;margin-left:auto;padding:0 5px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:15px}

/* ── 命令页（57-cmdlog.js）：会话记录 + 面板执行记录里这个工作区跑过的 git 命令 ── */
.dsh-git-cmd{flex:1;display:flex;flex-direction:column;min-height:0}
.dsh-git-cmdbar{flex:none;display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsh-git-cmdfilter{flex:1 1 auto;min-width:80px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:2px 6px;outline:none}
.dsh-git-cmdfilter:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-git-cmdfilter::placeholder{color:var(--dsw-alias-label-secondary)}
.dsh-git-cmdlist{flex:1;min-height:0;overflow:auto;padding:4px 0}
.dsh-git-cmdline{display:flex;align-items:center;gap:8px;padding:2px 8px;cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none}
.dsh-git-cmdline:hover{background:var(--dsw-alias-bg-layer-2)}
/* 100px 放得下最长的 YYYY-MM-DD HH:mm（10px 的表格数字），今天的那种短格式
   留白 —— 列对齐了，扫一眼就是时间轴。 */
.dsh-git-cmdtime{flex:none;width:100px;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsh-git-cmdtext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.dsh-git-cmdesc{flex:0 1 auto;max-width:32%;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-git-cmdfail{flex:none;color:var(--dsh-alias-state-error-primary);font-size:10px;font-weight:600}
.dsh-git-cmdsrc{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px}
/* 「面板」徽标：来自面板自己的执行（77-cmdrec.js），不是 AI 会话；给它一点边框，
   和会话号那种纯文字区分开。运行中标记（…）同色，结束时由推送换成真退出码。 */
.dsh-git-cmdpanel{padding:0 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:3px}
.dsh-git-cmdrun{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:600}
.dsh-git-cmdopen{display:flex;align-items:flex-start;gap:8px;margin:0 8px 4px;padding:6px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-left:2px solid var(--dsw-alias-border-l2);border-radius:4px}
.dsh-git-cmdpre{flex:1;min-width:0;margin:0;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px}
.dsh-git-cmdnote{flex:none;padding-top:5px;font-size:10px;color:var(--dsw-alias-label-secondary)}
.dsh-git-cmdtrunc{flex:none;font-size:10px;color:var(--dsw-alias-state-warn-primary)}

/* ── ⚡：提交历史工具条右端那个下拉按钮与它的浮层（78-actions.js）──
    按钮的样子照 .dsh-git-tool 画（同尺寸、同圆角、同悬停），类名刻意分开：那个类
    说的是「作用于选中提交的工具」，这个是「打开一个菜单」。 */
.dsh-git-acts{position:relative;display:inline-flex;gap:3px;flex:none}
.dsh-git-acts-btn{display:inline-flex;align-items:center;justify-content:center;gap:3px;width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:5px;background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:16px;cursor:pointer;flex:none}
.dsh-git-acts-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-acts-btn:disabled{opacity:.4;cursor:default}
.dsh-git-acts-btn-on{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1)}
/* 浮层挂在 .dsh-git-acts 那一格（position:relative），右对齐按钮、向下展开 —— 工具条
    在面板顶部，向下展开落在提交列表上面，z 高于列表。 */
.dsh-git-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:45;min-width:230px;max-width:320px;padding:4px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);font-size:12px}
.dsh-git-menu-item{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:5px 8px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer}
.dsh-git-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-menu-item:disabled{opacity:.45;cursor:default}
.dsh-git-menu-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-git-menu-sep{flex:none;height:1px;margin:3px 6px;background:var(--dsw-alias-border-l1)}
.dsh-git-menu-dim{color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-git-menu-pad{padding:6px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-git-menu-name{flex:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
/* 快捷命令那行：名字 + 代值预览各占一行 —— 一行塞下两条信息时预览先被挤没。 */
.dsh-git-menu-cmd{flex-direction:column;align-items:flex-start;gap:1px}
.dsh-git-menu-cmd .dsh-git-menu-dim{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Ctrl+点击挑进多选的提交行：左缘一道强调条 —— 选中行是整行底色，多选得在选中之外
    另有可区分的记号（两者可同时在一行上）。整行底色与 .dsh-git-crow-sel 同一个：
    只有一道左缘线的时候，多选里「除了最后点的那条」都看不出来被挑中了 —— 高密度
    列表里一条 2px 的线读不出选中感。hover 那条不是装饰：本条不带伪类、权重低过
    .dsh-git-crow:hover 的悬停色，不补同色的话鼠标一扫过多选行，底色就在选中色与
    悬停色之间跳一下（.dsh-git-crow-sel:hover 在本文件前部，同一条规矩的先例）。 */
.dsh-git-crow-multi{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary)}
.dsh-git-crow-multi:hover{background:var(--dsw-alias-interactive-bg-hover)}

/* 成功条：与 .dsh-git-error 同一个提示位、同一个密度，绿色系、等宽（多半是命令输出）。 */
.dsh-git-oknote{flex:none;box-sizing:border-box;max-height:120px;overflow:auto;color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}

/* ── 快捷命令的确认框与编辑器 ──
    面板里是覆盖层（盖住正文、居中一张卡片）；配置页的全局组里同一张卡片直接排在管理组下面。
    底板是半透明暗遮罩（rgba(0,0,0,.32)），不再是实色背景 —— 整块面板被盖成一张
    白纸（推送确认弹窗打开时连「现在推的是哪个仓库」都看不见，更别提拿身后的分支
    列表核对）就是实色底板干的。遮罩之下隐约看得见面板，弹窗本体 qc-box 保持实色
    —— 卡片与底板的层次由 box-shadow 与这道暗化一起撑。这一层是签出二选一、推送
    确认、reword 等多个框共用的同一块板，一并受益，属预期。 */
.dsh-git-qc-overlay{position:absolute;inset:0;z-index:50;display:flex;padding:14px;background:rgba(0,0,0,.32);overflow:auto}
.dsh-git-qc-box{margin:auto;width:min(620px,100%);max-height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
.dsh-git-qc-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.dsh-git-qc-x{display:inline-flex;align-items:center;justify-content:center;flex:none;margin-left:auto;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.dsh-git-qc-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-git-qc-field{display:flex;flex-direction:column;gap:3px;font-size:11px}
.dsh-git-qc-k{color:var(--dsw-alias-label-secondary)}
.dsh-git-qc-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 变量 chip：虚线药丸 + 等宽 —— 插进模板里的就是它身上写的这串字。 */
.dsh-git-qc-chips{display:flex;flex-wrap:wrap;gap:4px}
.dsh-git-qc-chip{border:1px dashed var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px;background:transparent;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;cursor:pointer}
.dsh-git-qc-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-qc-vars{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base)}
.dsh-git-qc-varrow{display:flex;gap:8px;font-size:11px;line-height:16px}
.dsh-git-qc-varname{flex:none;width:180px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
/* 行的声明与下面 qc 那三行共用同一组选择器（分组而不是复制，25-worktree.js 的
   wt-row 与 repo-box 同一条先例）—— 类名另起 dsh-git-wdm- 前缀：测试按类名认
   控件，目录映射的行与快捷命令的行各自可数。 */
.dsh-git-wdm-row,.dsh-git-qc-row{display:flex;align-items:center;gap:8px;padding:3px 0}
.dsh-git-qc-name{flex:none;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.dsh-git-qc-cmd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-git-wdm-row .dsh-git-btn,.dsh-git-qc-row .dsh-git-btn{flex:none}
.dsh-git-wdm-from{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-git-wdm-to{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.dsh-git-qc-empty{padding:6px 2px;font-size:11px;line-height:18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary)}
.dsh-git-qc-inrow{display:flex;align-items:center;gap:8px}
.dsh-git-qc-inhint{flex:none;width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-git-qc-inrow .dsh-git-input{flex:1 1 auto;width:auto}
/* 解析预览：等宽、pre-wrap、不截断 —— 读者确认的就是这一整条命令。 */
.dsh-git-qc-pre{max-height:180px;overflow:auto;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all}
.dsh-git-qc-actions{display:flex;align-items:center;gap:8px}

/* ── pull 的上游选择层（80-panel.js 覆盖层里挂 RemotePickList）──
    列表复用分支卡那套 dsh-git-bs-*；自身的 330px 上限在盒子里让位给 qc-box 的
    max-height —— 列表在盒内自己收缩。 */
.dsh-git-picklist{display:flex;flex-direction:column;min-height:0}
.dsh-git-qc-box .dsh-git-picklist{flex:0 1 auto}
.dsh-git-qc-box .dsh-git-picklist .dsh-git-bs-list{max-height:none;flex:0 1 auto;min-height:0}

/* ── 推送确认弹窗（80-panel.js 覆盖层里挂 PushConfirmBox）──
    提交行复用分支树那套 dsh-git-trow（行高、悬停反白同一个来处），行内四格的
    宽度口径照抄日志行（dsh-git-subject/-author/-date）：说明占满、作者与时间
    压暗收窄。清单在盒内自己滚，40vh 封顶 —— 提交再多弹窗也不顶出屏幕。「推送
    中…」的转圈复用 dsh-git-spin：tool 键那条 display:inline-block 挂在
    dsh-git-tool-run 底下，按钮这里不能整个 class 搬，给 qc-box 里的 spin 一条
    自己的 display（transform 对 inline 元素不生效，同 80-panel.js tool 里那条
    注释）。 */
.dsh-git-pushlist{flex:0 1 auto;min-height:0;overflow:auto;max-height:40vh;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsh-alias-bg-base)}
.dsh-git-pushlist .dsh-git-trow{cursor:default}
.dsh-git-phash{flex:none;width:64px;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-git-psub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsh-git-pwho{flex:none;width:110px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-git-pwhen{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-git-qc-box .dsh-git-spin{display:inline-block}

/* ── 三方合并冲突界面（59-merge.js）：三栏只读 + 可编辑结果区 ──
    色块的口径与 55-diff 的加/删底色同一套做法：主题里没有「淡蓝/淡黄的一块」这
    种令牌，用固定 rgba（14% 上下在浅色和深色底上都读得出来）。四色各有其职：
    左（ours）蓝、右（theirs）黄、基线灰、结果区冲突块红 —— 三栏里哪侧改过、
    结果区里哪块还没解决，扫一眼颜色就能对上。 */
.dsh-git-mrg{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0}
.dsh-git-mrg-head{display:flex;align-items:center;gap:6px;flex:none;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsh-git-mrg-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.dsh-git-mrg-grow{flex:1 1 0;min-width:8px}
.dsh-git-mrg-count{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-git-mrg-tools{display:flex;align-items:center;gap:4px;flex-wrap:wrap;flex:none;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-git-mrg-panes{flex:1 1 50%;min-height:0;display:flex;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-git-mrg-pane{flex:1 1 0;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1)}
.dsh-git-mrg-pane:last-child{border-right:0}
.dsh-git-mrg-panehead{flex:none;padding:3px 8px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-git-mrg-rows{flex:1;min-height:0;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:18px}
.dsh-git-mrg-wrap{min-width:100%;width:max-content}
.dsh-git-mrg-lrow{display:flex;height:18px;white-space:pre}
.dsh-git-mrg-lno{flex:none;width:40px;padding-right:8px;text-align:right;color:var(--dsw-alias-label-secondary);opacity:.6;-webkit-user-select:none;user-select:none}
.dsh-git-mrg-ltext{flex:1;padding-right:10px}
.dsh-git-mrg-m-ours{background:rgba(74,125,207,.16)}
.dsh-git-mrg-m-theirs{background:rgba(214,160,34,.16)}
.dsh-git-mrg-m-base{background:rgba(128,128,142,.16)}
.dsh-git-mrg-emptyp{padding:10px;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px}
/* 结果区：textarea 是本体（中文输入法、选区、原生行为都归它），色块层垫在底下，
    按「行号 × 18px 行高 + 4px 内边距」定位、跟随滚动平移 —— 几何是算术，不逐行
    镜像 DOM。textarea 的 padding 与行高必须和这里完全一致，错 1px 色块就串行。 */
.dsh-git-mrg-editor{position:relative;flex:1 1 50%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base)}
.dsh-git-mrg-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.dsh-git-mrg-band{position:absolute;left:0;width:100%}
.dsh-git-mrg-band-block{background:rgba(214,69,69,.10)}
.dsh-git-mrg-band-block-on{background:rgba(214,69,69,.24)}
.dsh-git-mrg-band-left{background:rgba(74,125,207,.10)}
.dsh-git-mrg-band-left-on{background:rgba(74,125,207,.26)}
.dsh-git-mrg-band-right{background:rgba(214,160,34,.10)}
.dsh-git-mrg-band-right-on{background:rgba(214,160,34,.26)}
.dsh-git-mrg-input{position:absolute;inset:0;box-sizing:border-box;border:0;outline:none;resize:none;background:transparent;color:var(--dsw-alias-label-primary);padding:4px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:18px;white-space:pre;overflow:auto}
.dsh-git-mrg-input::selection{background:rgba(74,125,207,.35)}
.dsh-git-mrg-foot{flex:none;display:flex;align-items:center;gap:6px;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsh-git-mrg-note{flex:none;padding:4px 10px;white-space:pre-wrap;cursor:pointer}
.dsh-git-mrg-confirm{width:min(460px,100%)}
`)
    }, 'dsh-git-idea panel styles')

