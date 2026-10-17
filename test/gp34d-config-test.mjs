import fs from 'node:fs'
import { spawn } from 'node:child_process'
const body = fs.readFileSync(process.env.GP_SRC || new URL('../host.js', import.meta.url).pathname, 'utf8')
function runShell(spec) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: Object.assign({}, process.env, { DSH_HOME: '/tmp/gp34d-home/.dsh', HOME: '/tmp/gp34d-home', GIT_CONFIG_GLOBAL: '/tmp/gp34d-home/.gitconfig', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('error', er => res({ exitCode: null, stdout: { text: o }, stderr: { text: String(er.message) } }))
    c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}
/* 没有 fs 服务这一项：这份配置文件走 shell（它在任何工作区之外，而文件服务是按工作区
   发策略的 —— 真机上正是这条把它写丢的）。骨架里只给 shell，就说明它不再需要别的东西。 */
const handlers = new Map()
const ctx = { get: n => (n === 'shell' ? { resolve: r => r, run: runShell } : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
const harness = { handle(n, f) { handlers.set(n, f); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', body)(
  ctx, harness, console, s => Buffer.from(s, 'binary').toString('base64'), s => Buffer.from(s, 'base64').toString('binary'), TextEncoder, TextDecoder).apply(ctx)
const H = n => handlers.get(n)

console.log('== 插件改名后，配置文件也跟着改名 ==')
const first = await H('git/config')({})
console.log('  路径:', first.path)
console.log('  是 dsh-git-idea.json:', String(first.path).indexOf('/dsh-git-idea.json') === 0 ? 'no' : first.path.endsWith('/dsh-git-idea.json'))
console.log('  不再叫 gitops.json:', first.path.indexOf('gitops.json') < 0)
console.log('  默认值:', JSON.stringify(first.config))

const IDENT_DIR = '/tmp/gp34d-home/.dsh'
const CONFIG_FILE = IDENT_DIR + '/dsh-git-idea.json'
const saved = await H('git/config-save')({ config: { initBranch: 'develop', cherryPickRecord: true } })
console.log('  保存:', saved.ok, JSON.stringify(saved.config))
console.log('  落在磁盘上的:', CONFIG_FILE, JSON.stringify(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/\s+/g, ' ')))
const again = await H('git/config')({})
console.log('  再读一致:', JSON.stringify(again.config) === JSON.stringify(saved.config))
const guards0 = []
const check0 = (label, value) => {
  if (value !== true) guards0.push(label)
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}
/* 真机上这条曾经安静地什么也没写：文件服务按工作区发策略，而这份文件在任何工作区之外，
   于是写被拒、屏幕上也没有一句话。现在它走 shell，而且断言看的是磁盘上的字节。 */
check0('保存之后磁盘上确实有这份文件（不是只活在内存里）',
  fs.existsSync(CONFIG_FILE) && fs.readFileSync(CONFIG_FILE, 'utf8').indexOf('"initBranch": "develop"') >= 0)
check0('而且没有 fs 服务也能读回来（骨架里只给了 shell）',
  JSON.stringify(again.config) === JSON.stringify(saved.config))
if (guards0.length > 0) process.exit(1)

console.log('')
console.log('== 脏输入仍然被清洗 ==')
for (const [label, raw] of [['null', null], ['字符串', 'x'], ['类型错', { initBranch: 42, cherryPickRecord: 'yes' }]]) {
  const out = await H('git/config-save')({ config: raw })
  console.log('  ' + label.padEnd(8), JSON.stringify(out.config))
}

/* ── 机器上的东西：哪个 git、谁提交 ──

   这一半读写的不是插件自己的配置文件，而是 git 的：`gitPath` 是设置，身份是 git 的
   全局 / 仓库配置。所以这个 fixture 把自己藏起来 —— HOME 和 GIT_CONFIG_GLOBAL 都指到
   /tmp 下面，于是 `git config --global` 写的是这里，而不是跑测试的那个人的 ~/.gitconfig。
   一个字节都不许碰到他自己的配置。 */
const IDENT_HOME = '/tmp/gp34d-home'
const IDENT_GLOBAL = IDENT_HOME + '/.gitconfig'
function sh(cmd, cwd) {
  return new Promise((res) => {
    const c = spawn('sh', ['-c', cmd], {
      cwd: cwd,
      env: Object.assign({}, process.env, {
        /* DSH_HOME 也要压住：它从环境里继承下来，比 HOME 优先 —— 只改 HOME 的话，
           这个套件写的仍然是跑测试那个人的真配置文件。 */
        DSH_HOME: IDENT_HOME + '/.dsh',
        HOME: IDENT_HOME, GIT_CONFIG_GLOBAL: IDENT_GLOBAL, GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      }),
    })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('close', x => res({ code: x, out: o, err: e }))
  })
}
await sh('rm -rf ' + IDENT_HOME + ' /tmp/gp34d-ident /tmp/gp34d-ident2 && mkdir -p ' + IDENT_HOME + ' /tmp/gp34d-ident /tmp/gp34d-ident2')
/* 「没配 user.* → git 拒绝签名」在这两块 fixture 里要**确定性**成立：裸机器上 git
   会用 /etc/passwd 的 gecos + hostname 自己猜一个身份，`git var GIT_AUTHOR_IDENT`
   于是照样成功（换一台机器这个套件就从绿变红）。user.useConfigOnly=true 把「猜」
   关掉 —— 没配就是缺，配了就签得出来，跟跑测试的机器是谁无关。 */
await sh('git init -q -b main . && git config user.useConfigOnly true && echo a > a.txt && git add -A', '/tmp/gp34d-ident')
await sh('git init -q -b main . && git config user.useConfigOnly true && echo b > b.txt && git add -A', '/tmp/gp34d-ident2')
const realGit = (await sh('command -v git')).out.trim()
const guards = []
const check = (label, value) => {
  if (value !== true) guards.push(label)
  console.log('  ' + (value ? '✓' : '✗') + ' ' + label)
}

console.log('')
console.log('== 哪个 git：设置里的路径真的被用了 ==')
const tool0 = await H('git/toolchain')({})
console.log('  默认:', JSON.stringify({ path: tool0.path, version: tool0.version, fromPath: tool0.fromPath, found: tool0.found }))
check('默认读的是 PATH 上的那一个，而且报出版本', tool0.found === true && tool0.fromPath === true && tool0.path === realGit && tool0.version.indexOf('git version') === 0)
const panelBefore = await H('git/panel')({ repo: '/tmp/gp34d-ident' })
check('（对照）默认这一读是好的', panelBefore.ok === true && panelBefore.branch === 'main')

const savedPath = await H('git/config-save')({ config: { gitPath: realGit } })
check('设置里写进一个绝对路径', savedPath.ok === true && savedPath.config.gitPath === realGit)
const tool1 = await H('git/toolchain')({})
check('它成了「用的就是它」，而不是「来自 PATH」', tool1.path === realGit && tool1.fromPath === false && tool1.found === true)
const panelAfter = await H('git/panel')({ repo: '/tmp/gp34d-ident' })
check('面板读照常（换的是命令词，不是行为）', panelAfter.ok === true && panelAfter.branch === 'main')

const badPath = await H('git/config-save')({ config: { gitPath: '/nonexistent/bin/git' } })
check('写一个不存在的路径：设置收下，但检查时说得清是「写的那个不可用」',
  badPath.ok === true && (await H('git/toolchain')({})).found === false
  && (await H('git/toolchain')({})).reason === 'configured-missing')
const panelBad = await H('git/panel')({ repo: '/tmp/gp34d-ident' })
check('这时候面板读说的是「这台机器上没有 git」，而不是「这不是仓库」',
  panelBad.ok !== true && panelBad.reason === 'no-git')
/* 缓存也得作废：上面这两次读的是**同一棵树**（同一个缓存键），所以这一对断言正是
   在说「答案跟着二进制走，而不是跟着上一次那个二进制的缓存走」。 */
const backToGood = await H('git/config-save')({ config: { gitPath: realGit } })
const afterFix = await H('git/panel')({ repo: '/tmp/gp34d-ident' })
check('把路径改回来，同一棵树立刻又读得动了（改 git 会作废缓存）',
  backToGood.ok === true && afterFix.ok === true)
await H('git/config-save')({ config: { gitPath: '' } })

console.log('')
console.log('== 脏路径会被清洗（它要贴在每一条命令前面）==')
for (const [label, raw] of [['换行', '/usr/bin/git\nrm -rf /'], ['前导减号', '-c'], ['制表符', '/usr/bin/\tgit']]) {
  const out = await H('git/config-save')({ config: { gitPath: raw } })
  console.log('  ' + label.padEnd(8), JSON.stringify(out.config.gitPath))
  check('  ' + label + ' 被丢掉（回到默认）', out.config.gitPath === '')
}
const spaced = await H('git/config-save')({ config: { gitPath: '/opt/my git/bin/git' } })
check('带空格的路径留下（引号管得住空格）', spaced.config.gitPath === '/opt/my git/bin/git')
await H('git/config-save')({ config: { gitPath: '' } })

console.log('')
console.log('== 提交身份：读、写、以及不许写的东西 ==')
const empty = await H('git/identity')({ repo: '/tmp/gp34d-ident' })
console.log('  没配时:', JSON.stringify({ needs: empty.needsIdentity, nameMissing: empty.nameMissing, emailMissing: empty.emailMissing, repo: empty.repo }))
check('没配时读出来就是「缺」，而且分得清缺的是名字还是邮箱',
  empty.ok === true && empty.needsIdentity === true && empty.nameMissing === true && empty.emailMissing === true)

const globalWrite = await H('git/identity-save')({ scope: 'global', name: 'Ada Lovelace', email: 'ada@example.com' })
console.log('  写全局:', JSON.stringify({ ok: globalWrite.ok, written: globalWrite.written, name: globalWrite.name, origin: globalWrite.nameOrigin }))
check('写全局：名字和邮箱都写进去了，读回来就是它们',
  globalWrite.ok === true && globalWrite.written.length === 2 && globalWrite.name === 'Ada Lovelace' && globalWrite.email === 'ada@example.com')
check('落点确实是 git 的全局配置文件（不是这个仓库）',
  globalWrite.nameOrigin.indexOf('.gitconfig') >= 0 && fs.readFileSync(IDENT_GLOBAL, 'utf8').indexOf('Ada Lovelace') >= 0)
check('这个仓库的 .git/config 里没有它', (await sh('git config --local --get user.name', '/tmp/gp34d-ident')).out.trim() === '')
const otherRepo = await H('git/identity')({ repo: '/tmp/gp34d-ident2' })
check('另一个仓库也认这份身份（写的是机器级的）', otherRepo.needsIdentity === false && otherRepo.name === 'Ada Lovelace' && otherRepo.nameOrigin.indexOf('.gitconfig') >= 0)

/* 不知道是哪个仓库时：只回答机器级那一份，绝不用「当前目录」的那一份 —— 跑测试的
   目录恰好是个有身份的仓库（插件自己那个），而 `git config` 会从它那儿答出一个不是
   读者的名字。这一条就是被这个 fixture 抓出来的那个 bug。 */
const nowhere = await H('git/identity')({})
console.log('  不知道仓库时:', JSON.stringify({ inside: nowhere.insideRepo, name: nowhere.name, origin: nowhere.nameOrigin }))
check('不知道仓库时不冒充「此刻生效」：名字只能来自那份全局配置',
  nowhere.ok === true && nowhere.insideRepo === false && nowhere.repo === null
  && nowhere.name === 'Ada Lovelace' && nowhere.nameOrigin.indexOf('.gitconfig') >= 0
  && nowhere.needsIdentity === false)

const localWrite = await H('git/identity-save')({ scope: 'local', repo: '/tmp/gp34d-ident', name: 'Repo Only', email: '' })
console.log('  写本地:', JSON.stringify({ ok: localWrite.ok, written: localWrite.written, name: localWrite.name, origin: localWrite.nameOrigin }))
check('写本地：只动了这一个仓库，而且空的邮箱一个字节都没写',
  localWrite.ok === true && localWrite.written.length === 1 && localWrite.written[0] === 'user.name'
  && (await sh('git config --local --get user.name', '/tmp/gp34d-ident')).out.trim() === 'Repo Only'
  && (await sh('git config --local --get user.email', '/tmp/gp34d-ident')).code !== 0)
check('这个仓库现在报的是本地那一份，来源指得出是哪个文件',
  (await H('git/identity')({ repo: '/tmp/gp34d-ident' })).nameOrigin === '.git/config')
check('别的仓库不受影响（还是全局那份）',
  (await H('git/identity')({ repo: '/tmp/gp34d-ident2' })).name === 'Ada Lovelace')

const before = fs.readFileSync(IDENT_GLOBAL, 'utf8')
check('两个都空 → 什么都不写，并说清为什么',
  (await H('git/identity-save')({ scope: 'global', name: '  ', email: '' })).ok !== true
  && fs.readFileSync(IDENT_GLOBAL, 'utf8') === before)
check('控制字符被拒（一个换行能把命令切成两半）',
  (await H('git/identity-save')({ scope: 'global', name: 'a\nb' })).ok !== true
  && fs.readFileSync(IDENT_GLOBAL, 'utf8') === before)
check('以 - 开头的值被拒（git 会把它当选项）',
  (await H('git/identity-save')({ scope: 'global', name: '-x' })).ok !== true
  && fs.readFileSync(IDENT_GLOBAL, 'utf8') === before)
check('要写本地却不知道是哪个仓库 → 直说，而不是猜一个',
  (await H('git/identity-save')({ scope: 'local', name: 'x' })).ok !== true)

/* 提交本身：写完之后这台机器就签得出名了。 */
const committed = await H('git/commit')({ repo: '/tmp/gp34d-ident', message: 'first', stageAll: true })
const logLine = (await sh("git log -1 --format='%an <%ae>'", '/tmp/gp34d-ident')).out.trim()
console.log('  提交一次:', JSON.stringify({ ok: committed.ok, author: logLine }))
check('配好身份之后提交成功，作者就是刚写进去的那个名字', committed.ok === true && logLine === 'Repo Only <ada@example.com>')
check('而且这次答复里没有身份这个标志', committed.needsIdentity === undefined)

console.log('')
console.log('== 提交信息草稿：按生效仓库存进这份配置 ==')

/* 两条 RPC 先钉在源码上（body 就是 host.js 的全文），行为断言在后面。 */
check('git/draft-read 与 git/draft-save 都在 Host 的 RPC 表里',
  body.indexOf("onRpc('git/draft-read'") >= 0 && body.indexOf("onRpc('git/draft-save'") >= 0)

/* drafts 与 repos、quickCommands 同住这份 json（70-config.js）。归一化从 git/config-save
   那扇门走：它是整份配置的最后一道关卡，设置页整份保存带进来的、别的版本写进来的
   drafts，都要在这里过一遍筛。 */
check('归一化：非对象的 drafts 清成空表（配置里这个键永远在）',
  (await H('git/config-save')({ config: { drafts: '不是表' } })).ok === true
  && Object.keys((await H('git/config')({})).config.drafts).length === 0)
check('归一化：数组也不收（草稿按仓库路径分键，数组没有键）',
  Object.keys((await H('git/config-save')({ config: { drafts: ['a'] } })).config.drafts).length === 0)

const dirty = await H('git/config-save')({
  config: {
    initBranch: 'develop',
    repos: { '/tmp/gp34d-ws': ['/tmp/gp34d-ident'] },
    drafts: {
      '/tmp/gp34d-ident': '写到一半的那条',
      'relative/path': '不是绝对路径',
      '/tmp/gp34d-ident2': 42,
      '/tmp/gp34d-empty': '   ',
      '/tmp/gp34d-long': 'x'.repeat(5000),
    },
  },
})
check('归一化：非法键（相对路径、非字符串值）与只剩空白的条目丢掉，合法的留着',
  dirty.ok === true && Object.keys(dirty.config.drafts).length === 2
  && dirty.config.drafts['/tmp/gp34d-ident'] === '写到一半的那条')
check('归一化：超长的截到 4000（同一个键原样保留）',
  dirty.config.drafts['/tmp/gp34d-long'] === 'x'.repeat(4000))

check('draft-read 把存进去的那条原样读回来',
  (await H('git/draft-read')({ repo: '/tmp/gp34d-ident' })).message === '写到一半的那条')
check('没有草稿的仓库答 ok 与空串（空 = 无草稿，不是错误）',
  (await H('git/draft-read')({ repo: '/tmp/gp34d-nowhere' })).ok === true
  && (await H('git/draft-read')({ repo: '/tmp/gp34d-nowhere' })).message === '')
check('路径不像话的读也安静：ok 与空串，绝不报错',
  (await H('git/draft-read')({ repo: 'relative/path' })).ok === true
  && (await H('git/draft-read')({ repo: '' })).message === ''
  && (await H('git/draft-read')({ repo: 42 })).message === ''
  && (await H('git/draft-read')(null)).message === '')

const saved3 = await H('git/draft-save')({ repo: '/tmp/gp34d-ident3', message: '新的一条' })
const afterSave = await H('git/config')({})
check('draft-save 存进一个新仓库：答复 ok，配置里几仓几份互不干扰',
  saved3.ok === true
  && afterSave.config.drafts['/tmp/gp34d-ident'] === '写到一半的那条'
  && afterSave.config.drafts['/tmp/gp34d-long'].length === 4000
  && afterSave.config.drafts['/tmp/gp34d-ident3'] === '新的一条')
check('draft-save 只动 drafts：initBranch 与 repos 原样跟着写回（磁盘上也是）',
  afterSave.config.initBranch === 'develop'
  && JSON.stringify(afterSave.config.repos) === JSON.stringify({ '/tmp/gp34d-ws': ['/tmp/gp34d-ident'] })
  && JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).initBranch === 'develop')

const bytesBefore = fs.readFileSync(CONFIG_FILE, 'utf8')
const same = await H('git/draft-save')({ repo: '/tmp/gp34d-ident3', message: '新的一条' })
check('同值再存一次：答复 unchanged，盘上一个字节没动（防抖的重复保存不写盘）',
  same.ok === true && same.unchanged === true
  && fs.readFileSync(CONFIG_FILE, 'utf8') === bytesBefore)
check('存一条只剩空白的信息 = 删掉这份草稿（「空」也是一条信息）',
  (await H('git/draft-save')({ repo: '/tmp/gp34d-ident3', message: '   ' })).ok === true
  && (await H('git/config')({})).config.drafts['/tmp/gp34d-ident3'] === undefined)
check('repo 不像话的存被拒（相对路径、空串都不行，宁可拒绝也不猜）',
  (await H('git/draft-save')({ repo: 'relative/path', message: 'x' })).ok === false
  && (await H('git/draft-save')({ repo: '', message: 'x' })).ok === false)

const many = {}
for (let i = 0; i < 70; i += 1) many['/tmp/gp34d-d' + i] = '第' + i + '条'
const capped = await H('git/config-save')({ config: { drafts: many } })
check('草稿按仓库封顶：70 个只留 64 个（键序在前面的留下）',
  capped.ok === true && Object.keys(capped.config.drafts).length === 64)
check('封顶之后新仓库的草稿存不进（直说，而不是悄悄挤掉谁）',
  (await H('git/draft-save')({ repo: '/tmp/gp34d-new', message: '挤不进来的' })).ok === false)
check('封顶之内更新已有的那一份照常',
  (await H('git/draft-save')({ repo: '/tmp/gp34d-d0', message: '更新的第0条' })).ok === true
  && (await H('git/draft-read')({ repo: '/tmp/gp34d-d0' })).message === '更新的第0条')

/* 回到小份配置，下面的并发与写盘失败都在它身上试。 */
await H('git/config-save')({ config: { drafts: { '/tmp/gp34d-ident': '并发前的那条' } } })
const both = await Promise.all([
  H('git/draft-save')({ repo: '/tmp/gp34d-ident', message: '并发甲' }),
  H('git/draft-save')({ repo: '/tmp/gp34d-ident2', message: '并发乙' }),
])
check('并发两次保存：两次都答复 ok，谁也没把谁撞炸',
  both[0].ok === true && both[1].ok === true)
check('并发之后这份文件仍是合法 JSON，Host 照常答草稿',
  JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).drafts !== undefined
  && (await H('git/draft-read')({ repo: '/tmp/gp34d-ident' })).ok === true)

/* 写盘失败：把配置目录顶成一个同名文件，mkdir -p 那一步就会失败 —— 答复要说得出
   为什么，进程要活着，目录恢复之后同一条路要照常工作。 */
await sh('rm -rf ' + IDENT_DIR + ' && touch ' + IDENT_DIR)
const broken = await H('git/draft-save')({ repo: '/tmp/gp34d-ident', message: '写不进去的一条' })
check('写盘失败：答复 ok:false 带一句原因，而不是把异常抛到天上',
  broken.ok === false && typeof broken.error === 'string' && broken.error.length > 0)
await sh('rm -f ' + IDENT_DIR + ' && mkdir -p ' + IDENT_DIR)
const healed = await H('git/draft-save')({ repo: '/tmp/gp34d-ident', message: '恢复之后的一条' })
check('目录恢复之后同一条路照常工作（进程没被那次失败带坏）',
  healed.ok === true
  && (await H('git/draft-read')({ repo: '/tmp/gp34d-ident' })).message === '恢复之后的一条')

console.log('')
if (guards.length > 0) {
  console.log('✗ ' + guards.length + ' 条不符合预期')
  process.exit(1)
}
console.log('（gp34d 全部通过）')
