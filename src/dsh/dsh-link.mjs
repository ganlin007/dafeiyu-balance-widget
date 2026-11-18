// dsh-link.mjs — DSH 联动：检测本机 DSH 是否在跑，在跑就把「每轮消耗 / 提问·授权提醒 / 对话名」
// 这几项依赖会话事件的功能点亮。
//
// 为什么分两种模式（关键：不能把账记两遍）：
//   桌面端与 DSH 共用同一个 $DSH_HOME（用户选定）。如果运行的 DSH 里**也装了本插件**
//   （实测：GET /dsh-whale/balance.json 返回 401 = 路由已注册，只有装了插件才有），
//   那么同一轮对话会被两个插件实例各记一次 —— 账本的 events（用量记录 / 本机模型费用）会翻倍。
//   （余额口径的「今日已用」不会翻倍：observeBalance 按共享 lastUnits 求差、且拒绝乱序样本。）
//   所以：
//     · display 模式（DSH 已装本插件）—— **只读**联动：不再往插件里投事件，
//       改成覆写两个只读接口，把 DSH 已经记好的数据端给桌面端界面。不写任何文件 ⇒ 不可能重复记账。
//     · account 模式（DSH 在跑但没装本插件）—— 桌面端就是唯一的记账者，
//       把会话日志合成为 session/event 投给插件，走插件自己的记账/挂起逻辑。
//   DSH 没在跑时：off（功能静默失效，与用户选择一致）。
// 可用环境变量 DSHW_LINK_MODE=display|account|off 强制指定。
import fs from 'node:fs'
import path from 'node:path'
import { detectDsh, probeWhaleRoute } from './detect.mjs'
import { createLogTail, listSessionFiles } from './session-log.mjs'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) { return null }
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 1e8) / 1e8
}

/**
 * @param {{ home: string, host: any, logger?: Console, detectMs?: number, tickMs?: number }} opts
 */
