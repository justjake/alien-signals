// The demo's own UI runs on dalien-signals: every piece of page state is a
// signal, every DOM mutation lives in an effect. Handlers write state;
// effects project state into the document. Equality cutoff makes the
// unchanged projections free — writing the same fps twice touches nothing.
import { signal, computed, effect } from 'dalien-signals';
import { buildGraph } from './graph.js';
import { ADAPTERS } from './adapters.js';
import { mountCounter, mountStepper, mountSheet } from './widgets.js';
import { mountBench } from './bench.js';

const WIDTH = 288;
const DEPTH = 162;
// The field can be driven by any of the adapter libraries; the page's own
// state stays on dalien-signals regardless.
const libName = signal('dalien-signals');
const graphSig = signal(buildGraph(WIDTH, DEPTH, ADAPTERS[libName()]));
let firstBuild = true;

// ---- page state ---------------------------------------------------------------
const wave = signal(true);
const storm = signal(false);
const recomputedCount = signal(0);
const frameMs = signal(0);
const fps = signal(0);
const cutoffOn = signal(true);
const note = signal(`graph built in ${graphSig().buildMs.toFixed(1)} ms`);
const share = computed(() => `${((recomputedCount() / graphSig().nodes) * 100).toFixed(1)}%`);
const cutoffLabel = computed(() => `equality cutoff: ${cutoffOn() ? 'on' : 'off'}`);

// ---- state => document ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const bindText = (id, read) => effect(() => { $(id).textContent = read(); });
const bindClass = (id, cls, read) => effect(() => { $(id).classList.toggle(cls, read()); });

bindText('stat-nodes', () => graphSig().nodes.toLocaleString());
bindText('stat-edges', () => graphSig().edges.toLocaleString());
bindText('stat-recomputed', () => recomputedCount().toLocaleString());
bindText('stat-share', share);
bindText('stat-frame', () => `${frameMs().toFixed(2)} ms`);
bindText('stat-fps', () => String(fps()));
// Every node and every edge is one 32-byte record in the arena — the whole
// graph's storage is arithmetic, not a heap profile.
const mb = (bytes) => `${(bytes / (1 << 20)).toFixed(1)} MB`;
bindText('stat-arena', () => mb((graphSig().nodes + graphSig().edges) * 32));
const heap = signal(NaN);
bindText('stat-heap', () => (Number.isFinite(heap()) ? mb(heap()) : 'n/a'));
if (performance.memory) {
	setInterval(() => heap(performance.memory.usedJSHeapSize), 1000);
	heap(performance.memory.usedJSHeapSize);
}
bindText('note', note);
bindText('btn-cutoff', cutoffLabel);
bindClass('btn-wave', 'on', wave);
bindClass('btn-storm', 'on', storm);

// ---- input => state --------------------------------------------------------------
$('btn-wave').addEventListener('click', () => wave(!wave()));
$('btn-storm').addEventListener('click', () => storm(!storm()));
$('btn-cutoff').addEventListener('click', () => {
	cutoffOn(!cutoffOn());
	timeFullPass(() => graphSig().quantize.write(cutoffOn()));
});
$('btn-invalidate').addEventListener('click', () => {
	const g = graphSig();
	timeFullPass(() => g.epoch.write(g.epoch.read() + 1));
});
$('lib-bar').addEventListener('click', (e) => {
	const lib = e.target.dataset?.lib;
	if (lib) libName(lib);
});
for (const b of $('lib-bar').querySelectorAll('button')) {
	effect(() => b.classList.toggle('on', libName() === b.dataset.lib));
}

const canvas = $('grid');
canvas.width = WIDTH;
canvas.height = DEPTH;
const ctx = canvas.getContext('2d');
const image = ctx.createImageData(WIDTH, DEPTH);
const data = image.data;
const flash = new Float32Array(WIDTH * DEPTH);

// Rebuilding the field is a projection of state: the selected library
// determines the graph. (Registered after `flash` exists — the effect body
// runs at creation.)
effect(() => {
	const name = libName();
	if (firstBuild) {
		firstBuild = false; // the initial graph was built eagerly above
		return;
	}
	const g = buildGraph(WIDTH, DEPTH, ADAPTERS[name]);
	g.quantize.write(cutoffOn());
	flash.fill(0);
	graphSig(g);
	note(`${name}: ${g.nodes.toLocaleString()} nodes built in ${g.buildMs.toFixed(1)} ms`);
});

// Left button paints lightness; right button paints darkness (erases).
let painting = false;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { painting = true; canvas.setPointerCapture(e.pointerId); paint(e); });
canvas.addEventListener('pointermove', (e) => { if (painting) paint(e); });
canvas.addEventListener('pointerup', () => { painting = false; });

function paint(e) {
	const dark = (e.buttons & 2) !== 0 || e.button === 2;
	const rect = canvas.getBoundingClientRect();
	const x = Math.floor(((e.clientX - rect.left) / rect.width) * WIDTH);
	const sources = graphSig().sources;
	for (let dx = -2; dx <= 2; dx++) {
		const v = dark ? 0 : 1 - Math.abs(dx) * 0.18;
		sources[(x + dx + WIDTH) % WIDTH].write(v);
	}
}

function timeFullPass(write) {
	const g = graphSig();
	g.recomputed.length = 0;
	const t0 = performance.now();
	write();
	readAll();
	note(`${g.recomputed.length.toLocaleString()} recomputes in ${(performance.now() - t0).toFixed(1)} ms`);
}

// ---- render loop ----------------------------------------------------------------
// Reads pull the graph: cells untouched by this frame's writes verify from
// their version snapshot in a couple of loads. The frame's work is
// proportional to the invalidation cone, not to the graph.
function readAll() {
	const rows = graphSig().rows;
	for (let r = 0; r < DEPTH; r++) {
		const row = rows[r];
		for (let i = 0; i < WIDTH; i++) {
			const v = Math.max(0, Math.min(1, row[i].read()));
			const p = (r * WIDTH + i) * 4;
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
	const g = graphSig();
	g.recomputed.length = 0;
	if (wave()) {
		phase += 1;
		for (const em of emitters) {
			const centre = (Math.sin(phase * em.speed) * em.span * 0.5 + 0.5) * WIDTH;
			for (let dx = -em.width; dx <= em.width; dx++) {
				const i = (Math.round(centre) + dx + WIDTH) % WIDTH;
				g.sources[i].write(em.gain * Math.max(0, 1 - Math.abs(dx) / (em.width + 1)));
			}
		}
		if (phase % 90 === 0) {
			g.sources[Math.floor(Math.random() * WIDTH)].write(1);
		}
	}
	if (storm()) {
		for (let k = 0; k < 4; k++) {
			g.sources[Math.floor(Math.random() * WIDTH)].write(Math.random() * 0.9);
		}
	}

	const t0 = performance.now();
	readAll();
	frameMs(performance.now() - t0);

	for (const index of g.recomputed) flash[index] = 1;
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
