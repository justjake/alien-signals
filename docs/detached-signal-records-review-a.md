# Adversarial review: detached signal records

Grounding: `packages/dalien-signals/docs/detached-signal-records.md` vs `packages/dalien-signals/src/index.ts` (host) and `packages/dalien-signals/src/system.ts` (kernel). Line references are to current `main`.

---

**1. FATAL — Detach loses staged writes: the value does not live in `currentVals`, it lives in `pendingVals`.**

The spec's state table ("attached | value lives in `currentVals` column") and the Detach step ("copy `currentVals[idx]` back into the closure") are wrong about where an attached signal's newest value is. A write stages into `pendingVals` and only commits at read/walk time (`setHot`, index.ts:1023-1027; commit in `updateSignal`, index.ts:775-779; commit-on-read in `readSignal`/`getSlow`).

Scenario (all public API):
1. `const s = signal(0); const stop = effect(() => { s(); });` — s attaches, one incoming link.
2. `startBatch(); s(1);` — write stages `pendingVals=1`, sets Dirty, propagates; no commit (batch open).
3. `stop();` — effect dispose → `freeNodeId` → subscriber unlink → refcount hits zero → `hostUnpinned` runs synchronously (the spec requires this, §Open questions #1) → detach copies `currentVals[idx]` = **0** into the closure, frees the record; `freedNode` wipes `pendingVals`.
4. `endBatch(); s()` → `id === 0` → closure value → returns **0**. Current library (and upstream) return 1.

No batch needed: `effect(() => { if (cond()) s(); })` with `startBatch(); cond(false); s(1); endBatch();` loses the write through `purgeDeps` (index.ts:936-942) the same way. Silent data loss on an ordinary sequence. Defeats §Design summary (state table), §Detach, and correctness obligations 2/4. Fix scope: detach must run the `updateSignal` commit before copying out — the spec must say so.

---

**2. FATAL — Owner-carrying signals have no reclaimer once the registry is "removed entirely".**

§Problem: "This design removes the registry from the signal lifecycle entirely." §Interactions: `signalOwner` "attaches eagerly" and does **not** detach ("Only the default `signal()` callable … detaches"). An eagerly attached record has zero incoming links, so link ownership — the design's entire replacement mechanism — never engages for it.

Scenario:
1. `signalOwner(0, obj)` → eager record, id stamped on `obj`, never read inside any effect (or read only untracked).
2. Drop `obj`.
3. Today: `createNode`'s registry (system.ts:751-758, orphan at 1777) reclaims the record. Under the design: no registry cell, refcount is 0 and never transitions 1→0, no scope region (owner path skips regions, index.ts:433), `dispose` never called (the stamp died with `obj`). The record, its `currentVals`/`pendingVals` entries, and its hook-column slot live until `reset()`.

Unbounded leak from the plainest use of the documented owner API. If the intended resolution is "the owner path keeps its registry," then §Problem's headline claim is false, the "one registry cell per signal" memory-gate arithmetic (§Costs) is wrong for that path, and the spec nowhere says which paths keep registration. Defeats §Problem and the §signalOwner bullet. This is precisely "the case where nothing else picks up reclamation."

---

**3. MAJOR — The scopes bullet rests on a false premise and cannot be implemented coherently for the default callable.**

§Scopes: "A signal created inside an active scope is attached eagerly at creation and its `(id, gen)` joins the scope's owned region exactly as today." In the actual code, a `signal()` callable **never** joins a region: `signal()` always passes the oper as `owner` (index.ts:1331), and `signalId` only region-pushes when `owner === undefined` (index.ts:433-435). "Exactly as today" describes behavior that does not exist. The two consistent readings both fail:

- Reading A (callable joins the region, replacing its lost registry ownership): the region holds `(id, gen)` of an eagerly attached **detachable** callable. Public sequence: inside the scope, an effect reads `s` (refcount 1), then re-runs without reading it → `purgeDeps` → refcount 0 → detach frees the record and bumps gen. The region's entry is now a gen-mismatched no-op; the signal has silently exited its region. A later tracked read anywhere re-attaches it into no region (or whatever scope happens to be current). "Scope disposal frees the signals created inside it" is false.
- Reading B (callable stays detachable, never region-owned): the bullet is vacuous for the very objects the design converts, and the rationale sentence ("letting a scoped signal attach later would put an id the region never heard of") condemns exactly what Reading B does.

Defeats §Scopes. The spec must pick one taxonomy for {callable, owner-path, scoped-raw, top-level-raw} and state each path's reclaimer; today it slices the population differently in three adjacent bullets.

---

**4. MAJOR — Attach moves every signal record allocation into tracked frames, where growth is forbidden.**

Attach happens only at a tracked read (`activeSub !== 0`), i.e. always inside an effect body or computed getter — always with `M[SysSlot.EnterDepth] > 0`, where growth is deferred and only the quarter headroom exists; exhausting it throws (system.ts:1224-1241, 1229-1231).

Scenario:
1. Create 1.1M detached signals at top level. Under the design this touches the arena **zero** times, so no growth pressure ever accrues (the design brags about this in §Arena growth: "growth has nothing to migrate for them").
2. Run one `effect(() => { for (const s of all) s(); })`. Every read attaches: 1.1M node records + 1.1M link records inside one operation against the default 2M-record arena (index.ts:202) → "record arena exhausted inside one operation" throw.

Today the same program interleaves record allocation with operation boundaries, crosses `growAt` during creation, migrates, and completes. The design converts a working program into a mid-operation crash and offers no gate or mitigation for it. Defeats the §Arena growth bullet, which presents the interaction as a pure win.

---

**5. MAJOR — The refcount column is redundant with a signal the kernel already computes and already delivers, and its specified lifecycle is self-contradictory.**

Refcount-zero for a signal is exactly "subs list became empty," which `unlink` already detects with zero added cost (`else if (!(M[dep + NodeSlot.Subs] = nextSub)) unwatched(dep)`, system.ts:1408-1410) and already delivers to this host: `lifecycleArmed` is true (index.ts passes `unwatched`, index.ts:226), `hostWatchedNode` fires on first subscriber (system.ts:1376-1381), and index.ts's `unwatchedNode` receives the last-unlink event for signals today and deliberately does nothing with it (index.ts:760-774, Signal kind falls through). First-subscriber detection (the increment side) likewise already exists. The proposed `Int32Array` RMW per link insert/free plus a new `hostUnpinned` seam re-derives a branch the kernel already takes; the `watched` seam even provides per-node host state storage (`hostState`) where the pin could live without a new column.

Separately, the column's spec is impossible as written: "following the existing no-holes column growth discipline" describes push-grown plain arrays with stable identity (index.ts:291-299), which an `Int32Array` cannot satisfy; and "the refcount and hook columns ride the same handoff as every other host column" is false for an `Int32Array` — host columns ride by reference, a fixed-size typed array must be copied at migration like `M`. If a host-owned `Int32Array` is ever replaced to grow, the string-compiled engine's construction-const capture (the `const hostFreed = shared.hostFreed` pattern, system.ts:1105-1107) keeps decrementing the dead array → refcount never reaches zero → hook entry pins the closure environment forever: a leak crossing the growth boundary. Defeats §Refcount and the §Arena growth bullet.

---

**6. MAJOR — The performance gates are mis-specified and partly unmeasurable.**

Against §Costs, point by point:
- "One refcount RMW per link insert and per link free. Gate: propagation rows flat." Link insert/free do not run in propagation — `propagate`/`shallowPropagate` touch no links' lifecycles. The cost lands in tracking passes (every effect/computed re-run's `link` re-track and `purgeDeps`) and in the tracked-read path itself. The named gate cannot observe the cost it gates.
- No gate covers refcount 0↔1 oscillation, the design's new worst case: a sole consumer that mounts/unmounts (list UI, conditional effect deps) pays full detach (value copy-out, hook clear, record free, gen bump) plus full re-attach (record alloc, hook closure alloc, copy-in, version snapshot reset defeating the `get` version gate, forcing re-verification) per cycle, where today it pays one `link`/`unlink` against a persistent record.
- "Churn benchmarks (create/dispose cycles) must improve, not just creation" is vacuous: created-then-dropped-unread callables never touch the arena under the design, so improvement is definitional and validates none of the new machinery.
- The ≥1.3x creation payoff bar treats registration as a synchronous per-create cost, but registration is already deferred and batched (`pendingRegister`, drained at threshold/microtask, system.ts:795-820, with the measured numbers in the comments); the removable per-create cost is two array pushes plus an amortized `registry.register`, which caps the achievable win well below what the doc implies.
- "Net retained memory must drop": for an attached-heavy steady state the design retains a hook closure (≈ a registry cell) + a refcount slot for **every** record including links/computeds/effects + a fatter callable context (two mutable slots vs one). The drop only materializes for detached populations; the gate as stated lets an attached-heavy regression hide behind a detached-heavy benchmark mix.

