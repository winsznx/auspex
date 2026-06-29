# Security

Auspex touches real mainnet funds. The operational rule is simple: small hot wallet, explicit spend
commands, no secrets in git, and every live claim backed by evidence.

## Secrets

- `.env` and `.env.local` are ignored by git.
- `HOT_WALLET_SECRET_KEY` is loaded from environment only and is never printed.
- `GROQ_API_KEY` is loaded from environment only and is never printed.
- RPC and provider URLs may contain API keys, so runtime logs redact endpoint paths and query strings.
- Railway service variables are the production secret store.

## Spend Safety

Implemented controls:

- C4 constructs and validates bundle bytes without submitting.
- C5 re-checks blockhash validity immediately before `sendBundle`.
- Spendful scripts are separated from read-only scripts.
- Tip floors and evidence-run caps are configurable by environment variables.
- `run:evidence` refuses to run with a very low balance relative to its configured tip cap.

Operator rules:

- Fund only a small hot wallet for the run.
- Run `npm run verify:day0` before any spendful command.
- Run `npm run judge:demo` before evidence collection.
- Do not run `verify:c5`, `run:evidence`, `run:ab`, or `fault:blockhash` unless the wallet and
  endpoint route are intentionally ready.

## Known Risks

- Direct public Jito routing currently returns bundle IDs but does not land bundles as bundles.
- The current Yellowstone endpoint is a placeholder; the available-infra path uses Solana PubSub
  WebSocket and does not claim it is Dragon's Mouth.
- A/B results from 10-20 bundles are operational evidence, not statistical certainty.
- AI policy must remain bounded by explicit max-tip caps.

## Reporting

This is a hackathon project by winsznx. Do not disclose private keys, RPC keys, wallet secrets, or
provider tokens in issues, screenshots, logs, or pull requests.
