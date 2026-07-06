/**
 * dalien-signals system: the alien-signals v3.2.x algorithm on a
 * data-oriented, interleaved Int32Array record plane.
 *
 * This replaces the upstream object-graph kernel (ReactiveNode/Link objects,
 * cons-cell traversal stacks) with the layout proven in this repo's research
 * program (libs/arena, 179/179 reactive-framework-test-suite conformance;
 * see research/RESEARCH.md §7b and research/packed-structs-guide.md):
 *
 * - Nodes and links are integer ids into ONE flat Int32Array plane (M),
 *   stride 8; ids are pre-multiplied record offsets (id = recordIndex * 8) so
 *   field access is `M[id + FIELD]`. Nodes and links interleave in the same
 *   plane: single base register, single bump pointer, two free lists (plane
 *   merge measured -2% deep / -8% diamond vs split planes). Record 0 is
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
 * CAPACITY (fixed plane, zero-indirection handles): the whole engine —
 * including every user-facing handle closure — closes over `const M`
 * (TurboFan embeds the base address; measured at exact const parity — see
 * the v8-growable-buffer-bindings note cited in RESEARCH.md §7). The plane
 * is FIXED CAPACITY and never moves: that is what makes it safe for handles
 * to capture M directly and call the engine's read/write/computedRead as
 * direct closure-scope calls (upstream-parity hop count). Capacity is
 * virtual until touched (large typed arrays are lazily-mapped zero pages),
 * defaults to 8M records (256 MB virtual), and is set per system with
 * configure({ initialRecords }) BEFORE first use; exhausting it throws a
 * loud, actionable error. Buffers are allocated LAZILY: importing the
 * library costs nothing; the plane comes into being at the first primitive
 * creation or when `configure()` is called, whichever happens first
 * (configure() is the browser-friendly sizing knob — there is deliberately
 * no environment-variable path, matching upstream's zero use of
 * `process.env`). Rejected alternatives (measured, do not relitigate):
 * growth via segment tables, resizable ArrayBuffers, mutable `let` buffer
 * bindings, per-function const aliases — every growth-support mechanism
 * puts a tax on the read path.
 *
 * RECLAMATION: effect/effectScope disposal returns node records to the free
 * list (deferred to the next operation boundary so a mid-flush dispose can
 * never recycle a record the queue or an in-flight walk still references; a
 * generation counter in the record makes stale disposers no-ops). Signal and
 * computed records are owned by the user's handle closures and are NOT
 * reclaimed: dropping the last reference to a signal/computed handle leaks
 * its record. The fix would be a FinalizationRegistry on the handles pushing
 * ids onto the free list — deliberately not implemented here.
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
export enum ReactiveFlags {
	None = 0,
	Mutable = 1,
	Watching = 2,
	RecursedCheck = 4,
	Recursed = 8,
	Dirty = 16,
	Pending = 32,
}

/**
 * The subscriber view handed out by index.ts's getActiveSub(): the semantic
 * flags word of a live node. Reading/writing `flags` goes straight to the
 * record plane (kind bits are engine-owned and masked out of this view).
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
	// Node fields (M plane, stride 8; ids are pre-multiplied: id = record * 8).
	FLAGS = 0,
	DEPS = 1, // doubles as the free-list next pointer for freed node records
	DEPS_TAIL = 2,
	SUBS = 3,
	SUBS_TAIL = 4,
	GEN = 5, // bumped on free; disposers capture it to defuse stale ids
	// Quiet-read verification stamp, split across two i32 slots (53-bit
	// epoch: never wraps). Same cache line as FLAGS, so the fast-path check
	// costs no extra memory traffic. Node records are now fully packed.
	VSTAMP_HI = 6,
	VSTAMP_LO = 7,

	// Link fields (M plane, stride 8; link records share the plane with nodes).
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
	HAS_CHILD_EFFECT = 64,
	K_SIGNAL = 128,
	K_COMPUTED = 256,
	K_EFFECT = 512,
	K_SCOPE = 1024,
	KIND_MASK = K_SIGNAL | K_COMPUTED | K_EFFECT | K_SCOPE,
	// The record's handle was garbage-collected (FinalizationRegistry fired)
	// while subscribers still existed; reclaim when the last subscriber
	// unlinks. Engine-internal, outside PUBLIC_MASK.
	ORPHANED = 2048,
	// A handle-owned getter is currently installed in the fns column (only
	// while the computed has subscribers — see makeComputed). Engine-internal.
	FN_INSTALLED = 4096,
	// Bits visible through the public ReactiveNode view (semantic bits +
	// HasChildEffect, which upstream also kept in the public flags word).
	PUBLIC_MASK = 127,
}

// Default plane capacity: 8M records x 32 B = 256 MB of mostly-untouched
// (lazily mapped) zero pages — physical memory tracks records actually
// touched. The plane is FIXED CAPACITY: it never grows or moves, which is
// what lets every handle closure capture `const M` directly and reach the
// engine with zero indirection (the measured alternative — growable buffers
// behind any mutable binding or segment table — costs 26-83% on hot walks;
// see the header note). Override per system via configure({ initialRecords })
// or createReactiveSystem({ initialRecords }) BEFORE the first primitive is
// created — nothing is allocated until then.
const DEFAULT_RECORDS = 1 << 23;

function normalizeRecords(n: number): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) {
		throw new TypeError('dalien-signals: initialRecords must be a finite number');
	}
	return Math.max(16, Math.ceil(n));
}

// Placeholder scratch stack shared by unmaterialized systems (walks can only
// run once an engine exists; materialize() installs the real stacks).
const EMPTY_I32 = new Int32Array(0);


// Handle identity for isSignal/isComputed/isEffect/isEffectScope, at ZERO
// creation cost. Handles are deliberately ANONYMOUS closures — any NAMED
// closure (variable-inferred or declared) gets wrapped by esbuild keepNames
// pipelines (tsx, some bundlers) in Object.defineProperty(fn, 'name', ...):
// dictionary-mode properties and ~120ns per created handle, measured. Even a
// symbol brand costs ~3ns and ~24B per handle. Instead: every handle of a
// kind is an instantiation of the SAME closure literal, so Function.prototype
// .toString() is identical across all of them — each literal's source is
// sampled once at first mint, and kind checks are a cold string compare.
// (Upstream's `fn.name === 'bound signalOper'` check had the same spoofable-
// by-construction character; this one additionally survives keepNames.)
export const enum HandleKind {
	None = 0,
	Signal = 1,
	Computed = 2,
	Effect = 3,
	EffectScope = 4,
}

// Sampled source text per kind; computed handles have two literals (one per
// reclamation mode). Module-level: every system shares the same literals.
let signalSrc: string | undefined;
let computedSrc: string | undefined;
let effectSrc: string | undefined;
let scopeSrc: string | undefined;

// Handle literals pass through anon() so they sit in ARGUMENT position — a
// `const oper = <arrow>` initializer would be name-inferred and
// keepNames-wrapped (the ~120ns/handle tax the anonymity exists to avoid).
// anon() is an identity function; TurboFan inlines it to nothing.
function anon<T>(f: T): T {
	return f;
}

/** Kind of a handle produced by this module's make* factories. */
export function handleKind(fn: unknown): HandleKind {
	if (typeof fn !== 'function') {
		return HandleKind.None;
	}
	const src = String(fn);
	if (src === signalSrc) {
		return HandleKind.Signal;
	}
	if (src === computedSrc) {
		return HandleKind.Computed;
	}
	if (src === effectSrc) {
		return HandleKind.Effect;
	}
	if (src === scopeSrc) {
		return HandleKind.EffectScope;
	}
	return HandleKind.None;
}

