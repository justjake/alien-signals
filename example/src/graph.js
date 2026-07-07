// The computation field, DOM-free so it can be smoke-run under Node.
//
// Cells are integer ids from the runtime's id tier: one node per pixel
// with no per-cell wrapper objects; parameters live in shared typed
// arrays so each cell's closure captures a single offset.
//
// The field is built in BANDS of 64 rows. Each band starts from its own
// row of writable signals and flows independently — even bands downward,
// odd bands upward — so a write's invalidation cone is confined to its
// band and frame cost tracks the writes issued, not the pixel count.
// Within a band each cell reads three parents bent sideways by a smooth
// warp (domain warping: changes advect along curved streamlines) plus a
// hub — a nearby cell that a 32-column group also reads, with smoothly
// varying influence. Hubs are local on purpose: a hub placed anywhere in
// the row would spread every write across the full width within a few
// rows, and the cone would stop being proportional to the change.
//
// `quantize` rounds outputs to a coarse step (the equality cutoff prunes
// fading cascades); `epoch` is read by every cell, so bumping it
// invalidates the whole graph in one write.

export const BAND = 64;
const HUB_ROWS = 9;

export function buildGraph(width, depth, rt) {
	const quantize = rt.signal(true);
	const epoch = rt.signal(0);
	const get = rt.get;
	const stats = { recomputes: 0 };

	const t0 = performance.now();
	const count = width * depth;
	const ids = new Int32Array(count);
	// per-cell parameters: parent/hub ids and blend weights
	const pa = new Int32Array(count);
	const pb = new Int32Array(count);
	const pc = new Int32Array(count);
	const ph = new Int32Array(count);
	const fw = new Float32Array(count * 4); // wa, wc, hw, bias

	const makeCell = (o) => () => {
		get(epoch);
		stats.recomputes++;
		const wa = fw[o * 4];
		const wc = fw[o * 4 + 1];
		const hw = fw[o * 4 + 2];
		const local = get(pa[o]) * wa + get(pb[o]) * (0.96 - wa - wc) + get(pc[o]) * wc;
		let v = local * (1 - hw) + get(ph[o]) * hw;
		v += 0.03 * Math.sin(v * 11 + fw[o * 4 + 3]);
		v = v < 0 ? 0 : v > 1 ? 1 : v;
		return get(quantize) ? Math.round(v * 72) / 72 : v;
	};

	const bandSources = []; // [{ row, cells: Int32Array of signal ids }]
	const bandCount = Math.ceil(depth / BAND);
	for (let band = 0; band < bandCount; band++) {
		const top = band * BAND;
		const bottom = Math.min(depth - 1, top + BAND - 1);
		const goingDown = band % 2 === 0;
		const sourceRow = goingDown ? top : bottom;
		const cells = new Int32Array(width);
		for (let i = 0; i < width; i++) {
			cells[i] = ids[sourceRow * width + i] = rt.signal(0);
		}
		bandSources.push({ row: sourceRow, cells });

		for (let step = 1; step <= bottom - top; step++) {
			const r = goingDown ? top + step : bottom - step;
			const upRow = (goingDown ? r - 1 : r + 1) * width;
			const hubRow = (goingDown
				? Math.max(top, r - HUB_ROWS)
				: Math.min(bottom, r + HUB_ROWS)) * width;
			for (let i = 0; i < width; i++) {
				const o = r * width + i;
				const drift = Math.round(
					4.2 * Math.sin(i * 0.031 + r * 0.061)
					+ 2.4 * Math.sin(i * 0.011 - r * 0.023 + 1.7),
				);
				const j = i + drift + 8 * width;
				pa[o] = ids[upRow + (j - 1) % width];
				pb[o] = ids[upRow + j % width];
				pc[o] = ids[upRow + (j + 1) % width];
				// 32-column groups share a hub within ±54 columns
				const hcol = ((i & ~31) + 16 + Math.round(38 * Math.sin((i >> 5) * 1.9 + r * 0.13)) + width) % width;
				ph[o] = ids[hubRow + hcol];
				const h = Math.sin(i * 12.9898 + r * 78.233) * 43758.5453;
				const jitter = (h - Math.floor(h)) * 0.08;
				fw[o * 4] = 0.21 + jitter;
				fw[o * 4 + 1] = 0.25 - jitter;
				fw[o * 4 + 2] = 0.07 + 0.05 * Math.sin(i * 0.017 + r * 0.029);
				fw[o * 4 + 3] = i * 0.021 + r * 0.047;
				ids[o] = rt.computed(makeCell(o));
			}
		}
	}
	const buildMs = performance.now() - t0;

	return {
		width,
		depth,
		ids,
		bandSources,
		quantize,
		epoch,
		stats,
		nodes: count + 2,
		edges: count * 6 - width * bandCount * 6,
		buildMs,
	};
}
