// The memory inspector's engine: a tiny signal library built directly on
// dalien-signals' system layer, the same way the shipped index.ts is built —
// host-owned values and callbacks, direct record writes, the five raw graph
// ops. Everything the inspector displays is decoded from the arena's
// Int32Array; nothing here keeps a shadow model of the graph.
import { createReactiveSystem } from 'dalien-signals/system';

// One record = 8 × int32 = 32 bytes. A record id IS the index of its first
// slot in the arena, so ids are 0, 8, 16, 24, … — record 0 belongs to the
// system (operation-depth counter and friends).
export const NODE_SLOTS = {
	Flags: 0, //    kind + state bits (see FLAG_BITS)
	Deps: 1, //     head of the dependency list (a link record id)
	DepsTail: 2, // re-track cursor into that list
	Subs: 3, //     head of the subscriber list (a link record id)
	SubsTail: 4, // tail of that list
	Gen: 5, //      generation counter: stale ids from freed records miss
	// slots 6+7 hold one float64: the version snapshot ("verified as of
	// global version N") read through a Float64Array view of the same buffer
};
export const LINK_SLOTS = {
	Version: 0, //  tracking pass that created/confirmed this edge
	Dep: 1, //      the record being depended on
	Sub: 2, //      the record doing the depending
	PrevSub: 3, //  doubly-linked subscriber list of Dep
	NextSub: 4,
	PrevDep: 5, //  singly/doubly-linked dependency list of Sub
	NextDep: 6,
};
export const FLAG_BITS = [
	[1, 'Mutable'],
	[2, 'Watching'],
	[4, 'RecursedCheck'],
	[8, 'Recursed'],
	[16, 'Dirty'],
	[32, 'Pending'],
];

// Host kind tags, stored in the flags word's host-reserved bits.
const HOST_SHIFT = 20;
export const KIND = { signal: 1 << HOST_SHIFT, computed: 2 << HOST_SHIFT, effect: 3 << HOST_SHIFT };
const KIND_MASK = 15 << HOST_SHIFT;
const HIDDEN = ~((1 << HOST_SHIFT) - 1);

export function kindOf(flags) {
	const k = flags & KIND_MASK;
	return k === KIND.signal ? 'signal' : k === KIND.computed ? 'computed' : k === KIND.effect ? 'effect' : null;
}

