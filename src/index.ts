/**
 * The default signal library: signal, computed, effect, and effectScope,
 * implemented ENTIRELY in userspace with the same division of labor as
 * upstream alien-signals — this module owns all tracking state (the active
 * subscriber, run depth, the batch counter, the pass cycle, the global
 * version, the effect queue) and manipulates node records directly in the
 * shared arena, while the core supplies the five graph algorithms
 * (link/unlink/propagate/checkDirty/shallowPropagate), allocation, and
 * growth. Each function here is a transliteration of its upstream
 * counterpart from `node.field` to `M[id + Slot]`; values and callbacks live
 * on the node-state objects in the `nodes` table.
 */
import {
	Arena,
	Flag,
	LinkSlot,
	NodeSlot,
	SysSlot,
	createReactiveSystem,
	type LinkId,
	type ReactiveArena,
	type SignalGen,
	type SignalId,
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
// Plain per-kind state objects, looked up by record number: the record holds
// the graph, these hold the JavaScript (values, callbacks). The handle a
// user receives closes over the node id and its state.

class SignalState {
	current: unknown;
	pending: unknown;
	constructor(value: unknown) {
		this.current = value;
		this.pending = value;
	}
}

class ComputedState {
	value: unknown = undefined;
	getter: (previousValue?: unknown) => unknown;
	constructor(getter: (previousValue?: unknown) => unknown) {
		this.getter = getter;
	}
}

class EffectState {
	fn: () => (() => void) | void;
	cleanup: (() => void) | void = undefined;
	constructor(fn: () => (() => void) | void) {
		this.fn = fn;
	}
}

// Dense id -> state map, indexed by record number. Slots are cleared by the
// same code paths that free records, so the map's lifecycle mirrors the
// arena's exactly.
const nodes: (SignalState | ComputedState | EffectState | undefined)[] = [];

// ---- host-owned tracking state (upstream's module lets) ---------------------

let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: SignalId = 0 as SignalId;
/** The tracking-pass counter (upstream's `cycle`): link versions. */
let cycle = 0;
/**
 * The global version (Preact/Vue naming): bumped by every committed write
 * and trigger. A node whose version snapshot (in the arena's `versions`
 * view) equals it is provably current — nothing observed has been written
 * since its last verification.
 */
let globalVersion = 1;

// The effect queue holds (id, generation) pairs: a generation mismatch at
// flush time means the record was freed (and possibly reused) after being
// queued, so the entry is skipped instead of running a stranger.
const queued: SignalId[] = [];
const queuedGens: SignalGen[] = [];

// ---- the shared arena and the five graph ops --------------------------------
// Bound by the `allocated` callback below — once at materialization, again
// after every growth (the arena object is replaced; ids and link ids survive
// verbatim). Host code never caches any of these in a local across a call
// that can allocate.

let M: Int32Array = new Int32Array(0);
let D: Float64Array = new Float64Array(0);
let link!: (dep: SignalId, sub: SignalId, version: number) => LinkId;
let unlink!: (linkId: LinkId, sub?: SignalId) => LinkId;
let propagate!: (subsLink: LinkId, innerWrite: boolean) => void;
let checkDirty!: (depsLink: LinkId, sub: SignalId) => boolean;
let shallowPropagate!: (subsLink: LinkId) => void;

// ---- the system, driven by this library's update/notify/unwatched seams -----

const system = createReactiveSystem({
	// 1M records x 32 B = 32 MB of virtual address space, allocated at
	// import (physical memory tracks records actually touched). The arena
	// grows automatically when the graph outgrows it; growCapacity() raises
	// it up front.
	initialCapacity: 1 << 20,
	allocated(arena: ReactiveArena): void {
		M = arena.memory;
		D = arena.versions;
		link = arena.link;
		unlink = arena.unlink;
		propagate = arena.propagate;
		checkDirty = arena.checkDirty;
		shallowPropagate = arena.shallowPropagate;
	},
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
			e = M[subsLink + LinkSlot.Sub] as SignalId;
			const flags = M[e + NodeSlot.Flags];
			if (!(flags & Flag.Watching)) {
				break;
			}
			M[e + NodeSlot.Flags] = flags & ~Flag.Watching;
			eGen = M[e + NodeSlot.Gen] as SignalGen;
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
				// next read (the zeroed snapshot defeats the version gate).
				M[id + NodeSlot.Flags] = (flags & Host.Hidden) | Flag.Mutable | Flag.Dirty;
				D[(id >> Arena.VersionShift) + Arena.VersionOffset] = 0;
				disposeAllDepsInReverse(id);
			}
		} else if (kind >= Host.Effect) {
			disposeEffect(id);
		}
	},
});

