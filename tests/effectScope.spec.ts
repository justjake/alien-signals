import { expect, test } from 'vitest';
import { computed, dispose, effectScope as effectScopeRaw, get, isComputed, isSignal, signal as signalRaw } from '../src';
import { effectFn as effect, effectScopeFn as effectScope, signalFn as signal } from './helpers/closures';

test('scope dispose runs child effect cleanup', () => {
	const log: string[] = [];
	const dispose = effectScope(() => {
		effect(() => {
			return () => log.push('inner:cleanup');
		});
	});
	dispose();
	expect(log).toEqual(['inner:cleanup']);
});

test('scope dispose: sibling effects clean up in reverse creation (LIFO)', () => {
	const log: string[] = [];
	const dispose = effectScope(() => {
		effect(() => {
			return () => log.push('e1:cleanup');
		});
		effect(() => {
			return () => log.push('e2:cleanup');
		});
		effect(() => {
			return () => log.push('e3:cleanup');
		});
	});
	dispose();
	expect(log).toEqual(['e3:cleanup', 'e2:cleanup', 'e1:cleanup']);
});

test('scope dispose: nested effect cleanup runs depth-first reverse', () => {
	const log: string[] = [];
	const dispose = effectScope(() => {
		effect(() => {
			effect(() => {
				return () => log.push('grandchild:cleanup');
			});
			return () => log.push('child:cleanup');
		});
	});
	dispose();
	expect(log).toEqual(['grandchild:cleanup', 'child:cleanup']);
});

test('scope as intermediate parent: cleanup order respects nesting', () => {
	// When effectScope is used as an intermediate scope inside an outer
	// effect, the outer's re-run must still dispose the scope (and its
	// effects) before running the outer's own cleanup.
	const a = signal(0);
	const log: string[] = [];

	effect(() => {
		a();
		log.push('outer:run');
		effectScope(() => {
			effect(() => {
				log.push('inner:run');
				return () => log.push('inner:cleanup');
			});
		});
		return () => log.push('outer:cleanup');
	});
	log.length = 0;

	a(1);
	expect(log).toEqual([
		'inner:cleanup',
		'outer:cleanup',
		'outer:run',
		'inner:run',
	]);
});

test('a scope owns the signals and computeds minted inside it', () => {
	let s!: ReturnType<typeof signalRaw<number>>;
	let c!: ReturnType<typeof computed<number>>;
	const scope = effectScopeRaw(() => {
		s = signalRaw(1);
		c = computed(() => get(s) + 1);
		expect(get(c)).toBe(2);
	});
	expect(isSignal(s)).toBe(true);
	expect(isComputed(c)).toBe(true);
	dispose(scope);
	// Region ownership: the scope freed its members.
	expect(isSignal(s)).toBe(false);
	expect(isComputed(c)).toBe(false);
});

test('a member disposed early is not double-freed by its scope', () => {
	let s!: ReturnType<typeof signalRaw<number>>;
	const scope = effectScopeRaw(() => {
		s = signalRaw(1);
	});
	dispose(s);
	// The record may be reused by a NEW node before the scope goes.
	const stranger = signalRaw(42);
	dispose(scope); // gen guard: must not free the stranger
	expect(get(stranger)).toBe(42);
	dispose(stranger);
});