export function makeInspectableSystem() {
	const F = { Mutable: 1, Watching: 2, RecursedCheck: 4, Dirty: 16, Pending: 32 };
	const states = []; // host column: values/getters/callbacks by record index
	const queue = [];
	const log = [];
	let activeSub = 0;
	let cycle = 0;
	let globalVersion = 1;
	let batchDepth = 0;
	let draining = false;

	let M, D, link, unlink, propagate, checkDirty, shallowPropagate;

	const sys = createReactiveSystem({
		capacityRecords: 512,
		allocated(arena) {
			({ memory: M, versions: D, link, unlink, propagate, checkDirty, shallowPropagate } = arena);
		},
		update(id, flags) {
			const st = states[id >> 3];
			if (st === undefined) return true;
			if ((flags & KIND_MASK) === KIND.signal) {
				M[id + NODE_SLOTS.Flags] = (flags & HIDDEN) | F.Mutable;
				return st.current !== (st.current = st.pending);
			}
			return recompute(id, st);
		},
		notify(id, gen) {
			log.push(`notify: effect @${id} queued`);
			queue.push([id, gen]);
		},
		unwatched(id) {
			if ((M[id + NODE_SLOTS.Flags] & KIND_MASK) === KIND.computed) {
				M[id + NODE_SLOTS.Flags] = (M[id + NODE_SLOTS.Flags] & HIDDEN) | F.Mutable | F.Dirty;
				D[(id >> 1) + 3] = 0;
				let l = M[id + NODE_SLOTS.DepsTail];
				while (l !== 0) {
					const prev = M[l + LINK_SLOTS.PrevDep];
					unlink(l, id);
					l = prev;
				}
				log.push(`unwatched: computed @${id} dropped its deps, went Dirty`);
			}
		},
	});

	function purgeDeps(sub) {
		const tail = M[sub + NODE_SLOTS.DepsTail];
		let l = tail !== 0 ? M[tail + LINK_SLOTS.NextDep] : M[sub + NODE_SLOTS.Deps];
		while (l !== 0) l = unlink(l, sub);
	}

	function recompute(id, st) {
		M[id + NODE_SLOTS.DepsTail] = 0;
		M[id + NODE_SLOTS.Flags] = (M[id + NODE_SLOTS.Flags] & HIDDEN) | F.Mutable | F.RecursedCheck;
		const prevSub = activeSub;
		activeSub = id;
		++cycle;
		++M[1]; // system slot: operation depth
		const entryVersion = globalVersion;
		try {
			const old = st.value;
			const changed = old !== (st.value = st.getter(old));
			D[(id >> 1) + 3] = entryVersion;
			log.push(`recompute: computed @${id} → ${fmt(st.value)}${changed ? '' : ' (unchanged — cutoff)'}`);
			return changed;
		} finally {
			--M[1];
			activeSub = prevSub;
			M[id + NODE_SLOTS.Flags] &= ~F.RecursedCheck;
			purgeDeps(id);
		}
	}

	function drain() {
		if (draining || batchDepth !== 0) return;
		draining = true;
		try {
			while (queue.length) {
				const [id, gen] = queue.shift();
				if (M[id + NODE_SLOTS.Gen] !== gen) continue;
				const st = states[id >> 3];
				if (st === undefined) continue;
				const flags = M[id + NODE_SLOTS.Flags];
				if (flags & F.Dirty || (flags & F.Pending && checkDirty(M[id + NODE_SLOTS.Deps], id))) {
					M[id + NODE_SLOTS.DepsTail] = 0;
					M[id + NODE_SLOTS.Flags] = (M[id + NODE_SLOTS.Flags] & HIDDEN) | F.Watching | F.RecursedCheck;
					const prevSub = activeSub;
					activeSub = id;
					++cycle;
					++M[1];
					try {
						log.push(`run: effect @${id}`);
						st.fn();
					} finally {
						--M[1];
						activeSub = prevSub;
						M[id + NODE_SLOTS.Flags] &= ~F.RecursedCheck;
						purgeDeps(id);
					}
				} else {
					M[id + NODE_SLOTS.Flags] = (flags & HIDDEN) | F.Watching;
					log.push(`verified clean: effect @${id} did not run`);
				}
			}
		} finally {
			draining = false;
		}
	}

	function fmt(v) {
		return typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
	}

	function signal(name, v) {
		const id = sys.allocNode(KIND.signal | F.Mutable);
		states[id >> 3] = { name, current: v, pending: v };
		return {
			id,
			name,
			read() {
				const st = states[id >> 3];
				const flags = M[id + NODE_SLOTS.Flags];
				if (flags & F.Dirty) {
					M[id + NODE_SLOTS.Flags] = (flags & HIDDEN) | F.Mutable;
					if (st.current !== (st.current = st.pending)) {
						const subs = M[id + NODE_SLOTS.Subs];
						if (subs !== 0) shallowPropagate(subs);
					}
				}
				D[(id >> 1) + 3] = globalVersion;
				if (activeSub !== 0) link(id, activeSub, cycle);
				return st.current;
			},
			write(v2) {
				const st = states[id >> 3];
				if (st.pending !== (st.pending = v2)) {
					M[id + NODE_SLOTS.Flags] = (M[id + NODE_SLOTS.Flags] & HIDDEN) | F.Mutable | F.Dirty;
					++globalVersion;
					log.push(`write: signal @${id} (${st.name}) ← ${fmt(v2)}; Flags gains Dirty; propagate marks the cone Pending`);
					const subs = M[id + NODE_SLOTS.Subs];
					if (subs !== 0) {
						propagate(subs, false);
						if (!batchDepth) drain();
					}
				} else {
					log.push(`write: signal @${id} (${st.name}) ← ${fmt(v2)} — same value, nothing happens`);
				}
			},
		};
	}

	function computed(name, getter) {
		const id = sys.allocNode(KIND.computed | F.Mutable | F.Dirty);
		states[id >> 3] = { name, getter, value: undefined };
		return {
			id,
			name,
			read() {
				const st = states[id >> 3];
				const flags = M[id + NODE_SLOTS.Flags];
				if (D[(id >> 1) + 3] !== globalVersion) {
					if (flags & F.Dirty || (flags & F.Pending && checkDirty(M[id + NODE_SLOTS.Deps], id))) {
						if (recompute(id, st)) {
							const subs = M[id + NODE_SLOTS.Subs];
							if (subs !== 0) shallowPropagate(subs);
						}
					} else if (flags & F.Pending) {
						M[id + NODE_SLOTS.Flags] = flags & ~F.Pending;
						D[(id >> 1) + 3] = globalVersion;
					}
				}
				if (activeSub !== 0) link(id, activeSub, cycle);
				return st.value;
			},
		};
	}

	function effect(name, fn) {
		const id = sys.allocNode(KIND.effect | F.Watching | F.RecursedCheck);
		states[id >> 3] = { name, fn };
		const prevSub = activeSub;
		activeSub = id;
		++M[1];
		try {
			log.push(`effect @${id} (${name}) runs and records its dependencies`);
			fn();
		} finally {
			--M[1];
			activeSub = prevSub;
			M[id + NODE_SLOTS.Flags] &= ~F.RecursedCheck;
		}
		return {
			id,
			name,
			dispose() {
				states[id >> 3] = undefined;
				log.push(`dispose: effect @${id} — record freed; its links return to the free list`);
				sys.disposeNode(id);
			},
		};
	}

	return {
		signal,
		computed,
		effect,
		startBatch: () => { ++batchDepth; },
		endBatch: () => { if (!--batchDepth) drain(); },
		arena: () => ({ M, D }),
		states,
		log,
		stats: () => sys.stats(),
	};
}
