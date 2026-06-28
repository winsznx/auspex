/**
 * Landing / evidence runner — submits REAL Jito bundles timed to Jito leader
 * windows until a target number LAND, then writes an on-chain-verifiable
 * evidence file. THIS MOVES REAL SOL (tips, only charged on a land).
 *
 * Boots the live data plane on one bus — WS slot source (C1) → leader-window
 * tracker (C2) → tip-floor (C3) — then per iteration: waits for a Jito leader
 * window, builds (C4) + submits (C5) a bundle, and resolves its lifecycle (C6)
 * to landed/failed. The tip starts at the live C3 baseline and escalates on a
 * miss-streak (bounded), so the run lands bundles unattended without hardcoding
 * a magic tip. Every landed bundle is cross-checkable on explorer.jito.wtf +
 * Solscan from the written evidence file.
 *
 * Run: npm run run:evidence   (env: EVIDENCE_TARGET_LANDED, EVIDENCE_MAX_ATTEMPTS,
 *   EVIDENCE_TIP_FLOOR_LAMPORTS, EVIDENCE_TIP_CAP_LAMPORTS, EVIDENCE_SELF_LAMPORTS)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { jitoBlockEngineUrl, solanaRpcUrl, kobeValidatorsUrl, tipFloorConfig } from '../src/config.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { AuspexBus } from '../src/shared/events.ts';
import { WebSocketSlotSource } from '../src/data-plane/ws-slot-source.ts';
import { LeaderWindowTracker } from '../src/data-plane/leader-window-tracker.ts';
import { TipFloorClient } from '../src/data-plane/tip-floor-client.ts';
import { BundleBuilder } from '../src/data-plane/bundle-builder.ts';
import { BundleSubmitter, BlockhashExpiredError } from '../src/data-plane/bundle-submitter.ts';
import { LifecycleTracker } from '../src/data-plane/lifecycle-tracker.ts';
import type { LeaderWindowEvent } from '../src/shared/types.ts';

const TARGET_LANDED = Number(process.env.EVIDENCE_TARGET_LANDED ?? 12);
const MAX_ATTEMPTS = Number(process.env.EVIDENCE_MAX_ATTEMPTS ?? 60);
const TIP_FLOOR_LAMPORTS = Number(process.env.EVIDENCE_TIP_FLOOR_LAMPORTS ?? 10_000);
const TIP_CAP_LAMPORTS = Number(process.env.EVIDENCE_TIP_CAP_LAMPORTS ?? 250_000);
const SELF_LAMPORTS = Number(process.env.EVIDENCE_SELF_LAMPORTS ?? 1);
const ESCALATE_EVERY_MISSES = 4;
const WINDOW_WAIT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBalanceLamports(rpcUrl: string, pubkey: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pubkey] }),
  });
  const body = (await res.json()) as { result?: { value?: number } };
  return body.result?.value ?? 0;
}

async function main(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const blockEngineUrl = jitoBlockEngineUrl();
  const payer = loadHotWallet();
  const pubkey = payer.publicKey.toBase58();
  const bus = new AuspexBus();

  console.log('\n=== Auspex landing / evidence run — REAL bundles, moves SOL ===');
  console.log(`payer=${pubkey} target=${TARGET_LANDED} landed maxAttempts=${MAX_ATTEMPTS}`);

  const balanceBefore = await getBalanceLamports(rpcUrl, pubkey);
  console.log(`balance before: ${balanceBefore / LAMPORTS_PER_SOL} SOL`);
  if (balanceBefore < 2 * TIP_CAP_LAMPORTS) {
    console.error(`FAIL: balance too low for a safe run (need > ${(2 * TIP_CAP_LAMPORTS) / LAMPORTS_PER_SOL} SOL).`);
    process.exit(1);
  }

  let latestWindow: LeaderWindowEvent | undefined;
  let inJitoWindow = false;
  bus.on('error', () => undefined);
  bus.on('leaderWindow', (e) => {
    latestWindow = e;
    inJitoWindow = e.inJitoWindow;
  });

  const slotSource = new WebSocketSlotSource({ bus, rpcUrl });
  const leaderTracker = new LeaderWindowTracker({ bus, rpcUrl, kobeUrl: kobeValidatorsUrl() });
  const tipClient = new TipFloorClient({ bus, config: tipFloorConfig() });
  const builder = new BundleBuilder({ rpcUrl, blockEngineUrl, payer });
  const submitter = new BundleSubmitter({ rpcUrl, blockEngineUrl });
  const lifecycle = new LifecycleTracker({ submitter });

  await leaderTracker.start();
  await slotSource.start();
  await tipClient.start();
  await builder.init();

  console.log('data plane up — waiting for the first Jito leader window…');
  const warmupDeadline = Date.now() + 20_000;
  while (latestWindow === undefined && Date.now() < warmupDeadline) await sleep(500);

  let attempts = 0;
  let consecutiveMisses = 0;
  let currentTip = Math.max(TIP_FLOOR_LAMPORTS, tipClient.getSnapshot()?.baselineLamports ?? TIP_FLOOR_LAMPORTS);

  while (lifecycle.landedCount < TARGET_LANDED && attempts < MAX_ATTEMPTS) {
    const windowDeadline = Date.now() + WINDOW_WAIT_MS;
    while (!inJitoWindow && Date.now() < windowDeadline) await sleep(250);

    attempts += 1;
    const baseline = tipClient.getSnapshot()?.baselineLamports ?? TIP_FLOOR_LAMPORTS;
    const tip = Math.min(Math.max(currentTip, baseline, TIP_FLOOR_LAMPORTS), TIP_CAP_LAMPORTS);

    try {
      const built = await builder.build({ tipLamports: tip, selfTransferLamports: SELF_LAMPORTS });
      const submitted = await submitter.submit(built);
      console.log(
        `[${attempts}] submitted ${submitted.bundleId.slice(0, 12)}… tip=${tip} ` +
          `slot=${latestWindow?.currentSlot} inWindow=${inJitoWindow} leader=${latestWindow?.leaderIdentity?.slice(0, 6)}`,
      );
      const record = await lifecycle.resolve(submitted, { tipLamports: tip, tipAccount: built.tip.account, arm: 'baseline' });

      if (record.outcome === 'landed') {
        consecutiveMisses = 0;
        currentTip = baseline;
        console.log(`    ✅ LANDED slot=${record.landedSlot} (${lifecycle.landedCount}/${TARGET_LANDED})`);
      } else {
        consecutiveMisses += 1;
        console.log(`    ✗ ${record.outcome} (miss streak ${consecutiveMisses})`);
        if (consecutiveMisses % ESCALATE_EVERY_MISSES === 0 && currentTip < TIP_CAP_LAMPORTS) {
          currentTip = Math.min(currentTip * 2, TIP_CAP_LAMPORTS);
          console.log(`    ↑ escalating tip to ${currentTip} lamports`);
        }
      }
    } catch (err) {
      consecutiveMisses += 1;
      if (err instanceof BlockhashExpiredError) {
        console.log(`[${attempts}] blockhash expired before submit — rebuilding next iteration`);
      } else {
        console.log(`[${attempts}] submit error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const balanceAfter = await getBalanceLamports(rpcUrl, pubkey);
  const records = lifecycle.getRecords();
  const landed = records.filter((r) => r.outcome === 'landed');
  const summary = {
    payer: pubkey,
    ranAt: new Date().toISOString(),
    attempts,
    landedCount: lifecycle.landedCount,
    failedCount: lifecycle.failedCount,
    targetLanded: TARGET_LANDED,
    spentLamports: balanceBefore - balanceAfter,
    spentSol: (balanceBefore - balanceAfter) / LAMPORTS_PER_SOL,
    records: records.map((r) => ({
      ...r,
      explorerUrl: `https://explorer.jito.wtf/bundle/${r.bundleId}`,
      solscanUrl: `https://solscan.io/tx/${r.signature}`,
    })),
  };

  mkdirSync('evidence', { recursive: true });
  const outPath = `evidence/landing-run-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  // Echo the full evidence to stdout between markers so it is recoverable from
  // `fly logs` even though the container filesystem is ephemeral.
  console.log('---EVIDENCE-JSON-BEGIN---');
  console.log(JSON.stringify(summary));
  console.log('---EVIDENCE-JSON-END---');

  console.log(`\n=== Run complete ===`);
  console.log(`attempts=${attempts} landed=${lifecycle.landedCount} failed=${lifecycle.failedCount}`);
  console.log(`spent: ${summary.spentLamports} lamports (${summary.spentSol} SOL)`);
  console.log(`evidence written: ${outPath}`);
  if (landed.length > 0) {
    console.log('\nLanded bundles (cross-check on-chain):');
    for (const r of landed) {
      console.log(`  slot ${r.landedSlot}  tip ${r.tipLamports}  https://explorer.jito.wtf/bundle/${r.bundleId}`);
    }
  }

  await tipClient.stop();
  await slotSource.stop();
  await leaderTracker.stop();
  process.exit(lifecycle.landedCount > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`evidence run FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
