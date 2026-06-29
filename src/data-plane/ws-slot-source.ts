/**
 * Solana PubSub WebSocket slot source — the available C1 stream with today's env.
 *
 * Standard Solana RPC exposes `slotsUpdatesSubscribe` through web3.js
 * `onSlotUpdate`. It is useful for development and judge demos because it shows
 * live commitment progression, but it is not Dragon's Mouth, not Yellowstone,
 * and not a replacement for a real Geyser/gRPC upstream.
 *
 * Phase mapping: frozen -> processed, optimisticConfirmation -> confirmed, root ->
 * finalized; createdBank/firstShredReceived/completed/dead pass through.
 *
 * AVAILABLE-INFRA ONLY — NOT on the Dragon's Mouth evidence path until C1 (gRPC)
 * has passed its live gate. Two honesty caveats vs gRPC: (1) lag here is local-receive-clock
 * and is tagged `source:'ws'`; never mix with gRPC lag; (2) many providers do
 * not enable `slotsUpdatesSubscribe` ("unstable"), so we stay in `connecting`
 * and never claim `streaming` until a real update arrives.
 */
import { Connection, type SlotUpdate as Web3SlotUpdate } from '@solana/web3.js';
import type { AuspexBus } from '../shared/events.ts';
import { logger } from '../shared/logger.ts';
import { redactUrl } from '../shared/redact.ts';
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
  silenceTimeoutMs: number;
  watchdogIntervalMs: number;
  maxProcessedEntries: number;
}

const DEFAULT_OPTIONS: WebSocketSlotSourceOptions = {
  silenceTimeoutMs: 30_000,
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
  private reconnects = 0;
  private rebuilding = false;

  constructor(deps: { bus: AuspexBus; rpcUrl: string; options?: Partial<WebSocketSlotSourceOptions> }) {
    this.bus = deps.bus;
    this.rpcUrl = deps.rpcUrl;
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
    this.tracker = new SlotStateTracker('ws', this.options.maxProcessedEntries);
  }

  async start(): Promise<void> {
    await this.subscribe();
    this.watchdog = setInterval(() => this.tickWatchdog(), this.options.watchdogIntervalMs);
  }

  async stop(): Promise<void> {
    this.phase = 'stopped';
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    await this.unsubscribe();
  }

  getState(): IngestorHealth {
    return {
      phase: this.phase,
      msSinceLastUpdate: this.lastUpdateAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastUpdateAt,
      watermarks: this.tracker.snapshot(),
      updatesSeen: this.updatesSeen,
      reconnects: this.reconnects,
    };
  }

  private async subscribe(): Promise<void> {
    // Stay 'connecting' until the FIRST real update — never claim 'streaming'
    // for an endpoint that may not support slotsUpdatesSubscribe.
    this.phase = 'connecting';
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    this.subscriptionId = this.connection.onSlotUpdate((update) => this.onUpdate(update));
    this.lastUpdateAt = Date.now(); // start the silence clock now
    logger.info({ rpcUrl: redactUrl(this.rpcUrl) }, 'ws-slot-source subscribing');
  }

  private async unsubscribe(): Promise<void> {
    if (this.connection && this.subscriptionId !== undefined) {
      try {
        await this.connection.removeSlotUpdateListener(this.subscriptionId);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ws-slot-source unsubscribe failed');
      }
    }
    this.subscriptionId = undefined;
    this.connection = undefined;
  }

  private onUpdate(update: Web3SlotUpdate): void {
    this.lastUpdateAt = Date.now();
    if (this.phase !== 'stopped') this.phase = 'streaming';
    const phase = WS_PHASE[update.type];
    if (!phase) return;

    const parent = update.type === 'createdBank' ? update.parent : undefined;
    this.updatesSeen += 1;
    const obs = this.tracker.observe(update.slot, parent, phase, this.lastUpdateAt);
    this.bus.emit('slot', obs.slotUpdate);
    if (obs.lag) this.bus.emit('lag', obs.lag);
    if (obs.watermark) this.bus.emit('watermark', obs.watermark);
  }

  private tickWatchdog(): void {
    if (this.phase === 'stopped') return;
    this.bus.emit('health', this.getState());
    const silentFor = this.lastUpdateAt === 0 ? 0 : Date.now() - this.lastUpdateAt;
    if (silentFor > this.options.silenceTimeoutMs) {
      void this.rebuild();
    }
  }

  /**
   * web3.js auto-reconnect does not cover a wedged half-open socket or an
   * endpoint that never pushes slot updates — so on prolonged silence we
   * recreate the Connection from scratch.
   */
  private async rebuild(): Promise<void> {
    if (this.rebuilding || this.phase === 'stopped') return;
    this.rebuilding = true;
    this.reconnects += 1;
    this.phase = 'reconnecting';
    logger.warn({ reconnects: this.reconnects }, 'ws-slot-source rebuilding connection (silence)');
    try {
      await this.unsubscribe();
      this.tracker.reset();
      if (!this.isStopped()) await this.subscribe();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ err: error.message }, 'ws-slot-source rebuild failed');
      this.bus.emit('error', error);
    } finally {
      this.rebuilding = false;
    }
  }

  private isStopped(): boolean {
    return this.phase === 'stopped';
  }
}
