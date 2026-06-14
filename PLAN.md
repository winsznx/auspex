# PLAN.md — Auspex living plan & gate ledger

> Single human-readable progress ledger. `gstack` is the machine ledger; this mirrors it for
> humans. **The dev agent owns this file** — update the gate status every time one flips.
> The plan itself is produced/refined by the dynamic workflow (see [CLAUDE.md §3](./CLAUDE.md)).

**Builder:** winsznx · **Deadline:** 2026-06-29 · **Winners:** 2026-07-13
**Deploy:** Railway (single TS service) · **Network:** Solana mainnet only
**Source of truth:** [PRD.md](./PRD.md) · **How to build:** [CLAUDE.md](./CLAUDE.md)

## Legend
`[ ]` not started · `[~]` in progress · `[x]` gate green · `[!]` blocked

## Standard component gate (every C-unit, non-negotiable — CLAUDE.md §1.7)
**(a)** `tsc --noEmit` clean · **(b)** runs against the real mainnet endpoint with real output ·
**(c)** no mocks, no demo data. Do not start C(n+1) until C(n) is green. Write-through to the
memory layer the moment a fact is verified or a gate flips.

---

## ⚠️ Environment blockers found during Step-1 read (surface before Step 3)
These do not block writing the plan or the Day-0 gate, but they block the prescribed §3 workflow
and must be resolved with the user.

- **B1 — `.claude/agents/` is missing.** CLAUDE.md §3 + KICKOFF reference six bespoke agents
  (research / architecture / implementation / verification / doubting / synthesis). The directory
  does not exist. → Either author the six agent definitions, or map the workflow onto the
  general Task agents available in this harness (`general-purpose`, `Explore`, `Plan`,
  `feature-dev:code-*`, `open-source-librarian`). **Decision required before C2.**
- **B2 — gbrain is down.** `gbrain` CLI v0.18.2 fails: macOS WASM/PGLite bug
  (github.com/garrytan/gbrain/issues/223) + the configured remote DB is unreachable. The mandated
  durable-knowledge layer (CLAUDE.md §2) cannot be written/recalled via gbrain right now.
  → **Fallback in use:** the harness file-memory at
  `~/.claude/projects/-Users-macbook-Desktop-opensource-Auspex/memory/` + the `sharedcontext`
  MCP. Migrate to gbrain once the WASM bug or DB connection is fixed.
- **B3 — no `gstack` task-stack CLI.** Only the gstack *skill package* (browser/QA) is installed;
  the task-stack tool from CLAUDE.md §2 is absent. → Working state tracked via harness Tasks/Todos
  + this file as the human ledger.
- **B4 — `.env.example` is missing** but `docs/DAY0-GATE.md` and `scripts/verify-day0.ts` reference
  `cp .env.example .env`. → Create `.env.example` from the required vars (see Day-0 below) as the
  first Step-2 action.
- **B5 — two PRD files** (`PRD.md` canonical + `AUSPEX-PRD.md`). PRD.md is the source of truth per
  CLAUDE.md; reconcile/delete the duplicate later so judges see one spec.

---

## Phase 0 — Foundation
- [x] Repo scaffolded (package.json, tsconfig, railway.json, src layout)
- [x] CLAUDE.md constitution + RESOURCES.md (verified third-party links)
- [x] Dev agent writes the **full plan** into this file (this document) — *Step 1 done*
- [ ] **`.claude/agents/` resolved** (B1) — author agents or map to harness agents
- [ ] **`.env.example` created** (B4) from required vars
- [ ] **Day-0 gate ALL GREEN** — `npm run verify:day0` (see docs/DAY0-GATE.md)

### Day-0 gate (build-sequence prompt 0) — external deps, each must go GREEN
Required env (from `scripts/verify-day0.ts` + DAY0-GATE):
`YELLOWSTONE_GRPC_ENDPOINT`, `YELLOWSTONE_X_TOKEN`, `SOLANA_RPC_URL`, `JITO_BLOCK_ENGINE_URL`,
`HOT_WALLET_SECRET_KEY` (base58). Optional: `JITO_TIP_FLOOR_URL`, `TIP_AGENT_MODEL`, `ANTHROPIC_API_KEY`.

