# Adversarial review: detached-signal-records.md, revision 5

All claims verified against `/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/index.ts` and `/Users/jitl/src/alien-signals-opt/packages/dalien-signals/src/system.ts` in the working tree. No v5 implementation exists; this reviews the design against shipped code, with all five hardenings assumed landed as specced.

Verdict up front: v5 closed every construction the v4 reviews built. It is refuted on one premise the v4 rounds never had to test, because v4's clear side didn't exist yet: **the "existing freed-notification seam" that hardening 1's clear side rides does not fire at the free — it fires at the sweep** — and the generation bump the restore validation depends on is deferred to the same sweep (a fact the doc itself states in its Double-free defense section). Everything hardening 1 promises about doomed frames is inert inside the free→sweep window, and that window is synchronously reachable through the most mundane public API. One FATAL, three MAJOR, four MINOR.

## Findings

**1. FATAL — The clear side's seam fires at the sweep, not the free: in the synchronous free→sweep window a doomed frame keeps tracking, generation validation passes (bumps are sweep-deferred), and links created in the window are never unlinked — ghost edges land on the recycled occupant.**

The spec: "every record free (explicit dispose, scope-region teardown, registry reclamation) **already dispatches the host's freed hook** … so a doomed frame stops tracking **at the moment of the free** … and no window exists between a free and the next restore." False on the code. All three named paths queue the record and defer the freed dispatch:
- explicit dispose → `freeNodeId` (system.ts:1193-1218): unlinks edges, zeroes flags, pushes `pendingFree` — **no `hostFreed` call**;
- region teardown → `freePendingRegions` → same `freeNode` (index.ts:611-629);
- registry → `orphan`/`reclaimOrphan` (system.ts:1777-1802) — same queue.

`hostFreed` fires exactly once, inside the sweep-time `freeNode` (system.ts:1243-1246), which is also the only place `++M[id + NodeSlot.Gen]` happens (system.ts:1252) — and the doc knows this: "node generation bumps are deferred to the sweep" (Double-free defense). So in the window between a free and the sweep, BOTH of hardening 1's defenses are dead: the caches aren't cleared (hook hasn't fired) and (id, gen) validation passes (gen unbumped). Hardening 5 narrows the window to "until the next depth-zero exit" — which straight-line top-level code and the remainder of a frame's own body never cross.

Three concrete scenarios, all public API, all with the hardenings landed as specced:

*(a) The v5 doc's own claimed fix still crashes.* `effectScope(() => { dispose(getActiveSub()); signalId(0); })` — `disposeEffect` moves the region to `pendingRegions` and sets `owned[idx] = undefined` (index.ts:597-609); `currentScope` is still the dead scope (no freed dispatch ran: EnterDepth ≥ 1, no sweep); `signalId`'s region push dereferences `owned[currentScope >> 3]!` → TypeError (index.ts:433-435). This is a4-3's exact scenario, which v5 claims the freed-seam clear resolves. It does not, because the seam fires too late.

*(b) The spec's own pinned semantic corrupts the arena.* An effect that stops itself and spawns a replacement: `effect(() => { stop(); effect(child); })`. The spec pins "creates that child in an untracked context — the child becomes a root effect." As specced: `dispose` queues the parent, gen unbumped, `activeSub` uncleared (sweep can't run, EnterDepth ≥ 1) → `effectId` sees `prevSub !== 0` and links the child **into the freed parent record** (index.ts:504-508). The parent's exit: `purgeDeps` starts *after* `DepsTail` (index.ts:936-942), which now points at the fresh link — the link survives. The exit sweep then frees the parent **without unlinking anything** (sweep-time `freeNode` zeroes slots only, system.ts:1243-1261). The child's subs list permanently holds an edge naming the parent's record id. When that record recycles as stranger X: `enqueueEffect` for the child hoists through the ghost edge into X — clearing X's `Watching` bit and queueing X spuriously (index.ts:703-730); disposing the child later runs `unlink` on the ghost edge, which writes `M[X + DepsTail]`/`M[X + Deps]` (system.ts:1390-1399) — wiping a live stranger's dependency-list head. Misattributed notification plus cross-node corruption.

