/*
 * dalien-signals system: the alien-signals v3.2.x algorithm on a
 * data-oriented, interleaved Int32Array record arena.
 *
 * This replaces the upstream object-graph kernel (ReactiveNode/Link objects,
 * cons-cell traversal stacks) with the layout proven in this repo's research
 * program (libs/arena, 179/179 reactive-framework-test-suite conformance;
 * see research/RESEARCH.md §7b and research/packed-structs-guide.md):
 *
 * - Nodes and links are integer ids into ONE flat Int32Array arena (M),
 *   stride 8; ids are pre-multiplied record offsets (id = recordIndex * 8) so
 *   field access is `M[id + FIELD]`. Nodes and links interleave in the same
 *   arena: single base register, single bump pointer, two free lists (arena
 *   merge measured -2% deep / -8% diamond vs split arenas). Record 0 is
 *   burned as NULL, so every `x !== undefined` upstream becomes `x !== 0`.
 * - Values and functions live in packed side arrays indexed off the id
 *   (`values` holds two slots per record: current/computed value + signal
 *   pending value or effect cleanup; `fns` holds one). One packed value
 *   column — never type-segregated (measured loss).
 * - The flags word carries the six upstream semantic bits PLUS kind bits, so
 *   type dispatch (upstream `'getter' in node` / `'currentValue' in node`)
 *   is a bit test on the same 4-byte load as the state check.
 * - Upstream's `{value, prev}` cons stacks become persistent Int32Array
 *   scratch stacks with base-pointer save/restore: checkDirty -> update ->
 *   user getter RE-ENTERS checkDirty, and the inner call must unwind to its
 *   own base.
 * - `link()` is split into a re-track fast path + out-of-line `linkInsert`:
 *   the monolithic version was 475 bytecodes (over V8's 460 inline budget,
 *   kExceedsBytecodeLimit) and never inlined into the read paths; the split
 *   measured deep -8% / broad -10% / diamond -13%.
 *
 * CAPACITY (immovable arena, zero-indirection handles, growth by
 * migration): the whole engine — including every user-facing handle
 * closure — closes over `const M` (TurboFan embeds the base address;
 * measured at exact const parity — see the v8-growable-buffer-bindings
 * note cited in RESEARCH.md §7). A given arena NEVER grows or moves: that
 * is what makes it safe for handles to capture M directly and call the
 * engine's read/write/computedRead as direct closure-scope calls
 * (upstream-parity hop count). The SYSTEM grows anyway — by migration:
 * when the bump pointer passes 3/4 of capacity, the factory (at the next
 * operation boundary, enterDepth === 0) builds a new engine over an arena
 * twice the size, copies the live prefix (ids are arena-relative offsets,
 * so every id survives), and retires the old engine; retired entry points
 * forward to the current engine, so pre-growth handles keep working one
 * hop behind. Measured cost of the forwarding guards: suite-total within
 * noise (+0.4%); the quiet-read fast paths carry no guard at all (a
 * retired arena is zeroed, so its version snapshots can never hit), and read/write
 * fold the check into kind bits of a flags word they already load.
 * Capacity is virtual until touched (large typed arrays are lazily-mapped
 * zero pages); the STARTING size is the required initialCapacity option of
 * createReactiveSystem, and growCapacity(records) raises it explicitly.
 * A second instantiation of the engine literals (growth, or another
 * system in the process) would permanently disable V8's function-context
 * specialization — the const-M embedding — so generations after the first
 * are compiled from String(createEngine) via new Function when the host
 * allows codegen (see instantiateEngine): fresh function identities,
 * fresh specialization. Measured: post-growth steady state ~1.1-1.2x
 * (was ~1.9x unfixed; the residual is the retired-forward hop on
 * pre-growth handles and mixed-generation call-site feedback), cloned
 * engines alone at parity. Where CSP forbids codegen the static literal
 * is reused and the ~1.9x cost returns — benchs/postGrowth.mjs measures
 * both. Resizable ArrayBuffers were re-measured as the alternative
 * (identity-stable M, no rebuild): ~1.9-2.3x on hot paths ALWAYS, so
 * migration + clones remains the right trade. Exhausting the headroom quarter INSIDE one operation (a single
 * effect/computed body minting that many nodes mid-run) still throws: no
 * live frame may hold a retired arena. Buffers are allocated LAZILY:
 * importing the library costs nothing. Rejected growth alternatives
 * (measured, do not relitigate): segment tables, resizable ArrayBuffers,
 * mutable `let` buffer bindings, per-function const aliases — each taxes
 * every hot-walk access; migration confines the cost to public entry of
 * retired engines.
 *
 * RECLAMATION: effect/effectScope disposal returns node records to the free
 * list (deferred to the next operation boundary so a mid-flush dispose can
 * never recycle a record the queue or an in-flight walk still references; a
 * generation counter in the record makes stale disposers no-ops). Signal and
 * computed records are reclaimed through a required FinalizationRegistry:
 * when the last reference to a handle is collected, the registry callback
 * pushes the record onto the free list (signals register at mint; computeds
 * register at first evaluation, with the handle-owned getter as the weak
 * target). system.reset() reclaims an entire generation wholesale.
 *
 * BREAKING CHANGES vs upstream system.ts: nodes are integer ids, not
 * objects; `createReactiveSystem` no longer takes update/notify/unwatched
 * callbacks (the four node kinds are built in, dispatched on kind bits) and
 * instead returns a complete, self-contained reactive system over integer
 * handles. `Link` no longer exists as a type. `ReactiveFlags` keeps its
 * upstream values and meaning.
 */

// Public flags enum: a REGULAR enum (not const) so it exists at runtime for
// every consumer toolchain (vitest/esbuild transform mode, stripped builds).
// Values match upstream alien-signals exactly. Hot code never touches this
// object — it uses the same-file `const enum Flag` below, which every
// toolchain inlines as numeric literals.
/** Public update-state bits exposed by {@link ReactiveNode.flags}. */
export enum ReactiveFlags {
	/** No update-state bits are set. */
	None = 0,
	/** Changes can continue through this node to its dependents. */
	Mutable = 1,
	/** This node is an effect that should be queued when reached. */
	Watching = 2,
	/** The engine is watching for a write that loops back into the active callback. */
	RecursedCheck = 4,
	/** A recursive write reached this node. */
	Recursed = 8,
	/** This node is known to need an update. */
	Dirty = 16,
	/** An earlier dependency may require this node to update. */
	Pending = 32,
}

// ---- record layout + flags as a same-file const enum -------------------------
// A const enum (not module-level `const`s) so every consumer toolchain inlines
// the values as literals. esbuild BUNDLING demotes module-scope `const` to
// mutable `var` (lazy-init/scope-merge hoisting), which costs TurboFan its
// constant-folding of these hot numbers — measured +15-21% on kairo workloads.
// Same-file const enum members are inlined as numeric literals by esbuild
// (transform AND bundle modes), tsx, vitest, and tsc alike.
// ---- the record layout (public: trusted hosts address the arena directly) --
// Records are 32 bytes: 8 int32 slots. Ids are pre-multiplied record offsets
// (id = recordIndex * 8), so a field access is one indexed load:
// M[id + NodeSlot.Flags]. Node and link records interleave in one arena.

/** Derived index math over the record layout. */
export const enum Arena {
	/**
	 * id -> dense per-node table index: records are 8 slots and ids are
	 * premultiplied, so `id >> NodeIndexShift` is the record number — the
	 * natural index for host-side id-keyed tables.
	 */
	NodeIndexShift = 3,
	/**
	 * A node's version snapshot as an index into the arena's Float64Array
	 * view: `versions[(id >> VersionShift) + VersionOffset]` — the snapshot
	 * is ONE float64 in slots 6-7 (byte offset 24; f64 index = id/2 + 3).
	 */
	VersionShift = 1,
	VersionOffset = 3,
}

/** Node record slots. */
export const enum NodeSlot {
	Flags = 0,
	/** First dependency link; doubles as the free-list next for freed nodes. */
	Deps = 1,
	DepsTail = 2,
	Subs = 3,
	SubsTail = 4,
	/** Generation counter: bumped on free; capture at mint to defuse stale ids. */
	Gen = 5,
	/**
	 * Slots 6-7 hold ONE float64: the node's version snapshot (the host's
	 * globalVersion at last verification), read through the arena's
	 * Float64Array view as versions[(id >> Arena.VersionShift) +
	 * Arena.VersionOffset]. A snapshot equal to the current globalVersion
	 * proves nothing observed has been written since — skip verification.
	 */
	VersionHi = 6,
	VersionLo = 7,
}

