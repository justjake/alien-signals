import { expect, test } from 'vitest';
import { makeMiniLib } from './helpers/miniLib';

test('reset() rewinds the arena and the system keeps working', () => {
	const lib = makeMiniLib({ initialCapacity: 4096 });
	const s = lib.signal(1);
	let seen = 0;
	lib.effect(() => {
		seen = s();
	});
	s(5);
	expect(seen).toBe(5);
	const used = lib.sys.stats().allocatedRecords;
	expect(used).toBeGreaterThan(0);
	lib.sys.reset();
	expect(lib.sys.stats().allocatedRecords).toBe(0);
	const s2 = lib.signal(10);
	let seen2 = 0;
	lib.effect(() => {
		seen2 = s2();
	});
	s2(11);
	expect(seen2).toBe(11);
});

test('reset() restores capacity consumed by a dead generation', () => {
	const lib = makeMiniLib({ initialCapacity: 256 });
	for (let i = 0; i < 100; i++) {
		lib.signal(i);
	}
	const before = lib.sys.stats().allocatedRecords;
	lib.sys.reset();
	expect(lib.sys.stats().allocatedRecords).toBeLessThan(before);
});

test('reset() during an active operation throws', () => {
	const lib = makeMiniLib({ initialCapacity: 4096 });
	const s = lib.signal(0);
	let threw: Error | undefined;
	lib.effect(() => {
		s();
		try {
			lib.sys.reset();
		} catch (error) {
			threw = error as Error;
		}
	});
	expect(threw?.message).toMatch(/active operation/);
});

test('pre-reset finalizations cannot reclaim post-reset records', async () => {
	const lib = makeMiniLib({ initialCapacity: 4096 });
	// Owner-registered node whose owner dies before reset: the stale
	// finalizer must self-disarm after reset replaces the registry.
	(() => {
		const owner = { alive: true };
		lib.sys.createReactiveNode(owner, 1 << 16);
	})();
	lib.sys.reset();
	const survivor = lib.signal(42);
	if (globalThis.gc !== undefined) {
		globalThis.gc();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(survivor()).toBe(42);
});
