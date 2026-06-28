/**
 * Diagnostic — submit ONE bundle and watch its full Jito lifecycle at fine
 * granularity to see whether it enters the auction (Pending) or is rejected
 * immediately (Invalid). Prints raw responses. Moves SOL only if it lands.
 */
import bs58 from 'bs58';
import { jitoBlockEngineUrl, solanaRpcUrl } from '../src/config.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { BundleBuilder } from '../src/data-plane/bundle-builder.ts';

const blockEngine = process.env.JITO_BLOCK_ENGINE_URL ?? jitoBlockEngineUrl();

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const payer = loadHotWallet();
  const builder = new BundleBuilder({ rpcUrl, blockEngineUrl: blockEngine, payer });
  await builder.init();
  const built = await builder.build({ tipLamports: Number(process.env.DIAG_TIP ?? 100_000), selfTransferLamports: 1 });
  const base64 = Buffer.from(bs58.decode(built.encodedTransaction)).toString('base64');

  console.log(`blockEngine=${blockEngine}`);
  console.log(`tip=${built.tip.lamports} sig=${built.signature}`);

  const sendRes = (await rpc(`${blockEngine}/api/v1/bundles`, 'sendBundle', [[base64], { encoding: 'base64' }])) as {
    result?: string;
    error?: unknown;
  };
  console.log('sendBundle response:', JSON.stringify(sendRes));
  const bundleId = sendRes.result;
  if (!bundleId) {
    console.log('no bundleId — aborting');
    process.exit(1);
  }

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const inflight = (await rpc(`${blockEngine}/api/v1/getInflightBundleStatuses`, 'getInflightBundleStatuses', [[bundleId]])) as {
      result?: { value?: Array<{ status?: string; landed_slot?: number | null } | null> };
    };
    const entry = inflight.result?.value?.[0];
    console.log(`t+${((i + 1) * 500).toString().padStart(5)}ms  inflight=${entry ? entry.status : 'null'}${entry?.landed_slot ? ` slot=${entry.landed_slot}` : ''}`);
    if (entry && (entry.status === 'Landed' || entry.status === 'Failed')) break;
  }

  const sig = await rpc(rpcUrl, 'getSignatureStatuses', [[built.signature], { searchTransactionHistory: true }]);
  console.log('on-chain getSignatureStatuses:', JSON.stringify((sig as { result?: { value?: unknown } }).result?.value));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
