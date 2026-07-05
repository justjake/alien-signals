// Sustained write cost across recompute-cone sizes, for locating the
// alien/dalien crossover and identifying what governs it. One process per
// library (set LIB to the library's esm index); FAMILY picks the shape:
//
//   deep    one chain of N computeds, one effect; a write recomputes N+1
//           nodes in a dependency line (pointer-chase depth).
//   broad   N independent chains of length 1; a write recomputes N+1 nodes
//           as siblings (fan-out width).
//   grid    sqrt(N) chains of sqrt(N) computeds — depth and width balanced.
//   batch   N atoms, each with its own single computed + effect, all N
//           written per iteration inside one batch: the same total
//           recompute as `broad` but reached with many small writes
//           instead of one write with a large cone. If ratios here track
//           `broad` at equal N, the governing variable is nodes recomputed
//           per flush, not atoms written.
//   islands ONE fixed 100-node cone, plus N unaffected nodes idling in the
//           graph. If ratios stay flat in N, total graph size is irrelevant
//           to write cost for both libraries.
//
// Output: CSV rows `family,N,nsPerWrite` on stdout.
const { computed, effect, signal, startBatch, endBatch } = await import(process.env.LIB);
const FAMILY = process.env.FAMILY ?? 'deep';
const SIZES = (process.env.SIZES ?? '1,3,10,30,100,300,1000,3000,10000,30000').split(',').map(Number);

function chain(src, len) {
	let last = src;
	for (let j = 0; j < len; j++) {
		const prev = last;
		last = computed(() => prev() + 1);
		// Evaluate periodically during construction: the first read of a
		// fresh chain recurses one user-getter frame per link, and both
		// libraries overflow the stack near ~10k unevaluated links.
		if (j % 500 === 499) last();
	}
	effect(() => {
		last();
	});
}

for (const N of SIZES) {
	let write;
	let cost; // approximate nodes touched per iteration, for the loop budget
	if (FAMILY === 'deep') {
		const src = signal(1);
		chain(src, N);
		write = (k) => src(k);
		cost = N + 2;
	} else if (FAMILY === 'broad') {
		const src = signal(1);
		for (let i = 0; i < N; i++) chain(src, 1);
		write = (k) => src(k);
		cost = 2 * N + 1;
	} else if (FAMILY === 'grid') {
		const side = Math.max(1, Math.round(Math.sqrt(N)));
		const src = signal(1);
		for (let i = 0; i < side; i++) chain(src, side);
		write = (k) => src(k);
		cost = side * side + side + 1;
	} else if (FAMILY === 'batch') {
		const atoms = [];
		for (let i = 0; i < N; i++) {
			const a = signal(1);
			chain(a, 1);
			atoms.push(a);
		}
		write = (k) => {
			startBatch();
			for (let i = 0; i < N; i++) atoms[i](k);
			endBatch();
		};
		cost = 3 * N;
	} else if (FAMILY === 'islands') {
		const src = signal(1);
		chain(src, 100);
		// N idle nodes: subscribed (so they are live graph, not garbage),
		// but never invalidated by the measured write.
		const idle = signal(1);
		for (let i = 0; i < N; i++) chain(idle, 1);
		write = (k) => src(k);
		cost = 102;
	} else {
		throw new Error(`unknown FAMILY ${FAMILY}`);
	}

	const n = Math.max(2000, Math.min(2_000_000, Math.round(40_000_000 / cost)));
	for (let k = 0; k < Math.min(n, 30_000); k++) write(k);
	const t0 = performance.now();
	for (let k = 0; k < n; k++) write(k);
	const ns = ((performance.now() - t0) * 1e6) / n;
	console.log(`${FAMILY},${N},${ns.toFixed(1)}`);
}
