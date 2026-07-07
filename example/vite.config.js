// The benchmark worker imports the milomg fork's suites and adapters from
// harness source (../../../../milomg-reactivity-benchmark). Those adapter
// files import their libraries by bare specifier, which would resolve up
// the FORK's directory chain — alias them (exact matches, subpaths first)
// to this example's own installed copies so the demo, the selector, and
// the benchmarks all run identical library builds, locally and in CI.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const fork = (p) => here(`../../../milomg-reactivity-benchmark/node_modules/.pnpm/${p}`);

export default defineConfig({
	// Two versions of @solidjs/signals are in play: the x-reactivity adapter
	// uses 0.10.2, while solid-js 2 beta ships against its own matching
	// beta (0.10.2 lacks exports the beta build imports, e.g.
	// clearSnapshots). Prebundling would collapse both onto one copy and
	// break the dev server; excluded, each importer resolves its own copy
	// by real path. The production build already resolves per-importer.
	optimizeDeps: {
		exclude: ['@solidjs/signals'],
	},
	resolve: {
		alias: [
			{ find: /^dalien-signals\/system$/, replacement: here('../esm/system.mjs') },
			{ find: /^dalien-signals$/, replacement: here('../esm/index.mjs') },
			{ find: /^alien-signals\/esm$/, replacement: here('./node_modules/alien-signals/esm/index.mjs') },
			{ find: /^alien-signals$/, replacement: here('./node_modules/alien-signals/esm/index.mjs') },
			{ find: /^@preact\/signals-core$/, replacement: here('./node_modules/@preact/signals-core/dist/signals-core.mjs') },
			// the pinned harness's adapter imports the React-flavoured package name;
			// signals-core exports the same signal/computed/effect/batch surface
			{ find: /^@preact\/signals$/, replacement: here('./node_modules/@preact/signals-core/dist/signals-core.mjs') },
			{ find: /^@reactively\/core$/, replacement: here('./node_modules/@reactively/core/dist/core.js') },
			// Three adapter dependencies live only in the fork's pnpm store —
			// no workspace package there declares them, so nothing links them
			// into a node_modules the resolver walks. Point their specifiers
			// at the store entries directly; each entry keeps its own
			// dependencies as sibling links, so transitive imports (rxjs,
			// @tldraw/utils) still resolve.
			{ find: /^anod$/, replacement: fork('anod@0.9.1/node_modules/anod/dist/index.js') },
			{ find: /^@tldraw\/state$/, replacement: fork('@tldraw+state@5.2.2/node_modules/@tldraw/state/dist-esm/index.mjs') },
			// the solid2 adapter imports this build by a relative path that
			// only exists in the store
			{ find: /^(\.\.\/)+node_modules\/solid-js-2\/dist\/solid\.js$/, replacement: fork('solid-js@2.0.0-beta.15/node_modules/solid-js/dist/solid.js') },
		],
	},
});
