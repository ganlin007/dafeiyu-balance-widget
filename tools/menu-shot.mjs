// 展开挂件菜单并截一张页面图，用于确认「总在最前」这一行的观感。
import fs from 'node:fs'
const port = Number(process.argv[2] || 9416)
const out = process.argv[3] || 'menu-shot.png'
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
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

// 展开菜单并返回菜单矩形
const box = await evaluate(`(async () => {
  const menu = document.querySelector('.dshwv-menu')
  menu.classList.add('dshwv-menu-open')
  await new Promise((r) => setTimeout(r, 500))
  const b = menu.getBoundingClientRect()
  return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]
})()`)
console.log('菜单矩形: ' + JSON.stringify(box))
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result && shot.result.data) {
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log('截图: ' + out + ' (' + fs.statSync(out).size + ' 字节)')
}
await evaluate(`document.querySelector('.dshwv-menu').classList.remove('dshwv-menu-open')`)
ws.close()
