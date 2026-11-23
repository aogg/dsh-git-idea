/* ─────────────── 面板「命令」页的出口：这个 git 面板自己执行过的 git 命令 ───────────────
 *
 * 这一页的数据源只有一份：面板自己经 RPC 跑的 git，记录器在 77-cmdrec.js（本会话的
 * 内存环形缓冲 + 配置目录里的 JSONL 持久化 + liveHub 实时推送），这里只负责出口 ——
 * 拿到面板记录、按会话/工作区归位、按 time 降序去重、套 limit、把「截断」如实带出去。
 *
 * 与记录器分开的理由只有一条：77 管「记什么、怎么记、怎么落盘」，这一片管「一次答复
 * 给哪几行」，两件事的失败方式不一样 —— 记录器写盘失败不该影响读，读失败也不该影响
 * 已经记下的行。
 *
 * 这里过去还有一路数据源：扫 DSH 会话记录（`$DSH_HOME/sessions/<工作区 slug>/…` 的
 * 多帧 zstd，`node -e` 起独立脚本、魔数切帧、逐帧解压、全量 JSON.parse，再按
 * (mtimeMs,size) 记一本增量账）。那一路读的是「AI 会话里跑过的 git 命令」，与面板
 * 无关（面板走的是 RPC，会话文件里根本没有它），整段已删除 —— 冷扫描单工作区实测
 * 5.5s、9p 真实工作区 7–17s，是这一页最慢的一段，随它一起消失。
 *
 * 「重新读取」重读的是记录：这一片一条 git 进程都不起、一个字节的仓库都不碰。 */

/* 一页默认 500 条：够翻到最近干的活，又不至于把整块 UI 按在一次答复里。 */
const CMDLOG_DEFAULT_LIMIT = 500
/* limit 封顶与 77-cmdrec.js 的 CMDREC_MAX 同一个数：面板记录的全部来源（内存环形 +
   文件尾部）各自上限就是这么多，问得更多只是把同一批行重排一遍；而一屏 2000 条已经
   是「找不到就算」的量级。顺带保住一件事：limit 再怎么传，一次答复的体量都有界。 */
const CMDLOG_LIMIT_MAX = 2000

/* 一次答复 = 面板记录按 limit 取最新的一截。
 *
 * 工作区是**会话自己的** cwd：记录按会话/目录归位（77 的 cmdrecScopeRows），所以
 * 读不出来就明说 —— 折成空列表就成了「这个工作区没跑过 git」，那是另一个问题的答案。
 * 排序与去重都在 77 的 cmdrecMerge 里：同一行「内存在场 + 文件尾部也有一份」是常态
 * （内存带最新退出码），不合并的话同一行会画两遍。 */
async function commandLogSnapshot(input) {
  const workspace = sessionWorkdir(input)
  if (workspace === undefined) return { ok: false, error: '无法确定这个会话的工作区，读不了它的命令记录' }
  const asked = input != null ? parseInt(input.limit, 10) : NaN
  const limit = isNaN(asked) ? CMDLOG_DEFAULT_LIMIT : Math.min(Math.max(asked, 1), CMDLOG_LIMIT_MAX)
  const panel = await cmdrecPanelRows()
  const scoped = cmdrecScopeRows(panel.rows, input != null && isStr(input.sessionId) ? input.sessionId : '', workspace)
  const merged = cmdrecMerge([scoped])
  return {
    ok: true,
    commands: merged.length > limit ? merged.slice(0, limit) : merged,
    /* 两个截断来源都要说：这次答复按 limit 切过，或持久化文件尾部本来就只有这么长
       （cmdrecPanelRows 的 clipped，文件被体积截断过）。不说的话，「最近怎么会只有
       500 条」就成了悬案。 */
    truncated: merged.length > limit || panel.clipped === true,
  }
}
