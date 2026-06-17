# Auspex

**A Solana smart-transaction stack whose AI control plane reads live network telemetry — slot
confirmation deltas, the Jito tip-floor, and our own landing rate — to decide the tip and timing
for every Jito bundle, and *proves* that decision beats a hardcoded baseline with
on-chain-verifiable evidence.**

> Superteam Nigeria — *Advanced Infrastructure Challenge: Build a Smart Transaction Stack.*
> One Railway TypeScript service · two logical planes · Solana **mainnet** only · no mocks, ever.

---

## ▶ The result (lead with the proof)

> _Filled from a real mainnet run (the A/B harness + evidence logger). Every number cross-checks on
> `explorer.jito.wtf` and Solscan — no mocks, no demo data. Pending the funded evidence run._

| Strategy | Bundles | Landing rate | Median latency (submit→confirmed) | Avg tip (SOL) | Cost per land |
|----------|--------:|-------------:|----------------------------------:|--------------:|--------------:|
| `ai`     | _pending_ | _pending_  | _pending_                         | _pending_     | _pending_     |
| `baseline = max(p75, floor)` | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

**Measured delta:** _pending the evidence run._ The AI tip policy is compared against the hardcoded
baseline under **matched** network conditions. Evidence will land in [`evidence/`](./evidence/).

---

## What it does

- **Data plane (hot, deterministic):** a slot/commitment stream (Yellowstone gRPC, or any compatible
  Geyser/RPC-WebSocket source) → Jito leader-window detection → bundle construction → submission →
  lifecycle tracking → failure classification. It applies the **current cached tip policy**
  instantly and **never waits on the LLM**.
- **Control plane (warm, async AI):** on regime shifts it reasons over structured telemetry and
  writes a **structured, regime-conditioned tip policy** (`regime → { tip rule, escalation, hold }`)
  with logged rationale — not a scalar. It also owns the synchronous failure-reasoning retry on the
  recovery path, where latency is free.
- **A/B harness:** alternates `ai` vs `baseline = max(p75_tip, floor)` under matched conditions and
  publishes the measured delta. This is the differentiator.
- **Fault injector:** forces a blockhash-expiry on command to exercise the agentic failure loop live.

The single AI-owned decision is **the tip** (hold-vs-submit is a facet of it). The two planes are a
**logical** split inside one process — cleanly splittable, but kept as one service on purpose.
See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the design and rationale.

---

## Build status

Each component is verified **live against mainnet** before the next begins — `tsc --noEmit` clean,
real output, no mocks. Components past C4 move real SOL and are gated on a funded hot wallet.

| # | Component | Status | Gate |
|---|-----------|--------|------|
| C1 | Stream Ingestor (slot/commitment) | 🟢 **live** | `verify:c1` — advancing processed/confirmed/finalized watermarks |
| C2 | Leader Window Tracker | 🟢 **live** | `verify:c2` — Jito windows + 100% leader decode vs `getSlotLeaders` |
| C3 | Tip-Floor Client + Baseline | 🟢 **live** | `verify:c3` — live percentiles, `baseline = max(p75, floor)` |
| C4 | Bundle Constructor | 🟢 **live (construct)** | `verify:c4` — signed base58 bundle, tip-last, blockhash-live |
| C5 | Submitter | ⏳ needs funded wallet | regional block-engine `sendBundle` → `bundle_id` |
| C6 | Lifecycle Tracker | ⏳ | submitted→processed→confirmed→finalized + latency deltas |
| C7 | Failure Classifier | ⏳ | label every non-landing outcome |
| C8 | Tip Intelligence (control plane) | ⏳ | telemetry → regime → structured policy + reasoning log |
| C9 | Failure-Reasoning Retry | ⏳ | sync agent diagnose→remedy→resubmit |
| C10 | A/B Harness | ⏳ | alternate `ai`/`baseline`, publish deltas |
| C11 | Fault Injector | ⏳ | force blockhash-expiry on command |
| C12 | Evidence Logger | ⏳ | persist explorer-checkable lifecycle log |

