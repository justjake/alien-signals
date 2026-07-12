# Design v7: detached signal records (default signal callables stop using the FinalizationRegistry)

Status: v7 DRAFT — seventh revision. Refutation history: v1 architecture
(-a/-b); v2 boundaries (-a2/-b2); v3 gate mechanism (-a3/-b3); v4 frame
identity and exit-growth (-a4/-b4); v5 a single timing premise (-a5/-b5):
the freed notification and the generation bump fired at the sweep, so the
free-to-sweep window defeated the clear side; v6 the relocation's
collateral (-a6/-b6): moving the freed hook WHOLESALE to logical-free time
cleared the host columns that `disposeEffect` reads after `freeNode`
returns, and three hardenings were specified more broadly than the code
they land in (sweep placement, growth sites, walk rules). v7 splits the
freed hook into an identity phase (logical free) and a release phase
(sweep), and re-specifies the three hardenings against the actual call
sites. Both v6 reviews confirmed the detach mechanics proper and the
queue-time generation bump survive attack unchanged. The rounds have
surfaced SIX pre-existing kernel/host bugs, each a named prerequisite
fix. Resolution maps for all rounds are at the end.

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
   (growth, per hardening 5, happens only on the microtask path, an
   explicit growCapacity call, or a creation trampoline's pre-dispatch
   boundary — never at a frame exit and never inside a host frame);
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
3. reclaim the record through the standard logical free: the hardening-1
   IDENTITY PHASE runs first (flags cleared, generation bumped, frame
   caches compared and zeroed), then the record is pushed onto the
   boundary `pendingFree` queue and maintenance is scheduled — the same
   sequence every other logical free performs, so the sweep never bumps
   again. The record's memory is not reused until the quiescent-point
   sweep (hardening 5), which is the mid-walk safety envelope: no kernel
   traversal can hold the record when the sweep runs. (The kernel's
   `unwatched` zeroes the version snapshot after the host dispatch
   returns — the reclaimed record's snapshot is unreachable either way,
   and the sweep re-zeroes it.)

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
corruption or leaks that are reachable today without this design. (A
sixth pre-existing kernel bug — mid-walk link-record reuse — is filed
under hardening 5, where its fix lives.)

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
  0 when the generation no longer matches. One carve-out: `reset()`
  rewinds every generation, so a frame pair saved before a reset is a
  pre-reset handle and undefined to restore, like every other pre-reset
  handle;
- the same discipline covers the two cached-id channels that are not the
  active subscriber: the current scope and the trigger scratch record;
- the freed dispatch SPLITS INTO TWO PHASES, because its current single
  seam does two unrelated jobs. The IDENTITY PHASE moves to LOGICAL-FREE
  time and runs at the very top of the free, in this normative order,
  before the dependency unlinking that can cascade into user cleanups:
  (1) clear the live flag and the rest of the flags word, (2) bump the
  generation, (3) compare the freed id against the active subscriber,
  current scope, and trigger scratch and zero any match. Non-live comes
  FIRST so a child cleanup that re-entrantly disposes the same record
  hits the live-flag gate instead of queueing it twice under the fresh
  generation; the bump and cache clears complete before ANY user code
  can run inside the free, so the v5 free-to-sweep window never opens.
  The identity phase touches no host columns and runs no user code. The
  RELEASE PHASE — the existing host freed hook that clears the five host
  columns — STAYS AT THE SWEEP, unchanged. This split is load-bearing in
  both directions: `disposeEffect` reads `cleanups[]` and `owned[]`
  after `freeNode` returns (its cleanup run and region hand-off depend
  on the columns surviving the free), and a self-stopping effect's try
  block stores its returned cleanup into the freed record's column AFTER
  the free — the sweep's unconditional column clear is what catches that
  late store, so neither dispatch time alone is correct. The invariant,
  stated normatively: a freed record's host columns remain intact from
  the logical free until the sweep's release phase, may be read by the
  freeing call's own straight-line continuation, and are cleared
  unconditionally at the sweep whatever landed in them meanwhile; no
  host code may DEPEND on a post-free column write surviving the sweep.
  Effect-queue entries and region entries holding the pre-bump
  generation mismatch from the moment of the free — which is the
  direction every one of those guards wants;
