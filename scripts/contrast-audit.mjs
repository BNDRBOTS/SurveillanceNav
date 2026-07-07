/**
 * WCAG 2.2 contrast audit — parses the LIVE token file
 * (web/src/styles/tokens.css) and the shared marker palette
 * (shared/src/constants.ts) so this gate can never drift from the shipped
 * theme. Every meaningful foreground/background pair is checked:
 *   - normal text: ≥ 4.5:1 (AA)
 *   - large/bold text (≥19px bold or 24px): ≥ 3:1
 *   - non-text UI boundaries (inputs, focus, markers): ≥ 3:1 (1.4.11)
 * Translucent glass surfaces are alpha-composited over the void background
 * before checking, which is what the eye actually sees.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokensCss = fs.readFileSync(path.join(root, 'web/src/styles/tokens.css'), 'utf8');
const constantsTs = fs.readFileSync(path.join(root, 'shared/src/constants.ts'), 'utf8');

/* ---------- token parsing ---------- */

// Only the base :root block — high-contrast overrides are a separate, stricter theme.
const rootBlock = tokensCss.slice(0, tokensCss.indexOf('[data-contrast="high"]'));
const tokens = {};
for (const m of rootBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();

const need = (name) => {
  const v = tokens[name];
  if (!v) {
    console.error(`✗ token ${name} missing from tokens.css — audit cannot run`);
    process.exit(1);
  }
  return v;
};

/** #rgb/#rrggbb or rgba() → { r, g, b, a } in 0-255 / 0-1. */
function parseColor(raw) {
  const s = raw.trim();
  let m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error(`Cannot parse color: ${raw}`);
}

/** Composite a (possibly translucent) color over an opaque backdrop. */
function over(fg, bg) {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

const lum = ({ r, g, b }) => {
  const [lr, lg, lb] = [r, g, b]
    .map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = ({ r, g, b }) =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/* ---------- palette under test ---------- */

const bg1 = parseColor(need('--color-bg-primary'));
const bg2 = parseColor(need('--color-bg-secondary'));
const bg3 = parseColor(need('--color-bg-tertiary'));
const glass = over(parseColor(need('--glass-bg')), bg1);
const glassHeavy = over(parseColor(need('--glass-bg-heavy')), bg1);

const text = parseColor(need('--color-text-primary'));
const text2 = parseColor(need('--color-text-secondary'));
const accent = parseColor(need('--color-accent'));
const accentInk = parseColor(need('--color-accent-ink'));
const danger = parseColor(need('--color-danger'));
const warning = parseColor(need('--color-warning'));
const success = parseColor(need('--color-success'));
const focusRing = parseColor(need('--color-focus-ring'));
const borderStrong = over(parseColor(need('--color-border-strong')), bg1);
const extended = ['--color-purple', '--color-cement', '--color-pink', '--color-cyan', '--color-orange'];

// map marker palette — parse TECH_COLORS literal from shared constants
const techBlock = constantsTs.match(/TECH_COLORS[^{]*\{([^}]+)\}/);
if (!techBlock) {
  console.error('✗ TECH_COLORS not found in shared/src/constants.ts');
  process.exit(1);
}
const markers = [...techBlock[1].matchAll(/(\w+):\s*'(#[0-9a-fA-F]{6})'/g)].map(([, name, color]) => ({
  name,
  color: parseColor(color),
}));
// dark basemap land tone (worst-case backdrop for markers) — from mapStyle.ts
const mapLand = parseColor('#0E0F10');

/* ---------- checks ---------- */

const checks = [];
const add = (name, fg, bg, min) => checks.push({ name, fg, bg, min, ratio: ratio(fg, bg) });

const surfaces = [
  ['void', bg1],
  ['void-2', bg2],
  ['void-3', bg3],
  ['glass', glass],
  ['glass-heavy', glassHeavy],
];
for (const [label, surface] of surfaces) {
  add(`primary text on ${label}`, text, surface, 4.5);
  add(`secondary text on ${label}`, text2, surface, 4.5);
  add(`accent text on ${label}`, accent, surface, 4.5);
  add(`danger text on ${label}`, danger, surface, 4.5);
  add(`warning text on ${label}`, warning, surface, 4.5);
  add(`success text on ${label}`, success, surface, 4.5);
}
add('button ink on accent fill', accentInk, accent, 4.5);
add('focus ring vs void', focusRing, bg1, 3);
add('focus ring vs glass-heavy', focusRing, glassHeavy, 3);
add('interactive border vs void', borderStrong, bg1, 3);
for (const name of extended) {
  add(`${name.replace('--color-', '')} (icon/badge) on void`, parseColor(need(name)), bg1, 3);
}
for (const m of markers) add(`marker ${m.name} on dark basemap`, m.color, mapLand, 3);

/* ---------- report ---------- */

let failed = 0;
for (const c of checks) {
  const ok = c.ratio >= c.min;
  if (!ok) failed += 1;
  console.log(
    `${ok ? '✓' : '✗ FAIL'} ${c.name}: ${c.ratio.toFixed(2)}:1 (min ${c.min}:1) [${hex(c.fg)} on ${hex(c.bg)}]`,
  );
}
console.log(`\n${checks.length - failed}/${checks.length} contrast checks pass`);
process.exit(failed === 0 ? 0 : 1);
