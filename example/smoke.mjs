// Node smoke for the field demo: replicates makeView in src/main.js —
// build the graph, settle it, create one render effect per pixel — against
// the real src/graph.js and src/adapters.js, then times batched
// write-frames shaped like the page's wave emitters. There is no DOM here;
// the ImageData pixels are a plain byte buffer.
//
// Usage: node --max-old-space-size=8192 smoke.mjs [library] [WxH] [frames]
//   e.g. node smoke.mjs dalien-signals 1920x1080 120
import { growCapacity } from 'dalien-signals';
import * as alien from 'alien-signals';
import { buildGraph, makeWaveDriver, TARGET_SHARE } from './src/graph.js';
import { paintPixel, makeRowMix } from './src/palette.js';
import { makeRuntime } from './src/adapters.js';

// Node-runnable mirror of the fork's alienSignals adapter: the fork's
// adapters are TypeScript with extensionless relative imports, which bare
// Node cannot load, so the same ReactiveFramework shape is rebuilt here on
// the example's own alien-signals install (same package the fork adapter
// aliases to under Vite). Kept field-for-field equivalent: cells are the
// library's own callables, effects parent to an effectScope opened by
// withBuild, cleanup disposes the scope.
let alienScope = null;
const alienFramework = {
	name: 'Alien Signals',
	createSignal: (v) => alien.signal(v),
	readSignal: (s) => s(),
	writeSignal: (s, v) => {
		s(v);
	},
	createComputed: (fn) => alien.computed(fn),
	readComputed: (c) => c(),
	// the field's render callbacks return undefined, so fn passes through
	// without a wrapper (alien-signals >= 3.2 treats a returned value as a
	// cleanup function), matching the fork adapter
	effect: (fn) => {
		alien.effect(fn);
	},
	withBatch: (fn) => {
		alien.startBatch();
		fn();
		alien.endBatch();
	},
	withBuild: (fn) => {
		let out;
		alienScope = alien.effectScope(() => {
			out = fn();
		});
		return out;
	},
	cleanup: () => {
		alienScope?.();
		alienScope = null;
	},
};

const lib = process.argv[2] ?? 'dalien-signals';
const [w, h] = (process.argv[3] ?? '1920x1080').split('x').map(Number);
const frames = Number(process.argv[4] ?? 120);
const count = w * h;
const now = () => performance.now();

console.log(`${lib} @ ${w}x${h} (${count.toLocaleString()} pixels), ${frames} frames`);

// Mirror main.js: 512 MB (1 << 24 records) reserved at boot, more for the
// 1080p tier — ~7 records per pixel with 4/3 headroom under the arena's
// 3/4-full growth threshold, rounded up to a power of two.
let capacity = 0;
if (lib === 'dalien-signals') {
	capacity = 1 << 24;
	while (capacity < count * 11) capacity *= 2;
	growCapacity(capacity);
	console.log(`growCapacity(${capacity.toLocaleString()}) — ${(capacity * 32 / 2 ** 20).toFixed(0)} MB reserved`);
}

// ---- build: graph, settle pass, render effects (same order as makeView) ----
// As in makeView, everything the graph owns is created inside the
// runtime's build scope so dispose() could reclaim it all; the phases are
// timed individually inside the one build callback.
const rt = makeRuntime(lib, lib === 'alien-signals' ? alienFramework : undefined);

const data = new Uint8ClampedArray(count * 4);
const vals = new Float32Array(count);
const flash = new Float32Array(count);
const flashList = new Int32Array(count);
const rowMix = makeRowMix(h);
const bundle = { flashEnd: 0 };

let graph, graphMs, settleMs, effectsMs;
rt.build(() => {
	let t = now();
	graph = buildGraph(w, h, rt);
	graphMs = now() - t;

	const get = rt.get;
	const ids = graph.ids;

	t = now();
	for (let i = 0; i < ids.length; i++) get(ids[i]);
	settleMs = now() - t;

	t = now();
	const renderPixel = (i, mix) => () => {
		const v0 = get(ids[i]);
		vals[i] = v0;
		if (flash[i] === 0) flashList[bundle.flashEnd++] = i;
		flash[i] = 1;
		paintPixel(data, i, v0, 1, mix);
	};
	for (let y = 0, i = 0; y < h; y++) {
		const mix = rowMix[y];
		for (let x = 0; x < w; x++, i++) {
			rt.effect(renderPixel(i, mix));
		}
	}
	effectsMs = now() - t;
});

// Exact record count for the dalien arena: the graph's nodes (a cell per
// pixel + quantize + epoch) and dependency links (counted per cell during
// the build: 3 in deep bands, 4 in wide), plus one node + one link per
// render effect. Growth triggers at 3/4 of capacity; the build must stay
// under that line or a frame mid-run pays for an arena migration.
if (lib === 'dalien-signals') {
	const records = graph.nodes + graph.edges + 2 * count;
	const growthLine = (capacity * 3) / 4;
	console.log(`records ${records.toLocaleString()} vs growth line ${growthLine.toLocaleString()} — ${records < growthLine ? 'no growth' : 'GROWTH WOULD TRIGGER'}`);
}

// ---- frames: the page's own adaptive wave driver — deep column profiles
// and wide hub pulses, write counts sized by the measured cones ----
const driver = makeWaveDriver(graph);
const batchMs = new Float64Array(frames);
const glowPassMs = new Float64Array(frames);
const recomputed = new Float64Array(frames);

for (let f = 0; f < frames; f++) {
	graph.stats.recomputes = 0;
	graph.stats.deepRecomputes = 0;
	graph.stats.wideRecomputes = 0;
	const t0 = now();
	rt.batch(() => {
		driver.step(rt);
	});
	batchMs[f] = now() - t0;
	driver.observe();
	recomputed[f] = graph.stats.recomputes;

	// the browser frame loop's glow decay, timed separately from the batch
	const t1 = now();
	const end = bundle.flashEnd;
	let live = 0;
	for (let k = 0; k < end; k++) {
		const i = flashList[k];
		const mix = rowMix[(i / w) | 0];
		const g = flash[i] * 0.66;
		if (g > 0.02) {
			flash[i] = g;
			flashList[live++] = i;
			paintPixel(data, i, vals[i], g, mix);
		} else {
			flash[i] = 0;
			paintPixel(data, i, vals[i], 0, mix);
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
const sustainedShare = recomputed.slice(half).reduce((a, b) => a + b, 0) / (frames - half) / graph.nodes;
console.log(`build: graph ${graphMs.toFixed(0)} ms, settle ${settleMs.toFixed(0)} ms, effects ${effectsMs.toFixed(0)} ms, total ${(graphMs + settleMs + effectsMs).toFixed(0)} ms`);
console.log(`recomputed cells/frame: ${stats(recomputed)}`);
console.log(`recompute share (last ${frames - half}, sustained): ${(sustainedShare * 100).toFixed(1)}% of ${graph.nodes.toLocaleString()} nodes (target ${(TARGET_SHARE * 100).toFixed(0)}%)`);
console.log(`write batch ms (all ${frames}):        ${stats(batchMs)}`);
console.log(`write batch ms (last ${frames - half}, sustained): ${stats(batchMs, half)}`);
console.log(`glow decay ms (last ${frames - half}, sustained):  ${stats(glowPassMs, half)}`);
