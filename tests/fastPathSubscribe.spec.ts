import { expect, test } from 'vitest';
import { computedFn as computed, effectFn as effect, signalFn as signal } from './helpers/closures';

// Regression: a computed evaluated by an UNTRACKED read is stamped by the
// quiet-epoch fast path; if the first subscription then arrives through
// that fast path (nothing written in between), the engine must still
// borrow the getter as an evaluator — otherwise the node is subscribed
// with no installed evaluator and propagation walks silently cut off at
// it. Found by benchs/crossover.mjs (progressively evaluated chains).

test('untracked read, then subscribe via another computed, then write', () => {
	const src = signal(1);
	const c1 = computed(() => src() + 1);
	expect(c1()).toBe(2); // untracked evaluation: stamps c1
	const c2 = computed(() => c1() + 1);
	let seen = 0;
	let runs = 0;
	effect(() => {
		seen = c2();
		runs++;
	});
	expect(seen).toBe(3);
	src(5);
	expect(runs).toBe(2);
	expect(seen).toBe(7);
});

test('untracked read, then subscribe directly from an effect, then write', () => {
	const src = signal(1);
	const c1 = computed(() => src() * 10);
	expect(c1()).toBe(10);
	let seen = 0;
	effect(() => {
		seen = c1();
	});
	src(3);
	expect(seen).toBe(30);
});

test('progressively evaluated deep chain propagates end to end', () => {
	const src = signal(1);
	let last: () => number = src as unknown as () => number;
	for (let j = 0; j < 1200; j++) {
		const prev = last;
		last = computed(() => prev() + 1);
		if (j % 100 === 99) {
			last(); // periodic untracked evaluation while building
		}
	}
	let seen = 0;
	effect(() => {
		seen = last();
	});
	expect(seen).toBe(1201);
	src(9);
	expect(seen).toBe(1209);
});
