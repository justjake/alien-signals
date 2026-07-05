// Exercises every budgeted hot path so V8 generates bytecode for each
// function (lazy compilation: uninvoked functions never get bytecode).
// Used by tests/bytecode.spec.ts via `node --print-bytecode`.
import {
	computed,
	effect,
	effectScope,
	endBatch,
	getActiveSub,
	signal,
	startBatch,
	trigger,
} from '../../esm/index.mjs';
import { createReactiveSystem, ReactiveFlags } from '../../esm/system.mjs';

const a = signal(1);
const b = signal(2);
const toggle = signal(false);
const c1 = computed(() => a() + 1);
const c2 = computed(() => c1() + (toggle() ? a() : b())); // dynamic deps: unlink/purgeDeps
const c3 = computed(() => c1() + c2()); // multi-sub: shallowPropagate
const d1 = effect(() => { c3(); });
const d2 = effect(() => { c2(); });
// Recursive write inside an effect: exercises isValidLink + the recurse arms.
let recursed = 0;
effect(() => {
	getActiveSub().flags &= ~ReactiveFlags.RecursedCheck;
	recursed = Math.min(recursed + 1, 3);
	a(Math.min(a() + 1, 5));
});
// Inner write with RecursedCheck still set: propagate's isValidLink arm.
const r = signal(0);
effect(() => {
	const v = r();
	if (v > 0 && v < 3) {
		r(v + 1);
	}
});
r(1);
// Parent effect re-runs with a child effect: run()'s unlinkChildEffects arm.
const p = signal(0);
effect(() => {
	p();
	effect(() => { b(); });
});
p(1);
for (let i = 0; i < 200; i++) {
	a(i);
	toggle(i % 2 === 0);
	b(i * 2);
}
startBatch();
a(999);
b(998);
endBatch();
trigger(() => { a(); });
const scope = effectScope(() => { effect(() => { c1(); }); });
scope();
d1();
d2();
// Exercise the id-level computedRead path (permanently-installed getter).
const sys = createReactiveSystem({ initialRecords: 4096, reclaimHandles: false });
const nsId = sys.signal(1);
const ncId = sys.computed(() => sys.signalRead(nsId) + 1);
sys.computedRead(ncId);
sys.signalWrite(nsId, 2);
sys.computedRead(ncId);

console.log('smoke ok', c3());
