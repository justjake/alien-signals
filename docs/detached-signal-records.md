# Design: detached signal records (signals stop using the FinalizationRegistry)

Status: REFUTED (2026-07-12) — two independent adversarial reviews (see
detached-signal-records-review-a.md and -review-b.md beside this file)
converged on fatal findings. Do not implement this revision. The findings
ledger at the end of this document records what any successor design must
resolve.

## Problem

Creating a signal today allocates an arena record and registers the returned
callable with a `FinalizationRegistry`, so that dropping the callable
eventually reclaims the record. Registration is the most expensive step of
creation, the registry cell is retained memory per signal, and reclamation
waits for the garbage collector even though the graph knows precisely when a
signal stops being referenced by anything reactive.

This design removes the registry from the signal lifecycle entirely.
Computeds are out of scope and keep their registry registration: a computed's
record owns outgoing dependency links that must be freed when the handle
dies, and only the collector knows when an unobserved computed's handle dies.
Signals have no outgoing edges — their record's only reactive owners are
their incoming links — which is what makes link ownership sufficient.

## Design summary

A signal is born **detached**: no arena record, no registry cell, no column
slots. Its value lives in the callable's own closure. The record
materializes (**attach**) at the signal's first tracked read — the moment
the first link wants to exist. When the last incoming link is freed
(**detach**), the record returns to the free stacks, the value moves back
into the closure, and the signal is again a plain closure the collector can
reclaim alone. At every point exactly one mechanism owns the record:

| state | record | value lives in | owner |
| --- | --- | --- | --- |
| detached | none | closure | JS garbage collector |
| attached | allocated | `currentVals` column | incoming links (refcount) |

## Lifecycle mechanics

**Creation.** `signal(initialValue)` builds the callable with two mutable
closure bindings: `id` (starts 0, the detached sentinel; record 0 is the
burned system record, so 0 can never name a real node) and `value`
(the current value while detached). Nothing else happens: no arena
allocation, no registration, no column writes.

**Reads and writes while detached.** The callable branches on `id === 0`
before delegating to the host read/write paths:

- untracked read (`activeSub === 0`): return `value` from the closure;
- write: apply the equality check and store into `value`. No version bump
  is needed — versions exist so consumers can compare readings, and a
  detached signal has no consumers (links are the only consumers, and a
  link's creation is what attaches);
- tracked read (`activeSub !== 0`): attach, then fall through to the normal
  host read (which creates the link).

**Attach.** Allocate the record (existing `signalId` internals minus
registration), copy `value` into `currentVals`, set the closure `id`, and
install the **unpin hook** (below) into a new id-indexed host column. The
version snapshot starts at zero — "never changed" — which is sound because
no consumer existed before this instant, so no reading can predate it.

**Detach.** The kernel's link-free path decrements the dependency's
refcount; at zero, for records flagged as detachable signals, it invokes a
new host seam (`hostUnpinned(id)`, following the existing `hostFreed` /
`hostUnwatchedNode` seam pattern). The host handler runs the signal's unpin
hook: copy `currentVals[idx]` back into the closure `value`, set the closure
`id = 0`, clear the hook column entry, and free the record (generation bump
included, exactly like today's `freeNode`).

**The unpin hook is the pin.** The closure bindings cannot be mutated from
outside, so attach creates one small closure — `() => { value =
currentVals[idx]; id = 0; }` — and stores it in the hook column. While the
signal is attached, that column entry is deliberately a strong reference to
the callable's closure environment: consumers hold only integer ids, so
something must keep the environment alive as long as links can deliver
reads. This is not a leak: when the last link drops, detach clears the
entry synchronously. If the user dropped the callable while it was still
linked, the environment survives until its consumers die, then detaches and
becomes garbage — no registry needed at any point.

**Refcount.** One `Int32Array` side column indexed by node record, following
the existing no-holes column growth discipline. Incremented in the kernel's
link-insert for the dependency side; decremented in link-free. (The kernel
already touches both sites; the counter adds one read-modify-write each.)

## Interactions with existing lifecycles

- **Scopes (region ownership).** A signal created inside an active scope is
  attached **eagerly at creation** and its `(id, gen)` joins the scope's
  owned region exactly as today. Rationale: the region list captures ids at
  creation time and disposal frees by id; letting a scoped signal attach
  later would put an id the region never heard of outside its teardown.
  Scoped creation already paid full allocation, so nothing regresses.
- **Manual mode (`allocNode`, no owner).** Unchanged and eager: manual
  records are freed by explicit `dispose()`/`reset()`, never by links or
  the registry. Detachment applies only to the owner-carrying default path.
- **`signalOwner` interop.** `signalOwner` stamps the id and generation onto
  the owner object as symbol properties at creation. Those stamps assume a
  stable id, so `signalOwner` also attaches eagerly. Only the default
  `signal()` callable — whose id never escapes — detaches.
- **`dispose(id)` raw API.** Unreachable for detached signals (their id
  never escapes the closure). Disposing an attached signal frees its links'
  subscriber side; its own record detaches when the incoming refcount hits
  zero as usual.
- **Effects and effect scopes.** Unchanged; they are graph roots with
  explicit stop functions and never used the registry.
- **Arena growth / engine generations.** Detached signals hold no id, so
  growth has nothing to migrate for them. The refcount and hook columns ride
  the same handoff as every other host column. The detached sentinel (0) is
  generation-independent.
- **`reset()`.** Frees every record. Attached signals' hook column entries
  are dropped wholesale with the other columns; their closures keep whatever
  `value` they last copied out — which is stale by definition after a reset,
  matching today's contract that pre-reset handles must not be reused.

## Costs, and the gates that must hold

Every cost lands on a measured gate; regressions kill the change:

- **One `id === 0` compare added to every read and write** through the
  default callables — the hottest path in the library. Gate: read-heavy and
  update-heavy benchmark rows within noise (≤1.01x) of baseline.
- **One closure allocation per attach** (the unpin hook), replacing one
  registry registration per creation. Attach happens at most once per
  linked lifetime; churn benchmarks (create/dispose cycles) must improve,
  not just creation.
- **One refcount read-modify-write per link insert and per link free.**
  Gate: propagation rows flat.
- **Two new host columns** (hook, refcount) versus one registry cell per
  signal: net retained memory must drop in the memory benchmark.
- Creation benchmark rows are the payoff and must improve decisively;
  anything under ~1.3x better on signal creation does not justify the
  complexity.

## Correctness obligations (new tests)

1. Drop a detached signal → collected (GC leak suite, no registry involved).
2. Drop an *attached* signal's callable while a consumer still reads it →
   values keep flowing; dispose the consumer → record detaches; environment
   collected.
3. Attach→detach→re-attach churn across an arena growth boundary: values
   and generations correct in the new engine generation.
4. Detached write then first tracked read: consumer sees the written value;
   version accounting treats it as never-changed (no spurious recompute).
5. Scope-created signals: unchanged region teardown, including scoped
   signals that were never read.
6. `reset()` with live attached and detached signals: no throw, post-reset
   creations work, pre-reset handles are dead as documented.
7. Refcount saturation/underflow guards: double-free of a link must not
   detach twice (generation bump makes the second free a mismatch no-op).

## Open questions for review

- Is there any path that reads a signal's version or flags **by id** while
  its refcount is zero but before detach runs (a window between the
  decrement and the seam call)? The seam must run synchronously inside the
  link-free to close it.
- Does any host or raw-API consumer cache signal ids outside `signalOwner`
  (which we keep eager)? A cached id to a detached-then-reattached signal
  would name the wrong record; the generation check covers frees, but reads
  by stale id return wrong values silently.
- The unpin hook doubles as the strong pin. Is one closure per attached
  signal acceptable versus a parallel `owners` column holding the callable
  plus a boxed mutable state object? The closure wins on read-path cost
  (zero extra indirection) and loses a little on attach cost.
- `effect()` bodies that read a detached signal untracked (via `untracked`
  or peek-style access) never attach it — correct per the tracking
  contract, but worth an explicit conformance case.

## Review findings ledger (2026-07-12)

Two independent adversarial reviews refuted this revision. Converged fatal
findings any successor must resolve:

1. **Staged writes are lost on detach.** Writes stage in `pendingVals` and
   commit lazily; detach as specified copies `currentVals` and silently
   drops an accepted write (trivially reachable: write inside a batch or
   manual mode, then stop the last consumer). Detach must run the commit
   first.
2. **Eagerly-attached, never-linked signals have no reclaimer.**
   `signalOwner` and any attach-without-link path leak unboundedly once the
   registry is gone. The registry cannot be "removed entirely"; the spec
   must state exactly which paths keep it and correct the memory
   arithmetic.
3. **A link is not proof of a live owner.** An effect stopped during its
   own run can still track new dependencies into a disposed subscriber
   record (the kernel performs no subscriber-liveness check at link time),
   creating a ghost edge that pins the hook environment forever. The
   ownership premise needs either a liveness check or dispose-during-run
   hardening — a latent kernel looseness this design would weaponize.
4. **Attach is not exception-safe.** The hook installs before the link
   allocation that can throw (arena exhausted mid-operation), leaving a
   zero-refcount pinned record with no path to reclamation.
5. **Attach concentrates allocation inside tracked frames where growth is
   forbidden**, converting programs that work today (bulk creation then one
   wide effect) into mid-operation arena-exhaustion throws.
6. **The refcount column is redundant and its growth handoff is wrong.**
   Subscriber-list-emptiness is already computed by the kernel and already
   delivered to the host through the watched/unwatched lifecycle seams
   (the host currently ignores it for signals); a successor should build on
   those seams instead of a new typed-array column, whose by-reference
   generation handoff as specified would silently break at growth.
7. **The double-free defense as stated is fictitious** — link records carry
   no generation, and node generation bumps are deferred to the sweep.
   The real guard must be the cleared hook entry / live-flag check.
8. **Every performance gate is mis-specified**: the propagation gate never
   executes the link-lifecycle cost it claims to bound; the creation gate
   passes definitionally; refcount 0↔1 oscillation (mount/unmount around a
   sole consumer) is the new worst case and has no gate; "≤1.01x" has no
   measurement protocol.

Not refuted, and reusable by a successor: the kernel seam through the
shared-state pattern keeps the string-compiled engine closed; a version
snapshot restarting at zero is sound (monotonic global version starts at
1); untracked reads cannot race attach in a single-threaded host; a
dropped detached signal is plain garbage.
