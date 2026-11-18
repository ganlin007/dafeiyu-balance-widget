// 向页面派发 mousemove：走的就是挂件「鼠标进出 → setInteractive → 主进程 setIgnoreMouseEvents」那条路径，
// 用来验证置顶位在切换穿透后是否还在。
// 用法：node tools/dispatch-move.mjs <debugPort> on|off
const port = Number(process.argv[2] || 9417)
const mode = process.argv[3] || 'on'
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

const out = await evaluate(`(async () => {
  const img = document.querySelector('.dshwv-img')
  const b = img.getBoundingClientRect()
  const pt = (${JSON.stringify(mode)} === 'on')
    ? [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]
    : [8, 8]
  for (let i = 0; i < 3; i++) {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: pt[0], clientY: pt[1], bubbles: true }))
    await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => setTimeout(r, 120))
  }
  return { mode: ${JSON.stringify(mode)}, point: pt, hit: (() => {
    const el = document.elementFromPoint(pt[0], pt[1])
    const cls = (n) => { try { return typeof n.className === 'string' ? n.className : (n.className && n.className.baseVal) || '' } catch (e) { return '' } }
    let n = el, ok = false
    for (let i = 0; i < 6 && n && n !== document.body; i++) { if (cls(n).indexOf('dshwv') >= 0) { ok = true; break } n = n.parentElement }
    return { tag: el ? el.tagName + '.' + cls(el) : null, belongsToWidget: ok }
  })() }
})()`)
console.log(JSON.stringify(out))
ws.close()
