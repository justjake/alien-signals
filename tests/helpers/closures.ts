import { computed, dispose, effect, effectScope, get, set, signal } from '../../src';
import type { Signal, SignalId } from '../../src';

// Closure-shaped conveniences over the numeric-handle API, for behavior
// specs written in the old call style. The library itself exposes only
// handles + module functions (the perf-shaped surface); these wrappers are
// test sugar.

export function signalFn<T>(initialValue?: T): { (): T; (value: T): void; id: Signal<T | undefined> } {
	const id = signal<T>(initialValue as T);
	const oper = ((...value: [T?]) => {
		if (value.length) {
			set(id, value[0] as T);
		} else {
			return get(id);
		}
	}) as { (): T; (value: T): void; id: Signal<T | undefined> };
	oper.id = id;
	return oper;
}

export function computedFn<T>(getter: (previousValue?: T) => T): { (): T; id: Signal<T> } {
	const id = computed(getter);
	const oper = (() => get(id)) as { (): T; id: Signal<T> };
	oper.id = id;
	return oper;
}

export function effectFn(fn: () => void | (() => void)): { (): void; id: SignalId } {
	const id = effect(fn);
	const disposer = (() => {
		dispose(id);
	}) as { (): void; id: SignalId };
	disposer.id = id;
	return disposer;
}

export function effectScopeFn(fn: () => void): { (): void; id: SignalId } {
	const id = effectScope(fn);
	const disposer = (() => {
		dispose(id);
	}) as { (): void; id: SignalId };
	disposer.id = id;
	return disposer;
}
