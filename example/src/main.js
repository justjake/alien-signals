// The demo's own UI runs on dalien-signals: every piece of page state is a
// signal, every DOM mutation lives in an effect. Handlers write state;
// effects project state into the document.
import { signal, computed, effect, growCapacity, setEffectMode, startBatch, endBatch } from 'dalien-signals';
import { buildGraph, makeWaveDriver, BAND } from './graph.js';
import { paintPixel, makeRowMix } from './palette.js';
import { makeRuntime } from './adapters.js';
import { FRAMEWORKS } from './milomgFrameworks.js';
import { mountCounter, mountStepper, mountSheet } from './widgets.js';
import { mountBench } from './bench.js';

// Reserve the arena before any signal exists. Growth rebuilds the engine,
// and callables created before a rebuild keep mixed call-site feedback
// afterwards — reserving up front keeps the page's long-lived signals and
// every tier through 720p on one engine generation. Reservation is
// address space (512 MB here); pages commit only as records are touched.
growCapacity(1 << 24);

// The imported benchmark adapters for dalien switch the engine's effect
// queue to manual mode at module load (their withBatch flushes it
// explicitly). This page's own UI relies on the default: a write outside
// a batch runs queued effects synchronously. Restore that before any page
// state exists; the dalien adapters still work in sync mode — their
// explicit flush just finds an empty queue.
setEffectMode('sync');

// One signal or computed per pixel at the named resolution, plus one
// render effect per pixel on top: at 1080p the arena holds ~4.1 million
// live nodes.
const TIERS = {
	'320p': [568, 320],
	'480p': [854, 480],
	'720p': [1280, 720],
	'1080p': [1920, 1080],
	'4k': [3840, 2160],
};
// Records per pixel: the cell node plus its dependency links (3 in deep
// bands, 4 in wide), and the render-effect node plus its one link —
// about 7 records. The arena doubles itself once it passes 3/4 full, so
// a tier needs 4/3 of its record count reserved to never rebuild
// mid-run. The boot reservation covers every tier through 720p (0.9 MP,
// ~5.9M records); 1080p (2.1 MP, ~13.4M records) grows once, to 1 GB,
// when selected, and 4k (8.3 MP, ~54M records) to 4 GB. A machine that
// refuses a reservation fails the build, which surfaces as a red line in
// the activity log.
const TIER_RECORDS = {
	'1080p': 1 << 25,
	'4k': 1 << 27,
};

// Importable but not selectable in the field demo:
//
// mol-wire cannot drive this page: its adapter's effect atoms are lazy —
// a $mol_wire_atom body runs on first pull, and only already-run atoms
// are subscribed and rescheduled — and nothing in the field ever pulls a
// render effect, so the canvas stays dark (verified: builds at 320p,
// zero pixels ever paint). The benchmark worker can still run the
// adapter, whose suites do pull.
//
// Two dalien entries compare its tiers on the same field: dalien-signals
// is the callable tier through the same generic bridge every library
// uses; dalien-malloc-free is the native integer-id tier with zero
// adapter overhead (bare ids, module get/set, per-id dispose).
const UNSELECTABLE = new Set(['mol-wire']);

// ---- sticky selection -----------------------------------------------------------
// The chosen library and tier survive a reload. Reads validate against
// the current roster — stale keys from an older deploy fall back to the
// defaults — and storage access is allowed to fail silently (private
// mode, file: contexts): stickiness is a nicety, never a boot blocker.
// A stored library only ever comes from an explicit selection — while the
// library tour runs, the persistence effect stores the tier alone — so
// its presence is what tells the next boot to start the tour paused.
const STICKY_KEY = 'dalien-example-selection';
function readStickySelection() {
	const fallback = { lib: 'dalien-signals', tier: '720p', paused: false };
	try {
		const stored = JSON.parse(localStorage.getItem(STICKY_KEY) ?? '{}');
		const storedLib = FRAMEWORKS[stored.lib] && !UNSELECTABLE.has(stored.lib) ? stored.lib : undefined;
		return {
			lib: storedLib ?? fallback.lib,
			tier: TIERS[stored.tier] ? stored.tier : fallback.tier,
			paused: storedLib !== undefined,
		};
	} catch {
		return fallback;
	}
}

