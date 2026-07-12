import { expect, test } from 'vitest';
import { computedId, dispose, effectId, effectScopeId, get, growCapacity, isEffect, set, signalId, trigger } from '../src';

// Hardening 5 (docs/detached-signal-records.md): growth never runs inside an
// in-flight host operation. Creation entries that establish frame state
// (effectId, effectScopeId) apply a pending growth at the module trampoline
// BEFORE dispatching into the host generation; trigger's scratch allocation
// happens inside its bracket, where growth stays deferred. Obligations 22,
// 28, 29. NOTE: this file grows the default arena — vitest's per-file
// isolation keeps that from leaking into other specs.

// Arm a pending growth without letting it apply: growCapacity() inside a
// live frame stashes the request.
function armPendingGrowth(records: number): void {
	const e = effectId(() => {
		growCapacity(records);
	});
	dispose(e);
}

test('effectId with a pending growth tracks in the live generation (bug #4 site 4a, obligation 29)', () => {
	armPendingGrowth(3 * 1024 * 1024);
	const s = signalId(0);
	let runs = 0;
	// Pre-fix: allocNode grew mid-call, the old closure set the retired
	// generation's activeSub, and the effect was born tracking nothing.
	const e = effectId(() => {
		runs++;
		get(s);
	});
	expect(isEffect(e)).toBe(true);
	set(s, 1);
	expect(runs).toBe(2);
	dispose(e);
});

test('effectScopeId with a pending growth scopes in the live generation (bug #4 site 4b)', () => {
	armPendingGrowth(4 * 1024 * 1024);
	const s = signalId(0);
	let childRuns = 0;
	const scope = effectScopeId(() => {
		effectId(() => {
			childRuns++;
			get(s);
		});
	});
	set(s, 1);
	expect(childRuns).toBe(2);
	// The child lives in the scope's region/deps of the LIVE generation:
	// disposing the scope kills it.
	dispose(scope);
	set(s, 2);
	expect(childRuns).toBe(2);
});

test('trigger right after a growth-threshold crossing is fully functional (obligation 22)', () => {
	armPendingGrowth(5 * 1024 * 1024);
	const box = signalId({ n: 1 });
	const c = computedId(() => get(box).n);
	let seen = 0;
	effectId(() => {
		seen = get(c);
	});
	expect(seen).toBe(1);
	get(box).n = 2;
	// First trigger allocates its persistent scratch — inside the bracket,
	// so the pending growth stays deferred and the scratch, the tracked
	// links, and the closure's arena stay one generation.
	trigger(() => {
		get(box);
	});
	expect(seen).toBe(2);
	get(box).n = 3;
	trigger(() => {
		get(box);
	});
	expect(seen).toBe(3);
});

test('links freed by a getter mid-walk are not recycled before the unwind (bug #6, obligation 28)', () => {
	const S = signalId(0);
	let X!: number;
	let kill = false;
	const Y = computedId(() => {
		const v = get(S);
		if (kill) {
			// Free node AND link records the live dirtiness walk still
			// holds (the E–X link sits on the traversal stack), then
			// allocate fresh links: a recycled held record would come back
			// as a foreign edge under the unwind.
			dispose(X);
			const a = signalId(1);
			const b = computedId(() => get(a));
			get(b);
		}
		return v;
	});
	X = computedId(() => get(Y));
	effectId(() => {
		get(X);
	});
	kill = true;
	set(S, 1);
	kill = false;
	expect(get(Y)).toBe(1);
	set(S, 2);
	expect(get(Y)).toBe(2);
	// Churn: corrupted link records (one record on two live edges) surface
	// as wrong propagation here.
	const p = signalId(0);
	const q = computedId(() => get(p) + 1);
	effectId(() => {
		get(q);
	});
	set(p, 3);
	expect(get(q)).toBe(4);
});
