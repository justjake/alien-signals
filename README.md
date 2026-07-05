<p align="center">
	<img src="assets/logo.png" width="250"><br>
<p>

<p align="center">
	<a href="https://npmjs.com/package/dalien-signals"><img src="https://badgen.net/npm/v/dalien-signals" alt="npm package"></a>
	<a href="https://deepwiki.com/justjake/dalien-signals"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

# dalien-signals

dalien-signals is a fork of [alien-signals](https://github.com/stackblitz/alien-signals) with a data-oriented memory layout. It runs the same push-pull algorithm and passes the same test suite, but the dependency graph lives in a single `Int32Array` instead of linked objects: nodes and edges are fixed-size integer records, values and callbacks sit in plain side arrays, and propagation walks preallocated stacks instead of allocating cons cells. Tracking, propagation, and dependency cleanup allocate no GC objects.

The layout trades update latency for throughput and memory. The crossover follows the size of each update's recompute set — not the size of the graph: a 120,000-node graph written eleven nodes at a time performs within ~3% of upstream, because every write-path cost (index arithmetic, upstream's traversal allocations, cache footprint) scales with what the update touches.

- Writes that recompute a handful of nodes run ~20% slower than upstream; from tens to a few hundred nodes per update the gap is 4–8%. Typed-array index arithmetic costs more per access than object field loads, and small updates give the allocation-free design little to win back.
- From roughly a thousand nodes per update dalien-signals pulls 30–50% ahead, and at ten thousand it is 2.2× faster; the sustained-write geomean across the whole shape matrix is 14% faster: upstream allocates traversal cells on every update (a GC tax that grows with recompute depth) and its object graph outgrows cache long before the packed records do (`benchs/propagateSustained.mjs`).
- 10,000 live effects retain ~47% less heap and a 100×100 computed/effect grid ~16% less; creating 10,000 signal→computed→effect rows is at parity. Signal and computed handles carry a FinalizationRegistry cell for reclamation, which costs them retained-heap parity — `reclaimHandles: false` removes it (`benchs/memoryUsage.mjs`).

The record store is allocated on first use, so importing the package costs nothing. It has a fixed capacity — the default reservation is 2^23 records (256 MB of lazily-mapped virtual pages; physical memory tracks records actually touched), sized with `configure({ initialRecords })` — because a plane that never moves is what lets every handle capture the buffer directly instead of paying an indirection per operation. Records of garbage-collected signal/computed handles are reclaimed through a `FinalizationRegistry`, like upstream's GC-visible graph reclaims its nodes; `configure({ reclaimHandles: false })` trades that safety for cheaper handle churn (dropped handles then leak a 32-byte record and their last value, never their closures). The `dalien-signals/system` entry point is a different, incompatible interface in this fork: rather than `createReactiveSystem(callbacks)` over user-provided node objects, it returns a self-contained engine over integer handles. The package root exports are unchanged, except that `getActiveSub()` returns a view object rather than the raw node (its `flags` stay readable and writable) and handle function names lose their `bound ` prefix (`isSignal` and friends still work).

Below is the [js-reactivity-benchmark](https://github.com/milomg/js-reactivity-benchmark) suite (sbench, kairo, cellx, dynamic), each framework in its own Node process, fastest-of-N per test. This estimator rewards small-update latency — the regime upstream is best at — and the fork still lands within 11% of upstream overall, tied with Preact Signals and ahead of the rest; the throughput and memory wins above are not visible in it. Reactively is omitted (stack overflow in its recursive update on deep graphs). Node 24, Apple M4 Max, 2026-07-05; raw data in `benchs/results/`.

<img width="1080" alt="Total benchmark time by framework: Alien Signals 1,999 ms; Dalien Signals 2,219 ms; Preact Signals 2,222 ms; s-js 2,971 ms; Vue 3,058 ms; Svelte v5 3,299 ms; tansu 3,712 ms; Pota 3,761 ms; Angular Signals 4,138 ms; SolidJS 4,519 ms; x-reactivity 5,556 ms; MobX 8,084 ms; Compostate 10,143 ms" src="assets/benchmark.png" />

<details>
<summary>Suite totals (ms, lower is better)</summary>

| framework | sbench | kairo | cellx | dynamic | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Alien Signals | 333 | 430 | 16 | 1220 | 1999 |
| Dalien Signals | 353 | 531 | 16 | 1319 | 2219 |
| Preact Signals | 237 | 461 | 15 | 1510 | 2222 |
| s-js | 362 | 672 | 24 | 1913 | 2971 |
| Vue | 453 | 706 | 51 | 1848 | 3058 |
| Svelte v5 | 594 | 863 | 23 | 1819 | 3299 |
| amadeus-it-group/tansu | 1080 | 857 | 80 | 1695 | 3712 |
| Pota | 628 | 916 | 80 | 2137 | 3761 |
| Angular Signals | 702 | 817 | 69 | 2549 | 4138 |
| SolidJS | 604 | 970 | 46 | 2899 | 4519 |
| x-reactivity | 1151 | 1246 | 48 | 3111 | 5556 |
| MobX | 1797 | 1873 | 107 | 4307 | 8084 |
| Compostate | 1118 | 1683 | 96 | 7246 | 10143 |

</details>

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
