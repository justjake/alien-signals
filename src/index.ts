/**
 * The default signal library, implemented ENTIRELY in userspace: signal,
 * computed, effect, and effectScope are host-defined node kinds built on the
 * system's public seam — custom nodes, the `update` callback, `notify`, and
 * the verify/verified/track/markDirty/beginTracking/endTracking verbs. Core
 * is a kindless graph machine; this file is one client of it (the packaged
 * default), with the same standing as any library a host would write.
 */
import { createReactiveSystem, ReactiveFlags, type NodeId, type ReactiveNode } from './system.js';

// ---- host kind tags (flags bits 16-27, engine-preserved) -------------------

const enum Kind {
	Signal = 1 << 16,
	Computed = 2 << 16,
	Effect = 3 << 16,
	Scope = 4 << 16,
	Mask = 7 << 16,
}

// ---- host node state --------------------------------------------------------

interface SignalState {
	current: unknown;
	pending: unknown;
}

interface ComputedState {
	value: unknown;
	getter: (previousValue?: unknown) => unknown;
	evaluated: boolean;
	children: number[]; // effects created during evaluation; disposal is LIFO
}

interface EffectState {
	fn: () => (() => void) | void;
	cleanup: (() => void) | void;
	children: number[]; // child effects/scopes; disposal is LIFO
	gen: number;
}

// Dense id -> state map (records are 32 bytes; ids are premultiplied by 8).
// Slots are cleared by the same code paths that free records, so the map's
// lifecycle mirrors the arena's exactly.
const nodes: (SignalState | ComputedState | EffectState | undefined)[] = [];

// ---- the system, driven by this library's update + notify -------------------

// The effect queue: notify() hands us affected effects at write time, in the
// order the propagation wave found them (outer effects before their
// children). They run when the operation that queued them completes — after
// a top-level write's propagation, or at the outermost endBatch.
const queue: number[] = [];
const queueGens: number[] = [];
let queueIndex = 0;
let draining = false;
let runDepth = 0;

const system = createReactiveSystem({
	update(id, flags) {
		const st = nodes[id >> 3];
		if (st === undefined) {
			return true; // freed mid-walk: treat as changed, the walk moves on
		}
		if ((flags & Kind.Mask) === Kind.Signal) {
			const sig = st as SignalState;
			return sig.current !== (sig.current = sig.pending);
		}
		return recompute(id, st as ComputedState);
	},
	notify(id, gen) {
		queue.push(id);
		queueGens.push(gen);
	},
	start() {
		return undefined; // presence enables stop() delivery
	},
	stop(id) {
		// A computed that lost its last subscriber: dispose the effects its
		// evaluation created (LIFO), drop its dependency edges, and mark it
		// dirty so the next read re-evaluates against fresh state.
		if ((nodeFlags(id) & (Kind.Mask as number)) === (Kind.Computed as number)) {
			const st = nodes[id >> 3] as ComputedState | undefined;
			if (st !== undefined) {
				disposeChildren(st);
				system.beginTracking(id);
				system.endTracking(id); // empty bracket: purges every dep
				system.markDirty(id);
			}
		}
	},
});

const {
	configure: systemConfigure,
	trigger: systemTrigger,
	getBatchDepth: systemGetBatchDepth,
	getActiveSub: systemGetActiveSub,
	setActiveSub: systemSetActiveSub,
	nodeFlags,
	setNodeFlags,
} = system;

function recompute(id: NodeId, st: ComputedState): boolean {
	// Effects created by the previous evaluation dispose first (LIFO).
	disposeChildren(st);
	const prevSub = systemSetActiveSub(id);
	system.beginTracking(id);
	try {
		const old = st.value;
		return old !== (st.value = st.getter(old));
	} finally {
		systemSetActiveSub(prevSub);
		system.endTracking(id);
	}
}

