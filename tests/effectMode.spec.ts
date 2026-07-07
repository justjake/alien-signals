import { expect, test } from 'vitest';
import {
	effect,
	endBatch,
	flushEffects,
	setEffectMode,
	signal,
	startBatch,
} from '../src';

test('manual mode parks and coalesces effect reruns', () => {
	const previous = setEffectMode('manual');
	const source = signal(0);
	const seen: number[] = [];
	const stop = effect(() => {
		seen.push(source());
	});
	try {
		source(1);
		source(2);
		expect(seen).toEqual([0]);

		flushEffects();
		expect(seen).toEqual([0, 2]);
	} finally {
		stop();
		flushEffects();
		setEffectMode(previous);
	}
});

test('switching back to sync drains pending effects', () => {
	const previous = setEffectMode('manual');
	const source = signal(0);
	let value = -1;
	const stop = effect(() => {
		value = source();
	});
	try {
		source(1);
		expect(value).toBe(0);
		expect(() => setEffectMode('sync')).not.toThrow();
		expect(value).toBe(1);
	} finally {
		stop();
		flushEffects();
		setEffectMode(previous);
	}
});

test('the mode can change inside a batch', () => {
	const previous = setEffectMode('manual');
	const source = signal(0);
	let value = -1;
	const stop = effect(() => {
		value = source();
	});
	try {
		startBatch();
		try {
			source(1);
			expect(() => setEffectMode('sync')).not.toThrow();
			expect(value).toBe(0);
		} finally {
			endBatch();
		}
		expect(value).toBe(1);
	} finally {
		stop();
		flushEffects();
		setEffectMode(previous);
	}
});
