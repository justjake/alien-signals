Verdict: REFUTED. Hardening 1 still admits ghost edges, Hardening 3 is underspecified in a way that breaks ordinary untracked computeds, and the attach failure protocol leaks or poisons the global growth counter.

## Findings

1. **FATAL — The ungated re-mark fast path preserves an edge to a disposed subscriber.**

   Public-API scenario:

   1. Create `s = signal(0)`.
   2. Create an effect whose first run reads `s`.
   3. On its rerun, call its own `stop()` before rereading `s`.
   4. `run()` has already reset the effect’s `DepsTail` to zero ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:836)).
   5. Disposal walks backward from `DepsTail`; because it is zero, the old edge in `Deps` is not unlinked ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1208), [system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1804)).
   6. Reread `s` before the callback returns.
   7. `link()` finds the old edge through `nextDep`, updates its version, and returns without entering `linkInsert`, so the proposed liveness gate never runs ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1330)).
   8. `purgeDeps()` retains the re-marked edge.
   9. The disposed subscriber is later swept without unlinking it; the edge remains in `s`’s subscriber list and pins the detach hook.

   The identical construction works for a computed disposed inside its getter before rereading an old dependency. This directly falsifies “a dead subscriber has no surviving links to re-mark.”

   Defeats: Hardening 1, obligations 8 and 13, “The hook is the pin,” and the claimed v2 ghost-link resolution.

2. **FATAL — A stale manual `activeSub` links to a recycled, unrelated live node.**

   Public-API scenario:

   1. `const dead = effectId(() => {})`.
   2. `setActiveSub(dead)`.
   3. `dispose(dead)`.
   4. Yield to a microtask so the pending-free sweep recycles `dead`.
   5. Allocate `const impostor = signalId(0)`; the node free stack can return the same numeric id ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1224)).
   6. Read a detached default signal without restoring `activeSub`.
   7. The insertion gate reads `Flag.Live` from `impostor`, passes, and links the detached signal to that unrelated raw signal.

   The gate verifies slot liveness, not that the occupant is the subscriber which established the frame. Retaining `impostor` retains the wrong edge; propagation now walks into an unrelated node.

   Defeats: Hardening 1, obligation 12, and the assertion that insertion gating covers every frame shape.

3. **FATAL — Refusing insertion leaves the just-allocated attach record without a reclaimer.**

   Public-API scenario:

   1. Enter a manual frame with an effect id.
   2. Dispose that effect without restoring `activeSub`.
   3. Read a detached signal.
   4. Attach has already allocated and seeded the signal record before reaching link insertion.
   5. Hardening 1 refuses the insert without throwing.
   6. Attach’s only rollback handles a thrown link allocation; v3 defines no return/result contract or rollback for a refused insertion ([detached-signal-records.md](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:72)).
   7. Step 4 cannot install the hook because no link exists. The record consequently has no link, hook, registry owner, scope region, or public id.

   Installing the hook would pin it; omitting the hook leaks an unreachable live arena record. Obligation 12 cannot follow from the specified mechanics.

   Defeats: Attach steps 3–4, Hardening 1, hook-presence dispatch, and obligation 12.

4. **FATAL — Hardening 3 cannot distinguish “became unwatched” from “was never watched.”**

   Public-API scenario:

   1. `const s = signal(1)`.
   2. `let runs = 0`.
   3. `const c = computed(() => { runs++; return s(); })`.
   4. Call `c()` untracked. During its getter, `c` records `s`, but `c` itself has zero subscribers.
   5. The proposed update-exit test sees “unwatched” and runs the dependency drop.

   Two literal implementations both fail:

   - If “re-drop” only unlinks dependencies, `c` remains clean. After `s(2)`, no edge invalidates `c`; the clean branch of `getSlow` returns the stale cached `1` ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:943)).
   - If it reruns the full unwatched cleanup, it marks `c` dirty and zeroes its snapshot ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:760)). A second `c()` with no intervening write recomputes, so `runs === 2` instead of `1`.

   V3 specifies only current subscriber emptiness, not the required mid-update watched→unwatched transition.

   Defeats: Hardening 3 and obligation 14.

5. **MAJOR — The enter-depth bracket starves growth across separate manual reads.**

   Public-API scenario:

   1. Create a live raw subscriber and install it with `setActiveSub`.
   2. Create many detached default signals.
   3. Read each signal once in a synchronous loop.
   4. Every read increments `EnterDepth` before `allocNode`.
   5. Once allocation crosses `growAt`, `growPending` becomes true.
   6. Every later `maybeBoundary()` still sees nonzero depth and refuses growth ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1140)).
   7. Decrementing depth after each attach performs no boundary work.
   8. The loop eventually exhausts the arena and throws.

   These first reads are already spread across separate API calls, contradicting that “first reads spread across operations” is an escape hatch. Only yielding to maintenance or pre-growing works.

   Defeats: dedicated Attach’s enter-depth bracket and the documented limitation’s escape-hatch claim.

6. **MAJOR — Record-allocation failure has no specified enter-depth unwind.**

   Public-API scenario:

   1. Use a wide first-read effect to consume the remaining headroom.
   2. A later attach enters its bracket.
   3. The record allocation itself throws at the hard arena limit, before any local record id exists ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1224)).
   4. V3 specifies rollback only when link allocation throws.
   5. Unless the whole bracket is normatively a `finally`, the increment survives.
   6. Maintenance thereafter sees the engine permanently busy, `growCapacity()` only defers, and `reset()` throws.

   Hardening 2 can dispose the outer effect but cannot repair the leaked counter.

   Defeats: Attach’s “ordered for exception safety” claim and the clean-throw limitation.