// ---- page state ---------------------------------------------------------------
const sticky = readStickySelection();
const libName = signal(sticky.lib);
const tierName = signal(sticky.tier);
const mode = signal('wave'); // 'off' | 'wave' | 'storm'
const building = signal(false);
const recomputedCount = signal(0);
const frameMs = signal(0);
const fps = signal(0);
const heap = signal(NaN); // latest usedJSHeapSize sample; NaN when unsupported
const note = signal('');

// ---- rolling averages -----------------------------------------------------------
// Every sampled stat pairs its current reading with a rolling average over
// the same window. A ring buffer with a running sum keeps the window's
// storage alive across frames and rebuilds — push/shift moves every element
// each sample, and `length = 0` drops the backing store just to reallocate
// it — and makes the average O(1). The average signal is NaN until the
// first sample lands; the stat bindings omit the avg segment then instead
// of showing a zero that was never measured. One window size, at each
// metric's own cadence: per frame (frame compute, recomputed cells), per
// half second (fps), per second (js heap) — so the windows span roughly
// the last two seconds to two minutes of the running graph.
const AVG_WINDOW = 120;
function rollingAverage() {
	const samples = new Float64Array(AVG_WINDOW);
	let count = 0;
	let index = 0;
	let sum = 0;
	const average = signal(NaN);
	return {
		average,
		record(value) {
			if (count === AVG_WINDOW) sum -= samples[index];
			else count++;
			samples[index] = value;
			index = (index + 1) % AVG_WINDOW;
			sum += value;
			average(sum / count);
		},
		reset() {
			count = 0;
			index = 0;
			sum = 0;
			average(NaN);
		},
	};
}
const frameAvg = rollingAverage();
const recomputedAvg = rollingAverage();
const fpsAvg = rollingAverage();
const heapAvg = rollingAverage();
// The fps counters live up here so resetAverages — which runs during
// module init via finishRebuild — can restart the fps window without
// reaching below its own declaration.
let frames = 0;
let fpsWindow = performance.now();
// Averages describe the running graph, so a rebuild starts every window
// over, and the fps window restarts so its first sample counts only
// new-graph frames. The heap window is reseeded with a fresh sample right
// away: its cadence is one second, and an empty window would blank the avg
// segment for that long even though a current reading is available.
function resetAverages() {
	frameAvg.reset();
	recomputedAvg.reset();
	fpsAvg.reset();
	heapAvg.reset();
	frames = 0;
	fpsWindow = performance.now();
	if (performance.memory) {
		const bytes = performance.memory.usedJSHeapSize;
		heap(bytes);
		heapAvg.record(bytes);
	}
}

