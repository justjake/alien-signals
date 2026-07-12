Verdict: REFUTED. V4 moves the central identity error from link insertion to frame restoration: a live slot is still not proof that it contains the subscriber whose ID was saved. It also introduces unconditional deferred teardown, unsafe exit-time migration, and a supported `reset()` sequence that permanently corrupts batching.

## Findings

1. **FATAL — Restore validation is identity-blind and can install a recycled stranger as `activeSub`.**

The proposed validator checks `Flag.Live` on a bare numeric ID. Reclamation increments the generation and permits the same ID to name another live node, but the saved frame state contains no generation. This is the exact distinction v4 says killed link-time gating, now reused at restoration.

Public-API scenario:

1. `const old = effectId(() => {})`.
2. `setActiveSub(old)`.
3. `const saved = setActiveSub()` saves `old` while disabling tracking.
4. `dispose(old)`, then yield to the scheduled maintenance microtask.
5. `const replacement = effectId(() => {})` reuses `old`’s record.
6. `setActiveSub(saved)` performs the proposed live-flag validation.
7. The check passes because `replacement` is live.
8. Read a detached `signal()`. It attaches and links to `replacement`, even though that effect never read it.
9. Writing the signal spuriously reruns `replacement`.

The current setter stores only an ID ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:349)); recycling changes the generation only at sweep ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1243)). V4’s assertion that “recycled ids can never occupy `activeSub`” is therefore false.

Defeats: Hardening 1, obligations 12–13, and the v3-resolution claim at [detached-signal-records.md](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:371).

2. **MAJOR — The stated restore-site list is incomplete; literal implementation leaves dead IDs restorable.**

The actual restore/assignment sites are:

1. `setActiveSub` ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:349)).
2. Initial `effectId` exit ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:502)).
3. `effectScopeId` exit ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:544)).
4. `trigger` exit ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:659)).
5. `updateComputed` exit ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:795)).
6. Effect `run` exit ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:838)).
7. `runCleanup` exit ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:902)).
8. Arena growth additionally transfers `activeSub` through `state()` into a new host generation; it is a state handoff rather than a lexical restore ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:316)).

V4 names only “the public frame setter and the run/update/trigger exits.” It omits both initial-creation finally blocks and `runCleanup`.

Public-API scenario if that list is implemented literally:

1. Create parent `P` and install it with `setActiveSub(P)`.
2. Call `effectId(() => dispose(P))`.
3. The child’s body runs with the child active, so disposing `P` does not clear the current `activeSub`.
4. The `effectId` finally restores saved `P`.
5. A subsequent detached read observes a nonzero dead subscriber.

`runCleanup` has the same hole: a cleanup can dispose the subscriber saved before tracking was disabled and then restore it.

Defeats: Hardening 1’s “every site” claim and obligation 12.

3. **MAJOR — Forward disposal reverses observable child-cleanup order.**

Today complete teardown walks from `DepsTail` backward ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:926)). Child effects are dependencies of their parent, and unlinking them synchronously invokes `unwatched`, disposal, and user cleanup ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1408)).

Public-API scenario:

1. Create a parent effect.
2. Inside it, create child A returning cleanup `() => order.push("A")`.
3. Then create child B returning cleanup `() => order.push("B")`.
4. Stop the parent.
5. Current reverse teardown produces `["B", "A"]`.
6. Hardening 2’s head-first walk produces `["A", "B"]`.

That is an externally observable semantic change, not merely an equivalent complete walk. Nested scopes and cleanup-triggered cascades expose the same ordering.

The narrower mid-run question is not independently refuted: if Hardening 1 clears the exact active subscriber synchronously, reads after self-disposal are untracked and do not recreate links.

Defeats: Hardening 2’s presentation as an independent lifecycle hardening with unchanged behavior.

4. **FATAL — A computed re-watched before update exit still executes the pending drop and loses live dependencies.**

The pending bit records “became unwatched during this update,” but v4 says only that update exit performs the drop “if the bit is set.” It neither cancels the request when the computed is re-watched nor conditions the exit drop on current subscriber emptiness. The kernel explicitly permits synchronous re-subscription during `unwatched` and checks for it afterward ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1756)).

Public-API scenario:

1. Create source signal `S`, computed `C`, old consumer effect `E`, and another live effect `R`.
2. `E` is initially the sole subscriber of `C`; `C` depends on `S`.
3. Write `S`, causing `C` to update while `E` is being checked.
4. Inside `C`’s getter, call `dispose(E)`.
5. Removing `E → C` makes `C` unwatched mid-update, setting the proposed pending-drop bit.
6. Before the getter returns, temporarily call `setActiveSub(R)` and read `C`.
7. That self-read is stale by current contract but creates `C → R`; `C` is watched again before its update exits.
8. Restore the previous subscriber and return from the getter.
9. V4’s unconditional bit-driven exit drop removes `S → C` despite `R` still watching `C`.
10. Future writes to `S` no longer invalidate `C` or notify `R`.

The document also never says whether the bit is cleared before or after the drop; without an explicit consuming transition, obligation 19’s “exactly once” does not follow.

Nested updates of different computeds are not refuted: a per-record bit naturally belongs to the corresponding record’s unique update frame. The re-watched transition is the fatal missing state.

Defeats: Hardening 3, obligation 19, and the claimed resolution of a3-3/b3-4.

5. **FATAL — Running boundary work at the current depth-zero decrement retires the arena before the exiting frame finishes using it.**

Every relevant `finally` currently decrements `EnterDepth` before completing old-generation work:

- `effectId` still restores `activeSub` and clears flags afterward ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:514)).
- `updateComputed` still restores, clears `RecursedCheck`, and purges dependencies afterward ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:809)).
- `run` similarly restores and purges afterward ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:845)).
- `trigger` performs most of its unlink/propagation teardown around the decrement ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:665)).

Growth constructs the new engine, retires and zeroes the old arena, then creates a new host from the old host’s current state ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:835), [index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:203)).

Public-API scenario:

1. Start an effect whose first body calls `growCapacity(...)`.
2. Growth is deferred because `EnterDepth > 0`.
3. The effect’s finally decrements the depth to zero.
4. Hardening 5 synchronously performs growth at that point.
5. The new host snapshots `activeSub = effectId` because restoration has not occurred.
6. The old arena is retired and zeroed.
7. The remainder of the old finally restores only the retired host closure and clears flags only in dead memory.
8. After `effectId` returns, an otherwise untracked detached read links itself to the finished effect.
9. A later write spuriously reruns it; its live record may also retain `RecursedCheck`.

A sweep at that same point can likewise reclaim records whose IDs and links are still referenced by the rest of the finally. Public IDs used after a completed `trigger()` survive an otherwise correctly placed growth because migration preserves IDs; the failure is specifically that the proposed “depth-zero exit” occurs before the current exit is operationally finished.

Defeats: Hardening 5, obligations 16 and 20, and the attach-bracket claim that no generation is split under live host frames.

6. **FATAL — `reset()` inside the newly supported open-batch state preserves the value but permanently poisons `batchDepth`.**

An open batch does not increment `EnterDepth`, so the current reset guard permits this state ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1152)). The detach hook can indeed copy `pendingVals` before the host arrays are wiped: `system.reset()` runs first, and the arrays are cleared afterward ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:1128)). That part is reachable.

But `host.resetState()` sets `batchDepth = 0` ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:320)), while the caller still owns a matching `endBatch()`.

Public-API scenario:

1. Attach `s`.
2. `startBatch()`.
3. Write `s(1)`.
4. Call `reset()`; the hook copies staged `1` correctly.
5. Call the required matching `endBatch()`.
6. `endBatch` executes `--batchDepth`, changing `0` to `-1` ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:379)).
7. Create a new signal and effect after reset.
8. Write the new signal.
9. Automatic flushing never occurs because `batchDepth` is permanently truthy; `getBatchDepth()` reports `-1`.

Thus obligation 21 promotes a previously accidental state into a tested contract while leaving the surrounding batch protocol invalid.

Defeats: the `reset()` contract and obligation 21. The narrower staged-value copy is not refuted.

7. **MAJOR — The noise formula nullifies both required payoff gates.**

The acceptance rule is:

`ratio <= max(stated threshold, 1 + 2 × baseline rMAD)`

The noise term is always at least `1`. Therefore:

1. The creation payoff threshold `0.75` is replaced by a threshold of at least `1.00`.
2. The detached-heavy memory threshold `0.70` is also replaced by at least `1.00`.
3. A change with zero creation or memory improvement passes both supposed payoff gates.
4. With nonzero baseline noise, an actual regression passes.
5. The full-suite `1.00` threshold is loosened above `1.00` for the same reason.

Consequently the implementation can retain every new hook allocation and high-water column cost, deliver none of the promised creation/memory payoff, and still pass. `K`, the exact benchmark suite membership, and the mechanism for a “forced maintenance flush” are also unnamed, leaving further room for window selection.

Defeats: Costs and gates, especially [detached-signal-records.md](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:268), a3-9, and b3-8.

8. **MINOR — The taxonomy invents an effect/scope “disposer registry” absent from the implementation.**

`effectId` uses ownerless `allocNode`, not `createNode`, and the returned stop closure is not registered anywhere ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:495), [index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:1358)). The only `FinalizationRegistry` handles owner-registered signal/computed records.

Public-API scenario:

1. Create an effect reading signal `s`.
2. Drop the returned stop closure.
3. Force host garbage collection.
4. Write `s`.
5. The effect still runs because the graph retains it; no disposer registry reclaims it.

The correct current reclaimer is explicit stop or parent/scope cascade, not the table’s “explicit stop, disposer registry net.”

Defeats: the creation-path taxonomy at [detached-signal-records.md](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:22).

## Surfaces not refuted

- Hardening 2’s full head walk does remove every old dependency of a self-disposed running subscriber; with immediate `activeSub` clearing, later body reads do not re-track.
- Hardening 3’s distinction between a real unwatched dispatch and a never-watched untracked computed is not refuted.
- Per-record pending bits match nested updates of different computeds; reentrant self-reads do not start a second full update of the same record.
- Hardening 4’s first-run disposal coverage for both effects and scopes: not refuted.
- Attach’s try/finally unwind, full signal flags, hole-free column growth, both-value seeding, and scope-region exclusion: not refuted.
- Hook-presence dispatch, double-dispatch no-op, and copying `pendingVals` as the newest value: not refuted.
- The reset hook’s staged-value copy before array clearing: not refuted.
- Growth after the entire exiting frame has finished using its old-generation locals: not refuted. The specified/current decrement point is the refuted surface.

## V3 review disposition

### a3 findings 1–10

- a3-1 — **RESOLVED**: immediate tracking shutdown plus full head-based unlink closes the exact re-marked-edge construction.
- a3-2 — **NOT RESOLVED**: live-flag restore validation remains identity-blind after record recycling.
- a3-3 — **RESOLVED**: deferral closes the exact dangling-tail/self-loop schedule; finding 4 is a new re-watch failure.
- a3-4 — **RESOLVED**: link refusal and its orphaned attach record disappear with the gate.
- a3-5 — **NOT RESOLVED**: depth-zero boundary work is specified at an unsafe point in existing frame exits.
- a3-6 — **RESOLVED**: attach’s bracket is explicitly unwound with `try/finally`, including record-allocation failure.
- a3-7 — **RESOLVED**: full flags and hole-free column growth are now explicit.
- a3-8 — **RESOLVED**: reset now accurately describes attached callables becoming detached.
- a3-9 — **NOT RESOLVED**: the noise formula erases the sub-1 payoff thresholds.
- a3-10 — **RESOLVED**: first-run `effectScope` failure is explicitly covered.

### b3 findings 1–9

- b3-1 — **RESOLVED**: full-list disposal closes the exact ungated re-mark path.
- b3-2 — **NOT RESOLVED**: recycled-occupant identity-blindness survives in restore validation.
- b3-3 — **RESOLVED**: the refusal path no longer exists.
- b3-4 — **RESOLVED**: only a real unwatched dispatch sets the bit; never-watched computeds are excluded.
- b3-5 — **NOT RESOLVED**: synchronous exit maintenance can split the exiting host frame across generations.
- b3-6 — **RESOLVED**: record-allocation failure explicitly unwinds the attach depth.
- b3-7 — **RESOLVED**: self-stopping effects now clear tracking, so replacement children become roots as v4 states.
- b3-8 — **NOT RESOLVED**: payoff gates are mathematically disabled and benchmark boundaries remain underspecified.
- b3-9 — **RESOLVED**: the reset survivor mechanics now match the hook behavior.

No files were modified.


