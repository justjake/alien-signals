import { createReactiveSystem, ReactiveFlags } from '../../src/system';
import type { NodeId, ReactiveSystem, ReactiveSystemOptions } from '../../src/system';

// A minimal userspace kind library for system-level tests: the smallest
// signal/computed/effect that drives every core seam (update, notify, flush,
// verbs). Mirrors src/index.ts's architecture without its policy depth.

export const SIG = 1 << 16;
export const COMP = 2 << 16;
export const EFF = 3 << 16;

export function makeMiniLib(options?: Omit<ReactiveSystemOptions, 'update' | 'notify' | 'flush'>) {
	const nodes: any[] = [];
	const queue: Array<[NodeId, number]> = [];
	const notified: number[] = [];
	let draining = false;

	const sys: ReactiveSystem = createReactiveSystem({
		...options,
		start(id) {
			return options?.start !== undefined ? options.start(id) : undefined;
		},
		stop(id, state) {
			// Library policy on unwatch (mirrors src/index.ts): a computed
			// that lost its last subscriber drops its deps and goes dirty.
			if ((sys.nodeFlags(id) & (15 << 16)) === COMP) {
				sys.beginTracking(id);
				sys.endTracking(id);
				sys.markDirty(id);
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
			if ((flags & (15 << 16)) === SIG) {
				return st.current !== (st.current = st.pending);
			}
			return recompute(id, st);
		},
		notify(id, gen) {
			notified.push(id);
			queue.push([id, gen]);
		},
		flush: () => drain(),
	});

	function recompute(id: NodeId, st: any): boolean {
		const prevSub = sys.setActiveSub(id);
		sys.beginTracking(id);
		try {
			const old = st.value;
			return old !== (st.value = st.getter());
		} finally {
			sys.setActiveSub(prevSub);
			sys.endTracking(id);
		}
	}

	function drain(): void {
		if (draining || sys.getBatchDepth()) {
			return;
		}
		draining = true;
		try {
			while (queue.length) {
				const [id, gen] = queue.shift()!;
				if (sys.gen(id) !== gen) {
					continue;
				}
				const st = nodes[id >> 3];
				if (st === undefined) {
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
				sys.setNodeFlags(id, sys.nodeFlags(id) | ReactiveFlags.Watching);
			}
		} finally {
			draining = false;
		}
	}

	function signal<T>(v: T): { (): T; (v: T): void } {
		const st = { current: v, pending: v };
		const oper = (...a: [T?]): T | void => {
			if (a.length) {
				if (st.pending !== (st.pending = a[0] as T)) {
					sys.markDirty(id);
					sys.propagate(id);
				}
			} else {
				if (sys.nodeFlags(id) & ReactiveFlags.Dirty) {
					sys.setNodeFlags(id, sys.nodeFlags(id) & ~ReactiveFlags.Dirty);
					if (st.current !== (st.current = st.pending)) {
						sys.shallowPropagate(id);
					}
				}
				sys.track(id);
				return st.current;
			}
		};
		const id = sys.custom(SIG | ReactiveFlags.Mutable, oper);
		nodes[id >> 3] = st;
		return oper as { (): T; (v: T): void };
	}

	function computed<T>(getter: () => T): () => T {
		const st = { value: undefined as T, getter, evaluated: false };
		const oper = (): T => {
			if (!sys.verified(id)) {
				if (sys.verify(id)) {
					if (recompute(id, st)) {
						sys.shallowPropagate(id);
					}
					st.evaluated = true;
				} else if (!st.evaluated) {
					st.evaluated = true;
					recompute(id, st);
				}
			}
			sys.track(id);
			return st.value;
		};
		const id = sys.custom(COMP | ReactiveFlags.Mutable, oper);
		nodes[id >> 3] = st;
		return oper;
	}

	function effect(fn: () => void | (() => void)): () => void {
		const st = { fn, cleanup: undefined as (() => void) | void };
		const id = sys.custom(EFF | ReactiveFlags.Watching);
		const gen = sys.gen(id);
		nodes[id >> 3] = st;
		const prevSub = sys.setActiveSub(id);
		sys.beginTracking(id);
		try {
			st.cleanup = fn();
		} finally {
			sys.setActiveSub(prevSub);
			sys.endTracking(id);
		}
		return () => {
			if (st.cleanup) {
				st.cleanup();
			}
			nodes[id >> 3] = undefined;
			sys.free(id, gen);
		};
	}

	return { sys, nodes, notified, drain, signal, computed, effect };
}
