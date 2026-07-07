// The demo's own UI runs on dalien-signals: every piece of page state is a
// signal, every DOM mutation lives in an effect. Handlers write state;
// effects project state into the document.
import { signal, computed, effect, growCapacity, startBatch, endBatch } from 'dalien-signals';
import { buildGraph, BAND } from './graph.js';
import { makeRuntime } from './adapters.js';
import { mountCounter, mountStepper, mountSheet } from './widgets.js';
import { mountBench } from './bench.js';

// One node per pixel at the named resolution.
const TIERS = {
	'320p': [568, 320],
	'480p': [854, 480],
	'720p': [1280, 720],
	'1080p': [1920, 1080],
	'4k': [3840, 2160],
	'8k': [7680, 4320],
};
// Arena records per cell: one node, ~6 dependency links, and a share of a
// render-tile effect and its links — about 8.2 records, rounded up to the
// next power of two. The top tiers are multi-GB reservations that the
// platform may refuse; a refused allocation surfaces in the note rather
// than crashing the flush.
const TIER_RECORDS = {
	'320p': 1 << 21,
	'480p': 1 << 22,
	'720p': 1 << 23,
	'1080p': 1 << 25,
	'4k': 1 << 27,
	'8k': 1 << 28,
};
// Render effects cover 64-column spans: narrow enough that a band write
// queues dozens of effects rather than thousands, wide enough that effects
// stay ~1.5% of the pixel count.
const TILE = 64;

// ---- page state ---------------------------------------------------------------
const libName = signal('dalien-signals');
const tierName = signal('320p');
const mode = signal('wave'); // 'off' | 'wave' | 'storm'
const cutoffOn = signal(true);
const building = signal(false);
const recomputedCount = signal(0);
const frameMs = signal(0);
const avgFrameMs = signal(0);
const fps = signal(0);
const note = signal('');
const frameTimes = [];
// The whole render bundle — runtime, graph, size-matched buffers — is one
// signal, rebuilt when the library or tier changes.
const view = signal(makeView());

const share = computed(() => `${((recomputedCount() / view().graph.nodes) * 100).toFixed(1)}%`);
const cutoffLabel = computed(() => `equality cutoff: ${cutoffOn() ? 'on' : 'off'}`);

const $ = (id) => document.getElementById(id);
const canvas = $('grid');
const ctx = canvas.getContext('2d');

function makeView() {
	const name = libName();
	const tier = tierName();
	const [w, h] = TIERS[tier];
	if (name === 'dalien-signals') {
		growCapacity(TIER_RECORDS[tier]); // address space is cheap; pages are lazy
	}
	const rt = makeRuntime(name);
	const graph = buildGraph(w, h, rt);
	const image = new ImageData(w, h);
	const data = image.data;
	const flash = new Float32Array(w * h);
	// NaN forces every pixel's first comparison to fail, so the creation
	// pass paints the whole field.
	const vals = new Float32Array(w * h).fill(NaN);
	const get = rt.get;
	const ids = graph.ids;
	// Settle the graph before wiring watchers: an untracked pass evaluates
	// every cell in dependency order, so effect creation links into a
	// finished graph instead of driving cold cascades from inside each
	// effect body. Measured on dalien at 1080p: first build 7.5s -> 2.0s.
	for (let i = 0; i < ids.length; i++) {
		get(ids[i]);
	}
	const bundle = { rt, graph, w, h, image, flash, vals, dirty: true, glowUntil: 0 };
	// One render effect per row-tile: each library's own scheduler repaints
	// exactly the tiles whose cells changed — frame cost tracks the
	// invalidation cones, not the pixel count.
	for (let r = 0; r < h; r++) {
		const base = r * w;
		for (let x0 = 0; x0 < w; x0 += TILE) {
			const start = base + x0;
			const end = base + Math.min(w, x0 + TILE);
			rt.effect(() => {
				for (let i = start; i < end; i++) {
					const v0 = get(ids[i]);
					if (v0 !== vals[i]) {
						vals[i] = v0;
						flash[i] = 1;
						paintPixel(data, i, v0, 1);
					}
				}
				bundle.dirty = true;
			});
		}
	}
	return bundle;
}

