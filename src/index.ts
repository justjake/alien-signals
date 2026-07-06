/**
 * The default signal library: signal, computed, effect, and effectScope,
 * implemented ENTIRELY in userspace with the same division of labor as
 * upstream alien-signals — this module owns all tracking state (the active
 * subscriber, run depth, the batch counter, the pass cycle, the write epoch,
 * the effect queue) and manipulates node records directly in the shared
 * arena, while the core supplies the five graph algorithms
 * (link/unlink/propagate/checkDirty/shallowPropagate), allocation, and
 * growth. Each function here is a transliteration of its upstream
 * counterpart from `node.field` to `M[id + Slot]`; values and callbacks live
 * on the node-state objects in the `nodes` table.
 */
import {
	Arena,
	Flag,
	LinkSlot,
	NodeGenKey,
	NodeIdKey,
	NodeSlot,
	SysSlot,
	createReactiveSystem,
	type LinkId,
	type NodeGen,
	type NodeId,
	type ReactiveNode,
} from './system.js';

// ---- host flag vocabulary ----------------------------------------------------
// The layout and the flag bits come from system.ts (the authority on the
// arena); this enum holds only what is THIS library's policy: its kind tags
// (planted in the host bits the engine preserves) and the child-effect
// marker upstream also keeps outside ReactiveFlags.

const enum Host {
	/** This effect/scope/computed created child effects; dispose them on re-run. */
	HasChildEffect = 64,
	/** Everything absolute flag stores must preserve (engine bits + kind tags). */
	Hidden = ~Flag.PublicMask,
	Signal = 1 << Flag.HostShift,
	Computed = 2 << Flag.HostShift,
	Effect = 3 << Flag.HostShift,
	Scope = 4 << Flag.HostShift,
	KindMask = 7 << Flag.HostShift,
}

// ---- node state ----------------------------------------------------------------
// The state object IS the reactive node: it carries the arena id and
// generation (assigned at mint), and `flags` is a live view over the
// record's public update-state bits, so the upstream pattern
// `getActiveSub()!.flags &= ~ReactiveFlags.RecursedCheck` works on any node
// this library hands out — no wrapper objects.

class NodeState implements ReactiveNode {
	declare [NodeIdKey]: NodeId;
	declare [NodeGenKey]: NodeGen;
	get flags(): number {
		return M[this[NodeIdKey] + NodeSlot.Flags] & Flag.PublicMask;
	}
	set flags(value: number) {
		const id = this[NodeIdKey];
		M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & Host.Hidden) | (value & Flag.PublicMask);
		// Flag surgery may mark Dirty/Pending without a write: the cached
		// verification can no longer be trusted.
		D[(id >> Arena.StampShift) + Arena.StampOffset] = 0;
	}
}

class SignalState extends NodeState {
	current: unknown;
	pending: unknown;
	constructor(value: unknown) {
		super();
		this.current = value;
		this.pending = value;
	}
}

class ComputedState extends NodeState {
	value: unknown = undefined;
	getter: (previousValue?: unknown) => unknown;
	constructor(getter: (previousValue?: unknown) => unknown) {
		super();
		this.getter = getter;
	}
}

class EffectState extends NodeState {
	fn: () => (() => void) | void;
	cleanup: (() => void) | void = undefined;
	constructor(fn: () => (() => void) | void) {
		super();
		this.fn = fn;
	}
}

// Dense id -> state map, indexed by record number. Slots are cleared by the
// same code paths that free records, so the map's lifecycle mirrors the
// arena's exactly.
const nodes: (NodeState | undefined)[] = [];

// ---- host-owned tracking state (upstream's module lets) ---------------------

let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: NodeId = 0 as NodeId;
/** The tracking-pass counter (upstream's `cycle`): link versions. */
let cycle = 0;
/**
 * The write epoch: bumped by every committed write and trigger. A node whose
 * stamp (in the arena's stamp view D) equals it is provably current —
 * nothing observed has been written since its last verification.
 */
let epoch = 1;

// The effect queue holds (id, generation) pairs: a generation mismatch at
// flush time means the record was freed (and possibly reused) after being
// queued, so the entry is skipped instead of running a stranger.
const queued: NodeId[] = [];
const queuedGens: NodeGen[] = [];

// ---- the shared arena and the five graph ops --------------------------------
// Captured lazily at the first node mint (the system materializes its arena
// on first use so configure() can still size it) and re-captured by the
// onGrow option whenever growth migrates the graph to a bigger arena. Ids
// and link ids survive growth verbatim — only these views and closures
// change — so host code never caches M, D, or an op in a local across a
// call that can allocate.

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

