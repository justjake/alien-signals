import { expect, test } from 'vitest';
import { NodeSlot, ReactiveFlags, createReactiveSystem } from '../src/system';
import { makeMiniLib } from './helpers/miniLib';

// The raw graph ops at the engine level (system.e): upstream alien-signals'
// five algorithms driven kindlessly, with the host reading records itself,
// plus the start/stop watched lifecycle those walks deliver.

test('link returns the edge id; the same pair dedupes; unlink removes', () => {
	const sys = createReactiveSystem({
		initialRecords: 4096,
		update: () => true,
		notify: () => {},
	});
	const dep = sys.custom(1 << 16 | ReactiveFlags.Mutable);
	const sub = sys.custom(2 << 16 | ReactiveFlags.Mutable);
	const { link, unlink } = sys.e;
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
		initialRecords: 4096,
		update: () => true,
		notify: (id) => {
			notified.push(id);
		},
	});
	const src = sys.custom(1 << 16 | ReactiveFlags.Mutable);
	const watcher = sys.custom(3 << 16 | ReactiveFlags.Watching);
	const M = sys.buffer();
	const { link, propagate, checkDirty } = sys.e;
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
		initialRecords: 4096,
		update: (id, flags) => {
			updated.push(id);
			// Host contract: reset the word (walks stop revisiting), report changed.
			sys.buffer()[id + NodeSlot.Flags] = flags & ~(ReactiveFlags.Dirty | ReactiveFlags.Pending);
			return true;
		},
		notify: () => {},
	});
	const src = sys.custom(1 << 16 | ReactiveFlags.Mutable);
	const mid = sys.custom(2 << 16 | ReactiveFlags.Mutable);
	const M = sys.buffer();
	const { link, propagate, checkDirty } = sys.e;
	link(src, mid, 1);
	M[src + NodeSlot.Flags] |= ReactiveFlags.Dirty;
	propagate(M[src + NodeSlot.Subs], false);
	expect(M[mid + NodeSlot.Flags] & ReactiveFlags.Pending).not.toBe(0);
	expect(checkDirty(M[mid + NodeSlot.Deps], mid)).toBe(true);
	expect(updated).toEqual([src]);
});

test('start fires on first subscriber only; stop on last unlink with state', () => {
	const events: string[] = [];
	const sys = createReactiveSystem({
		initialRecords: 4096,
		update: () => true,
		notify: () => {},
		start: (id) => {
			events.push(`start:${id}`);
			return `state:${id}`;
		},
		stop: (id, state) => {
			events.push(`stop:${id}:${state}`);
		},
	});
	const dep = sys.custom(1 << 16 | ReactiveFlags.Mutable);
	const s1 = sys.custom(2 << 16);
	const s2 = sys.custom(2 << 16);
	const { link, unlink } = sys.e;
	const l1 = link(dep, s1, 1);
	expect(events).toEqual([`start:${dep}`]);
	const l2 = link(dep, s2, 1);
	expect(events.length).toBe(1); // second subscriber: no second start
	unlink(l1, s1);
	expect(events.length).toBe(1);
	unlink(l2, s2);
	expect(events).toEqual([`start:${dep}`, `stop:${dep}:state:${dep}`]);
});

test('stop survives writes and recomputes of the started node', () => {
	const events: string[] = [];
	const lib = makeMiniLib({
		initialRecords: 4096,
		start: () => {
			events.push('start');
			return undefined;
		},
		stop: () => {
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

test('reset() delivers stop for every started node, newest first', () => {
	const stops: number[] = [];
	const sys = createReactiveSystem({
		initialRecords: 4096,
		update: () => true,
		notify: () => {},
		start: (id) => id,
		stop: (id) => {
			stops.push(id);
		},
	});
	const d1 = sys.custom(1 << 16 | ReactiveFlags.Mutable);
	const d2 = sys.custom(1 << 16 | ReactiveFlags.Mutable);
	const sub = sys.custom(2 << 16);
	sys.e.link(d1, sub, 1);
	sys.e.link(d2, sub, 1);
	sys.reset();
	expect(stops).toEqual([d2, d1]);
});

test('free(id, gen): explicit lifetime; stale gens are no-ops', () => {
	const sys = createReactiveSystem({
		initialRecords: 4096,
		update: () => true,
		notify: () => {},
	});
	const id = sys.custom(1 << 16 | ReactiveFlags.Mutable);
	const gen = sys.gen(id);
	sys.free(id, gen);
	sys.free(id, gen); // double free: gen/live checks make it harmless
	expect(() => sys.free(id, gen)).not.toThrow();
});
