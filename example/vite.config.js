// The benchmark worker imports the milomg fork's suites and adapters from
// harness source (../../../../milomg-reactivity-benchmark). Those adapter
// files import their libraries by bare specifier, which would resolve up
// the FORK's directory chain — alias them (exact matches, subpaths first)
// to this example's own installed copies so the demo, the selector, and
// the benchmarks all run identical library builds, locally and in CI.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// Paths through the fork core's own package links (pnpm symlinks): they
// resolve wherever the store physically lives, on any machine. A
// hard-coded .pnpm store path only works on the machine that produced it.
const fork = (p) => here(`../../../milomg-reactivity-benchmark/packages/core/node_modules/${p}`);

// The page's code samples are static text, so coloring them is a build
// concern: transformIndexHtml swaps each <pre><code class="language-x">
// block for shiki's span-per-token HTML while the page is served (dev) or
// emitted (build). The browser gets finished markup — no highlighter
// bundle to download, no post-load repaint to shift the layout.
// The page's opening section IS the README's opening section: extracted at
// build time (heading through the paragraph and bullets before the next
// h2, plus the reference-link definitions so reference-style links
// resolve) and rendered to HTML in place of the <!-- readme:intro -->
// marker. Hand-mirrored copies drift; this cannot.
function readmeIntro() {
	return {
		name: 'readme-intro',
		transformIndexHtml: {
			order: 'pre',
			handler(html) {
				const readme = readFileSync(here('../README.md'), 'utf8');
				const start = readme.indexOf('# dalien-signals');
				const end = readme.indexOf('\n## ', start);
				const linkDefs = [...readme.matchAll(/^\[[^\]]+\]: \S+$/gm)].map((m) => m[0]).join('\n');
				const intro = marked.parse(readme.slice(start, end) + '\n\n' + linkDefs);
				return html.replace('<!-- readme:intro -->', intro);
			},
		},
	};
}

function shikiHighlight() {
	// index.html authors the samples as escaped HTML; shiki wants source
	// text and does its own escaping on the way back out.
	const unescape = (html) => html
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&'); // last, so "&amp;lt;" cannot double-decode
	return {
		name: 'shiki-highlight',
		async transformIndexHtml(html) {
			// Imported per transform, not at config load: every vite command
			// evaluates this file, but only HTML serving needs a highlighter.
			// shiki caches its engine internally, so repeat transforms in a
			// long-lived dev server pay the wasm setup once.
			const { codeToHtml } = await import('shiki');
			const blocks = [...html.matchAll(/<pre><code class="language-([\w-]+)">([\s\S]*?)<\/code><\/pre>/g)];
			for (const [block, lang, escaped] of blocks) {
				const highlighted = await codeToHtml(unescape(escaped), {
					lang,
					// tokyo-night's cyan (#7dcfff) and purple (#bb9af7) sit next
					// to the page accents (#7fd4ff / #b48bff). Its background is
					// swapped for the stylesheet's pre background so the block
					// keeps the page's shade of dark instead of adding a second.
					theme: 'tokyo-night',
					colorReplacements: { '#1a1b26': '#10131c' },
				});
				// Replacement via callback: sample code contains `$` sequences
				// that String.replace would otherwise interpret.
				html = html.replace(block, () => highlighted);
			}
			return html;
		},
	};
}

export default defineConfig({
	plugins: [readmeIntro(), shikiHighlight()],
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
			{ find: /^anod$/, replacement: fork('anod/dist/index.js') },
			{ find: /^@tldraw\/state$/, replacement: fork('@tldraw/state/dist-esm/index.mjs') },
			// the solid2 adapter imports this build by a relative path that
			// only exists in the store
			{ find: /^(\.\.\/)+node_modules\/solid-js-2\/dist\/solid\.js$/, replacement: fork('solid-js-2/dist/solid.js') },
		],
	},
});
