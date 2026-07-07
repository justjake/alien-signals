// The computation field, DOM-free so it can be smoke-run under Node.
//
// Cells are integer ids from the runtime's id tier: one node per pixel
// with no per-cell wrapper objects; parameters live in shared typed
// arrays so each cell's closure captures a single offset.
//
// The field is built in BANDS of 64 rows that alternate between two
// shapes, chosen to stress opposite ends of a reactivity system:
//
// - DEEP bands (even indexes, flowing downward). Every cell reads exactly
//   one parent in the previous row, shifted by a per-row shear so the
//   columns bend. The shear is a whole-row rotation, so the parent map is
//   a bijection: one source write propagates through exactly one cell per
//   row, 64 levels deep — long serial re-validation chains in thin
//   columns.
// - WIDE bands (odd indexes, flowing upward). The source row keeps one
//   signal per pixel, but every ~32nd one is a HUB, and every other cell
//   in the band reads its two nearest hubs (blended by column position,
//   faded by distance from the source row). Each hub therefore carries
//   thousands of subscribers, and one hub write triggers a broad, shallow
//   invalidation wave — one-to-many fan-out.
//
// Adjacent bands flow toward opposite seams: a deep band's faded tail
// meets a wide band's faded tail, and a wide band's source row meets the
// next deep band's source row, so seams join rows of matching energy.
//
// `quantize` rounds outputs to a coarse step (the equality cutoff prunes
// fading cascades); `epoch` is read by every cell, so bumping it
// invalidates the whole graph in one write.

export const BAND = 64;
export const HUB_SPACING = 32; // wide-band hub pitch in columns

// Hubs are spaced evenly with one at each edge, so every column sits
// between two distinct hubs and every cell holds exactly two hub links.
export const hubCount = (width) => Math.max(2, Math.round(width / HUB_SPACING) + 1);

