# Architecture — Auspex

> **Skeleton.** The implementation/synthesis agents fill the marked sections from the real run.
> Per the playbook, this doc **leads with the measured A/B result**, then explains the design.

## 0. The result, up front
_(C10/C12 output — landing-rate / latency / cost delta between `ai` and `baseline`, with the
evidence pointer. Filled from a real mainnet run. No mocks.)_

## 1. Why two planes
Slots are ~400ms; LLM inference is 0.5–2s+. A synchronous per-bundle LLM call would blow blockhash
windows and miss leader slots — and reads to judges as a naive "AI wrapper," violating the bounty's
required *clean separation between AI layer and core transaction stack*. So:

- **Data plane (hot, deterministic):** applies the **current cached** `TipPolicy` instantly. Never
  awaits the LLM.
- **Control plane (warm, async):** observes telemetry, and on regime shifts writes a new structured
  `TipPolicy`. Latency here is free.

The split is **logical**, in one Railway process. This doc shows it is cleanly splittable into two
services (the event bus becomes a network boundary); the code does not split — simplicity is a
feature.

```
Yellowstone gRPC ──▶ [DATA PLANE] C1→C2→C4→C5→C6→C7 ──events──▶ [CONTROL PLANE] C8/C9
                          ▲ applies current TipPolicy ◀───────── writes structured policy
   C10 A/B · C11 Fault injector · C12 Evidence logger
```
_(Full diagram: [PRD.md §3](../PRD.md).)_

## 2. Why the AI genuinely owns the decision
The control plane does **not** emit a scalar multiplier. It emits a **structured regime-conditioned
policy**: `regime → { tip rule, escalation profile, hold flag }`, re-derived with **logged reasoning
on every regime shift / failure event**. Over a run there are many logged AI decisions, and the
realized tip visibly tracks the agent's reasoning as conditions change. The single owned decision is
**the tip** (hold-vs-submit is a facet of it).

Structured telemetry into the agent: (1) processed→confirmed delta over last N slots; (2) tip
variance + current tip-floor percentiles; (3) leader-skip flag; (4) our landing rate split by
strategy; (5) slots to the next Jito window.

## 3. The failure loop (agentic, on the recovery path)
On a bundle failure, the same brain diagnoses → decides remedy → resubmits — **synchronously**,
because the window is already gone so latency is free. _(C9. Demoed live via the fault injector, C11.)_

## 4. The A/B method (why the delta is credible)
`ai` and `baseline = max(p75_tip, floor)` are **alternated under matched network conditions** so the
comparison is not confounded by congestion timing. _(C10 — guarded by the doubting-agent against
cherry-picking.)_

## 5. Evidence integrity
≥10 real mainnet bundles incl. ≥2 failures; every `bundle_id` + slot number cross-checks on
`explorer.jito.wtf` and Solscan. _(C12 → [`../evidence/`](../evidence/).)_

## 6. Verified technical foundations
Yellowstone v5, `confirmed` blockhash, Jito tip-as-last-instruction / no-ALT / regional engine —
see [PRD.md §4](../PRD.md) and [RESOURCES.md](./RESOURCES.md). All recorded in `gbrain`.