- every generation guard protects ALL the mutations made on the guarded
  record's behalf, host-side stores included: a deferred consumer of a
  saved (id, generation) pair — the region teardown walk, the registry
  orphan callback — validates the pair BEFORE touching any host column
  or closure slot for that id. (Today's region teardown erases
  `fns[idx]` before its generation check runs; against a recycled
  occupant that store deletes a live stranger's getter. The store moves
  after the guard.);
- the registry ownership channel gets the same identity discipline: the
  registration's held value becomes an (id, generation) pair, and the
  orphan callback validates the generation before touching the record
  (today it checks only the live flag of whatever occupies the slot —
  filed as pre-existing bug #5: disposing an owner-registered id and
  recycling its record leaves the registration armed against the new
  occupant). The pair is captured ATOMICALLY AT ALLOCATION — read back
  from the engine's memory after the allocation call returns, so a
  growth forwarded mid-call yields the new arena's generation — never at
  the deferred registration drain, where a free-and-recycle between
  creation and drain would capture the stranger's generation and arm
  bug #5 one hop later;
- the public frame save/restore pattern gets a concrete pair-carrying
  API: `getActiveSubFrame(): number` returns a frame token — a single
  f64 packing the subscriber id in the low 31 bits and the low 22 bits
  of its generation above them (both integer-exact in one f64; zero
  allocation per save) — and `setActiveSubFrame(token: number)` unpacks
  it, compares the generation bits against the record's current
  generation, installs the id on match and 0 on mismatch. A false match
  requires the same record to be freed and recycled exactly 2^22 times
  between save and restore — documented and accepted. The existing
  numeric `setActiveSub(id)` seam is retained for the raw tier with a
  narrowed documented contract: valid only for an id the caller knows
  is live, like every other raw handle; the documented save/restore
  pattern moves to the token pair.

Consequences: reads in a doomed frame are simply untracked (a detached
signal read there returns its closure value and never attaches), a
recycled record can never inherit a stale frame (generation mismatch
restores 0), and tracking can never be attributed to a recycled
occupant. One semantic pinned by test: an effect that stops itself and
then spawns a replacement child creates that child in an untracked
context — the child becomes a root effect and survives.

**Hardening 2 — no link walk survives an unlink that can run user code
with a cached link pointer; each walk re-reads a stable anchor
instead.** Today's teardown walks backward from the dependency-tail
cursor, which a RUNNING frame has reset to zero — so disposing a running
subscriber unlinks nothing and leaves its old edges alive in every
dependency's subscriber list (reachable today). And every walk that
caches a next pointer across an unlink is corruptible: `unlink`
dispatches `unwatched` synchronously, which can dispose child effects
and run user cleanups, which can dispose other link holders and recycle
the cached link record onto a foreign edge. The normative rules, per
walk shape:

- FULL teardown walks — the disposal teardown and the unwatched
  dependency drop, which unlink everything — "unlink whatever the head
  slot currently names, until it names nothing." The head slot is
  re-read every iteration; no cached next pointer exists to go stale.
  This also fixes the double-teardown corruption for computeds (the
  second walk finds an empty head and stops).
- SELECTIVE and PARTIAL walks cannot consume the head (the child-effect
  disposal pass must SKIP non-effect deps; `purgeDeps` trims only past
  the tail cursor; `trigger`'s teardown loop unlinks the scratch
  record's deps). Each instead restarts from its stable anchor after
  EVERY unlink that can run user code, never resuming from a cached
  link id: the child-effect pass rescans forward from the sub's head
  slot and unlinks the first child effect found, repeating until a full
  scan finds none; `purgeDeps` re-reads the sub's tail-cursor slot and
  its next field after each unlink; `trigger` re-reads the scratch
  record's own head slot each iteration (its walk unlinks everything,
  so head-consumption applies).

Pinned semantic change: child cleanups now run in creation order rather
than newest-first; the reset path keeps its own separately documented
newest-first order. A test pins the new order.

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
dispatch also clears the bit. The bit lives in the record's flags word,
so a record freed mid-update drops it with its flags and the exit finds
nothing to do. A computed that was never watched never receives the
dispatch, so lazy untracked computeds keep their dependency graph and
caching semantics exactly as today.

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

