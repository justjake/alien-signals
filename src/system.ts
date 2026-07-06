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
 * retired arena is zeroed, so its stamps can never hit), and read/write
 * fold the check into kind bits of a flags word they already load.
 * Capacity is virtual until touched (large typed arrays are lazily-mapped
 * zero pages), defaults to 8M records (256 MB virtual), and the STARTING
 * size is set per system with configure({ initialRecords }) BEFORE first
 * use. A second instantiation of the engine literals (growth, or another
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
// object — it uses the same-file `const enum C` below, which every toolchain
// inlines as numeric literals.
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

/**
 * A live view of the node currently recording dependency reads.
 * Reading or writing `flags` accesses its public update-state bits directly;
 * node-type and memory-management bits are hidden.
 */
export interface ReactiveNode {
	flags: ReactiveFlags;
}

// ---- record layout + flags as a same-file const enum -------------------------
// A const enum (not module-level `const`s) so every consumer toolchain inlines
// the values as literals. esbuild BUNDLING demotes module-scope `const` to
// mutable `var` (lazy-init/scope-merge hoisting), which costs TurboFan its
// constant-folding of these hot numbers — measured +15-21% on kairo workloads.
// Same-file const enum members are inlined as numeric literals by esbuild
// (transform AND bundle modes), tsx, vitest, and tsc alike.
const enum C {
	// Node fields (M arena, stride 8; ids are pre-multiplied: id = record * 8).
	FLAGS = 0,
	DEPS = 1, // doubles as the free-list next pointer for freed node records
	DEPS_TAIL = 2,
	SUBS = 3,
	SUBS_TAIL = 4,
	GEN = 5, // bumped on free; disposers capture it to defuse stale ids
	// Quiet-read verification stamp: slots 6-7 hold ONE float64 (the write
	// epoch; 53-bit integer range never wraps), read through the D
	// Float64Array view over the same buffer — one load and one compare on
	// the fast path instead of two of each. Same cache line as FLAGS. The
	// f64 index of a node's stamp is (id >> 1) + 3 (records are 32 bytes,
	// the stamp at byte offset 24, so 8-byte alignment holds).
	VSTAMP_HI = 6,
	VSTAMP_LO = 7,

	// Link fields (M arena, stride 8; link records share the arena with nodes).
	VERSION = 0,
	DEP = 1,
	SUB = 2,
	PREV_SUB = 3,
	NEXT_SUB = 4,
	PREV_DEP = 5,
	NEXT_DEP = 6,
	// The free list threads through the SPARE field so a freed link keeps
	// every real field intact: upstream's walks deliberately read stale
	// nextDep/nextSub off links unlinked earlier in the same walk
	// (conformance #203 exercises this), and those stale pointers must name
	// former neighbors — never the free list.
	FREE_NEXT = 7,

	// Flags (upstream ReactiveFlags + HasChildEffect + kind bits).
	MUTABLE = 1,
	WATCHING = 2,
	RECURSED_CHECK = 4,
	RECURSED = 8,
	DIRTY = 16,
	PENDING = 32,
	// The record holds a live node (set by alloc, cleared by free): the
	// engine's only notion of "kind" — everything else is host bits.
	LIVE = 128,
	// The record's handle was garbage-collected (FinalizationRegistry fired)
	// while subscribers still existed; reclaim when the last subscriber
	// unlinks. Engine-internal, outside PUBLIC_MASK.
	ORPHANED = 2048,
	// The host's start() lifecycle callback ran for this node and its stop()
	// has not (see ReactiveSystemOptions.start/stop). Engine-internal.
	HOST_STARTED = 8192,
	// Bits 16-27 belong to the HOST: custom kinds plant their dispatch tags
	// here at mint (custom(hostBits)); the engine never touches them and
	// preserves them across every state rewrite (see STICKY).
	HOST_SHIFT = 16,
	HOST_MASK = 0x0FFF0000,
	// Engine-internal + host bits that every absolute FLAGS store preserves.
	STICKY = ORPHANED | HOST_STARTED | HOST_MASK,
	// Bits visible through the public ReactiveNode view (semantic bits +
	// HasChildEffect, which upstream also kept in the public flags word).
	PUBLIC_MASK = 127,
}

// Default STARTING capacity: 8M records x 32 B = 256 MB of mostly-untouched
// (lazily mapped) zero pages — physical memory tracks records actually
// touched. A given arena never grows or moves, which is what lets every
// handle closure capture `const M` directly and reach the engine with zero
// indirection (the measured alternative — growable buffers behind any
// mutable binding or segment table — costs 26-83% on hot walks; see the
// header note). The system grows past this by engine migration (see the
// CAPACITY header note). Override per system via configure({ initialRecords })
// or createReactiveSystem({ initialRecords }) BEFORE the first primitive is
// created — nothing is allocated until then.
const DEFAULT_RECORDS = 1 << 23;

function normalizeRecords(n: number): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) {
		throw new TypeError('dalien-signals: initialRecords must be a finite number');
	}
	return Math.max(16, Math.ceil(n));
}

function noop(): void {}

function uninitialized(): never {
	throw new Error('dalien-signals: system not materialized — create a signal/computed/effect or call configure() first');
}



/**
 * Id-level operations of the live engine, exposed as {@link ReactiveSystem.e}.
 * Reassigned when the arena grows (the engine is rebuilt over the larger
 * arena); stale references keep working — retired engines forward to the
 * current one. Handles returned by the make* methods do NOT go through this
 * object — they are closures minted inside the engine over `const M`,
 * calling these functions directly.
 */
export interface ReactiveEngine {
	/** Mint a host-kind node (see ReactiveSystem.custom). */
	newCustom(hostBits: number): NodeId;
	/** Explicitly free any node id if `gen` still matches. */
	free(id: NodeId, gen: number): void;
	/** True: the node must update. False: verified clean (and stamped). */
	verify(id: NodeId): boolean;
	/** One f64 compare: may the caller skip verification entirely? */
	verified(id: NodeId): boolean;
	/** Re-track bracket for update code that reads dependencies. */
	beginTracking(id: NodeId): void;
	endTracking(id: NodeId): void;
	/** Mark definitely-changed and kill the quiet-read stamp. */
	markDirty(id: NodeId): void;
	/** Link `id` to the active subscriber, if anything is tracking. */
	track(id: NodeId): void;
	/**
	 * Add a dependency edge: `sub` re-verifies (and effects re-run) when
	 * `dep` changes. Returns the edge's id (the existing one if the edge is
	 * already present). The edge behaves exactly like one made by a tracked
	 * read: if `sub` re-tracks (recomputes or re-runs), manual edges it does
	 * not re-establish are dropped.
	 */
	link(depId: NodeId, subId: NodeId): LinkId;
	/** Remove an edge made by `link` (or observed via tracking). */
	unlink(linkId: LinkId): void;
	/**
	 * Mark everything downstream of `id` possibly-stale (PENDING), queue
	 * affected effects, invalidate quiet-read stamps, and — matching a
	 * write — flush unless a batch is open. Pair with `shallowPropagate`
	 * when the node's value changed out of band, so direct subscribers are
	 * promoted to DIRTY and actually recompute.
	 */
	propagate(id: NodeId, innerWrite?: boolean): void;
	/**
	 * Promote `id`'s PENDING subscribers to DIRTY (they will recompute on
	 * next pull), queue affected effects, invalidate stamps, and flush
	 * unless a batch is open.
	 */
	shallowPropagate(id: NodeId): void;
}

