// The computation field, DOM-free so it can be smoke-run under Node.
//
// Each cell reads three parents from the row above — but not the three
// directly overhead: a smooth warp field bends the upstream direction from
// place to place (domain warping, the workhorse of shader art), so changes
// advect along curved streamlines instead of falling straight down. Each
// cell also reads one hub — a popular cell several rows up — with an
// influence that varies smoothly across the field; hub subscriber counts
// exceed ordinary cells' by an order of magnitude, and writes that reach
// one flash across a whole region. A gentle sine fold gives the surface
// filament structure and costs real arithmetic per recompute; the result
// stays a pure function of the inputs.
//
// `quantize` rounds outputs to a coarse step (equality cutoff visibly
// prunes fading cascades); `epoch` is read by every cell, so bumping it
// invalidates the whole graph in one write.

const HUB_STRIDE = 9; // hubs are read from this many rows up

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
			// the warp field: a slow two-octave drift, ±6 columns
			const drift = Math.round(
				4.2 * Math.sin(i * 0.031 + r * 0.061)
				+ 2.4 * Math.sin(i * 0.011 - r * 0.023 + 1.7),
			);
			const j = i + drift;
			const a = above[(j - 1 + 4 * width) % width].read;
			const b = above[(j + 4 * width) % width].read;
			const c = above[(j + 1 + 4 * width) % width].read;
			const h = Math.sin(i * 12.9898 + r * 78.233) * 43758.5453;
			const jitter = (h - Math.floor(h)) * 0.08;
			const wa = 0.21 + jitter;
			const wb = 0.5;
			const wc = 0.25 - jitter;
			// hub influence varies smoothly, 0.02–0.12, so hub regions blend
			// instead of forming seams
			const hw = 0.07 + 0.05 * Math.sin(i * 0.017 + r * 0.029);
			const hub = hubRow[hubs[Math.floor((i + r * 2) / 37) % hubs.length]].read;
			const bias = i * 0.021 + r * 0.047;
			const index = r * width + i;
			row.push(computed(() => {
				readEpoch();
				recomputed.push(index);
				const local = a() * wa + b() * wb + c() * wc;
				let v = local * (1 - hw) + hub() * hw;
				v += 0.03 * Math.sin(v * 11 + bias);
				v = v < 0 ? 0 : v > 1 ? 1 : v;
				return readQuantize() ? Math.round(v * 72) / 72 : v;
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
