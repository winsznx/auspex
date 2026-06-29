/**
 * C5 — Bundle Submitter (hot path). Broadcasts a construct-valid `BuiltBundle`
 * to the Jito Block Engine and returns the live `bundleId`. This is the first
 * module that moves real SOL — the tip leaves the wallet the moment Jito lands
 * the bundle.
 *
 * Two carried entry conditions from the C4 doubting-agent are enforced here
 * (see memory `c4-bundle-constructor`):
 *  - (b) PRE-SUBMIT BLOCKHASH RECHECK. A `BuiltBundle` is perishable (~150-slot
 *    blockhash). Submitting a stale one drops the bundle AND wastes the tip, so
 *    `submit` re-probes `isBlockhashValid` immediately before `sendBundle` and
 *    throws `BlockhashExpiredError` instead of burning SOL. This is exactly the
 *    failure the C11 fault injector forces.
 *  - (a) BASE64 SUBMIT ENCODING. Jito accepts base58 but marks it slow and
 *    deprecated; we re-encode the same signed wire bytes as base64 before submit.
 *
 * Verified Jito facts (memory `c4-bundle-constructor`):
 *  - sendBundle: POST <blockEngine>/api/v1/bundles, params `[[tx], {encoding}]`,
 *    success `result` = bundleId (SHA-256 of tx signatures, base58).
 *  - getInflightBundleStatuses / getBundleStatuses: POST the matching path,
 *    params `[[bundleId]]` (≤5), result is `{ context, value: [entry|null] }`.
 *  - Rate limit: 1 request/second/IP/region — the caller paces submissions.
 */
import bs58 from 'bs58';
import { logger } from '../shared/logger.ts';
import type {
  BuiltBundle,
  JitoBundleStatus,
  JitoInflightStatus,
  SubmittedBundle,
  TransactionEncoding,
} from '../shared/types.ts';

/** Thrown when the bundle's blockhash is no longer live at submit time. */
export class BlockhashExpiredError extends Error {
  readonly blockhash: string;
  constructor(blockhash: string) {
    super(`blockhash ${blockhash.slice(0, 8)}… expired before submit — not broadcasting (would drop the bundle and waste the tip)`);
    this.name = 'BlockhashExpiredError';
    this.blockhash = blockhash;
  }
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface RpcContextValue<T> {
  context: { slot: number };
  value: T;
}

export interface BundleSubmitterDeps {
  rpcUrl: string;
  blockEngineUrl: string;
}

export class BundleSubmitter {
  private readonly rpcUrl: string;
  private readonly blockEngineUrl: string;

  constructor(deps: BundleSubmitterDeps) {
    this.rpcUrl = deps.rpcUrl;
    this.blockEngineUrl = deps.blockEngineUrl;
  }

  async submit(built: BuiltBundle): Promise<SubmittedBundle> {
    const live = await this.isBlockhashValid(built.blockhash);
    if (!live) {
      throw new BlockhashExpiredError(built.blockhash);
    }

    const { bundleId, encoding } = await this.sendBundle(built.encodedTransaction, built.encoding);

    logger.info(
      { bundleId, signature: built.signature, tipLamports: built.tip.lamports, encoding },
      'bundle submitted to Jito',
    );

    return {
      bundleId,
      signature: built.signature,
      encoding,
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
      tip: built.tip,
      payer: built.payer,
      submittedAt: Date.now(),
    };
  }

  private async sendBundle(
    encodedTransaction: string,
    encoding: TransactionEncoding,
  ): Promise<{ bundleId: string; encoding: TransactionEncoding }> {
    // Jito's docs and SDK example recommend base64; base58 is slow/deprecated.
    // Always submit base64, converting from whatever signed wire bytes we were handed.
    const bytes = encoding === 'base64' ? Buffer.from(encodedTransaction, 'base64') : bs58.decode(encodedTransaction);
    const base64 = Buffer.from(bytes).toString('base64');
    const bundleId = await this.rpc<string>(
      `${this.blockEngineUrl}/api/v1/bundles`,
      'sendBundle',
      [[base64], { encoding: 'base64' }],
    );
    return { bundleId, encoding: 'base64' };
  }

  async getInflightBundleStatus(bundleId: string): Promise<JitoInflightStatus | null> {
    const result = await this.rpc<RpcContextValue<Array<{ bundle_id: string; status: string; landed_slot: number | null } | null>>>(
      `${this.blockEngineUrl}/api/v1/getInflightBundleStatuses`,
      'getInflightBundleStatuses',
      [[bundleId]],
    );
    const entry = result?.value?.[0];
    if (!entry) return null;
    return { bundleId: entry.bundle_id, status: entry.status as JitoInflightStatus['status'], landedSlot: entry.landed_slot };
  }

  async getBundleStatus(bundleId: string): Promise<JitoBundleStatus | null> {
    const result = await this.rpc<RpcContextValue<Array<{ bundle_id: string; transactions: string[]; slot: number; confirmation_status: string; err: unknown } | null>>>(
      `${this.blockEngineUrl}/api/v1/getBundleStatuses`,
      'getBundleStatuses',
      [[bundleId]],
    );
    const entry = result?.value?.[0];
    if (!entry) return null;
    return {
      bundleId: entry.bundle_id,
      transactions: entry.transactions,
      slot: entry.slot,
      confirmationStatus: entry.confirmation_status as JitoBundleStatus['confirmationStatus'],
      err: entry.err,
    };
  }

  private async isBlockhashValid(
    blockhash: string,
    commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
  ): Promise<boolean> {
    const v = await this.rpc<{ value: boolean }>(this.rpcUrl, 'isBlockhashValid', [blockhash, { commitment }]);
    return v?.value === true;
  }

  private async rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} HTTP ${res.status}${text ? `: ${text}` : ''}`);
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
