/**
 * C4 — Bundle Constructor (hot path).
 *
 * Builds a fully-signed, construct-valid single-transaction Jito bundle: a self
 * transfer with the tip carried as the LAST instruction (PRD §1 — one owned
 * decision, the tip). The tip amount is an INPUT (C3 baseline now; the C8 agent
 * later); this module only constructs, signs, and validates — it never decides
 * the tip and never submits. "Construct-valid" means well-formed + signed +
 * blockhash-live; it is NOT proof Jito will accept it (that needs C5 + funds).
 *
 * Verified facts driving the wire format (see memory `c4-bundle-constructor`):
 *  - Jito `sendBundle` requires **base58**-encoded transactions, not base64
 *    (Solana's own `sendTransaction` uses base64 — Jito diverges; live-proven).
 *  - A LEGACY `Transaction` is accepted (no address-lookup-table needed for a
 *    two-instruction self-transfer + tip).
 *  - Tip account: pick one of the block engine's 8 `getTipAccounts` at random
 *    per bundle to spread load / reduce contention. Accounts rotate — fetched
 *    live, never hardcoded.
 *  - Tip min is 1000 lamports; below that Jito rejects the bundle.
 *
 * Nothing here is broadcast. Holding a `BuiltBundle` moves no SOL — simulation
 * and submission (C5) are separate steps that need a funded wallet.
 */
import { Transaction, SystemProgram, PublicKey, type Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '../shared/logger.ts';
import type { BuiltBundle } from '../shared/types.ts';

const JITO_MIN_TIP_LAMPORTS = 1000;

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

export interface BundleBuilderDeps {
  rpcUrl: string;
  blockEngineUrl: string;
  payer: Keypair;
}

export interface BuildBundleParams {
  /** Tip carried as the last instruction. Must be an integer ≥ 1000 lamports. */
  tipLamports: number;
  /** The self-transfer leg's amount. A tiny real value; the payload is incidental. */
  selfTransferLamports: number;
}

export class BundleBuilder {
  private readonly rpcUrl: string;
  private readonly blockEngineUrl: string;
  private readonly payer: Keypair;
  private tipAccounts: PublicKey[] = [];

  constructor(deps: BundleBuilderDeps) {
    this.rpcUrl = deps.rpcUrl;
    this.blockEngineUrl = deps.blockEngineUrl;
    this.payer = deps.payer;
  }

  /** Load the live tip-account set. Call once before `build`; re-call to refresh. */
  async init(): Promise<void> {
    await this.refreshTipAccounts();
  }

  async refreshTipAccounts(): Promise<void> {
    const result = await this.rpc<string[]>(
      `${this.blockEngineUrl}/api/v1/getTipAccounts`,
      'getTipAccounts',
      [],
    );
    if (!Array.isArray(result) || result.length === 0) {
      throw new Error('getTipAccounts returned no accounts');
    }
    this.tipAccounts = result.map((a) => new PublicKey(a));
    logger.info({ count: this.tipAccounts.length }, 'bundle-builder loaded tip accounts');
  }

  get tipAccountCount(): number {
    return this.tipAccounts.length;
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const v = await this.rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
      this.rpcUrl,
      'getLatestBlockhash',
      [{ commitment: 'confirmed' }],
    );
    const blockhash = v?.value?.blockhash;
    const lastValidBlockHeight = v?.value?.lastValidBlockHeight;
    if (typeof blockhash !== 'string' || typeof lastValidBlockHeight !== 'number') {
      throw new Error('malformed getLatestBlockhash response');
    }
    return { blockhash, lastValidBlockHeight };
  }

  async isBlockhashValid(blockhash: string, commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'): Promise<boolean> {
    const v = await this.rpc<{ value: boolean }>(this.rpcUrl, 'isBlockhashValid', [blockhash, { commitment }]);
    return v?.value === true;
  }

  async build(params: BuildBundleParams): Promise<BuiltBundle> {
    const { tipLamports, selfTransferLamports } = params;
    if (!Number.isInteger(tipLamports) || tipLamports < JITO_MIN_TIP_LAMPORTS) {
      throw new Error(`tipLamports must be an integer ≥ ${JITO_MIN_TIP_LAMPORTS} (Jito min tip); got ${tipLamports}`);
    }
    if (!Number.isInteger(selfTransferLamports) || selfTransferLamports < 0) {
      throw new Error(`selfTransferLamports must be a non-negative integer; got ${selfTransferLamports}`);
    }

    const tipAccount = this.pickTipAccount();
    const { blockhash, lastValidBlockHeight } = await this.getLatestBlockhash();

    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: this.payer.publicKey });
    tx.add(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: this.payer.publicKey,
        lamports: selfTransferLamports,
      }),
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      }),
    );

    tx.sign(this.payer);
    if (!tx.verifySignatures()) {
      throw new Error('transaction failed local signature verification after signing');
    }
    if (tx.signature === null) {
      throw new Error('transaction has no signature after signing');
    }

    return {
      encodedTransaction: bs58.encode(tx.serialize()),
      encoding: 'base58',
      signature: bs58.encode(tx.signature),
      blockhash,
      lastValidBlockHeight,
      payer: this.payer.publicKey.toBase58(),
      tip: { account: tipAccount.toBase58(), lamports: tipLamports },
      selfTransferLamports,
      builtAt: Date.now(),
    };
  }

  private pickTipAccount(): PublicKey {
    const count = this.tipAccounts.length;
    if (count === 0) {
      throw new Error('no tip accounts loaded — call init()/refreshTipAccounts() before build()');
    }
    const account = this.tipAccounts[Math.floor(Math.random() * count)];
    if (account === undefined) {
      throw new Error('tip-account selection produced no account');
    }
    return account;
  }

  private async rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) {
      throw new Error(`${method} HTTP ${res.status}`);
    }
    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error) {
      throw new Error(`${method} RPC error ${body.error.code}: ${body.error.message}`);
    }
    if (body.result === undefined) {
      throw new Error(`${method} returned no result`);
    }
    return body.result;
  }
}
