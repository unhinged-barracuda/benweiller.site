// Builds the static site in dist/ from the design boards in design/boards/ and the assets in design/assets/.
//   node tools/build.mjs
// Each page holds its desktop board and its mobile board (as inert <template>s); dc-lite.js picks one on load.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ROUTES, SITE, ALIASES } from './routes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARDS = path.join(ROOT, 'design/boards');
const ASSETS = path.join(ROOT, 'design/assets');
const OUT = path.join(ROOT, 'dist');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---- assets: /_blob/<id> -> /assets/<id>.<ext> ----
// design/web/ holds lighter copies made by tools/optimize-assets.mjs (WebP at 800 / 1600 / full width,
// and the font as WOFF); where one exists it is served in place of the original.
const WEB = path.join(ROOT, 'design/web');
const IMG = fs.existsSync(path.join(WEB, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.json'), 'utf8')) : {};
const assetFile = {};
if (fs.existsSync(ASSETS)) {
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(ASSETS)) {
    const id = f.split('.')[0];
    const web = fs.existsSync(WEB) ? fs.readdirSync(WEB).filter((w) => w.startsWith(id)) : [];
    if (web.length) {
      for (const w of web) fs.copyFileSync(path.join(WEB, w), path.join(OUT, 'assets', w));
      assetFile[id] = web.find((w) => !w.includes('-')) || f;
    } else {
      assetFile[id] = f;
      fs.copyFileSync(path.join(ASSETS, f), path.join(OUT, 'assets', f));
    }
  }
}
const missing = new Set();
// assets not yet pulled from the canvas: show the previous version until the file is added to design/assets
const STANDIN = { '0227a1dd2baf79edf03b8d02e472b531': 'c3c1d5143a6d216d022cfa1f61762c82' /* vicks menu thumbnail v3 -> v2 */ };
function rewriteAssets(s) {
  // canvas exports write assets as relative "assets/<id>.<ext>"; the canvas itself uses "/_blob/<id>"
  s = s.replace(/(^|[^\w/.])(?:\.\/)?assets\/([0-9a-f]{32})\.[a-z0-9]+/g, (m, pre, id) => pre + '/_blob/' + id);
  return s.replace(/\/_blob\/([0-9a-f]{32})/g, (m, id) => {
    if (!assetFile[id] && STANDIN[id] && assetFile[STANDIN[id]]) { missing.add(id + ' (stand-in used)'); id = STANDIN[id]; }
    if (!assetFile[id]) { missing.add(id); return m; }
    return '/assets/' + assetFile[id];
  }).replace(/(url\(['"]?\/assets\/[0-9a-f]{32}\.woff['"]?\)\s*format\(['"])opentype(['"]\))/g, '$1woff$2');
}

// ---- board links: Foo.dc.html -> its route ----
const boardRoute = {};
for (const r of ROUTES) { for (const b of [r.desktop, r.mobile]) if (b) boardRoute[b] = r.path; }
Object.assign(boardRoute, ALIASES);
const unknownLinks = new Set();
function rewriteLinks(s) {
  return s.replace(/(["'(=\s])(?:\.\/|\/)?([A-Za-z0-9_][A-Za-z0-9_.-]*)\.dc\.html(#[A-Za-z0-9_-]*)?/g, (m, pre, name, hash) => {
    const r = boardRoute[name];
    if (!r) unknownLinks.add(name);
    return pre + (r || '/') + (hash || '');
  });
}

// ---- read one board ----
function readBoard(name) {
  const file = path.join(BOARDS, name + '.dc.html');
  const src = fs.readFileSync(file, 'utf8');
  const x0 = src.indexOf('<x-dc>');
  const x1 = src.lastIndexOf('</x-dc>');
  if (x0 < 0 || x1 < 0) throw new Error('no <x-dc> in ' + name);
  const xdc = src.slice(x0, x1 + 7);
  const sm = src.match(/<script type="text\/x-dc"([^>]*)>([\s\S]*?)<\/script>/);
  if (!sm) throw new Error('no logic script in ' + name);
  const pm = sm[1].match(/data-props='([^']*)'/);
  const tm = src.match(/<title>([\s\S]*?)<\/title>/);
  return { xdc, logic: sm[2], props: pm ? pm[1] : '{}', title: tm ? tm[1] : '' };
}

// Canvas-only controls (marked aria-label="Mockup only" on the board) are left out of the live site.
function stripMockup(s) {
  for (;;) {
    const i = s.search(/<div[^>]*aria-label="Mockup only"[^>]*>/);
    if (i < 0) return s;
    let depth = 0, j = i;
    const re = /<\/?div\b[^>]*>/g; re.lastIndex = i;
    let m;
    while ((m = re.exec(s))) { depth += m[0][1] === '/' ? -1 : 1; if (depth === 0) { j = re.lastIndex; break; } }
    s = s.slice(0, i) + s.slice(j);
  }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function page(r) {
  const parts = [];
  for (const kind of ['desktop', 'mobile']) {
    const name = r[kind];
    if (!name) continue;
    const b = readBoard(name);
    const xdc = rewriteLinks(rewriteAssets(stripMockup(b.xdc)));
    const logic = rewriteLinks(rewriteAssets(b.logic));
    if (/<\/script/i.test(logic)) throw new Error('</script> inside logic of ' + name);
    parts.push(`<template id="dc-${kind}" data-board="${name}">${xdc}</template>\n<script type="text/x-dc" id="dc-${kind}-logic" data-props='${b.props}'>${logic}</script>`);
  }
  const used = {};
  for (const m of parts.join('').matchAll(/\/assets\/([0-9a-f]{32})\.webp/g)) if (IMG[m[1]] && IMG[m[1]].v.length) used[m[1]] = IMG[m[1]];
  // the browser-tab title is the desktop board's own <title> (e.g. "Ben Weiller \\ Kia K5 GT")
  const title = (readBoard(r.desktop).title || SITE.name).trim();
  const url = SITE.origin + (r.path === '/404' ? '/' : r.path);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(r.description || SITE.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:title" content="${esc(SITE.name)}">
<meta property="og:description" content="${esc(r.description || SITE.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE.origin}/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#F1F1EE">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" href="/assets/${assetFile['a15098c6e2313273da5b37f609489781'] || ''}" as="font" type="font/woff" crossorigin>
<style>html,body{margin:0;background:#F1F1EE;overscroll-behavior:none}.page{overscroll-behavior:none}html.noblend .fab{mix-blend-mode:normal!important}html.noglass *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}#dc-root{min-height:100vh}</style><script>for(const k of ['noblend','noglass'])if(location.search.includes(k))document.documentElement.classList.add(k)</script><style>
::view-transition-old(root),::view-transition-new(root){animation-duration:.65s;animation-timing-function:cubic-bezier(.3,.7,.2,1)}
@media (prefers-reduced-motion: reduce){::view-transition-old(root),::view-transition-new(root){animation:none}}</style>
<script>window.__DC_PAGE__=${JSON.stringify({ tabletMobile: !!r.tabletMobile, preload: !!r.preload, backUp: r.backUp || null })};window.__IMG__=${JSON.stringify(used)}</script>
<script src="/dc-lite.js?v=${SITE.build}" defer></script>
</head>
<body>
<div id="dc-root"></div>
<noscript><p style="font:14px Inter,system-ui,sans-serif;padding:4vw">${esc(SITE.name)} — this portfolio needs JavaScript turned on.</p></noscript>
${parts.join('\n')}
</body>
</html>
`;
}

for (const r of ROUTES) {
  const html = page(r);
  const dest = r.path === '/404' ? path.join(OUT, '404.html') : path.join(OUT, r.path, 'index.html');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, html);
}

// ---- runtime bundle ----
await build({
  entryPoints: [path.join(ROOT, 'src/dc-lite.js')],
  bundle: true, minify: true, format: 'iife', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: path.join(OUT, 'dc-lite.js'), logLevel: 'warning',
});

// ---- static files (favicons, fonts, og image, headers, redirects) ----
const PUB = path.join(ROOT, 'public');
if (fs.existsSync(PUB)) fs.cpSync(PUB, OUT, { recursive: true });

if (missing.size) console.warn('MISSING ASSETS (' + missing.size + '):', [...missing].join(' '));
if (unknownLinks.size) console.warn('UNMAPPED BOARD LINKS → /:', [...unknownLinks].join(' '));
console.log('built', ROUTES.length, 'pages');