The data-plane foundation (C1–C4) runs today on free public infrastructure, 0 SOL spent. The
submission/evidence path (C5–C12) is implemented once the hot wallet is funded — a 0-balance wallet
fails simulation, and the win condition is *real* on-chain bundles, which cannot be mocked.

---

## The three graded questions

Backed by our own telemetry from the run; the full reasoning is locked.

- **Q1 — What does the `processed_at`→`confirmed_at` delta tell you about network health?**
  It's the time the block took to gather a supermajority (≥66% stake) of optimistic-confirmation
  votes under Tower BFT. `processed` = our node executed it and mutated bank state; `confirmed` = a
  supermajority has voted, so it is very unlikely to be on a dropped fork. A spiking delta means
  consensus/vote-propagation is lagging execution — vote-propagation delay, banking-thread
  congestion, elevated fork rates, or write-lock contention on hot accounts. _(Backed by a histogram
  of our own per-slot deltas.)_

- **Q2 — Why never use `finalized` commitment for a time-sensitive blockhash?**
  A blockhash lives ~150 slots (~60–90s). `finalized` lags `confirmed` by ≥32 slots (~13s), so a
  finalized blockhash is already ~13s into its lifespan before you sign — a fifth of the window gone
  for nothing, sharply raising expiry-before-landing risk under congestion. Use **`confirmed`**: only
  a few slots behind `processed`, with negligible dropped-fork risk.

- **Q3 — What happens to your bundle if the Jito leader skips their slot?**
  The bundle is tied to that Jito-Solana leader's block production within a single slot — it can't
  roll into a non-Jito leader's block (standard validators don't process bundles) and can't cross
  slot boundaries. If the leader skips, the bundle drops; since nothing executed, **no SOL is lost**
  (the tip pays only on landing). You resubmit to the next Jito leader with a fresh `confirmed`
  blockhash. Nuance: leaders hold **4 consecutive slots**, so a single skipped slot within a produced
  window can still land — a full drop is when the leader misses their whole window.

---

## Run it

Requires Node ≥ 22.6 (the repo runs TypeScript directly via Node's native type-stripping — no build
step for local runs).

```bash
npm install
cp .env.example .env      # fill REAL mainnet values (see .env.example for each)
```

**What runs today** (free public infra, 0 SOL, no funded wallet needed):

```bash
npm run dev               # boot the live data plane — C1–C4 on one process,
                          # streaming real mainnet telemetry (no submit). Ctrl-C to stop.

npm run verify:c1         # slot/commitment stream — watermarks advance
npm run verify:c2         # Jito leader windows + leader decode cross-check
npm run verify:c3         # live tip-floor percentiles + baseline = max(p75, floor)
npm run verify:c4         # construct + sign + validate a real base58 Jito bundle (no submit)
npm run verify:day0       # external-dependency gate (Yellowstone + wallet checks)
npm run typecheck         # tsc --noEmit
```

`npm run dev` selects the Yellowstone gRPC source when configured and otherwise falls back to the
free RPC-WebSocket source, so it runs on the public endpoint with no credentials.

**The end-to-end run** (evidence + A/B + fault loop) needs a funded hot wallet and is wired as
C5–C12 land:

```bash
npm run run:evidence      # ≥10 bundles, ≥2 failures — explorer-checkable lifecycle log
npm run run:ab            # alternated ai vs baseline, publishes the delta
npm run fault:blockhash   # trigger the failure-reasoning loop on demand
```

**Deploy:** Railway single service — config in [`railway.json`](./railway.json), secrets in Railway
service variables (never commit `.env`).

---

## How this repo is built

Auspex is built by Claude Code under a **dynamic, multi-agent workflow** — research → architecture →
implementation → verification → **doubting** → synthesis — governed by [CLAUDE.md](./CLAUDE.md). A
unit is not "done" until the skeptic gate can't raise a stronger objection. Permanent rules: **no
mocks, no demo data, no hardcoding, no guessing; one process / two planes; one owned AI decision (the
tip); mainnet only.**
