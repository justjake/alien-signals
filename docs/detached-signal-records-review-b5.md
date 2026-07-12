## Findings

1. **FATAL — `(id, generation)` still accepts a subscriber freed before the sweep.**

   The design explicitly chooses generation instead of liveness, while also acknowledging that generation bumps are sweep-deferred. In the real kernel, logical free clears flags and unlinks existing dependencies, then queues the record; `hostFreed` and the generation increment happen only later during `sweepPendingFree()` ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1193), [system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1243)).

   Scenario:

   1. Create subscriber `A`; save frame `(A, gen0)` and disable tracking.
   2. `dispose(A)` clears `A`’s flags and dependencies but leaves generation `gen0`.
   3. Restore `(A, gen0)` before a sweep. Generation matches, so v5 restores dead `A`.
   4. Read a detached signal. It attaches and links into `A`.
   5. The attach bracket exits and synchronously sweeps `A`.
   6. `freeNode()` zeroes `A.Deps` without unlinking the newly inserted edge, because the dependency teardown already happened in step 2.
   7. The signal retains a subscriber link forever, pinning its hook. If `A` is recycled, writes can be attributed to the new occupant.

   The freed callback cannot close this window: it is dispatched at step 5, after the corrupting link was created. Validation must require **both** matching generation and `Live`, or generation must bump at logical free. This directly falsifies hardening 1’s “no window” claim ([detached-signal-records.md](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:167)).

2. **MAJOR — record generation is not identity across `reset()`.**

   `resetState()` fills the arena with zero, including every generation slot ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1161)).

   1. Save `(A, 0)` and disable tracking.
   2. Call quiescent `reset()`.
   3. Allocate `B`; it receives `A`’s id and generation zero.
   4. Restoring `(A, 0)` passes and installs `B`.

   Growth migration is sound because it copies generations verbatim. Reset is not. If saved frame tokens are classified as invalid pre-reset handles, that exclusion must be explicit; otherwise an arena/reset epoch is required.

3. **MAJOR — the public frame-pair representation is unspecified.**

   Today `setActiveSub` accepts and returns a numeric `SignalId` ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:349)). Adding an internal `activeSubGen` is insufficient because the returned numeric id loses the saved generation.

   A sound implementation requires an API change—such as an opaque `{id, gen, epoch}` frame token—plus a distinction between installing a live raw id and restoring a token. V5 specifies neither the type nor its allocation/API cost.

4. **MAJOR — microtask-only automatic growth breaks ordinary synchronous creation bursts.**

   This regression is broader than the documented “mass first-reads inside one tracked frame” case.

   1. Create a small-capacity system.
   2. Synchronously create nodes in a plain top-level loop.
   3. Today, each allocation is an operation boundary, so the next allocation grows after the 3/4 threshold.
   4. Under v5, growth waits for a microtask.
   5. The same loop fills the remaining quarter and throws before yielding.

   The existing growth suite explicitly pins this currently working shape with 300 synchronous creations against capacity 64 ([growth.spec.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/tests/growth.spec.ts:11)); it also pins the shape inside an open batch ([growth.spec.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/tests/growth.spec.ts:35)). Bug #4’s generation-split fix is mechanically safe, but microtask-only growth is not behaviorally compatible.

5. **MAJOR — the gates miss the surviving failures.**

   - Obligation 12 forces a sweep before restoration, so it misses finding 1’s free-before-sweep window.
   - Obligation 23 covers growth migration but not reset identity.
   - No gate preserves today’s synchronous multi-operation automatic-growth behavior.
   - No type/API gate defines the new public saved-frame representation.

## Surfaces not refuted

- **Sweep-only frame exits:** not refuted. Logical free already removes edges; the sweep only clears records, bumps generations, and populates free stacks. Queued effects and pending regions are generation-guarded, freed link fields remain readable, and the sweep performs no allocation or migration.
- **Conditional deferred drop:** not refuted. The current-subscriber emptiness check, clearing on every exit including throw, and cancellation on re-watch close the v4 wrong-drop and bit-leak cases. Implementation must wire the existing `watched` callback; currently this host supplies only `unwatched`.
- **Core detach mechanics under a genuinely live subscriber:** not refuted. `pendingVals` copy-out, hook-presence dispatch, clear-before-queue, scope exclusion, attach rollback, and fresh reattachment before sweep compose correctly.
- **Reset batch guard:** not refuted.
- **Exact bug #4 generation split:** resolved by excluding growth from host-frame exits and allocation-site boundaries, notwithstanding finding 4’s new compatibility regression.

## V4 review disposition

### a4

1. **NOT RESOLVED** — generation is unchanged between logical free and sweep; reset also reuses generation zero.
2. **RESOLVED** — exits run only the non-migrating sweep.
3. **NOT RESOLVED** — sites are enumerated, but the claimed clear-at-free seam actually dispatches at sweep.
4. **RESOLVED** — drop is conditional and the bit is consumed/cancelled.
5. **RESOLVED** — consume-the-current-head and creation-order semantics are normative.
6. **RESOLVED** — reset refuses an open batch.
7. **RESOLVED** — growth no longer retires an arena beneath a live host closure; finding 4 is a new regression.
8. **RESOLVED** — first-run disposal is identified as a semantic change.
9. **RESOLVED** — renumbering corrected.
10. **RESOLVED** — the stated v4 gate residues are corrected; finding 5 identifies new omissions.

### b4

1. **NOT RESOLVED** — pair validation remains identity-blind before sweep and across reset.
2. **RESOLVED** — all seven lexical sites, scope, scratch, and growth handoff are named, though the public token representation remains unspecified.
3. **RESOLVED** — cleanup order and head re-read are explicit.
4. **RESOLVED** — re-watch cancels the pending drop; exit rechecks emptiness.
5. **RESOLVED** — no exit-time growth remains.
6. **RESOLVED** — reset rejects open batches.
7. **RESOLVED** — payoff gates no longer receive noise loosening.
8. **RESOLVED** — effects/scopes correctly say explicit stop only.

REFUTED


