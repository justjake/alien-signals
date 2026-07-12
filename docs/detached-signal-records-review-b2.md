V2 is refuted: two fatal correctness/leak holes remain, the memory and performance gates are still invalid, and the reset mechanics contradict the document.

## Findings

1. **FATAL — Arena exhaustion during initial `effect()` leaks the effect and every attachment completed before the throw.**

   Public-API scenario:

   1. Create enough detached default signals to exhaust the arena when each later consumes one node plus one link.
   2. Call:
      ```ts
      try {
        effect(() => {
          for (const s of signals) s();
        });
      } catch {}
      ```
   3. Many signals attach successfully. A later signal allocates its record, then its link allocation throws.
   4. V2 rolls back only that last signal.
   5. The initial-effect path has already allocated the effect and stored its callback in `fns`, but its `finally` only restores counters and `activeSub`; it neither frees the effect nor unlinks dependencies ([index.ts:495](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:495), [index.ts:510](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:510)).
   6. Because `effect()` throws, no stop callable is returned. The effect record, callback, successful links, hook environments, and likely the signal array captured by the callback remain reachable until `reset()`.

   The individual failed attachment is rolled back, but the operation is not clean and does not have “zero leak.” This defeats Attach step 3, the claimed bounded-and-clean limitation, and correctness obligation 4 ([detached-signal-records.md:78](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:78), [detached-signal-records.md:152](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:152), [detached-signal-records.md:213](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:213)).

2. **FATAL — A live computed can become unwatched during its own update, then attach a fresh signal after the unwatched cleanup has already run.**

   Public-API scenario:

   ```ts
   const tick = signal(0);
   let victim: ReturnType<typeof signal<number>> | undefined = signal(1);
   let armed = false;
   let stop = () => {};

   const c = computed(() => {
     tick();
     if (armed) {
       stop();
       victim!();
     }
     return 0;
   });

   stop = effect(() => {
     c();        // first dependency
     victim!();  // dependency tail, therefore unlinked first
   });

   armed = true;
   tick(1);
   victim = undefined;
   ```

   Walk:

   1. `tick(1)` makes `c` pending and queues the effect.
   2. `checkDirty` updates `c`, entering its getter with `activeSub = c` ([system.ts:1512](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1512), [index.ts:793](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:793)).
   3. `stop()` disposes the effect and unlinks its dependencies in reverse.
   4. The old `victim` link is removed first, so v2 detaches it. Removing the effect’s link to `c` then makes `c` unwatched.
   5. `unwatchedNode(c)` drops `c`’s dependencies synchronously even though its getter is still running ([index.ts:760](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:760), [system.ts:1384](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1384)).
   6. Execution returns to the same getter. `victim()` now reattaches a fresh record and links it to `c`.
   7. `updateComputed` exits and `purgeDeps(c)` retains that newly tracked link ([index.ts:809](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:809), [index.ts:936](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:936)).
   8. `c` is live but has zero subscribers and `HostStarted` is already clear. There is no future last-unlink event for `c` that will drop this dependency.
   9. Retaining `c` while dropping `victim` therefore pins `victim`’s hook environment and attached record indefinitely.

   The prerequisite checks only whether the subscriber record died. Here the subscriber computed remains live; it merely became unwatched during its own update. This defeats “a link proves a live subscriber,” the prerequisite hardening, the detach ownership table, and obligations 2 and 8 ([detached-signal-records.md:43](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:43), [detached-signal-records.md:127](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:127)).

3. **MAJOR — Detachment does not release column storage; the detached state’s “no column slots” claim is false after attachment.**

   Public-API scenario:

   1. Create `N` default signals.
   2. Attach every one under a consumer.
   3. Stop every consumer and allow the pending-free sweep to run.
   4. Retain the now-detached callables.

   The sweep invokes `freedNode`, which stores `undefined` into each populated column but never shortens any column ([index.ts:735](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:735)). Columns only grow by `push`; they are shortened only by `reset()` ([index.ts:291](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:291), [index.ts:1128](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:1128)). The proposed hook column must follow the same high-water behavior.

   Thus a formerly attached, currently detached population retains the backing stores for `currentVals`, `pendingVals`, `fns`, `cleanups`, `owned`, and the new hook column. The memory payoff exists only for never-attached signals, not for detached signals generally.

   This defeats the state table’s “no column slots” claim and lets the detached-heavy memory gate pass on a population unlike actual attach/detach churn ([detached-signal-records.md:45](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:45), [detached-signal-records.md:197](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:197)).

