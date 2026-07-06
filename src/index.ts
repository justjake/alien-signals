/**
 * The default signal library: signal, computed, effect, and effectScope,
 * implemented ENTIRELY in userspace with the same division of labor as
 * upstream alien-signals — this module owns all tracking state (the active
 * subscriber, run depth, the batch counter, the effect queue) and manipulates
 * node records directly in the shared arena, while the core supplies the five
 * graph algorithms (link/unlink/propagate/checkDirty/shallowPropagate),
 * allocation, and growth. Each function here is a transliteration of its
 * upstream counterpart from `node.field` to `M[id + Slot]`; values and
 * callbacks live on plain host objects in the `nodes` table.
 */
import {
	createReactiveSystem,
	type LinkId,
	type NodeId,
	type ReactiveNode,
} from './system.js';

// ---- arena vocabulary (same-file const enums: inlined by every toolchain) --
// Twins of the layout the core exports as NodeSlot/LinkSlot/SysSlot: declared
// again HERE because toolchains only reliably inline const enum members used
// in the same file, and these appear in every hot path below. The record
// layout is a frozen ABI (32-byte records, 8 int32 slots), so the duplication
// is safe by construction.

/** Node record slots (M arena; ids are pre-multiplied record offsets). */
const enum Node {
	Flags = 0,
	Deps = 1,
	DepsTail = 2,
	Subs = 3,
	SubsTail = 4,
	Gen = 5,
}

/** Link (edge) record slots. */
const enum Link {
	Dep = 1,
	Sub = 2,
	NextSub = 4,
	PrevDep = 5,
	NextDep = 6,
}

/** Record-0 system slots shared with the core (see SysSlot in system.ts). */
const enum Sys {
	/** Live frames holding the arena; growth waits until it is zero. */
	EnterDepth = 1,
	/** The tracking-pass counter (upstream's `cycle`); versions for link(). */
	Cycle = 2,
	/** f64 index of the write epoch in the stamp view D. */
	EpochF64 = 3,
}

/**
 * Flag bits. The low seven are the public update-state bits (upstream's
 * ReactiveFlags plus HasChildEffect); bits 16-27 are this library's kind
 * tags, planted at mint and preserved by the engine. Everything outside the
 * low seven — engine liveness and reclamation bits as well as the kind
 * tags — must ride through every absolute flag store, so stores are written
 * `(flags & Flag.Hidden) | newBits`.
 */
const enum Flag {
	Mutable = 1,
	Watching = 2,
	RecursedCheck = 4,
	Recursed = 8,
	Dirty = 16,
	Pending = 32,
	/** This effect/scope/computed created child effects; dispose them on re-run. */
	HasChildEffect = 64,
	/** Everything absolute flag stores must preserve (engine bits + kind tags). */
	Hidden = ~127,
	Signal = 1 << 16,
	Computed = 2 << 16,
	Effect = 3 << 16,
	Scope = 4 << 16,
	KindMask = 7 << 16,
}

// ---- host node state --------------------------------------------------------

interface SignalState {
	current: unknown;
	pending: unknown;
}

interface ComputedState {
	value: unknown;
	getter: (previousValue?: unknown) => unknown;
}

interface EffectState {
	fn: () => (() => void) | void;
	cleanup: (() => void) | void;
}

// Dense id -> state map (records are 32 bytes; ids are premultiplied by 8).
// Slots are cleared by the same code paths that free records, so the map's
// lifecycle mirrors the arena's exactly.
const nodes: (SignalState | ComputedState | EffectState | undefined)[] = [];

// ---- host-owned tracking state (upstream's module lets) ---------------------

let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: NodeId = 0;

// The effect queue holds (id, generation) pairs: a generation mismatch at
// flush time means the record was freed (and possibly reused) after being
// queued, so the entry is skipped instead of running a stranger.
const queued: number[] = [];
const queuedGens: number[] = [];

// ---- the shared arena and the five graph ops --------------------------------
// Captured lazily at the first node mint (the system materializes its arena
// on first use so configure() can still size it) and re-captured by onGrow
// whenever growth migrates the graph to a bigger arena. Ids and link ids
// survive growth verbatim — only these views and closures change — so host
// code never caches M, D, or an op in a local across a call that can
// allocate.