/** The self-contained reactive system returned by {@link createReactiveSystem}. */
export interface ReactiveSystem {
	/**
	 * The live engine (id-level entry points). Assigned at materialization,
	 * reassigned on arena growth; stale references forward to the current
	 * engine.
	 */
	e: ReactiveEngine;
	/**
	 * Set the record arena's STARTING capacity and allocate it now (the
	 * arena grows by engine migration when the live graph outgrows it).
	 * Buffers are otherwise allocated lazily on the first primitive
	 * creation, so this must be called before any signal/computed/effect/
	 * effectScope/trigger of this system exists — afterwards it throws.
	 * Works in any host (browser included); there is no environment-variable
	 * path. Capacity is virtual until touched (large typed arrays are
	 * lazily-mapped zero pages).
	 */
	configure(options?: ReactiveSystemOptions): void;
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
	 * dispatch tags, preserved by the engine across every state rewrite and
	 * visible in the flags handed to the `update` callback. If `owner` is
	 * given it is weak-registered: the record reclaims when the owner is
	 * garbage collected. Without an owner the caller MUST `free`, or the
	 * record lives until reset().
	 */
	custom(hostBits?: number, owner?: WeakKey): NodeId;
	/** Explicitly free any node id if `gen` still matches. */
	free(id: NodeId, gen: number): void;
	/** True: the node must update. False: verified clean (and stamped). */
	verify(id: NodeId): boolean;
	/** One f64 compare: may the caller skip verification entirely? */
	verified(id: NodeId): boolean;
	/** Re-track bracket for update code that reads dependencies. */
	beginTracking(id: NodeId): void;
	endTracking(id: NodeId): void;
	/** Mark definitely-changed and kill the quiet-read stamp. */
	markDirty(id: NodeId): void;
	/** Link `id` to the active subscriber, if anything is tracking. */
	track(id: NodeId): void;
	/** Add a dependency edge; see {@link ReactiveEngine.link}. */
	link(depId: NodeId, subId: NodeId): LinkId;
	/** Remove an edge; see {@link ReactiveEngine.unlink}. */
	unlink(linkId: LinkId): void;
	/** Push staleness downstream; see {@link ReactiveEngine.propagate}. */
	propagate(id: NodeId, innerWrite?: boolean): void;
	/** Promote pending subscribers; see {@link ReactiveEngine.shallowPropagate}. */
	shallowPropagate(id: NodeId): void;
	/** Current generation counter of a record (capture at creation). */
	gen(id: number): number;
	/** Re-notify dependencies read inside `fn` as if they had been written. */
	trigger(fn: () => void): void;
	startBatch(): void;
	endBatch(): void;
	getBatchDepth(): number;
	/** Active subscriber id (0 = none). */
	getActiveSub(): number;
	/** Set the active subscriber id (0 = none); returns the previous id. */
	setActiveSub(id: number): number;
	/** Raw flags word of a node (includes engine-owned kind bits). */
	nodeFlags(id: number): number;
	/** Overwrite the PUBLIC (semantic) flag bits of a node; kind bits keep. */
	setNodeFlags(id: number, flags: number): void;
	/** The live record arena (debugging/tooling only). */
	buffer(): Int32Array;
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
	/** Arena STARTING capacity in 32-byte records (default 2^23; grows). */
	initialRecords?: number;
	/**
	 * Host effect scheduler (upstream's `notify` seam, id-shaped). When set,
	 * the engine never runs effects itself: each effect that would have been
	 * queued is reported here exactly once — in the order the built-in queue
	 * would run them (outer effects before their children) — and stays
	 * silent until the host runs it via `runEffect(effectId, gen)`.
	 *
	 * Contract:
	 * - run every notified effect eventually, or it never re-notifies (the
	 *   dedup that prevents double-queueing is only reset by running it);
	 * - `gen` makes stale ids harmless: a disposed-and-recycled record makes
	 *   `runEffect` a no-op, so the host queue needs no cleanup on dispose;
	 * - notifications fire at write time even inside batches — with a host
	 *   scheduler, startBatch/endBatch no longer defer anything.
	 */
	notify?: (effectId: number, gen: number) => void;
	/**
	 * Called when a top-level operation finishes with notifications pending
	 * (write-parity: after an unbatched propagate, at the outermost
	 * endBatch, after trigger). Drain your effect queue here.
	 */
	flush?: () => void;
	/**
	 * Resolve a custom node's update (see `custom`): commit whatever
	 * "update" means for your kind and return whether its value changed —
	 * the return feeds the equality cut-off exactly like the built-ins'.
	 * Called by the graph walks with the node's flags word (dispatch on
	 * your host bits, `flags & HOST_MASK`) while the node is DIRTY.
	 */
	update?: (id: NodeId, flags: number) => boolean;
	/**
	 * Watched-lifecycle callbacks. `start` runs when a node gains its FIRST
	 * subscriber; whatever it returns is stored and passed to `stop` when the
	 * node's LAST subscriber unlinks. Use for subscription-counted external
	 * resources (connect on first watch, disconnect on last).
	 *
	 * - `js` is the node's payload: a signal's current value, otherwise the
	 *   node's installed function (undefined for a handle-minted computed
	 *   whose getter is not yet borrowed).
	 * - Delivery is INLINE, inside graph operations — treat callbacks like
	 *   effect-cleanup code (reads/writes are fine and queue normally).
	 * - Laziness makes "watched" approximate observed-by-an-effect: an
	 *   unobserved computed never evaluates, so it never links dependencies.
	 * - `reset()` delivers `stop` for every started node (newest first);
	 *   those callbacks must not touch reactive state mid-reset.
	 */
	start?: (id: NodeId) => unknown;
	stop?: (id: NodeId, state: unknown) => void;
}

