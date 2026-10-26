/* ── the real-package Client half ──

   A classic script, because that is what \`dsh-client-modules\` evaluates: a
   \`__ModuleLoader__\` bundle, no import/export. The fragments under src/client/
   were written for the dynamic bridge, which gave the browser realm \`React\` as
   a closure symbol and \`host.call(method, payload)\` as its one door to the
   Host. This prelude binds React from the module table and implements that same
   door over the route host-pre.js mounts — one body, two builds. */
window.__ModuleLoader__.load({
  id: 'dsh-git-idea',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    /* 与宿主半同一个前缀（host-pre.js 的 API_BASE）：顶层自造路径会被某些代理链
       改写，/api/<名>/… 的形状与 dsh 其它插件同款，实测在同一条链上是通的。 */
    const API_BASE = '/api/dsh-git-idea'
    const RPC_PATH = API_BASE + '/rpc'

    /* A method name and a JSON payload in, the handler's JSON answer out. The
       Host answers 404 for a method it has not registered yet, which is the
       exact case 10-state.js retries — so the message has to keep saying
       "is not registered". */
    const host = {
      call: function (method, payload) {
        return fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: method, payload: payload === undefined ? null : payload }),
        }).then(function (response) {
          return response.text().then(function (text) {
            let data = null
            try {
              data = text.length > 0 ? JSON.parse(text) : null
            } catch (error) {
              data = null
            }
            if (response.status === 404) throw new Error(method + ' is not registered')
            if (data === null || data.ok !== true) {
              const message = data !== null && typeof data.error === 'string'
                ? data.error
                : 'host.call failed with HTTP ' + String(response.status)
              throw new Error(message)
            }
            return data.value
          })
        })
      },
    }

    /* ── host→client 的实时通道（liveBus）──

       RPC 是一问一答，host 没法主动找浏览器 —— 面板执行的命令开始/结束就只能在下一轮
       整读才上屏。这里用浏览器原生 WebSocket 连真包 Host 半挂的 /api/dsh-git-idea/ws
       （与 dsh 其它插件同款的 /api/<名>/ 前缀：顶层自造路径会被某些代理链改写，这条
       形状实测是通的），把推来的消息分发给订阅者。连接前每轮先 GET /api/dsh-git-idea/
       ws-info 拿一次性 token（{cache:'no-store'}，每轮重拉：dsh 重启后插件实例重建、
       token 换新，拿旧 token 握手只会被宿主直接断开），拉失败按原有退避重试；socket
       建起来之前的失败也走同一条退避账（retry）。WS_CID 是本标签页加载时随机一次的
       标识，只进宿主握手日志，不参与鉴权。刻意做成一个闭包单例：面板会重挂、会话会
       切换，连接却只有这一条。指数退避重连（1s 起步、封顶 30s，连上就归零），页面
       重新可见/网络恢复时若已断开则立刻试一次 —— 宿主睡眠醒来不该等满一个退避周期。

       bridge 版的 client.js 没有 pkg 前奏，也就没有 liveBus —— 面板片段里的 typeof
       守卫会让它们安静退化成「无推送、照常轮询」，这是预期（bridge 的 Host 半本来
       就没有 WS 路由）。 */
    const WS_CID = (function () {
      let raw = ''
      try {
        if (typeof crypto !== 'undefined' && crypto != null && typeof crypto.randomUUID === 'function') {
          raw = crypto.randomUUID()
        }
      } catch (error) {
        /* randomUUID 偶发不可用（非安全上下文等实现限制）属预期降级：记一条后走
           Math.random 拼接，不让 cid 挡住连接。 */
        raw = ''
      }
      if (raw.length === 0) {
        raw = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
          + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2)
      }
      const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
      return cleaned.length > 0 ? cleaned : 'tab'
    })()

    const liveBus = {
      socket: null,
      wait: 1000,
      closed: false,
      connecting: false,
      listeners: new Set(),
      timer: null,
      /* socket 建起来之前的失败（ws-info 拉不到、WebSocket 建不起来）从这里走同一套
         退避账；onclose 保留自己那段同账的老逻辑（同一套守卫：同一时刻只排一个
         定时器，open 的单例判重兜住重复连接），两路排不出两个定时器。 */
      retry: function () {
        if (liveBus.closed === true || liveBus.socket !== null) return
        if (liveBus.timer !== null) return
        liveBus.timer = setTimeout(function () {
          liveBus.timer = null
          liveBus.open()
        }, liveBus.wait)
        liveBus.wait = Math.min(liveBus.wait * 2, 30000)
      },
      open: function () {
        if (liveBus.closed === true || liveBus.socket !== null || liveBus.connecting === true) return
        if (typeof WebSocket !== 'function') return
        liveBus.connecting = true
        fetch(API_BASE + '/ws-info', { cache: 'no-store' }).then(function (response) {
          if (response.ok !== true) throw new Error('ws-info answered HTTP ' + String(response.status))
          return response.json()
        }).then(function (info) {
          if (info == null || info.ok !== true || typeof info.token !== 'string' || info.token.length === 0) {
            throw new Error('ws-info answered without a token')
          }
          liveBus.connecting = false
          if (liveBus.closed === true || liveBus.socket !== null) return
          let ws = null
          try {
            ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '//'
              + location.host + API_BASE + '/ws?token=' + encodeURIComponent(info.token)
              + '&cid=' + encodeURIComponent(WS_CID))
          } catch (error) {
            console.error('dsh-git-idea: live 连接建不起来（继续用轮询）', String(error))
            liveBus.retry()
            return
          }
          liveBus.socket = ws
          ws.onopen = function () {
          liveBus.wait = 1000
          /* （重）连上 = 断线期间宿主推的消息丢过一批，订阅方需要补一轮核对 ——
             向 listeners 分发一条 live-open，谁听谁自己决定补什么（98-register.js
             补欠账 + 对签名）。首连也会收到这一条：欠账本来就是空的，签名第一拍
             只记基线，无害。与 onmessage 同一款逐订阅者 try/catch：一个订阅者的错
             不打断其余订阅者。 */
          liveBus.listeners.forEach(function (listener) {
            try {
              listener({ kind: 'live-open' })
            } catch (error) {
              console.error('dsh-git-idea: live 订阅者处理消息出错', String(error))
            }
          })
        }
        ws.onmessage = function (event) {
          let data = null
          try {
            data = JSON.parse(event.data)
          } catch (error) {
            console.error('dsh-git-idea: live 消息不是 JSON，丢弃', String(error))
            return
          }
          if (data == null || typeof data !== 'object') return
          liveBus.listeners.forEach(function (listener) {
            try {
              listener(data)
            } catch (error) {
              /* 一个订阅者的错不该打断其余订阅者 —— 记日志，继续分发。 */
              console.error('dsh-git-idea: live 订阅者处理消息出错', String(error))
            }
          })
        }
        ws.onclose = function () {
          if (liveBus.socket !== ws) return
          liveBus.socket = null
          if (liveBus.closed === true) return
          /* 指数退避重连；同一时刻只排一个定时器，open 的单例判重兜住重复连接。 */
          if (liveBus.timer !== null) return
          liveBus.timer = setTimeout(function () {
            liveBus.timer = null
            liveBus.open()
          }, liveBus.wait)
          liveBus.wait = Math.min(liveBus.wait * 2, 30000)
        }
        ws.onerror = function () {
          /* onerror 之后浏览器必发 onclose，重连交给那边。 */
        }
          }).catch(function (error) {
            /* ws-info 拉不到（宿主不在、围栏拦下、答得不像话）与 token 异形同账：
               清掉 connecting 这道闸、console.error、走同一条退避重试 —— 少了这道
               catch，rejected promise 无人接，connecting 永远卡在 true，open 的
               单例判重从此把 liveBus 永久关在门外。 */
            liveBus.connecting = false
            console.error('dsh-git-idea: live 拿不到接入信息（继续用轮询，稍后重试）', String(error))
            liveBus.retry()
          })
      },
      /* 页面重新可见 / 网络恢复：断着就立刻试一次，并把退避归零（多半是宿主睡了）。 */
      wake: function () {
        if (liveBus.closed === true || liveBus.socket !== null) return
        liveBus.wait = 1000
        if (liveBus.timer !== null) {
          clearTimeout(liveBus.timer)
          liveBus.timer = null
        }
        liveBus.open()
      },
      subscribe: function (listener) {
        liveBus.listeners.add(listener)
        return function () {
          liveBus.listeners.delete(listener)
        }
      },
      close: function () {
        liveBus.closed = true
        if (liveBus.timer !== null) {
          clearTimeout(liveBus.timer)
          liveBus.timer = null
        }
        const ws = liveBus.socket
        liveBus.socket = null
        if (ws != null && typeof ws.close === 'function') ws.close()
        liveBus.listeners.clear()
      },
    }
    if (typeof document !== 'undefined' && document != null && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') liveBus.wake()
      })
    }
    if (typeof window !== 'undefined' && window != null && typeof window.addEventListener === 'function') {
      window.addEventListener('online', function () { liveBus.wake() })
    }

    /* The dynamic bridge's browser realm also handed the fragments a `styles`
       symbol, and 46-css.js is written against it: one `insert(text)` that
       appends a <style> element and returns the remover that `ctx.effect`
       disposes with. The real client realm has no such symbol —
       `dsh-client-modules` instead claims whatever <style> a factory injected
       and tags it for HMR — so the prelude supplies the same one over the same
       DOM. */
    const styles = {
      insert: function (text) {
        const element = document.createElement('style')
        element.textContent = text
        document.head.appendChild(element)
        return function () {
          if (element.parentNode !== null) element.parentNode.removeChild(element)
        }
      },
    }

    const plugin = (function () {
