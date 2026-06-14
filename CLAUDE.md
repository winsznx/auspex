# CLAUDE.md — Auspex execution constitution

This file governs how Claude Code builds Auspex. Read it fully before any action.
Source of truth for *what* to build: [PRD.md](./PRD.md). This file is *how* to build it.

---

## 0. What Auspex is (one paragraph)

A single Railway TypeScript service with two logical planes. The **data plane** (hot,
deterministic) ingests Yellowstone gRPC slot/commitment telemetry, tracks Jito leader
windows, builds + submits Jito bundles, and tracks their lifecycle — always applying the
**current cached tip policy** instantly. The **control plane** (warm, async AI) watches the
telemetry and, on regime shifts, reasons over structured inputs and writes a **structured,
regime-conditioned tip policy** with logged rationale. An **A/B harness** alternates `ai` vs
`baseline = max(p75_tip, floor)` under matched conditions and publishes the measured delta.
A **fault injector** forces a blockhash-expiry on command to exercise the agentic failure loop.
The win condition is **proof**: ≥10 real mainnet bundles (≥2 failures), every slot/bundle_id
cross-checkable on explorer.jito.wtf + Solscan, with the A/B result led up front.

---

## 1. Permanent rules (non-negotiable)

1. **No mocks, no demo data — EVER.** Every number in every deliverable traces to a real
   mainnet artifact. If you cannot produce it live, you do not write it down.
2. **No guessing. No hardcoding.** If a fact is unverified, verify it against live docs or a
   live endpoint before using it. Config comes from env, never literals in code.
3. **Verify every claim block** against live data / an explorer before it enters a deliverable.
4. **One process, two logical planes.** No microservices, no message broker, no mmap channels,
   no vector DB. The architecture *doc* shows the planes are splittable; the *code* stays one process.
5. **ONE owned AI decision: the tip** (hold-vs-submit is a facet of it). Do not add a second
   owned decision (routing, sizing, MEV).
6. **The control plane emits a structured regime-conditioned policy, not a scalar.** The hot
   path never blocks on the LLM.
7. **Component gate before advancing:** (a) `tsc --noEmit` clean; (b) runs against the real
   mainnet endpoint with real output; (c) no mocks. Do not start C(n+1) until C(n) is green.
8. **Mainnet only.** Jito has no devnet. Tiny self-transfers only; real funds, real evidence.
9. **No scope cuts, no deadline-anxiety framing.** Ship the full sequence in [PRD.md §9](./PRD.md).

---

## 2. Memory discipline (gstack + gbrain)

Memory is mandatory, not optional. Use the existing **`gstack`** and **`gbrain`** skills.

- **`gbrain` = durable knowledge.** Write to gbrain every *verified fact*, decision, and gate
  result: confirmed API shapes, endpoint behaviors, the chosen block-engine region + measured
  latency, policy-schema decisions, the rationale behind each architecture choice, and every
  resolved doubting-agent objection. Before researching anything, **recall from gbrain first** —
  do not re-derive what is already verified.
- **`gstack` = working state / task stack.** Push the current component, its gate criteria, and
  open sub-tasks. Pop when a gate goes green. This is how a fresh session resumes exactly where
  the last left off without re-reading the world.
- **Write-through rule:** the moment a fact is verified or a gate flips, persist it. Never hold a
  hard-won verified fact only in conversation context — it dies on compaction.
- **No hardcoding mirror:** anything you would be tempted to hardcode (an endpoint, a percentile,
  a tip account) is either (a) loaded from env/config, or (b) a verified fact recorded in gbrain
  with its source — never a bare literal in the code.

---

## 3. Dynamic workflow (how to approach any non-trivial unit)

**Do not operate as a single agent on consequential work.** For any task that touches
architecture, external dependencies, research, security, financial logic (tips = real SOL),
infrastructure, public interfaces, or new dependencies — run the workflow below using sub-agents
(the `Task` tool). The agent definitions live in [.claude/agents/](./.claude/agents/).

**Never begin coding immediately when:** integrating a new service · handling money (tips) ·
handling auth/keys · designing infrastructure · creating a public interface · adding a dependency.
→ **Research first. Challenge assumptions second. Design third. Implement fourth. Verify fifth.**

### The six roles (run in this order; collapse only for genuinely trivial units)
1. **research-agent** — read official docs, verify API capabilities + limits, collect real
   examples. Output: *verified facts only*, with citations, plus unanswered questions. Writes facts to gbrain.
2. **architecture-agent** — design the solution, dependencies, boundaries, interfaces, package
   structure. Output: architecture proposal + implementation plan + risks.
3. **implementation-agent** — implement to the approved design. No abstractions that were not
   approved. Output: code + a live verification run + docs.
4. **verification-agent** — verify implementation vs requirements, vs docs, vs edge cases, vs
   security assumptions. Output: verification report + issues + confidence level.
5. **doubting-agent** — assume every other agent is wrong. Hunt contradictions, hidden failure
   modes, missing requirements, over-engineering. Output: objections + alternatives + unresolved risks.
6. **synthesis-agent** — merge findings, resolve disagreements, produce the final decision,
   rationale, and implementation order. Output: the decision of record (persisted to gbrain).

### Workflow rules
- The **doubting-agent gate**: a unit is not "done" until the doubting-agent cannot find a
  stronger objection. Structured skepticism beats rapid implementation for important decisions.
- A solution being "works on my run" is **not** complete. Complete means: requirements satisfied ·
  assumptions verified · edge cases considered · docs agree · verification passes · doubting-agent
  exhausted.
- The goal is **not maximum speed. The goal is reducing expensive mistakes** (tips are real money,
  and judges cross-check every slot number on-chain).
- Trivial, reversible, no-external-surface units (e.g. a pure type definition) may skip the full
  loop — but state that you are skipping it and why.

---

## 4. Build sequence (the spine)

Execute [PRD.md §9](./PRD.md) prompts **0 → 13 in order**. Each ends at a verification gate;
do not advance past a red gate. C1 (Stream Ingestor) is already built + type-checked against
`@triton-one/yellowstone-grpc@5.0.9`; drop it into `src/data-plane/stream-ingestor.ts`.

The current plan + gate status lives in [PLAN.md](./PLAN.md) — keep it updated as the single
human-readable progress ledger (gstack is the machine ledger).

Prompt 0 (now): get the Day-0 gate ([docs/DAY0-GATE.md](./docs/DAY0-GATE.md)) to ALL GREEN via
`npm run verify:day0` before any C-component work.

---

## 5. Tech facts already verified (do not re-derive — see PRD §4)

Yellowstone is **v5** (`.destroy()` not `.cancel()`; uint64 fields arrive as strings; enable
built-in reconnect with `slotRetention: 150`). Blockhash is fetched at **`confirmed`** (150-slot
validity). Jito tip is a **last-instruction** SOL transfer to a `getTipAccounts` address, **no
ALT**, min 1000 lamports, regional block engine, 1 req/s/IP/region. Full detail + the locked
README answers (Q1/Q2/Q3) are in [PRD.md §4–§5](./PRD.md). These are recorded in gbrain — recall
them, do not re-google them.

---

## 6. Runtimes & commands

- TypeScript everywhere. `npm run typecheck` (== `tsc --noEmit`) is the gate-A check.
- `npm run verify:day0` — Day-0 external-dependency gate.
- `npm run dev` — local run; `npm run start` — Railway start.
- Secrets in `.env` locally and Railway service variables in prod. **Never commit `.env`.**
