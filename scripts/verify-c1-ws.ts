/**
 * C1 live gate via the RPC-WebSocket fallback (no Yellowstone, no funded wallet,
 * free public RPC). Proves the data-plane slot source streams live mainnet slots
 * with MONOTONICALLY ADVANCING processed → confirmed → finalized watermarks and
 * emits slot/watermark/lag/health on the bus.
 *
 * This green-lights the shared slot-state machine (SlotStateTracker) against real
 * mainnet — the Yellowstone StreamIngestor reuses the exact same tracker, so its
 * remaining gap is only the gRPC transport, not the watermark/lag logic.
 *
 * Run: npm run verify:c1   (default 40s)
 */
import { AuspexBus } from '../src/shared/events.ts';
import { solanaRpcUrl } from '../src/config.ts';
import { WebSocketSlotSource } from '../src/data-plane/ws-slot-source.ts';
import type { Watermarks } from '../src/shared/types.ts';

const RUN_MS = Number(process.env.C1_RUN_MS ?? 40_000);

function advanced(first: Watermarks, last: Watermarks): boolean {
  return last.processed > first.processed && last.confirmed > first.confirmed && last.finalized > first.finalized;
}

async function main(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const bus = new AuspexBus();
  const source = new WebSocketSlotSource({ bus, rpcUrl });

  let first: Watermarks | undefined;
  let last: Watermarks | undefined;
  let watermarkEvents = 0;
  let lagSamples = 0;
  let lagTotal = 0;

  bus.on('watermark', (w) => {
    watermarkEvents += 1;
    if (!first) first = { ...w };
    last = { ...w };
  });
  bus.on('lag', (l) => {
    lagSamples += 1;
    lagTotal += l.deltaMs;
  });
  bus.on('error', (e) => console.error('bus error:', e.message));

  console.log(`C1 verify (WS fallback) · rpc=${rpcUrl} · ${RUN_MS}ms`);
  await source.start();
  await new Promise<void>((resolve) => setTimeout(resolve, RUN_MS));
  await source.stop();

  const health = source.getState();
  console.log(`\nfirst=${first ? JSON.stringify(first) : 'none'}`);
  console.log(`last =${last ? JSON.stringify(last) : 'none'}`);
  console.log(`watermarkEvents=${watermarkEvents} updatesSeen=${health.updatesSeen} reconnects=${health.reconnects} phase=${health.phase}`);
  console.log(`lagSamples=${lagSamples}${lagSamples > 0 ? ` avgProcessed→confirmed=${Math.round(lagTotal / lagSamples)}ms (local-clock)` : ''}`);

  const pass = first !== undefined && last !== undefined && advanced(first, last) && health.updatesSeen > 0;
  console.log(pass ? '\nGATE GREEN — live mainnet slot source with advancing processed→confirmed→finalized watermarks' : '\nGATE RED — watermarks did not advance across all three commitment levels');
  process.exit(pass ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('C1 verify crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
