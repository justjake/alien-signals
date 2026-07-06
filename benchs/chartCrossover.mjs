// Build the alien/dalien crossover chart (SVG): sustained write cost ratio
// (dalien / upstream) against the number of nodes recomputed per write, one
// line per shape family from benchs/crossover.mjs. Below 1.0 this fork is
// faster; above it upstream is. Log-scaled x; the ratio axis is linear.
//
// Usage: node benchs/chartCrossover.mjs <dalien.csv> <alien.csv> <out.svg>
import { readFileSync, writeFileSync } from 'node:fs';
import { GRID, INK, INK2, INK3, SURFACE, escXml } from './lib.mjs';

const DALIEN = process.argv[2] ?? 'benchs/results/2026-07-05-crossover-dalien.csv';
const ALIEN = process.argv[3] ?? 'benchs/results/2026-07-05-crossover-alien.csv';
const OUT = process.argv[4] ?? '/tmp/crossover.svg';

// Fastest of the reps per (family, size).
function read(path) {
	const m = new Map();
	for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
		const [family, n, ns] = line.split(',');
		const key = `${family},${n}`;
		const v = Number(ns);
		if (!m.has(key) || v < m.get(key)) m.set(key, v);
	}
	return m;
}
const d = read(DALIEN);
const a = read(ALIEN);

const FAMILIES = [
	{ key: 'broad', label: 'broad: 1 write, N sibling computeds', color: '#2a78d6' },
	{ key: 'grid', label: 'grid: 1 write, √N×√N cone', color: '#1baf7a' },
	{ key: 'deep', label: 'deep: 1 write, N-deep chain', color: '#eda100' },
	{ key: 'batch', label: 'batch: N writes, tiny cone each', color: '#008300' },
	{ key: 'islands', label: 'islands: fixed cone + N idle nodes', color: INK3, dash: true },
];
const SIZES = [1, 2, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000];

const series = FAMILIES.map((f) => ({
	...f,
	points: SIZES
		.filter((n) => d.has(`${f.key},${n}`) && a.has(`${f.key},${n}`))
		.map((n) => ({ n, ratio: d.get(`${f.key},${n}`) / a.get(`${f.key},${n}`) })),
}));

// ---- layout ----
const W = 1080, H = 560;
const M = { top: 96, right: 320, bottom: 56, left: 76 };
const plotW = W - M.left - M.right;
const plotH = H - M.top - M.bottom;
const maxRatio = Math.max(1.6, ...series.flatMap((s) => s.points.map((p) => p.ratio))) * 1.05;
const minRatio = 0;
const x = (n) => M.left + (Math.log10(n) / Math.log10(30000)) * plotW;
const y = (r) => M.top + (1 - (r - minRatio) / (maxRatio - minRatio)) * plotH;

const esc = escXml;
let svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">`);
svg.push(`<rect width="${W}" height="${H}" fill="${SURFACE}"/>`);
svg.push(`<text x="24" y="34" font-size="17" font-weight="600" fill="${INK}">Where dalien-signals overtakes upstream</text>`);
svg.push(`<text x="24" y="54" font-size="12" fill="${INK2}">sustained write cost, dalien ÷ alien-signals, by nodes recomputed per write — below 1.0 this fork is faster (benchs/crossover.mjs, Node 24, Apple M4 Max)</text>`);

// faster/slower shading relative to the 1.0 line
svg.push(`<rect x="${M.left}" y="${y(1)}" width="${plotW}" height="${y(minRatio) - y(1)}" fill="#1baf7a" opacity="0.06"/>`);
svg.push(`<text x="${M.left + 8}" y="${y(1) + 18}" font-size="11" fill="#1baf7a">dalien-signals faster</text>`);
svg.push(`<text x="${M.left + 8}" y="${y(1) - 8}" font-size="11" fill="${INK3}">upstream faster</text>`);

// gridlines: x at decades, y at 0.5 steps
for (const n of [1, 10, 100, 1000, 10000]) {
	svg.push(`<line x1="${x(n)}" y1="${M.top - 8}" x2="${x(n)}" y2="${H - M.bottom + 4}" stroke="${GRID}" stroke-width="1"/>`);
	svg.push(`<text x="${x(n)}" y="${H - M.bottom + 18}" font-size="11" fill="${INK2}" text-anchor="middle">${n.toLocaleString('en-US')}</text>`);
}
for (let r = 0; r <= maxRatio; r += 0.5) {
	svg.push(`<line x1="${M.left}" y1="${y(r)}" x2="${M.left + plotW}" y2="${y(r)}" stroke="${GRID}" stroke-width="1"/>`);
	svg.push(`<text x="${M.left - 8}" y="${y(r) + 4}" font-size="11" fill="${INK2}" text-anchor="end">${r.toFixed(1)}×</text>`);
}
// the parity line, emphasized
svg.push(`<line x1="${M.left}" y1="${y(1)}" x2="${M.left + plotW}" y2="${y(1)}" stroke="${INK3}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
svg.push(`<text x="${x(30000) / 2 + M.left / 2}" y="${H - 12}" font-size="11" fill="${INK2}" text-anchor="middle">nodes recomputed per write (log scale)</text>`);

// series lines + direct labels at line end
for (const s of series) {
	if (s.points.length === 0) continue;
	const path = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.n).toFixed(1)} ${y(p.ratio).toFixed(1)}`).join(' ');
	svg.push(`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2"${s.dash ? ' stroke-dasharray="4 4"' : ''}/>`);
	for (const p of s.points) {
		svg.push(`<circle cx="${x(p.n)}" cy="${y(p.ratio)}" r="3" fill="${s.color}"/>`);
	}
	const end = s.points[s.points.length - 1];
	svg.push(`<text x="${x(end.n) + 10}" y="${y(end.ratio) + 4}" font-size="12" fill="${s.color}">${esc(s.label)} — ${end.ratio.toFixed(2)}×</text>`);
}

svg.push('</svg>');
writeFileSync(OUT, svg.join('\n'));
console.log(`wrote ${OUT} (${series.length} families)`);
