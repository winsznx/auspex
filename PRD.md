# Auspex — Canonical PRD

> **One line:** A Solana smart-transaction stack whose AI control plane reads live network telemetry — slot-confirmation deltas, Jito tip-floor, and our own landing rate — to decide the tip and the timing for every Jito bundle, and **proves** that decision beats the hardcoded baseline everyone else ships, with on-chain-verifiable evidence.

- **Builder:** winsznx (solo), Claude Code as executor
- **Domain (suggested):** `tryauspex.xyz`
- **Target:** Superteam Nigeria — *Advanced Infrastructure Challenge: Build a Smart Transaction Stack*
- **Prize:** $5,000 USDG ($2,500 / $1,500 / $1,000), Nigeria-only
- **Deadline:** June 29 2026 · Winners announced July 13
- **Network:** Solana **mainnet** (Jito bundles do not exist on devnet; mainnet is the only verifiable surface)
- **Language:** TypeScript, whole stack
- **Deploy:** Railway (single service)

---

## 0. Why this wins (read before building anything)

This is a **depth + credibility** bounty, not a clever-idea bounty. Judging is: *Does It Work · Depth of Integration · AI Demonstration · Explanation.* Every serious entrant will stream slots, build a bundle, and hardcode-ish a tip. The win is not "build the stack" — it's **instrument the stack and prove the AI tip decision outperforms the dumb baseline**, plus a dominant architecture doc and README answers backed by our own telemetry.

**The differentiator no one else ships: an A/B harness.** We tag every bundle `ai` or `baseline`, alternate them under matched network conditions, and publish landing-rate / latency / cost side by side. That single artifact converts "we have an AI" (a claim every entry makes) into "here is the measured delta" (a claim almost none can make).

### Loss-pattern guardrails (these are hard rules, not suggestions)
- **ONE owned AI decision: the tip.** "Hold vs submit" is folded in as a *facet* of the tip decision (sometimes the right answer is "don't pay right now"). Do **not** let scope drift into multiple owned decisions.
- **No over-engineering.** No microservices, no memory-mapped queues, no vector DB. One Railway service, two logical planes, in-process event stream + shared policy object. The architecture *doc* shows the planes are splittable; the *build* stays one process.
- **Lead with the proof, not the protocol.** The README and architecture doc open with the measured A/B result, not with our cleverness.
- **No mocks, no demo data, ever.** Every number in every deliverable comes from a real mainnet run and is cross-checkable on an explorer.

---

## 1. Scope

### In scope
Two logical planes in one Railway TypeScript service, plus an A/B harness and a fault injector:

- **Data plane (hot, deterministic, never waits on the LLM):** Yellowstone gRPC ingest → slot/leader/commitment state → leader-window detection → bundle constructor → submitter → lifecycle tracker → failure classifier. Applies the *current cached tip policy* instantly.
- **Control plane (warm, async AI):** observes the data plane's event stream + tip-floor + our landing rate → on regime shifts, reasons over structured telemetry and writes a **structured, regime-conditioned tip policy** (not a scalar) with logged rationale. Also owns the **synchronous failure-reasoning retry** on the recovery path (latency is free there — the window is already missed).
- **A/B harness:** `ai` vs `baseline = max(p75_tip, floor)`, alternated, published.
- **Fault injector:** deterministically forces a blockhash-expiry to demonstrate the failure loop on command.

### Explicitly OUT of scope
- Any second "owned" AI decision (routing, sizing, MEV strategy). Tip only.
- Microservice split / message broker / mmap channels / vector store.
- Trading strategy, real value transfer beyond tiny self-transfers, token launches.
- Devnet anything (Jito has no devnet).

---

## 2. The AI decision (the heart of the entry)

**Owned decision:** what tip to attach to each bundle (and whether to submit now or hold).

**Why decoupled (not a synchronous LLM-in-the-hot-path):** slots are ~400ms; LLM inference is 0.5–2s+. A per-bundle synchronous call would blow blockhash windows and miss leader slots, and reads to judges as a naive "AI wrapper." It would also violate the bounty's explicit *"clean separation between AI layer and core transaction stack."* So the AI runs out-of-band.

