import { expect, test } from 'vitest';
import { computedId, dispose, effectId, get, set, signalId } from '../src';

// Hardening 3 (docs/detached-signal-records.md): a computed that loses its
// last subscriber while its own getter runs defers the unwatched dependency
// drop to its update exit. Obligation 19.

test('never-watched untracked computed keeps its dependency graph and cache', () => {
	const s = signalId(1);
	let runs = 0;
	const c = computedId(() => {
		runs++;
		return get(s);
	});
	expect(get(c)).toBe(1);
	expect(get(c)).toBe(1);
	expect(runs).toBe(1); // cached: no drop was ever dispatched
	set(s, 2);
	expect(get(c)).toBe(2);
	expect(runs).toBe(2);
});

test('mid-update unwatched drop is deferred to the exit (bug #3 shape)', () => {
	const s = signalId(0);
	const s2 = signalId(0);
	const s3 = signalId(0);
	let e1!: number;
	const c = computedId(() => {
		const v = get(s);
		if (v === 1) {
			// Kill the last subscriber mid-update, then KEEP TRACKING: the
			// old synchronous drop left DepsTail on a freed link and these
			// inserts could pop that record into a self-referential list.
			dispose(e1);
			get(s2);
			get(s3);
		}
		return v;
	});
	e1 = effectId(() => {
		get(c);
	});
	set(s, 1);
	expect(get(c)).toBe(1);
	// The exit drop ran: c is cold. Re-reads re-track cleanly.
	set(s2, 5);
	expect(get(c)).toBe(1);
	set(s, 2);
	expect(get(c)).toBe(2);
});

test('computed re-watched before its update exit keeps its dependencies', () => {
	const s = signalId(0);
	let e1!: number;
	let e2 = 0;
	let cRuns = 0;
	const c = computedId(() => {
		cRuns++;
		const v = get(s);
		if (v === 1 && e2 === 0) {
			dispose(e1); // last subscriber gone: pending drop
			e2 = effectId(() => {
				get(c); // re-watches c before its exit
			});
		}
		return v;
	});
	e1 = effectId(() => {
		get(c);
	});
	expect(cRuns).toBe(1);
	set(s, 1);
	const runsAfterWrite = cRuns;
	// Deps were kept: c is verified-current, so a read does not recompute.
	expect(get(c)).toBe(1);
	expect(cRuns).toBe(runsAfterWrite);
});

test('a throwing update exit clears the pending bit and still drops', () => {
	const s = signalId(0);
	let e1!: number;
	const c = computedId(() => {
		const v = get(s);
		if (v === 1) {
			dispose(e1);
			throw new Error('mid-update');
		}
		return v;
	});
	e1 = effectId(() => {
		get(c);
	});
	expect(() => set(s, 1)).toThrow('mid-update');
	// The drop happened at the throw exit; c re-evaluates (and rethrows
	// while s stays 1), then recovers.
	expect(() => get(c)).toThrow('mid-update');
	set(s, 2);
	expect(get(c)).toBe(2);
});
