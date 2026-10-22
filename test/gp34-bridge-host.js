return {
  apply(ctx) {
    /* ── the source bridge, not the plugin itself ──

       The real Host half sits in a file beside the deployment's own settings
       (<DSH_HOME>/dsh-git-idea/dist/host.js) and is evaluated here. A dynamic
       Package is immutable, so every change means submitting the whole thing
       again through the model — and this plugin is far past the size where that
       is a copy rather than a regeneration. The deployment already has a
       mechanism for a plugin that lives in files: a real package ships its Host
       half as dist/lib/ and its Client half as dist/client/client.js. This bridge is that
       layout, loaded by hand, until the plugin moves into a profile bundle.

       Everything the evaluated source registers — tools, RPC handlers, effects
       — belongs to this fiber, so stop, update and undefine still remove all of
       it. Re-running this Package re-reads the file, which is how a change to
       the source is picked up.

       Two things here are not about reading files. The Client half is only handed
       over once the Host half is in: both halves start together and the Client's
       first render asks for git/panel straight away, so a reply that arrived
       first produced a panel whose every request was refused. And the load is
       logged next to the source, because a failure here used to be one line in a
       console nobody reads. */

    const shell = ctx.get('shell')
    const fsService = ctx.get('fs')

    function detail(error) {
      return error != null && error.message !== undefined ? String(error.message) : String(error)
    }

    function quote(value) {
      return "'" + String(value).replace(/'/g, "'\\''") + "'"
    }

    async function probe(command) {
      if (shell === undefined) return null
      return await shell.run(shell.resolve({ command: command, timeoutMs: 20000, stdoutMaxBytes: 8388608 }))
    }

    async function probeText(command) {
      const raw = await probe(command)
      if (raw == null || raw.exitCode !== 0 || raw.stdout == null) return ''
      return typeof raw.stdout.text === 'string' ? raw.stdout.text : ''
    }

    let dirCache = null
    async function sourceDir() {
      if (dirCache !== null) return dirCache
      const home = (await probeText('printf %s "${DSH_HOME:-$HOME/.dsh}"')).trim()
      if (home.length === 0) throw new Error('neither DSH_HOME nor $HOME could be read')
      dirCache = home + '/dsh-git-idea'
      return dirCache
    }

    let logPath = ''
    async function log(line) {
      console.log('dsh-git-idea bridge: ' + line)
      try {
        if (logPath.length === 0) logPath = (await sourceDir()) + '/bridge.log'
        await probe('printf %s ' + quote('[' + new Date().toISOString() + '] ' + line + '\n') + ' >> ' + quote(logPath))
      } catch (error) {
        /* a diagnostic that fails must not become the failure */
      }
    }

    async function readOne(path) {
      if (fsService !== undefined) {
        try {
          const target = await fsService.resolve(path)
          const text = await fsService.readText(target)
          if (typeof text === 'string' && text.length > 0) return text
        } catch (error) {
          /* fall through to the shell reader below */
        }
      }
      return await probeText('cat ' + quote(path))
    }

    async function readSource(name) {
      const dir = await sourceDir()
      const text = await readOne(dir + '/dist/' + name)
      if (text.length === 0) throw new Error('cannot read ' + dir + '/dist/' + name)
      return text
    }

    function wait(ms) {
      return new Promise(function (resolve) {
        const timer = ctx.get('timer')
        if (timer === undefined) { resolve(); return }
        timer.timeout(function () { resolve() }, ms)
      })
    }

    async function loadOnce() {
      const source = await readSource('host.js')
      const factory = new Function('ctx', 'harness', 'console', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', source)
      const plugin = factory(ctx, harness, console, btoa, atob, TextEncoder, TextDecoder)
      if (plugin == null || typeof plugin.apply !== 'function') throw new Error('the Host source did not return a plugin')
      plugin.apply(ctx)
      return source.length
    }

    /* A shell read can fail once for reasons that have nothing to do with the
       file, and until it succeeds the plugin has no Host half at all, so it is
       tried a few times before the failure is believed. The memo is dropped on
       the way out, so the next request tries again instead of replaying the same
       rejection forever. */
    let hostLoad = null
    function loadHost() {
      if (hostLoad === null) {
        hostLoad = (async function () {
          let last = null
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              const written = await loadOnce()
              await log('host half applied (' + String(written) + ' chars)')
              return written
            } catch (error) {
              last = error
              await log('host half attempt ' + String(attempt) + ' failed: ' + detail(error))
              if (attempt < 3) await wait(300)
            }
          }
          throw last
        })()
        hostLoad.catch(function (error) {
          hostLoad = null
          log('host half gave up: ' + detail(error))
        })
      }
      return hostLoad
    }

    /* The Client half is fetched from here, because the Client realm has no
       filesystem of its own — and only after the Host half is in, because the
       first thing the Client does with it is call git/panel. A Host that failed
       to load is not made any worse by a Client that never appears, so the source
       is handed over anyway; the Client retries those refused calls itself. */
    ctx.effect(function () {
      return harness.handle('dsh-git-idea/source', async function (input) {
        try {
          await loadHost()
        } catch (error) {
          await log('handing over the client source with no host half: ' + detail(error))
        }
        const name = input != null && input.half === 'client' ? 'client.js' : 'host.js'
        const source = await readSource(name)
        return { ok: true, half: name, source: source }
      })
    }, 'dsh-git-idea bridge source rpc')

    ctx.effect(function () {
      /* Started here rather than behind an await: the two halves are dispatched
         together, and this one has real work to do before the other can run. */
      loadHost().catch(function () {})
      return function () {}
    }, 'dsh-git-idea bridge host')
  },
}