**Why it still genuinely owns the decision (not a heuristic with an AI-tuned knob):** the control plane does **not** emit a scalar multiplier. It emits a **structured regime-conditioned policy** — `regime → { tip rule, escalation profile, hold flag }` — re-derived with **logged reasoning on every regime shift / failure event**. Over a run you get many logged AI decisions, and the realized tip visibly tracks the agent's reasoning as conditions change. The data plane applies the *current* policy deterministically and fast.

**Structured telemetry passed to the agent (Gemini's good idea, kept):**
1. processed→confirmed delta over the last N slots
2. recent tip variance + current tip-floor percentiles
3. leader-skip flag (did the targeted Jito leader produce?)
4. our recent landing rate, split by strategy (`ai` vs `baseline`)
5. distance (in slots) to the next Jito leader window

**Reasoning sketch the agent should produce (illustrative, not hardcoded):**
- *processed→confirmed delta spiking, tips steady* → consensus / vote-propagation lag, not an auction problem → **hold** or hold tip flat; don't overpay into congestion.
- *bundles dropping, tip-floor rising, leaders producing* → we're losing the auction → **escalate** tip toward p95 with a bounded multiplier.
- *bundle failed on a skipped slot* → infra wasn't at fault → refresh blockhash, keep tip steady, target the next Jito window.

**Failure handling (separately required by the bounty) is also agentic, on the recovery path:** when a bundle fails, the same brain diagnoses → decides remedy → resubmits. This is synchronous because the window is already gone, so latency is free.

---

## 3. Architecture (data flow)

```
                 Yellowstone gRPC (mainnet)
                          │  slot status: processed→confirmed→finalized
                          ▼
   ┌──────────────────────── DATA PLANE (hot, deterministic) ────────────────────────┐
   │  C1 Stream Ingestor ──▶ slot/commitment state + health (F6 gate)                  │
   │           │                                                                       │
   │           ▼                                                                       │
   │  C2 Leader Window Tracker ──▶ "Jito leader in N slots"                            │
   │           │                                                                       │
   │           ▼                                                                       │
   │  C4 Bundle Constructor  ◀── current cached tip policy (applied instantly)         │
   │     (confirmed blockhash + memo self-transfer + tip LAST)                         │
   │           │                                                                       │
   │           ▼                                                                       │
   │  C5 Submitter (regional block-engine) ──▶ bundle_id                               │
   │           │                                                                       │
   │           ▼                                                                       │
   │  C6 Lifecycle Tracker (stream-first, getBundleStatuses backup)                    │
   │     submitted→processed→confirmed→finalized + slots + ts + latency deltas         │
   │           │                                                                       │
   │           ▼                                                                       │
   │  C7 Failure Classifier ──▶ {blockhash_expired, leader_skipped, sim_failed, ...}   │
   └───────────┬───────────────────────────────────────────────────────────────────┬─┘
               │ metric + failure events (in-process)                                │ applies
               ▼                                                                     │ policy
   ┌──────────────────── CONTROL PLANE (warm, async AI) ─────────────────────┐       │
   │  C8 Tip Intelligence: telemetry → regime → STRUCTURED tip policy +       │───────┘
   │      logged rationale.  Owns sync failure-reasoning retry (C9).          │
   └──────────────────────────────────────────────────────────────────────────┘

   C10 A/B Harness: tags bundles ai|baseline, alternates, publishes deltas.
   C11 Fault Injector: forces blockhash-expiry to exercise the failure loop.
   C12 Evidence Logger: persists the ≥10-bundle lifecycle log (≥2 failures), explorer-checkable.
```

---

## 4. Verified technical facts (the builder must not re-derive these)

> All of the following were verified against live docs / the installed package during design. Bake them in; do not trust online tutorials, which are stale.

### 4.1 Yellowstone gRPC client — **v5, not v4**
- Package: `@triton-one/yellowstone-grpc@^5.0.9` (latest). **The v5 API differs from every tutorial online (all v4).**
- Native N-API module; prebuilt binary loads on Linux x64 (Railway target) — verified.
- Constructor: `new Client(endpoint, xToken, channelOptions?, reconnectOptions?)`.
- **Built-in transparent reconnect** via `ReconnectOptions = { enabled?, backoff?: { initialIntervalMs?, multiplier?, maxRetries? }, slotRetention? }`. Enable it (`slotRetention: 150`) and do **not** hand-roll a reconnect loop — only a hard-silence backstop on top.
- `subscribe(request?: SubscribeRequest)` returns a Node **`Duplex`**. Teardown is **`.destroy()`** (NOT `.cancel()` — that was v4 grpc-js).
- `SubscribeRequest` requires all filter maps (`accounts/slots/transactions/transactionsStatus/blocks/blocksMeta/entry`) + `accountsDataSlice: []`; `commitment`, `ping`, `fromSlot` optional.
- Slots: `slots: { name: { filterByCommitment: false } }` → emits **every** status transition per slot (needed for the processed→confirmed delta).
- **uint64 fields arrive as strings** (`slot`, `parent`) — `Number()` them explicitly.
- `SlotStatus` enum: `Processed=0, Confirmed=1, Finalized=2, FirstShredReceived=3, Completed=4, CreatedBank=5, Dead=6`.
- Useful unary methods on the client for later components: `getLatestBlockhash(commitment)`, `isBlockhashValid(hash, commitment)`, `getSlot`, `getBlockHeight`, `ping`, `getVersion`, `subscribeReplayInfo`, `connect`.

### 4.2 Jito
- Bundles execute **only when a Jito-Solana leader is producing blocks**; standard validators do not process bundles.
- A bundle is ≤5 transactions, **atomic / all-or-nothing**, executes **within a single slot** (cannot cross slot boundaries), and is set to **expire after the next Jito-Solana leader**.
- Auction window ~200ms; block engine forwards to the validator currently producing the slot.
- Block-engine `sendBundle` endpoints are **regional** — e.g. `https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles` (also amsterdam / frankfurt / tokyo / mainnet). Submitting to multiple in parallel raises landing odds.
- **Tip:** a SOL transfer to one of the 8 `getTipAccounts`, **must be the last instruction** in the bundle, **no Address Lookup Tables** on the tip tx.
- **Tip floor (for the baseline + agent inputs):** REST `https://bundles.jito.wtf/api/v1/bundles/tip_floor` (returns `landed_tips_25th/50th/75th/95th_percentile` + EMA); WS stream `wss://bundles.jito.wtf/api/v1/bundles/tip_stream`.
- **Status:** `getBundleStatuses` / `getInflightBundleStatuses` return slot + commitment + retryable/non-retryable error — the lifecycle-tracker backup to the gRPC stream. (Max 5 bundle IDs per call.)
- **Rate limit:** default 1 request/second/IP/region; 429 on exceed. Minimum tip 1000 lamports.
- Bundle explorer for evidence: `https://explorer.jito.wtf/bundle/<bundle_id>`.

### 4.3 Solana commitment / blockhash (drives C4 + README)
- A recent blockhash is valid for **150 slots** (`MAX_PROCESSING_AGE`); effectively **151** (queue is 0-indexed); ≈ **60–90s** at 400–600ms slots.
- **Fetch blockhash at `confirmed`** — not `processed` (~5% of blocks land on dropped forks → blockhash never lands) and not `finalized` (lags confirmed by **≥32 slots / ~13s**, eating ~13s of the validity window).
- processed→confirmed delta = time for the block to gather supermajority (≥66% stake) optimistic-confirmation votes via Tower BFT.

---

## 5. README answers (graded against "specific correct answers" — lock these)

**Q1 — What does the delta between `processed_at` and `confirmed_at` tell you about network health?**
It is the time the block took to gather supermajority (≥66% stake) optimistic-confirmation votes across the cluster's fork-choice rule (Tower BFT). `processed` = our node executed it and mutated bank state; `confirmed` = a supermajority has voted, so it is very unlikely to be on a dropped fork. A spiking delta means consensus/vote-propagation is lagging behind execution — driven by vote-propagation delay, banking-thread congestion, elevated fork rates, or write-lock contention on hot accounts. Back the answer with a histogram of our own per-slot deltas from the run.

**Q2 — Why never use `finalized` commitment for a time-sensitive blockhash?**
A blockhash lives ~150 slots (~60–90s). `finalized` lags `confirmed` by ≥32 slots (~13s), so a finalized blockhash is already ~13s into its lifespan before you sign — you've thrown away a fifth of your window for nothing, sharply raising expiry-before-landing risk under congestion or aggressive retries. Use **`confirmed`**: it's only a few slots behind `processed` and (unlike `processed`) carries negligible dropped-fork risk.

**Q3 — What happens to your bundle if the Jito leader skips their slot?**
The bundle is tied to that Jito-Solana leader's block production and executes within a single slot — it cannot roll into a non-Jito leader's block (standard validators don't process bundles) and cannot cross slot boundaries. If the leader skips, the bundle is dropped; since nothing executed, **no SOL is lost** (the tip only pays on landing). You resubmit to the next Jito leader, re-signing with a fresh `confirmed` blockhash if the old one has aged. Nuance to include: leaders hold **4 consecutive slots**, so a single skipped slot within a produced window can still land — a full drop is when the leader misses their whole window.

---

## 6. Components (build units)

Each component is small, single-responsibility, and verified live before the next. Standard verification gate for every component: **(a)** `tsc --noEmit` clean; **(b)** runs against the real mainnet endpoint with real output; **(c)** no mocks.

| # | Component | Responsibility | Key inputs → outputs |
|---|-----------|----------------|----------------------|
| **C1** | **Stream Ingestor** ✅ *done, verified, type-checked vs v5.0.9* | Real-time slot + commitment state, health, backpressure, dedup | gRPC → `slot`/`health`/`lag` events + `getState()` |
| C2 | Leader Window Tracker | "Jito leader in N slots" + skip detection | leader schedule / `getNextScheduledLeader` + C1 state → window events |
| C3 | Tip-Floor Client + Baseline Policy | Live percentiles; `baseline = max(p75, floor)` | tip_floor REST/WS → cached percentiles + baseline tip |
| C4 | Bundle Constructor | Build a valid bundle, tip applied from current policy | `confirmed` blockhash + memo self-transfer + tip LAST → signed bundle |
| C5 | Submitter | Send to regional block-engine(s) | signed bundle → `bundle_id` |
| C6 | Lifecycle Tracker | submitted→processed→confirmed→finalized + slots + ts + latency deltas | C1 stream (primary) + `getBundleStatuses` (backup) → lifecycle record |
| C7 | Failure Classifier | Label every non-landing outcome | lifecycle + errors → `{blockhash_expired, leader_skipped, sim_failed, dropped_low_tip, ...}` |
| C8 | Tip Intelligence (control plane) | Telemetry → regime → **structured policy** + logged rationale | events + percentiles + landing rate → policy object + reasoning log |
| C9 | Failure-Reasoning Retry | Sync agent diagnose→remedy→resubmit on failure | failure event → new bundle params |
| C10 | A/B Harness | Alternate `ai`/`baseline`, publish deltas | tagged runs → landing-rate / latency / cost table |
| C11 | Fault Injector | Force blockhash-expiry on command | flag → guaranteed expiry path |
| C12 | Evidence Logger | Persist explorer-checkable lifecycle log | all records → `evidence/run-*.json` + human-readable log |

---

## 7. Deliverables for submission

1. **Working stack** deployed on Railway, runnable end-to-end on mainnet.
2. **Lifecycle log of ≥10 real bundles incl. ≥2 failures** — every bundle's slot numbers and bundle_id cross-checkable on `explorer.jito.wtf` and Solscan. (Judges *will* cross-check.) ≥2 failures come from the fault injector (blockhash-expiry) + at least one natural drop/leader-skip.
3. **Architecture doc** (separately judged — plays to our strength): the two-plane design, the AI-decoupling rationale, the failure loop, and **the A/B result up front**.
4. **README** answering Q1/Q2/Q3 (Section 5), backed by our own telemetry, plus the A/B comparison and exact run instructions.
5. **Short demo** showing the fault injector triggering the failure-reasoning loop live.

---

## 8. Day-0 gate (verify before Phase-1 build — UNVERIFIED until checked)

These are external dependencies; treat each as a checklist item that must go green:

- [ ] **Yellowstone gRPC endpoint + x-token** secured (claim SolInfra credits — up to $20k incl. Yellowstone gRPC — via `t.me/superteamng`). Verify: C1 streams live slots.
- [ ] **Mainnet RPC** (for `getLatestBlockhash`, `getNextScheduledLeader`/leader schedule, `getBundleStatuses`). Verify each call returns live data.
- [ ] **Mainnet hot wallet funded** (~0.1 SOL covers tips + fees across a full A/B run; tips are tiny, ~0.00001–0.001 SOL each). Verify balance on-chain.
- [ ] **Regional block-engine endpoint** reachable (`ny.mainnet.block-engine.jito.wtf`). Verify a no-op `getTipAccounts` call.
- [ ] **Tip-floor endpoint** reachable. Verify percentiles return.
- [ ] Confirm `getNextScheduledLeader` is exposed by the chosen RPC/Jito API (fallback: derive Jito-leader windows from `getLeaderSchedule` + the Jito validator set).

---

## 9. Build sequence (Claude Code prompts)

Run in order. Each prompt ends at its verification gate; do not advance past a red gate. No scope cuts.

0. **Repo + Day-0 verifier.** Scaffold the single TS service (Railway-ready). Write a `verify:day0` script that hits every Section-8 dependency live and prints pass/fail. **Gate:** all green.
1. **C1 Stream Ingestor.** Drop in the verified reference module (`src/data-plane/stream-ingestor.ts`). **Gate:** streams live slots with advancing processed/confirmed/finalized watermarks.
2. **C2 Leader Window Tracker.** Detect "Jito leader in N slots" + skip detection, reading C1 state. **Gate:** logs real upcoming Jito-leader windows vs live chain.
3. **C3 Tip-floor client + baseline policy.** Live percentiles; `baseline = max(p75, floor)`. **Gate:** prints live percentiles; baseline recomputes on update.
4. **C4 Bundle Constructor.** `confirmed` blockhash + memo self-transfer tagged `run_id`/`strategy` + tip LAST to a `getTipAccounts` address, no ALT. **Gate:** constructs a bundle that `isBlockhashValid` confirms and that simulates clean.
5. **C5 Submitter.** Regional block-engine submit; return `bundle_id`. **Gate:** a real bundle_id appears on `explorer.jito.wtf`.
6. **C6 Lifecycle Tracker.** Stream-first lifecycle with `getBundleStatuses` backup; record slots, timestamps, latency deltas. **Gate:** a landed bundle shows the full submitted→finalized timeline with real slot numbers.
7. **C7 Failure Classifier.** Map outcomes to labels. **Gate:** correctly labels a real drop.
8. **C8 Tip Intelligence.** Telemetry → regime → structured policy + per-update reasoning log. **Gate:** policy changes with reasoning as live conditions shift.
9. **C9 Failure-reasoning retry.** Sync diagnose→remedy→resubmit. **Gate:** a forced failure produces a reasoned, successful resubmit.
10. **C10 A/B harness.** Alternate `ai`/`baseline` under matched conditions; publish the comparison. **Gate:** a real run produces a landing-rate/latency/cost table.
11. **C11 Fault injector.** Deterministic blockhash-expiry. **Gate:** produces a guaranteed, classified failure on demand.
12. **C12 Evidence run.** Execute a full mainnet run producing ≥10 bundles incl. ≥2 failures; persist explorer-checkable evidence. **Gate:** every record cross-checks on-chain.
13. **Docs.** Architecture doc + README (Section 5 answers + A/B result + run instructions). **Gate:** A/B delta stated up front; every claim traceable to evidence.

---

## 10. Permanent rules (from the playbook)

- **No mocks, no demo data — ever.** Every figure traces to a real mainnet artifact.
- **Verify every claim block** against live data / an explorer before it goes in a deliverable.
- **No scope cuts, no deadline-anxiety framing.** Ship the full sequence.
- **Railway** is the deploy target for all compute.
- **Every bundle's slot number is cross-checked** on `explorer.jito.wtf` and Solscan before it enters the lifecycle log.
- Keep the build **one process, two logical planes** — the doc shows it's splittable; the code stays simple.

---

*Status: PRD locked. C1 (Stream Ingestor) already built, type-checked against `@triton-one/yellowstone-grpc@5.0.9`, native module load-verified on Linux x64. Ready for Day-0 gate + Claude Code execution from prompt 0.*
