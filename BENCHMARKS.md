# milomg benchmark campaign — findings

Goal under test: be 20% faster than upstream alien-signals v3 on the milomg
reactivity benchmark (geomean of per-test medians ≤ 0.80), with a basic
public API that cannot leak and needs no ceremony.

## Result

| scoreboard | adapter | geomean vs alien |
|---|---|---|
| v15 (8-round medians) | raw id tier | **1.022** |
| v19 (5-round medians) | default GC-owned handles | **1.051** |

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

## Bugs the campaign found

- Dead getter closures stayed pinned (and GC-traced) in host columns after
  records were reclaimed, until index reuse — fixed by the `freed` seam
  (options.freed), which flipped createComputations from 1.10 to 0.69.
- Capacity-sized pointer columns (2M slots × 5 arrays) added ~10 ms of
  marking to every major GC — presizing reverted.
- The read memo requires a tracking-cycle key (re-tracks at an unchanged
  globalVersion must re-link or purgeDeps drops the edge) and invalidation
  on every free (recycled ids collide) — both caught by conformance.