// ---- library tour -----------------------------------------------------------------
// The bar visits every selectable library on a ~5s dwell clock. A dwell
// starts when a build finishes (startDwell in finishRebuild) and ends
// TOUR_DWELL_MS later: the frame average accumulated since that build is
// snapshotted onto the library's subtitle, and — when the tour is running —
// the selection advances to the next stop. While paused the clock keeps
// running in place, so a parked library's subtitle refreshes with each
// ~5s of new frames. The tour always boots playing; a stored library only
// picks the starting stop. Pausing is a per-visit act, not a preference.
const TOUR_DWELL_MS = 5000;
const cycling = signal(true);
// Per-library subtitle stats, each field recorded where it is measured:
// setupMs when a build succeeds, teardownMs when the library is left (it
// is unknowable sooner), frameAvgMs at dwell end. One signal-of-map keeps
// the subtitles a pure projection; writes replace the map so the render
// effect reruns on any change.
const libStats = signal(new Map());
function recordLibStats(name, patch) {
	const next = new Map(libStats());
	next.set(name, { ...next.get(name), ...patch });
	libStats(next);
}
// Libraries marked slow carry a badge and are excluded from the auto tour
// at 720p and above, where their mount or unmount stalls the rotation for
// tens of seconds (tc39's Watcher.unwatch is quadratic in watched
// producers; tansu and svelte pay heavy per-node teardown). Selecting one
// by hand always works and still records its stats. A library whose build
// fails during the tour joins tourFailed so the rotation advances past it
// instead of wedging on the failure.
const SLOW_LABELS = new Map([
	['tansu', 'slow'],
	['svelte', 'slow unmount'],
	['tc39-signals', 'slow & quadratic unmount'],
]);
const SLOW_TIER_MIN = Object.keys(TIERS).indexOf('720p');
const tierTooBigForSlow = () => Object.keys(TIERS).indexOf(tierName()) >= SLOW_TIER_MIN;
const tourFailed = new Set();
const TOUR_ORDER = Object.keys(FRAMEWORKS).filter((key) => !UNSELECTABLE.has(key));
function nextTourStop(from) {
	const at = TOUR_ORDER.indexOf(from);
	for (let step = 1; step <= TOUR_ORDER.length; step++) {
		const key = TOUR_ORDER[(at + step) % TOUR_ORDER.length];
		if (SLOW_LABELS.has(key) && tierTooBigForSlow()) continue;
		if (!tourFailed.has(key)) return key;
	}
	return undefined; // every stop skipped or failed — nowhere to advance
}
let dwellTimer;
let dwellLib; // the library whose ~5s visit clock is running
function startDwell(name) {
	clearTimeout(dwellTimer);
	dwellLib = name;
	dwellTimer = setTimeout(endDwell, TOUR_DWELL_MS);
}
function endDwell() {
	// ~5s of samples since this library's build finished: the rolling fps
	// average was reset at that build, so it is exactly this visit's reading.
	const avg = fpsAvg.average();
	if (Number.isFinite(avg)) recordLibStats(dwellLib, { fps: avg });
	if (cycling()) {
		const next = nextTourStop(dwellLib);
		if (next !== undefined) {
			libName(next); // the rebuild effect takes over; the next dwell starts at finishRebuild
			return;
		}
		cycling(false); // nowhere to advance — park here
	}
	startDwell(dwellLib); // paused: refresh this library's stats every ~5s
}
// The whole render bundle — runtime, graph, size-matched buffers — is one
// signal, rebuilt when the library or tier changes. A sticky selection
// can boot straight into a heavy tier; if this machine refuses it (the
// reservations are gigabyte-scale at 4k), fall back to the defaults so
// the page still comes up, and surface the error once the log exists.
const bootSetupT0 = performance.now();
let bootBundle;
let bootError;
try {
	bootBundle = makeView();
} catch (err) {
	bootError = err;
	startBatch();
	try {
		libName('dalien-signals');
		tierName('320p');
	} finally {
		endBatch();
	}
	bootBundle = makeView();
}
const view = signal(bootBundle);
const bootSetupMs = performance.now() - bootSetupT0;

// Activity log, newest at the bottom. The frozen history is one signal
// rendered wholesale — lines are appended only on rebuilds — while the
// live average line is bound to its own element below the list, so its
// per-frame updates touch one text node instead of re-rendering the list.
// Failures keep a visible home after the narration log's removal: the
// last few errors render in red under the controls; the container hides
// when there is nothing to report.
const ERROR_LIMIT = 5;
const errorLines = signal([]);
const reportError = (text) => errorLines([...errorLines(), text].slice(-ERROR_LIMIT));


const $ = (id) => document.getElementById(id);
const canvas = $('grid');
const ctx = canvas.getContext('2d');