// ---- the system, driven by this library's update/notify/unwatched seams -----

const system = createReactiveSystem({
	onGrow: capture,
	update: function updateNode(id, flags): boolean {
		const st = nodes[id >> Arena.NodeIndexShift];
		if (st === undefined) {
			return true; // freed mid-walk: treat as changed, the walk moves on
		}
		if ((flags & Host.KindMask) === Host.Signal) {
			return updateSignal(id, flags, st as SignalState);
		}
		return updateComputed(id, st as ComputedState, flags);
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
			const subsLink = M[e + NodeSlot.Subs] as LinkId;
			if (!subsLink) {
				break;
			}
			e = M[subsLink + LinkSlot.Sub] as NodeId;
			const flags = M[e + NodeSlot.Flags];
			if (!(flags & Flag.Watching)) {
				break;
			}
			M[e + NodeSlot.Flags] = flags & ~Flag.Watching;
			eGen = M[e + NodeSlot.Gen] as NodeGen;
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
	// Upstream's unwatched, delivered when a node's last subscriber unlinks.
	unwatched: function unwatchedNode(id): void {
		const flags = M[id + NodeSlot.Flags];
		const kind = flags & Host.KindMask;
		if (kind === Host.Computed) {
			if (M[id + NodeSlot.Deps] !== 0) {
				// Drop the dependency graph and force re-evaluation on the
				// next read (the zeroed stamp defeats the quiet-read gate).
				M[id + NodeSlot.Flags] = (flags & Host.Hidden) | Flag.Mutable | Flag.Dirty;
				D[(id >> Arena.StampShift) + Arena.StampOffset] = 0;
				disposeAllDepsInReverse(id);
			}
		} else if (kind >= Host.Effect) {
			disposeEffect(id);
		}
	},
});

const { configure: systemConfigure } = system;

// ---- update behaviors (upstream index.ts, transliterated) -------------------

function updateSignal(id: NodeId, flags: number, st: SignalState): boolean {
	M[id + NodeSlot.Flags] = (flags & Host.Hidden) | Flag.Mutable;
	return st.current !== (st.current = st.pending);
}

// `flags` is the caller's already-loaded word: both call sites (the update
// seam and computedOper's read ladder) have it in hand, and the bits this
// function keeps (Hidden, HasChildEffect) cannot change under checkDirty.
function updateComputed(id: NodeId, st: ComputedState, flags: number): boolean {
	if (flags & Host.HasChildEffect) {
		disposeChildEffects(id);
	}
	M[id + NodeSlot.DepsTail] = 0;
	M[id + NodeSlot.Flags] = (flags & Host.Hidden) | Flag.Mutable | Flag.RecursedCheck;
	const prevSub = activeSub;
	activeSub = id;
	++cycle;
	++M[SysSlot.EnterDepth];
	const entryEpoch = epoch;
	try {
		const oldValue = st.value;
		const changed = oldValue !== (st.value = st.getter(oldValue));
		// Stamp with the epoch captured BEFORE the getter ran: a write from
		// inside it moved the epoch past entryEpoch, so the stamp can only
		// miss, never lie. Skipped when the getter throws.
		D[(id >> Arena.StampShift) + Arena.StampOffset] = entryEpoch;
		return changed;
	} finally {
		--M[SysSlot.EnterDepth];
		activeSub = prevSub;
		M[id + NodeSlot.Flags] &= ~Flag.RecursedCheck;
		purgeDeps(id);
	}
}

// Re-run an effect the queue delivered (upstream's run).
function run(id: NodeId, st: EffectState): void {
	const flags = M[id + NodeSlot.Flags];
	if (
		flags & Flag.Dirty
		|| (
			flags & Flag.Pending
			&& checkDirty(M[id + NodeSlot.Deps] as LinkId, id)
		)
	) {
		if (flags & Host.HasChildEffect) {
			disposeChildEffects(id);
		}
		if (st.cleanup) {
			runCleanup(st);
			if (nodes[id >> Arena.NodeIndexShift] !== st) {
				return; // the cleanup disposed this effect
			}
		}
		M[id + NodeSlot.DepsTail] = 0;
		M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & Host.Hidden) | Flag.Watching | Flag.RecursedCheck;
		const prevSub = activeSub;
		activeSub = id;
		++cycle;
		++M[SysSlot.EnterDepth];
		++runDepth;
		try {
			st.cleanup = st.fn();
		} finally {
			--runDepth;
			--M[SysSlot.EnterDepth];
			activeSub = prevSub;
			M[id + NodeSlot.Flags] &= ~Flag.RecursedCheck;
			purgeDeps(id);
		}
	} else if (M[id + NodeSlot.Deps] !== 0) {
		// Verified clean, not run: re-arm what notify's dedup cleared.
		M[id + NodeSlot.Flags] = (flags & (Host.Hidden | Host.HasChildEffect)) | Flag.Watching;
	}
}

