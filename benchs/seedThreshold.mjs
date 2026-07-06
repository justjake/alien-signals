// HISTORICAL: this probe derived the mint-count threshold (33, plateau
// [20, 45]) for the old node-count seeding trigger. Seeding now triggers
// on callback-shape diversity (see maybeSeed in src/system.ts); the
// mint-count sweep is kept for re-deriving a fallback threshold if the
// diversity trigger ever needs one.
// Maps the zero-regret plateau for the lazy-seed threshold in
// src/system.ts (maybeSeed). Build variants with the threshold constant
// patched (5/9/17/33/65/129/never), then run this probe against each:
//
//   MODE=kernel LIB=<variant>/index.mjs node benchs/seedThreshold.mjs
//   MODE=app    LIB=<variant>/index.mjs node benchs/seedThreshold.mjs
//
// Two failure modes bound the threshold from each side. Seeding too early
// charges hot micro-kernels the megamorphic premium for insurance that can
// never pay out (kernel rows slow by ~5-6ns/write; note the engine's four
// startup sampling mints count toward the threshold, so a 3-node kernel is
// seeded already at threshold 5). Seeding too late leaves an app-shaped
// workload speculated when its shapes diversify (cliff ratio jumps from
// ~1.03 to ~1.15 once the threshold exceeds the first graph's size).
// Measured 2026-07-05 (Node 24, Apple M4 Max): premium appears at
// threshold <= 17, cliff appears at >= 65 -> plateau [~20, ~45]; 33 is its
// middle. Rerun after Node/V8 major upgrades alongside phaseTransition.mjs.
const { computed, effect, signal } = await import(process.env.LIB);
function buildChain(depth, mk) {
	const src = signal(1);
	let last = src;
	for (let i = 0; i < depth; i++) { const prev = last; last = mk(prev, i); }
	effect(() => { last(); });
	return src;
}
function timeWrites(src, n) {
	const t0 = performance.now();
	for (let i = 0; i < n; i++) src(i);
	return performance.now() - t0;
}
if (process.env.MODE === 'kernel') {
	// 1 signal + 1 computed + 1 effect = 3 mints; stays under every threshold >3
	const a = buildChain(1, (prev) => computed(() => prev() + 1));
	timeWrites(a, 300000);
	const ms = timeWrites(a, 2000000);
	console.log(`kernel1,${(ms * 1e6 / 2000000).toFixed(1)}`);
	// slightly larger kernel: 13 mints
	const b = buildChain(6, (prev) => computed(() => prev() * 2));
	timeWrites(b, 100000);
	const ms2 = timeWrites(b, 500000);
	console.log(`kernel13,${(ms2 * 1e6 / 500000).toFixed(1)}`);
} else {
	// app-shaped: first graph is 40 nodes, then new shapes arrive
	const a = buildChain(40, (prev) => computed(() => prev() + 1));
	timeWrites(a, 200000);
	const aAlone = timeWrites(a, 200000);
	const shapes = [
		(prev) => computed(() => prev() - 1),
		(prev) => computed(() => prev() * 2),
		(prev) => computed(() => (prev() & 7) + 1),
		(prev) => computed(() => Math.max(prev(), 0)),
		(prev) => computed(() => prev() + prev()),
	];
	for (const mk of shapes) { const s = buildChain(40, mk); timeWrites(s, 50000); }
	const aAfter = timeWrites(a, 200000);
	console.log(`cliff,${(aAfter / aAlone).toFixed(3)}`);
}
