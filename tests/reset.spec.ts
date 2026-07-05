import { expect, test } from 'vitest';
import { createReactiveSystem } from '../src/system.js';

function drainFinalizers(): Promise<void> {
	return new Promise((resolve) => {
		// One GC plus two macrotask turns lets FinalizationRegistry cleanups
		// enqueue and run.
		gc!();
		setTimeout(() => {
			gc!();
			setTimeout(() => resolve(), 0);
		}, 0);
	});
}

test('reset() rewinds the arena and the system keeps working', () => {
	const sys = createReactiveSystem({ initialRecords: 1 << 16 });
	const s = sys.makeSignal(1) as { (): number; (v: number): void };
	const c = sys.makeComputed(() => s() + 1) as () => number;
	let seen = 0;
	sys.makeEffect(() => {
		seen = c();
	});
	s(41);
	expect(seen).toBe(42);

	sys.reset();

	const s2 = sys.makeSignal(10) as { (): number; (v: number): void };
	const c2 = sys.makeComputed(() => s2() * 2) as () => number;
	let seen2 = 0;
	sys.makeEffect(() => {
		seen2 = c2();
	});
	expect(seen2).toBe(20);
	s2(11);
	expect(seen2).toBe(22);
});

test('reset() restores capacity consumed by a dead generation', () => {
	const sys = createReactiveSystem({ initialRecords: 1 << 12 });
	// Burn most of the plane across generations; without reset this throws.
	for (let generation = 0; generation < 20; generation++) {
		for (let i = 0; i < 1000; i++) {
			sys.makeSignal(i);
		}
		sys.reset();
	}
});

test('reset() during an active operation throws', () => {
	const sys = createReactiveSystem({ initialRecords: 1 << 16 });
	let error: Error | undefined;
	sys.makeEffect(() => {
		try {
			sys.reset();
		} catch (e) {
			error = e as Error;
		}
	});
	expect(error?.message).toMatch(/active operation/);
});

test('pre-reset finalizations cannot reclaim post-reset records', async () => {
	const sys = createReactiveSystem({ initialRecords: 1 << 16 });
	// Mint a batch of handles and drop them so their registry cells are
	// pending, then reset before the cleanups run.
	(() => {
		for (let i = 0; i < 1000; i++) {
			const s = sys.makeSignal(i) as () => number;
			const c = sys.makeComputed(() => s() + 1) as () => number;
			c();
		}
	})();
	sys.reset();
	// New generation occupying the same record ids as the dropped handles.
	const s2 = sys.makeSignal(7) as { (): number; (v: number): void };
	const c2 = sys.makeComputed(() => s2() + 1) as () => number;
	let seen = 0;
	sys.makeEffect(() => {
		seen = c2();
	});
	// Let the old generation's finalizers fire; the disarmed registry must
	// not touch the new generation's records.
	await drainFinalizers();
	s2(100);
	expect(seen).toBe(101);
	expect(c2()).toBe(101);
});
