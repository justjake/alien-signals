# Design v4: detached signal records (default signal callables stop using the FinalizationRegistry)

Status: v4 DRAFT — fourth revision. v1 refuted outright (reviews -a, -b);
v2 materially sounder, refuted on boundaries (-a2, -b2); v3 refuted on its
hardening mechanisms (-a3, -b3) — which in the process surfaced three
pre-existing kernel bugs this revision turns into named prerequisite
fixes. Resolution maps for all rounds are at the end.

## Problem

Creating a default signal callable today allocates an arena record and
registers the callable with a `FinalizationRegistry`, so that dropping the
callable eventually reclaims the record. Registration and its retained
registry cell are per-signal costs, and reclamation waits for the garbage
collector even though the graph knows precisely when a signal stops being
referenced by anything reactive.

This design removes registry participation for exactly one creation path:
the default `signal()` callable, whose record id never escapes its closure.
Every other path keeps its current reclaimer. Precisely:

| creation path | reclaimer today | reclaimer after |
| --- | --- | --- |
| `signal()` default callable | registry | **links (this design)** |
| `signalOwner` / `signalId(v, owner)` | registry | registry (unchanged) |
| raw `signalId(v)` at top level | `dispose()` / `reset()` | unchanged |
| raw `signalId(v)` inside a scope | scope region | unchanged |
| `computed()` / `computedId` | registry (at creation) | unchanged |
| effects / scopes | explicit stop, disposer registry net | unchanged |

Note on today's behavior this table encodes: a default callable created
inside a scope is **not** region-owned today (region membership requires
the raw ownerless path), so detachability changes nothing about scopes.

## Design summary

A default signal is born **detached**: no arena record, no registry cell,
no column slots. Its value lives in the callable's closure. The record
materializes (**attach**) at the signal's first tracked read — the moment
the first link wants to exist. When the last incoming link is unlinked
(**detach**), the newest accepted value moves back into the closure, the
closure abandons the id, and the record is reclaimed through the same
boundary-sweep discipline the kernel already uses for orphaned records.
At every point exactly one mechanism owns the record:

| state | record | newest value lives in | owner |
| --- | --- | --- | --- |
| detached, never attached | none | closure | JS garbage collector |
| attached | allocated | `pendingVals` column | incoming links |
| detached after attachment | none (column VALUES cleared at the sweep; column CAPACITY is high-water, like every freed record today) | closure | JS garbage collector |

The "newest value" column is deliberate: the write path stages values in
`pendingVals` and commits to `currentVals` lazily, so `pendingVals[idx]` is
the newest accepted value at every instant (writes store there first, and
the commit copies from it). Detach therefore copies from `pendingVals`,
never `currentVals` — this is what makes stopping a consumer inside an
open batch or in manual effect mode lossless.

## Mechanics

**Creation.** The callable closes over two mutable bindings: `id` (0, the
detached sentinel — record 0 is the burned system record and can never
name a real node) and `value`. Nothing else happens.

**Detached reads and writes.** The callable branches on `id === 0`:

- untracked read: return `value`;
- write: equality-check against `value`, store into `value`. No version
  traffic — versions let consumers compare readings, and link creation is
  the only way to become a consumer, which attaches first;
- tracked read (`activeSub !== 0`): attach, then the normal host read.

**Attach** (inside the callable, ordered for exception safety):

