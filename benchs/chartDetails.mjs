// Build the per-test benchmark chart (SVG): small multiples, one panel per
// individual benchmark, horizontal bars for every framework. Framework order
// is FIXED across panels (sorted by overall total, same as the totals chart)
// so a framework lives on the same row everywhere; each panel has its own
// x-scale because tests differ by orders of magnitude — compare within a
// panel, not across panels. Bars wear the panel's suite color, matching the
// totals chart's legend.
//
// Usage: node benchs/chartDetails.mjs <results.txt> <out.svg> [TITLE] [SUBTITLE]
import { readFileSync, writeFileSync } from 'node:fs';
import { COLOR, GRID, INK, INK2, INK3, SURFACE, SUITES, escXml, parseResults, suiteOf, displayName, isOurs } from './lib.mjs';

const SRC = process.argv[2] ?? 'benchs/results/2026-07-05-isolated-node.txt';
const OUT = process.argv[3] ?? '/tmp/benchmark-details.svg';
const TITLE = process.argv[4] ?? 'Individual benchmark times';
const SUBTITLE = process.argv[5] ?? 'one panel per test, per-panel scale - lower is better';

const rows = parseResults(readFileSync(SRC, 'utf8'));

// test -> Map(framework -> ms), in first-seen test order (= suite order the
// harness runs them in); framework totals for the shared row order.
const tests = new Map();
const totals = new Map();
for (const { framework: fw, test, time } of rows) {
	if (!tests.has(test)) tests.set(test, new Map());
	tests.get(test).set(fw, time);
	totals.set(fw, (totals.get(fw) ?? 0) + time);
}
const frameworks = [...totals.entries()].sort((a, b) => a[1] - b[1]).map(([fw]) => fw);
// Group panels by suite, preserving harness order inside each suite.
const panels = SUITES.flatMap((s) => [...tests.keys()].filter((t) => suiteOf(t) === s));

// ---- layout ----
const COLS = 3;
const MARGIN = 24;
const GUTTER = 18;
const W = 1080;
const PANEL_W = Math.floor((W - 2 * MARGIN - (COLS - 1) * GUTTER) / COLS);
const LABEL_W = 132;
const VALUE_W = 62;
const PLOT_W = PANEL_W - LABEL_W - VALUE_W;
const ROW_H = 15;
const BAR_H = 11;
const PANEL_HEAD = 20;
const PANEL_PAD = 12;
const PANEL_H = PANEL_HEAD + frameworks.length * ROW_H + PANEL_PAD;
const TOP = 72;
const gridRows = Math.ceil(panels.length / COLS);
const H = TOP + gridRows * PANEL_H + 16;

const esc = escXml;
// Long framework names get middle-truncated to the label column.
const shorten = (s) => (s.length <= 20 ? s : s.slice(0, 12) + '…' + s.slice(-7));
const fmt = (v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v >= 10 ? v.toFixed(1) : v.toFixed(2));

let svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">`);
svg.push(`<rect width="${W}" height="${H}" fill="${SURFACE}"/>`);
svg.push(`<text x="${MARGIN}" y="34" font-size="17" font-weight="600" fill="${INK}">${esc(TITLE)}</text>`);
svg.push(`<text x="${MARGIN}" y="54" font-size="12" fill="${INK2}">${esc(SUBTITLE)}</text>`);

// legend (top right): suite colors, only suites present
const usedSuites = SUITES.filter((s) => panels.some((t) => suiteOf(t) === s));
let lx = W - MARGIN;
for (const s of [...usedSuites].reverse()) {
	const tw = s.length * 7 + 22;
	lx -= tw;
	svg.push(`<rect x="${lx}" y="26" width="10" height="10" rx="2" fill="${COLOR[s]}"/>`);
	svg.push(`<text x="${lx + 14}" y="35" font-size="12" fill="${INK2}">${s}</text>`);
}

panels.forEach((test, pi) => {
	const px = MARGIN + (pi % COLS) * (PANEL_W + GUTTER);
	const py = TOP + Math.floor(pi / COLS) * PANEL_H;
	const suite = suiteOf(test);
	const data = tests.get(test);
	const max = Math.max(...data.values());
	svg.push(`<text x="${px}" y="${py + 12}" font-size="12" font-weight="600" fill="${INK}">${esc(test)}</text>`);
	svg.push(`<line x1="${px + LABEL_W}" y1="${py + PANEL_HEAD - 2}" x2="${px + LABEL_W}" y2="${py + PANEL_HEAD + frameworks.length * ROW_H - 2}" stroke="${GRID}" stroke-width="1"/>`);
	frameworks.forEach((fw, i) => {
		const y = py + PANEL_HEAD + i * ROW_H;
		svg.push(`<text x="${px + LABEL_W - 6}" y="${y + BAR_H - 2}" font-size="10" text-anchor="end" fill="${isOurs(fw) ? INK : INK2}"${isOurs(fw) ? ' font-weight="700"' : ''}>${esc(shorten(displayName(fw)))}</text>`);
		const v = data.get(fw);
		if (v === undefined) {
			// crashed/skipped test for this framework — keep the row, mark it
			svg.push(`<text x="${px + LABEL_W + 4}" y="${y + BAR_H - 2}" font-size="10" fill="${INK3}">no data</text>`);
			return;
		}
		const w = Math.max((v / max) * PLOT_W, 1.5);
		svg.push(`<path d="M ${px + LABEL_W} ${y} h ${Math.max(w - 3, 0)} a 3 3 0 0 1 3 3 v ${BAR_H - 6} a 3 3 0 0 1 -3 3 h ${-Math.max(w - 3, 0)} z" fill="${COLOR[suite]}"/>`);
		const best = Math.min(...data.values());
		const p = (v / best - 1) * 100;
		const pct = v === best ? '' : `<tspan fill="${INK3}" font-size="8"> +${p < 9.95 ? p.toFixed(1) : Math.round(p)}%</tspan>`;
		svg.push(`<text x="${px + LABEL_W + w + 4}" y="${y + BAR_H - 2}" font-size="9" fill="${INK2}">${fmt(v)}${pct}</text>`);
	});
});

svg.push('</svg>');
writeFileSync(OUT, svg.join('\n'));
console.log(`wrote ${OUT} (${panels.length} tests x ${frameworks.length} frameworks, ${W}x${H})`);
