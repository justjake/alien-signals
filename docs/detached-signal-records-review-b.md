1. **FATAL — `signalOwner` leaks every dropped signal.**

   Scenario:

   1. Call `let owner = signalOwner(1, {})`.
   2. Per the design, this eagerly allocates a stable record but does not register it with the `FinalizationRegistry`.
   3. Never track the signal, so its incoming-link refcount remains zero.
   4. Drop `owner`.
   5. No link is removed, so `hostUnpinned` never runs. It is not scope-owned or manually disposed.
   6. The record and value-column entries survive indefinitely; arena growth migrates them into every later generation.

   This directly contradicts “removes the registry from the signal lifecycle entirely” and the assertion that only default callables detach. Current `signalOwner` relies on `createNode(owner, ...)` specifically for reclamation ([index.ts](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:1261>)).

   Defeats: [Problem](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:15>), [Design summary](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:30>), [`signalOwner` interop](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:97>).

2. **FATAL — stopping an effect can leave a ghost link that pins a dropped callable forever.**

   Scenario:

   1. Create `tick = signal(0)`.
   2. Create an effect that reads `tick`.
   3. After its initial run, create detached `victim = signal(1)`.
   4. Write `tick(1)` so the effect reruns.
   5. During that rerun, call the effect’s own `stop()`.
   6. `disposeEffect` removes the effect’s existing dependencies and queues its record for recycling, but `activeSub` remains the disposed effect id until `run`’s `finally` ([index.ts](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:836>)).
   7. Still in the same effect body, call `victim()`.
   8. `victim` attaches and the kernel accepts a new link whose subscriber is the already-disposed effect; `link` performs no subscriber-liveness check ([system.ts](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1330>)).
   9. `purgeDeps` preserves that newly tracked tail. Later record recycling clears the effect’s dependency fields without unlinking this post-disposal edge.
   10. Drop `victim`. Its refcount remains one, so the hook column permanently pins its closure environment. Growth copies the ghost edge; only `reset()` clears it.

   A link is therefore not proof of a live reactive owner, invalidating the design’s foundational ownership claim.

   Defeats: [Problem, “links are the only consumers”](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:19>), [Design summary ownership table](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:30>), [Unpin hook](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:70>), [Effects](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:105>).

3. **FATAL — attach is not exception-safe, leaving a zero-refcount record pinned with no reclamation path.**

   Scenario:

   1. Allocate one raw record with `signalId(0)`.
   2. Create 1,048,575 detached default signals; under the proposed design these consume no arena records.
   3. Call `trigger(() => { for (const s of signals) s(); })`. The trigger scratch consumes one more record.
   4. The current default arena has `1 << 21` records. Each successful first read consumes one signal record and one link record.
   5. Eventually exactly one record remains. The next attach successfully allocates its signal record, sets `id`, and installs its hook.
   6. The subsequent link allocation throws because growth cannot occur during the active `trigger` frame.
   7. `trigger`’s `finally` unlinks all successfully inserted links, but the failed signal has no link to discover.
   8. Drop the signal array. The failed signal’s hook pins its environment at refcount zero. Scheduled growth migrates the leaked record.

   The attach operation needs a rollback invariant, but none is specified or tested.

   Defeats: [Attach](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:56>), [exactly-one-owner claim](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:30>), [Correctness obligations](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:135>).

4. **FATAL — detaching a dirty signal loses an accepted write.**

   Scenario:

   1. Create `s = signal(0)`.
   2. Create `stop = effect(() => s())`, attaching `s`.
   3. Switch to manual effect mode.
   4. Call `s(1)`.
   5. The current write path stores `1` in `pendingVals`, marks the record dirty, and leaves `currentVals` at `0` until `updateSignal` runs ([index.ts](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:1023>), [index.ts](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:775>)).
   6. Before flushing, call `stop()`.
   7. Removing the last link invokes detach, which copies `currentVals[idx]`—still `0`—into the closure.
   8. Flush effects or restore sync mode; the disposed effect is skipped.
   9. Call `s()` untracked. It returns `0`, although `s(1)` completed successfully.

   The same loss occurs by stopping the effect inside an open batch.

   Defeats: [Detached writes](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:45>), [Detach](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:62>), [Effects/manual mode](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:94>), correctness obligation 3.

