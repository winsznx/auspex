/**
 * Hot-wallet loader. This wallet pays bundle tips + fees (real SOL), so its
 * secret is read once from the bs58 `HOT_WALLET_SECRET_KEY` env var and never
 * logged or echoed. A malformed key fails fast and loud here — not mid-submit
 * with a real bundle in flight.
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { requireEnv } from '../config.ts';

const SECRET_KEY_BYTES = 64;

export function loadHotWallet(): Keypair {
  const secret = requireEnv('HOT_WALLET_SECRET_KEY');
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(secret);
  } catch (err) {
    throw new Error(
      `HOT_WALLET_SECRET_KEY is not valid base58: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (bytes.length !== SECRET_KEY_BYTES) {
    throw new Error(`HOT_WALLET_SECRET_KEY must decode to ${SECRET_KEY_BYTES} bytes; got ${bytes.length}`);
  }
  return Keypair.fromSecretKey(bytes);
}
