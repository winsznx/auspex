/**
 * C2 — Leader Window Tracker (hot path).
 *
 * Bundles only land while a Jito-Solana validator is the slot leader, and leaders
 * hold 4 consecutive slots. This tracker answers "Jito leader in N slots?" and
 * surfaces leader skips, deterministically and off a free public RPC.
 *
 * Source (verified D6, no new dependency, no funded wallet):
 *  - `getEpochInfo` → epochFirstSlot = absoluteSlot - slotIndex.
 *  - `getLeaderSchedule(null)` → { identity: relativeSlotIdx[] } for the epoch.
 *  - kobe (`kobe.mainnet.jito.network/api/v1/validators`) → the Jito validator set
 *    (~96% slot coverage). The intersection is the set of Jito leader windows.
 *  - `getNextScheduledLeader` is gRPC-only (Jito SDK) and intentionally NOT used.
 *
 * The schedule is 4-aligned per epoch (windowStartRel = relIdx - relIdx%4), so the
 * leader of any slot is a single map lookup; the next Jito window is a binary
 * search over the precomputed sorted window-onset list. That alignment is an
 * empirical fact, not an RPC contract — so it is ASSERTED at build time and a
 * violation raises an error rather than silently mis-mapping a leader (real SOL).
 *
 * SKIP DETECTION SCOPE: `leaderSkip` is emitted on the C1 stream's SLOT_DEAD
 * ('dead') phase. It is structurally wired and unit-correct, but a natural dead
 * slot is rare; live FIRING is exercised by C11 (the fault injector), not asserted
 * by C2's own gate. C2's gate proves window emission + leader-decode-vs-chain only.
 */
import { Connection } from '@solana/web3.js';
import type { AuspexBus } from '../shared/events.ts';
import { logger } from '../shared/logger.ts';
import type { LeaderSkipEvent, LeaderWindowEvent, SlotUpdate } from '../shared/types.ts';

const SLOTS_PER_LEADER = 4;
const ROLLOVER_BACKOFF_MS = 2_000;

interface KobeValidator {
  identity_account?: unknown;
  running_jito?: unknown;
}

interface EpochWindows {
  epoch: number;
  epochFirstSlot: number;
  epochLastSlot: number;
  slotsInEpoch: number;
  leaderByWindowRel: Map<number, string>;
  jitoWindowStartsAbs: number[];
  jitoWindowStartSet: Set<number>;
}

export interface LeaderTrackerHealth {
  ready: boolean;
  epoch: number | undefined;
  epochFirstSlot: number | undefined;
  jitoWindows: number;
  /** Fraction of epoch slots flagged Jito (kobe ∩ schedule) — honest recall of the feed. */
  coverageRatio: number;
  currentSlot: number;
  windowEvents: number;
  skipEvents: number;
}

function lowerBound(sorted: number[], target: number): number | undefined {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length ? sorted[lo] : undefined;
}

export class LeaderWindowTracker {
  private readonly bus: AuspexBus;
  private readonly connection: Connection;
  private readonly kobeUrl: string;

  private windows: EpochWindows | undefined;
  private currentSlot = 0;
  private windowEvents = 0;
  private skipEvents = 0;
  private rebuilding = false;
  private rolloverBackoffUntil = 0;
  private started = false;
  private stopped = false;

  private lastInJitoWindow: boolean | undefined;
  private lastNextWindowSlot: number | undefined;

  private readonly onSlot = (update: SlotUpdate): void => this.handleSlot(update);

