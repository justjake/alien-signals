import { expect, test } from 'vitest';
import { computed, effect, effectScope, isComputed, isEffect, isEffectScope, isSignal, signal } from '../src';
import { createReactiveSystem } from '../src/system';

test('is* identify handles of every kind, at zero creation cost', () => {
	const s = signal(1);
	const c = computed(() => s() + 1);
	const e = effect(() => { c(); });
	const sc = effectScope(() => {});

	expect(isSignal(s)).toBe(true);
	expect(isComputed(c)).toBe(true);
	expect(isEffect(e)).toBe(true);
	expect(isEffectScope(sc)).toBe(true);

	// no cross-kind confusion
	expect(isSignal(c) || isSignal(e) || isSignal(sc)).toBe(false);
	expect(isComputed(s) || isComputed(e) || isComputed(sc)).toBe(false);
	expect(isEffect(s) || isEffect(c) || isEffect(sc)).toBe(false);
	expect(isEffectScope(s) || isEffectScope(c) || isEffectScope(e)).toBe(false);

	// arbitrary functions are none of them
	const stranger = (): number => 1;
	expect(isSignal(stranger)).toBe(false);
	expect(isComputed(stranger)).toBe(false);
	expect(isEffect(stranger)).toBe(false);
	expect(isEffectScope(stranger)).toBe(false);

	e();
	sc();
});

test('is* work across systems and reclaim modes', () => {
	const sys = createReactiveSystem({ initialRecords: 4096, reclaimHandles: false });
	expect(isSignal(sys.makeSignal(1) as () => void)).toBe(true);
	expect(isComputed(sys.makeComputed(() => 1) as () => void)).toBe(true);
	expect(isEffect(sys.makeEffect(() => {}))).toBe(true);
	expect(isEffectScope(sys.makeScope(() => {}))).toBe(true);
});