// navy -> cyan -> gold ramp with late-rising red; glow is drawn over the
// base color, never accumulated into it, so a fading highlight lands back
// on the exact base.
function paintPixel(data, i, v0, glow) {
	const v = v0 < 0 ? 0 : v0 > 1 ? 1 : v0;
	const warm = v > 0.55 ? (v - 0.55) * 2.2 : 0;
	const p = i * 4;
	data[p] = warm * warm * 255 + v * 30;
	data[p + 1] = v ** 1.6 * 235 + glow * 70;
	data[p + 2] = (0.16 + v * (1.25 - v)) * 235 + glow * 90;
	data[p + 3] = 255;
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
		const v = e.target.closest('button[data-v]')?.dataset.v;
		if (v) write(v);
	});
	// One effect binds the whole group, not one per button: the invariant
	// (exactly one active) is group-wide, and a single run always lands the
	// group in a consistent state. With per-button effects, anything that
	// interrupts the flush between two of them leaves two buttons marked
	// active at once.
	const buttons = [...bar.querySelectorAll('button')];
	effect(() => {
		const v = read();
		for (const b of buttons) b.classList.toggle('on', v === b.dataset.v);
	});
}
radioGroup('lib-bar', libName, libName);
radioGroup('tier-bar', tierName, tierName);
radioGroup('mode-bar', mode, mode);

$('btn-cutoff').addEventListener('click', () => {
	const next = !cutoffOn();
	cutoffOn(next);
	timeFullPass(() => {
		const v = view();
		v.rt.set(v.graph.quantize, next);
	});
});
$('btn-invalidate').addEventListener('click', () => {
	timeFullPass(() => {
		const v = view();
		v.rt.set(v.graph.epoch, v.rt.get(v.graph.epoch) + 1);
	});
});

// rebuild is a projection of (library, tier)
//
// The build itself stays out of the effect flush: it can take seconds at
// the big tiers (the click would appear to do nothing), and if it throws —
// growCapacity and the pixel buffers are multi-GB allocations at 4k/8k —
// an exception inside the flush aborts it and strands every DOM-binding
// effect still queued behind it with stale output. The effect only posts
// feedback and schedules; the build runs after the note has had a frame
// to paint, wrapped so failure is reported instead of thrown.
let builtName = libName();
let builtTier = tierName();
let buildSeq = 0;
effect(() => {
	const name = libName();
	const tier = tierName();
	// The running view already shows this pair: the effect's initial run,
	// or the selection was just put back after a failed build.
	if (name === builtName && tier === builtTier) return;
	const seq = ++buildSeq;
	building(true);
	note(`building ${name} @ ${tier}…`);
	// Two frames: the first rAF fires before the pending paint, so the
	// note reaches the screen at the end of that frame; the build runs in
	// the second, keeping the page honest about multi-second builds.
	requestAnimationFrame(() => requestAnimationFrame(() => {
		if (seq !== buildSeq) return; // superseded by a newer selection
		// Free the outgoing graph before building the next one: its ids
		// return to the arena, so the new build reuses those records
		// instead of holding two graphs' worth of memory at the peak.
		view().rt.dispose();
		let next;
		try {
			next = makeView();
		} catch (err) {
			note(`build failed for ${name} @ ${tier} — ${err?.message ?? err}`);
			// The old graph is already freed, so put the selection back and
			// clear the built pair: the rebuild effect sees the reverted
			// selection as new work and rebuilds it from scratch.
			const prevName = builtName;
			const prevTier = builtTier;
			builtName = builtTier = undefined;
			startBatch();
			try {
				libName(prevName);
				tierName(prevTier);
			} finally {
				endBatch();
			}
			return;
		}
		builtName = name;
		builtTier = tier;
		view(next);
		finishRebuild(name, tier);
	}));
});
finishRebuild(builtName, builtTier); // initial view: size the canvas and post the note

function finishRebuild(name, tier) {
	const v = view();
	v.rt.set(v.graph.quantize, cutoffOn());
	canvas.width = v.w;
	canvas.height = v.h;
	frameTimes.length = 0;
	building(false);
	note(`${name} @ ${tier}: ${v.graph.nodes.toLocaleString()} nodes built in ${v.graph.buildMs.toFixed(1)} ms`);
}

// ---- input => state --------------------------------------------------------------
let painting = false;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { painting = true; canvas.setPointerCapture(e.pointerId); paint(e); });
canvas.addEventListener('pointermove', (e) => { if (painting) paint(e); });
canvas.addEventListener('pointerup', () => { painting = false; });

