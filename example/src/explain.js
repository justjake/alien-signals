// The memory inspector's UI. Rendering is state => document throughout:
// `tick` (a public dalien-signals signal) versions the inspected arena, and
// every view — records table, decoded graph, activity log — is an effect
// that reads it and re-renders. Action buttons only perform the graph
// operation and bump `tick`.
import { signal, effect } from 'dalien-signals';
import { makeInspectableSystem, NODE_SLOTS, LINK_SLOTS, FLAG_BITS, kindOf } from './inspector.js';

export function mountInspector(root) {
	const world = makeInspectableSystem();
	const price = world.signal('price', 3);
	const qty = world.signal('qty', 2);
	const subtotal = world.computed('subtotal', () => price.read() * qty.read());
	const total = world.computed('total', () => Math.round(subtotal.read() * 1.1 * 100) / 100);
	let receipt = world.effect('receipt', () => { total.read(); });
	world.log.length = 0;
	world.log.push('built: price, qty → subtotal → total → receipt effect');

	// page state, on the library's public tier
	const tick = signal(0);
	const selected = signal(-1);
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
		<div class="panes">
			<div>
				<h3>the arena, decoded</h3>
				<p class="hint">every row is one record: 8 int32 slots. click a row to trace its pointers.</p>
				<div id="records"></div>
			</div>
			<div>
				<h3>the same integers, as a graph</h3>
				<svg id="graphview" viewBox="0 0 460 320"></svg>
				<h3>what just happened</h3>
				<ol id="log"></ol>
			</div>
		</div>`;

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

	// ---- records table: decoded straight from the Int32Array -------------------
	const recordsEl = root.querySelector('#records');
	recordsEl.addEventListener('click', (e) => {
		const row = e.target.closest('[data-id]');
		if (row) selected(Number(row.dataset.id));
	});
	let prev = null;
	effect(() => {
		tick();
		const sel = selected();
		const { M } = world.arena();
		const live = touchedRecords(M);
		const snap = new Int32Array(live.length * 8);
		let html = `<table><thead><tr><th>id</th><th colspan="8">slots (int32 × 8 = 32 bytes)</th><th>decoded</th></tr></thead><tbody>`;
		for (let n = 0; n < live.length; n++) {
			const id = live[n];
			let cells = '';
			for (let s = 0; s < 8; s++) {
				const v = M[id + s];
				snap[n * 8 + s] = v;
				const was = prev && prev.ids[n] === id ? prev.snap[n * 8 + s] : v;
				cells += `<td class="${v !== was ? 'changed' : ''}">${v}</td>`;
			}
			html += `<tr data-id="${id}" class="${rowKind(M, id, world)} ${sel === id ? 'selected' : ''}">
				<th>@${id}</th>${cells}<td class="decoded">${decode(M, id, world)}</td></tr>`;
		}
		html += '</tbody></table>';
		recordsEl.innerHTML = html;
		prev = { ids: live, snap };
	});

	// ---- the graph view: edges read out of the link records --------------------
	const svg = root.querySelector('#graphview');
	effect(() => {
		tick();
		const { M } = world.arena();
		const nodes = [];
		for (const id of touchedRecords(M)) {
			const k = kindOf(M[id + NODE_SLOTS.Flags]);
			if (k) nodes.push({ id, kind: k, name: world.states[id >> 3]?.name ?? '(freed)' });
		}
		const cols = { signal: 40, computed: 200, effect: 380 };
		const rows = { signal: 0, computed: 0, effect: 0 };
		const pos = new Map();
		for (const nd of nodes) {
			pos.set(nd.id, { x: cols[nd.kind], y: 60 + rows[nd.kind]++ * 90 });
		}
		let edges = '';
		for (const nd of nodes) {
			// walk the subscriber list: Subs -> link record -> NextSub …
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

	// ---- narrated log ------------------------------------------------------------
	const logEl = root.querySelector('#log');
	effect(() => {
		tick();
		logEl.innerHTML = world.log.map((l) => `<li>${l}</li>`).join('') || '<li>idle</li>';
	});
}

// Records that have ever been used: allocation is a bump pointer, so live +
// freed records are the prefix of the arena after the system's record 0.
function touchedRecords(M) {
	const out = [];
	for (let id = 8; id < M.length; id += 8) {
		let any = false;
		for (let s = 0; s < 8 && !any; s++) any = M[id + s] !== 0;
		if (!any && id > 64) break; // past the bump pointer
		out.push(id);
	}
	return out;
}

function rowKind(M, id, world) {
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
		return `${k} <b>${st?.name ?? ''}</b>: flags=${bits}${deps ? `, deps→@${deps}` : ''}${subs ? `, subs→@${subs}` : ''}`;
	}
	const dep = M[id + LINK_SLOTS.Dep];
	const sub = M[id + LINK_SLOTS.Sub];
	if (dep !== 0 && sub !== 0) {
		const nd = M[id + LINK_SLOTS.NextDep];
		const ns = M[id + LINK_SLOTS.NextSub];
		return `link: @${dep} ←feeds— @${sub}${nd ? `, nextDep→@${nd}` : ''}${ns ? `, nextSub→@${ns}` : ''}`;
	}
	return 'freed (waiting on the free list)';
}
