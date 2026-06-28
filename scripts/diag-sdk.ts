/**
 * Diagnostic — send a bundle with Jito's OWN SDK (jito-js-rpc), mirroring their
 * basic_bundle example. If this ALSO fails to land from here, the cause is
 * environmental (location/IP/host), not our submit code.
 */
import { Connection, PublicKey, Transaction, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import pkg from 'jito-js-rpc';
import { loadHotWallet } from '../src/shared/wallet.ts';
import { solanaRpcUrl } from '../src/config.ts';

const { JitoJsonRpcClient } = pkg as unknown as {
  JitoJsonRpcClient: new (url: string, uuid: string) => {
    getRandomTipAccount: () => Promise<string>;
    sendBundle: (params: unknown) => Promise<{ result: string }>;
    confirmInflightBundle: (id: string, timeoutMs: number) => Promise<unknown>;
  };
};

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');

async function main(): Promise<void> {
  const connection = new Connection(solanaRpcUrl());
  const wallet = loadHotWallet();
  const client = new JitoJsonRpcClient('https://mainnet.block-engine.jito.wtf/api/v1', '');

  const tipAccount = new PublicKey(await client.getRandomTipAccount());
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: INCINERATOR, lamports: 1 }));
  tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: tipAccount, lamports: 150_000 }));
  tx.add(new TransactionInstruction({ keys: [], programId: MEMO, data: Buffer.from('auspex-sdk') }));

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet);

  const base64 = Buffer.from(tx.serialize({ verifySignatures: false })).toString('base64');
  const result = await client.sendBundle([[base64], { encoding: 'base64' }]);
  const bundleId = result.result;
  console.log('bundleId:', bundleId);
  console.log('sig:', tx.signatures[0] ? require('bs58').default.encode(tx.signatures[0].signature) : 'n/a');

  try {
    const status = await client.confirmInflightBundle(bundleId, 30_000);
    console.log('confirmInflightBundle:', JSON.stringify(status));
  } catch (e) {
    console.log('confirm error:', e instanceof Error ? e.message : String(e));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
