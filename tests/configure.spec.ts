import { expect, test } from 'vitest';
import { computed, configure, effect, signal } from '../src';
import { createReactiveSystem } from '../src/system';
import { makeMiniLib } from './helpers/miniLib';

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
	// Reading `arena` materializes on demand; callers never see a
	// pre-allocation state.
	expect(sys.arena.memory.length).toBe(64 * 8);
});

test('configure after a node exists throws (per-system)', () => {
	const sys = createReactiveSystem({ initialRecords: 128 });
	sys.createReactiveNode({});
	expect(() => sys.configure({ initialRecords: 256 })).toThrowError(/before the first/);
});

test('initialRecords must be a finite number', () => {
	const sys = createReactiveSystem();
	expect(() => sys.configure({ initialRecords: Number.NaN })).toThrowError(TypeError);
});

test('creating a system allocates nothing until first use', () => {
	const sys = createReactiveSystem({ initialRecords: 1 << 20 });
	// configure() is still legal, so nothing has materialized yet.
	expect(() => sys.configure({ initialRecords: 64 })).not.toThrow();
	expect(sys.arena.memory.length).toBe(64 * 8);
});

test('top-level allocation past capacity grows instead of throwing', () => {
	const lib = makeMiniLib({ initialRecords: 16 });
	const handles: Array<() => number> = [];
	for (let i = 0; i < 500; i++) {
		handles.push(lib.signal(i));
	}
	expect(handles[0]()).toBe(0);
	expect(handles[499]()).toBe(499);
	expect(lib.sys.arena.memory.length).toBeGreaterThan(16 * 8);
});
