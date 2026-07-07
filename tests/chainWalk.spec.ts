import { expect, test } from 'vitest';
import { computed, effect, signal } from '../src';

// The stackless chain walk (chainCheck in system.ts) resolves runs of
// single-dep single-subscriber pending nodes without the traversal stack.
// These tests pin its semantics: equality cut-off mid-chain, bail-out to the
// general loop on branching shapes, and end-to-end propagation.

test('deep chain propagates end to end through the chain walk', () => {
	const src = signal(1);
	let last: () => number = src as unknown as () => number;
	for (let i = 0; i < 50; i++) {
		const prev = last;
		last = computed(() => prev() + 1);
	}
	let seen = 0;
	let runs = 0;
	effect(() => {
		seen = last();
		runs++;
	});
	expect(seen).toBe(51);
	src(10);
	expect(seen).toBe(60);
	expect(runs).toBe(2);
});

test('equality cut mid-chain stops the wave and clears pending', () => {
	const src = signal(1);
	const a = computed(() => src() + 1);
	const clamp = computed(() => Math.min(a(), 5));
	const b = computed(() => clamp() * 10);
	const c = computed(() => b() + 1);
	let runs = 0;
	let seen = 0;
	effect(() => {
		seen = c();
		runs++;
	});
	expect(seen).toBe(21);
	src(2); // clamp 3 -> changes
	expect(runs).toBe(2);
	expect(seen).toBe(31);
	src(10); // clamp saturates at 5
	expect(runs).toBe(3);
	expect(seen).toBe(51);
	src(20); // clamp still 5: unchanged, effect must NOT rerun
	expect(runs).toBe(3);
	src(3); // back under the clamp: wave resumes (pending was cleared, not stuck)
	expect(runs).toBe(4);
	expect(seen).toBe(41);
});

test('multi-subscriber node mid-chain falls back to the general walk', () => {
	const src = signal(1);
	const shared = computed(() => src() * 2);
	// shared has two subscribers: the chain walk must bail and stay correct.
	const left = computed(() => shared() + 1);
	const right = computed(() => shared() + 2);
	const tailL = computed(() => left() + 1);
	const tailR = computed(() => right() + 1);
	let seenL = 0;
	let seenR = 0;
	effect(() => {
		seenL = tailL();
	});
	effect(() => {
		seenR = tailR();
	});
	src(5);
	expect(seenL).toBe(12);
	expect(seenR).toBe(13);
});

test('branching deps mid-chain fall back to the general walk', () => {
	const s1 = signal(1);
	const s2 = signal(10);
	const join = computed(() => s1() + s2()); // two deps: not a chain
	const tail1 = computed(() => join() + 1);
	const tail2 = computed(() => tail1() + 1);
	let seen = 0;
	effect(() => {
		seen = tail2();
	});
	expect(seen).toBe(13);
	s1(2);
	expect(seen).toBe(14);
	s2(20);
	expect(seen).toBe(24);
});
