// link-test.mjs — DSH 联动的自动化测试（不需要 Electron、不需要真的开着 DSH 也能跑主要分支）。
//
// 覆盖：
//   ① 真实检测：本机 3080 上的 DSH 是否被识别、是否装了本插件
//   ② zstd 多帧增量读取：把一帧一帧追加写入，读取器要能跨帧、跨半帧正确断句
//   ③ display 模式：两个只读接口的响应内容 + **绝不写盘**（账本 mtime/内容不变）
//   ④ account 模式：会话日志被合成为 session/event 投给插件（含进行中那轮的补投）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { detectDsh, probeWhaleRoute } from '../src/dsh/detect.mjs'
import { createLogTail } from '../src/dsh/session-log.mjs'
import { createDshLink } from '../src/dsh/dsh-link.mjs'

// 测试用压缩：Node 自带 zstd 压缩（每个记录一个独立帧，复刻 DSH 的追加写形态）
const compress = (buf) => zlib.zstdCompressSync(buf)

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- ① 真实检测 ----------
const det = await detectDsh()
check('检测到本机运行中的 DSH', det.running === true, JSON.stringify(det))
if (det.running) {
  const hasWhale = await probeWhaleRoute(det.port)
  check('能判定运行中的 DSH 是否装了本插件', typeof hasWhale === 'boolean', 'hasWhalePlugin=' + hasWhale)
}

// ---------- ② zstd 多帧 / 半帧增量读取 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-link-'))
const logDir = path.join(tmp, 'sessions', '--proj--', 'session-test-0001')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, 'session.v4.jsonl.zstd')

const recs = [
  { type: 'session', version: 4, id: 'session-test-0001', createdAt: Date.now(), cwd: 'E:\\tmp' },
  { type: 'session/title', seq: 2, time: Date.now(), data: { title: '联动测试对话' } },
  { type: 'turn/start', seq: 3, time: Date.now(), data: { turn: 1 } },
  { type: 'assistant/message', seq: 4, time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500 }, message: { role: 'assistant', source: { kind: 'model', model: 'deepseek-flash' } } } },
  { type: 'tool/call', seq: 5, time: Date.now(), data: { turn: 1, step: 1, callId: 'call_abc', name: 'ask_user_question' } },
]
// 每个记录一帧（模拟 DSH 的追加写）
const frames = recs.map((r) => Buffer.from(compress(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))))
fs.writeFileSync(logFile, Buffer.concat(frames.slice(0, 3)))

const tail = createLogTail(logFile)
const boot = tail.bootstrap()
check('日志引导：读出会话 id', boot.sessionId === 'session-test-0001', boot.sessionId)
check('日志引导：读出 3 条记录', boot.records.length === 3, 'records=' + boot.records.length)

// 追加第 4 帧，再追加「半帧」验证不会误读
fs.appendFileSync(logFile, frames[3])
let got = tail.readNew()
check('增量读取：拿到新追加的第 4 条', !!got && got.records.length === 1 && got.records[0].type === 'assistant/message',
  got ? got.records.map((r) => r.type).join(',') : 'null')

const half = frames[4].subarray(0, Math.max(1, Math.floor(frames[4].length / 2)))
fs.appendFileSync(logFile, half)
const partial = tail.readNew()
check('半个 zstd 帧不会被误读成记录', !partial || partial.records.length === 0, partial ? 'records=' + partial.records.length : 'null')

fs.appendFileSync(logFile, frames[4].subarray(half.length))
got = tail.readNew()
check('补齐剩余字节后正确读出第 5 条', !!got && got.records.length === 1 && got.records[0].type === 'tool/call',
  got ? got.records.map((r) => r.type).join(',') : 'null')

// ---------- ③/④ 联动模式 ----------
const ledgerFile = path.join(tmp, '.dshw-usage.json')
const turnFile = path.join(tmp, '.dshw-turn.json')
fs.writeFileSync(turnFile, JSON.stringify({ seq: 7, updatedAt: new Date().toISOString() }))
fs.writeFileSync(ledgerFile, JSON.stringify({
  date: '2026-10-04',
  events: [
    { ts: 1000, day: '2026-10-04', model: 'deepseek-flash', cost: 0.5, tokens: 10 },
    { ts: 2000, day: '2026-10-04', model: 'deepseek-flash', cost: 0.25, tokens: 5 },
    { ts: 2000, day: '2026-10-04', model: 'deepseek-pro', cost: 0.75, tokens: 7 },
  ],
}))

