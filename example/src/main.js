// The demo's own UI runs on dalien-signals: every piece of page state is a
// signal, every DOM mutation lives in an effect. Handlers write state;
// effects project state into the document.
import { signal, computed, effect, growCapacity } from 'dalien-signals';
import { buildGraph } from './graph.js';
import { ADAPTERS } from './adapters.js';
import { mountCounter, mountStepper, mountSheet } from './widgets.js';
import { mountBench } from './bench.js';

// Resolution tiers name the DISPLAY size they suit; the graph runs one
// cell per quarter-resolution pixel, so "1080p" is a 480×270 cell field.
const TIERS = {
	'480p': [214, 120],
	'720p': [320, 180],
	'1080p': [480, 270],
	'4k': [960, 540],
	'8k': [1920, 1080],
};

// ---- page state ---------------------------------------------------------------
const libName = signal('dalien-signals');
const tierName = signal('1080p');
const mode = signal('wave'); // 'off' | 'wave' | 'storm'
const cutoffOn = signal(true);
const recomputedCount = signal(0);
const frameMs = signal(0);
const avgFrameMs = signal(0);
const fps = signal(0);
const note = signal('');
const frameTimes = [];
// The whole render bundle — graph plus size-matched buffers — is one
// signal, rebuilt when the library or tier changes.
const view = signal(makeView());

const share = computed(() => `${((recomputedCount() / view().graph.nodes) * 100).toFixed(1)}%`);
const cutoffLabel = computed(() => `equality cutoff: ${cutoffOn() ? 'on' : 'off'}`);

const $ = (id) => document.getElementById(id);
const canvas = $('grid');
const ctx = canvas.getContext('2d');

function makeView() {
	const [w, h] = TIERS[tierName ? tierName() : '1080p'];
	// The 8k tier needs ~15M records; reserving address space is cheap.
	if ((libName ? libName() : 'dalien-signals') === 'dalien-signals' && w * h > 300000) {
		growCapacity(1 << 24);
	}
	const graph = buildGraph(w, h, ADAPTERS[libName ? libName() : 'dalien-signals']);
	return {
		graph,
		w,
		h,
		image: new ImageData(w, h),
		flash: new Float32Array(w * h),
	};
}

// ---- state => document ----------------------------------------------------------
const bindText = (id, read) => effect(() => { $(id).textContent = read(); });

bindText('stat-nodes', () => view().graph.nodes.toLocaleString());
bindText('stat-edges', () => view().graph.edges.toLocaleString());
bindText('stat-recomputed', () => recomputedCount().toLocaleString());
bindText('stat-share', share);
bindText('stat-frame', () => `${frameMs().toFixed(2)} ms`);
bindText('stat-avg', () => `${avgFrameMs().toFixed(2)} ms`);
bindText('stat-fps', () => String(fps()));
const mb = (bytes) => `${(bytes / (1 << 20)).toFixed(1)} MB`;
bindText('stat-arena', () => mb((view().graph.nodes + view().graph.edges) * 32));
const heap = signal(NaN);
bindText('stat-heap', () => (Number.isFinite(heap()) ? mb(heap()) : 'n/a'));
if (performance.memory) {
	setInterval(() => heap(performance.memory.usedJSHeapSize), 1000);
	heap(performance.memory.usedJSHeapSize);
}
bindText('note', note);
bindText('btn-cutoff', cutoffLabel);

// radio-style button groups: exactly one active per group
function radioGroup(barId, read, write) {
	const bar = $(barId);
	bar.addEventListener('click', (e) => {
		const v = e.target.dataset?.v;
		if (v) write(v);
	});
	for (const b of bar.querySelectorAll('button')) {
		effect(() => b.classList.toggle('on', read() === b.dataset.v));
	}
}
radioGroup('lib-bar', libName, libName);
radioGroup('tier-bar', tierName, tierName);
radioGroup('mode-bar', mode, mode);

$('btn-cutoff').addEventListener('click', () => {
	cutoffOn(!cutoffOn());
	timeFullPass(() => view().graph.quantize.write(cutoffOn()));
});
$('btn-invalidate').addEventListener('click', () => {
	const g = view().graph;
	timeFullPass(() => g.epoch.write(g.epoch.read() + 1));
});

// rebuild is a projection of (library, tier)
let firstBuild = true;
effect(() => {
	const name = libName();
	const tier = tierName();
	if (firstBuild) {
		firstBuild = false;
	} else {
		view(makeView());
	}
	const v = view();
	v.graph.quantize.write(cutoffOn());
	canvas.width = v.w;
	canvas.height = v.h;
	frameTimes.length = 0;
	note(`${name} @ ${tier}: ${v.graph.nodes.toLocaleString()} nodes built in ${v.graph.buildMs.toFixed(1)} ms`);
});