function noop(): void {}

function uninitialized(): never {
	throw new Error('dalien-signals: system not materialized — create a signal/computed/effect or call configure() first');
}



/**
 * Id-level operations of the live engine, exposed as {@link ReactiveSystem.e}.
 * Assigned at materialization and stable thereafter (the plane is fixed
 * capacity, so the engine is never rebuilt). Handles returned by the make*
 * methods do NOT go through this object — they are closures minted inside
 * the engine over `const M`, calling these functions directly.
 */
export interface ReactiveEngine {
	read(id: number): unknown;
	/** Write a signal; propagates and (outside a batch) flushes effects. */
	write(id: number, value: unknown): void;
	computedRead(id: number): unknown;
	/** Dispose an effect/scope if `gen` still matches (stale ids are no-ops). */
	dispose(id: number, gen: number): void;
	makeSignal(initialValue?: unknown): SignalHandle;
	makeComputed(getter: (previousValue?: unknown) => unknown): () => unknown;
	makeEffect(fn: () => (() => void) | void): () => void;
	makeScope(fn: () => void): () => void;
}

/** Callable signal handle: `s()` reads, `s(value)` writes. */
export type SignalHandle = {
	(): unknown;
	(value: unknown): void;
};

/** The self-contained reactive system returned by {@link createReactiveSystem}. */
export interface ReactiveSystem {
	/**
	 * The live engine (id-level entry points). Assigned at materialization,
	 * stable thereafter.
	 */
	e: ReactiveEngine;
	/**
	 * Set the record-plane CAPACITY (it does not grow) and allocate it now.
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
	 * plane, truncates the value/callback tables, and replaces the
	 * FinalizationRegistry, so an entire dead generation is reclaimed by the
	 * GC as a few large objects instead of one weak cell per handle. Every
	 * handle created before the reset is invalid afterwards — calling one is
	 * undefined behavior. Throws if called during an active operation
	 * (inside an effect, computed getter, batch, or trigger). The engine
	 * itself (and its warmed-up JIT state) is reused across resets.
	 */
	reset(): void;
	/** Create a signal and return its callable handle (zero-indirection closure). */
	makeSignal(initialValue?: unknown): SignalHandle;
	/** Create a computed and return its read handle. */
	makeComputed(getter: (previousValue?: unknown) => unknown): () => unknown;
	/** Create an effect (runs immediately) and return its disposer. */
	makeEffect(fn: () => (() => void) | void): () => void;
	/** Create an effect scope (runs immediately) and return its disposer. */
	makeScope(fn: () => void): () => void;
	/** Allocate a signal record holding `initialValue`. Returns its id. */
	signal(initialValue?: unknown): number;
	/** Allocate a computed record over `getter`. Returns its id. */
	computed(getter: (previousValue?: unknown) => unknown): number;
	/** Allocate an effect record and run `fn` inside it (alien semantics). */
	effect(fn: () => (() => void) | void): number;
	/** Allocate an effect scope record and run `fn` inside it. */
	effectScope(fn: () => void): number;
	/** Dispose an effect/scope if `gen` still matches (stale ids are no-ops). */
	dispose(id: number, gen: number): void;
	/** Current generation counter of a record (capture at creation). */
	gen(id: number): number;
	signalRead(id: number): unknown;
	signalWrite(id: number, value: unknown): void;
	computedRead(id: number): unknown;
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
	/** The live record plane (debugging/tooling only). */
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
	/** Plane CAPACITY in 32-byte records (fixed; default 2^23). */
	initialRecords?: number;
}

