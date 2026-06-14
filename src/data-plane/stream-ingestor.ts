/**
 * C1 — Stream Ingestor (hot path).
 *
 * Subscribes to Yellowstone v5 slot status transitions and maintains the
 * authoritative processed/confirmed/finalized watermarks plus the
 * processed→confirmed timing signal. Deterministic, never awaits the LLM.
 *
 * Verified v5 facts baked in (do not re-derive):
 *  - `new Client(endpoint, xToken, channelOptions?, reconnectOptions?)`; enable
 *    built-in reconnect (`slotRetention: 150`) — no hand-rolled reconnect loop,
 *    only a hard-silence backstop on top.
 *  - `subscribe(req)` returns a Node Duplex; teardown is `.destroy()`.
 *  - uint64 fields (`slot`, `parent`) arrive as STRINGS → `Number()` them.
 *  - slots filter `{ filterByCommitment: false }` emits every status transition.
 *  - `SlotStatus` numeric enum 0..6 → mapped via SLOT_STATUS_LABEL.
 */
import Client, {
  CommitmentLevel,
  type SubscribeRequest,
  type SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import type { AuspexBus } from '../shared/events.ts';
import { logger } from '../shared/logger.ts';
import { SLOT_STATUS_LABEL } from '../shared/types.ts';
import type {
  IngestorHealth,
  IngestorPhase,
  SlotPhase,
  SlotUpdate,
  Watermarks,
} from '../shared/types.ts';
import type { YellowstoneConfig } from '../config.ts';

type Stream = Awaited<ReturnType<Client['subscribe']>>;

export interface StreamIngestorOptions {
  /** Stream considered silent after this long with no update (ms). */
  silenceTimeoutMs: number;
  /** Health watchdog tick interval (ms). */
  watchdogIntervalMs: number;
  /** Slots of processed→confirmed history to retain before pruning. */
  lagRetentionSlots: number;
}

const DEFAULT_OPTIONS: StreamIngestorOptions = {
  silenceTimeoutMs: 30_000,
  watchdogIntervalMs: 2_000,
  lagRetentionSlots: 150,
};

const COMMITMENT_PHASES: ReadonlySet<SlotPhase> = new Set(['processed', 'confirmed', 'finalized']);

export class StreamIngestor {
  private readonly bus: AuspexBus;
  private readonly config: YellowstoneConfig;
  private readonly options: StreamIngestorOptions;

  private client: Client | undefined;
  private stream: Stream | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;

  private phase: IngestorPhase = 'idle';
  private readonly watermarks: Watermarks = { processed: 0, confirmed: 0, finalized: 0 };
  private readonly processedAt = new Map<number, number>();
  private lastUpdateAt = 0;
  private updatesSeen = 0;
  private reconnects = 0;
  private restarting = false;

  constructor(deps: { bus: AuspexBus; config: YellowstoneConfig; options?: Partial<StreamIngestorOptions> }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
  }

  async start(): Promise<void> {
    this.client = new Client(this.config.endpoint, this.config.xToken, undefined, {
      enabled: true,
      slotRetention: 150,
    });
    await this.openStream();
    this.watchdog = setInterval(() => this.tickWatchdog(), this.options.watchdogIntervalMs);
  }

  async stop(): Promise<void> {
    this.setPhase('stopped');
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    this.teardownStream();
    this.client = undefined;
  }

  getState(): IngestorHealth {
    return {
      phase: this.phase,
      msSinceLastUpdate: this.lastUpdateAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastUpdateAt,
      watermarks: { ...this.watermarks },
      updatesSeen: this.updatesSeen,
      reconnects: this.reconnects,
    };
  }

  private async openStream(): Promise<void> {
    if (!this.client) throw new Error('StreamIngestor.openStream called before start()');
    this.setPhase('connecting');
    const request: SubscribeRequest = {
      accounts: {},
      slots: { auspex: { filterByCommitment: false } },
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
    };
    const stream = await this.client.subscribe(request);
    stream.on('data', (update: SubscribeUpdate) => this.onUpdate(update));
    stream.on('error', (err: Error) => this.onStreamError(err));
    stream.on('close', () => this.onStreamClose());
    this.stream = stream;
    this.setPhase('streaming');
    logger.info({ endpoint: this.config.endpoint }, 'stream-ingestor subscribed');
  }

  private onUpdate(update: SubscribeUpdate): void {
    this.lastUpdateAt = Date.now();
    if (this.phase === 'reconnecting') this.setPhase('streaming');
    const slotUpdate = update.slot;
    if (!slotUpdate) return;

    const phase = SLOT_STATUS_LABEL[slotUpdate.status as keyof typeof SLOT_STATUS_LABEL];
    if (!phase) return;

    const slot = Number(slotUpdate.slot);
    if (!Number.isFinite(slot)) return;
    const parent = slotUpdate.parent !== undefined ? Number(slotUpdate.parent) : undefined;

    this.updatesSeen += 1;
    const event: SlotUpdate = { slot, parent, phase, observedAt: this.lastUpdateAt };
    this.bus.emit('slot', event);

    if (phase === 'processed') {
      this.processedAt.set(slot, event.observedAt);
    } else if (phase === 'confirmed') {
      this.recordLag(slot, event.observedAt);
    }

    if (COMMITMENT_PHASES.has(phase)) this.advanceWatermark(phase as keyof Watermarks, slot);
  }

  private advanceWatermark(level: keyof Watermarks, slot: number): void {
    if (slot <= this.watermarks[level]) return;
    this.watermarks[level] = slot;
    this.bus.emit('watermark', { ...this.watermarks });
  }

  private recordLag(slot: number, confirmedAt: number): void {
    const processedAt = this.processedAt.get(slot);
    if (processedAt !== undefined) {
      this.processedAt.delete(slot);
      this.bus.emit('lag', { slot, processedAt, confirmedAt, deltaMs: confirmedAt - processedAt });
    }
    this.pruneProcessed(slot);
  }

  private pruneProcessed(confirmedSlot: number): void {
    const cutoff = confirmedSlot - this.options.lagRetentionSlots;
    for (const slot of this.processedAt.keys()) {
      if (slot < cutoff) this.processedAt.delete(slot);
    }
  }

  private onStreamError(err: Error): void {
    logger.warn({ err: err.message }, 'stream-ingestor stream error');
    this.bus.emit('error', err);
    this.scheduleRestart();
  }

  private onStreamClose(): void {
    if (this.phase === 'stopped') return;
    logger.warn('stream-ingestor stream closed');
    this.scheduleRestart();
  }

  private tickWatchdog(): void {
    if (this.phase === 'stopped') return;
    this.bus.emit('health', this.getState());
    const silentFor = this.lastUpdateAt === 0 ? 0 : Date.now() - this.lastUpdateAt;
    if (this.lastUpdateAt !== 0 && silentFor > this.options.silenceTimeoutMs) {
      logger.warn({ silentFor }, 'stream-ingestor silent past timeout — restarting');
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.restarting || this.phase === 'stopped' || !this.client) return;
    this.restarting = true;
    this.reconnects += 1;
    this.setPhase('reconnecting');
    this.teardownStream();
    this.openStream()
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ err: error.message }, 'stream-ingestor restart failed');
        this.bus.emit('error', error);
      })
      .finally(() => {
        this.restarting = false;
      });
  }

  private teardownStream(): void {
    if (!this.stream) return;
    this.stream.removeAllListeners();
    this.stream.destroy();
    this.stream = undefined;
  }

  private setPhase(phase: IngestorPhase): void {
    this.phase = phase;
  }
}
