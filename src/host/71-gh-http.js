/* ─────────────── GitHub Actions 的宿主半 ──────────────

   「Actions」页签要的三件事都在这里：把 origin 拆成 owner/repo、替浏览器去问
   api.github.com、以及 OAuth 设备码那两条 github.com 端点的单次转发。请求都由
   浏览器发起（打开页签、点 ⟳、会话完成的钩子），宿主只做「这一次」HTTP ——
   没有后台常驻轮询，也没有定时器。

   代理：全局配置的 ghProxy 本版本只是**占位**（空 = 直连）。Node 的原生 fetch
   默认不读 HTTP(S)_PROXY 环境变量；部署在代理链后面时把 NODE_USE_ENV_PROXY=1
   加进 DSH 进程的环境，fetch 才会走环境代理 —— 这是 Node ≥ 24 的实验开关，
   不自研 CONNECT 代理。

   token 安全：ghToken 只住在这份配置文件里（$DSH_HOME/dsh-git-idea.json）。
   git/config 与 git/config-save 的答复在 80-rpc.js 里经 ghConfigForClient /
   ghMergeSentinelToken 走哨兵 —— 客户端只见 {saved:true, tail:'abcd4'}，见不到
   token 本身；设备码流程拿到的 access_token 在这里**直接写盘**、从不回传明文
   （答复只带尾 4 位）。 */

const GITHUB_API_BASE = 'https://api.github.com'
const GITHUB_WEB_BASE = 'https://github.com'
const GH_RUNS_PER_PAGE = 30
const GH_RUNS_MAX = 30
const GH_TOKEN_MAX = 512
const GH_CLIENT_ID_MAX = 64
const GH_PROXY_MAX = 500
/* ghRepos 的值是 "owner/repo" 一段文本；GitHub 两段各自最长 100 字符，给足余量。 */
const GH_OWNER_REPO_MAX = 220
const GH_REPO_MAP_MAX = 64
const GH_KEY_MAX = 4096
/* ghWorkflows 每工作区收的 yaml 路径条数与单条长度。runs 的客户端过滤靠 run.path
   与这里的条目做等值比较，超长的路径反正等不上任何 run。 */
const GH_WORKFLOW_MAP_MAX = 64
const GH_WORKFLOW_LIST_MAX = 30
const GH_WORKFLOW_PATH_MAX = 300
const GH_HTTP_TIMEOUT_MS = 15000
/* 设备码轮询的节奏由客户端的用户操作驱动；slow_down 时 GitHub 要求在原间隔上再加
   5 秒，这里把「下一次点击前至少等几秒」作为常数带回去。 */
const GH_SLOW_DOWN_INTERVAL = 10

/* ── owner/repo 的解析 ──

   三种形态都要认（都截到 owner/repo 两段，.git 后缀可有可无）：
     · https://github.com/owner/repo.git
     · git@github.com:owner/repo.git
     · ssh://git@github.com/owner/repo.git
   其余（别的主机、别的协议、带子路径的 GitHub Enterprise）一律 null —— 判不出
   github.com 的远端就不显示 Actions 页签。 */
function ghOwnerRepoOfUrl(url) {
  const raw = isStr(url) ? url.trim() : ''
  if (raw.length === 0) return null
  let rest = null
  const httpsAt = raw.indexOf('github.com/')
  if (httpsAt >= 0 && (httpsAt === 0 || /[:/@]/.test(raw.charAt(httpsAt - 1)))) {
    rest = raw.slice(httpsAt + 'github.com/'.length)
  } else {
    const colon = raw.indexOf('github.com:')
    if (colon >= 0) rest = raw.slice(colon + 'github.com:'.length)
  }
  if (rest == null) return null
  /* 前缀里可能还压着别的路径段（Gitea 的镜像写法等），只认最后两段前的部分：
     owner 不带斜杠 —— 段数对不上就当不是 GitHub 的形状。 */
  if (rest.charAt(0) === '/') rest = rest.slice(1)
  const clean = rest.replace(/\.git$/i, '').replace(/\/+$/, '')
  const slash = clean.indexOf('/')
  if (slash <= 0 || slash >= clean.length - 1 || clean.indexOf('/', slash + 1) >= 0) return null
  const owner = clean.slice(0, slash)
  const repo = clean.slice(slash + 1)
  /* 这两个名字要拼进 URL 路径：URL 里不能出现的字符直接不认（不猜、不编码）；
     纯点段（./..）也不认 —— 那是路径穿越的形状，不是仓库名。 */
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  if (owner.length > 100 || repo.length > 100) return null
  return owner + '/' + repo
}