5. **MAJOR — eager scope ownership leaves retained callables stale or resurrects them outside the disposed scope.**

   Scenario:

   1. Run `let s; const stop = effectScope(() => { s = signal(1); })`.
   2. The design eagerly attaches `s`, records `(id, gen)` in the scope, and installs an unpin hook.
   3. Never track `s`; its refcount starts and remains zero, so no zero-producing decrement ever invokes `hostUnpinned`.
   4. Call `stop()` and allow deferred region teardown to free the record.
   5. Generic `hostFreed` clears the value and hook columns, but the only specified operation that sets the callable’s `id = 0` is `hostUnpinned`.
   6. Calling retained `s()` now reads the freed slot or a later occupant. Calling `s(value)` can mutate that occupant.

   If generic scope teardown invokes the hook instead, `s` becomes detached and can attach again after its owning scope was disposed, escaping region ownership. The design has no dead-callable state that satisfies either lifecycle.

   Defeats: [Scopes](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:88>), [Detach](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:62>), correctness obligation 5.

6. **FATAL — the claimed double-free protection does not exist for links.**

   Scenario:

   1. Through the public `ReactiveArena`, allocate a dependency and subscriber and call `link(dep, sub, version)`.
   2. Call `unlink(linkId, sub)` once. The proposed decrement reaches zero and detaches the dependency.
   3. Call `unlink(linkId, sub)` again.
   4. Link records have no generation or live bit. Current `unlink` reads the stale fields and calls `freeLink` again ([system.ts](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1384>)).
   5. The new refcount decrement therefore occurs again before any node-generation check could help.
   6. The same link id is pushed twice onto the free stack; two later allocations can receive the same record, corrupting both graphs.

   The spec’s assertion that a node generation bump makes a second link free a no-op is categorically false.

   Defeats: [Refcount](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:81>), correctness obligation 7.

7. **MAJOR — the refcount column has no valid growth handoff as specified.**

   Scenario:

   1. Build enough attached signals and links to cross the current arena capacity.
   2. Growth constructs the next `createEngine` before invoking the host’s `allocated` callback ([system.ts](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:835>)).
   3. Existing host columns are stable JavaScript arrays in `HostDeps`; none is a replaceable capacity-sized typed array.
   4. If the new `Int32Array` refcount is treated like those columns, it remains sized for the old generation.
   5. Attach a signal whose index is beyond the old array length.
   6. Its out-of-bounds increment is ignored; later decrement cannot reach a stored zero transition, so its hook and record leak.

   The factory would have to own and migrate this typed array before constructing the next engine, but the design merely says it “rides the same handoff,” a handoff that does not exist for this representation.

   Defeats: [Arena growth](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:107>), [Refcount](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:81>).

8. **MAJOR — the refcount performance gate measures the wrong operation.**

   Scenario:

   1. Construct a stable graph once.
   2. Run the proposed “propagation rows” by repeatedly writing a source.
   3. Propagation walks existing links; it performs neither `linkInsert` nor `freeLink`.
   4. The additional refcount read-modify-writes are therefore never executed.
   5. The propagation gate remains flat even if dependency retracking and teardown have regressed severely.

   Defeats: [Costs, refcount gate](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:127>).

9. **MAJOR — the creation gate can report a decisive win by moving the cost outside the measured row.**

   Scenario:

   1. Benchmark creating one million default signals without reading them.
   2. The candidate performs only callable allocation, so the creation row easily clears the required 1.3× improvement.
   3. In the actual application phase, place those signals under consumers.
   4. First reads now pay record allocation, column growth, hook closure allocation, link allocation, and refcount mutation.
   5. Repeatedly mount and unmount consumers around the same signal; every linked lifetime allocates another hook closure.
   6. A “create/dispose cycle” benchmark does not measure this same-callable attach/detach churn, so every stated gate can pass while total work and allocation increase.

   Defeats: [Costs and gates](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:116>).

10. **MINOR — “within noise (≤1.01×)” is not a measurable acceptance rule.**

    Scenario:

    1. Run a row whose natural run-to-run variation is ±2%.
    2. Observe candidate ratios of 0.99, 1.02, 1.00, and 1.015.
    3. Depending on run selection or aggregation, the same implementation both passes and fails the stated 1.01 threshold.
    4. The design specifies no repetitions, confidence interval, machine-contention rejection, multiple-row correction, or baseline promotion rule.

    Defeats: [hot-path compare gate](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:120>).

11. **Kernel source-closure constraint — not refuted.** `hostUnpinned` can be passed through the existing `shared` parameter and captured alongside `hostFreed`; that does not introduce a forbidden free variable into `String(createEngine)` ([system.ts](</Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1101>)).

12. **Version zero after a clean reattach — not refuted.** If the refcount accurately represents live links and there is no pending dirty write, no consumer snapshot can survive the fully detached interval.

13. **Untracked-read/attach race — not refuted.** In the current single-threaded synchronous host, no public call can interleave between the closure branch and attach absent user-code reentrancy; the concrete failures above arise from disposal and exceptions instead.


