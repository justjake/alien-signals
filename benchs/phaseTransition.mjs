// Measures the workload-phase-transition cost that call-site seeding
// (src/system.ts materialize()) exists to remove, so the mitigation can be
// re-verified after Node/V8 upgrades.
//
// Phase A runs a single getter shape hot (the regime where V8 speculates on
// exact call targets at the engine's user-callback sites). Phase B then
// introduces several new getter shapes and re-times the SAME phase-A graph.
// Without seeding, phase B deoptimizes the engine's hot functions (observed:
// computedReadWith 4.6x self-time, 20-35% on pull-heavy suite tests) and
// phase-A rates drop until reoptimization settles; with seeding the sites are
// megamorphic from birth and A-during-B stays flat.
//
// Interpretation: A-alone vs A-after-B should be within noise (<5%). A large
// gap means V8's polymorphism threshold or call-IC behavior changed and the
// seed in materialize() needs re-tuning (it currently assumes >4 shapes =
// megamorphic, stable in V8 for over a decade).
//
// Usage: node benchs/phaseTransition.mjs
import { computed, effect, signal } from '../esm/index.mjs';

function buildChain(depth, mk) {
	const src = signal(1);
	let last = src;
	for (let i = 0; i < depth; i++) {
		const prev = last;
		last = mk(prev, i);
	}
	effect(() => {
		last();
	});
	return src;
}

function timeWrites(src, n) {
	const t0 = performance.now();
	for (let i = 0; i < n; i++) {
		src(i);
	}
	return performance.now() - t0;
}

const N = 200_000;

// Phase A: one getter shape, hot.
const a = buildChain(40, (prev) => computed(() => prev() + 1));
timeWrites(a, N); // warm
const aAlone = timeWrites(a, N);

// Phase B: introduce distinct getter shapes (a second workload arriving in
// the same process), run them hot enough to matter.
const shapes = [
	(prev) => computed(() => prev() - 1),
	(prev) => computed(() => prev() * 2),
	(prev) => computed(() => (prev() & 7) + 1),
	(prev) => computed(() => Math.max(prev(), 0)),
	(prev) => computed(() => prev() + prev()),
];
for (const mk of shapes) {
	const src = buildChain(40, mk);
	timeWrites(src, N / 4);
}

// Phase A again on the ORIGINAL graph: did B's shapes knock A down?
const aAfterB = timeWrites(a, N);
const ratio = aAfterB / aAlone;
console.log(`phase A alone:   ${aAlone.toFixed(1)} ms`);
console.log(`phase A after B: ${aAfterB.toFixed(1)} ms`);
console.log(`transition ratio: ${ratio.toFixed(3)} ${ratio < 1.05 ? '(flat: seeding effective)' : '(CLIFF: re-tune seed in system.ts materialize())'}`);
