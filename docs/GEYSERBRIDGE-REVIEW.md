# GeyserBridge Review

Repository reviewed: `https://github.com/Luckyisrael/GeyserBridge`

Date reviewed: 2026-06-29

## Verdict

GeyserBridge is a real working repository, not a nonexistent link. It implements a gRPC server using
the Yellowstone `geyser.Geyser` protobuf surface and backs it with normal Solana RPC/WebSocket calls.
Its own tests pass, and its own examples stream live slots.

It does **not** give free Dragon's Mouth credentials, free provider credits, or a true Geyser data
source. It is a compatibility shim over normal Solana RPC.

## What Was Verified

- Cloned the repository locally.
- Installed dependencies.
- Ran its full test suite:

```txt
Test Files  9 passed (9)
Tests       59 passed (59)
```

- Started the server locally with public Solana RPC.
- Ran its own slot-streaming example successfully.
- Tried connecting with Auspex's installed `@triton-one/yellowstone-grpc` v5 client.

## Important Findings

### 1. It Does Not Provide Credits

There is no provider signup, sponsor credential flow, or credit grant mechanism in the repo. The
`.env.example` only asks for:

```txt
SOLANA_RPC_URL
SOLANA_RPC_WS_URL
ADMIN_KEY
```

So this repo cannot solve the missing SolInfra/Dragon's Mouth credential problem by itself.

### 2. Slot Updates Are Not Dragon's Mouth Equivalent

The server's main slot loop uses `Connection.onSlotChange()` and emits:

```ts
const status = statusFromCommitment(1);
```

That hard-codes every slot update as `CONFIRMED`.

In a local smoke test, the bridge's own example printed only:

```txt
status=1
```

For Auspex, this is weaker than the current Solana PubSub source because Auspex needs
processed-to-confirmed-to-finalized progression for lifecycle-health signals.

### 3. It Is Not Drop-In For Our Current Yellowstone Client

Auspex's installed `@triton-one/yellowstone-grpc` v5 client failed against the local bridge on
`Subscribe`:

```txt
failed to open subscribe stream
Error deserializing request: Cannot read properties of null (reading 'filterByCommitment')
```

The bridge's own raw gRPC example works, so the bridge is functional, but it is not currently a
zero-change replacement for Auspex's Yellowstone ingestor.

### 4. It Still Depends On Normal RPC Limits

Transactions are sourced from `onLogs` and then fetched with `getTransaction`. Blocks are fetched
with `getBlock`. Accounts use `onProgramAccountChange`.

That means throughput, coverage, ordering, and rate limits are those of the configured RPC provider,
not a validator-side Geyser plugin.

## Can We Use It?

Not for final Yellowstone evidence.

Possible use:

- as a separate educational demo showing a community gRPC shim exists
- as a future adapter experiment if we patch compatibility and slot status handling

Not acceptable to claim:

- "Dragon's Mouth is solved"
- "we got free Yellowstone credentials"
- "public RPC WebSocket is equivalent to Geyser"

## Decision For Auspex

Do not integrate GeyserBridge before submission. It would add complexity and weaken the proof. The
current Auspex Solana PubSub source is more honest and already gives the processed/confirmed/finalized
watermarks needed for the terminal demo.

Keep the product story focused:

- available-infra stream: Solana PubSub WebSocket
- premium stream path: implemented Yellowstone client, awaiting real Dragon's Mouth credentials
- bundle landing path: blocked by provider/commercial Jito route, documented with Helius result