function flush(): void {
	try {
		while (notifyIndex < queuedLength) {
			const id = queued[notifyIndex];
			const gen = queuedGens[notifyIndex];
			queued[notifyIndex++] = 0 as NodeId;
			if (M[id + NodeSlot.Gen] === gen) {
				const st = nodes[id >> Arena.NodeIndexShift] as EffectState | undefined;
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
			queued[notifyIndex++] = 0 as NodeId;
			if (M[id + NodeSlot.Gen] === gen && nodes[id >> Arena.NodeIndexShift] !== undefined) {
				M[id + NodeSlot.Flags] |= Flag.Watching | Flag.Recursed;
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
	activeSub = 0 as NodeId;
	++M[SysSlot.EnterDepth];
	try {
		cleanup();
	} finally {
		--M[SysSlot.EnterDepth];
		activeSub = prevSub;
	}
}

// Unlink the child effects/scopes a re-running parent created last time:
// each unlink empties the child's subscriber list, which delivers
// unwatched(), which disposes it. Values and computeds in the walk are left
// alone.
function disposeChildEffects(sub: NodeId): void {
	let l = M[sub + NodeSlot.DepsTail] as LinkId;
	while (l !== 0) {
		const prev = M[l + LinkSlot.PrevDep] as LinkId;
		if ((M[M[l + LinkSlot.Dep] + NodeSlot.Flags] & Host.KindMask) >= Host.Effect) {
			unlink(l, sub);
		}
		l = prev;
	}
}

function disposeAllDepsInReverse(sub: NodeId): void {
	let l = M[sub + NodeSlot.DepsTail] as LinkId;
	while (l !== 0) {
		const prev = M[l + LinkSlot.PrevDep] as LinkId;
		unlink(l, sub);
		l = prev;
	}
}

// Drop the dependency edges a tracking pass did not re-establish (upstream's
// purgeDeps): everything after the pass's depsTail ages out.
function purgeDeps(sub: NodeId): void {
	const depsTail = M[sub + NodeSlot.DepsTail] as LinkId;
	let l = depsTail !== 0 ? (M[depsTail + LinkSlot.NextDep] as LinkId) : (M[sub + NodeSlot.Deps] as LinkId);
	while (l !== 0) {
		l = unlink(l, sub);
	}
}

// The effect/scope teardown (upstream's effectOper + effectScopeOper), shared
// by user disposers and unwatched() delivery. The graph teardown itself —
// deps unlinked in reverse, subscribers unlinked, child stops delivered — is
// free()'s job, and ONLY free's: doing any of it here too would unlink the
// same edges twice (a self-dispose mid-run leaves DepsTail mid-chain, so a
// second reverse walk re-frees links and corrupts the free list). Clearing
// the nodes slot FIRST makes the reentrant unwatched() that free delivers
// for this very node a no-op.
function disposeEffect(id: NodeId): void {
	const st = nodes[id >> Arena.NodeIndexShift] as EffectState | undefined;
	if (st === undefined) {
		return; // already disposed
	}
	nodes[id >> Arena.NodeIndexShift] = undefined;
	system.free(id, st[NodeGenKey]);
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
// are a cold string compare.

let signalSrc: string | undefined;
let computedSrc: string | undefined;
let effectSrc: string | undefined;
let scopeSrc: string | undefined;

/**
 * Identity helper that keeps a closure literal ANONYMOUS. Passed in argument
 * position, a function expression gets no inferred name, so every instance
 * of the literal has an empty `.name` and byte-identical source text for the
 * String(fn) brand checks above — and name-preserving build pipelines
 * (keepNames-style) have no name to re-attach, which would otherwise wrap
 * the literal differently per site.
 */
function anonymous<T>(f: T): T {
	return f;
}

// ---- public API ---------------------------------------------------------------

/**
 * Return the node currently recording signal reads: the actual node-state
 * object, whose `flags` property is a live view of the record's public
 * update-state bits (the upstream escape hatch
 * `getActiveSub()!.flags &= ~ReactiveFlags.RecursedCheck` works).
 *
 * Returns `undefined` outside a computed getter, effect callback, effect
 * scope, or other dependency-tracking operation.
 */
export function getActiveSub(): (ReactiveNode & { flags: number }) | undefined {
	return activeSub !== 0 ? nodes[activeSub >> Arena.NodeIndexShift] : undefined;
}

/**
 * Set the node that records subsequent signal reads.
 *
 * Pass a node previously returned by {@link getActiveSub}, or `undefined` to
 * disable tracking. Returns the previous node so callers can restore it.
 */
export function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
	const prev = activeSub;
	if (sub !== undefined) {
		const id = sub[NodeIdKey];
		if (typeof id !== 'number') {
			throw new TypeError('dalien-signals: setActiveSub expects a node returned by getActiveSub()');
		}
		activeSub = id;
	} else {
		activeSub = 0 as NodeId;
	}
	return prev !== 0 ? nodes[prev >> Arena.NodeIndexShift] : undefined;
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
	const st = new SignalState(initialValue);
	const oper = anonymous(((...value: [T?]): T | undefined | void => {
		if (value.length) {
			if (st.pending !== (st.pending = value[0])) {
				M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & Host.Hidden) | Flag.Mutable | Flag.Dirty;
				// Every committed write invalidates the quiet-read stamps.
				++epoch;
				const subs = M[id + NodeSlot.Subs] as LinkId;
				if (subs !== 0) {
					propagate(subs, runDepth !== 0);
					if (!batchDepth) {
						flush();
					}
				}
			}
		} else {
			const flags = M[id + NodeSlot.Flags];
			if (flags & Flag.Dirty) {
				// Commit-on-read: a staged write inside an open batch.
				if (updateSignal(id, flags, st)) {
					const subs = M[id + NodeSlot.Subs] as LinkId;
					if (subs !== 0) {
						shallowPropagate(subs);
					}
				}
			}
			if (activeSub !== 0) {
				link(id, activeSub, cycle);
			}
			return st.current as T | undefined;
		}
	}) as { (): T | undefined; (value: T | undefined): void });
	// The handle is the node's owner: the record reclaims when the last
	// reference to `oper` is dropped.
	const node = system.createReactiveNode(oper as object as ReactiveNode, Host.Signal | Flag.Mutable);
	if (!M.length) {
		capture();
	}
	const id = node[NodeIdKey];
	st[NodeIdKey] = id;
	st[NodeGenKey] = node[NodeGenKey];
	nodes[id >> Arena.NodeIndexShift] = st;
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
	const st = new ComputedState(getter as (previousValue?: unknown) => unknown);
	const oper = anonymous((): T => {
		// Quiet-read gate: a stamp equal to the current write epoch proves
		// nothing observed has been written since the last verification.
		if (D[(id >> Arena.StampShift) + Arena.StampOffset] === epoch) {
			if (activeSub !== 0) {
				link(id, activeSub, cycle);
			}
			return st.value as T;
		}
		const flags = M[id + NodeSlot.Flags];
		if (flags & Flag.Dirty) {
			if (updateComputed(id, st, flags)) {
				const subs = M[id + NodeSlot.Subs] as LinkId;
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		} else if (flags & Flag.Pending) {
			const entryEpoch = epoch;
			if (checkDirty(M[id + NodeSlot.Deps] as LinkId, id)) {
				if (updateComputed(id, st, M[id + NodeSlot.Flags])) {
					const subs = M[id + NodeSlot.Subs] as LinkId;
					if (subs !== 0) {
						shallowPropagate(subs);
					}
				}
			} else {
				M[id + NodeSlot.Flags] = flags & ~Flag.Pending;
				D[(id >> Arena.StampShift) + Arena.StampOffset] = entryEpoch;
			}
		}
		// A reentrant self-read lands here with neither bit set (the update
		// in progress already cleared them): stale read by contract.
		if (activeSub !== 0) {
			link(id, activeSub, cycle);
		}
		return st.value as T;
	});
	// Minted DIRTY: the first read takes the update path (upstream's cold
	// first evaluation), against an empty subscriber list. The handle owns
	// the record.
	const node = system.createReactiveNode(oper as object as ReactiveNode, Host.Computed | Flag.Mutable | Flag.Dirty);
	if (!M.length) {
		capture();
	}
	const id = node[NodeIdKey];
	st[NodeIdKey] = id;
	st[NodeGenKey] = node[NodeGenKey];
	nodes[id >> Arena.NodeIndexShift] = st;
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
	// The state object is the owner; the nodes table holds it until
	// disposal, so effects are never garbage-collected out from under the
	// graph — they run until stopped.
	const st = system.createReactiveNode<EffectState>(new EffectState(fn), Host.Effect | Flag.Watching | Flag.RecursedCheck);
	if (!M.length) {
		capture();
	}
	const id = st[NodeIdKey];
	const gen = st[NodeGenKey];
	nodes[id >> Arena.NodeIndexShift] = st;
	const prevSub = activeSub;
	activeSub = id;
	if (prevSub !== 0) {
		// A child effect is a dependency of its parent: the parent's next
		// re-run (or disposal) unlinks it, which disposes it.
		link(id, prevSub, 0);
		M[prevSub + NodeSlot.Flags] |= Host.HasChildEffect;
	}
	++M[SysSlot.EnterDepth];
	++runDepth;
	try {
		st.cleanup = fn();
	} finally {
		--runDepth;
		--M[SysSlot.EnterDepth];
		activeSub = prevSub;
		M[id + NodeSlot.Flags] &= ~Flag.RecursedCheck;
	}
	const dispose = anonymous((): void => {
		if (M[id + NodeSlot.Gen] === gen) {
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
	const st = system.createReactiveNode<EffectState>(new EffectState(fn as () => void), Host.Scope | Flag.Mutable);
	if (!M.length) {
		capture();
	}
	const id = st[NodeIdKey];
	const gen = st[NodeGenKey];
	nodes[id >> Arena.NodeIndexShift] = st;
	const prevSub = activeSub;
	activeSub = id;
	if (prevSub !== 0) {
		link(id, prevSub, 0);
		M[prevSub + NodeSlot.Flags] |= Host.HasChildEffect;
	}
	++M[SysSlot.EnterDepth];
	try {
		fn();
	} finally {
		--M[SysSlot.EnterDepth];
		activeSub = prevSub;
	}
	const disposeScope = anonymous((): void => {
		if (M[id + NodeSlot.Gen] === gen) {
			disposeScopeNode(id);
		}
	});
	scopeSrc ??= String(disposeScope);
	return disposeScope;
}

function noopEffectBody(): void {}

// One persistent scratch subscriber for trigger(), minted on first use and
// reused ever after: its record is never freed (this module never resets the
// default system, so the id stays valid), and Watching|RecursedCheck
// together keep the propagation ladder from ever notifying it. A reentrant
// trigger — rare — falls back to a throwaway node.
let triggerScratch: EffectState | undefined;
let triggerScratchBusy = false;

/**
 * Notify dependents after mutating values stored inside signals in place.
 * Read each changed signal inside `fn`.
 */
export function trigger(fn: () => void): void {
	// A scratch subscriber records the reads; unlinking it afterwards turns
	// each recorded dependency into an out-of-band invalidation wave.
	let st: EffectState;
	let persistent = false;
	if (!triggerScratchBusy && triggerScratch !== undefined) {
		st = triggerScratch;
		persistent = true;
		const sid = st[NodeIdKey];
		M[sid + NodeSlot.Flags] = (M[sid + NodeSlot.Flags] & Host.Hidden) | Flag.Watching | Flag.RecursedCheck;
	} else {
		st = system.createReactiveNode<EffectState>(new EffectState(noopEffectBody), Flag.Watching | Flag.RecursedCheck);
		if (!M.length) {
			capture();
		}
		nodes[st[NodeIdKey] >> Arena.NodeIndexShift] = st;
		if (triggerScratch === undefined && !triggerScratchBusy) {
			triggerScratch = st;
			persistent = true;
		}
	}
	if (persistent) {
		triggerScratchBusy = true;
	}
	const id = st[NodeIdKey];
	const prevSub = activeSub;
	activeSub = id;
	++batchDepth;
	++M[SysSlot.EnterDepth];
	try {
		fn();
	} finally {
		activeSub = prevSub;
		M[id + NodeSlot.Flags] &= Host.Hidden;
		++epoch;
		let l = M[id + NodeSlot.Deps] as LinkId;
		while (l !== 0) {
			const dep = M[l + LinkSlot.Dep] as NodeId;
			l = unlink(l, id);
			const subs = M[dep + NodeSlot.Subs] as LinkId;
			if (subs !== 0) {
				propagate(subs, runDepth !== 0);
				shallowPropagate(subs);
			}
		}
		--M[SysSlot.EnterDepth];
		if (persistent) {
			triggerScratchBusy = false;
		} else {
			nodes[id >> Arena.NodeIndexShift] = undefined;
			system.free(id, st[NodeGenKey]);
		}
		if (!--batchDepth) {
			flush();
		}
	}
}

export { ReactiveFlags, type ReactiveNode } from './system.js';
