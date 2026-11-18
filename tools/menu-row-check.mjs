// 验证宿主注入到挂件菜单里的「总在最前」行：存在、样式与原生行一致、点击能切置顶。
const port = Number(process.argv[2] || 9415)
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

const menus = await evaluate(`(() => [...document.querySelectorAll('.dshwv-menu')].map((m, i) => ({
  i, children: m.children.length,
  parent: m.parentElement.tagName + '.' + (m.parentElement.className || ''),
  text: (m.innerText || '').replace(/\\n+/g, ' | ').slice(0, 100),
  hasHostRow: !!m.querySelector('.dshw-host-topmost'),
  isOpen: m.classList.contains('dshwv-menu-open'),
})))()`)
console.log('页面里的 .dshwv-menu：' + JSON.stringify(menus, null, 1))

const info = await evaluate(`(() => {
  const row = document.querySelector('.dshw-host-topmost')
  const native = document.querySelector('.dshwv-menu .dshwv-menu-row')
  if (!row) return { found: false }
  const chk = row.querySelector('input')
  const rs = getComputedStyle(row)
  const ns = native ? getComputedStyle(native) : null
  return {
    found: true,
    label: (row.textContent || '').trim(),
    checkboxClass: chk ? chk.className : null,
    checked: chk ? chk.checked : null,
    rowStyle: { display: rs.display, gap: rs.gap, fontSize: rs.fontSize, color: rs.color },
    nativeStyle: ns ? { display: ns.display, gap: ns.gap, fontSize: ns.fontSize, color: ns.color } : null,
    positionInMenu: [...row.parentElement.children].indexOf(row),
    childCount: row.parentElement.children.length,
  }
})()`)
console.log('注入行检查：' + JSON.stringify(info, null, 2))

// 点一下这个复选框，看主进程是否收到并切换置顶
const toggled = await evaluate(`(async () => {
  const chk = document.querySelector('.dshw-host-topmost input')
  if (!chk) return { error: '没有复选框' }
  const before = chk.checked
  chk.click()
  await new Promise((r) => setTimeout(r, 400))
  return { before, after: chk.checked }
})()`)
console.log('点击切换：' + JSON.stringify(toggled))
ws.close()