export function buildGraph(width, depth, rt) {
	const quantize = rt.signal(true);
	const epoch = rt.signal(0);
	const get = rt.get;
	// recomputes counted per band family: the wave driver sizes its write
	// budget from each family's measured invalidation cone
	const stats = { recomputes: 0, deepRecomputes: 0, wideRecomputes: 0 };

	const t0 = performance.now();
	const count = width * depth;
	const ids = new Int32Array(count);
	// per-cell parameters: parent ids and blend weights
	const pa = new Int32Array(count);
	const pb = new Int32Array(count);
	const fw = new Float32Array(count * 3);

	// fw = [decay, unused, ripple bias]: v carries the parent forward with
	// a slight loss, so a strong write survives the full 64-level chain
	// and a weak one fades into the equality cutoff on the way down.
	const makeDeepCell = (o) => () => {
		get(epoch);
		stats.recomputes++;
		stats.deepRecomputes++;
		let v = get(pa[o]) * fw[o * 3];
		v += 0.03 * Math.sin(v * 11 + fw[o * 3 + 2]);
		v = v < 0 ? 0 : v > 1 ? 1 : v;
		return get(quantize) ? Math.round(v * 72) / 72 : v;
	};

	// fw = [hub blend t, source-distance fade, ripple bias]: the cell is a
	// position-weighted blend of its two hubs, so a hub write recomputes
	// every subscriber at once but each lands on its own value.
	const makeWideCell = (o) => () => {
		get(epoch);
		stats.recomputes++;
		stats.wideRecomputes++;
		const t = fw[o * 3];
		let v = (get(pa[o]) * (1 - t) + get(pb[o]) * t) * fw[o * 3 + 1];
		v += 0.03 * Math.sin(v * 9 + fw[o * 3 + 2]);
		v = v < 0 ? 0 : v > 1 ? 1 : v;
		return get(quantize) ? Math.round(v * 72) / 72 : v;
	};

	// links counted as cells are created, so `edges` is exact by
	// construction: deep cells hold 3 (epoch, parent, quantize), wide
	// cells hold 4 (epoch, two hubs, quantize)
	let edges = 0;
	const rippleBias = (i, r) => i * 0.021 + r * 0.047;

	const bandSources = []; // [{ row, kind, cells: Int32Array of writable ids }]
	const bandCount = Math.ceil(depth / BAND);
	for (let band = 0; band < bandCount; band++) {
		const top = band * BAND;
		const bottom = Math.min(depth - 1, top + BAND - 1);
		const kind = band % 2 === 0 ? 'deep' : 'wide';
		const goingDown = kind === 'deep';
		const sourceRow = goingDown ? top : bottom;
		const cells = new Int32Array(width);
		const source = { row: sourceRow, kind, cells, hubs: null };
		bandSources.push(source);

		if (kind === 'deep') {
			for (let i = 0; i < width; i++) {
				cells[i] = ids[sourceRow * width + i] = rt.signal(0);
			}
			for (let step = 1; step <= bottom - top; step++) {
				const r = top + step;
				const upRow = (r - 1) * width;
				// whole-row shear: every cell in this row reads the parent
				// `shift` columns over, so the row-to-row map is a rotation
				// (a bijection) and no chain ever merges or dies short
				const shift = Math.round(
					2.6 * Math.sin(r * 0.11 + band * 1.7)
					+ 1.7 * Math.sin(r * 0.041 + 2.3),
				);
				for (let i = 0; i < width; i++) {
					const o = r * width + i;
					pa[o] = ids[upRow + (i + shift + 8 * width) % width];
					const h = Math.sin(i * 12.9898 + r * 78.233) * 43758.5453;
					fw[o * 3] = 0.978 + (h - Math.floor(h)) * 0.014;
					fw[o * 3 + 2] = rippleBias(i, r);
					ids[o] = rt.computed(makeDeepCell(o));
					edges += 3;
				}
			}
		} else {
			const hubs = hubCount(width);
			const hubIds = new Int32Array(hubs);
			const isHub = new Uint8Array(width);
			const hubX = (k) => Math.round((k * (width - 1)) / (hubs - 1));
			// Hub signals first: every other cell in the band, including
			// the source row's non-hub pixels, is a computed over them.
			const sourceBase = sourceRow * width;
			for (let k = 0; k < hubs; k++) {
				isHub[hubX(k)] = 1;
				hubIds[k] = ids[sourceBase + hubX(k)] = rt.signal(0);
			}
			source.hubs = hubIds; // the wave driver addresses hub groups directly
			// The writable surface maps every column to its nearest hub, so
			// emitters and pointer strokes can address the band by x like a
			// deep band; a write anywhere lands on a hub.
			for (let i = 0; i < width; i++) {
				cells[i] = hubIds[Math.round((i * (hubs - 1)) / (width - 1))];
			}
			for (let r = top; r <= bottom; r++) {
				const dist = Math.abs(r - sourceRow);
				// strong fade: the curtain dissolves before the far seam, so
				// a wide band meets its neighbor at matching darkness
				const fall = 1 - (dist / BAND) * 0.8;
				for (let i = 0; i < width; i++) {
					if (r === sourceRow && isHub[i]) continue; // hub signal already placed
					const o = r * width + i;
					const f = (i * (hubs - 1)) / (width - 1);
					const k = Math.min(hubs - 2, Math.floor(f));
					pa[o] = hubIds[k];
					pb[o] = hubIds[k + 1];
					fw[o * 3] = f - k;
					fw[o * 3 + 1] = fall;
					fw[o * 3 + 2] = rippleBias(i, r);
					ids[o] = rt.computed(makeWideCell(o));
					edges += 4;
				}
			}
		}
	}
	const buildMs = performance.now() - t0;

	return {
		width,
		depth,
		ids,
		bandSources,
		deepBands: bandSources.filter((b) => b.kind === 'deep'),
		wideBands: bandSources.filter((b) => b.kind === 'wide'),
		quantize,
		epoch,
		stats,
		nodes: count + 2,
		edges,
		buildMs,
	};
}

// ---- adaptive wave driver ----------------------------------------------------
//
// The wave mode's writes, one driver per built graph, shared with the
// Node smoke so both environments drive the field identically. Each
// frame the driver spends a recompute budget of ~10% of the graph, split
// evenly between the two band families, so the load scales with the
// graph instead of shrinking to a rounding error at the big sizes. The
// budget is deliberately not capped by frame time: this is a stress
// test, and at the big sizes a 10% frame costs more than 60fps allows —
// the frame-time stats report that cost instead of hiding it.
//
// Write counts come from damped estimates of each family's invalidation
// cone (recomputes per write — the equality cutoff shrinks it as ripples
// repeat), moving a fixed fraction of the way to each new sample, so the
// counts drift smoothly instead of oscillating.
export const TARGET_SHARE = 0.1;
const DAMP = 0.2;

const EMITTERS = [
	{ speed: 0.021, span: 0.9, gain: 1.0 },
	{ speed: -0.033, span: 0.55, gain: 0.8 },
	{ speed: 0.013, span: 0.75, gain: 0.65 },
];

