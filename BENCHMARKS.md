# milomg benchmark campaign — findings

Goal under test: be 20% faster than upstream alien-signals v3 on the milomg
reactivity benchmark (geomean of per-test medians ≤ 0.80), with a basic
public API that cannot leak and needs no ceremony.

## Result

| scoreboard | adapter | geomean vs alien |
|---|---|---|
| v15 (8-round medians) | raw id tier | **1.022** |
| v19 (5-round medians) | default GC-owned handles | **1.051** |

Aggregation sensitivity (10 merged rounds, final code): geomean 1.049,
median cell 1.051, trimmed geomean 1.015, total-suite-time ratio 1.027;
2/20 cells ≥20% faster, 7/20 faster at all. No honest aggregation
reaches 0.80.

Campaign trajectory: 1.56 → 1.05 over ~15 landed optimizations. For
calibration, the fused main-branch engine (seeding, codegen clones, fused
read/write — this project's historical performance ceiling) measures
0.99–1.07 on the identical suite: this branch now equals the best the
arena family has done against alien on milomg.

Where the design wins decisively (v19): repeatedObservers 0.66,
createComputations 0.69, cellx2500 0.80, cellx1000 0.90, updateSignals
0.96, 25-1000x5 0.93. Where it loses: createSignals ~2–3× (see below) and
a propagation band at 1.05–1.15.

## Why the remaining ~25% has no identified mechanism

1. **Automatic reclamation has a cost floor that alien does not pay.**
   Alien's nodes are plain GC objects: dropping a handle reclaims the node
   for free. Any arena must track lifetime explicitly. Everything was
   measured: immediate FinalizationRegistry cells (~14 ns/mint, but
   per-mint weak cells in a burst regressed create-heavy cells ~35%),
   deferred registration (pins owners through in-window scavenges),
   WeakMap side tables (~400 ns/mint at scale), unregister tokens
   (~150–370 ns), owner stamping (~20 ns of shape transitions). The
   shipped scheme — deferred registration drained by a maintenance
   microtask — is the cheapest honest one found.
2. **V8 will not eliminate redundant typed-array loads across loop
   iterations** (alias analysis), while it GVNs/hoists alien's
   object-property chains. Repeated-read cells were capped ~1.5× until the
   one-entry read memo (keyed id+sub+globalVersion+cycle, in foldable
   context slots) recovered them; the same headwind taxes the whole
   propagation band a few ns per operation with no per-site fix. (Audited:
   the engine walks themselves have nothing to hoist — a graph walk is
   load-fresh, touching each slot once; the redundancy was host- and
   user-loop-level, and those sites are fixed. A GC-tuning diagnostic —
   16× young-gen, both frameworks — moved the geomean ratio by ~1%,
   confirming the band is per-op work, not collector scheduling; only
   createSignals is GC-machinery-bound, and a large nursery makes its
   deferred-registration pinning WORSE, +58%.)
3. The benchmark harness times `cleanup()` inside the measured window for
   sBench-family tests while running `gc()` after it — explicit-teardown
   designs get charged in-window for what GC frameworks pay off-clock.
   Adapters must dispose scopes only and let ownership reclaim
   asynchronously.

## Operational notes

- Suite runs are noisy (±5–10% per cell between invocations; some cells
  bimodal). Decisions need 5+ interleaved rounds with per-cell medians;
  adapter-free probes are the reliable inner loop.
- The bundled runner (`packages/node`) inlines the libraries: rebuild it
  after any library change.
- Run one framework per process; pass framework names as argv, and
  `--test <substring>` filters output.

## Write-size crossover matrix (benchs/crossover.mjs, 5 families × 10 sizes)

Sustained ns/write across recompute-cone sizes vs upstream alien, 2
interleaved rounds, per-cell medians (2026-07-06, after the switch to the
upstream callable API):

- **dalien main (fused): 0.90 geomean** — reproduces its documented 0.92,
  same signature: deep/grid enter the win band at N≈300–1000 and reach
  0.42–0.52; islands carries a flat ~5% premium.
- **userspace raw tier: 1.05 geomean.** The crossover survives this
  architecture: deep/grid at N=1000–30000 run 0.44–0.66 of alien. What's
  lost vs main is the small-write end (N≤300 at 1.1–1.6×: host-seam and
  module-let overhead) and batch (many small writes per flush, ~1.0–1.2×).
- **userspace callable API: ~1.12–1.17 geomean.** The default-API wrapper
  costs 10–25% over the raw tier on this matrix (worst on islands/batch,
  mildest on deep large-N where update work dominates).

### The callable wrapper tax: what it is NOT (all measured)

Four mechanisms were implemented and benchmarked; the tax was invariant:

1. Arrow wrapper calling set()/get() (shipped variant).
2. set()'s body inlined into the write arm (one frame like upstream's
   signalOper) — no change.
