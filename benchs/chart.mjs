// Build the README benchmark chart (SVG) from the isolated-runner output.
// Stacked horizontal bars: one row per framework, one segment per suite,
// sorted by total time ascending. Specs per the dataviz method: bars <=24px,
// 4px rounded data-end (square baseline), 2px surface gaps between segments,
// hairline solid gridlines, values at bar tips in text ink, legend on top.
import { readFileSync, writeFileSync } from 'node:fs';
import { COLOR, GRID, INK, INK2, SURFACE, SUITES, escXml, parseResults, summarize } from './lib.mjs';

// Pipeline: run `node dist/isolated.js` in milomg-reactivity-benchmark/packages/node
// (one process per framework), save its stdout under benchs/results/, then
// `node benchs/chart.mjs <results.txt> <out.svg>` and rasterize the SVG at 2x
// (e.g. headless Chrome --screenshot --force-device-scale-factor=2) into
// assets/benchmark.png.
const SRC = process.argv[2] ?? 'benchs/results/2026-07-04-isolated.txt';
const OUT = process.argv[3] ?? '/tmp/benchmark.svg';
const TITLE = process.argv[4] ?? 'Total benchmark time by framework';
const SUBTITLE = process.argv[5] ?? 'js-reactivity-benchmark (milomg), all four suites, one process per framework, fastest-of-N per test - lower is better';

const rows = parseResults(readFileSync(SRC, 'utf8'));
const { frameworks, partial } = summarize(rows);
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

const esc = escXml;
let svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">`);
svg.push(`<rect width="${W}" height="${H}" fill="${SURFACE}"/>`);
svg.push(`<text x="24" y="34" font-size="17" font-weight="600" fill="${INK}">${esc(TITLE)}</text>`);
svg.push(`<text x="24" y="54" font-size="12" fill="${INK2}">${esc(SUBTITLE)}</text>`);

// legend (top right) — only suites that actually have data in this run
const usedSuites = SUITES.filter((s) => frameworks.some((f) => f[s] > 0));
let lx = W - 24;
for (const s of [...usedSuites].reverse()) {
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
	const isOurs = f.fw === 'Dalien Signals' || f.fw === 'dalien-signals';
	const isUpstream = f.fw.startsWith('Alien Signals') || f.fw.startsWith('alien-signals');
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
