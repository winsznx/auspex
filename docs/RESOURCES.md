# RESOURCES.md — verified third-party tools, docs & links

Every link below was confirmed against live docs during setup (2026-06-13). These are the
*only* sources of truth — **do not trust random tutorials**, especially for Yellowstone (all
online tutorials are stale v4; we use v5). Where a behavior matters, the verified fact is also
baked into [PRD.md §4](../PRD.md) and recorded in `gbrain`.

---

## 1. Yellowstone gRPC (Geyser) — slot/commitment stream  · C1
The data-plane ingest. Built by **Triton One** ("Dragon's Mouth").

| What | Link |
|------|------|
| npm package | `@triton-one/yellowstone-grpc` — install: `npm i @triton-one/yellowstone-grpc@^5.0.9` |
| GitHub (monorepo) | https://github.com/rpcpool/yellowstone-grpc |
| TypeScript client + examples | https://github.com/rpcpool/yellowstone-grpc/tree/master/examples/typescript |
| Node client source | https://github.com/rpcpool/yellowstone-grpc/tree/master/yellowstone-grpc-client-nodejs |
| Official docs | https://docs.triton.one/rpc-pool/grpc-subscriptions |

**v5 facts that bite (already in PRD §4.1):** `new Client(endpoint, xToken, channelOptions?, reconnectOptions?)`;
`subscribe()` returns a Node `Duplex`, teardown is `.destroy()` (NOT `.cancel()`); uint64 fields
(`slot`, `parent`) arrive as **strings** → `Number()` them; enable built-in reconnect with
`slotRetention: 150`; `SubscribeRequest` needs all filter maps + `accountsDataSlice: []`;
`SlotStatus` enum `Processed=0, Confirmed=1, Finalized=2, FirstShredReceived=3, Completed=4, CreatedBank=5, Dead=6`.

> **Endpoint + x-token** come from your provider. Claim **SolInfra credits** (up to $20k, includes
> Yellowstone gRPC) via Superteam — see §5.

---

## 2. Jito — bundles, tips, status  · C3/C4/C5/C6/C7
Bundles execute **only** while a Jito-Solana leader produces blocks; standard validators don't
process them. ≤5 tx, atomic, single-slot, expire after the next Jito leader.

| What | Link / value |
|------|--------------|
| Docs — low-latency txn send / bundles | https://docs.jito.wtf/lowlatencytxnsend/ |
| Block engine (global) | `https://mainnet.block-engine.jito.wtf` |
| Regional block engines | `ny` · `slc` · `amsterdam` · `dublin` · `frankfurt` · `london` · `singapore` · `tokyo` → `https://<region>.mainnet.block-engine.jito.wtf` |
| `sendBundle` | `POST https://<region>.mainnet.block-engine.jito.wtf/api/v1/bundles` |
| `getTipAccounts` | `POST …/api/v1/getTipAccounts` (8 accounts) |
| `getBundleStatuses` | `POST …/api/v1/getBundleStatuses` (≤5 ids/call) |
| `getInflightBundleStatuses` | `POST …/api/v1/getInflightBundleStatuses` (last 5 min) |
| **Tip floor REST** | `https://bundles.jito.wtf/api/v1/bundles/tip_floor` → `landed_tips_25th/50th/75th/95th_percentile` + EMA |
| **Tip stream WS** | `wss://bundles.jito.wtf/api/v1/bundles/tip_stream` |
| Bundle explorer (evidence) | `https://explorer.jito.wtf/bundle/<bundle_id>` |
| JS/TS SDK | https://github.com/jito-labs/jito-js-rpc |
| Rust SDK | https://github.com/jito-labs/jito-rust-rpc |
| Python SDK | https://github.com/jito-labs/jito-py-rpc |

**Limits (verified):** default **1 request/second/IP/region** (429 on exceed); **min tip 1000
lamports**; tip is a SOL transfer to a `getTipAccounts` address, **must be the LAST instruction**,
**no Address Lookup Tables** on the tip tx. Optional `x-jito-auth` UUID for elevated limits.

---

