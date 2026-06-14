# Auspex

**A Solana smart-transaction stack whose AI control plane reads live network telemetry — slot
confirmation deltas, Jito tip-floor, and our own landing rate — to decide the tip and the timing
for every Jito bundle, and *proves* that decision beats the hardcoded baseline, with
on-chain-verifiable evidence.**

> Superteam Nigeria — *Advanced Infrastructure Challenge: Build a Smart Transaction Stack.*
> One Railway TypeScript service · two logical planes · Solana **mainnet** only.

---

## ▶ The result (lead with the proof)

> _This section is filled from a real mainnet run (C10/C12). No mocks, no demo data — every
> number cross-checks on `explorer.jito.wtf` and Solscan._

| Strategy | Bundles | Landing rate | Median latency (submit→confirmed) | Avg tip (SOL) | Cost per land |
|----------|--------:|-------------:|----------------------------------:|--------------:|--------------:|
| `ai`     | _tbd_   | _tbd_        | _tbd_                             | _tbd_         | _tbd_         |
| `baseline = max(p75, floor)` | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |

**Measured delta:** _tbd_ — the AI tip policy [outperformed / matched] the hardcoded baseline
under matched network conditions. Evidence: [`evidence/`](./evidence/).

---

## What it does
- **Data plane (hot, deterministic):** Yellowstone gRPC slot/commitment stream → leader-window
  detection → Jito bundle construction → submission → lifecycle tracking → failure classification.
  Applies the **current cached tip policy** instantly; never waits on the LLM.
- **Control plane (warm, async AI):** on regime shifts, an agent reasons over structured telemetry
  and writes a **structured regime-conditioned tip policy** with logged rationale. Also owns the
  synchronous failure-reasoning retry on the recovery path.
- **A/B harness:** alternates `ai` vs `baseline` under matched conditions and publishes the delta.
- **Fault injector:** forces a blockhash-expiry on command to exercise the agentic failure loop.

See [PRD.md](./PRD.md) for the full spec and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the design.

---

## The three graded questions (answers locked in [PRD.md §5](./PRD.md))
- **Q1** — `processed_at`→`confirmed_at` delta = time to gather ≥66%-stake optimistic-confirmation
  votes (Tower BFT); a spike = consensus/vote-propagation lagging execution. _(Backed by our own
  per-slot delta histogram from the run.)_
- **Q2** — Never use `finalized` for a time-sensitive blockhash: it lags `confirmed` by ≥32 slots
  (~13s), throwing away ~⅕ of the ~150-slot validity window before you sign. Use `confirmed`.
- **Q3** — If the Jito leader skips, the bundle drops (single-slot, can't roll to a non-Jito
  block); **no SOL lost** (tip pays only on landing); resubmit to the next Jito leader with a
  fresh `confirmed` blockhash. Nuance: leaders hold 4 consecutive slots.

---

## Run it

```bash
npm install
cp .env.example .env      # fill REAL mainnet credentials (see docs/DAY0-GATE.md)
npm run verify:day0       # external-dependency gate — must be ALL GREEN
npm run dev               # local run
# evidence run (≥10 bundles, ≥2 failures):
npm run run:evidence
# A/B comparison:
npm run run:ab
# trigger the failure loop on demand:
npm run fault:blockhash
```

Deploy: Railway single service (`railway up`); config in [`railway.json`](./railway.json),
secrets in Railway service variables. Details in [docs/RESOURCES.md §4](./docs/RESOURCES.md).

---

## Build & contribution model
This repo is built by Claude Code under a **dynamic, multi-agent workflow** (research →
architecture → implementation → verification → doubting → synthesis), governed by
[CLAUDE.md](./CLAUDE.md). Permanent rules: **no mocks, no demo data, no hardcoding, no guessing;
one process / two planes; one owned AI decision (the tip); mainnet only.** Progress ledger:
[PLAN.md](./PLAN.md). To start the agent: [KICKOFF.md](./KICKOFF.md).

## Status
PRD locked. C1 (Stream Ingestor) built + type-checked vs `@triton-one/yellowstone-grpc@5.0.9`.
Next: Day-0 gate → C2…C12 → deploy → evidence → docs.