function makeView() {
	const name = libName();
	const tier = tierName();
	const [w, h] = TIERS[tier];
	// Both dalien-backed selections — the native id tier and the benchmark
	// adapter's malloc/free tier — allocate from the same shared arena.
	if (name.startsWith('dalien') && TIER_RECORDS[tier]) {
		growCapacity(TIER_RECORDS[tier]); // address space is cheap; pages are lazy
	}
	const rt = makeRuntime(name, FRAMEWORKS[name]);
	const count = w * h;
	const image = new ImageData(w, h);
	const data = image.data;
	const vals = new Float32Array(count);
	// Glow bookkeeping: flash[i] is pixel i's glow level, and the first
	// flashEnd entries of flashList are exactly the pixels with glow > 0.
	// The render loop decays that list instead of scanning the field, and
	// flash[i] === 0 doubles as "not in the list", so a pixel is never
	// appended twice.
	const flash = new Float32Array(count);
	const flashList = new Int32Array(count);
	// per-row palette family (deep vs wide, crossfaded at band seams)
	const rowMix = makeRowMix(h);
	const bundle = { rt, graph: undefined, w, h, image, vals, flash, flashList, flashEnd: 0, rowMix };
	// Everything the graph owns — signals, computeds, render effects — is
	// created inside the runtime's build scope, so dispose() can hand the
	// whole graph back through each framework's own ownership mechanism
	// (effect scope, root).
	rt.build(() => {
		const graph = buildGraph(w, h, rt);
		bundle.graph = graph;
		const get = rt.get;
		const ids = graph.ids;
		// Settle the graph before wiring watchers: a plain read pass
		// evaluates every cell in dependency order, so effect creation
		// links into a finished graph and does uniform work per pixel,
		// instead of driving cold cascades of arbitrary depth from inside
		// each effect body. Measured on dalien at 1080p: 4x off the first
		// build when render effects covered 64-pixel tiles (7.5s -> 2.0s);
		// with per-pixel effects the totals are close (2.8s with, 2.4s
		// without, Node), and the pass stays for the bounded per-effect
		// creation cost.
		for (let i = 0; i < ids.length; i++) {
			get(ids[i]);
		}
		// One render effect per pixel: the finest possible subscription, so
		// each library's own scheduler decides exactly which pixels repaint.
		// An effect reruns only when its cell produced a new value (every
		// library here cuts propagation on equality), so the body repaints
		// unconditionally — running at all is the proof of change.
		// The factory keeps each closure's own context to the one pixel
		// index and its row's palette family; the shared buffers are
		// captured once, in the enclosing scope.
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
	});
	// the wave mode's adaptive write controller, sized to this graph
	bundle.driver = makeWaveDriver(bundle.graph);
	return bundle;
}

// ---- state => document ----------------------------------------------------------
const bindText = (id, read) => effect(() => { $(id).textContent = read(); });
// A sampled stat is one tile reading "<current> / avg <average>": the
// current value in the tile's .now node, the quieter avg segment in its
// .avg node (see .stat .avg). Two effects, so each segment updates on its
// own signal; while a fresh window is still empty (average is NaN) the avg
// segment is omitted rather than shown as a zero nobody measured.
const bindStat = (id, fmt, current, average) => {
	const el = $(id);
	const now = el.querySelector('.now');
	const avg = el.querySelector('.avg');
	effect(() => { now.textContent = fmt(current()); });
	effect(() => {
		const a = average();
		avg.textContent = Number.isFinite(a) ? ` / avg ${fmt(a)}` : '';
	});
};

bindText('stat-nodes', () => view().graph.nodes.toLocaleString());
bindText('stat-edges', () => view().graph.edges.toLocaleString());
bindStat('stat-recomputed', (n) => Math.round(n).toLocaleString(), recomputedCount, recomputedAvg.average);
// share of the graph recomputed: nodes is constant per graph and the
// windows reset on rebuild, so the average share is the averaged count
// over the same node total — no separate window needed.
const shareOf = (count) => (count / view().graph.nodes) * 100;
bindStat('stat-share', (p) => `${p.toFixed(1)}%`, () => shareOf(recomputedCount()), () => shareOf(recomputedAvg.average()));
bindStat('stat-frame', (ms) => `${ms.toFixed(2)} ms`, frameMs, frameAvg.average);
bindStat('stat-fps', (f) => String(Math.round(f)), fps, fpsAvg.average);
const mb = (bytes) => `${(bytes / (1 << 20)).toFixed(1)} MB`;
// dalien's arena footprint for this graph: nodes, dependency edges, and
// one render effect (node + link) per pixel, 32 bytes each. Other
// libraries build the same graph from ordinary heap objects — their cost
// shows in the js heap stat instead.
bindText('stat-arena', () => {
	const v = view();
	return mb((v.graph.nodes + v.graph.edges + 2 * v.w * v.h) * 32);
});
bindStat('stat-heap', (bytes) => (Number.isFinite(bytes) ? mb(bytes) : 'n/a'), heap, heapAvg.average);
if (performance.memory) {
	setInterval(() => {
		const bytes = performance.memory.usedJSHeapSize;
		heap(bytes);
		heapAvg.record(bytes);
	}, 1000);
	heap(performance.memory.usedJSHeapSize);
}
bindText('note', note);

