import { expect, test } from 'vitest';
import { ReactiveFlags, createReactiveSystem } from '../src/system';
import { makeMiniLib } from './helpers/miniLib';

// The composable kit at the id level: link/unlink/propagate/shallowPropagate
// and the start/stop watched lifecycle, driven kindlessly.

test('link returns the edge id; the same pair dedupes; unlink removes', () => {
	const sys = createReactiveSystem({
		initialRecords: 4096,
		update: () => true,
		notify: () => {},
	});
	const dep = sys.custom(1 << 16 | ReactiveFlags.Mutable);
	const sub = sys.custom(2 << 16 | ReactiveFlags.Mutable);
	const l1 = sys.link(dep, sub);
	const l2 = sys.link(dep, sub);
	expect(l1).toBe(l2);
	sys.unlink(l1);
	const l3 = sys.link(dep, sub);
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
	sys.link(src, watcher);
	sys.markDirty(src);
	sys.propagate(src);
	expect(notified).toEqual([watcher]);
	// dedup: WATCHING cleared until re-armed
	sys.markDirty(src);
	sys.propagate(src);
	expect(notified).toEqual([watcher]);
	// The host "runs" the watcher: verify clears its pending state, then
	// re-arming WATCHING makes it notifiable again (an already-pending
	// watcher is deliberately not re-notified).
	sys.verify(watcher);
	sys.setNodeFlags(watcher, ReactiveFlags.Watching);
	sys.markDirty(src);
	sys.propagate(src);
	expect(notified).toEqual([watcher, watcher]);
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
	const l1 = sys.link(dep, s1);
	expect(events).toEqual([`start:${dep}`]);
	const l2 = sys.link(dep, s2);
	expect(events.length).toBe(1); // second subscriber: no second start
	sys.unlink(l1);
	expect(events.length).toBe(1);
	sys.unlink(l2);
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
	lib.sys.startBatch();
	s(6);
	s(7);
	lib.sys.endBatch();
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
	sys.link(d1, sub);
	sys.link(d2, sub);
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
