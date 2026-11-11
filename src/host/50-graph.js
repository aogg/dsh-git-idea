/* ─────────────── graph layout ─────────────── */

function layoutGraph(commits, maxLanes) {
  const lanes = []
  const rows = []
  let widest = 1
  for (let i = 0; i < commits.length; i += 1) {
    const commit = commits[i]
    let lane = lanes.indexOf(commit.hash)
    if (lane < 0) {
      lane = lanes.indexOf(null)
      if (lane < 0) {
        if (lanes.length >= maxLanes) lane = lanes.length - 1
        else { lanes.push(null); lane = lanes.length - 1 }
      }
    }
    lanes[lane] = null
    const edges = []
    for (let k = 0; k < commit.parents.length; k += 1) {
      const parent = commit.parents[k]
      let parentLane = lanes.indexOf(parent)
      if (parentLane < 0) {
        if (k === 0) { parentLane = lane; lanes[lane] = parent }
        else {
          parentLane = lanes.indexOf(null)
          if (parentLane < 0) {
            if (lanes.length >= maxLanes) continue
            lanes.push(parent)
            parentLane = lanes.length - 1
          } else lanes[parentLane] = parent
        }
      }
      edges.push({ hash: parent, lane: parentLane })
      if (parentLane + 1 > widest) widest = parentLane + 1
    }
    if (lane + 1 > widest) widest = lane + 1
    rows.push({ lane: lane, edges: edges })
  }
  return { rows: rows, lanes: widest }
}

/* ── the graph under a filter ──

   The plain layout below walks the commits it is handed, so it can only ever
   connect two of them: a parent that the filter hid is not in the list, and the
   lane booked for it is never claimed — the next commit then takes a *fresh*
   lane. Measured on the reader's repository with `fix` typed in the search box
   (200 matching commits): 104 lanes' worth of bookings, capped at 14, a 202px
   column that is mostly empty, 52% of the edges drawn as a one-row stub, and
   the dots marching right until they all pile onto the last lane. Same search,
   same repository, the graph was unreadable — while the plain history drew a
   proper ribbon.

   So a filtered read is laid out on the **real** DAG: the host reads the plain
   hash+parents history for the span the matches cover (measured: 1518 commits
   in 190ms for those 200 rows), lays that out, and then places each visible
   commit on the lane it really holds. An edge is drawn to the nearest *visible*
   ancestor, and marked dashed when commits in between were filtered out —
   IDEA's own reading of a dashed line, and the reason its graph stays a graph
   when a filter is on. Nothing here changes an unfiltered read: that path still
   goes through layoutGraph alone. */
const DAG_SKIP_MAX = 5000

function layoutVisible(full, commits, maxLanes) {
  const base = layoutGraph(full, maxLanes)
  const rowOf = {}
  for (let i = 0; i < full.length; i += 1) rowOf[full[i].hash] = i
  const visible = {}
  for (let i = 0; i < commits.length; i += 1) visible[commits[i].hash] = true
  const laneOf = function (hash) {
    const at = rowOf[hash]
    return at === undefined ? -1 : base.rows[at].lane
  }

  const rows = []
  let widest = 1
  for (let i = 0; i < commits.length; i += 1) {
    const commit = commits[i]
    let lane = laneOf(commit.hash)
    /* A match that the span does not reach (it is older than the range the DAG
       read was allowed) has no lane of its own; it joins the row above rather
       than starting a lane the picture cannot justify. */
    if (lane < 0) lane = rows.length > 0 ? rows[rows.length - 1].lane : 0
    const edges = []
    for (let k = 0; k < commit.parents.length; k += 1) {
      const parent = commit.parents[k]
      let cur = parent
      let dashed = false
      let guard = 0
      while (rowOf[cur] !== undefined && visible[cur] !== true) {
        dashed = true
        const grand = full[rowOf[cur]].parents
        if (grand.length === 0) { cur = null; break }
        cur = grand[0]
        guard += 1
        if (guard > DAG_SKIP_MAX) { cur = null; break }
      }
      const reached = cur !== null && visible[cur] === true
      const target = reached ? laneOf(cur) : laneOf(parent)
      const edgeLane = target < 0 ? lane : target
      /* Whatever is left is a parent this list does not contain and cannot
         follow to one: the line leaves the page, and the client draws it that
         way instead of stopping it a row short. */
      edges.push({ hash: reached ? cur : parent, lane: edgeLane, dashed: reached ? dashed : true })
      if (edgeLane + 1 > widest) widest = edgeLane + 1
    }
    if (lane + 1 > widest) widest = lane + 1
    rows.push({ lane: lane, edges: edges })
  }
  return { rows: rows, lanes: widest }
}

/* `git log --pretty=format:%H %P`, one commit per line: the plain history the
   filtered graph is laid out on. Only the shape of the DAG is needed, so this is
   the cheapest form of the same walk. */
function parseDag(stdout) {
  const commits = []
  const lines = stdout.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '')
    if (line.length === 0) continue
    const parts = line.split(' ')
    const parents = []
    for (let k = 1; k < parts.length; k += 1) if (parts[k].length > 0) parents.push(parts[k])
    commits.push({ hash: parts[0], parents: parents })
  }
  return commits
}

function parseCommitRecords(stdout) {
  const commits = []
  const records = stdout.split('\u001e')
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i].replace(/^\n+/, '')
    if (record.length === 0) continue
    const fields = record.split('\u001f')
    const parents = fields[7] === undefined || fields[7].length === 0 ? [] : fields[7].split(' ')
    commits.push({
      hash: field(fields, 0),
      short: field(fields, 1),
      author: field(fields, 2),
      email: field(fields, 3),
      date: field(fields, 4),
      subject: field(fields, 5),
      refs: field(fields, 6),
      parents: parents,
      /* %b（第 8 个字段，64-history.js 的 format 末位）：提交信息正文，喂给历史页
         的「行：」显示选择器。尾换行剥掉 —— 79d-expose.js 对 %b 的既有处理；
         66-refs.js 的推送预览走同一个解析器，它的 format 没有这一位，
         field() 兜底成空串，弹窗行不吃它。 */
      body: field(fields, 8).replace(/\n+$/, ''),
    })
  }
  return commits
}

