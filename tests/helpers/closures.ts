import { computed, effect, effectScope, signal } from '../../src';
import type { SignalId } from '../../src';

// Closure-shaped conveniences over the default handle API, for behavior
// specs written in the old call style.

export function signalFn<T>(initialValue?: T): { (): T; (value: T): void; id: SignalId } {
	const s = signal<T>(initialValue as T);
	const oper = ((...value: [T?]) => {
		if (value.length) {
			s.set(value[0] as T);
		} else {
			return s.get();
		}
	}) as { (): T; (value: T): void; id: SignalId };
	oper.id = s.id;
	return oper;
}

export function computedFn<T>(getter: (previousValue?: T) => T): { (): T; id: SignalId } {
	const c = computed(getter);
	const oper = (() => c.get()) as { (): T; id: SignalId };
	oper.id = c.id;
	return oper;
}

export function effectFn(fn: () => void | (() => void)): { (): void; id: SignalId } {
	const e = effect(fn);
	const disposer = (() => {
		e.dispose();
	}) as { (): void; id: SignalId };
	disposer.id = e.id;
	return disposer;
}

export function effectScopeFn(fn: () => void): { (): void; id: SignalId } {
	const e = effectScope(fn);
	const disposer = (() => {
		e.dispose();
	}) as { (): void; id: SignalId };
	disposer.id = e.id;
	return disposer;
}
