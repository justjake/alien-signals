// The computation field, DOM-free so it can be smoke-run under Node.
//
// Shape: row 0 is WIDTH signals. Every later cell reads its three parents
// ([i-1, i, i+1] above, wrapping) AND one hub — a popular cell chosen from
// several rows up by a fixed hash. About 2% of positions are hubs; each
// collects dozens of subscribers where an ordinary cell has three, so the
// subscriber-list lengths vary by an order of magnitude across the graph.
// A write that reaches a hub fans out in a wide flash; writes that stay
// on ordinary cells cascade in narrow cones. The per-cell transfer adds a
// trigonometric term, so recomputes cost real arithmetic, and the result
// stays a pure function of the inputs.
//
// `quantize` rounds outputs to a coarse step (equality cutoff visibly
// prunes fading cascades); `epoch` is read by every cell, so bumping it
// invalidates the whole graph in one write.

const HUB_STRIDE = 7; // hubs are read from this many rows up

function hubPositions(width, row) {
	const count = Math.max(3, width >> 5);
	const out = [];
	for (let k = 0; k < count; k++) {
		out.push(((k * 2654435761 ^ row * 40503) >>> 0) % width);
	}
	return out;
}

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
		const hubRow = rows[Math.max(0, r - HUB_STRIDE)];
		const hubs = hubPositions(width, Math.max(0, r - HUB_STRIDE));
		const row = [];
		for (let i = 0; i < width; i++) {
			const a = above[(i - 1 + width) % width].read;
			const b = above[i].read;
			const c = above[(i + 1) % width].read;
			const h = Math.sin(i * 12.9898 + r * 78.233) * 43758.5453;
			const frac = h - Math.floor(h);
			const jitter = frac * 0.08;
			const wa = 0.21 + jitter;
			const wb = 0.5;
			const wc = 0.25 - jitter;
			const hub = hubRow[hubs[(Math.floor(i / 24) + r) % hubs.length]].read;
			const bias = i * 0.021 + r * 0.047;
			const index = r * width + i;
			row.push(computed(() => {
				readEpoch();
				recomputed.push(index);
				const local = a() * wa + b() * wb + c() * wc;
				const hv = hub();
				let v = local * 0.87 + hv * 0.1 + 0.028 * Math.sin(local * 9 + hv * 6 + bias);
				v = v < 0 ? 0 : v > 1 ? 1 : v;
				return readQuantize() ? Math.round(v * 64) / 64 : v;
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
		nodes: width * depth + 2,
		edges: width * (depth - 1) * 6 + 2, // 3 parents + hub + quantize + epoch
		buildMs,
	};
}
