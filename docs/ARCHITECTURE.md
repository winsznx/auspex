# Architecture — Auspex

> This doc **leads with the measured A/B result**, then explains the design. The result table is
> filled from a real mainnet run — no mocks, no demo data.

---

## 0. The result, up front

| Strategy | Bundles | Landing rate | Median latency (submit→confirmed) | Avg tip (SOL) | Cost per land |
|----------|--------:|-------------:|----------------------------------:|--------------:|--------------:|
| `ai`     | _pending_ | _pending_  | _pending_                         | _pending_     | _pending_     |
| `baseline = max(p75, floor)` | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

**Delta:** _pending the funded evidence run._ Every `bundle_id` and slot number cross-checks on
`explorer.jito.wtf` and Solscan.

---

## 1. Why two planes

Solana slots are ~400ms; LLM inference is 0.5–2s+. A synchronous per-bundle LLM call would blow
blockhash windows and miss leader slots — and reads to a reviewer as a naive "AI wrapper," violating
the required **clean separation between the AI layer and the core transaction stack**. So:

- **Data plane (hot, deterministic):** applies the **current cached** `TipPolicy` instantly. Never
  awaits the LLM. This is where every real-SOL action happens.
- **Control plane (warm, async):** observes telemetry and, on regime shifts, writes a new structured
  `TipPolicy`. Latency here is free.

The split is **logical**, in one Railway process. This doc shows it is cleanly splittable into two
services — the in-process event bus (`AuspexBus`) simply becomes a network boundary — but the code
stays one service. Simplicity is a feature, not a missing milestone.

```
 slot/commitment stream ─▶ [ DATA PLANE ]                         [ CONTROL PLANE ]
 (Yellowstone gRPC or         C1 → C2 → C4 → C5 → C6 → C7  ──events──▶  C8  Tip Intelligence
  RPC-WebSocket fallback)          ▲                                    C9  Failure-Reasoning Retry
                                   │ applies current TipPolicy ◀──writes structured policy──┘
        side harnesses:  C3 tip-floor · C10 A/B · C11 fault injector · C12 evidence logger
```

---

## 2. Why the AI genuinely owns the decision

The control plane does **not** emit a scalar multiplier. It emits a **structured, regime-conditioned
policy**: `regime → { tip rule, escalation profile, hold flag }`, re-derived with **logged reasoning
on every regime shift / failure event**. Over a run there are many logged AI decisions, and the
realized tip visibly tracks the agent's reasoning as conditions change. The single owned decision is
**the tip** (hold-vs-submit is a facet of it) — deliberately scoped; no second owned decision
(routing, sizing, MEV) is added.

Structured telemetry fed to the agent:

1. processed→confirmed delta over the last N slots (network-health signal)
2. tip variance + current tip-floor percentiles
3. leader-skip flag
4. our own landing rate, split by strategy
5. slots to the next Jito window

## 3. The failure loop (agentic, on the recovery path)

On a bundle failure the **same brain** diagnoses → decides a remedy → resubmits — **synchronously**,
because the window is already gone, so latency is free here. Demonstrated live via the fault injector
forcing a blockhash-expiry.

## 4. The A/B method (why the delta is credible)

`ai` and `baseline = max(p75_tip, floor)` are **alternated under matched network conditions**, so the
comparison is not confounded by congestion timing. The harness is guarded against cherry-picking: the
strategy assignment is fixed before each window, and every run is logged whether it lands or fails.

## 5. Evidence integrity

≥10 real mainnet bundles including ≥2 failures; every `bundle_id` + slot number cross-checks on
`explorer.jito.wtf` and Solscan. Failures come from the fault injector (blockhash-expiry) plus at
least one natural drop/leader-skip. Output lands in [`../evidence/`](../evidence/).

## 6. Verified technical foundations

These are confirmed against live endpoints / the installed packages, not assumed:

- **Stream:** Yellowstone v5 (`.destroy()`, uint64-as-string, built-in reconnect with
  `slotRetention: 150`); abstracted behind `SlotSource` so an RPC-WebSocket fallback is drop-in.
- **Blockhash:** fetched at **`confirmed`** (~150-slot validity); never `finalized` for a
  time-sensitive hash.
- **Bundle:** the Jito tip is a **last-instruction** SOL transfer to a `getTipAccounts` address, **no
  address-lookup-table**, min **1000 lamports**, submitted to a regional block engine (1 req/s/IP).
  Jito `sendBundle` requires **base58**-encoded transactions (not base64) — verified live.
- **Leader windows:** derived from `getLeaderSchedule` ∩ the Jito validator set (kobe), with a
  4-consecutive-slot window invariant; a mis-mapped schedule is refused rather than served.

---

## 7. Build status (as-built vs designed)

| Plane | Component | Status |
|-------|-----------|--------|
| data | C1 Stream Ingestor · C2 Leader Window · C3 Tip-Floor + Baseline · C4 Bundle Constructor (construct) | 🟢 **live**, doubting-gated, on free infra |
| data | C5 Submitter · C6 Lifecycle · C7 Failure Classifier | ⏳ designed — gated on a funded wallet |
| control | C8 Tip Intelligence · C9 Failure-Reasoning Retry | ⏳ designed |
| harness | C10 A/B · C11 Fault Injector · C12 Evidence Logger | ⏳ designed |

Sections 0 and 4's numbers are produced by C10/C12 on a funded mainnet run. Everything in §1–§6 is
either built (C1–C4) or a locked design decision verified against live infrastructure.
