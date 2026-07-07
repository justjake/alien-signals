// Field palette, DOM-free and shared by main.js and smoke.mjs.
//
// Two hue families make the alternating band structure legible: deep
// bands paint navy -> blue -> cyan, wide bands paint violet -> magenta ->
// amber. Both ramps keep brightness monotonic in the cell value and land
// near the same luminance at equal values, so the physics reads the same
// in either family and a band seam is a change of hue, not of brightness.
// Near a seam the two families crossfade over a few rows, so the boundary
// reads as intended structure rather than a rendering glitch.
import { BAND } from './graph.js';

// Narrow: wide bands keep their brightest rows (the source row) against
// a seam, and a wide crossfade would mute exactly that edge.
const SEAM_BLEND = 3; // rows of hue crossfade on each side of a band seam

// mix[row]: 0 = deep family, 1 = wide family, fractional near seams.
// Band parity fixes the family (even = deep, matching buildGraph).
export function makeRowMix(height) {
	const mix = new Float32Array(height);
	for (let r = 0; r < height; r++) {
		const own = Math.floor(r / BAND) % 2;
		mix[r] = own;
		// signed distance from the row centre to the nearest interior seam
		const u = r + 0.5;
		const seam = Math.round(u / BAND) * BAND;
		if (seam === 0 || seam >= height) continue;
		const d = u - seam;
		if (Math.abs(d) >= SEAM_BLEND) continue;
		const s = (d + SEAM_BLEND) / (2 * SEAM_BLEND); // 0 above the seam -> 1 below it
		const below = Math.floor(seam / BAND) % 2; // family on the seam's lower side
		mix[r] = (1 - below) * (1 - s) + below * s;
	}
	return mix;
}

// Both ramps live in lookup tables built once at module load: the paint
// path runs for every recomputed pixel every frame — hundreds of
// thousands per second — so it should be table reads, not Math.pow.
const STEPS = 512;
const SCALE = STEPS - 1;
const deepLUT = new Float32Array(STEPS * 3);
const wideLUT = new Float32Array(STEPS * 3);
for (let q = 0; q < STEPS; q++) {
	const v = q / SCALE;
	deepLUT[q * 3] = 8 + 112 * v * v * v;
	deepLUT[q * 3 + 1] = 12 + 223 * v ** 1.5;
	deepLUT[q * 3 + 2] = 40 + 215 * v ** 0.9;
	wideLUT[q * 3] = 24 + 231 * v ** 0.8;
	wideLUT[q * 3 + 1] = 6 + 199 * v ** 1.8;
	wideLUT[q * 3 + 2] = 36 + 380 * v * (1 - v) + 40 * v;
}

// Glow is drawn over the base color, never accumulated into it, so a
// fading highlight lands back on the exact base. The highlight is a warm
// white, visible against both families.
export function paintPixel(data, i, v0, glow, mix) {
	const q = (v0 <= 0 ? 0 : v0 >= 1 ? SCALE : (v0 * SCALE) | 0) * 3;
	let r, g, b;
	if (mix <= 0) {
		r = deepLUT[q];
		g = deepLUT[q + 1];
		b = deepLUT[q + 2];
	} else if (mix >= 1) {
		r = wideLUT[q];
		g = wideLUT[q + 1];
		b = wideLUT[q + 2];
	} else {
		// seam rows: crossfade the two families
		r = deepLUT[q] + (wideLUT[q] - deepLUT[q]) * mix;
		g = deepLUT[q + 1] + (wideLUT[q + 1] - deepLUT[q + 1]) * mix;
		b = deepLUT[q + 2] + (wideLUT[q + 2] - deepLUT[q + 2]) * mix;
	}
	// subtle weights: at the adaptive write rates a tenth of the field
	// glows at once, and a strong flash would gray the whole palette
	const p = i * 4;
	data[p] = r + glow * 55;
	data[p + 1] = g + glow * 48;
	data[p + 2] = b + glow * 40;
	data[p + 3] = 255;
}
