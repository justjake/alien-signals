# Design v5: detached signal records (default signal callables stop using the FinalizationRegistry)

Status: v5 DRAFT — fifth revision. v1 refuted outright (reviews -a, -b);
v2 sounder, refuted on boundaries (-a2, -b2); v3 refuted on its gate
mechanism (-a3, -b3); v4 refuted on two residues (-a4, -b4): frame-saved
subscriber ids need generation validation, not liveness validation, and
deferred growth can never run at frame exits. The review rounds have
surfaced FOUR pre-existing kernel/host bugs, each now a named
prerequisite fix. Resolution maps for all rounds are at the end.

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
| effects / scopes | explicit stop only | unchanged |

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
   (growth, per hardening 5, happens only on the microtask path or an explicit growCapacity call — never at the exit itself);
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

**Hardening 1 — saved subscriber identity is an (id, generation) pair,
and every free clears the live caches.** Bare record ids are
identity-blind: a freed record can be recycled, and its new occupant is
live, so no liveness test on a saved id can ever be sound — this killed
the v3 link gate and the v4 restore validation alike. The record
generation counter that already exists is the identity the frames need:

- every site that SAVES the current subscriber to restore later — the
  public frame setter and the exits of run, update, trigger, effect
  creation, scope creation, and cleanup invocation (all seven; the v4
  review enumerated them) — saves the (id, generation) pair and restores
  0 when the generation no longer matches;
- the same discipline covers the two cached-id channels that are not the
  active subscriber: the current scope and the trigger scratch record;
- the CLEAR side rides the existing freed-notification seam: every
  record free (explicit dispose, scope-region teardown, registry
  reclamation) already dispatches the host's freed hook, which now also
  compares the freed id against the active subscriber, current scope,
  and trigger scratch, and zeroes any match — so a doomed frame stops
  tracking at the moment of the free, whatever path freed it, and no
  window exists between a free and the next restore.

Consequences: reads in a doomed frame are simply untracked (a detached
signal read there returns its closure value and never attaches), a
recycled record can never inherit a stale frame (generation mismatch
restores 0), and tracking can never be attributed to a recycled
occupant. One semantic pinned by test: an effect that stops itself and
then spawns a replacement child creates that child in an untracked
context — the child becomes a root effect and survives.

**Hardening 2 — disposal unlinks the full dependency list by
repeatedly consuming the list HEAD.** Today's teardown walks backward
from the dependency-tail cursor, which a RUNNING frame has reset to
zero — so disposing a running subscriber unlinks nothing and leaves its
old edges alive in every dependency's subscriber list (reachable today).
The replacement loop is normatively "unlink whatever the head slot
currently names, until it names nothing": re-reading the head each
iteration — never a cached next pointer — is what makes the walk correct
under re-entrancy, because an unlinked child's own cleanup can dispose
siblings and recycle link records mid-walk. This also fixes the
double-teardown corruption for computeds (the second walk finds an empty
head and stops). Pinned semantic change: child cleanups now run in
creation order rather than newest-first; the reset path keeps its own
separately documented newest-first order. A test pins the new order.

**Hardening 3 — the unwatched dependency-drop of a computed that is
mid-update is deferred, conditionally, to its update exit.** Today the
drop runs synchronously inside the unlink cascade even when the
computed's own getter is on the stack, leaving the running frame's
dependency-tail cursor pointing at a freed link; the next link insertion
can pop that same link and stitch a self-referential dependency list
(reachable today). Deferral discipline: the unwatched dispatch, finding
the computed mid-update, sets a pending bit; EVERY update exit —
including exits by throw — clears the bit, and performs the drop only if
the bit was set AND the subscriber list is still empty at that moment (a
computed re-watched before its exit keeps its dependencies); the watched
dispatch also clears the bit. A computed that was never watched never
receives the dispatch, so lazy untracked computeds keep their dependency
graph and caching semantics exactly as today.

**Hardening 4 — a throwing FIRST run disposes what it created.** Today
`effect(fn)` whose initial run throws keeps its record, its pre-throw
links, and its armed state — it re-runs when those dependencies change,
even though no stop callable was ever returned, so it can never be
stopped: an unstoppable half-armed effect that is also a leak.
`effectScope(fn)` leaks its record, region, and children the same way.
Both now dispose on initial-run throw. This is a SEMANTIC CHANGE, not
just a leak fix — retry-shaped code that relied on the half-armed effect
re-running loses that behavior — and the test pins the new semantics
explicitly.

