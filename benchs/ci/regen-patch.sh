#!/usr/bin/env bash
# Regenerate milomg-fork.patch from the local milomg-reactivity-benchmark
# working tree (the parent repo's submodule). Run from the parent repo root
# whenever the harness fork changes (estimator, runner, adapters).
#
# The patch must apply cleanly to the MILOMG_SHA pinned in
# .github/workflows/benchmark.yml; if you bump that pin, rebase the working
# tree first, then regenerate.
set -euo pipefail
cd "$(dirname "$0")/../../../../milomg-reactivity-benchmark"
git add -A
git diff --cached --binary > ../packages/dalien-signals/benchs/ci/milomg-fork.patch
git reset -q
echo "wrote benchs/ci/milomg-fork.patch:"
git -C ../packages/dalien-signals diff --stat -- benchs/ci/milomg-fork.patch | tail -1 || true
grep -c '^diff --git' ../packages/dalien-signals/benchs/ci/milomg-fork.patch