/** Link (edge) record slots. */
export const enum LinkSlot {
	/** Tracking-pass version (the host's cycle counter at link time). */
	Version = 0,
	/** The node being depended on. */
	Dep = 1,
	/** The node doing the depending. */
	Sub = 2,
	PrevSub = 3,
	NextSub = 4,
	PrevDep = 5,
	NextDep = 6,
	/**
	 * Free-list thread. Freed links keep every REAL field intact: walks may
	 * deliberately read stale nextDep/nextSub off links unlinked earlier in
	 * the same pass, and those must name former neighbors, never the list.
	 */
	FreeNext = 7,
}

/**
 * Well-known slots of record 0 (the burned null record): system scalars both
 * core and trusted hosts touch directly, with zero call crossings.
 */
/**
 * Well-known slots of record 0 (the burned null record). Only state BOTH
 * sides genuinely share lives here; everything else about tracking (the
 * active subscriber, the pass counter, the write epoch, batching) is plain
 * host variables — upstream's split.
 */
export const enum SysSlot {
	/**
	 * Live frames currently holding the arena in registers. The CORE reads
	 * this as its growth gate (the arena may only move when it is zero), so
	 * it cannot be a host variable. Hosts MUST increment before running user
	 * code that could allocate (getters, effect bodies) and decrement after:
	 * M[SysSlot.EnterDepth]++ / --.
	 */
	EnterDepth = 1,
}

/**
 * Flag bits of a node's state word (M[id + NodeSlot.Flags]). A const enum:
 * the build (tsc) inlines members as literals everywhere — including into
 * compiled engine clones and across module boundaries (isolatedModules is
 * off; per-file transforms like vitest's fall back to the runtime enum
 * object, which only tests pay for). The low bits match upstream
 * alien-signals' ReactiveFlags exactly; hosts building on the raw ops use
 * this enum, ReactiveFlags is the runtime mirror for reflective consumers.
 */
export const enum Flag {
	Mutable = 1,
	Watching = 2,
	RecursedCheck = 4,
	Recursed = 8,
	Dirty = 16,
	Pending = 32,
	/**
	 * The record holds a live node (set by alloc, cleared by free): the
	 * engine's only notion of "kind" — everything else is host bits.
	 */
	Live = 128,
	/**
	 * The record's handle was garbage-collected (FinalizationRegistry fired)
	 * while subscribers still existed; reclaim when the last subscriber
	 * unlinks. Engine-internal, outside PublicMask.
	 */
	Orphaned = 2048,
	/**
	 * The host's start() lifecycle callback ran for this node and its stop()
	 * has not (see ReactiveSystemOptions.start/stop). Engine-internal.
	 */
	HostStarted = 8192,
	/**
	 * Bits 16-27 belong to the HOST: custom kinds plant their dispatch tags
	 * here at mint (custom(hostBits)); the engine never touches them and
	 * preserves them across every state rewrite (see Sticky).
	 */
	HostShift = 16,
	HostMask = 0x0FFF0000,
	/** Engine-internal + host bits every absolute flags store preserves. */
	Sticky = Orphaned | HostStarted | HostMask,
	/**
	 * Bits visible through the public ReactiveNode view (semantic bits +
	 * HasChildEffect, which upstream also kept in the public flags word).
	 */
	PublicMask = 127,
}

// 32-byte records: 1 MB holds 32,768 of them.
const RECORDS_PER_MEGABYTE = (1024 * 1024) / 32;

function normalizeRecords(n: number): number {
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
		throw new TypeError('dalien-signals: capacity must be a positive finite number');
	}
	return Math.max(16, Math.ceil(n));
}

// Exactly one of the two units must be given. Capacity does NOT need to be
// a power of two — it is only ever a length bound (the power-of-two math in
// the layout is the 8-slot record stride, which is fixed).
function resolveCapacity(records: number | undefined, megabytes: number | undefined, which: string): number {
	if (records !== undefined && megabytes !== undefined) {
		throw new TypeError('dalien-signals: give ' + which + ' in records OR megabytes, not both');
	}
	if (records !== undefined) {
		return normalizeRecords(records);
	}
	if (megabytes !== undefined) {
		return normalizeRecords(megabytes * RECORDS_PER_MEGABYTE);
	}
	throw new TypeError('dalien-signals: ' + which + 'Records or ' + which + 'Megabytes is required');
}

function noop(): void {}



/**
 * ONE arena generation's surface, exposed as {@link ReactiveSystem.arena}:
 * the record memory, the per-node version snapshots, and the five graph
 * algorithms compiled over exactly that memory. The whole object is replaced
 * when the arena grows (ids and link ids survive verbatim; these views and
 * closures do not) — re-capture it in the `allocated` callback, and never
 * cache any of it in a local across a call that can allocate. mint/free
 * forward from a retired arena; nothing else here does.
 */
export interface ReactiveArena {
	/**
	 * The record memory: 32-byte records, 8 int32 slots each, addressed as
	 * memory[id + NodeSlot.X] / memory[linkId + LinkSlot.X].
	 */
	readonly memory: Int32Array;
	/**
	 * Float64 view over the same memory holding each node's version
	 * snapshot: versions[(id >> Arena.VersionShift) + Arena.VersionOffset]
	 * is the host's globalVersion at the node's last verification; equality
	 * with the current globalVersion proves the node is current.
	 */
	readonly versions: Float64Array;
	/**
	 * MANUAL memory management: allocate a node record and return its id.
	 * Nothing watches it — pair every allocNode with a freeNode, or the
	 * record lives until reset(). `hostBits` (masked to the host-tag and
	 * public flag ranges) seed the node's flags word. Passing 3/4 capacity
	 * schedules a background growth; allocating from a completely full
	 * arena (mid-operation, or capped by maxCapacity) throws.
	 */
	allocNode(hostBits: number): SignalId;
	/**
	 * MANUAL memory management: free a node record. Its edges unlink (with
	 * unwatched delivery for subscribers that empty), and the record is
	 * recycled at the next operation boundary. Gen-guarded: a stale
	 * (id, gen) pair is a harmless no-op, so double-frees are safe.
	 */
	freeNode(id: SignalId, gen: SignalGen): void;

	// ---- the five graph ops -----------------------------------------------
	// The same algorithms upstream alien-signals' index.ts builds on, with
	// the same shapes: the host reads memory[id + NodeSlot.Subs]/Deps itself
	// and passes LINK ids, owns its own tracking state (the active
	// subscriber, its pass counter, its globalVersion), runs its own effect
	// queue and batching, and brackets user-code frames with
	// memory[SysSlot.EnterDepth]++/--.

	/**
	 * Edge insert/refresh between `dep` and `sub` with the caller's
	 * tracking-pass `version` (the host's cycle counter). Returns the edge id.
	 */
	link(depId: SignalId, subId: SignalId, version: number): LinkId;
	/**
	 * Edge removal. `subId` defaults to the link's recorded subscriber;
	 * passing it saves the load when the caller already knows it (dependency
	 * purges). Returns the link's nextDep, so a purge loop is
	 * `while (l !== 0) l = unlink(l, sub)`.
	 */
	unlink(linkId: LinkId, subId?: SignalId): LinkId;
	/**
	 * The invalidation wave over a SUBS list: marks the transitive
	 * subscriber closure Pending/Dirty and notifies Watching nodes. The
	 * caller bumps the epoch and flushes; `innerWrite` is true when the
	 * write happened inside an active update (host runDepth > 0).
	 */
	propagate(subsLinkId: LinkId, innerWrite: boolean): void;
	/**
	 * Recursive staleness resolution over a DEPS list: returns true if
	 * `sub` must recompute (some dependency's value actually changed —
	 * updates run through the `update` seam during the walk).
	 */
	checkDirty(depsLinkId: LinkId, subId: SignalId): boolean;
	/**
	 * One-level promotion over a SUBS list: Pending subscribers become
	 * Dirty, Watching ones are notified. Call after an in-place value
	 * change (the Dirty|Pending upgrade after a changed recompute).
	 */
	shallowPropagate(subsLinkId: LinkId): void;
}

