// benchs/crossover.mjs works directly on this library's DEFAULT API now
// (upstream-shaped callables). This runner covers the RAW ID TIER instead:
// the manual malloc/free interface (signalId/computedId/effectId +
// get()/set()), same families, sizes, loop budgets, and CSV protocol.
const lib = await import(process.env.LIB ?? '../esm/index.mjs');
const FAMILY = process.env.FAMILY ?? 'deep';
const SIZES = (process.env.SIZES ?? '1,3,10,30,100,300,1000,3000,10000,30000').split(',').map(Number);

const { signalId, computedId, effectId, get, set, startBatch, endBatch } = lib;

const mkSignal = signalId;
const sig = set;
function mkChain(src, len) {
	let last = src;
	for (let j = 0; j < len; j++) {
		const prev = last;
		last = computedId(() => get(prev) + 1);
		// Evaluate periodically during construction: the first read of a
		// fresh chain recurses one user-getter frame per link, and both
		// libraries overflow the stack near ~10k unevaluated links.
		if (j % 500 === 499) get(last);
	}
	const tail = last;
	effectId(() => {
		get(tail);
	});
}

for (const N of SIZES) {
	let write;
	let cost; // approximate nodes touched per iteration, for the loop budget
	if (FAMILY === 'deep') {
		const src = mkSignal(1);
		mkChain(src, N);
		write = (k) => sig(src, k);
		cost = N + 2;
	} else if (FAMILY === 'broad') {
		const src = mkSignal(1);
		for (let i = 0; i < N; i++) mkChain(src, 1);
		write = (k) => sig(src, k);
		cost = 2 * N + 1;
	} else if (FAMILY === 'grid') {
		const side = Math.max(1, Math.round(Math.sqrt(N)));
		const src = mkSignal(1);
		for (let i = 0; i < side; i++) mkChain(src, side);
		write = (k) => sig(src, k);
		cost = side * side + side + 1;
	} else if (FAMILY === 'batch') {
		const atoms = [];
		for (let i = 0; i < N; i++) {
			const a = mkSignal(1);
			mkChain(a, 1);
			atoms.push(a);
		}
		write = (k) => {
			startBatch();
			for (let i = 0; i < N; i++) sig(atoms[i], k);
			endBatch();
		};
		cost = 3 * N;
	} else if (FAMILY === 'islands') {
		const src = mkSignal(1);
		mkChain(src, 100);
		// N idle nodes: subscribed (so they are live graph, not garbage),
		// but never invalidated by the measured write.
		const idle = mkSignal(1);
		for (let i = 0; i < N; i++) mkChain(idle, 1);
		write = (k) => sig(src, k);
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
