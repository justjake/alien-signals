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

/**
 * Return a live view of the node currently recording signal reads.
 *
 * Returns `undefined` outside a computed getter, effect callback, effect
 * scope, or other dependency-tracking operation. Writing `view.flags`
 * changes that node's public update flags immediately.
 */
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

/**
 * Set the node that records subsequent signal reads.
 *
 * Pass a view previously returned by {@link getActiveSub}, or `undefined` to
 * disable tracking. Returns the previous view so callers can restore it.
 */
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
 * Set the fixed capacity of the default system and allocate its arena.
 *
 * Call this before creating a signal, computed, effect, or effect scope.
 * `initialRecords` counts 32-byte node and dependency records. It defaults
 * to 8,388,608 records (256 MB of virtual address space). The arena grows
 * automatically between operations once 3/4 full; a single callback that
 * allocates past the remaining headroom in one go throws.
 *
 * @example
 * ```ts
 * configure({ initialRecords: 1 << 20 });
 * const count = signal(0);
 * ```
 */
export function configure(options?: { initialRecords?: number; notify?: (effectId: number, gen: number) => void }): void {
	systemConfigure(options);
}

/** Return the number of currently open batches. */
export function getBatchDepth(): number {
	return systemGetBatchDepth();
}

/**
 * Open a batch. Signal writes still take effect, but queued effects wait for
 * the matching {@link endBatch} call.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * effect(() => console.log(count())); // 0
 * startBatch();
 * try {
 *   count(1);
 *   count(2);
 * } finally {
 *   endBatch(); // 2; the effect runs once.
 * }
 * ```
 */
export function startBatch() {
	systemStartBatch();
}

/**
 * Close a batch and run queued effects when the outermost batch closes.
 * Call once for each {@link startBatch} call.
 */
export function endBatch() {
	systemEndBatch();
}

/** Return whether `fn` is a signal function created by this package. */
export function isSignal(fn: () => void): boolean {
	return handleKind(fn) === HandleKind.Signal;
}

/** Return whether `fn` is a computed read function created by this package. */
export function isComputed(fn: () => void): boolean {
	return handleKind(fn) === HandleKind.Computed;
}

/** Return whether `fn` is an effect disposer created by this package. */
export function isEffect(fn: () => void): boolean {
	return handleKind(fn) === HandleKind.Effect;
}

/** Return whether `fn` is an effect-scope disposer created by this package. */
export function isEffectScope(fn: () => void): boolean {
	return handleKind(fn) === HandleKind.EffectScope;
}

/**
 * Create a reactive value whose returned function reads or writes the value.
 * Calling `value()` reads; calling `value(next)` writes.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * count();  // 0
 * count(1);
 * count();  // 1
 * ```
 */
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

/**
 * Create a cached value derived from the signals and computeds read by
 * `getter`. The getter runs on the first read and again only when needed.
 * Its argument is the previous cached value, or `undefined` on the first run.
 *
 * @example
 * ```ts
 * const count = signal(2);
 * const doubled = computed(() => count() * 2);
 * doubled(); // 4
 * count(3);
 * doubled(); // 6
 * ```
 */
export function computed<T>(getter: (previousValue?: T) => T): () => T {
	return system.e.makeComputed(getter as (previousValue?: unknown) => unknown) as () => T;
}

/**
 * Run `fn` immediately, then rerun it when a value it read changes.
 *
 * `fn` may return cleanup work, which runs before the next execution and
 * when the returned disposer is called.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * const stop = effect(() => console.log(count())); // 0
 * count(1); // 1
 * stop();
 * ```
 */
export function effect(fn: () => void | (() => void)): () => void {
	return system.e.makeEffect(fn);
}

/**
 * Run `fn` immediately and group every nested effect it creates.
 * The returned disposer stops the group and runs its cleanup work.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * const stop = effectScope(() => {
 *   effect(() => console.log(count()));
 * });
 * stop();
 * count(1); // No log; the scope is stopped.
 * ```
 */
export function effectScope(fn: () => void): () => void {
	return system.e.makeScope(fn);
}

/**
 * Notify dependents after mutating values stored inside signals in place.
 * Read each changed signal inside `fn`; each affected effect is queued at
 * most once.
 *
 * @example
 * ```ts
 * const items = signal<string[]>([]);
 * const size = computed(() => items().length);
 * size(); // 0
 * items().push('one');
 * trigger(items);
 * size(); // 1
 * ```
 */
export function trigger(fn: () => void) {
	systemTrigger(fn);
}