/** The self-contained reactive system returned by {@link createReactiveSystem}. */
export interface ReactiveSystem {
	/**
	 * The current arena generation (memory, version snapshots, the five
	 * graph ops). Reading it allocates the arena if none exists yet; the
	 * object is REPLACED on growth, so bind to it in the `allocated`
	 * callback rather than caching it.
	 */
	readonly arena: ReactiveArena;
	/**
	 * Raise the arena's capacity to at least `records` 32-byte records
	 * (no-op if already that big; TypeError on a non-positive or non-finite
	 * request; RangeError past maxCapacity). Grows immediately when the
	 * system is idle; a request made mid-operation (inside an effect or
	 * getter) is stashed and applied at the next operation boundary, where
	 * growth is safe.
	 */
	growCapacity(records: number): void;
	/**
	 * Bulk arena teardown for generation-scoped lifecycles (per-request
	 * graphs, worker pools, benchmark harness cleanup): rewinds the record
	 * arena, truncates the value/callback tables, and replaces the
	 * FinalizationRegistry, so an entire dead generation is reclaimed by the
	 * GC as a few large objects instead of one weak cell per handle. Every
	 * handle created before the reset is invalid afterwards — calling one is
	 * undefined behavior. Throws if called during an active operation
	 * (inside an effect, computed getter, batch, or trigger). The engine
	 * itself (and its warmed-up JIT state) is reused across resets.
	 */
	reset(): void;
	/**
	 * Mint a host-kind node. `hostBits` (masked to HOST_MASK) are your
	 * AUTOMATIC memory management: allocate a node record whose lifetime is
	 * tied to `owner` — the record frees itself when `owner` is garbage
	 * collected, so pass the object whose reachability should keep the node
	 * alive (a handle closure, a state object). Grows the arena first when
	 * it is running out of space. `hostBits` seeds the node's flags word as
	 * in arena.allocNode.
	 *
	 * There is deliberately no owner -> id lookup here: keeping one costs a
	 * WeakMap write and a tokened registry entry per mint (measured ~10x on
	 * creation-heavy workloads). Hold the id (disposers close over it), or
	 * keep your own map.
	 */
	createNode(owner: WeakKey, hostBits?: number): SignalId;
	/**
	 * Tie an ALREADY-MINTED node's lifetime to `owner`, as createNode does
	 * at mint. For hosts whose owner object needs the id to exist first
	 * (e.g. a callable bound to the id): allocNode, build the owner, adopt.
	 */
	adoptNode(owner: WeakKey, id: SignalId): void;
	/**
	 * MANUAL memory management with the growth boundary check: like
	 * arena.allocNode, but grows the arena first when it is running out of
	 * space (the safe default for mint paths). No owner, no watch — pair
	 * with disposeNode/freeNode, or the record lives until reset().
	 */
	allocNode(hostBits?: number): SignalId;
	/**
	 * Free a node made by createNode. Gen-guarded when `gen` is given;
	 * without it the record's CURRENT generation is used — only omit it for
	 * an id you know is live. Stale generations and already-freed nodes are
	 * harmless no-ops. (The garbage-collection watch on the owner is NOT
	 * cancelled; when it eventually fires, the generation guard makes it a
	 * no-op.)
	 */
	disposeNode(id: SignalId, gen?: SignalGen): void;
	/**
	 * The node's current generation (memory[id + NodeSlot.Gen]): capture at
	 * mint and compare before acting on a stored id — a mismatch means the
	 * record was freed (and possibly reused) in the meantime.
	 */
	generationOf(id: SignalId): SignalGen;
	/** Allocation accounting (debugging/tests): walks the free lists, O(free). */
	stats(): {
		capacityRecords: number;
		allocatedRecords: number;
		freeNodeRecords: number;
		freeLinkRecords: number;
		pendingFreeRecords: number;
		pendingRegistrations: number;
	};
}

export interface ReactiveSystemOptions {
	/**
	 * Arena STARTING capacity, allocated when the system is created — as a
	 * count of 32-byte records, or as megabytes; give exactly one. Capacity
	 * is virtual until touched (typed arrays are lazily-mapped zero pages);
	 * a graph outgrowing it migrates to a bigger arena automatically, and
	 * growCapacity() raises it explicitly. Any size >= 16 records works —
	 * powers of two are not required.
	 */
	capacityRecords?: number;
	capacityMegabytes?: number;
	/**
	 * Ceiling on the arena, in records or megabytes (at most one; default
	 * unlimited). Automatic growth stops here — once a full arena is at max
	 * capacity, allocation throws — and a growCapacity() request past it
	 * throws a RangeError. Must be >= the starting capacity.
	 */
	maxCapacityRecords?: number;
	maxCapacityMegabytes?: number;
	/**
	 * The effect scheduler (upstream's `notify` seam, id-shaped): the
	 * propagation wave reports each Watching node here exactly once,
	 * clearing its Watching bit as the dedup. The host owns the queue, the
	 * ordering, the batching, and the running.
	 *
	 * Contract:
	 * - queue (id, gen) and run it eventually, re-arming Watching after the
	 *   run — the dedup only resets when the host sets the bit again;
	 * - `gen` makes stale ids harmless: compare against M[id + NodeSlot.Gen]
	 *   before running, and a disposed-and-recycled record is skipped;
	 * - notifications fire at write time (propagate), batched or not — the
	 *   host decides when to flush.
	 */
	notify?: (effectId: SignalId, gen: SignalGen) => void;
	/**
	 * Resolve a node's update (upstream's `update` seam): the graph walks
	 * hand over every Mutable node whose staleness resolved to Dirty, and
	 * the host does EVERYTHING — reset the flags word (preserving the bits
	 * outside ReactiveFlags), re-track dependencies, recompute, snapshot the
	 * version — and
	 * returns whether the value changed (the equality cut-off). `flags` is
	 * the node's word at entry; dispatch on your host bits.
	 */
	update?: (id: SignalId, flags: number) => boolean;
	/**
	 * Watched-lifecycle callbacks (upstream's `unwatched`, split in two).
	 * `watched` runs when a node gains its FIRST subscriber; whatever it
	 * returns is stored and passed to `unwatched` when the node's LAST
	 * subscriber unlinks. `unwatched` is delivered whether or not `watched`
	 * is defined — it is how a host learns a computed went cold or an owned
	 * effect lost its parent.
	 *
	 * - Delivery is INLINE, inside graph operations — treat callbacks like
	 *   effect-cleanup code (reads/writes are fine and queue normally).
	 * - Laziness makes "watched" approximate observed-by-an-effect: an
	 *   unobserved computed never evaluates, so it never links dependencies.
	 * - `reset()` delivers `unwatched` for every watched node (newest
	 *   first); those callbacks must not touch reactive state mid-reset.
	 */
	watched?: (id: SignalId) => unknown;
	unwatched?: (id: SignalId, state: unknown) => void;
	/**
	 * A node record was recycled onto the free list (explicit free, owner
	 * collection, or reclamation sweep): drop everything the host still
	 * holds for this id — values, callbacks — or dead closures stay pinned
	 * (and garbage-collector-traced) until the record is reused.
	 */
	freed?: (id: SignalId) => void;
	/**
	 * Runs when an arena generation comes into being: once inside
	 * createReactiveSystem (the arena is allocated eagerly), and again after
	 * every growth. Bind your views of {@link ReactiveSystem.arena} here —
	 * it fires before any node can observe the new arena.
	 */
	allocated?: (arena: ReactiveArena) => void;
}

// Branded number types, deliberately LENIENT: any plain number is
// assignable to them (arena reads need no casts — `const dep: SignalId =
// M[l + LinkSlot.Dep]` just works), but the brands are mutually exclusive,
// so a SignalId handed where a LinkId belongs is still a compile error.
declare const IdOf: unique symbol;
/** A node record's id: its starting slot offset in the arena (record * 8). */
export type SignalId = number & { [IdOf]?: 'signal' };
/** An edge record's id, returned by `link`; pass to `unlink`. */
export type LinkId = number & { [IdOf]?: 'link' };
/** A node record's generation; stale (id, gen) pairs are harmless no-ops. */
export type SignalGen = number & { [IdOf]?: 'generation' };


// ---- engine generations and codegen cloning -------------------------------
//
// V8 applies function-context specialization — folding a closure's captured
// `const M` in as a machine-code constant — only while a function literal has
// produced exactly ONE closure. The SECOND instantiation of createEngine
// (arena growth, or another system in the same process) permanently disables
// that for every engine compiled from the same literal. The escape hatch:
// code compiled from NEW source text gets fresh function identities, so each
// later generation is compiled from `String(createEngine)` via new Function
// when the host allows it. createEngine is deliberately CLOSED — its only
// free names are its parameters and globals — so its source is compilable
// anywhere (tests/codegen.spec.ts pins this).

/** Whether this host permits runtime code generation (CSP etc.). Detected once at import. */
export const codegenAvailable = (() => {
	try {
		return (new Function('return 1') as () => number)() === 1;
	} catch {
		return false;
	}
})();

