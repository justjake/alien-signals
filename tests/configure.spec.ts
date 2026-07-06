import { expect, test } from 'vitest';
import { computed, configure, effect, signal } from '../src';
import { createReactiveSystem } from '../src/system';

// NOTE: this file relies on vitest's per-file module isolation — the default
// system configured here is not the one other spec files see.

test('configure sizes the default system before first use', () => {
	configure({ initialRecords: 4096 });

	const s = signal(1);
	const c = computed(() => s() + 1);
	let seen = 0;
	effect(() => {
		seen = c();
	});
	s(41);
	expect(seen).toBe(42);
});

test('configure throws once the system is materialized', () => {
	expect(() => configure({ initialRecords: 8192 })).toThrowError(/before the first/);
});

test('createReactiveSystem honors initialRecords (stride-8 arena)', () => {
	const sys = createReactiveSystem({ initialRecords: 64 });
	expect(sys.buffer().length).toBe(64 * 8);
});

test('system.configure works lazily and wins over the default size', () => {
	const sys = createReactiveSystem();
	sys.configure({ initialRecords: 32 });
	expect(sys.buffer().length).toBe(32 * 8);
	expect(() => sys.configure({ initialRecords: 64 })).toThrowError(/before the first/);
});

test('configure after a primitive exists throws (per-system)', () => {
	const sys = createReactiveSystem({ initialRecords: 128 });
	sys.signal(0);
	expect(() => sys.configure({ initialRecords: 256 })).toThrowError(/before the first/);
});

test('initialRecords must be a finite number', () => {
	const sys = createReactiveSystem();
	expect(() => sys.configure({ initialRecords: Number.NaN })).toThrowError(TypeError);
	expect(() => createReactiveSystem({ initialRecords: Number.POSITIVE_INFINITY })).toThrowError(TypeError);
});

test('unmaterialized engine access fails loudly', () => {
	const sys = createReactiveSystem();
	expect(() => sys.e.read(0)).toThrowError(/not materialized/);
});

test('top-level allocation past capacity grows the arena instead of throwing', () => {
	const sys = createReactiveSystem({ initialRecords: 16 });
	const ids: number[] = [];
	for (let i = 0; i < 1000; i++) {
		ids.push(sys.signal(i));
	}
	// Ids minted before every growth stay valid — the migration copy
	// preserves arena-relative offsets.
	expect(sys.signalRead(ids[0])).toBe(0);
	expect(sys.signalRead(ids[999])).toBe(999);
	expect(sys.buffer().length).toBeGreaterThan(16 * 8);
});

test('engine-minted handles work against a configured arena', () => {
	const sys = createReactiveSystem({ initialRecords: 4096 });
	const s = sys.makeSignal(1);
	const c = sys.makeComputed(() => (s() as number) + 1);
	let seen = 0;
	sys.makeEffect(() => {
		seen = c() as number;
	});
	s(41);
	expect(seen).toBe(42);
});