function drain(): void {
	if (draining) {
		return;
	}
	draining = true;
	let paused = false;
	try {
		while (queueIndex < queue.length) {
			if (systemGetBatchDepth()) {
				paused = true; // a batch opened mid-drain: rest waits for endBatch
				return;
			}
			const id = queue[queueIndex];
			const gen = queueGens[queueIndex++];
			if (system.gen(id) === gen) {
				const st = nodes[id >> 3] as EffectState | undefined;
				if (st !== undefined) {
					runEffect(id, st);
				}
			}
		}
	} finally {
		if (!paused) {
			// Abnormal exit (an effect threw): survivors are re-armed — a
			// change to THEIR dependencies re-notifies them — but the failed
			// flush does not resume on unrelated writes (upstream parity).
			while (queueIndex < queue.length) {
				const id = queue[queueIndex];
				const gen = queueGens[queueIndex++];
				if (system.gen(id) === gen && nodes[id >> 3] !== undefined) {
					setNodeFlags(id, nodeFlags(id) | ReactiveFlags.Watching | ReactiveFlags.Recursed);
				}
			}
			queue.length = 0;
			queueGens.length = 0;
			queueIndex = 0;
		}
		draining = false;
	}
}

function runEffect(id: NodeId, st: EffectState): void {
	if (system.verify(id)) {
		// Children from the previous run dispose first (LIFO), then cleanup.
		disposeChildren(st);
		if (st.cleanup) {
			runCleanup(st);
			if (system.gen(id) !== st.gen || nodes[id >> 3] === undefined) {
				return; // disposed by its own cleanup
			}
		}
		// Re-arm BEFORE running: a write from inside the body (recursed
		// effects clear their own RecursedCheck) must be able to re-notify.
		setNodeFlags(id, nodeFlags(id) | ReactiveFlags.Watching);
		const prevSub = systemSetActiveSub(id);
		system.beginTracking(id);
		++runDepth;
		try {
			st.cleanup = st.fn();
		} finally {
			--runDepth;
			systemSetActiveSub(prevSub);
			system.endTracking(id);
		}
	} else {
		// Verified clean, not run: re-arm what notify's dedup cleared.
		setNodeFlags(id, nodeFlags(id) | ReactiveFlags.Watching);
	}
}

function runCleanup(st: EffectState): void {
	const cleanup = st.cleanup as () => void;
	st.cleanup = undefined;
	const prevSub = systemSetActiveSub(0);
	try {
		cleanup();
	} finally {
		systemSetActiveSub(prevSub);
	}
}

function disposeChildren(st: EffectState | ComputedState): void {
	while (st.children.length !== 0) {
		disposeNode(st.children.pop()!);
	}
}

function disposeNode(id: NodeId): void {
	const st = nodes[id >> 3] as EffectState | undefined;
	if (st === undefined) {
		return; // already disposed
	}
	nodes[id >> 3] = undefined;
	disposeChildren(st);
	if (st.cleanup) {
		runCleanup(st);
	}
	system.free(id, st.gen);
}

// Register a fresh effect/scope with its surrounding parent, if any: the
// parent tracks it for LIFO disposal, and a graph edge keeps ordering (the
// parent's wave reaches children after the parent).
function adopt(id: NodeId): void {
	const parent = systemGetActiveSub();
	if (parent !== 0) {
		const parentSt = nodes[parent >> 3] as EffectState | undefined;
		if (parentSt !== undefined && Array.isArray(parentSt.children)) {
			parentSt.children.push(id);
			system.link(id, parent);
		}
	}
}

// ---- brands ------------------------------------------------------------------
// Every handle of a kind is an instantiation of the SAME closure literal, so
// Function.prototype.toString() is identical across all of them: kind checks
// are a cold string compare that survives keepNames pipelines (the same trick
// the engine used when it owned the handles). anon() keeps the literals in
// argument position so they stay nameless.

let signalSrc: string | undefined;
let computedSrc: string | undefined;
let effectSrc: string | undefined;
let scopeSrc: string | undefined;

function anon<T>(f: T): T {
	return f;
}

// ---- public API ---------------------------------------------------------------

const NODE_ID = Symbol('dalien.nodeId');

/**
 * Live view over a node record: `.flags` reads/writes the semantic flag bits
 * in the record arena (the documented upstream pattern
 * `getActiveSub()!.flags &= ~ReactiveFlags.RecursedCheck` keeps working).
 */
