// plugin-host.mjs — 把**未改动的**上游插件装配到 mini 宿主上。
//
// 装配顺序刻意与 DSH 一致：
//   ① 建宿主 → ② 注册三个服务（webServer / credentials / connection）
//   → ③ 服务监听 → ④ apply(插件) → ⑤ 兜底路由返回桌面壳页面（经插件自己的注入管线）
import os from 'node:os'
import path from 'node:path'
import { createHost } from './mini-host.mjs'
import { createWebServer } from './web-server.mjs'
import { createCredentials } from './credentials.mjs'
import { createConnection } from './connection.mjs'
import { shellHtml } from './shell.mjs'
import whalePlugin from '../../vendor/dsh-whale/lib/index.js'

export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * 启动插件宿主。
 * @param {{ port?: number }} [opts] 端口 0 = 由系统分配（推荐，桌面端不占用固定端口）
 */
export async function startPluginHost({ port = 0 } = {}) {
  const home = resolveDshHome()
  const host = createHost()
  const webServer = createWebServer({ host: '127.0.0.1', port, emit: host.emit })
  const credentials = createCredentials({ home })
  const connection = createConnection()

  host.provide('webServer', webServer)
  host.provide('credentials', credentials)
  host.provide('connection', connection)

  const listeningPort = await webServer.listen()

  // 兜底路由：桌面壳页面（与 DSH 的 SPA fallback 同位）
  const disposeFallback = webServer.registerFallback((req, res) => {
    const method = String(req.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405
      res.end()
      return
    }
    const html = webServer.renderIndex(shellHtml())
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(html)
  })

  // 插件本体：一字未改地 apply。
  whalePlugin.apply(host.root)

  return {
    home,
    host,
    webServer,
    credentials,
    connection,
    port: listeningPort,
    /** 供诊断：插件已注册的 /dsh-whale/* 路由条数 */
    async dispose() {
      try { disposeFallback() } catch (err) {}
      host.dispose()
      await webServer.close()
    },
  }
}
