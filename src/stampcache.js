// stampcache: SVG groups drawn through a texture filter (feTurbulence "rough"/"worn" stamp edges) are
// expensive on CPU-filter browsers (Safari): the whole filter region is recomputed whenever any shape inside
// moves (mouse-follow, SMIL wiggles). Here each shape is filtered ONCE into a bitmap, in the svg's own user
// space (so the texture is identical to the original), and a mirror group shows those bitmaps, moved with
// plain transforms. Displacement and alpha masks are per-pixel, so filtering shapes one by one and stacking
// them gives the same picture as filtering the stack. The original group stays in the DOM (React owns it),
// just hidden with its filter detached. ?nostamp turns this off.
const NS = 'http://www.w3.org/2000/svg';
const PATH_ATTRS = ['d', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linejoin', 'stroke-linecap', 'stroke-opacity', 'opacity'];
const cache = new Map(); // key -> { url, box, m0 } | { pending: Promise }
const groups = new Map(); // original g -> state

const mat = (m) => `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
function pathMatrix(p) {
  const l = p.transform && p.transform.baseVal;
  const c = l && l.numberOfItems ? l.consolidate() : null;
  return c ? DOMMatrix.fromMatrix(c.matrix) : new DOMMatrix();
}
function scaleOf(svg) {
  const m = svg.getScreenCTM();
  const s = m ? Math.hypot(m.a, m.b) : 1;
  return Math.max(0.5, Math.min(3, Math.round(s * (window.devicePixelRatio || 1) * 4) / 4));
}
function filterFor(g) {
  const ref = /url\(#([^)]+)\)/.exec(g.__scFilter || g.getAttribute('filter') || '');
  const svg = g.ownerSVGElement;
  return ref && svg ? svg.querySelector('filter#' + CSS.escape(ref[1])) : null;
}
const cacheable = (f) => f && f.querySelector('feTurbulence') && !f.querySelector('feImage, feTile, [in="BackgroundImage"], [in2="BackgroundImage"]');

function rasterize(key, p, filterXML, k, cif) {
  const m0 = pathMatrix(p);
  let bb; try { bb = p.getBBox(); } catch (e) { return null; }
  if (!bb.width && !bb.height) return null;
  const sw = parseFloat(p.getAttribute('stroke-width')) || 0;
  const pts = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]].map(([x, y]) => m0.transformPoint(new DOMPoint(x, y)));
  const pad = 12 + sw * 2;
  const x = Math.floor(Math.min(...pts.map((q) => q.x)) - pad), y = Math.floor(Math.min(...pts.map((q) => q.y)) - pad);
  const w = Math.ceil(Math.max(...pts.map((q) => q.x)) + pad) - x, h = Math.ceil(Math.max(...pts.map((q) => q.y)) + pad) - y;
  const kk = Math.min(k, 4096 / Math.max(w, h));
  const W = Math.max(1, Math.round(w * kk)), H = Math.max(1, Math.round(h * kk));
  const f = filterXML.replace(/^<filter\b[^>]*>/, `<filter id="f" filterUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}" color-interpolation-filters="${cif}">`);
  const attrs = PATH_ATTRS.map((a) => p.hasAttribute(a) ? ` ${a}="${p.getAttribute(a).replace(/"/g, '&quot;')}"` : '').join('');
  const src = `<svg xmlns="${NS}" width="${W}" height="${H}" viewBox="${x} ${y} ${w} ${h}"><defs>${f}</defs><g filter="url(#f)"><path transform="${mat(m0)}"${attrs}/></g></svg>`;
  const job = (async () => {
    const su = URL.createObjectURL(new Blob([src], { type: 'image/svg+xml' }));
    try {
      const img = new Image(); img.src = su; await img.decode();
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      cv.getContext('2d').drawImage(img, 0, 0, W, H);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      if (!blob) throw new Error('toBlob');
      const v = { url: URL.createObjectURL(blob), box: { x, y, w, h }, m0 };
      cache.set(key, v);
      if (cache.size > 400) { const [k0, v0] = cache.entries().next().value; if (v0.url) URL.revokeObjectURL(v0.url); cache.delete(k0); }
      return v;
    } finally { URL.revokeObjectURL(su); }
  })().catch(() => { cache.set(key, { failed: true }); return null; });
  cache.set(key, { pending: job });
  return job;
}

