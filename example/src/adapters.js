// One interface over four signal libraries, for the field demo and the
// benchmark runner: signal(v) and computed(fn) return cells exposing
// read() (and write(v) for signals). The wrapper closure is identical for
// every library, so comparisons measure the engines, not the adapters.
import * as dalien from 'dalien-signals';
import * as alien from 'alien-signals';
import { signal as preactSignal, computed as preactComputed } from '@preact/signals-core';
import { reactive } from '@reactively/core';

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
	},
};
