# Auspex

Auspex is a Solana smart-transaction stack for the Superteam Nigeria **Advanced Infrastructure
Challenge**. With the infrastructure available today, it streams live mainnet slot telemetry, tracks
Jito leader windows, reads live Jito tip markets, asks an AI agent for a bounded bid policy, and
constructs signed Jito-compatible bundle bytes without mocks.

The core design is deliberately narrow: one Railway TypeScript service, two logical planes, one
AI-owned decision. The AI owns **bid policy** only: `BID` with a bounded tip, or `NO_BID` when the
current regime makes submission uneconomical.

## Current State

This repo is not a mock demo. The available-infra path runs against Solana mainnet today.

| Area | State | Notes |
|---|---|---|
| C1 slot stream | Live via Solana PubSub WebSocket | This is real mainnet slot telemetry, not Yellowstone/Geyser. Yellowstone code is implemented but needs a paid or sponsor-provided Dragon's Mouth endpoint. |
| C2 leader windows | Live | Jito leader windows derived from live leader schedule and Jito validator set. |
| C3 tip floor | Live | REST seed plus WebSocket stream from Jito tip-floor endpoints. |
| C4 bundle construction | Live construct gate | Builds and signs real bundle bytes with tip-last validation; no submit in this gate. |
| C5/C6 submit + lifecycle | Built | Direct public Jito route returns bundle IDs, but landing is blocked by bundle intake/routing. |
| C8 AI bid policy | Implemented; env-gated | Uses Groq/OpenAI-compatible chat completion to return strict `BID | NO_BID` policy JSON from live telemetry. Current local env must pass Groq auth before recording this as live. |
| C7/C9-C12 | In progress | Failure classifier, retry loop, A/B harness, fault injector, final evidence run. |

The open infrastructure blocker is bundle landing: direct public `sendBundle` submissions are accepted
but show `Invalid` and never enter the auction. The next live test is routing through a provider or
endpoint with a staked/whitelisted Jito path. See
[BUNDLE-LANDING-INVESTIGATION.md](./docs/BUNDLE-LANDING-INVESTIGATION.md).

The open streaming blocker is Yellowstone/Dragon's Mouth credentials. A normal Solana JSON-RPC URL is
not a Dragon's Mouth gRPC source, and projects like `richat` still need a real gRPC upstream or a
self-hosted validator plugin. Auspex therefore treats Solana PubSub WebSocket as the honest
available-infra stream, not as a fake Geyser bridge.

## Available-Infra Proof

With `SOLANA_RPC_URL`, `JITO_BLOCK_ENGINE_URL`, `HOT_WALLET_SECRET_KEY`, and a valid
`GROQ_API_KEY`, Auspex can prove:

- live slot and commitment progression from mainnet
- live Jito leader-window detection
- live Jito tip-floor ingestion
- a real AI bid-policy decision from current telemetry
- signed, locally validated Jito-compatible bundle construction
- no SOL movement unless an explicit spendful command is run

What it cannot honestly prove without additional infrastructure:

- Yellowstone/Dragon's Mouth streaming
- Jito bundle landing as a bundle
- the final 10-bundle A/B evidence table

If `GROQ_API_KEY` fails auth, the AI decision must be described as implemented but not live. Do not
replace it with a deterministic heuristic and call that AI.

## Proof Commands

Install and configure real mainnet credentials:

```bash
npm install
cp .env.example .env
```

Read-only or no-submit checks that work with the available infrastructure:

```bash
npm run typecheck
npm run build
npm run doctor:env
npm run verify:c1
npm run verify:c2
npm run verify:c3
npm run verify:c4
npm run judge:demo
```

Strict premium-ingest gate:

```bash
npm run verify:day0
```

`verify:day0` is expected to remain `10/11 green` and closed until
`YELLOWSTONE_GRPC_ENDPOINT` is a real Dragon's Mouth-compatible endpoint. This is deliberate: the
PubSub WebSocket path proves the app wakes up live, but it is not counted as Yellowstone evidence.

Spendful commands, run only when the hot wallet and bundle route are intentionally ready:

```bash
npm run verify:c5
npm run run:evidence
npm run verify:evidence -- evidence/run-mainnet.json --strict
npm run run:ab
npm run fault:blockhash
```

`judge:demo` is the main recording command: it streams slots, reads tip floors, detects the next Jito
leader window, asks the AI agent for `BID | NO_BID`, and constructs local signed bundle bytes without
submitting or moving SOL.

## Environment

Required for the available-infra proof:

| Variable | Purpose |
|---|---|
| `SOLANA_RPC_URL` | Mainnet JSON-RPC for blockhashes, leader schedule, balances, and Solana PubSub slot WebSocket. |
| `JITO_BLOCK_ENGINE_URL` | Regional Jito block-engine endpoint for tip accounts and bundle submit/status APIs. |
| `HOT_WALLET_SECRET_KEY` | Base58 Solana keypair for local signing and spendful bundle runs. |
| `GROQ_API_KEY` | Control-plane LLM key for the live C8 bid-policy decision. |

Supported, but not available in the current budget/env:

| Variable | Purpose |
|---|---|
| `YELLOWSTONE_GRPC_ENDPOINT` | Real Dragon's Mouth-compatible gRPC endpoint. A normal RPC URL will not work. |
| `YELLOWSTONE_X_TOKEN` | Token for that gRPC endpoint. |
| `HELIUS_RPC_URL` | Provider endpoint used by `scripts/diag-helius.ts`; normal RPC works on free plans, but Helius `sendBundle` is currently business-plan gated. |