// ---- update behaviors (upstream index.ts, transliterated) -------------------

function updateSignal(id: SignalId, flags: number, st: SignalState): boolean {
	M[id + NodeSlot.Flags] = (flags & Host.Hidden) | Flag.Mutable;
	return st.current !== (st.current = st.pending);
}

// `flags` is the caller's already-loaded word: both call sites (the update
// seam and computedOper's read ladder) have it in hand, and the bits this
// function keeps (Hidden, HasChildEffect) cannot change under checkDirty.
function updateComputed(id: SignalId, st: ComputedState, flags: number): boolean {
	if (flags & Host.HasChildEffect) {
		disposeChildEffects(id);
	}
	M[id + NodeSlot.DepsTail] = 0;
	M[id + NodeSlot.Flags] = (flags & Host.Hidden) | Flag.Mutable | Flag.RecursedCheck;
	const prevSub = activeSub;
	activeSub = id;
	++cycle;
	++M[SysSlot.EnterDepth];
	const entryVersion = globalVersion;
	try {
		const oldValue = st.value;
		const changed = oldValue !== (st.value = st.getter(oldValue));
		// Snapshot the version captured BEFORE the getter ran: a write from
		// inside it moved globalVersion past entryVersion, so the snapshot
		// can only miss, never lie. Skipped when the getter throws.
		D[(id >> Arena.VersionShift) + Arena.VersionOffset] = entryVersion;
		return changed;
	} finally {
		--M[SysSlot.EnterDepth];
		activeSub = prevSub;
		M[id + NodeSlot.Flags] &= ~Flag.RecursedCheck;
		purgeDeps(id);
	}
}