effect(() => {
	const list = $('errors');
	list.textContent = '';
	list.style.display = errorLines().length === 0 ? 'none' : '';
	for (const text of errorLines()) {
		const div = document.createElement('div');
		div.textContent = text;
		list.append(div);
	}
});
if (bootError) {
	reportError(`${sticky.lib} @ ${sticky.tier}: build failed on boot — ${String(bootError)}`);
}
recordLibStats(libName(), { setupMs: bootSetupMs });

// state => persistence: one effect mirrors the selection into storage
// whenever it changes; a write failure is silently ignored. While the
// tour runs, the library is a transient stop, not a choice to restore —
// only the tier persists then, and the absent lib key is what makes the
// next boot start the tour running (see readStickySelection).
effect(() => {
	const value = JSON.stringify(cycling() ? { tier: tierName() } : { lib: libName(), tier: tierName() });
	try {
		localStorage.setItem(STICKY_KEY, value);
	} catch {
		// storage unavailable — the selection just won't stick
	}
});

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
// The library bar is generated from the frameworks map, so the selector
// can never drift from the set of imported adapters (UNSELECTABLE keys
// excluded, see above). data-v carries the key makeRuntime receives. Each
// button holds two fixed lines — the adapter's display name over the
// visit-stats subtitle — so a stat appearing never resizes its cell.
// Buttons must exist before radioGroup snapshots the group.
for (const [key, framework] of Object.entries(FRAMEWORKS)) {
	if (UNSELECTABLE.has(key)) continue;
	const b = document.createElement('button');
	b.dataset.v = key;
	b.title = framework.name; // long names ellipsize in the grid cell
	const nameLine = document.createElement('span');
	nameLine.className = 'lib-name';
	nameLine.textContent = framework.name;
	const statsLine = document.createElement('span');
	statsLine.className = 'lib-stats';
	b.append(nameLine, statsLine);
	$('lib-bar').append(b);
}
// Explicit row count so the tour toggle can span the full column height:
// implicit grid rows ignore `grid-row: 1 / -1`.
$('lib-bar').style.setProperty(
	'--lib-rows',
	Math.ceil($('lib-bar').querySelectorAll('button[data-v]').length / 3),
);
// Readout projection: three labeled, color-coded segments — mount (graph
// setup wall), fps (the visit's average), unmount (teardown wall) — an em
// dash per still-unmeasured segment. The name line carries a rank badge:
// position by fps and percent slower than first place, recomputed over
// every measured library whenever any stat lands.
// data-avg-ms carries the unrounded fps so a fresh snapshot is observable
// even when the rounded text comes out identical.
const fmtDur = (ms) => (ms === undefined ? '—' : ms < 999.5 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtFps = (v) => (v === undefined ? '—' : String(Math.round(v)));
{
	const lines = [...$('lib-bar').querySelectorAll('button[data-v] .lib-stats')].map((line) => {
		const seg = (cls, label) => {
			const el = document.createElement('span');
			el.className = `seg ${cls}`;
			el.append(label + '\u00a0');
			const value = document.createElement('b');
			el.append(value);
			line.append(el);
			return value;
		};
		const rank = document.createElement('span');
		rank.className = 'lib-rank';
		const nameEl = line.parentElement.querySelector('.lib-name');
		if (SLOW_LABELS.has(line.parentElement.dataset.v)) {
			const slow = document.createElement('span');
			slow.className = 'lib-slow';
			slow.textContent = SLOW_LABELS.get(line.parentElement.dataset.v);
			slow.title = 'excluded from the auto tour at 720p and above';
			nameEl.append(slow);
		}
		nameEl.append(rank);
		return { line, rank, mount: seg('mount', 'mount'), fps: seg('fps', 'fps'), unmount: seg('unmount', 'unmount') };
	});
	effect(() => {
		const stats = libStats();
		const ranked = [...stats.entries()]
			.filter(([, s]) => s.fps !== undefined)
			.sort((a, b) => b[1].fps - a[1].fps);
		const best = ranked[0]?.[1].fps;
		const rankOf = new Map(ranked.map(([key, s], i) => [key, { place: i + 1, slower: (1 - s.fps / best) * 100 }]));
		// Closeness to dalien-signals, as a subtle wash: parity or faster is
		// a full-strength cyan; the tint cools and fades as fps falls away,
		// vanishing past 60% off. Unmeasured cells stay untinted.
		const mainFps = stats.get('dalien-signals')?.fps;
		const tintFor = (fps) => {
			if (mainFps === undefined || fps === undefined) return '';
			const off = Math.max(0, 1 - fps / mainFps); // 0 = at parity or faster
			const strength = Math.max(0, 1 - off / 0.6);
			if (strength === 0) return '';
			const alpha = (0.04 + 0.16 * strength).toFixed(3);
			return `linear-gradient(135deg, rgba(127, 212, 255, ${alpha}), rgba(127, 212, 255, 0) 65%), #10131c`;
		};
		for (const { line, rank, mount, fps, unmount } of lines) {
			const key = line.parentElement.dataset.v;
			const s = stats.get(key);
			line.parentElement.style.setProperty('--tint', tintFor(s?.fps));
			mount.textContent = fmtDur(s?.setupMs);
			fps.textContent = fmtFps(s?.fps);
			unmount.textContent = fmtDur(s?.teardownMs);
			const r = rankOf.get(key);
			rank.textContent = r === undefined ? ''
				: r.place === 1 ? '#1'
				: `#${r.place} · ${Math.round(r.slower)}% slower`;
			line.title = `mount (graph setup) ${fmtDur(s?.setupMs)} · avg fps ${fmtFps(s?.fps)} · unmount (teardown) ${fmtDur(s?.teardownMs)}${r ? ` · rank ${r.place} by fps` : ''}`;
			if (s?.fps !== undefined) line.dataset.avgMs = String(s.fps);
		}
	});
}
radioGroup('lib-bar', libName, libName);
// An explicit library choice holds: clicking any library pauses the tour.
// The toggle carries no data-v, so it is not a choice — it flips the tour,
// and resuming advances at the current dwell's end rather than instantly.
$('lib-bar').addEventListener('click', (e) => {
	if (e.target.closest('button[data-v]')) cycling(false);
});
$('btn-tour').addEventListener('click', () => cycling(!cycling()));
effect(() => {
	const on = cycling();
	const btn = $('btn-tour');
	btn.textContent = on ? '⏸' : '⏵'; // the glyph names the action a click performs
	btn.title = on ? 'pause the library tour' : 'play the library tour';
});
radioGroup('tier-bar', tierName, tierName);
radioGroup('mode-bar', mode, mode);


// rebuild is a projection of (library, tier)
//
// The build itself stays out of the effect flush: it can take seconds at
// the big tiers (the click would appear to do nothing), and if it throws —
// growCapacity and the pixel buffers are gigabyte-scale allocations at
// 1080p — an exception inside the flush aborts it and strands every DOM-binding
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
	// A new selection ends the current visit: stop its dwell clock now so a
	// stale snapshot can't land (or advance the tour) while graphs swap.
	clearTimeout(dwellTimer);
	const seq = ++buildSeq;
	building(true);
	note(`building ${name} @ ${tier}…`);
	// Two frames: the first rAF fires before the pending paint, so the
	// note reaches the screen at the end of that frame; the build runs in
	// the second, keeping the page honest about multi-second builds.
	requestAnimationFrame(() => requestAnimationFrame(() => {
		if (seq !== buildSeq) return; // superseded by a newer selection
		if (builtName !== undefined && tier !== builtTier) {
			// Visit stats are per-resolution: a 320p mount time or fps says
			// nothing about 720p. New size, clean slate, fresh ranking.
			libStats(new Map());
		}
		// Free the outgoing graph before building the next one: its ids
		// return to the arena, so the new build reuses those records
		// instead of holding two graphs' worth of memory at the peak.
		const teardownT0 = performance.now();
		view().rt.dispose();
		if (builtName !== undefined) {
			// Teardown is only knowable on the way out — write it back onto
			// the outgoing library's subtitle.
			const teardownMs = performance.now() - teardownT0;
			recordLibStats(builtName, { teardownMs });
		}
		let next;
		const setupT0 = performance.now();
		try {
			next = makeView();
		} catch (err) {
			// The note stays concise; the log line carries the whole error.
			note(`build failed for ${name} @ ${tier} — ${err?.message ?? err}`);
			reportError(`${name} @ ${tier}: build failed — ${String(err)}`);
			// A failure during the tour must not wedge the rotation: skip
			// this library for the rest of the session and advance to the
			// next stop immediately. The old graph is already freed, so the
			// advance is an ordinary rebuild with no built pair behind it.
			if (cycling()) {
				tourFailed.add(name);
				const nextStop = nextTourStop(name);
				if (nextStop !== undefined) {
					builtName = builtTier = undefined;
					libName(nextStop);
					return;
				}
				cycling(false); // nowhere left to advance — fall through to the manual retry path
			}
			// The old graph is already freed, so put the selection back and
			// clear the built pair: the rebuild effect sees the reverted
			// selection as new work and rebuilds it from scratch. If this
			// WAS that retry (no built pair to fall back to), stop here —
			// `building` stays true, which keeps the frame loop and pointer
			// input off the disposed view until the user picks a selection
			// that builds.
			if (builtName !== undefined) {
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
			}
			return;
		}
		const setupMs = performance.now() - setupT0;
		recordLibStats(name, { setupMs });
		builtName = name;
		builtTier = tier;
		view(next);
		finishRebuild(name, tier);
	}));
});
finishRebuild(builtName, builtTier); // initial view: size the canvas and post the note