let M: Int32Array = new Int32Array(0);
let D: Float64Array = new Float64Array(0);
let link!: (dep: NodeId, sub: NodeId, version: number) => LinkId;
let unlink!: (linkId: LinkId, sub?: NodeId) => LinkId;
let propagate!: (subsLink: LinkId, innerWrite: boolean) => void;
let checkDirty!: (depsLink: LinkId, sub: NodeId) => boolean;
let shallowPropagate!: (subsLink: LinkId) => void;

function capture(): void {
	M = system.buffer();
	D = system.stampView();
	const e = system.e;
	link = e.link;
	unlink = e.unlink;
	propagate = e.propagate;
	checkDirty = e.checkDirty;
	shallowPropagate = e.shallowPropagate;
}

// ---- the system, driven by this library's update/notify/stop seams ----------

const system = createReactiveSystem({
	update: function updateNode(id, flags): boolean {
		const st = nodes[id >> 3];
		if (st === undefined) {
			return true; // freed mid-walk: treat as changed, the walk moves on
		}
		if ((flags & Flag.KindMask) === Flag.Signal) {
			return updateSignal(id, flags, st as SignalState);
		}
		return updateComputed(id, st as ComputedState);
	},
	// Upstream's notify: queue the effect, then hoist queued ancestors above
	// it (clearing Watching as the dedup) and reverse the run so outer
	// effects flush before the children they own. The core already cleared
	// the entry node's Watching bit before calling here.
	notify: function enqueueEffect(id, gen): void {
		let insertIndex = queuedLength;
		let firstInsertedIndex = insertIndex;
		let e = id;
		let eGen = gen;
		while (true) {
			queued[insertIndex] = e;
			queuedGens[insertIndex++] = eGen;
			const subsLink = M[e + Node.Subs];
			if (!subsLink) {
				break;
			}
			e = M[subsLink + Link.Sub];
			const flags = M[e + Node.Flags];
			if (!(flags & Flag.Watching)) {
				break;
			}
			M[e + Node.Flags] = flags & ~Flag.Watching;
			eGen = M[e + Node.Gen];
		}
		queuedLength = insertIndex;
		while (firstInsertedIndex < --insertIndex) {
			const leftId = queued[firstInsertedIndex];
			const leftGen = queuedGens[firstInsertedIndex];
			queued[firstInsertedIndex] = queued[insertIndex];
			queuedGens[firstInsertedIndex++] = queuedGens[insertIndex];
			queued[insertIndex] = leftId;
			queuedGens[insertIndex] = leftGen;
		}
	},
	start() {
		return undefined; // presence enables stop() delivery
	},
	// Upstream's unwatched, delivered when a node's last subscriber unlinks.
	stop: function stopNode(id): void {
		const flags = M[id + Node.Flags];
		const kind = flags & Flag.KindMask;
		if (kind === Flag.Computed) {
			if (M[id + Node.Deps] !== 0) {
				// Drop the dependency graph and force re-evaluation on the
				// next read (the zeroed stamp defeats the quiet-read gate).
				M[id + Node.Flags] = (flags & Flag.Hidden) | Flag.Mutable | Flag.Dirty;
				D[(id >> 1) + 3] = 0;
				disposeAllDepsInReverse(id);
			}
		} else if (kind >= Flag.Effect) {
			disposeEffect(id);
		}
	},
});

const { configure: systemConfigure } = system;
system.onGrow(capture);

// ---- update behaviors (upstream index.ts, transliterated) -------------------

function updateSignal(id: NodeId, flags: number, st: SignalState): boolean {
	M[id + Node.Flags] = (flags & Flag.Hidden) | Flag.Mutable;
	return st.current !== (st.current = st.pending);
}

