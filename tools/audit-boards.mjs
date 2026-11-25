// Clean-code audit for the boards the site uses. The intention behind it (Ben, Nov 24): the most efficient, cleanest, most
// effective code possible. Every change replaces the original instead of fixing or updating on top of it, so a board always
// reads as if it had been written that way from the start. It checks the families of ways code piles up, not one spelling of each:
//
//   force    a value forced over another: !important anywhere (CSS, inline styles, script)
//   outside  an element changed from outside by matching its inline style ([style*=…], [style^=…], [style~=…] …)
//   repeat   the same thing written twice: a selector twice in one context (each @media block is its own context), a
//            property twice in one rule, @keyframes twice, or an inline style that sets a property its own class sets
//   dead     code that does nothing: CSS for classes the board doesn't use, @keyframes nothing runs, empty rules, and
//            values the script hands to the markup (renderVals) that the markup never uses, and state nothing reads
//
//   node tools/audit-boards.mjs            the table and every finding by name; exit 1 if anything got worse
//   node tools/audit-boards.mjs --lower    after a cleanup: lower tools/audit-baseline.json (it never goes up)
// The build runs it and stops if any board is worse than the baseline, or if the site's own code forces a value or matches
// inline styles. Every board is at zero, so the baseline is the rule: zero.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from './routes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = path.join(ROOT, 'tools/audit-baseline.json');
export const KEYS = ['force', 'outside', 'repeat', 'dead'];
export const SITE_FILES = ['tools/build.mjs', 'src/dc-lite.js', 'src/fastblob.js', 'src/stampcache.js'];

const KF = /@keyframes\s+([\w-]+)\s*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g;
const MEDIA = /(@media[^{]*)\{((?:[^{}]*\{[^}]*\})*[^}]*)\}/g;
const RULES = /(?<=^|[{};])\s*([^{};@][^{};]*?)\s*\{([^{}]*)\}/g;
const props = (decls) => decls.split(/;(?![^(]*\))/).map((d) => d.split(':')[0].trim().toLowerCase()).filter(Boolean);
const count = (a) => a.reduce((o, k) => ((o[k] = (o[k] || 0) + 1), o), {});
const twice = (o) => Object.keys(o).filter((k) => o[k] > 1);

// the top-level keys of the object literal that starts at index `open` (the { itself)
function objectKeys(script, open) {
  const keys = [];
  let depth = 0, start = true;
  for (let i = open; i < script.length; i++) {
    const ch = script[i];
    if (ch === '/' && script[i + 1] === '/') { i = script.indexOf('\n', i); continue; }
    if (ch === '/' && script[i + 1] === '*') { i = script.indexOf('*/', i) + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { for (i++; i < script.length && script[i] !== ch; i++) if (script[i] === '\\') i++; start = false; continue; }
    if ('{[('.includes(ch)) { depth++; if (depth === 1) start = true; continue; }
    if ('}])'.includes(ch)) { depth--; if (depth === 0) break; continue; }
    if (depth !== 1) continue;
    if (ch === ',') { start = true; continue; }
    if (start && /\s/.test(ch)) continue;
    if (start) { const m = script.slice(i).match(/^([A-Za-z_$][\w$]*)\s*(:|,|\})/); if (m) keys.push(m[1]); start = false; }
  }
  return keys;
}