let engineInstantiations = 0; // process-wide: feedback slots are per-literal
let engineSourceText: string | undefined;
// Cloning also requires the RUNTIME source to be self-contained: toolchains
// that inline the const enums (esbuild bundling — the published build; most
// transforms) produce closed source, but a transform that keeps runtime enum
// references leaves clones unresolvable — and new Function parses lazily, so
// the ReferenceError would surface deep inside engine operation. Verdict by
// eager smoke-execution, once per process: compile a clone, push one signal
// through it against a throwaway shared. Failure downgrades to the static
// literal (correct, pays the documented despecialization).
let engineCloneVerdict: boolean | undefined;

function cloneWorks(): boolean {
	try {
		const compile = new Function(engineSourceText + '0') as () => typeof createEngine;
		const dummy: EngineShared = {
			pendingFree: [],
			hostState: [],
			inner: undefined,
			registry: undefined,
			hostNotify: undefined,
			hostUpdate: undefined,
			hostWatched: undefined,
			hostUnwatched: undefined,
			hostFreed: undefined,
			growPending: false,
			boundaryPending: false,
			grow: noop,
			boundaryWork: noop,
			scheduleMaintenance: noop,
		};
		const probe = compile()(64, undefined, {
			recNext: 8,
			nodeFreeHead: 0,
			linkFreeHead: 0,
		}, dummy);
		dummy.inner = probe;
		// Exercise mint, flags, edges, staleness resolution: any unresolved
		// identifier in the cloned source throws here, not later.
		const a = probe.allocNode(1 << 16 | 1); // host tag + Mutable
		const b = probe.allocNode(2 << 16 | 1);
		const edge = probe.link(a, b, 1);
		const M = probe.memory;
		M[a + NodeSlot.Flags] |= Flag.Dirty;
		probe.propagate(edge, false);
		return probe.checkDirty(M[b + NodeSlot.Deps], b) === true;
	} catch {
		return false;
	}
}


/**
 * Whether engine generations can be compiled from source in this
 * environment: runtime codegen is permitted AND the engine's runtime source
 * is self-contained (const enums inlined by the toolchain). The published
 * build satisfies the second condition by construction; some dev/test
 * transforms do not, and fall back to the static literal.
 */
export function codegenSupported(): boolean {
	if (!codegenAvailable) {
		return false;
	}
	engineSourceText ??= 'return (' + String(createEngine) + ');//gen';
	return (engineCloneVerdict ??= cloneWorks());
}

function instantiateEngine(records: number, from: Int32Array | undefined, boot: EngineState, shared: EngineShared): Engine {
	if (++engineInstantiations > 1 && codegenAvailable) {
		engineSourceText ??= 'return (' + String(createEngine) + ');//gen';
		if (engineCloneVerdict ??= cloneWorks()) {
			// Every generation is compiled from its own source text (the
			// trailing generation comment defeats V8's eval compilation
			// cache), so every generation gets its own function identities —
			// and with them its own context specialization.
			const compile = new Function(engineSourceText + engineInstantiations) as () => typeof createEngine;
			return compile()(records, from, boot, shared);
		}
	}
	return createEngine(records, from, boot, shared);
}

/** Hot per-generation counters handed from a retiring engine to its successor. */
interface EngineState {
	recNext: number;
	nodeFreeHead: number;
	linkFreeHead: number;
}

/**
 * State shared by every engine generation of one system, plus the factory
 * services an engine calls back into. Everything here is either a stable
 * array identity or a cold-path mutable slot; hot scalars live inside the
 * engine and travel via {@link EngineState}.
 */
interface EngineShared {
	pendingFree: number[];
	hostState: unknown[];
	inner: Engine | undefined;
	registry: FinalizationRegistry<number> | undefined;
	hostNotify: ((effectId: SignalId, gen: SignalGen) => void) | undefined;
	hostUpdate: ((id: SignalId, flags: number) => boolean) | undefined;
	hostWatched: ((id: SignalId) => unknown) | undefined;
	hostUnwatched: ((id: SignalId, state: unknown) => void) | undefined;
	hostFreed: ((id: SignalId) => void) | undefined;
	growPending: boolean;
	boundaryPending: boolean;
	grow(): void;
	boundaryWork(): void;
	scheduleMaintenance(): void;
}

interface Engine extends ReactiveArena {
	retire(): void;
	state(): EngineState;
	busy(): boolean;
	maybeBoundary(): void;
	resetGuard(): void;
	resetState(): void;
	freeRecordCounts(): { freeNodeRecords: number; freeLinkRecords: number };
	orphan(id: number): void;
	sweepPendingFree(): void;
}

/**
 * Create an independent reactive graph with its own arena, queues, and
 * dependency-tracking state.
 */