function paint(e) {
	if (building()) return;
	const { rt, graph, w, h } = view();
	const dark = (e.buttons & 2) !== 0 || e.button === 2;
	const rect = canvas.getBoundingClientRect();
	const x = Math.floor(((e.clientX - rect.left) / rect.width) * w);
	const y = Math.floor(((e.clientY - rect.top) / rect.height) * h);
	// write into the source row of the band under the pointer
	const band = graph.bandSources[Math.min(graph.bandSources.length - 1, Math.max(0, Math.floor(y / BAND)))];
	const brush = Math.max(2, w >> 7);
	rt.batch(() => {
		for (let dx = -brush; dx <= brush; dx++) {
			const value = dark ? 0 : 1 - (Math.abs(dx) / (brush + 1)) * 0.7;
			rt.set(band.cells[(x + dx + w) % w], value);
		}
	});
}

function timeFullPass(write) {
	if (building()) return;
	const v = view();
	v.graph.stats.recomputes = 0;
	const t0 = performance.now();
	try {
		v.rt.batch(write);
	} catch (err) {
		// A failed pass must surface in the note, not escape the handler
		// mid-flush and strand whatever effects are still queued.
		note(`update failed — ${err?.message ?? err}`);
		return;
	}
	recomputedCount(v.graph.stats.recomputes);
	note(`${v.graph.stats.recomputes.toLocaleString()} recomputes in ${(performance.now() - t0).toFixed(1)} ms`);
}

// ---- render loop ----------------------------------------------------------------
// Render effects repaint changed pixels as each library's scheduler runs
// them; the frame loop only issues writes inside one batch per frame.

let frames = 0;
let frameCount = 0;
let fpsWindow = performance.now();
let phase = 0;
const emitters = [
	{ speed: 0.021, span: 0.9, width: 2, gain: 1.0 },
	{ speed: -0.033, span: 0.55, width: 1, gain: 0.8 },
	{ speed: 0.013, span: 0.75, width: 3, gain: 0.65 },
];

function frame() {
	frameCount++;
	if (!building()) {
		const v = view();
		const g = v.graph;
		const rt = v.rt;
		g.stats.recomputes = 0;

		const m = mode();
		const bands = g.bandSources;
		const t0 = performance.now();
		rt.batch(() => {
			if (m === 'wave') {
				phase += 1;
				// one band per frame keeps frame cost bounded at every tier
				const band = bands[phase % bands.length];
				for (const em of emitters) {
					const centre = (Math.sin(phase * em.speed) * em.span * 0.5 + 0.5) * v.w;
					const ww = Math.max(em.width, v.w >> 8);
					for (let dx = -ww; dx <= ww; dx++) {
						const i = (Math.round(centre) + dx + v.w) % v.w;
						rt.set(band.cells[i], em.gain * Math.max(0, 1 - Math.abs(dx) / (ww + 1)));
					}
				}
				if (phase % 90 === 0) {
					rt.set(band.cells[Math.floor(Math.random() * v.w)], 1);
				}
			} else if (m === 'storm') {
				const drops = Math.max(4, v.w >> 7);
				for (let k = 0; k < drops; k++) {
					const band = bands[Math.floor(Math.random() * bands.length)];
					rt.set(band.cells[Math.floor(Math.random() * v.w)], Math.random() * 0.9);
				}
			}
		});
		const ms = performance.now() - t0;
		frameMs(ms);
		frameTimes.push(ms);
		if (frameTimes.length > 120) frameTimes.shift();
		avgFrameMs(frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length);
		recomputedCount(g.stats.recomputes);

		// The glow pass touches every pixel, so it only runs while something
		// is glowing: ~18 frames of decay after the last change.
		if (v.dirty) {
			v.glowUntil = frameCount + 18;
			v.dirty = false;
		}
		if (frameCount <= v.glowUntil) {
			const { image, flash, vals } = v;
			const data = image.data;
			for (let i = 0; i < flash.length; i++) {
				const f = flash[i];
				if (f > 0.02) {
					flash[i] = f * 0.78;
					paintPixel(data, i, vals[i], flash[i]);
				} else if (f !== 0) {
					flash[i] = 0;
					paintPixel(data, i, vals[i], 0);
				}
			}
			ctx.putImageData(image, 0, 0);
		}
	}

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
