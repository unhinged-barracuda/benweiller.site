// fastblob — draws the boards' grainy blobs on the graphics chip (WebGL) instead of through SVG filters.
//
// The boards draw each blob as a few <path>s with SVG filters (Gaussian blur + turbulence displacement for the
// grain) and a full-page grain <rect>. Safari (and to a lesser degree every browser) renders those filters on the
// main processor, every frame, at full screen resolution — which froze the site. This module finds those layers,
// hides them, and repaints the same thing each frame in a <canvas> placed right behind the board's <svg>:
//   - the shapes, colours, opacities and every transform/animation still come from the board (read live each frame);
//   - the blur is done at low resolution (it is a huge blur, so nothing is lost) and scaled up smoothly;
//   - the grain displacement and the page grain use a noise texture with the same scale and strength.
// Anything it doesn't recognise is left to the SVG, so a board can never break because of it.

const MAX_DPR = 2;
const BLUR_TEXELS = 6;
const BUF = 256; // size of the low-resolution blur buffers // the blur is computed at a resolution where sigma is about this many texels

// ---------- small 2D matrix helpers: [a, b, c, d, e, f] like DOMMatrix / SVG ----------
const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const tr = (x, y) => [1, 0, 0, 1, x, y];
const inv = (m) => {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-9;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function parseCssMatrix(s) {
  if (!s || s === 'none') return null;
  const n = s.match(/-?[\d.]+(?:e-?\d+)?/g);
  if (!n) return null;
  const v = n.map(Number);
  if (s.startsWith('matrix3d')) return [v[0], v[1], v[4], v[5], v[12], v[13]];
  return v.slice(0, 6);
}

// the transform an element applies to its children, as the browser computes it right now (CSS transitions and
// keyframe animations included)
function localMatrix(el, knownBox) {
  const cs = getComputedStyle(el);
  let m = parseCssMatrix(cs.transform);
  if (!m) {
    const base = el.transform && el.transform.baseVal;
    if (base && base.numberOfItems) { const c = base.consolidate().matrix; return [c.a, c.b, c.c, c.d, c.e, c.f]; }
    return I;
  }
  const o = (cs.transformOrigin || '0 0').split(' ').map(parseFloat);
  let ox = o[0] || 0, oy = o[1] || 0;
  if (cs.transformBox === 'fill-box') {
    // the browser resolves % origins against the fill-box; it reports them in px from the box's corner
    let bb = null; try { bb = el.getBBox(); } catch (e) { /* not rendered */ }
    if (bb) { ox += bb.x; oy += bb.y; }
  }
  return mul(mul(tr(ox, oy), m), tr(-ox, -oy));
}

// viewBox + preserveAspectRatio -> CSS pixels inside the svg box
function viewboxMatrix(svg, W, H) {
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (!vb || !vb.width || !vb.height) return I;
  const par = (svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim().split(/\s+/);
  let sx = W / vb.width, sy = H / vb.height;
  if (par[0] !== 'none') {
    const s = par[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = s;
  }
  let tx = -vb.x * sx, ty = -vb.y * sy;
  if (par[0] !== 'none') {
    const a = par[0];
    const fx = a.includes('xMid') ? 0.5 : a.includes('xMax') ? 1 : 0;
    const fy = a.includes('YMid') ? 0.5 : a.includes('YMax') ? 1 : 0;
    tx += (W - vb.width * sx) * fx; ty += (H - vb.height * sy) * fy;
  }
  return [sx, 0, 0, sy, tx, ty];
}

// bounding box of a path from its numbers (absolute M/C/L/Z paths, as the boards write them) — no layout needed
const boxCache = new Map();
function pathBox(d) {
  if (!d) return null;
  if (boxCache.has(d)) return boxCache.get(d);
  const n = d.match(/-?\d*\.?\d+(?:e-?\d+)?/g);
  if (!n || n.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < n.length; i += 2) { const x = +n[i], y = +n[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const b = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  if (boxCache.size > 500) boxCache.clear();
  boxCache.set(d, b); return b;
}
// a group's fill-box: the union of its painted children's boxes, through their own transforms
function groupBox(el) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of el.children) {
    let b = null;
    if (c.localName === 'path') b = pathBox(c.getAttribute('d'));
    else if (c.localName === 'g') { b = groupBox(c); if (b) { const m = localMatrix(c, b); const p = [apply(m, b.x, b.y), apply(m, b.x + b.width, b.y), apply(m, b.x, b.y + b.height), apply(m, b.x + b.width, b.y + b.height)]; b = { x: Math.min(...p.map((q) => q[0])), y: Math.min(...p.map((q) => q[1])), width: 0, height: 0, x1: Math.max(...p.map((q) => q[0])), y1: Math.max(...p.map((q) => q[1])) }; b.width = b.x1 - b.x; b.height = b.y1 - b.y; } }
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// ---------- what can be accelerated ----------
const urlId = (v) => { const m = v && v.match(/url\(\s*['"]?#([^'")]+)['"]?\s*\)/); return m ? m[1] : null; };

function readBlurFilter(f) {
  if (!f) return null;
  const kids = Array.from(f.children).map((k) => k.localName);
  if (!kids.includes('feGaussianBlur')) return null;
  const ok = kids.every((k) => ['feGaussianBlur', 'feTurbulence', 'feDisplacementMap'].includes(k));
  if (!ok) return null;
  const blur = f.querySelector('feGaussianBlur');
  const sd = parseFloat(blur.getAttribute('stdDeviation')) || 0;
  const turb = f.querySelector('feTurbulence');
  const disp = f.querySelector('feDisplacementMap');
  return {
    sigma: sd,
    freq: turb ? parseFloat(turb.getAttribute('baseFrequency')) || 0.9 : 0.9,
    disp: disp ? parseFloat(disp.getAttribute('scale')) || 0 : 0,
  };
}

function readGrainFilter(f) {
  if (!f) return null;
  const kids = Array.from(f.children).map((k) => k.localName);
  if (kids.length !== 2 || kids[0] !== 'feTurbulence' || kids[1] !== 'feColorMatrix') return null;
  const cm = f.children[1];
  if ((cm.getAttribute('type') || 'matrix') !== 'matrix') return null;
  const v = (cm.getAttribute('values') || '').trim().split(/[\s,]+/).map(Number);
  if (v.length !== 20) return null;
  return { freq: parseFloat(f.children[0].getAttribute('baseFrequency')) || 0.9, matrix: v };
}

// masks on the blob's groups: "keep everything" (a white rect) or a left-to-right black→white fade
function readMask(svg, id) {
  const m = svg.querySelector('mask#' + CSS.escape(id));
  if (!m) return null;
  const kids = Array.from(m.children);
  if (kids.length !== 1 || kids[0].localName !== 'rect') return null;
  const fill = kids[0].getAttribute('fill') || '';
  if (/^(#fff|#ffffff|white)$/i.test(fill)) return { kind: 'none' };
  const gid = urlId(fill);
  const g = gid && svg.querySelector('linearGradient#' + CSS.escape(gid));
  if (!g || g.getAttribute('gradientUnits') !== 'userSpaceOnUse') return null;
  const stops = g.querySelectorAll('stop');
  if (stops.length !== 2) return null;
  const lum = (s) => { const c = (s.getAttribute('stop-color') || '').toLowerCase(); return /^(#000|#000000|black)$/.test(c) ? 0 : /^(#fff|#ffffff|white)$/.test(c) ? 1 : null; };
  const a = lum(stops[0]), b = lum(stops[1]);
  const y1 = parseFloat(g.getAttribute('y1') || 0), y2 = parseFloat(g.getAttribute('y2') || 0);
  if (a === null || b === null || y1 !== y2) return null;
  return { kind: 'fade', x1: parseFloat(g.getAttribute('x1') || 0), x2: parseFloat(g.getAttribute('x2') || 1), a, b };
}

const PAINTED = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'use', 'foreignObject']);
const inDefs = (el, svg) => { for (let p = el.parentElement; p && p !== svg; p = p.parentElement) if (/^(defs|mask|clipPath|pattern|symbol|marker|filter)$/.test(p.localName)) return true; return false; };

// one board <svg> -> a plan of layers to draw, or null if anything in it is unfamiliar
function plan(svg) {
  const all = Array.from(svg.querySelectorAll('*')).filter((el) => PAINTED.has(el.localName) && !inDefs(el, svg));
  if (!all.length) return null;
  const layers = [];
  let started = false;
  for (const el of all) {
    const fid = urlId(el.getAttribute('filter'));
    const f = fid && svg.querySelector('filter#' + CSS.escape(fid));
    const blur = el.localName === 'path' && readBlurFilter(f);
    const grain = !blur && el.localName === 'rect' && readGrainFilter(f);
    if (!blur && !grain) {
      // a painted thing under the blob would end up above it once the blob moves into the canvas behind the svg
      if (!started) return null;
      continue;
    }
    // the chain up to the svg must be plain groups (masks only of the kinds handled above)
    const chain = [];
    let ok = true, mask = null;
    for (let p = el.parentElement; p && p !== svg; p = p.parentElement) {
      if (p.localName !== 'g' && p.localName !== 'a') { ok = false; break; }
      if (p.getAttribute('filter') || p.getAttribute('clip-path')) { ok = false; break; }
      const mid = urlId(p.getAttribute('mask'));
      if (mid) {
        const mk = readMask(svg, mid);
        if (!mk || mask) { ok = false; break; }
        if (mk.kind !== 'none') { mask = mk; mask.el = p; }
      }
      chain.unshift(p);
    }
    if (!ok) return null;
    if (grain && !started) return null; // grain under the blob: unusual, leave it
    started = true;
    layers.push(blur ? { kind: 'blob', el, chain, f: blur, mask } : { kind: 'grain', el, chain, f: grain, mask });
  }
  return layers.length ? layers : null;
}

// ---------- WebGL ----------
const VS = `attribute vec2 p; uniform vec4 r; uniform vec2 res; varying vec2 v;
void main(){ vec2 px = r.xy + p * r.zw; v = p; gl_Position = vec4(px / res * 2.0 - 1.0, 0.0, 1.0); gl_Position.y = -gl_Position.y; }`;
const FS_BLUR = `precision mediump float; varying vec2 v; uniform sampler2D t; uniform vec2 dir; uniform float sig;
void main(){ float w0 = 1.0; vec4 acc = texture2D(t, v); float ws = 1.0;
  for (int i = 1; i <= 20; i++) { float fi = float(i); if (fi > sig * 3.0) break; float w = exp(-0.5 * fi * fi / (sig * sig));
    acc += (texture2D(t, v + dir * fi) + texture2D(t, v - dir * fi)) * w; ws += 2.0 * w; }
  gl_FragColor = acc / ws; }`;
// composite: sample the blurred shape at a grain-displaced position, tint, mask, output premultiplied
const FS_BLOB = `precision highp float; varying vec2 v; uniform sampler2D t; uniform sampler2D nz;
uniform vec4 r; uniform vec2 res; uniform vec4 col; uniform mat3 invM; uniform mat2 lin; uniform float freq; uniform float disp;
uniform vec4 rect; uniform vec4 mk; uniform mat3 invRoot;
void main(){ vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
  vec2 u = (invM * vec3(px, 1.0)).xy;
  vec2 n = texture2D(nz, u * freq / 256.0).rg - 0.5;
  vec2 q = px + lin * (n * disp);
  vec2 uv = (q - rect.xy) / rect.zw;
  float a = texture2D(t, uv).a;
  if (mk.w > 0.5) { float x = (invRoot * vec3(px, 1.0)).x; float k = clamp((x - mk.x) / (mk.y - mk.x), 0.0, 1.0); a *= mix(mk.z, 1.0 - mk.z, k); }
  a *= col.a; gl_FragColor = vec4(col.rgb * a, a); }`;
const FS_GRAIN = `precision highp float; uniform sampler2D nz; uniform vec2 res; uniform mat3 invM; uniform float freq;
uniform mat4 cm; uniform vec4 co;
void main(){ vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y); vec2 u = (invM * vec3(px, 1.0)).xy;
  vec4 n = texture2D(nz, u * freq / 256.0); vec4 c = clamp(cm * n + co, 0.0, 1.0); c.rgb = pow(c.rgb, vec3(1.0 / 2.2)); gl_FragColor = vec4(c.rgb * c.a, c.a); }`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, a.name); }
  return { p, u, a: gl.getAttribLocation(p, 'p') };
}

// smooth value noise, 256x256, tiling: four independent channels like fractalNoise (centred on 0.5)
function noiseTexture(gl) {
  const N = 256, out = new Uint8Array(N * N * 4);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const oct = [[N / 1, 0.65], [N / 2, 0.35]]; // two octaves, like numOctaves="2"
  const grids = oct.map(([g]) => { const a = new Float32Array(g * g * 4); for (let i = 0; i < a.length; i++) a[i] = rnd() * 2 - 1; return { g, a }; });
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = [0, 0, 0, 0];
    grids.forEach(({ g, a }, oi) => {
      const fx = (x / N) * g, fy = (y / N) * g, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = sm(fx - x0), ty = sm(fy - y0);
      const at = (xx, yy, c) => a[(((yy % g) * g) + (xx % g)) * 4 + c];
      for (let c = 0; c < 4; c++) {
        const top = at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx;
        const bot = at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx;
        v[c] += (top * (1 - ty) + bot * ty) * oct[oi][1];
      }
    });
    for (let c = 0; c < 4; c++) out[(y * N + x) * 4 + c] = Math.max(0, Math.min(255, Math.round((0.5 + v[c] * 0.2) * 255)));
  }
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, out);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return t;
}

function makeTarget(gl, w, h) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  return { t, fb, w, h };
}

const colorCtx = document.createElement('canvas').getContext('2d');
const colorCache = new Map();
function rgba(c) {
  if (colorCache.has(c)) return colorCache.get(c);
  colorCtx.clearRect(0, 0, 1, 1); colorCtx.fillStyle = '#000'; colorCtx.fillStyle = c; colorCtx.fillRect(0, 0, 1, 1);
  const d = colorCtx.getImageData(0, 0, 1, 1).data;
  const v = [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
  if (colorCache.size > 2000) colorCache.clear();
  colorCache.set(c, v); return v;
}

// ---------- one accelerated svg ----------
class Stage {
  constructor(svg, layers) {
    this.svg = svg; this.layers = layers;
    const cv = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true');
    const scs = getComputedStyle(svg);
    if (scs.position === 'static' || scs.position === 'relative' || scs.position === 'sticky') throw new Error('in-flow svg');
    this.fixed = scs.position === 'fixed';
    cv.style.cssText = 'position:' + (this.fixed ? 'fixed' : 'absolute') + ';left:0;top:0;width:0;height:0;pointer-events:none;display:block;margin:0;padding:0;border:0';
    if (scs.zIndex !== 'auto') cv.style.zIndex = scs.zIndex;
    cv.className = 'fastblob';
    const gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('no webgl');
    this.cv = cv; this.gl = gl;
    this.blurP = compile(gl, VS, FS_BLUR);
    this.blobP = compile(gl, VS, FS_BLOB);
    this.grainP = compile(gl, VS, FS_GRAIN);
    this.nz = noiseTexture(gl);
    this.quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.src = makeTarget(gl, BUF, BUF); this.tmp = makeTarget(gl, BUF, BUF); this.dst = makeTarget(gl, BUF, BUF);
    const c2 = document.createElement('canvas'); c2.width = c2.height = BUF; this.c2 = c2.getContext('2d');
    svg.parentNode.insertBefore(cv, svg);
    for (const L of layers) L.el.style.visibility = 'hidden';
  }
  destroy() {
    for (const L of this.layers) if (L.el.isConnected) L.el.style.visibility = '';
    this.cv.remove();
    const ext = this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
  }
  draw() {
    const { gl, cv, svg } = this;
    const sr = svg.getBoundingClientRect();
    if (!sr.width || !sr.height) return;
    // keep the canvas exactly over the svg's box
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
    if (sr.bottom < 0 || sr.top > innerHeight || sr.right < 0 || sr.left > innerWidth) return;
    const cr = cv.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(cr.width * dpr)), H = Math.max(1, Math.round(cr.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    // svg user space -> canvas device pixels
    const root = mul([dpr, 0, 0, dpr, (sr.left - cr.left) * dpr, (sr.top - cr.top) * dpr], viewboxMatrix(svg, sr.width, sr.height));
    const svgOpacity = parseFloat(getComputedStyle(svg).opacity);
    gl.viewport(0, 0, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const mats = new Map();
    const chainM = (chain) => { let m = root, op = svgOpacity; for (const g of chain) { if (!mats.has(g)) mats.set(g, [localMatrix(g), parseFloat(getComputedStyle(g).opacity)]); const [lm, o] = mats.get(g); m = mul(m, lm); op *= o; } return [m, op]; };
    for (const L of this.layers) {
      if (!L.el.isConnected) continue;
      const [cm, gop] = chainM(L.chain);
      const M = mul(cm, localMatrix(L.el));
      const op = gop * parseFloat(getComputedStyle(L.el).opacity);
      if (op <= 0.001) continue;
      if (L.kind === 'grain') this.drawGrain(L, M, op, W, H);
      else this.drawBlob(L, M, op, W, H, root);
    }
  }
  drawGrain(L, M, op, W, H) {
    const { gl } = this; const P = this.grainP;
    const x = parseFloat(L.el.getAttribute('x') || 0), y = parseFloat(L.el.getAttribute('y') || 0);
    const w = parseFloat(L.el.getAttribute('width') || 0), h = parseFloat(L.el.getAttribute('height') || 0);
    const c = [apply(M, x, y), apply(M, x + w, y), apply(M, x, y + h), apply(M, x + w, y + h)];
    const x0 = Math.max(0, Math.min(...c.map((p) => p[0]))), y0 = Math.max(0, Math.min(...c.map((p) => p[1])));
    const x1 = Math.min(W, Math.max(...c.map((p) => p[0]))), y1 = Math.min(H, Math.max(...c.map((p) => p[1])));
    if (x1 <= x0 || y1 <= y0) return;
    gl.useProgram(P.p); gl.enableVertexAttribArray(P.a); gl.vertexAttribPointer(P.a, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(P.u.r, x0, y0, x1 - x0, y1 - y0); gl.uniform2f(P.u.res, W, H);
    const iv = inv(M); gl.uniformMatrix3fv(P.u.invM, false, [iv[0], iv[1], 0, iv[2], iv[3], 0, iv[4], iv[5], 1]);
    gl.uniform1f(P.u.freq, L.f.freq);
    const v = L.f.matrix;
    // mat4 in column-major: cm * n where rows are the colour-matrix rows
    gl.uniformMatrix4fv(P.u.cm, false, [v[0], v[5], v[10], v[15] * op, v[1], v[6], v[11], v[16] * op, v[2], v[7], v[12], v[17] * op, v[3], v[8], v[13], v[18] * op]);
    gl.uniform4f(P.u.co, v[4], v[9], v[14], v[19] * op);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.nz); gl.uniform1i(P.u.nz, 1);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  drawBlob(L, M, op, W, H, root) {
    const { gl } = this; const S = BUF;
    const bb = pathBox(L.el.getAttribute('d'));
    if (!bb) return;
    if (!bb.width || !bb.height) return;
    const scaleU = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])); // device px per user unit
    // browsers approximate big SVG blurs with three box blurs, which reads a little tighter than a true Gaussian
    const sigmaPx = L.f.sigma * scaleU, dispPx = L.f.disp * scaleU;
    const pad = sigmaPx * 3 + dispPx;
    const c = [apply(M, bb.x, bb.y), apply(M, bb.x + bb.width, bb.y), apply(M, bb.x, bb.y + bb.height), apply(M, bb.x + bb.width, bb.y + bb.height)];
    const rx0 = Math.min(...c.map((p) => p[0])) - pad, ry0 = Math.min(...c.map((p) => p[1])) - pad;
    const rx1 = Math.max(...c.map((p) => p[0])) + pad, ry1 = Math.max(...c.map((p) => p[1])) + pad;
    if (rx1 < 0 || ry1 < 0 || rx0 > W || ry0 > H) return;
    const rw = rx1 - rx0, rh = ry1 - ry0;
    // a low-resolution square buffer: the blur radius becomes at most ~BLUR_TEXELS texels
    const q = Math.min(1, BLUR_TEXELS / Math.max(0.5, sigmaPx), (S - 2) / Math.max(rw, rh));
    // 1) rasterise the shape (white on transparent) with the 2D canvas
    const c2 = this.c2;
    c2.setTransform(1, 0, 0, 1, 0, 0); c2.clearRect(0, 0, S, S);
    const T = mul([q, 0, 0, q, -rx0 * q, -ry0 * q], M);
    c2.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
    c2.fillStyle = '#fff';
    try { c2.fill(new Path2D(L.el.getAttribute('d') || ''), L.el.getAttribute('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero'); } catch (e) { return; }
    // 2) upload and blur (horizontal, then vertical) at that resolution
    gl.bindTexture(gl.TEXTURE_2D, this.src.t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c2.canvas);
    const sig = Math.max(0.5, sigmaPx * q);
    const B = this.blurP; gl.useProgram(B.p); gl.enableVertexAttribArray(B.a); gl.vertexAttribPointer(B.a, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    const pass = (from, to, dx, dy) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.fb); gl.viewport(0, 0, S, S);
      gl.uniform4f(B.u.r, 0, 0, S, S); gl.uniform2f(B.u.res, S, S);
      gl.uniform2f(B.u.dir, dx / S, dy / S); gl.uniform1f(B.u.sig, sig);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, from.t); gl.uniform1i(B.u.t, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    // each pass flips the image vertically (screen-style y), so two passes leave it the right way up
    pass(this.src, this.tmp, 1, 0);
    pass(this.tmp, this.dst, 0, 1);
    // 3) composite on the screen canvas with the grain displacement
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    const P = this.blobP; gl.useProgram(P.p); gl.enableVertexAttribArray(P.a); gl.vertexAttribPointer(P.a, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(P.u.r, rx0, ry0, rw, rh); gl.uniform2f(P.u.res, W, H);
    const col = rgba(L.el.getAttribute('fill') || '#000');
    gl.uniform4f(P.u.col, col[0], col[1], col[2], col[3] * op);
    const iv = inv(M); gl.uniformMatrix3fv(P.u.invM, false, [iv[0], iv[1], 0, iv[2], iv[3], 0, iv[4], iv[5], 1]);
    gl.uniformMatrix2fv(P.u.lin, false, [M[0], M[1], M[2], M[3]]);
    gl.uniform1f(P.u.freq, L.f.freq); gl.uniform1f(P.u.disp, L.f.disp);
    // the blurred buffer covers [rx0, rx0 + S/q] x [ry0, ry0 + S/q] in device pixels
    gl.uniform4f(P.u.rect, rx0, ry0, S / q, S / q);
    if (L.mask && L.mask.kind === 'fade') {
      const ir = inv(root);
      gl.uniform4f(P.u.mk, L.mask.x1, L.mask.x2, L.mask.a, 1);
      gl.uniformMatrix3fv(P.u.invRoot, false, [ir[0], ir[1], 0, ir[2], ir[3], 0, ir[4], ir[5], 1]);
    } else gl.uniform4f(P.u.mk, 0, 1, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.dst.t); gl.uniform1i(P.u.t, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.nz); gl.uniform1i(P.u.nz, 1);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

// ---------- driver ----------
const stages = new Map();
let looping = false;
export function startFastBlob(root, now) {
  if (/[?&]svgblob\b/.test(location.search)) return; // ?svgblob shows the original SVG rendering, for comparison
  const scan = () => {
    for (const [svg, st] of stages) if (!svg.isConnected) { st.destroy(); stages.delete(svg); }
    root.querySelectorAll('svg').forEach((svg) => {
      if (stages.has(svg) || svg.closest('defs, mask, .fastblob')) return;
      const layers = plan(svg);
      if (!layers || !layers.some((l) => l.kind === 'blob')) return;
      try { stages.set(svg, new Stage(svg, layers)); } catch (e) { /* no WebGL: leave the SVG as it is */ }
    });
  };
  if (!root.__fastblob) {
    root.__fastblob = true;
    let pending = false;
    new MutationObserver(() => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; scan(); }); })
      .observe(root, { childList: true, subtree: true });
  }
  scan();
  // when swapping pages, paint the new blob straight away so the cross-dissolve shows it
  if (now) for (const st of stages.values()) { try { st.draw(); } catch (e) { /* next frame */ } }
  if (looping) return;
  looping = true;
  const loop = () => {
    const t0 = performance.now();
    for (const st of stages.values()) { try { st.draw(); } catch (e) { /* skip a frame */ } }
    if (window.__PERF__) window.__PERF__.blob += performance.now() - t0;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
