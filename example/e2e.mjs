// End-to-end verification of the built example against a real Chrome.
//
// Usage: pnpm run build && pnpm run e2e
//    or: node e2e.mjs http://127.0.0.1:4173/   (verify an already-running server)
//
// Without a URL argument the script serves the existing dist/ with
// `vite preview` on a free port; it never builds. Playwright drives the
// system Chrome (`channel: 'chrome'`) so no browser download is required;
// set PW_CHANNEL or PW_EXECUTABLE to point at a different Chrome. Exits
// non-zero with a message on the first failed check, prints a PASS
// summary otherwise.
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const exampleDir = path.dirname(fileURLToPath(import.meta.url));

// Expected shapes mirror src/graph.js: nodes = cells + quantize + epoch.
// Deep bands (even indexes) keep one signal per source-row pixel; wide
// bands (odd indexes) keep hubCount(w) hub signals. Every other cell is a
// computed, and a full-field pass (epoch bump, quantize toggle) recomputes
// each computed exactly once.
const BAND = 64;
const HUB_SPACING = 32;
const hubCount = (w) => Math.max(2, Math.round(w / HUB_SPACING) + 1);
const TIERS = { '320p': [568, 320], '480p': [854, 480], '720p': [1280, 720] };
const tierNodes = (tier) => TIERS[tier][0] * TIERS[tier][1] + 2;
const tierComputeds = (tier) => {
	const [w, h] = TIERS[tier];
	const bands = Math.ceil(h / BAND);
	const signals = w * Math.ceil(bands / 2) + hubCount(w) * Math.floor(bands / 2);
	return w * h - signals;
};

const BARS = ['lib-bar', 'tier-bar', 'mode-bar'];
const BUILD_TIMEOUT_MS = 180_000; // rebuilds create one node + one effect per pixel
const POLL_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digits = (text) => Number(text.replace(/[^0-9]/g, ''));

class CheckFailure extends Error {}
const die = (message) => { throw new CheckFailure(message); };

