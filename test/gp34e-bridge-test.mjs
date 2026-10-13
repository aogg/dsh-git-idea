import fs from 'node:fs'
import { spawn } from 'node:child_process'
/* 桥找的是真机 $DSH_HOME（缺省 $HOME/.dsh）下已安装的那份插件；没有这份安装的环境
   （构建容器）里 host 半边必然起不来。那是环境缺失，不是回归 —— 明说跳过并 exit 0，
   不把红色留给一个套件本来就无法成立的地方。真机上安装在，下面原样全跑。 */
const dshHome = process.env.DSH_HOME || (process.env.HOME || '') + '/.dsh'
const installedAt = dshHome + '/dsh-git-idea'
if (!fs.existsSync(installedAt + '/host.js') || !fs.existsSync(installedAt + '/client.js')) {
  console.log('SKIP: ' + installedAt + ' 没有已安装的插件（host.js/client.js）—— 桥套件只对真机安装成立')
  process.exit(0)
}
const bridge = fs.readFileSync(new URL('./gp34-bridge-host.js', import.meta.url).pathname, 'utf8')
function runShell(spec) {
  return new Promise((res) => {
    /* DSH_HOME 不在这里改：桥就是靠它去找插件源码的。这个套件读的配置因此是真机上那份，
       但它只断言 git/branches 这一条读，不受插件设置影响。 */
    const c = spawn('sh', ['-c', spec.command], { cwd: spec.workdir, env: process.env })
    let o = '', e = ''
    c.stdout.on('data', b => o += b); c.stderr.on('data', b => e += b)
    c.on('close', x => res({ exitCode: x, stdout: { text: o }, stderr: { text: e } }))
  })
}
const handlers = new Map(); const tools = []; const logs = []
const ctx = { get: n => (n === 'shell' ? { resolve: r => r, run: runShell } : undefined), effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} } }
const harness = { handle(n, f) { handlers.set(n, f); return () => {} }, defineTool: d => d, registerTool: (c, d) => { tools.push(d.name); return () => {} } }
new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', bridge)(ctx, harness, { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERR ' + a.join(' ')) }, s => s, s => s, TextEncoder, TextDecoder).apply(ctx)
await new Promise(r => setTimeout(r, 1200))
console.log('日志:', JSON.stringify(logs))
console.log('工具:', tools.length, '（应为 0：这个插件不注册工具） RPC:', handlers.size)
const src = await handlers.get('dsh-git-idea/source')({ half: 'client' })
console.log('client 源码长度:', src.source.length, ' 与磁盘一致:', src.source === fs.readFileSync(installedAt + '/client.js', 'utf8'))
const b = await handlers.get('git/branches')({ repo: '/tmp/gp34-repo' })
console.log('git/branches 仍可用:', b.ok, b.branches.length, '个本地分支')