| # | Check | Gate criterion | Blocked on |
|---|-------|----------------|------------|
| D1 | Yellowstone gRPC endpoint + x-token | live slot-stream probe shows advancing watermarks | **USER** (SolInfra credits via t.me/superteamng) |
| D2 | Mainnet JSON-RPC | `getHealth=ok` + `getLatestBlockhash(confirmed)` returns a hash | **USER** (RPC URL) |
| D3 | Funded hot wallet | decode secret → `getBalance ≥ ~0.05 SOL` | **USER** (fund ~0.1 SOL) |
| D4 | Regional block engine | live `getTipAccounts` returns ≥1 account | self (public) |
| D5 | Tip-floor endpoint | live fetch returns p50/p75/p95 | self (public, no auth) |
| D6 | Jito leader-window source | confirm `getNextScheduledLeader` exposed; else fallback to `getLeaderSchedule` + Jito validator set — **record decision** | research-agent (C2 dep) |

> `verify:day0` today checks D2/D4/D5 + env-presence. **Two TODOs to add (research+impl agents):**
> a live Yellowstone v5 slot probe (D1) and a wallet-balance decode/`getBalance` (D3). These two
> additions are the only Phase-0 code work before the gate can be honestly ALL GREEN.

---

## Phase 1 — Data plane (hot, deterministic, never awaits the LLM)

### C1 — Stream Ingestor ✅ already built, type-checked vs `@triton-one/yellowstone-grpc@5.0.9`
- **Deps:** D1 (Yellowstone endpoint+token).
- **Action:** drop the verified module into `src/data-plane/stream-ingestor.ts`.
- **Gate:** streams live mainnet slots with advancing **processed → confirmed → finalized**
  watermarks; emits `slot`/`health`/`lag` events; `getState()` works.
- **Verified facts relied on (PRD §4.1):** v5 API; `new Client(endpoint, xToken, channelOptions?, reconnectOptions?)`;
  `subscribe()` → Node `Duplex`, teardown **`.destroy()`** (not `.cancel()`); **uint64 (`slot`,`parent`)
  arrive as strings → `Number()`**; built-in reconnect `slotRetention: 150`; `SubscribeRequest` needs
  all filter maps + `accountsDataSlice: []`; slots filter `{ filterByCommitment: false }` emits every
  status transition; `SlotStatus` enum `Processed=0,Confirmed=1,Finalized=2,FirstShredReceived=3,Completed=4,CreatedBank=5,Dead=6`.
- **Open Q (research-agent):** does the dropped-in module already match this src path's `shared/events.ts`
  + `shared/types.ts` contract, or does it need an adapter?

### C2 — Leader Window Tracker
- **Deps:** C1 state · D6 (leader-window source decision).
- **Output:** "Jito leader in N slots" window events + leader-skip detection.
- **Gate:** logs real upcoming **Jito-leader** windows that match the live chain; correctly flags a
  real skip.
- **Verified facts (PRD §4.2):** bundles execute **only** while a **Jito-Solana** leader produces;
  leaders hold **4 consecutive slots** (a single skipped slot within a produced window can still land —
  full drop = whole window missed, PRD §5 Q3); standard validators don't process bundles.
- **Open Qs (research-agent, BLOCKING for D6):**
  (1) Is `getNextScheduledLeader` exposed by the chosen RPC or only the Jito block-engine API?
  (2) How do we obtain the **Jito validator set** to intersect with `getLeaderSchedule` (fallback path)?
  (3) Leader schedule is per-epoch (pubkey → slot indices) — confirm exact shape + epoch-boundary handling.

### C3 — Tip-Floor Client + Baseline Policy
- **Deps:** D5 (tip-floor endpoint).
- **Output:** cached live percentiles; **`baseline = max(p75_tip, floor)`** (PRD §1, §9.3).
- **Gate:** prints live percentiles; baseline recomputes on each update.
- **Verified facts (PRD §4.2):** REST `https://bundles.jito.wtf/api/v1/bundles/tip_floor` →
  `landed_tips_25th/50th/75th/95th_percentile` + EMA; WS `wss://bundles.jito.wtf/api/v1/bundles/tip_stream`;
  **min tip 1000 lamports**.
- **Open Qs (research-agent):** exact JSON shape (array vs object — verify-day0 handles both) and
  units (SOL vs lamports) of each percentile field; what is `floor` in `max(p75, floor)` — a config
  constant (≥1000 lamports) or an endpoint-derived value? Decide + record.

### C4 — Bundle Constructor
- **Deps:** D2 (RPC for blockhash) · D4 (tip accounts) · C3 (current tip policy) · `@solana/web3.js`.
- **Output:** a signed, valid bundle — `confirmed` blockhash + memo self-transfer tagged
  `run_id`/`strategy` + **tip transfer LAST**, **no ALT**.