/* remotesSnapshot 的清单里找 GitHub 的 owner/repo：origin 优先（任务口径就是
   「当前仓库 origin 是 github.com」），没有 origin 时退回唯一的一条远端 —— 只有一
   条时它几乎一定是读者心里的「那个远端」。 */
function ghOwnerRepoOfRemotes(remotes) {
  const list = Array.isArray(remotes) ? remotes : []
  /* 两轮扫描：先 origin 的 URL（任务口径就是 origin），没有 origin 或它不是
     GitHub 形态时再试其余远端 —— 只有一条远端的仓库，那条几乎一定是读者心里的
     「那个远端」。fetch 与 push 指向不同时两处都试。 */
  const originRows = []
  const otherRows = []
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i]
    if (one == null || typeof one !== 'object') continue
    const holder = one.name === 'origin' ? originRows : otherRows
    if (isStr(one.url) && one.url.trim().length > 0) holder.push(one.url.trim())
    if (isStr(one.pushUrl) && one.pushUrl.trim().length > 0) holder.push(one.pushUrl.trim())
  }
  const ordered = originRows.concat(otherRows)
  for (let i = 0; i < ordered.length; i += 1) {
    const found = ghOwnerRepoOfUrl(ordered[i])
    if (found !== null) return found
  }
  return null
}

/* ── 配置字段的归一化（normalizeConfig 在 70-config.js 调；同一作用域，函数声明
   提升让顺序无关）── */

function ghTokenOf(config) {
  return config != null && isStr(config.ghToken) ? config.ghToken : ''
}

function ghClientIdOf(config) {
  return config != null && isStr(config.ghOAuthClientId) ? config.ghOAuthClientId : ''
}

/* 手贴的 token：掐掉两头空白（复制粘贴的常态）、封顶。内容不挑 —— PAT 是读者
   自己从 GitHub 页面上贴来的，值得原样保存。 */
function cleanGhToken(value) {
  return isStr(value) ? value.trim().slice(0, GH_TOKEN_MAX) : ''
}

function cleanGhClientId(value) {
  return isStr(value) ? value.trim().slice(0, GH_CLIENT_ID_MAX) : ''
}

function cleanGhProxy(value) {
  return isStr(value) ? value.trim().slice(0, GH_PROXY_MAX) : ''
}

/* 工作区 → "owner/repo" 覆盖。键值清洗口径与 normalizeAppliedRepos 同一条：键是
   isStoredPath 认的绝对路径（本地 / 或 ssh:// 拼法）≤4096，条数封顶 64；值必须是
   ghOwnerRepoOfUrl 认得出的 owner/repo（这也是一道防呆：把整条 URL 贴进来也能存
   —— 答复的就是 owner/repo 两段）。清洗后条目不足不报错，空映射照存。 */
function normalizeGhRepos(raw) {
  const out = {}
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out
  let kept = 0
  for (const key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    if (kept >= GH_REPO_MAP_MAX) break
    const workspace = isStr(key) ? key.trim() : ''
    const value = isStr(raw[key]) ? raw[key].trim() : ''
    if (!isStoredPath(workspace) || workspace.length > GH_KEY_MAX) continue
    const ownerRepo = ghOwnerRepoOfUrl(value)
    if (ownerRepo === null || ownerRepo.length > GH_OWNER_REPO_MAX) continue
    out[workspace] = ownerRepo
    kept += 1
  }
  return out
}

/* 工作区 → yaml 路径数组。条目 trim 后非空、封顶，去重保持首次出现的顺序；一条都
   不剩的工作区整个丢掉（「清空了」也是答案，没有键就是「空」的存储形状，drafts
   同一条口径）。路径不强制 .github/workflows 前缀也不强制 .yml 后缀 —— 它只是
   run.path 的等值过滤词，存什么比什么都能被 GitHub 的 path 字段对上。 */
