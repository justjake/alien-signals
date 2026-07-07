// The computation graph, DOM-free so it can be smoke-run under Node.
//
// Shape: row 0 is WIDTH signals; every later cell is a computed blending
// the three cells above it ([i-1, i, i+1], wrapping) through fixed
// per-cell weights. Writing one source therefore invalidates a cone that
// widens by one cell per row — the classic dependency cone, and exactly
// the region the engine recomputes: everything outside it is untouched.
//
// `quantize` is a signal EVERY cell reads. With it on, each cell rounds
// its output to a coarse step, so a small change often settles to the
// SAME value partway down — equality cutoff stops the cascade and the
// cone visibly narrows. Flipping it is also a full-graph invalidation:
// one write that recomputes every node, which the HUD times.

export function buildGraph(width, depth, adapter) {
	const { signal, computed } = adapter;
	const recomputed = [];
	const quantize = signal(true);
	const readQuantize = quantize.read;
	// A generation counter every cell reads: bumping it invalidates the
	// whole graph in one write — the full-throughput lever.
	const epoch = signal(0);
	const readEpoch = epoch.read;

	const t0 = performance.now();
	const sources = [];
	for (let i = 0; i < width; i++) {
		sources.push(signal(0));
	}
	const rows = [sources];
	for (let r = 1; r < depth; r++) {
		const above = rows[r - 1];
		const row = [];
		for (let i = 0; i < width; i++) {
			const a = above[(i - 1 + width) % width].read;
			const b = above[i].read;
			const c = above[(i + 1) % width].read;
			// Fixed pseudo-random weights per cell keep the field organic
			// without any per-frame randomness.
			const h = Math.sin(i * 12.9898 + r * 78.233) * 43758.5453;
			const jitter = (h - Math.floor(h)) * 0.08;
			const wa = 0.22 + jitter;
			const wb = 0.5;
			const wc = 0.25 - jitter;
			const index = r * width + i;
			row.push(computed(() => {
				readEpoch();
				recomputed.push(index);
				const v = a() * wa + b() * wb + c() * wc;
				return readQuantize() ? Math.round(v * 96) / 96 : v;
			}));
		}
		rows.push(row);
	}
	const buildMs = performance.now() - t0;

	return {
		width,
		depth,
		rows,
		sources,
		quantize,
		epoch,
		recomputed, // cells append their index as they recompute; drain per frame
		nodes: width * depth + 1,
		edges: width * (depth - 1) * 5 + 2, // 3 neighbors + quantize + epoch per cell
		buildMs,
	};
}