function updateComputed(id: NodeId, st: ComputedState): boolean {
	const flags = M[id + Node.Flags];
	if (flags & Flag.HasChildEffect) {
		disposeChildEffects(id);
	}
	M[id + Node.DepsTail] = 0;
	M[id + Node.Flags] = (flags & Flag.Hidden) | Flag.Mutable | Flag.RecursedCheck;
	const prevSub = activeSub;
	activeSub = id;
	++M[Sys.Cycle];
	++M[Sys.EnterDepth];
	const entryEpoch = D[Sys.EpochF64];
	try {
		const oldValue = st.value;
		const changed = oldValue !== (st.value = st.getter(oldValue));
		// Stamp with the epoch captured BEFORE the getter ran: a write from
		// inside it moved the epoch past entryEpoch, so the stamp can only
		// miss, never lie. Skipped when the getter throws.
		D[(id >> 1) + 3] = entryEpoch;
		return changed;
	} finally {
		--M[Sys.EnterDepth];
		activeSub = prevSub;
		M[id + Node.Flags] &= ~Flag.RecursedCheck;
		purgeDeps(id);
	}
}

// Re-run an effect the queue delivered (upstream's run).
function run(id: NodeId, st: EffectState): void {
	const flags = M[id + Node.Flags];
	if (
		flags & Flag.Dirty
		|| (
			flags & Flag.Pending
			&& checkDirty(M[id + Node.Deps], id)
		)
	) {
		if (flags & Flag.HasChildEffect) {
			disposeChildEffects(id);
		}
		if (st.cleanup) {
			runCleanup(st);
			if (nodes[id >> 3] !== st) {
				return; // the cleanup disposed this effect
			}
		}
		M[id + Node.DepsTail] = 0;
		M[id + Node.Flags] = (M[id + Node.Flags] & Flag.Hidden) | Flag.Watching | Flag.RecursedCheck;
		const prevSub = activeSub;
		activeSub = id;
		++M[Sys.Cycle];
		++M[Sys.EnterDepth];
		++runDepth;
		try {
			st.cleanup = st.fn();
		} finally {
			--runDepth;
			--M[Sys.EnterDepth];
			activeSub = prevSub;
			M[id + Node.Flags] &= ~Flag.RecursedCheck;
			purgeDeps(id);
		}
	} else if (M[id + Node.Deps] !== 0) {
		// Verified clean, not run: re-arm what notify's dedup cleared.
		M[id + Node.Flags] = (flags & (Flag.Hidden | Flag.HasChildEffect)) | Flag.Watching;
	}
}

function flush(): void {
	try {
		while (notifyIndex < queuedLength) {
			const id = queued[notifyIndex];
			const gen = queuedGens[notifyIndex];
			queued[notifyIndex++] = 0;
			if (M[id + Node.Gen] === gen) {
				const st = nodes[id >> 3] as EffectState | undefined;
				if (st !== undefined) {
					run(id, st);
				}
			}
		}
	} finally {
		// Abnormal exit (an effect threw): survivors are re-armed — a change
		// to THEIR dependencies re-notifies them — but the failed flush does
		// not resume on unrelated writes (upstream parity).
		while (notifyIndex < queuedLength) {
			const id = queued[notifyIndex];
			const gen = queuedGens[notifyIndex];
			queued[notifyIndex++] = 0;
			if (M[id + Node.Gen] === gen && nodes[id >> 3] !== undefined) {
				M[id + Node.Flags] |= Flag.Watching | Flag.Recursed;
			}
		}
		notifyIndex = 0;
		queuedLength = 0;
	}
}

// ---- teardown helpers --------------------------------------------------------

function runCleanup(st: EffectState): void {
	const cleanup = st.cleanup as () => void;
	st.cleanup = undefined;
	const prevSub = activeSub;
	activeSub = 0;
	++M[Sys.EnterDepth];
	try {
		cleanup();
	} finally {
		--M[Sys.EnterDepth];
		activeSub = prevSub;
	}
}

// Unlink the child effects/scopes a re-running parent created last time:
// each unlink empties the child's subscriber list, which delivers stop(),
// which disposes it. Values and computeds in the walk are left alone.
function disposeChildEffects(sub: NodeId): void {
	let l = M[sub + Node.DepsTail];
	while (l !== 0) {
		const prev = M[l + Link.PrevDep];
		if ((M[M[l + Link.Dep] + Node.Flags] & Flag.KindMask) >= Flag.Effect) {
			unlink(l, sub);
		}
		l = prev;
	}
}