*(c) Manual frames, no exit at all.* `setActiveSub(E); dispose(E); get(s)` — `get` links s→E into the freed record; no frame exit occurs, so no sweep, no clear, no gen bump. Same ghost-edge endgame as (b), and if `s` is a detachable signal the read *attaches* — allocating a record and pinning the hook environment to a dead subscriber, the exact v1-finding-3 weaponization the design exists to prevent.

The restore-site half of hardening 1 is genuinely sound (see Not refuted); the clear-side half is specified on a false premise about the code. The repair is small — dispatch the doomed-frame clears (and arguably the gen bump) at queue time in `freeNodeId`/`reclaimOrphan`, not at the sweep — but as written the design does not deliver "reads in a doomed frame are simply untracked," and obligation 13's "tracking stops at the free" is unimplementable on the seam the spec names. Defeats: hardening 1's clear side, obligation 13, and — inside the window — the detach ownership premise itself.

**2. MAJOR — Microtask-only growth breaks a documented, working-today synchronous shape the spec never mentions: frameless bulk creation past 3/4 capacity.**

Today a top-level, unscoped synchronous creation burst larger than capacity works: each create passes `maybeBoundary` at EnterDepth 0 (system.ts:954-969, 1140-1150), growth fires mid-burst, and the retired-engine forwarding (`newCustom`'s `retired` check, system.ts:1179-1187) plus shared side columns carry the in-flight `createNode` call across the migration correctly. This is documented behavior ("the arena also grows automatically once 3/4 full," index.ts:1110-1117). Bug #4's two real violations are the *scoped* create (stale-closure `M[id + NodeSlot.Gen]` read, index.ts:434) and trigger's pre-bracket scratch alloc (index.ts:645 vs 662) — the unscoped top-level burst is not one of them. Hardening 5 excludes growth from creation entries wholesale ("only … the microtask maintenance path and the explicit `growCapacity()` call"), so a 3M-signal synchronous burst on a 2M arena now throws at capacity (system.ts:1230-1232) where today it grows and completes. The spec's coverage claim — "Synchronous code whose LIVE set outgrows the arena **inside one frame** still throws … exactly as today" — does not cover this shape: it is inside no frame. Either the spec documents this second regression class with its escape hatch, or bug #4's fix must keep one safe synchronous growth point at creation entry *before* dispatching into the host generation's closure (the trampolines at index.ts:1182-1210 are host-stack-empty at that instant). As specced, the fix is sound against bug #4 but its stated cost is wrong. Defeats: hardening 5's "no legitimate shape beyond the documented throw" framing; the Documented-limitation section's completeness.

**3. MAJOR — A save channel is still missed: the registry ownership channel holds bare ids, `orphan()` validates only `Flag.Live`, and the registration can never be revoked — a recycled record is reclaimed out from under its live occupant.**

`registry.register(owner, id)` stores a bare id with no unregister token (system.ts:812-820); `orphan(id)` checks `Flag.Live` only (system.ts:1777-1791) — the exact identity-blind liveness test hardening 1 exists to abolish. `disposeNode`'s own doc claims "the generation guard makes it a no-op" (system.ts:425-430); no such guard exists on this path. Public scenario: `const o = signalOwner(0, {...}); dispose(o[SignalIdKey])` (dispose is public and unrestricted, index.ts:567-578) → record recycles to live node B → drop `o` → GC fires `orphan`: B is Live → B has subs → B is stamped `Orphaned` and reclaimed at its next last-unlink (system.ts:1767-1769) — a live stranger freed. Pre-existing, but hardening 1 claims the (id, generation) discipline now covers every cached-id channel ("the two cached-id channels that are not the active subscriber") and this is a third, and hardening 5's exit sweeps make the recycle window strictly more common. The `pendingRegister` queue (owner, bare id) has the same defect between create and drain. Fix shape: gen-pair the registry held value. Defeats: hardening 1's channel-enumeration completeness; obligation 24's registry-path coverage.

**4. MAJOR — The cached-prev link-walk re-entrancy that hardening 2's own rationale names is fixed in only one of its three instances; hardening 3's deferred drop routes through an unfixed one.**

Hardening 2 justifies re-read-the-head with "an unlinked child's own cleanup can dispose siblings and recycle link records mid-walk" — but applies it only to disposal teardown. The same shape survives in:
- host `disposeChildEffects` (index.ts:916-925): caches `prev = M[l + PrevDep]` before `unlink(l)`, and the unlink runs the child's `disposeEffect` → `runCleanup` → user code synchronously;
- kernel `disposeAllDepsInReverse` (system.ts:1804-1811): used by `reclaimOrphan` and by the computed unwatched drop — which hardening 3 defers to update exit but still *executes* through this walk. A computed can own child effects (effect created in a getter links dep=child, sub=computed, index.ts:504-508), so the drop runs user cleanups mid-walk.

Link records recycle immediately (`freeLink`→`allocLink`, system.ts:1300-1326). Scenario: parent re-runs; `disposeChildEffects` caches `prev = L_A`, unlinks child B; B's cleanup does `dispose(aStop)` (frees `L_A` to the link free stack) then `effect(() => get(s))` (allocLink pops `L_A` and rewrites all seven fields); the walk resumes at `l = L_A`, now an unrelated live edge — reads its Dep's kind and, if ≥ Effect, unlinks a live edge of a stranger's list. Pre-existing, unfixed by the five hardenings, and the design's premise is that the hardening program closes the frame-lifecycle holes "at the source." Defeats: hardening 2's scope; hardening 3's drop mechanism inherits it; obligation 14 covers only the disposal walk.

**5. MINOR — Hardening 3's pending bit has no specified home.** If it lives outside the flags word, a getter that disposes its own computed mid-update leaves the bit set (`freeNodeId` zeroes only flags) and the exit performs the drop on a pendingFree record — writing `Mutable | Dirty` into a freed record awaiting sweep. Flags-word placement (zeroed by `freeNodeId`) avoids this for free; the spec should pin it.

**6. MINOR — Generation validation is silently void across `reset()`.** `resetState` rewinds the arena to gen 0 (system.ts:1161-1175), so a pre-reset saved pair (id, 0) for a never-freed record validates against a post-reset stranger at the same id. Contract-covered ("every OTHER pre-reset handle … undefined to reuse"), but hardening 1's "restores 0 when the generation no longer matches" should carry the one-sentence carve-out, since the frame setter is the one public channel a user will plausibly hold across a reset.

**7. MINOR — Sweep-at-exit clearing host columns for already-queued ids is safe today only by kind-accident.** `disposeEffect` reads `owned[idx]` *after* `runCleanup` (index.ts:594-609), whose exit is a depth-zero sweep site that runs `freedNode(id)` for the just-queued id and clears its columns. This is currently unreachable only because effects never have `owned[]` entries and scopes never have cleanups. The invariant ("no code reads a queued id's host columns across a bracketed user-code exit") is load-bearing under hardening 5 and appears nowhere in the spec.

**8. MINOR — Gates: the 3% environment-rejection cap means every regression gate, including the suite geomean 1.00 and the 1.05 per-row cap, can legitimately loosen to ~1.06 on a compliant machine.** Bounded and defensible, but the spec should state the worst-case bound it is accepting rather than leaving it implied by the formula.

## Per-surface disposition (the brief's six)

1. **Frame identity**: gen-across-growth SOUND (verbatim prefix copy, system.ts:1014-1019; obligation 23 holds). Gen-across-reset: finding 6. Missed channel: finding 3. Free→dispatch window: **finding 1 — refuted.**
2. **Sweep-only exits**: not refuted in itself. Effect queue, pendingRegions, and flush's catch re-arm are all gen-guarded (index.ts:871-897, 619-628); walk stacks hold link ids and the sweep frees only node records; the finallys' post-sweep writes to swept self-records are benign zero-stores; the decrement-before-restore order in effectId/run/updateComputed makes gen validation land after the bump, and trigger's early restore is covered by the sweep-time cache clear at its own exit. Residue: finding 7's fragile invariant.
3. **Microtask-only growth**: closes bug #4's two named violations; **finding 2** on the undocumented broken shape.
4. **Deferred-drop bit lifecycle**: not refuted (still-empty check, clear-on-all-exits, clear-on-rewatch, per-record bit under non-reentrant self-updates all verified consistent), modulo finding 5's storage home.
5. **Core detach mechanics end to end**: outside the finding-1 window, not refuted — I could not construct a leak, stale read, wrong value, double free, or misattributed tracking. Verified specifically: pendingVals is the newest value on every path (index.ts:1023-1037, 775-779, 943-957); attach rollback is clean (`allocLink` throws before any list mutation, system.ts:1349-1363; hook installs only after the link); the queued record is unreachable pre-sweep so re-reads attach fresh; the kernel's post-dispatch subs-recheck/version-zero/Orphaned sequence (system.ts:1756-1770) is a no-op against a detach-cleared record; the reset walk detaches via the hook and `resetState` drops the pendingFree queue wholesale — no double free; the masquerade parenthetical is real (LinkSlot.Version at offset 0 vs HostStarted=8192) and the hook gate is immune to it. **Inside the window, finding 1 delivers misattributed tracking, pinning, and corruption through the design's own pinned scenario.**
6. **Gates**: finding 8 only.

## v4 resolution ledger

**a4:**
1. RESOLVED — (id, gen) pairs close the restore-after-recycle construction; every recycle passes through a sweep, which bumps the gen before any subsequent restore.
2. RESOLVED — exits are sweep-only; growth is confined to the microtask path and growCapacity.
3. NOT RESOLVED — all seven restore sites plus scope/scratch are named, but the clear side rides a seam that fires at the sweep, not the free: this finding's own effectScope crash scenario still reproduces as specced (finding 1).
4. RESOLVED — drop conditional on still-empty; bit cleared on every exit including throw and on re-watch.
5. RESOLVED — consume-the-head is normative; creation-order cleanups pinned; reset's order kept separately documented.
6. RESOLVED — reset refuses inside an open batch.
7. RESOLVED — filed as pre-existing kernel bug #4 with the microtask-only fix and obligation 22 (the fix's undocumented collateral is finding 2).
8. RESOLVED — pinned as a semantic change with the old behavior described.
9. RESOLVED — the limitation section now credits hardening 4.
10. RESOLVED — no-growth-beyond-initial steady state, 10,000-cycle window, 3% environment rejection.

**b4:**
1. RESOLVED — generation, not liveness, validates every restore.
2. RESOLVED — all seven sites named, including both creation finallys and runCleanup; the growth handoff is covered because the new generation's freed hook clears its own booted caches.
3. RESOLVED — the creation-order flip is pinned with a test.
4. RESOLVED — re-watch cancels via the watched dispatch and the still-empty check.
5. RESOLVED — exits sweep only; no memory moves; gen-guarded queues; remainder-of-finally stores into swept self-records are benign.
6. RESOLVED — reset refuses inside an open batch, closing the batchDepth −1 poisoning.
7. RESOLVED — payoff gates take the bare ratio; 3% rejection bounds the regression-gate loosening (residue: finding 8).
8. RESOLVED — the taxonomy cell now reads "explicit stop only."

## Verdict

The convergence is real: every v4 construction is closed, the restore-identity design is correct, and the detach mechanics proper survive genuine attack. But hardening 1's clear side — the mechanism the whole doomed-frame story stands on — is specified against a freed-notification timing the code does not have, and the resulting window reproduces a4-3's crash verbatim and corrupts the design's own pinned scenario. One false premise, load-bearing, with a small known repair (queue-time clears), plus three MAJORs that a v6 must absorb.

REFUTED