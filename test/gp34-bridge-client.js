return {
  apply(ctx) {
    /* The Client half of the bridge: the real UI source is fetched from the Host
       bridge and evaluated here. Same reasoning as the Host half — and the same
       end state, where dist/client/client.js is a file the browser loads. */

    const loading = (async function () {
      const reply = await host.call('dsh-git-idea/source', { half: 'client' })
      const source = reply != null && typeof reply.source === 'string' ? reply.source : ''
      if (source.length === 0) throw new Error('the Host bridge returned no Client source')
      const factory = new Function('ctx', 'React', 'host', 'styles', 'console', source)
      const plugin = factory(ctx, React, host, styles, console)
      if (plugin == null || typeof plugin.apply !== 'function') throw new Error('the Client source did not return a plugin')
      plugin.apply(ctx)
      console.log('dsh-git-idea bridge: loaded ' + String(source.length) + ' bytes of Client source')
    })()

    loading.catch(function (error) {
      const detail = error != null && error.message !== undefined ? String(error.message) : String(error)
      console.error('dsh-git-idea bridge: ' + detail)
    })
  },
}
