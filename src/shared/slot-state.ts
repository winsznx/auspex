/**
 * Source-agnostic slot state: monotonic watermarks + processed→confirmed lag.
 * Shared by every slot source (Yellowstone gRPC C1, RPC-WebSocket fallback) so
 * the watermark/lag rules live in exactly one tested place.
 *
 * Pure: `observe()` mutates internal state and RETURNS what should be emitted;
 * the caller owns the bus. No I/O, no enums (strip-types safe).
 */
import type { LagSample, SlotPhase, SlotUpdate, Watermarks } from './types.ts';

export interface SlotObservation {
  slotUpdate: SlotUpdate;
  /** Present only when a watermark advanced. */
  watermark: Watermarks | undefined;
  /** Present only when a processed→confirmed pair completed. */
  lag: LagSample | undefined;
}

const COMMITMENT_LEVELS: Record<'processed' | 'confirmed' | 'finalized', keyof Watermarks> = {
  processed: 'processed',
  confirmed: 'confirmed',
  finalized: 'finalized',
};

export class SlotStateTracker {
  private readonly watermarks: Watermarks = { processed: 0, confirmed: 0, finalized: 0 };
  private readonly processedAt = new Map<number, number>();
  private readonly maxProcessedEntries: number;

  constructor(maxProcessedEntries = 1_024) {
    this.maxProcessedEntries = maxProcessedEntries;
  }

  observe(slot: number, parent: number | undefined, phase: SlotPhase, observedAt: number): SlotObservation {
    const slotUpdate: SlotUpdate = { slot, parent, phase, observedAt };
    let lag: LagSample | undefined;
    let watermarkChanged = false;

    switch (phase) {
      case 'processed':
        this.rememberProcessed(slot, observedAt);
        watermarkChanged = this.advance('processed', slot);
        break;
      case 'confirmed':
        lag = this.takeLag(slot, observedAt);
        watermarkChanged = this.advance('confirmed', slot);
        break;
      case 'finalized':
        watermarkChanged = this.advance('finalized', slot);
        break;
      case 'dead':
        this.processedAt.delete(slot);
        break;
      default:
        break;
    }

    return {
      slotUpdate,
      watermark: watermarkChanged ? this.snapshot() : undefined,
      lag,
    };
  }

  snapshot(): Watermarks {
    return { ...this.watermarks };
  }

  reset(): void {
    this.processedAt.clear();
  }

  private advance(level: keyof typeof COMMITMENT_LEVELS, slot: number): boolean {
    const key = COMMITMENT_LEVELS[level];
    if (slot <= this.watermarks[key]) return false; // replayed/older — never regress
    this.watermarks[key] = slot;
    return true;
  }

  private rememberProcessed(slot: number, observedAt: number): void {
    this.processedAt.set(slot, observedAt);
    while (this.processedAt.size > this.maxProcessedEntries) {
      const oldest = this.processedAt.keys().next().value; // insertion order = oldest first
      if (oldest === undefined) break;
      this.processedAt.delete(oldest);
    }
  }

  private takeLag(slot: number, confirmedAt: number): LagSample | undefined {
    const processedAt = this.processedAt.get(slot);
    if (processedAt === undefined) return undefined;
    this.processedAt.delete(slot);
    return { slot, processedAt, confirmedAt, deltaMs: confirmedAt - processedAt };
  }
}
