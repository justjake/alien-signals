<p align="center">
	<img src="assets/logo.png" width="250"><br>
<p>

<p align="center">
	<a href="https://npmjs.com/package/dalien-signals"><img src="https://badgen.net/npm/v/dalien-signals" alt="npm package"></a>
	<a href="https://deepwiki.com/justjake/dalien-signals"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

# dalien-signals

dalien-signals is a fork of [alien-signals](https://github.com/stackblitz/alien-signals) with a data-oriented core: the dependency graph lives in one `Int32Array` — nodes and edges are 32-byte integer records, values and callbacks sit in side arrays — traversal uses preallocated stacks, and graph maintenance allocates no GC objects. The algorithm and the package-root API are upstream's; all 179 conformance cases pass.

What changes in practice:

- **Throughput over micro-latency, mixed workloads over single hot loops.** In a dedicated loop over one small graph — the regime microbenchmarks love and the JIT optimizes hardest — upstream leads: sustained small-update writes run 1.15–1.45× upstream's time, and the nine-shape write matrix (`benchs/propagateSustained.mjs`, run against upstream) averages ~9% behind. The picture inverts as work grows or mixes: updates recomputing thousands of nodes run 1.4–1.6× faster, and in the benchmark suites below — mixed workloads, closer to applications — this fork wins all nine kairo propagation tests under Node (1.1–2.7× faster; eight of nine under Bun) — and kairo's graphs are built at 10–1,000 nodes, the size range of most application state and finishes first overall on both runtimes. Part of the hot-loop cost is deliberate: the engine pre-seeds its callback call sites past the JIT's speculation threshold (`benchs/phaseTransition.mjs`), trading a little single-shape speed for performance that stays flat as an application's callback shapes diversify. For scale: in the suite's closest test to a typical interactive app (a small layered graph, one atom written per update), the difference is ~20 nanoseconds per update — imperceptible for any library in the top half of the chart. At that scale the differentiators are the tails: burst updates (document loads, sync patches, undo), heap size and GC churn over a long session, and behavior that does not degrade as the app grows.
- **Reads of clean computeds skip re-verification.** A global write epoch stamps every verified computed; while nothing has been written, re-reading costs one compare against the node's own record instead of a dependency re-check. A single clean read is about a nanosecond slower than upstream's flag check, but when many derived reads follow each write — the shape of the dynamic suite below — the stamps carry the win.
- **Leak-free by construction.** Dropped signal/computed handles reclaim their records through a required `FinalizationRegistry` (ES2021), and getters are owned by their handles — the engine borrows them only while the computed is subscribed, so no internal table can pin user closures. 10,000 live effects retain ~47% less heap than upstream; signals pay about one registry cell each, and computeds join the registry only once first evaluated, so computeds that are created but never read cost nothing.
- **Fixed-capacity store, allocated on first use.** `configure({ initialRecords })` sizes it before first use (default 2^23 records ≈ 256 MB of lazily-mapped virtual pages; physical memory tracks records actually touched). The plane never grows or moves — that is what lets handles reach the graph with zero indirection.
- **Generation lifecycle.** `system.reset()` tears down an entire generation in one sweep: it rewinds the record plane and replaces the finalization registry, so a dead generation costs the garbage collector a few large objects instead of one weak cell per handle. Request-scoped graphs, worker pools, and benchmark harnesses want exactly this; every handle minted before a reset is invalid afterwards.
- **`dalien-signals/system` is a new, incompatible interface** (a self-contained engine over integer handles). The package root is drop-in, except `getActiveSub()` returns a flags view object and handle functions are anonymous (`isSignal` and friends still work).

The crossover between this fork and upstream is governed by one variable: **how many nodes a single write recomputes**. It is not the number of atoms written per batch (thirty thousand tiny writes per flush never cross — each write's small wave pays upstream's favorite price every time), and not graph size (a fixed cone surrounded by thirty thousand idle nodes holds a constant ratio). One write fanning out to a few hundred nodes is where record iteration overtakes object traversal: ~300 nodes for wide fan-outs, ~500 for mixed shapes, deepening to 2.3× faster at ten-thousand-node cones. Pure depth is the weakest axis — a single chain is pointer-chasing for both sides, and upstream's objects are allocated in chain order too.

<img width="1080" alt="Sustained write cost ratio (dalien over alien) against nodes recomputed per write, five shape families: broad and grid cross below 1.0 near 300-1000 nodes; batch and islands stay flat above 1.0; deep dips at 1000 then recovers" src="assets/crossover.png" />

Below is the [js-reactivity-benchmark](https://github.com/milomg/js-reactivity-benchmark) suite (sbench, kairo, cellx, dynamic) under both JavaScript engines. Methodology: each framework runs in its own process; each test reports the median of its runs (upstream reports the fastest run, which hides amortized costs — collection of what a run allocated, deoptimization recovery, finalizer processing); frameworks run interleaved round-robin for three rounds and each test's final time is the median across rounds, which cancels machine drift. The dalien adapter uses `reset()` between tests — the arena equivalent of the wholesale collection a dead GC-managed graph gets automatically. Apple M4 Max, 2026-07-05; raw data in `benchs/results/`; the same harness runs in CI on every push (`benchs/ci/`).

**Node 24 (V8)** — dalien-signals finishes first overall, 16% less total time than upstream:

<!-- benchmark:node:begin — generated by benchs/ci/pull-run.mjs; edits inside are overwritten -->
<img width="1080" alt="Total benchmark time by framework, Node 24: Dalien Signals 3,199 ms; Vue 3,388 ms; Reactively 3,406 ms; Svelte v5 3,479 ms; Alien Signals 3,831 ms; Pota 3,941 ms; s-js 3,949 ms; Preact Signals 3,957 ms; tansu 4,126 ms; x-reactivity 5,956 ms; Angular Signals 6,505 ms; SolidJS 7,565 ms; MobX 10,847 ms; Compostate 15,445 ms" src="assets/benchmark.png" />

<details>
<summary>Node suite totals (ms, lower is better)</summary>

| framework | sbench | kairo | cellx | dynamic | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dalien Signals | 354 | 481 | 21 | 2342 | 3199 |
| Vue | 475 | 708 | 57 | 2149 | 3388 |
| Reactively | 336 | 1066 | 107 | 1896 | 3406 |
| Svelte v5 | 640 | 907 | 27 | 1905 | 3479 |
| Alien Signals | 340 | 877 | 35 | 2579 | 3831 |
| Pota | 796 | 973 | 68 | 2105 | 3941 |
| s-js | 384 | 1156 | 46 | 2364 | 3949 |
| Preact Signals | 293 | 668 | 59 | 2937 | 3957 |
| amadeus-it-group/tansu | 1320 | 884 | 102 | 1821 | 4126 |
| x-reactivity | 1358 | 1318 | 52 | 3228 | 5956 |
| Angular Signals | 1453 | 1476 | 68 | 3508 | 6505 |
| SolidJS | 1368 | 1342 | 62 | 4794 | 7565 |
| MobX | 1744 | 1871 | 227 | 7005 | 10847 |
| Compostate | 2341 | 2415 | 110 | 10579 | 15445 |

Reactively crashed one of its three rounds mid-suite (a known flake), so its dynamic-suite entries are medians of two rounds.

<img width="1080" alt="Individual benchmark times under Node, one panel per test" src="assets/benchmark-details.png" />

</details>
<!-- benchmark:node:end -->

**Bun 1.3 (JavaScriptCore)** — first overall again, 20% less total time than upstream:

<!-- benchmark:bun:begin — generated by benchs/ci/pull-run.mjs; edits inside are overwritten -->
<img width="1080" alt="Total benchmark time by framework, Bun 1.3: Dalien Signals 1,557 ms; Reactively 1,690 ms; Alien Signals 1,935 ms; Preact Signals 2,208 ms; s-js 2,218 ms; Vue 2,499 ms; Angular Signals 3,140 ms; Svelte v5 3,272 ms; Pota 3,766 ms; tansu 4,059 ms; SolidJS 4,555 ms; x-reactivity 4,683 ms; MobX 5,869 ms; Compostate 12,498 ms" src="assets/benchmark-bun.png" />

<details>
<summary>Bun suite totals (ms, lower is better)</summary>

| framework | sbench | kairo | cellx | dynamic | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dalien Signals | 253 | 302 | 15 | 986 | 1557 |
| Reactively | 227 | 555 | 30 | 879 | 1690 |
| Alien Signals | 347 | 362 | 19 | 1207 | 1935 |
| Preact Signals | 327 | 335 | 17 | 1531 | 2208 |
| s-js | 273 | 451 | 22 | 1472 | 2218 |
| Vue | 385 | 453 | 41 | 1620 | 2499 |
| Angular Signals | 725 | 591 | 67 | 1757 | 3140 |
| Svelte v5 | 501 | 695 | 19 | 2056 | 3272 |
| Pota | 460 | 944 | 56 | 2306 | 3766 |
| amadeus-it-group/tansu | 1205 | 801 | 91 | 1962 | 4059 |
| SolidJS | 556 | 847 | 49 | 3102 | 4555 |
| x-reactivity | 1039 | 989 | 41 | 2614 | 4683 |
| MobX | 1001 | 1331 | 99 | 3438 | 5869 |
| Compostate | 924 | 1442 | 91 | 10040 | 12498 |

<img width="1080" alt="Individual benchmark times under Bun, one panel per test" src="assets/benchmark-details-bun.png" />

</details>
<!-- benchmark:bun:end -->

The [transitive-bullshit fork](https://github.com/transitive-bullshit/js-reactivity-benchmark) of the same suite runs every framework in one shared Node process — the methodology behind the upstream alien-signals chart further down. `alien-signals` here is the 1.0.0-alpha.1 that repo pins; `alien-signals-v3` is the v3.2.1 this fork tracks. Read it with two caveats: shared-process totals are order-sensitive (each framework inherits the JIT and heap state of whatever ran before it — in our testing, reordering frameworks changed relative results materially), and its creation tests end their timed region with a forced full GC over ~100k just-abandoned nodes, which bills dalien-signals' `FinalizationRegistry` cells inside the timing while upstream's dead nodes are ordinary garbage. That one suite accounts for most of the gap to upstream below. Node 24, Apple M4 Max, 2026-07-05; raw data in `benchs/results/`.

<!-- benchmark:tb:begin — generated by benchs/ci/pull-run.mjs; edits inside are overwritten -->
<img width="1080" alt="Total benchmark time by framework, shared process: alien-signals 1,729 ms; alien-signals-v3 1,937 ms; dalien-signals 2,653 ms; @reactively 2,978 ms; Svelte v5 3,246 ms; s-js 3,750 ms; tansu 3,911 ms; Oby 4,049 ms; $mol_wire 4,224 ms; Preact Signals 4,885 ms; uSignal 5,013 ms; SolidJS 5,598 ms; MobX 7,123 ms; Signia 7,579 ms; @vue/reactivity 8,609 ms; TC39 Signals Polyfill 17,165 ms; @angular/signals 20,360 ms" src="assets/benchmark-tb.png" />

<details>
<summary>Suite totals (ms, lower is better)</summary>

| framework | sbench | kairo | dynamic | total |
| --- | ---: | ---: | ---: | ---: |
| alien-signals 1.0.0-alpha.1 | 37 | 920 | 771 | 1729 |
| alien-signals v3.2.1 | 54 | 996 | 887 | 1937 |
| dalien-signals | 556 | 1124 | 973 | 2653 |
| @reactively | 664 | 1326 | 987 | 2978 |
| Svelte v5 | 640 | 1498 | 1109 | 3246 |
| s-js | 774 | 1517 | 1459 | 3750 |
| @amadeus-it-group/tansu | 697 | 1802 | 1412 | 3911 |
| Oby | 836 | 1813 | 1401 | 4049 |
| $mol_wire | 677 | 2126 | 1422 | 4224 |
| Preact Signals | 656 | 1122 | 3108 | 4885 |
| uSignal | 670 | 2408 | 1935 | 5013 |
| SolidJS | 855 | 2159 | 2584 | 5598 |
| MobX | 725 | 3597 | 2801 | 7123 |
| Signia | 714 | 1846 | 5019 | 7579 |
| @vue/reactivity | 691 | 1866 | 6051 | 8609 |
| TC39 Signals Polyfill | 761 | 3281 | 13123 | 17165 |
| @angular/signals | 694 | 2462 | 17204 | 20360 |

<img width="1080" alt="Individual benchmark times, shared process, one panel per test" src="assets/benchmark-details-tb.png" />

</details>
<!-- benchmark:tb:end -->

---

`alien-signals` explores a push-pull based signal algorithm. The implementation is related to the following frontend projects:

- Propagation algorithm of Vue 3
- Preact’s double-linked-list approach (https://preactjs.com/blog/signal-boosting/)
- Inner effects scheduling of Svelte
- Graph-coloring approach of Reactively (https://milomg.dev/2022-12-01/reactivity)

We impose some constraints (such as not using Array/Set/Map and disallowing function recursion in [the algorithmic core](https://github.com/stackblitz/alien-signals/blob/master/src/system.ts)) to ensure performance. We found that under these conditions, maintaining algorithmic simplicity offers more significant improvements than complex scheduling strategies.

I wrote the reactivity code for both Vue and alien-signals. Below is a benchmark comparison against Vue 3.4 and other frameworks. The core algorithm has since been [ported back to Vue 3.6](https://github.com/vuejs/core/pull/12349).

<img width="1210" alt="Image" src="https://github.com/user-attachments/assets/88448f6d-4034-4389-89aa-9edf3da77254" />

> Benchmark repo: https://github.com/transitive-bullshit/js-reactivity-benchmark

## Background

I spent considerable time [optimizing Vue 3.4’s reactivity system](https://github.com/vuejs/core/pull/5912), gaining experience along the way. Since Vue 3.5 [switched to a pull-based algorithm similar to Preact](https://github.com/vuejs/core/pull/10397), I decided to continue researching a push-pull based implementation in a separate project. The algorithm is used in Vue language tools for incremental AST parsing and virtual code generation.

## Other Language Implementations

- **Dart:** [medz/alien-signals-dart](https://github.com/medz/alien-signals-dart)
- **Dart:** [void-signals/void_signals](https://github.com/void-signals/void_signals)
- **Lua:** [YanqingXu/alien-signals-in-lua](https://github.com/YanqingXu/alien-signals-in-lua)
- **Lua 5.4:** [xuhuanzy/alien-signals-lua](https://github.com/xuhuanzy/alien-signals-lua)
- **Luau:** [Nicell/alien-signals-luau](https://github.com/Nicell/alien-signals-luau)
- **Java:** [CTRL-Neo-Studios/java-alien-signals](https://github.com/CTRL-Neo-Studios/java-alien-signals)
- **C#:** [CTRL-Neo-Studios/csharp-alien-signals](https://github.com/CTRL-Neo-Studios/csharp-alien-signals)
- **Go:** [delaneyj/alien-signals-go](https://github.com/delaneyj/alien-signals-go)
- **Rust:** [wuzekang/samara-signals](https://github.com/wuzekang/samara/tree/main/crates/signals)
- **Rust:** [ohkami-rs/alien-signals-rs](https://github.com/ohkami-rs/alien-signals-rs)

## Derived Projects

- [Rajaniraiyn/react-alien-signals](https://github.com/Rajaniraiyn/react-alien-signals): React bindings for the alien-signals API
- [CCherry07/alien-deepsignals](https://github.com/CCherry07/alien-deepsignals): Use alien-signals with the interface of a plain JavaScript object
- [hunghg255/reactjs-signal](https://github.com/hunghg255/reactjs-signal): Share Store State with Signal Pattern
- [gn8-ai/universe-alien-signals](https://github.com/gn8-ai/universe-alien-signals): Enables simple use of the Alien Signals state management system in modern frontend frameworks
- [WebReflection/alien-signals](https://github.com/WebReflection/alien-signals): Preact signals like API and a class based approach for easy brand check
- [@lift-html/alien](https://github.com/JLarky/lift-html/tree/main/packages/alien): Integrating alien-signals into lift-html
- [ilha](https://github.com/ilhajs/ilha): A tiny web UI library built around the islands architecture
- [@sigrea/core](https://github.com/sigrea/core): Signals, deep reactivity, and molecule lifecycles built on alien-signals
- [@lazy-promise/alien-signals](https://github.com/lazy-promise/lazy-promise/tree/main/packages/alien-signals): Async signals built on top of alien-signals and LazyPromise

## Adoption

- [vuejs/core](https://github.com/vuejs/core): The core algorithm has been ported to v3.6 (PR: https://github.com/vuejs/core/pull/12349)
- [statelyai/xstate](https://github.com/statelyai/xstate): The core algorithm has been ported to implement the atom architecture (PR: https://github.com/statelyai/xstate/pull/5250)
- [flamrdevs/xignal](https://github.com/flamrdevs/xignal): Infrastructure for the reactive system
- [vuejs/language-tools](https://github.com/vuejs/language-tools): Used in the language-core package for virtual code generation
- [unuse](https://github.com/un-ts/unuse): A framework-agnostic `use` library inspired by `VueUse`

## Usage

#### Basic APIs

```ts
import { signal, computed, effect } from "alien-signals";

const count = signal(1);
const doubleCount = computed(() => count() * 2);

effect(() => {
  console.log(`Count is: ${count()}`);
}); // Console: Count is: 1

console.log(doubleCount()); // 2

count(2); // Console: Count is: 2

console.log(doubleCount()); // 4
```

#### Effect Scope

```ts
import { signal, effect, effectScope } from "alien-signals";

const count = signal(1);

const stopScope = effectScope(() => {
  effect(() => {
    console.log(`Count in scope: ${count()}`);
  }); // Console: Count in scope: 1
});

count(2); // Console: Count in scope: 2

stopScope();

count(3); // No console output
```

#### Nested Effects

Effects can be nested inside other effects. When the outer effect re-runs, inner effects from the previous run are automatically cleaned up, and new inner effects are created if needed. The system ensures proper execution order — outer effects always run before their inner effects:

```ts
import { signal, effect } from "alien-signals";

const show = signal(true);
const count = signal(1);

effect(() => {
  if (show()) {
    // This inner effect is created when show() is true
    effect(() => {
      console.log(`Count is: ${count()}`);
    });
  }
}); // Console: Count is: 1

count(2); // Console: Count is: 2

// When show becomes false, the inner effect is cleaned up
show(false); // No output

count(3); // No output (inner effect no longer exists)
```

#### Manual Triggering

The `trigger()` function allows you to manually trigger updates for downstream dependencies when you've directly mutated a signal's value without using the signal setter:

```ts
import { signal, computed, trigger } from "alien-signals";

const arr = signal<number[]>([]);
const length = computed(() => arr().length);

console.log(length()); // 0

// Direct mutation doesn't automatically trigger updates
arr().push(1);
console.log(length()); // Still 0

// Manually trigger updates
trigger(arr);
console.log(length()); // 1
```

You can also trigger multiple signals at once:

```ts
import { signal, computed, trigger } from "alien-signals";

const src1 = signal<number[]>([]);
const src2 = signal<number[]>([]);
const total = computed(() => src1().length + src2().length);

src1().push(1);
src2().push(2);

trigger(() => {
  src1();
  src2();
});

console.log(total()); // 2
```

#### Creating Your Own Surface API

You can reuse alien-signals’ core algorithm via `createReactiveSystem()` to build your own signal API. For implementation examples, see:

- [Starter template](https://github.com/johnsoncodehk/alien-signals-starter) (implements `.get()` & `.set()` methods like the [Signals proposal](https://github.com/tc39/proposal-signals))
- [stackblitz/alien-signals/src/index.ts](https://github.com/stackblitz/alien-signals/blob/master/src/index.ts)
- [proposal-signals/signal-polyfill#44](https://github.com/proposal-signals/signal-polyfill/pull/44)

## About `propagate` and `checkDirty` functions

The actual implementations of `propagate` and `checkDirty` in [system.ts](https://github.com/stackblitz/alien-signals/blob/master/src/system.ts) replace recursive calls with iterative stack-based traversal for performance. The recursive versions below are equivalent and easier to follow — useful as a reference when porting to other languages where the iterative optimization may not help.

<details>
<summary><code>propagate</code></summary>

```ts
function propagate(link: Link, innerWrite: boolean): void {
  do {
    const sub = link.sub;

    let flags = sub.flags;

    if (
      !(
        flags &
        (ReactiveFlags.RecursedCheck |
          ReactiveFlags.Recursed |
          ReactiveFlags.Dirty |
          ReactiveFlags.Pending)
      )
    ) {
      sub.flags = flags | ReactiveFlags.Pending;
      if (innerWrite) {
        sub.flags |= ReactiveFlags.Recursed;
      }
    } else if (
      !(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))
    ) {
      flags = ReactiveFlags.None;
    } else if (!(flags & ReactiveFlags.RecursedCheck)) {
      sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending;
    } else if (
      !(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) &&
      isValidLink(link, sub)
    ) {
      sub.flags = flags | ReactiveFlags.Recursed | ReactiveFlags.Pending;
      flags &= ReactiveFlags.Mutable;
    } else {
      flags = ReactiveFlags.None;
    }

    if (flags & ReactiveFlags.Watching) {
      notify(sub);
    }

    if (flags & ReactiveFlags.Mutable) {
      const subSubs = sub.subs;
      if (subSubs !== undefined) {
        propagate(subSubs, innerWrite);
      }
    }

    link = link.nextSub!;
  } while (link !== undefined);
}
```

</details>

<details>
<summary><code>checkDirty</code></summary>

```ts
function checkDirty(link: Link, sub: ReactiveNode): boolean {
  do {
    const dep = link.dep;
    const depFlags = dep.flags;

    if (sub.flags & ReactiveFlags.Dirty) {
      return true;
    } else if (
      (depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) ===
      (ReactiveFlags.Mutable | ReactiveFlags.Dirty)
    ) {
      if (update(dep)) {
        const subs = dep.subs!;
        if (subs.nextSub !== undefined) {
          shallowPropagate(subs);
        }
        return true;
      }
    } else if (
      (depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) ===
      (ReactiveFlags.Mutable | ReactiveFlags.Pending)
    ) {
      if (checkDirty(dep.deps!, dep)) {
        if (update(dep)) {
          const subs = dep.subs!;
          if (subs.nextSub !== undefined) {
            shallowPropagate(subs);
          }
          return true;
        }
      } else {
        dep.flags = depFlags & ~ReactiveFlags.Pending;
      }
    }

    link = link.nextDep!;
  } while (link !== undefined);

  return false;
}
```

</details>