function disposeAllDepsInReverse(sub: NodeId): void {
	let l = M[sub + Node.DepsTail];
	while (l !== 0) {
		const prev = M[l + Link.PrevDep];
		unlink(l, sub);
		l = prev;
	}
}

// Drop the dependency edges a tracking pass did not re-establish (upstream's
// purgeDeps): everything after the pass's depsTail ages out.
function purgeDeps(sub: NodeId): void {
	const depsTail = M[sub + Node.DepsTail];
	let l = depsTail !== 0 ? M[depsTail + Link.NextDep] : M[sub + Node.Deps];
	while (l !== 0) {
		l = unlink(l, sub);
	}
}

// The effect/scope teardown (upstream's effectOper + effectScopeOper), shared
// by user disposers and stop() delivery. The graph teardown itself — deps
// unlinked in reverse, subscribers unlinked, child stops delivered — is
// free()'s job, and ONLY free's: doing any of it here too would unlink the
// same edges twice (a self-dispose mid-run leaves DepsTail mid-chain, so a
// second reverse walk re-frees links and corrupts the free list). Clearing
// the nodes slot FIRST makes the reentrant stop() that free delivers for
// this very node a no-op.
function disposeEffect(id: NodeId): void {
	const st = nodes[id >> 3] as EffectState | undefined;
	if (st === undefined) {
		return; // already disposed
	}
	nodes[id >> 3] = undefined;
	system.free(id, M[id + Node.Gen]);
	if (st.cleanup) {
		runCleanup(st);
	}
}

// Distinctly-named twin of disposeEffect's caller: keeps the scope disposer
// literal's source text different from the effect disposer's, so the is*
// brand checks (cold string compares) can tell them apart.
function disposeScopeNode(id: NodeId): void {
	disposeEffect(id);
}

// ---- brands ------------------------------------------------------------------
// Every handle of a kind is an instantiation of the SAME closure literal, so
// Function.prototype.toString() is identical across all of them: kind checks
// are a cold string compare that survives keepNames pipelines. anon() keeps
// the literals in argument position so they stay nameless.

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
	get flags(): number {
		return M[this[NODE_ID] + Node.Flags] & ~Flag.Hidden;
	}
	set flags(value: number) {
		const id = this[NODE_ID];
		M[id + Node.Flags] = (M[id + Node.Flags] & Flag.Hidden) | (value & ~Flag.Hidden);
		D[(id >> 1) + 3] = 0; // flag surgery invalidates the quiet-read stamp
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
	const id = activeSub;
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
	const prevId = activeSub;
	activeSub = id;
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
	return batchDepth;
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
	++batchDepth;
}

