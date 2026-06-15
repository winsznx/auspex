/**
 * C1 — Stream Ingestor (hot path), Yellowstone v5 slot source.
 *
 * Subscribes to slot status transitions and feeds the shared SlotStateTracker
 * (monotonic processed/confirmed/finalized watermarks + processed→confirmed
 * lag). Deterministic, never awaits the LLM. Implements `SlotSource` so the
 * stack is source-agnostic.
 *
 * Reconnect model (verified v5 facts — do not re-derive):
 *  - Built-in reconnect (`{ enabled:true, slotRetention:150 }`) owns transient
 *    drops transparently; we do NOT hand-roll that loop.
 *  - The Duplex emits `error`/`close` only when built-in reconnect has
 *    TERMINALLY given up — we treat that as fatal and rebuild a fresh `Client`.
 *  - A silence watchdog backstops a native hang that never surfaces error/close.
 *
 * Other v5 facts: `subscribe(req)` returns a Node Duplex (teardown `.destroy()`);
 * uint64 (`slot`,`parent`) arrive as STRINGS → `Number()`; slots filter
 * `{ filterByCommitment:false }` emits every status transition.
 */
import Client, {
  CommitmentLevel,
  type SubscribeRequest,
  type SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import type { AuspexBus } from '../shared/events.ts';
import { logger } from '../shared/logger.ts';
import { SlotStateTracker } from '../shared/slot-state.ts';
import { slotPhaseFromStatus } from '../shared/types.ts';
import type { IngestorHealth, IngestorPhase, SlotSource } from '../shared/types.ts';
import type { YellowstoneConfig } from '../config.ts';

type Stream = Awaited<ReturnType<Client['subscribe']>>;

export interface StreamIngestorOptions {
  /** Stream considered hung after this long with no update (ms). */
  silenceTimeoutMs: number;
  /** Health watchdog tick interval (ms). */
  watchdogIntervalMs: number;
  /** Delay before rebuilding the client after a terminal failure (ms). */
  rebuildDelayMs: number;
  /** Hard cap on retained processed→confirmed timestamps (eviction-bounded). */
  maxProcessedEntries: number;
}

const DEFAULT_OPTIONS: StreamIngestorOptions = {
  silenceTimeoutMs: 30_000,
  watchdogIntervalMs: 2_000,
  rebuildDelayMs: 1_000,
  maxProcessedEntries: 1_024,
};

export class StreamIngestor implements SlotSource {
  private readonly bus: AuspexBus;
  private readonly config: YellowstoneConfig;
  private readonly options: StreamIngestorOptions;
  private readonly tracker: SlotStateTracker;

  private client: Client | undefined;
  private stream: Stream | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;

  private phase: IngestorPhase = 'idle';
  private lastUpdateAt = 0;
  private updatesSeen = 0;
  private reconnects = 0;
  private rebuilding = false;

  constructor(deps: { bus: AuspexBus; config: YellowstoneConfig; options?: Partial<StreamIngestorOptions> }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
    this.tracker = new SlotStateTracker('grpc', this.options.maxProcessedEntries);
  }

  async start(): Promise<void> {
    this.createClient();
    await this.openStream();
    this.watchdog = setInterval(() => this.tickWatchdog(), this.options.watchdogIntervalMs);
  }

  async stop(): Promise<void> {
    this.setPhase('stopped');
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = undefined;
    }
    this.teardownStream();
    this.client = undefined;
  }

  getState(): IngestorHealth {
    return {
      phase: this.phase,
      msSinceLastUpdate: this.msSinceLastUpdate(),
      watermarks: this.tracker.snapshot(),
      updatesSeen: this.updatesSeen,
      reconnects: this.reconnects,
    };
  }

  private createClient(): void {
    this.client = new Client(this.config.endpoint, this.config.xToken, undefined, {
      enabled: true,
      slotRetention: 150,
    });
  }

  private async openStream(): Promise<void> {
    if (!this.client) throw new Error('StreamIngestor.openStream called without a client');
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
    stream.on('error', (err: Error) => this.onTerminal('stream-error', err));
    stream.on('close', () => this.onTerminal('stream-close'));
    this.stream = stream;
    // Start the silence clock now so an initial hang (subscribe resolves but no
    // data ever flows) is still caught by the watchdog.
    this.lastUpdateAt = Date.now();
    this.setPhase('streaming');
    logger.info({ endpoint: this.config.endpoint }, 'stream-ingestor subscribed');
  }

  private onUpdate(update: SubscribeUpdate): void {
    this.lastUpdateAt = Date.now();
    if (this.phase === 'reconnecting') this.setPhase('streaming');

    const slotUpdate = update.slot;
    if (!slotUpdate) return;

    const phase = slotPhaseFromStatus(slotUpdate.status);
    if (!phase) return;

    const slot = Number(slotUpdate.slot);
    if (!Number.isFinite(slot)) return;
    const parent = slotUpdate.parent !== undefined ? Number(slotUpdate.parent) : undefined;

    this.updatesSeen += 1;
    const obs = this.tracker.observe(slot, parent, phase, this.lastUpdateAt);
    this.bus.emit('slot', obs.slotUpdate);
    if (obs.lag) this.bus.emit('lag', obs.lag);
    if (obs.watermark) this.bus.emit('watermark', obs.watermark);
  }

  private onTerminal(reason: string, err?: Error): void {
    if (err) {
      logger.warn({ reason, err: err.message }, 'stream-ingestor terminal stream event');
      this.bus.emit('error', err);
    } else {
      logger.warn({ reason }, 'stream-ingestor terminal stream event');
    }
    this.scheduleRebuild(reason);
  }

  private tickWatchdog(): void {
    if (this.phase === 'stopped') return;
    this.bus.emit('health', this.getState());
    const silentFor = this.msSinceLastUpdate();
    if (Number.isFinite(silentFor) && silentFor > this.options.silenceTimeoutMs) {
      this.scheduleRebuild('silence');
    }
  }

  /**
   * Full rebuild: built-in reconnect has terminally failed or the native layer
   * is silently hung. Re-arming reconnect on an existing client is unproven, so
   * we drop it and construct a fresh `Client`.
   */
  private scheduleRebuild(reason: string): void {
    if (this.rebuilding || this.phase === 'stopped') return;
    this.rebuilding = true;
    this.reconnects += 1;
    this.setPhase('reconnecting');
    logger.warn({ reason, reconnects: this.reconnects }, 'stream-ingestor rebuilding client');

    this.teardownStream();
    this.client = undefined;
    this.tracker.reset();
    this.lastUpdateAt = Date.now(); // grant the new stream a full silence window

    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      if (this.phase === 'stopped') {
        this.rebuilding = false;
        return;
      }
      this.createClient();
      this.openStream()
        .catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error({ err: error.message }, 'stream-ingestor rebuild failed');
          this.bus.emit('error', error);
        })
        .finally(() => {
          this.rebuilding = false;
        });
    }, this.options.rebuildDelayMs);
  }

  private teardownStream(): void {
    if (!this.stream) return;
    this.stream.removeAllListeners();
    this.stream.destroy();
    this.stream = undefined;
  }

  private msSinceLastUpdate(): number {
    return this.lastUpdateAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastUpdateAt;
  }

  private setPhase(phase: IngestorPhase): void {
    this.phase = phase;
  }
}
