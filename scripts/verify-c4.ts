/**
 * C4 live gate (creds-free partial — construct + sign + validate).
 *
 * Builds ONE real, fully-signed Jito bundle transaction against live mainnet
 * infra, then proves it is genuine by DECODING the wire bytes back and
 * re-deriving every claim independently — it never trusts the builder's own
 * object:
 *   - decodes `bs58(encodedTransaction)` → a legacy `Transaction`
 *   - asserts the expected self-transfer → memo → tip instruction order, with tip LAST
 *   - re-derives the tip leg via `SystemInstruction.decodeTransfer` and checks
 *     destination ∈ an INDEPENDENT live `getTipAccounts` fetch, amount ≥ floor
 *   - asserts local `verifySignatures()` and recentBlockhash round-trip
 *   - asserts the blockhash is live via `isBlockhashValid` (real RPC call)
 *
 * Does NOT simulate and does NOT submit — both need a funded wallet. No SOL
 * moves. Gate is GREEN when every assertion holds and the blockhash is live.
 *
 * Run: npm run verify:c4
 */
import { PublicKey, Transaction, SystemProgram, SystemInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { jitoBlockEngineUrl, solanaRpcUrl, tipFloorConfig } from '../src/config.ts';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { BundleBuilder } from '../src/data-plane/bundle-builder.ts';

const SELF_TRANSFER_LAMPORTS = 1;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const checks: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
}

async function fetchTipAccountsIndependently(blockEngineUrl: string): Promise<string[]> {
  const res = await fetch(`${blockEngineUrl}/api/v1/getTipAccounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
  });
  if (!res.ok) throw new Error(`getTipAccounts HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string[] };
  if (!Array.isArray(body.result)) throw new Error('getTipAccounts: no result array');
  return body.result;
}

async function main(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const blockEngineUrl = jitoBlockEngineUrl();
  const floorLamports = tipFloorConfig().floorLamports;
  const payer = loadHotWallet();

  console.log(`\n=== Auspex C4 Gate — bundle construct/sign/validate (no submit) ===`);
  console.log(`payer=${payer.publicKey.toBase58().slice(0, 8)}… tip=${floorLamports} lamports self=${SELF_TRANSFER_LAMPORTS} lamports\n`);

  const builder = new BundleBuilder({ rpcUrl, blockEngineUrl, payer });
  await builder.init();
  check('tipAccounts loaded', builder.tipAccountCount > 0, `${builder.tipAccountCount} accounts`);

  const liveTipAccounts = await fetchTipAccountsIndependently(blockEngineUrl);

  const built = await builder.build({ tipLamports: floorLamports, selfTransferLamports: SELF_TRANSFER_LAMPORTS });

  check('encoding is base58', built.encoding === 'base58', built.encoding);
  check('tip ≥ Jito floor', built.tip.lamports >= floorLamports && built.tip.lamports >= 1000, `${built.tip.lamports} lamports`);
  check(
    'tip account ∈ live getTipAccounts',
    liveTipAccounts.includes(built.tip.account),
    `${built.tip.account.slice(0, 8)}… in ${liveTipAccounts.length}`,
  );

  const decoded = Transaction.from(bs58.decode(built.encodedTransaction));
  const ixs = decoded.instructions;
  check('exactly 3 instructions', ixs.length === 3, `${ixs.length}`);
  check(
    'exactly 2 System-program instructions',
    ixs.filter((ix) => ix.programId.equals(SystemProgram.programId)).length === 2,
    `${ixs.filter((ix) => ix.programId.equals(SystemProgram.programId)).length} System ix`,
  );
  check('memo is the middle instruction', ixs[1]?.programId.equals(MEMO_PROGRAM_ID) === true, 'self-transfer → memo → tip');

  const lastIx = ixs[ixs.length - 1];
  let tipDestMatches = false;
  let tipAmountMatches = false;
  let selfTransferIsFirst = false;
  if (lastIx !== undefined) {
    const tip = SystemInstruction.decodeTransfer(lastIx);
    tipDestMatches = tip.toPubkey.toBase58() === built.tip.account;
    tipAmountMatches = BigInt(tip.lamports) === BigInt(built.tip.lamports);
  }
  const firstIx = ixs[0];
  if (firstIx !== undefined) {
    const self = SystemInstruction.decodeTransfer(firstIx);
    selfTransferIsFirst =
      self.fromPubkey.toBase58() === built.payer && self.toPubkey.toBase58() === built.payer;
  }
  check('tip is the LAST instruction (correct dest)', tipDestMatches, built.tip.account.slice(0, 8) + '…');
  check('tip amount round-trips through the wire', tipAmountMatches, `${built.tip.lamports}`);
  check('self-transfer is the first instruction', selfTransferIsFirst, `${built.payer.slice(0, 8)}…→self`);

  check('signatures verify locally', decoded.verifySignatures(), 'verifySignatures()=true');
  check('blockhash round-trips', decoded.recentBlockhash === built.blockhash, `${built.blockhash.slice(0, 8)}…`);

  const live = await builder.isBlockhashValid(built.blockhash);
  check('blockhash is live (isBlockhashValid)', live, `lastValidBlockHeight=${built.lastValidBlockHeight}`);

  console.log(`signature=${built.signature.slice(0, 16)}…`);
  console.log(`encodedTransaction[base58]=${built.encodedTransaction.slice(0, 24)}… (${built.encodedTransaction.length} chars)\n`);

  let green = 0;
  for (const c of checks) {
    if (c.pass) green++;
    console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name.padEnd(42)} ${c.detail}`);
  }
  const allGreen = green === checks.length;
  console.log(
    `\n${green}/${checks.length} green. C4 construct-gate: ${allGreen ? 'GREEN' : 'RED'} ` +
      `(simulate + submit deferred — need a funded wallet)\n`,
  );
  process.exit(allGreen ? 0 : 1);
}

main().catch((err) => {
  console.error(`C4 gate FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
