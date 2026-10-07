    ctx.effect(function () {
      return styles.insert(`
.dsh-git-chip{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:200px;padding:0 10px;border:none;border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;flex:none}
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
.dsh-git-lf-select{appearance:none;-webkit-appearance:none;-moz-appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-family:inherit;padding:0;flex:0 1 auto;min-width:0;overflow:hidden;cursor:pointer;outline:none}
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
.dsh-git-commitpane{width:304px;flex:none;border-left:1px solid var(--dsw-alias-border-l1);padding:8px;display:flex;flex-direction:column;gap:8px}
.dsh-git-crow{display:flex;align-items:center;gap:8px;height:26px;box-sizing:border-box;padding:0 8px;cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none}
.dsh-git-crow:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-git-crow-sel{background:var(--dsw-alias-interactive-bg-hover)}
/* 选中的那一行悬浮上去仍然是选中色：两条规则权重一样（一个类 + 一个伪类），
   谁写在后面谁赢 —— 少了这一条，鼠标一放上去选中色就被悬停色顶掉，看起来
   就像选中丢了。分支树的行一直是这个规矩。 */
.dsh-git-crow-sel:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-subject{flex:1;overflow:hidden;text-overflow:ellipsis}
.dsh-git-author{flex:none;width:84px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-git-date{flex:none;width:82px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11px}
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
.dsh-git-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-git-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-git-tools{position:relative;flex:none;display:flex;align-items:center;gap:3px;flex-wrap:nowrap;padding:5px 52px 5px 7px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
/* Every part of this strip is fixed-width except the search box and the filters,
   and the four commit actions at the end are the last thing that should ever
   move: when a branch name makes the row too long, the things that can give way
   do — the search shrinks and the filter chips clip — rather than the actions
   dropping onto a second line under the filters they belong beside. */
.dsh-git-logsearch{flex:0 1 170px}
.dsh-git-tool{display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;background:0 0;color:var(--dsw-alias-label-primary);border-radius:5px;padding:3px 7px;font-size:11px;font-family:inherit;cursor:pointer;flex:none;line-height:16px}
.dsh-git-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-tool:disabled{opacity:.4;cursor:default}
.dsh-git-tool-on{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1)}
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
.dsh-git-set-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-git-set-label{flex:none;min-width:170px;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsh-git-set-input{flex:1 1 160px;width:auto;max-width:260px}
.dsh-git-set-num{flex:none;width:74px}
.dsh-git-set-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}
.dsh-git-set-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-git-set-group{margin-top:6px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
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
   透明色在浅色和深色底上都读得出来（取自 LANE_COLORS 里的 #22a06b / #d64545）。 */
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
.dsh-git-dline{display:flex;height:18px;box-sizing:border-box;white-space:pre}
.dsh-git-dno{flex:none;width:44px;padding-right:8px;text-align:right;color:var(--dsw-alias-label-secondary);opacity:.6;-webkit-user-select:none;user-select:none}
.dsh-git-dsign{flex:none;width:12px;color:var(--dsw-alias-label-secondary);-webkit-user-select:none;user-select:none}
.dsh-git-dtext{flex:1;padding-right:10px}
.dsh-git-dl-add{background:rgba(34,160,107,.14)}
.dsh-git-dl-add .dsh-git-dsign{color:var(--dsw-alias-state-success-primary)}
.dsh-git-dl-del{background:rgba(214,69,69,.14)}
.dsh-git-dl-del .dsh-git-dsign{color:var(--dsw-alias-state-error-primary)}
.dsh-git-dl-hunk{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-git-dl-meta{color:var(--dsw-alias-label-secondary)}
.dsh-git-dl-note{color:var(--dsw-alias-label-secondary)}

/* ── 仓库切换列表 ──
    一个工作区里嵌着多个仓库时，左栏分支树和变更页各有一列这样的行。它刻意不用
    dsh-git-trow 那套类名：树行带着折叠、树选中和一串跟着类名走的断言，仓库行是
    另一类控件 —— 不折叠、不属于哪棵树，被当成树行数进去只会搅浑两边。 */
.dsh-git-repo-head{display:flex;align-items:center;gap:6px;padding:6px 6px 2px;color:var(--dsw-alias-label-secondary);font-size:10px;text-transform:uppercase;letter-spacing:.04em}
.dsh-git-repo-head-name{flex:none}
.dsh-git-repo-note{margin-left:auto;flex:none;font-size:10px}
.dsh-git-repo-row{display:flex;align-items:center;gap:5px;padding:2px 6px;border-radius:4px;cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none}
.dsh-git-repo-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-git-repo-mark{flex:none;width:10px;font-size:9px;text-align:center;color:var(--dsw-alias-brand-primary)}
.dsh-git-repo-name{overflow:hidden;text-overflow:ellipsis;min-width:0}
.dsh-git-repo-dim{flex:none;margin-left:auto;padding-right:4px;color:var(--dsw-alias-label-secondary);font-size:10px}
/* 生效仓库：名字加粗，左缘一道品牌色竖线 —— 和分支树里「筛选范围」那一格同一个
   读法（dsh-git-trow-scope），见过一次就不用再学。 */
.dsh-git-repo-cur{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.dsh-git-repo-cur .dsh-git-repo-name{font-weight:600;color:var(--dsw-alias-brand-primary)}
/* Ctrl+单击挑中的仓库 */
.dsh-git-repo-sel{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-git-repo-sel:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 手动登记过、目录已经不在的那行：留得住也删得掉，但看得出它失效了 */
.dsh-git-repo-gone{opacity:.55}
.dsh-git-repo-x{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;padding:0 2px;border-radius:3px;cursor:pointer}
.dsh-git-repo-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-git-repo-add{display:flex;align-items:center;gap:5px;margin-top:2px;padding:2px 6px;border-radius:4px;cursor:pointer;white-space:nowrap}
.dsh-git-repo-add:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-git-repo-addrow{display:flex;gap:4px;padding:2px 6px}
.dsh-git-repo-input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:2px 4px;outline:none}
.dsh-git-repo-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-git-repo-ok{flex:none}
.dsh-git-repo-problem{padding:2px 8px 4px;font-size:10px;line-height:14px;color:var(--dsw-alias-state-error-primary)}
/* 设置页（这里还不是仓库）下面挂的那份仓库清单：RepoSetup 自己是可滚动的整页，
   清单跟在它下面同页滚动，一条细线隔开。 */
.dsh-git-setupwrap{flex:1;display:flex;flex-direction:column;min-height:0;overflow:auto}
.dsh-git-setupwrap .dsh-git-setup{flex:none;overflow:visible}
.dsh-git-setup-repos{padding:0 20px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
/* 变更页左侧那列仓库侧栏：宽度对着分支树那栏（208px）收窄一点 —— 变更树本身还有
   一列目录缩进要放。 */
.dsh-git-reposide{width:168px;flex:none;overflow:auto;padding:2px 0 6px;border-right:1px solid var(--dsw-alias-border-l1)}
/* 按仓库分组的组头：左栏分支树（多选时）和变更树（多选时）共用。点它就是「只看
   这个仓库」，所以它是可点的，但样式是标题 —— 组里那些行才是内容。 */
.dsh-git-rgroup{display:flex;align-items:center;gap:5px;margin-top:4px;padding:3px 6px;border-radius:4px;font-weight:600;cursor:pointer;white-space:nowrap}
.dsh-git-rgroup:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-git-rgroup .dsh-git-repo-dim{margin-left:0;padding-left:4px}
`)
    }, 'dsh-git-idea panel styles')

