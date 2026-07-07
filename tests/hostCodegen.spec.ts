import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// createHost must stay CLOSED — only parameters and globals free — so
// post-growth generations can be compiled from String(createHost) with
// fresh function identities (preserving V8's function-context
// specialization; see instantiateHost). This spec compiles the BUILT
// factory's source text in a scope with none of the module's bindings:
// any captured module name becomes a ReferenceError here first.
test('the built createHost compiles from its own source text', () => {
	const built = readFileSync(join(__dirname, '..', 'esm', 'index.mjs'), 'utf8');
	const m = built.match(/function createHost\(arena, deps, boot\) \{/);
	expect(m, 'createHost found in build').toBeTruthy();
	const start = m!.index!;
	// brace-match to the factory's end
	let depth = 0;
	let i = built.indexOf('{', start);
	while (true) {
		const c = built[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) break;
		}
		i++;
	}
	const src = built.slice(start, i + 1);
	const compile = new Function('return (' + src + ');//closedness-spec');
	const clone = compile() as (arena: unknown, deps: unknown, boot: unknown) => Record<string, unknown>;
	expect(typeof clone).toBe('function');
	// A cloned generation must be constructible against plain stand-ins:
	// construction touches only arena fields and deps/boot properties.
	const fakeArena = {
		memory: new Int32Array(64),
		versions: new Float64Array(16),
		link: () => 0, unlink: () => 0, propagate: () => {},
		checkDirty: () => false, shallowPropagate: () => {}, freeNode: () => {},
	};
	const fakeDeps = {
		currentVals: [], pendingVals: [], fns: [], cleanups: [], owned: [],
		queued: [], pendingRegions: [], sys: { createNode: () => 8, allocNode: () => 8, adoptNode: () => {} },
	};
	const boot = {
		activeSub: 0, cycle: 0, globalVersion: 1, batchDepth: 0, runDepth: 0,
		manualEffects: false, notifyIndex: 0, queuedLength: 0, currentScope: 0, triggerScratch: 0,
	};
	const gen = clone(fakeArena, fakeDeps, boot);
	expect(typeof gen.readSignal).toBe('function');
	expect(typeof gen.state).toBe('function');
});