export function createReactiveSystem(options: ReactiveSystemOptions): ReactiveSystem {
	let configuredRecords = resolveCapacity(options.capacityRecords, options.capacityMegabytes, 'capacity');
	const maxRecords = options.maxCapacityRecords !== undefined || options.maxCapacityMegabytes !== undefined
		? resolveCapacity(options.maxCapacityRecords, options.maxCapacityMegabytes, 'maxCapacity')
		: Infinity;
	if (configuredRecords > maxRecords) {
		throw new TypeError('dalien-signals: maxCapacity is smaller than the starting capacity');
	}
	// An explicit growCapacity() target; grow() honors it over doubling.
	let requestedRecords = 0;

	// Everything engine generations share: stable array identities plus
	// cold-path mutable slots (see EngineShared). Hot counters live inside
	// each engine and travel between generations via EngineState.
	//
	// Side columns, indexed off the id: values[id >> 2] = current/computed
	// value, values[(id >> 2) + 1] = signal pending value OR effect cleanup fn,
	// fns[id >> 3] = computed getter / effect fn. Plain arrays grown by push
	// (stays PACKED; plain-array growth has no binding problem). Reclamation
	// queues (pendingFree/pendingFnClear) and the effect queue are shared so
	// their contents survive growth. The registry is REQUIRED: dropped
	// signal/computed handles reclaim their records through it (registration
	// is immediate — every batching scheme measured worse), and each
	// registry's callbacks self-disarm once replaced by reset().
	const shared: EngineShared = {
		pendingFree: [],
		hostState: [],
		inner: undefined,
		registry: undefined,
		hostNotify: options?.notify,
		hostUpdate: options?.update,
		hostWatched: options?.watched,
		hostUnwatched: options?.unwatched,
		hostFreed: options?.freed,
		growPending: false,
		boundaryPending: false,
		grow,
		boundaryWork,
		scheduleMaintenance,
	};
	const hostState = shared.hostState;

	// Each registry's callback disarms itself once the registry is no longer
	// current: reset() replaces the registry, but cleanups already enqueued
	// for the old one keep it alive until they drain, and their record ids
	// refer to the pre-reset arena — running them would reclaim whatever new
	// node now occupies that id.
	function mintRegistry(): FinalizationRegistry<number> {
		const minted: FinalizationRegistry<number> = new FinalizationRegistry((id) => {
			if (shared.registry === minted) {
				shared.inner!.orphan(id);
			}
		});
		return minted;
	}

	function materialize(): Engine {
		if (typeof FinalizationRegistry !== 'function') {
			throw new Error('dalien-signals requires FinalizationRegistry (ES2021): dropped signal/computed handles reclaim their records through it');
		}
		shared.registry = mintRegistry();
		const engine = instantiateEngine(configuredRecords, undefined, {
			recNext: 8,
			nodeFreeHead: 0,
			linkFreeHead: 0,
		}, shared);
		shared.inner = engine;
		for (let i = 0; i < allocatedCallbacks.length; i++) {
			allocatedCallbacks[i](engine);
		}
		return engine;
	}



	// ---- operation boundaries: reclamation + growth ---------------------------

	// Reclamation (record sweeps, getter returns) runs in a microtask — after
	// the current synchronous operation, before the next task — mirroring
	// where upstream's GC pays its reclamation cost. The synchronous boundary
	// drain only fires when a long fully-synchronous burst piles work past
	// the caps, keeping memory bounded without taxing the common op.
	let maintenanceScheduled = false;
	// Deferred owner registrations as (owner, id) pairs: a registry cell is
	// weak-GC machinery the collector traces, and creating one per mint
	// inside a mint burst measured worse than queueing (cellx-style
	// create-heavy cells regressed ~35%). Owners are held strongly until
	// the maintenance microtask registers them, so none can be collected
	// before its registration lands.
	let pendingRegister: unknown[] = [];

	// Grow-by-migration: allocate an arena twice the current capacity, copy the
	// live prefix (ids are arena-relative offsets, so every id survives
	// verbatim), build the next engine generation over the new `const M` —
	// handing the hot counters across via prev.state() — and retire the old
	// engine, whose public entry points forward to the current one. Handles
	// minted before the growth keep working at one extra hop. Only runs at
	// operation boundaries (the engine is not busy): no live frame holds the
	// old arena, so nothing can write through it afterwards.
	const allocatedCallbacks: Array<(arena: ReactiveArena) => void> = [];
	if (options?.allocated !== undefined) {
		allocatedCallbacks.push(options.allocated);
	}

	function grow(): void {
		shared.growPending = false;
		let target = requestedRecords > configuredRecords ? requestedRecords : configuredRecords * 2;
		requestedRecords = 0;
		if (target > maxRecords) {
			target = maxRecords;
		}
		if (target <= configuredRecords) {
			return; // already at max capacity; allocation past a full arena throws
		}
		const prev = shared.inner!;
		const next = instantiateEngine(target, prev.memory, prev.state(), shared);
		configuredRecords = target;
		shared.inner = next;
		prev.retire();
		// Hosts re-bind to the new arena now, before any node can observe it.
		for (let i = 0; i < allocatedCallbacks.length; i++) {
			allocatedCallbacks[i](next);
		}
	}

	function scheduleMaintenance(): void {
		if (!maintenanceScheduled) {
			maintenanceScheduled = true;
			queueMicrotask(runMaintenance);
		}
	}

	function runMaintenance(): void {
		maintenanceScheduled = false;
		if (pendingRegister.length !== 0) {
			const registry = shared.registry!;
			for (let i = 0; i < pendingRegister.length; i += 2) {
				registry.register(pendingRegister[i] as WeakKey, pendingRegister[i + 1] as SignalId);
			}
			pendingRegister.length = 0;
		}
		const engine = shared.inner;
		if (engine === undefined || engine.busy()) {
			return;
		}
		if (shared.growPending) {
			grow();
		}
		if (shared.boundaryPending) {
			boundaryWork();
		}
	}

	function boundaryWork(): void {
		shared.boundaryPending = false;
		// boundaryPending is only ever raised by engine code, so `inner` is
		// always materialized by the time this runs. Host effect queues hold
		// (id, gen) pairs, so sweeping cannot misdeliver: a recycled id fails
		// the host's gen check.
		if (shared.pendingFree.length !== 0) {
			shared.inner!.sweepPendingFree();
		}
	}

	// ---- the public system object (stable across engine rebuilds) -------------
	// `e` mirrors `inner` (materialize/boundaryWork reassign both) so hot call
	// sites reach the engine with one property load; everything else is cold
	// delegation through shared.inner (always materialized: creation is eager).

	const facade: ReactiveSystem = {
		// Materializes on first access: callers never see a pre-allocation
		// state. The IDENTITY still changes on growth — bind in `allocated`.
		get arena(): ReactiveArena {
			return shared.inner!;
		},
		growCapacity(records: number): void {
			const target = normalizeRecords(records);
			if (target <= configuredRecords) {
				return; // already that big
			}
			if (target > maxRecords) {
				throw new RangeError('dalien-signals: growCapacity() request exceeds maxCapacity');
			}
			requestedRecords = target;
			if (shared.inner!.busy()) {
				// Mid-operation: growth would move the arena under live
				// frames. Stash the request; maintenance applies it at the
				// next operation boundary.
				shared.growPending = true;
				shared.scheduleMaintenance();
				return;
			}
			grow();
		},
		reset(): void {
			const engine = shared.inner!;
			engine.resetGuard();
			// Bulk arena teardown: rewind the record arena and drop the whole
			// FinalizationRegistry, so a dead generation is reclaimed by the
			// GC as a few large objects instead of one weak cell per handle.
			// Every handle minted before the reset is INVALID afterwards —
			// calling one is undefined behavior (it reads whatever new node
			// occupies its record). The engine closures (and their warmed-up
			// JIT state) are reused; only the arena contents restart.
			// Watched-lifecycle teardown: every started node gets its stop
			// before the arena rewinds (newest records first, LIFO-ish). These
			// callbacks must not touch reactive state mid-reset.
			const M = engine.memory;
			for (let id = engine.state().recNext - 8; id >= 8; id -= 8) {
				const flags = M[id + NodeSlot.Flags];
				if (flags & Flag.HostStarted) {
					const state = hostState[id >> Arena.NodeIndexShift];
					hostState[id >> Arena.NodeIndexShift] = undefined;
					if (shared.hostUnwatched !== undefined) {
						shared.hostUnwatched(id, state);
					}
				}
			}
			hostState.length = 0;
			engine.resetState(); // arena fill + counters + shared queue drains
			shared.boundaryPending = false;
			shared.growPending = false; // capacity stays at its grown size
			shared.registry = mintRegistry();
			// Pre-reset owners must not register against the new generation.
			pendingRegister.length = 0;
		},
		createNode(owner: WeakKey, hostBits?: number): SignalId {
			const engine = shared.inner!;
			engine.maybeBoundary();
			const id = engine.allocNode(hostBits ?? 0);
			pendingRegister.push(owner, id);
			scheduleMaintenance();
			return id;
		},
		allocNode(hostBits?: number): SignalId {
			const engine = shared.inner!;
			engine.maybeBoundary();
			return engine.allocNode(hostBits ?? 0);
		},
		adoptNode(owner: WeakKey, id: SignalId): void {
			pendingRegister.push(owner, id);
			scheduleMaintenance();
		},
		disposeNode(id: SignalId, gen?: SignalGen): void {
			const engine = shared.inner!;
			engine.freeNode(id, gen ?? engine.memory[id + NodeSlot.Gen]);
		},
		generationOf(id: SignalId): SignalGen {
			return shared.inner!.memory[id + NodeSlot.Gen];
		},
		stats() {
			const engine = shared.inner!;
			const { freeNodeRecords, freeLinkRecords } = engine.freeRecordCounts();
			return {
				capacityRecords: engine.memory.length / 8,
				allocatedRecords: (engine.state().recNext - 8) / 8,
				freeNodeRecords,
				freeLinkRecords,
				pendingFreeRecords: shared.pendingFree.length,
				pendingRegistrations: 0,
			};
		},
	};
	materialize();
	return facade;
}

// ---- the engine (one generation over one arena; a CLOSED function) --------
// createEngine's only free names are its parameters and globals: engine
// generations after the first are compiled from String(createEngine) (see
// instantiateEngine), and eval'd code can see nothing else. Hot counters are
// plain locals — each generation is a single closure of its own compilation,
// so V8 folds them (and `const M`) into the optimized code as constants.