function normalizeGhWorkflows(raw) {
  const out = {}
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out
  let kept = 0
  for (const key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    if (kept >= GH_WORKFLOW_MAP_MAX) break
    const workspace = isStr(key) ? key.trim() : ''
    if (!isStoredPath(workspace) || workspace.length > GH_KEY_MAX) continue
    const list = Array.isArray(raw[key]) ? raw[key] : []
    const clean = []
    for (let i = 0; i < list.length && clean.length < GH_WORKFLOW_LIST_MAX; i += 1) {
      const path = isStr(list[i]) ? list[i].trim() : ''
      if (path.length === 0 || path.length > GH_WORKFLOW_PATH_MAX) continue
      if (clean.indexOf(path) >= 0) continue
      clean.push(path)
    }
    if (clean.length > 0) { out[workspace] = clean; kept += 1 }
  }
  return out
}

/* ── token 的哨兵（git/config 答复与 git/config-save 收稿的两端）──

   哨兵是 {saved:true, tail:'abcd4'}：saved=true 的对象在客户端配置里代表「宿主存着
   一个 token，这里只露尾 4 位」。ghConfigForClient 在每次把整份配置发给浏览器前把
   真值换成哨兵；ghMergeSentinelToken 在写盘前把哨兵换回 configCache 里的真值 ——
   客户端「保存整份配置」的通道（savePluginConfig）原样传回哨兵时，token 一个字节
   都不动。字符串照过：那是读者手贴的新 token 或设备码流程写入的真值。 */
function ghSentinelOf(token) {
  const value = isStr(token) ? token : ''
  return value.length > 0 ? { saved: true, tail: value.slice(-4) } : ''
}

function ghConfigForClient(config) {
  if (config == null || typeof config !== 'object') return config
  const out = Object.assign({}, config)
  out.ghToken = ghSentinelOf(config.ghToken)
  return out
}

function ghMergeSentinelToken(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const given = raw.ghToken
  if (given != null && typeof given === 'object' && !Array.isArray(given) && given.saved === true) {
    const kept = configCache !== null ? ghTokenOf(configCache) : ''
    return Object.assign({}, raw, { ghToken: kept })
  }
  return raw
}

/* ── 一次 HTTP 的封装：统一头、超时、限速头、错误归类 ──

   返回 {ok, status, data, remaining, reset, error, detail}。错误类别：
     network   —— fetch 本身失败（DNS、断网、沙箱拦了出网……宿主进程看得见的那半）
     timeout   —— 超时主动放弃
     unauthorized —— 401：token 无效或过期
     forbidden —— 403 但不是配额（比如 SSO 没授权这个 token）
     rate-limited —— 403/429 且 x-ratelimit-remaining: 0（配额用尽，带 reset）
     not-found —— 404：私有仓库匿名一律 404，或路径不存在
     http      —— 其余非 200
   x-ratelimit-reset 是 UTC 秒，原样带回（换算成人话是界面的事）。 */
