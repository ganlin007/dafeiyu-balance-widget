// 宠pet 窗口的端到端验证（全部走 CDP，不需要真实鼠标）：
//   ① 鲸鱼是否被钉在窗口右下角、尺寸是否正常
//   ② alpha 命中测试：不透明像素上应判"可交互"，透明角落应判"穿透"（结果看主进程日志）
//   ③ 拖鲸鱼是否真的移动窗口（模拟 screenX/screenY 增量）
//   ④ 松手后是否夹进工作区 / 吸附到边缘
import fs from 'node:fs'
const port = Number(process.argv[2] || 9419)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let target = null
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && String(t.url || '').includes('dshw://'))
    if (page) { target = page; break }
  } catch (err) {}
  await sleep(500)
}
if (!target) { console.error('没找到页面'); process.exit(1) }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
let id = 1
const pending = new Map()
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(String(ev.data)) } catch { return }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params) => new Promise((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description }
  return r.result?.result?.value
}

const info = await evaluate(`(() => {
  const root = document.querySelector('.dshwv-root')
  const img = document.querySelector('.dshwv-img')
  const r = root.getBoundingClientRect(), ir = img.getBoundingClientRect()
  return {
    viewport: [innerWidth, innerHeight],
    screenXY: [window.screenX, window.screenY],
    rootRect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    imgRect: [Math.round(ir.x), Math.round(ir.y), Math.round(ir.width), Math.round(ir.height)],
    imgLoaded: img.complete && img.naturalWidth > 0,
    baseVar: getComputedStyle(root).getPropertyValue('--dshw-base'),
    pinned: { left: getComputedStyle(root).left, top: getComputedStyle(root).top, right: getComputedStyle(root).right, bottom: getComputedStyle(root).bottom },
  }
})()`)
console.log('① 布局: ' + JSON.stringify(info, null, 1))

// ② 命中测试：分别在不透明处（img 中心）和透明角落（img 外 2px 的 root 区域）派发 mousemove
const hit = await evaluate(`(async () => {
  const img = document.querySelector('.dshwv-img')
  const r = img.getBoundingClientRect()
  const rootR = document.querySelector('.dshwv-root').getBoundingClientRect()
  const pts = {
    center: [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)],
    corner: [Math.round(rootR.x + 3), Math.round(rootR.y + 3)],
    empty: [8, 8],
  }
  const out = {}
  for (const k of Object.keys(pts)) {
    const p = pts[k]
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: p[0], clientY: p[1], bubbles: true }))
      await new Promise((rr) => requestAnimationFrame(rr))
      await new Promise((rr) => setTimeout(rr, 120))
    }
    const el = document.elementFromPoint(p[0], p[1])
    out[k] = { point: p, element: el ? (el.tagName + '.' + (typeof el.className === 'string' ? el.className : '')) : null }
    await new Promise((rr) => setTimeout(rr, 250))
  }
  return out
})()`)
console.log('② 命中测试点: ' + JSON.stringify(hit))

// ③ 模拟拖鲸鱼：screenX/screenY 增量 -400（不动 clientX），看窗口是否跟着移动
const drag = await evaluate(`(async () => {
  const img = document.querySelector('.dshwv-img')
  const r = img.getBoundingClientRect()
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2)
  const sx0 = window.screenX + cx, sy0 = window.screenY + cy
  const down = (x, y) => new PointerEvent('pointerdown', { clientX: cx, clientY: cy, screenX: x, screenY: y, button: 0, bubbles: true })
  const move = (x, y) => new PointerEvent('pointermove', { clientX: cx, clientY: cy, screenX: x, screenY: y, bubbles: true })
  window.dispatchEvent(down(sx0, sy0))
  for (let i = 1; i <= 8; i++) {
    window.dispatchEvent(move(sx0 - i * 50, sy0))
    await new Promise((rr) => setTimeout(rr, 60))
  }
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, screenX: sx0 - 400, screenY: sy0, button: 0, bubbles: true }))
  await new Promise((rr) => setTimeout(rr, 500))
  return { startScreen: [sx0, sy0], endScreenX: window.screenX }
})()`)
console.log('③ 拖动模拟: ' + JSON.stringify(drag))
await sleep(1200)
console.log('   拖动后 window.screenX = ' + (await evaluate('window.screenX')))
ws.close()
