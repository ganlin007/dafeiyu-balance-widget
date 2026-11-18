// credentials.mjs — 与 @deepseek-ai/dsh-credentials(-local) 兼容的凭据服务。
//
// 目标：桌面端与 DSH **共用同一份密钥**。读取顺序与 DSH 完全一致：
//   ① 启动环境变量 → ② 存储文件 $DSH_HOME/.credentials.yaml 的 refs 段 → ③ 项目 .env → ④ $DSH_HOME/.env
// 写入只做**外科手术式行编辑**：只动 refs 段里那一行，其余字节（含 records 段、注释、排版）原样保留，
// 这样 DSH 端的凭据文档不会被桌面端破坏。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REF_LINE = /^(\s+)([^\s:#][^:]*):(?:\s*(.*))?$/

/** 读取 YAML 标量（含引号、块标量），返回 { value, nextIndex }。 */
function readScalar(raw, lines, lineIndex, indent) {
  const text = String(raw == null ? '' : raw).trim()
  // 块标量：| |+ |- > >+ >-
  const block = /^([|>])([+-]?)(\d*)$/.exec(text)
  if (block) {
    const style = block[1]
    const chomp = block[2]
    const body = []
    let i = lineIndex + 1
    let minIndent = Infinity
    for (; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '') { body.push(''); continue }
      const ind = line.match(/^\s*/)[0].length
      if (ind <= indent) break
      minIndent = Math.min(minIndent, ind)
    }
    // 重新收集，按 minIndent 去掉缩进
    const collected = []
    let j = lineIndex + 1
    for (; j < i; j++) {
      const line = lines[j]
      collected.push(line.trim() === '' ? '' : line.slice(Math.min(minIndent, line.length)))
    }
    while (collected.length && collected[collected.length - 1] === '') collected.pop()
    const joined = style === '|' ? collected.join('\n') : collected.join(' ').replace(/\s+/g, ' ').trim()
    const value = chomp === '-' ? joined.replace(/\n+$/, '') : chomp === '+' ? joined + '\n' : joined + '\n'
    return { value, nextIndex: Math.max(lineIndex, j - 1) }
  }
  if (text.startsWith('"')) {
    try { return { value: String(JSON.parse(text)), nextIndex: lineIndex } } catch (err) {}
    // 非标准双引号（YAML 允许 \x \u 等转义）：手工剥离
    const m = /^"([\s\S]*)"$/.exec(text)
    if (m) return { value: m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'), nextIndex: lineIndex }
  }
  if (text.startsWith("'")) {
    const m = /^'([\s\S]*)'$/.exec(text)
    if (m) return { value: m[1].replace(/''/g, "'"), nextIndex: lineIndex }
  }
  // 纯标量：去掉行尾注释（# 前必须有空白）
  const plain = text.replace(/\s+#.*$/, '').trim()
  if (plain === '' || plain === '~' || plain === 'null') return { value: '', nextIndex: lineIndex }
  return { value: plain, nextIndex: lineIndex }
}

/** 解析 refs 段（只需要键值对；records 段不碰）。 */
export function parseRefs(text) {
  const lines = String(text || '').split(/\r?\n/)
  const refs = {}
  const start = lines.findIndex((l) => /^refs:\s*$/.test(l))
  if (start < 0) return refs
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^\S/.test(line)) break // 回到顶层键
    if (/^\s*#/.test(line)) continue
    const m = REF_LINE.exec(line)
    if (!m) continue
    const key = m[2].trim()
    const indent = m[1].length
    const parsed = readScalar(m[3], lines, i, indent)
    i = parsed.nextIndex
    refs[key] = parsed.value
  }
  return refs
}

/** 渲染成可安全写回 YAML 的标量。 */
function renderScalar(value) {
  const s = String(value == null ? '' : value)
  if (s.includes('\n')) {
    const body = s.replace(/\n$/, '').split('\n').map((l) => '    ' + l).join('\n')
    return '|-\n' + body
  }
  if (s === '') return '""'
  // 纯标量只允许最保守的安全字符集；其余一律 JSON 双引号（YAML 双引号是 JSON 超集）
  if (/^[A-Za-z0-9_\-./+@]{1,512}$/.test(s)) return s
  return JSON.stringify(s)
}

function refsBlockRange(lines) {
  const start = lines.findIndex((l) => /^refs:\s*$/.test(l))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length) {
    const l = lines[end]
    if (l.trim() === '') { end++; continue }
    if (/^\S/.test(l)) break
    end++
  }
  return { start, end }
}