**Hardening 5 — the free-record SWEEP (and only the sweep) runs at
QUIESCENT POINTS: the return path of an outermost public entry, where
frame depth is zero AND no kernel traversal is live; growth moves to the
creation trampolines' pre-dispatch boundary and out of the host frames
entirely.** A synchronous loop whose only allocations happen inside
tracked frames starves maintenance today; with detachment, attach/detach
cycles are exactly such a loop (a `trigger` loop over a detachable
signal consumes a record per iteration).

The sweep's placement condition is QUIESCENCE, which frame depth alone
does not establish: the dirtiness walk runs unbracketed at depth zero
(both the flush loop and a top-level lazy read evaluate it before or
outside any user-code bracket), and a computed update inside that walk
brackets 0→1→0 — so "any frame exit at depth zero" would sweep while the
walk's traversal stacks still hold link ids naming the freed records,
and a subsequent in-walk allocation could recycle a record the unwind is
about to consult. The sweep therefore runs only where BOTH hold: frame
depth is zero and the kernel's traversal state is empty (the check and
propagation stacks, and the stackless chain climb, are not mid-walk).
Concretely that is the return path of the outermost public entries —
write-flush completion, trigger completion, a top-level lazy read's
return, the microtask maintenance path — which is exactly where the
churn-loop motivation needs it: one sweep per trigger/write iteration.
The sweep moves no memory and every queue that could name swept records
is generation-guarded, so it is safe under live host closures at those
points.

Related and filed here as pre-existing bug #6: freed LINK records are
reusable mid-walk today. Links recycle immediately at unlink, so a
getter that disposes a node the current dirtiness walk descended
through frees link records still held on the walk's stack, and a later
in-walk `link()` can rewrite one as a foreign edge before the unwind
pops it. The fix rides the same quiescence notion: while a kernel
traversal is live, unlinked link records queue on a walk-local pending
list and join the free stack only when the walk unwinds — link-record
reuse becomes quiescent-only, matching node records. (Today's host
absorbs part of this through its freed-mid-walk guard, which is why the
bug is latent rather than everyday; detachment raises unlink churn, so
the design requires the fix rather than inheriting the latency.)