7. **MAJOR — The claimed replacement-child semantics are the opposite of the actual gate behavior.**

   Public-API scenario:

   1. During an effect rerun, stop the effect.
   2. Still inside its callback, create a replacement `effect`.
   3. `effectId` tries to link the child to `prevSub`, the dead parent ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:502)).
   4. Hardening 1 refuses that insertion.
   5. `effectId` nevertheless continues, sets `HasChildEffect` on the dead record, runs the child, and returns it.
   6. Because no parent edge exists, neither the parent’s purge nor sweep can kill the child. It behaves as a top-level effect and can continue rerunning.

   V3 explicitly claims the replacement “gets killed with the doomed frame”; insertion refusal makes it survive.

   Defeats: Hardening 3’s stated semantic choice.

8. **MAJOR — The 2.0x gates remain gameable and the memory gates remain unmeasurable.**

   - Detached nodes enter `pendingFree`; actual sweeping is asynchronous or forced only after more than 8,192 queued records ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1147)). A micro below that size can time enqueueing while excluding reclamation, column clearing, and free-stack work.
   - Results change discontinuously depending on whether a repetition crosses the 8,192 threshold.
   - The oscillation baseline includes effect allocation and disposal, allowing common effect overhead to dilute arbitrary attach/detach regressions.
   - “Attached-heavy,” “detached-heavy,” “must not regress,” and “drop decisively” still define neither heap methodology nor numeric thresholds.
   - The v2 resolution map claims the detached memory mix measures attach/detach churn, but the gate does not require formerly attached signals; a never-attached population can pass while churn retains peak column capacity.
   - “Noise band” has no estimator, rejection rule, or minimum sample count beyond three medians.

   Defeats: Costs and gates and the claimed resolution of A2-8/B2-4.

9. **MINOR — The reset mechanics still contradict the document.**

   Public-API scenario:

   1. Attach `s` by reading it from an effect.
   2. Call `reset()`.
   3. Reset dispatches `unwatched` for every actual `HostStarted` node before wiping the arena ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:921)).
   4. The real signal record has a hook, so the proposed hook-presence gate passes.
   5. The hook copies out the value and resets the closure id to zero.
   6. The callable therefore does not retain its pre-reset id, contrary to v3’s explicit statement ([detached-signal-records.md](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:212)).

   Reuse remains undefined, but the claimed mechanism and B2-5 resolution remain false.

   Defeats: `reset()` contract and obligation 10.

## Not refuted

- Hardening 3 dropping links while an outer `checkDirty` walk retains positions: **not refuted**. The outer walk retains parent links rather than the computed’s newly reacquired dependency links, and freed-link fields remain intact until an intervening allocation. No concrete public-API corruption schedule was found from the re-drop alone.
- Dedicated attach skipping scope-region ownership: **not refuted**.
- The other load-bearing `signalId` work—`Host.Signal | Mutable`, hole-free `growColumns`, and seeding both value columns—is covered if the dedicated path actually calls the extended `growColumns`. No additional registration or owner behavior is required.
- Enter-depth preventing a migration between record allocation and link insertion: **not refuted**; finding 5 is the starvation consequence.
- Hook present between installation and closure-id assignment: **not refuted**. There is no user callback or allocation in that straight-line window.
- Re-entrant dispatch during the hook itself: **not refuted**. The hook performs only closure/column assignments.
- Hook absence on raw nodes and masquerading reset link records: **not refuted**.
- Legitimate value semantics of refusing tracking for a genuinely dead subscriber: **not refuted**, apart from the separately false replacement-child claim.

## V2-review disposition

- A2-1 — **NOT RESOLVED**: re-marked surviving edges and recycled occupants bypass the intended invariant.
- A2-2 — **NOT RESOLVED**: computed self-dispose can re-mark an old edge through the ungated fast path.
- A2-3 — **RESOLVED**: the dedicated path excludes scope-region capture.
- A2-4 — **RESOLVED**: the bracket prevents mid-attach generation splitting, while introducing finding 5.
- A2-5 — **RESOLVED**: masquerading link records have no hook entry.
- A2-6 — **RESOLVED**: the factual ordering and host-only change surface are corrected.
- A2-7 — **RESOLVED**: `trigger()` is explicitly included in an oscillation measurement.
- A2-8 — **NOT RESOLVED**: timing can omit deferred work and memory acceptance remains qualitative.
- A2-9 — **RESOLVED**: computed registration is correctly stated as creation-time.
- A2 additional replacement-child finding — **NOT RESOLVED**: the gate makes the child survive, not die.
- B2-1 — **RESOLVED**: Hardening 2 requires disposal of a failed initial effect and its partial dependency graph.
- B2-2 — **RESOLVED** for that exact mid-update schedule; Hardening 3 introduces finding 4.
- B2-3 — **RESOLVED**: column capacity is now documented as high-water.
- B2-4 — **NOT RESOLVED**: the new gates remain gameable and partly undefined.
- B2-5 — **NOT RESOLVED**: reset still runs the real signal’s hook and converts it to `id = 0`.
