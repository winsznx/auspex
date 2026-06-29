/**
 * Judge Mode CLI.
 *
 * Read-only by default. It streams live slots, leader windows, and Jito tip
 * floor, then constructs a signed local bundle without submitting it. This is
 * the "does this stack wake up for real?" demo before evidence runs.
 */
import { AuspexBus } from '../src/shared/events.ts';
import {
  jitoBlockEngineUrl,
  kobeValidatorsUrl,
  solanaRpcUrl,
  tipFloorConfig,
  yellowstoneConfig,
  yellowstoneConfigReadiness,
} from '../src/config.ts';
import { WebSocketSlotSource } from '../src/data-plane/ws-slot-source.ts';
import { StreamIngestor } from '../src/data-plane/stream-ingestor.ts';
import { LeaderWindowTracker } from '../src/data-plane/leader-window-tracker.ts';
import { TipFloorClient } from '../src/data-plane/tip-floor-client.ts';
import { BundleBuilder } from '../src/data-plane/bundle-builder.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { redactUrl } from '../src/shared/redact.ts';
import { decideTipPolicy } from '../src/control-plane/tip-agent.ts';
import type { LagSample, LeaderWindowEvent, SlotSource, TipFloorSnapshot } from '../src/shared/types.ts';

const RUN_MS = Number(process.env.JUDGE_RUN_MS ?? 20_000);
const SELF_TRANSFER_LAMPORTS = Number(process.env.JUDGE_SELF_LAMPORTS ?? 1);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startSlotSource(bus: AuspexBus, rpcUrl: string): Promise<{ source: SlotSource; kind: string }> {
  const readiness = yellowstoneConfigReadiness();
  if (readiness.usable) {
    const source = new StreamIngestor({ bus, config: yellowstoneConfig() });
    try {
      await source.start();
      return { source, kind: 'yellowstone-grpc' };
    } catch (err) {
      await source.stop().catch(() => undefined);
      console.log(`Yellowstone unavailable for judge demo: ${err instanceof Error ? err.message : String(err)}`);
      console.log('Using Solana PubSub WebSocket slot updates.');
    }
  } else {
    console.log(`Yellowstone not used for judge demo: ${readiness.reason}.`);
    console.log('Using Solana PubSub WebSocket slot updates.');
  }
  const pubsub = new WebSocketSlotSource({ bus, rpcUrl });
  await pubsub.start();
  return { source: pubsub, kind: 'solana-pubsub-websocket' };
}

function formatTip(snapshot: TipFloorSnapshot | undefined): string {
  if (!snapshot) return 'tip floor unavailable';
  const p = snapshot.percentiles;
  return `p50=${p.p50} p75=${p.p75} p95=${p.p95} baseline=max(p75,floor)=${snapshot.baselineLamports} lamports`;
}

async function main(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const bus = new AuspexBus();
  const tracker = new LeaderWindowTracker({ bus, rpcUrl, kobeUrl: kobeValidatorsUrl() });
  const tipClient = new TipFloorClient({ bus, config: tipFloorConfig() });

  let latestWindow: LeaderWindowEvent | undefined;
  let latestLag: LagSample | undefined;
  let latestSkipAt: number | undefined;
  let lagSamples = 0;
  let lagTotal = 0;

  bus.on('leaderWindow', (event) => {
    latestWindow = event;
  });
  bus.on('lag', (sample) => {
    latestLag = sample;
    lagSamples += 1;
    lagTotal += sample.deltaMs;
  });
  bus.on('leaderSkip', () => {
    latestSkipAt = Date.now();
  });
  bus.on('error', (err) => {
    console.log(`bus error: ${err.message}`);
  });

  console.log('\nAUSPEX JUDGE MODE');
  console.log(`rpc=${redactUrl(rpcUrl)}`);
  console.log('mode=read-only (constructs local bundle bytes, no submit)\n');

  await tracker.start();
  const { source, kind } = await startSlotSource(bus, rpcUrl);
  await tipClient.start();

  await sleep(RUN_MS);

  const health = source.getState();
  const snapshot = tipClient.getSnapshot();
  const avgLag = lagSamples > 0 ? Math.round(lagTotal / lagSamples) : undefined;

  console.log('1. Slot source');
  console.log(`   source=${kind} phase=${health.phase} updates=${health.updatesSeen} reconnects=${health.reconnects}`);
  console.log(`   watermarks=${JSON.stringify(health.watermarks)}`);

  console.log('2. Network health');
  console.log(
    `   processed->confirmed samples=${lagSamples}` +
      (avgLag !== undefined ? ` avg=${avgLag}ms latest=${latestLag?.deltaMs ?? '?'}ms` : ' avg=?'),
  );

  console.log('3. Jito leader window');
  console.log(
    latestWindow
      ? `   currentSlot=${latestWindow.currentSlot} inJito=${latestWindow.inJitoWindow} slotsToNext=${latestWindow.slotsToNextJitoWindow} leader=${latestWindow.leaderIdentity?.slice(0, 8) ?? '?'}`
      : '   no leader-window event observed yet',
  );

  console.log('4. Tip floor');
  console.log(`   ${formatTip(snapshot)}`);

  let selectedTipLamports = snapshot?.baselineLamports;
  if (snapshot) {
    console.log('5. AI bid policy');
    try {
      const policy = await decideTipPolicy({
        p50TipLamports: snapshot.percentiles.p50,
        p75TipLamports: snapshot.percentiles.p75,
        p95TipLamports: snapshot.percentiles.p95,
        processedConfirmedDeltaMs: avgLag,
        slotsToNextJitoLeader: latestWindow?.slotsToNextJitoWindow,
        leaderSkipped: latestSkipAt !== undefined && Date.now() - latestSkipAt < 30_000,
        recentAiLandingRate: undefined,
        recentBaselineLandingRate: undefined,
      });
      if (policy) {
        if (policy.action === 'BID' && policy.tipLamports !== undefined) {
          selectedTipLamports = policy.tipLamports;
        }
        console.log(
          `   action=${policy.action} regime=${policy.regime} tip=${policy.tipLamports ?? 'none'} max=${policy.maxTipLamports} confidence=${policy.confidence}`,
        );
        console.log(`   rule=${policy.rule}`);
        console.log(`   rationale=${policy.rationale}`);
      } else {
        console.log('   unavailable: GROQ_API_KEY is not set');
      }
    } catch (err) {
      console.log(`   unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (snapshot) {
    try {
      const payer = loadHotWallet();
      const builder = new BundleBuilder({ rpcUrl, blockEngineUrl: jitoBlockEngineUrl(), payer });
      await builder.init();
      const built = await builder.build({
        tipLamports: selectedTipLamports ?? snapshot.baselineLamports,
        selfTransferLamports: SELF_TRANSFER_LAMPORTS,
      });
      console.log('6. Local bundle construction');
      console.log(`   payer=${payer.publicKey.toBase58().slice(0, 8)}...`);
      console.log(`   signature=${built.signature.slice(0, 16)}... tip=${built.tip.lamports} tipAccount=${built.tip.account.slice(0, 8)}...`);
      console.log(`   blockhash=${built.blockhash.slice(0, 8)}... encoding=${built.encoding} submit=false`);
    } catch (err) {
      console.log('6. Local bundle construction');
      console.log(`   unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await tipClient.stop();
  await source.stop();
  await tracker.stop();
  console.log('\nJudge mode complete. No SOL moved.\n');
}

main().catch((err) => {
  console.error(`judge:demo failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
