// check-key.mjs — 诊断 DeepSeek 余额为什么读不到：用桌面端同一套凭据解析逻辑取 key，直接打余额接口。
// 只打印状态码与响应体，不打印密钥内容。
import { createCredentials } from '../src/host/credentials.mjs'
import { resolveDshHome } from '../src/host/plugin-host.mjs'

const home = resolveDshHome()
const cred = createCredentials({ home })
console.log('$DSH_HOME =', home)
console.log('凭据文件 =', cred.path)

const names = await cred.list().catch(() => [])
console.log('refs 里的凭据名：', names.join(', ') || '(无)')

const cred0 = await cred.resolve('DEEPSEEK_API_KEY')
const key = cred0 && cred0.value ? String(cred0.value) : ''
if (!key) {
  console.log('结论：没有解析到 DEEPSEEK_API_KEY')
  process.exit(0)
}
console.log('解析到 key：长度', key.length, '前 6 位', key.slice(0, 6) + '...', '来源', cred0.source)

try {
  const res = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(30000),
  })
  console.log('余额接口 HTTP', res.status)
  console.log('响应体：', (await res.text()).slice(0, 400))
} catch (err) {
  console.log('请求异常：', err.cause?.code || err.message)
}
