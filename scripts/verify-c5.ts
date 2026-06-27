/**
 * C5 live gate — submit ONE real Jito bundle to mainnet. THIS MOVES REAL SOL.
 *
 * Proves the full submit path end-to-end against live infra, no mocks:
 *   - builds a real signed bundle (C4) tipped at the live C3 baseline (capped
 *     for a verify run), self-transfer leg of 1 lamport
 *   - re-checks the blockhash is live, then `sendBundle` to the Jito Block Engine
 *   - prints the `bundleId` + tx signature with explorer.jito.wtf + Solscan URLs
 *     so every claim is cross-checkable on-chain
 *   - polls `getInflightBundleStatuses` (≤1 req/s) until Landed/Failed/Invalid
 *   - reports the on-chain balance delta
 *
 * Gate is GREEN when Jito returns a real `bundleId` (the submit path works).
 * Landing is reported honestly but not required here — landing reliability is
 * the evidence run's concern (C12), which times submission to a Jito leader
 * window (C2). Run: npm run verify:c5
 */
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { jitoBlockEngineUrl, solanaRpcUrl, tipFloorConfig } from '../src/config.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { AuspexBus } from '../src/shared/events.ts';
import { BundleBuilder } from '../src/data-plane/bundle-builder.ts';
import { BundleSubmitter } from '../src/data-plane/bundle-submitter.ts';
import { TipFloorClient } from '../src/data-plane/tip-floor-client.ts';

const SELF_TRANSFER_LAMPORTS = 1;
const TIP_CEILING_LAMPORTS = Number(process.env.VERIFY_C5_TIP_CEILING_LAMPORTS ?? 100_000);
const POLL_INTERVAL_MS = 2_000;
const POLL_BUDGET_MS = 40_000;

async function getBalanceLamports(rpcUrl: string, pubkey: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pubkey] }),
  });
  const body = (await res.json()) as { result?: { value?: number } };
  return body.result?.value ?? 0;
}

async function resolveBaselineTip(bus: AuspexBus, floorLamports: number): Promise<{ tip: number; source: string }> {
  const client = new TipFloorClient({ bus, config: tipFloorConfig() });
  try {
    await client.start();
    const snap = client.getSnapshot();
    if (snap) return { tip: snap.baselineLamports, source: `baseline=max(p75=${snap.percentiles.p75},floor=${snap.floorLamports})` };
  } catch {
    // fall through to floor
  } finally {
    await client.stop();
  }
  return { tip: floorLamports, source: 'floor (tip-floor unavailable)' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const blockEngineUrl = jitoBlockEngineUrl();
  const floorLamports = tipFloorConfig().floorLamports;
  const payer = loadHotWallet();
  const pubkey = payer.publicKey.toBase58();
  const bus = new AuspexBus();

  console.log('\n=== Auspex C5 Gate — REAL bundle submission (moves SOL) ===');
  console.log(`payer=${pubkey}`);

  const balanceBefore = await getBalanceLamports(rpcUrl, pubkey);
  console.log(`balance before: ${balanceBefore / LAMPORTS_PER_SOL} SOL`);
  if (balanceBefore === 0) {
    console.error('FAIL: wallet is empty — fund it before submitting.');
    process.exit(1);
  }

  const { tip: baseline, source } = await resolveBaselineTip(bus, floorLamports);
  const tipLamports = Math.max(floorLamports, Math.min(baseline, TIP_CEILING_LAMPORTS));
  const capped = baseline > TIP_CEILING_LAMPORTS ? ` (capped from ${baseline})` : '';
  console.log(`tip: ${tipLamports} lamports${capped}  [${source}]`);

  const builder = new BundleBuilder({ rpcUrl, blockEngineUrl, payer });
  await builder.init();
  const built = await builder.build({ tipLamports, selfTransferLamports: SELF_TRANSFER_LAMPORTS });
  console.log(`built: sig=${built.signature.slice(0, 24)}… tipAccount=${built.tip.account} blockhash=${built.blockhash.slice(0, 8)}…`);

  const submitter = new BundleSubmitter({ rpcUrl, blockEngineUrl });
  console.log('submitting to Jito…');
  const submitted = await submitter.submit(built);

  console.log(`\n  bundleId:  ${submitted.bundleId}`);
  console.log(`  signature: ${submitted.signature}`);
  console.log(`  explorer:  https://explorer.jito.wtf/bundle/${submitted.bundleId}`);
  console.log(`  solscan:   https://solscan.io/tx/${submitted.signature}\n`);

  let landed = false;
  let finalStatus = 'Pending';
  let landedSlot: number | null = null;
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const inflight = await submitter.getInflightBundleStatus(submitted.bundleId);
    if (!inflight) {
      console.log('  status: (not yet visible)');
      continue;
    }
    finalStatus = inflight.status;
    landedSlot = inflight.landedSlot;
    console.log(`  status: ${inflight.status}${inflight.landedSlot ? ` @ slot ${inflight.landedSlot}` : ''}`);
    if (inflight.status === 'Landed') {
      landed = true;
      break;
    }
    if (inflight.status === 'Failed' || inflight.status === 'Invalid') {
      break;
    }
  }

  if (landed) {
    const full = await submitter.getBundleStatus(submitted.bundleId);
    if (full) {
      console.log(`  landed: slot=${full.slot} confirmation=${full.confirmationStatus} err=${JSON.stringify(full.err)}`);
    }
  }

  const balanceAfter = await getBalanceLamports(rpcUrl, pubkey);
  const deltaLamports = balanceBefore - balanceAfter;
  console.log(`\nbalance after:  ${balanceAfter / LAMPORTS_PER_SOL} SOL`);
  console.log(`spent:          ${deltaLamports} lamports (${deltaLamports / LAMPORTS_PER_SOL} SOL)`);

  console.log(`\nsubmit path: GREEN (real bundleId from Jito). landed=${landed} finalStatus=${finalStatus}${landedSlot ? ` slot=${landedSlot}` : ''}`);
  console.log('C5 gate: GREEN — submission path proven on mainnet.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(`C5 gate FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