Defeats §Costs.

---

**7. MINOR — Attach seeds `currentVals` but not `pendingVals`, producing a spurious invalidation wave.**

`freedNode` cleared `pendingVals` on the record's previous free (index.ts:746-748); §Attach copies value into `currentVals` only. First write after attach of a value equal to the current one: `setHot` compares against `pendingVals` (`undefined !== v`) → Dirty, `++globalVersion`, full propagate wave; every version gate in the graph misses once. `checkDirty` resolves it clean so no effect runs, but obligation 4's "no spurious recompute" spirit and the version-gate economics are defeated by the spec's own attach sequence. Attach must seed both columns.

---

**8. MINOR — Obligation 7's double-free defense is fictitious.**

"Generation bump makes the second free a mismatch no-op": link records carry no generation at all (`LinkSlot`, system.ts:165-183), and a node's gen bump is deferred to the `pendingFree` sweep (`freeNode` runs at the boundary, system.ts:1243-1261) — between detach and the sweep, any gen comparison passes. The guard that actually works (cleared hook entry / `Flag.Live` check, mirroring `freeNodeId`'s early return at system.ts:1202-1204) is not what the spec states. Defeats §Correctness obligation 7 as written.

---

**9. MINOR — `reset()` no longer invalidates all pre-reset handles uniformly.**