export function createReactiveSystem(options?: ReactiveSystemOptions): ReactiveSystem {
	// ---- shared mutable state (survives engine rebuilds) ----------------------
	// Scalar heads/counters live at factory level so a rebuilt engine resumes
	// exactly where the old one stopped; only the buffer binding lives in the
	// engine closure.
	let recNext = 8; // bump pointer, shared by nodes and links (record 0 burned)
	let nodeFreeHead = 0; // free list threaded through M[id + C.DEPS]
	let linkFreeHead = 0; // free list threaded through M[id + C.NEXT_DEP]
	let boundaryPending = false; // pendingFree nonempty (one hot-path load)

	let cycle = 0;
	// Global write epoch (quiet-read fast path): bumped by every committed
	// signal write and every trigger(). A computed whose verification stamp
	// equals the current epoch is provably current — nothing anywhere has
	// been written since it was last verified — so reads skip the flags
	// ladder entirely. Preact/Vue 3.6/Svelte ship the same idea; upstream
	// alien-signals does not. Split lo/hi (manual carry at 2^30) so stamps
	// fit two i32 record slots and the whole scheme never wraps.
	let epochLo = 1;
	let epochHi = 1;
	let runDepth = 0;
	let batchDepth = 0;
	let notifyIndex = 0;
	let queuedLength = 0;
	let activeSub = 0;
	let enterDepth = 0; // live engine frames that captured M; 0 = op boundary

	const queued: number[] = [];
	const pendingFree: number[] = []; // disposed effect/scope records awaiting sweep
	// Computeds that lost their last subscriber and should return their
	// borrowed getter to the owning handle. Deferred to the next operation
	// boundary: an in-flight walk (e.g. a dispose() called from inside a
	// getter mid-checkDirty) may still update() the node and needs its
	// evaluator until the walk unwinds (conformance #203).
	const pendingFnClear: number[] = [];

	// Side columns, indexed off the id: values[id >> 2] = current/computed
	// value, values[(id >> 2) + 1] = signal pending value OR effect cleanup fn,
	// fns[id >> 3] = computed getter / effect fn. Plain arrays grown by push
	// (stays PACKED; plain-array growth has no binding problem).
	const values: unknown[] = [undefined, undefined];
	const fns: (Function | undefined)[] = [undefined];

	// Persistent scratch stacks (upstream's cons-cell Stack<T>). Re-entrant
	// walks push above the caller's base and restore it on exit. Allocated by
	// materialize() together with the plane; walks can only run once an
	// engine (and therefore a node) exists.
	let propStack: Int32Array = EMPTY_I32;
	let propSp = 0;
	let checkStack: Int32Array = EMPTY_I32;
	let checkSp = 0;

	// Growth is out of line so the walk loops stay under V8's 460-bytecode
	// inlining budget (enforced by the bytecode budget test).
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

	interface Engine extends ReactiveEngine {
		buffer(): Int32Array;
		newSignal(value: unknown): number;
		newComputed(getter: (previousValue?: unknown) => unknown): number;
		newEffect(fn: () => (() => void) | void): number;
		newScope(fn: () => void): number;
		makeSignal(initialValue: unknown): SignalHandle;
		makeComputed(getter: (previousValue?: unknown) => unknown): () => unknown;
		makeEffect(fn: () => (() => void) | void): () => void;
		makeScope(fn: () => void): () => void;
		orphan(id: number): void;
		clearStamp(id: number): void;
		run(e: number): void;
		requeueAbort(e: number): void;
		trigger(fn: () => void): void;
		sweepPendingFree(): void;
		sweepFnClears(): void;
	}

	// LAZY MATERIALIZATION: importing/creating a system allocates nothing.
	// The plane + scratch stacks come into being at the first primitive
	// creation, or when configure() is called — whichever happens first.
	let configuredRecords = options?.initialRecords !== undefined
		? normalizeRecords(options.initialRecords)
		: DEFAULT_RECORDS;
	let inner: Engine | undefined;
	// Reclaims signal/computed records whose handles were garbage collected
	// (upstream reclaims them implicitly: its whole graph is GC-visible).
	// Callbacks run between tasks, so reclamation needs the event loop to
	// turn — exactly when real applications yield. REQUIRED: this library
	// does not ship a leaking configuration.
	let registry: FinalizationRegistry<number>;
	// Registration is IMMEDIATE (FinalizationRegistry.register, ~15ns): every
	// batching scheme measured worse — a pending queue strongly retains each
	// handle until it drains, which carries the whole batch through the
	// nursery into premature promotion and turns the saving into major-GC
	// debt.

	function ensureEngine(): Engine {
		return inner !== undefined ? inner : materialize();
	}

	// Each registry's callback disarms itself once the registry is no longer
	// current: reset() replaces the registry, but cleanups already enqueued
	// for the old one keep it alive until they drain, and their record ids
	// refer to the pre-reset arena — running them would reclaim whatever new
	// node now occupies that id.
	function mintRegistry(): FinalizationRegistry<number> {
		const minted: FinalizationRegistry<number> = new FinalizationRegistry((id) => {
			if (registry === minted) {
				inner!.orphan(id);
			}
		});
		return minted;
	}

	function materialize(): Engine {
		propStack = new Int32Array(4096);
		checkStack = new Int32Array(4096);
		if (typeof FinalizationRegistry !== 'function') {
			throw new Error('dalien-signals requires FinalizationRegistry (ES2021): dropped signal/computed handles reclaim their records through it');
		}
		registry = mintRegistry();
		const engine = createEngine(configuredRecords);
		inner = engine;
		facade.e = engine;
		// Sample each handle literal's source once from throwaway mints so
		// handleKind() works without any per-mint bookkeeping. (The dummy
		// records self-reclaim via the registry when it exists; otherwise
		// they cost a few records, once per system.)
		if (signalSrc === undefined) {
			signalSrc = String(engine.makeSignal(undefined));
			computedSrc = String(engine.makeComputed(noop));
			effectSrc = String(engine.makeEffect(noop));
			scopeSrc = String(engine.makeScope(noop));
		}
		return engine;
	}


	// Seed the engine's user-callback call sites (cold eval, recompute,
	// effect run) past V8's megamorphic threshold (>4 shapes). When such a
	// site has seen four or fewer shapes, V8 speculates on the exact call
	// targets and compiles them inline; a workload that later pushes the
	// site past the threshold deoptimizes the engine's hot functions and
	// pays reoptimization cycles mid-run (measured at 20-35% on pull-heavy
	// graphs when several distinct workloads share one process).
	//
	// Seeding is LAZY: it fires when the 33rd node is created rather than
	// at engine startup. A tiny dedicated loop over a handful of nodes —
	// the shape of a hot micro-kernel — never seeds and keeps V8's full
	// single-target speculation (which is worth ~10% there); anything
	// resembling an application crosses 33 nodes while still building its
	// first graph, so the flat-behavior insurance is in place before any
	// steady state forms. Also skipped on tiny configured planes, where
	// the ~30 transient records would be a real bite out of capacity.
	//
	// 33 sits in the middle of a measured zero-regret plateau, not on a
	// point estimate (benchs/seedThreshold.mjs): thresholds at or below
	// ~17 charge real micro-kernels the megamorphic premium for nothing,
	// and thresholds at or above ~65 leave a 40-node first graph
	// speculated when its callback shapes later diversify (a ~1.15x
	// deopt-churn cliff). Any value between roughly 20 and 45 measures
	// identically on both corpora.
	let mintCount = 0;
	let seeded = false;
	function maybeSeed(): void {
		if (seeded || ++mintCount < 33 || configuredRecords < 4096) {
			return;
		}
		seeded = true;
		const engine = inner!;
		const s0 = engine.makeSignal(0);
		const read = s0 as () => number;
		const c1 = engine.makeComputed(() => read() + 1);
		const c2 = engine.makeComputed((p) => (p === undefined ? 0 : (p as number)) + read());
		const c3 = engine.makeComputed(() => {
			const v = read();
			return v * 2;
		});
		const c4 = engine.makeComputed(() => read() - 1);
		const c5 = engine.makeComputed(() => (read() & 1) + read());
		const cs = [c1, c2, c3, c4, c5];
		const e1 = engine.makeEffect(() => {
			c1();
		});
		const e2 = engine.makeEffect(() => {
			c2();
			c3();
		});
		const e3 = engine.makeEffect(() => {
			c4();
		});
		const e4 = engine.makeEffect(() => {
			void c5();
		});
		const e5 = engine.makeEffect(() => {
			for (const c of cs) {
				c();
			}
		});
		const write = s0 as (v: number) => void;
		for (let round = 1; round <= 3; round++) {
			write(round);
			c1();
			c2();
			c3();
			c4();
			c5();
		}
		e1();
		e2();
		e3();
		e4();
		e5();
	}

	// ---- operation boundaries: reclamation + growth ---------------------------

	// Reclamation (record sweeps, getter returns) runs in a microtask — after
	// the current synchronous operation, before the next task — mirroring
	// where upstream's GC pays its reclamation cost. The synchronous boundary
	// drain only fires when a long fully-synchronous burst piles work past
	// the caps, keeping memory bounded without taxing the common op.
	let maintenanceScheduled = false;

	function scheduleMaintenance(): void {
		if (!maintenanceScheduled) {
			maintenanceScheduled = true;
			queueMicrotask(runMaintenance);
		}
	}

	function runMaintenance(): void {
		maintenanceScheduled = false;
		if (boundaryPending && !enterDepth) {
			boundaryWork();
		}
	}

	function maybeBoundary(): void {
		if (boundaryPending && !enterDepth
			&& (pendingFree.length > 8192 || pendingFnClear.length > 8192)) {
			boundaryWork();
		}
	}

	function boundaryWork(): void {
		boundaryPending = false;
		// boundaryPending is only ever raised by engine code, so `inner` is
		// always materialized by the time this runs.
		if (pendingFnClear.length !== 0) {
			inner!.sweepFnClears();
		}
		// Sweep only while the effect queue is empty: an un-flushed queue (e.g.
		// a read's shallowPropagate notified an effect after the last flush) may
		// still reference a disposed record, and freeing it here would let a new
		// node reuse the id and be run() by the stale queue entry.
		if (pendingFree.length !== 0) {
			if (!queuedLength) {
				inner!.sweepPendingFree();
			} else {
				boundaryPending = true; // retry once the queue drains
			}
		}
	}

	function flush(): void {
		// Boundary-lite: record reclamation only BEFORE the flush loop, not
		// between effects (a mid-flush sweep could recycle an id the queue
		// still holds).
		maybeBoundary();
		// A flush implies queued effects, which imply a materialized engine.
		const engine = inner!;
		const queue = queued;
		try {
			while (notifyIndex < queuedLength) {
				const e = queue[notifyIndex];
				queue[notifyIndex++] = 0;
				engine.run(e);
			}
		} finally {
			while (notifyIndex < queuedLength) {
				const e = queue[notifyIndex];
				queue[notifyIndex++] = 0;
				engine.requeueAbort(e);
			}
			notifyIndex = 0;
			queuedLength = 0;
		}
	}

	// ---- the engine (rebuilt on growth; M is closure-const) -------------------

	function createEngine(records: number): Engine {
		const M = new Int32Array(records * 8);
		// Function-scope aliases for the factory-level side arrays: esbuild
		// bundling demotes module/factory-scope `const` to mutable `var` only at
		// module scope; these locals fold via the same one-closure-cell context
		// specialization that embeds M.
		const vals = values;
		const fnTab = fns;
		const queue = queued;

		return {
			buffer: () => M,
			newSignal,
			newComputed,
			newEffect,
			newScope,
			makeSignal,
			makeComputed,
			makeEffect,
			makeScope,
			orphan,
			clearStamp,
			read,
			write,
			computedRead,
			run,
			requeueAbort,
			dispose,
			trigger,
			sweepPendingFree,
			sweepFnClears,
		};

		// ---- user-facing handles ------------------------------------------------
		// Handles are closures minted INSIDE the engine over `const M`: calling
		// one reaches the graph with upstream-parity hop count (the closure IS
		// the operation; read/write/computedRead/dispose below are direct
		// closure-scope calls that TurboFan statically resolves and inlines).
		// The closures' statically-inferred names ('signalOper' etc., stored on
		// the shared function info at zero per-instance cost) are the identity
		// channel for index.ts's isSignal/isComputed/isEffect/isEffectScope.

		function makeSignal(initialValue: unknown): SignalHandle {
			maybeSeed();
			maybeBoundary();
			const id = newSignal(initialValue);
			const oper = anon(((...value: [unknown?]): unknown => {
				if (value.length) {
					write(id, value[0]);
				} else {
					return read(id);
				}
			}) as SignalHandle);
			if (registry !== undefined) {
				registry.register(oper, id);
			}
			return oper;
		}

		// The HANDLE owns the getter; the fns column only borrows it while the
		// computed is subscribed (installed on first tracked read, dropped at
		// unwatched). Storing it unconditionally would let the column pin the
		// handle itself through capture cycles (getter -> shared block context
		// -> handle), making the FinalizationRegistry unable to ever fire —
		// upstream has no such anchor because its whole graph is GC-traceable.
		function makeComputed(getter: (previousValue?: unknown) => unknown): () => unknown {
			maybeSeed();
			maybeBoundary();
			const id = allocNode(C.K_COMPUTED);
			// Registration is deferred to the first evaluation (see
			// coldEvalWith): an unevaluated computed has no value and no
			// engine-side closure anchor (getters are handle-owned), so there
			// is nothing GC-visible to reclaim — and create-heavy workloads
			// skip the registry entirely for computeds they never use. A
			// dropped never-read computed leaks only its 32-byte plane record.
			return anon(() => computedReadWith(id, getter));
		}

		function makeEffect(fn: () => (() => void) | void): () => void {
			maybeSeed();
			maybeBoundary();
			const id = newEffect(fn);
			const gen = M[id + C.GEN];
			return () => {
				dispose(id, gen);
			};
		}

		function makeScope(fn: () => void): () => void {
			maybeSeed();
			maybeBoundary();
			const id = newScope(fn);
			const gen = M[id + C.GEN];
			// disposeScope wraps dispose: the distinct callee NAME keeps this
			// literal's source text different from makeEffect's under every
			// transform (their kinds are told apart by source, not by brand).
			return () => {
				disposeScope(id, gen);
			};
		}

		// ---- allocation --------------------------------------------------------

		function allocNode(flags: number): number {
			let id: number;
			if (nodeFreeHead !== 0) {
				id = nodeFreeHead;
				nodeFreeHead = M[id + C.DEPS];
				M[id + C.DEPS] = 0;
			} else {
				id = recNext;
				if (id >= M.length) {
					throw new Error('dalien-signals: record plane capacity exhausted; configure({ initialRecords }) with a larger capacity before first use');
				}
				recNext = id + 8;
				// Size the side columns for a fresh record only (recycled ids
				// are already inside the sized region). push keeps the arrays
				// PACKED; a store past length would go HOLEY permanently.
				const v = id >> 2;
				while (vals.length <= v + 1) {
					vals.push(undefined);
				}
				while (fnTab.length <= id >> 3) {
					fnTab.push(undefined);
				}
			}
			M[id + C.FLAGS] = flags;
			return id;
		}

		function freeNode(id: number): void {
			M[id + C.VSTAMP_LO] = 0;
			M[id + C.VSTAMP_HI] = 0;
			M[id + C.FLAGS] = 0;
			M[id + C.DEPS_TAIL] = 0;
			M[id + C.SUBS] = 0;
			M[id + C.SUBS_TAIL] = 0;
			++M[id + C.GEN];
			const v = id >> 2;
			vals[v] = undefined;
			vals[v + 1] = undefined;
			fnTab[id >> 3] = undefined;
			M[id + C.DEPS] = nodeFreeHead;
			nodeFreeHead = id;
		}

		function sweepPendingFree(): void {
			for (let i = 0; i < pendingFree.length; ++i) {
				freeNode(pendingFree[i]);
			}
			pendingFree.length = 0;
		}

		// Return borrowed getters of still-unsubscribed computeds to their
		// handles. Safe at any boundary: no walk is live, and a re-subscribed
		// or recycled record is skipped (or, for a make* computed, harmlessly
		// re-installed on its next tracked read).
		function sweepFnClears(): void {
			for (let i = 0; i < pendingFnClear.length; ++i) {
				const id = pendingFnClear[i];
				const flags = M[id + C.FLAGS];
				if (
					(flags & (C.K_COMPUTED | C.FN_INSTALLED)) === (C.K_COMPUTED | C.FN_INSTALLED)
					&& !M[id + C.SUBS]
				) {
					fnTab[id >> 3] = undefined;
					M[id + C.FLAGS] = flags & ~C.FN_INSTALLED;
				}
			}
			pendingFnClear.length = 0;
		}

		function allocLink(): number {
			let id: number;
			if (linkFreeHead !== 0) {
				id = linkFreeHead;
				linkFreeHead = M[id + C.FREE_NEXT];
			} else {
				id = recNext;
				if (id >= M.length) {
					throw new Error('dalien-signals: record plane capacity exhausted; configure({ initialRecords }) with a larger capacity before first use');
				}
				recNext = id + 8;
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

		function update(node: number): boolean {
			const flags = M[node + C.FLAGS];
			if (flags & C.K_COMPUTED) {
				return updateComputed(node);
			}
			if (flags & C.K_SIGNAL) {
				return updateSignal(node);
			}
			M[node + C.FLAGS] = (flags & C.KIND_MASK) | C.MUTABLE;
			return true;
		}

		function notify(e: number): void {
			let insertIndex = queuedLength;
			const firstInsertedIndex = insertIndex;

			do {
				queue[insertIndex++] = e;
				M[e + C.FLAGS] &= ~C.WATCHING;
				const subs = M[e + C.SUBS];
				e = subs !== 0 ? M[subs + C.SUB] : 0;
				if (!e || !(M[e + C.FLAGS] & C.WATCHING)) {
					break;
				}
			} while (true);

			queuedLength = insertIndex;

			// The parent chain was appended child-first: reverse the inserted
			// segment in place so outer effects run before inner.
			let left = firstInsertedIndex;
			while (left < --insertIndex) {
				const tmp = queue[left];
				queue[left++] = queue[insertIndex];
				queue[insertIndex] = tmp;
			}
		}

		function unwatched(node: number): void {
			const flags = M[node + C.FLAGS];
			if (flags & C.K_COMPUTED) {
				// Alien recomputes an unwatched computed on its next read (it
				// is marked Dirty without any write); drop the stamp so the
				// fast path cannot skip that recompute.
				M[node + C.VSTAMP_LO] = 0;
				M[node + C.VSTAMP_HI] = 0;
				if (flags & C.ORPHANED) {
					reclaimOrphan(node); // handle already collected; nothing can re-subscribe
				} else {
					if (flags & C.FN_INSTALLED) {
						// Schedule the borrowed getter's return to its owning
						// handle (boundary-deferred; see pendingFnClear).
						pendingFnClear.push(node);
						boundaryPending = true;
						scheduleMaintenance();
					}
					if (M[node + C.DEPS_TAIL] !== 0) {
						M[node + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.DIRTY | (flags & C.FN_INSTALLED);
						disposeAllDepsInReverse(node);
					}
				}
			} else if (flags & C.K_SIGNAL) {
				if (flags & C.ORPHANED) {
					reclaimOrphan(node);
				}
			} else if (flags & (C.K_EFFECT | C.K_SCOPE)) {
				disposeInner(node);
			}
		}

		// Upstream's HasChildEffect slow path in updateComputed/run: unlink
		// every dep that is not a signal/computed (child effects/scopes), in
		// reverse, so their disposal (and cleanups) runs LIFO.
		function unlinkChildEffects(sub: number): void {
			let cur = M[sub + C.DEPS_TAIL];
			while (cur !== 0) {
				const prev = M[cur + C.PREV_DEP];
				const dep = M[cur + C.DEP];
				if (!(M[dep + C.FLAGS] & (C.K_COMPUTED | C.K_SIGNAL))) {
					unlink(cur, sub);
				}
				cur = prev;
			}
		}

		function updateComputed(c: number, getter?: (previousValue?: unknown) => unknown): boolean {
			const entryFlags = M[c + C.FLAGS];
			if (entryFlags & C.HAS_CHILD_EFFECT) {
				unlinkChildEffects(c);
			}
			M[c + C.DEPS_TAIL] = 0;
			M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK | (entryFlags & (C.ORPHANED | C.FN_INSTALLED));
			const prevSub = activeSub;
			activeSub = c;
			++enterDepth;
			try {
				++cycle;
				const v = c >> 2;
				const oldValue = vals[v];
				const fn = getter !== undefined ? getter : fnTab[c >> 3] as (previousValue?: unknown) => unknown;
				if (fn === undefined) {
					// Reachable only through an upstream-style stale walk: the
					// algorithm may read `nextDep` off links unlinked earlier in
					// the same walk (see freeLink), and such a dead-end can name
					// an unwatched computed whose borrowed getter was already
					// returned to its handle. Its result cannot matter (no
					// subscribers); report "unchanged" like upstream's cutoff.
					return false;
				}
				return oldValue !== (vals[v] = fn(oldValue));
			} finally {
				--enterDepth;
				activeSub = prevSub;
				M[c + C.FLAGS] &= ~C.RECURSED_CHECK;
				purgeDeps(c);
			}
		}

		function updateSignal(s: number): boolean {
			M[s + C.FLAGS] = C.K_SIGNAL | C.MUTABLE;
			const v = s >> 2;
			return vals[v] !== (vals[v] = vals[v + 1]);
		}

		function run(e: number): void {
			const flags = M[e + C.FLAGS];
			if (
				flags & C.DIRTY
				|| (flags & C.PENDING && checkDirty(M[e + C.DEPS], e))
			) {
				if (flags & C.HAS_CHILD_EFFECT) {
					unlinkChildEffects(e);
				}
				const cv = (e >> 2) + 1;
				if (vals[cv]) {
					runCleanup(e);
					if (!M[e + C.FLAGS]) {
						return; // disposed by its own cleanup
					}
				}
				M[e + C.DEPS_TAIL] = 0;
				M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK;
				const prevSub = activeSub;
				activeSub = e;
				++enterDepth;
				try {
					++cycle;
					++runDepth;
					vals[cv] = (fnTab[e >> 3] as () => (() => void) | void)();
				} finally {
					--runDepth;
					--enterDepth;
					activeSub = prevSub;
					M[e + C.FLAGS] &= ~C.RECURSED_CHECK;
					purgeDeps(e);
				}
			} else if (M[e + C.DEPS] !== 0) {
				M[e + C.FLAGS] = C.K_EFFECT | C.WATCHING | (flags & C.HAS_CHILD_EFFECT);
			}
		}

		// flush() abort path: re-arm effects still queued after a throw.
		function requeueAbort(e: number): void {
			if (M[e + C.FLAGS] & C.KIND_MASK) {
				M[e + C.FLAGS] |= C.WATCHING | C.RECURSED;
			}
		}

		function runCleanup(e: number): void {
			const cv = (e >> 2) + 1;
			const cleanup = vals[cv] as () => void;
			vals[cv] = undefined;
			const prevSub = activeSub;
			activeSub = 0;
			++enterDepth;
			try {
				cleanup();
			} finally {
				--enterDepth;
				activeSub = prevSub;
			}
		}

		// effectOper + effectScopeOper: dispose an effect (runs cleanup) or
		// scope. Children (linked as deps) dispose first via the reverse deps
		// walk -> unwatched cascade, giving depth-first LIFO cleanup order.
		function disposeInner(e: number): void {
			const flags = M[e + C.FLAGS];
			if (!(flags & C.KIND_MASK)) {
				return; // already disposed
			}
			M[e + C.FLAGS] = 0;
			disposeAllDepsInReverse(e);
			const sub = M[e + C.SUBS];
			if (sub !== 0) {
				unlink(sub);
			}
			if (flags & C.K_EFFECT && vals[(e >> 2) + 1]) {
				runCleanup(e);
			}
			// Release the GC payload NOW (nothing reads it once flags are 0):
			// waiting for the deferred sweep would keep the fn closure alive
			// past the current task and promote it out of the nursery.
			// (vals[e >> 2] stays: effects never write the current-value slot;
			// freeNode clears it for the record's next occupant.)
			fnTab[e >> 3] = undefined;
			vals[(e >> 2) + 1] = undefined;
			// Deferred reclamation: the queue (or an in-flight walk) may still
			// hold this id; the record is swept back onto the free list at the
			// next operation boundary.
			pendingFree.push(e);
			boundaryPending = true;
			scheduleMaintenance();
		}

		function dispose(e: number, gen: number): void {
			if (M[e + C.GEN] !== gen) {
				return; // record already reclaimed (and possibly reused)
			}
			disposeInner(e);
			maybeBoundary();
		}

		// Distinctly-named wrapper so effect and scope handle literals differ
		// textually (see makeScope). Declared (hoisted) — the engine's return
		// object is built before this line would run as a statement.
		function disposeScope(e: number, gen: number): void {
			dispose(e, gen);
		}

		// Invalidate the quiet-read stamp (public flag surgery via
		// setNodeFlags may mark Dirty/Pending without a write).
		function clearStamp(id: number): void {
			M[id + C.VSTAMP_LO] = 0;
			M[id + C.VSTAMP_HI] = 0;
		}

		// FinalizationRegistry target: the handle for this signal/computed was
		// garbage collected. Reclaim the record now if the graph no longer
		// needs it; otherwise mark it and reclaim when the last subscriber
		// unlinks (unwatched). Only make* handles register, and only this path
		// frees signal/computed records, so the id cannot be stale here.
		function orphan(id: number): void {
			const flags = M[id + C.FLAGS];
			if (!(flags & (C.K_SIGNAL | C.K_COMPUTED))) {
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
			boundaryPending = true;
			scheduleMaintenance();
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

		function newSignal(value: unknown): number {
			maybeSeed();
			const id = allocNode(C.K_SIGNAL | C.MUTABLE);
			const v = id >> 2;
			vals[v] = value; // currentValue
			vals[v + 1] = value; // pendingValue
			return id;
		}

		function newComputed(getter: (previousValue?: unknown) => unknown): number {
			maybeSeed();
			const id = allocNode(C.K_COMPUTED);
			fnTab[id >> 3] = getter;
			return id;
		}

		function newEffect(fn: () => (() => void) | void): number {
			maybeSeed();
			const e = allocNode(C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK);
			fnTab[e >> 3] = fn;
			const prevSub = activeSub;
			activeSub = e;
			if (prevSub !== 0) {
				link(e, prevSub, 0);
				M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT;
			}
			++enterDepth;
			try {
				++runDepth;
				vals[(e >> 2) + 1] = fn();
			} finally {
				--runDepth;
				--enterDepth;
				activeSub = prevSub;
				M[e + C.FLAGS] &= ~C.RECURSED_CHECK;
			}
			return e;
		}

		function newScope(fn: () => void): number {
			maybeSeed();
			const e = allocNode(C.K_SCOPE | C.MUTABLE);
			const prevSub = activeSub;
			activeSub = e;
			if (prevSub !== 0) {
				link(e, prevSub, 0);
				M[prevSub + C.FLAGS] |= C.HAS_CHILD_EFFECT;
			}
			++enterDepth;
			try {
				fn();
			} finally {
				--enterDepth;
				activeSub = prevSub;
			}
			return e;
		}

		// signalOper read path.
		function read(s: number): unknown {
			if (M[s + C.FLAGS] & C.DIRTY) {
				if (updateSignal(s)) {
					const subs = M[s + C.SUBS];
					if (subs !== 0) {
						shallowPropagate(subs);
					}
				}
			}
			if (activeSub !== 0) {
				link(s, activeSub, cycle);
			}
			return vals[s >> 2];
		}

		// signalOper write path. flush() (factory-level) starts with a boundary
		// check, so growth still happens between queued effects at top level.
		function write(s: number, value: unknown): void {
			const p = (s >> 2) + 1;
			if (vals[p] !== (vals[p] = value)) {
				M[s + C.FLAGS] = C.K_SIGNAL | C.MUTABLE | C.DIRTY;
				const subs = M[s + C.SUBS];
				if (subs !== 0) {
					// Stamps only exist on subscribed-or-once-subscribed
					// computeds, which hold links; an unobserved write can
					// invalidate no stamp, so the epoch only moves here.
					if (++epochLo === 0x40000000) {
						epochLo = 0;
						++epochHi;
					}
					propagate(subs, runDepth !== 0);
					if (!batchDepth) {
						flush();
					}
				}
			}
		}

		// computedOper for id-level callers: their getter is installed
		// permanently by newComputed, so no evaluator ever needs carrying.
		function computedRead(c: number): unknown {
			if (M[c + C.VSTAMP_LO] === epochLo && M[c + C.VSTAMP_HI] === epochHi) {
				const fastSub = activeSub;
				if (fastSub !== 0) {
					link(c, fastSub, cycle);
				}
				return vals[c >> 2];
			}
			// Stamp with the epoch captured BEFORE the body: if user code run
			// during verification writes a signal (bumping the epoch), the
			// stamp is already stale and the next read re-verifies.
			const lo = epochLo;
			const hi = epochHi;
			const flags = M[c + C.FLAGS];
			if (
				flags & C.DIRTY
				|| (
					flags & C.PENDING
					&& (
						checkDirty(M[c + C.DEPS], c)
						|| (M[c + C.FLAGS] = flags & ~C.PENDING, false)
					)
				)
			) {
				if (updateComputed(c)) {
					const subs = M[c + C.SUBS];
					if (subs !== 0) {
						shallowPropagate(subs);
					}
				}
			} else if (flags === C.K_COMPUTED) { // upstream `!flags`: never evaluated
				coldEvalInstalled(c);
			}
			const sub = activeSub;
			if (sub !== 0) {
				link(c, sub, cycle);
			}
			// Stamp tracked reads too: during a flush the epoch is stable
			// (the triggering write already bumped it), so every node the
			// flush verifies or recomputes becomes a same-epoch fast hit for
			// the rest of the flush (diamond re-reads) and for any reads
			// before the next write. The entry-captured epoch keeps this
			// safe: a write from user code during verification moved the
			// epoch past `lo/hi`, so the stamp can only miss, never lie.
			M[c + C.VSTAMP_LO] = lo;
			M[c + C.VSTAMP_HI] = hi;
			return vals[c >> 2];
		}

		// First evaluation with the handle-owned getter. Out of line: cold,
		// and it keeps computedReadWith under the inline budget.
		//
		// This is also where the computed joins the FinalizationRegistry.
		// It runs exactly once per node (`flags === K_COMPUTED` is only true
		// before the first evaluation; every later flag write sets MUTABLE),
		// so the hot read path carries no registration check, and computeds
		// that are created but never read cost no registry cell at all. The
		// weak target is the getter rather than the handle — the handle owns
		// the only lasting strong ref to it — so the record is reclaimed once
		// the getter is unreachable. A caller who keeps the getter alive after
		// dropping the handle keeps the record (and its cached value) alive
		// with it; that memory is still reachable from the caller's own
		// closure, not leaked.
		function coldEvalWith(c: number, getter: (previousValue?: unknown) => unknown): void {
			registry.register(getter, c);
			M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = c;
			++enterDepth;
			try {
				vals[c >> 2] = getter();
			} finally {
				--enterDepth;
				activeSub = prevSub;
				M[c + C.FLAGS] &= ~C.RECURSED_CHECK;
			}
		}

		// First evaluation of a computed whose getter is installed (id-level
		// computeds). Out of line: cold, and it keeps computedRead under the
		// inline budget.
		function coldEvalInstalled(c: number): void {
			M[c + C.FLAGS] = C.K_COMPUTED | C.MUTABLE | C.RECURSED_CHECK;
			const prevSub = activeSub;
			activeSub = c;
			++enterDepth;
			try {
				vals[c >> 2] = (fnTab[c >> 3] as () => unknown)();
			} finally {
				--enterDepth;
				activeSub = prevSub;
				M[c + C.FLAGS] &= ~C.RECURSED_CHECK;
			}
		}

		// Slow twin of computedRead for the sentinel paths: carries the
		// handle-owned evaluator and installs it on subscription.
		function computedReadWith(c: number, getter: (previousValue?: unknown) => unknown): unknown {
			if (M[c + C.VSTAMP_LO] === epochLo && M[c + C.VSTAMP_HI] === epochHi) {
				const fastSub = activeSub;
				if (fastSub !== 0) {
					link(c, fastSub, cycle);
					// A first subscription can arrive THROUGH this fast path
					// (the node was evaluated by an untracked read, stamped,
					// and nothing has been written since). The engine must
					// borrow the getter here exactly as the slow tail does,
					// or the node is subscribed with no evaluator installed
					// and later propagation walks cannot update it.
					if (!(M[c + C.FLAGS] & C.FN_INSTALLED)) {
						fnTab[c >> 3] = getter;
						M[c + C.FLAGS] |= C.FN_INSTALLED;
					}
				}
				return vals[c >> 2];
			}
			const lo = epochLo;
			const hi = epochHi;
			const flags = M[c + C.FLAGS];
			if (
				flags & C.DIRTY
				|| (
					flags & C.PENDING
					&& (
						checkDirty(M[c + C.DEPS], c)
						|| (M[c + C.FLAGS] = flags & ~C.PENDING, false)
					)
				)
			) {
				if (updateComputed(c, getter)) {
					const subs = M[c + C.SUBS];
					if (subs !== 0) {
						shallowPropagate(subs);
					}
				}
			} else if (flags === C.K_COMPUTED) { // upstream `!flags`: never evaluated
				coldEvalWith(c, getter);
			}
			const sub = activeSub;
			if (sub !== 0) {
				link(c, sub, cycle);
				// First subscription borrows the handle's getter into the fns
				// column so graph walks (checkDirty -> update) can evaluate
				// this node without the handle on the stack. Dropped again at
				// unwatched. Subscribed implies installed.
				if (!(M[c + C.FLAGS] & C.FN_INSTALLED)) {
					fnTab[c >> 3] = getter;
					M[c + C.FLAGS] |= C.FN_INSTALLED;
				}
			}
			// Stamp tracked reads too — see computedRead for the epoch
			// argument; the write->flush->read pattern consumes these stamps.
			M[c + C.VSTAMP_LO] = lo;
			M[c + C.VSTAMP_HI] = hi;
			return vals[c >> 2];
		}

		// Upstream index.ts trigger(): run `fn` under a temporary watching sub,
		// then re-notify every dependency it read as if written. The temp node
		// is kindless: it is never notified (the propagate ladder masks its
		// Watching bit in every reachable branch), never a dep of anything, and
		// is reclaimed at the next boundary.
		function trigger(fn: () => void): void {
			const sub = allocNode(C.WATCHING | C.RECURSED_CHECK);
			const prevSub = activeSub;
			activeSub = sub;
			++batchDepth;
			++enterDepth;
			try {
				fn();
			} finally {
				activeSub = prevSub;
				if (++epochLo === 0x40000000) {
					epochLo = 0;
					++epochHi;
				}
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
				boundaryPending = true;
				scheduleMaintenance();
				--enterDepth;
				if (!--batchDepth) {
					flush();
				}
			}
		}
	}

	// ---- the public system object (stable across engine rebuilds) -------------
	// `e` mirrors `inner` (materialize/boundaryWork reassign both) so hot call
	// sites reach the engine with one property load; everything else is cold
	// delegation through ensureEngine(), which materializes on first use.

	// `system.e` before materialization: creation entry points materialize
	// and delegate; id-level operations throw (ids can only come from a
	// materialized system). Handle call sites (read/write/computedRead/
	// dispose) only ever see the real engine's hidden class — handles
	// post-date materialization — so their ICs stay monomorphic.
	const bootEngine: ReactiveEngine = {
		read: uninitialized,
		write: uninitialized,
		computedRead: uninitialized,
		dispose: uninitialized,
		makeSignal: (initialValue?: unknown) => ensureEngine().makeSignal(initialValue),
		makeComputed: (getter: (previousValue?: unknown) => unknown) => ensureEngine().makeComputed(getter),
		makeEffect: (fn: () => (() => void) | void) => ensureEngine().makeEffect(fn),
		makeScope: (fn: () => void) => ensureEngine().makeScope(fn),
	};

	const facade: ReactiveSystem = {
		e: bootEngine,
		makeSignal(initialValue?: unknown): SignalHandle {
			return ensureEngine().makeSignal(initialValue);
		},
		makeComputed(getter: (previousValue?: unknown) => unknown): () => unknown {
			return ensureEngine().makeComputed(getter);
		},
		makeEffect(fn: () => (() => void) | void): () => void {
			return ensureEngine().makeEffect(fn);
		},
		makeScope(fn: () => void): () => void {
			return ensureEngine().makeScope(fn);
		},
		configure(configureOptions?: ReactiveSystemOptions): void {
			if (inner !== undefined) {
				throw new Error('dalien-signals: configure() must be called before the first signal/computed/effect/effectScope is created');
			}
			if (configureOptions?.initialRecords !== undefined) {
				configuredRecords = normalizeRecords(configureOptions.initialRecords);
			}
			materialize();
		},
		reset(): void {
			if (inner === undefined) {
				return; // nothing materialized, nothing to reset
			}
			if (enterDepth !== 0 || activeSub !== 0 || batchDepth !== 0 || runDepth !== 0) {
				throw new Error('dalien-signals: reset() called during an active operation (inside an effect, computed, batch, or trigger)');
			}
			// Bulk arena teardown: rewind the record plane and drop the whole
			// FinalizationRegistry, so a dead generation is reclaimed by the
			// GC as a few large objects instead of one weak cell per handle.
			// Every handle minted before the reset is INVALID afterwards —
			// calling one is undefined behavior (it reads whatever new node
			// occupies its record). The engine closures (and their warmed-up
			// JIT state) are reused; only the arena contents restart.
			inner.buffer().fill(0, 0, recNext);
			recNext = 8;
			nodeFreeHead = 0;
			linkFreeHead = 0;
			boundaryPending = false;
			notifyIndex = 0;
			queuedLength = 0;
			queued.length = 0;
			pendingFree.length = 0;
			pendingFnClear.length = 0;
			values.length = 2;
			values[0] = undefined;
			values[1] = undefined;
			fns.length = 1;
			fns[0] = undefined;
			// Epoch and link-cycle counters keep counting: fresh records hold
			// zeroed stamps/versions, which can never equal a live counter.
			registry = mintRegistry();
		},
		signal(initialValue?: unknown): number {
			const engine = ensureEngine();
			maybeBoundary();
			return engine.newSignal(initialValue);
		},
		computed(getter: (previousValue?: unknown) => unknown): number {
			const engine = ensureEngine();
			maybeBoundary();
			return engine.newComputed(getter);
		},
		effect(fn: () => (() => void) | void): number {
			const engine = ensureEngine();
			maybeBoundary();
			return engine.newEffect(fn);
		},
		effectScope(fn: () => void): number {
			const engine = ensureEngine();
			maybeBoundary();
			return engine.newScope(fn);
		},
		dispose(id: number, gen: number): void {
			ensureEngine().dispose(id, gen);
		},
		gen(id: number): number {
			return ensureEngine().buffer()[id + C.GEN];
		},
		signalRead(id: number): unknown {
			return ensureEngine().read(id);
		},
		signalWrite(id: number, value: unknown): void {
			ensureEngine().write(id, value);
		},
		computedRead(id: number): unknown {
			// No boundary on the read path: top-level first-eval read sequences
			// allocate well under C.REC_SLACK between the surrounding
			// safe-points; steady-state reads allocate nothing.
			return ensureEngine().computedRead(id);
		},
		trigger(fn: () => void): void {
			const engine = ensureEngine();
			maybeBoundary();
			engine.trigger(fn);
		},
		startBatch(): void {
			++batchDepth;
		},
		endBatch(): void {
			if (!--batchDepth) {
				flush();
			}
		},
		getBatchDepth(): number {
			return batchDepth;
		},
		getActiveSub(): number {
			return activeSub;
		},
		setActiveSub(id: number): number {
			const prev = activeSub;
			activeSub = id;
			return prev;
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
			const M = ensureEngine().buffer();
			let freeNodeRecords = 0;
			for (let id = nodeFreeHead; id !== 0; id = M[id + C.DEPS]) {
				++freeNodeRecords;
			}
			let freeLinkRecords = 0;
			for (let id = linkFreeHead; id !== 0; id = M[id + C.FREE_NEXT]) {
				++freeLinkRecords;
			}
			return {
				capacityRecords: M.length / 8,
				allocatedRecords: (recNext - 8) / 8,
				freeNodeRecords,
				freeLinkRecords,
				pendingFreeRecords: pendingFree.length,
				pendingRegistrations: 0,
			};
		},
	};
	return facade;
}
