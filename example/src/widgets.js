// The explainer's live widgets. Each one follows the same discipline as the
// library it demonstrates: state lives in signals, the DOM is written only
// by effects, and event handlers do nothing but write state.
import { signal, computed, effect } from 'dalien-signals';
import { makeInspectableSystem, NODE_SLOTS, LINK_SLOTS, FLAG_BITS, kindOf } from './inspector.js';

// ---- 1. the three primitives, live -------------------------------------------

export function mountCounter(root) {
	const count = signal(1);
	const doubled = computed(() => count() * 2);
	const isEven = computed(() => count() % 2 === 0);
	const effectRuns = signal(0);

	root.innerHTML = `
		<div class="counter">
			<button data-step="-1">−</button>
			<div class="cell"><label>signal count</label><output id="c-count"></output></div>
			<button data-step="1">+</button>
			<div class="cell"><label>computed count × 2</label><output id="c-doubled"></output></div>
			<div class="cell"><label>computed even?</label><output id="c-even"></output></div>
			<div class="cell"><label>effect runs</label><output id="c-runs"></output></div>
		</div>`;
	root.addEventListener('click', (e) => {
		const step = Number(e.target.dataset?.step);
		if (step) count(count() + step);
	});
	const out = (id) => root.querySelector('#' + id);
	effect(() => { out('c-count').textContent = count(); });
	effect(() => { out('c-doubled').textContent = doubled(); });
	effect(() => { out('c-even').textContent = isEven() ? 'yes' : 'no'; });
	// This effect reads both computeds, so it re-runs when either one
	// produces a NEW value — stepping 1 → 3 changes doubled but not even?,
	// and the even? column's own effect stays asleep.
	effect(() => { doubled(); isEven(); effectRuns(effectRuns() + 1); });
	effect(() => { out('c-runs').textContent = effectRuns(); });
}

// ---- shared: a decoded view of a mini system's arena ---------------------------

function makeRecordsView(container, world, tickRead) {
	const selected = signal(-1);
	let prev = null;
	container.addEventListener('click', (e) => {
		const row = e.target.closest('[data-id]');
		if (row) selected(Number(row.dataset.id));
	});
	effect(() => {
		tickRead();
		const sel = selected();
		const { M } = world.arena();
		const live = touchedRecords(M);
		const snap = new Int32Array(live.length * 8);
		// Two label rows: node records and link records give the same eight
		// slots different meanings, so each column is named twice, color-
		// keyed to the row kinds below.
		let html = `<table><thead>
			<tr><th rowspan="2">id</th>
				<th class="nh">Flags</th><th class="nh">Deps</th><th class="nh">DepsTail</th><th class="nh">Subs</th><th class="nh">SubsTail</th><th class="nh">Gen</th><th class="nh" colspan="2">Version (f64)</th>
				<th rowspan="2">decoded</th></tr>
			<tr><th class="lh">Version</th><th class="lh">Dep</th><th class="lh">Sub</th><th class="lh">PrevSub</th><th class="lh">NextSub</th><th class="lh">PrevDep</th><th class="lh">NextDep</th><th class="lh">—</th></tr>
		</thead><tbody>`;
		for (let n = 0; n < live.length; n++) {
			const id = live[n];
			let cells = '';
			for (let s = 0; s < 8; s++) {
				const v = M[id + s];
				snap[n * 8 + s] = v;
				const was = prev && prev.ids[n] === id ? prev.snap[n * 8 + s] : v;
				cells += `<td class="${v !== was ? 'changed' : ''}">${v}</td>`;
			}
			html += `<tr data-id="${id}" class="${rowKind(M, id)} ${sel === id ? 'selected' : ''}">
				<th>@${id}</th>${cells}<td class="decoded">${decode(M, id, world)}</td></tr>`;
		}
		html += '</tbody></table>';
		container.innerHTML = html;
		prev = { ids: live, snap };
	});
}

function touchedRecords(M) {
	const out = [];
	for (let id = 8; id < M.length; id += 8) {
		let any = false;
		for (let s = 0; s < 8 && !any; s++) any = M[id + s] !== 0;
		if (!any && id > 64) break; // past the allocation frontier
		out.push(id);
	}
	return out;
}

function rowKind(M, id) {
	const k = kindOf(M[id + NODE_SLOTS.Flags]);
	if (k) return k;
	if (M[id + LINK_SLOTS.Dep] !== 0 && M[id + LINK_SLOTS.Sub] !== 0) return 'link';
	return 'freed';
}