function createEngine(records: number, from: Int32Array | undefined, boot: EngineState, shared: EngineShared): Engine {
	const M = new Int32Array(records * 8);
	// Float64 view over the same plane for the one-slot version snapshots.
	const D = new Float64Array(M.buffer);
	if (from !== undefined) {
		// Growth migration: ids are arena-relative offsets, so copying the
		// live prefix preserves every id, edge, generation, and version
		// snapshot —
		// including record 0's system slots.
		M.set(from.subarray(0, boot.recNext));
	}
	// Ask for growth once the bump pointer passes 3/4 of the arena
	// (records * 8 slots * 3/4). The remaining quarter is headroom for
	// allocations made mid-operation, where growing is unsafe.
	const growAt = records * 6;

	// Hot per-generation counters, handed off through boot/state().
	let recNext = boot.recNext; // bump pointer, nodes and links (record 0 burned)
	let nodeFreeHead = boot.nodeFreeHead; // free list threaded through M[id + NodeSlot.Deps]
	let linkFreeHead = boot.linkFreeHead; // free list threaded through M[id + LinkSlot.NextDep]
	// Tracking state (the active subscriber, run depth, batching) is the
	// HOST's, as module or closure lets on its side of the seam — exactly
	// upstream's split. Enter depth (live frames holding the arena; 0 = an
	// operation boundary) lives in record 0 as M[SysSlot.EnterDepth] so the
	// host brackets its own user-code frames with it.

	function snapshot(): EngineState {
		return { recNext, nodeFreeHead, linkFreeHead };
	}

	// Persistent scratch stacks (upstream's cons-cell Stack<T>). Re-entrant
	// walks push above the caller's base and restore it on exit. Walks never
	// span a generation boundary, so each generation gets fresh stacks.
	let propStack = new Int32Array(4096);
	let propSp = 0;
	let checkStack = new Int32Array(4096);
	let checkSp = 0;

	// Stack growth is out of line so the walk loops stay under V8's
	// 460-bytecode inlining budget (enforced by the bytecode budget test).
	function growPropStack(): void {
		const bigger = new Int32Array(propStack.length * 2);
		bigger.set(propStack);
		propStack = bigger;
	}

	function growCheckStack(): void {
		const bigger = new Int32Array(checkStack.length * 2);
		bigger.set(checkStack);
		checkStack = bigger;
	}

	// A retired engine's mint/free entry points forward to shared.inner (the
	// current generation): allocation calls in flight across a growth keep
	// working at one extra hop. Set at most once, at an operation boundary.
	// Zeroing the old arena makes stale reads scream instead of lying.
	let retired = false;
	function retire(): void {
		retired = true;
		M.fill(0, 0, recNext);
	}

	// Local aliases for the shared side arrays (stable identities): one load
	// at construction, then context-specialized constants in the hot paths.
	const pendingFree = shared.pendingFree;
	// Seam callbacks are fixed at system creation (options are the only way
	// to set them), so each generation captures them as construction consts:
	// walk call sites become direct, foldable, inlinable calls instead of
	// per-call property loads off `shared`.
	const hostUpdate = shared.hostUpdate;
	const hostNotify = shared.hostNotify;
	const hostFreed = shared.hostFreed;
	const lifecycleArmed = shared.hostWatched !== undefined || shared.hostUnwatched !== undefined;
	const hostState = shared.hostState;

	return {
		memory: M,
		versions: D,
		retire,
		state: snapshot,
		busy,
		maybeBoundary,
		resetGuard,
		resetState,
		freeRecordCounts,
		orphan,
		allocNode: newCustom,
		freeNode: freeNodeId,
		link,
		unlink,
		propagate,
		checkDirty,
		shallowPropagate,
		sweepPendingFree,
	};

	// ---- allocation ----------------------------------------------------------

		function busy(): boolean {
			return M[SysSlot.EnterDepth] !== 0;
		}

		// May grow — retiring THIS engine — so mint paths re-check `retired`
		// right after calling it.
		function maybeBoundary(): void {
			if (M[SysSlot.EnterDepth] !== 0) {
				return;
			}
			if (shared.growPending) {
				shared.grow();
			}
			if (shared.boundaryPending && pendingFree.length > 8192) {
				shared.boundaryWork();
			}
		}

		function resetGuard(): void {
			if (M[SysSlot.EnterDepth] !== 0) {
				throw new Error('dalien-signals: reset() called during an active operation (inside an effect, computed getter, or other tracked frame)');
			}
		}

		// Bulk arena teardown (see ReactiveSystem.reset): rewind the arena and
		// this generation's counters. The factory handles the side columns,
		// the registry, and host-lifecycle stops.
		function resetState(): void {
			M.fill(0, 0, recNext);
			recNext = 8;
			nodeFreeHead = 0;
			linkFreeHead = 0;
			pendingFree.length = 0;
			// The host's globalVersion/cycle counters keep counting: fresh
			// records hold zeroed snapshots, which can never equal them.
		}

		// ---- minting and freeing (see ReactiveSystemOptions.update) -----------

		function newCustom(hostBits: number): SignalId {
			if (retired) {
				return shared.inner!.allocNode(hostBits);
			}
			// Host tags plus initial PUBLIC state: the kind declares its own
			// nature (MUTABLE for value nodes so walks update them and waves
			// traverse them; WATCHING for effect-likes so notify fires;
			// neither for wave-opaque bookkeeping nodes).
			return allocNode(hostBits & (Flag.HostMask | Flag.PublicMask));
		}

		// Generic, gen-guarded free for ANY node id: the explicit-lifetime
		// counterpart of owner-based reclamation. Effects and scopes route
		// through their kind-correct teardown (cleanup, children).
		function freeNodeId(id: number, gen: number): void {
			if (retired) {
				shared.inner!.freeNode(id, gen);
				return;
			}
			if (M[id + NodeSlot.Gen] !== gen) {
				return; // already reclaimed (and possibly reused)
			}
			const flags = M[id + NodeSlot.Flags];
			if (!(flags & Flag.Live)) {
				return; // already freed
			}
			if (flags & Flag.HostStarted) {
				hostUnwatchedNode(id);
			}
			M[id + NodeSlot.Flags] = 0;
			disposeAllDepsInReverse(id);
			let sub = M[id + NodeSlot.Subs];
			while (sub !== 0) {
				unlink(sub);
				sub = M[id + NodeSlot.Subs];
			}
			pendingFree.push(id);
			shared.boundaryPending = true;
			shared.scheduleMaintenance();
		}

		function freeRecordCounts(): { freeNodeRecords: number; freeLinkRecords: number } {
			let freeNodeRecords = 0;
			for (let id = nodeFreeHead; id !== 0; id = M[id + NodeSlot.Deps]) {
				++freeNodeRecords;
			}
			let freeLinkRecords = 0;
			for (let id = linkFreeHead; id !== 0; id = M[id + LinkSlot.FreeNext]) {
				++freeLinkRecords;
			}
			return { freeNodeRecords, freeLinkRecords };
		}

		function allocNode(flags: number): number {
			let id: number;
			if (nodeFreeHead !== 0) {
				id = nodeFreeHead;
				nodeFreeHead = M[id + NodeSlot.Deps];
				M[id + NodeSlot.Deps] = 0;
			} else {
				id = recNext;
				if (id >= M.length) {
					throw new Error('dalien-signals: record arena exhausted inside one operation (growth runs between operations); growCapacity() or a larger initialCapacity is needed');
				}
				recNext = id + 8;
				if (recNext > growAt && !shared.growPending) {
					shared.growPending = true;
					shared.scheduleMaintenance();
				}
			}
			M[id + NodeSlot.Flags] = flags | Flag.Live;
			return id;
		}

		function freeNode(id: number): void {
			if (hostFreed !== undefined) {
				hostFreed(id);
			}
			D[(id >> Arena.VersionShift) + Arena.VersionOffset] = 0;
			M[id + NodeSlot.Flags] = 0;
			M[id + NodeSlot.DepsTail] = 0;
			M[id + NodeSlot.Subs] = 0;
			M[id + NodeSlot.SubsTail] = 0;
			++M[id + NodeSlot.Gen];
			M[id + NodeSlot.Deps] = nodeFreeHead;
			nodeFreeHead = id;
		}

		function sweepPendingFree(): void {
			if (retired) {
				shared.inner!.sweepPendingFree();
				return;
			}
			for (let i = 0; i < pendingFree.length; ++i) {
				freeNode(pendingFree[i]);
			}
			pendingFree.length = 0;
		}

		function allocLink(): number {
			let id: number;
			if (linkFreeHead !== 0) {
				id = linkFreeHead;
				linkFreeHead = M[id + LinkSlot.FreeNext];
			} else {
				id = recNext;
				if (id >= M.length) {
					throw new Error('dalien-signals: record arena exhausted inside one operation (growth runs between operations); growCapacity() or a larger initialCapacity is needed');
				}
				recNext = id + 8;
				if (recNext > growAt && !shared.growPending) {
					shared.growPending = true;
					shared.scheduleMaintenance();
				}
			}
			return id;
		}

		function freeLink(id: number): void {
			M[id + LinkSlot.FreeNext] = linkFreeHead;
			linkFreeHead = id;
		}

		// ---- graph kernel (upstream system.ts, transliterated) ----------------

		function link(dep: number, sub: number, version: number): LinkId {
			const prevDep = M[sub + NodeSlot.DepsTail];
			if (prevDep !== 0 && M[prevDep + LinkSlot.Dep] === dep) {
				return prevDep;
			}
			const nextDep = prevDep !== 0 ? M[prevDep + LinkSlot.NextDep] : M[sub + NodeSlot.Deps];
			if (nextDep !== 0 && M[nextDep + LinkSlot.Dep] === dep) {
				M[nextDep + LinkSlot.Version] = version;
				M[sub + NodeSlot.DepsTail] = nextDep;
				return nextDep;
			}
			linkInsert(dep, sub, version, prevDep, nextDep);
			// Insert and its dedup fast path both leave the edge as the
			// dep's subscriber tail.
			return M[dep + NodeSlot.SubsTail];
		}

		// Insertion tail of link(): kept out of line so the steady-state
		// re-track fast path above stays under V8's inlining bytecode budget.
		function linkInsert(dep: number, sub: number, version: number, prevDep: number, nextDep: number): void {
			const prevSub = M[dep + NodeSlot.SubsTail];
			if (prevSub !== 0 && M[prevSub + LinkSlot.Version] === version && M[prevSub + LinkSlot.Sub] === sub) {
				return;
			}
			const newLink = allocLink();
			M[sub + NodeSlot.DepsTail] = newLink;
			M[dep + NodeSlot.SubsTail] = newLink;
			M[newLink + LinkSlot.Version] = version;
			M[newLink + LinkSlot.Dep] = dep;
			M[newLink + LinkSlot.Sub] = sub;
			M[newLink + LinkSlot.PrevDep] = prevDep;
			M[newLink + LinkSlot.NextDep] = nextDep;
			M[newLink + LinkSlot.PrevSub] = prevSub;
			M[newLink + LinkSlot.NextSub] = 0;
			if (nextDep !== 0) {
				M[nextDep + LinkSlot.PrevDep] = newLink;
			}
			if (prevDep !== 0) {
				M[prevDep + LinkSlot.NextDep] = newLink;
			} else {
				M[sub + NodeSlot.Deps] = newLink;
			}
			if (prevSub !== 0) {
				M[prevSub + LinkSlot.NextSub] = newLink;
			} else {
				M[dep + NodeSlot.Subs] = newLink;
				// First subscriber: watched-lifecycle arming (out of the common
				// re-subscribe path; one folded compare on first-link only).
				if (lifecycleArmed) {
					hostWatchedNode(dep);
				}
			}
		}

		function unlink(id: number, sub = M[id + LinkSlot.Sub]): LinkId {
			const dep = M[id + LinkSlot.Dep];
			const prevDep = M[id + LinkSlot.PrevDep];
			const nextDep = M[id + LinkSlot.NextDep];
			const nextSub = M[id + LinkSlot.NextSub];
			const prevSub = M[id + LinkSlot.PrevSub];
			if (nextDep !== 0) {
				M[nextDep + LinkSlot.PrevDep] = prevDep;
			} else {
				M[sub + NodeSlot.DepsTail] = prevDep;
			}
			if (prevDep !== 0) {
				M[prevDep + LinkSlot.NextDep] = nextDep;
			} else {
				M[sub + NodeSlot.Deps] = nextDep;
			}
			if (nextSub !== 0) {
				M[nextSub + LinkSlot.PrevSub] = prevSub;
			} else {
				M[dep + NodeSlot.SubsTail] = prevSub;
			}
			freeLink(id);
			if (prevSub !== 0) {
				M[prevSub + LinkSlot.NextSub] = nextSub;
			} else if (!(M[dep + NodeSlot.Subs] = nextSub)) {
				unwatched(dep);
			}
			return nextDep;
		}

		// ---- watched lifecycle (ReactiveSystemOptions.start/stop) -------------

		// Inline delivery, like upstream's unwatched: callbacks run inside
		// graph operations and are treated like effect-cleanup code.
		function hostWatchedNode(id: number): void {
			const flags = M[id + NodeSlot.Flags];
			if (flags & Flag.HostStarted) {
				return;
			}
			M[id + NodeSlot.Flags] = flags | Flag.HostStarted;
			const hostWatched = shared.hostWatched;
			hostState[id >> Arena.NodeIndexShift] = hostWatched !== undefined ? hostWatched(id) : undefined;
		}

		function hostUnwatchedNode(id: number): void {
			const flags = M[id + NodeSlot.Flags] & ~Flag.HostStarted;
			M[id + NodeSlot.Flags] = flags;
			const state = hostState[id >> Arena.NodeIndexShift];
			hostState[id >> Arena.NodeIndexShift] = undefined;
			if (shared.hostUnwatched !== undefined) {
				shared.hostUnwatched(id, state);
			}
		}

		function propagate(startLink: number, innerWrite: boolean): void {
			// No try/finally: propagate never runs user code (notify only
			// queues), so it cannot throw and always drains the stack back to
			// its base.
			let cur = startLink;
			let next = M[cur + LinkSlot.NextSub];
			const markBits = innerWrite ? Flag.Pending | Flag.Recursed : Flag.Pending;
			const stackBase = propSp;

			top: do {
				const sub = M[cur + LinkSlot.Sub];
				let flags = M[sub + NodeSlot.Flags];

				if (!(flags & (Flag.RecursedCheck | Flag.Recursed | Flag.Dirty | Flag.Pending))) {
					M[sub + NodeSlot.Flags] = flags | markBits;
				} else if (!(flags & (Flag.RecursedCheck | Flag.Recursed))) {
					flags = 0;
				} else if (!(flags & Flag.RecursedCheck)) {
					M[sub + NodeSlot.Flags] = (flags & ~Flag.Recursed) | Flag.Pending;
				} else if (!(flags & (Flag.Dirty | Flag.Pending)) && isValidLink(cur, sub)) {
					M[sub + NodeSlot.Flags] = flags | (Flag.Recursed | Flag.Pending);
					flags &= Flag.Mutable;
				} else {
					flags = 0;
				}

				if (flags & Flag.Watching) {
					notify(sub);
				}

				if (flags & Flag.Mutable) {
					const subSubs = M[sub + NodeSlot.Subs];
					if (subSubs !== 0) {
						cur = subSubs;
						const nextSub = M[cur + LinkSlot.NextSub];
						if (nextSub !== 0) {
							if (propSp === propStack.length) {
								growPropStack();
							}
							propStack[propSp++] = next;
							next = nextSub;
						}
						continue;
					}
				}

				if ((cur = next) !== 0) {
					next = M[cur + LinkSlot.NextSub];
					continue;
				}

				while (propSp > stackBase) {
					cur = propStack[--propSp];
					if (cur !== 0) {
						next = M[cur + LinkSlot.NextSub];
						continue top;
					}
				}

				break;
			} while (true);
		}

		// Entry wrapper: owns the scratch-stack base restore (update() runs user
		// getters, which can throw mid-walk). Kept apart from the loop so the
		// loop body stays under V8's 460-bytecode inlining budget — try/finally
		// plumbing plus the loop was 543 bytecodes, which barred checkDirty from
		// inlining into run()/computedRead() (the bytecode budget test pins this).
		function checkDirty(startLink: number, startSub: number): boolean {
			// Shallow fast path mirroring checkDirtyLoop's first iteration:
			// the sub is already dirty, or its first dep is a directly-dirty
			// mutable — the shape of every effect sitting one link away from
			// a written signal's computed. Resolving here skips the loop's
			// stack machinery and the try/finally for the hottest walks;
			// anything deeper (pending deps, more links) falls through to
			// the general loop unchanged.
			if (M[startSub + NodeSlot.Flags] & Flag.Dirty) {
				return true;
			}
			const dep = M[startLink + LinkSlot.Dep];
			const depFlags = M[dep + NodeSlot.Flags];
			if ((depFlags & (Flag.Mutable | Flag.Dirty)) === (Flag.Mutable | Flag.Dirty)) {
				if (updateAndShallow(dep, M[dep + NodeSlot.Subs])) {
					// Same disposed-sub guard as the loop's return: update()
					// may run user code that disposes the sub mid-walk.
					return M[startSub + NodeSlot.Flags] !== 0;
				}
				const nextDep = M[startLink + LinkSlot.NextDep];
				if (!nextDep) {
					return false;
				}
				startLink = nextDep;
			} else if ((depFlags & (Flag.Mutable | Flag.Pending)) === (Flag.Mutable | Flag.Pending)) {
				// Two-level degenerate case: the pending dep has exactly one
				// dep of its own and it is directly dirty — the shape of
				// every effect one computed away from a written signal. The
				// sequence mirrors the loop's descend-then-unwind for this
				// shape: update the inner node (subs captured first), then
				// either recompute the pending dep or clear its Pending.
				const innerLink = M[dep + NodeSlot.Deps];
				const inner = M[innerLink + LinkSlot.Dep];
				if (
					!M[innerLink + LinkSlot.NextDep]
					&& (M[inner + NodeSlot.Flags] & (Flag.Mutable | Flag.Dirty)) === (Flag.Mutable | Flag.Dirty)
				) {
					if (updateAndShallow(inner, M[inner + NodeSlot.Subs])) {
						if (updateAndShallow(dep, M[dep + NodeSlot.Subs])) {
							return M[startSub + NodeSlot.Flags] !== 0;
						}
					} else {
						M[dep + NodeSlot.Flags] &= ~Flag.Pending;
					}
					const nextDep = M[startLink + LinkSlot.NextDep];
					if (!nextDep) {
						return false;
					}
					startLink = nextDep;
				}
				// Anything deeper falls through to the general loop with no
				// state mutated.
			}
			// Chains: a run of single-dep, single-subscriber pending nodes
			// needs no traversal stack — the descent is unbranched, and the
			// unwind path is recoverable by climbing each node's unique
			// subscriber link. deep/grid/island cones are exactly this shape.
			if (!M[startLink + LinkSlot.NextDep]) {
				const r = chainCheck(startLink);
				if (r >= 0) {
					return r !== 0 && M[startSub + NodeSlot.Flags] !== 0;
				}
			}
			const stackBase = checkSp;
			try {
				return checkDirtyLoop(startLink, startSub);
			} finally {
				checkSp = stackBase;
			}
		}

		// update() + sibling Pending->Dirty upgrade, shared by the descend and
		// unwind arms of checkDirtyLoop. `subs` is captured BEFORE update() runs
		// (the re-track may rebuild the list), exactly as upstream.
		function updateAndShallow(node: number, subs: number): boolean {
			if (update(node)) {
				if (M[subs + LinkSlot.NextSub] !== 0) {
					shallowPropagate(subs);
				}
				return true;
			}
			return false;
		}

		// Stackless walk for pure chains (see checkDirty). Descends while the
		// pending dep has exactly one dep-link and one subscriber; on finding
		// a directly-dirty base, updates back UP by climbing the unique
		// subscriber links — the resume state a branching walk would need a
		// stack for is recoverable from the graph itself. Returns 1 (dirty:
		// caller re-checks its sub), 0 (resolved clean), -1 (shape is not a
		// chain here: fall through to the general loop, nothing mutated).
		function chainCheck(startLink: number): number {
			let link = startLink;
			let depth = 0;
			let dep = 0;
			while (true) {
				dep = M[link + LinkSlot.Dep];
				const flags = M[dep + NodeSlot.Flags];
				if ((flags & (Flag.Mutable | Flag.Dirty)) === (Flag.Mutable | Flag.Dirty)) {
					break; // dirty base found
				}
				if ((flags & (Flag.Mutable | Flag.Pending)) !== (Flag.Mutable | Flag.Pending)) {
					return -1; // clean or non-mutable dep: not a resolvable chain
				}
				const depDeps = M[dep + NodeSlot.Deps];
				if (!depDeps || M[depDeps + LinkSlot.NextDep] !== 0) {
					return -1; // branching deps
				}
				const depSubs = M[dep + NodeSlot.Subs];
				if (!depSubs || M[depSubs + LinkSlot.NextSub] !== 0) {
					return -1; // shared node: the climb needs a unique subscriber
				}
				link = depDeps;
				++depth;
			}
			if (!depth) {
				return -1; // directly-dirty first dep: the shallow paths own this
			}
			let changed = updateAndShallow(dep, M[dep + NodeSlot.Subs]);
			let node = dep;
			while (depth--) {
				const up = M[node + NodeSlot.Subs];
				const sub = M[up + LinkSlot.Sub];
				if (changed) {
					changed = updateAndShallow(sub, M[sub + NodeSlot.Subs]);
				} else {
					M[sub + NodeSlot.Flags] &= ~Flag.Pending;
				}
				node = sub;
			}
			return changed ? 1 : 0;
		}

		function checkDirtyLoop(cur: number, sub: number): boolean {
			let checkDepth = 0;
			let dirty = false;

			top: do {
				const dep = M[cur + LinkSlot.Dep];
				const depFlags = M[dep + NodeSlot.Flags];

				if (M[sub + NodeSlot.Flags] & Flag.Dirty) {
					dirty = true;
				} else if ((depFlags & (Flag.Mutable | Flag.Dirty)) === (Flag.Mutable | Flag.Dirty)) {
					if (updateAndShallow(dep, M[dep + NodeSlot.Subs])) {
						dirty = true;
					}
				} else if ((depFlags & (Flag.Mutable | Flag.Pending)) === (Flag.Mutable | Flag.Pending)) {
					if (checkSp === checkStack.length) {
						growCheckStack();
					}
					checkStack[checkSp++] = cur;
					cur = M[dep + NodeSlot.Deps];
					sub = dep;
					++checkDepth;
					continue;
				}

				if (!dirty) {
					const nextDep = M[cur + LinkSlot.NextDep];
					if (nextDep !== 0) {
						cur = nextDep;
						continue;
					}
				}

				while (checkDepth--) {
					cur = checkStack[--checkSp];
					if (dirty) {
						if (updateAndShallow(sub, M[sub + NodeSlot.Subs])) {
							sub = M[cur + LinkSlot.Sub];
							continue;
						}
						dirty = false;
					} else {
						M[sub + NodeSlot.Flags] &= ~Flag.Pending;
					}
					sub = M[cur + LinkSlot.Sub];
					const nextDep = M[cur + LinkSlot.NextDep];
					if (nextDep !== 0) {
						cur = nextDep;
						continue top;
					}
				}

				// Upstream: `dirty && !!sub.flags` — a live node always has
				// its kind bits set; flags reads 0 only if sub was disposed
				// (record zeroed) by re-entrant user code during update().
				return dirty && M[sub + NodeSlot.Flags] !== 0;
			} while (true);
		}

		function shallowPropagate(startLink: number): void {
			let cur = startLink;
			do {
				const sub = M[cur + LinkSlot.Sub];
				const flags = M[sub + NodeSlot.Flags];
				if ((flags & (Flag.Pending | Flag.Dirty)) === Flag.Pending) {
					M[sub + NodeSlot.Flags] = flags | Flag.Dirty;
					if ((flags & (Flag.Watching | Flag.RecursedCheck)) === Flag.Watching) {
						notify(sub);
					}
				}
			} while ((cur = M[cur + LinkSlot.NextSub]) !== 0);
		}

		function isValidLink(checkLink: number, sub: number): boolean {
			let cur = M[sub + NodeSlot.DepsTail];
			while (cur !== 0) {
				if (cur === checkLink) {
					return true;
				}
				cur = M[cur + LinkSlot.PrevDep];
			}
			return false;
		}

		// ---- node behaviors (upstream index.ts, transliterated) ---------------

		// The walks land here for every MUTABLE|DIRTY node: resolution is
		// entirely the host's (see ReactiveSystemOptions.update) — the host
		// resets the flags word, re-tracks, recomputes, and snapshots the
		// version, exactly
		// like upstream's updateComputed. Without a callback the node is just
		// marked resolved so walks terminate.
		function update(node: number): boolean {
			const flags = M[node + NodeSlot.Flags];
			if (hostUpdate !== undefined) {
				return hostUpdate(node, flags);
			}
			M[node + NodeSlot.Flags] = flags & ~(Flag.Dirty | Flag.Pending);
			return true;
		}

		// Effect scheduling is the host's (see ReactiveSystemOptions.notify):
		// the propagation ladder lands here for WATCHING nodes; clearing the
		// bit is the dedup (one notification until the host re-arms it).
		function notify(e: number): void {
			M[e + NodeSlot.Flags] &= ~Flag.Watching;
			if (hostNotify !== undefined) {
				hostNotify(e, M[e + NodeSlot.Gen]);
			}
		}

		function unwatched(node: number): void {
			if (M[node + NodeSlot.Flags] & Flag.HostStarted) {
				hostUnwatchedNode(node);
				if (M[node + NodeSlot.Subs] !== 0) {
					return; // stop() re-subscribed the node; it is watched again
				}
			}
			// Kill the version snapshot: an unwatched node no longer receives
			// invalidations, so its cached verification must not be trusted
			// if something re-subscribes later.
			D[(node >> Arena.VersionShift) + Arena.VersionOffset] = 0;
			if (M[node + NodeSlot.Flags] & Flag.Orphaned) {
				reclaimOrphan(node); // owner already collected; nothing can re-subscribe
			}
		}

		// FinalizationRegistry target: the handle for this signal/computed was
		// garbage collected. Reclaim the record now if the graph no longer
		// needs it; otherwise mark it and reclaim when the last subscriber
		// unlinks (unwatched). Only owner-registered nodes get here, and only
		// this path frees them, so the id cannot be stale.
		function orphan(id: number): void {
			if (retired) {
				shared.inner!.orphan(id);
				return;
			}
			const flags = M[id + NodeSlot.Flags];
			if (!(flags & Flag.Live)) {
				return; // already reclaimed
			}
			if (M[id + NodeSlot.Subs] !== 0) {
				M[id + NodeSlot.Flags] = flags | Flag.Orphaned;
			} else {
				reclaimOrphan(id);
			}
		}

		// No live handle (the registry fired) and no subscribers: release the
		// record's edges and queue it for the free list. Zero-flags-first
		// mirrors disposeInner's re-entrancy guard.
		function reclaimOrphan(id: number): void {
			M[id + NodeSlot.Flags] = 0;
			disposeAllDepsInReverse(id);
			pendingFree.push(id);
			shared.boundaryPending = true;
			shared.scheduleMaintenance();
		}

		function disposeAllDepsInReverse(sub: number): void {
			let cur = M[sub + NodeSlot.DepsTail];
			while (cur !== 0) {
				const prev = M[cur + LinkSlot.PrevDep];
				unlink(cur, sub);
				cur = prev;
			}
		}

		// ---- operations dispatched from the public system object --------------
	}


