import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// Mechanism/policy split: system.ts encapsulates all the bytes and bits;
// index.ts is ONE example client — a typed signal framework built strictly
// from the public surface. Anything index.ts needs that is not on this list
// must become part of the public API first, so that a third party could
// build an equivalent framework without forking.

const PUBLIC_SURFACE = new Set([
	// factory + public types
	'createReactiveSystem',
	'ReactiveSystemOptions',
	'ReactiveSystem',
	'ReactiveEngine',
	'ReactiveNode',
	'ReactiveFlags',
	'SignalId',
	'LinkId',
	'SignalGen',
	'SignalIdKey',
	'SignalGenKey',
	// the record layout (trusted hosts address the arena directly)
	'NodeSlot',
	'LinkSlot',
	'SysSlot',
	'Arena',
	'Flag',
	// codegen feature detection
	'codegenAvailable',
	'codegenSupported',
]);

test('index.ts consumes only the public system surface', () => {
	const src = readFileSync(
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
		'utf8',
	);
	const imports = [...src.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'\.\/system\.js'/g)]
		.flatMap((m) => m[1].split(','))
		.map((name) => name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])
		.filter(Boolean);
	expect(imports.length).toBeGreaterThan(0);
	for (const name of imports) {
		expect(PUBLIC_SURFACE, `index.ts imports non-public '${name}' from system.ts`).toContain(name);
	}
});
