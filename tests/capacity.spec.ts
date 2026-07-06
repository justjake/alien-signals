import { expect, test } from 'vitest';
import { computed, effect, growCapacity, signal } from '../src';
import { createReactiveSystem } from '../src/system';
import { makeMiniLib } from './helpers/miniLib';

// Capacity is fixed at creation (initialCapacity, required) and only ever
// raised: automatically when the graph outgrows the arena, or explicitly
// via growCapacity(records).

test('createReactiveSystem allocates initialCapacity eagerly (stride-8 arena)', () => {
	const sys = createReactiveSystem({ initialCapacity: 64 });
	expect(sys.arena.memory.length).toBe(64 * 8);
});

test('initialCapacity must be a positive finite number', () => {
	expect(() => createReactiveSystem({ initialCapacity: Number.NaN })).toThrowError(TypeError);
	expect(() => createReactiveSystem({ initialCapacity: -5 })).toThrowError(TypeError);
});

test('growCapacity raises capacity immediately when idle', () => {
	const sys = createReactiveSystem({ initialCapacity: 64 });
	const before = sys.arena;
	sys.growCapacity(1024);
	expect(sys.arena.memory.length).toBe(1024 * 8);
	expect(sys.arena).not.toBe(before); // a new arena generation
});

test('growCapacity is a no-op when already big enough; throws on invalid', () => {
	const sys = createReactiveSystem({ initialCapacity: 1024 });
	const before = sys.arena;
	sys.growCapacity(512);
	expect(sys.arena).toBe(before);
	expect(() => sys.growCapacity(Number.NaN)).toThrowError(TypeError);
	expect(() => sys.growCapacity(0)).toThrowError(TypeError);
});

test('growCapacity preserves the live graph', () => {
	const lib = makeMiniLib({ initialCapacity: 64 });
	const s = lib.signal(1);
	const c = lib.computed(() => s() * 10);
	let seen = 0;
	lib.effect(() => {
		seen = c();
	});
	lib.sys.growCapacity(4096);
	expect(lib.sys.arena.memory.length).toBe(4096 * 8);
	s(5);
	expect(seen).toBe(50);
});

test('growCapacity mid-operation is stashed and applied at the boundary', async () => {
	const lib = makeMiniLib({ initialCapacity: 256 });
	const s = lib.signal(0);
	let requested = false;
	lib.effect(() => {
		if (s() === 1 && !requested) {
			requested = true;
			// Inside an effect: the arena must not move under this frame.
			lib.sys.growCapacity(2048);
			expect(lib.sys.arena.memory.length).toBe(256 * 8);
		}
	});
	s(1);
	expect(lib.sys.arena.memory.length).toBe(256 * 8);
	await new Promise((resolve) => setTimeout(resolve, 0)); // maintenance microtask
	expect(lib.sys.arena.memory.length).toBe(2048 * 8);
	s(2); // the migrated graph still works
});

test('index growCapacity export grows the default system', () => {
	const s = signal(1);
	const c = computed(() => s() + 1);
	let seen = 0;
	effect(() => {
		seen = c();
	});
	growCapacity(1 << 21);
	s(41);
	expect(seen).toBe(42);
	expect(() => growCapacity(Number.NaN)).toThrowError(TypeError);
});

test('top-level allocation past capacity grows instead of throwing', () => {
	const lib = makeMiniLib({ initialCapacity: 16 });
	const handles: Array<() => number> = [];
	for (let i = 0; i < 500; i++) {
		handles.push(lib.signal(i));
	}
	expect(handles[0]()).toBe(0);
	expect(handles[499]()).toBe(499);
	expect(lib.sys.arena.memory.length).toBeGreaterThan(16 * 8);
});
