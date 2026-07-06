import { expect, test } from 'vitest';
import { makeMiniLib } from './helpers/miniLib';

declare const gc: (() => void) | undefined;

async function drainFinalizers(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		gc!();
		await new Promise((res) => setTimeout(res, 1));
	}
}

// An arena of 4096 records only fits repeated batches if records whose
// OWNERS were collected are reclaimed through the FinalizationRegistry.
// The mini library registers each handle closure as its node's owner.
test('records of collected owners are reclaimed', async () => {
	expect(typeof gc).toBe('function'); // vitest.config.ts sets --expose-gc
	const lib = makeMiniLib({ initialCapacity: 4096 });
	const makeBatch = () => {
		for (let i = 0; i < 400; i++) {
			const s = lib.signal(i);
			const c = lib.computed(() => s() + 1);
			c(); // links c -> s so reclamation must also release the edge
		}
	};
	for (let batch = 0; batch < 5; batch++) {
		makeBatch();
		await drainFinalizers();
		lib.signal(0); // boundary: sweep the pending free list
	}
});

test('an orphaned-but-subscribed node survives until unwatched', async () => {
	expect(typeof gc).toBe('function');
	const lib = makeMiniLib({ initialCapacity: 4096 });
	const s = lib.signal(1);
	let seen = 0;
	let stop: (() => void) | undefined;
	// The computed handle goes out of scope, but the effect subscribes:
	// the record must keep serving the graph until the last unlink.
	(() => {
		const c = lib.computed(() => s() * 10);
		stop = lib.effect(() => {
			seen = c();
		});
	})();
	await drainFinalizers();
	s(2);
	lib.drain();
	expect(seen).toBe(20); // orphaned computed still recomputes
	stop!();
});
