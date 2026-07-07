// In-browser benchmarks. Every (workload, library) cell runs in a FRESH
// Worker: a new JavaScript realm with its own copies of every module — no
// JIT feedback, no arena, and no main-thread animation shared with the
// page or with other cells. This is the browser equivalent of the CI
// methodology's process-per-framework isolation. Numbers are still a
// single round on whatever machine is viewing the page: indicative; the
// README's CI runs are the scoreboard.
import { signal, effect } from 'dalien-signals';
import { ADAPTERS } from './adapters.js';
import { BENCHES } from './benchDefs.js';

const LIBS = Object.keys(ADAPTERS);
// Validated categorical palette (fixed order; color follows the library).
const COLORS = { 'dalien-signals': '#2a78d6', 'alien-signals': '#1baf7a', '@preact/signals-core': '#eda100', '@reactively/core': '#008300' };

function runCell(benchKey, lib) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./benchWorker.js', import.meta.url), { type: 'module' });
		const timeout = setTimeout(() => { worker.terminate(); reject(new Error('bench timeout')); }, 30000);
		worker.onmessage = (e) => {
			clearTimeout(timeout);
			worker.terminate();
			resolve(e.data.ms);
		};
		worker.onerror = (e) => {
			clearTimeout(timeout);
			worker.terminate();
			reject(e);
		};
		worker.postMessage({ benchKey, lib });
	});
}

export function mountBench(root) {
	const running = signal(false);
	const progress = signal('');
	const results = signal(null);

	root.innerHTML = `
		<div class="actions">
			<button id="bench-run">run benchmarks</button>
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
		try {
			for (const bench of BENCHES) {
				out[bench.key] = {};
				for (const lib of LIBS) {
					progress(`${bench.label} — ${lib}`);
					out[bench.key][lib] = await runCell(bench.key, lib);
					results({ ...out });
				}
			}
			progress('done — one fresh worker per cell, single round, this machine');
		} catch (err) {
			progress(`failed: ${err.message ?? err}`);
		}
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
			<p class="hint">bars: time ÷ fastest per test (lower is better) · absolute times labelled · each cell = a fresh worker realm — see the README's CI methodology for stable numbers</p>`;
	});
}