// state the script sets up but never reads (this.state.x / state.x)
function unreadState(script) {
  const code = script.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const m = code.match(/this\.state = \{/);
  if (!m) return [];
  return objectKeys(code, m.index + m[0].length - 1).filter((k) => !new RegExp('state\\.' + k.replace(/\$/g, '\\$') + '(?![\\w$])').test(code));
}

// the top-level keys of renderVals()'s returned object
function returnedKeys(script) {
  const at = script.indexOf('renderVals()');
  if (at < 0) return [];
  const end = script.indexOf('\n  }\n', at);
  const ret = script.lastIndexOf('\n    return {', end > 0 ? end : script.length) + 1; // the method's own return (4 spaces in), not one inside a .map()
  if (ret <= at) return [];
  const keys = [];
  let depth = 0, start = true;
  for (let i = script.indexOf('{', ret); i < script.length; i++) {
    if (i === script.indexOf('{', ret)) { depth = 1; start = true; continue; }
    const ch = script[i];
    if (ch === '/' && script[i + 1] === '/') { i = script.indexOf('\n', i); continue; }
    if (ch === '/' && script[i + 1] === '*') { i = script.indexOf('*/', i) + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { for (i++; i < script.length && script[i] !== ch; i++) if (script[i] === '\\') i++; start = false; continue; }
    if ('{[('.includes(ch)) { depth++; if (depth === 1) start = true; continue; }
    if ('}])'.includes(ch)) { depth--; if (depth === 0) break; continue; }
    if (depth !== 1) continue;
    if (ch === ',') { start = true; continue; }
    if (start && /\s/.test(ch)) continue;
    if (start) {
      const m = script.slice(i).match(/^([A-Za-z_$][\w$]*)\s*(:|,|\})/);
      if (m) keys.push(m[1]);
      start = false;
    }
  }
  return keys;
}

export function auditBoard(src) {
  const css = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const scriptAt = src.indexOf('<script type="text/x-dc"');
  const script = scriptAt < 0 ? '' : src.slice(scriptAt);
  const markup = (scriptAt < 0 ? src : src.slice(0, scriptAt)).replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const rest = src.replace(/<style>[\s\S]*?<\/style>/g, '');
  const f = { force: [], outside: [], repeat: [], dead: [] };

  // force
  const imp = (src.match(/!\s*important/g) || []).length;
  if (imp) f.force.push(imp + '× !important');

  // outside
  for (const m of css.matchAll(/[^{};]*\[style[^\]]*\][^{]*\{/g)) f.outside.push(m[0].replace(/\s+/g, ' ').trim().slice(0, 90));

  // repeat
  const noKf = css.replace(KF, '');
  const ctx = { '': noKf.replace(MEDIA, '') };
  for (const m of noKf.matchAll(MEDIA)) ctx[m[1].trim()] = (ctx[m[1].trim()] || '') + m[2];
  const top = [];
  for (const [c, body] of Object.entries(ctx)) {
    const rules = [...body.matchAll(RULES)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2]]);
    if (!c) top.push(...rules);
    twice(count(rules.map((r) => r[0]))).forEach((s) => f.repeat.push('selector twice: ' + (c ? c + ' ' : '') + s));
    rules.forEach(([s, b]) => twice(count(props(b))).forEach((p) => f.repeat.push('property twice: ' + s + ' { ' + p + ' }')));
    rules.filter(([, b]) => !b.trim()).forEach(([s]) => f.dead.push('empty rule: ' + s));
  }
  const kfs = [...css.matchAll(KF)].map((m) => m[1]);
  twice(count(kfs)).forEach((k) => f.repeat.push('@keyframes twice: ' + k));
  const classProps = {};
  top.forEach(([s, b]) => { const m = s.match(/^\.([\w-]+)$/); if (m) classProps[m[1]] = new Set([...(classProps[m[1]] || []), ...props(b)]); });
  for (const tag of markup.matchAll(/<[a-z][\w-]*\s[^>]*>/g)) {
    const cls = (tag[0].match(/\sclass="([^"]*)"/) || [])[1], st = (tag[0].match(/\sstyle="([^"]*)"/) || [])[1];
    if (!cls || !st) continue;
    const inl = new Set(props(st));
    cls.replace(/\{\{.*?\}\}/g, '').split(/\s+/).filter((c) => classProps[c]).forEach((c) =>
      [...classProps[c]].filter((p) => inl.has(p)).forEach((p) => f.repeat.push('inline over class: .' + c + ' { ' + p + ' }')));
  }

  // dead
  const classes = [...new Set([...noKf.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))];
  const used = (c) => new RegExp('(^|[^\\w-])' + c.replace(/-/g, '\\-') + '($|[^\\w-])').test(rest);
  classes.filter((c) => !used(c)).forEach((c) => f.dead.push('unused class: .' + c));
  [...new Set(kfs)].filter((k) => !new RegExp('animation(-name)?\\s*:[^;}]*\\b' + k + '\\b').test(noKf) && !new RegExp('\\b' + k + '\\b').test(rest))
    .forEach((k) => f.dead.push('@keyframes nothing runs: ' + k));
  unreadState(script).forEach((k) => f.dead.push('state nothing reads: ' + k));
  returnedKeys(script).filter((k) => !new RegExp('\\{\\{\\s*' + k.replace(/\$/g, '\\$') + '\\b').test(markup))
    .forEach((k) => f.dead.push('value the markup never uses: ' + k));

  const out = Object.fromEntries(KEYS.map((k) => [k, f[k].length]));
  out.findings = f;
  return out;
}