**Hardening 5 — the free-record SWEEP (and only the sweep) runs when
the frame depth returns to zero.** A synchronous loop whose only
allocations happen inside tracked frames starves maintenance today; with
detachment, attach/detach cycles are exactly such a loop (a `trigger`
loop over a detachable signal consumes a record per iteration). Frame
exits at depth zero run the pending free-record sweep synchronously —
the sweep moves no memory and every queue that could name swept records
is generation-guarded, so it is safe under live host closures. Arena
GROWTH is excluded, permanently: growth retires the arena generation,
and any host closure on the stack — an exiting effect's own finally, the
flush loop between queued effects, an update's promotion wave — still
holds the retiring generation's state; growth may run only where the
host stack is empty, which means the microtask maintenance path and the
explicit `growCapacity()` call. The review rounds established that even
today's allocation-site growth violates this (a `trigger` whose scratch
allocation grows mid-setup runs its body un-bracketed against a retired
closure; a scope-owned record allocated across a growth registers a
generation read from the zeroed arena) — filed as pre-existing kernel
bug #4: synchronous growth under live host frames is unsound wherever it
fires, and the fix (microtask-only growth) is a prerequisite here.
Synchronous code whose LIVE set outgrows the arena inside one frame
still throws with headroom exhausted, exactly as today; churn loops need
the sweep, not growth, and get it at every exit.

## Documented limitation: mass first-reads inside one tracked frame

Attach moves record allocation to the first tracked read, which always
runs inside a tracked frame — where arena growth is deferred and only the
capacity headroom (a quarter of the arena) can absorb new records. A
program that creates a very large number of detached signals and then
first-reads all of them inside a single effect can exhaust the arena
mid-operation and throw, where today's eager allocation would have grown
the arena between creations. This is a real behavioral regression for
that shape. The throw itself is bounded: the attach rollback (step 3)
frees the failing signal's record, and hardening 4 disposes a first-run
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

`reset()` refuses to run inside an open batch (it already refuses during
active operations; the batch guard closes a documented-but-unenforced
gap: resetting host counters under a live `endBatch()` would drive the
batch depth negative and kill flushing for the process). At quiescence,
the reset walk delivers the unwatched dispatch before rewinding the
arena; an attached default callable has a populated hook, so the walk
DETACHES it — newest value copied into the closure, closure id zeroed,
hook cleared. This is the defined behavior, and a strictly better
contract than today's for this one path: after `reset()`, every default
signal callable (attached or not) is a working detached signal holding
its newest accepted value. Every OTHER pre-reset handle (raw ids,
owner-stamped objects, computed callables, effect stops) remains
undefined to reuse, exactly as today.

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
ratio of medians. REGRESSION gates (threshold at or above 1) pass when
the ratio is at or below max(threshold, 1 + 2x the baseline's relative
median absolute deviation across its own five runs). PAYOFF gates
(threshold below 1) get no noise loosening: the bare ratio must meet the
threshold. If the baseline's relative median absolute deviation exceeds
3%, the environment is rejected and the measurement redone — a noisy
machine must not loosen every gate at once.

- **One `id === 0` compare on every default-callable read and write.**
  Gate: read-heavy and update-heavy suite rows, threshold 1.01, measured
  through the CALLABLE tier (the benchmark adapter uses the default
  callables; a raw-tier measurement would never execute this compare).
- **Attach/detach oscillation is the new worst case**: a sole consumer
  that repeatedly mounts and unmounts around the same signal pays record
  alloc + column seed + hook closure + link per cycle, where today it
  pays link/unlink against a persistent record. Dedicated micro through
  the callable tier whose measured window is 10,000 cycles PLUS a forced
  maintenance flush, so the deferred sweep cost cannot fall between
  samples. Threshold: 2.0. `trigger()` over an otherwise unwatched
  detachable signal is the same cost family and is measured in the same
  micro; hardening 5 additionally gates its steady state: one million
  synchronous trigger iterations over one detachable signal never grow
  the arena beyond its initial capacity.
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

## Additional correctness obligations (v3-v5)

