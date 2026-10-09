
    ctx.effect(function () {
      return slots.inject('conversation.input.left', function () {
        return slots.register({ name: 'conversation.input.left', id: 'dsh-git-idea-chip', order: 10 }, GitChip)
      })
    }, 'dsh-git-idea composer chip')

    ctx.effect(function () {
      return slots.inject('conversation.input.overlay', function () {
        return slots.register({ name: 'conversation.input.overlay', id: 'dsh-git-idea-panel', order: 10 }, GitPopover)
      })
    }, 'dsh-git-idea composer panel')

    /* A page of its own in Settings, between Agent presets (20) and Market (40). */
    ctx.effect(function () {
      return slots.inject('settings.section', function () {
        return slots.register({ name: 'settings.section', id: 'dsh-git-idea', order: 30, label: SETTINGS_NAV_LABEL }, GitSettingsSection)
      })
    }, 'dsh-git-idea settings section')

    /* host→client 的实时通道（真包的 client-pre.js 提供 liveBus）：插件活着连接就活着，
       插件卸载连接断开。bridge 版没有 liveBus（也没有 WS 路由可连），typeof 守卫让它
       安静跳过 —— 面板的一切照旧走轮询。 */
    ctx.effect(function () {
      if (typeof liveBus !== 'undefined' && liveBus != null && typeof liveBus.open === 'function') liveBus.open()
      return function () {
        if (typeof liveBus !== 'undefined' && liveBus != null && typeof liveBus.close === 'function') liveBus.close()
      }
    }, 'dsh-git-idea live connection')
  },
}
