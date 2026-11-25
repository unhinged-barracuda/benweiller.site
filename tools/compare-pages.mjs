// Before / after check for a cleanup: renders the same pages from two local servers and compares them element by element.
//   node tools/compare-pages.mjs http://localhost:8789 http://localhost:8788 /heelys/ /vizio/ …   (old first, new second; --only=desktop or --only=iphone)
// Needs Playwright (PLAYWRIGHT=path/to/playwright/index.mjs if it isn't installed in the project).
// Same random seed on both sides, animations paused, then for each page at desktop and phone sizes it compares:
//   - every visible image, video, link, button, heading and text block: position, size and its computed look
//     (colour, type, opacity, background, shadow, blend, visibility…), matched by content, not by markup path,
//     so a rebuild may drop wrappers as long as nothing on screen moves;
//   - the same after opening the "///" menu, after opening the first expandable image, and after a carousel step;
//   - the keyboard focus look (the focused element and its ::before glass) for the first few Tab stops.
// Anything over 0.5px or with a different computed value is listed. No output under a page means identical.
const PW = process.env.PLAYWRIGHT || 'playwright';
const { chromium, devices } = await import(PW);
const args = process.argv.slice(2), only = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const [OLD, NEW, ...paths] = args.filter((a) => !a.startsWith('--'));
const ALL_SIZES = [
  ['desktop 1440x900', { viewport: { width: 1440, height: 900 } }],
  ['desktop 1280x720', { viewport: { width: 1280, height: 720 } }],
  ['iphone 390x844', { ...devices['iPhone 13'] }],
  ['iphone 375x667', { ...devices['iPhone SE'] }],
];
const SIZES = only ? ALL_SIZES.filter(([n]) => n.startsWith(only)) : ALL_SIZES; // --only=desktop / --only=iphone
const PROPS = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'textDecorationLine',
  'opacity', 'backgroundColor', 'backgroundImage', 'boxShadow', 'borderRadius', 'mixBlendMode', 'visibility', 'display', 'objectFit', 'objectPosition', 'filter', 'cursor', 'whiteSpace', 'zIndex',
  'transform', 'transitionProperty', 'transitionDuration', 'animationName', 'position', 'pointerEvents', 'backdropFilter', 'outlineStyle'];