async function ghHttpJson(url, token, options) {
  const opts = options == null ? {} : options
  const method = isStr(opts.method) ? opts.method : 'GET'
  const formBody = isStr(opts.body) ? opts.body : null
  const headers = { 'user-agent': 'dsh-git-idea', 'accept': 'application/vnd.github+json' }
  const tokenValue = isStr(token) && token.length > 0 ? token : ''
  if (tokenValue.length > 0) headers.authorization = 'Bearer ' + tokenValue
  if (formBody !== null) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    headers.accept = 'application/json'
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller !== null
    ? setTimeout(function () { controller.abort() }, typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : GH_HTTP_TIMEOUT_MS)
    : null
  let response = null
  try {
    response = await fetch(url, { method: method, headers: headers, body: formBody, signal: controller !== null ? controller.signal : undefined })
  } catch (error) {
    const aborted = controller !== null && error != null && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
    const detail = error != null && error.message !== undefined ? String(error.message) : String(error)
    return { ok: false, status: 0, data: null, remaining: '', reset: '', error: aborted ? 'timeout' : 'network', detail: detail }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
  const remaining = response.headers != null && isStr(response.headers.get('x-ratelimit-remaining')) ? response.headers.get('x-ratelimit-remaining') : ''
  const reset = response.headers != null && isStr(response.headers.get('x-ratelimit-reset')) ? response.headers.get('x-ratelimit-reset') : ''
  let data = null
  try {
    const text = await response.text()
    if (text.length > 0) data = JSON.parse(text)
  } catch (error) {
    data = null
  }
  const status = typeof response.status === 'number' ? response.status : 0
  if (status === 200) return { ok: true, status: status, data: data, remaining: remaining, reset: reset, error: '', detail: '' }
  if (status === 401) return { ok: false, status: status, data: data, remaining: remaining, reset: reset, error: 'unauthorized', detail: '' }
  if ((status === 403 || status === 429) && remaining === '0') {
    return { ok: false, status: status, data: data, remaining: remaining, reset: reset, error: 'rate-limited', detail: '' }
  }
  if (status === 403) return { ok: false, status: status, data: data, remaining: remaining, reset: reset, error: 'forbidden', detail: '' }
  if (status === 404) return { ok: false, status: status, data: data, remaining: remaining, reset: reset, error: 'not-found', detail: '' }
  return { ok: false, status: status, data: data, remaining: remaining, reset: reset, error: 'http', detail: String(status) }
}

/* runs 答复里读者用得上的那几列。path（workflow yaml 的路径）是客户端过滤的键，
   其余都是行展示。返回的行不携带任何凭据。 */
function ghRunRow(raw) {
  return {
    id: raw != null && typeof raw.id === 'number' ? raw.id : null,
    name: raw != null && isStr(raw.name) ? raw.name : '',
    path: raw != null && isStr(raw.path) ? raw.path : '',
    headBranch: raw != null && isStr(raw.head_branch) ? raw.head_branch : '',
    headSha: raw != null && isStr(raw.head_sha) ? raw.head_sha.slice(0, 40) : '',
    status: raw != null && isStr(raw.status) ? raw.status : '',
    conclusion: raw != null && isStr(raw.conclusion) ? raw.conclusion : '',
    htmlUrl: raw != null && isStr(raw.html_url) ? raw.html_url : '',
    runNumber: raw != null && typeof raw.run_number === 'number' ? raw.run_number : 0,
    createdAt: raw != null && isStr(raw.created_at) ? raw.created_at : '',
    event: raw != null && isStr(raw.event) ? raw.event : '',
    repository: raw != null && raw.repository != null && isStr(raw.repository.full_name) ? raw.repository.full_name : '',
  }
}

/* ghRepos 查询键：客户端显式带的 workspace（生效仓库口径）优先，缺省回退 repoFrom
   （会话工作区）。repoKeyOf 是 61-repos.js 同一把钳子（去尾斜杠），保证「同一个
   目录两种写法」落在同一个键上。 */
function ghWorkspaceKeyOf(input) {
  if (input != null && isStr(input.workspace) && input.workspace.trim().length > 0) return repoKeyOf(input.workspace.trim())
  const from = repoFrom(input, null)
  return from !== undefined && from !== null && isStr(from) ? repoKeyOf(from) : ''
}

/* ghOverrideOf：查这个工作区配了 owner/repo 覆盖没有。空串 = 没配。键的两种写法
   都查一遍（原样与 repoKeyOf 裁过尾斜杠的）—— 客户端写入的是 Host 解出的仓库根
   （无尾斜杠），查询侧的 repoFrom 也一样，但文件被手改过时别让一个尾斜杠把覆盖
   变成没配。 */
function ghOverrideOf(config, workspace) {
  const map = config != null && config.ghRepos != null && typeof config.ghRepos === 'object' ? config.ghRepos : {}
  const raw = isStr(workspace) ? workspace : ''
  if (raw.length === 0) return ''
  const keys = [raw, repoKeyOf(raw)]
  for (let i = 0; i < keys.length; i += 1) {
    const found = keys[i].length > 0 && map[keys[i]] !== undefined ? map[keys[i]] : undefined
    if (found !== undefined && isStr(found) && found.length > 0) return found
  }
  return ''
}

/* ── Actions runs 的一次读取 ──

   owner/repo 的来源按序：这个工作区配的覆盖（ghRepos）→ 仓库 origin 的 URL。两次
   来源都空就 ok:true 地答 ownerRepo:null（界面说「远端不是 github.com」，这不是
   一次失败）。带 token 与否都照发 —— 公共仓库匿名也能读（60 次/小时），404 才是
   「读不到」。 */
async function ghActionsSnapshot(input) {
  const config = await readConfigFile()
  const workspaceKey = ghWorkspaceKeyOf(input)
  const override = ghOverrideOf(config, workspaceKey)
  let ownerRepo = override
  let source = override.length > 0 ? 'override' : ''
  if (ownerRepo.length === 0) {
    const remotes = await remotesSnapshot(input)
    if (remotes.ok !== true) {
      return { ok: false, ownerRepo: null, workspace: workspaceKey, error: 'remote-failed', stderr: isStr(remotes.stderr) ? remotes.stderr : '', noGit: remotes.noGit === true }
    }
    const parsed = remotes.insideRepo === true ? ghOwnerRepoOfRemotes(remotes.remotes) : null
    if (parsed === null) {
      return {
        ok: true, ownerRepo: null, workspace: workspaceKey, source: '',
        authorized: ghTokenOf(config).length > 0, proxyConfigured: cleanGhProxy(config.ghProxy).length > 0,
        runs: [], totalCount: 0, rateRemaining: '', rateReset: '',
      }
    }
    ownerRepo = parsed
    source = 'origin'
  }
  const token = ghTokenOf(config)
  const one = await ghHttpJson(GITHUB_API_BASE + '/repos/' + ownerRepo + '/actions/runs?per_page=' + String(GH_RUNS_PER_PAGE), token, { timeoutMs: GH_HTTP_TIMEOUT_MS })
  if (one.ok !== true) {
    return {
      ok: false, ownerRepo: ownerRepo, source: source, workspace: workspaceKey,
      authorized: token.length > 0, proxyConfigured: cleanGhProxy(config.ghProxy).length > 0,
      error: one.error, detail: one.detail, httpStatus: one.status,
      rateRemaining: one.remaining, rateReset: one.reset,
    }
  }
  const list = one.data != null && Array.isArray(one.data.workflow_runs) ? one.data.workflow_runs : []
  const runs = []
  for (let i = 0; i < list.length && runs.length < GH_RUNS_MAX; i += 1) {
    const row = list[i]
    if (row == null || typeof row !== 'object') continue
    runs.push(ghRunRow(row))
  }
  return {
    ok: true, ownerRepo: ownerRepo, source: source, workspace: workspaceKey,
    authorized: token.length > 0, proxyConfigured: cleanGhProxy(config.ghProxy).length > 0,
    runs: runs,
    totalCount: one.data != null && typeof one.data.total_count === 'number' ? one.data.total_count : runs.length,
    rateRemaining: one.remaining, rateReset: one.reset,
  }
}

/* ── 设备码「网页授权」：两条 github.com 端点的单次转发 ──

   这两个端点不在 api.github.com 上，不占 API 配额。宿主只转发一次：start 发
   POST /login/device/code，poll 发 POST /login/oauth/access_token。轮询的节奏由
   读者在界面上点「继续」驱动 —— 宿主没有定时器，也没有后台循环。

   poll 拿到 access_token 的那一刻就地写盘（writeConfigFile 走会话的沙箱策略），
   答复只带尾 4 位 —— 明文 token 从出现在 HTTP 答复里。 */

function ghDeviceFormBody(pairs) {
  const parts = []
  for (let i = 0; i < pairs.length; i += 1) {
    parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]))
  }
  return parts.join('&')
}

