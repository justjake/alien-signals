// The actual milomg-fork framework adapters, imported straight from the
// harness source (Vite transforms the TypeScript). The same adapter code
// the CI benchmarks run — no example-local re-implementations.
//
// Every key is selectable in the field demo's library bar. One special
// case: makeRuntime routes the 'dalien-signals' key to dalien's native
// integer-id tier instead of this adapter object; the benchmark worker
// still runs the adapter itself.
import { alienFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/alienSignals.ts';
import { angularFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/angularSignals2.ts';
import { anodFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/anod.ts';
import { cosignalFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/cosignal.ts';
import { dalienMallocFreeFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/dalienMallocFree.ts';
import { dalienFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/dalienSignals.ts';
import { molWireFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/molWire.ts';
import { potaFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/pota.ts';
import { preactSignalFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/preactSignals.ts';
import { reactivelyFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/reactively.ts';
import { solidFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/solid.ts';
import { solid2Framework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/solid2.ts';
import { svelteFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/svelte.ts';
import { tansuFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/tansu.ts';
import { tanstackStoreFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/tanstackStore.ts';
import { tc39SignalsFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/tc39signals.ts';
import { tldrawStateFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/tldrawState.ts';
import { xReactivityFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/xReactivity.ts';

export const FRAMEWORKS = {
	// the four the in-page benchmark section runs (bench.js keys — fixed)
	'dalien-signals': dalienFramework,
	'alien-signals': alienFramework,
	'@preact/signals-core': preactSignalFramework,
	'@reactively/core': reactivelyFramework,
	// the rest of the fork's active adapters, field-demo only.
	// Two carry known field-demo caveats: mol-wire's effect atoms never run
	// without a pull (main.js keeps it out of the selector), and
	// tc39-signals disposes slowly — the polyfill's Watcher.unwatch scans
	// every watched producer per call, so freeing the field's ~180k render
	// effects is quadratic (~55 s frozen tab at 320p when switching away).
	'dalien-malloc-free': dalienMallocFreeFramework,
	'angular-signals': angularFramework,
	'anod': anodFramework,
	'cosignal': cosignalFramework,
	'mol-wire': molWireFramework,
	'pota': potaFramework,
	'solid': solidFramework,
	'solid-2': solid2Framework,
	'svelte': svelteFramework,
	'tansu': tansuFramework,
	'tanstack-store': tanstackStoreFramework,
	'tc39-signals': tc39SignalsFramework,
	'tldraw-state': tldrawStateFramework,
	'x-reactivity': xReactivityFramework,
};
