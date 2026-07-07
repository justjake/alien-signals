// Benchmark workloads over the adapter interface. Each returns elapsed ms
// and retains its graph until the cell's worker is discarded.
export const BENCHES = [
	{
		key: 'create',
		label: 'create 20k signal→computed pairs',
		run(adapter) {
			const t0 = performance.now();
			const keep = [];
