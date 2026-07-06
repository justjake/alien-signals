# The upstream split, arena edition

Goal: index.ts has the SAME SEMANTICS as upstream alien-signals' index.ts —
the host owns tracking (activeSub, cycle, runDepth, batchDepth, queue,
flush) and manipulates node state directly — transliterated from
`node.field` to `M[id + Slot]`.

## Core (system.ts) exports

- Arena management: custom()/free()/owner registry/reset/growth/codegen.
- The five graph algorithms, id-shaped, taking explicit args like upstream:
  `link(depId, subId, version): LinkId`, `unlink(linkId, subId?)`,
  `propagate(subsLinkId, innerWrite)`, `checkDirty(depsLinkId, subId)`,
  `shallowPropagate(subsLinkId)`. The host reads M[id + NodeSlot.Subs]
  itself and passes link ids, exactly as upstream hosts pass node.subs.
- The seams that must run inside walks: update(id, flags), notify(id, gen).
- THE RECORD LAYOUT, as semantic const enums (the reason for splitting C):
  - `NodeSlot`: Flags, Deps, DepsTail, Subs, SubsTail, Gen, Stamp (f64 via D)
  - `LinkSlot`: Version, Dep, Sub, PrevSub, NextSub, PrevDep, NextDep
  - `SysSlot`: record-0 well-known slots (EnterDepth, ...)
  - flags: ReactiveFlags (public) + host bit field docs
- `buffer(): Int32Array` + `stampView(): Float64Array` + an `onGrow(cb)`
  hook (see wrinkle 1).

## Wrinkle 1: M rebinding across growth

The host keeps module-scope `let M / let D`, updated by the onGrow callback.
V8 const-tracks single-assignment module lets, so pre-growth they fold like
the old engine's closure consts; the first growth deopts them to plain
context slots (same cost class as the CSP fallback — acceptable, measured).

## Wrinkle 2: growth safety without core calls

Growth may not move the arena under a host frame that caches M in a
register. The old engine used engine-local enterDepth. Now: EnterDepth is an
ARENA SLOT (record 0). The host brackets user-code sections with direct
`M[SysSlot.EnterDepth]++/--` (measured: M-slot RMW == context RMW, a wash);
core's maybeBoundary reads the slot. Zero crossings, same invariant.
Epoch moves to a record-0 f64 slot the same way: host stamps/checks
directly; core propagate bumps it.

## Wrinkle 3: cross-module const enums

esbuild inlines const enums across files when BUNDLING (the shipped esm is
fine) but vitest's per-file transform does not. Resolution options, decide
during implementation: single-chunk bundle for tests, or frozen-object
twins exported for non-bundled consumers with a parity test.

## Layering

The raw layer (layout + buffer + five ops + seams) is the trusted-host tier
— what index.ts uses. The verb kit (pull/track/verify/runTracked/...) stays
as the safe tier for casual hosts; it is implemented over the same core and
no longer on index.ts's hot path.

## Why this performs like the fused engine

The host's updateComputed owns the whole ladder: entryFlags loaded once into
a named local and reused (no cross-verb GVN needed), one seam crossing per
recompute (core checkDirty -> update callback), tracking state in host
module scope exactly like upstream. Residual vs old fused core: value/getter
live on host objects (~1-2ns/node, the arena bet) and bounds checks vs map
checks (wash).
