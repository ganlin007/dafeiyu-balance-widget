// zstd-frames.mjs — 解析 DSH 会话日志用的“多帧 zstd”读取器。
//
// 背景：DSH 的会话日志是 $DSH_HOME/sessions/<工作区>/<会话>/session*.jsonl.zstd，
// 内容是**逐个 zstd 帧拼接**的追加日志（实测一份 280KB 的文件里有 232 个帧）。
// Node 的 zlib.zstdDecompressSync 只解第一帧就停，Electron 各版本的 zstd 支持也不一致，
// 所以这里自己按 zstd 帧格式切帧（只用帧头 + 块头做边界计算，不解码），
// 再交给纯 JS 的 fzstd 逐帧解压 —— 不依赖原生模块，也不依赖 Node 版本。
import fs from 'node:fs'
import { decompress } from 'fzstd'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f

/**
 * 从头扫描连续的 zstd 帧。
 * @returns {{ frames: Array<[number, number]>, nextOffset: number }}
 *          frames 为 [start, end) 字节区间；nextOffset 是最后一个**完整**帧之后的偏移，
 *          若尾部有写了一半的帧，nextOffset 停在该帧起点（下次从那里继续读）。
 */
export function splitFrames(buf, start = 0) {
  const frames = []
  let off = start
  const need = (n) => off + n <= buf.length
  while (need(4)) {
    const magic = buf.readUInt32LE(off)
    if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
      if (!need(8)) break
      const size = buf.readUInt32LE(off + 4)
      if (!need(8 + size)) break
      frames.push([off, off + 8 + size])
      off += 8 + size
      continue
    }
    if (magic !== ZSTD_MAGIC) break // 不是帧（截断/损坏）→ 停在这里
    const frameStart = off
    let p = off + 4
    if (p + 1 > buf.length) break
    const fhd = buf[p]; p += 1
    const fcsFlag = fhd >> 6
    const singleSegment = (fhd >> 5) & 1
    const checksum = (fhd >> 2) & 1
    const dictFlag = fhd & 3
    if (!singleSegment) p += 1
    p += [0, 1, 2, 4][dictFlag]
    if (fcsFlag === 0) { if (singleSegment) p += 1 }
    else p += [0, 2, 4, 8][fcsFlag]
    if (p > buf.length) break // 帧头没写完
    let complete = true
    for (;;) {
      if (p + 3 > buf.length) { complete = false; break }
      const h = buf.readUInt32LE(p) & 0xffffff
      p += 3
      const last = h & 1
      const type = (h >> 1) & 3
      const size = h >> 3
      if (type === 3) { complete = false; break } // Reserved：数据不可信
      const payload = type === 1 ? 1 : size
      if (p + payload > buf.length) { complete = false; break }
      p += payload
      if (last) break
    }
    if (!complete) break
    if (checksum) {
      if (p + 4 > buf.length) break
      p += 4
    }
    frames.push([frameStart, p])
    off = p
  }
  return { frames, nextOffset: off }
}

/**
 * 解出 [start, EOF) 区间内的完整帧文本。
 * @returns {{ text: string, nextOffset: number, frameCount: number }}
 */
export function decodeFrames(buf, start = 0) {
  const { frames, nextOffset } = splitFrames(buf, start)
  const parts = []
  for (const [s, e] of frames) {
    try { parts.push(Buffer.from(decompress(buf.subarray(s, e)))) } catch (err) { /* 单帧坏掉不影响其它帧 */ }
  }
  return { text: Buffer.concat(parts).toString('utf8'), nextOffset, frameCount: frames.length }
}

/** 读取整个日志文件并解出全部文本（用于激活时的状态引导）。 */
export function decodeFile(file) {
  return decodeFrames(fs.readFileSync(file), 0)
}
