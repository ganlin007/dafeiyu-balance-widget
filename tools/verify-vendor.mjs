// verify-vendor.mjs — 证明「别的功能都没改动」：vendor/dsh-whale 下的文件必须与上游逐字节一致。
//
// 两级校验：
//   ① 与 tools/vendor-manifest.json 里的 sha256 比对（自包含，离线可用）
//   ② 若工作区里还有上游源码副本（whale-src/，由 _fetch_whale.mjs 抓取），再逐字节比对一次
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'vendor', 'dsh-whale')
const MANIFEST = path.join(ROOT, 'tools', 'vendor-manifest.json')
const UPSTREAM = path.resolve(ROOT, '..', 'whale-src')

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

let bad = 0
let checked = 0
const rows = []
for (const [rel, want] of Object.entries(manifest.files)) {
  const p = path.join(VENDOR, rel)
  if (!fs.existsSync(p)) { rows.push(`MISSING  ${rel}`); bad++; continue }
  const got = sha(fs.readFileSync(p))
  checked++
  if (got !== want) { rows.push(`MODIFIED ${rel}\n   期望 ${want}\n   实际 ${got}`); bad++ }
}
for (const line of rows) console.log(line)
console.log(`\n① 清单校验：${checked}/${Object.keys(manifest.files).length} 个文件与上游哈希一致${bad ? `，${bad} 个异常` : ''}`)

if (fs.existsSync(UPSTREAM)) {
  let diff = 0
  let n = 0
  const upstreamFiles = [
    ['lib/index.js', 'lib/index.js'],
    ['lib/accounting.mjs', 'lib/accounting.mjs'],
    ['assets/whale-widget.js', 'assets/whale-widget.js'],
  ]
  for (const name of fs.readdirSync(path.join(UPSTREAM, 'assets'))) {
    upstreamFiles.push(['assets/' + name, 'assets/' + name])
  }
  for (const [upRel, vRel] of upstreamFiles) {
    const up = path.join(UPSTREAM, upRel)
    const vn = path.join(VENDOR, vRel)
    if (!fs.existsSync(up)) continue
    n++
    if (!fs.existsSync(vn) || sha(fs.readFileSync(up)) !== sha(fs.readFileSync(vn))) {
      console.log(`DIFF     ${vRel}`)
      diff++
    }
  }
  console.log(`② 与上游源码副本逐字节比对：${n - diff}/${n} 一致${diff ? `，${diff} 个不同` : ''}`)
  console.log(`   上游 commit：${manifest.upstreamCommit}（版本 ${manifest.upstreamVersion}）`)
  if (diff) bad += diff
} else {
  console.log('② 未找到上游源码副本（../whale-src），跳过逐字节比对')
}

if (bad) {
  console.log('\n结论：vendor 里有文件与上游不一致 —— 这违反了「不改动其它功能」的要求。')
  process.exit(1)
}
console.log('\n结论：vendor/dsh-whale 与上游逐字节一致，插件本体一行未改。')