async function ghDeviceStart(input) {
  const config = await readConfigFile()
  const clientId = cleanGhClientId(config.ghOAuthClientId)
  if (clientId.length === 0) {
    return { ok: false, error: 'no-client-id', stderr: '没有配置 OAuth App 的 Client ID：去全局配置档「GitHub 授权」里填上它，这个按钮才会出现' }
  }
  const one = await ghHttpJson(GITHUB_WEB_BASE + '/login/device/code', '', {
    method: 'POST',
    body: ghDeviceFormBody([['client_id', clientId], ['scope', 'repo']]),
    timeoutMs: GH_HTTP_TIMEOUT_MS,
  })
  if (one.ok !== true) {
    return { ok: false, error: one.error === 'network' ? 'network' : 'start-failed', detail: one.detail, httpStatus: one.status, stderr: 'GitHub 没有接受这次设备码申请' }
  }
  const data = one.data
  const deviceCode = data != null && isStr(data.device_code) ? data.device_code : ''
  const userCode = data != null && isStr(data.user_code) ? data.user_code : ''
  const verificationUri = data != null && isStr(data.verification_uri) ? data.verification_uri : ''
  if (deviceCode.length === 0 || userCode.length === 0 || verificationUri.length === 0) {
    return { ok: false, error: 'bad-reply', stderr: 'GitHub 的答复里缺了设备码的字段，请稍后再试' }
  }
  const expiresIn = data != null && typeof data.expires_in === 'number' && isFinite(data.expires_in) ? data.expires_in : 900
  const interval = data != null && typeof data.interval === 'number' && isFinite(data.interval) && data.interval >= 1 ? data.interval : 5
  /* device_code 是一次性的短期凭据（expires_in 秒后作废），交给浏览器保管、poll 时
     带回来 —— 宿主不做会话级存储（没有后台状态可清）。 */
  return {
    ok: true, deviceCode: deviceCode, userCode: userCode,
    verificationUri: verificationUri,
    expiresAt: Date.now() + Math.min(expiresIn, 3600) * 1000,
    interval: interval,
  }
}

