// Pull a benchmark CI run's artifacts into this repo: copy the result CSVs
// under benchs/results/, regenerate the totals and per-test charts from
// them, rasterize to assets/, and rewrite the README's generated benchmark
// blocks (the regions between `<!-- benchmark:<name>:begin -->` and
// `<!-- benchmark:<name>:end -->`).
//
// Usage:
//   node benchs/ci/pull-run.mjs --run <run-id> [--repo justjake/alien-signals]
//                               [--dry] [--no-readme]
//
// --dry writes everything under /tmp/pull-run-<id>/ instead of the repo, so
// a run can be inspected before it replaces the published numbers. Requires
// the GitHub CLI (`gh`) authenticated for the repo, and a Chrome/Chromium
// binary for SVG -> PNG (override with $CHROME).
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES, parseResults, summarize } from '../lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	return args[i + 1];
};
const RUN = flag('--run');
const REPO = flag('--repo') ?? 'justjake/alien-signals';
const DRY = args.includes('--dry');
const NO_README = args.includes('--no-readme');
if (!RUN) {
	console.error('usage: node benchs/ci/pull-run.mjs --run <run-id> [--repo owner/name] [--dry] [--no-readme]');
	process.exit(1);
}

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outRoot = DRY ? join(tmpdir(), `pull-run-${RUN}`) : pkgRoot;
mkdirSync(join(outRoot, 'assets'), { recursive: true });
mkdirSync(join(outRoot, 'benchs/results'), { recursive: true });

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8' });

const meta = JSON.parse(gh('run', 'view', RUN, '--repo', REPO, '--json', 'headSha,createdAt,conclusion,displayTitle'));
if (meta.conclusion !== 'success') {
	console.error(`refusing to publish from run ${RUN}: conclusion is ${meta.conclusion}`);
	process.exit(1);
}
const sha7 = meta.headSha.slice(0, 7);
const date = meta.createdAt.slice(0, 10);

const dl = mkdtempSync(join(tmpdir(), 'pull-run-dl-'));
gh('run', 'download', RUN, '--repo', REPO, '--dir', dl);

// Artifact layout: benchmark-<runtime>/results-<runtime>.csv (+ CI-rendered
// svg/png, which we ignore — charts are regenerated here so subtitles and
// the per-test chart stay consistent).
const RUNTIME_LABEL = { node: 'Node (V8)', bun: 'Bun (JavaScriptCore)' };
const runtimes = readdirSync(dl).filter((d) => d.startsWith('benchmark-')).map((d) => d.slice('benchmark-'.length))
	.filter((r) => existsSync(join(dl, `benchmark-${r}`, `results-${r}.csv`)));
if (runtimes.length === 0) {
	console.error(`run ${RUN} has no benchmark-<runtime> artifacts with results CSVs`);
	process.exit(1);
}

function chrome() {
	if (process.env.CHROME) return process.env.CHROME;
	for (const c of [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
	]) if (existsSync(c)) return c;
	throw new Error('no Chrome/Chromium found; set $CHROME');
}

function renderPng(svgPath, pngPath) {
	const height = /height="(\d+)"/.exec(readFileSync(svgPath, 'utf8'))[1];
	const res = spawnSync(chrome(), [
		'--headless=new', '--no-sandbox', '--disable-gpu',
		`--screenshot=${pngPath}`, `--window-size=1080,${height}`,
		'--force-device-scale-factor=2', '--default-background-color=FFFFFFFF',
		`file://${resolve(svgPath)}`,
	], { stdio: 'ignore' });
	if (res.status !== 0 || !existsSync(pngPath)) throw new Error(`chrome render failed for ${svgPath}`);
}

const chart = (script, src, out, title, subtitle) => {
	execFileSync(process.execPath, [join(pkgRoot, 'benchs', script), src, out, title, subtitle], { stdio: 'inherit' });
};

const fmtMs = (v) => Math.round(v).toLocaleString('en-US');
let readme = readFileSync(join(pkgRoot, 'README.md'), 'utf8');

for (const rt of runtimes) {
	const label = RUNTIME_LABEL[rt] ?? rt;
	const suffix = rt === 'node' ? '' : `-${rt}`;
	const csvSrc = join(dl, `benchmark-${rt}`, `results-${rt}.csv`);
	const csvDest = join(outRoot, 'benchs/results', `${date}-ci-run${RUN}-${rt}.txt`);
	copyFileSync(csvSrc, csvDest);

	const subtitle = `js-reactivity-benchmark, ${label}: median of runs per test, interleaved isolated rounds - CI run ${RUN} @ ${sha7}, ${date} - lower is better`;
	const totalsSvg = join(dl, `totals-${rt}.svg`);
	const detailsSvg = join(dl, `details-${rt}.svg`);
	chart('chart.mjs', csvSrc, totalsSvg, 'Total benchmark time by framework', subtitle);
	chart('chartDetails.mjs', csvSrc, detailsSvg, 'Individual benchmark times', `${subtitle.replace(' - lower is better', '')}; per-panel scale - lower is better`);
	renderPng(totalsSvg, join(outRoot, 'assets', `benchmark${suffix}.png`));
	renderPng(detailsSvg, join(outRoot, 'assets', `benchmark-details${suffix}.png`));

	const { frameworks, partial } = summarize(parseResults(readFileSync(csvSrc, 'utf8')));
	if (partial.length) console.error(`note: excluded from ${rt} charts (crashed mid-suite): ${partial.join('; ')}`);

	const alt = frameworks.map((f) => `${f.fw} ${fmtMs(f.total)} ms`).join('; ');
	const table = [
		'| framework | sbench | kairo | cellx | dynamic | total |',
		'| --- | ---: | ---: | ---: | ---: | ---: |',
		...frameworks.map((f) => `| ${f.fw} | ${SUITES.map((s) => Math.round(f[s])).join(' | ')} | ${Math.round(f.total)} |`),
	].join('\n');
	const block = [
		`<img width="1080" alt="Total benchmark time by framework, ${label}: ${alt}" src="assets/benchmark${suffix}.png" />`,
		'',
		'<details>',
		`<summary>${label} suite totals (ms, lower is better) — CI run ${RUN} @ ${sha7}, ${date}</summary>`,
		'',
		table,
		'',
		`<img width="1080" alt="Individual benchmark times, ${label}, one panel per test" src="assets/benchmark-details${suffix}.png" />`,
		'',
		'</details>',
	].join('\n');

	const begin = new RegExp(`<!-- benchmark:${rt}:begin[^>]*-->`);
	const end = `<!-- benchmark:${rt}:end -->`;
	const m = begin.exec(readme);
	if (m === undefined || m === null || !readme.includes(end)) {
		console.error(`README has no benchmark:${rt} markers; skipping README update for ${rt}`);
		continue;
	}
	const head = readme.slice(0, m.index + m[0].length);
	const tail = readme.slice(readme.indexOf(end));
	readme = `${head}\n${block}\n${tail}`;
	console.log(`updated README block benchmark:${rt} (${frameworks.length} frameworks)`);
}

if (!NO_README) {
	writeFileSync(join(outRoot, 'README.md'), readme);
}
console.log(`done -> ${outRoot}${DRY ? ' (dry run; repo untouched)' : ''}`);