Arena GROWTH never runs at a frame exit (growth retires the arena
generation, and an exiting frame's epilogue still holds the retiring
generation's state) and never inside an in-flight host operation. The
v5/v6 claim that today's in-call growth forwarding is safe for all
frameless creation entries was wrong: it holds for top-level unscoped
`signalId`/`computedId` (post-allocation work touches only shared side
columns — verified twice), but `effectId` and `effectScopeId` allocate
BEFORE establishing their frame state and then keep executing in the
retired closure — the effect sets the dead generation's active
subscriber and brackets the dead arena while reads dispatch through the
new host: the effect is born tracking nothing, and under a manual frame
its parent link lands in the dead arena. Pre-existing bug #4 therefore
has FOUR sites, all fixed: (1) `trigger` allocates its scratch before
entering its bracket — the allocation moves inside the bracket; (2, 3)
the SCOPED creation entries (`signalId`, `computedId` under a current
scope) read the new record's generation through the pre-growth closure —
they re-read after the allocation returns; (4) `effectId` and
`effectScopeId` — the growth boundary check hoists OUT of the host
closure INTO the module trampoline, which runs the pending growth (host
stack genuinely empty at that instant) and only then dispatches into the
current — possibly new — host generation; inside a host closure,
allocation never grows. Growth's complete site list after this
hardening: the microtask maintenance path, explicit `growCapacity()`,
and the creation trampolines' pre-dispatch boundary. Synchronous code
whose LIVE set outgrows the arena inside one frame still throws with
headroom exhausted, exactly as today; churn loops need the sweep, not
growth, and get it at every quiescent point.

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
hatches are `growCapacity()` before the wide read, or yielding to the
microtask maintenance path between batches of first reads (an attach
always runs inside a tracked frame, so no synchronous spreading of the
reads alone can reach a growth site). Attach's enter-depth bracket (step 1) also means a
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

Link records carry no generation stamp, so generation cannot defend the
detach dispatch itself (v1 finding 8's residue). The actual guards: the
hook column entry is cleared at detach, so a second `unwatched` dispatch
for the same record finds no hook and is a no-op; and record reclamation
goes through the standard logical free, whose live-flag clear comes
FIRST in the identity phase (hardening 1) — a re-entrant second free
hits the flag gate before the generation has any chance to mislead it,
and the sweep frees each queued record once.

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
13. Identity phase at LOGICAL-FREE time, in pinned order: free the
    active subscriber via explicit dispose inside its own frame, via
    scope-region teardown, and via registry reclamation — in all three,
    the live flag clears FIRST, the generation bumps SECOND, and the
    frame caches zero THIRD, all before the free's dependency unlinking
    can cascade into user code; tracking stops at the free itself; a
    detachable signal read afterwards in the same frame returns its
    closure value with no attach; the self-stop-then-spawn scenario
    creates the child as a root effect with no ghost edge into the freed
    parent; a child cleanup that re-entrantly disposes the same record
    hits the live-flag gate and queues nothing.
14. No walk resumes from a cached link id across an unlink that can run
    user code: disposal mid-run unlinks the entire old dependency set
    via the consume-the-head loop, including when an unlinked child's
    cleanup disposes siblings mid-walk; the SELECTIVE child-effect pass
    rescans from the head after each unlink and still skips (and keeps)
    non-effect deps; `purgeDeps` and `trigger`'s teardown survive a
    cleanup that disposes the walk's own subject and recycles the cached
    link onto a foreign edge; child cleanups run in creation order
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
    (records recycle at quiescent points); growth fires only from the
    microtask path, growCapacity(), or a creation trampoline's
    pre-dispatch boundary — never at a frame exit and never inside a
    host frame (asserted by instrumentation in the test build).
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
25. Registry identity (pre-existing bug #5 regression): dispose an
    owner-registered id, recycle its record to a live node, drop the
    owner — the orphan callback generation-mismatches and the new
    occupant is untouched. The pair's capture point is pinned: create an
    owner-registered node while a growth is pending so the allocation
    forwards mid-call — the captured generation is the NEW arena's; and
    dispose-and-recycle a registered record between creation and the
    registration drain — the registration still holds the creation-time
    pair and mismatches.

## Additional correctness obligations (v6)

26. Split freed hook, disposeEffect side: stop an effect with a cleanup —
    the cleanup RUNS; stop an effectScope owning raw ids — the region is
    queued and every member is reclaimed; both also via the unwatched
    cascade and via reset(). (The a6/b6 FATAL regression.)
27. Split freed hook, late-store side: an effect that stops itself
    mid-body and returns a cleanup — the store lands after the free, the
    sweep's release phase clears it, the closure is collectable (GC leak
    suite), and recycling the record as a signal inherits no stale
    column entry.
28. Sweep quiescence: a computed getter that disposes a node the live
    dirtiness walk descended through, then creates nodes before the walk
    unwinds — no record held by the walk is recycled mid-walk; the walk
    resolves dirtiness correctly; instrumentation asserts the sweep
    never fires while the traversal stacks are non-empty. Pre-existing
    bug #6 regression (lands with its fix): freed link records are not
    reused while a kernel traversal is live.
29. Bug #4 sites 4a/4b (effectId/effectScopeId): cross the growth
    threshold, then create a top-level effect — it tracks its reads,
    re-runs on writes, brackets the live arena, and under a manual frame
    its parent link lands in the live generation; same for effectScope
    (nested raw nodes join the live scope's region and die with it).
30. Guard-before-mutation: save a raw id created in a scope, stop the
    scope, dispose the id, sweep, recycle the record to a live computed —
    the region teardown's generation guard rejects the entry BEFORE any
    host column store; the new occupant's getter survives.
31. Frame token: getActiveSubFrame/setActiveSubFrame round-trip
    installs the same subscriber; after free-and-recycle the restore
    installs 0; the token is a plain number (no allocation per save);
    packing widths are pinned by test.

## How v7 answers the v6 reviews

- The wholesale hook move (a6 FATAL 1, MAJOR 2; b6 FATAL 1) → the freed
  dispatch splits: an identity phase (non-live → generation bump →
  frame-cache clears, at the top of the logical free, before any user
  code) and the unchanged sweep-time release phase. `disposeEffect`'s
  post-free column reads survive; late column stores are caught by the
  sweep's unconditional clear; the re-entrant double-queue trap is
  closed by non-live-first ordering. The a5-7 invariant is now stated in
  the body (columns intact from free to sweep, cleared unconditionally
  at the sweep). Obligations 13 (rewritten), 26, 27.
- effectId/effectScopeId frameless growth (a6 MAJOR 4; b6 FATAL 2) →
  bug #4 refiled with four sites; the effect/scope fix hoists the growth
  boundary into the module trampoline before host-generation dispatch;
  in-closure allocation never grows; obligation 20 rewritten to match
  (the v6 self-contradiction with hardening 5 is gone). Obligation 29.
- Sweep placement (a6 MAJOR 3) → the sweep condition is quiescence
  (depth zero AND empty traversal state), placed at outermost
  public-entry returns; detach step 3's safety-envelope sentence now
  refers to that envelope. Pre-existing bug #6 (mid-walk link-record
  reuse, reachable today) is filed with its fix: walk-local pending list
  for links unlinked while a traversal is live. Obligation 28.
- Selective/partial walks (a6 MAJOR 5; b6 MAJOR 6) → hardening 2 is now
  a per-walk-shape rule: consume-the-head for the two full teardowns;
  anchored rescan after every user-code-capable unlink for the
  child-effect pass, purgeDeps, and trigger's teardown. Obligation 14
  rewritten.
- Registry pair capture (a6 MINOR 6; b6 MAJOR 3) → captured atomically
  at allocation, read back post-forwarding; never at the drain.
  Obligation 25 extended.
- Guard-before-mutation (b6 MAJOR 4) → normative rule in hardening 1:
  deferred consumers validate the pair before any host-side store; the
  region teardown's pre-guard `fns` erasure moves behind the guard.
  Obligation 30.
- Public frame API (a6 MINOR 8; b6 MAJOR 5) → named and specified:
  getActiveSubFrame/setActiveSubFrame with a packed-f64 token (31-bit
  id, 22-bit generation, wrap caveat documented); the raw id setter
  keeps a narrowed live-ids-only contract. Obligation 31.
- Consistency defects (a6 MINOR 7) → the Double-free defense section
  rewritten for queue-time bumps; detach step 3 states its identity
  phase and that the sweep never bumps again; obligation 13 pins
  bump-first ordering explicitly; the frame-token API lives in the body,
  not a phantom change list.
- Confirmed unchanged by both reviews: the queue-time generation bump
  itself, top-level unscoped signalId/computedId growth forwarding, and
  the end-to-end detach mechanics (sixth consecutive round).

## How v6 answers the v5 reviews

- The free-to-sweep window (a5 FATAL 1; b5 FATAL 1) → the generation
  bump and the freed-hook dispatch move to logical-free time; the sweep
  only zeroes slots and stacks the record. Obligation 13 rewritten to
  pin all three scenarios (scope self-dispose crash, self-stop
  replacement child, manual frame).
- Registry bare-id channel (a5 MAJOR 3) → registrations hold (id,
  generation) and the orphan callback validates it — pre-existing bug
  #5. Obligation 25.
- Microtask-only growth overreach (a5 MAJOR 2; b5 MAJOR 4) → retracted:
  growth keeps its frameless entry sites (top-level bursts grow as
  today); bug #4's fix targets exactly the two unsafe sites.
- Cached-prev walks beyond disposal (a5 MAJOR 4) → consume-the-head is
  normative for all three link-walk instances.
- Pending-bit home (a5 MINOR 5) → the flags word.
- Reset carve-out for saved frames (a5 MINOR 6; b5 MAJOR 2-class) →
  stated: pre-reset frame pairs are pre-reset handles.
- Exit-sweep column-read invariant (a5 MINOR 7) → stated and asserted
  by test-build instrumentation.
- Gate worst-case bound (a5 MINOR 8; b5 MAJOR 5-class) → stated
  explicitly (at most threshold plus six points under the rejection
  cap). The public frame-pair API shape (b5 MAJOR 3) → the raw seam
  keeps its id-based setter; the documented save/restore pattern becomes
  the pair returned by a new getter and validated by the restore path,
  named in the implementation change list.

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