A detached signal is invisible to `reset()` and keeps working afterwards — including re-attaching into the new arena generation on its next tracked read — while an attached one dies as documented. Whether a given callable survives reset now depends on whether its last consumer unlinked before the reset, an invisible property. §reset() claims this "match[es] today's contract that pre-reset handles must not be reused"; today's contract (system.ts:386-392) invalidates every handle, unconditionally. Defeats the §reset() bullet's parity claim.

---

**10. MINOR — Throw window between attach and first link pins the hook forever.**

§Attach installs the hook and allocates the record, "then fall[s] through to the normal host read (which creates the link)." If `link`'s `allocLink` throws (arena exhausted mid-operation — made likelier by finding 4), the signal is left attached at refcount 0 with a live hook-column entry that no link-free can ever clear: pinned until `reset()`. The spec specifies no ordering or rollback. Defeats §Attach.

---

**Not refuted, after genuine effort:**

- `hostUnpinned` inside the closed string-compiled `createEngine`: not refuted — a slot on `EngineShared` captured as a construction const (the `hostFreed` pattern) satisfies the parameters-and-globals constraint, and a detachable tag in `Flag.HostMask` survives `newCustom`'s mask.
- Version restarting at zero on re-attach: not refuted — a zero snapshot can never equal `globalVersion` (starts at 1, monotonic), so the miss direction is re-verification, never a stale hit.
- Untracked reads racing attach: not refuted — synchronous single-threaded handoff; the only value-divergence window is finding 1's pending-value bug, not a race.
- Id escape for default callables (stale reads by cached raw id): not refuted — `signal()`'s id reaches no public surface; `getActiveSub` exposes only subscriber ids.
- Equality contract on detached writes: not refuted — comparing against the closure value equals comparing against the last written value, which is what the attached `pendingVals` comparison implements.
- Obligation 1 (drop detached signal → collected): not refuted — a detached signal is a plain closure with no external strong reference.