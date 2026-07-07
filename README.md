<p align="center">
	<img src="assets/logo.png" width="250"><br>
</p>

<p align="center">
	<a href="https://npmjs.com/package/dalien-signals"><img src="https://badgen.net/npm/v/dalien-signals" alt="npm package"></a>
	<a href="https://deepwiki.com/justjake/dalien-signals"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

# dalien-signals

**d**alien-signals is a **d**ata-oriented fork of [alien-signals][], a fast [signals][tc39] reactivity library. Its reactive dependency graph is stored in a single `Int32Array` memory [arena][arena-wikipedia], like a contiguous array of structs in C.

The default arena reserves 64 MB of address space (2,097,152 records of 32 bytes). Large zero-filled buffers are typically demand-paged, or lazily committed: allocation reserves virtual address space, but resident physical memory grows only as pages are touched. `growCapacity()` raises the reservation for bigger graphs, and the arena also grows itself when it fills.

**See it live:** [justjake.github.io/dalien-signals](https://justjake.github.io/dalien-signals/) — paint a 20,000-node computation field and watch only the dependency cone recompute, then inspect the actual arena integers of a small graph as you write, batch, and dispose. The site's own HUD runs on the library (`example/`).

## How it works

`dalien-signals` keeps calculations and callbacks in sync with changing values. It provides three main primitives:

- A `signal` stores a value. Call it with no argument to read it, or with an argument to write it.
- A `computed` derives and caches a value from signals or other computeds.
- An `effect` runs a function now, then again when a value it read changes.

Dependencies are automatic. While a computed or effect runs, the library records every signal and computed it reads.

```ts
import { computed, effect, signal } from "dalien-signals";

const count = signal(1);
const doubled = computed(() => count() * 2);
const isEven = computed(() => count() % 2 === 0);

effect(() => console.log(doubled(), isEven())); // 2 false
count(2); // 4 true
```

```mermaid
flowchart LR
    count["signal: count"] -->|read by| doubled["computed: doubled"]
    count -->|read by| even["computed: isEven"]
    doubled -->|read by| log["effect: console.log both"]
    even -->|read by| log
```

Arrows point from a value to the work that depends on it. When `count` changes, the effect is reached through both computeds but queued only once.

Recalculating every downstream node on each write would waste work. Recalculating dependents immediately could also run an effect more than once or before all of its inputs are current. Updates instead use a push-pull algorithm:

1. **Push:** a write marks downstream computeds and effects as possibly stale. Effects are queued, but no user callback runs during this graph walk.
2. **Pull:** before a computed returns its value, it checks its dependencies and recalculates if necessary. A queued effect reruns and pulls each computed it reads up to date. If a computed's value has not changed, the update stops along that path.

```mermaid
sequenceDiagram
    participant S as signal: count
    participant D as computed: doubled
    participant V as computed: isEven
    participant E as effect: console.log

    S->>D: push: mark possibly stale
    D->>E: push: queue effect
    S->>V: push: mark possibly stale
    V->>E: push: effect already queued
    E->>D: pull: effect reads doubled
    D->>S: pull: read count
    S-->>D: 2
    D-->>E: 4
    E->>V: pull: effect reads isEven
    V->>S: pull: read count
    S-->>V: 2
    V-->>E: true
    Note over D,V: both values are current
    E->>E: console.log(4, true)
```

## API

````ts
import type { ReactiveNode } from "dalien-signals/system";

/** Return the node currently recording signal reads, if there is one. */
export declare function getActiveSub(): ReactiveNode | undefined;

/**
 * Set the node that records subsequent reads.
 * Returns the previous node so it can be restored.
 */
export declare function setActiveSub(
  sub?: ReactiveNode,
): ReactiveNode | undefined;

/**
 * Raise the arena's capacity to at least `records` 32-byte records (no-op
 * if already that big). Best called before building a large graph so it
 * never grows mid-flight. The default capacity is 2,097,152 records.
 *
 * @example
 * ```ts
 * growCapacity(1 << 22);
 * const count = signal(0);
 * ```
 */
export declare function growCapacity(records: number): void;

/** Return the number of currently open batches. */
export declare function getBatchDepth(): number;

/**
 * Open a batch. Queued effects wait for the matching `endBatch()`.
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
export declare function startBatch(): void;

/** Close a batch, flushing effects when the outermost batch closes. */
export declare function endBatch(): void;

/** Return whether `fn` is a signal created by this package. */
export declare function isSignal(fn: () => void): boolean;

/** Return whether `fn` is a computed created by this package. */
export declare function isComputed(fn: () => void): boolean;

/** Return whether `fn` is an effect disposer created by this package. */
export declare function isEffect(fn: () => void): boolean;

/** Return whether `fn` is an effect-scope disposer created by this package. */
export declare function isEffectScope(fn: () => void): boolean;

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
export declare function signal<T>(): {
  (): T | undefined;
  (value: T | undefined): void;
};
export declare function signal<T>(initialValue: T): {
  (): T;
  (value: T): void;
};

/**
 * Create a cached value derived from the signals and computeds read by
 * `getter`. Its argument is the previous value, or `undefined` initially.
 *
 * @example
 * ```ts
 * const count = signal(2);
 * const doubled = computed(() => count() * 2);
 * doubled(); // 4
 * count(3);
 * doubled(); // 6
 * ```
 */
export declare function computed<T>(getter: (previousValue?: T) => T): () => T;

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
export declare function effect(fn: () => void | (() => void)): () => void;

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
export declare function effectScope(fn: () => void): () => void;

/**
 * Notify dependents after mutating values stored inside signals in place.
 * Read each changed signal inside `fn`.
 *
 * @example
 * ```ts
 * const items = signal<string[]>([]);
 * const size = computed(() => items().length);
 * size(); // 0
 * items().push('one');
 * trigger(items);
 * size(); // 1
 * ```
 */
export declare function trigger(fn: () => void): void;
````

The `dalien-signals/system` entry point exposes isolated engines, numeric record IDs, debugging, and bulk reset.

## Storage

Internally, each signal, computed, effect, or scope is a node. Each dependency is a link. Both use eight-slot, 32-byte records in one fixed-capacity `Int32Array`, JavaScript's typed array of 32-bit integers:

```mermaid
classDiagram
    direction LR
    class Node["node record — 8 int32 slots, 32 bytes"] {
        0 FLAGS : update state and node type
        1 DEPS : first input link
        2 DEPS_TAIL : last input link
        3 SUBS : first dependent link
        4 SUBS_TAIL : last dependent link
        5 GEN : counter changed when reused
        6 VSTAMP_HI : write counter, high half
        7 VSTAMP_LO : write counter, low half
    }
    class Link["link record — 8 int32 slots, 32 bytes"] {
        0 VERSION : latest dependency scan
        1 DEP : node being read
        2 SUB : node doing the reading
        3 PREV_SUB : previous dependent link
        4 NEXT_SUB : next dependent link
        5 PREV_DEP : previous input link
        6 NEXT_DEP : next input link
        7 FREE_NEXT : next recycled link
    }
    class SideArrays["JavaScript side arrays"] {
        values : current, staged, cleanup
        fns : getters, callbacks
    }
    Node --> Link : DEPS / SUBS
    Link --> Node : DEP / SUB
    Node ..> SideArrays : same ID
```

- This array is the **arena**. An ID is a record's starting offset within it; ID `0` means “no record.”
- A free list chains unused records together so they can be recycled without allocating new edge objects.
- Side arrays hold values, cleanup functions, getters, and callbacks.

`FLAGS` stores the node type and update state. A computed moves through three states:

```mermaid
stateDiagram-v2
    Clean --> Pending : an earlier dependency was written
    Pending --> Dirty : a direct input changed value
    Pending --> Clean : all input values stayed equal
    Dirty --> Clean : recalculate and cache
```

- **Clean:** the cached value is current. This state has no `ReactiveFlags.Dirty` or `ReactiveFlags.Pending` bit.
- **Pending:** an input may have changed, so the node must check its inputs before deciding whether to recalculate.
- **Dirty:** a direct input changed, so the node must recalculate before returning its value.

Effects use the same pending-versus-dirty distinction to decide whether their callbacks need to rerun. The live `.flags` object returned by `getActiveSub()` exposes these bits:

| bit | name                          | meaning                                                                           |
| --: | ----------------------------- | --------------------------------------------------------------------------------- |
|   0 | `ReactiveFlags.Mutable`       | Changes can continue through this node to its dependents.                         |
|   1 | `ReactiveFlags.Watching`      | This node is an effect that should be queued when reached.                        |
|   2 | `ReactiveFlags.RecursedCheck` | The engine is watching for a write that loops back into the callback now running. |
|   3 | `ReactiveFlags.Recursed`      | Such a recursive write reached this node.                                         |
|   4 | `ReactiveFlags.Dirty`         | This node is known to need an update.                                             |
|   5 | `ReactiveFlags.Pending`       | An earlier dependency may require this node to update.                            |
|   6 | `HAS_CHILD_EFFECT` (internal) | This node owns nested effects that require ordered cleanup.                       |

Bits identifying the node type or tracking record recycling are engine-only and are hidden from that object. `ReactiveFlags`, exported by `dalien-signals/system`, names bits 0–5 so integrations do not need to hard-code their numeric values.

Whenever a write could invalidate cached work, the engine increments a global write counter, called the **epoch**. After checking or recalculating a computed, it saves the epoch into the record's stamp — one float64 spanning slots 6–7, read through a `Float64Array` view over the same arena (a 53-bit counter never wraps, and one load-and-compare replaces two). If the saved and current epochs match on the next read, no write that could affect the cache occurred in between, so the value can be returned without walking the graph. If a callback writes another signal during the check, the current epoch advances and the saved value no longer matches.

## Performance details

- One- and two-link updates use dedicated fast paths instead of the general graph traversal. Runs of single-dependency, single-subscriber nodes — chains — walk without the traversal stack: the way back up is recoverable from each node's unique subscriber link.
- A `FinalizationRegistry` tracks when signal or computed functions are GC'd and returns their underlying record memory to a free-list for re-use.
- The lower-level engine's `reset()` method clears the whole arena at once. Functions and numeric IDs created before the reset become invalid.
- `tests/bytecode.spec.ts` enforces V8's 460-bytecode inline limit for hot functions. Large functions are split so the JIT can inline them into callers.

## Build your own framework

`createReactiveSystem` is the graph engine with none of the signal semantics: five raw operations over the arena, allocation, growth, and a set of seams the host fills in. `src/index.ts` — the whole default library — is one client of this surface (`tests/policyBoundary.spec.ts` enforces that it uses nothing else). A host can bring its own semantics:

````ts
import { createReactiveSystem } from "dalien-signals/system";

const sys = createReactiveSystem({
  // Required: the arena's capacity, in records or megabytes (1 MB = 32,768
  // records). maxCapacityRecords / maxCapacityMegabytes cap growth.
  capacityRecords: 1 << 16,

  // Fires at creation and after every growth: capture the arena here. The
  // object is replaced when the arena grows, so hosts re-capture rather
  // than holding fields.
  allocated(arena) {
    // arena.memory: Int32Array — the records themselves
    // arena.versions: Float64Array — the same buffer, for version stamps
    // arena.link(dep, sub, version) / arena.unlink(linkId, sub?)
    // arena.propagate(subsLink, innerWrite) / arena.checkDirty(depsLink, sub)
    // arena.shallowPropagate(subsLink)
    // arena.allocNode(hostBits) / arena.freeNode(id, gen)
  },

  // The walks call this for every stale node: commit whatever "update"
  // means for your kind (dispatch on your own host bits in `flags`) and
  // return whether the value changed — it feeds the equality cut-off.
  update(id, flags) { return true; },

  // An effect needs to run: queue it however you schedule work.
  notify(id, gen) {},

  // A node gained its first subscriber / lost its last one. Connect and
  // disconnect external resources here; `unwatched` also fires for every
  // watched node during reset().
  watched(id) {},
  unwatched(id, state) {},

  // A record went back to the free list: drop anything you keep for it
  // (values, callbacks), or dead objects stay pinned until the id is
  // reused.
  freed(id) {},
});

// Lifetime tiers on the system object:
sys.createNode(owner, hostBits); // automatic: freed when `owner` is GC'd
sys.adoptNode(owner, id);        // tie an already-created id to an owner
sys.allocNode(hostBits);         // manual: pair with disposeNode/freeNode
sys.disposeNode(id, gen?);       // gen-guarded free; stale ids are no-ops
sys.generationOf(id);            // capture at creation to guard stored ids
sys.growCapacity(records);       // immediate when idle, else at the next boundary
sys.reset();                     // rewind the whole arena; every id dies
sys.stats();                     // capacity, live records, free-list depth
````

Node state lives in the arena as 32-byte records of eight `int32` slots — flags, dependency-list head and cursor, subscriber-list head and tail, a generation counter, and a float64 version stamp. Edges are records too. The [live inspector](https://justjake.github.io/dalien-signals/) decodes a real arena, record by record, as you mutate a graph.

`tests/hostPrimitives.spec.ts` is the proof: signal, computed, and effect implemented entirely from this surface — glitch-free diamonds, equality cut-off, batching, re-tracking, implicit stamping — interoperating both directions with the built-ins in one graph, at parity on the benchmark suite.

## Constraints

- The arena grows between operations. Once 3/4 full, the engine and the library's hot tier are rebuilt over an arena twice the size; every record is copied and existing signals keep working. Both rebuilds compile from freshly generated source (`new Function`) so each generation keeps the JIT specialization a repeated closure would lose. Growing **before** a graph is built runs at full speed afterwards; growing under an already-hot graph leaves long-lived callables with mixed call-site feedback, measured at ~1.3x on sustained recompute chains — call `growCapacity()` up front for graphs you expect to be large. Where Content-Security-Policy forbids runtime codegen, growth falls back to plain instantiation: correct, with the same mixed-feedback cost.
- Growth cannot move the arena under a running callback. A single effect or computed callback that allocates past the remaining quarter of the arena throws; `growCapacity()` raises capacity up front for allocation-heavy paths. The default reservation is 64 MB of address space (2,097,152 records); physical memory is consumed only for records that are touched.
- The JavaScript runtime must support `FinalizationRegistry`, which is part of ES2021.
- Across the write-cost crossover matrix (5 shape families x 10 sizes, `benchs/crossover.mjs`, Node 24, Apple M4 Max, 2026-07-07), this arena averages ~11% faster than the original `alien-signals` (geometric mean ratio 0.89) and reaches 1.9-2.9x faster once a write recomputes hundreds of nodes (grid cones bottom out at 0.34x, broad fan-outs at 0.5-0.6x). The remaining upstream edge is a narrow band: single-node and few-node writes run up to ~1.1x this fork's time, and a fixed cone surrounded by idle nodes carries a flat ~10% premium. `benchs/propagateSustained.mjs` and `benchs/memoryUsage.mjs` probe the adjacent regimes.

<img width="1080" alt="Sustained write cost ratio (dalien over alien) by recomputed nodes per write" src="assets/crossover.png" />

The chart divides dalien-signals time by alien-signals time. Values below `1.0` mean dalien-signals was faster; values above `1.0` mean alien-signals was faster.

## Benchmarks

These charts compare JavaScript reactivity libraries with the `sbench`, `kairo`, `cellx`, and `dynamic` workload groups from [js-reactivity-benchmark](https://github.com/milomg/js-reactivity-benchmark). Each table reports elapsed milliseconds; lower is better, and `total` is the sum of those workload groups.

The first two charts run each library in a fresh process, so one library cannot leave compiled code or uncollected objects behind for the next. Each number is the median of four CI rounds; the libraries take turns each round instead of completing all runs in a fixed order. See [run 28848044239](https://github.com/justjake/dalien-signals/actions/runs/28848044239) at `ae1b4ae`; `benchs/ci/` contains the harness and method. On Node, dalien-signals posts the lowest total of every framework measured.

### Node (V8)

<!-- benchmark:node:begin — generated by benchs/ci/pull-run.mjs; edits inside are overwritten -->
<img width="1080" alt="Total benchmark time by framework, Node (V8): Dalien Signals 3,793 ms; Reactively 4,119 ms; Alien Signals 4,224 ms; Preact Signals 4,438 ms" src="assets/benchmark.png" />

<details>
<summary>Node (V8) suite totals (ms, lower is better) — CI run 28848044239 @ ae1b4ae, 2026-07-07</summary>

| framework | sbench | kairo | cellx | dynamic | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dalien Signals | 584 | 958 | 33 | 2219 | 3793 |
| Reactively | 622 | 1224 | 86 | 2186 | 4119 |
| Alien Signals | 695 | 914 | 34 | 2581 | 4224 |
| Preact Signals | 586 | 1000 | 35 | 2817 | 4438 |

<img width="1080" alt="Individual benchmark times, Node (V8), one panel per test" src="assets/benchmark-details.png" />

</details>
<!-- benchmark:node:end -->

### Bun (JavaScriptCore)

Bun's JavaScriptCore currently runs this library well behind alien-signals (the engine work above is tuned against V8, and the current host structure regressed JSC from the previous release, which beat alien-signals under Bun at 0.84x). Treat the Bun numbers as a known issue under active investigation rather than a stable property.

<!-- benchmark:bun:begin — generated by benchs/ci/pull-run.mjs; edits inside are overwritten -->
<img width="1080" alt="Total benchmark time by framework, Bun (JavaScriptCore): Reactively 3,730 ms; Alien Signals 4,298 ms; Preact Signals 4,378 ms; Dalien Signals 6,469 ms" src="assets/benchmark-bun.png" />

<details>
<summary>Bun (JavaScriptCore) suite totals (ms, lower is better) — CI run 28848044239 @ ae1b4ae, 2026-07-07</summary>

| framework | sbench | kairo | cellx | dynamic | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reactively | 504 | 1205 | 78 | 1943 | 3730 |
| Alien Signals | 688 | 772 | 48 | 2790 | 4298 |
| Preact Signals | 665 | 716 | 41 | 2956 | 4378 |
| Dalien Signals | 2679 | 1031 | 134 | 2625 | 6469 |

<img width="1080" alt="Individual benchmark times, Bun (JavaScriptCore), one panel per test" src="assets/benchmark-details-bun.png" />

</details>
<!-- benchmark:bun:end -->

The final chart uses another [js-reactivity-benchmark fork](https://github.com/transitive-bullshit/js-reactivity-benchmark) that runs every library in one Node process. Its result depends on run order because each library inherits compiled code and allocated objects left by earlier libraries. Its graph-creation tests also force JavaScript garbage collection (GC) inside the timed region. Treat it as a different workload, not a direct comparison with the isolated charts. Here, `alien-signals` means the old `1.0.0-alpha.1` version pinned by that benchmark; `alien-signals v3.2.1` is the version dalien-signals follows. Node 24, Apple M4 Max, 2026-07-06; raw data is in `benchs/results/`.

<!-- benchmark:tb:begin — generated by benchs/ci/pull-run.mjs; edits inside are overwritten -->
<img width="1080" alt="Total benchmark time by framework, shared process: alien-signals 1.0.0-alpha.1 1,674 ms; alien-signals v3.2.1 1,906 ms; dalien-signals 2,598 ms; @reactively 3,007 ms; Svelte v5 3,325 ms; s-js 3,788 ms; @amadeus-it-group/tansu 3,998 ms; Oby 4,125 ms; $mol_wire 4,232 ms; uSignal 4,990 ms; Preact Signals 5,074 ms; SolidJS 5,497 ms; MobX 7,165 ms; Signia 7,409 ms; @vue/reactivity 8,145 ms; TC39 Signals Polyfill 17,597 ms; @angular/signals 21,544 ms" src="assets/benchmark-tb.png" />

<details>
<summary>Suite totals (ms, lower is better)</summary>

| framework                   | sbench | kairo | dynamic | total |
| --------------------------- | -----: | ----: | ------: | ----: |
| alien-signals 1.0.0-alpha.1 |     32 |   907 |     735 |  1674 |
| alien-signals v3.2.1        |     50 |   985 |     871 |  1906 |
| dalien-signals              |    551 |  1106 |     941 |  2598 |
| @reactively                 |    673 |  1336 |     999 |  3007 |
| Svelte v5                   |    651 |  1561 |    1113 |  3325 |
| s-js                        |    778 |  1539 |    1471 |  3788 |
| @amadeus-it-group/tansu     |    713 |  1845 |    1440 |  3998 |
| Oby                         |    863 |  1789 |    1472 |  4125 |
| $mol_wire                   |    688 |  2085 |    1459 |  4232 |
| uSignal                     |    688 |  2390 |    1912 |  4990 |
| Preact Signals              |    665 |  1108 |    3301 |  5074 |
| SolidJS                     |    840 |  2097 |    2559 |  5497 |
| MobX                        |    737 |  3578 |    2850 |  7165 |
| Signia                      |    699 |  1792 |    4917 |  7409 |
| @vue/reactivity             |    709 |  1873 |    5563 |  8145 |
| TC39 Signals Polyfill       |    771 |  3296 |   13530 | 17597 |
| @angular/signals            |    715 |  2437 |   18392 | 21544 |

<img width="1080" alt="Individual benchmark times, shared process, one panel per test" src="assets/benchmark-details-tb.png" />

</details>
<!-- benchmark:tb:end -->

## Origin

The [alien-signals][] repository contains the original algorithm history, ports, and related projects.

[alien-signals]: https://github.com/stackblitz/alien-signals
[tc39]: https://github.com/tc39/proposal-signals
[arena-wikipedia]: https://en.wikipedia.org/wiki/Region-based_memory_management