1. allocate the record through a DEDICATED attach path — not
   `signalId`, whose internals include the scope-region branch (an
   attached-by-read record must never join a region: a region frees by
   id, and a record whose real owner is its links being freed by a
   disposing scope silently unlinks live outside consumers and
   double-queues the record). The dedicated path KEEPS the other
   load-bearing internals: the hole-free column growth to the new
   record's index before any column store, and the full host flags word
   (the signal kind tag, the mutable flag, and the new detachable bit —
   without the kind and mutable bits, the update dispatch would route
   the record to the computed path and never commit staged writes).
   Steps 1-4 run inside the kernel enter-depth bracket, entered and
   exited in try/finally: a pending arena growth cannot migrate the
   arena between the allocation and the link insert, and any throw —
   including record allocation hitting the hard capacity limit at step
   1 — unwinds the bracket, so maintenance and reset stay reachable
   (hardening 5's exit check may then grow the arena);
2. seed **both** `currentVals[idx]` and `pendingVals[idx]` with the
   closure value (seeding only one produces a spurious first-write
   invalidation, v1 finding 7);
3. create the link. If link allocation throws (arena exhausted inside a
   tracked frame), free the record and rethrow: the closure still holds
   `id = 0` and the value, so the signal remains a working detached
   signal and nothing is pinned (v1 finding: attach exception safety);
4. only after the link exists: store the detach hook in the hook column
   and set the closure `id`.

Step 3's link insert is what fires the kernel's existing first-subscriber
arming (`hostWatchedNode`): the kernel sets `HostStarted` and extends the
host-state column itself. Attach needs no new kernel calls.

**Detach.** The kernel already reports last-unlink: when a node's
subscriber list empties, `unwatched(dep)` runs synchronously inside
`unlink` and dispatches to the host's `unwatchedNode` for any node with
`HostStarted`. Today the Signal kind falls through that handler. This
design adds the Signal branch. The branch's dispatch gate is the HOOK
ENTRY'S PRESENCE — not the detachable bit alone. A populated hook slot is
the one signal that an attached, detachable, not-yet-detached record is
behind this id; its absence makes the branch a no-op. This single gate is
what makes a second dispatch harmless, keeps raw-path records out, and
makes the branch immune to the pre-existing reset-sweep misdispatch (the
reset walk can misread a link record's version bits as host flags past
cycle 8192 — filed separately as a kernel bug; a masqueraded dispatch
finds no hook and does nothing):

1. copy `pendingVals[idx]` into the closure via the hook;
2. reset the closure `id` to 0 and clear the hook column entry;
3. reclaim the record the way `reclaimOrphan` does today: clear flags,
   push onto the boundary `pendingFree` queue, schedule maintenance. The
   record's memory is not reused until the operation-boundary sweep, which
   is the same mid-walk safety envelope the kernel already grants orphaned
   records. (The kernel's `unwatched` zeroes the version snapshot after
   the host dispatch returns — the reclaimed record's snapshot is
   unreachable either way, and the sweep re-zeroes it.)

A re-read after detach but before the sweep attaches a **fresh** record —
the closure abandoned the old id, so nothing can reach the queued record
again. No re-check at sweep time is needed.

**The hook is the pin.** Attach creates one closure — copy-out plus id
reset — and stores it in a hook column: a plain array grown hole-free in
lockstep with the other host columns (`currentVals` discipline; it rides
generation handoffs by reference exactly as they do — v1's typed-array
handoff complaint does not apply to plain columns). While attached, the
hook entry is a deliberate strong reference to the closure environment:
consumers hold only integer ids, so the environment must outlive the last
link. Detach clears the entry synchronously; if the user dropped the
callable while linked, the environment lives exactly until its last
consumer unlinks, then becomes plain garbage.

**No refcount, no kernel changes.** v1 proposed a per-node refcount
column; subscriber-list emptiness is that count's zero test, and the
kernel already computes and delivers it through the watched/unwatched
seams — for EVERY first-linked node, kind-agnostic, whenever the
lifecycle seams are armed (they are, in this host). Detachable signals
need nothing from the kernel beyond hardening 1: the change surface for
detachment itself is host-only (the Signal branch in `unwatchedNode` and
the attach path), which also means no string-compiled engine-clone
consequences.

## Prerequisite hardenings (separate changes, land first)

The design's premise is "a link proves a live subscriber." The review
rounds established that no link-time gate can hold that premise — a
liveness flag is identity-blind under record recycling, and the re-mark
fast path never consults an insert gate — and that the true holes are in
the frame lifecycle itself. Five hardenings close them at the source.
Each is an independent bug fix against today's code; the first three fix
corruption or leaks that are reachable today without this design.

**Hardening 1 — disposing the active subscriber ends tracking.** When
disposal reaches a record that is the current `activeSub` (an effect
stopping itself mid-run, a computed disposed from inside its own getter,
a manual frame whose subscriber is disposed before the frame ends),
`activeSub` becomes 0 on the spot. Every site that restores a saved
subscriber (the public frame setter and the run/update/trigger exits)
validates the saved id's live flag first and restores 0 for a dead one —
so a stale id can never be re-installed after its record was freed or
recycled. Consequences: reads in a doomed frame are simply untracked
(a detached signal read there returns its closure value and never
attaches — no link, no gate, no refusal case, nothing to roll back), and
tracking can never be attributed to a recycled record's new occupant,
because a dead id never survives inside `activeSub`. One semantic pinned
by test: an effect that stops itself and then spawns a replacement child
creates that child in an untracked context — the child becomes a root
effect and survives, matching today's observable behavior.

**Hardening 2 — disposal unlinks the full dependency list, walking
forward from the list head.** Today's teardown walks backward from the
dependency-tail cursor, which a RUNNING frame has reset to zero — so
disposing a running subscriber unlinks nothing and leaves its old edges
alive in every dependency's subscriber list (reachable today; the edges
survive the record's reclamation and later misattribute propagation to
whatever recycles the record). A forward walk from the head is complete
regardless of cursor state and idempotent (the head empties as it goes),
which also fixes the double-teardown corruption for computeds, where the
unwatched cleanup and the disposal path each run a backward walk today.