Optional model controls:

| Variable | Purpose |
|---|---|
| `GROQ_BASE_URL` | Defaults to `https://api.groq.com/openai/v1`. |
| `TIP_AGENT_MODEL` | Defaults to `llama-3.3-70b-versatile`. |
| `TIP_AGENT_MAX_TIP_LAMPORTS` | Hard cap for AI-selected tips; defaults to `100000`. |

Run `npm run doctor:env` to inspect the active environment safely. It prints only redacted endpoint
shapes and never prints private keys or tokens.

## Evidence Standard

Final submission evidence is designed to be machine-checkable, not just readable. The verifier checks
local evidence shape, Jito landed bundle status, Solana signature status, landed-slot agreement, A/B
labels, and strict submission minimums.

Each final bundle record should include:

```txt
run_id
strategy: ai | baseline
bundle_id
signature
target_leader_slot
landed_slot
submitted_at / processed_at / confirmed_at / finalized_at
tip_lamports
tip_percentile_used
policy_version
failure_classification
explorer links
```

## Architecture

- [ARCHITECTURE.md](./ARCHITECTURE.md) — two-plane design, AI isolation, A/B method, evidence model.
- [DEMO-SCRIPT.md](./DEMO-SCRIPT.md) — terminal-first 3-minute recording guide.
- [ADVERSARIAL-TESTING.md](./ADVERSARIAL-TESTING.md) — skeptical tests, known blockers, and red-team checks.
- [SECURITY.md](./SECURITY.md) — key handling, spend safety, and operational controls.
- [BUNDLE-LANDING-INVESTIGATION.md](./docs/BUNDLE-LANDING-INVESTIGATION.md) — current Jito landing blocker.
- [GEYSERBRIDGE-REVIEW.md](./docs/GEYSERBRIDGE-REVIEW.md) — review of the tempting free bridge route.

## Why Auspex Exists

On Solana, sending a transaction is not the whole problem. A production transaction stack has to
watch leader windows, blockhash age, tip-market pressure, commitment progression, and failure modes.
The bounty asks for that operational depth, plus one meaningful AI decision.

Auspex focuses the AI on one bounded decision: whether to bid and how much to tip. The hot path stays
deterministic and fast; the AI updates policy asynchronously from live telemetry. The submission is
not "trust the agent." It is "judge the agent against a fixed baseline using real lifecycle logs."

## How Auspex Is Built

The service is one Railway process with two logical planes:

- The data plane streams slots, tracks Jito leader windows, reads tip-floor data, builds bundles,
  submits bundles, and tracks lifecycle status.
- The control plane observes telemetry and emits a structured bid policy: `BID` with a bounded tip,
  or `NO_BID` when conditions make submission uneconomical.
- The evidence layer writes bundle records, policy decisions, failure classifications, and verifier
  inputs so judges can cross-check the run.

This avoids putting an LLM inside the 400ms slot path while still making the AI decision auditable.

## Three-Minute Demo Script

1. Run `npm run doctor:env` to show redacted, real mainnet configuration.
2. Run `npm run judge:demo` to show live slot streaming, Jito leader detection, tip floor, AI bid
   policy, and local bundle construction with `submit=false`.
3. Open [ARCHITECTURE.md](./ARCHITECTURE.md) and explain the hot data plane versus warm control plane.
4. Open [docs/BUNDLE-LANDING-INVESTIGATION.md](./docs/BUNDLE-LANDING-INVESTIGATION.md) and explain
   the current landing blocker honestly.
5. Show [ADVERSARIAL-TESTING.md](./ADVERSARIAL-TESTING.md) and [SECURITY.md](./SECURITY.md) to make
   clear this is built for real mainnet operations, not a scripted happy path.

## README Questions

**Q1 — What does the `processed_at` to `confirmed_at` delta tell you about network health?**

It is the time between local observation of a slot being processed and confirmed. Operationally, it
tracks how quickly the block moves from local execution to optimistic confirmation by the cluster. A
spiking delta suggests consensus or vote-propagation lag relative to execution, not necessarily a tip
auction problem. Auspex records this as a local receive-clock metric and keeps source labels so gRPC
and WebSocket samples are not mixed.

**Q2 — Why never use `finalized` commitment for a time-sensitive blockhash?**

A recent blockhash has a short validity window. `finalized` lags `confirmed`, so using a finalized
blockhash spends useful lifetime before the bundle is even signed. Auspex fetches blockhashes at
`confirmed`, stores `lastValidBlockHeight`, and re-checks blockhash validity immediately before
submission.

**Q3 — What happens if the Jito leader skips their slot?**

Bundles execute only when a Jito-Solana leader produces the relevant slot, and a bundle cannot cross
slot boundaries. If the targeted leader window is missed, the bundle does not roll into a standard
validator block; the remedy is to rebuild or resubmit for a later Jito leader with a fresh confirmed
blockhash. The tip only pays if the transaction lands.

## Deployment

Deployment target is **Railway only**. Configuration lives in [railway.json](./railway.json). Secrets
belong in Railway service variables, never in git.

## License

MIT. See [LICENSE](./LICENSE).