- **Gate:** constructs a bundle that `isBlockhashValid(confirmed)` confirms and that **simulates clean**.
- **Verified facts (PRD §4.2, §4.3):** tip is a SOL transfer to a `getTipAccounts` address, **must be
  the last instruction**, **no Address Lookup Tables** on the tip tx; bundle ≤5 tx, atomic, single-slot;
  fetch blockhash at **`confirmed`** (processed → ~5% dropped-fork; finalized → lags ≥32 slots/~13s);
  blockhash valid **~150 slots (~60–90s)**.
- **Open Qs (research-agent):** memo program id + how to embed `run_id`/`strategy`; bundle wire format
  expected by `sendBundle` (base58 vs base64 array of signed txs); tip min applied from C3.

### C5 — Submitter
- **Deps:** C4 · D4 (regional block engine).
- **Output:** `bundle_id` from a regional `sendBundle`.
- **Gate:** a real `bundle_id` appears on `https://explorer.jito.wtf/bundle/<id>`.
- **Verified facts (PRD §4.2):** `POST https://<region>.mainnet.block-engine.jito.wtf/api/v1/bundles`;
  **rate limit 1 req/s/IP/region (429 on exceed)**; multi-region parallel submit raises landing odds.
- **Open Qs (research-agent):** chosen region by **measured latency from the Railway region** (record);
  exact `sendBundle` params/encoding; whether `x-jito-auth` UUID is needed for our cadence.

### C6 — Lifecycle Tracker
- **Deps:** C1 stream (primary) · C5 (`bundle_id`) · D2 (`getBundleStatuses` backup).
- **Output:** `LifecycleRecord`: submitted→processed→confirmed→finalized + slots + ts + latency deltas.
- **Gate:** a landed bundle shows the **full timeline with real slot numbers** (cross-checkable on
  explorer.jito.wtf + Solscan).
- **Verified facts (PRD §4.2):** `getBundleStatuses`/`getInflightBundleStatuses` return slot +
  commitment + retryable/non-retryable error; **≤5 bundle ids per call**.
- **Open Qs (research-agent):** map gRPC tx-status stream to a bundle's landing slot; reconcile
  stream-first vs status-poll backup without double-counting.

### C7 — Failure Classifier
- **Deps:** C6 + C2 (skip signal) + C4 (blockhash validity).
- **Output:** label every non-landing outcome →
  `{blockhash_expired, leader_skipped, sim_failed, dropped_low_tip, ...}`.
- **Gate:** correctly labels a **real** drop.
- **Verified facts:** PRD §4.2 status error fields + §4.3 blockhash validity + §5 Q3 leader-skip
  semantics.
- **Open Qs (research-agent):** the exhaustive error taxonomy from Jito status error strings; how to
  distinguish `dropped_low_tip` from a generic auction loss.

---

## Phase 2 — Control plane (warm, async AI — off the hot path)

### C8 — Tip Intelligence (the owned AI decision)
- **Deps:** C1/C6/C7 events · C3 percentiles · C10 landing-rate split · Anthropic SDK.
- **Output:** a **structured regime-conditioned `TipPolicy`** object (`regime → { tip rule,
  escalation profile, hold flag }`) + a **per-update reasoning log**. NOT a scalar multiplier.
  Data plane applies the *current cached* policy instantly; **hot path never awaits the LLM**.
- **Gate:** policy changes with **logged rationale** as live conditions shift.
- **Structured telemetry inputs (PRD §2):** (1) processed→confirmed delta over last N slots,
  (2) recent tip variance + current floor percentiles, (3) leader-skip flag, (4) our landing rate
  split by `ai`/`baseline`, (5) slots-to-next-Jito-window.
- **Verified facts (RESOURCES §6):** `@anthropic-ai/sdk`; default model `claude-opus-4-8`
  (`TIP_AGENT_MODEL`); structured output via tool-use. **NOTE: `@anthropic-ai/sdk` is NOT yet in
  package.json** — add as a dep during C8 architecture.
- **Open Qs (research+architecture agents, consequential — full §3 loop):** exact `TipPolicy` schema;
  regime taxonomy + shift-detection trigger; tool-use JSON schema for structured output; cost/latency
  budget; how the cached policy is shared between planes (`shared/policy.ts`).

### C9 — Failure-Reasoning Retry
- **Deps:** C7 failure event · C8 agent · C4/C5.
- **Output:** **synchronous** agent diagnose → remedy → resubmit on failure (latency is free — the
  window is already missed, PRD §2).
- **Gate:** a **forced** failure produces a reasoned, successful resubmit.
- **Verified facts:** PRD §2 recovery path; §5 Q3 (refresh blockhash, target next Jito window).
- **Open Qs:** remedy action space (refresh blockhash / re-target window / adjust tip); guardrails so a
  retry loop can't burn SOL.

