/**
 * The default signal library: signal, computed, effect, and effectScope over
 * NUMERIC HANDLES — `signal()` returns a SignalId and `get(id)`/`set(id, v)`
 * are module functions, so minting a node allocates NO JavaScript object at
 * all (an arena record plus a value-column store), and reads dispatch
 * through one monomorphic function instead of per-node closures.
 *
 * This module owns all tracking state (the active subscriber, run depth,
 * the batch counter, the pass cycle, the global version, the effect queue)
 * with the same division of labor as upstream alien-signals — the core
 * supplies the five graph algorithms (link/unlink/propagate/checkDirty/
 * shallowPropagate), allocation, and growth, and this module manipulates
 * node records directly in the shared arena. Values and callbacks live in
 * side columns indexed by record number.
 *
 * Lifetime, in precedence order: an explicit `owner` argument ties a
 * node's life to that object (freed by the garbage collector when the owner
 * goes); otherwise the innermost effectScope OWNS nodes minted inside it
 * and frees them when it disposes (region ownership — the leak-free default
 * for structured code); at top level, handles are caller-managed via
 * dispose()/reset(), like any global. Effects always belong to the
 * effect/scope they were created under and cascade on dispose.
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

/**
 * A raw handle: the node's arena id with a phantom type parameter carrying
 * the value type through get/set. It is just a number — the fast tier for
 * hosts that manage node lifetime themselves (see Signal for the default).
 */
declare const ValueOf: unique symbol;
export type SignalIdOf<T> = SignalId & { [ValueOf]?: (value: T) => T };

/** Property key carrying a stamped owner's node id (see signalOwner). */
export const SignalIdKey: unique symbol = Symbol('dalien-signals.id');
/** Property key carrying a stamped owner's mint generation. */
export const SignalGenKey: unique symbol = Symbol('dalien-signals.gen');

/** An owner object stamped with the node it keeps alive. */
export type SignalOwner<T, R> = R & { [SignalIdKey]: SignalIdOf<T>; [SignalGenKey]: SignalGen };

// ---- node state ----------------------------------------------------------------
// Structure-of-arrays side columns, indexed by record number: the record
// holds the graph, these hold the JavaScript. currentVals is a signal's
// committed value or a computed's cached value; pendingVals is a signal's
// staged write; fns is a computed's getter or an effect's body (undefined =
// no callback lives here, which doubles as the liveness guard); cleanups is
// an effect's returned cleanup. No per-node state object exists at all.

type NodeFn = (previousValue?: unknown) => unknown;
const currentVals: unknown[] = [];
const pendingVals: unknown[] = [];
const fns: (NodeFn | undefined)[] = [];
const cleanups: ((() => void) | void)[] = [];
// A scope's owned signals/computeds as (id, gen) pairs: freed when the
// scope disposes. Gen-guarded, so a member freed early (and its record
// reused) cannot be freed out from under the new occupant.
const owned: (number[] | undefined)[] = [];

// ---- host-owned tracking state (upstream's module lets) ---------------------

let runDepth = 0;
let batchDepth = 0;
/**
 * The innermost live effectScope: signals and computeds minted inside it
 * belong to it and are freed when it disposes (region ownership — the
 * leak-free default for structured code). An explicit `owner` argument
 * takes precedence; outside any scope, handles are caller-managed.
 */
let currentScope: SignalId = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: SignalId = 0;
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
let manualEffects = false;

// ---- the shared arena and the five graph ops --------------------------------
// Bound by the `allocated` callback below — once at creation, again after
// every growth (the arena object is replaced; ids and link ids survive
// verbatim). Host code never caches any of these in a local across a call
// that can allocate.

let M: Int32Array = new Int32Array(0);
let D: Float64Array = new Float64Array(0);
let link!: (dep: SignalId, sub: SignalId, version: number) => LinkId;
let unlink!: (linkId: LinkId, sub?: SignalId) => LinkId;
let propagate!: (subsLink: LinkId, innerWrite: boolean) => void;
let checkDirty!: (depsLink: LinkId, sub: SignalId) => boolean;
let shallowPropagate!: (subsLink: LinkId) => void;
let freeNode!: (id: SignalId, gen: SignalGen) => void;