function finishRebuild(name, tier) {
	const v = view();
	v.rt.set(v.graph.quantize, true); // the equality cutoff is always on
	canvas.width = v.w;
	canvas.height = v.h;
	resetAverages();
	building(false);
	note(`${name} @ ${tier}: ${v.graph.nodes.toLocaleString()} nodes built in ${v.graph.buildMs.toFixed(1)} ms`);
	startDwell(name); // this visit's ~5s clock starts once the graph is running
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


// ---- render loop ----------------------------------------------------------------
// Render effects repaint changed pixels as each library's scheduler runs
// them; the frame loop issues writes inside one batch per frame, then
// decays the glow of recently changed pixels.

// frames / fpsWindow are declared with the rolling averages above, so
// resetAverages can restart the fps window on rebuilds.
function frame() {
	if (!building()) {
		const v = view();
		const g = v.graph;
		const rt = v.rt;
		g.stats.recomputes = 0;
		g.stats.deepRecomputes = 0;
		g.stats.wideRecomputes = 0;

		const m = mode();
		const bands = g.bandSources;
		const t0 = performance.now();
		rt.batch(() => {
			if (m === 'wave') {
				v.driver.step(rt);
			} else if (m === 'storm') {
				const drops = Math.max(4, v.w >> 7);
				for (let k = 0; k < drops; k++) {
					const band = bands[Math.floor(Math.random() * bands.length)];
					rt.set(band.cells[Math.floor(Math.random() * v.w)], Math.random() * 0.9);
				}
			}
		});
		const ms = performance.now() - t0;
		// the controller's cone estimates only make sense for its own writes
		if (m === 'wave') v.driver.observe();
		frameMs(ms);
		frameAvg.record(ms);
		recomputedCount(g.stats.recomputes);
		recomputedAvg.record(g.stats.recomputes);

		// The glow pass walks only the pixels with active glow — the live
		// prefix of flashList — compacting the list in place as entries
		// fade out, so its cost tracks recent change, not field size.
		if (v.flashEnd > 0) {
			const { image, flash, flashList, vals, rowMix, w } = v;
			const data = image.data;
			const end = v.flashEnd;
			let live = 0;
			for (let k = 0; k < end; k++) {
				const i = flashList[k];
				const mix = rowMix[(i / w) | 0];
				// fast decay (~9 frames to dark): the glow list holds every
				// recently changed pixel, and the adaptive writes make that
				// hundreds of thousands of entries at the big sizes
				const f = flash[i] * 0.66;
				if (f > 0.02) {
					flash[i] = f;
					flashList[live++] = i;
					paintPixel(data, i, vals[i], f, mix);
				} else {
					flash[i] = 0; // 0 also means "not in the list"
					paintPixel(data, i, vals[i], 0, mix);
				}
			}
			v.flashEnd = live;
			ctx.putImageData(image, 0, 0);
		}
	}

	frames++;
	const now = performance.now();
	if (now - fpsWindow > 500) {
		const sample = Math.round((frames * 1000) / (now - fpsWindow));
		fps(sample);
		fpsAvg.record(sample);
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
