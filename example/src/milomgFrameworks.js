// The actual milomg-fork framework adapters, imported straight from the
// harness source (Vite transforms the TypeScript). The same adapter code
// CI benchmarks run — no example-local re-implementations.
import { dalienFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/dalienSignals.ts';
import { alienFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/alienSignals.ts';
import { preactSignalFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/preactSignals.ts';
import { reactivelyFramework } from '../../../../milomg-reactivity-benchmark/packages/core/src/frameworks/reactively.ts';

export const FRAMEWORKS = {
	'dalien-signals': dalienFramework,
	'alien-signals': alienFramework,
	'@preact/signals-core': preactSignalFramework,
	'@reactively/core': reactivelyFramework,
};
