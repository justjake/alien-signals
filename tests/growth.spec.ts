import { expect, test } from 'vitest';
import { createReactiveSystem } from '../src/system';

// Arena growth (grow-by-migration): when the bump pointer passes 3/4 of
// capacity, the factory builds a new engine over an arena twice the size at
// the next operation boundary, copies the live prefix (ids are arena-relative
// offsets, so every id survives), and retires the old engine. Retired-engine
// entry points forward to the current engine, so handles minted before a
// growth keep working. These tests pin that contract.

test('handles minted before growth keep working after it', () => {
	const sys = createReactiveSystem({ initialRecords: 64 });
	const s = sys.makeSignal(1);
	const c = sys.makeComputed(() => (s() as number) * 10);
	let seen = 0;
	let runs = 0;
	sys.makeEffect(() => {
		seen = c() as number;
		runs++;
	});
	const before = sys.buffer().length;

	// Push the arena through multiple growths with top-level mints.
	const extras: Array<() => unknown> = [];
	for (let i = 0; i < 500; i++) {
		extras.push(sys.makeSignal(i));
	}
	expect(sys.buffer().length).toBeGreaterThan(before);

	// The pre-growth signal handle (write path), computed handle (read path),
	// and effect subscription (propagation) all still work.
	expect(c()).toBe(10);
	(s as (v: number) => void)(5);
	expect(seen).toBe(50);
	expect(runs).toBe(2);
	// Pre-growth mints kept their values.
	expect(extras[0]()).toBe(0);
	expect(extras[499]()).toBe(499);
});

test('growth preserves the dependency graph mid-batch', () => {
	const sys = createReactiveSystem({ initialRecords: 64 });
	const s = sys.makeSignal(0);
	let seen = -1;
	sys.makeEffect(() => {
		seen = s() as number;
	});
	sys.startBatch();
	(s as (v: number) => void)(7);
	// Mint enough at top level (inside the batch, outside any effect) to
	// trigger growth while the write is still queued.
	for (let i = 0; i < 300; i++) {
		sys.makeSignal(i);
	}
	expect(seen).toBe(0); // batch still open
	sys.endBatch();
	expect(seen).toBe(7); // queued effect ran on the grown arena
});

test('disposers minted before growth dispose the right record after it', () => {
	const sys = createReactiveSystem({ initialRecords: 64 });
	const s = sys.makeSignal(0);
	let runs = 0;
	const stop = sys.makeEffect(() => {
		s();
		runs++;
	});
	for (let i = 0; i < 300; i++) {
		sys.makeSignal(i);
	}
	stop();
	(s as (v: number) => void)(1);
	expect(runs).toBe(1); // disposed effect never re-ran
});

test('unobserved-value semantics survive growth (staged writes)', () => {
	const sys = createReactiveSystem({ initialRecords: 64 });
	const s = sys.makeSignal(1);
	(s as (v: number) => void)(2); // staged, no subscribers
	for (let i = 0; i < 300; i++) {
		sys.makeSignal(i);
	}
	expect(s()).toBe(2);
});

test('exhaustion inside one operation still throws an actionable error', () => {
	const sys = createReactiveSystem({ initialRecords: 32 });
	// Inside an effect body enterDepth > 0, so growth cannot run; a mint
	// burst that blows through the remaining headroom must fail loudly.
	expect(() => {
		sys.makeEffect(() => {
			for (let i = 0; i < 100; i++) {
				sys.makeSignal(i);
			}
		});
	}).toThrowError(/exhausted inside one operation.*configure/);
});

test('reset() after growth keeps the grown capacity and works', () => {
	const sys = createReactiveSystem({ initialRecords: 64 });
	for (let i = 0; i < 500; i++) {
		sys.makeSignal(i);
	}
	const grown = sys.buffer().length;
	expect(grown).toBeGreaterThan(64 * 8);
	sys.reset();
	expect(sys.buffer().length).toBe(grown);
	const s = sys.makeSignal(1);
	let seen = 0;
	sys.makeEffect(() => {
		seen = s() as number;
	});
	(s as (v: number) => void)(3);
	expect(seen).toBe(3);
});

test('system.e and id-level operations track the current engine', () => {
	const sys = createReactiveSystem({ initialRecords: 64 });
	const id = sys.signal(5);
	const cid = sys.computed(() => (sys.signalRead(id) as number) + 1);
	const eBefore = sys.e;
	for (let i = 0; i < 500; i++) {
		sys.signal(i);
	}
	expect(sys.e).not.toBe(eBefore); // engine was rebuilt
	// Ids minted on the old engine resolve on the new one.
	expect(sys.signalRead(id)).toBe(5);
	expect(sys.computedRead(cid)).toBe(6);
	// The retired engine object still works, one hop behind.
	expect(eBefore.read(id)).toBe(5);
	eBefore.write(id, 9);
	expect(sys.signalRead(id)).toBe(9);
});
