// Benchmark workloads over the adapter interface. Each returns elapsed ms
// and retains its graph until the cell's worker is discarded.
export const BENCHES = [
	{
		key: 'create',
		label: 'create 20k signal→computed pairs',
		run(adapter) {
			const t0 = performance.now();
			const keep = [];
			for (let i = 0; i < 20000; i++) {
				const s = adapter.signal(i);
				const c = adapter.computed(() => s.read() + 1);
				c.read();
				keep.push(s, c);
			}
			return { ms: performance.now() - t0, keep };
		},
	},
	{
		key: 'deep',
		label: 'deep chain ×400, 2k writes',
		run(adapter) {
			const src = adapter.signal(0);
			let prev = src;
			for (let i = 0; i < 400; i++) {
				const p = prev;
				prev = adapter.computed(() => p.read() + 1);
			}
			const tail = prev;
			tail.read();
			const t0 = performance.now();
			for (let k = 0; k < 2000; k++) {
				src.write(k);
				tail.read();
			}
			return { ms: performance.now() - t0, keep: [src, tail] };
		},
	},
	{
		key: 'broad',
		label: 'fan-out ×2,000, 500 writes',
		run(adapter) {
			const src = adapter.signal(0);
			const subs = [];
			for (let i = 0; i < 2000; i++) {
				subs.push(adapter.computed(() => src.read() * 2 + i));
			}
			for (const c of subs) c.read();
			const t0 = performance.now();
			for (let k = 0; k < 500; k++) {
				src.write(k);
				for (const c of subs) c.read();
			}
			return { ms: performance.now() - t0, keep: [src, subs] };
		},
	},
	{
		key: 'cone',
		label: 'field cones: 96×54 grid, 2k writes',
		run(adapter) {
			const W = 96;
			const H = 54;
			const rows = [[]];
			for (let i = 0; i < W; i++) rows[0].push(adapter.signal(0));
			for (let r = 1; r < H; r++) {
				const above = rows[r - 1];
				const row = [];
				for (let i = 0; i < W; i++) {
					const a = above[(i - 1 + W) % W].read;
					const b = above[i].read;
					const c = above[(i + 1) % W].read;
					row.push(adapter.computed(() => a() * 0.24 + b() * 0.5 + c() * 0.24));
				}
				rows.push(row);
			}
			const bottom = rows[H - 1];
			for (const c of bottom) c.read();
			const t0 = performance.now();
			for (let k = 0; k < 2000; k++) {
				rows[0][k % W].write((k % 7) / 7);
				for (const c of bottom) c.read();
			}
			return { ms: performance.now() - t0, keep: rows };
		},
	},
];