export function createDshLink({ home, host, logger = console, detectMs = 10000, tickMs = 1500 }) {
  const turnFile = path.join(home, '.dshw-turn.json')
  const ledgerFile = path.join(home, '.dshw-usage.json')
  const forced = String(process.env.DSHW_LINK_MODE || '').toLowerCase()

  let mode = 'off'
  let dsh = { running: false, port: null, evidence: null }
  let foreignWhale = false
  const overrideDisposers = []
  const tails = new Map()
  const waitState = { pending: null, sessionName: '' }
  let lastTurnNumber = null
  let detectTimer = null
  let tickTimer = null
  let busy = false

  function log(...args) { try { logger.log('[dsh-link]', ...args) } catch (err) {} }

  // —— display 模式：挂起状态机（与插件 notePendingEvent 的语义一致，只用于展示） ——
  function notePending(record) {
    try {
      const type = String((record && record.type) || '')
      const data = (record && record.data) || {}
      const now = Date.now()
      if (type === 'session/title') {
        const ti = String(data.title == null ? '' : data.title).trim()
        if (ti) waitState.sessionName = ti.slice(0, 120)
        return
      }
      if (type === 'tool/call' && String(data.name || data.toolName || '') === 'ask_user_question') {
        const id = String(data.callId || data.call_id || data.toolCallId || '') || ('q' + now)
        waitState.pending = { kind: 'question', id, ts: now, session: null }
        return
      }
      if (type === 'tool/result') {
        if (waitState.pending && waitState.pending.kind === 'question') {
          const cid = String(data.callId || data.call_id || data.toolCallId || (data.message && data.message.callId) || (data.message && data.message.toolCallId) || '')
          if (!cid || cid === waitState.pending.id) waitState.pending = null
        }
        return
      }
      if (type === 'approval/asked') {
        waitState.pending = { kind: 'approval', id: String(data.id || ('a' + now)), ts: now, session: null }
        return
      }
      if (type.indexOf('approval/') === 0) {
        if (waitState.pending && waitState.pending.kind === 'approval') {
          const id2 = String(data.id || '')
          if (!id2 || id2 === waitState.pending.id) waitState.pending = null
        }
        return
      }
      if (type === 'turn/start' || type === 'turn/end') waitState.pending = null
    } catch (err) {}
  }

  function noteTurn(record) {
    if (!record) return
    if (record.type === 'turn/end') {
      const t = record.data && record.data.turn
      if (Number.isFinite(Number(t))) lastTurnNumber = Number(t)
    }
    if (record.type === 'assistant/message') {
      const t = record.data && record.data.turn
      if (Number.isFinite(Number(t))) lastTurnNumber = Number(t)
    }
  }

  /** display 模式：直接读 DSH 已经写好的账本与 seq，拼出与插件同形状的 last-turn 响应。 */
  function displayLastTurn() {
    const turnState = readJson(turnFile) || {}
    const seq = Number(turnState.seq) || 0
    const led = readJson(ledgerFile) || {}
    const events = Array.isArray(led.events) ? led.events : []
    const dated = events
      .map((e) => ({ ts: Number(e && e.ts) || 0, cost: Number(e && e.cost) || 0, tokens: Number(e && e.tokens) || 0 }))
      .filter((e) => e.ts > 0)
    if (!dated.length) return { ok: true, seq, turn: null, amount: null, tokens: null, ts: null }
    let lastTs = 0
    for (const e of dated) if (e.ts > lastTs) lastTs = e.ts
    // 同一轮里每个模型写一条事件、ts 相同（插件 finalizeTurn 的 agg.lastTs）⇒ 按 ts 聚合即该轮总额
    const batch = dated.filter((e) => e.ts === lastTs)
    let amount = 0
    let tokens = 0
    for (const e of batch) { amount += e.cost; tokens += e.tokens }
    return { ok: true, seq, turn: lastTurnNumber == null ? 0 : lastTurnNumber, amount: roundMoney(amount), tokens, ts: lastTs }
  }

  function installOverrides() {
    if (overrideDisposers.length) return
    if (!host.webServer || typeof host.webServer.override !== 'function') {
      // 这里绝不能静默返回：装不上覆写 ⇒ last-turn/wait 会退回插件自己的内存态（永远是空），
      // 表现就是「DSH 在跑但每轮消耗/提问提醒不出现」。
      log('❌ display 模式装不上只读覆写：host.webServer.override 不可用（DSH 联动会失效）')
      return
    }
    overrideDisposers.push(host.webServer.override('/dsh-whale/last-turn.json', (req, res) => {
      let payload
      try { payload = displayLastTurn() } catch (err) {
        payload = { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }
      }
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(payload))
    }))
    overrideDisposers.push(host.webServer.override('/dsh-whale/wait.json', (req, res) => {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({
        ok: true,
        pending: waitState.pending,
        sessionName: waitState.sessionName || '',
      }))
    }))
    log('display 模式：已接管 /dsh-whale/last-turn.json 与 /dsh-whale/wait.json（只读，不写账本）')
  }

  function removeOverrides() {
    while (overrideDisposers.length) {
      try { overrideDisposers.pop()() } catch (err) {}
    }
  }

  function resetTails() {
    tails.clear()
    waitState.pending = null
    waitState.sessionName = ''
    lastTurnNumber = null
  }

  function setMode(next) {
    if (next === mode) return
    log(`模式切换：${mode} → ${next}`)
    mode = next
    resetTails()
    if (next === 'display') installOverrides()
    else removeOverrides()
  }

  /** 首次见到某个会话日志：account 模式补投「进行中那一轮」的用量，display 模式只重建展示状态。 */
  function handleBootstrap(tail) {
    const boot = tail.bootstrap()
    const records = boot.records || []
    for (const rec of records) {
      noteTurn(rec)
      notePending(rec)
    }
    if (mode !== 'account') return
    // 找出仍在进行中的轮次（最后一次 turn/start 晚于最后一次 turn/end）
    let lastStart = -1
    let lastEnd = -1
    records.forEach((r, i) => {
      if (!r) return
      if (r.type === 'turn/start') lastStart = i
      if (r.type === 'turn/end') lastEnd = i
    })
    const session = { id: tail.sessionId, name: waitState.sessionName || '' }
    for (const rec of records) {
      if (rec && rec.type === 'session/title') emit(session, rec)
    }
    if (lastStart > lastEnd) {
      const turn = records[lastStart].data && records[lastStart].data.turn
      for (let i = lastStart; i < records.length; i++) {
        const rec = records[i]
        if (rec && rec.type === 'assistant/message' && Number(rec.data && rec.data.turn) === Number(turn)) {
          emit(session, rec)
        }
      }
      log(`account 模式：补投进行中的第 ${turn} 轮用量（${tail.sessionId}）`)
    }
  }

  function emit(session, record) {
    try { host.emit('session/event', session, record) } catch (err) {}
  }

  function handleRecords(tail, records) {
    for (const rec of records) {
      noteTurn(rec)
      notePending(rec)
      if (mode === 'account') emit({ id: tail.sessionId, name: waitState.sessionName || '' }, rec)
    }
  }

  function tick() {
    if (mode === 'off') return
    let files = []
    try { files = listSessionFiles(home) } catch (err) { return }
    const alive = new Set()
    for (const f of files) {
      alive.add(f.file)
      let tail = tails.get(f.file)
      if (!tail) {
        tail = createLogTail(f.file)
        tails.set(f.file, tail)
        try { handleBootstrap(tail) } catch (err) {}
        continue
      }
      let res = null
      try { res = tail.readNew() } catch (err) {}
      if (res && res.records && res.records.length) handleRecords(tail, res.records)
    }
    for (const key of [...tails.keys()]) if (!alive.has(key)) tails.delete(key)
  }

  async function detect() {
    if (busy) return
    busy = true
    try {
      const found = await detectDsh()
      dsh = found
      foreignWhale = found.running ? await probeWhaleRoute(found.port).catch(() => false) : false
      let next
      if (forced === 'off' || forced === 'display' || forced === 'account') next = forced
      else if (!found.running) next = 'off'
      else next = foreignWhale ? 'display' : 'account'
      setMode(next)
    } catch (err) {
      log('检测失败：' + String((err && err.message) || err))
    } finally {
      busy = false
    }
  }

  return {
    start() {
      if (detectTimer) return
      detect().catch(() => {})
      detectTimer = setInterval(() => { detect().catch(() => {}) }, detectMs)
      tickTimer = setInterval(tick, tickMs)
      try { detectTimer.unref && detectTimer.unref() } catch (err) {}
      try { tickTimer.unref && tickTimer.unref() } catch (err) {}
    },
    stop() {
      if (detectTimer) clearInterval(detectTimer)
      if (tickTimer) clearInterval(tickTimer)
      detectTimer = null
      tickTimer = null
      setMode('off')
    },
    /** 诊断用状态（不含任何密钥）。 */
    status() {
      return {
        mode,
        dshRunning: dsh.running,
        dshPort: dsh.port,
        dshEvidence: dsh.evidence,
        dshHasWhalePlugin: foreignWhale,
        sessions: tails.size,
        lastTurnNumber,
        pending: waitState.pending ? waitState.pending.kind : null,
        sessionName: waitState.sessionName,
      }
    },
  }
}
