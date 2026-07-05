// Build the README benchmark chart (SVG) from the isolated-runner output.
// Stacked horizontal bars: one row per framework, one segment per suite,
// sorted by total time ascending. Specs per the dataviz method: bars <=24px,
// 4px rounded data-end (square baseline), 2px surface gaps between segments,
// hairline solid gridlines, values at bar tips in text ink, legend on top.
import { readFileSync, writeFileSync } from 'node:fs';

// Pipeline: run `node dist/isolated.js` in milomg-reactivity-benchmark/packages/node
// (one process per framework), save its stdout under benchs/results/, then
// `node benchs/chart.mjs <results.txt> <out.svg>` and rasterize the SVG at 2x
// (e.g. headless Chrome --screenshot --force-device-scale-factor=2) into
// assets/benchmark.png.
const SRC = process.argv[2] ?? 'benchs/results/2026-07-04-isolated.txt';
const OUT = process.argv[3] ?? '/tmp/benchmark.svg';

const KAIRO = new Set(['avoidablePropagation', 'broadPropagation', 'deepPropagation', 'diamond', 'mux', 'repeatedObservers', 'triangle', 'unstable', 'molBench']);
const SBENCH = new Set(['createSignals', 'createComputations', 'updateSignals']);
const suiteOf = (test) => SBENCH.has(test) ? 'sbench'
	: KAIRO.has(test) ? 'kairo'
	: test.startsWith('cellx') ? 'cellx'
	: 'dynamic';

const SUITES = ['sbench', 'kairo', 'cellx', 'dynamic'];
const EXPECTED_TESTS = 20; // 3 sbench + 9 kairo + 2 cellx + 6 dynamic

// Validated categorical palette (light), slots 1-4 in fixed order.
const COLOR = { sbench: '#2a78d6', kairo: '#1baf7a', cellx: '#eda100', dynamic: '#008300' };
const SURFACE = '#ffffff';
const INK = '#0b0b0b';
const INK2 = '#52514e';
const GRID = '#e8e8e6';

const rows = readFileSync(SRC, 'utf8').split('\n')
	.map((l) => l.split(',').map((p) => p.trim()))
	.filter((p) => p.length === 3 && p[0] !== 'framework' && Number.isFinite(Number(p[2])));

const byFw = new Map();
for (const [fw, test, time] of rows) {
	if (!byFw.has(fw)) byFw.set(fw, { tests: 0, sums: { sbench: 0, kairo: 0, cellx: 0, dynamic: 0 } });
	const e = byFw.get(fw);
	e.tests++;
	e.sums[suiteOf(test)] += Number(time);
}

const frameworks = [];
const partial = [];
for (const [fw, e] of byFw) {
	if (e.tests < EXPECTED_TESTS) { partial.push(`${fw} (${e.tests}/${EXPECTED_TESTS} tests)`); continue; }
	frameworks.push({ fw, ...e.sums, total: SUITES.reduce((t, s) => t + e.sums[s], 0) });
}
frameworks.sort((a, b) => a.total - b.total);
if (partial.length) console.error('excluded (crashed mid-suite): ' + partial.join('; '));

// ---- layout ----
const W = 1080, ROW = 34, BAR = 20, LABEL_W = 170, VALUE_W = 90, TOP = 78, BOT = 46;
const H = TOP + frameworks.length * ROW + BOT;
const plotW = W - LABEL_W - VALUE_W - 24;
const maxTotal = Math.max(...frameworks.map((f) => f.total));
// clean tick step
const rawStep = maxTotal / 5;
const mag = 10 ** Math.floor(Math.log10(rawStep));
const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => maxTotal / s <= 6);
const axisMax = Math.ceil(maxTotal / step) * step;
const x = (v) => LABEL_W + (v / axisMax) * plotW;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
let svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">`);
svg.push(`<rect width="${W}" height="${H}" fill="${SURFACE}"/>`);
svg.push(`<text x="24" y="34" font-size="17" font-weight="600" fill="${INK}">Total benchmark time by framework</text>`);
svg.push(`<text x="24" y="54" font-size="12" fill="${INK2}">js-reactivity-benchmark (milomg), all four suites, one process per framework, fastest-of-N per test - lower is better</text>`);

// legend (top right)
let lx = W - 24;
for (const s of [...SUITES].reverse()) {
	const label = s;
	const tw = label.length * 7 + 22;
	lx -= tw;
	svg.push(`<rect x="${lx}" y="${26}" width="10" height="10" rx="2" fill="${COLOR[s]}"/>`);
	svg.push(`<text x="${lx + 14}" y="${35}" font-size="12" fill="${INK2}">${label}</text>`);
}

// gridlines + axis labels
for (let v = 0; v <= axisMax; v += step) {
	const gx = x(v);
	svg.push(`<line x1="${gx}" y1="${TOP - 8}" x2="${gx}" y2="${H - BOT + 4}" stroke="${GRID}" stroke-width="1"/>`);
	svg.push(`<text x="${gx}" y="${H - BOT + 18}" font-size="11" fill="${INK2}" text-anchor="middle">${v.toLocaleString('en-US')}</text>`);
}
svg.push(`<text x="${x(axisMax / 2)}" y="${H - 10}" font-size="11" fill="${INK2}" text-anchor="middle">total time (ms)</text>`);

// bars
frameworks.forEach((f, i) => {
	const y = TOP + i * ROW + (ROW - BAR) / 2;
	const isOurs = f.fw === 'Dalien Signals';
	const isUpstream = f.fw === 'Alien Signals';
	svg.push(`<text x="${LABEL_W - 8}" y="${y + BAR / 2 + 4}" font-size="12" text-anchor="end" fill="${INK}"${isOurs ? ' font-weight="700"' : isUpstream ? ' font-weight="600"' : ''}>${esc(f.fw)}</text>`);
	let cx = LABEL_W;
	SUITES.forEach((s, si) => {
		const w = (f[s] / axisMax) * plotW;
		if (w <= 0) return;
		const isLast = si === SUITES.length - 1;
		// 2px surface gap between segments; 4px rounded data-end on the final segment only
		const gap = isLast ? 0 : 2;
		const rw = Math.max(0, w - gap);
		if (isLast) {
			svg.push(`<path d="M ${cx} ${y} h ${Math.max(rw - 4, 0)} a 4 4 0 0 1 4 4 v ${BAR - 8} a 4 4 0 0 1 -4 4 h ${-Math.max(rw - 4, 0)} z" fill="${COLOR[s]}"/>`);
		} else {
			svg.push(`<rect x="${cx}" y="${y}" width="${rw}" height="${BAR}" fill="${COLOR[s]}"/>`);
		}
		cx += w;
	});
	svg.push(`<text x="${cx + 8}" y="${y + BAR / 2 + 4}" font-size="12" fill="${INK2}">${Math.round(f.total).toLocaleString('en-US')} ms</text>`);
});

svg.push('</svg>');
writeFileSync(OUT, svg.join('\n'));
console.log(`wrote ${OUT} (${frameworks.length} frameworks, axisMax ${axisMax}ms)`);
console.log(frameworks.map((f) => `${f.fw}: ${Math.round(f.total)}`).join('\n'));
