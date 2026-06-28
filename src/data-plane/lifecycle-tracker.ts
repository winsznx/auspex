/**
 * C6 — Bundle Lifecycle Tracker (hot path).
 *
 * Resolves a submitted bundle to a terminal outcome by polling the Jito Block
 * Engine: `getInflightBundleStatuses` (Invalid|Pending|Failed|Landed) until the
 * verdict is terminal, then `getBundleStatuses` to capture the landed slot +
 * confirmation for the on-chain evidence trail. Keeps an append-only record set
 * the evidence run (C12) and A/B harness (C10) read.
 *
 * Pacing: every block-engine call respects the 1 req/s/IP/region limit. The
 * caller drives cadence; this module only sleeps between its own poll attempts.
 */
import { logger } from '../shared/logger.ts';
import type { BundleSubmitter } from './bundle-submitter.ts';
import type { SubmittedBundle } from '../shared/types.ts';

export type BundleOutcome = 'pending' | 'landed' | 'failed' | 'invalid';

export interface BundleRecord {
  bundleId: string;
  signature: string;
  tipLamports: number;
  tipAccount: string;
  /** Which arm produced the tip — for the A/B harness (C10). */
  arm: 'ai' | 'baseline';
  submittedAt: number;
  outcome: BundleOutcome;
  landedSlot: number | null;
  confirmationStatus: string | null;
  err: unknown;
  resolvedAt: number | null;
  pollAttempts: number;
}

export interface ResolveOptions {
  pollIntervalMs: number;
  timeoutMs: number;
}

const DEFAULT_RESOLVE: ResolveOptions = { pollIntervalMs: 2_000, timeoutMs: 24_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LifecycleTracker {
  private readonly submitter: BundleSubmitter;
  private readonly records: BundleRecord[] = [];

  constructor(deps: { submitter: BundleSubmitter }) {
    this.submitter = deps.submitter;
  }

  /**
   * Poll one submitted bundle until its Jito verdict is terminal (Landed/Failed/
   * Invalid) or the timeout elapses (recorded as the last-seen non-terminal
   * state, defaulting to `invalid` — Jito drops unknown bundles after ~5 min).
   */
  async resolve(
    submitted: SubmittedBundle,
    meta: { tipLamports: number; tipAccount: string; arm: 'ai' | 'baseline' },
    options: Partial<ResolveOptions> = {},
  ): Promise<BundleRecord> {
    const { pollIntervalMs, timeoutMs } = { ...DEFAULT_RESOLVE, ...options };
    const record: BundleRecord = {
      bundleId: submitted.bundleId,
      signature: submitted.signature,
      tipLamports: meta.tipLamports,
      tipAccount: meta.tipAccount,
      arm: meta.arm,
      submittedAt: submitted.submittedAt,
      outcome: 'pending',
      landedSlot: null,
      confirmationStatus: null,
      err: null,
      resolvedAt: null,
      pollAttempts: 0,
    };

    const deadline = Date.now() + timeoutMs;
    let landed = false;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      record.pollAttempts += 1;
      const inflight = await this.submitter.getInflightBundleStatus(submitted.bundleId);
      if (!inflight) continue;

      if (inflight.status === 'Landed') {
        landed = true;
        record.landedSlot = inflight.landedSlot;
        break;
      }
      if (inflight.status === 'Failed') {
        record.outcome = 'failed';
        break;
      }
      if (inflight.status === 'Invalid') {
        record.outcome = 'invalid';
        break;
      }
      // Pending — keep polling.
    }

    if (landed) {
      const full = await this.submitter.getBundleStatus(submitted.bundleId);
      record.outcome = 'landed';
      record.landedSlot = full?.slot ?? record.landedSlot;
      record.confirmationStatus = full?.confirmationStatus ?? null;
      record.err = full?.err ?? null;
    } else if (record.outcome === 'pending') {
      // Never reached a terminal verdict before timeout — treat as not landed.
      record.outcome = 'invalid';
    }

    record.resolvedAt = Date.now();
    this.records.push(record);
    logger.info(
      { bundleId: record.bundleId.slice(0, 12), outcome: record.outcome, landedSlot: record.landedSlot, tip: record.tipLamports },
      'bundle lifecycle resolved',
    );
    return record;
  }

  getRecords(): BundleRecord[] {
    return [...this.records];
  }

  get landedCount(): number {
    return this.records.filter((r) => r.outcome === 'landed').length;
  }

  get failedCount(): number {
    return this.records.filter((r) => r.outcome === 'failed' || r.outcome === 'invalid').length;
  }
}
