import { expect, test } from 'vitest';
import {
	effect,
	effectScope,
	endBatch,
	growCapacity,
	reset,
	setEffectMode,
	signal,
	startBatch,
	trigger,
} from '../src';

declare const gc: (() => void) | undefined;

// Detached signal records (docs/detached-signal-records.md): the default
// signal() callable is born without an arena record, attaches at its first
// tracked read, and detaches — value back into the closure, record
// reclaimed — when its last incoming link unlinks. Obligations 1-3, 5-7,
// 9-11, 20, 21, 24.

async function drainMaintenance(): Promise<void> {
	await new Promise((res) => setTimeout(res, 0));
}

async function collect(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		gc!();
		await new Promise((res) => setTimeout(res, 1));
	}
}

test('detached basics: read, write, equality (obligation 1 behavior)', () => {
	const s = signal(1);
	expect(s()).toBe(1);
	s(2);
	expect(s()).toBe(2);
	const u = signal<number>();
	expect(u()).toBe(undefined);
});

test('attach at first tracked read; values flow; detach on last unlink (obligation 2)', () => {
	const s = signal(10);
	let seen = 0;
	let runs = 0;
	const stop = effect(() => {
		runs++;
		seen = s()!;
	});
	expect(seen).toBe(10);
	s(11);
	expect(seen).toBe(11);
	expect(runs).toBe(2);
	stop(); // last consumer: detach
	s(12); // detached write, closure only
	expect(s()).toBe(12);
	expect(runs).toBe(2);
});

test('a dropped detached value is garbage once the callable goes (obligations 1, 24)', async () => {
	expect(typeof gc).toBe('function');
	let heavy: object | undefined = { big: new Array(64).fill(0) };
	const ref = new WeakRef(heavy);
	let s: ReturnType<typeof signal<object>> | undefined = signal(heavy);
	heavy = undefined;
	// Attach then detach: the value rides record -> closure and the hook
	// environment must not stay pinned anywhere after the detach + drop.
	const stop = effect(() => {
		s!();
	});
	stop();
	await drainMaintenance(); // sweep the reclaimed record
	s = undefined;
	await collect();
	expect(ref.deref()).toBe(undefined);
});

test('write inside an open batch, then stop the last consumer, then end the batch (obligation 3)', () => {
	const s = signal(0);
	const stop = effect(() => {
		s();
	});
	startBatch();
	s(5); // staged in pendingVals, not yet committed
	stop(); // detach inside the batch: copies the NEWEST accepted value
	endBatch();
	expect(s()).toBe(5);
});

test('manual effect mode with an unflushed write preserves the staged value (obligation 3)', () => {
	const prev = setEffectMode('manual');
	try {
		const s = signal(0);
		const stop = effect(() => {
			s();
		});
		s(7); // no flush in manual mode
		stop();
		expect(s()).toBe(7);
	} finally {
		setEffectMode(prev);
	}
});

test('detached write then first tracked read; no spurious rerun on the first equal write (obligation 5)', () => {
	const s = signal(0);
	s(42); // detached write: closure only
	let runs = 0;
	const stop = effect(() => {
		runs++;
		s();
	});
	expect(runs).toBe(1);
	s(42); // equal to the seeded value: both columns were seeded, no wave
	expect(runs).toBe(1);
	s(43);
	expect(runs).toBe(2);
	stop();
});

test('attach/detach/re-attach churn, across a growth boundary (obligation 6)', () => {
	const s = signal(0);
	for (let i = 1; i <= 3; i++) {
		const stop = effect(() => {
			s();
		});
		s(i);
		stop();
		expect(s()).toBe(i);
	}
	growCapacity(6 * 1024 * 1024); // migrate the arena mid-churn
	const stop = effect(() => {
		s();
	});
	s(99);
	stop();
	expect(s()).toBe(99);
});

test('re-read between detach and the boundary sweep attaches a fresh record (obligation 7)', async () => {
	const s = signal(0);
	const stop1 = effect(() => {
		s();
	});
	stop1(); // detach: the old record is queued, not yet swept
	let seen = -1;
	const stop2 = effect(() => {
		seen = s()!;
	}); // fresh attach before the sweep
	s(7);
	expect(seen).toBe(7);
	await drainMaintenance(); // the queued record sweeps without incident
	s(8);
	expect(seen).toBe(8);
	stop2();
});

test('scoped default callables are not region-owned (obligations 9, 15)', async () => {
	let s!: ReturnType<typeof signal<number>>;
	const stop = effectScope(() => {
		s = signal(3);
		effect(() => {
			s();
		});
	});
	stop(); // scope death detaches; the region must NOT free the record too
	await drainMaintenance();
	expect(s()).toBe(3); // a working detached signal
	s(4);
	expect(s()).toBe(4);
});

test('a consumer OUTSIDE the scope keeps its subscription across scope disposal (obligation 15)', () => {
	let s!: ReturnType<typeof signal<number>>;
	const scopeStop = effectScope(() => {
		s = signal(1);
		effect(() => {
			s();
		});
	});
	let outerSeen = 0;
	const outerStop = effect(() => {
		outerSeen = s()!;
	});
	scopeStop(); // inner consumer dies; the outer link keeps the record attached
	s(2);
	expect(outerSeen).toBe(2);
	outerStop();
});

test('reset() refuses inside an open batch and detaches attached callables at quiescence (obligations 10, 21)', () => {
	startBatch();
	expect(() => reset()).toThrow(/open batch/);
	endBatch();

	const attached = signal(1);
	const neverAttached = signal(2);
	effect(() => {
		attached();
	});
	attached(5);
	reset();
	// The documented contract: every default callable survives reset as a
	// working detached signal holding its newest accepted value.
	expect(attached()).toBe(5);
	expect(neverAttached()).toBe(2);
	attached(6);
	expect(attached()).toBe(6);
});

test('trigger churn over a detachable signal recycles records (obligation 20 smoke)', () => {
	const s = signal({ n: 0 });
	// Each iteration attaches (record + link) inside the trigger frame and
	// detaches at its teardown; the quiescent sweep at each trigger return
	// keeps the backlog bounded. 50k iterations would exhaust any leak of
	// record ids into unswept territory long before this completes.
	for (let i = 0; i < 50_000; i++) {
		trigger(() => {
			s();
		});
	}
	expect(s()!.n).toBe(0);
});

test('double detach dispatch is a no-op via the cleared hook (obligation 11)', () => {
	// Two consumers, disposed re-entrantly: the second unwatched-style path
	// (stop2 inside stop1's teardown) must find the hook already cleared or
	// the record still attached — never a double free.
	const s = signal(0);
	let stop2!: () => void;
	const stop1 = effect(() => {
		s();
		return () => {
			stop2();
		};
	});
	stop2 = effect(() => {
		s();
	});
	stop1(); // cleanup disposes stop2: both links unlink, one detach
	s(1);
	expect(s()).toBe(1);
	// Re-attach cleanly afterwards.
	let seen = 0;
	const stop3 = effect(() => {
		seen = s()!;
	});
	s(2);
	expect(seen).toBe(2);
	stop3();
});