function makeFakeHost() {
  const emitted = []
  const routes = new Map()
  return {
    emitted,
    routes,
    host: {
      emit: (event, ...args) => emitted.push({ event, args }),
      webServer: {
        override: (p, h) => { routes.set(p, h); return () => routes.delete(p) },
      },
    },
  }
}
function callRoute(routes, p, body = {}) {
  return new Promise((resolve) => {
    const h = routes.get(p)
    if (!h) return resolve(null)
    h({ method: 'GET', url: p, headers: {} }, {
      writeHead: (code, headers) => { body.code = code; body.headers = headers },
      end: (text) => { try { resolve(JSON.parse(text)) } catch (err) { resolve(text) } },
    })
  })
}

// —— display 模式 ——
process.env.DSHW_LINK_MODE = 'display'
const fake = makeFakeHost()
const linkD = createDshLink({ home: tmp, host: fake.host, logger: { log() {} }, detectMs: 999999, tickMs: 200 })
const beforeLedger = fs.readFileSync(ledgerFile, 'utf8')
const beforeMtime = fs.statSync(ledgerFile).mtimeMs
linkD.start()
await sleep(900)
check('display 模式：接管了 last-turn.json', fake.routes.has('/dsh-whale/last-turn.json'))
check('display 模式：接管了 wait.json', fake.routes.has('/dsh-whale/wait.json'))
check('display 模式：模式状态正确', linkD.status().mode === 'display', JSON.stringify(linkD.status().mode))

const lt = await callRoute(fake.routes, '/dsh-whale/last-turn.json')
check('display 模式：last-turn 用 DSH 账本的 seq', lt && lt.seq === 7, JSON.stringify(lt))
check('display 模式：last-turn 聚合了同一轮的多模型事件（0.25+0.75=1）', lt && Math.abs(lt.amount - 1) < 1e-9, 'amount=' + (lt && lt.amount))
check('display 模式：last-turn 归类到最近的轮次号', lt && lt.turn === 1, 'turn=' + (lt && lt.turn))

const wait = await callRoute(fake.routes, '/dsh-whale/wait.json')
check('display 模式：wait 报出提问挂起', wait && wait.pending && wait.pending.kind === 'question', JSON.stringify(wait))
check('display 模式：wait 带上对话名', wait && wait.sessionName === '联动测试对话', JSON.stringify(wait && wait.sessionName))
check('display 模式：没有任何事件被投给插件（只读）', fake.emitted.length === 0, 'emit=' + fake.emitted.length)

// 再追加 tool/result（回答完成）→ 挂起应解除
fs.appendFileSync(logFile, Buffer.from(compress(Buffer.from(JSON.stringify({ type: 'tool/result', seq: 6, time: Date.now(), data: { turn: 1, step: 1, callId: 'call_abc', message: { role: 'tool', toolCallId: 'call_abc', content: [] } } }) + '\n', 'utf8'))))
await sleep(700)
const wait2 = await callRoute(fake.routes, '/dsh-whale/wait.json')
check('display 模式：tool/result 后挂起解除', wait2 && wait2.pending === null, JSON.stringify(wait2 && wait2.pending))

check('display 模式：账本内容一字未改', fs.readFileSync(ledgerFile, 'utf8') === beforeLedger)
check('display 模式：账本 mtime 未变（全程没写过盘）', fs.statSync(ledgerFile).mtimeMs === beforeMtime)
linkD.stop()
check('display 模式：stop 之后撤掉接管', !fake.routes.has('/dsh-whale/last-turn.json') && !fake.routes.has('/dsh-whale/wait.json'))

// —— account 模式 ——
process.env.DSHW_LINK_MODE = 'account'
const fake2 = makeFakeHost()
const linkA = createDshLink({ home: tmp, host: fake2.host, logger: { log() {} }, detectMs: 999999, tickMs: 200 })
linkA.start()
await sleep(900)
check('account 模式：不接管任何路由', fake2.routes.size === 0, 'routes=' + fake2.routes.size)
const types = fake2.emitted.filter((e) => e.event === 'session/event').map((e) => e.args[1].type)
check('account 模式：把会话记录投给插件（session/event）', types.length > 0, types.join(','))
check('account 模式：补投了进行中那轮的 assistant/message', types.includes('assistant/message'), types.join(','))
check('account 模式：投递的事件带 session.id', fake2.emitted[0] && fake2.emitted[0].args[0] && fake2.emitted[0].args[0].id === 'session-test-0001',
  JSON.stringify(fake2.emitted[0] && fake2.emitted[0].args[0]))
linkA.stop()
delete process.env.DSHW_LINK_MODE

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) { console.log('失败项：' + failed.map((f) => f.name).join('; ')); process.exit(1) }