function seed() {
  let a = 1234567;
  Math.random = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function snap(page, PROPS) {
  return page.evaluate((PROPS) => {
    // transitions (menu words, fades) run to their end; endless animations (breathing, drift) are held at their start
    document.getAnimations().forEach((a) => { try { if (a instanceof CSSTransition) a.finish(); else { a.pause(); a.currentTime = 0; } } catch (e) {} });
    const root = document.getElementById('dc-root'); const out = {}; const n = {};
    const own = (el) => [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').replace(/\s+/g, ' ').trim();
    for (const el of root.querySelectorAll('img,video,a,button,h1,h2,h3,p,span,li,figure,section,nav,svg,canvas,picture')) {
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      if (el.closest('template')) continue;
      const vis = getComputedStyle(el); if (vis.visibility === 'hidden' || vis.display === 'none' || !el.getClientRects().length) continue; // nobody sees it
      const src = el.currentSrc || el.getAttribute('src') || el.getAttribute('poster') || '';
      const id = (src.match(/[0-9a-f]{32}/) || [''])[0].slice(0, 8);
      const key = [el.tagName.toLowerCase(), (el.getAttribute('class') || '').replace(/\{\{.*?\}\}/g, '').trim(), id, el.getAttribute('aria-label') || '', el.getAttribute('href') || '', own(el).slice(0, 40)].join('|');
      if (key.replace(/\|/g, '') === el.tagName.toLowerCase() && !['svg', 'canvas', 'section', 'nav', 'figure', 'picture'].includes(el.tagName.toLowerCase())) continue; // anonymous wrappers
      n[key] = (n[key] || 0) + 1;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const sc = document.scrollingElement.scrollTop + ([...document.querySelectorAll('[data-pscroll],.page')].reduce((m, s) => m + s.scrollTop, 0));
      const look = {}; for (const p of PROPS) look[p] = String(cs[p]).replace(/https?:\/\/[^/"]+/g, ''); // same asset from either server
      out[key + '#' + n[key]] = { box: [r.x, r.y + sc, r.width, r.height].map((v) => Math.round(v * 2) / 2), look };
    }
    return out;
  }, PROPS);
}

function diff(a, b) {
  const lines = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!a[k]) { lines.push('  + only in new: ' + k); continue; }
    if (!b[k]) { lines.push('  - only in old: ' + k); continue; }
    const da = a[k].box, db = b[k].box;
    if (da.some((v, i) => Math.abs(v - db[i]) > 0.5)) lines.push('  box ' + k + '  ' + da.join(',') + ' → ' + db.join(','));
    for (const p of Object.keys(a[k].look)) if (a[k].look[p] !== b[k].look[p]) lines.push('  ' + p + ' ' + k + '  ' + a[k].look[p] + ' → ' + b[k].look[p]);
  }
  return lines;
}

async function states(ctx, base, path) {
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + path, { waitUntil: 'load' }); await page.waitForTimeout(900);
  // scroll through so lazy images load, then back to the top
  await page.evaluate(async () => {
    const s = [document.scrollingElement, ...document.querySelectorAll('[data-pscroll],.page')];
    for (let y = 0; y < 30000; y += 700) { s.forEach((e) => (e.scrollTop = y)); await new Promise((r) => setTimeout(r, 40)); }
    s.forEach((e) => (e.scrollTop = 0));
  });
  await page.waitForTimeout(700);
  const res = { page: await snap(page, PROPS) };
  // keyboard focus: first 6 Tab stops, the focused element and its ::before
  const foc = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab'); await page.waitForTimeout(60);
    foc.push(await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return 'body'; const b = getComputedStyle(e, '::before'), c = getComputedStyle(e); const r = e.getBoundingClientRect(); return [e.tagName, e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20), Math.round(r.x), Math.round(r.width), c.outlineStyle, c.boxShadow, b.content, b.background.slice(0, 60), b.transform].join(' | '); }));
  }
  res.focus = foc;
  await page.keyboard.press('Escape');
  // each state starts from the same place: nothing focused, every scroller back at the top (the Tab stops scroll the page)
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); for (const e of [document.scrollingElement, ...document.querySelectorAll('[data-pscroll],.page')]) e.scrollTop = 0; });
  await page.waitForTimeout(300);
  // the "///" menu
  const menu = page.locator('.fabBtn, button.ico[aria-controls="hdrMenuG"]').first(); // the fixed "///" on project pages, the header "///" elsewhere
  if (await menu.count()) { await menu.click({ force: true }).catch(() => {}); await page.waitForTimeout(700); res.menu = await snap(page, PROPS); await menu.click({ force: true }).catch(() => {}); await page.waitForTimeout(500); }
  // the first expandable image, and one step in it
  const xp = page.locator('#dc-root .xp').first();
  if (await xp.count()) {
    await xp.scrollIntoViewIfNeeded().catch(() => {}); await xp.click({ force: true }).catch(() => {}); await page.waitForTimeout(500); res.expanded = await snap(page, PROPS);
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400); res.expandedNext = await snap(page, PROPS);
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  }
  res.errors = errs;
  await page.close();
  return res;
}

const browser = await (await import(PW)).chromium.launch();
let total = 0;
for (const p of paths) for (const [name, opts] of SIZES) {
  const run = async (base) => { const ctx = await browser.newContext(opts); await ctx.addInitScript(seed); const r = await states(ctx, base, p); await ctx.close(); return r; };
  const [a, b] = [await run(OLD), await run(NEW)];
  const lines = [];
  for (const k of ['page', 'menu', 'expanded', 'expandedNext']) {
    if (!a[k] && !b[k]) continue;
    if (!a[k] || !b[k]) { lines.push(' [' + k + '] only on one side'); continue; }
    const d = diff(a[k], b[k]); if (d.length) lines.push(' [' + k + ']', ...d.slice(0, 40), d.length > 40 ? '  … ' + (d.length - 40) + ' more' : '');
  }
  a.focus.forEach((f, i) => { if (f !== b.focus[i]) lines.push(' [focus ' + (i + 1) + ']\n  ' + f + '\n  ' + b.focus[i]); });
  if (b.errors.length) lines.push(' [errors] ' + b.errors.join(' / '));
  const n = Object.keys(b.page).length;
  console.log(p + '  ' + name + '  (' + n + ' elements)' + (lines.filter(Boolean).length ? '' : '  identical'));
  if (lines.filter(Boolean).length) { console.log(lines.filter(Boolean).join('\n')); total++; }
}
await browser.close();
process.exit(total ? 1 : 0);
