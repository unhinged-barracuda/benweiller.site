// Renders the favicon set and the link-preview image from the Favicon and Link-Preview boards into public/.
//   node tools/build.mjs && node tools/serve.mjs & node tools/make-icons.mjs
import fs from 'node:fs'; import { chromium } from 'playwright';
const read = (n) => { const s = fs.readFileSync(`design/boards/${n}.dc.html`, 'utf8');
  const x = s.slice(s.indexOf('<x-dc>'), s.lastIndexOf('</x-dc>') + 7).replace(/\/_blob\/([0-9a-f]{32})/g, (m, id) => { const f = fs.readdirSync('design/assets').find(f => f.startsWith(id)); return f ? '/assets/' + f : m; });
  const sm = s.match(/<script type="text\/x-dc"([^>]*)>([\s\S]*?)<\/script>/); return { x, logic: sm[2] }; };
fs.mkdirSync('dist/_tool', { recursive: true });
for (const n of ['Favicon', 'Link-Preview']) { const b = read(n);
  fs.writeFileSync(`dist/_tool/${n}.html`, `<!doctype html><html><head><meta charset="utf-8"><script src="/dc-lite.js" defer></script></head><body style="margin:0"><div id="dc-root"></div><template id="dc-desktop">${b.x}</template><script type="text/x-dc" id="dc-desktop-logic" data-props='{}'>${b.logic}</script></body></html>`); }
const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 4 });
await p.goto('http://localhost:8788/_tool/Favicon.html'); await p.waitForTimeout(1500); await p.evaluate(() => document.fonts.ready);
// the primary tile: ink BW on the ground colour
const tile = p.locator('.bw').filter({ hasText: 'BW' }).nth(0);
for (const [file, px] of [['icon-512.png', 512], ['apple-touch-icon.png', 180], ['favicon-32.png', 32], ['favicon-16.png', 16]]) {
  await p.setViewportSize({ width: 1600, height: 1200 });
  const el = px >= 180 ? tile : p.locator('figure .bw').filter({ hasText: 'BW' }).nth(px === 32 ? 2 : 3);
  await el.evaluate((n) => { n.style.boxShadow = 'none'; n.style.borderRadius = '0'; });
  await el.screenshot({ path: `public/${file}` });
}
const p2 = await br.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1200 / 640 });
await p2.goto('http://localhost:8788/_tool/Link-Preview.html'); await p2.waitForTimeout(1500); await p2.evaluate(() => document.fonts.ready);
await p2.locator('svg[aria-label^="Share image"]').first().screenshot({ path: 'public/og.png' });
await br.close();