function build(g) {
  const st = groups.get(g);
  if (!g.isConnected) { st.mirror.remove(); st.mo.disconnect(); groups.delete(g); return; }
  const f = filterFor(g);
  if (!cacheable(f)) return restore(g);
  const maskRef = /url\(#([^)]+)\)/.exec(g.getAttribute('mask') || '');
  const mask = maskRef && g.ownerSVGElement.querySelector('mask#' + CSS.escape(maskRef[1]));
  const paths = [...g.children].filter((c) => c.localName === 'path');
  const empty = mask && !mask.firstElementChild; // nothing can show through an empty mask: draw nothing at all
  const k = scaleOf(g.ownerSVGElement);
  const fx = new XMLSerializer().serializeToString(f);
  const cif = f.getAttribute('color-interpolation-filters') || getComputedStyle(f).colorInterpolationFilters || 'linearRGB';
  const items = [], misses = [];
  if (!empty) for (const p of paths) {
    const key = fx + '|' + k + '|' + PATH_ATTRS.map((a) => p.getAttribute(a)).join('|');
    let c = cache.get(key);
    if (!c) { rasterize(key, p, fx, k, cif); c = cache.get(key); }
    if (!c || c.failed) items.push({ p, vec: true });
    else if (c.pending) { misses.push(c.pending); items.push({ p, vec: true }); }
    else items.push({ p, c });
  }
  if (!st.active && misses.length) { Promise.all(misses).then(() => schedule(g)); return; } // first paint waits so nothing flashes
  // swap in: hide the original, detach its filter so the browser stops computing it
  if (!st.active) {
    st.active = true;
    g.__scFilter = g.getAttribute('filter');
    g.removeAttribute('filter');
    g.style.visibility = 'hidden';
  }
  if (misses.length) Promise.all(misses).then(() => schedule(g));
  const mir = st.mirror;
  if (g.getAttribute('mask')) mir.setAttribute('mask', g.getAttribute('mask')); else mir.removeAttribute('mask');
  const kids = mir.children;
  items.forEach((it, i) => {
    const m = pathMatrix(it.p);
    const anims = [...it.p.children].filter((a) => /^animate/.test(a.localName));
    const sig = (it.vec ? 'v' : it.c.url) + anims.map((a) => a.outerHTML).join('');
    let node = kids[i];
    if (!node || node.__sig !== sig) {
      const n = document.createElementNS(NS, 'g');
      if (it.vec) {
        // not cached yet: draw this one shape with its own (small) filter until its bitmap is ready
        const inner = document.createElementNS(NS, 'g'); inner.setAttribute('filter', g.__scFilter);
        const cp = it.p.cloneNode(true); inner.appendChild(cp); n.appendChild(inner); n.__vec = cp;
      } else {
        for (const a of anims) n.appendChild(a.cloneNode(true));
        const im = document.createElementNS(NS, 'image');
        const b = it.c.box;
        im.setAttribute('href', it.c.url); im.setAttribute('x', b.x); im.setAttribute('y', b.y);
        im.setAttribute('width', b.w); im.setAttribute('height', b.h); im.setAttribute('preserveAspectRatio', 'none');
        im.setAttribute('transform', mat(it.c.m0.inverse()));
        n.appendChild(im);
      }
      n.__sig = sig;
      if (node) mir.replaceChild(n, node); else mir.appendChild(n);
      node = n;
    }
    if (node.__vec) { for (const a of ['transform', ...PATH_ATTRS]) { const v = it.p.getAttribute(a); if (v == null) node.__vec.removeAttribute(a); else if (node.__vec.getAttribute(a) !== v) node.__vec.setAttribute(a, v); } }
    else { const t = mat(m); if (node.getAttribute('transform') !== t) node.setAttribute('transform', t); }
  });
  while (kids.length > items.length) mir.lastChild.remove();
}
function restore(g) {
  const st = groups.get(g);
  if (st && st.active) { g.setAttribute('filter', g.__scFilter); g.style.visibility = ''; st.active = false; }
  if (st) st.mirror.replaceChildren();
}
function schedule(g) {
  const st = groups.get(g);
  if (!st || st.queued) return;
  st.queued = true;
  requestAnimationFrame(() => { st.queued = false; try { build(g); } catch (e) { restore(g); } });
}
function adopt(g) {
  if (groups.has(g) || g.closest('defs, mask, clipPath, [data-stampcache]')) return;
  if (!cacheable(filterFor(g)) || !g.querySelector(':scope > path')) return;
  const mirror = document.createElementNS(NS, 'g');
  mirror.setAttribute('data-stampcache', '');
  mirror.setAttribute('aria-hidden', 'true');
  g.after(mirror);
  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.target === g && r.type === 'attributes') {
        if (r.attributeName === 'filter' && g.getAttribute('filter')) { g.__scFilter = g.getAttribute('filter'); if (groups.get(g).active) g.removeAttribute('filter'); }
        if (r.attributeName === 'style') continue;
      }
      schedule(g); return;
    }
  });
  mo.observe(g, { attributes: true, childList: true, subtree: true, characterData: false });
  groups.set(g, { mirror, mo, active: false, queued: false });
  schedule(g);
}

let resizeHooked = false;
export function startStampCache(root) {
  if (/[?&]nostamp\b/.test(location.search) || typeof DOMMatrix === 'undefined') return;
  const scan = () => {
    for (const g of [...groups.keys()]) if (!g.isConnected) { groups.get(g).mirror.remove(); groups.get(g).mo.disconnect(); groups.delete(g); }
    root.querySelectorAll('svg g[filter]').forEach(adopt);
  };
  scan();
  if (!root.__stampcache) {
    let q = false;
    root.__stampcache = new MutationObserver((recs) => {
      if (q || !recs.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1 && !(n.hasAttribute && n.hasAttribute('data-stampcache'))) || r.removedNodes.length)) return;
      q = true; requestAnimationFrame(() => { q = false; scan(); });
    });
    root.__stampcache.observe(root, { childList: true, subtree: true });
  }
  if (!resizeHooked) {
    resizeHooked = true;
    let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => groups.forEach((_, g) => schedule(g)), 250); });
  }
}
