import { expect, test } from 'vitest';
import { makeMiniLib } from './helpers/miniLib';

// THE PROOF for the userspace-kinds architecture: signal, computed, and
// effect implemented entirely outside core — host bits for dispatch, host
// objects for state, host-owned tracking (active subscriber, batching, the
// effect queue), and direct record writes over the five raw graph ops. Core
// never learns what these nodes mean. The host lives in helpers/miniLib.ts;
// if this file passes, "signal" and "computed" are userspace concepts
// (upstream parity), with src/index.ts as the packaged default.

function makeUserspace() {
	const lib = makeMiniLib({ initialCapacity: 1 << 16 });
	const batch = (fn: () => void) => {
		lib.startBatch();
		try {
			fn();
		} finally {
			lib.endBatch();
		}
	};
	return { ...lib, batch };
}

test('userspace signal -> computed -> effect propagates', () => {
	const { signal, computed, effect } = makeUserspace();
	const s = signal(1);
	const c = computed(() => s() * 10);
	let seen = 0;
	let runs = 0;
	effect(() => {
		seen = c();
		runs++;
	});
	expect(seen).toBe(10);
	s(3);
	expect(seen).toBe(30);
	expect(runs).toBe(2);
});

test('diamond is glitch-free: one effect run, consistent values', () => {
	const { signal, computed, effect } = makeUserspace();
	const s = signal(1);
	const a = computed(() => s() + 1);
	const b = computed(() => s() * 2);
	let runs = 0;
	let snapshot = '';
	effect(() => {
		snapshot = `${a()},${b()}`;
		runs++;
	});
	expect(snapshot).toBe('2,2');
	s(5);
	expect(snapshot).toBe('6,10');
	expect(runs).toBe(2);
});

test('equality cut: unchanged computed stops the wave', () => {
	const { signal, computed, effect } = makeUserspace();
	const s = signal(1);
	const clamped = computed(() => Math.min(s(), 5));
	let runs = 0;
	effect(() => {
		clamped();
		runs++;
	});
	s(10);
	expect(runs).toBe(2); // 5 -> clamp hit, changed 1->5
	s(20);
	expect(runs).toBe(2); // still 5: wave dies at the computed
});

test('batch: many writes, one run', () => {
	const { signal, effect, batch } = makeUserspace();
	const s = signal(0);
	let runs = 0;
	effect(() => {
		s();
		runs++;
	});
	batch(() => {
		s(1);
		s(2);
		s(3);
	});
	expect(runs).toBe(2);
});

test('re-tracking drops conditional deps', () => {
	const { signal, effect } = makeUserspace();
	const which = signal(true);
	const a = signal('a');
	const b = signal('b');
	let runs = 0;
	effect(() => {
		if (which()) {
			a();
		} else {
			b();
		}
		runs++;
	});
	which(false);
	expect(runs).toBe(2);
	a('a2'); // no longer tracked
	expect(runs).toBe(2);
	b('b2');
	expect(runs).toBe(3);
});

test('explicit free: disposed userspace effect never reruns', () => {
	const { signal, effect } = makeUserspace();
	const s = signal(0);
	let runs = 0;
	const stop = effect(() => {
		s();
		runs++;
	});
	stop();
	s(1);
	expect(runs).toBe(1);
});

test('quiet re-reads hit the implicit stamp (verified gate)', () => {
	const { sys, signal, computed } = makeUserspace();
	const s = signal(1);
	const c = computed(() => s() + 1);
	let evals = 0;
	const counting = computed(() => {
		evals++;
		return c() * 2;
	});
	counting();
	expect(evals).toBe(1);
	// no writes anywhere: the verified() gate short-circuits everything
	counting();
	counting();
	expect(evals).toBe(1);
	s(2);
	expect(counting()).toBe(6); // (2 + 1) * 2
	expect(evals).toBe(2);
});
