import { expect, test } from 'vitest';
import { createReactiveSystem, ReactiveFlags } from '../src/system';
import type { NodeId, ReactiveSystem } from '../src/system';

// THE PROOF for the userspace-kinds architecture: signal, computed, and
// effect implemented entirely outside core — host bits for dispatch, host
// objects for state, the update seam for resolution, notify for scheduling,
// verify/track/markDirty/beginTracking/endTracking as the verbs. Core never
// learns what these nodes mean. If this file passes, "signal" and
// "computed" are userspace concepts (upstream parity), with the built-in
// library as the optimized default.

const SIG = 1 << 16;
const COMP = 2 << 16;
const EFF = 3 << 16;
const KIND = 15 << 16;

function makeUserspace() {
	const nodes: any[] = []; // host id -> state; dense, host-owned
	const queue: Array<[NodeId, number]> = [];

	const sys: ReactiveSystem = createReactiveSystem({
		initialRecords: 1 << 16,
		update(id, flags) {
			const st = nodes[id >> 3];
			if ((flags & KIND) === SIG) {
				return st.current !== (st.current = st.pending);
			}
			return recompute(id, st); // COMP
		},
		notify(id, gen) {
			queue.push([id, gen]); // NEVER run effects here: we are mid-walk
		},
	});

	function recompute(id: NodeId, st: any): boolean {
		const prevSub = sys.setActiveSub(id);
		sys.beginTracking(id);
		try {
			const old = st.value;
			return old !== (st.value = st.getter(old));
		} finally {
			sys.setActiveSub(prevSub);
			sys.endTracking(id);
		}
	}

	function drain() {
		while (queue.length && !sys.getBatchDepth()) {
			const [id, gen] = queue.shift()!;
			if (sys.gen(id) !== gen) continue; // freed while queued
			const st = nodes[id >> 3];
			if (st === undefined) {
				// not ours: a BUILT-IN effect in the same system (a host
				// notify scheduler owns every effect's scheduling)
				sys.runEffect(id, gen);
				continue;
			}
			if (sys.verify(id)) {
				st.cleanup?.();
				const prevSub = sys.setActiveSub(id);
				sys.beginTracking(id);
				try {
					st.cleanup = st.fn();
				} finally {
					sys.setActiveSub(prevSub);
					sys.endTracking(id);
				}
			}
			// re-arm notification (notify's dedup cleared WATCHING)
			sys.setNodeFlags(id, sys.nodeFlags(id) | ReactiveFlags.Watching);
		}
	}

	function signal<T>(v: T) {
		const st = { current: v, pending: v };
		const oper = (...a: [T?]): T | void => {
			if (a.length) {
				if (st.pending !== (st.pending = a[0] as T)) {
					sys.markDirty(id);
					sys.propagate(id);
					drain();
				}
			} else {
				if (sys.nodeFlags(id) & ReactiveFlags.Dirty) {
					// commit-on-read (batched writes)
					if (st.current !== (st.current = st.pending)) {
						sys.setNodeFlags(id, sys.nodeFlags(id) & ~ReactiveFlags.Dirty);
						sys.shallowPropagate(id);
					} else {
						sys.setNodeFlags(id, sys.nodeFlags(id) & ~ReactiveFlags.Dirty);
					}
				}
				sys.track(id);
				return st.current;
			}
		};
		const id = sys.custom(SIG, oper);
		nodes[id >> 3] = st;
		return oper as { (): T; (v: T): void };
	}

	function computed<T>(getter: (prev?: T) => T) {
		const st = { value: undefined as T, getter, evaluated: false };
		const oper = (): T => {
			if (!sys.verified(id)) { // the implicit-stamp fast gate
				if (sys.verify(id)) {
					if (recompute(id, st)) {
						sys.shallowPropagate(id);
					}
				} else if (!st.evaluated) {
					recompute(id, st);
				}
				st.evaluated = true;
			}
			sys.track(id);
			return st.value;
		};
		const id = sys.custom(COMP, oper);
		nodes[id >> 3] = st;
		return oper;
	}

	function effect(fn: () => void | (() => void)) {
		const st = { fn, cleanup: undefined as (() => void) | undefined };
		const id = sys.custom(EFF);
		const gen = sys.gen(id);
		nodes[id >> 3] = st;
		sys.setNodeFlags(id, sys.nodeFlags(id) | ReactiveFlags.Watching);
		const prevSub = sys.setActiveSub(id);
		sys.beginTracking(id);
		try {
			st.cleanup = fn() as (() => void) | undefined;
		} finally {
			sys.setActiveSub(prevSub);
			sys.endTracking(id);
		}
		return () => {
			st.cleanup?.();
			sys.free(id, gen);
			nodes[id >> 3] = undefined;
		};
	}

	const batch = (fn: () => void) => {
		sys.startBatch();
		try {
			fn();
		} finally {
			sys.endBatch();
			drain();
		}
	};

	return { sys, signal, computed, effect, batch, drain };
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

test('INTEROP: built-in computed over a userspace signal', () => {
	const { sys, signal } = makeUserspace();
	const s = signal(2);
	const builtin = sys.makeComputed(() => (s() as number) * 100);
	let seen = 0;
	sys.makeEffect(() => {
		seen = builtin() as number;
	});
	expect(seen).toBe(200);
	s(3); // custom write -> walks -> update seam commits -> built-in recomputes
	expect(seen).toBe(300);
});

test('INTEROP: userspace computed over a built-in signal', () => {
	const us = makeUserspace();
	const base = us.sys.makeSignal(5);
	const c = us.computed(() => (base() as number) + 1);
	let seen = 0;
	let runs = 0;
	us.effect(() => {
		seen = c();
		runs++;
	});
	expect(seen).toBe(6);
	(base as (v: number) => void)(9); // built-in write notifies the userspace effect
	us.drain();
	expect(seen).toBe(10);
	expect(runs).toBe(2);
});
