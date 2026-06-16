/**
 * C2 live gate. Drives the LeaderWindowTracker off the live C1 WS slot stream and
 * proves two things against mainnet:
 *  1. The tracker emits real upcoming Jito-leader windows.
 *  2. Its leader decoding MATCHES the live chain — for a sample of slots we compare
 *     tracker.leaderOfSlot() against the RPC's own getSlotLeaders(). 100% required.
 * Leader skips are reported when observed (sporadic ~5%; forcing one is C11's job).
 *
 * Free public RPC, no funded wallet, 0 SOL. Run: npm run verify:c2  (default 60s)
 */
import { Connection } from '@solana/web3.js';
import { AuspexBus } from '../src/shared/events.ts';
import { kobeValidatorsUrl, solanaRpcUrl } from '../src/config.ts';
import { WebSocketSlotSource } from '../src/data-plane/ws-slot-source.ts';
import { LeaderWindowTracker } from '../src/data-plane/leader-window-tracker.ts';

const RUN_MS = Number(process.env.C2_RUN_MS ?? 60_000);
const SAMPLE = 24;

async function main(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const bus = new AuspexBus();
  const source = new WebSocketSlotSource({ bus, rpcUrl });
  const tracker = new LeaderWindowTracker({ bus, rpcUrl, kobeUrl: kobeValidatorsUrl() });

  bus.on('leaderWindow', (e) => {
    console.log(
      `[window] slot=${e.currentSlot} epoch=${e.epoch} inJito=${e.inJitoWindow} ` +
      `leader=${e.leaderIdentity?.slice(0, 8) ?? '?'} nextJito=${e.nextJitoWindowSlot ?? '?'} (+${e.slotsToNextJitoWindow})`,
    );
  });
  bus.on('leaderSkip', (e) => {
    console.log(`[SKIP] slot=${e.slot} windowStart=${e.windowStartSlot} leader=${e.leaderIdentity?.slice(0, 8) ?? '?'} wasJito=${e.wasJitoWindow}`);
  });
  bus.on('error', (e) => console.error('bus error:', e.message));

  console.log(`C2 verify · rpc=${rpcUrl} · ${RUN_MS}ms`);
  await tracker.start();
  await source.start();
  await new Promise<void>((resolve) => setTimeout(resolve, RUN_MS));

  const state = tracker.getState();
  const currentSlot = state.currentSlot;

  console.log('\ncross-checking tracker leader decode vs live getSlotLeaders…');
  const probe = new Connection(rpcUrl, 'confirmed');
  const startSlot = Math.max(currentSlot - SAMPLE, 0);
  const chainLeaders = await probe.getSlotLeaders(startSlot, SAMPLE);
  let matched = 0;
  let compared = 0;
  for (let i = 0; i < chainLeaders.length; i += 1) {
    const slot = startSlot + i;
    const mine = tracker.leaderOfSlot(slot);
    if (mine === undefined) continue;
    compared += 1;
    if (mine === chainLeaders[i]!.toBase58()) matched += 1;
    else console.log(`  MISMATCH slot=${slot} mine=${mine.slice(0, 8)} chain=${chainLeaders[i]!.toBase58().slice(0, 8)}`);
  }

  await source.stop();
  await tracker.stop();

  console.log(
    `\nepoch=${state.epoch} jitoWindows=${state.jitoWindows} windowEvents=${state.windowEvents} ` +
    `skipEvents=${state.skipEvents} · leaderDecode ${matched}/${compared} match`,
  );
  const pass = state.ready && state.windowEvents > 0 && compared > 0 && matched === compared;
  console.log(pass ? '\nGATE GREEN — live Jito windows emitted + leader decode matches the chain 100%' : '\nGATE RED');
  process.exit(pass ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('C2 verify crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