// Re-run an effect the queue delivered (upstream's run).
function run(id: SignalId, st: EffectState): void {
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
			queued[notifyIndex++] = 0 as SignalId;
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
			queued[notifyIndex++] = 0 as SignalId;
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
	activeSub = 0 as SignalId;
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
function disposeChildEffects(sub: SignalId): void {
	let l = M[sub + NodeSlot.DepsTail] as LinkId;
	while (l !== 0) {
		const prev = M[l + LinkSlot.PrevDep] as LinkId;
		if ((M[M[l + LinkSlot.Dep] + NodeSlot.Flags] & Host.KindMask) >= Host.Effect) {
			unlink(l, sub);
		}
		l = prev;
	}
}

function disposeAllDepsInReverse(sub: SignalId): void {
	let l = M[sub + NodeSlot.DepsTail] as LinkId;
	while (l !== 0) {
		const prev = M[l + LinkSlot.PrevDep] as LinkId;
		unlink(l, sub);
		l = prev;
	}
}

// Drop the dependency edges a tracking pass did not re-establish (upstream's
// purgeDeps): everything after the pass's depsTail ages out.
function purgeDeps(sub: SignalId): void {
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
// for this very node a no-op. Callers have already validated the id, so the
// record's CURRENT generation is the right one to free.
function disposeEffect(id: SignalId): void {
	const st = nodes[id >> Arena.NodeIndexShift] as EffectState | undefined;
	if (st === undefined) {
		return; // already disposed
	}
	nodes[id >> Arena.NodeIndexShift] = undefined;
	system.free(id, M[id + NodeSlot.Gen] as SignalGen);
	if (st.cleanup) {
		runCleanup(st);
	}
}

// Distinctly-named twin of disposeEffect's caller: keeps the scope disposer
// literal's source text different from the effect disposer's, so the is*
// brand checks (cold string compares) can tell them apart.
function disposeScopeNode(id: SignalId): void {
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
 * Return the id of the node currently recording signal reads, or 0 outside a
 * computed getter, effect callback, effect scope, or other
 * dependency-tracking operation.
 */
export function getActiveSub(): SignalId {
	return activeSub;
}

/**
 * Set the node that records subsequent signal reads.
 *
 * Pass an id previously returned by {@link getActiveSub}, or `undefined` (or
 * 0) to disable tracking. Returns the previous id so callers can restore it.
 */
export function setActiveSub(sub?: SignalId): SignalId {
	const prev = activeSub;
	activeSub = sub !== undefined ? sub : (0 as SignalId);
	return prev;
}

/**
 * Read a node's public update-state flags (see ReactiveFlags).
 */
export function getFlags(id: SignalId): number {
	return M[id + NodeSlot.Flags] & Flag.PublicMask;
}

/**
 * Overwrite a node's public update-state flags. The escape hatch for the
 * upstream recursion pattern — an effect that wants its own writes to
 * re-notify it clears its RecursedCheck bit:
 * `setFlags(getActiveSub(), getFlags(getActiveSub()) & ~ReactiveFlags.RecursedCheck)`.
 */
export function setFlags(id: SignalId, flags: number): void {
	M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & Host.Hidden) | (flags & Flag.PublicMask);
	// Flag surgery may mark Dirty/Pending without a write: the cached
	// verification can no longer be trusted.
	D[(id >> Arena.VersionShift) + Arena.VersionOffset] = 0;
}

/**
 * Raise the default system's arena capacity to at least `records` 32-byte
 * node and dependency records (no-op if already that big; throws on an
 * invalid request). The default is 1,048,576 records (32 MB of virtual
 * address space), and the arena also grows automatically once 3/4 full —
 * call this before a bulk load to pay for one migration instead of several.
 * Safe to call at any time: a request made inside an effect or getter is
 * applied at the next operation boundary.
 *
 * @example
 * ```ts
 * growCapacity(1 << 22);
 * ```
 */
export function growCapacity(records: number): void {
	system.growCapacity(records);
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
				// Every committed write invalidates the version snapshots.
				++globalVersion;
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
	const id = system.createReactiveNode(oper, Host.Signal | Flag.Mutable);
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
		// The version gate: a snapshot equal to the current globalVersion
		// proves nothing observed has been written since the last
		// verification.
		if (D[(id >> Arena.VersionShift) + Arena.VersionOffset] === globalVersion) {
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
			const entryVersion = globalVersion;
			if (checkDirty(M[id + NodeSlot.Deps] as LinkId, id)) {
				if (updateComputed(id, st, M[id + NodeSlot.Flags])) {
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
	const id = system.createReactiveNode(oper, Host.Computed | Flag.Mutable | Flag.Dirty);
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
	const st = new EffectState(fn);
	const id = system.createReactiveNode(st, Host.Effect | Flag.Watching | Flag.RecursedCheck);
	const gen = M[id + NodeSlot.Gen] as SignalGen;
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
	const st = new EffectState(fn as () => void);
	const id = system.createReactiveNode(st, Host.Scope | Flag.Mutable);
	const gen = M[id + NodeSlot.Gen] as SignalGen;
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
let triggerScratch: SignalId = 0 as SignalId;
let triggerScratchBusy = false;

/**
 * Notify dependents after mutating values stored inside signals in place.
 * Read each changed signal inside `fn`.
 */
export function trigger(fn: () => void): void {
	// A scratch subscriber records the reads; unlinking it afterwards turns
	// each recorded dependency into an out-of-band invalidation wave.
	let id: SignalId;
	let persistent = false;
	if (!triggerScratchBusy && triggerScratch !== 0) {
		id = triggerScratch;
		persistent = true;
		M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & Host.Hidden) | Flag.Watching | Flag.RecursedCheck;
	} else {
		const st = new EffectState(noopEffectBody);
		id = system.createReactiveNode(st, Flag.Watching | Flag.RecursedCheck);
		nodes[id >> Arena.NodeIndexShift] = st;
		if (triggerScratch === 0 && !triggerScratchBusy) {
			triggerScratch = id;
			persistent = true;
		}
	}
	if (persistent) {
		triggerScratchBusy = true;
	}
	const prevSub = activeSub;
	activeSub = id;
	++batchDepth;
	++M[SysSlot.EnterDepth];
	try {
		fn();
	} finally {
		activeSub = prevSub;
		M[id + NodeSlot.Flags] &= Host.Hidden;
		++globalVersion;
		let l = M[id + NodeSlot.Deps] as LinkId;
		while (l !== 0) {
			const dep = M[l + LinkSlot.Dep] as SignalId;
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
			system.free(id, M[id + NodeSlot.Gen] as SignalGen);
		}
		if (!--batchDepth) {
			flush();
		}
	}
}

export { ReactiveFlags, type SignalId } from './system.js';
