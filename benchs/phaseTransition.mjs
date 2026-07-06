// Measures the workload-phase-transition cost that call-site seeding
// (src/system.ts maybeSeed) exists to remove, so the mitigation can be
// re-verified after Node/V8 upgrades.
//
// Phase A runs a single getter shape hot (the regime where V8 speculates on
// exact call targets at the engine's user-callback sites). Phase B then
// introduces several new getter shapes and re-times the SAME phase-A graph.
// Without seeding, phase B deoptimizes the engine's hot functions (observed:
// computedReadWith 4.6x self-time, 20-35% on pull-heavy suite tests).
//
// Seeding is adaptive (shape-diversity triggered), so three measurements
// tell the story — each in its OWN CHILD PROCESS. One process per config is
// mandatory: creating a second system in a process instantiates the engine
// closures a second time, which disables V8's function-context
// specialization (the const-M embedding) for every system in the process
// and would corrupt the comparison by ~1.8x.
//
//   eager      — always-seeded reference: the old flat-but-taxed world
//   alone      — adaptive, phase A only: the single-shape bonus; should
//                BEAT eager (no seed tax)
//   transition — adaptive, phase A after phase B: the insurance; must land
//                near eager, NOT collapse into unmitigated deopt churn
//
// Interpretation: transition/eager <= ~1.08 means the insurance holds; the
// eager/alone gap is the tax adaptive seeding stopped charging single-shape
// processes. If transition blows past eager, V8's polymorphism threshold or
// call-IC behavior changed and the seed needs re-tuning.
//
// Usage: node benchs/phaseTransition.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODE = process.env.PHASE_MODE;

if (MODE === undefined) {
	// Parent: run one child per config and interpret.
	const self = fileURLToPath(import.meta.url);
	const run = (mode) =>
		Number(execFileSync(process.execPath, [self], {
			env: { ...process.env, PHASE_MODE: mode },
			encoding: 'utf8',
		}).trim());
	const eager = run('eager');
	const alone = run('alone');
	const transition = run('transition');
	const insurance = transition / eager;
	const bonus = eager / alone;
	console.log(`eager A (always seeded): ${eager.toFixed(1)} ms`);
	console.log(`auto A alone:            ${alone.toFixed(1)} ms (bonus ${bonus.toFixed(2)}x over eager)`);
	console.log(`auto A after B:          ${transition.toFixed(1)} ms`);
	console.log(
		`insurance ratio (afterB/eager): ${insurance.toFixed(3)} ${
			insurance < 1.08 ? '(holds: diversity converges to the seeded steady state)' : '(CLIFF: re-tune seed in system.ts maybeSeed())'
		}`,
	);
	process.exit(0);
}

// Child: one system, one config, print the phase-A milliseconds.
const { createReactiveSystem } = await import('../esm/system.mjs');

const sys = createReactiveSystem(MODE === 'eager' ? { seeding: 'eager' } : undefined);

function buildChain(depth, mk) {
	const src = sys.makeSignal(1);
	let last = src;
	for (let i = 0; i < depth; i++) {
		const prev = last;
		last = mk(prev, i);
	}
	sys.makeEffect(() => {
		last();
	});
	return src;
}

function timeWrites(src, n) {
	const t0 = performance.now();
	for (let i = 0; i < n; i++) {
		src(i);
	}
	return performance.now() - t0;
}

const N = 200_000;
const a = buildChain(40, (prev) => sys.makeComputed(() => prev() + 1));
timeWrites(a, N); // warm

if (MODE === 'transition') {
	const shapes = [
		(prev) => sys.makeComputed(() => prev() - 1),
		(prev) => sys.makeComputed(() => prev() * 2),
		(prev) => sys.makeComputed(() => (prev() & 7) + 1),
		(prev) => sys.makeComputed(() => Math.max(prev(), 0)),
		(prev) => sys.makeComputed(() => prev() + prev()),
	];
	for (const mk of shapes) {
		timeWrites(buildChain(40, mk), N / 4);
	}
	if (!sys.stats().seeded) {
		console.error('BUG: diverse phase B did not trigger the adaptive seed');
		process.exit(1);
	}
	timeWrites(a, N / 10); // settle reoptimization
} else if (MODE === 'alone' && sys.stats().seeded) {
	console.error('BUG: single-shape phase A seeded the adaptive system');
	process.exit(1);
}

console.log(timeWrites(a, N).toFixed(3));
