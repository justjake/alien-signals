import { createReactiveSystem, HandleKind, handleKind, ReactiveFlags, type ReactiveNode } from './system.js';

const system = createReactiveSystem();

const {
	configure: systemConfigure,
	trigger: systemTrigger,
	startBatch: systemStartBatch,
	endBatch: systemEndBatch,
	getBatchDepth: systemGetBatchDepth,
	getActiveSub: systemGetActiveSub,
	setActiveSub: systemSetActiveSub,
	nodeFlags,
	setNodeFlags,
} = system;

// Handles are ANONYMOUS closures minted INSIDE the engine (system.ts
// makeSignal etc.) over the fixed-capacity plane: calling one reaches the
// graph with upstream-parity hop count, and creating one costs a symbol
// brand (~3ns) instead of a name — named closures get defineProperty-wrapped
// by keepNames toolchains at ~120ns per handle (see system.ts HANDLE_KIND).
// isSignal/isComputed/isEffect/isEffectScope check the brand, so they work
// exactly as upstream's name checks did; `fn.name` itself is now ''.

const NODE_ID = Symbol('dalien.nodeId');

/**
 * Live view over a node record: `.flags` reads/writes the semantic flag bits
 * in the record plane (the documented upstream pattern
 * `getActiveSub()!.flags &= ~ReactiveFlags.RecursedCheck` keeps working).
 */
class NodeView implements ReactiveNode {
	[NODE_ID]: number;
	constructor(id: number) {
		this[NODE_ID] = id;
	}
	get flags(): ReactiveFlags {
		return nodeFlags(this[NODE_ID]) & 127;
	}
	set flags(value: ReactiveFlags) {
		setNodeFlags(this[NODE_ID], value);
	}
}

let activeSubView: NodeView | undefined;

export function getActiveSub(): ReactiveNode | undefined {
	const id = systemGetActiveSub();
	if (!id) {
		return undefined;
	}
	if (activeSubView === undefined || activeSubView[NODE_ID] !== id) {
		activeSubView = new NodeView(id);
	}
	return activeSubView;
}

export function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
	let id = 0;
	if (sub !== undefined) {
		id = (sub as NodeView)[NODE_ID];
		if (typeof id !== 'number') {
			throw new TypeError('dalien-signals: setActiveSub expects a value returned by getActiveSub()');
		}
	}
	const prevId = systemSetActiveSub(id);
	if (!prevId) {
		return undefined;
	}
	return new NodeView(prevId);
}

/**
 * Size and eagerly allocate the default system's record plane. Buffers are
 * otherwise allocated lazily on first primitive creation, so call this
 * before any signal/computed/effect/effectScope exists — afterwards it
 * throws. `initialRecords` is the plane CAPACITY in 32-byte records
 * (default 2^23 ≈ 256 MB of lazily-mapped virtual pages — physical memory
 * tracks records actually touched). The plane does not grow; exhausting it
 * throws an actionable error naming this function.
 */
export function configure(options?: { initialRecords?: number }): void {
	systemConfigure(options);
}

export function getBatchDepth(): number {
	return systemGetBatchDepth();
}

export function startBatch() {
	systemStartBatch();
}

export function endBatch() {
	systemEndBatch();
}

export function isSignal(fn: () => void): boolean {
	return handleKind(fn) === HandleKind.Signal;
}

export function isComputed(fn: () => void): boolean {
	return handleKind(fn) === HandleKind.Computed;
}

export function isEffect(fn: () => void): boolean {
	return handleKind(fn) === HandleKind.Effect;
}

export function isEffectScope(fn: () => void): boolean {
	return handleKind(fn) === HandleKind.EffectScope;
}

export function signal<T>(): {
	(): T | undefined;
	(value: T | undefined): void;
};
export function signal<T>(initialValue: T): {
	(): T;
	(value: T): void;
};
export function signal<T>(initialValue?: T): {
	(): T | undefined;
	(value: T | undefined): void;
} {
	return system.e.makeSignal(initialValue) as {
		(): T | undefined;
		(value: T | undefined): void;
	};
}

export function computed<T>(getter: (previousValue?: T) => T): () => T {
	return system.e.makeComputed(getter as (previousValue?: unknown) => unknown) as () => T;
}

export function effect(fn: () => void | (() => void)): () => void {
	return system.e.makeEffect(fn);
}

export function effectScope(fn: () => void): () => void {
	return system.e.makeScope(fn);
}

export function trigger(fn: () => void) {
	systemTrigger(fn);
}
