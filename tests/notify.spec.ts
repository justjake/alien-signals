import { expect, test } from 'vitest';
import { ReactiveFlags, createReactiveSystem } from '../src/system';
import { makeMiniLib } from './helpers/miniLib';

// The notify seam is THE effect mechanism: the propagation ladder hands
// every WATCHING node to the host as (id, gen) at write time, clearing
// WATCHING as the dedup. Hosts own queues, ordering, and running.

test('notifications carry gens; stale ids are detectable', () => {
	const lib = makeMiniLib({ initialCapacity: 4096 });
	const s = lib.signal(0);
	let runs = 0;
	const stop = lib.effect(() => {
		s();
		runs++;
	});
	s(1);
	lib.drain();
	expect(runs).toBe(2);
	stop();
	s(2); // notification may fire for the freed id; gen check drops it
	lib.drain();
	expect(runs).toBe(2);
});

test('one notification per wave until the host re-arms', () => {
	const lib = makeMiniLib({ initialCapacity: 4096 });
	const s = lib.signal(0);
	lib.effect(() => {
		s();
	});
	lib.notified.length = 0;
	lib.startBatch();
	s(1);
	s(2);
	s(3);
	lib.endBatch();
	expect(lib.notified.length).toBe(1); // deduped while un-run
	lib.drain();
	s(4);
	lib.drain();
	expect(lib.notified.length).toBe(2); // re-armed after running
});

test('reads stay consistent while effects are parked', () => {
	const lib = makeMiniLib({ initialCapacity: 4096 });
	const s = lib.signal(1);
	const c = lib.computed(() => s() * 10);
	lib.effect(() => {
		c();
	});
	lib.startBatch();
	s(5);
	expect(c()).toBe(50); // pull re-verifies before any effect ran
	lib.endBatch();
	lib.drain();
});

test('without a notify option, watching nodes are silently skipped', () => {
	const sys = createReactiveSystem({
		initialCapacity: 4096,
		update: () => true,
	});
	const src = sys.createReactiveNode({}, 1 << 16 | ReactiveFlags.Mutable);
	const watcher = sys.createReactiveNode({}, 3 << 16 | ReactiveFlags.Watching);
	const M = sys.arena.memory;
	const edge = sys.arena.link(src, watcher, 1);
	M[src] |= ReactiveFlags.Dirty; // slot 0 = flags
	expect(() => sys.arena.propagate(edge, false)).not.toThrow();
});