// ---- preview server ---------------------------------------------------------------

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function startPreview() {
	if (!existsSync(path.join(exampleDir, 'dist', 'index.html'))) {
		die('no dist/index.html — run `pnpm run build` first');
	}
	const port = await freePort();
	const url = `http://127.0.0.1:${port}/`;
	const child = spawn(
		path.join(exampleDir, 'node_modules', '.bin', 'vite'),
		['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
		{ cwd: exampleDir, stdio: ['ignore', 'ignore', 'pipe'] },
	);
	let stderr = '';
	child.stderr.on('data', (chunk) => { stderr += chunk; });
	const deadline = Date.now() + 15_000;
	for (;;) {
		if (child.exitCode !== null) die(`vite preview exited with code ${child.exitCode}: ${stderr.trim()}`);
		try {
			const response = await fetch(url);
			if (response.ok) break;
		} catch {
			// not accepting connections yet
		}
		if (Date.now() > deadline) die(`vite preview did not serve ${url} within 15s: ${stderr.trim()}`);
		await sleep(POLL_MS);
	}
	return { url, child };
}

// ---- page probes ------------------------------------------------------------------

const noteText = (page) => page.evaluate(() => document.getElementById('note').textContent);
const statText = (page, id) => page.evaluate((statId) => document.getElementById(statId).textContent, id);

// The activity log: frozen history lines plus the always-updating live
// average line under them.
const readActivity = (page) => page.evaluate(() => ({
	lines: [...document.querySelectorAll('#activity-log div')].map((div) => div.textContent),
	live: document.getElementById('activity-live').textContent,
}));

// Each bar dumped as its buttons' data-v values, the active one marked `value*`.
function readBars(page) {
	return page.evaluate((barIds) => barIds.map((id) => {
		const buttons = [...document.getElementById(id).querySelectorAll('button[data-v]')];
		const active = buttons.filter((b) => b.classList.contains('on'));
		return {
			id,
			dump: buttons.map((b) => b.dataset.v + (b.classList.contains('on') ? '*' : '')).join(' '),
			activeCount: active.length,
			active: active.length === 1 ? active[0].dataset.v : null,
		};
	}), BARS);
}

// The radio invariant is group-wide: exactly one `.on` per bar, on the
// expected button, no matter how the clicks were interleaved.
async function assertBars(page, expected) {
	const bars = await readBars(page);
	const dumps = bars.map((b) => `${b.id}[${b.dump}]`).join(' ');
	for (const bar of bars) {
		if (bar.activeCount !== 1) die(`${bar.id} has ${bar.activeCount} active buttons, want exactly 1 — ${dumps}`);
		const want = expected[bar.id];
		if (bar.active !== want) die(`${bar.id} active is ${bar.active}, want ${want} — ${dumps}`);
	}
	return dumps;
}

const clickButton = (page, barId, value) => page.click(`#${barId} button[data-v="${value}"]`);

// Dispatch every click inside one page task: no rAF can fire between
// them, so this is the tightest interleaving the UI can ever see.
function rapidClicks(page, barId, values) {
	return page.evaluate(([id, vs]) => {
		for (const v of vs) {
			document.querySelector(`#${id} button[data-v="${v}"]`).click();
		}
	}, [barId, values]);
}

// Rebuild completion is announced through #note; poll for the exact
// (library, tier) pair so a stale build note is never mistaken for the
// one being awaited.
async function awaitBuildNote(page, lib, tier) {
	const pattern = /^(.+) @ (\d+p): ([\d,]+) nodes built in ([\d.]+) ms$/;
	const deadline = Date.now() + BUILD_TIMEOUT_MS;
	for (;;) {
		const text = await noteText(page);
		const match = text.match(pattern);
		if (match && match[1] === lib && match[2] === tier) {
			const nodes = digits(match[3]);
			if (nodes !== tierNodes(tier)) die(`${lib} @ ${tier} built ${nodes} nodes, want ${tierNodes(tier)}`);
			return text;
		}
		if (Date.now() > deadline) die(`timed out waiting for "${lib} @ ${tier} … built in" note; note is "${text}"`);
		await sleep(POLL_MS);
	}
}

// A full-field pass posts "<n> recomputes in <ms> ms" and must not
// rebuild: same note shape check and node-count identity in one place.
async function assertTimedPass(page, label, expectedRecomputes) {
	const nodesBefore = digits(await statText(page, 'stat-nodes'));
	await page.click(`#${label}`);
	const text = await noteText(page);
	const match = text.match(/^([\d,]+) recomputes in ([\d.]+) ms$/);
	if (!match) die(`#${label} did not post a timed pass; note is "${text}"`);
	const recomputes = digits(match[1]);
	if (recomputes < 1) die(`#${label} reported ${recomputes} recomputes`);
	if (expectedRecomputes !== undefined && recomputes !== expectedRecomputes) {
		die(`#${label} reported ${recomputes} recomputes, want ${expectedRecomputes}`);
	}
	const nodesAfter = digits(await statText(page, 'stat-nodes'));
	if (nodesAfter !== nodesBefore) die(`#${label} changed the node count ${nodesBefore} -> ${nodesAfter}: it rebuilt`);
	return text;
}

// Sample the canvas coarsely: `lit` counts sampled pixels above the
// near-black floor (the field's base ramp is navy, so a painted frame is
// almost entirely lit), and `checksum` folds in enough bytes that any
// animated frame differs from the last.
function sampleCanvas(page) {
	return page.evaluate(() => {
		const canvas = document.getElementById('grid');
		const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
		let sampled = 0;
		let lit = 0;
		let checksum = 0;
		for (let p = 0; p + 2 < data.length; p += 4 * 97) { // 97 is co-prime with every tier width
			sampled += 1;
			if (data[p] + data[p + 1] + data[p + 2] > 12) lit += 1;
		}
		for (let p = 0; p < data.length; p += 31) {
			checksum = (checksum * 33 + data[p]) >>> 0;
		}
		return { width: canvas.width, height: canvas.height, sampled, lit, checksum };
	});
}

// The first painted frame lands one rAF tick after the build note is
// posted, so a paint assertion has to poll rather than sample once.
async function awaitPaint(page) {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const sample = await sampleCanvas(page);
		if (sample.sampled > 0 && sample.lit / sample.sampled >= 0.9) return sample;
		if (Date.now() > deadline) {
			die(`canvas stayed unpainted: ${sample.lit}/${sample.sampled} sampled pixels non-black after 10s`);
		}
		await sleep(POLL_MS);
	}
}

// ---- checks -----------------------------------------------------------------------

