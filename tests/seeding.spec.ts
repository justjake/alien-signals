import { expect, test } from 'vitest';
import { createReactiveSystem } from '../src/system';

// Call-site seeding triggers on callback-shape DIVERSITY (per call-site
// family), not node count. Single-shape processes never seed and keep V8's
// full speculation; diverse processes seed as soon as a sampled shape
// differs from the first. stats().seeded observes the trigger.

const distinctGetter = (i: number) =>
	new Function(`return ${i} + 0`) as () => number;

test('a single-shape process never seeds, at any size', () => {
	const sys = createReactiveSystem({ initialRecords: 1 << 16 });
	const s = sys.makeSignal(0);
	const read = s as () => number;
	for (let i = 0; i < 200; i++) {
		const c = sys.makeComputed(() => read() + 1); // one shape, many mints
		sys.makeEffect(() => {
			(c as () => number)();
		});
	}
	expect(sys.stats().seeded).toBe(false);
});

test('diverse getter shapes trigger seeding', () => {
	const sys = createReactiveSystem({ initialRecords: 1 << 16 });
	for (let i = 0; i < 20; i++) {
		sys.makeComputed(distinctGetter(i));
	}
	expect(sys.stats().seeded).toBe(true);
});

test('diverse effect shapes trigger seeding independently of getters', () => {
	const sys = createReactiveSystem({ initialRecords: 1 << 16 });
	const s = sys.makeSignal(0);
	const read = s as () => number;
	for (let i = 0; i < 20; i++) {
		sys.makeComputed(() => read() + 1); // getters stay one shape
		sys.makeEffect(new Function('', `void ${i}`) as () => void);
	}
	expect(sys.stats().seeded).toBe(true);
});

test("seeding: 'off' never seeds despite diversity", () => {
	const sys = createReactiveSystem({ initialRecords: 1 << 16, seeding: 'off' });
	for (let i = 0; i < 20; i++) {
		sys.makeComputed(distinctGetter(i));
	}
	expect(sys.stats().seeded).toBe(false);
});

test("seeding: 'eager' seeds at materialization", () => {
	const sys = createReactiveSystem({ initialRecords: 1 << 16, seeding: 'eager' });
	sys.makeSignal(0); // materialize
	expect(sys.stats().seeded).toBe(true);
});

test('tiny arenas never seed (records would be a real bite)', () => {
	const sys = createReactiveSystem({ initialRecords: 512 });
	for (let i = 0; i < 20; i++) {
		sys.makeComputed(distinctGetter(i));
	}
	expect(sys.stats().seeded).toBe(false);
});
