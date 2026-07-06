# Benchmark CI

`.github/workflows/benchmark.yml` benchmarks this library against upstream
alien-signals (plus the rest of the contested cluster) on every push to
main, once under Node and once under Bun, in parallel jobs. Each job uploads
`results-<runtime>.csv` (per-test medians) and `benchmark-<runtime>.png`
(the chart), and writes a totals table to the job summary.

## How the harness gets there

The benchmark is the [milomg js-reactivity-benchmark](https://github.com/milomg/js-reactivity-benchmark)
plus this repo's methodology fork:

- `medianTest` / `medianOf`: per-test **median of N runs** instead of
  upstream's fastest-of-N (the minimum hides amortized costs — GC of what a
  run allocated, deopt recovery, finalizer processing).
- `isolated.ts --rounds N`: one process per framework, frameworks
  **interleaved round-robin**, final time = median across rounds. This is
  what makes results usable on noisy shared runners.
- Adapters for this library (including the `reset()` generation lifecycle
  in `cleanup()` — the arena equivalent of what GC-managed graphs get
  automatically when a dead graph becomes unreachable).

Those changes live in `milomg-fork.patch`, applied in CI to a clone pinned
to the SHA in the workflow's `env`. Upstream alien-signals is likewise a
pinned clone, built from source (its `esm/` is a build artifact). The CI
recreates the local development layout so the harness's relative `file:`
dependencies resolve unchanged.

To update the patch after changing the harness fork locally:

```sh
./benchs/ci/regen-patch.sh   # run from anywhere; resolves its own paths
```

## Reading the numbers

- Hosted runners are shared hardware: treat run-over-run deltas under ~5%
  as noise. The meaningful comparison is between frameworks **within** one
  run — that is what interleaving + medians protect.
- Never shard frameworks or suites across runner machines: cross-machine
  times are not comparable. Node vs Bun is the only parallel axis, because
  those produce separate charts.
- The default framework set is the contested cluster. Dispatch the workflow
  manually with `frameworks: ALL` for the full 14-framework chart (hours).

## Pulling CI results into the repo

`pull-run.mjs` syncs a green CI run into the repo — data, charts, and README:

```sh
node benchs/ci/pull-run.mjs --run <run-id> [--repo justjake/dalien-signals] [--dry]
```

It downloads the run's `benchmark-<runtime>` artifacts, copies each results
CSV to `benchs/results/<date>-ci-run<id>-<runtime>.txt`, regenerates the
totals chart (`benchs/chart.mjs`) and the per-test small-multiples chart
(`benchs/chartDetails.mjs`) with run metadata in the subtitle, rasterizes
them into `assets/`, and rewrites the README regions between
`<!-- benchmark:<runtime>:begin -->` and `<!-- benchmark:<runtime>:end -->`
(image, alt text, suite-totals table, per-test chart). Everything between
those markers is generated — hand edits there are overwritten; prose lives
outside them. `--dry` writes to a temp directory for inspection instead of
the repo; runs whose conclusion is not success are refused. Requires an
authenticated `gh` and a Chrome/Chromium binary (override with `$CHROME`).

The chart scripts share their parsing, suite mapping, and palette through
`benchs/lib.mjs`, so the three of them cannot drift apart.
