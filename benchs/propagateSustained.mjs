// Sustained-throughput propagate: N back-to-back writes per shape with NO
// gc()/settling between samples, so allocation and GC cost land inside the
// measurement. This is the companion to propagate.mjs (mitata), whose
// per-iteration sampling lets the collector run between samples and so
// systematically under-reports the cost of traversal garbage (see
// research/RESEARCH.md §1.8 in the parent repo: "fastest-of-N hides GC
// costs"). Apps that stream writes experience THIS number, not the min.
import { computed, effect, signal } from '../esm/index.mjs';

const shapes = [
	[1, 1], [1, 10], [1, 100],
	[10, 1], [10, 10], [10, 100],
	[100, 1], [100, 10], [100, 100],
];

console.log('| shape (w x h) | ns/write (sustained) |');
console.log('| ------------- | -------------------- |');
for (const [w, h] of shapes) {
	const src = signal(1);
	for (let i = 0; i < w; i++) {
		let last = src;
		for (let j = 0; j < h; j++) {
			const prev = last;
			last = computed(() => prev() + 1);
		}
		effect(() => { last(); });
	}
	const cost = w * h + w + 1;
	const n = Math.max(3000, Math.min(3_000_000, Math.round(60_000_000 / cost)));
	for (let k = 0; k < Math.min(n, 50_000); k++) {
		src(src() + 1); // warmup
	}
	const t0 = performance.now();
	for (let k = 0; k < n; k++) {
		src(src() + 1);
	}
	const ns = (performance.now() - t0) * 1e6 / n;
	console.log(`| ${w} x ${h} | ${ns.toFixed(1)} |`);
}