/** Close a batch, flushing effects when the outermost batch closes. */
export function endBatch(): void {
	if (!--batchDepth) {
		flush();
	}
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
				M[id + Node.Flags] = (M[id + Node.Flags] & Flag.Hidden) | Flag.Mutable | Flag.Dirty;
				// Every committed write invalidates the quiet-read stamps.
				++D[Sys.EpochF64];
				const subs = M[id + Node.Subs];
				if (subs !== 0) {
					propagate(subs, runDepth !== 0);
					if (!batchDepth) {
						flush();
					}
				}
			}
		} else {
			const flags = M[id + Node.Flags];
			if (flags & Flag.Dirty) {
				// Commit-on-read: a staged write inside an open batch.
				if (updateSignal(id, flags, st)) {
					const subs = M[id + Node.Subs];
					if (subs !== 0) {
						shallowPropagate(subs);
					}
				}
			}
			if (activeSub !== 0) {
				link(id, activeSub, M[Sys.Cycle]);
			}
			return st.current as T | undefined;
		}
	}) as { (): T | undefined; (value: T | undefined): void });
	const id = system.custom(Flag.Signal | Flag.Mutable, oper);
	if (!M.length) {
		capture();
	}
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
	};
	const oper = anon((): T => {
		// Quiet-read gate: a stamp equal to the current write epoch proves
		// nothing observed has been written since the last verification.
		if (D[(id >> 1) + 3] === D[Sys.EpochF64]) {
			if (activeSub !== 0) {
				link(id, activeSub, M[Sys.Cycle]);
			}
			return st.value as T;
		}
		const flags = M[id + Node.Flags];
		if (flags & Flag.Dirty) {
			if (updateComputed(id, st)) {
				const subs = M[id + Node.Subs];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		} else if (flags & Flag.Pending) {
			const entryEpoch = D[Sys.EpochF64];
			if (checkDirty(M[id + Node.Deps], id)) {
				if (updateComputed(id, st)) {
					const subs = M[id + Node.Subs];
					if (subs !== 0) {
						shallowPropagate(subs);
					}
				}
			} else {
				M[id + Node.Flags] = flags & ~Flag.Pending;
				D[(id >> 1) + 3] = entryEpoch;
			}
		}
		// A reentrant self-read lands here with neither bit set (the update
		// in progress already cleared them): stale read by contract.
		if (activeSub !== 0) {
			link(id, activeSub, M[Sys.Cycle]);
		}
		return st.value as T;
	});
	// Minted DIRTY: the first read takes the update path (upstream's cold
	// first evaluation), against an empty subscriber list.
	const id = system.custom(Flag.Computed | Flag.Mutable | Flag.Dirty, oper);
	if (!M.length) {
		capture();
	}
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
	const st: EffectState = { fn, cleanup: undefined };
	const id = system.custom(Flag.Effect | Flag.Watching | Flag.RecursedCheck);
	if (!M.length) {
		capture();
	}
	const gen = M[id + Node.Gen];
	nodes[id >> 3] = st;
	const prevSub = activeSub;
	activeSub = id;
	if (prevSub !== 0) {
		// A child effect is a dependency of its parent: the parent's next
		// re-run (or disposal) unlinks it, which disposes it.
		link(id, prevSub, 0);
		M[prevSub + Node.Flags] |= Flag.HasChildEffect;
	}
	++M[Sys.EnterDepth];
	++runDepth;
	try {
		st.cleanup = fn();
	} finally {
		--runDepth;
		--M[Sys.EnterDepth];
		activeSub = prevSub;
		M[id + Node.Flags] &= ~Flag.RecursedCheck;
	}
	const dispose = anon((): void => {
		if (M[id + Node.Gen] === gen) {
			disposeEffect(id);
		}
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
	const st: EffectState = { fn: fn as () => void, cleanup: undefined };
	const id = system.custom(Flag.Scope | Flag.Mutable);
	if (!M.length) {
		capture();
	}
	const gen = M[id + Node.Gen];
	nodes[id >> 3] = st;
	const prevSub = activeSub;
	activeSub = id;
	if (prevSub !== 0) {
		link(id, prevSub, 0);
		M[prevSub + Node.Flags] |= Flag.HasChildEffect;
	}
	++M[Sys.EnterDepth];
	try {
		fn();
	} finally {
		--M[Sys.EnterDepth];
		activeSub = prevSub;
	}
	const disposeScope = anon((): void => {
		if (M[id + Node.Gen] === gen) {
			disposeScopeNode(id);
		}
	});
	scopeSrc ??= String(disposeScope);
	return disposeScope;
}

/**
 * Notify dependents after mutating values stored inside signals in place.
 * Read each changed signal inside `fn`.
 */
export function trigger(fn: () => void): void {
	// A scratch subscriber records the reads; unlinking it afterwards turns
	// each recorded dependency into an out-of-band invalidation wave.
	const scratch = system.custom(Flag.Watching | Flag.RecursedCheck);
	if (!M.length) {
		capture();
	}
	const gen = M[scratch + Node.Gen];
	const prevSub = activeSub;
	activeSub = scratch;
	++batchDepth;
	++M[Sys.EnterDepth];
	try {
		fn();
	} finally {
		activeSub = prevSub;
		M[scratch + Node.Flags] &= Flag.Hidden;
		++D[Sys.EpochF64];
		let l = M[scratch + Node.Deps];
		while (l !== 0) {
			const dep = M[l + Link.Dep];
			l = unlink(l, scratch);
			const subs = M[dep + Node.Subs];
			if (subs !== 0) {
				propagate(subs, runDepth !== 0);
				shallowPropagate(subs);
			}
		}
		--M[Sys.EnterDepth];
		system.free(scratch, gen);
		if (!--batchDepth) {
			flush();
		}
	}
}

export { ReactiveFlags, type ReactiveNode } from './system.js';
