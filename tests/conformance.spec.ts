import { describe, expect, test } from 'vitest';
import { testSuite, SkipTest, setExpect, type ReactiveFramework } from 'reactive-framework-test-suite';
import { computed, dispose, effect, effectScope, endBatch, get, set, setActiveSub, signal, startBatch } from '../src';

const framework: ReactiveFramework = {
	signal(initialValue) {
		const s = signal(initialValue);
		return {
			read: () => get(s),
			write: (v) => set(s, v),
		};
	},
	computed(fn) {
		const c = computed(fn);
		return { read: () => get(c) };
	},
	effect(fn) {
		const e = effect(fn);
		return () => dispose(e);
	},
	run(fn) {
		dispose(effectScope(fn));
	},
	batch(fn) {
		startBatch();
		try {
			fn();
		} finally {
			endBatch();
		}
	},
	untracked(fn) {
		const prev = setActiveSub(undefined);
		try {
			return fn();
		} finally {
			setActiveSub(prev);
		}
	},
};

setExpect(expect);

for (const { section, cases } of testSuite) {
	describe(section, () => {
		for (const [name, fn] of Object.entries(cases)) {
			test(name, () => {
				try {
					framework.run(() => fn(framework));
				} catch (e) {
					if (e instanceof SkipTest) return;
					throw e;
				}
			});
		}
	});
}