// ---- input => state --------------------------------------------------------------
let painting = false;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { painting = true; canvas.setPointerCapture(e.pointerId); paint(e); });
canvas.addEventListener('pointermove', (e) => { if (painting) paint(e); });
canvas.addEventListener('pointerup', () => { painting = false; });

function paint(e) {
	const { graph, w } = view();
	const dark = (e.buttons & 2) !== 0 || e.button === 2;
	const rect = canvas.getBoundingClientRect();
	const x = Math.floor(((e.clientX - rect.left) / rect.width) * w);
	const brush = Math.max(2, w >> 7);
	for (let dx = -brush; dx <= brush; dx++) {
		const value = dark ? 0 : 1 - (Math.abs(dx) / (brush + 1)) * 0.7;
		graph.sources[(x + dx + w) % w].write(value);
	}
}

function timeFullPass(write) {
	const g = view().graph;
	g.recomputed.length = 0;
	const t0 = performance.now();
	write();
	readAll();
	note(`${g.recomputed.length.toLocaleString()} recomputes in ${(performance.now() - t0).toFixed(1)} ms`);
}

// ---- render loop ----------------------------------------------------------------
// Reads pull the graph: cells untouched by this frame's writes verify from
// their version snapshot in a couple of loads — frame cost tracks the
// invalidation cones, not the graph size.
function readAll() {
	const { graph, w, h, image } = view();
	const data = image.data;
	const rows = graph.rows;
	for (let r = 0; r < h; r++) {
		const row = rows[r];
		for (let i = 0; i < w; i++) {
			const v0 = row[i].read();
			const v = v0 < 0 ? 0 : v0 > 1 ? 1 : v0;
			const p = (r * w + i) * 4;
			// navy -> cyan -> gold ramp with late-rising red
			const warm = v > 0.55 ? (v - 0.55) * 2.2 : 0;
			data[p] = warm * warm * 255 + v * 30;
			data[p + 1] = v ** 1.6 * 235;
			data[p + 2] = (0.16 + v * (1.25 - v)) * 235;
			data[p + 3] = 255;
		}
	}
}

let frames = 0;
let fpsWindow = performance.now();
let phase = 0;
const emitters = [
	{ speed: 0.021, span: 0.9, width: 2, gain: 1.0 },
	{ speed: -0.033, span: 0.55, width: 1, gain: 0.8 },
	{ speed: 0.013, span: 0.75, width: 3, gain: 0.65 },
];

function frame() {
	const v = view();
	const g = v.graph;
	g.recomputed.length = 0;

	const m = mode();
	if (m === 'wave') {
		phase += 1;
		for (const em of emitters) {
			const centre = (Math.sin(phase * em.speed) * em.span * 0.5 + 0.5) * v.w;
			const ww = Math.max(em.width, v.w >> 8);
			for (let dx = -ww; dx <= ww; dx++) {
				const i = (Math.round(centre) + dx + v.w) % v.w;
				g.sources[i].write(em.gain * Math.max(0, 1 - Math.abs(dx) / (ww + 1)));
			}
		}
		if (phase % 90 === 0) {
			g.sources[Math.floor(Math.random() * v.w)].write(1);
		}
	} else if (m === 'storm') {
		const drops = Math.max(4, v.w >> 6);
		for (let k = 0; k < drops; k++) {
			g.sources[Math.floor(Math.random() * v.w)].write(Math.random() * 0.9);
		}
	}

	const t0 = performance.now();
	readAll();
	const ms = performance.now() - t0;
	frameMs(ms);
	frameTimes.push(ms);
	if (frameTimes.length > 120) frameTimes.shift();
	avgFrameMs(frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length);

	const { image, flash } = v;
	const data = image.data;
	for (const index of g.recomputed) {
		if (index < flash.length) flash[index] = 1;
	}
	for (let i = 0; i < flash.length; i++) {
		const f = flash[i];
		if (f > 0.02) {
			const p = i * 4;
			data[p + 1] = Math.min(255, data[p + 1] + f * 70);
			data[p + 2] = Math.min(255, data[p + 2] + f * 90);
			flash[i] = f * 0.78;
		} else {
			flash[i] = 0;
		}
	}
	ctx.putImageData(image, 0, 0);

	recomputedCount(g.recomputed.length);
	frames++;
	const now = performance.now();
	if (now - fpsWindow > 500) {
		fps(Math.round((frames * 1000) / (now - fpsWindow)));
		frames = 0;
		fpsWindow = now;
	}
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

mountCounter(document.getElementById('w-counter'));
mountStepper(document.getElementById('w-stepper'));
mountSheet(document.getElementById('w-sheet'));
mountBench(document.getElementById('w-bench'));