export function makeWaveDriver(graph) {
	const w = graph.width;
	const stats = graph.stats;
	const deepBands = graph.deepBands;
	const wideBands = graph.wideBands;
	const hubsPerBand = wideBands[0].hubs.length;

	// cone estimates, seeded from the band geometry and refined by observe()
	let deepCone = BAND - 1; // a full chain, before cutoff truncation
	let wideCone = 2 * HUB_SPACING * (BAND - 1); // one hub's subscribers
	// writes actually issued by the last step(), for observe()
	let deepWrites = 0;
	let wideWrites = 0;
	let phase = 0;
	const budget = TARGET_SHARE * graph.nodes;

	function step(rt) {
		phase += 1;
		// clamps: never idle, never more than the emitters' bands can
		// hold (each emitter owns one band's source row per family)
		const deepGoal = Math.min(EMITTERS.length * w, Math.max(6, Math.round((budget / 2) / deepCone)));
		const wideGoal = Math.min(EMITTERS.length * hubsPerBand, Math.max(3, Math.round((budget / 2) / wideCone)));
		deepWrites = 0;
		wideWrites = 0;
		// exact per-emitter quotas, so issued writes match the goals and
		// the measured cones stay calibrated
		const deepBase = (deepGoal / EMITTERS.length) | 0;
		const deepRem = deepGoal - deepBase * EMITTERS.length;
		const wideBase = (wideGoal / EMITTERS.length) | 0;
		const wideRem = wideGoal - wideBase * EMITTERS.length;
		for (let k = 0; k < EMITTERS.length; k++) {
			const em = EMITTERS[k];
			const centre = Math.round((Math.sin(phase * em.speed) * em.span * 0.5 + 0.5) * w);
			// deep: a contiguous column profile in this emitter's own band —
			// each column is the head of a chain one pixel wide
			const deep = deepBands[(phase + k) % deepBands.length];
			const cols = Math.min(w, deepBase + (k < deepRem ? 1 : 0));
			for (let m = 0; m < cols; m++) {
				const dx = m - (cols >> 1);
				const i = (centre + dx + 8 * w) % w;
				// fine column-scale ripple on top of the sweep profile, so
				// broad write spans still seed distinct chains instead of
				// one flat gradient
				const texture = 0.8 + 0.2 * Math.sin(i * 0.37 + phase * 0.09);
				rt.set(deep.cells[i], em.gain * texture * (1 - Math.abs(dx) / (cols / 2 + 1)));
				deepWrites++;
			}
			// wide: a group of adjacent hubs at the mirrored position. The
			// pulse is slow relative to the sweep, so neighboring hubs land
			// on correlated values (broad gradients, not one tooth per
			// hub), and it swings past zero, so hubs the emitter lingers
			// over breathe dark again (cells clamp at 0) instead of
			// pinning the band lit.
			const wide = wideBands[(phase + k) % wideBands.length];
			const hubs = wide.hubs;
			// mostly lit, with a brief dip past zero each cycle so hubs
			// breathe dark (cells clamp at 0) instead of pinning the band
			const pulse = em.gain * (0.62 + 0.55 * Math.sin(phase * em.speed * 2 + k * 2.1));
			const h0 = Math.round(((w - 1 - centre) * (hubsPerBand - 1)) / (w - 1));
			const group = Math.min(hubsPerBand, wideBase + (k < wideRem ? 1 : 0));
			for (let m = 0; m < group; m++) {
				const dh = m - (group >> 1);
				const hk = (h0 + dh + hubsPerBand) % hubsPerBand;
				// the profile shades the group's edges without zeroing them,
				// so a large group is a lit gradient, not one bright centre
				rt.set(hubs[hk], pulse * (0.55 + 0.45 * (1 - Math.abs(dh) / (group / 2 + 1))));
				wideWrites++;
			}
		}
		if (phase % 90 === 0) {
			rt.set(deepBands[phase % deepBands.length].cells[Math.floor(Math.random() * w)], 1);
			deepWrites++;
		}
	}

	// Called after the batch with the family counters populated; a quiet
	// frame (cutoff swallowed everything) carries no signal, so the
	// estimates only move on real samples.
	function observe() {
		if (deepWrites > 0 && stats.deepRecomputes > 0) {
			deepCone += DAMP * (stats.deepRecomputes / deepWrites - deepCone);
			deepCone = Math.max(2, deepCone);
		}
		if (wideWrites > 0 && stats.wideRecomputes > 0) {
			wideCone += DAMP * (stats.wideRecomputes / wideWrites - wideCone);
			wideCone = Math.max(16, wideCone);
		}
	}

	return { step, observe };
}
