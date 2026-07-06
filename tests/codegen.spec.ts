import { expect, test } from 'vitest';
import { codegenAvailable, createReactiveSystem } from '../src/system';

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
	const first = createReactiveSystem({ initialRecords: 4096 });
	first.makeSignal(0); // materialize: consumes the static-literal slot

	// Everything below runs on a compiled clone.
	const events: string[] = [];
	const notified: Array<[number, number]> = [];
	const sys = createReactiveSystem({
		initialRecords: 4096,
		start: (id, js) => {
			events.push(`start:${js}`);
			return js;
		},
		stop: (id, js) => {
			events.push(`stop:${js}`);
		},
	});
	const s = sys.makeSignal(2);
	const c = sys.makeComputed(() => (s() as number) * 3);
	let seen = 0;
	let runs = 0;
	const stop = sys.makeEffect(() => {
		seen = c() as number;
		runs++;
	});
	expect(seen).toBe(6);
	expect(events[0]).toBe('start:2'); // the signal started (js = current value)
	expect(events.length).toBe(2); // ...and the computed (js = its getter)

	(s as (v: number) => void)(5);
	expect(seen).toBe(15);
	expect(runs).toBe(2);

	sys.startBatch();
	(s as (v: number) => void)(6);
	(s as (v: number) => void)(7);
	expect(runs).toBe(2);
	sys.endBatch();
	expect(seen).toBe(21);
	expect(runs).toBe(3);

	// id-level kit ops on the clone
	const sid = sys.signal(1);
	const cid = sys.computed(() => (sys.signalRead(sid) as number) + 1);
	expect(sys.computedRead(cid)).toBe(2);
	sys.signalWrite(sid, 9);
	expect(sys.computedRead(cid)).toBe(10);

	stop();
	expect(events.some((e) => e.startsWith('stop:'))).toBe(true);

	// reset on a clone
	sys.reset();
	const s2 = sys.makeSignal(1);
	let seen2 = 0;
	sys.makeEffect(() => {
		seen2 = s2() as number;
	});
	(s2 as (v: number) => void)(4);
	expect(seen2).toBe(4);
});

test('growth produces cloned generations; two growths chain clones', () => {
	const sys = createReactiveSystem({ initialRecords: 64 });
	const s = sys.makeSignal(1);
	const c = sys.makeComputed(() => (s() as number) + 100);
	let seen = 0;
	sys.makeEffect(() => {
		seen = c() as number;
	});
	const capacities = [sys.stats().capacityRecords];
	// Force at least two growths.
	for (let i = 0; i < 2000; i++) {
		sys.makeSignal(i);
	}
	capacities.push(sys.stats().capacityRecords);
	expect(capacities[1]).toBeGreaterThanOrEqual(capacities[0] * 4);
	// Pre-growth handles still work across two cloned generations.
	(s as (v: number) => void)(42);
	expect(seen).toBe(142);
	expect(c()).toBe(142);
});

test('handle brands survive cloned generations', async () => {
	const sys = createReactiveSystem({ initialRecords: 4096 });
	const { isSignal, isComputed } = await import('../src');
	const s = sys.makeSignal(0);
	const c = sys.makeComputed(() => 1);
	// Clone literals have identical source text, so brand checks by source
	// sampling keep working across generations.
	expect(isSignal(s as () => void)).toBe(true);
	expect(isComputed(c as () => void)).toBe(true);
});

test('the BUILT artifact supports engine cloning (const enums inlined)', async () => {
	// The src-transform path may legitimately fall back (some transforms keep
	// runtime enum references); the published build must not. Import the
	// build output the same way bytecode.spec depends on it existing.
	const built = await import(new URL('../esm/system.mjs', import.meta.url).href) as typeof import('../src/system');
	expect(built.codegenSupported()).toBe(true);
});
