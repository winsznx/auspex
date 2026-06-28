/**
 * Diagnostic — call Jito simulateBundle to get the block engine's actual reason
 * for dropping our bundle (it accepts then never auctions). Free, no SOL.
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

async function main(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const builder = new BundleBuilder({ rpcUrl, blockEngineUrl: blockEngine, payer: loadHotWallet() });
  await builder.init();
  const built = await builder.build({ tipLamports: 100_000, selfTransferLamports: 1 });
  const base64 = Buffer.from(bs58.decode(built.encodedTransaction)).toString('base64');

  console.log(`blockEngine=${blockEngine} blockhash=${built.blockhash}`);

  for (const variant of [
    { label: 'object param', params: [{ encodedTransactions: [base64] }] },
    { label: 'object + simulationBank current', params: [{ encodedTransactions: [base64] }, { simulationBank: 'current' }] },
  ]) {
    console.log(`\n--- simulateBundle (${variant.label}) ---`);
    try {
      console.log(JSON.stringify(await rpc(`${blockEngine}/api/v1/bundles`, 'simulateBundle', variant.params)));
    } catch (e) {
      console.log('err:', e instanceof Error ? e.message : String(e));
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
