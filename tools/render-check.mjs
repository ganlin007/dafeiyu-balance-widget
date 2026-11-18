// render-check.mjs — 无 GUI 环境下的渲染自检：起 mini 宿主 → 用系统 Edge/Chrome headless 打开桌面壳页面
// → 通过 CDP 在真实浏览器引擎里断言挂件 DOM、图片加载、localStorage、以及鼠标穿透所用的命中测试。
// 桌面端日常运行走 Electron；本脚本只是自动化验证手段。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPng = process.argv[2] || path.join(ROOT, 'render-check.png')

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const browser = BROWSERS.find((p) => fs.existsSync(p))
if (!browser) { console.error('找不到 Edge/Chrome'); process.exit(2) }

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { startPluginHost } = await import('../src/host/plugin-host.mjs')
const host = await startPluginHost({ port: 0 })
const url = `http://127.0.0.1:${host.port}/`
console.log('宿主：' + url + '（$DSH_HOME=' + host.home + '）')

const cdpPort = 9000 + Math.floor(Math.random() * 900)
const baseProfile = path.join(ROOT, '.render-profile')
try { fs.rmSync(baseProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch (err) { /* 上次的浏览器可能还占着 */ }
const profileDir = fs.existsSync(baseProfile) ? baseProfile + '-' + Date.now() : baseProfile

const child = spawn(browser, [
  '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--mute-audio', '--remote-allow-origins=*',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1600,900',
  url,
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
    const list = await r.json()
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    // 必须挑到我们那个 URL 的页面：headless 有时会先给一个 about:blank 页
    target = pages.find((t) => String(t.url || '').startsWith(url)) || (pages.length === 1 ? pages[0] : null)
    if (target) break
  } catch (err) {}
  await sleep(500)
}
if (!target) {
  console.error('FAIL  无法连接浏览器调试端口')
  child.kill()
  await host.dispose()
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pendingCalls = new Map()
ws.addEventListener('message', (ev) => {
  let msg
  try { msg = JSON.parse(String(ev.data)) } catch (err) { return }
  if (msg.id && pendingCalls.has(msg.id)) {
    pendingCalls.get(msg.id)(msg)
    pendingCalls.delete(msg.id)
  }
})
function send(method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    pendingCalls.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result && res.result.exceptionDetails) {
    return { __error: res.result.exceptionDetails.exception && res.result.exceptionDetails.exception.description }
  }
  return res.result && res.result.result ? res.result.result.value : null
}

// 等挂件挂载
let mounted = null
for (let i = 0; i < 40; i++) {
  mounted = await evaluate(`!!document.querySelector('.dshwv-root')`)
  if (mounted) break
  await sleep(500)
}
check('挂件在真实浏览器里初始化（.dshwv-root 存在）', mounted === true)

await sleep(1500)
const info = await evaluate(`(() => {
  const root = document.querySelector('.dshwv-root')
  const img = document.querySelector('.dshwv-img')
  const r = root ? root.getBoundingClientRect() : null
  const ir = img ? img.getBoundingClientRect() : null
  return {
    hasRoot: !!root, rootCount: document.querySelectorAll('.dshwv-root').length,
    rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
    img: img ? { src: img.getAttribute('src'), complete: img.complete, nw: img.naturalWidth, nh: img.naturalHeight,
      rect: ir ? [Math.round(ir.x), Math.round(ir.y), Math.round(ir.width), Math.round(ir.height)] : null } : null,
    viewport: [innerWidth, innerHeight],
    localStorageOk: (() => { try { localStorage.setItem('dshw-probe', '1'); const v = localStorage.getItem('dshw-probe') === '1'; localStorage.removeItem('dshw-probe'); return v } catch (e) { return 'ERR ' + e.message } })(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    menuBtn: !!document.querySelector('.dshwv-menu-btn'),
  }
})()`)
check('页面上只有一份挂件实例', info && info.rootCount === 1, JSON.stringify(info && info.rootCount))
check('角色图片已加载完成', !!(info && info.img && info.img.complete && info.img.nw > 0),
  info && info.img ? `natural=${info.img.nw}x${info.img.nh} src=${info.img.src}` : 'no img')
check('挂件右下角定位（贴视口右下）', !!(info && info.rect && info.rect[0] + info.rect[2] <= info.viewport[0] + 1 && info.rect[1] + info.rect[3] <= info.viewport[1] + 1),
  info ? `rect=${JSON.stringify(info.rect)} viewport=${JSON.stringify(info.viewport)}` : '')
check('localStorage 可用（位置/尺寸记忆依赖它）', info && info.localStorageOk === true, String(info && info.localStorageOk))
check('角色图走的是插件的图片接口', !!(info && info.img && /\/dsh-whale\/(image\.png|role-image\.png)/.test(info.img.src)), info && info.img ? info.img.src : '')
check('主菜单按钮已注入', !!(info && info.menuBtn))

// 鼠标穿透的命中测试：鲸鱼身上要能命中 .dshwv-root，空白处必须命中不到
const hit = await evaluate(`(() => {
  const img = document.querySelector('.dshwv-img')
  const ir = img.getBoundingClientRect()
  const cx = Math.round(ir.x + ir.width / 2), cy = Math.round(ir.y + ir.height / 2)
  const on = document.elementFromPoint(cx, cy)
  const off = document.elementFromPoint(5, 5)
  const hitOf = (el) => !!(el && el.closest && el.closest('.dshwv-root'))
  return { onHit: hitOf(on), onTag: on ? on.className || on.tagName : null, offHit: hitOf(off), offTag: off ? (off.className || off.tagName) : null }
})()`)
check('指针落在鲸鱼上 → 命中挂件（窗口该切成可交互）', hit && hit.onHit === true, JSON.stringify(hit))
check('指针在空白处 → 不命中挂件（窗口该保持穿透）', hit && hit.offHit === false, hit ? `offTag=${hit.offTag}` : '')

// 页面内同源接口可用（挂件就是这么取余额/记账的）
const api = await evaluate(`(async () => {
  const out = {}
  for (const p of ['/dsh-whale/balance.json', '/dsh-whale/size.json', '/dsh-whale/roles.json', '/dsh-whale/bubble.json', '/dsh-whale/wait.json', '/dsh-whale/last-turn.json']) {
    try { const r = await fetch(p, { cache: 'no-store' }); out[p] = { status: r.status, ok: (await r.json()) !== null } }
    catch (e) { out[p] = { error: String(e && e.message) } }
  }
  return out
})()`)
const apiOk = api && Object.values(api).every((v) => v && v.status === 200 && v.ok)
check('页面内同源调用 6 个接口全部 200 + JSON', apiOk, JSON.stringify(api))

// 截图
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot && shot.result && shot.result.data) {
  fs.writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'))
  check('截图已保存', fs.statSync(outPng).size > 1000, outPng + '（' + fs.statSync(outPng).size + ' 字节）')
} else {
  check('截图已保存', false)
}

ws.close()
child.kill()
await host.dispose()
await sleep(1200)
try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch (err) { /* Edge 可能还占着配置目录，忽略 */ }

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) { console.log('失败项：' + failed.map((f) => f.name).join('; ')); process.exit(1) }
