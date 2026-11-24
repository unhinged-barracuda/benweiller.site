// Clean-code audit for the boards the site uses (Ben's "keeping it clean" rule: change the original, don't patch on top).
//   node tools/audit-boards.mjs            print the table; exit 1 if any board got worse than tools/audit-baseline.json
//   node tools/audit-boards.mjs --lower    after a cleanup: lower the baseline to the new counts (it never goes up)
// The build runs this too and stops if a board got worse. Goal for every board: all zeros.
//
// What it counts, per board (CSS comments ignored):
//   important   rules forced with !important
//   styleMatch  rules that find elements by text in their inline style ([style*="…"]) to change them from outside
//   dupSelector the same selector written more than once (the later one partly overrides the first)
//   dupKeyframe the same @keyframes written more than once
//   unusedClass classes styled in the CSS that nothing on the page uses (left over from other boards / earlier versions)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from './routes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = path.join(ROOT, 'tools/audit-baseline.json');
const KEYS = ['important', 'styleMatch', 'dupSelector', 'dupKeyframe', 'unusedClass'];

export function auditBoard(src) {
  const css = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const rest = src.replace(/<style>[\s\S]*?<\/style>/g, '');
  const important = (css.match(/!important/g) || []).length;
  const styleMatch = (css.match(/\[style\*=/g) || []).length;
  // selectors of plain rules (top level and inside @media), keyframe steps left out
  const noKf = css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
  const sels = [...noKf.matchAll(/(?:^|[{};])\s*([^{};@][^{};]*?)\s*\{[^{}]*\}/g)].map((m) => m[1].trim().replace(/\s+/g, ' '));
  const count = (a) => a.reduce((o, k) => ((o[k] = (o[k] || 0) + 1), o), {});
  const over = (o) => Object.values(o).reduce((n, c) => n + Math.max(0, c - 1), 0);
  const dupSelector = over(count(sels));
  const dupKeyframe = over(count([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])));
  // a class counts as used if it's in a class attribute or appears as a word in the board's markup or script
  const classes = [...new Set([...noKf.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))];
  const used = (c) => new RegExp('(^|[^\\w-])' + c.replace(/-/g, '\\-') + '($|[^\\w-])').test(rest);
  const unused = classes.filter((c) => !used(c));
  return { important, styleMatch, dupSelector, dupKeyframe, unusedClass: unused.length, unused };
}

export function auditAll() {
  const boards = [...new Set(ROUTES.flatMap((r) => [r.desktop, r.mobile]).filter(Boolean))];
  const out = {};
  for (const b of boards) out[b] = auditBoard(fs.readFileSync(path.join(ROOT, 'design/boards', b + '.dc.html'), 'utf8'));
  return out;
}

// compare with the baseline: returns the list of boards / counts that got worse
export function worse(res, base) {
  const bad = [];
  for (const [b, r] of Object.entries(res)) for (const k of KEYS) {
    const was = base[b] ? base[b][k] : 0; // a board not in the baseline must be clean
    if (r[k] > was) bad.push(b + ' ' + k + ' ' + was + ' → ' + r[k]);
  }
  return bad;
}

export function table(res) {
  const pad = (s, n) => String(s).padStart(n);
  const lines = ['board'.padEnd(24) + KEYS.map((k) => pad(k, 12)).join('')];
  const tot = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const [b, r] of Object.entries(res)) { lines.push(b.padEnd(24) + KEYS.map((k) => pad(r[k], 12)).join('')); KEYS.forEach((k) => (tot[k] += r[k])); }
  lines.push('TOTAL'.padEnd(24) + KEYS.map((k) => pad(tot[k], 12)).join(''));
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const res = auditAll();
  const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : null;
  console.log(table(res));
  if (process.argv.includes('--verbose')) for (const [b, r] of Object.entries(res)) if (r.unused.length) console.log(b + ' unused: ' + r.unused.join(' '));
  if (process.argv.includes('--lower') || !base) {
    const next = {};
    for (const [b, r] of Object.entries(res)) next[b] = Object.fromEntries(KEYS.map((k) => [k, base && base[b] ? Math.min(base[b][k], r[k]) : r[k]]));
    fs.writeFileSync(BASE, JSON.stringify(next, null, 1) + '\n');
    console.log('baseline written: ' + path.relative(ROOT, BASE));
  }
  const bad = base ? worse(res, base) : [];
  if (bad.length) { console.error('\nWORSE than the baseline (fix the board, do not raise the baseline):\n  ' + bad.join('\n  ')); process.exit(1); }
}