class NodeView implements ReactiveNode {
	[NODE_ID]: number;
	constructor(id: number) {
		this[NODE_ID] = id;
	}
	get flags(): ReactiveFlags {
		return nodeFlags(this[NODE_ID]) & 127;
	}
	set flags(value: ReactiveFlags) {
		setNodeFlags(this[NODE_ID], value);
	}
}

let activeSubView: NodeView | undefined;

/**
 * Return a live view of the node currently recording signal reads.
 *
 * Returns `undefined` outside a computed getter, effect callback, effect
 * scope, or other dependency-tracking operation. Writing `view.flags`
 * changes that node's public update flags immediately.
 */
export function getActiveSub(): ReactiveNode | undefined {
	const id = systemGetActiveSub();
	if (!id) {
		return undefined;
	}
	if (activeSubView === undefined || activeSubView[NODE_ID] !== id) {
		activeSubView = new NodeView(id);
	}
	return activeSubView;
}

/**
 * Set the node that records subsequent signal reads.
 *
 * Pass a view previously returned by {@link getActiveSub}, or `undefined` to
 * disable tracking. Returns the previous view so callers can restore it.
 */
export function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
	let id = 0;
	if (sub !== undefined) {
		id = (sub as NodeView)[NODE_ID];
		if (typeof id !== 'number') {
			throw new TypeError('dalien-signals: setActiveSub expects a value returned by getActiveSub()');
		}
	}
	const prevId = systemSetActiveSub(id);
	if (!prevId) {
		return undefined;
	}
	return new NodeView(prevId);
}

/**
 * Set the fixed capacity of the default system and allocate its arena.
 *
 * Call this before creating a signal, computed, effect, or effect scope.
 * `initialRecords` counts 32-byte node and dependency records. It defaults
 * to 8,388,608 records (256 MB of virtual address space). The arena grows
 * automatically between operations once 3/4 full; a single callback that
 * allocates past the remaining headroom in one go throws.
 *
 * @example
 * ```ts
 * configure({ initialRecords: 1 << 20 });
 * const count = signal(0);
 * ```
 */
export function configure(options?: { initialRecords?: number }): void {
	systemConfigure(options);
}

/** Return the number of currently open batches. */
export function getBatchDepth(): number {
	return systemGetBatchDepth();
}

/**
 * Open a batch. Signal writes still take effect, but queued effects wait for
 * the matching {@link endBatch} call.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * effect(() => console.log(count())); // 0
 * startBatch();
 * try {
 *   count(1);
 *   count(2);
 * } finally {
 *   endBatch(); // 2; the effect runs once.
 * }
 * ```
 */
export function startBatch(): void {
	system.startBatch();
}

/** Close a batch, flushing effects when the outermost batch closes. */
export function endBatch(): void {
	system.endBatch();
	drain();
}

/** Return whether `fn` is a signal created by this package. */
export function isSignal(fn: () => void): boolean {
	return String(fn) === signalSrc;
}

/** Return whether `fn` is a computed created by this package. */
export function isComputed(fn: () => void): boolean {
	return String(fn) === computedSrc;
}

/** Return whether `fn` is an effect disposer created by this package. */
export function isEffect(fn: () => void): boolean {
	return String(fn) === effectSrc;
}

/** Return whether `fn` is an effect-scope disposer created by this package. */
export function isEffectScope(fn: () => void): boolean {
	return String(fn) === scopeSrc;
}

/**
 * Create a reactive value. Call the returned function with no argument to
 * read the value, or with an argument to write it.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * count();  // 0
 * count(1);
 * count();  // 1
 * ```
 */
