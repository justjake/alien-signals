// Shared pieces of the benchmark chart pipeline: results parsing, the
// test-to-suite mapping, and the validated categorical palette. chart.mjs
// (totals), chartDetails.mjs (per-test panels), and ci/pull-run.mjs all
// import from here so the suite mapping can't drift between them.

export const KAIRO = new Set(['avoidablePropagation', 'broadPropagation', 'deepPropagation', 'diamond', 'mux', 'repeatedObservers', 'triangle', 'unstable', 'molBench']);

// sbench test names differ between the milomg and transitive-bullshit forks
// (createSignals vs createDataSignals/createComputations0to1/...), but all
// share the create*/update* prefixes.
export const suiteOf = (test) => (test.startsWith('create') || test.startsWith('update')) ? 'sbench'
	: KAIRO.has(test) ? 'kairo'
	: test.startsWith('cellx') ? 'cellx'
	: 'dynamic';

export const SUITES = ['sbench', 'kairo', 'cellx', 'dynamic'];

// Validated categorical palette (light), slots 1-4 in fixed order.
export const COLOR = { sbench: '#2a78d6', kairo: '#1baf7a', cellx: '#eda100', dynamic: '#008300' };
export const SURFACE = '#ffffff';
export const INK = '#0b0b0b';
export const INK2 = '#52514e';
export const INK3 = '#8a8984';
export const GRID = '#e8e8e6';

/** Parse the isolated-runner CSV: rows of `framework , test , time`. */
export function parseResults(text) {
	return text.split('\n')
		.map((l) => l.split(',').map((p) => p.trim()))
		.filter((p) => p.length === 3 && p[0] !== 'framework' && Number.isFinite(Number(p[2])))
		.map(([framework, test, time]) => ({ framework, test, time: Number(time) }));
}

/**
 * Per-framework suite sums and totals, sorted ascending, with frameworks
 * that crashed mid-suite (fewer rows than the fullest) split out.
 */
export function summarize(rows) {
	const byFw = new Map();
	for (const { framework, test, time } of rows) {
		if (!byFw.has(framework)) byFw.set(framework, { tests: 0, sums: { sbench: 0, kairo: 0, cellx: 0, dynamic: 0 } });
		const e = byFw.get(framework);
		e.tests++;
		e.sums[suiteOf(test)] += time;
	}
	const expectedTests = Math.max(...[...byFw.values()].map((e) => e.tests));
	const frameworks = [];
	const partial = [];
	for (const [fw, e] of byFw) {
		if (e.tests < expectedTests) { partial.push(`${fw} (${e.tests}/${expectedTests} tests)`); continue; }
		frameworks.push({ fw, ...e.sums, total: SUITES.reduce((t, s) => t + e.sums[s], 0) });
	}
	frameworks.sort((a, b) => a.total - b.total);
	return { frameworks, partial };
}

export const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