## 3. Solana — commitment, blockhash, leader schedule  · C2/C4/C6
| What | Link |
|------|------|
| JSON-RPC HTTP methods | https://solana.com/docs/rpc/http |
| `getLatestBlockhash` | https://solana.com/docs/rpc/http/getlatestblockhash |
| `isBlockhashValid` | https://solana.com/docs/rpc/http/isblockhashvalid |
| `getLeaderSchedule` | https://solana.com/docs/rpc/http/getleaderschedule |
| Commitment / confirmation | https://solana.com/docs/references/terminology#commitment |
| `@solana/web3.js` | https://github.com/solana-labs/solana-web3.js · docs: https://solana-labs.github.io/solana-web3.js/ |
| Solscan (cross-check evidence) | https://solscan.io |

**Verified facts (PRD §4.3):** blockhash valid ~150 slots (~60–90s); fetch at **`confirmed`**
(processed → ~5% dropped-fork risk; finalized → lags ≥32 slots/~13s, wasting the window);
processed→confirmed delta = time to gather ≥66%-stake optimistic-confirmation votes (Tower BFT).

---

## 4. Railway — deploy target (single service)
| What | Link |
|------|------|
| Docs home | https://docs.railway.com |
| Deploy a Node app (Railpack) | https://railpack.com/languages/node |
| Config-as-code (`railway.json` / `railway.toml`) | https://docs.railway.com/reference/config-as-code |
| Environment variables | https://docs.railway.com/guides/variables |
| CLI | https://docs.railway.com/guides/cli |

**Flow:** `railway init` → set service variables (mirror `.env.example`) → `railway up` →
`railway domain`. `railway.json` (in repo root) pins build (`npm ci && npm run build`) and start
(`npm run start`). Secrets live in Railway **service variables**, never in the repo.

---

## 5. Bounty, credits & community
| What | Link |
|------|------|
| Superteam Nigeria (Telegram — claim SolInfra credits here) | https://t.me/superteamng |
| Superteam Earn (bounties listing) | https://earn.superteam.fun |
| Jito Discord (rate-limit / auth tickets) | linked from https://docs.jito.wtf |
| Triton One (Yellowstone provider/support) | https://triton.one |

> **Action item (Day-0 #1):** message `t.me/superteamng` to claim SolInfra credits → get the
> Yellowstone gRPC endpoint + x-token + a mainnet RPC.

---

## 6. AI control plane (C8/C9) — the agent brain
The structured tip-policy reasoning + failure diagnosis. Use the **latest Claude model**.

| What | Link / value |
|------|--------------|
| Anthropic API docs | https://docs.anthropic.com |
| TS SDK | `@anthropic-ai/sdk` — https://github.com/anthropics/anthropic-sdk-typescript |
| Structured output (tool use / JSON) | https://docs.anthropic.com/en/docs/build-with-claude/tool-use |
| Model id (default for tip agent) | `claude-opus-4-8` (set `TIP_AGENT_MODEL`) |

The agent must emit a **structured regime-conditioned policy object** (regime → {tip rule,
escalation profile, hold flag}) with logged rationale — never a bare scalar. Off the hot path.

---

## 7. Quick map: component → resources
- **C1** Stream Ingestor → §1 Yellowstone
- **C2** Leader Window → §3 Solana (`getLeaderSchedule`/`getNextScheduledLeader`) + §2 Jito validator set
- **C3** Tip-Floor + Baseline → §2 Jito tip_floor REST/WS
- **C4** Bundle Constructor → §3 `getLatestBlockhash(confirmed)`/`isBlockhashValid` + §2 `getTipAccounts` + `@solana/web3.js`
- **C5** Submitter → §2 regional `sendBundle`
- **C6** Lifecycle Tracker → §1 stream + §2 `getBundleStatuses` + §2 explorer / §3 Solscan
- **C7** Failure Classifier → §2 status error fields + §3 blockhash validity
- **C8/C9** Tip Intelligence / Retry → §6 Anthropic
- **C12** Evidence → §2 explorer.jito.wtf + §3 Solscan
- **Deploy** → §4 Railway
