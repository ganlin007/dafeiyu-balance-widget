// 最终布局核对 + 抓一张页面图（确认鲸鱼位置、无异常镜像）
import fs from 'node:fs'
const port = Number(process.argv[2] || 9420)
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
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value

const layout = await ev(`(() => {
  const root = document.querySelector('.dshwv-root'), img = document.querySelector('.dshwv-img')
  const r = root.getBoundingClientRect(), ir = img.getBoundingClientRect()
  return {
    screenX: window.screenX, screenY: window.screenY,
    viewport: [innerWidth, innerHeight],
    root: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    img: [Math.round(ir.x), Math.round(ir.y), Math.round(ir.width), Math.round(ir.height)],
    flipped: root.classList.contains('dshwv-left'),
    imgAtRootBottomRight: Math.abs((ir.x + ir.width) - (r.x + r.width)) < 2 && Math.abs((ir.y + ir.height) - (r.y + r.height)) < 2,
    hostRow: !!document.querySelector('.dshw-host-topmost'),
  }
})()`)
console.log('最终布局: ' + JSON.stringify(layout, null, 1))

// 鲸鱼素材内部的透明角落应当判"穿透"，不透明中心应判"可交互"（结果去主进程日志看）
const alpha = await ev(`(() => {
  const img = document.querySelector('.dshwv-img')
  const r = img.getBoundingClientRect()
  const c = document.createElement('canvas')
  c.width = Math.round(r.width); c.height = Math.round(r.height)
  const cx = c.getContext('2d', { willReadFrequently: true })
  cx.drawImage(img, 0, 0, c.width, c.height)
  const d = cx.getImageData(0, 0, c.width, c.height).data
  const at = (px, py) => d[((py * c.width) + px) * 4 + 3]
  return {
    topLeft: at(2, 2), topRight: at(c.width - 3, 2), bottomLeft: at(2, c.height - 3),
    center: at(Math.floor(c.width / 2), Math.floor(c.height / 2)),
    size: [c.width, c.height],
  }
})()`)
console.log('素材四角/中心 alpha: ' + JSON.stringify(alpha))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result && shot.result.data) {
  fs.writeFileSync('pet-final.png', Buffer.from(shot.result.data, 'base64'))
  console.log('截图: pet-final.png')
}
ws.close()
