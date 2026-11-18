// smoke.mjs — 端到端冒烟测试：把 mini 宿主 + 未改动的上游插件跑起来，逐条验证对外接口。
//
// 重要：本测试把 DSH_HOME 指到临时目录，绝不写用户的真实数据；
// 真实凭据文件只做一次**只读**解析，用于确认「能读到 DSH 已配置的 key」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok: !!ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-smoke-'))
process.env.DSH_HOME = tmpHome

// 造一份与 DSH 同形状的凭据文档（含 records 段，验证外科手术式写入不会破坏它）
const credPath = path.join(tmpHome, '.credentials.yaml')
fs.writeFileSync(credPath, [
  'version: 1',
  '',
  'refs:',
  '  # DeepSeek 官方',
  '  DEEPSEEK_API_KEY: sk-smoke-test-0001',
  '  OTHER_KEY: "quoted value"',
  '',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      secret: keep-me-intact',
  '',
].join('\n'))

const { startPluginHost } = await import('../src/host/plugin-host.mjs')
const host = await startPluginHost({ port: 0 })
const base = `http://127.0.0.1:${host.port}`

async function get(p) {
  const res = await fetch(base + p, { redirect: 'manual' })
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, type: res.headers.get('content-type') || '', buf, text: buf.toString('utf8') }
}
async function json(p) {
  const r = await get(p)
  let body = null
  try { body = JSON.parse(r.text) } catch (err) {}
  return { ...r, body }
}

// ① 首页：插件通过注入管线把前端挂件脚本挂进去
const index = await get('/')
check('GET / 返回 200', index.status === 200, 'status=' + index.status)
check('首页含注入的挂件脚本行', index.text.includes('/dsh-whale/widget.js'))
check('首页含注入的 <script', /<script/i.test(index.text))
check('首页含 desktop 壳的 #root composer 桩', index.text.includes('data-composer-input'))

// ② 挂件前端本体
const widget = await get('/dsh-whale/widget.js')
check('GET /dsh-whale/widget.js 返回 200', widget.status === 200, 'status=' + widget.status)
check('widget.js 是插件原文件（大小一致）', widget.buf.length === 861966, 'bytes=' + widget.buf.length)
check('widget.js Content-Type 正确', /javascript/.test(widget.type), widget.type)

// ③ 图片 / 音频资源
const img = await get('/dsh-whale/image.png?v=2')
check('GET /dsh-whale/image.png 返回图片', img.status === 200 && img.buf.length > 1000, `status=${img.status} bytes=${img.buf.length}`)
const rua = await get('/dsh-whale/rua.gif')
check('GET /dsh-whale/rua.gif 返回 gif', rua.status === 200 && rua.buf.length > 1000, `status=${rua.status} bytes=${rua.buf.length}`)
const sound = await get('/dsh-whale/sound/press.mp3?set=duck')
check('GET /dsh-whale/sound/press.mp3 返回音频', sound.status === 200 && sound.buf.length > 100, `status=${sound.status} bytes=${sound.buf.length}`)

// ④ 读接口
for (const p of ['/dsh-whale/size.json', '/dsh-whale/roles.json', '/dsh-whale/audio.json', '/dsh-whale/bubble.json',
  '/dsh-whale/bubble-imgs.json', '/dsh-whale/last-turn.json', '/dsh-whale/wait.json', '/dsh-whale/usage-records.json',
  '/dsh-whale/usage-settings.json', '/dsh-whale/api-models.json']) {
  const r = await json(p)
  check(`GET ${p} 返回 JSON`, r.status === 200 && r.body !== null, `status=${r.status}`)
}

// 余额校正接口按设计只认内置 DeepSeek：不带 modelId 时插件自己返回 403，带上才是 200
const adjBad = await json('/dsh-whale/balance-adjustments.json')
check('GET 余额校正（缺 modelId）按插件设计返回 403', adjBad.status === 403, 'status=' + adjBad.status)
const adjOk = await json('/dsh-whale/balance-adjustments.json?modelId=deepseek')
check('GET 余额校正（modelId=deepseek）返回 JSON', adjOk.status === 200 && adjOk.body !== null, 'status=' + adjOk.status)

