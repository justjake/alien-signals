// One interface over four signal libraries, for the field demo and the
// benchmark runner: signal(v) and computed(fn) return cells exposing
// read() (and write(v) for signals). The wrapper closure is identical for
// every library, so comparisons measure the engines, not the adapters.
import * as dalien from 'dalien-signals';
import * as alien from 'alien-signals';
import { signal as preactSignal, computed as preactComputed, effect as preactEffect, batch as preactBatch } from '@preact/signals-core';
import { Reactive, reactive, stabilize } from '@reactively/core';

export const ADAPTERS = {
	'dalien-signals': {
		signal(v) {
			const s = dalien.signal(v);
			return { read: () => s(), write: (x) => s(x) };
		},
		computed(fn) {
			const c = dalien.computed(fn);
			return { read: () => c() };
		},
		effect: (fn) => dalien.effect(fn),
	},
	'alien-signals': {
		signal(v) {
			const s = alien.signal(v);
			return { read: () => s(), write: (x) => s(x) };
		},
		computed(fn) {
			const c = alien.computed(fn);
			return { read: () => c() };
		},
		effect: (fn) => alien.effect(fn),
	},
	'@preact/signals-core': {
		signal(v) {
			const s = preactSignal(v);
			return { read: () => s.value, write: (x) => { s.value = x; } };
		},
		computed(fn) {
			const c = preactComputed(fn);
			return { read: () => c.value };
		},
		effect: (fn) => preactEffect(fn),
	},
	'@reactively/core': {
		signal(v) {
			const s = reactive(v);
			return { read: () => s.value, write: (x) => { s.value = x; } };
		},
		computed(fn) {
			const c = reactive(fn);
			return { read: () => c.value };
		},
		// reactively's effects run when stabilize() is called
		effect: (fn) => new Reactive(fn, true),
		flush: () => stabilize(),
	},
};

// Field runtime: an id-based tier for the pixel graph. The field allocates
// one node per pixel, so per-cell wrapper closures and GC registration
// dominate build time and memory at scale. dalien-signals exposes integer
// ids natively (signalId/computedId/get/set/dispose); the other libraries
// are shimmed with an index into a cell array. Rebuilding a view calls
// dispose(), which frees every id — dropped nodes are reclaimed, never
// leaked.
export function makeRuntime(lib) {
	if (lib === 'dalien-signals') {
		const ids = [];
		return {
			signal(v) {
				const id = dalien.signalId(v);
				ids.push(id);
				return id;
			},
			computed(fn) {
				const id = dalien.computedId(fn);
				ids.push(id);
				return id;
			},
			effect(fn) {
				ids.push(dalien.effectId(fn));
			},
			get: dalien.get,
			set: dalien.set,
			batch(fn) {
				dalien.startBatch();
				fn();
				dalien.endBatch();
			},
			dispose() {
				for (const id of ids) dalien.dispose(id);
				ids.length = 0;
			},
		};
	}
	if (lib === 'alien-signals') {
		const cells = [];
		const stops = [];
		return {
			signal: (v) => cells.push(alien.signal(v)) - 1,
			computed: (fn) => cells.push(alien.computed(fn)) - 1,
			effect(fn) {
				stops.push(alien.effect(fn));
			},
			get: (id) => cells[id](),
			set: (id, v) => cells[id](v),
			batch(fn) {
				alien.startBatch();
				fn();
				alien.endBatch();
			},
			dispose() {
				for (const stop of stops) stop();
				stops.length = 0;
				cells.length = 0;
			},
		};
	}
	if (lib === '@preact/signals-core') {
		const cells = [];
		const stops = [];
		return {
			signal: (v) => cells.push(preactSignal(v)) - 1,
			computed: (fn) => cells.push(preactComputed(fn)) - 1,
			effect(fn) {
				stops.push(preactEffect(fn));
			},
			get: (id) => cells[id].value,
			set: (id, v) => {
				cells[id].value = v;
			},
			batch: preactBatch,
			dispose() {
				for (const stop of stops) stop();
				stops.length = 0;
				cells.length = 0;
			},
		};
	}
	if (lib === '@reactively/core') {
		const cells = [];
		let effects = [];
		return {
			signal: (v) => cells.push(reactive(v)) - 1,
			computed: (fn) => cells.push(reactive(fn)) - 1,
			effect(fn) {
				effects.push(new Reactive(fn, true));
			},
			get: (id) => cells[id].value,
			set: (id, v) => {
				cells[id].value = v;
			},
			// reactively defers effects until stabilize()
			batch(fn) {
				fn();
				stabilize();
			},
			dispose() {
				effects = [];
				cells.length = 0;
			},
		};
	}
	throw new Error(`unknown library: ${lib}`);
}
