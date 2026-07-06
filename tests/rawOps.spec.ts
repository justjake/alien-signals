import { expect, test } from 'vitest';
import { NodeSlot, ReactiveFlags, createReactiveSystem } from '../src/system';
import type { LinkId, SignalId, ReactiveSystem } from '../src/system';
import { makeMiniLib } from './helpers/miniLib';

// Each minted owner is pinned in `owners` so garbage collection cannot
// reclaim records mid-test.
function minter(sys: ReactiveSystem): (hostBits?: number) => SignalId {
	const owners: object[] = [];
	return (hostBits?: number) => {
		const owner = {};
		owners.push(owner);
		return sys.createNode(owner, hostBits);
	};
}

// The raw graph ops at the engine level (system.e): upstream alien-signals'
// five algorithms driven kindlessly, with the host reading records itself,
// plus the watched/unwatched lifecycle those walks deliver.

test('link returns the edge id; the same pair dedupes; unlink removes', () => {
	const sys = createReactiveSystem({
		capacityRecords: 4096,
		update: () => true,
		notify: () => {},
	});
	const mint = minter(sys);
	const dep = mint(1 << 16 | ReactiveFlags.Mutable);
	const sub = mint(2 << 16 | ReactiveFlags.Mutable);
	const { link, unlink } = sys.arena;
	const l1 = link(dep, sub, 1);
	const l2 = link(dep, sub, 1);
	expect(l1).toBe(l2);
	unlink(l1, sub);
	const l3 = link(dep, sub, 2);
	expect(typeof l3).toBe('number');
});

test('propagate marks downstream pending and notifies watchers', () => {
	const notified: number[] = [];
	const sys = createReactiveSystem({
		capacityRecords: 4096,
		update: () => true,
		notify: (id) => {
			notified.push(id);
		},
	});
	const mint = minter(sys);
	const src = mint(1 << 16 | ReactiveFlags.Mutable);
	const watcher = mint(3 << 16 | ReactiveFlags.Watching);
	const M = sys.arena.memory;
	const { link, propagate, checkDirty } = sys.arena;
	link(src, watcher, 1);
	M[src + NodeSlot.Flags] |= ReactiveFlags.Dirty;
	propagate(M[src + NodeSlot.Subs], false);
	expect(notified).toEqual([watcher]);
	// dedup: Watching cleared until re-armed
	M[src + NodeSlot.Flags] |= ReactiveFlags.Dirty;
	propagate(M[src + NodeSlot.Subs], false);
	expect(notified).toEqual([watcher]);
	// The host "runs" the watcher: resolving its staleness through the
	// update seam clears the pending state, then re-arming Watching makes
	// it notifiable again (an already-pending watcher is deliberately not
	// re-notified).
	checkDirty(M[watcher + NodeSlot.Deps], watcher);
	M[watcher + NodeSlot.Flags] &= ~(ReactiveFlags.Dirty | ReactiveFlags.Pending);
	M[watcher + NodeSlot.Flags] |= ReactiveFlags.Watching;
	M[src + NodeSlot.Flags] |= ReactiveFlags.Dirty;
	propagate(M[src + NodeSlot.Subs], false);
	expect(notified).toEqual([watcher, watcher]);
});

test('checkDirty resolves staleness through the update seam', () => {
	const updated: number[] = [];
	const sys = createReactiveSystem({
		capacityRecords: 4096,
		update: (id, flags) => {
			updated.push(id);
			// Host contract: reset the word (walks stop revisiting), report changed.
			sys.arena.memory[id + NodeSlot.Flags] = flags & ~(ReactiveFlags.Dirty | ReactiveFlags.Pending);
			return true;
		},
		notify: () => {},
	});
	const mint = minter(sys);
	const src = mint(1 << 16 | ReactiveFlags.Mutable);
	const mid = mint(2 << 16 | ReactiveFlags.Mutable);
	const M = sys.arena.memory;
	const { link, propagate, checkDirty } = sys.arena;
	link(src, mid, 1);
	M[src + NodeSlot.Flags] |= ReactiveFlags.Dirty;
	propagate(M[src + NodeSlot.Subs], false);
	expect(M[mid + NodeSlot.Flags] & ReactiveFlags.Pending).not.toBe(0);
	expect(checkDirty(M[mid + NodeSlot.Deps], mid)).toBe(true);
	expect(updated).toEqual([src]);
});