// TODO(seeding): port main's adaptive seeding at library level — synthetic
// graph warm-up keyed on callback-shape diversity (String(fn) sampled on a
// geometric cadence), as in the fused engine. Not for milomg (its harness
// pre-warms every cell) but for the write-size crossover bench, where cold
// first-shape compilation decides the result. See dalien-signals main:
// adaptive seeding notes (one-shot specialization, seed tax ~0 when idle).

// ---- the system, driven by this library's update/notify/unwatched seams -----

const system = createReactiveSystem({
	// 1M records x 32 B = 32 MB of virtual address space, allocated at
	// import (physical memory tracks records actually touched). The arena
	// grows automatically when the graph outgrows it; growCapacity() raises
	// it up front.
	capacityRecords: 1 << 20,
	allocated(arena: ReactiveArena): void {
		M = arena.memory;
		D = arena.versions;
		link = arena.link;
		unlink = arena.unlink;
		propagate = arena.propagate;
		checkDirty = arena.checkDirty;
		shallowPropagate = arena.shallowPropagate;
		freeNode = arena.freeNode;
		// The side columns are NOT presized to capacity: pointer arrays are
		// traversed by major GC marking, and capacity-sized columns (2M
		// slots x 5 arrays) put a ~10 ms Mark-Compact tax on every major
		// collection. Incremental growth costs amortized copying instead,
		// which measured cheaper everywhere.
	},
	update: function updateNode(id, flags): boolean {
		if ((flags & Host.KindMask) === Host.Signal) {
			return updateSignal(id, flags);
		}
		return updateComputed(id, flags);
	},
	// Upstream's notify: queue the effect, then hoist queued ancestors above
	// it (clearing Watching as the dedup) and reverse the run so outer
	// effects flush before the children they own. The core already cleared
	// the entry node's Watching bit before calling here.
	notify: function enqueueEffect(id): void {
		let insertIndex = queuedLength;
		let firstInsertedIndex = insertIndex;
		let e = id;
		while (true) {
			queued[insertIndex++] = e;
			const subsLink: LinkId = M[e + NodeSlot.Subs];
			if (!subsLink) {
				break;
			}
			e = M[subsLink + LinkSlot.Sub];
			const flags = M[e + NodeSlot.Flags];
			if (!(flags & Flag.Watching)) {
				break;
			}
			M[e + NodeSlot.Flags] = flags & ~Flag.Watching;
		}
		queuedLength = insertIndex;
		while (firstInsertedIndex < --insertIndex) {
			const leftId = queued[firstInsertedIndex];
			queued[firstInsertedIndex++] = queued[insertIndex];
			queued[insertIndex] = leftId;
		}
	},
	// A record went to the free list (explicit free, owner collection, or
	// sweep): release everything this library holds for the id, or dead
	// values and closures stay pinned — and traced by every major GC —
	// until the record is reused.
	freed: function freedNode(id): void {
		// A freed record can be recycled after the next sweep. In manual
		// effect mode the queue outlives writes, so a queued id could
		// otherwise be reused by an unrelated node before its flush; scrub
		// it here — the queue is empty outside flush in sync workloads, so
		// this loop runs only for frees during a manual-mode pending window.
		if (notifyIndex !== queuedLength) {
			for (let i = notifyIndex; i < queuedLength; i++) {
				if (queued[i] === id) {
					queued[i] = 0;
				}
			}
		}
		const idx = id >> Arena.NodeIndexShift;
		currentVals[idx] = undefined;
		pendingVals[idx] = undefined;
		fns[idx] = undefined;
		cleanups[idx] = undefined;
		owned[idx] = undefined;
		memoId = -1;
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
		memoId = -1; // freed or unwatched: the read memo may name this record
	},
});

// ---- update behaviors (upstream index.ts, transliterated) -------------------

function updateSignal(id: SignalId, flags: number): boolean {
	M[id + NodeSlot.Flags] = (flags & Host.Hidden) | Flag.Mutable;
	const idx = id >> Arena.NodeIndexShift;
	return currentVals[idx] !== (currentVals[idx] = pendingVals[idx]);
}

