// Field runtime: the id-based interface the pixel graph is built against.
//
// graph.js, main.js, and smoke.mjs speak one interface:
//   signal(v) -> id      computed(fn) -> id     effect(fn)
//   get(id)              set(id, v)             batch(fn)
//   build(fn)            dispose()
//
// makeRuntime(lib, framework) has exactly two paths:
//   - 'dalien-signals' runs on dalien's native integer-id tier. The field
//     allocates one node per pixel, so per-cell wrapper objects and GC
//     registration dominate build time and memory at scale; the id tier
//     has neither, and per-id dispose() is an API the generic framework
//     interface cannot express.
//   - every other library goes through one generic bridge over a
//     benchmark-adapter object (the milomg fork's ReactiveFramework shape:
//     static methods createSignal/readSignal/writeSignal/createComputed/
//     readComputed/effect/withBatch/withBuild/cleanup, generic over the
//     framework's own cell representation), passed in by the caller.
//     Dependency injection keeps this module importable by bare Node: the
//     adapter sources are TypeScript with extensionless imports, which
//     only Vite can load, so main.js passes FRAMEWORKS[lib] and smoke.mjs
//     passes its own Node-runnable adapter.
import * as dalien from 'dalien-signals';

export function makeRuntime(lib, framework) {
	if (lib === 'dalien-signals') {
		// Ids have explicit lifetimes: track every allocation and free each
		// one in dispose(). No build scope is needed — per-id dispose is
		// already total — so build(fn) just runs fn.
		let ids = [];
		return {
			build: (fn) => fn(),
			signal(v) {
				const id = dalien.signalId(v);
				ids.push(id);
				return id;
			},
			computed(fn) {
				const id = dalien.computedId(fn);
				ids.push(id);
				return id;
			},
			effect(fn) {
				ids.push(dalien.effectId(fn));
			},
			get: dalien.get,
			set: dalien.set,
			batch(fn) {
				dalien.startBatch();
				fn();
				dalien.endBatch();
			},
			dispose() {
				for (const id of ids) dalien.dispose(id);
				ids = [];
			},
		};
	}
	if (!framework) {
		throw new Error(`makeRuntime('${lib}') needs a framework adapter object`);
	}
	// Generic bridge: ids are indexes into an array of the adapter's own
	// opaque cells — the static-method interface never allocates a
	// per-cell wrapper or closure pair. Reads all go through
	// readComputed, which the interface requires to accept signal cells
	// too; writes only ever target signals. Everything the graph owns
	// must be created inside build(fn) — several adapters parent effects
	// (and for dalien's malloc/free tier, every node) to a scope or root
	// opened by withBuild, and cleanup() disposes that scope. Creations
	// outside it would survive cleanup.
	let cells = [];
	return {
		build: (fn) => framework.withBuild(fn),
		signal: (v) => cells.push(framework.createSignal(v)) - 1,
		computed: (fn) => cells.push(framework.createComputed(fn)) - 1,
		effect(fn) {
			framework.effect(fn);
		},
		get: (id) => framework.readComputed(cells[id]),
		set: (id, v) => framework.writeSignal(cells[id], v),
		batch: (fn) => framework.withBatch(fn),
		dispose() {
			// Read .cleanup at call time: the solid-style adapters install
			// the real dispose function by replacing that property from
			// inside withBuild. Every adapter's cleanup() is real disposal
			// (the fork's interface rework closed the last gaps), so
			// dropping the cell storage afterwards frees the whole graph.
			framework.cleanup();
			cells = [];
		},
	};
}