async function ghDevicePoll(input) {
  const config = await readConfigFile()
  const clientId = cleanGhClientId(config.ghOAuthClientId)
  const deviceCode = input != null && isStr(input.deviceCode) ? input.deviceCode.trim() : ''
  if (clientId.length === 0) return { ok: false, error: 'no-client-id', stderr: '没有配置 OAuth App 的 Client ID' }
  if (deviceCode.length === 0 || deviceCode.length > 200) return { ok: false, error: 'bad-request', stderr: '设备码不在手上，请重新点「网页授权」' }
  const one = await ghHttpJson(GITHUB_WEB_BASE + '/login/oauth/access_token', '', {
    method: 'POST',
    body: ghDeviceFormBody([
      ['client_id', clientId],
      ['device_code', deviceCode],
      ['grant_type', 'urn:ietf:params:oauth:grant-type:device_code'],
    ]),
    timeoutMs: GH_HTTP_TIMEOUT_MS,
  })
  if (one.ok !== true) return { ok: false, error: one.error === 'network' ? 'network' : 'poll-failed', detail: one.detail, httpStatus: one.status, stderr: '授权询问没有完成' }
  const data = one.data
  const accessToken = data != null && isStr(data.access_token) ? data.access_token.trim() : ''
  if (accessToken.length > 0) {
    /* 写盘：writeConfigFile 的哨兵合并只认「客户端传来的哨兵」，这里递的是真值
       字符串，照常落盘。argsAt 让这次写拿到发起会话的沙箱策略。 */
    const written = await writeConfigFile(Object.assign({}, config, { ghToken: accessToken }), argsAt(input, null))
    if (written.ok !== true) {
      return { ok: false, error: 'save-failed', stderr: isStr(written.error) ? written.error : 'token 拿到了，但写不进插件配置', sandboxDenied: written.sandboxDenied === true }
    }
    return { ok: true, status: 'granted', saved: true, tail: accessToken.slice(-4) }
  }
  const err = data != null && isStr(data.error) ? data.error : ''
  const detail = data != null && isStr(data.error_description) ? data.error_description : ''
  if (err === 'authorization_pending') return { ok: true, status: 'pending', detail: detail }
  if (err === 'slow_down') return { ok: true, status: 'slow_down', interval: GH_SLOW_DOWN_INTERVAL, detail: detail }
  if (err === 'expired_token') return { ok: true, status: 'expired', detail: detail }
  if (err === 'access_denied') return { ok: true, status: 'denied', detail: detail }
  return { ok: true, status: 'error', error: err.length > 0 ? err : 'unknown', detail: detail }
}
