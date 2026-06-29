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

/**
 * Where we are relative to the next Jito-enabled leader window. Bundles only land
 * while a Jito-Solana validator leads, and leaders hold 4 consecutive slots, so
 * the data plane uses this to time submission. `leaderIdentity` is the leader of
 * the CURRENT slot (base58 identity); undefined if the schedule has no entry.
 */
export interface LeaderWindowEvent {
  currentSlot: number;
  epoch: number;
  inJitoWindow: boolean;
  leaderIdentity: string | undefined;
  /** 0 when currently inside a Jito window. */
  slotsToNextJitoWindow: number;
  nextJitoWindowSlot: number | undefined;
}

/** A slot whose leader produced no block (SLOT_DEAD). A full 4-slot dead window = missed bundle. */
export interface LeaderSkipEvent {
  slot: number;
  windowStartSlot: number;
  leaderIdentity: string | undefined;
  wasJitoWindow: boolean;
}

/** Wire encoding of a serialized transaction — Jito `sendBundle` accepts either. */
export type TransactionEncoding = 'base58' | 'base64';

/** The Jito tip carried as the bundle's last instruction. */
export interface BundleTip {
  /** Tip account (base58) — one of the block engine's `getTipAccounts`. */
  account: string;
  lamports: number;
}

/**
 * A fully-signed, well-formed single-transaction bundle — construct-valid, not
 * yet proven submittable (no simulate/submit until a funded wallet exists). C4
 * builds + signs + validates this on the free RPC; C5 submits it.
 * `encodedTransaction` is the wire payload Jito `sendBundle` expects (with
 * `encoding`). Nothing here is broadcast — holding a `BuiltBundle` moves no SOL.
 *
 * PERISHABLE: the blockhash is valid for ~150 slots from `builtAt`. A consumer
 * that holds a bundle before submitting MUST re-check liveness (compare
 * `getBlockHeight` against `lastValidBlockHeight`, or call `isBlockhashValid`)
 * immediately before `sendBundle` — a stale blockhash drops the bundle and
 * wastes the tip.
 */
export interface BuiltBundle {
  encodedTransaction: string;
  encoding: TransactionEncoding;
  /** Base58 transaction signature (the bundle's identity for lifecycle tracking). */
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Fee payer / source wallet (base58). */
  payer: string;
  tip: BundleTip;
  /** Lamports moved by the self-transfer leg (distinct from the tip + fee). */
  selfTransferLamports: number;
  builtAt: number;
}

/**
 * The receipt of a real `sendBundle` submission (C5). `bundleId` is Jito's
 * SHA-256 of the bundle's transaction signatures (base58) — the identity used
 * to poll lifecycle (C6). `signature` is the on-chain transaction signature a
 * verifier looks up on Solscan. `encoding` records what we actually submitted
 * with (base58 by default; base64 only if a decode-fallback fired).
 */
export interface SubmittedBundle {
  bundleId: string;
  signature: string;
  encoding: TransactionEncoding;
  blockhash: string;
  lastValidBlockHeight: number;
  tip: BundleTip;
  payer: string;
  submittedAt: number;
}

/** getInflightBundleStatuses status — Jito's 5-minute-lookback verdict. */
export type JitoInflightStatusValue = 'Invalid' | 'Pending' | 'Failed' | 'Landed';

/** One entry of a `getInflightBundleStatuses` response (null if not found). */
export interface JitoInflightStatus {
  bundleId: string;
  status: JitoInflightStatusValue;
  landedSlot: number | null;
}

/**
 * One entry of a `getBundleStatuses` response (null if not found). `err` is
 * Jito's `{ Ok: null }` on success or a transaction error object otherwise.
 */
export interface JitoBundleStatus {
  bundleId: string;
  transactions: string[];
  slot: number;
  confirmationStatus: SlotCommitment;
  err: unknown;
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
 * Solana PubSub WebSocket source implement this, so the rest of the stack is
 * source-agnostic. The WebSocket source is real mainnet telemetry, but it is not
 * claimed as Yellowstone/Geyser evidence.
 */
export interface SlotSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): IngestorHealth;
}
