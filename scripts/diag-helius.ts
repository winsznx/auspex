/**
 * Diagnostic — submit the bundle through Helius's whitelisted/staked Jito
 * connection instead of hitting Jito's public block engine directly. Tests the
 * IP-whitelist theory: our direct submissions get a bundleId but never enter the
 * auction; a provider with a staked Jito connection should actually land it.
 *
 * Provide your Helius RPC URL (free tier) via env — NOT committed, not in .env:
 *   HELIUS_RPC_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_KEY' \
 *     node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/diag-helius.ts
 *   optional: DIAG_TIP (lamports, default 10000), DIAG_ATTEMPTS (default 3)
 *
 * MOVES REAL SOL (tip on a land). Blockhash is still fetched from SOLANA_RPC_URL.
 */
import bs58 from 'bs58';
import { solanaRpcUrl, jitoBlockEngineUrl } from '../src/config.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { BundleBuilder } from '../src/data-plane/bundle-builder.ts';

const HELIUS = process.env.HELIUS_RPC_URL;
const TIP = Number(process.env.DIAG_TIP ?? 10_000);
const ATTEMPTS = Number(process.env.DIAG_ATTEMPTS ?? 3);
const JITO = jitoBlockEngineUrl();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json() as Promise<{ result?: unknown; error?: { message: string } }>;
}

async function inflight(bundleId: string): Promise<string> {
  const r = await rpc(`${JITO}/api/v1/getInflightBundleStatuses`, 'getInflightBundleStatuses', [[bundleId]]);
  const e = (r.result as { value?: Array<{ status?: string; landed_slot?: number | null } | null> } | undefined)?.value?.[0];
  return e?.status ?? 'null';
}

async function main(): Promise<void> {
  if (!HELIUS) {
    console.error('Set HELIUS_RPC_URL env var (https://mainnet.helius-rpc.com/?api-key=YOUR_KEY)');
    process.exit(1);
  }
  const builder = new BundleBuilder({ rpcUrl: solanaRpcUrl(), blockEngineUrl: JITO, payer: loadHotWallet() });
  await builder.init();
  console.log(`submitting via Helius (masked) tip=${TIP} attempts=${ATTEMPTS}`);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const built = await builder.build({ tipLamports: TIP, selfTransferLamports: 1 });
    const base64 = Buffer.from(bs58.decode(built.encodedTransaction)).toString('base64');

    const send = await rpc(HELIUS, 'sendBundle', [[base64], { encoding: 'base64' }]);
    const bundleId = typeof send.result === 'string' ? send.result : undefined;
    console.log(`\n[attempt ${attempt}] sig=${built.signature.slice(0, 8)} bundleId=${bundleId ?? 'NONE'}${send.error ? ` ERROR ${send.error.message}` : ''}`);
    if (!bundleId) {
      await sleep(1_500);
      continue;
    }

    let last = '';
    for (let poll = 0; poll < 15; poll++) {
      await sleep(2_000);
      const status = await inflight(bundleId);
      if (status !== last) {
        console.log(`   t+${((poll + 1) * 2).toFixed(0)}s  inflight=${status}`);
        last = status;
      }
      if (status === 'Landed') {
        const full = await rpc(`${JITO}/api/v1/getBundleStatuses`, 'getBundleStatuses', [[bundleId]]);
        const fe = (full.result as { value?: Array<{ slot?: number; confirmation_status?: string } | null> } | undefined)?.value?.[0];
        console.log(`\n✅ LANDED AS A BUNDLE  slot=${fe?.slot} status=${fe?.confirmation_status}`);
        console.log(`   explorer: https://explorer.jito.wtf/bundle/${bundleId}`);
        console.log(`   solscan:  https://solscan.io/tx/${built.signature}`);
        process.exit(0);
      }
      if (status === 'Failed') break;
    }
    console.log(`   → not a bundle this attempt (last inflight=${last || 'null'})`);
  }
  console.log(`\n✗ even via Helius, no bundle landed across ${ATTEMPTS} attempts.`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
