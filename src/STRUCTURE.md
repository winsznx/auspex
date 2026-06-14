# Source layout — one process, two logical planes

The build stays a **single Railway process**. These folders are *logical* planes, not
separate services. The architecture doc shows they are splittable; the code does not split.

```
src/
  index.ts                 # entrypoint: wires planes, parses --mode / --inject flags
  config.ts                # typed env loader (reads .env), fail-fast on missing required vars
  shared/
    events.ts              # in-process event bus (typed EventEmitter) — the spine between planes
    policy.ts              # the shared TipPolicy object (regime → { tip rule, escalation, hold })
    types.ts               # SlotStatus, LifecycleRecord, FailureLabel, Regime, etc.
    logger.ts              # pino logger
  data-plane/              # HOT · deterministic · never awaits the LLM
    stream-ingestor.ts     # C1 ✅ (drop in verified module) — Yellowstone v5 slot/commitment stream
    leader-window.ts       # C2 — "Jito leader in N slots" + skip detection
    tip-floor.ts           # C3 — tip_floor REST/WS client + baseline = max(p75, floor)
    bundle-constructor.ts  # C4 — confirmed blockhash + memo self-transfer + tip LAST, no ALT
    submitter.ts           # C5 — regional block-engine sendBundle → bundle_id
    lifecycle-tracker.ts   # C6 — stream-first + getBundleStatuses backup → LifecycleRecord
    failure-classifier.ts  # C7 — outcome → FailureLabel
  control-plane/           # WARM · async AI · off the hot path
    tip-intelligence.ts    # C8 — telemetry → regime → STRUCTURED policy + logged rationale
    failure-retry.ts       # C9 — sync agent diagnose → remedy → resubmit on failure
    agent.ts               # LLM client wrapper (Claude) + structured-output schema
  harness/
    ab-harness.ts          # C10 — alternate ai|baseline under matched conditions, publish deltas
    fault-injector.ts      # C11 — force blockhash-expiry on command
    evidence-logger.ts     # C12 — persist explorer-checkable lifecycle log to evidence/
scripts/
  verify-day0.ts           # Day-0 gate: live-checks every external dependency, prints pass/fail
evidence/                  # run-*.json + human-readable logs (committed as proof)
```

## Hard rules (enforced by the dynamic workflow, see ../CLAUDE.md)
- **No mocks, no demo data.** Every number traces to a real mainnet artifact.
- Each component passes its gate (`tsc --noEmit` clean + real mainnet output) before the next starts.
- The data plane applies the **current cached** `TipPolicy` instantly; it never blocks on the agent.
- The control plane writes a **structured regime-conditioned policy**, never a scalar multiplier.
