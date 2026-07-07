// The benchmark worker imports the milomg fork's suites and adapters from
// harness source (../../../../milomg-reactivity-benchmark). Those adapter
// files import their libraries by bare specifier, which would resolve up
// the FORK's directory chain — alias them (exact matches, subpaths first)
// to this example's own installed copies so the demo, the selector, and
// the benchmarks all run identical library builds, locally and in CI.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^dalien-signals\/system$/, replacement: here('../esm/system.mjs') },
			{ find: /^dalien-signals$/, replacement: here('../esm/index.mjs') },
			{ find: /^alien-signals\/esm$/, replacement: here('./node_modules/alien-signals/esm/index.mjs') },
			{ find: /^alien-signals$/, replacement: here('./node_modules/alien-signals/esm/index.mjs') },
			{ find: /^@preact\/signals-core$/, replacement: here('./node_modules/@preact/signals-core/dist/signals-core.mjs') },
			{ find: /^@reactively\/core$/, replacement: here('./node_modules/@reactively/core/dist/core.js') },
		],
	},
});
