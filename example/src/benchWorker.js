// One (suite, library) cell per worker lifetime: a fresh realm per cell, so
// no library inherits JIT feedback, arena contents, or main-thread work
// from the page or from other cells. The suites are the milomg fork's own,
// imported from the harness source — the code CI runs.
import { sbench } from '../../../../milomg-reactivity-benchmark/packages/core/src/benches/sBench.ts';
import { kairoBench } from '../../../../milomg-reactivity-benchmark/packages/core/src/benches/kairoBench.ts';
import { cellxbench } from '../../../../milomg-reactivity-benchmark/packages/core/src/benches/cellxBench.ts';
import { dynamicBench } from '../../../../milomg-reactivity-benchmark/packages/core/src/benches/reactively/dynamicBench.ts';
import { FRAMEWORKS } from './milomgFrameworks.js';

const SUITES = {
	sbench: (fw, log) => sbench(fw, log),
	kairo: (fw, log) => kairoBench([{ framework: fw, testPullCounts: true }], log),
	cellx: (fw, log) => cellxbench([{ framework: fw, testPullCounts: true }], log),
	dynamic: (fw, log) => dynamicBench([{ framework: fw, testPullCounts: true }], log),
};

self.onmessage = async (e) => {
	const { suite, lib } = e.data;
	const framework = FRAMEWORKS[lib];
	let total = 0;
	try {
		await SUITES[suite](framework, (result) => {
			total += result.time;
			self.postMessage({ type: 'test', test: result.test, time: result.time });
		});
		self.postMessage({ type: 'done', totalMs: total });
	} catch (err) {
		self.postMessage({ type: 'error', message: String(err?.message ?? err) });
	}
};
