# Day-0 Gate — external dependency checklist

Every item is an **external** dependency. Each must go GREEN before any C-component build.
`npm run verify:day0` automates the network checks; the credential/funding items are manual.

| # | Dependency | How to satisfy | How `verify:day0` checks it |
|---|------------|----------------|------------------------------|
| 1 | **Yellowstone gRPC endpoint + x-token** | Claim SolInfra credits (up to $20k, incl. Yellowstone gRPC) via [t.me/superteamng](https://t.me/superteamng). Set `YELLOWSTONE_GRPC_ENDPOINT` + `YELLOWSTONE_X_TOKEN`. | env presence now; **TODO**: live slot-stream probe (research+impl agents add it) |
| 2 | **Mainnet JSON-RPC** | A mainnet RPC URL with `getLatestBlockhash`, `getLeaderSchedule`/`getNextScheduledLeader`, `getBundleStatuses`. Set `SOLANA_RPC_URL`. | `getHealth` + `getLatestBlockhash(confirmed)` live |
| 3 | **Funded hot wallet** | ~0.1 SOL on mainnet (tips ~0.00001–0.001 SOL each). Set `HOT_WALLET_SECRET_KEY` (base58). | env presence now; **TODO**: decode → `getBalance ≥ ~0.05 SOL` |
| 4 | **Regional block engine** | Pick the lowest-latency region (e.g. `https://ny.mainnet.block-engine.jito.wtf`). Set `JITO_BLOCK_ENGINE_URL`. | live `getTipAccounts` returns ≥1 account |
| 5 | **Tip-floor endpoint** | Public, no auth: `https://bundles.jito.wtf/api/v1/bundles/tip_floor`. | live fetch returns p50/p75/p95 percentiles |
| 6 | **Jito leader-window source** | Confirm `getNextScheduledLeader` is exposed by your RPC/Jito API. Fallback: derive from `getLeaderSchedule` + the Jito validator set. | manual confirm; record decision in gbrain |

## Funding / credentials checklist (manual)
- [ ] SolInfra credits claimed → Yellowstone endpoint + token in hand
- [ ] Mainnet RPC URL in hand (and confirmed it exposes the leader-schedule method you choose)
- [ ] Hot wallet generated, **secret stored only in `.env` / Railway variables**, funded ~0.1 SOL
- [ ] Chosen block-engine region decided by measured latency from the Railway region
- [ ] `.env` filled from `.env.example`

## Gate
```
npm install
cp .env.example .env   # then fill real values
npm run verify:day0    # must exit 0 — ALL GREEN
```
Do **not** start C2+ until this gate is open. Record each green result to **gbrain**.
