import { describe, expect, it } from 'vitest';
import { effectScope, growCapacity, isSignal, signal, signalId } from '../src/index.js';

// A scope disposal queues its region for a deferred (microtask) flush.
// Arena growth between the queuing and the flush replaces the host
// generation; the flush state (live extent + scheduled flag) is shared
// across generations, so the pre-growth flush drains everything and the
// post-growth generation starts from an empty queue. A generation-local
// copy of that state made the post-growth flush re-read cleared slots:
// TypeError on region.length, thrown from a microtask (uncatchable by
// callers — it killed the example site's sbench benchmark worker).
describe('deferred region flush across arena growth', () => {
	it('drains regions queued before and after growth without throwing', async () => {
		const uncaught: unknown[] = [];
		const onUncaught = (err: unknown) => {
			uncaught.push(err);
		};
		process.on('uncaughtException', onUncaught);
		try {
			const preIds: number[] = [];
			const stopPre = effectScope(() => {
				for (let i = 0; i < 64; i++) {
					preIds.push(signalId(i));
				}
			});
			stopPre(); // queues the region; flush is a microtask away

			// Doubles the default capacity: growth replaces the host generation.
			growCapacity(1 << 22);

			const postIds: number[] = [];
			const stopPost = effectScope(() => {
				for (let i = 0; i < 64; i++) {
					postIds.push(signalId(i));
				}
			});
			stopPost(); // queues into the same shared queue, post-growth

			// Let both scheduled flushes (and the maintenance boundary) run.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(uncaught).toEqual([]);
			// Both regions actually freed: every member is dead.
			for (const id of [...preIds, ...postIds]) {
				expect(isSignal(id as never)).toBe(false);
			}
			// The system still works.
			const s = signal(1);
			s(2);
			expect(s()).toBe(2);
		} finally {
			process.off('uncaughtException', onUncaught);
		}
	});
});