12. Identity: save a frame, dispose its subscriber, force a sweep and a
    recycle so the record hosts a live stranger, restore the frame — the
    restore installs 0 (generation mismatch), and subsequent reads are
    untracked. Repeat via every save channel: the public frame setter,
    effect/scope creation exits, cleanup invocation, and the trigger
    scratch.
13. Clear side: free the active subscriber via scope-region teardown and
    via registry reclamation (paths that never pass through dispose) —
    tracking stops at the free; a detachable signal read afterwards in
    the same frame returns its closure value with no attach.
14. Disposal mid-run unlinks the entire old dependency set via the
    consume-the-head loop, including when an unlinked child's cleanup
    disposes siblings mid-walk; child cleanups run in creation order
    (pinned); the computed double-teardown corruption is covered.
15. Attach inside a scoped effect for a top-level signal: the record
    joins NO region; disposing the scope leaves the outside consumer
    linked and propagating.
16. Attach under a pending arena growth inside a manual frame: the
    enter-depth bracket defers migration; the link lands in the same
    generation as the record. A record-allocation throw at step 1
    unwinds the bracket (maintenance and reset() remain reachable).
17. Reset-sweep masquerade immunity: with cycle counters forced past
    8192, reset over live links never invokes the Signal detach branch
    (hook-presence gate holds); the underlying kernel misdispatch is
    filed and tested separately.
18. Hardening 4: a throwing first run of effect() OR effectScope()
    disposes the record (and the scope region); the semantic change from
    today's half-armed survivor is pinned explicitly.
19. Hardening 3: drop exactly once at update exit only if still
    unwatched; bit cleared on every exit including throw and on
    re-watch; a computed re-watched before its exit keeps its
    dependencies; never-watched untracked computeds unchanged.
20. Hardening 5: one million synchronous trigger() iterations over one
    detachable signal never grow the arena beyond initial capacity
    (records recycle at exits); growth fires only from the microtask
    path or growCapacity() — never inside a frame exit (asserted by
    instrumentation in the test build).
21. reset() throws inside an open batch; at quiescence it detaches
    attached default callables with their newest accepted value.
22. Pre-existing bug #4 regression (lands with its fix): a trigger()
    issued right after an in-frame growth-threshold crossing is fully
    functional — tracked reads link, the finally propagates, the
    enter-depth bracket brackets the live arena.
23. Frame identity across growth: a saved (id, generation) pair
    validates correctly when the growth migration happens between save
    and restore (generations survive migration verbatim).
24. GC leak suite extension: hook environments, detached closures, and
    the freed-notification cache clears under all of scope, registry,
    and dispose reclamation paths.

## How v5 answers the v4 reviews

- Restore-site identity blindness (a4 FATAL 1; b4 FATAL 1) → saved
  subscribers are (id, generation) pairs at all seven save channels plus
  the scope and trigger-scratch caches; generation, not liveness, is the
  validation. Obligations 12, 23.
- Incomplete site/clear enumeration (a4 MAJOR 3; b4 MAJOR 2) → the seven
  sites are named; the clear side rides the freed-notification seam,
  covering region and registry frees. Obligation 13.
- Growth at exits (a4 FATAL 2; b4 FATAL 5-class) → hardening 5 is
  sweep-only; growth is microtask-or-explicit only, which also names
  pre-existing kernel bug #4 (today's allocation-site growth under live
  host frames). Obligations 20, 22.
- Re-watched-before-exit drop (a4 MAJOR 4; b4 FATAL 4) → conditional
  drop (still-empty check), bit cleared on all exits and on re-watch.
  Obligation 19.
- Forward-walk order and idempotence (a4 MAJOR 5; b4 MAJOR 3) →
  consume-the-head loop is normative; creation-order cleanups pinned;
  reset keeps its own order. Obligation 14.
- reset() in an open batch (a4 MAJOR 6; b4 FATAL 6) → reset refuses
  (batch guard added), closing today's documented-but-unenforced gap.
  Obligation 21.
- Hardening 4 framing (a4 MINOR 8) → pinned as a semantic change with
  the old behavior described. Obligation 18.
- Renumbering slip (a4 MINOR 9) → fixed.
- Gate residue (a4 MINOR 10; b4 MAJOR 7-8) → payoff gates exempt from
  the noise floor; environment rejected above 3% relative deviation;
  the oscillation window is 10,000 cycles; the steady-state gate is
  "never grows beyond initial capacity"; the taxonomy cell for
  effects/scopes reads "explicit stop only."

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