async function run(page, url) {
	const results = [];
	const pageErrors = [];
	page.on('pageerror', (err) => pageErrors.push(String(err)));

	const check = async (label, body) => {
		const detail = await body();
		// Page errors fail the run at the step that provoked them, not in a
		// blanket sweep at the end, so the summary names the culprit.
		if (pageErrors.length > 0) die(`page error during "${label}": ${pageErrors.join(' | ')}`);
		results.push(`${label}: ${detail}`);
	};

	await check('boot', async () => {
		await page.goto(url, { waitUntil: 'load' });
		const note = await awaitBuildNote(page, 'dalien-signals', '320p');
		await assertBars(page, { 'lib-bar': 'dalien-signals', 'tier-bar': '320p', 'mode-bar': 'wave' });
		return note;
	});

	await check('canvas paints at 320p', async () => {
		const s = await awaitPaint(page);
		if (s.width !== 568 || s.height !== 320) die(`canvas is ${s.width}x${s.height}, want 568x320`);
		return `${s.width}x${s.height}, ${s.lit}/${s.sampled} sampled pixels lit`;
	});

	await check('activity log: boot setup line and live average', async () => {
		const log = await readActivity(page);
		const setup = log.lines.find((line) => /^dalien-signals: graph setup \d+ ms$/.test(line));
		if (!setup) die(`no boot setup line; log is [${log.lines.join(' | ')}]`);
		if (!/^dalien-signals: avg frame time \d+(\.\d+)? ms$/.test(log.live)) {
			die(`live line is "${log.live}", want a dalien-signals average`);
		}
		return `${setup}; live "${log.live}"`;
	});

	await check('mode radio: single clicks', async () => {
		await clickButton(page, 'mode-bar', 'storm');
		await assertBars(page, { 'lib-bar': 'dalien-signals', 'tier-bar': '320p', 'mode-bar': 'storm' });
		await clickButton(page, 'mode-bar', 'wave');
		return assertBars(page, { 'lib-bar': 'dalien-signals', 'tier-bar': '320p', 'mode-bar': 'wave' });
	});

	await check('mode radio: rapid clicks', async () => {
		await rapidClicks(page, 'mode-bar', ['off', 'storm', 'off', 'wave']);
		return assertBars(page, { 'lib-bar': 'dalien-signals', 'tier-bar': '320p', 'mode-bar': 'wave' });
	});

	await check('tier radio: rapid clicks', async () => {
		await rapidClicks(page, 'tier-bar', ['480p', '320p', '480p']);
		// The invariant must hold immediately, while the rebuild is still pending…
		await assertBars(page, { 'lib-bar': 'dalien-signals', 'tier-bar': '480p', 'mode-bar': 'wave' });
		await awaitBuildNote(page, 'dalien-signals', '480p');
		// …and again after the last-selected tier finishes building.
		return assertBars(page, { 'lib-bar': 'dalien-signals', 'tier-bar': '480p', 'mode-bar': 'wave' });
	});

	await check('lib radio: rapid clicks', async () => {
		await rapidClicks(page, 'lib-bar', ['alien-signals', '@preact/signals-core']);
		await assertBars(page, { 'lib-bar': '@preact/signals-core', 'tier-bar': '480p', 'mode-bar': 'wave' });
		await awaitBuildNote(page, '@preact/signals-core', '480p');
		const dumps = await assertBars(page, { 'lib-bar': '@preact/signals-core', 'tier-bar': '480p', 'mode-bar': 'wave' });
		await clickButton(page, 'lib-bar', 'dalien-signals');
		await awaitBuildNote(page, 'dalien-signals', '480p');
		return dumps;
	});

	await check('tier switch to 720p', async () => {
		await clickButton(page, 'tier-bar', '720p');
		const note = await awaitBuildNote(page, 'dalien-signals', '720p');
		const nodes = digits(await statText(page, 'stat-nodes'));
		if (nodes !== tierNodes('720p')) die(`#stat-nodes shows ${nodes}, want ${tierNodes('720p')}`);
		await assertBars(page, { 'lib-bar': 'dalien-signals', 'tier-bar': '720p', 'mode-bar': 'wave' });
		return note;
	});

	await check('equality cutoff: timed pass, no rebuild', async () => {
		const note = await assertTimedPass(page, 'btn-cutoff');
		const label = await statText(page, 'btn-cutoff');
		if (label !== 'equality cutoff: off') die(`cutoff label is "${label}", want "equality cutoff: off"`);
		return note;
	});

	await check('invalidate everything: full-field recompute', () =>
		assertTimedPass(page, 'btn-invalidate', tierComputeds('720p')));

	await check('equality cutoff: restore', async () => {
		const note = await assertTimedPass(page, 'btn-cutoff');
		const label = await statText(page, 'btn-cutoff');
		if (label !== 'equality cutoff: on') die(`cutoff label is "${label}", want "equality cutoff: on"`);
		return note;
	});

	await check('tier back to 320p', async () => {
		await clickButton(page, 'tier-bar', '320p');
		return awaitBuildNote(page, 'dalien-signals', '320p');
	});

	await check('library switch to alien-signals', async () => {
		await clickButton(page, 'lib-bar', 'alien-signals');
		const note = await awaitBuildNote(page, 'alien-signals', '320p');
		await assertBars(page, { 'lib-bar': 'alien-signals', 'tier-bar': '320p', 'mode-bar': 'wave' });
		return note;
	});

	await check('alien-signals animates', async () => {
		const before = await awaitPaint(page);
		await sleep(500);
		const after = await sampleCanvas(page);
		if (before.checksum === after.checksum) die('canvas checksum unchanged over 500 ms: not animating');
		const deadline = Date.now() + 5_000;
		let recomputed = 0;
		while ((recomputed = digits(await statText(page, 'stat-recomputed'))) === 0) {
			if (Date.now() > deadline) die('#stat-recomputed stayed 0: the wave writes are not recomputing cells');
			await sleep(POLL_MS);
		}
		return `checksum ${before.checksum} -> ${after.checksum}, ${recomputed} recomputed last frame`;
	});

	await check('activity log narrates the framework switch', async () => {
		const log = await readActivity(page);
		// The switch to alien-signals was the last rebuild, so its narration
		// is the log's tail: frozen average, change line, teardown, setup.
		const tail = log.lines.slice(-4);
		const want = [
			/^dalien-signals: avg frame time \d+(\.\d+)? ms$/,
			/^framework changed to alien-signals$/,
			/^dalien-signals: graph teardown (\d+) ms$/,
			/^alien-signals: graph setup (\d+) ms$/,
		];
		for (let k = 0; k < want.length; k++) {
			if (!want[k].test(tail[k] ?? '')) {
				die(`log tail line ${k} is "${tail[k]}", want ${want[k]} — log is [${log.lines.join(' | ')}]`);
			}
		}
		const setupMs = digits(tail[3].match(want[3])[1]);
		if (setupMs < 1 || setupMs > BUILD_TIMEOUT_MS) die(`setup time ${setupMs} ms is not plausible`);
		const liveMatch = log.live.match(/^alien-signals: avg frame time (\d+(\.\d+)?) ms$/);
		if (!liveMatch) die(`live line is "${log.live}", want an alien-signals average`);
		if (!(Number(liveMatch[1]) > 0)) die(`live average is ${liveMatch[1]} ms after 500 ms of animation`);
		// Many rebuilds have happened by now; the history must be capped at
		// its limit, with the live line making ~10 visible entries.
		if (log.lines.length !== 9) die(`log holds ${log.lines.length} frozen lines, want the 9-line cap`);
		return `${tail.join(' | ')}; live "${log.live}"`;
	});

	await check('sticky selection survives reload', async () => {
		await clickButton(page, 'tier-bar', '720p');
		await awaitBuildNote(page, 'alien-signals', '720p');
		await page.reload({ waitUntil: 'load' });
		const note = await awaitBuildNote(page, 'alien-signals', '720p');
		const dumps = await assertBars(page, { 'lib-bar': 'alien-signals', 'tier-bar': '720p', 'mode-bar': 'wave' });
		return `${note} — ${dumps}`;
	});

	return results;
}

// ---- entry ------------------------------------------------------------------------

async function main() {
	const givenUrl = process.argv[2];
	const preview = givenUrl ? null : await startPreview();
	const url = givenUrl ?? preview.url;

	// System Chrome by default: the repo intentionally carries no browser
	// binaries. PW_EXECUTABLE (a path) wins over PW_CHANNEL (a channel name).
	const executablePath = process.env.PW_EXECUTABLE;
	const browser = await chromium.launch(
		executablePath ? { headless: true, executablePath } : { headless: true, channel: process.env.PW_CHANNEL ?? 'chrome' },
	);

	try {
		const page = await browser.newPage();
		const results = await run(page, url);
		console.log(`PASS example e2e — ${results.length} checks against ${url}`);
		for (const line of results) console.log(`  ${line}`);
	} finally {
		await browser.close();
		preview?.child.kill('SIGTERM');
	}
}

main().catch((err) => {
	console.error(err instanceof CheckFailure ? `FAIL example e2e — ${err.message}` : err);
	process.exit(1);
});
