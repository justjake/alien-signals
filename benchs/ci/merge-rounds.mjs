// Merge per-round benchmark CSVs into one median CSV. Each input is a
// COMPLETE interleaved round run on its own machine (a block, in the
// experimental-design sense): comparisons inside a round share hardware, and
// taking the per-test median ACROSS rounds keeps cross-framework ratios
// honest because machine speed shifts every framework in a block together.
// What would NOT be valid is sharding frameworks across machines — that
// difference is why the workflow parallelizes rounds and nothing else.
//
// Usage: node merge-rounds.mjs <out.csv> <round1.csv> <round2.csv> ...
import { readFileSync, writeFileSync } from 'node:fs';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
	console.error('usage: node merge-rounds.mjs <out.csv> <round.csv>...');
	process.exit(1);
}

const WIDTHS = { framework: 32, test: 60, time: 8 };
const pad = (value, width) => String(value).slice(0, width).padEnd(width);
const row = (framework, test, time) => [pad(framework, WIDTHS.framework), pad(test, WIDTHS.test), pad(time, WIDTHS.time)].join(' , ');

const samples = new Map(); // "fw,test" -> number[]; insertion order preserved
for (const path of inputs) {
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const parts = line.split(',').map((p) => p.trim());
		// Rounds from the fork carry additive memory columns after time. The
		// merged CSV stays timing-only for now (charts don't read memory yet);
		// the per-round artifacts keep the full rows.
		if (parts.length < 3 || parts[0] === 'framework' || !Number.isFinite(Number(parts[2]))) continue;
		const key = `${parts[0]},${parts[1]}`;
		if (!samples.has(key)) samples.set(key, []);
		samples.get(key).push(Number(parts[2]));
	}
}
if (samples.size === 0) {
	console.error('no benchmark rows found in inputs');
	process.exit(1);
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const lines = [row('framework', 'test', 'time')];
for (const [key, xs] of samples) {
	const [framework, test] = key.split(',');
	if (xs.length < inputs.length) {
		console.error(`note: ${framework} / ${test}: ${xs.length}/${inputs.length} rounds (crashed elsewhere)`);
	}
	lines.push(row(framework, test, median(xs).toFixed(2)));
}
writeFileSync(out, lines.join('\n') + '\n');
console.error(`merged ${inputs.length} rounds, ${samples.size} rows -> ${out}`);
