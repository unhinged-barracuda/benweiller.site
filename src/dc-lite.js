// dc-lite — runs a Claude Design board (.dc.html) as a live page.
// The board's <x-dc> markup is kept verbatim inside a <template>; this file turns it into
// React elements on every render, and its `class Component extends DCLogic` drives it.
// Keeping the board source unchanged is the point: a tweak made on the design canvas comes
// to the site by copying the board file across (see README).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { startFastBlob } from './fastblob.js';
import { startStampCache } from './stampcache.js';

// ---------- holes ----------
const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
const WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

function lookup(path, scope) {
  if (path === 'true') return true;
  if (path === 'false') return false;
  if (path === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
  if (/^(['"]).*\1$/.test(path)) return path.slice(1, -1);
  const parts = path.split('.');
  let v;
  for (let s = scope; s; s = s.__parent) {
    if (Object.prototype.hasOwnProperty.call(s, parts[0])) { v = s[parts[0]]; break; }
  }
  for (let i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
  return v;
}
function interp(str, scope) {
  return str.replace(HOLE, (_, p) => { const v = lookup(p, scope); return v == null || v === false ? '' : String(v); });
}

// ---------- attribute names (the HTML parser lowercases them; React wants camelCase) ----------
const EVENTS = ['Click','DoubleClick','ContextMenu','MouseDown','MouseUp','MouseMove','MouseEnter','MouseLeave','MouseOver','MouseOut',
  'PointerDown','PointerUp','PointerMove','PointerEnter','PointerLeave','PointerCancel','Wheel','TouchStart','TouchMove','TouchEnd','TouchCancel',
  'KeyDown','KeyUp','KeyPress','Focus','Blur','Change','Input','Submit','Scroll','Load','Error','Ended','Play','Pause','Playing','TimeUpdate',
  'LoadedMetadata','LoadedData','CanPlay','Seeked','Waiting','TransitionEnd','AnimationEnd','AnimationIteration','DragStart','Drop','DragOver'];
const ATTR = { class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', colspan: 'colSpan',
  rowspan: 'rowSpan', crossorigin: 'crossOrigin', srcset: 'srcSet', playsinline: 'playsInline', autoplay: 'autoPlay', contenteditable: 'contentEditable',
  spellcheck: 'spellCheck', allowfullscreen: 'allowFullScreen', autocomplete: 'autoComplete', enterkeyhint: 'enterKeyHint', inputmode: 'inputMode',
  referrerpolicy: 'referrerPolicy', fetchpriority: 'fetchPriority', 'xlink:href': 'xlinkHref', 'xml:space': 'xmlSpace', datetime: 'dateTime',
  accesskey: 'accessKey', novalidate: 'noValidate', formnovalidate: 'formNoValidate', usemap: 'useMap', frameborder: 'frameBorder',
  defaultvalue: 'defaultValue', defaultchecked: 'defaultChecked', disablepictureinpicture: 'disablePictureInPicture', controlslist: 'controlsList' };
EVENTS.forEach((e) => { ATTR['on' + e.toLowerCase()] = 'on' + e; });
const BOOL = new Set(['muted','loop','autoPlay','playsInline','controls','disabled','hidden','checked','selected','readOnly','required','multiple',
  'allowFullScreen','noValidate','open','defer','async','disablePictureInPicture','inert']);

function attrName(n, svg) {
  if (ATTR[n]) return ATTR[n];
  if (n.startsWith('data-') || n.startsWith('aria-')) return n;
  if (svg && n.includes('-')) return n.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return n;
}

// "a: b; --c: d" -> {a:'b','--c':'d'}
function parseStyle(s) {
  const o = {};
  let depth = 0, cur = '';
  const parts = [];
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    const i = p.indexOf(':');
    if (i < 0) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (!k || v === '') continue;
    const key = k.startsWith('--') ? k : k.toLowerCase().replace(/^-(webkit|moz|ms)-/, (m, pre) => pre[0].toUpperCase() + pre.slice(1) + '-').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    o[key] = v.replace(/\s*!important\s*$/, '');
  }
  return o;
}

// ---------- template -> render function ----------
function compileChildren(parent, svg) {
  const out = [];
  parent.childNodes.forEach((n) => { const c = compileNode(n, svg); if (c) out.push(c); });
  return out;
}

function compileNode(node, svgParent) {
  if (node.nodeType === 3) {
    const t = node.nodeValue;
    if (svgParent && !t.trim()) return null;
    const m = t.match(WHOLE);
    if (m) return (scope) => { const v = lookup(m[1], scope); return v == null || v === false ? null : v; };
    if (!t.includes('{{')) return () => t;
    return (scope) => interp(t, scope);
  }
  if (node.nodeType !== 1) return null;
  const tag = node.localName;
  if (tag === 'helmet' || tag === 'script') return null;

  if (tag === 'sc-for') {
    const list = node.getAttribute('list') || '';
    const as = node.getAttribute('as') || 'item';
    const kids = compileChildren(node.content || node, svgParent);
    const lm = list.match(WHOLE);
    return (scope) => {
      const arr = lm ? lookup(lm[1], scope) : null;
      if (!arr || !arr.length) return null;
      return arr.map((it, i) => {
        const s = { [as]: it, $index: i, __parent: scope };
        return React.createElement(React.Fragment, { key: (it && it.key != null) ? it.key : i }, ...kids.map((k) => k(s)));
      });
    };
  }
  if (tag === 'sc-if') {
    const val = node.getAttribute('value') || '';
    const kids = compileChildren(node, svgParent);
    const vm = val.match(WHOLE);
    return (scope) => {
      const v = vm ? lookup(vm[1], scope) : val;
      if (!v) return null;
      return React.createElement(React.Fragment, null, ...kids.map((k) => k(scope)));
    };
  }

  const svg = svgParent || tag === 'svg';
  const inForeign = tag === 'foreignObject';
  const statics = {};
  const dyn = [];
  for (const a of Array.from(node.attributes)) {
    if (a.name.startsWith('hint-')) continue;
    const name = attrName(a.name, svg && !inForeign);
    const v = a.value;
    if (name === 'style') {
      if (v.includes('{{')) dyn.push([name, (s) => parseStyle(interp(v, s))]);
      else statics.style = parseStyle(v);
      continue;
    }
    const m = v.match(WHOLE);
    if (m) dyn.push([name, (s) => lookup(m[1], s)]);
    else if (v.includes('{{')) dyn.push([name, (s) => interp(v, s)]);
    else if (BOOL.has(name)) statics[name] = v === '' || v === name.toLowerCase() || v === 'true';
    else statics[name] = v;
  }
  if (tag === 'video' && statics.muted) statics.defaultMuted = true;
  const src = tag === 'template' ? node.content : node;
  const kids = compileChildren(src, svg && !inForeign);
  const elTag = tag === 'template' ? React.Fragment : node.localName;
  return (scope) => {
    const props = Object.assign({}, statics);
    for (const [k, f] of dyn) {
      const val = f(scope);
      if (val === undefined || val === null || (val === false && !k.startsWith('aria-'))) continue;
      if (k === 'className' && typeof val !== 'string') { props[k] = String(val); continue; }
      props[k] = val;
    }
    if (tag === 'img') sizeImg(props);
    const ch = kids.map((k) => k(scope));
    return React.createElement(elTag, props, ...ch);
  };
}

// ---------- images: load as they come near the screen, and let phones pick a smaller copy ----------
const IMGRE = /\/assets\/([0-9a-f]{32})\.webp$/;
function sizeImg(props) {
  if (props.loading === undefined) props.loading = 'lazy';
  if (props.decoding === undefined) props.decoding = 'async';
  const m = typeof props.src === 'string' && props.src.match(IMGRE);
  const info = m && window.__IMG__ && window.__IMG__[m[1]];
  if (!info || props.srcSet) return;
  props.srcSet = info.v.map((w, i) => `/assets/${m[1]}-${[800, 1600][i]}.webp ${w}w`).concat(`${props.src} ${info.w}w`).join(', ');
  // the column is 900px wide on desktop and full width on phones; full-screen views ask for more
  if (!props.sizes) props.sizes = '(max-width: 767px) 100vw, (max-width: 1100px) 88vw, 900px';
}

// ---------- ?perf: a small readout of where each frame's time goes (for checking speed on a real device) ----------
export const PERF = /[?&]perf\b/.test(location.search) ? { render: 0, renders: 0, blob: 0, frames: 0, worst: 0, last: 0, gaps: [] } : null;
if (PERF) {
  window.__PERF__ = PERF;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;font:11px/1.4 ui-monospace,Menlo,monospace;background:rgba(0,0,0,.78);color:#fff;padding:8px 10px;border-radius:6px;pointer-events:none;white-space:pre';
  const tick = (t) => {
    if (PERF.last) { const g = t - PERF.last; PERF.gaps.push(g); if (g > PERF.worst) PERF.worst = g; }
    PERF.last = t; PERF.frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(() => {
    const n = Math.max(1, PERF.gaps.length), avg = PERF.gaps.reduce((a, b) => a + b, 0) / n;
    const slow = PERF.gaps.filter((g) => g > 50).length;
    box.textContent = 'fps      ' + Math.round(1000 / (avg || 16.7)) + '\nworst    ' + Math.round(PERF.worst) + ' ms\nslow>50  ' + slow +
      '\nrender   ' + (PERF.render / n).toFixed(1) + ' ms/frame (' + PERF.renders + ')\nblob     ' + (PERF.blob / n).toFixed(1) + ' ms/frame' +
      '\nwebgl    ' + (document.querySelector('canvas.fastblob') ? 'on' : 'OFF') + (window.__glLost ? ' (lost ' + window.__glLost + 'x)' : '') + '\n' + navigator.userAgent.replace(/^.*\) /, '').slice(0, 40) +
      ((window.__dcErrors || []).length ? '\nERRORS:\n' + window.__dcErrors.slice(-4).join('\n') : '');
    PERF.gaps = []; PERF.worst = 0; PERF.render = 0; PERF.renders = 0; PERF.blob = 0;
    if (!box.isConnected) document.body.appendChild(box);
  }, 1000);
}

// ---------- the base class boards extend ----------
export class DCLogic extends React.Component {
  renderVals() { return {}; }
  render() {
    const t0 = PERF ? performance.now() : 0;
    const vals = this.renderVals() || {};
    const tree = this.__tpl.map((f) => f(vals));
    if (PERF) { PERF.render += performance.now() - t0; PERF.renders++; }
    return React.createElement(React.Fragment, null, ...tree);
  }
}

let helmetNodes = [];
function applyHelmet(frag) {
  const h = frag.querySelector('helmet');
  if (!h) return;
  const prev = helmetNodes; helmetNodes = [];
  Array.from(h.children).forEach((el) => {
    const c = el.cloneNode(true);
    // a <style> or <link> cloned from a template is inert; recreate it so the browser applies it
    const fresh = document.createElement(c.localName);
    Array.from(c.attributes).forEach((a) => fresh.setAttribute(a.name, a.value));
    fresh.textContent = c.textContent;
    // the same font / stylesheet link twice is harmless but wasteful: reuse it
    const same = fresh.localName === 'link' && prev.find((n) => n.localName === 'link' && n.getAttribute('href') === fresh.getAttribute('href'));
    if (same) { helmetNodes.push(same); prev.splice(prev.indexOf(same), 1); return; }
    document.head.appendChild(fresh);
    helmetNodes.push(fresh);
  });
  // the previous page's styles go once the new ones are in
  prev.forEach((n) => n.remove());
}

// if a board ever throws while rendering, don't leave a blank page: log it and redraw it fresh (a few times at most)
class Guard extends React.Component {
  constructor(p) { super(p); this.state = { n: 0, failed: false }; this.tries = 0; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) {
    noteError(err);
    if (this.tries++ < 3) setTimeout(() => this.setState((s) => ({ n: s.n + 1, failed: false })), 30);
  }
  render() { return this.state.failed ? null : React.createElement(React.Fragment, { key: this.state.n }, this.props.children); }
}
export function noteError(err) {
  const msg = (err && (err.message || err.reason && err.reason.message || err.reason)) || String(err);
  (window.__dcErrors = window.__dcErrors || []).push(String(msg).slice(0, 160));
}
window.addEventListener('error', (e) => noteError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => noteError(e.reason));

let reactRoot = null;
export function mount(tplEl, scriptEl, mountEl, sync) {
  const frag = tplEl.content;
  applyHelmet(frag);
  const xdc = frag.querySelector('x-dc') || frag;
  const tpl = compileChildren(xdc, false);
  let props = {};
  try {
    const dp = JSON.parse(scriptEl.getAttribute('data-props') || '{}');
    for (const k in dp) if (k[0] !== '$' && dp[k] && 'default' in dp[k]) props[k] = dp[k].default;
  } catch (e) { /* ignore */ }
  // eslint-disable-next-line no-new-func
  const Component = new Function('DCLogic', 'React', scriptEl.textContent + '\n;return Component;')(DCLogic, React);
  Component.prototype.__tpl = tpl;
  if (reactRoot) reactRoot.unmount();
  reactRoot = createRoot(mountEl);
  const el = React.createElement(Guard, null, React.createElement(Component, props));
  if (sync) flushSync(() => reactRoot.render(el)); else reactRoot.render(el);
  if (sync) startFastBlob(mountEl, true); else requestAnimationFrame(() => startFastBlob(mountEl));
  requestAnimationFrame(() => startStampCache(mountEl));
}

// ---------- films: the boards show a cover + glass play button; on the live site a click loads the Vimeo player in place ----------
// (nothing loads from Vimeo until someone presses play; the film id comes from that film's "watch on vimeo" link)
function vimeoFor(card) {
  for (let el = card; el && el !== document.body; el = el.parentElement) {
    const links = el.querySelectorAll('a[href*="vimeo.com/"]');
    if (links.length) {
      // the link that belongs to this film is the first one after it in the page
      for (const a of links) if (card.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const m = a.getAttribute('href').match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([0-9a-f]+))?/);
        if (m) return m;
      }
    }
  }
  return null;
}
document.addEventListener('click', (e) => {
  const card = e.target.closest && e.target.closest('a.card');
  if (!card || card.getAttribute('href') !== '#') return;
  e.preventDefault();
  if (card.querySelector('iframe.vplayer')) return;
  const m = vimeoFor(card);
  if (!m) return;
  const q = 'autoplay=1&dnt=1&playsinline=1&title=0&byline=0&portrait=0&loop=0' + (m[2] ? '&h=' + m[2] : '');
  const f = document.createElement('iframe');
  f.className = 'vplayer';
  f.src = 'https://player.vimeo.com/video/' + m[1] + '?' + q;
  f.allow = 'autoplay; fullscreen; picture-in-picture';
  f.allowFullscreen = true;
  f.title = card.getAttribute('aria-label') || 'film';
  f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;z-index:5;background:#000';
  // keep the flip on the glass button visible for a beat, then the player takes over
  setTimeout(() => { card.appendChild(f); card.removeAttribute('href'); card.style.cursor = 'default'; }, 450);
}, false);

// ---------- page boot: pick the desktop or the mobile board ----------
function pick() {
  const cfg = window.__DC_PAGE__ || {};
  const w = window.innerWidth;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  // phones always get the mobile boards; tablets get them only for the pages that say so (homepage, menu)
  let mobile = w < 768;
  if (!mobile && cfg.tabletMobile && coarse && Math.min(w, window.innerHeight) < 1100) mobile = true;
  const want = mobile ? 'mobile' : 'desktop';
  const tpl = document.getElementById('dc-' + want) || document.getElementById('dc-desktop') || document.getElementById('dc-mobile');
  return tpl;
}

// ---------- pages ----------
let currentTpl = null;
function warmImages(script) {
  const urls = [...new Set((script.textContent.match(/\/assets\/[0-9a-f]{32}\.(?:webp|jpg|jpeg|png)/g) || []))];
  let i = 0;
  const next = () => { if (i >= urls.length) return; const im = new Image(); im.onload = im.onerror = next; im.src = urls[i++]; };
  next(); next();
}
function start(sync) {
  const tpl = pick();
  if (!tpl) return;
  const script = document.getElementById(tpl.id + '-logic');
  const root = document.getElementById('dc-root');
  document.documentElement.dataset.board = tpl.id.replace('dc-', '');
  currentTpl = tpl.id;
  mount(tpl, script, root, sync);
  setBackUp((window.__DC_PAGE__ || {}).backUp);
  // pages whose images appear on hover (the menu's thumbnail card) warm them up once the page has settled
  if ((window.__DC_PAGE__ || {}).preload) {
    if (document.readyState === 'complete') setTimeout(() => warmImages(script), 600); else window.addEventListener('load', () => setTimeout(() => warmImages(script), 600), { once: true });
  }
}

// ---------- scrolling up on a page that says so (the menu) goes back to the homepage, like scrolling down on the homepage opens the menu ----------
let backUp = null;
function setBackUp(path) {
  if (backUp) { backUp.off(); backUp = null; }
  if (!path) return;
  const t0 = Date.now();
  let acc = 0, wt = 0, ty = null;
  const fire = () => { if (Date.now() - t0 < 800) return; go(new URL(path, location.href), true); };
  const wheel = (e) => {
    if (e.deltaY < 0) { acc -= e.deltaY; clearTimeout(wt); wt = setTimeout(() => { acc = 0; }, 400); if (acc > 120) { acc = 0; fire(); } } else acc = 0;
  };
  const ts = (e) => { const t = e.touches && e.touches[0]; ty = t ? [t.clientX, t.clientY] : null; };
  const te = (e) => { const t = e.changedTouches && e.changedTouches[0]; if (ty && t) { const dx = t.clientX - ty[0], dy = t.clientY - ty[1]; if (dy > 60 && Math.abs(dy) > Math.abs(dx) * 1.5) fire(); } ty = null; };
  const key = (e) => { if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return; if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); fire(); } };
  window.addEventListener('wheel', wheel, { passive: true });
  window.addEventListener('touchstart', ts, { passive: true });
  window.addEventListener('touchend', te, { passive: true });
  window.addEventListener('keydown', key);
  backUp = { off: () => { clearTimeout(wt); window.removeEventListener('wheel', wheel); window.removeEventListener('touchstart', ts); window.removeEventListener('touchend', te); window.removeEventListener('keydown', key); } };
}