// ⑤ 写接口（临时目录，安全）
const putSize = await fetch(base + '/dsh-whale/size.json', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scale: 1.5, menuButtonHidden: false }),
})
const putBody = await putSize.json().catch(() => null)
check('POST /dsh-whale/size.json 写入成功', putSize.status === 200 && putBody && putBody.ok === true, JSON.stringify(putBody))
const sizeFile = path.join(tmpHome, '.dshw-size.json')
check('写入落到 $DSH_HOME/.dshw-size.json', fs.existsSync(sizeFile), sizeFile)
const reread = await json('/dsh-whale/size.json')
check('重新读取能拿到刚写入的 scale', reread.body && Number(reread.body.scale) === 1.5, JSON.stringify(reread.body && reread.body.scale))

// ⑥ 非回环 Host 的写请求必须被拒（插件的信任栅栏）
const banned = await fetch(`http://127.0.0.1:${host.port}/dsh-whale/size.json`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Host: 'evil.example.com', 'Sec-Fetch-Site': 'cross-site' },
  body: JSON.stringify({ scale: 2 }),
}).catch((err) => ({ status: 'ERR ' + err.message }))
check('跨站写请求被拒绝', banned.status === 403, 'status=' + banned.status)

// ⑦ 凭据服务：解析 + 写入 + 删除，且不能弄坏 records 段
//    注意 resolve 必须返回 DSH 的 { value, source } 结构（插件读的是 cred.value）
const cred = host.credentials
check('凭据：解析已存在的 key', (await cred.resolve('DEEPSEEK_API_KEY'))?.value === 'sk-smoke-test-0001')
check('凭据：解析带引号的值', (await cred.resolve('OTHER_KEY'))?.value === 'quoted value')
check('凭据：解析结果带 source 字段', (await cred.resolve('DEEPSEEK_API_KEY'))?.source === 'store')
await cred.set('NEW_KEY', 'sk-new-value-42')
check('凭据：写入新 key', (await cred.resolve('NEW_KEY'))?.value === 'sk-new-value-42')
const credText = fs.readFileSync(credPath, 'utf8')
check('凭据：records 段与注释未被破坏', credText.includes('secret: keep-me-intact') && credText.includes('# DeepSeek 官方'))
check('凭据：document 仍可被 DSH 解析（version/refs/records 齐全）',
  /^version: 1$/m.test(credText) && /^refs:$/m.test(credText) && /^records:$/m.test(credText))
await cred.set('NEW_KEY', 'sk-second-value')
check('凭据：覆盖已存在的 key', (await cred.resolve('NEW_KEY'))?.value === 'sk-second-value')
await cred.unset('NEW_KEY')
check('凭据：删除 key', (await cred.resolve('NEW_KEY')) === undefined)
check('凭据：删除后文件仍完好', fs.readFileSync(credPath, 'utf8').includes('secret: keep-me-intact'))

// ⑧ 只读检查真实 DSH 凭据：确认桌面端能直接读到用户已配置的 key（不打印内容）
const realHome = path.join(os.homedir(), '.dsh')
if (fs.existsSync(path.join(realHome, '.credentials.yaml'))) {
  const { createCredentials } = await import('../src/host/credentials.mjs')
  const real = createCredentials({ home: realHome })
  const names = await real.list()
  const key = await real.resolve('DEEPSEEK_API_KEY')
  check('真实 $DSH_HOME 凭据：能列出凭据名', names.length > 0, names.join(','))
  check('真实 $DSH_HOME 凭据：能读到 DEEPSEEK_API_KEY', !!(key && typeof key.value === 'string' && key.value.length > 8),
    key ? '长度 ' + key.value.length + '（内容未打印）' : '未配置')
} else {
  check('真实 $DSH_HOME 凭据存在', false, path.join(realHome, '.credentials.yaml') + ' 不存在')
}

// ⑨ 余额接口（临时目录里没有真 key ⇒ 允许失败，但必须是结构化 JSON）
const bal = await json('/dsh-whale/balance.json')
check('GET /dsh-whale/balance.json 返回结构化 JSON', bal.status === 200 && bal.body && typeof bal.body === 'object',
  'status=' + bal.status + ' keys=' + (bal.body ? Object.keys(bal.body).join(',') : 'null'))

await host.dispose()
fs.rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('; '))
  process.exit(1)
}
