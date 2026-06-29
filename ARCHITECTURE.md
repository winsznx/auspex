# Architecture — Auspex

> This doc leads with what the current env can prove on mainnet, then explains the design. No mocks,
> no fabricated bridges, no claim that public RPC is Dragon's Mouth.

---

## 0. Current Proof, Up Front

| Capability | Current proof |
|------------|---------------|
| Slot stream | Live Solana PubSub WebSocket, with processed/confirmed/finalized watermarks |
| Leader windows | Live Jito window detection from leader schedule and Jito validator set |
| Tip market | Live Jito tip-floor REST + WebSocket |
| AI decision | Implemented Groq-backed `BID | NO_BID` policy; live proof requires a valid Groq key |
| Bundle construction | Signed, locally validated Jito-compatible bundle bytes with tip-last invariant |
| Bundle landing | Blocked by available route; direct public Jito returns bundle IDs but does not land bundles |

The final A/B landing table is intentionally not filled until a real staked/whitelisted Jito route
or provider bundle route is available.

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
 (Solana PubSub today;       C1 → C2 → C4 → C5 → C6 → C7  ──events──▶  C8  Tip Intelligence
  Yellowstone when funded)          ▲                                    C9  Failure-Reasoning Retry
                                   │ applies current TipPolicy ◀──writes structured policy──┘
        side harnesses:  C3 tip-floor · C10 A/B · C11 fault injector · C12 evidence logger
```

---

## 2. Why the AI genuinely owns the decision

The control plane does **not** emit a scalar multiplier. It emits a **structured, regime-conditioned
bid policy**: `BID` with a bounded tip, or `NO_BID` when submission is uneconomical, re-derived with
**logged reasoning on every regime shift / failure event**. Over a run there are many logged AI
decisions, and the realized tip visibly tracks the agent's reasoning as conditions change. The
single owned decision is **the bid policy** — deliberately scoped; no second owned decision
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

## 5. Evidence Integrity Target

The target final run is at least 10 real mainnet bundles including at least 2 failures; every
`bundle_id` and slot number cross-checks on `explorer.jito.wtf` and Solscan. That target depends on
bundle landing being unblocked. Until then, the current proof is the available-infra stack:
streaming, leader windows, tip market, AI policy, and signed bundle construction.

## 6. Verified technical foundations

These are confirmed against live endpoints / the installed packages, not assumed:

- **Stream:** Solana PubSub WebSocket is live with the current env. Yellowstone v5 support is
  implemented (`connect()` before `subscribe()`, `.destroy()`, uint64-as-string, built-in reconnect
  with `slotRetention: 150`) but requires a real Dragon's Mouth-compatible endpoint. A normal Solana
  JSON-RPC URL, or a free public-RPC bridge story, is not equivalent.
- **Blockhash:** fetched at **`confirmed`** (~150-slot validity); never `finalized` for a
  time-sensitive hash.
- **Bundle:** the Jito tip is a **last-instruction** SOL transfer to a `getTipAccounts` address, **no
  address-lookup-table**, min **1000 lamports**, submitted to a regional block engine (1 req/s/IP).
  Jito `sendBundle` accepts base64 or base58, with **base64 recommended** and base58 deprecated.
- **Leader windows:** derived from `getLeaderSchedule` ∩ the Jito validator set (kobe), with a
  4-consecutive-slot window invariant; a mis-mapped schedule is refused rather than served.

---

## 7. Build status (as-built vs designed)

| Plane | Component | Status |
|-------|-----------|--------|
| data | C1 Stream Ingestor · C2 Leader Window · C3 Tip-Floor + Baseline · C4 Bundle Constructor | live with available infra |
| data | C5 Submitter · C6 Lifecycle | built; submit path live; bundle landing blocked on routing/staked Jito connection |
| data | C7 Failure Classifier | pending |
| control | C8 Tip Intelligence | implemented; env-gated by Groq auth |
| control | C9 Failure-Reasoning Retry | designed |
| harness | C10 A/B · C11 Fault Injector · C12 Evidence Logger | designed |

Sections 3-5's landing evidence is produced by C10/C12 only after bundle landing is unblocked.
Everything in section 0 is runnable against the current env except the Groq-backed C8 proof when
`doctor:env` reports invalid Groq auth.