  constructor(deps: { bus: AuspexBus; rpcUrl: string; kobeUrl: string }) {
    this.bus = deps.bus;
    this.connection = new Connection(deps.rpcUrl, 'confirmed');
    this.kobeUrl = deps.kobeUrl;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.windows = await this.buildEpochWindows();
    this.bus.on('slot', this.onSlot);
    logger.info(
      {
        epoch: this.windows.epoch,
        jitoWindows: this.windows.jitoWindowStartsAbs.length,
        coverageRatio: this.coverageRatio(this.windows),
      },
      'leader-window-tracker ready',
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.bus.off('slot', this.onSlot);
  }

  getState(): LeaderTrackerHealth {
    return {
      ready: this.windows !== undefined,
      epoch: this.windows?.epoch,
      epochFirstSlot: this.windows?.epochFirstSlot,
      jitoWindows: this.windows?.jitoWindowStartsAbs.length ?? 0,
      coverageRatio: this.windows ? this.coverageRatio(this.windows) : 0,
      currentSlot: this.currentSlot,
      windowEvents: this.windowEvents,
      skipEvents: this.skipEvents,
    };
  }

  /** Leader (base58 identity) of a given absolute slot, or undefined if outside the cached epoch. */
  leaderOfSlot(absSlot: number): string | undefined {
    const w = this.windows;
    if (!w) return undefined;
    const relIdx = absSlot - w.epochFirstSlot;
    if (relIdx < 0 || relIdx >= w.slotsInEpoch) return undefined;
    return w.leaderByWindowRel.get(relIdx - (relIdx % SLOTS_PER_LEADER));
  }

  private coverageRatio(w: EpochWindows): number {
    return (w.jitoWindowStartsAbs.length * SLOTS_PER_LEADER) / w.slotsInEpoch;
  }

  private windowStartAbs(absSlot: number): number {
    const w = this.windows;
    if (!w) return absSlot;
    const relIdx = absSlot - w.epochFirstSlot;
    return w.epochFirstSlot + (relIdx - (relIdx % SLOTS_PER_LEADER));
  }

  private isJitoSlot(absSlot: number): boolean {
    return this.windows?.jitoWindowStartSet.has(this.windowStartAbs(absSlot)) ?? false;
  }

  private handleSlot(update: SlotUpdate): void {
    if (this.stopped || !this.windows) return;

    if (update.phase === 'dead') {
      this.emitSkip(update.slot);
      return;
    }
    if (update.phase !== 'processed') return;
    if (update.slot <= this.currentSlot) return;
    this.currentSlot = update.slot;

    if (this.currentSlot > this.windows.epochLastSlot) {
      if (Date.now() >= this.rolloverBackoffUntil) void this.rebuildForEpochRollover();
      return;
    }
    this.emitWindowIfChanged();
  }

  private emitWindowIfChanged(): void {
    const inJitoWindow = this.isJitoSlot(this.currentSlot);
    const nextJitoWindowSlot = inJitoWindow
      ? this.windowStartAbs(this.currentSlot)
      : lowerBound(this.windows!.jitoWindowStartsAbs, this.currentSlot);

    if (inJitoWindow === this.lastInJitoWindow && nextJitoWindowSlot === this.lastNextWindowSlot) return;
    this.lastInJitoWindow = inJitoWindow;
    this.lastNextWindowSlot = nextJitoWindowSlot;

    const event: LeaderWindowEvent = {
      currentSlot: this.currentSlot,
      epoch: this.windows!.epoch,
      inJitoWindow,
      leaderIdentity: this.leaderOfSlot(this.currentSlot),
      slotsToNextJitoWindow: inJitoWindow || nextJitoWindowSlot === undefined ? 0 : nextJitoWindowSlot - this.currentSlot,
      nextJitoWindowSlot,
    };
    this.windowEvents += 1;
    this.bus.emit('leaderWindow', event);
  }

  private emitSkip(slot: number): void {
    const event: LeaderSkipEvent = {
      slot,
      windowStartSlot: this.windowStartAbs(slot),
      leaderIdentity: this.leaderOfSlot(slot),
      wasJitoWindow: this.isJitoSlot(slot),
    };
    this.skipEvents += 1;
    this.bus.emit('leaderSkip', event);
  }

  private async rebuildForEpochRollover(): Promise<void> {
    if (this.rebuilding || this.stopped || !this.windows) return;
    this.rebuilding = true;
    const previousEpoch = this.windows.epoch;
    logger.info({ currentSlot: this.currentSlot, previousEpoch }, 'leader-window-tracker rebuilding for epoch rollover');
    try {
      const next = await this.buildEpochWindows();
      if (next.epoch <= previousEpoch) {
        // RPC has not advanced its notion of the current epoch yet — back off so we
        // don't re-download the multi-MB schedule every slot until it catches up.
        this.rolloverBackoffUntil = Date.now() + ROLLOVER_BACKOFF_MS;
        logger.warn({ rpcEpoch: next.epoch, previousEpoch }, 'leader-window-tracker rollover RPC lag — backing off');
        return;
      }
      this.windows = next;
      this.lastInJitoWindow = undefined;
      this.lastNextWindowSlot = undefined;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ err: error.message }, 'leader-window-tracker rollover rebuild failed');
      this.bus.emit('error', error);
    } finally {
      this.rebuilding = false;
    }
  }

  private async buildEpochWindows(): Promise<EpochWindows> {
    const [epochInfo, schedule, kobeSet] = await Promise.all([
      this.connection.getEpochInfo(),
      this.connection.getLeaderSchedule(),
      this.fetchKobeJitoSet(),
    ]);
    if (!schedule) throw new Error('getLeaderSchedule returned null');

    const epochFirstSlot = epochInfo.absoluteSlot - epochInfo.slotIndex;
    const epochLastSlot = epochFirstSlot + epochInfo.slotsInEpoch - 1;

    const leaderByWindowRel = new Map<number, string>();
    const jitoWindowStartSet = new Set<number>();
    let alignmentConflicts = 0;

    for (const [identity, indices] of Object.entries(schedule)) {
      const isJito = kobeSet.has(identity);
      for (const idx of indices) {
        const windowStartRel = idx - (idx % SLOTS_PER_LEADER);
        const existing = leaderByWindowRel.get(windowStartRel);
        if (existing !== undefined && existing !== identity) {
          alignmentConflicts += 1; // two leaders in one 4-slot window ⇒ schedule is NOT 4-aligned
        } else {
          leaderByWindowRel.set(windowStartRel, identity);
        }
        if (isJito) jitoWindowStartSet.add(epochFirstSlot + windowStartRel);
      }
    }

    if (alignmentConflicts > 0) {
      // Detection without refusal is not a fix on a money path: a mis-mapped leader
      // times a bundle to the wrong/non-Jito validator (wasted SOL). Refuse to
      // serve — start() then fails RED; a rollover keeps the previous good windows.
      logger.error({ epoch: epochInfo.epoch, alignmentConflicts }, '4-slot-aligned invariant violated — refusing to serve leader map');
      throw new Error(
        `leader schedule violated the 4-slot-aligned invariant (${alignmentConflicts} window conflicts) — leader decode is unsafe`,
      );
    }

    const jitoWindowStartsAbs = [...jitoWindowStartSet].sort((a, b) => a - b);

    return {
      epoch: epochInfo.epoch,
      epochFirstSlot,
      epochLastSlot,
      slotsInEpoch: epochInfo.slotsInEpoch,
      leaderByWindowRel,
      jitoWindowStartsAbs,
      jitoWindowStartSet,
    };
  }

  private async fetchKobeJitoSet(): Promise<Set<string>> {
    const res = await fetch(this.kobeUrl);
    if (!res.ok) throw new Error(`kobe HTTP ${res.status}`);
    const body = (await res.json()) as { validators?: KobeValidator[] };
    const set = new Set<string>();
    for (const v of body.validators ?? []) {
      if (v.running_jito === true && typeof v.identity_account === 'string') set.add(v.identity_account);
    }
    if (set.size === 0) throw new Error('kobe returned no running_jito validators');
    return set;
  }
}
