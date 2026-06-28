/**
 * Diagnostic — build a real bundle tx and simulate it via standard RPC to find
 * out WHY Jito drops it (accepted by sendBundle, never lands, shows Invalid).
 * Free, no SOL moves.
 */
import bs58 from 'bs58';
import { jitoBlockEngineUrl, solanaRpcUrl, tipFloorConfig } from '../src/config.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { BundleBuilder } from '../src/data-plane/bundle-builder.ts';

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
  const payer = loadHotWallet();
  const builder = new BundleBuilder({ rpcUrl, blockEngineUrl: jitoBlockEngineUrl(), payer });
  await builder.init();
  const built = await builder.build({ tipLamports: Math.max(10_000, tipFloorConfig().floorLamports), selfTransferLamports: 1 });

  const base64 = Buffer.from(bs58.decode(built.encodedTransaction)).toString('base64');
  console.log(`tip=${built.tip.lamports} tipAccount=${built.tip.account}`);
  console.log(`blockhash=${built.blockhash}`);

  console.log('\n--- simulateTransaction (sigVerify, real blockhash) ---');
  console.log(JSON.stringify(await rpc(rpcUrl, 'simulateTransaction', [base64, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]), null, 2));

  console.log('\n--- simulateTransaction (replaceRecentBlockhash) ---');
  console.log(JSON.stringify(await rpc(rpcUrl, 'simulateTransaction', [base64, { encoding: 'base64', replaceRecentBlockhash: true, sigVerify: false, commitment: 'confirmed' }]), null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
