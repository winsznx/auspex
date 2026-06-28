/**
 * Diagnostic — send the SAME bundle tx as a NORMAL transaction (no Jito) to
 * isolate whether the tx/wallet/blockhash can land on mainnet at all. Moves a
 * tiny amount of SOL (fee + small tip-account transfer).
 */
import bs58 from 'bs58';
import { jitoBlockEngineUrl, solanaRpcUrl } from '../src/config.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { BundleBuilder } from '../src/data-plane/bundle-builder.ts';

const rpcUrl = solanaRpcUrl();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json() as Promise<{ result?: unknown; error?: { message: string } }>;
}

async function main(): Promise<void> {
  const builder = new BundleBuilder({ rpcUrl, blockEngineUrl: jitoBlockEngineUrl(), payer: loadHotWallet() });
  await builder.init();
  const built = await builder.build({ tipLamports: 1_000, selfTransferLamports: 1 });
  const base64 = Buffer.from(bs58.decode(built.encodedTransaction)).toString('base64');

  console.log(`sig=${built.signature} blockhash=${built.blockhash}`);
  const send = await rpc('sendTransaction', [base64, { encoding: 'base64', skipPreflight: false, maxRetries: 5 }]);
  console.log('sendTransaction:', JSON.stringify(send));
  if (send.error) {
    process.exit(1);
  }

  for (let i = 0; i < 20; i++) {
    await sleep(2_000);
    const st = await rpc('getSignatureStatuses', [[built.signature], { searchTransactionHistory: true }]);
    const v = (st.result as { value?: Array<{ confirmationStatus?: string; slot?: number } | null> } | undefined)?.value?.[0];
    console.log(`t+${(i + 1) * 2}s  ${v ? `${v.confirmationStatus} slot=${v.slot}` : 'null'}`);
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) {
      console.log(`\n✅ tx LANDED on-chain at slot ${v.slot} — tx/wallet/blockhash are fine; the problem is bundle-specific.`);
      process.exit(0);
    }
  }
  console.log('\n✗ tx did NOT land even as a normal transaction in 40s.');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
