import { expect, test } from 'vitest';
import {
	computedId,
	dispose,
	effectId,
	effectScope,
	effectScopeId,
	get,
	getActiveSub,
	getActiveSubFrame,
	set,
	setActiveSub,
	setActiveSubFrame,
	signalId,
} from '../src';
import { FrameToken } from '../src/system';
import type { SignalIdOf } from '../src';

declare const gc: (() => void) | undefined;

// Hardening 1 (docs/detached-signal-records.md): saved subscriber identity
// is an (id, generation) pair; the logical free's identity phase — non-live,
// generation bump, frame-cache clears — runs before any user code, so
// tracking stops AT the free. Obligations 12, 13, 25, 27, 30, 31.

async function drainMaintenance(): Promise<void> {
	// The free-record sweep runs in the maintenance microtask.
	await new Promise((res) => setTimeout(res, 0));
}

async function drainFinalizers(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		gc!();
		await new Promise((res) => setTimeout(res, 1));
	}
}

test('reads after a self-dispose are untracked: no ghost edge (obligation 13)', async () => {
	const s = signalId(0);
	let kill = false;
	let runs = 0;
	const self: number = effectId(() => {
		runs++;
		if (kill) {
			dispose(self);
		}
		get(s); // after the dispose this read must not track
	});
	kill = true;
	set(s, 1);
	expect(runs).toBe(2);

	await drainMaintenance(); // sweep, so the record can recycle
	const t = signalId(0);
	let strangerRuns = 0;
	effectId(() => {
		strangerRuns++;
		get(t);
	});
	set(s, 2);
	expect(runs).toBe(2);
	expect(strangerRuns).toBe(1); // a ghost edge would notify the recycled record
});

test('scope self-dispose: later creations do not join the dead region', async () => {
	let inner!: SignalIdOf<number>;
	effectScopeId(() => {
		dispose(getActiveSub());
		inner = signalId(7); // currentScope was cleared at the free: top-level
	});
	expect(get(inner)).toBe(7);
	await drainMaintenance(); // region flush + sweep must not reclaim it
	expect(get(inner)).toBe(7);
	set(inner, 8);
	expect(get(inner)).toBe(8);
});

test('self-stop-then-spawn: the replacement child is a root effect and survives (pinned)', () => {
	const s = signalId(0);
	let childRuns = 0;
	let self!: number;
	self = effectId(() => {
		if (get(s) === 1) {
			dispose(self);
			effectId(() => {
				childRuns++;
				get(s);
			});
		}
	});
	set(s, 1);
	expect(childRuns).toBe(1);
	set(s, 2); // the child was created untracked → root → it survives
	expect(childRuns).toBe(2);
});

test('frame token: round-trips live, restores 0 from the moment of the free (obligations 12, 31)', async () => {
	const e = effectId(() => {});
	setActiveSub(e);
	const token = getActiveSubFrame();
	expect(token & FrameToken.IdMask).toBe(e); // plain number, id in the low bits
	setActiveSub(0);

	// Live round-trip installs the same subscriber.
	setActiveSubFrame(token);
	expect(getActiveSub()).toBe(e);
	setActiveSub(0);

	// The generation bumps at the LOGICAL free: the token dies immediately,
	// no sweep needed.
	dispose(e);
	setActiveSubFrame(token);
	expect(getActiveSub()).toBe(0);

	// And stays dead after the record recycles to a live stranger.
	await drainMaintenance();
	const stranger = effectId(() => {});
	setActiveSubFrame(token);
	expect(getActiveSub()).toBe(0);
	dispose(stranger);
});

test('a self-stopped effect\'s late cleanup store never runs and is swept (obligation 27)', async () => {
	let released = 0;
	let oldId = 0;
	effectId(() => {
		oldId = getActiveSub();
		dispose(oldId);
		return () => {
			released++;
		};
	});
	expect(released).toBe(0);
	await drainMaintenance(); // sweep's release phase clears the late store
	const e2 = effectId(() => {}); // no cleanup of its own
	dispose(e2);
	// Had the stale cleanup survived in the column, disposing the recycled
	// record would have run it.
	expect(released).toBe(0);
});

test('region teardown validates the generation before touching host columns (obligation 30)', async () => {
	let member!: SignalIdOf<number>;
	const stop = effectScope(() => {
		member = signalId(1);
	});
	dispose(member); // freed early: generation bumps now
	await drainMaintenance(); // swept: the record is reusable
	const c = computedId(() => 42); // may recycle the member's record
	stop(); // queues the region holding the STALE (id, gen) pair
	await drainMaintenance(); // region flush: the guard must skip the entry
	expect(get(c)).toBe(42); // the occupant's getter survived
});

test('registry identity: a recycled record is safe from its old owner\'s collection (bug #5, obligation 25)', async () => {
	expect(typeof gc).toBe('function');
	let owner: object | undefined = {};
	const owned = signalId(5, owner);
	dispose(owned); // freed through another path: generation bumps
	await drainMaintenance(); // swept
	const occupant = signalId(9); // may recycle the record
	owner = undefined; // now drop the owner
	await drainFinalizers(); // the orphan callback generation-mismatches
	expect(get(occupant)).toBe(9); // the new occupant is untouched
	set(occupant, 10);
	expect(get(occupant)).toBe(10);
});
