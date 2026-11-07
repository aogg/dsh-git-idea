#!/usr/bin/env node
/* ── 79d-expose.js 的最小自测 ──

   不进 run-all（那里是整套面板套件，重型）。这里只验证跨插件暴露这一块：

     · 聚合脚本与 git log 命令用 mock shell **真实执行**（bash -c 跑在本仓库上）
       —— 引号、awk、numstat -z 的解析对着真 git 的字节验，罐头输出骗不过它；
     · 参数归一（parseInt / 帽子 / 数组收口）对着 argv 验；
     · cordis 服务与 HTTP 路由的注册与应答用 mock ctx / mock req·res 验。

   跑法：node test/expose-selftest.mjs */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { render, TARGETS } from '../build.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = ROOT /* 本仓库自己就是测试夹具：有真实历史、真改名提交、真 worktree 表 */

let passed = 0
let failed = 0
function ok(condition, name, detail) {
  if (condition === true) {
    passed += 1
    console.log('  ok  ' + name)
  } else {
    failed += 1
    console.error('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail) : ''))
  }
}

function run(command, cwd) {
  return new Promise(function (resolve) {
    execFile('/bin/bash', ['-c', command], { cwd: cwd === null || cwd === undefined ? ROOT : cwd, timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, function (error, stdout, stderr) {
      resolve({
        exitCode: error != null && typeof error.code === 'number' ? error.code : (error == null ? 0 : 1),
        stdoutText: String(stdout == null ? '' : stdout),
        stderrText: String(stderr == null ? '' : stderr),
      })
    })
  })
}

/* mock shell：resolve 原样透传；execute 真跑 bash。SYNTH 标记的查询改回罐头
   输出（测 merge 提交没有 numstat 段的解析分支）。 */
const lastCommands = []
const mockShell = {
  resolve(spec) { return spec },
  async execute(spec) {
    lastCommands.push(spec.command)
    if (spec.command.indexOf('--grep=__SYNTH__') >= 0) {
      const a = 'aaa1111', b = 'bbb2222', c = 'ccc3333'
      const text = [
        a + '\u001f' + a.slice(0, 7) + '\u001fAnn\u001fa@x\u001f2026-01-02T00:00:00+00:00\u001fAnn\u001fa@x\u001f2026-01-02T00:00:00+00:00\u001fone\u001f\u001f\u001f' + '' + '\u001e',
        '\n',
        b + '\u001f' + b.slice(0, 7) + '\u001fBen\u001fb@x\u001f2026-01-01T00:00:00+00:00\u001fBen\u001fb@x\u001f2026-01-01T00:00:00+00:00\u001fmerge two\u001f\u001fHEAD\u001f' + a + '\u001e',
        '\n',
        c + '\u001f' + c.slice(0, 7) + '\u001fCid\u001fc@x\u001f2025-12-31T00:00:00+00:00\u001fCid\u001fc@x\u001f2025-12-31T00:00:00+00:00\u001fthree\u001f\u001f\u001f\u001e',
        '\n',
        '1\t2\tgone.txt\u0000',
        '\u0000',
      ].join('')
      return { exitCode: 0, stdout: { text: text, truncated: false }, stderr: { text: '', truncated: false }, timedOut: false, aborted: false, sandbox: { denied: false } }
    }
    const ran = await run(spec.command, spec.workdir)
    return {
      exitCode: ran.exitCode,
      stdout: { text: ran.stdoutText, truncated: false },
      stderr: { text: ran.stderrText, truncated: false },
      timedOut: false,
      aborted: false,
      sandbox: { denied: false },
    }
  },
}

/* mock ctx：provide / inject / effect 收集起来；get 只认 shell。 */
const provided = {}
const routes = []
const injections = []
const mockCtx = {
  get(name) { return name === 'shell' ? mockShell : undefined },
  provide(name, value) { provided[name] = value; return function () { delete provided[name] } },
  effect(action, label) { return action() },
  inject(deps, cb) {
    injections.push({ deps: deps })
    cb({
      effect(action, label) { return action() },
      webServer: {
        register(route) { routes.push(route); return function () {} },
        registerUpgrade() { return function () {} },
      },
    })
  },
  on() { return function () {} },
}

/* harness 全局（80-rpc 的 onRpc 要用）。 */
globalThis.harness = { handle(name, handler) { return function () {} } }

/* eval 构建产物本体（它就是 `return { apply(ctx) { … } }` 的函数体）。 */
const hostTarget = TARGETS.find(function (t) { return t.out === 'dist/host.js' })
const bodyText = render(hostTarget).replace(/^\/\* GENERATED[^*]*\*\/\n/, '')
const plugin = new Function('ctx', bodyText)(mockCtx)
plugin.apply(mockCtx)

console.log('== 服务与路由注册 ==')
const service = provided['dsh-git-idea']
ok(typeof service === 'object' && service !== null, 'cordis 服务已注册：ctx.get("dsh-git-idea") 可取')
ok(service != null && service.apiVersion === 1, '服务带 apiVersion=1')
ok(typeof service.summary === 'function' && typeof service.log === 'function', '服务暴露 summary/log')
ok(injections.some(function (row) { return row.deps.indexOf('webServer') >= 0 }), 'HTTP 注册等 webServer 可用')
const routePaths = routes.map(function (r) { return r.path })
ok(routePaths.indexOf('/api/dsh-git-idea/summary') >= 0, '路由 /api/dsh-git-idea/summary 已挂')
ok(routePaths.indexOf('/api/dsh-git-idea/log') >= 0, '路由 /api/dsh-git-idea/log 已挂')
ok(routePaths.indexOf('/api/dsh-git-idea/manifest') >= 0, '路由 /api/dsh-git-idea/manifest 已挂')
ok(routePaths.every(function (p) { return p.indexOf('/api/dsh-git-idea/') === 0 }), '全部路由在 /api/dsh-git-idea/ 前缀之下')

console.log('== summary（真实执行聚合脚本）==')
lastCommands.length = 0
const summary = await service.summary({ repos: [REPO] })
ok(summary.ok === true, 'summary ok')
ok(summary.apiVersion === 1 && summary.plugin === 'dsh-git-idea', 'summary 带 plugin/apiVersion')
ok(summary.scope.mode === 'repos' && summary.scope.repos[0] === REPO, 'scope 记录点名仓库')
const me = summary.repos.find(function (r) { return r.path === REPO })
ok(me != null && me.ok === true, '本仓库聚合成功（脚本语法与解析都对）' + (me != null ? '' : ' ' + JSON.stringify(summary.repos)))
if (me != null && me.ok === true) {
  ok(typeof me.branch === 'string' && me.branch.length > 0, 'branch=' + me.branch)
  ok(me.detached === false, 'detached=false')
  ok(Number.isInteger(me.counts.staged) && Number.isInteger(me.counts.unstaged) && Number.isInteger(me.counts.untracked) && Number.isInteger(me.counts.unmerged), 'counts 四项都是整数 ' + JSON.stringify(me.counts))
  ok(Number.isInteger(me.stash) && me.stash >= 0, 'stash 整数 ' + me.stash)
  ok(Array.isArray(me.worktrees), 'worktrees 数组 ' + me.worktrees.length)
  ok(me.refs.branches.total >= 1 && me.refs.branches.names.indexOf(me.branch) >= 0, 'branches total=' + me.refs.branches.total + ' 含当前分支')
  ok(typeof me.refs.tags.total === 'number', 'tags total=' + me.refs.tags.total)
  ok(me.head != null && /^[0-9a-f]{40}$/.test(me.head.hash) === true, 'head.hash 40 位')
  ok(typeof me.upstream === 'string' || me.upstream === null, 'upstream=' + me.upstream)
  ok(Number.isInteger(me.ahead) && Number.isInteger(me.behind), 'ahead/behind 整数')
}

console.log('== 不存在的仓库 / 相对路径拒绝 ==')
const bad = await service.summary({ repos: ['/definitely/not/a/repo', 'relative/path'] })
const badRow = bad.repos.find(function (r) { return r.path === '/definitely/not/a/repo' })
ok(bad.ok === true && badRow != null && badRow.ok === false, '不存在仓库整仓 ok:true、行内 ok:false（优雅降级）')
ok(bad.repos.every(function (r) { return r.path.indexOf('relative/') !== 0 }), '相对路径被 isStoredPath 拒绝')
const none = await service.summary({})
ok(none.scope.mode === 'none' && none.error === 'no-workspace' && none.repoCount === 0, '无会话无仓库 → no-workspace')

console.log('== log（真实 git）==')
const log1 = await service.log({ repos: [REPO], limit: 5, grep: 'worktree' })
ok(log1.ok === true, 'log ok')
ok(log1.scope.mode === 'repos', 'log scope=repos')
const argvCmd = lastCommands[lastCommands.length - 1] || ''
ok(argvCmd.indexOf('--grep=worktree') >= 0 && argvCmd.indexOf('--fixed-strings') >= 0 && argvCmd.indexOf('-i') >= 0, 'argv 带 --grep/--fixed-strings/-i')
ok(argvCmd.indexOf('--max-count=6') >= 0, 'limit=5 → --max-count=6（多一条探「还有更多」）')
ok(argvCmd.indexOf('-M') >= 0 && argvCmd.indexOf('--numstat') >= 0 && argvCmd.indexOf('-z') >= 0, 'argv 带 -M --numstat -z')
if (log1.repos[0] != null && log1.repos[0].ok === true) {
  const one = log1.repos[0]
  ok(one.commits.length >= 1, 'grep 命中 ' + one.commits.length + ' 条')
  const c0 = one.commits[0]
  ok(/^[0-9a-f]{40}$/.test(c0.hash) === true && typeof c0.subject === 'string', 'commit.hash/subject')
  ok(c0.author != null && typeof c0.author.email === 'string' && typeof c0.author.date === 'string', 'commit.author 三元组')
  ok(c0.committer != null && typeof c0.committer.name === 'string' && typeof c0.committer.date === 'string', 'commit.committer 三元组')
  ok(Array.isArray(c0.files), 'commit.files 数组')
  if (c0.files.length > 0) {
    const f0 = c0.files[0]
    ok(typeof f0.path === 'string' && f0.path.length > 0, 'file.path=' + f0.path)
    ok((f0.added === null || Number.isInteger(f0.added)) && (f0.deleted === null || Number.isInteger(f0.deleted)), 'file.added/deleted 整数或 null(二进制)')
  }
  ok(c0.stats != null && Number.isInteger(c0.stats.additions) && Number.isInteger(c0.stats.deletions) && Number.isInteger(c0.stats.filesChanged), 'commit.stats 整数')
}

const log2 = await service.log({ repos: [REPO], limit: 2 })
ok(log2.repos[0].hasMore === true && log2.repos[0].commits.length === 2, 'limit=2 → hasMore=true 且只回 2 条')
ok(log2.commitCount === 2, 'commitCount=2')

const log3 = await service.log({ repos: [REPO], limit: 99999 })
const clampCmd = lastCommands[lastCommands.length - 1] || ''
ok(clampCmd.indexOf('--max-count=501') >= 0, 'limit=99999 收敛到上限 500（--max-count=501）')
ok(log3.query.limit === 500, 'reply.query.limit=500')
ok(log3.commits.every(function (c) { return c.repo === REPO }), '每条 commit 带 repo 字段')

const log4 = await service.log({ repos: [REPO], limit: 3, skip: 2 })
const skipCmd = lastCommands[lastCommands.length - 1] || ''
ok(skipCmd.indexOf('--skip=2') >= 0, 'skip=2 → --skip=2')
ok(log4.query.skip === 2, 'reply.query.skip=2')
const log5 = await service.log({ repos: [REPO], includeFiles: false, limit: 3 })
ok(log5.commits.every(function (c) { return Array.isArray(c.files) && c.files.length === 0 }) && log5.commits.every(function (c) { return c.stats != null }), 'includeFiles=false → files 清空、stats 保留')

/* 改名提交：本仓库 80879c5 把 docs/功能列表.md 改名过 —— 用 from..to 圈住它。 */
const renameInfo = await run("git log --diff-filter=R --format='%H %P' -1")
const renameParts = renameInfo.stdoutText.trim().split(' ')
if (renameParts.length === 2 && renameParts[0].length === 40) {
  const logR = await service.log({ repos: [REPO], from: renameParts[1], to: renameParts[0], limit: 5 })
  const rc = logR.commits[0]
  const renamed = rc != null ? rc.files.filter(function (f) { return f.renamed === true }) : []
  ok(rc != null && renamed.length >= 1, '改名提交识别出 renamed 条目')
  ok(renamed[0] != null && typeof renamed[0].oldPath === 'string' && renamed[0].oldPath.length > 0 && renamed[0].path !== renamed[0].oldPath, 'renamed.oldPath=' + (renamed[0] != null ? renamed[0].oldPath : '-'))
} else {
  ok(false, '找不到改名提交（夹具变化）')
}

/* merge 提交（无 numstat 段）的解析：走 SYNTH 罐头。 */
const logS = await service.log({ repos: [REPO], grep: '__SYNTH__', limit: 10 })
ok(logS.repos[0].commits.length === 3, 'SYNTH：3 条提交全解析（含无 numstat 的 merge）')
ok(logS.repos[0].commits.every(function (c) { return Array.isArray(c.files) }), 'SYNTH：merge 提交 files 为空数组')
ok(logS.repos[0].commits[2] != null && logS.repos[0].commits[2].files.length === 1 && logS.repos[0].commits[2].files[0].added === 1 && logS.repos[0].commits[2].files[0].deleted === 2, 'SYNTH：末条 numstat 归到正确的提交（1/2）')

const logM = await service.log({ repos: [REPO], limit: 3, authors: ['不存在的作者'], merges: 'only', firstParent: true, regex: true, caseSensitive: true, grep: '面板' })
/* 作者不存在 → log 退出非 0 → 还有 verifyHead / rev-parse 两条后继命令；断言要
   找带着这些旗标的那一条，不能只看最后一条。regex 只随 grep 下发，caseSensitive
   时 -i 不出现。 */
const mCmd = lastCommands.find(function (c) { return c.indexOf('--author=') >= 0 }) || ''
ok(mCmd.indexOf('--author=') >= 0 && mCmd.indexOf('--fixed-strings') >= 0 && mCmd.indexOf('--merges') >= 0 && mCmd.indexOf('--first-parent') >= 0 && mCmd.indexOf('--extended-regexp') >= 0 && mCmd.indexOf('-i ') < 0 && mCmd.indexOf("'-i'") < 0, 'argv 聚齐 author/merges/firstParent/regex 且大小写敏感时无 -i')

const logRange = await service.log({ repos: [REPO], from: 'HEAD~2', to: 'HEAD', limit: 10 })
const rangeCmd = lastCommands[lastCommands.length - 1] || ''
ok(rangeCmd.indexOf('HEAD~2..HEAD') >= 0, 'from/to → HEAD~2..HEAD')
ok(logRange.scope.range === 'HEAD~2..HEAD', 'reply.scope.range')

const logAll = await service.log({ repos: [REPO], all: true, limit: 3 })
const allCmd = lastCommands[lastCommands.length - 1] || ''
ok(allCmd.indexOf("'--all'") >= 0, 'all=true → --all')

const logNoRepo = await service.log({})
ok(logNoRepo.scope.mode === 'none' && logNoRepo.error === 'no-repository', 'log 无会话无仓库 → no-repository')

const logBad = await service.log({ repos: [REPO], repos2: 'x', limit: 'abc' })
ok(logBad.query.limit === 50, 'limit 非数字 → 默认 50（parseInt 规矩）')

console.log('== HTTP 通道 ==')
function routeOf(p) { return routes.find(function (r) { return r.path === p }) }

function makeReq(method, url, headers, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers || {}
  process.nextTick(function () {
    if (body !== undefined) req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

function makeRes() {
  const res = { statusCode: 0, headers: null, body: '' }
  res.writeHead = function (code, headers) { res.statusCode = code; res.headers = headers }
  res.end = function (text) { res.body = String(text == null ? '' : text) }
  return res
}

const manifestRoute = routeOf('/api/dsh-git-idea/manifest')
const manifestRes = makeRes()
await manifestRoute.handler(makeReq('GET', '/api/dsh-git-idea/manifest'), manifestRes)
const manifestBody = JSON.parse(manifestRes.body)
ok(manifestBody.ok === true && manifestBody.routes.length === 3, 'manifest 列出 3 条路由')

const summaryRoute = routeOf('/api/dsh-git-idea/summary')
const getRes = makeRes()
await summaryRoute.handler(makeReq('GET', '/api/dsh-git-idea/summary?repos=' + encodeURIComponent(REPO) + '&limit=3'), getRes)
const getBody = JSON.parse(getRes.body)
ok(getBody.ok === true && getBody.repoCount === 1 && getBody.query === undefined, 'GET query 参数生效（summary 无 query 回显）')

const postRes = makeRes()
await summaryRoute.handler(makeReq('POST', '/api/dsh-git-idea/summary', { origin: 'http://same:3080', host: 'same:3080' }, JSON.stringify({ repos: [REPO] })), postRes)
ok(JSON.parse(postRes.body).ok === true && JSON.parse(postRes.body).repoCount === 1, 'POST 同源 JSON body 生效')

const crossRes = makeRes()
await summaryRoute.handler(makeReq('POST', '/api/dsh-git-idea/summary', { origin: 'http://evil:1', host: 'same:3080' }, '{}'), crossRes)
ok(crossRes.statusCode === 403, 'POST 跨源 → 403（sameOrigin 门）')

const delRes = makeRes()
await summaryRoute.handler(makeReq('DELETE', '/api/dsh-git-idea/summary', {}, undefined), delRes)
ok(delRes.statusCode === 405, 'DELETE → 405')

const logRoute = routeOf('/api/dsh-git-idea/log')
const logGet = makeRes()
await logRoute.handler(makeReq('GET', '/api/dsh-git-idea/log?repos=' + encodeURIComponent(REPO) + '&limit=2&grep=worktree&grepAll=true&merges=exclude'), logGet)
const logGetBody = JSON.parse(logGet.body)
ok(logGetBody.ok === true && logGetBody.query.limit === 2 && logGetBody.query.grep[0] === 'worktree' && logGetBody.query.grepAll === true && logGetBody.query.merges === 'exclude', 'GET log 多条件参数归一（重复键数组 + 数值 parseInt + 布尔）')

const badJson = makeRes()
await summaryRoute.handler(makeReq('POST', '/api/dsh-git-idea/summary', { origin: 'http://same:3080', host: 'same:3080' }, '{oops'), badJson)
ok(badJson.statusCode === 400, 'POST 坏 JSON → 400')

console.log('')
console.log('passed=' + passed + ' failed=' + failed)
process.exit(failed > 0 ? 1 : 0)