3. get()'s fast path (memo + version gate) also inlined into both opers —
   slightly WORSE (more code per closure).
4. Upstream's exact mechanism — one shared module-level oper per kind,
   bound per node with the id as primitive `this` (one feedback vector
   trained by all nodes, cheap bound trampolines) — no better, slightly
   worse on small-N deep. Requires system.adoptNode(owner, id) (register
   after mint), which stays as API.
5. FinalizationRegistry adoption disabled entirely as a diagnostic:
   ratio 1.00 flat — ownership registration costs nothing at steady state.

Remaining hypothesis consistent with all of the above: this library's read
path is much larger than alien's (one-entry memo — four compares — plus
the f64 version-gate load, then link), so V8 stops inlining it through ANY
additional wrapper layer, while alien's minimal read (flags check + link +
value load) inlines fully into user getter closures — their wrapper is
nearly free, ours re-pays a call per read. Chasing that means slimming or
splitting the read fast path — engine work, independent of API shape.

## Manual vs GC interface ("Dalien Malloc Free" framework)

The suite now carries a second adapter for this library: the raw id tier
(signalId/computedId/effectId + dispose(scope)) with scope-region
ownership — bare numeric ids, no handle objects, no FinalizationRegistry,
100% explicit lifetime. Three interleaved rounds against the default
GC-handle adapter and alien (2026-07-06, per-cell medians):

- **geomean manual/handles = 1.02** — the leak-free default costs
  approximately nothing suite-wide. After the freed-seam fix, even
  createComputations is equal (0.97).
- The one clear manual win: **createSignals 0.81** (pure mint burst —
  handle allocation plus registry cell are the only remaining GC-interface
  costs). Even manual remains ~1.9× alien there: the floor is arena
  lifetime bookkeeping, not the handle wrapper.
- Propagation cells drift 1.03–1.09 against manual — within the suite's
  per-cell noise band; both adapters read and write through identical
  get(id)/set(id) paths after build, so there is no mechanism for a real
  steady-state gap.
- This batch: handles/alien 1.01, manual/alien 1.03 — batch-to-batch drift
  (the known ±5–10%) now dominates the interface difference entirely.

Conclusion: the honest benchmark config is the handle adapter; the manual
tier buys nothing except in signal-mint microbenchmarks.

## Tried and rejected: inline 1:1 edges (chain edges)

Prototype (built, measured, reverted): when a subscriber has exactly one
dependency AND that dependency has exactly one subscriber, store the edge
inline in the two node records (negated peer id in the Deps/Subs slots; the
sub's DepsTail doubles as the re-track confirm version) instead of
allocating a 32-byte link record. Pure chains — deepPropagation's exact
shape — carry zero link records; the edge graduates to a real link on
first structural complication.

Measured (adapter-free probes, 3 interleaved rounds, medians):

- deepPropagation steady state: **no change** (~20.3 ms both). Same lesson
  as the walk audit above: walks are load-fresh, so removing the link-record
  pointer chase saves loads that were never the bottleneck; update/bracket
  work dominates propagation cells.
- broadPropagation: **~9% regression** (58 vs 53 ms). Every hot path pays
  the dual-representation sign dispatch (link()'s head check, propagate's
  descent, chainCheck, updateAndShallow), and the branches cost more than
  the saved loads. Not an inlining artifact (checkDirty was restructured
  back under V8's 460-bytecode limit — no change) and not deopt churn
  (--trace-deopt clean in both builds).
- 1:1 creation (20k signal→computed→computed chains): chain build ~3.0 ms
  stable vs baseline 2.9–4.3 ms bimodal — at best a small allocation win,
  nowhere near alien's ~1.8 ms floor, which is reclamation machinery, not
  link records.

Implementation notes for the record: the design works and passed
chain/diamond/dispose smoke tests. Two load-bearing subtleties: (1) a
materialized link must inherit the exact pass version that confirmed the
inline edge, or linkInsert's same-pass dedup misses on out-of-order
re-reads and inserts duplicate links; (2) every consumer of a Deps/Subs
slot — including host-side purge/dispose/queue-climb walkers — needs a sign
arm; a missing arm dereferences a confirm version as a link id and corrupts
the arena.

## Bugs the campaign found

- Dead getter closures stayed pinned (and GC-traced) in host columns after
  records were reclaimed, until index reuse — fixed by the `freed` seam
  (options.freed), which flipped createComputations from 1.10 to 0.69.
- Capacity-sized pointer columns (2M slots × 5 arrays) added ~10 ms of
  marking to every major GC — presizing reverted.
- The read memo requires a tracking-cycle key (re-tracks at an unchanged
  globalVersion must re-link or purgeDeps drops the edge) and invalidation
  on every free (recycled ids collide) — both caught by conformance.
