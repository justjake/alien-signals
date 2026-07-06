import { expect, test } from 'vitest';
import { makeMiniLib } from './helpers/miniLib';

// Arena growth (grow-by-migration): when the bump pointer passes 3/4 of
// capacity, the factory builds the next engine generation over an arena
// twice the size at an operation boundary, copies the live prefix (ids are
// arena-relative offsets, so every id survives), and retires the old engine
// whose entry points forward. These tests drive growth through a userspace
// kind library, which is the only way nodes exist now.

test('userspace nodes minted before growth keep working after it', () => {
	const lib = makeMiniLib({ initialRecords: 64 });
	const s = lib.signal(1);
	const c = lib.computed(() => s() * 10);
	let seen = 0;
	let runs = 0;
	lib.effect(() => {
		seen = c();
		runs++;
	});
	const before = lib.sys.arena.memory.length;
	const extras: Array<() => number> = [];
	for (let i = 0; i < 300; i++) {
		extras.push(lib.signal(i));
	}
	expect(lib.sys.arena.memory.length).toBeGreaterThan(before);
	expect(c()).toBe(10);
	s(5);
	expect(seen).toBe(50);
	expect(runs).toBe(2);
	expect(extras[0]()).toBe(0);
	expect(extras[299]()).toBe(299);
});

test('growth preserves the graph mid-batch', () => {
	const lib = makeMiniLib({ initialRecords: 64 });
	const s = lib.signal(0);
	let seen = -1;
	lib.effect(() => {
		seen = s();
	});
	lib.startBatch();
	s(7);
	for (let i = 0; i < 300; i++) {
		lib.signal(i);
	}
	expect(seen).toBe(0);
	lib.endBatch();
	lib.drain();
	expect(seen).toBe(7);
});

test('disposers minted before growth free the right record after it', () => {
	const lib = makeMiniLib({ initialRecords: 64 });
	const s = lib.signal(0);
	let runs = 0;
	const stop = lib.effect(() => {
		s();
		runs++;
	});
	for (let i = 0; i < 300; i++) {
		lib.signal(i);
	}
	stop();
	s(1);
	expect(runs).toBe(1);
});

test('exhaustion inside one operation still throws an actionable error', () => {
	const lib = makeMiniLib({ initialRecords: 32 });
	expect(() => {
		lib.effect(() => {
			for (let i = 0; i < 100; i++) {
				lib.signal(i);
			}
		});
	}).toThrowError(/exhausted inside one operation.*configure/);
});

test('reset() after growth keeps the grown capacity and works', () => {
	const lib = makeMiniLib({ initialRecords: 64 });
	for (let i = 0; i < 300; i++) {
		lib.signal(i);
	}
	const grown = lib.sys.arena.memory.length;
	expect(grown).toBeGreaterThan(64 * 8);
	lib.sys.reset();
	expect(lib.sys.arena.memory.length).toBe(grown);
	const s = lib.signal(1);
	let seen = 0;
	lib.effect(() => {
		seen = s();
	});
	s(3);
	expect(seen).toBe(3);
});

test('system.arena tracks the current generation; stale mint refs forward', () => {
	const lib = makeMiniLib({ initialRecords: 64 });
	const arenaBefore = lib.sys.arena;
	const s = lib.signal(5);
	for (let i = 0; i < 300; i++) {
		lib.signal(i);
	}
	expect(lib.sys.arena).not.toBe(arenaBefore);
	expect(s()).toBe(5); // pre-growth closure reaches the new generation
});
