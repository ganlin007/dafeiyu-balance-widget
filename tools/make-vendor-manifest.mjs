// Regenerate tools/vendor-manifest.json from the vendored tree.
// Run: node tools/make-vendor-manifest.mjs [upstreamCommit]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'dsh-whale');
const OUT = path.join(ROOT, 'tools', 'vendor-manifest.json');

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

const files = {};
for (const rel of walk(VENDOR)) {
  files[rel] = createHash('sha256').update(fs.readFileSync(path.join(VENDOR, rel))).digest('hex');
}

const manifest = {
  note: 'Vendored verbatim from the upstream DSH plugin. Do not edit these files; regenerate this manifest if the upstream revision changes.',
  upstream: 'https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget',
  upstreamCommit: process.argv[2] || '770d3f55ff40284eb244fff33fc9ed4654be8a45',
  upstreamVersion: '0.3.18',
  files,
};
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${OUT} (${Object.keys(files).length} files)`);
