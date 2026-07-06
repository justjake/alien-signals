import { Arena, Flag, LinkSlot, NodeSlot, SysSlot, createReactiveSystem } from '../../src/system';
import type { LinkId, ReactiveArena, SignalGen, SignalId, ReactiveSystemOptions } from '../../src/system';

// A minimal userspace kind library for system-level tests: the smallest
// signal/computed/effect built the way src/index.ts is built — host-owned
// tracking state and direct record writes over the five raw graph ops.
// Mirrors src/index.ts's architecture without its policy depth.

export const SIG = 1 << Flag.HostShift;
export const COMP = 2 << Flag.HostShift;
export const EFF = 3 << Flag.HostShift;
const KIND = 15 << Flag.HostShift;
const HIDDEN = ~Flag.PublicMask;

export function makeMiniLib(options?: Omit<ReactiveSystemOptions, 'update' | 'notify' | 'allocated'>) {
	const nodes: any[] = [];
	const queue: Array<[SignalId, SignalGen]> = [];
	const notified: number[] = [];
	let activeSub: SignalId = 0 as SignalId;
	let batchDepth = 0;
	let cycle = 0;
	let globalVersion = 1;
	let draining = false;

	const sys = createReactiveSystem({
		...options,
		allocated(arena) {
			({ memory: M, versions: D, link, unlink, propagate, checkDirty, shallowPropagate } = arena);
		},
		watched(id) {
			return options?.watched !== undefined ? options.watched(id) : undefined;
		},
		unwatched(id, state) {
			// Library policy on unwatch (mirrors src/index.ts): a computed
			// that lost its last subscriber drops its deps and goes dirty.
			if ((M[id + NodeSlot.Flags] & KIND) === COMP) {
				M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & HIDDEN) | Flag.Mutable | Flag.Dirty;
				D[(id >> Arena.VersionShift) + Arena.VersionOffset] = 0;
				let l = M[id + NodeSlot.DepsTail] as LinkId;
				while (l !== 0) {
					const prev = M[l + LinkSlot.PrevDep] as LinkId;
					unlink(l, id);
					l = prev;
				}
			}
			if (options?.unwatched !== undefined) {
				options.unwatched(id, state);
			}
		},
		update(id, flags) {
			const st = nodes[id >> Arena.NodeIndexShift];
			if (st === undefined) {
				return true;
			}
			if ((flags & KIND) === SIG) {
				M[id + NodeSlot.Flags] = (flags & HIDDEN) | Flag.Mutable;
				return st.current !== (st.current = st.pending);
			}
			return recompute(id, st);
		},
		notify(id, gen) {
			notified.push(id);
			queue.push([id, gen]);
		},
	});

	// The arena views and the five ops, bound by the allocated callback at
	// materialization and after every growth. Materialize eagerly — fine
	// for tests.
	let M!: Int32Array;
	let D!: Float64Array;
	let link!: ReactiveArena['link'];
	let unlink!: ReactiveArena['unlink'];
	let propagate!: ReactiveArena['propagate'];
	let checkDirty!: ReactiveArena['checkDirty'];
	let shallowPropagate!: ReactiveArena['shallowPropagate'];
	sys.configure();

	function purgeDeps(sub: SignalId): void {
		const depsTail = M[sub + NodeSlot.DepsTail] as LinkId;
		let l: LinkId = depsTail !== 0 ? (M[depsTail + LinkSlot.NextDep] as LinkId) : (M[sub + NodeSlot.Deps] as LinkId);
		while (l !== 0) {
			l = unlink(l, sub);
		}
	}

	// The host-owned re-track bracket (upstream's updateComputed shape).
	function recompute(id: SignalId, st: any): boolean {
		M[id + NodeSlot.DepsTail] = 0;
		M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & HIDDEN) | Flag.Mutable | Flag.RecursedCheck;
		const prevSub = activeSub;
		activeSub = id;
		++cycle;
		++M[SysSlot.EnterDepth];
		const entryVersion = globalVersion;
		try {
			const old = st.value;
			const changed = old !== (st.value = st.getter(old));
			D[(id >> Arena.VersionShift) + Arena.VersionOffset] = entryVersion;
			return changed;
		} finally {
			--M[SysSlot.EnterDepth];
			activeSub = prevSub;
			M[id + NodeSlot.Flags] &= ~Flag.RecursedCheck;
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
				if (M[id + NodeSlot.Gen] !== gen) {
					continue;
				}
				const st = nodes[id >> Arena.NodeIndexShift];
				if (st === undefined) {
					continue;
				}
				const flags = M[id + NodeSlot.Flags];
				if (flags & Flag.Dirty || (flags & Flag.Pending && checkDirty(M[id + NodeSlot.Deps] as LinkId, id))) {
					st.cleanup?.();
					st.cleanup = undefined;
					M[id + NodeSlot.DepsTail] = 0;
					M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & HIDDEN) | Flag.Watching | Flag.RecursedCheck;
					const prevSub = activeSub;
					activeSub = id;
					++cycle;
					++M[SysSlot.EnterDepth];
					try {
						st.cleanup = st.fn();
					} finally {
						--M[SysSlot.EnterDepth];
						activeSub = prevSub;
						M[id + NodeSlot.Flags] &= ~Flag.RecursedCheck;
						purgeDeps(id);
					}
				} else {
					// Verified clean, not run: clear Pending, re-arm Watching.
					M[id + NodeSlot.Flags] = (flags & HIDDEN) | Flag.Watching;
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
					M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & HIDDEN) | Flag.Mutable | Flag.Dirty;
					++globalVersion;
					const subs = M[id + NodeSlot.Subs] as LinkId;
					if (subs !== 0) {
						propagate(subs, false);
						if (!batchDepth) {
							drain();
						}
					}
				}
			} else {
				const flags = M[id + NodeSlot.Flags];
				if (flags & Flag.Dirty) {
					M[id + NodeSlot.Flags] = (flags & HIDDEN) | Flag.Mutable;
					if (st.current !== (st.current = st.pending)) {
						const subs = M[id + NodeSlot.Subs] as LinkId;
						if (subs !== 0) {
							shallowPropagate(subs);
						}
					}
				}
				if (activeSub !== 0) {
					link(id, activeSub, cycle);
				}
				return st.current;
			}
		};
		const id = sys.createReactiveNode(oper, SIG | Flag.Mutable);
		nodes[id >> Arena.NodeIndexShift] = st;
		return oper as { (): T; (v: T): void };
	}

	function computed<T>(getter: () => T): () => T {
		const st = { value: undefined as T, getter };
		const oper = (): T => {
			// The quiet-read stamp gate, then upstream's computedOper ladder.
			if (D[(id >> Arena.VersionShift) + Arena.VersionOffset] !== globalVersion) {
				const flags = M[id + NodeSlot.Flags];
				if (flags & Flag.Dirty) {
					if (recompute(id, st)) {
						const subs = M[id + NodeSlot.Subs] as LinkId;
						if (subs !== 0) {
							shallowPropagate(subs);
						}
					}
				} else if (flags & Flag.Pending) {
					const entryVersion = globalVersion;
					if (checkDirty(M[id + NodeSlot.Deps] as LinkId, id)) {
						if (recompute(id, st)) {
							const subs = M[id + NodeSlot.Subs] as LinkId;
							if (subs !== 0) {
								shallowPropagate(subs);
							}
						}
					} else {
						M[id + NodeSlot.Flags] = flags & ~Flag.Pending;
						D[(id >> Arena.VersionShift) + Arena.VersionOffset] = entryVersion;
					}
				}
			}
			if (activeSub !== 0) {
				link(id, activeSub, cycle);
			}
			return st.value;
		};
		// Minted Dirty: the first read takes the update path.
		const id = sys.createReactiveNode(oper, COMP | Flag.Mutable | Flag.Dirty);
		nodes[id >> Arena.NodeIndexShift] = st;
		return oper;
	}

	function effect(fn: () => void | (() => void)): () => void {
		const st = { fn, cleanup: undefined as (() => void) | void };
		const id = sys.createReactiveNode(st, EFF | Flag.Watching | Flag.RecursedCheck);
		const gen = M[id + NodeSlot.Gen] as SignalGen;
		nodes[id >> Arena.NodeIndexShift] = st;
		const prevSub = activeSub;
		activeSub = id;
		++M[SysSlot.EnterDepth];
		try {
			st.cleanup = fn();
		} finally {
			--M[SysSlot.EnterDepth];
			activeSub = prevSub;
			M[id + NodeSlot.Flags] &= ~Flag.RecursedCheck;
		}
		return () => {
			const live = nodes[id >> Arena.NodeIndexShift];
			if (live === undefined || M[id + NodeSlot.Gen] !== gen) {
				return;
			}
			// Graph teardown is free()'s job ALONE (see src/index.ts).
			nodes[id >> Arena.NodeIndexShift] = undefined;
			sys.free(id, gen);
			live.cleanup?.();
		};
	}

	return { sys, nodes, notified, drain, startBatch, endBatch, signal, computed, effect };
}
