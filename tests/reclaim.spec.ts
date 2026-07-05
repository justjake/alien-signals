import { expect, test } from 'vitest';
import { createReactiveSystem } from '../src/system';

declare const gc: (() => void) | undefined;

async function drainFinalizers(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		gc!();
		await new Promise((res) => setTimeout(res, 1));
	}
}

// A plane of 4096 records holds ~1300 signal+computed+link triples. Three
// batches only fit if records from collected handles are reclaimed; without
// the FinalizationRegistry path the third batch throws capacity-exhausted.
test('records of collected signal/computed handles are reclaimed', async () => {
	expect(typeof gc).toBe('function'); // vitest.config.ts sets --expose-gc
	const sys = createReactiveSystem({ initialRecords: 4096 });
	const makeBatch = () => {
		for (let i = 0; i < 400; i++) {
			const s = sys.makeSignal(i);
			const c = sys.makeComputed(() => (s() as number) + 1);
			c(); // links c -> s so reclamation must also release the edge
		}
	};
	for (let batch = 0; batch < 5; batch++) {
		makeBatch();
		await drainFinalizers();
		sys.makeSignal(0); // boundary: sweep the pending free list
	}
});

test('orphaned-but-subscribed computeds survive until unwatched', async () => {
	expect(typeof gc).toBe('function');
	const sys = createReactiveSystem({ initialRecords: 4096 });
	const s = sys.makeSignal(1);
	let dispose: (() => void) | undefined;
	// The computed handle goes out of scope, but the effect subscribes to it:
	// the record must keep serving the graph.
	(() => {
		const c = sys.makeComputed(() => (s() as number) * 10);
		dispose = sys.makeEffect(() => {
			c();
		});
	})();
	await drainFinalizers();
	let observed = 0;
	const stop = sys.makeEffect(() => {
		observed = s() as number;
	});
	s(5); // propagates THROUGH the orphaned computed: must not be freed
	expect(observed).toBe(5);
	dispose!();
	stop();
	await drainFinalizers();
	sys.makeSignal(0); // boundary sweep; reclaim after last unlink must not throw
});