/** A record id: a node's (or link's) starting offset in the arena. */
export type NodeId = number;
export type SignalId = number;
export type ComputedId = number;
export type EffectId = number;
export type EffectScopeId = number;
/** Id of an edge record returned by `link`; pass to `unlink`. */
export type LinkId = number;

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
			hostFlush: undefined,
			hostStart: undefined,
			hostStop: undefined,
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
			epoch: 1,
			cycle: 0,
			batchDepth: 0,
		}, dummy);
		dummy.inner = probe;
		// Exercise mint, flags, edges, staleness resolution: any unresolved
		// identifier in the cloned source throws here, not later.
		const a = probe.newCustom(1 << 16 | 1); // host tag + MUTABLE
		const b = probe.newCustom(2 << 16 | 1);
		probe.link(a, b);
		probe.markDirty(a);
		probe.propagate(a);
		return probe.verify(b) === true;
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
	epoch: number;
	cycle: number;
	batchDepth: number;
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
	hostNotify: ((effectId: number, gen: number) => void) | undefined;
	hostUpdate: ((id: NodeId, flags: number) => boolean) | undefined;
	hostFlush: (() => void) | undefined;
	hostStart: ((id: NodeId) => unknown) | undefined;
	hostStop: ((id: NodeId, state: unknown) => void) | undefined;
	growPending: boolean;
	boundaryPending: boolean;
	grow(): void;
	boundaryWork(): void;
	scheduleMaintenance(): void;
}

interface Engine extends ReactiveEngine {
	buffer(): Int32Array;
	retire(): void;
	state(): EngineState;
	busy(): boolean;
	maybeBoundary(): void;
	startBatch(): void;
	endBatch(): void;
	getBatchDepth(): number;
	setActiveSub(id: number): number;
	getActiveSub(): number;
	resetGuard(): void;
	resetState(): void;
	freeRecordCounts(): { freeNodeRecords: number; freeLinkRecords: number };
	orphan(id: number): void;
	clearStamp(id: number): void;
	trigger(fn: () => void): void;
	sweepPendingFree(): void;
}

/**
 * Create an independent reactive graph with its own arena, queues, and
 * dependency-tracking state.
 */
