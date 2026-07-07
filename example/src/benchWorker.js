// One benchmark cell per worker lifetime. The worker is created fresh for
// every (workload, library) pair and terminated afterwards, so each cell
// gets untrained modules and, for dalien-signals, a fresh arena.
import { ADAPTERS } from './adapters.js';
import { BENCHES } from './benchDefs.js';

self.onmessage = (e) => {
	const { benchKey, lib } = e.data;
	const bench = BENCHES.find((b) => b.key === benchKey);
	const { ms } = bench.run(ADAPTERS[lib]);
	self.postMessage({ ms });
};