function decode(M, id, world) {
	const flags = M[id + NODE_SLOTS.Flags];
	const k = kindOf(flags);
	if (k) {
		const st = world.states[id >> 3];
		const bits = FLAG_BITS.filter(([bit]) => flags & bit).map(([, nm]) => nm).join('|') || '—';
		const deps = M[id + NODE_SLOTS.Deps];
		const subs = M[id + NODE_SLOTS.Subs];
		return `${k} <b>${st?.name ?? ''}</b>: ${bits}${deps ? `, deps→@${deps}` : ''}${subs ? `, subs→@${subs}` : ''}`;
	}
	const dep = M[id + LINK_SLOTS.Dep];
	const sub = M[id + LINK_SLOTS.Sub];
	if (dep !== 0 && sub !== 0) {
		const nd = M[id + LINK_SLOTS.NextDep];
		const ns = M[id + LINK_SLOTS.NextSub];
		return `link: @${sub} reads @${dep}${nd ? `, nextDep→@${nd}` : ''}${ns ? `, nextSub→@${ns}` : ''}`;
	}
	return 'freed (on the free list)';
}

// ---- 2. the algorithm stepper: write, propagate, pull, cut off ------------------

export function mountStepper(root) {
	const world = makeInspectableSystem();
	const price = world.signal('price', 3);
	const qty = world.signal('qty', 2);
	const subtotal = world.computed('subtotal', () => price.read() * qty.read());
	const total = world.computed('total', () => Math.round(subtotal.read() * 1.1 * 100) / 100);
	let receipt = world.effect('receipt', () => { total.read(); });
	world.log.length = 0;
	world.log.push('built: price, qty → subtotal → total → receipt effect');

	const tick = signal(0);
	const bump = () => tick(tick() + 1);

	root.innerHTML = `
		<div class="actions">
			<button data-act="price">price ← price + 1</button>
			<button data-act="qty">qty ← qty + 1</button>
			<button data-act="batch">batch: write both</button>
			<button data-act="same">qty ← qty (same value)</button>
			<button data-act="read">read total</button>
			<button data-act="dispose">dispose the effect</button>
		</div>
		<svg id="graphview" viewBox="0 0 500 300"></svg>
		<ol id="log"></ol>
		<h3>the same graph, as raw memory</h3>
		<div class="records"></div>`;

	const acts = {
		price: () => price.write(price.read() + 1),
		qty: () => qty.write(qty.read() + 1),
		batch: () => {
			world.startBatch();
			price.write(price.read() + 1);
			qty.write(qty.read() + 1);
			world.endBatch();
		},
		same: () => qty.write(qty.read()),
		read: () => world.log.push(`read: total = ${total.read()}`),
		dispose: () => {
			if (receipt) {
				receipt.dispose();
				receipt = null;
			} else {
				receipt = world.effect('receipt', () => { total.read(); });
			}
		},
	};
	root.querySelector('.actions').addEventListener('click', (e) => {
		const act = e.target.dataset?.act;
		if (!act) return;
		world.log.length = 0;
		acts[act]();
		if (act === 'dispose') {
			e.target.textContent = receipt ? 'dispose the effect' : 'recreate the effect';
		}
		bump();
	});

	const svg = root.querySelector('#graphview');
	effect(() => {
		tick();
		const { M } = world.arena();
		const nodes = [];
		for (const id of touchedRecords(M)) {
			const k = kindOf(M[id + NODE_SLOTS.Flags]);
			if (k) nodes.push({ id, kind: k, name: world.states[id >> 3]?.name ?? '(freed)' });
		}
		const cols = { signal: 72, computed: 245, effect: 420 };
		const rows = { signal: 0, computed: 0, effect: 0 };
		const pos = new Map();
		for (const nd of nodes) {
			pos.set(nd.id, { x: cols[nd.kind], y: 50 + rows[nd.kind]++ * 92 });
		}
		let edges = '';
		for (const nd of nodes) {
			let l = M[nd.id + NODE_SLOTS.Subs];
			while (l !== 0) {
				const sub = M[l + LINK_SLOTS.Sub];
				const a = pos.get(nd.id);
				const b = pos.get(sub);
				if (a && b) {
					edges += `<path d="M${a.x + 55} ${a.y + 18} C ${a.x + 110} ${a.y + 18}, ${b.x - 55} ${b.y + 18}, ${b.x - 1} ${b.y + 18}" />
						<text x="${(a.x + b.x) / 2 + 26}" y="${(a.y + b.y) / 2 + 12}">link @${l}</text>`;
				}
				l = M[l + LINK_SLOTS.NextSub];
			}
		}
		let boxes = '';
		for (const nd of nodes) {
			const { x, y } = pos.get(nd.id);
			const flags = M[nd.id + NODE_SLOTS.Flags];
			const chips = FLAG_BITS.filter(([bit]) => flags & bit).map(([, nm]) => nm).join(' · ');
			const st = world.states[nd.id >> 3];
			const value = st ? ('value' in st ? st.value : st.current) : undefined;
			boxes += `<g class="node ${nd.kind}" transform="translate(${x - 52}, ${y})">
				<rect width="108" height="38" rx="7"></rect>
				<text x="54" y="15">${nd.name}${value !== undefined ? ` = ${value}` : ''}</text>
				<text x="54" y="30" class="chips">@${nd.id}${chips ? ' · ' + chips : ''}</text>
			</g>`;
		}
		svg.innerHTML = `<g class="edges">${edges}</g>${boxes}`;
	});

	const logEl = root.querySelector('#log');
	effect(() => {
		tick();
		logEl.innerHTML = world.log.map((l) => `<li>${l}</li>`).join('') || '<li>idle</li>';
	});

	makeRecordsView(root.querySelector('.records'), world, tick);
}

