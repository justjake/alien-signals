// The demo's own UI runs on dalien-signals: every piece of page state is a
// signal, every DOM mutation lives in an effect. Handlers write state;
// effects project state into the document. Equality cutoff makes the
// unchanged projections free — writing the same fps twice touches nothing.
import { signal, computed, effect } from 'dalien-signals';
import { buildGraph } from './graph.js';
import { mountInspector } from './explain.js';

const WIDTH = 192;
const DEPTH = 108;
const graph = buildGraph(WIDTH, DEPTH);

// ---- page state ---------------------------------------------------------------
const wave = signal(true);
const storm = signal(false);
const recomputedCount = signal(0);
const frameMs = signal(0);
const fps = signal(0);
const note = signal(`graph built in ${graph.buildMs.toFixed(1)} ms`);
const share = computed(() => `${((recomputedCount() / graph.nodes) * 100).toFixed(1)}%`);
const cutoffLabel = computed(() => `equality cutoff: ${graph.quantize() ? 'on' : 'off'}`);

// ---- state => document ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const bindText = (id, read) => effect(() => { $(id).textContent = read(); });
const bindClass = (id, cls, read) => effect(() => { $(id).classList.toggle(cls, read()); });

bindText('stat-nodes', () => graph.nodes.toLocaleString());
bindText('stat-edges', () => graph.edges.toLocaleString());
bindText('stat-recomputed', () => recomputedCount().toLocaleString());
bindText('stat-share', share);
bindText('stat-frame', () => `${frameMs().toFixed(2)} ms`);
bindText('stat-fps', () => String(fps()));
bindText('note', note);
bindText('btn-cutoff', cutoffLabel);
bindClass('btn-wave', 'on', wave);
bindClass('btn-storm', 'on', storm);

// ---- input => state --------------------------------------------------------------
$('btn-wave').addEventListener('click', () => wave(!wave()));
$('btn-storm').addEventListener('click', () => storm(!storm()));
$('btn-cutoff').addEventListener('click', () => timeFullPass(() => graph.quantize(!graph.quantize())));
$('btn-invalidate').addEventListener('click', () => timeFullPass(() => graph.epoch(graph.epoch() + 1)));

const canvas = $('grid');
canvas.width = WIDTH;
canvas.height = DEPTH;
const ctx = canvas.getContext('2d');
const image = ctx.createImageData(WIDTH, DEPTH);
const data = image.data;
const flash = new Float32Array(WIDTH * DEPTH);

let painting = false;
canvas.addEventListener('pointerdown', (e) => { painting = true; canvas.setPointerCapture(e.pointerId); paint(e); });
canvas.addEventListener('pointermove', (e) => { if (painting) paint(e); });
canvas.addEventListener('pointerup', () => { painting = false; });

function paint(e) {
	const rect = canvas.getBoundingClientRect();
	const x = Math.floor(((e.clientX - rect.left) / rect.width) * WIDTH);
	for (let dx = -2; dx <= 2; dx++) {
		graph.sources[(x + dx + WIDTH) % WIDTH](1 - Math.abs(dx) * 0.18);
	}
}

function timeFullPass(write) {
	graph.recomputed.length = 0;
	const t0 = performance.now();
	write();
	readAll();
	note(`${graph.recomputed.length.toLocaleString()} recomputes in ${(performance.now() - t0).toFixed(1)} ms`);
}

// ---- render loop ----------------------------------------------------------------
// Reads pull the graph: cells untouched by this frame's writes verify from
// their version snapshot in a couple of loads. The frame's work is
// proportional to the invalidation cone, not to the graph.
function readAll() {
	const rows = graph.rows;
	for (let r = 0; r < DEPTH; r++) {
		const row = rows[r];
		for (let i = 0; i < WIDTH; i++) {
			const v = Math.max(0, Math.min(1, row[i]()));
			const p = (r * WIDTH + i) * 4;
			data[p] = v * v * 235;
			data[p + 1] = v * 190;
			data[p + 2] = 40 + v * 215;
			data[p + 3] = 255;
		}
	}
}

let frames = 0;
let fpsWindow = performance.now();
let phase = 0;

function frame() {
	graph.recomputed.length = 0;
	if (wave()) {
		phase += 0.045;
		const centre = (Math.sin(phase) * 0.5 + 0.5) * WIDTH;
		for (let dx = -3; dx <= 3; dx++) {
			graph.sources[(Math.round(centre) + dx + WIDTH) % WIDTH](Math.max(0, 1 - Math.abs(dx) * 0.22));
		}
	}
	if (storm()) {
		for (let k = 0; k < 6; k++) {
			graph.sources[Math.floor(Math.random() * WIDTH)](Math.random());
		}
	}

	const t0 = performance.now();
	readAll();
	frameMs(performance.now() - t0);

	for (const index of graph.recomputed) flash[index] = 1;
	for (let i = 0; i < flash.length; i++) {
		const f = flash[i];
		if (f > 0.02) {
			const p = i * 4;
			data[p] = Math.min(255, data[p] + f * 160);
			data[p + 1] = Math.min(255, data[p + 1] + f * 160);
			data[p + 2] = Math.min(255, data[p + 2] + f * 120);
			flash[i] = f * 0.82;
		} else {
			flash[i] = 0;
		}
	}
	ctx.putImageData(image, 0, 0);

	recomputedCount(graph.recomputed.length);
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

mountInspector(document.getElementById('inspector'));
