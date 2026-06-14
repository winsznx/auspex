/**
 * Shared types — the contracts between the two planes.
 * No TS `enum` (the Node strip-types runner cannot transform enums) — use
 * string-literal unions + `as const` maps instead.
 */

export type SlotCommitment = 'processed' | 'confirmed' | 'finalized';

/**
 * Non-commitment slot statuses the stream also emits. `dead` matters (the slot
 * was abandoned); the rest are informational.
 */
export type SlotPhase =
  | SlotCommitment
  | 'firstShredReceived'
  | 'completed'
  | 'createdBank'
  | 'dead';

/** Maps the v5 `SlotStatus` numeric enum (from the package) to our labels. */
export const SLOT_STATUS_LABEL = {
  0: 'processed',
  1: 'confirmed',
  2: 'finalized',
  3: 'firstShredReceived',
  4: 'completed',
  5: 'createdBank',
  6: 'dead',
} as const satisfies Record<number, SlotPhase>;

/**
 * Guarded lookup: any out-of-range status (including v5's `-1` UNRECOGNIZED)
 * returns undefined. Keeps the single unchecked cast contained + tested here.
 */
export function slotPhaseFromStatus(status: number): SlotPhase | undefined {
  if (!Number.isInteger(status) || status < 0 || status > 6) return undefined;
  return SLOT_STATUS_LABEL[status as keyof typeof SLOT_STATUS_LABEL];
}

/** A single slot status transition observed on the stream. */
export interface SlotUpdate {
  slot: number;
  parent: number | undefined;
  phase: SlotPhase;
  /** Local receive time (ms epoch) — used for processed→confirmed deltas. */
  observedAt: number;
}

/** Highest slot seen at each commitment level — monotonic, never rewinds. */
export interface Watermarks {
  processed: number;
  confirmed: number;
  finalized: number;
}

/** processed→confirmed timing sample for one slot (network-health signal). */
export interface LagSample {
  slot: number;
  processedAt: number;
  confirmedAt: number;
  deltaMs: number;
}

export type IngestorPhase = 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'stopped';

export interface IngestorHealth {
  phase: IngestorPhase;
  /** ms since the last update of any kind; high = silent stream. */
  msSinceLastUpdate: number;
  watermarks: Watermarks;
  updatesSeen: number;
  reconnects: number;
}