---

## Phase 3 — Proof

### C10 — A/B Harness (the differentiator)
- **Deps:** C4–C7 (tagged runs) · C3 baseline · C8 ai policy.
- **Output:** alternate `ai` vs `baseline = max(p75, floor)` under **matched conditions**; publish a
  landing-rate / latency / cost table with the measured delta.
- **Gate:** a real run produces the comparison table.
- **Open Qs (architecture-agent):** how to guarantee "matched conditions" (interleave per leader
  window? alternate per bundle?); statistical honesty of the delta with small N.

### C11 — Fault Injector
- **Deps:** C4/C5/C7.
- **Output:** deterministic **blockhash-expiry** on command (`npm run fault:blockhash`).
- **Gate:** produces a guaranteed, **classified** failure on demand (feeds the ≥2-failures requirement).
- **Verified facts:** blockhash validity window (PRD §4.3) is what we deliberately blow.

### C12 — Evidence Run
- **Deps:** all of C1–C11.
- **Output:** a full mainnet run producing **≥10 bundles incl. ≥2 failures** (1 forced blockhash-expiry
  + ≥1 natural drop/leader-skip); persist `evidence/run-*.json` + human-readable log.
- **Gate:** **every record cross-checks on-chain** (explorer.jito.wtf + Solscan). Judges will check.

---

## Phase 4 — Deliverables
- [ ] **Architecture doc** — two-plane design + AI-decoupling rationale + failure loop, **A/B result up front**.
- [ ] **README** — Q1/Q2/Q3 (PRD §5) backed by our telemetry + A/B comparison + exact run instructions.
- [ ] **Railway deploy** — runnable end-to-end on mainnet (`railway.json` build/start pinned).
- [ ] **Short demo** — fault injector triggering the failure-reasoning loop live.
- [ ] **Submit** to Superteam Nigeria (deadline 2026-06-29).

---

## Dynamic workflow per component (CLAUDE.md §3) — applied C2→C12
research → architecture → (doubting + synthesis on consequential units) → implementation →
verification → doubting → synthesis. A unit is **not done** until the doubting-agent cannot raise a
stronger objection. Consequential units (touch money/keys/external service/public interface/new dep):
**C2, C4, C5, C8, C9, C10** run the full loop. Trivial/reversible units may collapse it — and must say so.

---

## Gate log (append-only — date · component · result · evidence pointer)
- 2026-06-13 · Phase 0 scaffold · GREEN · repo created
- 2026-06-13 · Step 1 plan · GREEN · this PLAN.md expanded from PRD §4/§6/§8/§9
- 2026-06-14 · B1 agents authored · GREEN · 6 agents in `.claude/agents/`
- 2026-06-14 · B4 `.env.example` created · GREEN · required + optional vars documented
- 2026-06-14 · verify-day0 extended · GREEN · Yellowstone v5 slot probe + wallet getBalance added, tsc clean
- 2026-06-14 · Day-0 partial run · 2/11 (D4 getTipAccounts=8, D5 tip_floor=live) · rest blocked on user creds
- _next: user supplies D1/D2/D3 creds → fill .env → `npm run verify:day0` ALL GREEN → C1 drop-in_

## Open risks / decisions of record (mirror to memory layer)
- **DoR-RESOLVED:** TS runner = Node native strip-types (`--experimental-strip-types`), tsx removed — tsx breaks yellowstone-grpc named exports. engines.node≥22.6. **Constraint:** our code avoids TS `enum`/`namespace`/param-properties (use unions / `as const`). See memory `runner-decision`.
- **DoR-RESOLVED:** tip_floor percentiles are **SOL** (×1e9 → lamports for C3 baseline); endpoint returns an array, take `[0]`. See memory `verified-facts`.
- **DoR-pending:** D6 leader-window source (`getNextScheduledLeader` vs `getLeaderSchedule`+Jito set).
- **DoR-pending:** C3 `floor` constant value (≥1000 lamports min).
- **DoR-pending:** C5 block-engine region by measured latency from Railway region.
- **DoR-pending:** C8 `TipPolicy` schema + regime taxonomy + add `@anthropic-ai/sdk` dep.
- **Memory layer degraded (B2/B3):** gbrain down → using harness file-memory + sharedcontext until fixed.
- **B5 pending:** reconcile/delete duplicate `AUSPEX-PRD.md` (PRD.md is canonical).
- **npm audit:** 3 moderate (transitive, pre-existing) — not addressed; revisit before deploy.
