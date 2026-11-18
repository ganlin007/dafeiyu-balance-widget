// 贴边验证：模拟把鲸鱼拖到指定方向后松手，看窗口与鲸鱼最终落在哪、锚点/镜像类是否正确。
// 用法：node tools/snap-check.mjs <debugPort> <dx> <dy>
import fs from 'node:fs'
const port = Number(process.argv[2] || 9421)
const dx = Number(process.argv[3] || 0)
const dy = Number(process.argv[4] || 0)
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

const snap = `(() => {
  const root = document.querySelector('.dshwv-root')
  const r = root.getBoundingClientRect()
  return {
    win: [window.screenX, window.screenY], viewport: [innerWidth, innerHeight],
    avail: [screen.availWidth, screen.availHeight],
    whale: [Math.round(window.screenX + r.left), Math.round(window.screenY + r.top), Math.round(r.width), Math.round(r.height)],
    pins: ['dshw-pin-tl','dshw-pin-bl','dshw-pin-tr'].filter(c => root.classList.contains(c)),
    flipped: root.classList.contains('dshwv-left'),
  }
})()`
console.log('拖动前: ' + JSON.stringify(await ev(snap)))

const res = await ev(`(async () => {
  const root = document.querySelector('.dshwv-root'), img = document.querySelector('.dshwv-img')
  const r = img.getBoundingClientRect()
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2)
  const sx0 = window.screenX + cx, sy0 = window.screenY + cy
  const DX = ${dx}, DY = ${dy}
  window.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, screenX: sx0, screenY: sy0, button: 0, bubbles: true }))
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: cx, clientY: cy, screenX: sx0 + DX * i / steps, screenY: sy0 + DY * i / steps, button: 0, bubbles: true }))
    await new Promise((rr) => setTimeout(rr, 50))
  }
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, screenX: sx0 + DX, screenY: sy0 + DY, button: 0, bubbles: true }))
  await new Promise((rr) => setTimeout(rr, 600))
  return { requested: [DX, DY] }
})()`)
console.log('拖动: ' + JSON.stringify(res))
await sleep(900)
console.log('拖动后: ' + JSON.stringify(await ev(snap)))
ws.close()
