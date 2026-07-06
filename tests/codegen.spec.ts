import { expect, test } from 'vitest';
import { codegenAvailable } from '../src/system';
import { makeMiniLib } from './helpers/miniLib';

// Engine generations after the first are compiled from String(createEngine)
// via new Function (see instantiateEngine): fresh function identities restore
// V8's context specialization that a second instantiation of the static
// literal would otherwise permanently disable. That only works if
// createEngine stays CLOSED — free names beyond parameters and globals throw
// ReferenceError inside a clone. These tests execute cloned engines hard
// enough that any escaped identifier fails loudly.

test('codegen is available under vitest/node', () => {
	expect(codegenAvailable).toBe(true);
});

test('a second system (cloned engine) behaves identically', () => {
	const first = makeMiniLib({ initialRecords: 4096 });
	first.signal(0); // materialize: consumes the static-literal slot

	// Everything below runs on a compiled clone.
	const lib = makeMiniLib({ initialRecords: 4096 });
	const s = lib.signal(2);
	const c2 = lib.computed(() => s() * 3);
	let seen = 0;
	let runs = 0;
	const stop = lib.effect(() => {
		seen = c2();
		runs++;
	});
	expect(seen).toBe(6);
	s(5);
	lib.drain();
	expect(seen).toBe(15);
	expect(runs).toBe(2);
	lib.sys.startBatch();
	s(6);
	s(7);
	lib.sys.endBatch();
	lib.drain();
	expect(seen).toBe(21);
	stop();
	lib.sys.reset();
	const s2 = lib.signal(1);
	let seen2 = 0;
	lib.effect(() => {
		seen2 = s2();
	});
	s2(4);
	lib.drain();
	expect(seen2).toBe(4);
});

test('growth produces cloned generations; two growths chain clones', () => {
	const lib = makeMiniLib({ initialRecords: 64 });
	const s = lib.signal(1);
	const c2 = lib.computed(() => s() + 100);
	let seen = 0;
	lib.effect(() => {
		seen = c2();
	});
	const cap0 = lib.sys.stats().capacityRecords;
	for (let i = 0; i < 2000; i++) {
		lib.signal(i);
	}
	expect(lib.sys.stats().capacityRecords).toBeGreaterThanOrEqual(cap0 * 4);
	s(42);
	lib.drain();
	expect(seen).toBe(142);
	expect(c2()).toBe(142);
});

test('the BUILT artifact supports engine cloning (const enums inlined)', async () => {
	// The src-transform path may legitimately fall back (some transforms keep
	// runtime enum references); the published build must not. Import the
	// build output the same way bytecode.spec depends on it existing.
	const built = await import(new URL('../esm/system.mjs', import.meta.url).href) as typeof import('../src/system');
	expect(built.codegenSupported()).toBe(true);
});
