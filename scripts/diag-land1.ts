/**
 * Diagnostic — land ONE bundle the way Jito's own basic_bundle example does:
 * ONE endpoint (no multi-region duplicate that triggers rebroadcast/unbundling),
 * a SMALL tip, and PATIENT polling. Tests whether a clean single-region submit
 * lands AS A BUNDLE (getBundleStatuses shows a slot) instead of leaking onto the
 * chain as a normal transaction.
 *
 * MOVES REAL SOL — tip is charged on a land (or on an unbundled leak). Run:
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/diag-land1.ts
 *   env: DIAG_TIP (lamports, default 10000), DIAG_ATTEMPTS (default 3)
 */
import bs58 from 'bs58';
import { solanaRpcUrl } from '../src/config.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { BundleBuilder } from '../src/data-plane/bundle-builder.ts';

const TIP = Number(process.env.DIAG_TIP ?? 10_000);
const ATTEMPTS = Number(process.env.DIAG_ATTEMPTS ?? 3);
const ENGINE = 'https://mainnet.block-engine.jito.wtf';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json() as Promise<{ result?: unknown; error?: { message: string } }>;
}

async function main(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const builder = new BundleBuilder({ rpcUrl, blockEngineUrl: ENGINE, payer: loadHotWallet() });
  await builder.init();
  console.log(`single-region=${ENGINE} tip=${TIP} lamports attempts=${ATTEMPTS}`);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const built = await builder.build({ tipLamports: TIP, selfTransferLamports: 1 });
    const base64 = Buffer.from(bs58.decode(built.encodedTransaction)).toString('base64');

    const send = await rpc(`${ENGINE}/api/v1/bundles`, 'sendBundle', [[base64], { encoding: 'base64' }]);
    const bundleId = typeof send.result === 'string' ? send.result : undefined;
    console.log(`\n[attempt ${attempt}] sig=${built.signature.slice(0, 8)} bundleId=${bundleId ?? 'NONE'}${send.error ? ` ERROR ${send.error.message}` : ''}`);
    if (!bundleId) {
      await sleep(1_500);
      continue;
    }

    let last = '';
    for (let poll = 0; poll < 15; poll++) {
      await sleep(2_000);
      const inflight = await rpc(`${ENGINE}/api/v1/getInflightBundleStatuses`, 'getInflightBundleStatuses', [[bundleId]]);
      const e = (inflight.result as { value?: Array<{ status?: string; landed_slot?: number | null } | null> } | undefined)?.value?.[0];
      const status = e?.status ?? 'null';
      if (status !== last) {
        console.log(`   t+${((poll + 1) * 2).toFixed(0)}s  inflight=${status}${e?.landed_slot ? ` landed_slot=${e.landed_slot}` : ''}`);
        last = status;
      }
      if (status === 'Landed') {
        const full = await rpc(`${ENGINE}/api/v1/getBundleStatuses`, 'getBundleStatuses', [[bundleId]]);
        const fe = (full.result as { value?: Array<{ slot?: number; confirmation_status?: string } | null> } | undefined)?.value?.[0];
        console.log(`\n✅ LANDED AS A BUNDLE  slot=${fe?.slot} status=${fe?.confirmation_status}`);
        console.log(`   explorer: https://explorer.jito.wtf/bundle/${bundleId}`);
        console.log(`   solscan:  https://solscan.io/tx/${built.signature}`);
        process.exit(0);
      }
      if (status === 'Failed') break;
    }
    // Not Landed via inflight — check getBundleStatuses directly + whether the tx leaked on-chain.
    const full = await rpc(`${ENGINE}/api/v1/getBundleStatuses`, 'getBundleStatuses', [[bundleId]]);
    const fe = (full.result as { value?: Array<unknown> } | undefined)?.value?.[0];
    const sig = await rpc(rpcUrl, 'getSignatureStatuses', [[built.signature], { searchTransactionHistory: true }]);
    const ss = (sig.result as { value?: Array<{ confirmationStatus?: string; slot?: number } | null> } | undefined)?.value?.[0];
    console.log(`   → not a bundle (getBundleStatuses=${fe ? 'present' : 'null'}); tx on-chain: ${ss ? `${ss.confirmationStatus} slot=${ss.slot} (LEAKED as normal tx)` : 'no'}`);
  }
  console.log(`\n✗ no bundle landed AS A BUNDLE across ${ATTEMPTS} single-region attempts.`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
