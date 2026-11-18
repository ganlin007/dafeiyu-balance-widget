// web-server.mjs — 与 @deepseek-ai/dsh-host-webserver 行为等价的 WebServer 服务。
//
// 为什么需要它：原插件（lib/index.js）是标准 DSH bundle 插件，它通过 `ctx.webServer.register()`
// 注册 23 条 /dsh-whale/* 路由，并依赖 `webserver/index-inject` 事件表 + `tapIndex` 往 index.html
// 注入前端挂件脚本。桌面壳只要按同一份契约提供一个 WebServer，插件本体就能一字不改地跑起来。
//
// 契约来源：本机 @deepseek-ai/dsh-host-webserver/lib/types/index.d.ts 与 injections.d.ts。
import http from 'node:http'

/** 把一个结构化注入行渲染成 HTML 片段（对应 renderIndexInjections 的行语义）。 */
function renderRow(row) {
  if (!row || typeof row !== 'object') return ''
  switch (row.kind) {
    case 'global':
      return `<script>globalThis[${JSON.stringify(String(row.name))}]=${JSON.stringify(row.value ?? null)}</script>`
    case 'script':
      return `<script>${String(row.text == null ? '' : row.text)}</script>`
    case 'script-src':
      return `<script src="${String(row.src == null ? '' : row.src)}"></script>`
    case 'script-preload':
      return `<link rel="preload" as="script" href="${String(row.src == null ? '' : row.src)}">`
    case 'style':
      return `<style>${String(row.text == null ? '' : row.text)}</style>`
    case 'html':
      return String(row.html == null ? '' : row.html)
    default:
      return ''
  }
}

/** 按 placement 把行插到 <head> / <body> 开标签之后。 */
export function renderIndexInjections(html, rows) {
  const head = []
  const body = []
  for (const row of rows || []) {
    const frag = renderRow(row)
    if (!frag) continue
    if (row.placement === 'head') head.push(frag)
    else body.push(frag)
  }
  let out = String(html == null ? '' : html)
  if (head.length) {
    const m = /<head[^>]*>/i.exec(out)
    out = m ? out.slice(0, m.index + m[0].length) + head.join('') + out.slice(m.index + m[0].length) : out + head.join('')
  }
  if (body.length) {
    const m = /<body[^>]*>/i.exec(out)
    out = m ? out.slice(0, m.index + m[0].length) + body.join('') + out.slice(m.index + m[0].length) : out + body.join('')
  }
  return out
}

/**
 * 创建 WebServer 服务。
 * @param {{ host?: string, port?: number, emit: (event: string, ...args: any[]) => void }} opts
 *        emit 用于投递 `webserver/index-inject`（收集注入表）。
 */