// `flags` is the caller's already-loaded word: both call sites (the update
// seam and get's read ladder) have it in hand, and the bits this function
// keeps (Hidden, HasChildEffect) cannot change under checkDirty.
function updateComputed(id: SignalId, flags: number, getter?: NodeFn): boolean {
	if (getter === undefined) {
		getter = fns[id >> Arena.NodeIndexShift];
		if (getter === undefined) {
			return true; // freed mid-walk: treat as changed, the walk moves on
		}
	}
	if (flags & Host.HasChildEffect) {
		disposeChildEffects(id);
	}
	M[id + NodeSlot.DepsTail] = 0;
	M[id + NodeSlot.Flags] = (flags & Host.Hidden) | Flag.Mutable | Flag.RecursedCheck;
	const prevSub = activeSub;
	activeSub = id;
	++cycle;
	memoId = -1; // a new tracking pass must re-link: no reads may memo across it
	++M[SysSlot.EnterDepth];
	const entryVersion = globalVersion;
	try {
		const idx = id >> Arena.NodeIndexShift;
		const oldValue = currentVals[idx];
		const changed = oldValue !== (currentVals[idx] = getter(oldValue));
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
function run(id: SignalId, fn: NodeFn): void {
	const flags = M[id + NodeSlot.Flags];
	if (
		flags & Flag.Dirty
		|| (
			flags & Flag.Pending
			&& checkDirty(M[id + NodeSlot.Deps], id)
		)
	) {
		if (flags & Host.HasChildEffect) {
			disposeChildEffects(id);
		}
		const idx = id >> Arena.NodeIndexShift;
		if (cleanups[idx]) {
			runCleanup(idx);
			if (!(M[id + NodeSlot.Flags] & Flag.Live)) {
				return; // the cleanup disposed this effect
			}
		}
		M[id + NodeSlot.DepsTail] = 0;
		M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & Host.Hidden) | Flag.Watching | Flag.RecursedCheck;
		const prevSub = activeSub;
		activeSub = id;
		++cycle;
		memoId = -1;
		++M[SysSlot.EnterDepth];
		++runDepth;
		try {
			cleanups[idx] = fn() as (() => void) | void;
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
			queued[notifyIndex++] = 0;
			// A zeroed entry was scrubbed (freed while queued); a live id
			// with no callback was disposed while queued.
			if (id !== 0) {
				const fn = fns[id >> Arena.NodeIndexShift];
				if (fn !== undefined) {
					run(id, fn);
				}
			}
		}
	} finally {
		// Abnormal exit (an effect threw): survivors are re-armed — a change
		// to THEIR dependencies re-notifies them — but the failed flush does
		// not resume on unrelated writes (upstream parity).
		while (notifyIndex < queuedLength) {
			const id = queued[notifyIndex];
			queued[notifyIndex++] = 0;
			if (id !== 0 && fns[id >> Arena.NodeIndexShift] !== undefined) {
				M[id + NodeSlot.Flags] |= Flag.Watching | Flag.Recursed;
			}
		}
		notifyIndex = 0;
		queuedLength = 0;
	}
}

/** Immediately run every queued effect. Throws inside an open batch. */
export function flushEffects(): void {
	if (batchDepth !== 0) {
		throw new Error('dalien-signals: cannot flush effects inside an open batch');
	}
	if (!notifyIndex) {
		flush();
	}
}

/**
 * Choose whether writes run queued effects synchronously or leave them for
 * flushEffects(). Switching back to sync drains pending effects immediately
 * unless a batch or effect drain is already active.
 */
export function setEffectMode(mode: 'sync' | 'manual'): 'sync' | 'manual' {
	const previous = manualEffects ? 'manual' : 'sync';
	manualEffects = mode === 'manual';
	if (!manualEffects && !batchDepth && !notifyIndex) {
		flush();
	}
	return previous;
}

// ---- teardown helpers --------------------------------------------------------

function runCleanup(idx: number): void {
	const cleanup = cleanups[idx] as () => void;
	cleanups[idx] = undefined;
	const prevSub = activeSub;
	activeSub = 0;
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
	let l: LinkId = M[sub + NodeSlot.DepsTail];
	while (l !== 0) {
		const prev: LinkId = M[l + LinkSlot.PrevDep];
		if ((M[M[l + LinkSlot.Dep] + NodeSlot.Flags] & Host.KindMask) >= Host.Effect) {
			unlink(l, sub);
		}
		l = prev;
	}
}

function disposeAllDepsInReverse(sub: SignalId): void {
	let l: LinkId = M[sub + NodeSlot.DepsTail];
	while (l !== 0) {
		const prev: LinkId = M[l + LinkSlot.PrevDep];
		unlink(l, sub);
		l = prev;
	}
}

// Drop the dependency edges a tracking pass did not re-establish (upstream's
// purgeDeps): everything after the pass's depsTail ages out.
function purgeDeps(sub: SignalId): void {
	const depsTail: LinkId = M[sub + NodeSlot.DepsTail];
	let l: LinkId = depsTail !== 0 ? M[depsTail + LinkSlot.NextDep] : M[sub + NodeSlot.Deps];
	while (l !== 0) {
		l = unlink(l, sub);
	}
}

// The effect/scope teardown (upstream's effectOper + effectScopeOper), shared
// by dispose() and unwatched() delivery. The graph teardown itself — deps
// unlinked in reverse, subscribers unlinked, child stops delivered — is
// freeNode's job, and ONLY freeNode's: doing any of it here too would unlink
// the same edges twice (a self-dispose mid-run leaves DepsTail mid-chain, so
// a second reverse walk re-frees links and corrupts the free list). Clearing
// the fns slot FIRST makes the reentrant unwatched() that freeNode delivers
// for this very node a no-op.
function disposeEffect(id: SignalId): void {
	const idx = id >> Arena.NodeIndexShift;
	if (fns[idx] === undefined) {
		return; // already disposed
	}
	fns[idx] = undefined;
	memoId = -1; // freed records recycle their ids; the memo must not
	freeNode(id, M[id + NodeSlot.Gen]);
	if (cleanups[idx]) {
		runCleanup(idx);
	}
	const region = owned[idx];
	if (region !== undefined) {
		// A scope frees the signals/computeds minted inside it — DEFERRED to
		// a microtask, so disposal costs land off the disposing caller's
		// clock (where garbage-collected graphs pay theirs). Gen-guarded:
		// members freed early, or whose records were reused, no-op.
		owned[idx] = undefined;
		pendingRegions.push(region);
		if (!regionFlushScheduled) {
			regionFlushScheduled = true;
			queueMicrotask(freePendingRegions);
		}
	}
}

const pendingRegions: number[][] = [];
let regionFlushScheduled = false;

function freePendingRegions(): void {
	regionFlushScheduled = false;
	memoId = -1;
	for (let r = 0; r < pendingRegions.length; r++) {
		const region = pendingRegions[r];
		for (let i = 0; i < region.length; i += 2) {
			const member: SignalId = region[i];
			fns[member >> Arena.NodeIndexShift] = undefined;
			freeNode(member, region[i + 1]);
		}
	}
	pendingRegions.length = 0;
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
	activeSub = sub !== undefined ? sub : 0;
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
 */
export function growCapacity(records: number): void {
	system.growCapacity(records);
}

/**
 * Tear down the whole default graph: every id is invalid afterwards, and
 * the arena rewinds for reuse at its grown capacity. Cleanups of watched
 * effects run; version counters keep counting.
 */
export function reset(): void {
	system.reset();
	currentVals.length = 0;
	pendingVals.length = 0;
	fns.length = 0;
	cleanups.length = 0;
	owned.length = 0;
	pendingRegions.length = 0;
	queued.length = 0;
	notifyIndex = 0;
	queuedLength = 0;
	activeSub = 0;
	currentScope = 0;
	memoId = -1;
	batchDepth = 0;
	runDepth = 0;
	triggerScratch = 0;
	triggerScratchBusy = false;
	// globalVersion and cycle keep counting: fresh records hold zeroed
	// snapshots/versions, which can never equal them.
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
 * effect(() => console.log(get(count))); // 0
 * startBatch();
 * try {
 *   set(count, 1);
 *   set(count, 2);
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
	if (!--batchDepth && !manualEffects) {
		flush();
	}
}

/** Return whether `id` is a live signal. */
export function isSignal(id: SignalId): boolean {
	return (M[id + NodeSlot.Flags] & (Host.KindMask | Flag.Live)) === (Host.Signal | Flag.Live);
}

/** Return whether `id` is a live computed. */
export function isComputed(id: SignalId): boolean {
	return (M[id + NodeSlot.Flags] & (Host.KindMask | Flag.Live)) === (Host.Computed | Flag.Live);
}

/** Return whether `id` is a live effect. */
export function isEffect(id: SignalId): boolean {
	return (M[id + NodeSlot.Flags] & (Host.KindMask | Flag.Live)) === (Host.Effect | Flag.Live);
}

/** Return whether `id` is a live effect scope. */
export function isEffectScope(id: SignalId): boolean {
	return (M[id + NodeSlot.Flags] & (Host.KindMask | Flag.Live)) === (Host.Scope | Flag.Live);
}

/**
 * Create a reactive value and return its handle (a number). Read it with
 * {@link get}, write it with {@link set}.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * get(count);     // 0
 * set(count, 1);
 * get(count);     // 1
 * ```
 */
export function signalId<T>(): SignalIdOf<T | undefined>;
export function signalId<T>(initialValue: T, owner?: WeakKey): SignalIdOf<T>;
export function signalId<T>(initialValue?: T, owner?: WeakKey): SignalIdOf<T | undefined> {
	// With an owner, the record frees itself when the owner is collected —
	// the GC-managed lifetime for hosts that wrap handles in objects.
	// Without one, the handle lives until dispose()/reset().
	const id = owner !== undefined
		? system.createNode(owner, Host.Signal | Flag.Mutable)
		: system.allocNode(Host.Signal | Flag.Mutable);
	const idx = id >> Arena.NodeIndexShift;
	currentVals[idx] = initialValue;
	pendingVals[idx] = initialValue;
	if (owner === undefined && currentScope !== 0) {
		owned[currentScope >> Arena.NodeIndexShift]!.push(id, M[id + NodeSlot.Gen]);
	}
	return id;
}

/**
 * Read a signal or computed by handle, tracking it as a dependency of the
 * active subscriber.
 */
let memoId = -1;
let memoSub: SignalId = -1 as SignalId;
let memoVal: unknown;

export function get<T>(id: SignalIdOf<T>): T {
	// This head must stay TINY: it is the entire cost of a repeated read,
	// and it has to inline through the callable opers into user getters —
	// V8 rejects candidates once a hot compile's cumulative inlined size
	// is spent, and the read path loses exactly those races when it is one
	// big function (measured: the callable API carried a 10-25% wrapper
	// tax purely from get() at 184 bytecodes failing to inline). The memo
	// key is (id, sub) only; every ++globalVersion / ++cycle site clears
	// memoId instead of the read comparing them.
	if (id === memoId && activeSub === memoSub) {
		return memoVal as T;
	}
	return getFresh(id) as T;
}

function getFresh(id: SignalId): unknown {
	// The version gate: a snapshot equal to the current globalVersion proves
	// nothing observed has been written since this node was last verified.
	if (D[(id >> Arena.VersionShift) + Arena.VersionOffset] === globalVersion) {
		if (activeSub !== 0) {
			link(id, activeSub, cycle);
		}
		const value = currentVals[id >> Arena.NodeIndexShift];
		memoId = id;
		memoSub = activeSub;
		memoVal = value;
		return value;
	}
	return getSlow(id);
}

function getSlow(id: SignalId, getter?: NodeFn): unknown {
	const flags = M[id + NodeSlot.Flags];
	if ((flags & Host.KindMask) === Host.Signal) {
		if (flags & Flag.Dirty) {
			// Commit-on-read: a staged write inside an open batch.
			if (updateSignal(id, flags)) {
				const subs: LinkId = M[id + NodeSlot.Subs];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		}
		// A committed signal is current by definition: snapshot so reads hit
		// the version gate until the next write anywhere.
		D[(id >> Arena.VersionShift) + Arena.VersionOffset] = globalVersion;
	} else if (flags & Flag.Dirty) {
		if (updateComputed(id, flags, getter)) {
			const subs: LinkId = M[id + NodeSlot.Subs];
			if (subs !== 0) {
				shallowPropagate(subs);
			}
		}
	} else if (flags & Flag.Pending) {
		const entryVersion = globalVersion;
		if (checkDirty(M[id + NodeSlot.Deps], id)) {
			if (updateComputed(id, M[id + NodeSlot.Flags], getter)) {
				const subs: LinkId = M[id + NodeSlot.Subs];
				if (subs !== 0) {
					shallowPropagate(subs);
				}
			}
		} else {
			M[id + NodeSlot.Flags] = flags & ~Flag.Pending;
			D[(id >> Arena.VersionShift) + Arena.VersionOffset] = entryVersion;
		}
	}
	// A reentrant self-read of a mid-update computed lands here with neither
	// bit set (the update in progress already cleared them): stale read by
	// contract.
	if (activeSub !== 0) {
		link(id, activeSub, cycle);
	}
	return currentVals[id >> Arena.NodeIndexShift];
}

/** Write a signal by handle. Equal values (Object.is-style ===) are ignored. */
export function set<T>(id: SignalIdOf<T>, value: T): void {
	const idx = id >> Arena.NodeIndexShift;
	if (pendingVals[idx] !== (pendingVals[idx] = value)) {
		M[id + NodeSlot.Flags] = (M[id + NodeSlot.Flags] & Host.Hidden) | Flag.Mutable | Flag.Dirty;
		// Every committed write invalidates the version snapshots.
		++globalVersion;
		memoId = -1;
		const subs: LinkId = M[id + NodeSlot.Subs];
		if (subs !== 0) {
			propagate(subs, runDepth !== 0);
			if (!manualEffects && !batchDepth) {
				flush();
			}
		}
	}
}

/**
 * Create a cached value derived from the signals and computeds read by
 * `getter`, and return its handle. Its argument is the previous value, or
 * `undefined` initially.
 *
 * @example
 * ```ts
 * const count = signal(2);
 * const doubled = computed(() => get(count) * 2);
 * get(doubled); // 4
 * ```
 */
export function computedId<T>(getter: (previousValue?: T) => T, owner?: WeakKey): SignalIdOf<T> {
	// Minted DIRTY: the first read takes the update path (upstream's cold
	// first evaluation), against an empty subscriber list. `owner` as in
	// signal(): its collection frees the record.
	const id = owner !== undefined
		? system.createNode(owner, Host.Computed | Flag.Mutable | Flag.Dirty)
		: system.allocNode(Host.Computed | Flag.Mutable | Flag.Dirty);
	fns[id >> Arena.NodeIndexShift] = getter as NodeFn;
	if (owner === undefined && currentScope !== 0) {
		owned[currentScope >> Arena.NodeIndexShift]!.push(id, M[id + NodeSlot.Gen]);
	}
	return id;
}

/**
 * Run `fn` immediately, then rerun it when a value it read changes.
 * `fn` may return cleanup work. Stop the effect with {@link dispose}.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * const e = effect(() => console.log(get(count))); // 0
 * set(count, 1); // 1
 * dispose(e);
 * ```
 */
export function effectId(fn: () => void | (() => void)): SignalId {
	const id = system.allocNode(Host.Effect | Flag.Watching | Flag.RecursedCheck);
	const idx = id >> Arena.NodeIndexShift;
	fns[idx] = fn as NodeFn;
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
		cleanups[idx] = fn() as (() => void) | void;
	} finally {
		--runDepth;
		--M[SysSlot.EnterDepth];
		activeSub = prevSub;
		M[id + NodeSlot.Flags] &= ~Flag.RecursedCheck;
	}
	return id;
}

/**
 * Run `fn` and group every nested effect it creates; dispose() of the scope
 * stops the group and runs its cleanup work.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * const scope = effectScope(() => {
 *   effect(() => console.log(get(count)));
 * });
 * dispose(scope);
 * set(count, 1); // No log; the scope is stopped.
 * ```
 */
export function effectScopeId(fn: () => void): SignalId {
	const id = system.allocNode(Host.Scope | Flag.Mutable);
	fns[id >> Arena.NodeIndexShift] = fn as NodeFn;
	owned[id >> Arena.NodeIndexShift] = [];
	const prevSub = activeSub;
	const prevScope = currentScope;
	activeSub = id;
	currentScope = id;
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
		currentScope = prevScope;
	}
	return id;
}

/**
 * Free a node by handle. Effects and scopes tear down (cleanups run, child
 * effects cascade); signals and computeds release their record. Repeat
 * disposals are harmless no-ops.
 */
export function dispose(id: SignalId): void {
	const flags = M[id + NodeSlot.Flags];
	if (!(flags & Flag.Live)) {
		return; // already freed
	}
	if ((flags & Host.KindMask) >= Host.Effect) {
		disposeEffect(id);
	} else {
		fns[id >> Arena.NodeIndexShift] = undefined;
		memoId = -1;
		freeNode(id, M[id + NodeSlot.Gen]);
	}
}

/**
 * AUTOMATIC memory management with a handle object: mint a signal whose
 * record frees itself when `owner` is garbage collected, stamp the id and
 * generation onto the owner, and return it. The owner is whatever object
 * represents the signal to your code (a wrapper with read/write methods, a
 * component record, ...):
 *
 * ```ts
 * let id: SignalIdOf<number>;
 * const count = signalOwner(0, {
 *   read: () => get(id),
 *   write: (v: number) => set(id, v),
 * });
 * id = count[SignalIdKey];
 * ```
 */
export function signalOwner<T, R extends WeakKey>(initialValue: T, owner: R): SignalOwner<T, R> {
	const id = signalId(initialValue, owner);
	const stamped = owner as SignalOwner<T, R>;
	stamped[SignalIdKey] = id;
	stamped[SignalGenKey] = M[id + NodeSlot.Gen];
	return stamped;
}

/** signalOwner's computed twin: see {@link signalOwner}. */
export function computedOwner<T, R extends WeakKey>(getter: (previousValue?: T) => T, owner: R): SignalOwner<T, R> {
	const id = computedId(getter, owner);
	const stamped = owner as SignalOwner<T, R>;
	stamped[SignalIdKey] = id;
	stamped[SignalGenKey] = M[id + NodeSlot.Gen];
	return stamped;
}

// ---- default callables --------------------------------------------------------
// The DEFAULT creators return callables in the upstream alien-signals
// shape — `sig()` reads, `sig(next)` writes, `stop()` disposes — and each
// callable is its own garbage-collection owner: drop it and the node
// reclaims, so the basic API cannot leak. A call goes straight to the
// module fast paths with the id in the closure context (no property load,
// no method dispatch). Hosts that want zero allocations per node use the
// raw tier (signalId/computedId + get/set) and manage lifetime explicitly.

/** A reactive value: call with no arguments to read, one argument to write. */
export interface WriteableSignal<T> {
	(): T;
	(value: T): void;
}

/** A cached derived value: call to read. */
export interface ReadableSignal<T> {
	(): T;
}

/** Stops its effect (or effect scope) when called. */
export type EffectStop = () => void;

// The callables deliberately carry NO id property: one property store on a
// fresh closure is a map transition, measured at ~30ns of the ~50ns mint —
// it alone held createSignals at 1.5x the fused engine. Workflows that
// want record ids use the raw tier creators (signalId/computedId/effectId/
// effectScopeId), which return the id itself.

/**
 * Create a reactive value (leak-free default: the returned callable owns
 * the node; dropping it reclaims the record).
 *
 * @example
 * ```ts
 * const count = signal(0);
 * count();   // 0
 * count(1);
 * count();   // 1
 * ```
 */
// Kind-specialized read paths for the callable tier, shaped like the fused
// engine's read()/computedRead(): a SIGNAL read is a flags check, a link,
// and the value load — the version gate and the read memo exist to make
// the kind-dispatching raw get() fast, and putting them on every callable
// read is what made the callable tier measure 10-25% over raw (BENCHMARKS
// "Write-size crossover matrix"). Verification cost belongs to computeds,
// paid per re-verification in readComputed's gate, not per read.
function readSignal(id: SignalId): unknown {
	const flags = M[id + NodeSlot.Flags];
	if (flags & Flag.Dirty) {
		// Commit-on-read: a staged write inside an open batch.
		if (updateSignal(id, flags)) {
			const subs: LinkId = M[id + NodeSlot.Subs];
			if (subs !== 0) {
				shallowPropagate(subs);
			}
		}
	}
	if (activeSub !== 0) {
		link(id, activeSub, cycle);
	}
	return currentVals[id >> Arena.NodeIndexShift];
}

function readComputed(id: SignalId, getter?: NodeFn): unknown {
	// The version gate: a snapshot equal to the current globalVersion
	// proves nothing observed has been written since this node was last
	// verified.
	if (D[(id >> Arena.VersionShift) + Arena.VersionOffset] === globalVersion) {
		if (activeSub !== 0) {
			link(id, activeSub, cycle);
		}
		return currentVals[id >> Arena.NodeIndexShift];
	}
	return getSlow(id, getter);
}

export function signal<T>(): WriteableSignal<T | undefined>;
export function signal<T>(initialValue: T): WriteableSignal<T>;
export function signal<T>(initialValue?: T): WriteableSignal<T | undefined> {
	const oper = (...value: [T?]) => {
		if (value.length) {
			set(id, value[0] as T);
		} else {
			return readSignal(id);
		}
	};
	const id = signalId(initialValue, oper);
	return oper as WriteableSignal<T | undefined>;
}

/**
 * Create a cached value derived from the signals and computeds read by
 * `getter` (leak-free default: the callable owns the node).
 *
 * @example
 * ```ts
 * const count = signal(2);
 * const doubled = computed(() => count() * 2);
 * doubled(); // 4
 * ```
 */
export function computed<T>(getter: (previousValue?: T) => T): ReadableSignal<T> {
	const oper = () => readComputed(id, getter as NodeFn) as T;
	const id = computedId(getter, oper);
	return oper as ReadableSignal<T>;
}

/**
 * Run `fn` immediately, then rerun it when a value it read changes; returns
 * a function that stops it. Effects live until stopped (or until their
 * owning scope disposes) — they are kept alive by the graph, not by the
 * returned callable.
 */
export function effect(fn: () => void | (() => void)): EffectStop {
	const id = effectId(fn);
	return () => {
		dispose(id);
	};
}

/**
 * Run `fn` and group every nested effect it creates; calling the returned
 * function stops the group, its effects, and the signals/computeds created
 * inside it (region ownership).
 */
export function effectScope(fn: () => void): EffectStop {
	const id = effectScopeId(fn);
	return () => {
		dispose(id);
	};
}

function noopEffectBody(): void {}

// One persistent scratch subscriber for trigger(), minted on first use and
// reused ever after (its record is only released by reset(), which also
// clears this cache). Watching|RecursedCheck together keep the propagation
// ladder from ever notifying it. A reentrant trigger — rare — falls back to
// a throwaway node.
let triggerScratch: SignalId = 0;
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
		id = system.allocNode(Flag.Watching | Flag.RecursedCheck);
		fns[id >> Arena.NodeIndexShift] = noopEffectBody as NodeFn;
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
		memoId = -1;
		let l: LinkId = M[id + NodeSlot.Deps];
		while (l !== 0) {
			const dep: SignalId = M[l + LinkSlot.Dep];
			l = unlink(l, id);
			const subs: LinkId = M[dep + NodeSlot.Subs];
			if (subs !== 0) {
				propagate(subs, runDepth !== 0);
				shallowPropagate(subs);
			}
		}
		--M[SysSlot.EnterDepth];
		if (persistent) {
			triggerScratchBusy = false;
		} else {
			fns[id >> Arena.NodeIndexShift] = undefined;
			freeNode(id, M[id + NodeSlot.Gen]);
		}
		if (!--batchDepth && !manualEffects) {
			flush();
		}
	}
}

export { ReactiveFlags, type SignalId } from './system.js';
