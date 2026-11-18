// detect.mjs — 检测本机是否有 DSH 在运行。
//
// 为什么用 HTTP 探测而不是进程枚举：桌面端要跨平台、不能依赖 tasklist/wmic 之类的子进程，
// 而 DSH 的 Web 宿主本身就是一个回环 HTTP 服务。探测它即可，且能顺手拿到端口。
//
// 判定特征（实测 127.0.0.1:3080，DSH 0.2.x）：
//   GET /            → 401 + "dsh web authentication required; reopen the URL printed by dsh web."
//   GET /favicon.svg → 200 + image/svg+xml（静态资源在鉴权之外）
const DEFAULT_PORTS = [3080, 3081, 3000, 3456, 8000, 8080, 8888]

/** 探测单个端口是否是 DSH Web 宿主。 */
export async function probePort(port, timeoutMs = 700) {
  const base = `http://127.0.0.1:${port}`
  const signal = () => AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetch(base + '/', { redirect: 'manual', signal: signal() })
    const body = await res.text().catch(() => '')
    if (res.status === 401 && /dsh\b/i.test(body)) return { port, evidence: 'auth-401' }
    if (res.status === 200 && (body.includes('__DSH_BOOT__') || /DeepSeek Harness/i.test(body))) {
      return { port, evidence: 'index' }
    }
    if (res.status === 401 || res.status === 403) {
      // 有鉴权但文案不同：再看一眼公开的静态资源确认是 DSH
      const fav = await fetch(base + '/favicon.svg', { signal: signal() }).catch(() => null)
      if (fav && fav.ok && /svg/i.test(String(fav.headers.get('content-type') || ''))) {
        return { port, evidence: 'favicon' }
      }
    }
  } catch (err) {
    return null // 连不上 = 该端口没有服务
  }
  return null
}

/**
 * 判断「正在运行的 DSH」里是否装了本插件（决定联动模式，避免账记两遍）。
 *
 * 实测标定（DSH 0.2.x，127.0.0.1:3080）：
 *   装了插件 → GET /dsh-whale/balance.json 返回 401（路由已注册，被宿主浏览器鉴权拦住）
 *   没装插件 → 未注册的路径返回 404
 * 所以 401/403/200 都表示「这条路由存在」＝插件在跑。
 */
export async function probeWhaleRoute(port, timeoutMs = 900) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/dsh-whale/balance.json`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    await res.arrayBuffer().catch(() => {})
    return res.status === 401 || res.status === 403 || res.status === 200
  } catch (err) {
    return false
  }
}

/**
 * 在候选端口里找正在运行的 DSH。
 * @param {{ ports?: number[], timeoutMs?: number }} [opts]
 * @returns {Promise<{ running: boolean, port: number|null, evidence: string|null }>}
 */
export async function detectDsh({ ports, timeoutMs = 700 } = {}) {
  const list = []
  const push = (p) => {
    const n = Number(p)
    if (Number.isInteger(n) && n > 0 && n < 65536 && !list.includes(n)) list.push(n)
  }
  const fromEnv = Number(process.env.DSHW_DSH_PORT)
  if (fromEnv) push(fromEnv)
  for (const p of ports || []) push(p)
  for (const p of DEFAULT_PORTS) push(p)

  const results = await Promise.all(list.map((p) => probePort(p, timeoutMs)))
  for (let i = 0; i < list.length; i++) {
    const hit = results[i]
    if (hit) return { running: true, port: hit.port, evidence: hit.evidence }
  }
  return { running: false, port: null, evidence: null }
}
