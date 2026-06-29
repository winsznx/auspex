# Adversarial Testing

Auspex is built around a skeptical standard: every green check should survive a judge trying to
disprove it.

## Available-Infra Gates

Read-only or no-submit gates that run with the current env:

```bash
npm run typecheck
npm run build
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

This gate is intentionally closed with the current env. It opens only when a real Dragon's
Mouth-compatible endpoint replaces the Yellowstone placeholder.

Spendful gates:

```bash
npm run verify:c5
npm run run:evidence
npm run verify:evidence -- evidence/run-mainnet.json --strict
```

## What Has Been Tested

- C1 streams live slot updates and emits processed, confirmed, and finalized watermarks.
- C2 derives Jito leader windows and cross-checks leader decoding against `getSlotLeaders`.
- C3 reads live Jito tip percentiles and recomputes `baseline = max(p75, floor)`.
- C8 is wired to call the Groq-backed tip agent and validate a strict `BID | NO_BID` policy from
  live telemetry; it is a live gate only when `doctor:env` passes Groq auth.
- C4 decodes its own signed bundle bytes and independently verifies:
  - tip account comes from live `getTipAccounts`
  - tip amount is at least the Jito minimum
  - instruction order is self-transfer, memo, tip
  - tip is the final instruction
  - blockhash is live
- `judge:demo` proves the read-only stack wakes up against mainnet and constructs local bundle bytes.
  It also prints the real AI policy decision when Groq auth is valid.

## Landing Investigation

The current landing blocker is not hidden. Direct public Jito submissions return real `bundle_id`
values but move to `Invalid` and do not land as bundles. The investigation has tested tip amount,
region, timing, encoding, blockhash freshness, bundle structure, tip accounts, host latency, RPC
provider, and SDK-vs-local submitter paths.

See [docs/BUNDLE-LANDING-INVESTIGATION.md](./docs/BUNDLE-LANDING-INVESTIGATION.md).

## Next Red-Team Checks

1. Route `sendBundle` through a provider/staked Jito path and prove one bundle lands as a bundle.
2. Add C7 failure classifications to every non-landed record.
3. Save every AI policy decision as strict JSONL using the C8 `BID | NO_BID` schema.
4. Generate matched-pair A/B evidence with comparable leader distance, tip floor, and network lag.
5. Run `verify:evidence --strict` against the final evidence file.

## Limitations

- A small evidence run can show operational behavior, not statistical proof.
- Local receive-clock latency samples must not be mixed across sources.
- Solana PubSub WebSocket is the honest stream available with the current env. It is not Yellowstone
  or a Geyser-compatible stream.
- A Dragon's Mouth-compatible gRPC endpoint must be a real provider endpoint or self-hosted validator
  plugin source. A normal public RPC URL, or a fabricated "bridge" project, is not equivalent.
