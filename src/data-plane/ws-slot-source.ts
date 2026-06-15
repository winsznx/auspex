/**
 * RPC-WebSocket slot source — the free fallback for C1's Yellowstone gRPC feed.
 *
 * The bounty allows "any compatible Geyser stream provider"; standard Solana RPC
 * exposes `slotsUpdatesSubscribe` (via web3.js `onSlotUpdate`) over a free
 * WebSocket, which carries the same commitment progression we need. We map its
 * `type` to our SlotPhase and feed the SAME SlotStateTracker the gRPC ingestor
 * uses, so watermarks + processed→confirmed lag are computed identically.
 *
 * Phase mapping (web3 SlotUpdate.type → SlotPhase):
 *   frozen → processed (node finished executing the slot's bank)
 *   optimisticConfirmation → confirmed (supermajority optimistic vote)
 *   root → finalized
 * createdBank/firstShredReceived/completed/dead pass through informationally.
 *
 * web3.js Connection manages WebSocket reconnection + resubscription itself, so
 * this source does not hand-roll reconnect; it exposes the same `SlotSource`
 * health surface for parity.
 */
import { Connection, type SlotUpdate as Web3SlotUpdate } from '@solana/web3.js';
import type { AuspexBus } from '../shared/events.ts';
import { logger } from '../shared/logger.ts';
import { SlotStateTracker } from '../shared/slot-state.ts';
import type { IngestorHealth, IngestorPhase, SlotPhase, SlotSource } from '../shared/types.ts';

const WS_PHASE: Record<Web3SlotUpdate['type'], SlotPhase | undefined> = {
  firstShredReceived: 'firstShredReceived',
  completed: 'completed',
  createdBank: 'createdBank',
  frozen: 'processed',
  optimisticConfirmation: 'confirmed',
  root: 'finalized',
  dead: 'dead',
};

export interface WebSocketSlotSourceOptions {
  watchdogIntervalMs: number;
  maxProcessedEntries: number;
}

const DEFAULT_OPTIONS: WebSocketSlotSourceOptions = {
  watchdogIntervalMs: 2_000,
  maxProcessedEntries: 1_024,
};

export class WebSocketSlotSource implements SlotSource {
  private readonly bus: AuspexBus;
  private readonly rpcUrl: string;
  private readonly options: WebSocketSlotSourceOptions;
  private readonly tracker: SlotStateTracker;

  private connection: Connection | undefined;
  private subscriptionId: number | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;

  private phase: IngestorPhase = 'idle';
  private lastUpdateAt = 0;
  private updatesSeen = 0;

  constructor(deps: { bus: AuspexBus; rpcUrl: string; options?: Partial<WebSocketSlotSourceOptions> }) {
    this.bus = deps.bus;
    this.rpcUrl = deps.rpcUrl;
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
    this.tracker = new SlotStateTracker(this.options.maxProcessedEntries);
  }

  async start(): Promise<void> {
    this.phase = 'connecting';
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    this.subscriptionId = this.connection.onSlotUpdate((update) => this.onUpdate(update));
    this.lastUpdateAt = Date.now();
    this.phase = 'streaming';
    this.watchdog = setInterval(() => this.tick(), this.options.watchdogIntervalMs);
    logger.info({ rpcUrl: this.rpcUrl }, 'ws-slot-source subscribed');
  }

  async stop(): Promise<void> {
    this.phase = 'stopped';
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    if (this.connection && this.subscriptionId !== undefined) {
      await this.connection.removeSlotUpdateListener(this.subscriptionId);
    }
    this.subscriptionId = undefined;
    this.connection = undefined;
  }

  getState(): IngestorHealth {
    return {
      phase: this.phase,
      msSinceLastUpdate: this.lastUpdateAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastUpdateAt,
      watermarks: this.tracker.snapshot(),
      updatesSeen: this.updatesSeen,
      reconnects: 0, // web3.js manages WS reconnection internally
    };
  }

  private onUpdate(update: Web3SlotUpdate): void {
    this.lastUpdateAt = Date.now();
    const phase = WS_PHASE[update.type];
    if (!phase) return;

    const parent = update.type === 'createdBank' ? update.parent : undefined;
    this.updatesSeen += 1;
    const obs = this.tracker.observe(update.slot, parent, phase, this.lastUpdateAt);
    this.bus.emit('slot', obs.slotUpdate);
    if (obs.lag) this.bus.emit('lag', obs.lag);
    if (obs.watermark) this.bus.emit('watermark', obs.watermark);
  }

  private tick(): void {
    if (this.phase === 'stopped') return;
    this.bus.emit('health', this.getState());
  }
}
