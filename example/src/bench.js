// In-browser benchmarks over the shared adapter interface. Single-round
// numbers from whatever machine is viewing the page: indicative, not
// publication-grade — the README's CI methodology (interleaved rounds,
// per-test medians, isolated processes) is the real scoreboard. The value
// here is immediacy: the same code, on your hardware, right now.
import { signal, computed, effect } from 'dalien-signals';
import { ADAPTERS } from './adapters.js';

const LIBS = Object.keys(ADAPTERS);
// Validated categorical palette (fixed order; color follows the library).
const COLORS = { 'dalien-signals': '#2a78d6', 'alien-signals': '#1baf7a', '@preact/signals-core': '#eda100', '@reactively/core': '#008300' };

const BENCHES = [
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

const yield_ = () => new Promise((r) => setTimeout(r, 30));

export function mountBench(root) {
	const running = signal(false);
	const progress = signal('');
	const results = signal(null); // { benchKey: { libName: ms } }

	root.innerHTML = `
		<div class="actions">
			<button id="bench-run">run benchmarks in this tab</button>
			<span id="bench-progress" class="hint"></span>
		</div>
		<div id="bench-chart"></div>`;

	const btn = root.querySelector('#bench-run');
	effect(() => { btn.disabled = running(); });
	effect(() => { root.querySelector('#bench-progress').textContent = progress(); });

	btn.addEventListener('click', async () => {
		if (running()) return;
		running(true);
		const out = {};
		for (const bench of BENCHES) {
			out[bench.key] = {};
			for (const lib of LIBS) {
				progress(`${bench.label} — ${lib}`);
				await yield_();
				const { ms } = bench.run(ADAPTERS[lib]);
				out[bench.key][lib] = ms;
				results({ ...out });
			}
		}
		progress('done — single round, this machine, this tab');
		running(false);
	});

	const chartEl = root.querySelector('#bench-chart');
	effect(() => {
		const res = results();
		if (!res) {
			chartEl.innerHTML = '';
			return;
		}
		const groups = BENCHES.filter((b) => res[b.key]);
		const rowH = 22;
		const groupPad = 34;
		let y = 8;
		let body = '';
		for (const bench of groups) {
			const times = res[bench.key];
			const best = Math.min(...Object.values(times));
			body += `<text class="bench-name" x="0" y="${y + 12}">${bench.label}</text>`;
			y += 20;
			for (const lib of LIBS) {
				if (!(lib in times)) continue;
				const ratio = times[lib] / best;
				const w = Math.min(520, (ratio / 3) * 520);
				body += `<rect x="150" y="${y + 4}" width="${w}" height="14" rx="4" fill="${COLORS[lib]}"></rect>
					<text class="lib" x="144" y="${y + 15}">${lib.replace('@preact/signals-core', 'preact').replace('@reactively/core', 'reactively')}</text>
					<text class="val" x="${156 + w}" y="${y + 15}">${times[lib].toFixed(0)} ms · ${ratio.toFixed(2)}×</text>`;
				y += rowH;
			}
			y += groupPad - rowH + 8;
		}
		chartEl.innerHTML = `<svg viewBox="0 0 760 ${y}" role="img" aria-label="Benchmark times by library; bars show time relative to the fastest library per test, lower is better">${body}</svg>
			<p class="hint">bars: time ÷ fastest per test (lower is better) · absolute times labelled · single round in this tab — see the README's CI methodology for stable numbers</p>`;
	});
}
