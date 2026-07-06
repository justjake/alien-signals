import { expect, test } from 'vitest';
import { createReactiveSystem } from '../src/system';

// The composable kit: id-shaped link/unlink/propagate/shallowPropagate plus
// the start/stop watched lifecycle. Together with notify/runEffect these are
// the seams a host needs to build its own framework on the system.

test('link returns the edge id; the same pair returns the same id', () => {
	const sys = createReactiveSystem({ initialRecords: 4096 });
	const s = sys.signal(1);
	let runs = 0;
	const e = sys.effect(() => {
		runs++; // tracks nothing: manual edges only
	});
	expect(runs).toBe(1);
	const l1 = sys.link(s, e);
	const l2 = sys.link(s, e);
	expect(l1).toBe(l2);
	sys.signalWrite(s, 2);
	expect(runs).toBe(2); // manual edge delivered the update
});

test('unlink(linkId) removes the edge', () => {
	const sys = createReactiveSystem({ initialRecords: 4096 });
	const s = sys.signal(1);
	let runs = 0;
	const e = sys.effect(() => {
		runs++;
	});
	const l = sys.link(s, e);
	sys.signalWrite(s, 2);
	expect(runs).toBe(2);
	sys.unlink(l);
	sys.signalWrite(s, 3);
	expect(runs).toBe(2); // no longer subscribed
});

test('manual edges age out when the subscriber re-tracks', () => {
	const sys = createReactiveSystem({ initialRecords: 4096 });
	const tracked = sys.signal(0);
	const manual = sys.signal(0);
	let runs = 0;
	const e = sys.effect(() => {
		sys.signalRead(tracked);
		runs++;
	});
	sys.link(manual, e);
	sys.signalWrite(manual, 1);
	expect(runs).toBe(2); // manual edge fired, effect re-tracked
	sys.signalWrite(manual, 2);
	expect(runs).toBe(2); // re-track dropped the manual edge (upstream parity)
	sys.signalWrite(tracked, 1);
	expect(runs).toBe(3); // tracked edge still live
});

test('propagate + shallowPropagate invalidate out-of-band changes', () => {
	const sys = createReactiveSystem({ initialRecords: 4096 });
	let external = 1;
	const src = sys.signal(0); // stands in for the external resource
	const c = sys.computed(() => {
		sys.signalRead(src);
		return external * 10;
	});
	let seen = 0;
	sys.effect(() => {
		seen = sys.computedRead(c) as number;
	});
	expect(seen).toBe(10);

	external = 2;
	// No signal write happened: quiet-read stamps still consider c current.
	expect(sys.computedRead(c)).toBe(10);
	// Out-of-band invalidation: mark downstream stale, promote direct
	// subscribers to dirty, effects flush (write parity).
	sys.startBatch();
	sys.propagate(src);
	sys.shallowPropagate(src);
	sys.endBatch();
	expect(seen).toBe(20); // effect re-ran
	expect(sys.computedRead(c)).toBe(20); // stamp was invalidated
});

test('start fires on first subscriber only; stop on last unlink with state', () => {
	const events: string[] = [];
	const sys = createReactiveSystem({
		initialRecords: 4096,
		start: (id, js) => {
			events.push(`start:${js}`);
			return { token: js };
		},
		stop: (id, js, state) => {
			events.push(`stop:${js}:${(state as { token: unknown }).token}`);
		},
	});
	const s = sys.makeSignal('res');
	let d1: (() => void) | undefined;
	let d2: (() => void) | undefined;
	d1 = sys.makeEffect(() => {
		s();
	});
	d2 = sys.makeEffect(() => {
		s();
	});
	// Effects are watched nodes themselves (started if they gain parents);
	// standalone effects have no subscribers, so only the signal starts.
	expect(events).toEqual(['start:res']);
	d1();
	expect(events).toEqual(['start:res']); // still one subscriber left
	d2();
	expect(events).toEqual(['start:res', 'stop:res:res']);
});

test('re-running an effect does not churn start/stop for kept deps', () => {
	const events: string[] = [];
	const sys = createReactiveSystem({
		initialRecords: 4096,
		start: (id, js) => {
			events.push(`start:${js}`);
			return js;
		},
		stop: (id, js) => {
			events.push(`stop:${js}`);
		},
	});
	const s = sys.makeSignal('a');
	sys.makeEffect(() => {
		s();
	});
	expect(events).toEqual(['start:a']);
	(s as (v: string) => void)('b'); // effect re-runs, keeps the dep
	expect(events).toEqual(['start:a']);
});

test('conditionally dropped deps get stop; re-observing restarts', () => {
	const events: string[] = [];
	const sys = createReactiveSystem({
		initialRecords: 4096,
		start: (id, js) => {
			events.push(`start:${js}`);
			return js;
		},
		stop: (id, js) => {
			events.push(`stop:${js}`);
		},
	});
	const which = sys.makeSignal(true);
	const a = sys.makeSignal('a');
	const b = sys.makeSignal('b');
	sys.makeEffect(() => {
		if (which() as boolean) {
			a();
		} else {
			b();
		}
	});
	expect(events).toEqual(['start:true', 'start:a']);
	events.length = 0;
	(which as (v: boolean) => void)(false);
	expect(events).toContain('start:b');
	expect(events).toContain('stop:a');
});

test('reset() delivers stop for every started node, newest first', () => {
	const events: string[] = [];
	const sys = createReactiveSystem({
		initialRecords: 4096,
		start: (id, js) => {
			events.push(`start:${js}`);
			return js;
		},
		stop: (id, js) => {
			events.push(`stop:${js}`);
		},
	});
	const s1 = sys.makeSignal('one');
	const s2 = sys.makeSignal('two');
	sys.makeEffect(() => {
		s1();
		s2();
	});
	events.length = 0;
	sys.reset();
	expect(events).toEqual(['stop:two', 'stop:one']);
});

test('computeds pass their getter as js', () => {
	let startedJs: unknown;
	const sys = createReactiveSystem({
		initialRecords: 4096,
		start: (id, js) => {
			startedJs = js;
			return undefined;
		},
	});
	const getter = () => 42;
	const c = sys.computed(getter);
	let seen = 0;
	sys.makeEffect(() => {
		seen = sys.computedRead(c) as number;
	});
	expect(seen).toBe(42);
	expect(startedJs).toBe(getter);
});

test('start/stop survive arena growth', () => {
	const events: string[] = [];
	const sys = createReactiveSystem({
		initialRecords: 64,
		start: (id, js) => {
			events.push('start');
			return 'state';
		},
		stop: (id, js, state) => {
			events.push(`stop:${state}`);
		},
	});
	const s = sys.makeSignal(0);
	const stopEffect = sys.makeEffect(() => {
		s();
	});
	expect(events).toEqual(['start']);
	for (let i = 0; i < 500; i++) {
		sys.makeSignal(i); // force growth while the resource is live
	}
	stopEffect();
	expect(events).toEqual(['start', 'stop:state']);
});
