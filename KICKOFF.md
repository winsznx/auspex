# KICKOFF.md — paste this to your dev agent (Claude Code) to start

This is the exact opening instruction for the Auspex dev agent. It enforces: write the plan first,
run the dynamic workflow, use gstack + gbrain, no hardcoding, no guessing.

---

## Paste-ready kickoff prompt

> You are the executor for **Auspex** (Solana smart-transaction stack — see `PRD.md`). Operate
> under `CLAUDE.md` at all times. Do **not** start coding components yet.
>
> **Step 1 — Plan.** Read `PRD.md` and `CLAUDE.md` end to end. Recall any existing context from
> `gbrain`. Then write the complete execution plan into `PLAN.md`: expand each phase/component
> with its gate criteria, dependencies, and the verified facts it relies on (cite `PRD.md §4`).
> Push the active task + gate onto `gstack`. Do not invent facts — anything unverified is marked
> as a question for the research-agent, not a guess.
>
> **Step 2 — Day-0 gate.** Get `docs/DAY0-GATE.md` to ALL GREEN. Run `npm install`, fill `.env`
> from `.env.example` with the real mainnet credentials, then `npm run verify:day0`. Do not start
> C-components until every check is green. Record each green result to `gbrain`.
>
> **Step 3 — Dynamic workflow per component.** For C2 onward (C1 is already built — drop it into
> `src/data-plane/stream-ingestor.ts` and verify its gate), do **not** single-shot. For each
> component run the workflow in `CLAUDE.md §3` using the `Task` tool and the agents in
> `.claude/agents/`: research → architecture → (doubting + synthesis on consequential units) →
> implementation → verification → doubting → synthesis. Advance only on a green gate.
>
> **Standing rules:** no mocks, no demo data, no hardcoding, no guessing; one process / two planes;
> one owned AI decision (the tip); mainnet only; write-through to gbrain the moment a fact is
> verified or a gate flips; keep `PLAN.md` current.
>
> Begin with Step 1 now. Report the written plan back before touching the Day-0 gate.

---

## Why this order (do not skip Step 1)
Per the playbook: **research first, challenge assumptions second, design third, implement fourth,
verify fifth.** The plan + Day-0 gate exist so that no expensive mistake (a real-SOL tip, a
judge-visible bad slot number) is made on an unverified assumption.
