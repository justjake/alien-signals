import { expect, test } from 'vitest';
import { computedId, dispose, effect, effectId, get, set, signalId, trigger } from '../src';

// Hardening 2 (docs/detached-signal-records.md): teardown walks consume the
// dependency-list head; selective and partial walks re-derive their position
// from the record after every unlink that can run user code. These pin the
// two today-reachable failures the walk rules fix.

test('disposing an effect during its own run unlinks its whole dependency set (bug #2)', async () => {
	// run() resets DepsTail before the body, so the old tail-anchored walk
	// unlinked NOTHING when an effect disposed itself before re-reading its
	// deps — the dead record kept its edge in every dependency's subscriber
	// list, and after sweep + recycle the new occupant inherited it.
	const s = signalId(0);
	let kill = false;
	let runs = 0;
	const self: number = effectId(() => {
		runs++;
		if (kill) {
			dispose(self);
			return; // no re-read: DepsTail is still zero at the dispose
		}
		get(s);
	});
	kill = true;
	set(s, 1);
	expect(runs).toBe(2);

	// Let the boundary sweep recycle the record, then reuse it.
	await Promise.resolve();
	const t = signalId(0);
	let strangerRuns = 0;
	effectId(() => {
		strangerRuns++;
		get(t);
	});
	// A surviving ghost edge would notify (or corrupt) the recycled record.
	set(s, 2);
	expect(runs).toBe(2);
	expect(strangerRuns).toBe(1);
});

test('child cleanup disposing a later sibling mid-teardown is safe', () => {
	const log: string[] = [];
	let stop3!: () => void;
	const stopOuter = effect(() => {
		effect(() => () => {
			stop3();
			log.push('c1');
		});
		effect(() => () => log.push('c2'));
		stop3 = effect(() => () => log.push('c3'));
		return () => log.push('outer');
	});
	log.length = 0;
	stopOuter();
	// c1's cleanup disposes c3 (whose cleanup runs inside it); the walk
	// re-reads the head and still finds c2; c3 is already gone when the
	// walk gets there.
	expect(log).toEqual(['c3', 'c1', 'c2', 'outer']);
});

test('purgeDeps survives a drop cascade that disposes a link ahead of the walk', () => {
	const cond = signalId(true);
	const s1 = signalId(1);
	const d2 = computedId(() => get(s1));
	const d1 = computedId(() => {
		effect(() => () => {
			dispose(d2);
		});
		return get(s1);
	});
	const C = computedId(() => {
		if (get(cond)) {
			get(d1);
			get(d2);
		}
		return get(s1);
	});
	effectId(() => {
		get(C);
	});
	// C re-evaluates reading only cond and s1: purgeDeps drops C–d1, whose
	// unwatched cascade runs the child effect's cleanup, which disposes d2 —
	// unlinking C–d2, the exact link the old walk had already cached as its
	// next position (double-unlink corrupted the link free stack).
	set(cond, false);
	expect(get(C)).toBe(1);
	// Churn afterwards: a corrupted free stack hands the same link record to
	// two live edges and misbehaves here.
	const z = computedId(() => get(s1) + 1);
	effectId(() => {
		get(z);
	});
	set(s1, 5);
	expect(get(z)).toBe(6);
	expect(get(C)).toBe(5);
});

test('computed double-teardown: dispose after unwatched drop finds an empty head', () => {
	const s = signalId(0);
	const c = computedId(() => get(s));
	const e = effectId(() => {
		get(c);
	});
	dispose(c); // unwatched drop + the free's own dep walk hit the same list
	dispose(e);
	set(s, 1); // graph coherent: no stale links, no crash
	const c2 = computedId(() => get(s) * 2);
	expect(get(c2)).toBe(2);
});

test('trigger teardown consumes the head under a cold-drop cascade', () => {
	const box = signalId({ n: 1 });
	const other = signalId(0);
	const d2 = computedId(() => get(other));
	const d1 = computedId(() => {
		effect(() => () => {
			dispose(d2);
		});
		return get(box).n;
	});
	let seen = 0;
	const e = effectId(() => {
		seen = get(d1);
	});
	dispose(e);
	// d1 and d2 are now only reachable from trigger's scratch subscriber.
	trigger(() => {
		get(d1);
		get(d2);
	});
	// The teardown unlinked scratch–d1 → d1 went cold → its child effect's
	// cleanup disposed d2, killing the link the walk would visit next.
	get(box).n = 2;
	trigger(() => {
		get(box);
	});
	expect(seen).toBe(1);
	// Coherence churn.
	const z = computedId(() => get(other) + 10);
	expect(get(z)).toBe(10);
});
