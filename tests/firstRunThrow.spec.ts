import { expect, test } from 'vitest';
import { effect, effectId, effectScope, effectScopeId, get, isEffect, isEffectScope, set, signal, signalId } from '../src';

// Hardening 4 (docs/detached-signal-records.md): a throwing FIRST run of an
// effect or scope disposes what it created. SEMANTIC CHANGE pinned here: the
// old behavior kept the record half-armed — it re-ran on dependency changes
// but could never be stopped (no stop callable was ever returned).

test('effect whose first run throws is disposed, not half-armed', () => {
	const s = signal(0);
	let runs = 0;
	expect(() =>
		effect(() => {
			runs++;
			s();
			throw new Error('boom');
		}),
	).toThrow('boom');
	expect(runs).toBe(1);
	// The old half-armed record would re-run here.
	s(1);
	expect(runs).toBe(1);
});

test('effectId whose first run throws frees its record', () => {
	const s = signalId(0);
	let id = 0;
	expect(() => {
		id = effectId(() => {
			id = 0; // never reached past the throw below on rerun
			get(s);
			throw new Error('boom');
		});
	}).toThrow('boom');
	// The id never escaped (effectId threw), but the record must not be
	// live: allocate an effect and verify no stale rerun fires.
	let reruns = 0;
	const ok = effectId(() => {
		get(s);
		reruns++;
	});
	set(s, 1);
	expect(reruns).toBe(2);
	expect(isEffect(ok)).toBe(true);
});

test('effect that throws on RERUN keeps today\'s behavior (re-armed, stoppable)', () => {
	const s = signal(0);
	let runs = 0;
	const stop = effect(() => {
		runs++;
		s();
		if (s() === 1) {
			throw new Error('later');
		}
	});
	expect(runs).toBe(1);
	expect(() => s(1)).toThrow('later');
	// Still alive: a further write re-runs it.
	expect(() => s(2)).not.toThrow();
	expect(runs).toBe(3);
	stop();
	s(3);
	expect(runs).toBe(3);
});

test('effectScope whose first run throws disposes its children and region', async () => {
	const outer = signal(0);
	let childRuns = 0;
	let memberId = 0 as ReturnType<typeof signalId<number>>;
	expect(() =>
		effectScope(() => {
			memberId = signalId(123);
			effect(() => {
				childRuns++;
				outer();
			});
			throw new Error('boom');
		}),
	).toThrow('boom');
	expect(childRuns).toBe(1);
	// The child died with the scope: no rerun.
	outer(1);
	expect(childRuns).toBe(1);
	// The region member is reclaimed by the deferred region flush.
	await Promise.resolve();
	// Freed record: a fresh signal may reuse it; the old value must be gone.
	const fresh = signalId(undefined);
	if (fresh === memberId) {
		expect(get(fresh)).toBe(undefined);
	}
});

test('effectScopeId whose first run throws frees the scope record', () => {
	expect(() =>
		effectScopeId(() => {
			throw new Error('boom');
		}),
	).toThrow('boom');
	// Allocate a scope: the freed record recycles cleanly.
	const scope = effectScopeId(() => {});
	expect(isEffectScope(scope)).toBe(true);
});

test('child cleanup runs when a scope dies to a first-run throw', () => {
	let cleaned = 0;
	expect(() =>
		effectScope(() => {
			effect(() => {
				return () => {
					cleaned++;
				};
			});
			throw new Error('boom');
		}),
	).toThrow('boom');
	expect(cleaned).toBe(1);
});
