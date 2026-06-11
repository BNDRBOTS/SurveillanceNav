/**
 * WCAG 2.2 contrast audit for the Void & Glow token system.
 * Computes relative-luminance contrast ratios for every meaningful
 * foreground/background pair on both surfaces (void chrome + bone paper)
 * and fails CI if any pair drops below its threshold:
 *   - normal text: ≥ 4.5:1 (AA)
 *   - large/bold text (≥19px bold or 24px): ≥ 3:1
 *   - non-text UI component boundaries (inputs, chips): ≥ 3:1 (1.4.11)
 */
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const DARK = {
  bg: '#050505', bg2: '#0E0F10', bg3: '#161718',
  text: '#F4F4F2', text2: '#9BA0A6',
  accent: '#00E5A8', accentInk: '#03251B',
  danger: '#FF4D4D', warning: '#FFB347', success: '#4ADE80',
  borderStrong: '#62686F',
};
const PAPER = {
  bg: '#EDEAE3', bg2: '#F4F2EC', bg3: '#FBFAF7',
  text: '#16171A', text2: '#5B6066',
  accent: '#006F55', accentInk: '#F4F4F2',
  danger: '#C2342C', warning: '#8A5A00', success: '#1B6E3C',
  borderStrong: '#7C7868',
};
const TECH = ['#00E5A8', '#FFD166', '#FF4D4D', '#FF8E3C', '#B98CFF', '#FF5CA8', '#4ADE80', '#19D3DA', '#ACFF3C', '#8A9099'];

const checks = [];
const add = (name, fg, bg, min) => checks.push({ name, fg, bg, min, ratio: ratio(fg, bg) });

for (const [label, t] of [['void', DARK], ['paper', PAPER]]) {
  for (const surface of ['bg', 'bg2', 'bg3']) {
    add(`${label}: primary text on ${surface}`, t.text, t[surface], 4.5);
    add(`${label}: secondary text on ${surface}`, t.text2, t[surface], 4.5);
    add(`${label}: accent text on ${surface}`, t.accent, t[surface], 4.5);
    add(`${label}: danger text on ${surface}`, t.danger, t[surface], 4.5);
    add(`${label}: warning text on ${surface}`, t.warning, t[surface], 4.5);
    add(`${label}: success text on ${surface}`, t.success, t[surface], 4.5);
    add(`${label}: interactive border on ${surface}`, t.borderStrong, t[surface], 3);
  }
  add(`${label}: primary button ink on accent`, t.accentInk, t.accent, 4.5);
  add(`${label}: focus ring vs ${label} bg`, t.accent, t.bg, 3);
}
// map markers are ≥10px glowing dots with dark stroke — graphical objects (3:1)
TECH.forEach((c, i) => add(`marker[${i}] on void map`, c, '#050505', 3));
// table headers on paper use inverted charcoal header
add('paper: table header text', '#C9CCCF', '#16171A', 4.5);

let failed = 0;
for (const c of checks) {
  const ok = c.ratio >= c.min;
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗ FAIL'} ${c.name}: ${c.ratio.toFixed(2)}:1 (min ${c.min}:1) [${c.fg} on ${c.bg}]`);
}
console.log(`\n${checks.length - failed}/${checks.length} contrast checks pass`);
process.exit(failed === 0 ? 0 : 1);