4. **MAJOR — The rewritten gates still do not define enforceable acceptance criteria.**

   Public-API benchmark scenario:

   1. Measure ordinary creation/read/update rows and obtain several small wins.
   2. Measure sole-consumer mount/unmount through `effect(() => s()); stop();` and observe a large regression.
   3. The full-suite geometric mean can still be `≤ 1.00` because the creation wins numerically hide the oscillation loss.
   4. V2 supplies no oscillation cap: it says “with an explicit budget,” but gives no budget.
   5. “More than creation-plus-memory gains justify” has no formula and mixes elapsed-time and retained-memory quantities.
   6. “Roughly a wash,” “must not regress,” and “drop decisively” provide no heap-measurement method or numeric threshold.

   Alternating medians and an idle-noise measurement do not resolve those missing decision rules. This defeats Costs and gates and v1 resolution 6 ([detached-signal-records.md:179](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:179)).

5. **MINOR — Reset makes an attached callable detached and usable; it does not make it “die.”**

   Public-API scenario:

   1. `const s = signal(1)`.
   2. Attach it with `effect(() => s())`.
   3. Call `reset()`.
   4. The kernel directly invokes `unwatched` for every `HostStarted` node before clearing the arena ([system.ts:921](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:921)).
   5. V2’s Signal branch therefore runs the detach hook: it copies the value and sets the closure’s id to zero.
   6. After columns are cleared, `s()` reads the copied closure value and can later attach to the new arena.

   Reuse remains outside the documented contract, but the document’s mechanistic distinction—attached callables die, detached callables happen to survive—is false. The new hook actively converts attached callables into survivors. This defeats the `reset()` section and obligation 10 ([detached-signal-records.md:158](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/docs/detached-signal-records.md:158)).

## V1 resolution ledger

1. **RESOLVED** — `setHot` always writes `pendingVals` before equality rejection, `updateSignal` only copies from it, and sweeping clears it only after synchronous detach ([index.ts:1023](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:1023)).

2. **RESOLVED** — `signalOwner` and `signalId(v, owner)` retain registry ownership; raw ownerless paths retain explicit or region ownership.

3. **RESOLVED** — The corrected scope premise matches `signalId`: owner-backed default callables skip `currentScope` region registration ([index.ts:420](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts:420)).

4. **NOT RESOLVED** — Working bulk-first-read programs still become arena-exhaustion throws, and finding 1 disproves the promised clean, zero-leak failure.

5. **RESOLVED** — The redundant refcount and typed-array handoff are gone; a stable plain hook column can cross host generations by reference.

6. **NOT RESOLVED** — Finding 4: the oscillation budget and memory acceptance rules remain unspecified, and the geometric mean can hide the new worst case.

7. **RESOLVED** — Seeding both value columns prevents the first equal write from observing a stale/undefined pending slot.

8. **RESOLVED** — For record reclamation, cleared-hook plus `Flag.Live` discipline replaces the fictitious generation defense. Raw repeated `unlink(linkId)` remains unsafe, but `unlink` is not documented as idempotent.

9. **RESOLVED** — The contract now explicitly says every pre-reset handle is invalid; finding 5 refutes only the document’s claimed incidental mechanics.

10. **RESOLVED** — For the single failed signal, linking before hook installation removes the zero-link pinned-hook window. Finding 1 is the surrounding operation-level exception hole.

11. **NOT RESOLVED** — Finding 2 creates a ghost dependency from a live-but-already-unwatched computed, so the proposed “record died during the run” hardening is insufficient.

## Surfaces not refuted

- **Attach ordering: not refuted.** In this system `watched` is undefined; `linkInsert` only sets `HostStarted` and extends `hostState`. No public/user callback can unlink between link insertion and the following hook store ([system.ts:1349](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1349), [system.ts:1418](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1418)).

- **`pendingVals` newest-value invariant: not refuted.** Equal writes still assign it, commits do not clear it, growth preserves the array identity, and `freedNode` runs at the later sweep.

- **Physical last-link dispatch: not refuted.** `unlink` dispatches exactly when the subscriber-list head becomes zero; I found no ordinary path that misses the physical last link or invokes a still-live hook twice ([system.ts:1384](/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts:1384)).

- **Old-record safety before sweep: not refuted.** Node reuse is deferred; the examined purge, reverse-disposal, trigger, and `checkDirty` paths do not reuse the queued signal record before the boundary sweep.

- **Other reclaimers: not refuted.** Owner finalization, computed orphan reclamation, scoped raw-node regions, scoped-effect disposal, `trigger()`’s `finally`, and ordinary untracked reads each retain a concrete reclaimer or synchronously remove their temporary links.

- **String-compiled closure constraint: not refuted.** A hook array in `HostDeps` remains reachable through factory parameters and does not add an unresolved free name to `createEngine`.