export function signal<T>(): {
	(): T | undefined;
	(value: T | undefined): void;
};
export function signal<T>(initialValue: T): {
	(): T;
	(value: T): void;
};
export function signal<T>(initialValue?: T): {
	(): T | undefined;
	(value: T | undefined): void;
} {
	const st: SignalState = { current: initialValue, pending: initialValue };
	const oper = anon(((...value: [T?]): T | undefined | void => {
		if (value.length) {
			if (st.pending !== (st.pending = value[0])) {
				system.markDirty(id);
				system.propagate(id, runDepth !== 0);
				drain();
			}
		} else {
			if (nodeFlags(id) & ReactiveFlags.Dirty) {
				// Commit-on-read: a staged write inside an open batch.
				setNodeFlags(id, nodeFlags(id) & ~ReactiveFlags.Dirty);
				if (st.current !== (st.current = st.pending)) {
					system.shallowPropagate(id);
				}
			}
			system.track(id);
			return st.current as T | undefined;
		}
	}) as { (): T | undefined; (value: T | undefined): void });
	const id = system.custom(Kind.Signal | ReactiveFlags.Mutable, oper);
	nodes[id >> 3] = st;
	signalSrc ??= String(oper);
	return oper;
}

/**
 * Create a cached value derived from the signals and computeds read by
 * `getter`. Its argument is the previous value, or `undefined` initially.
 *
 * @example
 * ```ts
 * const count = signal(2);
 * const doubled = computed(() => count() * 2);
 * doubled(); // 4
 * ```
 */
export function computed<T>(getter: (previousValue?: T) => T): () => T {
	const st: ComputedState = {
		value: undefined,
		getter: getter as (previousValue?: unknown) => unknown,
		evaluated: false,
		children: [],
	};
	const oper = anon((): T => {
		if (!system.verified(id)) {
			if (nodeFlags(id) & ReactiveFlags.RecursedCheck) {
				// Re-entrant self-read during our own recompute: hand back
				// the stale value instead of recursing (upstream parity).
			} else if (system.verify(id)) {
				if (recompute(id, st)) {
					system.shallowPropagate(id);
				}
				st.evaluated = true;
			} else if (!st.evaluated) {
				st.evaluated = true;
				recompute(id, st);
			}
		}
		system.track(id);
		return st.value as T;
	});
	const id = system.custom(Kind.Computed | ReactiveFlags.Mutable, oper);
	nodes[id >> 3] = st;
	computedSrc ??= String(oper);
	return oper;
}

/**
 * Run `fn` immediately, then rerun it when a value it read changes.
 * `fn` may return cleanup work. The returned function stops the effect.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * const stop = effect(() => console.log(count())); // 0
 * count(1); // 1
 * stop();
 * ```
 */
export function effect(fn: () => void | (() => void)): () => void {
	const st: EffectState = { fn, cleanup: undefined, children: [], gen: 0 };
	const id = system.custom(Kind.Effect | ReactiveFlags.Watching);
	st.gen = system.gen(id);
	nodes[id >> 3] = st;
	adopt(id);
	const prevSub = systemSetActiveSub(id);
	system.beginTracking(id);
	++runDepth;
	try {
		st.cleanup = fn();
	} finally {
		--runDepth;
		systemSetActiveSub(prevSub);
		system.endTracking(id);
	}
	const dispose = anon((): void => {
		disposeNode(id);
	});
	effectSrc ??= String(dispose);
	return dispose;
}

/**
 * Run `fn` and group every nested effect it creates.
 * The returned function stops the group and runs its cleanup work.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * const stop = effectScope(() => {
 *   effect(() => console.log(count()));
 * });
 * stop();
 * count(1); // No log; the scope is stopped.
 * ```
 */
export function effectScope(fn: () => void): () => void {
	const st: EffectState = { fn: fn as () => void, cleanup: undefined, children: [], gen: 0 };
	const id = system.custom(Kind.Scope);
	st.gen = system.gen(id);
	nodes[id >> 3] = st;
	adopt(id);
	const prevSub = systemSetActiveSub(id);
	try {
		fn();
	} finally {
		systemSetActiveSub(prevSub);
	}
	const disposeScope = anon((): void => {
		disposeNode(id);
	});
	scopeSrc ??= String(disposeScope);
	return disposeScope;
}

/**
 * Notify dependents after mutating values stored inside signals in place.
 * Read each changed signal inside `fn`.
 */
export function trigger(fn: () => void): void {
	systemTrigger(fn);
	drain();
}

export { ReactiveFlags, type ReactiveNode } from './system.js';
