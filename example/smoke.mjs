// Node smoke for the field demo: replicates makeView in src/main.js —
// build the graph, settle it, create one render effect per pixel — against
// the real src/graph.js and src/adapters.js, then times batched
// write-frames shaped like the page's wave emitters. There is no DOM here;
// the ImageData pixels are a plain byte buffer.
//
// Usage: node --max-old-space-size=8192 smoke.mjs [library] [WxH] [frames]
//   e.g. node smoke.mjs dalien-signals 1920x1080 120
import { growCapacity } from 'dalien-signals';
import { buildGraph, BAND } from './src/graph.js';
import { makeRuntime } from './src/adapters.js';

const lib = process.argv[2] ?? 'dalien-signals';
const [w, h] = (process.argv[3] ?? '1920x1080').split('x').map(Number);
const frames = Number(process.argv[4] ?? 120);
const count = w * h;
const now = () => performance.now();

console.log(`${lib} @ ${w}x${h} (${count.toLocaleString()} pixels), ${frames} frames`);

// Mirror main.js TIER_RECORDS: ~9 records per pixel with 4/3 headroom
// under the arena's 3/4-full growth threshold, rounded up to a power of
// two.
let capacity = 0;
if (lib === 'dalien-signals') {
	capacity = 1 << 21;
	while (capacity < count * 12) capacity *= 2;
	growCapacity(capacity);
	console.log(`growCapacity(${capacity.toLocaleString()}) — ${(capacity * 32 / 2 ** 20).toFixed(0)} MB reserved`);
}

// ---- build: graph, settle pass, render effects (same order as makeView) ----
let t = now();
const rt = makeRuntime(lib);
const graph = buildGraph(w, h, rt);
const graphMs = now() - t;

const get = rt.get;
const ids = graph.ids;

t = now();
for (let i = 0; i < ids.length; i++) get(ids[i]);
const settleMs = now() - t;

const data = new Uint8ClampedArray(count * 4);
const vals = new Float32Array(count);
const flash = new Float32Array(count);
const flashList = new Int32Array(count);
const bundle = { flashEnd: 0 };

// copied from main.js paintPixel
function paintPixel(data, i, v0, glow) {
	const v = v0 < 0 ? 0 : v0 > 1 ? 1 : v0;
	const warm = v > 0.55 ? (v - 0.55) * 2.2 : 0;
	const p = i * 4;
	data[p] = warm * warm * 255 + v * 30;
	data[p + 1] = v ** 1.6 * 235 + glow * 70;
	data[p + 2] = (0.16 + v * (1.25 - v)) * 235 + glow * 90;
	data[p + 3] = 255;
}

t = now();
const renderPixel = (i) => () => {
	const v0 = get(ids[i]);
	vals[i] = v0;
	if (flash[i] === 0) flashList[bundle.flashEnd++] = i;
	flash[i] = 1;
	paintPixel(data, i, v0, 1);
};
for (let i = 0; i < count; i++) {
	rt.effect(renderPixel(i));
}
const effectsMs = now() - t;

// Exact record count for the dalien arena: cell nodes + quantize + epoch,
// six dependency links per non-source cell, and one node + one link per
// render effect. Growth triggers at 3/4 of capacity; the build must stay
// under that line or a frame mid-run pays for an arena migration.
if (lib === 'dalien-signals') {
	const bandCount = Math.ceil(h / BAND);
	const records = (count + 2) + 6 * (count - w * bandCount) + 2 * count;
	const growthLine = (capacity * 3) / 4;
	console.log(`records ${records.toLocaleString()} vs growth line ${growthLine.toLocaleString()} — ${records < growthLine ? 'no growth' : 'GROWTH WOULD TRIGGER'}`);
}

// ---- frames: wave emitters, one band per frame (same shape as main.js) ----
const emitters = [
	{ speed: 0.021, span: 0.9, width: 2, gain: 1.0 },
	{ speed: -0.033, span: 0.55, width: 1, gain: 0.8 },
	{ speed: 0.013, span: 0.75, width: 3, gain: 0.65 },
];
const bands = graph.bandSources;
let phase = 0;
const batchMs = new Float64Array(frames);
const glowPassMs = new Float64Array(frames);
const recomputed = new Float64Array(frames);

for (let f = 0; f < frames; f++) {
	graph.stats.recomputes = 0;
	const t0 = now();
	rt.batch(() => {
		phase += 1;
		const band = bands[phase % bands.length];
		for (const em of emitters) {
			const centre = (Math.sin(phase * em.speed) * em.span * 0.5 + 0.5) * w;
			const ww = Math.max(em.width, w >> 8);
			for (let dx = -ww; dx <= ww; dx++) {
				const i = (Math.round(centre) + dx + w) % w;
				rt.set(band.cells[i], em.gain * Math.max(0, 1 - Math.abs(dx) / (ww + 1)));
			}
		}
		if (phase % 90 === 0) {
			rt.set(band.cells[Math.floor(Math.random() * w)], 1);
		}
	});
	batchMs[f] = now() - t0;
	recomputed[f] = graph.stats.recomputes;

	// the browser frame loop's glow decay, timed separately from the batch
	const t1 = now();
	const end = bundle.flashEnd;
	let live = 0;
	for (let k = 0; k < end; k++) {
		const i = flashList[k];
		const g = flash[i] * 0.78;
		if (g > 0.02) {
			flash[i] = g;
			flashList[live++] = i;
			paintPixel(data, i, vals[i], g);
		} else {
			flash[i] = 0;
			paintPixel(data, i, vals[i], 0);
		}
	}
	bundle.flashEnd = live;
	glowPassMs[f] = now() - t1;
}

function stats(arr, from = 0) {
	const xs = [...arr.slice(from)].sort((a, b) => a - b);
	const pick = (q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
	const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
	return `avg ${avg.toFixed(2)}  p50 ${pick(0.5).toFixed(2)}  p95 ${pick(0.95).toFixed(2)}  worst ${xs[xs.length - 1].toFixed(2)}`;
}

const half = frames >> 1;
console.log(`build: graph ${graphMs.toFixed(0)} ms, settle ${settleMs.toFixed(0)} ms, effects ${effectsMs.toFixed(0)} ms, total ${(graphMs + settleMs + effectsMs).toFixed(0)} ms`);
console.log(`recomputed cells/frame: ${stats(recomputed)}`);
console.log(`write batch ms (all ${frames}):        ${stats(batchMs)}`);
console.log(`write batch ms (last ${frames - half}, sustained): ${stats(batchMs, half)}`);
console.log(`glow decay ms (last ${frames - half}, sustained):  ${stats(glowPassMs, half)}`);
