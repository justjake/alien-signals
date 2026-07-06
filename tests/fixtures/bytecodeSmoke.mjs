// Exercises every budgeted hot path so V8 generates bytecode for each
// function (lazy compilation: uninvoked functions never get bytecode).
// Used by tests/bytecode.spec.ts via `node --print-bytecode`.
import {
	computed,
	dispose,
	effect,
	effectScope,
	endBatch,
	get,
	getActiveSub,
	getFlags,
	set,
	setFlags,
	signal,
	startBatch,
	trigger,
} from '../../esm/index.mjs';
import { ReactiveFlags, createReactiveSystem } from '../../esm/system.mjs';

const a = signal(1);
const b = signal(2);
const toggle = signal(false);
const c1 = computed(() => get(a) + 1);
const c2 = computed(() => get(c1) + (get(toggle) ? get(a) : get(b))); // dynamic deps: unlink/purgeDeps
const c3 = computed(() => get(c1) + get(c2)); // multi-sub: shallowPropagate
const d1 = effect(() => { get(c3); });
const d2 = effect(() => { get(c2); });
// Recursive write inside an effect: exercises isValidLink + the recurse arms.
let recursed = 0;
effect(() => {
	setFlags(getActiveSub(), getFlags(getActiveSub()) & ~ReactiveFlags.RecursedCheck);
	recursed = Math.min(recursed + 1, 3);
	set(a, Math.min(get(a) + 1, 5));
});
// Inner write with RecursedCheck still set: propagate's isValidLink arm.
const r = signal(0);
effect(() => {
	const v = get(r);
	if (v > 0 && v < 3) {
		set(r, v + 1);
	}
});
set(r, 1);
// Parent effect re-runs with a child effect: run()'s unlinkChildEffects arm.
const p = signal(0);
effect(() => {
	get(p);
	effect(() => { get(b); });
});
set(p, 1);
for (let i = 0; i < 200; i++) {
	set(a, i);
	set(toggle, i % 2 === 0);
	set(b, i * 2);
}
startBatch();
set(a, 999);
set(b, 998);
endBatch();
trigger(() => { get(a); });
const scope = effectScope(() => { effect(() => { get(c1); }); });
dispose(scope);
dispose(d1);
dispose(d2);
// Exercise the kindless seam + the raw graph ops directly.
const nodes = [];
const sys = createReactiveSystem({
	capacityRecords: 4096,
	update(id, flags) {
		const st = nodes[id >> 3];
		sys.arena.memory[id] = flags & ~48; // clear Dirty|Pending (slot 0 = flags)
		return st.current !== (st.current = st.pending);
	},
	notify() {},
});
const nsOwner = { current: 1, pending: 1 };
const nsId = sys.createNode(nsOwner, 1 << 16 | ReactiveFlags.Mutable);
nodes[nsId >> 3] = nsOwner;
const watcherOwner = {};
const watcherId = sys.createNode(watcherOwner, 2 << 16 | ReactiveFlags.Watching);
const M = sys.arena.memory;
const rawEdge = sys.arena.link(nsId, watcherId, 1);
nodes[nsId >> 3].pending = 2;
M[nsId] |= ReactiveFlags.Dirty;
sys.arena.propagate(rawEdge, false);
sys.arena.checkDirty(M[watcherId + 1], watcherId); // slot 1 = deps head
sys.arena.unlink(rawEdge, watcherId);

console.log('smoke ok', get(c3));
