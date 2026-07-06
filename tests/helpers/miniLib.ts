import { createReactiveSystem, ReactiveFlags } from '../../src/system';
import type { LinkId, NodeId, ReactiveSystemOptions } from '../../src/system';

// A minimal userspace kind library for system-level tests: the smallest
// signal/computed/effect built the way src/index.ts is built — host-owned
// tracking state and direct record writes over the five raw graph ops.
// Mirrors src/index.ts's architecture without its policy depth.

export const SIG = 1 << 16;
export const COMP = 2 << 16;
export const EFF = 3 << 16;
const KIND = 15 << 16;

// Record layout twins (tests are cold; plain consts are fine here).
const FLAGS = 0;
const DEPS = 1;
const DEPS_TAIL = 2;
const SUBS = 3;
const GEN = 5;
const L_PREV_DEP = 5;
const L_NEXT_DEP = 6;
const SYS_ENTER = 1;
const SYS_CYCLE = 2;
const SYS_EPOCH = 3;
const HIDDEN = ~127;
const { Mutable, Watching, RecursedCheck, Dirty, Pending } = ReactiveFlags;

export function makeMiniLib(options?: Omit<ReactiveSystemOptions, 'update' | 'notify'>) {
	const nodes: any[] = [];
	const queue: Array<[NodeId, number]> = [];
	const notified: number[] = [];
	let activeSub = 0;
	let batchDepth = 0;
	let draining = false;

	const sys = createReactiveSystem({
		...options,
		start(id) {
			return options?.start !== undefined ? options.start(id) : undefined;
		},
		stop(id, state) {
			// Library policy on unwatch (mirrors src/index.ts): a computed
			// that lost its last subscriber drops its deps and goes dirty.
			if ((M[id + FLAGS] & KIND) === COMP) {
				M[id + FLAGS] = (M[id + FLAGS] & HIDDEN) | Mutable | Dirty;
				D[(id >> 1) + 3] = 0;
				let l = M[id + DEPS_TAIL];
				while (l !== 0) {
					const prev = M[l + L_PREV_DEP];
					unlink(l, id);
					l = prev;
				}
			}
			if (options?.stop !== undefined) {
				options.stop(id, state);
			}
		},
		update(id, flags) {
			const st = nodes[id >> 3];
			if (st === undefined) {
				return true;
			}
			if ((flags & KIND) === SIG) {
				M[id + FLAGS] = (flags & HIDDEN) | Mutable;
				return st.current !== (st.current = st.pending);
			}
			return recompute(id, st);
		},
		notify(id, gen) {
			notified.push(id);
			queue.push([id, gen]);
		},
	});

	// The arena views and the five ops, re-captured whenever growth migrates
	// the graph to a bigger arena. Materializes eagerly — fine for tests.
	let M = sys.buffer();
	let D = sys.stampView();
	let { link, unlink, propagate, checkDirty, shallowPropagate } = sys.e;
	sys.onGrow(() => {
		M = sys.buffer();
		D = sys.stampView();
		({ link, unlink, propagate, checkDirty, shallowPropagate } = sys.e);
	});

	function purgeDeps(sub: NodeId): void {
		const depsTail = M[sub + DEPS_TAIL];
		let l: LinkId = depsTail !== 0 ? M[depsTail + L_NEXT_DEP] : M[sub + DEPS];
		while (l !== 0) {
			l = unlink(l, sub);
		}
	}

	// The host-owned re-track bracket (upstream's updateComputed shape).
	function recompute(id: NodeId, st: any): boolean {
		M[id + DEPS_TAIL] = 0;
		M[id + FLAGS] = (M[id + FLAGS] & HIDDEN) | Mutable | RecursedCheck;
		const prevSub = activeSub;
		activeSub = id;
		++M[SYS_CYCLE];
		++M[SYS_ENTER];
		const entryEpoch = D[SYS_EPOCH];
		try {
			const old = st.value;
			const changed = old !== (st.value = st.getter(old));
			D[(id >> 1) + 3] = entryEpoch;
			return changed;
		} finally {
			--M[SYS_ENTER];
			activeSub = prevSub;
			M[id + FLAGS] &= ~RecursedCheck;
			purgeDeps(id);
		}
	}

	function drain(): void {
		if (draining || batchDepth !== 0) {
			return;
		}
		draining = true;
		try {
			while (queue.length) {
				const [id, gen] = queue.shift()!;
				if (M[id + GEN] !== gen) {
					continue;
				}
				const st = nodes[id >> 3];
				if (st === undefined) {
					continue;
				}
				const flags = M[id + FLAGS];
				if (flags & Dirty || (flags & Pending && checkDirty(M[id + DEPS], id))) {
					st.cleanup?.();
					st.cleanup = undefined;
					M[id + DEPS_TAIL] = 0;
					M[id + FLAGS] = (M[id + FLAGS] & HIDDEN) | Watching | RecursedCheck;
					const prevSub = activeSub;
					activeSub = id;
					++M[SYS_CYCLE];
					++M[SYS_ENTER];
					try {
						st.cleanup = st.fn();
					} finally {
						--M[SYS_ENTER];
						activeSub = prevSub;
						M[id + FLAGS] &= ~RecursedCheck;
						purgeDeps(id);
					}
				} else {
					// Verified clean, not run: clear Pending, re-arm Watching.
					M[id + FLAGS] = (flags & HIDDEN) | Watching;
				}
			}
		} finally {
			draining = false;
		}
	}

	function startBatch(): void {
		++batchDepth;
	}

	function endBatch(): void {
		if (!--batchDepth) {
			drain();
		}
	}

	function signal<T>(v: T): { (): T; (v: T): void } {
		const st = { current: v, pending: v };
		const oper = (...a: [T?]): T | void => {
			if (a.length) {
				if (st.pending !== (st.pending = a[0] as T)) {
					M[id + FLAGS] = (M[id + FLAGS] & HIDDEN) | Mutable | Dirty;
					++D[SYS_EPOCH];
					const subs = M[id + SUBS];
					if (subs !== 0) {
						propagate(subs, false);
						if (!batchDepth) {
							drain();
						}
					}
				}
			} else {
				const flags = M[id + FLAGS];
				if (flags & Dirty) {
					M[id + FLAGS] = (flags & HIDDEN) | Mutable;
					if (st.current !== (st.current = st.pending)) {
						const subs = M[id + SUBS];
						if (subs !== 0) {
							shallowPropagate(subs);
						}
					}
				}
				if (activeSub !== 0) {
					link(id, activeSub, M[SYS_CYCLE]);
				}
				return st.current;
			}
		};
		const id = sys.custom(SIG | Mutable, oper);
		nodes[id >> 3] = st;
		return oper as { (): T; (v: T): void };
	}

	function computed<T>(getter: () => T): () => T {
		const st = { value: undefined as T, getter };
		const oper = (): T => {
			// The quiet-read stamp gate, then upstream's computedOper ladder.
			if (D[(id >> 1) + 3] !== D[SYS_EPOCH]) {
				const flags = M[id + FLAGS];
				if (flags & Dirty) {
					if (recompute(id, st)) {
						const subs = M[id + SUBS];
						if (subs !== 0) {
							shallowPropagate(subs);
						}
					}
				} else if (flags & Pending) {
					const entryEpoch = D[SYS_EPOCH];
					if (checkDirty(M[id + DEPS], id)) {
						if (recompute(id, st)) {
							const subs = M[id + SUBS];
							if (subs !== 0) {
								shallowPropagate(subs);
							}
						}
					} else {
						M[id + FLAGS] = flags & ~Pending;
						D[(id >> 1) + 3] = entryEpoch;
					}
				}
			}
			if (activeSub !== 0) {
				link(id, activeSub, M[SYS_CYCLE]);
			}
			return st.value;
		};
		// Minted Dirty: the first read takes the update path.
		const id = sys.custom(COMP | Mutable | Dirty, oper);
		nodes[id >> 3] = st;
		return oper;
	}

	function effect(fn: () => void | (() => void)): () => void {
		const st = { fn, cleanup: undefined as (() => void) | void };
		const id = sys.custom(EFF | Watching | RecursedCheck);
		const gen = M[id + GEN];
		nodes[id >> 3] = st;
		const prevSub = activeSub;
		activeSub = id;
		++M[SYS_ENTER];
		try {
			st.cleanup = fn();
		} finally {
			--M[SYS_ENTER];
			activeSub = prevSub;
			M[id + FLAGS] &= ~RecursedCheck;
		}
		return () => {
			const live = nodes[id >> 3];
			if (live === undefined || M[id + GEN] !== gen) {
				return;
			}
			// Graph teardown is free()'s job ALONE (see src/index.ts).
			nodes[id >> 3] = undefined;
			sys.free(id, gen);
			live.cleanup?.();
		};
	}

	return { sys, nodes, notified, drain, startBatch, endBatch, signal, computed, effect };
}