export function createReactiveSystem(options?: ReactiveSystemOptions): ReactiveSystem {
	// LAZY MATERIALIZATION: importing/creating a system allocates nothing.
	// The arena + scratch stacks come into being at the first primitive
	// creation, or when configure() is called — whichever happens first.
	let configuredRecords = options?.initialRecords !== undefined
		? normalizeRecords(options.initialRecords)
		: DEFAULT_RECORDS;

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
		hostFlush: options?.flush,
		hostStart: options?.start,
		hostStop: options?.stop,
		growPending: false,
		boundaryPending: false,
		grow,
		boundaryWork,
		scheduleMaintenance,
	};
	const hostState = shared.hostState;

	function ensureEngine(): Engine {
		return shared.inner !== undefined ? shared.inner : materialize();
	}

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
			epoch: 1,
			cycle: 0,
			batchDepth: 0,
		}, shared);
		shared.inner = engine;
		facade.e = engine;
		return engine;
	}



	// ---- operation boundaries: reclamation + growth ---------------------------

	// Reclamation (record sweeps, getter returns) runs in a microtask — after
	// the current synchronous operation, before the next task — mirroring
	// where upstream's GC pays its reclamation cost. The synchronous boundary
	// drain only fires when a long fully-synchronous burst piles work past
	// the caps, keeping memory bounded without taxing the common op.
	let maintenanceScheduled = false;

	// Grow-by-migration: allocate an arena twice the current capacity, copy the
	// live prefix (ids are arena-relative offsets, so every id survives
	// verbatim), build the next engine generation over the new `const M` —
	// handing the hot counters across via prev.state() — and retire the old
	// engine, whose public entry points forward to the current one. Handles
	// minted before the growth keep working at one extra hop. Only runs at
	// operation boundaries (the engine is not busy): no live frame holds the
	// old arena, so nothing can write through it afterwards.
	function grow(): void {
		shared.growPending = false;
		const prev = shared.inner!;
		const next = instantiateEngine(configuredRecords * 2, prev.buffer(), prev.state(), shared);
		configuredRecords *= 2;
		shared.inner = next;
		facade.e = next;
		prev.retire();
	}

	function scheduleMaintenance(): void {
		if (!maintenanceScheduled) {
			maintenanceScheduled = true;
			queueMicrotask(runMaintenance);
		}
	}

	function runMaintenance(): void {
		maintenanceScheduled = false;
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
	// delegation through ensureEngine(), which materializes on first use.

	// `system.e` before materialization: id-level operations throw (ids can
	// only come from a materialized system).
	const bootEngine: ReactiveEngine = {
		newCustom: uninitialized,
		free: uninitialized,
		verify: uninitialized,
		verified: uninitialized,
		beginTracking: uninitialized,
		endTracking: uninitialized,
		markDirty: uninitialized,
		track: uninitialized,
		link: uninitialized,
		unlink: uninitialized,
		propagate: uninitialized,
		shallowPropagate: uninitialized,
	};

	const facade: ReactiveSystem = {
		e: bootEngine,
		configure(configureOptions?: ReactiveSystemOptions): void {
			if (shared.inner !== undefined) {
				throw new Error('dalien-signals: configure() must be called before the first signal/computed/effect/effectScope is created');
			}
			if (configureOptions?.initialRecords !== undefined) {
				configuredRecords = normalizeRecords(configureOptions.initialRecords);
			}
			if (configureOptions?.notify !== undefined) {
				shared.hostNotify = configureOptions.notify;
			}
			if (configureOptions?.update !== undefined) {
				shared.hostUpdate = configureOptions.update;
			}
			if (configureOptions?.start !== undefined) {
				shared.hostStart = configureOptions.start;
			}
			if (configureOptions?.stop !== undefined) {
				shared.hostStop = configureOptions.stop;
			}
			materialize();
		},
		reset(): void {
			const engine = shared.inner;
			if (engine === undefined) {
				return; // nothing materialized, nothing to reset
			}
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
			const M = engine.buffer();
			for (let id = engine.state().recNext - 8; id >= 8; id -= 8) {
				const flags = M[id + C.FLAGS];
				if (flags & C.HOST_STARTED) {
					const state = hostState[id >> 3];
					hostState[id >> 3] = undefined;
					if (shared.hostStop !== undefined) {
						shared.hostStop(id, state);
					}
				}
			}
			hostState.length = 0;
			engine.resetState(); // arena fill + counters + shared queue drains
			shared.boundaryPending = false;
			shared.growPending = false; // capacity stays at its grown size
			shared.registry = mintRegistry();
		},
		custom(hostBits?: number, owner?: WeakKey): NodeId {
			const engine = ensureEngine();
			engine.maybeBoundary();
			const id = engine.newCustom(hostBits ?? 0);
			if (owner !== undefined) {
				shared.registry!.register(owner, id);
			}
			return id;
		},
		free(id: NodeId, gen: number): void {
			ensureEngine().free(id, gen);
		},
		verify(id: NodeId): boolean {
			return ensureEngine().verify(id);
		},
		verified(id: NodeId): boolean {
			return ensureEngine().verified(id);
		},
		beginTracking(id: NodeId): void {
			ensureEngine().beginTracking(id);
		},
		endTracking(id: NodeId): void {
			ensureEngine().endTracking(id);
		},
		markDirty(id: NodeId): void {
			ensureEngine().markDirty(id);
		},
		track(id: NodeId): void {
			ensureEngine().track(id);
		},
		link(depId: NodeId, subId: NodeId): LinkId {
			const engine = ensureEngine();
			engine.maybeBoundary(); // link allocates a record
			return engine.link(depId, subId);
		},
		unlink(linkId: LinkId): void {
			ensureEngine().unlink(linkId);
		},
		propagate(id: NodeId, innerWrite?: boolean): void {
			ensureEngine().propagate(id, innerWrite);
		},
		shallowPropagate(id: NodeId): void {
			ensureEngine().shallowPropagate(id);
		},
		gen(id: number): number {
			return ensureEngine().buffer()[id + C.GEN];
		},
		trigger(fn: () => void): void {
			const engine = ensureEngine();
			engine.maybeBoundary();
			engine.trigger(fn);
		},
		// Batch and tracking state lives in the engine; opening a batch
		// materializes (batches exist to hold writes, writes need an arena).
		startBatch(): void {
			ensureEngine().startBatch();
		},
		endBatch(): void {
			ensureEngine().endBatch();
		},
		getBatchDepth(): number {
			return shared.inner === undefined ? 0 : shared.inner.getBatchDepth();
		},
		getActiveSub(): number {
			return shared.inner === undefined ? 0 : shared.inner.getActiveSub();
		},
		setActiveSub(id: number): number {
			return ensureEngine().setActiveSub(id);
		},
		nodeFlags(id: number): number {
			return ensureEngine().buffer()[id + C.FLAGS];
		},
		setNodeFlags(id: number, flags: number): void {
			const engine = ensureEngine();
			const M = engine.buffer();
			M[id + C.FLAGS] = (M[id + C.FLAGS] & ~C.PUBLIC_MASK) | (flags & C.PUBLIC_MASK);
			engine.clearStamp(id);
		},
		buffer(): Int32Array {
			return ensureEngine().buffer();
		},
		stats() {
			const engine = ensureEngine();
			const { freeNodeRecords, freeLinkRecords } = engine.freeRecordCounts();
			return {
				capacityRecords: engine.buffer().length / 8,
				allocatedRecords: (engine.state().recNext - 8) / 8,
				freeNodeRecords,
				freeLinkRecords,
				pendingFreeRecords: shared.pendingFree.length,
				pendingRegistrations: 0,
			};
		},
	};
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
	// Float64 view over the same plane for the one-slot epoch stamps.
	const D = new Float64Array(M.buffer);
	if (from !== undefined) {
		// Growth migration: ids are arena-relative offsets, so copying the
		// live prefix preserves every id, edge, generation, and stamp.
		M.set(from.subarray(0, boot.recNext));
	}
	// Ask for growth once the bump pointer passes 3/4 of the arena
	// (records * 8 slots * 3/4). The remaining quarter is headroom for
	// allocations made mid-operation, where growing is unsafe.
	const growAt = records * 6;

	// Hot per-generation counters, handed off through boot/state().
	let recNext = boot.recNext; // bump pointer, nodes and links (record 0 burned)
	let nodeFreeHead = boot.nodeFreeHead; // free list threaded through M[id + C.DEPS]
	let linkFreeHead = boot.linkFreeHead; // free list threaded through M[id + C.NEXT_DEP]
	// Global write epoch (quiet-read fast path): bumped by every committed
	// signal write and every trigger(). A computed whose verification stamp
	// equals the current epoch is provably current — nothing anywhere has
	// been written since it was last verified — so reads skip the flags
	// ladder entirely. One float64 (2^53 never wraps).
	let epoch = boot.epoch;
	let cycle = boot.cycle;
	let batchDepth = boot.batchDepth;
	// Always neutral at a generation boundary:
	let activeSub = 0;
	let runDepth = 0;
	let enterDepth = 0; // live engine frames that captured M; 0 = op boundary

	function snapshot(): EngineState {
		return { recNext, nodeFreeHead, linkFreeHead, epoch, cycle, batchDepth };
	}

	// Invalidate every quiet-read stamp: any observed change MUST pass here
	// (or use the inline twin in write()) or stamped computeds keep serving
	// their cached values.
	function bumpEpoch(): void {
		++epoch;
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

	// A retired engine's public entry points forward to shared.inner (the
	// current generation): handles minted before a growth keep working at one
	// extra hop. Set at most once, at an operation boundary. Zeroing the
	// old arena makes every quiet-read stamp miss (a zeroed stamp can
	// never equal the live epoch, which starts at 1 and only grows), so
	// computedRead/computedReadWith keep their stamp-hit fast paths
	// guard-free and check `retired` only in the slow tail.
	let retired = false;
	function retire(): void {
		retired = true;
		M.fill(0, 0, recNext);
	}

	// Local aliases for the shared side arrays (stable identities): one load
	// at construction, then context-specialized constants in the hot paths.
	const pendingFree = shared.pendingFree;
	const hostState = shared.hostState;

	return {
		buffer: () => M,
		retire,
		state: snapshot,
		busy,
		maybeBoundary,
		startBatch,
		endBatch,
		getBatchDepth,
		setActiveSub,
		getActiveSub,
		resetGuard,
		resetState,
		freeRecordCounts,
		orphan,
		clearStamp,
		newCustom,
		free: freeNodeId,
		verify,
		verified,
		beginTracking,
		endTracking,
		markDirty,
		track,
		link: linkNode,
		unlink: unlinkEdge,
		propagate: propagateNode,
		shallowPropagate: shallowPropagateNode,
		trigger,
		sweepPendingFree,
	};

	// ---- allocation ----------------------------------------------------------

		function busy(): boolean {
			return enterDepth !== 0;
		}

		function startBatch(): void {
			if (retired) {
				shared.inner!.startBatch();
				return;
			}
			++batchDepth;
		}

		function endBatch(): void {
			if (retired) {
				shared.inner!.endBatch();
				return;
			}
			if (!--batchDepth) {
				const hostFlush = shared.hostFlush;
				if (hostFlush !== undefined) {
					hostFlush();
				}
			}
		}

		function getBatchDepth(): number {
			return retired ? shared.inner!.getBatchDepth() : batchDepth;
		}

		function setActiveSub(id: number): number {
			if (retired) {
				return shared.inner!.setActiveSub(id);
			}
			const prev = activeSub;
			activeSub = id;
			return prev;
		}

		function getActiveSub(): number {
			return retired ? shared.inner!.getActiveSub() : activeSub;
		}

		// May grow — retiring THIS engine — so mint paths re-check `retired`
		// right after calling it.
		function maybeBoundary(): void {
			if (enterDepth !== 0) {
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
			if (enterDepth !== 0 || activeSub !== 0 || batchDepth !== 0 || runDepth !== 0) {
				throw new Error('dalien-signals: reset() called during an active operation (inside an effect, computed, batch, or trigger)');
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
			// Epoch and link-cycle counters keep counting: fresh records hold
			// zeroed stamps/versions, which can never equal a live counter.
		}

		// ---- userspace-kind verbs (see ReactiveSystemOptions.update) ----------

		function newCustom(hostBits: number): number {
			if (retired) {
				return shared.inner!.newCustom(hostBits);
			}
			// Host tags plus initial PUBLIC state: the kind declares its own
			// nature (MUTABLE for value nodes so walks update them and waves
			// traverse them; WATCHING for effect-likes so notify fires;
			// neither for wave-opaque bookkeeping nodes).
			return allocNode(hostBits & (C.HOST_MASK | C.PUBLIC_MASK));
		}

		// Generic, gen-guarded free for ANY node id: the explicit-lifetime
		// counterpart of owner-based reclamation. Effects and scopes route
		// through their kind-correct teardown (cleanup, children).
		function freeNodeId(id: number, gen: number): void {
			if (retired) {
				shared.inner!.free(id, gen);
				return;
			}
			if (M[id + C.GEN] !== gen) {
				return; // already reclaimed (and possibly reused)
			}
			const flags = M[id + C.FLAGS];
			if (!(flags & C.LIVE)) {
				return; // already freed
			}
			if (flags & C.HOST_STARTED) {
				hostStopNode(id);
			}
			M[id + C.FLAGS] = 0;
			disposeAllDepsInReverse(id);
			let sub = M[id + C.SUBS];
			while (sub !== 0) {
				unlink(sub);
				sub = M[id + C.SUBS];
			}
			pendingFree.push(id);
			shared.boundaryPending = true;
			shared.scheduleMaintenance();
		}

		// Resolve a node's staleness without reading it: true means "you must
		// update"; false means verified clean (PENDING cleared, and the node
		// is stamped with the epoch captured BEFORE verification — user code
		// run during it can only make the stamp miss, never lie).
		function verify(id: number): boolean {
			if (retired) {
				return shared.inner!.verify(id);
			}
			const flags = M[id + C.FLAGS];
			if (flags & C.DIRTY) {
				return true;
			}
			if (!(flags & C.PENDING)) {
				return false;
			}
			const entryEpoch = epoch;
			if (checkDirty(M[id + C.DEPS], id)) {
				return true;
			}
			M[id + C.FLAGS] &= ~C.PENDING;
			D[(id >> 1) + 3] = entryEpoch;
			return false;
		}

		/** One f64 compare: may the caller skip verification entirely? */
		function verified(id: number): boolean {
			return D[(id >> 1) + 3] === epoch;
		}

		// The re-track bracket (upstream's startTracking/endTracking): a
		// custom update that reads dependencies wraps its user code in these
		// (with setActiveSub around them) to get computed-style re-tracking.
		function beginTracking(id: number): void {
			if (retired) {
				shared.inner!.beginTracking(id);
				return;
			}
			++enterDepth;
			++cycle;
			M[id + C.DEPS_TAIL] = 0;
			M[id + C.FLAGS] = (M[id + C.FLAGS] & ~(C.DIRTY | C.PENDING | C.RECURSED)) | C.RECURSED_CHECK;
		}

		function endTracking(id: number): void {
			if (retired) {
				shared.inner!.endTracking(id);
				return;
			}
			M[id + C.FLAGS] &= ~C.RECURSED_CHECK;
			purgeDeps(id);
			--enterDepth;
		}

		/** Mark a node definitely-changed and kill its quiet-read stamp. */
		function markDirty(id: number): void {
			if (retired) {
				shared.inner!.markDirty(id);
				return;
			}
			M[id + C.FLAGS] |= C.DIRTY;
			D[(id >> 1) + 3] = 0;
		}

		/** Link `id` to the active subscriber, if anything is tracking. */
		function track(id: number): void {
			if (retired) {
				shared.inner!.track(id);
				return;
			}
			if (activeSub !== 0) {
				link(id, activeSub, cycle);
			}
		}

		function freeRecordCounts(): { freeNodeRecords: number; freeLinkRecords: number } {
			let freeNodeRecords = 0;
			for (let id = nodeFreeHead; id !== 0; id = M[id + C.DEPS]) {
				++freeNodeRecords;
			}
			let freeLinkRecords = 0;
			for (let id = linkFreeHead; id !== 0; id = M[id + C.FREE_NEXT]) {
				++freeLinkRecords;
			}
			return { freeNodeRecords, freeLinkRecords };
		}

		function allocNode(flags: number): number {
			let id: number;
			if (nodeFreeHead !== 0) {
				id = nodeFreeHead;
				nodeFreeHead = M[id + C.DEPS];
				M[id + C.DEPS] = 0;
			} else {
				id = recNext;
				if (id >= M.length) {
					throw new Error('dalien-signals: record arena exhausted inside one operation (growth runs between operations); configure({ initialRecords }) with more capacity');
				}
				recNext = id + 8;
				if (recNext > growAt && !shared.growPending) {
					shared.growPending = true;
					shared.scheduleMaintenance();
				}
			}
			M[id + C.FLAGS] = flags | C.LIVE;
			return id;
		}

		function freeNode(id: number): void {
			D[(id >> 1) + 3] = 0;
			M[id + C.FLAGS] = 0;
			M[id + C.DEPS_TAIL] = 0;
			M[id + C.SUBS] = 0;
			M[id + C.SUBS_TAIL] = 0;
			++M[id + C.GEN];
			M[id + C.DEPS] = nodeFreeHead;
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
				linkFreeHead = M[id + C.FREE_NEXT];
			} else {
				id = recNext;
				if (id >= M.length) {
					throw new Error('dalien-signals: record arena exhausted inside one operation (growth runs between operations); configure({ initialRecords }) with more capacity');
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
			M[id + C.FREE_NEXT] = linkFreeHead;
			linkFreeHead = id;
		}

		// ---- graph kernel (upstream system.ts, transliterated) ----------------

		function link(dep: number, sub: number, version: number): void {
			const prevDep = M[sub + C.DEPS_TAIL];
			if (prevDep !== 0 && M[prevDep + C.DEP] === dep) {
				return;
			}
			const nextDep = prevDep !== 0 ? M[prevDep + C.NEXT_DEP] : M[sub + C.DEPS];
			if (nextDep !== 0 && M[nextDep + C.DEP] === dep) {
				M[nextDep + C.VERSION] = version;
				M[sub + C.DEPS_TAIL] = nextDep;
				return;
			}
			linkInsert(dep, sub, version, prevDep, nextDep);
		}

		// Insertion tail of link(): kept out of line so the steady-state
		// re-track fast path above stays under V8's inlining bytecode budget.
		function linkInsert(dep: number, sub: number, version: number, prevDep: number, nextDep: number): void {
			const prevSub = M[dep + C.SUBS_TAIL];
			if (prevSub !== 0 && M[prevSub + C.VERSION] === version && M[prevSub + C.SUB] === sub) {
				return;
			}
			const newLink = allocLink();
			M[sub + C.DEPS_TAIL] = newLink;
			M[dep + C.SUBS_TAIL] = newLink;
			M[newLink + C.VERSION] = version;
			M[newLink + C.DEP] = dep;
			M[newLink + C.SUB] = sub;
			M[newLink + C.PREV_DEP] = prevDep;
			M[newLink + C.NEXT_DEP] = nextDep;
			M[newLink + C.PREV_SUB] = prevSub;
			M[newLink + C.NEXT_SUB] = 0;
			if (nextDep !== 0) {
				M[nextDep + C.PREV_DEP] = newLink;
			}
			if (prevDep !== 0) {
				M[prevDep + C.NEXT_DEP] = newLink;
			} else {
				M[sub + C.DEPS] = newLink;
			}
			if (prevSub !== 0) {
				M[prevSub + C.NEXT_SUB] = newLink;
			} else {
				M[dep + C.SUBS] = newLink;
				// First subscriber: watched-lifecycle start (out of the common
				// re-subscribe path; one context compare on first-link only).
				if (shared.hostStart !== undefined) {
					hostStartNode(dep);
				}
			}
		}

		function unlink(id: number, sub = M[id + C.SUB]): number {
			const dep = M[id + C.DEP];
			const prevDep = M[id + C.PREV_DEP];
			const nextDep = M[id + C.NEXT_DEP];
			const nextSub = M[id + C.NEXT_SUB];
			const prevSub = M[id + C.PREV_SUB];
			if (nextDep !== 0) {
				M[nextDep + C.PREV_DEP] = prevDep;
			} else {
				M[sub + C.DEPS_TAIL] = prevDep;
			}
			if (prevDep !== 0) {
				M[prevDep + C.NEXT_DEP] = nextDep;
			} else {
				M[sub + C.DEPS] = nextDep;
			}
			if (nextSub !== 0) {
				M[nextSub + C.PREV_SUB] = prevSub;
			} else {
				M[dep + C.SUBS_TAIL] = prevSub;
			}
			freeLink(id);
			if (prevSub !== 0) {
				M[prevSub + C.NEXT_SUB] = nextSub;
			} else if (!(M[dep + C.SUBS] = nextSub)) {
				unwatched(dep);
			}
			return nextDep;
		}

		// ---- composable kit (public, id-shaped; cold next to the walks) -------

		// Public link: same three cases as link(), but returns the edge id.
		// Manual edges carry the current tracking version, so they age out on
		// re-track exactly like read-discovered edges (upstream parity).
		function linkNode(dep: number, sub: number): number {
			if (retired) {
				return shared.inner!.link(dep, sub);
			}
			const prevDep = M[sub + C.DEPS_TAIL];
			if (prevDep !== 0 && M[prevDep + C.DEP] === dep) {
				return prevDep;
			}
			const nextDep = prevDep !== 0 ? M[prevDep + C.NEXT_DEP] : M[sub + C.DEPS];
			if (nextDep !== 0 && M[nextDep + C.DEP] === dep) {
				M[nextDep + C.VERSION] = cycle;
				M[sub + C.DEPS_TAIL] = nextDep;
				return nextDep;
			}
			linkInsert(dep, sub, cycle, prevDep, nextDep);
			// Insert and its dedup fast path both leave the edge as the dep's
			// subscriber tail.
			return M[dep + C.SUBS_TAIL];
		}

		function unlinkEdge(linkId: number): void {
			if (retired) {
				shared.inner!.unlink(linkId);
				return;
			}
			unlink(linkId);
		}

		function propagateNode(id: number, innerWrite?: boolean): void {
			if (retired) {
				shared.inner!.propagate(id, innerWrite);
				return;
			}
			const subs = M[id + C.SUBS];
			if (subs !== 0) {
				bumpEpoch();
				propagate(subs, innerWrite ?? runDepth !== 0);
				if (!batchDepth && shared.hostFlush !== undefined) {
					shared.hostFlush();
				}
			}
		}

		function shallowPropagateNode(id: number): void {
			if (retired) {
				shared.inner!.shallowPropagate(id);
				return;
			}
			const subs = M[id + C.SUBS];
			if (subs !== 0) {
				bumpEpoch();
				shallowPropagate(subs);
				if (!batchDepth && shared.hostFlush !== undefined) {
					shared.hostFlush();
				}
			}
		}

		// ---- watched lifecycle (ReactiveSystemOptions.start/stop) -------------

		// Inline delivery, like upstream's unwatched: callbacks run inside
		// graph operations and are treated like effect-cleanup code.
		function hostStartNode(id: number): void {
			const flags = M[id + C.FLAGS];
			if (flags & C.HOST_STARTED) {
				return;
			}
			M[id + C.FLAGS] = flags | C.HOST_STARTED;
			hostState[id >> 3] = shared.hostStart!(id);
		}

		function hostStopNode(id: number): void {
			const flags = M[id + C.FLAGS] & ~C.HOST_STARTED;
			M[id + C.FLAGS] = flags;
			const state = hostState[id >> 3];
			hostState[id >> 3] = undefined;
			if (shared.hostStop !== undefined) {
				shared.hostStop(id, state);
			}
		}

		function propagate(startLink: number, innerWrite: boolean): void {
			// No try/finally: propagate never runs user code (notify only
			// queues), so it cannot throw and always drains the stack back to
			// its base.
			let cur = startLink;
			let next = M[cur + C.NEXT_SUB];
			const markBits = innerWrite ? C.PENDING | C.RECURSED : C.PENDING;
			const stackBase = propSp;

			top: do {
				const sub = M[cur + C.SUB];
				let flags = M[sub + C.FLAGS];

				if (!(flags & (C.RECURSED_CHECK | C.RECURSED | C.DIRTY | C.PENDING))) {
					M[sub + C.FLAGS] = flags | markBits;
				} else if (!(flags & (C.RECURSED_CHECK | C.RECURSED))) {
					flags = 0;
				} else if (!(flags & C.RECURSED_CHECK)) {
					M[sub + C.FLAGS] = (flags & ~C.RECURSED) | C.PENDING;
				} else if (!(flags & (C.DIRTY | C.PENDING)) && isValidLink(cur, sub)) {
					M[sub + C.FLAGS] = flags | (C.RECURSED | C.PENDING);
					flags &= C.MUTABLE;
				} else {
					flags = 0;
				}

				if (flags & C.WATCHING) {
					notify(sub);
				}

				if (flags & C.MUTABLE) {
					const subSubs = M[sub + C.SUBS];
					if (subSubs !== 0) {
						cur = subSubs;
						const nextSub = M[cur + C.NEXT_SUB];
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
					next = M[cur + C.NEXT_SUB];
					continue;
				}

				while (propSp > stackBase) {
					cur = propStack[--propSp];
					if (cur !== 0) {
						next = M[cur + C.NEXT_SUB];
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
			if (M[startSub + C.FLAGS] & C.DIRTY) {
				return true;
			}
			const dep = M[startLink + C.DEP];
			const depFlags = M[dep + C.FLAGS];
			if ((depFlags & (C.MUTABLE | C.DIRTY)) === (C.MUTABLE | C.DIRTY)) {
				if (updateAndShallow(dep, M[dep + C.SUBS])) {
					// Same disposed-sub guard as the loop's return: update()
					// may run user code that disposes the sub mid-walk.
					return M[startSub + C.FLAGS] !== 0;
				}
				const nextDep = M[startLink + C.NEXT_DEP];
				if (!nextDep) {
					return false;
				}
				startLink = nextDep;
			} else if ((depFlags & (C.MUTABLE | C.PENDING)) === (C.MUTABLE | C.PENDING)) {
				// Two-level degenerate case: the pending dep has exactly one
				// dep of its own and it is directly dirty — the shape of
				// every effect one computed away from a written signal. The
				// sequence mirrors the loop's descend-then-unwind for this
				// shape: update the inner node (subs captured first), then
				// either recompute the pending dep or clear its Pending.
				const innerLink = M[dep + C.DEPS];
				const inner = M[innerLink + C.DEP];
				if (
					!M[innerLink + C.NEXT_DEP]
					&& (M[inner + C.FLAGS] & (C.MUTABLE | C.DIRTY)) === (C.MUTABLE | C.DIRTY)
				) {
					if (updateAndShallow(inner, M[inner + C.SUBS])) {
						if (updateAndShallow(dep, M[dep + C.SUBS])) {
							return M[startSub + C.FLAGS] !== 0;
						}
					} else {
						M[dep + C.FLAGS] &= ~C.PENDING;
					}
					const nextDep = M[startLink + C.NEXT_DEP];
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
			if (!M[startLink + C.NEXT_DEP]) {
				const r = chainCheck(startLink);
				if (r >= 0) {
					return r !== 0 && M[startSub + C.FLAGS] !== 0;
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
				if (M[subs + C.NEXT_SUB] !== 0) {
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
				dep = M[link + C.DEP];
				const flags = M[dep + C.FLAGS];
				if ((flags & (C.MUTABLE | C.DIRTY)) === (C.MUTABLE | C.DIRTY)) {
					break; // dirty base found
				}
				if ((flags & (C.MUTABLE | C.PENDING)) !== (C.MUTABLE | C.PENDING)) {
					return -1; // clean or non-mutable dep: not a resolvable chain
				}
				const depDeps = M[dep + C.DEPS];
				if (!depDeps || M[depDeps + C.NEXT_DEP] !== 0) {
					return -1; // branching deps
				}
				const depSubs = M[dep + C.SUBS];
				if (!depSubs || M[depSubs + C.NEXT_SUB] !== 0) {
					return -1; // shared node: the climb needs a unique subscriber
				}
				link = depDeps;
				++depth;
			}
			if (!depth) {
				return -1; // directly-dirty first dep: the shallow paths own this
			}
			let changed = updateAndShallow(dep, M[dep + C.SUBS]);
			let node = dep;
			while (depth--) {
				const up = M[node + C.SUBS];
				const sub = M[up + C.SUB];
				if (changed) {
					changed = updateAndShallow(sub, M[sub + C.SUBS]);
				} else {
					M[sub + C.FLAGS] &= ~C.PENDING;
				}
				node = sub;
			}
			return changed ? 1 : 0;
		}

		function checkDirtyLoop(cur: number, sub: number): boolean {
			let checkDepth = 0;
			let dirty = false;

			top: do {
				const dep = M[cur + C.DEP];
				const depFlags = M[dep + C.FLAGS];

				if (M[sub + C.FLAGS] & C.DIRTY) {
					dirty = true;
				} else if ((depFlags & (C.MUTABLE | C.DIRTY)) === (C.MUTABLE | C.DIRTY)) {
					if (updateAndShallow(dep, M[dep + C.SUBS])) {
						dirty = true;
					}
				} else if ((depFlags & (C.MUTABLE | C.PENDING)) === (C.MUTABLE | C.PENDING)) {
					if (checkSp === checkStack.length) {
						growCheckStack();
					}
					checkStack[checkSp++] = cur;
					cur = M[dep + C.DEPS];
					sub = dep;
					++checkDepth;
					continue;
				}

				if (!dirty) {
					const nextDep = M[cur + C.NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue;
					}
				}

				while (checkDepth--) {
					cur = checkStack[--checkSp];
					if (dirty) {
						if (updateAndShallow(sub, M[sub + C.SUBS])) {
							sub = M[cur + C.SUB];
							continue;
						}
						dirty = false;
					} else {
						M[sub + C.FLAGS] &= ~C.PENDING;
					}
					sub = M[cur + C.SUB];
					const nextDep = M[cur + C.NEXT_DEP];
					if (nextDep !== 0) {
						cur = nextDep;
						continue top;
					}
				}

				// Upstream: `dirty && !!sub.flags` — a live node always has
				// its kind bits set; flags reads 0 only if sub was disposed
				// (record zeroed) by re-entrant user code during update().
				return dirty && M[sub + C.FLAGS] !== 0;
			} while (true);
		}

		function shallowPropagate(startLink: number): void {
			let cur = startLink;
			do {
				const sub = M[cur + C.SUB];
				const flags = M[sub + C.FLAGS];
				if ((flags & (C.PENDING | C.DIRTY)) === C.PENDING) {
					M[sub + C.FLAGS] = flags | C.DIRTY;
					if ((flags & (C.WATCHING | C.RECURSED_CHECK)) === C.WATCHING) {
						notify(sub);
					}
				}
			} while ((cur = M[cur + C.NEXT_SUB]) !== 0);
		}

		function isValidLink(checkLink: number, sub: number): boolean {
			let cur = M[sub + C.DEPS_TAIL];
			while (cur !== 0) {
				if (cur === checkLink) {
					return true;
				}
				cur = M[cur + C.PREV_DEP];
			}
			return false;
		}

		// ---- node behaviors (upstream index.ts, transliterated) ---------------

		// The walks land here for every MUTABLE|DIRTY node: resolution is the
		// host's (see ReactiveSystemOptions.update). Stamped with the epoch
		// captured BEFORE the host code runs: a write from inside it moves
		// the epoch past entryEpoch, so the stamp can only miss, never lie.
		function update(node: number): boolean {
			const flags = M[node + C.FLAGS];
			const entryEpoch = epoch;
			M[node + C.FLAGS] = (flags & (C.WATCHING | C.STICKY | C.LIVE | C.PUBLIC_MASK & ~C.DIRTY & ~C.PENDING)) | C.MUTABLE;
			const changed = shared.hostUpdate === undefined ? true : shared.hostUpdate(node, flags);
			D[(node >> 1) + 3] = entryEpoch;
			return changed;
		}

		// Effect scheduling is the host's (see ReactiveSystemOptions.notify):
		// the propagation ladder lands here for WATCHING nodes; clearing the
		// bit is the dedup (one notification until the host re-arms it).
		function notify(e: number): void {
			M[e + C.FLAGS] &= ~C.WATCHING;
			const hostNotify = shared.hostNotify;
			if (hostNotify !== undefined) {
				hostNotify(e, M[e + C.GEN]);
			}
		}

		function unwatched(node: number): void {
			if (M[node + C.FLAGS] & C.HOST_STARTED) {
				hostStopNode(node);
				if (M[node + C.SUBS] !== 0) {
					return; // stop() re-subscribed the node; it is watched again
				}
			}
			// Kill the quiet-read stamp: an unwatched node no longer receives
			// invalidations, so its cached verification must not be trusted
			// if something re-subscribes later.
			D[(node >> 1) + 3] = 0;
			if (M[node + C.FLAGS] & C.ORPHANED) {
				reclaimOrphan(node); // owner already collected; nothing can re-subscribe
			}
		}

		// Invalidate the quiet-read stamp (public flag surgery via
		// setNodeFlags may mark Dirty/Pending without a write).
		function clearStamp(id: number): void {
			if (retired) {
				shared.inner!.clearStamp(id);
				return;
			}
			D[(id >> 1) + 3] = 0;
		}

		// FinalizationRegistry target: the handle for this signal/computed was
		// garbage collected. Reclaim the record now if the graph no longer
		// needs it; otherwise mark it and reclaim when the last subscriber
		// unlinks (unwatched). Only make* handles register, and only this path
		// frees signal/computed records, so the id cannot be stale here.
		function orphan(id: number): void {
			if (retired) {
				shared.inner!.orphan(id);
				return;
			}
			const flags = M[id + C.FLAGS];
			if (!(flags & C.LIVE)) {
				return; // already reclaimed
			}
			if (M[id + C.SUBS] !== 0) {
				M[id + C.FLAGS] = flags | C.ORPHANED;
			} else {
				reclaimOrphan(id);
			}
		}

		// No live handle (the registry fired) and no subscribers: release the
		// record's edges and queue it for the free list. Zero-flags-first
		// mirrors disposeInner's re-entrancy guard.
		function reclaimOrphan(id: number): void {
			M[id + C.FLAGS] = 0;
			disposeAllDepsInReverse(id);
			pendingFree.push(id);
			shared.boundaryPending = true;
			shared.scheduleMaintenance();
		}

		function disposeAllDepsInReverse(sub: number): void {
			let cur = M[sub + C.DEPS_TAIL];
			while (cur !== 0) {
				const prev = M[cur + C.PREV_DEP];
				unlink(cur, sub);
				cur = prev;
			}
		}

		function purgeDeps(sub: number): void {
			const depsTail = M[sub + C.DEPS_TAIL];
			let dep = depsTail !== 0 ? M[depsTail + C.NEXT_DEP] : M[sub + C.DEPS];
			while (dep !== 0) {
				dep = unlink(dep, sub);
			}
		}

		// ---- operations dispatched from the public system object --------------

		// Upstream index.ts trigger(): run `fn` under a temporary watching sub,
		// then re-notify every dependency it read as if written. The temp node
		// is kindless: it is never notified (the propagate ladder masks its
		// Watching bit in every reachable branch), never a dep of anything, and
		// is reclaimed at the next boundary.
		function trigger(fn: () => void): void {
			if (retired) {
				shared.inner!.trigger(fn);
				return;
			}
			const sub = allocNode(C.WATCHING | C.RECURSED_CHECK);
			const prevSub = activeSub;
			activeSub = sub;
			++batchDepth;
			++enterDepth;
			try {
				fn();
			} finally {
				activeSub = prevSub;
				++epoch;
				M[sub + C.FLAGS] = 0;
				let cur = M[sub + C.DEPS];
				while (cur !== 0) {
					const dep = M[cur + C.DEP];
					cur = unlink(cur, sub);
					const subs = M[dep + C.SUBS];
					if (subs !== 0) {
						propagate(subs, runDepth !== 0);
						shallowPropagate(subs);
					}
				}
				pendingFree.push(sub);
				shared.boundaryPending = true;
				shared.scheduleMaintenance();
				--enterDepth;
				if (!--batchDepth) {
					const hostFlush = shared.hostFlush;
					if (hostFlush !== undefined) {
						hostFlush();
					}
				}
			}
		}
	}


