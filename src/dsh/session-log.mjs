// session-log.mjs — 读取/跟进 DSH 的会话日志（只读，不写任何文件）。
//
// 日志位置：$DSH_HOME/sessions/<工作区 slug>/<会话 id>/session*.jsonl.zstd
// 记录形状与插件监听的 session/event 完全同构：{ type, seq, time, data }
// 例如：{"type":"assistant/message","seq":18,"time":1791091210513,"data":{...}}
import fs from 'node:fs'
import path from 'node:path'
import { decodeFrames } from './zstd-frames.mjs'

/** 列出最近活跃的会话日志。 */
export function listSessionFiles(home, { activeWindowMs = 45 * 60 * 1000, max = 4, now = Date.now() } = {}) {
  const root = path.join(home, 'sessions')
  const out = []
  const walk = (dir, depth) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1)
        continue
      }
      if (!e.name.startsWith('session')) continue
      if (e.name.endsWith('.bak')) continue
      let st
      try { st = fs.statSync(p) } catch (err) { continue }
      if (now - st.mtimeMs > activeWindowMs) continue
      out.push({ file: p, sessionId: path.basename(path.dirname(p)), mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  walk(root, 0)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, max)
}

/** 把一段解压出来的文本切成完整 JSON 记录，尾部残行留在 buffer 里。 */
function takeRecords(lineBuf, text) {
  const combined = lineBuf + text
  const lines = combined.split('\n')
  const rest = lines.pop() ?? ''
  const records = []
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    try { records.push(JSON.parse(s)) } catch (err) { /* 坏行跳过 */ }
  }
  return { records, lineBuf: rest }
}

/**
 * 为单个日志文件建立增量读取器。
 * 首次调用 bootstrap() 会解出整个文件，用于掌握会话 id / 标题 / 进行中的轮次，
 * 之后 readNew() 只解新增的 zstd 帧。
 */
export function createLogTail(file) {
  let offset = 0
  let lineBuf = ''
  let sessionId = path.basename(path.dirname(file))
  let started = false

  function bootstrap() {
    let records = []
    try {
      const buf = fs.readFileSync(file)
      const { text } = decodeFrames(buf, 0)
      const taken = takeRecords('', text)
      records = taken.records
      lineBuf = ''
      offset = buf.length
    } catch (err) {
      offset = 0
    }
    for (const rec of records) {
      if (rec && rec.type === 'session' && typeof rec.id === 'string' && rec.id) sessionId = rec.id
    }
    started = true
    return { records, sessionId, bootstrap: true }
  }

  function readNew() {
    if (!started) return bootstrap()
    let st
    try { st = fs.statSync(file) } catch (err) { return null }
    if (st.size < offset) {
      // 文件被截断/重建（版本迁移等）⇒ 重新引导
      offset = 0
      lineBuf = ''
      started = false
      return bootstrap()
    }
    if (st.size === offset) return null
    let buf
    try { buf = fs.readFileSync(file) } catch (err) { return null }
    const tail = buf.subarray(offset)
    const { text, nextOffset } = decodeFrames(tail, 0)
    offset = Math.min(buf.length, offset + nextOffset)
    if (!text) return null
    const taken = takeRecords(lineBuf, text)
    lineBuf = taken.lineBuf
    return { records: taken.records, sessionId, bootstrap: false }
  }

  return {
    file,
    get sessionId() { return sessionId },
    bootstrap,
    readNew,
  }
}

/** 从一批记录里提取插件需要的状态（会话标题 / 最后一轮 / 进行中的一轮）。 */
export function summarizeRecords(records) {
  let title = ''
  let lastTurnEnd = -1
  let lastTurnStart = -1
  let lastTurnNumber = null
  let lastTurnStartIndex = -1
  records.forEach((rec, i) => {
    if (!rec || typeof rec.type !== 'string') return
    if (rec.type === 'session/title' && rec.data && typeof rec.data.title === 'string' && rec.data.title.trim()) {
      title = rec.data.title.trim().slice(0, 120)
    }
    if (rec.type === 'turn/start') { lastTurnStart = i; lastTurnStartIndex = i }
    if (rec.type === 'turn/end') {
      lastTurnEnd = i
      const t = rec.data && rec.data.turn
      if (Number.isFinite(Number(t))) lastTurnNumber = Number(t)
    }
  })
  return { title, lastTurnEnd, lastTurnStart, lastTurnNumber, lastTurnStartIndex }
}