test('watched fires on first subscriber only; unwatched on last unlink with state', () => {
	const events: string[] = [];
	const sys = createReactiveSystem({
		capacityRecords: 4096,
		update: () => true,
		notify: () => {},
		watched: (id) => {
			events.push(`start:${id}`);
			return `state:${id}`;
		},
		unwatched: (id, state) => {
			events.push(`stop:${id}:${state}`);
		},
	});
	const mint = minter(sys);
	const dep = mint(1 << 16 | ReactiveFlags.Mutable);
	const s1 = mint(2 << 16);
	const s2 = mint(2 << 16);
	const { link, unlink } = sys.arena;
	const l1 = link(dep, s1, 1);
	expect(events).toEqual([`start:${dep}`]);
	const l2 = link(dep, s2, 1);
	expect(events.length).toBe(1); // second subscriber: no second start
	unlink(l1, s1);
	expect(events.length).toBe(1);
	unlink(l2, s2);
	expect(events).toEqual([`start:${dep}`, `stop:${dep}:state:${dep}`]);
});

test('unwatched survives writes and recomputes of the watched node', () => {
	const events: string[] = [];
	const lib = makeMiniLib({
		capacityRecords: 4096,
		watched: () => {
			events.push('start');
			return undefined;
		},
		unwatched: () => {
			events.push('stop');
		},
	});
	const s = lib.signal(2);
	const c = lib.computed(() => s() * 3);
	const stop = lib.effect(() => {
		c();
	});
	s(5);
	lib.startBatch();
	s(6);
	s(7);
	lib.endBatch();
	lib.drain();
	events.length = 0;
	stop();
	expect(events).toEqual(['stop', 'stop']); // computed, then signal
});

test('reset() delivers unwatched for every watched node, newest first', () => {
	const stops: number[] = [];
	const sys = createReactiveSystem({
		capacityRecords: 4096,
		update: () => true,
		notify: () => {},
		watched: (id) => id,
		unwatched: (id) => {
			stops.push(id);
		},
	});
	const mint = minter(sys);
	const d1 = mint(1 << 16 | ReactiveFlags.Mutable);
	const d2 = mint(1 << 16 | ReactiveFlags.Mutable);
	const sub = mint(2 << 16);
	sys.arena.link(d1, sub, 1);
	sys.arena.link(d2, sub, 1);
	sys.reset();
	expect(stops).toEqual([d2, d1]);
});

test('unwatched is delivered even when watched is not defined', () => {
	const stops: number[] = [];
	const sys = createReactiveSystem({
		capacityRecords: 4096,
		update: () => true,
		notify: () => {},
		unwatched: (id) => {
			stops.push(id);
		},
	});
	const mint = minter(sys);
	const dep = mint(1 << 16 | ReactiveFlags.Mutable);
	const sub = mint(2 << 16);
	const l = sys.arena.link(dep, sub, 1);
	sys.arena.unlink(l, sub);
	expect(stops).toEqual([dep]);
});

test('arena.freeNode(id, gen): manual lifetime; stale gens are no-ops', () => {
	const sys = createReactiveSystem({
		capacityRecords: 4096,
		update: () => true,
		notify: () => {},
	});
	const id = sys.arena.allocNode(1 << 16 | ReactiveFlags.Mutable);
	const gen = sys.generationOf(id);
	sys.arena.freeNode(id, gen);
	sys.arena.freeNode(id, gen); // double free: gen/live checks make it harmless
	expect(() => sys.arena.freeNode(id, gen)).not.toThrow();
});

test('disposeNode frees a live id; repeats are no-ops', () => {
	const sys = createReactiveSystem({
		capacityRecords: 4096,
		update: () => true,
		notify: () => {},
	});
	const id = sys.createNode({}, 1 << 16 | ReactiveFlags.Mutable);
	sys.disposeNode(id);
	expect(sys.arena.memory[id + NodeSlot.Flags]).toBe(0); // freed
	expect(() => sys.disposeNode(id)).not.toThrow(); // already freed: no-op
});

test('disposeNode with a stale generation is a no-op', () => {
	const sys = createReactiveSystem({
		capacityRecords: 4096,
		update: () => true,
		notify: () => {},
	});
	const owner = {};
	const id = sys.createNode(owner, 1 << 16 | ReactiveFlags.Mutable);
	const gen = sys.generationOf(id);
	sys.disposeNode(id, ((gen as number) + 1) as typeof gen); // wrong gen: no-op
	expect(sys.arena.memory[id + NodeSlot.Flags]).not.toBe(0); // still live
	sys.disposeNode(id, gen); // right gen: freed
	expect(sys.arena.memory[id + NodeSlot.Flags]).toBe(0);
});