// ---------- moving between pages without reloading: the next page is fetched, swapped in and cross-dissolved ----------
const pageCache = new Map();
function fetchPage(url) {
  const key = url.pathname;
  if (!pageCache.has(key)) pageCache.set(key, fetch(key, { credentials: 'same-origin' }).then((r) => r.text()).catch((e) => { pageCache.delete(key); throw e; }));
  return pageCache.get(key);
}
function sameSite(a) {
  if (!a || !a.href || a.target === '_blank' || a.hasAttribute('download')) return null;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || /^\/(assets|_tool)\//.test(url.pathname) || /\.[a-z0-9]+$/i.test(url.pathname)) return null;
  if (url.pathname === location.pathname && url.hash) return null; // a jump within the page
  return url;
}
function swapIn(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.title = doc.title;
  const cfg = doc.querySelector('head script:not([src])');
  if (cfg) { try { (0, eval)(cfg.textContent); } catch (e) { /* keep the old config */ } }
  document.querySelectorAll('body > template[id^="dc-"], body > script[type="text/x-dc"]').forEach((n) => n.remove());
  doc.querySelectorAll('body > template[id^="dc-"], body > script[type="text/x-dc"]').forEach((n) => document.body.appendChild(document.importNode(n, true)));
  const canon = doc.querySelector('link[rel="canonical"]'), mine = document.querySelector('link[rel="canonical"]');
  if (canon && mine) mine.href = canon.href;
}
let navigating = false, queued = null, renderedPath = location.pathname;
async function go(url, push) {
  if (navigating) { queued = [url, push]; return; }
  navigating = true;
  try {
    const html = await fetchPage(url);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const swap = () => {
      swapIn(html);
      if (push) history.pushState({ dc: 1 }, '', url.pathname + url.search + url.hash);
      window.scrollTo(0, 0);
      renderedPath = url.pathname;
      start(true);
    };
    if (!reduce && document.startViewTransition) {
      const vt = document.startViewTransition(swap);
      await vt.updateCallbackDone.catch(() => {});
    } else if (!reduce) {
      const root = document.getElementById('dc-root');
      root.style.transition = 'opacity 260ms ease'; root.style.opacity = '0';
      await new Promise((r) => setTimeout(r, 260));
      swap();
      requestAnimationFrame(() => { root.style.transition = 'opacity 420ms ease'; root.style.opacity = '1'; });
    } else swap();
  } catch (e) {
    location.href = url.href; // anything unexpected: a normal page load
  } finally {
    navigating = false;
    if (queued) { const [u, p] = queued; queued = null; if (u.pathname !== renderedPath) go(u, p); }
  }
}
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest && e.target.closest('a[href]');
  const url = sameSite(a);
  if (!url) return;
  e.preventDefault();
  if (url.pathname === location.pathname && !url.hash) return;
  go(url, true);
});
// fetch a page as soon as the pointer heads for its link, so the swap is instant
const warmLink = (e) => { const url = sameSite(e.target.closest && e.target.closest('a[href]')); if (url && url.pathname !== location.pathname) fetchPage(url); };
document.addEventListener('pointerover', warmLink, { passive: true });
document.addEventListener('touchstart', warmLink, { passive: true });
window.addEventListener('popstate', () => go(new URL(location.href), false));

function boot() {
  history.replaceState({ dc: 1 }, '');
  // keep this page's own markup, so coming back to it later needs no download
  pageCache.set(location.pathname, Promise.resolve('<!doctype html>' + document.documentElement.outerHTML));
  start(false);
  // the homepage leads to the menu: have it ready
  if (location.pathname === '/') setTimeout(() => fetchPage(new URL('/work/', location.href)), 1200);
  // crossing the phone breakpoint (rotate, resize) swaps boards: simplest is a reload
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { const n = pick(); if (n && n.id !== currentTpl) location.reload(); }, 250); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
