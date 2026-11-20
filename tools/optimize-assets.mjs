// Makes lighter web copies of the design's images (run after adding or replacing assets in design/assets/):
//   node tools/optimize-assets.mjs
// For every still image it writes design/web/<id>.webp (at most 2400px on the long edge) plus smaller
// <id>-800.webp and <id>-1600.webp for phones and normal screens. Animated images and films are left as they are.
// The build serves these instead of the originals; the originals stay in design/assets/ untouched.
// Needs `sharp` (npm i -D sharp) — it is only used here, not by the Cloudflare build.
import fs from 'node:fs'; import path from 'node:path'; import sharp from 'sharp';
const SRC = 'design/assets', OUT = 'design/web';
fs.mkdirSync(OUT, { recursive: true });
const manifest = {};
for (const f of fs.readdirSync(SRC)) {
  const id = f.split('.')[0], ext = path.extname(f).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) continue;
  const input = path.join(SRC, f);
  const meta = await sharp(input, { animated: true }).metadata();
  if ((meta.pages || 1) > 1) continue; // animated: keep the original
  const long = Math.max(meta.width, meta.height);
  const alpha = meta.hasAlpha;
  const widths = [];
  for (const w of [800, 1600]) if (long > w * 1.15) widths.push(w);
  const enc = (img) => img.webp({ quality: alpha ? 85 : 80, effort: 5, alphaQuality: 90 });
  const scale = (w) => meta.width >= meta.height ? { width: w } : { height: w };
  await enc(sharp(input).rotate().resize({ ...scale(Math.min(long, 2400)), withoutEnlargement: true })).toFile(path.join(OUT, id + '.webp'));
  for (const w of widths) await enc(sharp(input).rotate().resize(scale(w))).toFile(path.join(OUT, `${id}-${w}.webp`));
  // srcset widths are in CSS-image width units, so record the real pixel widths
  const full = Math.round(meta.width * Math.min(1, 2400 / long));
  manifest[id] = { w: full, v: widths.map((w) => Math.round(meta.width >= meta.height ? w : meta.width * w / meta.height)) };
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
const before = fs.readdirSync(SRC).reduce((a, f) => a + fs.statSync(path.join(SRC, f)).size, 0);
const after = fs.readdirSync(OUT).filter((f) => !f.includes('-')).reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
console.log(Object.keys(manifest).length, 'images; originals', (before / 1e6).toFixed(1), 'MB → full-size web copies', (after / 1e6).toFixed(1), 'MB');
