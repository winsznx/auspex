/**
 * Diagnostic — mirror Jito's basic_bundle example EXACTLY to test the last
 * untested structural difference: a REAL transfer to a different account (not a
 * payer→payer self-transfer no-op). Instruction order matches the example:
 * transfer → tip → memo. Single region, small tip, patient poll.
 *
 * If THIS lands as a bundle, the self-transfer no-op was the cause. If it still
 * shows Invalid, the rejection is environmental/account-specific, not structural.
 *
 * MOVES REAL SOL (tip + 1 lamport). Run:
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/diag-land2.ts
 *   env: DIAG_TIP (lamports, default 10000), DIAG_ATTEMPTS (default 3)
 */
import { Connection, Transaction, SystemProgram, PublicKey, TransactionInstruction, Keypair } from '@solana/web3.js';
import { solanaRpcUrl, jitoBlockEngineUrl } from '../src/config.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';

const TIP = Number(process.env.DIAG_TIP ?? 10_000);
const ATTEMPTS = Number(process.env.DIAG_ATTEMPTS ?? 3);
const ENGINE = 'https://mainnet.block-engine.jito.wtf';
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json() as Promise<{ result?: unknown; error?: { message: string } }>;
}

async function getTipAccounts(): Promise<PublicKey[]> {
  const r = await rpc(`${ENGINE}/api/v1/getTipAccounts`, 'getTipAccounts', []);
  return (r.result as string[]).map((a) => new PublicKey(a));
}

async function main(): Promise<void> {
  const connection = new Connection(solanaRpcUrl(), 'confirmed');
  const payer = loadHotWallet();
  const tipAccounts = await getTipAccounts();
  console.log(`single-region=${ENGINE} tip=${TIP} lamports attempts=${ATTEMPTS} (Jito-example structure: real transfer → tip → memo)`);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const receiver = Keypair.generate().publicKey;
    const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)]!;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    const tx = new Transaction();
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: receiver, lamports: 1 }));
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: tipAccount, lamports: TIP }));
    tx.add(new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from('auspex') }));
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);

    const base64 = Buffer.from(tx.serialize({ verifySignatures: false })).toString('base64');
    const sig = tx.signature ? Buffer.from(tx.signature).toString('hex').slice(0, 8) : '?';

    const send = await rpc(`${ENGINE}/api/v1/bundles`, 'sendBundle', [[base64], { encoding: 'base64' }]);
    const bundleId = typeof send.result === 'string' ? send.result : undefined;
    console.log(`\n[attempt ${attempt}] receiver=${receiver.toBase58().slice(0, 6)} sig=${sig} bundleId=${bundleId ?? 'NONE'}${send.error ? ` ERROR ${send.error.message}` : ''}`);
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
        process.exit(0);
      }
      if (status === 'Failed') break;
    }
    console.log(`   → not a bundle this attempt (last inflight=${last || 'null'})`);
  }
  console.log(`\n✗ Jito-example structure also did not land as a bundle across ${ATTEMPTS} attempts.`);
  console.log('  → rejection is NOT our bundle structure. It is environmental/account-specific.');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