export function auditAll() {
  const boards = [...new Set(ROUTES.flatMap((r) => [r.desktop, r.mobile]).filter(Boolean))];
  const out = {};
  for (const b of boards) out[b] = auditBoard(fs.readFileSync(path.join(ROOT, 'design/boards', b + '.dc.html'), 'utf8'));
  return out;
}

// the site's own code: nothing forced, nothing matched by its inline style
export function auditSite() {
  const out = [];
  for (const p of SITE_FILES) {
    const file = path.join(ROOT, p);
    if (!fs.existsSync(file)) continue;
    const code = fs.readFileSync(file, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    if (/!\s*important\s*[;}"'`]/.test(code)) out.push(p + ': !important in CSS it writes');
    if (/\[style[*^$~|]?=/.test(code)) out.push(p + ': CSS that matches inline styles ([style…])');
  }
  return out;
}

// compare with the baseline: the boards / counts that got worse
export function worse(res, base) {
  const bad = [];
  for (const [b, r] of Object.entries(res)) for (const k of KEYS) {
    const was = base[b] && base[b][k] !== undefined ? base[b][k] : 0; // a board not in the baseline must be clean
    if (r[k] > was) bad.push(b + ' ' + k + ' ' + was + ' → ' + r[k] + ':  ' + r.findings[k].join(' | '));
  }
  return bad;
}

export function table(res) {
  const pad = (s, n) => String(s).padStart(n);
  const lines = ['board'.padEnd(24) + KEYS.map((k) => pad(k, 9)).join('')];
  const tot = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const [b, r] of Object.entries(res)) { lines.push(b.padEnd(24) + KEYS.map((k) => pad(r[k], 9)).join('')); KEYS.forEach((k) => (tot[k] += r[k])); }
  lines.push('TOTAL'.padEnd(24) + KEYS.map((k) => pad(tot[k], 9)).join(''));
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const res = auditAll();
  const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : null;
  console.log(table(res));
  for (const [b, r] of Object.entries(res)) for (const k of KEYS) r.findings[k].forEach((x) => console.log('  ' + b + ' · ' + k + ' · ' + x));
  const site = auditSite();
  site.forEach((x) => console.log('  site · ' + x));
  if (process.argv.includes('--lower') || !base) {
    const next = {};
    for (const [b, r] of Object.entries(res)) next[b] = Object.fromEntries(KEYS.map((k) => [k, base && base[b] && base[b][k] !== undefined ? Math.min(base[b][k], r[k]) : r[k]]));
    fs.writeFileSync(BASE, JSON.stringify(next, null, 1) + '\n');
    console.log('baseline written: ' + path.relative(ROOT, BASE));
  }
  const bad = (base ? worse(res, base) : []).concat(site);
  if (bad.length) { console.error('\nWORSE than the baseline (fix the board, do not raise the baseline):\n  ' + bad.join('\n  ')); process.exit(1); }
}
