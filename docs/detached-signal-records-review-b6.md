1. **FATAL — Moving the existing freed hook wholesale to logical-free time skips effect cleanups and leaks scope regions.**

   1. `disposeEffect()` clears `fns[idx]`, calls `freeNode()`, and only afterwards reads `cleanups[idx]` and `owned[idx]` ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:587)).
   2. The existing freed hook clears both columns ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:735)).
   3. Under v6’s immediate dispatch, `freeNode()` clears them before `disposeEffect()` consumes them.
   4. `effect(() => () => releaseResource())` therefore never runs its cleanup when stopped.
   5. `effectScope(() => { child = signalId(0) })` loses its `owned[]` region when stopped; `child` remains live indefinitely.

   This also exposes an ordering trap during re-entrancy. If generation bumps before `Live` clears, a child cleanup can recursively `dispose(parent)` using the new generation, queueing the same node twice. If the bump waits until after cleanup, the original free-to-sweep identity window remains open during user code. Logical free must first make the node non-live, bump generation, and invalidate frame caches; column cleanup must remain deferred or `disposeEffect` must extract its cleanup/region first. V6 specifies none of that ordering and contradicts itself by still saying column values clear at sweep ([design](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:49)).

2. **FATAL — Retaining the current frameless allocation boundary is not sound for `effectId` or `effectScopeId`; engine-level allocation forwarding does not forward the enclosing host operation.**

   1. Fill the arena past its growth threshold, leaving `growPending`.
   2. Call top-level `effectId(() => s())`.
   3. The old host closure enters `effectId` and calls `deps.sys.allocNode()` ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:495)).
   4. `allocNode()` calls `maybeBoundary()`, which grows, retires the old arena, and forwards the node allocation into the new engine ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:966), [system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1179)).
   5. The in-flight `effectId` continues in the old `createHost` closure. It sets the old closure’s `activeSub` and writes the retired `M`.
   6. `s()` dispatches through the newly installed global host, whose `activeSub` was snapshotted before step 5 and remains zero.
   7. The effect tracks no dependency and never reruns.

   `effectScopeId` similarly sets `currentScope` only in the retired host; nested raw nodes are created by the new host as top-level nodes and leak after the scope stops.

   Today’s top-level unscoped `signalId`/`computedId` forwarding is sound because their post-allocation work touches shared side columns and, outside a scope, does not read the retired arena. That does not generalize to every creation entry. Growth must happen before dispatch into the host-generation trampoline, as a concrete mechanism—not inside the in-flight host operation.

   The spec is additionally self-contradictory: hardening 5 retains frameless growth ([design](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:261)), while obligation 20 still asserts growth occurs only from the microtask path or `growCapacity()` ([design](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:440)).

3. **MAJOR — Registry generation pairing has an unclosed mid-growth capture seam.**

   1. Arrange for a freed node with generation 1 to be on `nodeFreeStack`, and leave growth pending.
   2. Create an owner-registered node.
   3. `createNode()` captures `const engine = shared.inner`, then `engine.maybeBoundary()` retires and zeroes that engine ([system.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:954)).
   4. `engine.allocNode()` forwards and reuses the generation-1 record in the new arena.
   5. A mechanical extension of the current registration queue that reads the generation from captured `engine.memory` records zero, not one.
   6. Owner collection then generation-mismatches and never reclaims the node: permanent record leak.

   The pair must be captured from `shared.inner!.memory` after forwarding, or returned atomically by allocation. V6 explicitly identifies the analogous stale-host read for scoped creation but does not specify this registry read or test registry pairing across growth.

4. **MAJOR — Region generation guards do not guard the host-side mutation preceding them; a delayed region can erase a recycled stranger’s callback.**

   1. Save the id of a raw computed created inside a scope.
   2. Stop the scope, queueing its region.
   3. Explicitly dispose that computed.
   4. Use a depth-zero frame exit to sweep it, then create computed `B`, reusing the record.
   5. When the region microtask runs, it executes `fns[member >> shift] = undefined` before calling the generation-guarded `freeNode()` ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:619)).
   6. `freeNode()` correctly rejects the stale generation, but `B` has already lost its getter. Reading it returns the wrong value.

   Immediate freed-column clearing could make this store redundant, but v6 does not remove or guard it. Thus the claim that region entries “mismatch from the moment of free” is insufficient.

5. **MAJOR — The public saved-frame API remains unspecified and the existing public restoration pattern remains identity-blind.**

   Current `getActiveSub()` and `setActiveSub()` exchange numeric ids ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:335)). V6 mentions “a new getter” and “the restore path” only in its resolution map, with no names, signatures, representation, allocation cost, or distinction between installing a raw live id and restoring a saved pair ([design](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:484)).

   As written, the existing public pattern can still save a bare id, free and recycle it, then pass it back to the retained id-based setter and install the stranger. Obligation 12 cannot be implemented against a specified public API.

6. **MAJOR — “Consume the head” is not a complete algorithm for the selective child-effect walk.**

   The disposal and unwatched-drop walks can consume every head. `disposeChildEffects`, however, intentionally leaves signal and computed dependencies linked and removes only child effects ([index.ts](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:912)).

   If the head is a signal followed by a child effect:

   - Consuming every head removes ordinary dependencies too, causing detach/reattach churn and changing rerun behavior.
   - Stopping at the non-effect head never reaches the child.
   - Advancing with a cached pointer reproduces a5-4 when a child cleanup disposes and recycles later links.

   The safe rule is a head-forward scan that restarts from the head after every unlink capable of running user code. V6 instead applies an impossible literal “consume the head” rule to all three walks, so a5-4 is not resolved.

### Surfaces not otherwise refuted

- **Queue-time generation bump itself:** no kernel invariant requires generation stability until sweep. After a correctly ordered logical-free transition, old effect-queue and region pairs should mismatch immediately; bare `pendingFree` ids remain safe because records cannot be reused before sweep; growth copies the bumped generation and carries the shared queue forward. The sweep must not bump again.
- **Bare-id top-level `signalId`/`computedId` growth forwarding:** not refuted. The broader effect/scope and new registry-pair cases are findings 2–3.
- **Core detachable-record mechanics with a genuinely live subscriber:** not refuted. Copying `pendingVals`, hook-clear-before-queue, fresh reattachment, and attach rollback still compose.

### V5 resolution ledger

**a5**

1. **NOT RESOLVED** — the timing window closes, but moving the existing hook without a new ordering/split loses cleanups and regions.
2. **NOT RESOLVED** — frameless growth is retained inconsistently and is unsafe for effect/scope host entries.
3. **NOT RESOLVED** — pairing is required, but generation capture across forwarded growth is unspecified and can leak.
4. **NOT RESOLVED** — the selective child-effect walk still lacks a re-entrancy-safe algorithm.
5. **RESOLVED** — the deferred-drop bit is placed in the flags word.
6. **RESOLVED** — pre-reset frame pairs are explicitly classified as invalid pre-reset handles.
7. **NOT RESOLVED** — immediate freed dispatch makes the post-`freeNode` column reads concretely destructive.
8. **RESOLVED** — the resolution map states a bounded six-point worst-case ceiling.

**b5**

1. **NOT RESOLVED** — generation timing is corrected, but the required logical-free transition is not safely specified.
2. **RESOLVED** — reset reuse is explicitly excluded from frame-token validity.
3. **NOT RESOLVED** — no concrete public pair API or gate exists.
4. **NOT RESOLVED** — retained growth is contradictory and unsafe across effect/scope host dispatch.
5. **NOT RESOLVED** — the public API gate is still absent and obligation 20 contradicts retained frameless growth.

REFUTED
