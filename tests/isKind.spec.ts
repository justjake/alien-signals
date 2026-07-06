import { expect, test } from 'vitest';
import { computed, dispose, effect, effectScope, isComputed, isEffect, isEffectScope, isSignal, signal } from '../src';

// Kind checks on numeric handles: the kind tag lives in the node's flags
// word, so is* is a flags load + mask — and a freed id is no kind at all.

test('each kind identifies as itself and nothing else', () => {
	const s = signal(0);
	const c = computed(() => 1);
	const e = effect(() => {});
	const scope = effectScope(() => {});
	expect([isSignal(s), isComputed(s), isEffect(s), isEffectScope(s)]).toEqual([true, false, false, false]);
	expect([isSignal(c), isComputed(c), isEffect(c), isEffectScope(c)]).toEqual([false, true, false, false]);
	expect([isSignal(e), isComputed(e), isEffect(e), isEffectScope(e)]).toEqual([false, false, true, false]);
	expect([isSignal(scope), isComputed(scope), isEffect(scope), isEffectScope(scope)]).toEqual([false, false, false, true]);
});

test('a disposed id is no kind', () => {
	const e = effect(() => {});
	expect(isEffect(e)).toBe(true);
	dispose(e);
	expect(isEffect(e)).toBe(false);
});