// ---- 3. the spreadsheet: dynamic dependencies through eval ----------------------

const COLS = ['A', 'B', 'C', 'D', 'E'];
const ROWS = [1, 2, 3, 4];

export function mountSheet(root) {
	const world = makeInspectableSystem();
	const tick = signal(0);
	const bump = () => tick(tick() + 1);

	// Each cell is two nodes: a signal holding the typed text, and a
	// computed holding the evaluated value. A formula calls GET('A:1') to
	// read another cell — and because the formula runs inside the
	// computed's evaluation, every GET records a real dependency edge.
	// Editing a formula re-evaluates it and rewires those edges; the table
	// on the right shows the link records appearing and aging out.
	const cells = {};
	function GET(ref) {
		const cell = cells[String(ref).toUpperCase().trim()];
		const v = cell ? cell.value.read() : 0;
		return typeof v === 'number' ? v : 0;
	}
	for (const c of COLS) {
		for (const r of ROWS) {
			const name = `${c}:${r}`;
			const raw = world.signal(`${name}·text`, '');
			const value = world.computed(name, () => evaluate(raw.read()));
			cells[name] = { raw, value };
		}
	}

	function evaluate(text) {
		if (text === '' || text == null) return '';
		if (typeof text === 'string' && text.startsWith('=')) {
			try {
				// The formula body after '=' is evaluated directly as
				// JavaScript with GET in scope. Any value is a legal cell
				// result; numbers are rounded for display, everything else
				// passes through as-is.
				const v = new Function('GET', '"use strict"; return (' + text.slice(1) + ');')(GET);
				return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
			} catch (err) {
				return String(err);
			}
		}
		const n = Number(text);
		return Number.isFinite(n) && text.trim() !== '' ? n : text;
	}

	let grid = '<table class="sheet"><tr><th></th>';
	for (const c of COLS) grid += `<th>${c}</th>`;
	grid += '</tr>';
	for (const r of ROWS) {
		grid += `<tr><th>${r}</th>`;
		for (const c of COLS) {
			grid += `<td><input data-cell="${c}:${r}" spellcheck="false" /><output data-out="${c}:${r}"></output></td>`;
		}
		grid += '</tr>';
	}
	grid += '</table>';
	root.innerHTML = `
		${grid}
		<p class="hint">type numbers, or JavaScript formulas like <code>=GET('A:1') + 5</code> — every GET is a live dependency edge</p>
		<h3>the sheet's arena, decoded</h3>
		<div class="records"></div>`;

	// input => state; one mini-system effect per cell projects value => DOM
	root.addEventListener('input', (e) => {
		const name = e.target.dataset?.cell;
		if (name) {
			cells[name].raw.write(e.target.value);
			bump();
		}
	});
	for (const name of Object.keys(cells)) {
		const out = root.querySelector(`[data-out="${name}"]`);
		world.effect(`${name}·view`, () => {
			out.textContent = String(cells[name].value.read());
		});
	}

	// seed a little model so the graph is interesting immediately
	const seed = {
		'A:1': '3',
		'B:1': '4',
		'C:1': "=GET('A:1') + GET('B:1')",
		'D:1': "=GET('C:1') * GET('C:1')",
		'A:2': "=GET('A:1') * 2",
		'B:2': "=Math.max(GET('A:2'), GET('C:1'))",
		'C:2': "=GET('D:1') - GET('B:2')",
		'A:3': "=Math.round(Math.sqrt(GET('D:1')) * 100) / 100",
	};
	for (const [name, text] of Object.entries(seed)) {
		cells[name].raw.write(text);
		root.querySelector(`[data-cell="${name}"]`).value = text;
	}
	world.log.length = 0;
	bump();

	makeRecordsView(root.querySelector('.records'), world, tick);
}