**Hardening 3 — the unwatched dependency-drop of a computed that is
mid-update is deferred to its update exit.** Today the drop runs
synchronously inside the unlink cascade even when the computed's own
getter is on the stack, leaving the running frame's dependency-tail
cursor pointing at a freed link; the next link insertion can pop that
same link off the free stack and stitch a self-referential dependency
list (an unbounded unlink loop — reachable today). Deferral: the
unwatched dispatch, on finding the computed mid-update, sets a pending
bit instead of dropping; the update exit performs the drop if the bit is
set. A computed that was never watched never receives the dispatch, so
lazy untracked computeds keep their dependency graph and their caching
semantics exactly as today.

**Hardening 4 — a throwing FIRST run disposes what it created.** Today
`effect(fn)` whose initial run throws leaks the effect record, its
callback column entry, and every link the partial run tracked (no stop
callable was ever returned); `effectScope(fn)` leaks the scope record,
its region, and any children the same way. Both dispose on initial-run
throw.

**Hardening 5 — pending boundary work runs when the frame depth returns
to zero.** Maintenance (the free-record sweep, deferred growth) runs
today only from allocation sites and microtasks; a synchronous loop
whose only allocations happen inside tracked frames starves it. With
detachment, attach/detach cycles are exactly such a loop (a `trigger`
loop over a detachable signal consumes a record per iteration and never
reaches a boundary today's creation allocations would have provided).
Frame-bracket exits check for pending boundary work at depth zero and
run it synchronously, restoring bounded steady-state record usage for
synchronous churn loops.

## Documented limitation: mass first-reads inside one tracked frame

Attach moves record allocation to the first tracked read, which always
runs inside a tracked frame — where arena growth is deferred and only the
capacity headroom (a quarter of the arena) can absorb new records. A
program that creates a very large number of detached signals and then
first-reads all of them inside a single effect can exhaust the arena
mid-operation and throw, where today's eager allocation would have grown
the arena between creations. This is a real behavioral regression for
that shape. The throw itself is bounded: the attach rollback (step 3)
frees the failing signal's record, and hardening 2 disposes a first-run
effect that dies to it — but links and attachments completed BEFORE the
throw belong to the (possibly never-returned) effect and follow its
lifecycle, exactly as any throwing effect body behaves today. The escape
hatches are `growCapacity()` before the wide read, or first reads spread
across operations. Attach's enter-depth bracket (step 1) also means a
pending growth never migrates the arena mid-attach in manual frames —
the deferral is uniform whatever frame shape triggered the read. The
spec gates this with a test asserting the clean throw and no NEW leak
class; it does not pretend the shape got better.

## `reset()` contract

`reset()` walks live records and delivers the unwatched dispatch before
rewinding the arena; an attached default callable has a populated hook,
so the walk DETACHES it — newest value copied into the closure, closure
id zeroed, hook cleared. This is the defined behavior, and it is a
strictly better contract than today's for this one path: after
`reset()`, every default signal callable (attached or not) is a working
detached signal holding its newest accepted value. Every OTHER pre-reset
handle (raw ids, owner-stamped objects, computed callables, effect
stops) remains undefined to reuse, exactly as today.

## Double-free defense

Generation stamps do not defend this path (link records carry none, and
node generation bumps are deferred to the sweep — v1 finding 8). The
actual guards: the hook column entry is cleared at detach, so a second
`unwatched` dispatch for the same record finds no hook and is a no-op;
and record reclamation goes through the same live-flag discipline as
`freeNodeId` (flags cleared at queue time, sweep frees once).

## Costs and gates

Measurement protocol, used by every gate below: at least five isolated
alternating runs against the pre-change build; the statistic is the
ratio of medians; a gate passes when that ratio is at or below
max(the stated threshold, 1 + 2x the baseline's relative median absolute
deviation across its own five runs). Thresholds ARE ratios; the noise
term only ever loosens them, never tightens.

- **One `id === 0` compare on every default-callable read and write.**
  Gate: read-heavy and update-heavy suite rows, threshold 1.01, measured
  through the CALLABLE tier (the benchmark adapter uses the default
  callables; a raw-tier measurement would never execute this compare).
- **Attach/detach oscillation is the new worst case**: a sole consumer
  that repeatedly mounts and unmounts around the same signal pays record
  alloc + column seed + hook closure + link per cycle, where today it
  pays link/unlink against a persistent record. Dedicated micro through
  the callable tier whose measured window is K cycles PLUS a forced
  maintenance flush, so the deferred sweep cost cannot fall between
  samples. Threshold: 2.0. `trigger()` over an otherwise unwatched
  detachable signal is the same cost family and is measured in the same
  micro; hardening 5 additionally gates its steady state (a bounded
  arena over one million synchronous trigger iterations).
- **Teardown-heavy micro**: one effect over 1,000 detachable
  dependencies, stopped; window includes the maintenance flush.
  Threshold: 2.0.
- **Creation is measured attach-inclusive**: create N, read all once
  under one consumer per signal, dispose, flush — not bare callable
  creation (which improves definitionally and validates nothing).
  Threshold: 0.75 (the payoff row; misses reject the change).
- **Memory, two mixes, concrete method**: process RSS and V8 heap-used
  sampled after three forced garbage collections, medians of five runs.
  Attached-heavy steady state (hook closure versus registry cell):
  threshold 1.02. Detached-heavy after attach/detach churn (records
  reclaimed, closures carrying values, column capacity at high-water):
  threshold 0.70.
- **Full-suite verdict**: suite geometric mean threshold 1.00 under the
  protocol above, and no individual row above 1.05 except the two
  budgeted micros.

## Correctness obligations (new tests)

1. Drop a detached signal → collected, no registry involved.
2. Drop an attached signal's callable while a consumer reads it → values
   flow; dispose the consumer → detach; environment collected.
3. **Write inside an open batch, then stop the last consumer, then end
   the batch** → untracked read returns the written value (staged-value
   preservation; same for manual effect mode with an unflushed write).
4. Attach rollback: force arena exhaustion at the link step of attach →
   clean throw, signal still works detached, nothing pinned (checked
   under the GC leak suite).
5. Detached write then first tracked read: consumer sees the value; no
   spurious invalidation on the first equal write after attach (both
   columns seeded).
6. Attach→detach→re-attach churn across an arena growth boundary.
7. Re-read between detach and the boundary sweep → fresh record; the
   queued record sweeps without incident.
8. Ghost-link hardening regression test (prerequisite change).
9. Scoped default callables: not region-owned before, not after; scope
   disposal unaffected.
10. `reset()` with live attached and detached signals: documented
    contract holds.
11. Double `unwatched` dispatch for one record (re-entrant stop patterns)
    → second is a no-op via the cleared hook.

## Additional correctness obligations (v3/v4)

12. Hardening 1: dispose the active subscriber inside a manual frame,
    then read a detachable signal — the read is untracked (closure value,
    no attach, no record), and ending the frame restores nothing dead.
13. Hardening 1: a computed disposed from inside its own getter tracks
    nothing for the rest of that update; an effect that stops itself and
    spawns a replacement child leaves the child alive as a root effect.
14. Hardening 2: disposing a subscriber MID-RUN unlinks its entire old
    dependency set (the dependency-tail cursor is mid-frame state); no
    edge survives into the record's reclamation. Regression covers the
    computed double-teardown corruption.
15. Attach inside a scoped effect for a top-level signal: the record
    joins NO region; disposing the scope leaves the outside consumer
    linked and propagating.
16. Attach under a pending arena growth inside a manual frame: the
    enter-depth bracket defers migration; the link lands in the same
    generation as the record. A record-allocation throw at step 1
    unwinds the bracket (maintenance, growth, and reset() all remain
    reachable afterwards).
17. Reset-sweep masquerade immunity: with cycle counters forced past
    8192, reset over live links never invokes the Signal detach branch
    (hook-presence gate holds); the underlying kernel misdispatch is
    filed and tested separately.
18. Hardening 4: a throwing first run of effect() OR effectScope()
    disposes the record (and the scope region); only pre-throw
    attachments owned by OTHER live consumers persist.
19. Hardening 3: a computed that loses its last subscriber mid-update
    drops its dependencies exactly once, at update exit; an untracked
    never-watched computed keeps its dependencies and recomputes only
    when invalidated (caching semantics unchanged).
20. Hardening 5: one million synchronous trigger() iterations over one
    detachable signal hold arena usage bounded (records recycle at
    frame-exit boundaries).
21. reset() detach contract: attached default callables come back as
    working detached signals holding their newest accepted value,
    including values staged inside an open batch at reset time.

## How v4 answers the v3 reviews

- Re-mark fast path revives dead edges / gate identity-blindness /
  refusal leaks (a3 FATAL 1-2, MAJOR 4; b3 FATAL 1-3) → there is no
  link-time gate in v4 at all. Hardening 1 ends tracking at disposal and
  validates every frame restore, so doomed frames read untracked and
  recycled ids can never occupy `activeSub`; hardening 2 makes disposal
  unlink completely regardless of frame state. Obligations 12-14.
- Mid-update dep-drop corruption / never-watched confusion (a3 FATAL 3;
  b3 FATAL 4) → the drop is deferred via a pending bit set only by a
  real unwatched dispatch; no mid-update unlink, no dangling cursor, no
  effect on never-watched computeds. Obligation 19.
- Growth/sweep starvation and bracket wedge (a3 MAJOR 5-6; b3 MAJOR 5-6)
  → hardening 5 (boundary work at depth-zero frame exits) plus the
  try/finally bracket with the step-1 throw case. Obligations 16, 20.
- Lost signalId internals (a3 MAJOR 7) → attach step 1 names the column
  growth and the full host flags word as kept internals.
- effectScope first-run throw (a3 MINOR 10) → hardening 4 covers both.
  Obligation 18.
- reset text wrong (a3 MINOR 8; b3 MINOR 9) → the mechanics (hook-driven
  detach during the reset walk) are now the documented contract, and a
  strictly better one. Obligation 21.
- Gate residue (a3 MINOR 9; b3 MAJOR 8) → thresholds are ratios with a
  noise floor; memory method named (RSS + heap-used after forced GC);
  micro windows include the maintenance flush; trigger steady-state
  gated.

## How v3 answers the v2 reviews

- Ghost links via manual frames / computed self-dispose (a2 FATAL 1,
  MAJOR 2; b2 FATAL 2 class) → hardening 1 moves the guard to link
  insertion, covering every frame shape; hardening 3 covers the
  live-but-unwatched mid-update re-track; obligations 12-14.
- Attach region capture and double-free (a2 MAJOR 3) → dedicated attach
  path never joins regions; obligation 15.
- Manual-frame growth migration mid-attach (a2 MAJOR 4) → enter-depth
  bracket around attach; obligation 16.
- Reset-sweep masquerade (a2 MAJOR 5, pre-existing kernel bug) → hook
  presence is the normative dispatch gate; obligation 17; kernel bug
  filed separately.
- Initial-effect throw leak (b2 FATAL 1, pre-existing) → hardening 2;
  obligation 18; the limitation section no longer overclaims "zero
  leak."
- Column high-water (b2 MAJOR 3) → state table row three states it;
  memory gate measures attach/detach churn, not never-attached
  populations.
- Unenforceable gates (a2 MINOR 8, b2 MAJOR 4) → numeric budgets (2.0x
  micros), per-row cap (1.05x), noise-band geomean rule, callable-tier
  requirement, teardown row added.
- Factual fixes: computeds register at creation (taxonomy); the
  unwatched version-zeroing order (detach step 3); change surface is
  host-only.

## How v2 answers the v1 ledger

1. Staged-write loss → detach copies `pendingVals` (the always-newest
   slot); obligation 3 pins it.
2. Eager-attach paths unreclaimed → the taxonomy table keeps the registry
   for every path whose id escapes; only the default callable detaches.
3. Scopes premise → corrected to today's actual behavior: default
   callables were never region-owned; regions are untouched.
4. Growth-forbidden mass attach → documented limitation with rollback
   guarantee, test, and escape hatches; no longer claimed as a pure win.
5. Redundant refcount / impossible handoff → deleted; built on the
   existing watched/unwatched seams and a plain hole-free hook column.
6. Gate mis-specification → gates rewritten with a measurement protocol,
   attach-inclusive creation, an oscillation micro with budget, and a
   full-suite geomean requirement.
7. Spurious first-write wave → attach seeds both value columns.
8. Fictitious generation defense → replaced with cleared-hook and
   live-flag guards.
9. `reset()` parity overclaim → replaced with the explicit documented
   contract.
10. Attach exception window → hook installs only after the link exists;
    rollback frees the record.
11. Ghost links (dispose-during-run) → promoted to a prerequisite
    hardening change with its own regression test.

## Appendix: v1 findings ledger (2026-07-12, verbatim)

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