export function createCredentials({ home } = {}) {
  const dshHome = home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = path.join(dshHome, '.credentials.yaml')
  const envFiles = [path.join(process.cwd(), '.env'), path.join(dshHome, '.env')]

  function readFileText() {
    try { return fs.readFileSync(file, 'utf8') } catch (err) { return '' }
  }

  function writeFileText(text) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
  }

  function dotenvLookup(ref) {
    for (const p of envFiles) {
      try {
        const text = fs.readFileSync(p, 'utf8')
        for (const line of text.split(/\r?\n/)) {
          const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
          if (!m || m[1] !== ref) continue
          let v = m[2].trim()
          if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1)
          return v
        }
      } catch (err) {}
    }
    return null
  }

  /**
   * 解析一个凭据引用。
   * ⚠️ 返回结构必须与 DSH 一致：`{ value, source }`（插件读的是 `cred.value`，见 vendor 的
   * `fetchApiKeyBalance`；早期这里返回裸字符串，导致实际发出 `Bearer undefined` → 余额接口 401）。
   * 未配置时返回 undefined。
   */
  async function resolve(ref) {
    const key = String(ref == null ? '' : ref).trim()
    if (!key) return undefined
    const fromEnv = process.env[key]
    if (fromEnv !== undefined && fromEnv !== '') return { value: String(fromEnv), source: 'environment' }
    const refs = parseRefs(readFileText())
    if (Object.prototype.hasOwnProperty.call(refs, key) && refs[key] !== '') {
      return { value: refs[key], source: 'store' }
    }
    const fromDotenv = dotenvLookup(key)
    if (fromDotenv !== null && fromDotenv !== '') return { value: fromDotenv, source: 'dotenv' }
    return undefined
  }

  async function describe(ref) {
    const key = String(ref == null ? '' : ref).trim()
    if (!key) return { configured: false, source: null, writable: true }
    if (process.env[key]) return { configured: true, source: 'environment', writable: false }
    const refs = parseRefs(readFileText())
    if (Object.prototype.hasOwnProperty.call(refs, key) && refs[key] !== '') {
      return { configured: true, source: 'store', writable: true }
    }
    if (dotenvLookup(key)) return { configured: true, source: 'dotenv', writable: true }
    return { configured: false, source: null, writable: true }
  }

  async function set(ref, value) {
    const key = String(ref == null ? '' : ref).trim()
    if (!key) throw new Error('credentials.set: empty ref')
    if (process.env[key]) throw new Error(`credentials.set: ${key} 由启动环境提供，是只读的`)
    const text = readFileText()
    const lines = text === '' ? [] : text.split(/\r?\n/)
    const rendered = `${key}: ${renderScalar(value)}`

    let range = refsBlockRange(lines)
    if (!range) {
      // 没有 refs 段：补一个（保留原有内容）
      const add = []
      if (lines.length && lines[lines.length - 1].trim() !== '') add.push('')
      if (!lines.some((l) => /^version\s*:/.test(l))) add.unshift('version: 1', '')
      add.push('refs:', '  ' + rendered)
      writeFileText(lines.concat(add).join('\n').replace(/\n+$/, '') + '\n')
      return
    }
    // 已有同名键 → 原位替换（含块标量的多行值）
    for (let i = range.start + 1; i < range.end; i++) {
      const m = REF_LINE.exec(lines[i])
      if (!m || m[2].trim() !== key) continue
      const indent = m[1]
      let j = i + 1
      while (j < range.end) {
        const l = lines[j]
        if (l.trim() === '') break
        if (l.match(/^\s*/)[0].length > indent.length) j++
        else break
      }
      lines.splice(i, j - i, indent + rendered)
      writeFileText(lines.join('\n'))
      return
    }
    // 追加到 refs 段末尾
    let insertAt = range.end
    while (insertAt > range.start + 1 && lines[insertAt - 1].trim() === '') insertAt--
    lines.splice(insertAt, 0, '  ' + rendered)
    writeFileText(lines.join('\n'))
  }

  async function unset(ref) {
    const key = String(ref == null ? '' : ref).trim()
    if (!key) return
    if (process.env[key]) throw new Error(`credentials.unset: ${key} 由启动环境提供，是只读的`)
    const text = readFileText()
    if (!text) return
    const lines = text.split(/\r?\n/)
    const range = refsBlockRange(lines)
    if (!range) return
    for (let i = range.start + 1; i < range.end; i++) {
      const m = REF_LINE.exec(lines[i])
      if (!m || m[2].trim() !== key) continue
      const indent = m[1].length
      let j = i + 1
      while (j < range.end) {
        const l = lines[j]
        if (l.trim() !== '' && l.match(/^\s*/)[0].length > indent) j++
        else break
      }
      // 删除紧邻上方的注释（属于该条目的注解）
      let from = i
      while (from - 1 > range.start && /^\s*#/.test(lines[from - 1])) from--
      lines.splice(from, j - from)
      writeFileText(lines.join('\n'))
      return
    }
  }

  return {
    resolve,
    set,
    unset,
    describe,
    /** 存储文件路径（诊断用，不含任何密钥内容）。 */
    get path() { return file },
    /** 凭据名清单（不含值）。 */
    async list() {
      return Object.keys(parseRefs(readFileText()))
    },
  }
}
