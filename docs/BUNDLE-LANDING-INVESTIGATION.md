# Bundle Landing Investigation

> Status report — 2026-06-29. Honest account of where the data plane stands, what is
> proven live on mainnet, and the one blocker between the current build and a full
> evidence run. No mocks, no demo data — every claim below traces to a real mainnet
> call or an on-chain artifact.

## TL;DR

The C1–C6 data plane is **built and live on mainnet**: it streams slots, detects Jito
leader windows, reads the live tip-floor, builds + signs a valid bundle, submits it to the
Jito Block Engine, and tracks its lifecycle. Submissions are **accepted** (Jito returns a
real `bundle_id`) and the underlying transaction is **provably valid** (it lands on-chain as
a normal transaction at a sufficient tip).

The open blocker: **bundles are accepted but never enter Jito's auction** — `sendBundle`
returns a `bundle_id`, but `getInflightBundleStatuses` reports `Invalid` immediately and the
bundle never lands *as a bundle*. We have systematically eliminated every client-side cause.
The remaining, untested-by-us cause is **submission routing**: Jito's block engine appears to
require a whitelisted / staked connection for a bundle to actually enter the auction, which
direct public submission from an arbitrary IP does not have.

## What is proven live on mainnet

| Component | State | Evidence |
|-----------|-------|----------|
| C1 Stream Ingestor (slot/commitment) | 🟢 live | advancing processed/confirmed/finalized watermarks over RPC-WebSocket |
| C2 Leader Window Tracker | 🟢 live | Jito windows from `getLeaderSchedule` ∩ kobe set, ~96% coverage, 100% leader decode vs `getSlotLeaders` |
| C3 Tip-Floor Client + Baseline | 🟢 live | live p25/p50/p75/p95/p99 percentiles, `baseline = max(p75, floor)` |
| C4 Bundle Constructor | 🟢 live | signed legacy tx, tip-last, blockhash-live via `isBlockhashValid` |
| C5 Submitter | 🟢 submit-path live | real `bundle_id` from `sendBundle`, pre-submit blockhash recheck |
| C6 Lifecycle Tracker | 🟢 built | polls `getInflightBundleStatuses` → `getBundleStatuses`, classifies landed/failed |
| C7–C12 | ⏳ pending | classifier, AI tip intelligence, A/B harness, fault injector, evidence run |

## The symptom

For every bundle, across ~70+ real mainnet submissions:

- `sendBundle` returns a valid `bundle_id` (the transaction parsed and its signature verified).
- `getInflightBundleStatuses` returns `Invalid` (`bundle_id` not in the system) within ~1s and
  stays `Invalid`; the status **never** transitions to `Pending`.
- `getBundleStatuses` returns `null` — the bundle never lands as a bundle.
- At a high tip the *transaction itself* leaks onto chain via the normal banking stage (the tip
  is charged as a plain transfer — wasted), confirming the transaction is valid but the **bundle
  never entered the auction**.

A bundle that lost an auction would show `Pending` first. Never reaching `Pending` means the
bundle is dropped at **intake**, before the auction.

## Systematic elimination (each ruled out with a live test)

| Hypothesis | Test | Result |
|-----------|------|--------|
| Tip too low | escalated 10k → 50k → 1M → 10M lamports (> p99) | still `Invalid` — a 10M tip would crush any auction it entered, so it never enters |
| Wrong region | submitted to 7 regional engines in parallel | all 7 accept; all `Invalid` |
| Submission timing | gated on Jito leader window; also fired ahead of window | no change (96% of slots are Jito-led anyway) |
| Encoding | base58 and base64 (`{encoding:'base64'}`) | both accepted, both `Invalid` |
| Blockhash freshness | `confirmed` and `finalized` | both `Invalid` |
| Multi-region duplicate | single region, single submit | still `Invalid` |
| Bundle structure | mirrored Jito's official `basic_bundle.js` exactly (real transfer → tip → memo) | still `Invalid` |
| Tip account stale | verified `getTipAccounts` global == regional == canonical 8 | valid, not the cause |
| Host location / latency | this machine **and** a Frankfurt data-center host co-located with Jito | both fail identically — not latency, not location |
| RPC blockhash view | swapped public RPC for a dedicated provider RPC | still `Invalid` |
| Helius free plan | `sendBundle` through configured Helius RPC | blocked by API: business plan or above required |
| Our submitter code | Jito's own `jito-js-rpc` SDK from the same host | identical `Invalid` — not our code |

Two facts are constant across every failing configuration: the **wallet** and the **direct,
unauthenticated submission to Jito's public block engine**.

## Leading hypothesis

Provider documentation (e.g. Triton) notes that **the customer is responsible for having their
IP whitelisted with Jito's Block Engine**, and providers (Helius "Sender", Triton, QuickNode
"Lil' Jit") sell **staked / whitelisted Jito connections** precisely to make bundles land. This
fits every symptom: an un-whitelisted IP receives a `bundle_id` (the tx parsed) but the bundle is
never admitted to the auction (`Invalid`), regardless of tip, region, timing, or structure.

Helius confirms the same direction operationally: its free RPC endpoint is healthy for normal RPC,
but `sendBundle` is gated to business plans or above. That makes the remaining unblocker commercial
access to a provider bundle route, not a local code change.

**Next step:** get an eligible provider route: Helius Business/Sender access, QuickNode Lil' JIT,
SolInfra-sponsored Yellowstone/Jito support, or direct Jito whitelisting. If one bundle lands, the
`bundle_id` is a real Jito bundle verifiable on `explorer.jito.wtf`, and the path to the full
≥10-bundle evidence run is unblocked.

## Diagnostic scripts (the investigation, reproducible)

All under `scripts/`, each a single real-mainnet probe:

- `diag-sim.ts` — `simulateTransaction` (tx is valid, `err: null`)
- `diag-sendtx.ts` — sends the bundle tx as a normal transaction (lands on-chain → tx/wallet/RPC fine)
- `diag-land.ts` — multi-region, escalating-tip submit
- `diag-land1.ts` — single-region, small-tip, patient poll
- `diag-land2.ts` — mirrors Jito's `basic_bundle.js` structure exactly
- `diag-helius.ts` — submit via Helius RPC; free accounts currently return a business-plan gate
- `diag-sdk.ts` / `diag-simbundle.ts` / `diag-bundle.ts` — Jito SDK + block-engine probes

## Honest position

The hard, deterministic data plane (C1–C6) is real and demonstrable today. The bundle-landing
blocker is isolated to submission routing, with a concrete, documented next step. The control
plane (C8 AI tip), A/B harness (C10), and the full evidence run (C12) depend on landing being
unblocked.
