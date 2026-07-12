# Design v3: detached signal records (default signal callables stop using the FinalizationRegistry)

Status: v3 DRAFT — third revision. v1 was refuted outright (reviews -a, -b);
v2 was judged materially sounder but refuted on boundary conditions
(reviews -a2, -b2: 9 of 11 v1 items resolved). v3 resolves the v2 findings;
the resolution maps for both rounds are at the end.

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

1. allocate the record with the detachable host bit set through a
   DEDICATED attach path — not `signalId`, whose internals include the
   scope-region branch. An attached-by-read record must never join a
   region: a region frees by id, and a record whose real owner is its
   links being freed by a disposing scope silently unlinks live outside
   consumers and double-queues the record (v2 review). Attach also
   brackets steps 1-4 in the kernel enter-depth counter so a pending
   arena growth cannot migrate the arena between the allocation and the
   link insert (a manual tracking frame leaves the counter at zero, and
   a mid-attach migration would split the two across generations);
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

## Prerequisite hardening (separate changes, land first)

The design's premise is "a link proves a live subscriber." Three
public-API constructions falsify it today: an effect stopped during its
own run keeps tracking (its record is disposed but `activeSub` still
names it); a computed disposed from inside its own getter does the same;
and a MANUAL tracking frame (`setActiveSub`) has no run exit at all, so
no frame-exit cleanup can ever cover it. The v1 hardening (unlink at run
exit) therefore cannot establish the premise — v2 review, fatal finding.

**Hardening 1 — subscriber-liveness gate at link insertion.** The link
INSERT path (not the re-mark fast path) checks the subscriber record's
live flag and refuses to insert an edge for a dead subscriber; the read
returns the value untracked. This closes every construction at the root:
dead subscribers simply never gain edges, whatever frame shape produced
them. The re-mark fast path needs no check — with inserts gated, a dead
subscriber has no surviving links to re-mark (its edges were unlinked at
disposal). Cost: one flags load and mask per insert, gated by the
dynamic-dependency benchmark rows. This is a pre-existing bug fix on its
own: today those ghost edges leak the link and leave a stale
subscriber-list entry that propagation walks into whatever record next
occupies the freed slot.

**Hardening 2 — a throwing initial effect run disposes the effect.**
Today `effect(fn)` whose first run throws leaks the effect record, its
callback column entry, and every link the partial run tracked (no stop
callable is ever returned). Pre-existing; under this design the mass
first-read exhaustion shape makes it easier to hit, so it lands first
with its own test.

**Hardening 3 — a computed that becomes unwatched during its own update
re-drops its dependencies at update exit.** The host's unwatched cleanup
drops an unobserved computed's dependency graph; a getter that loses its
last subscriber mid-run and then keeps reading re-acquires dependencies
after that cleanup ran. The retained edges are not a permanent leak (the
computed's own registry reclamation unlinks them), but they contradict
the host's drop-when-unwatched memory policy and extend detachable
signals' pinned lifetime to the computed's. At update exit, if the
computed is unwatched, run the same dependency drop again. One semantic
choice this pins (with a test): an effect that stops itself mid-run and
spawns a replacement child gets the child killed with the doomed frame
under hardening 1's gate — the replacement must be created outside the
doomed frame.

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

`reset()` frees every record and drops every column wholesale. An
attached callable's closure still holds its pre-reset id afterwards —
using it is undefined behavior, exactly as using any pre-reset handle is
today (the id names arena memory the next generation reallocates). A
signal that happened to be detached at reset time holds no engine state,
so its closure keeps working and would attach into the post-reset arena
on its next tracked read. The contract is unchanged and stated plainly:
handles created before `reset()` must not be reused; neither "keeps
working" (detached) nor any particular failure (attached) is promised.

## Double-free defense

Generation stamps do not defend this path (link records carry none, and
node generation bumps are deferred to the sweep — v1 finding 8). The
actual guards: the hook column entry is cleared at detach, so a second
`unwatched` dispatch for the same record finds no hook and is a no-op;
and record reclamation goes through the same live-flag discipline as
`freeNodeId` (flags cleared at queue time, sweep frees once).

## Costs and gates

Measurement protocol for every gate: isolated alternating runs against
the pre-change build, medians of at least three rounds, on a machine
whose idle noise band has been measured first; a gate's threshold is
expressed relative to that band, not as a bare ratio.

- **One `id === 0` compare on every default-callable read and write.**
  Gate: read-heavy and update-heavy suite rows within the noise band,
  measured through the CALLABLE tier (the benchmark adapter uses the
  default callables; a raw-tier measurement would never execute this
  compare).
- **Attach/detach oscillation is the new worst case**: a sole consumer
  that repeatedly mounts and unmounts around the same signal pays record
  alloc + column seed + hook closure + link per cycle, where today it
  pays link/unlink against a persistent record. Dedicated micro-benchmark
  (effect-reads-signal, stop, repeat), through the CALLABLE tier. Budget:
  at most 2.0x the baseline cycle cost. `trigger()` over an otherwise
  unwatched detachable signal is the same cost family (its scratch
  subscriber attaches on entry and detaches in the finally) and is
  measured in the same micro.
- **Teardown-heavy row**: disposing one effect over a wide detachable
  dependency set cascades one detach per dependency inside the dispose
  path; a dedicated micro (effect reading 1,000 detachables, stopped)
  with the same 2.0x budget.
- **Full-suite verdict**: the benchmark suite's geometric mean, measured
  under the stated protocol, must not regress by more than the measured
  noise band's half-width, and no suite row may regress by more than
  1.05x unless it is one of the two budgeted micros above.
- **Creation is measured attach-inclusive**: create N, read all once
  under one consumer per signal, dispose — not bare callable creation
  (which improves definitionally and validates nothing).
- **Memory in two mixes**: attached-heavy steady state (hook closure
  versus registry cell, roughly a wash, must not regress) and
  detached-heavy (the payoff: no record, no registry cell, no column
  slots — must drop decisively).
- **Link-lifecycle costs land in tracking passes, not propagation**
  (v1 mis-gated this): the gates are the dynamic-dependency suite rows
  and the oscillation micro, not propagation rows.

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

## Additional correctness obligations (v3)

12. Hardening 1 regression: dispose an effect inside a manual
    `setActiveSub` frame, then read a detachable signal — no link is
    created, the read returns the value, nothing is pinned (GC-checked).
13. Hardening 1 regression: a computed disposed from inside its own
    getter tracks nothing afterwards; no ghost edge survives the update.
14. Hardening 3 regression: a computed that loses its last subscriber
    mid-update holds no dependencies at update exit.
15. Attach inside a scoped effect for a top-level signal: the record
    joins NO region; disposing the scope leaves the outside consumer
    linked and propagating (the v2 double-free construction).
16. Attach under a pending arena growth inside a manual frame: the
    enter-depth bracket defers migration; the link lands in the same
    generation as the record (no silent tracking loss).
17. Reset-sweep masquerade immunity: with cycle counters forced past
    8192, reset over live links never invokes the Signal detach branch
    (hook-presence gate holds); the underlying kernel misdispatch is
    filed and tested separately.
18. Initial-effect throw (hardening 2): the effect record, callback
    entry, and tracked links are disposed; only pre-throw attachments
    owned by OTHER live consumers persist.

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
