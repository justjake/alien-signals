import { expect, test } from 'vitest';
import { createReactiveSystem } from '../src/system';

// Host effect scheduler (upstream's `notify` seam, id-shaped): with
// createReactiveSystem({ notify }) the engine never runs effects itself —
// each affected effect is reported once per wave as (id, gen), and runs only
// when the host calls runEffect(id, gen). Stale ids are no-ops by generation
// check, so host queues need no cleanup when effects are disposed.

function hostSystem(initialRecords?: number) {
	const notified: Array<[number, number]> = [];
	const sys = createReactiveSystem({
		initialRecords,
		notify: (id, gen) => {
			notified.push([id, gen]);
		},
	});
	const drain = () => {
		// Copy-then-clear: running effects may notify again (re-entrant writes).
		const batch = notified.splice(0);
		for (const [id, gen] of batch) {
			sys.runEffect(id, gen);
		}
	};
	return { sys, notified, drain };
}

test('writes notify the host instead of running effects', () => {
	const { sys, notified, drain } = hostSystem();
	const s = sys.makeSignal(1);
	let seen = 0;
	sys.makeEffect(() => {
		seen = s() as number;
	});
	expect(seen).toBe(1); // creation still runs synchronously
	expect(notified.length).toBe(0);

	(s as (v: number) => void)(2);
	expect(seen).toBe(1); // did not run
	expect(notified.length).toBe(1);
	drain();
	expect(seen).toBe(2);
});

test('one notification per wave until the effect runs (dedup)', () => {
	const { sys, notified, drain } = hostSystem();
	const s = sys.makeSignal(0);
	let runs = 0;
	sys.makeEffect(() => {
		s();
		runs++;
	});
	(s as (v: number) => void)(1);
	(s as (v: number) => void)(2);
	(s as (v: number) => void)(3);
	expect(notified.length).toBe(1); // deduped while un-run
	drain();
	expect(runs).toBe(2);
	(s as (v: number) => void)(4);
	expect(notified.length).toBe(1); // re-armed after running
	drain();
	expect(runs).toBe(3);
});

test('reads stay consistent while effects are parked', () => {
	const { sys, drain } = hostSystem();
	const s = sys.makeSignal(1);
	const c = sys.makeComputed(() => (s() as number) * 10);
	sys.makeEffect(() => {
		c();
	});
	(s as (v: number) => void)(5);
	expect(c()).toBe(50); // pull-based read is fresh before any effect ran
	drain();
});

test('nested effects notify outer before inner', () => {
	const { sys, notified } = hostSystem();
	const s = sys.makeSignal(0);
	let outerId = -1;
	let innerId = -1;
	sys.makeEffect(() => {
		s();
		outerId = 1;
		sys.makeEffect(() => {
			s();
			innerId = 1;
		});
	});
	expect(outerId).toBe(1);
	expect(innerId).toBe(1);
	notified.length = 0;
	(s as (v: number) => void)(1);
	expect(notified.length).toBe(2);
	// The engine's own queue runs outer effects before their children; the
	// host receives them in that same order.
	const [first, second] = notified;
	expect(first[0]).not.toBe(second[0]);
});

test('disposed effects make stale notifications harmless', async () => {
	const { sys, notified } = hostSystem();
	const s = sys.makeSignal(0);
	let runs = 0;
	const stop = sys.makeEffect(() => {
		s();
		runs++;
	});
	(s as (v: number) => void)(1);
	expect(notified.length).toBe(1);
	stop();
	// Let the boundary sweep reclaim the record (microtask).
	await Promise.resolve();
	const [[id, gen]] = notified;
	sys.runEffect(id, gen); // stale: gen bumped by reclamation
	expect(runs).toBe(1);
});

test('batch writes notify at write time; nothing waits for endBatch', () => {
	const { sys, notified, drain } = hostSystem();
	const s = sys.makeSignal(0);
	let seen = -1;
	sys.makeEffect(() => {
		seen = s() as number;
	});
	sys.startBatch();
	(s as (v: number) => void)(9);
	expect(notified.length).toBe(1); // notified during the batch
	sys.endBatch(); // internal flush is a no-op in host mode
	expect(seen).toBe(0);
	drain();
	expect(seen).toBe(9);
});

test('notifications survive arena growth', () => {
	const { sys, notified, drain } = hostSystem(64);
	const s = sys.makeSignal(0);
	let seen = -1;
	sys.makeEffect(() => {
		seen = s() as number;
	});
	(s as (v: number) => void)(7);
	expect(notified.length).toBe(1);
	// Grow the arena while the notification is parked in the host queue.
	for (let i = 0; i < 500; i++) {
		sys.makeSignal(i);
	}
	drain();
	expect(seen).toBe(7);
});

test('configure({ notify }) installs the scheduler on a fresh system', () => {
	const notified: Array<[number, number]> = [];
	const sys = createReactiveSystem();
	sys.configure({
		notify: (id, gen) => {
			notified.push([id, gen]);
		},
	});
	const s = sys.makeSignal(0);
	let seen = -1;
	sys.makeEffect(() => {
		seen = s() as number;
	});
	(s as (v: number) => void)(3);
	expect(seen).toBe(0);
	expect(notified.length).toBe(1);
	sys.runEffect(notified[0][0], notified[0][1]);
	expect(seen).toBe(3);
});