export function createWebServer({ host = '127.0.0.1', port = 0, emit } = {}) {
  const exact = new Map()
  const prefixes = new Map()
  const upgrades = new Map()
  const overrides = new Map()
  const indexTaps = []
  let fallback = null
  let server = null
  let listenedPort = 0

  function match(pathname) {
    // 宿主级覆写优先：桌面端用它把两个**只读**接口改成读 DSH 已写好的数据
    // （见 src/dsh/dsh-link.mjs 的 display 模式）。插件自身的路由表不受影响。
    const over = overrides.get(pathname)
    if (over) return over
    const hit = exact.get(pathname)
    if (hit) return hit
    let best = null
    let bestLen = -1
    for (const [prefix, handler] of prefixes) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        if (prefix.length > bestLen) { best = handler; bestLen = prefix.length }
      }
    }
    return best
  }

  /** 收集结构化注入表：一次 emit，订阅者各自 push 当前行。 */
  function collectIndexInjections() {
    const table = []
    try { if (typeof emit === 'function') emit('webserver/index-inject', table) } catch (err) {}
    return table
  }

  function applyIndexTaps(html) {
    let out = String(html == null ? '' : html)
    for (const tap of indexTaps) {
      try { out = tap(out) } catch (err) {}
    }
    return out
  }

  /** 渲染 index.html：先结构化行，再原始 tap 变换（与 DSH 顺序一致）。 */
  function renderIndex(html) {
    return applyIndexTaps(renderIndexInjections(html, collectIndexInjections()))
  }

  const service = {
    get port() { return listenedPort },
    host,

    register(route) {
      if (!route || typeof route !== 'object') throw new Error('register: route required')
      const kind = route.kind
      const p = String(route.path || '')
      if (kind !== 'exact' && kind !== 'prefix') throw new Error(`register: bad kind ${String(kind)}`)
      if (!p.startsWith('/')) throw new Error(`register: path must be absolute: ${p}`)
      if (typeof route.handler !== 'function') throw new Error('register: handler required')
      const table = kind === 'exact' ? exact : prefixes
      if (table.has(p)) throw new Error(`register: duplicate route ${kind} ${p}`)
      table.set(p, route.handler)
      return () => { if (table.get(p) === route.handler) table.delete(p) }
    },

    registerUpgrade(route) {
      const p = String((route && route.path) || '')
      if (!p.startsWith('/')) throw new Error(`registerUpgrade: path must be absolute: ${p}`)
      if (upgrades.has(p)) throw new Error(`registerUpgrade: duplicate path ${p}`)
      upgrades.set(p, route.handler)
      return () => { if (upgrades.get(p) === route.handler) upgrades.delete(p) }
    },

    registerFallback(handler) {
      if (typeof handler !== 'function') throw new Error('registerFallback: handler required')
      if (fallback) throw new Error('registerFallback: seat already claimed')
      fallback = handler
      return () => { if (fallback === handler) fallback = null }
    },

    tapIndex(transform) {
      if (typeof transform !== 'function') throw new Error('tapIndex: transform required')
      indexTaps.push(transform)
      return () => {
        const i = indexTaps.indexOf(transform)
        if (i >= 0) indexTaps.splice(i, 1)
      }
    },

    /**
     * 宿主级路由覆写（优先级高于插件注册的命名路由）。
     * 仅用于桌面端把**只读**接口接到 DSH 已有的数据源上；插件本体一行未改。
     */
    override(p, handler) {
      const key = String(p || '')
      if (!key.startsWith('/')) throw new Error(`override: path must be absolute: ${key}`)
      if (typeof handler !== 'function') throw new Error('override: handler required')
      overrides.set(key, handler)
      return () => { if (overrides.get(key) === handler) overrides.delete(key) }
    },

    collectIndexInjections,
    applyIndexTaps,
    renderIndex,
    renderIndexInjections(html, rows) { return renderIndexInjections(html, rows) },

    async listen() {
      if (server) return listenedPort
      server = http.createServer((req, res) => {
        let pathname = '/'
        try {
          pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname
        } catch (err) {
          res.statusCode = 400
          res.end('bad request')
          return
        }
        // 命名路由没有尾斜杠；`/foo/` 视为 `/foo`（DSH 的路径同样不带尾斜杠）
        const key = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
        const handler = match(key)
        if (handler) {
          try { Promise.resolve(handler(req, res)).catch(() => { try { res.statusCode = 500; res.end() } catch (e) {} }) }
          catch (err) { try { res.statusCode = 500; res.end() } catch (e) {} }
          return
        }
        if (fallback) {
          try { Promise.resolve(fallback(req, res)).catch(() => { try { res.statusCode = 500; res.end() } catch (e) {} }) }
          catch (err) { try { res.statusCode = 500; res.end() } catch (e) {} }
          return
        }
        res.statusCode = 404
        res.end('not found')
      })
      server.on('upgrade', (req, socket, head) => {
        let pathname = '/'
        try { pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname } catch (err) {}
        const handler = upgrades.get(pathname)
        if (!handler) { try { socket.destroy() } catch (err) {} return }
        try { Promise.resolve(handler(req, socket, head)).catch(() => { try { socket.destroy() } catch (e) {} }) }
        catch (err) { try { socket.destroy() } catch (e) {} }
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          listenedPort = server.address().port
          resolve()
        })
      })
      return listenedPort
    },

    async close() {
      if (!server) return
      const s = server
      server = null
      await new Promise((resolve) => {
        let settled = false
        const done = () => { if (!settled) { settled = true; resolve() } }
        try { s.close(done) } catch (err) { done() }
        // 挂件页面是长连接页面（每秒轮询），直接强制断开，避免退出时卡住
        try { s.closeAllConnections && s.closeAllConnections() } catch (err) {}
        // 兜底：2 秒内没关掉也放行退出
        setTimeout(done, 2000).unref?.()
      })
    },
  }

  return service
}
