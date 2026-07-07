// In-browser benchmarks: the milomg fork's actual suites (sbench, kairo,
// cellx, dynamic) over its actual framework adapters. Every (suite,
// library) cell runs in a FRESH Worker — a new realm with untrained
// modules and, for dalien-signals, a fresh arena — the browser analogue of
// the CI methodology's process-per-framework isolation. One round on the
// viewing machine: indicative; the README's CI runs are the scoreboard.
import { signal, effect } from 'dalien-signals';

const LIBS = ['dalien-signals', 'alien-signals', '@preact/signals-core', '@reactively/core'];
const SUITES = [
	{ key: 'sbench', label: 'sbench: create & update' },
	{ key: 'kairo', label: 'kairo: propagation shapes' },
	{ key: 'cellx', label: 'cellx: layered grids' },
	{ key: 'dynamic', label: 'dynamic: changing graphs' },
];
// Validated categorical palette (fixed order; color follows the library).
const COLORS = { 'dalien-signals': '#2a78d6', 'alien-signals': '#1baf7a', '@preact/signals-core': '#eda100', '@reactively/core': '#008300' };

function runCell(suite, lib, onTest) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./benchWorker.js', import.meta.url), { type: 'module' });
		const timeout = setTimeout(() => { worker.terminate(); reject(new Error('timeout')); }, 300000);
		worker.onmessage = (e) => {
			if (e.data.type === 'test') {
				onTest(e.data);
			} else if (e.data.type === 'done') {
				clearTimeout(timeout);
				worker.terminate();
				resolve(e.data.totalMs);
			} else {
				clearTimeout(timeout);
				worker.terminate();
				reject(new Error(e.data.message));
			}
		};
		worker.onerror = (err) => {
			clearTimeout(timeout);
			worker.terminate();
			reject(err);
		};
		worker.postMessage({ suite, lib });
	});
}

export function mountBench(root) {
	const running = signal(false);
	const progress = signal('');
	const results = signal(null); // { suiteKey: { libName: totalMs } }

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
		const failures = [];
		for (const suite of SUITES) {
			out[suite.key] = {};
			for (const lib of LIBS) {
				progress(`${suite.label} — ${lib}`);
				// A cell failure (a worker can overflow its stack where the
				// same suite passes under Node) skips that bar, not the run.
				try {
					out[suite.key][lib] = await runCell(suite.key, lib, (t) => {
						progress(`${suite.label} — ${lib} — ${t.test}: ${t.time.toFixed(0)} ms`);
					});
				} catch (err) {
					failures.push(`${suite.key}/${lib.replace('@preact/signals-core', 'preact').replace('@reactively/core', 'reactively')}: ${err.message ?? err}`);
				}
				results({ ...out });
			}
		}
		progress(`done — one fresh worker per cell, single round, this machine${failures.length ? ` · skipped ${failures.join(' · ')}` : ''}`);
		running(false);
	});

	const chartEl = root.querySelector('#bench-chart');
	effect(() => {
		const res = results();
		if (!res) {
			chartEl.innerHTML = '';
			return;
		}
		const groups = SUITES.filter((s2) => res[s2.key] && Object.keys(res[s2.key]).length);
		const rowH = 22;
		const groupPad = 34;
		let y = 8;
		let body = '';
		for (const suite of groups) {
			const times = res[suite.key];
			const best = Math.min(...Object.values(times));
			body += `<text class="bench-name" x="0" y="${y + 12}">${suite.label} — suite total</text>`;
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
		chartEl.innerHTML = `<svg viewBox="0 0 760 ${y}" role="img" aria-label="Suite totals by library; bars show time relative to the fastest library per suite, lower is better">${body}</svg>
			<p class="hint">bars: suite total ÷ fastest (lower is better) · absolute totals labelled · each cell = a fresh worker realm, single round — the README's CI runs interleaved rounds and reports medians</p>`;
	});
}
