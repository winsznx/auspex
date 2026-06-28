/**
 * Diagnostic — land ONE bundle. Tests the two strongest non-code hypotheses for
 * why bundles never land: (1) region routing — we only ever submit to `ny`, but
 * the live Jito leader may be wired to a different block engine; (2) timing — by
 * firing every ~1.5s with a fresh blockhash we cover many leader windows.
 *
 * Each attempt builds a fresh bundle (confirmed blockhash) and submits the SAME
 * tx to ALL regional block engines in parallel (same signatures ⇒ same bundleId).
 * Then it polls getInflightBundleStatuses fast, logging every status transition,
 * and stops on the first Landed. MOVES REAL SOL — the tip is charged only on a
 * land. Run: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/diag-land.ts
 *   env: DIAG_TIP (lamports, default 50000), DIAG_ATTEMPTS (default 6)
 */
import bs58 from 'bs58';
import { solanaRpcUrl } from '../src/config.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { BundleBuilder } from '../src/data-plane/bundle-builder.ts';

const TIPS = (process.env.DIAG_TIPS ?? '2000000,5000000,10000000').split(',').map(Number);
const GLOBAL = 'https://mainnet.block-engine.jito.wtf';
const REGIONS = [
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://slc.mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://london.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
  GLOBAL,
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json() as Promise<{ result?: unknown; error?: { message: string } }>;
}

function regionLabel(url: string): string {
  return url.replace('https://', '').split('.')[0] ?? url;
}

async function main(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const builder = new BundleBuilder({ rpcUrl, blockEngineUrl: GLOBAL, payer: loadHotWallet() });
  await builder.init();
  console.log(`tips=[${TIPS.join(', ')}] lamports (escalating) regions=${REGIONS.length}`);

  for (let attempt = 1; attempt <= TIPS.length; attempt++) {
    const tip = TIPS[attempt - 1]!;
    const built = await builder.build({ tipLamports: tip, selfTransferLamports: 1 });
    const base64 = Buffer.from(bs58.decode(built.encodedTransaction)).toString('base64');
    const params = [[base64], { encoding: 'base64' }];

    const sends = await Promise.all(
      REGIONS.map(async (url) => {
        const r = await rpc(`${url}/api/v1/bundles`, 'sendBundle', params).catch(
          (e): { result?: unknown; error?: { message: string } } => ({ error: { message: String(e) } }),
        );
        return { region: regionLabel(url), bundleId: typeof r.result === 'string' ? r.result : undefined, error: r.error?.message };
      }),
    );
    const accepted = sends.filter((s) => s.bundleId);
    const bundleId = accepted[0]?.bundleId;
    console.log(
      `\n[attempt ${attempt}] tip=${tip} blockhash=${built.blockhash.slice(0, 8)} sig=${built.signature.slice(0, 8)} ` +
        `accepted=${accepted.length}/${REGIONS.length}\n   bundleId=${bundleId ?? 'NONE'}`,
    );
    for (const s of sends) {
      if (s.error) console.log(`   ${s.region}: ERROR ${s.error}`);
    }
    if (!bundleId) {
      await sleep(1_500);
      continue;
    }

    let lastStatus = '';
    for (let poll = 0; poll < 8; poll++) {
      await sleep(1_200);
      const inflight = await rpc(`${GLOBAL}/api/v1/getInflightBundleStatuses`, 'getInflightBundleStatuses', [[bundleId]]);
      const entry = (inflight.result as { value?: Array<{ status?: string; landed_slot?: number | null } | null> } | undefined)?.value?.[0];
      const status = entry?.status ?? 'null';
      if (status !== lastStatus) {
        console.log(`   t+${((poll + 1) * 1.2).toFixed(1)}s  inflight=${status}${entry?.landed_slot ? ` slot=${entry.landed_slot}` : ''}`);
        lastStatus = status;
      }
      if (status === 'Landed') {
        const full = await rpc(`${GLOBAL}/api/v1/getBundleStatuses`, 'getBundleStatuses', [[bundleId]]);
        const fe = (full.result as { value?: Array<{ slot?: number; confirmation_status?: string } | null> } | undefined)?.value?.[0];
        console.log(`\n✅ LANDED  slot=${fe?.slot} status=${fe?.confirmation_status}`);
        console.log(`   explorer: https://explorer.jito.wtf/bundle/${bundleId}`);
        console.log(`   solscan:  https://solscan.io/tx/${built.signature}`);
        process.exit(0);
      }
      if (status === 'Failed') break;
    }
    console.log(`   → not landed this attempt (last inflight=${lastStatus || 'null'})`);
  }
  console.log(`\n✗ no bundle landed across ${TIPS.length} escalating tips × ${REGIONS.length} regions.`);
  console.log('  If accepted>0 every time but inflight stayed Invalid/null, it is NOT region or timing —');
  console.log('  the block engine is rejecting our bundle CONTENT (simulation/value). Pivot there next.');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
