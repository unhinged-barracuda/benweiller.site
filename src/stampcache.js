// stampcache: SVG groups drawn through a texture filter (feTurbulence "rough"/"worn" stamp edges) are
// expensive on CPU-filter browsers (Safari): the whole filter region is recomputed whenever any shape inside
// moves (mouse-follow, SMIL wiggles). Here each shape is filtered ONCE into a bitmap, in the svg's own user
// space (so the texture is identical to the original), and a mirror group shows those bitmaps, moved with
// plain transforms. Displacement and alpha masks are per-pixel, so filtering shapes one by one and stacking
// them gives the same picture as filtering the stack. The original group stays in the DOM (React owns it),
// just hidden with its filter detached. ?nostamp turns this off.
import { localMatrix, mul, viewboxMatrix } from './fastblob.js';
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
  const maskRef = /url\(#([^)]+)\)/.exec(g.__scMask || g.getAttribute('mask') || '');
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
  // a mask with a shape in it (e.g. the blob the stamps flip inside) changes every frame; SVG masks are redrawn on the
  // CPU in Safari, so those are composited on a canvas instead (see MaskStage below). Plain masks stay in the SVG.
  const maskAttr = g.__scMask || g.getAttribute('mask');
  const dyn = mask && !empty && mask.querySelector('path') && !/[?&]svgmask\b/.test(location.search);
  if (dyn) {
    if (g.getAttribute('mask')) { g.__scMask = g.getAttribute('mask'); g.removeAttribute('mask'); }
    mir.removeAttribute('mask'); mir.style.visibility = 'hidden';
    st.mask = mask; maskStageFor(g.ownerSVGElement).add(g);
  } else {
    if (maskAttr) mir.setAttribute('mask', maskAttr); else mir.removeAttribute('mask');
    mir.style.visibility = ''; if (st.mask) { st.mask = null; maskStageFor(g.ownerSVGElement).remove(g); }
  }
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
  if (st && st.active) { g.setAttribute('filter', g.__scFilter); if (g.__scMask) g.setAttribute('mask', g.__scMask); g.style.visibility = ''; st.active = false; }
  if (st && st.mask) { st.mask = null; maskStageFor(g.ownerSVGElement).remove(g); }
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
        if (r.attributeName === 'mask') { if (g.getAttribute('mask') && groups.get(g).mask) { g.__scMask = g.getAttribute('mask'); g.removeAttribute('mask'); } continue; }
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


// ---------- MaskStage: stamps flipping inside a moving shape, composited on a 2D canvas ----------
// For each cached group: draw its stamp bitmaps into a layer, keep only the part inside (or outside) the mask shape,
// and paint the layer on a canvas laid over the svg. The mask shape is drawn small and blurred with a shadow
// (cheap on every browser), then scaled up. Same picture as the SVG mask, no per-frame SVG work.
const maskStages = new Map();
const imgCache = new Map();
function bitmap(url) {
  let im = imgCache.get(url);
  if (!im) { im = new Image(); im.decoding = 'async'; im.src = url; imgCache.set(url, im); if (imgCache.size > 600) imgCache.delete(imgCache.keys().next().value); }
  return im.complete && im.naturalWidth ? im : null;
}
// matrix of el's coordinate system within `top` (top's own user space), including CSS + SMIL-animated transforms
function chain(el, top) {
  let m = [1, 0, 0, 1, 0, 0];
  for (let n = el; n && n !== top; n = n.parentElement) {
    let l = localMatrix(n);
    const av = n.transform && n.transform.animVal;
    if (av && av.numberOfItems && getComputedStyle(n).transform === 'none') { const c = av.consolidate().matrix; l = [c.a, c.b, c.c, c.d, c.e, c.f]; }
    m = mul(l, m);
  }
  return m;
}
const scaleOfM = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
function blurOf(el) {
  const ref = /url\(\s*['"]?#([^'")]+)/.exec(el.getAttribute('filter') || '');
  const f = ref && el.ownerSVGElement && el.ownerSVGElement.querySelector('filter#' + CSS.escape(ref[1]));
  const gb = f && f.querySelector('feGaussianBlur');
  return gb ? parseFloat(gb.getAttribute('stdDeviation')) || 0 : 0;
}
const isWhite = (c) => /^(#fff(fff)?|white|rgb\(255,\s*255,\s*255\))$/i.test((c || '').trim());

class MaskStage {
  constructor(svg) {
    this.svg = svg; this.groups = new Set();
    const cv = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true'); cv.className = 'stampmask';
    const scs = getComputedStyle(svg);
    this.fixed = scs.position === 'fixed';
    cv.style.cssText = 'position:' + (this.fixed ? 'fixed' : 'absolute') + ';left:0;top:0;width:0;height:0;pointer-events:none;display:block;margin:0;padding:0;border:0';
    if (scs.zIndex !== 'auto') cv.style.zIndex = scs.zIndex;
    svg.after(cv);
    this.cv = cv; this.ctx = cv.getContext('2d');
    this.layer = document.createElement('canvas'); this.lctx = this.layer.getContext('2d');
    this.mcv = document.createElement('canvas'); this.mctx = this.mcv.getContext('2d');
  }
  add(g) { this.groups.add(g); loop(); }
  remove(g) { this.groups.delete(g); if (!this.groups.size) { this.cv.remove(); maskStages.delete(this.svg); } }
  // the mask's alpha, drawn at 1/MS of the canvas size
  drawMask(mask, P, W, H) {
    const MS = 4, w = Math.max(1, Math.ceil(W / MS)), h = Math.max(1, Math.ceil(H / MS));
    const m = this.mcv, c = this.mctx;
    if (m.width !== w || m.height !== h) { m.width = w; m.height = h; }
    c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, w, h);
    const OFF = 4 * (w + h); // draw shapes off-canvas and let only their blurred shadow land on it
    for (const el of mask.querySelectorAll('rect, path, ellipse, circle')) {
      const fill = el.getAttribute('fill') || getComputedStyle(el).fill;
      const white = isWhite(fill);
      const M = mul([1 / MS, 0, 0, 1 / MS, 0, 0], mul(P, chain(el, mask)));
      const sigma = blurOf(el) * scaleOfM(M);
      let path;
      if (el.localName === 'path') path = new Path2D(el.getAttribute('d') || '');
      else if (el.localName === 'rect') { path = new Path2D(); path.rect(+el.getAttribute('x') || 0, +el.getAttribute('y') || 0, parseFloat(el.getAttribute('width')) || 0, parseFloat(el.getAttribute('height')) || 0); }
      else { const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0, rx = parseFloat(el.getAttribute('rx') || el.getAttribute('r')) || 0, ry = parseFloat(el.getAttribute('ry') || el.getAttribute('r')) || 0; path = new Path2D(); path.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); }
      c.globalCompositeOperation = white ? 'source-over' : 'destination-out';
      if (sigma > 0.3) {
        c.shadowColor = '#fff'; c.shadowBlur = sigma * 2; c.shadowOffsetX = OFF; c.shadowOffsetY = 0;
        c.setTransform(M[0], M[1], M[2], M[3], M[4] - OFF, M[5]);
      } else { c.shadowColor = 'transparent'; c.shadowBlur = 0; c.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]); }
      c.fillStyle = '#fff'; c.fill(path);
    }
    c.shadowColor = 'transparent'; c.shadowBlur = 0; c.globalCompositeOperation = 'source-over';
    return m;
  }
  draw() {
    const { svg, cv, ctx } = this;
    const sr = svg.getBoundingClientRect();
    if (!sr.width || !sr.height) return;
    let left = sr.left, top = sr.top;
    if (!this.fixed) {
      const op = cv.offsetParent || document.body, pr = op.getBoundingClientRect();
      left = sr.left - pr.left - op.clientLeft + op.scrollLeft; top = sr.top - pr.top - op.clientTop + op.scrollTop;
    }
    const st = cv.style, px = (n) => n.toFixed(2) + 'px';
    if (st.left !== px(left)) st.left = px(left);
    if (st.top !== px(top)) st.top = px(top);
    if (st.width !== px(sr.width)) st.width = px(sr.width);
    if (st.height !== px(sr.height)) st.height = px(sr.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(sr.width * dpr)), H = Math.max(1, Math.round(sr.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    if (this.layer.width !== W || this.layer.height !== H) { this.layer.width = W; this.layer.height = H; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // only the stamps' area is touched each frame (the rest of the canvas stays empty)
    if (this.prev) { ctx.clearRect(this.prev[0], this.prev[1], this.prev[2], this.prev[3]); this.prev = null; }
    if (sr.bottom < 0 || sr.top > innerHeight) return;
    const root = mul([dpr, 0, 0, dpr, 0, 0], viewboxMatrix(svg, sr.width, sr.height));
    const L = this.lctx;
    // paint groups in document order
    const ordered = [...this.groups].filter((g) => g.isConnected).sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
    for (const g of ordered) {
      const gs = groups.get(g); if (!gs || !gs.mask || !gs.active) continue;
      const P = mul(root, chain(gs.mirror.parentElement, svg));
      // work out where the stamps land (device px) and only touch that box
      const items = []; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const node of gs.mirror.children) {
        if (node.__vec) continue; // not cached yet (drawn on the next frames once its bitmap is ready)
        const im = node.querySelector('image'); if (!im) continue;
        const bm = bitmap(im.getAttribute('href')); if (!bm) continue;
        const M = mul(P, chain(im, gs.mirror));
        const x = +im.getAttribute('x'), y = +im.getAttribute('y'), w = +im.getAttribute('width'), h = +im.getAttribute('height');
        for (const [u, v] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
          const X = M[0] * u + M[2] * v + M[4], Y = M[1] * u + M[3] * v + M[5];
          if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        }
        items.push([bm, M, x, y, w, h]);
      }
      if (!items.length) continue;
      const bx = Math.max(0, Math.floor(x0) - 2), by = Math.max(0, Math.floor(y0) - 2);
      const bw = Math.min(W, Math.ceil(x1) + 2) - bx, bh = Math.min(H, Math.ceil(y1) + 2) - by;
      if (bw <= 0 || bh <= 0) continue;
      L.setTransform(1, 0, 0, 1, 0, 0); L.globalCompositeOperation = 'source-over'; L.clearRect(bx, by, bw, bh);
      for (const [bm, M, x, y, w, h] of items) { L.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]); L.drawImage(bm, x, y, w, h); }
      const mk = this.drawMask(gs.mask, P, W, H), MS = W / mk.width, NS = H / mk.height;
      L.setTransform(1, 0, 0, 1, 0, 0); L.globalCompositeOperation = 'destination-in'; L.imageSmoothingEnabled = true;
      L.drawImage(mk, bx / MS, by / NS, bw / MS, bh / NS, bx, by, bw, bh);
      L.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.layer, bx, by, bw, bh, bx, by, bw, bh);
      const pv = this.prev; this.prev = pv ? [Math.min(pv[0], bx), Math.min(pv[1], by), Math.max(pv[0] + pv[2], bx + bw) - Math.min(pv[0], bx), Math.max(pv[1] + pv[3], by + bh) - Math.min(pv[1], by)] : [bx, by, bw, bh];
    }
  }
}
function maskStageFor(svg) {
  let s = maskStages.get(svg);
  if (!s) { s = new MaskStage(svg); maskStages.set(svg, s); }
  return s;
}
let looping = false;
function loop() {
  if (looping) return; looping = true;
  const tick = () => {
    for (const [svg, s] of maskStages) {
      if (!svg.isConnected) { s.cv.remove(); maskStages.delete(svg); continue; }
      try { s.draw(); } catch (e) { /* skip a frame */ }
    }
    if (maskStages.size) requestAnimationFrame(tick); else looping = false;
  };
  requestAnimationFrame(tick);
}
