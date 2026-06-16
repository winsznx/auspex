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

/** Which feed produced an observation — lag is only comparable within one source. */
export type SlotSourceKind = 'grpc' | 'ws';

/**
 * processed→confirmed timing sample for one slot (network-health signal).
 * NOTE: `deltaMs` is a LOCAL receive-clock delta (when THIS client saw each
 * status), not on-chain time — so it is transport-relative and only comparable
 * within a single `source`. Do not mix sources in one comparison or present it
 * as an on-chain figure a verifier could reproduce from an explorer.
 */
export interface LagSample {
  slot: number;
  processedAt: number;
  confirmedAt: number;
  deltaMs: number;
  source: SlotSourceKind;
}

/**
 * Jito landed-tip percentiles, normalized to LAMPORTS (the endpoint reports SOL).
 * Integers — lamports are indivisible; we round on ingest so every downstream
 * number is a real submittable tip amount, not a float a verifier can't reproduce.
 */
export interface TipPercentiles {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  /** EMA of the 50th percentile — a smoothed trend signal, not a submit target. */
  ema50: number;
}

/** Which Jito feed produced a tip-floor snapshot. */
export type TipFloorSource = 'rest' | 'ws';

/**
 * The current cached tip-floor picture the hot path reads synchronously.
 * `baselineLamports = max(p75, floorLamports)` (PRD §1/§9.3) — the A/B control arm.
 */
export interface TipFloorSnapshot {
  percentiles: TipPercentiles;
  baselineLamports: number;
  floorLamports: number;
  /** Endpoint-reported sample time (ISO) when present — provenance for evidence. */
  sampledAt: string | undefined;
  /** Local receive time (ms epoch). */
  observedAt: number;
  source: TipFloorSource;
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

/**
 * A live slot/commitment feed. Both the Yellowstone gRPC ingestor (C1) and the
 * RPC-WebSocket fallback implement this, so the rest of the stack is
 * source-agnostic. The bounty permits "any compatible Geyser stream provider".
 */
export interface SlotSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): IngestorHealth;
}
