/**
 * C3 — Tip-Floor Client + Baseline (hot path).
 *
 * Tracks Jito's live landed-tip percentiles and derives the A/B control arm:
 *   baseline = max(p75, floor)   (PRD §1/§9.3)
 * The hot path reads `getSnapshot()` SYNCHRONOUSLY — the cache is always the
 * latest known floor; nothing here awaits the network on the submit path.
 *
 * Two feeds into ONE cache:
 *  - WS `tip_stream` is primary (server-pushed, ~every 20–30s).
 *  - REST `tip_floor` seeds the cache on start (so the hot path is never empty)
 *    and backstops the WS as a periodic poll, so a wedged/blocked socket can
 *    never staleness-poison the baseline.
 *
 * Verified live (2026-06-16): both endpoints return `[{ time,
 * landed_tips_{25,50,75,95,99}th_percentile, ema_landed_tips_50th_percentile }]`
 * with values in SOL. We normalize to integer LAMPORTS on ingest so every
 * downstream tip is a real, submittable amount.
 */
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { AuspexBus } from '../shared/events.ts';
import { logger } from '../shared/logger.ts';
import type { TipFloorConfig } from '../config.ts';
import type { TipFloorSnapshot, TipFloorSource, TipPercentiles } from '../shared/types.ts';

interface RawTipFloor {
  time?: unknown;
  landed_tips_25th_percentile?: unknown;
  landed_tips_50th_percentile?: unknown;
  landed_tips_75th_percentile?: unknown;
  landed_tips_95th_percentile?: unknown;
  landed_tips_99th_percentile?: unknown;
  ema_landed_tips_50th_percentile?: unknown;
}

export interface TipFloorClientOptions {
  /** Backstop REST poll interval (ms). */
  restRefreshMs: number;
  /** Force a WS rebuild after this long with no message (ms). */
  wsSilenceMs: number;
  /** WS reconnect backoff floor / ceiling (ms). */
  wsReconnectBaseMs: number;
  wsReconnectMaxMs: number;
  /**
   * Past this age, `getSnapshot()` fails CLOSED (returns undefined) so the hot
   * path cannot tip on a stale floor. `observedAt` only advances on a genuinely
   * newer sample (see the monotonic guard in `ingest`), so this also catches a
   * server-side-frozen feed, not just a dead socket.
   */
  maxAgeMs: number;
}

const DEFAULT_OPTIONS: TipFloorClientOptions = {
  restRefreshMs: 30_000,
  wsSilenceMs: 60_000,
  wsReconnectBaseMs: 1_000,
  wsReconnectMaxMs: 30_000,
  maxAgeMs: 90_000,
};

export interface TipFloorHealth {
  hasSnapshot: boolean;
  stale: boolean;
  source: TipFloorSource | undefined;
  ageMs: number;
  updatesSeen: number;
  wsConnected: boolean;
  wsReconnects: number;
}

function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

function asFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parsePayload(raw: unknown): { percentiles: TipPercentiles; sampledAt: string | undefined } | undefined {
  const row = (Array.isArray(raw) ? raw[0] : raw) as RawTipFloor | undefined;
  if (!row || typeof row !== 'object') return undefined;

  const p25 = asFinite(row.landed_tips_25th_percentile);
  const p50 = asFinite(row.landed_tips_50th_percentile);
  const p75 = asFinite(row.landed_tips_75th_percentile);
  const p95 = asFinite(row.landed_tips_95th_percentile);
  const p99 = asFinite(row.landed_tips_99th_percentile);
  const ema50 = asFinite(row.ema_landed_tips_50th_percentile);
  if (p25 === undefined || p50 === undefined || p75 === undefined || p95 === undefined || p99 === undefined || ema50 === undefined) {
    return undefined;
  }

  return {
    percentiles: {
      p25: solToLamports(p25),
      p50: solToLamports(p50),
      p75: solToLamports(p75),
      p95: solToLamports(p95),
      p99: solToLamports(p99),
      ema50: solToLamports(ema50),
    },
    sampledAt: typeof row.time === 'string' ? row.time : undefined,
  };
}

export class TipFloorClient {
  private readonly bus: AuspexBus;
  private readonly config: TipFloorConfig;
  private readonly options: TipFloorClientOptions;

  private snapshot: TipFloorSnapshot | undefined;
  private socket: WebSocket | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private stopped = false;
  private updatesSeen = 0;
  private wsReconnects = 0;
  private reconnectAttempt = 0;
  private lastWsMessageAt = 0;
  /** Server sample time (epoch ms) of the cached floor — used to reject out-of-order ingests. */
  private lastSampleMs = Number.NEGATIVE_INFINITY;

  constructor(deps: { bus: AuspexBus; config: TipFloorConfig; options?: Partial<TipFloorClientOptions> }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refreshRest();
    this.openSocket();
    this.pollTimer = setInterval(() => void this.refreshRest(), this.options.restRefreshMs);
    // Poll faster than the silence threshold so a wedged feed is detected within
    // ~5s rather than only once per wsSilenceMs window.
    this.watchdog = setInterval(() => this.tickWatchdog(), Math.min(this.options.wsSilenceMs, 5_000));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = this.watchdog = this.reconnectTimer = undefined;
    this.closeSocket();
  }

  /**
   * Synchronous hot-path read. Returns undefined before the first ingest OR once
   * the cache exceeds `maxAgeMs` — so a forgetful consumer fails CLOSED (no tip /
   * hold) instead of tipping on a stale floor. Pair with `getHealth()` for the
   * raw age when you need to log why it's missing.
   */
  getSnapshot(): TipFloorSnapshot | undefined {
    if (this.snapshot === undefined) return undefined;
    if (Date.now() - this.snapshot.observedAt > this.options.maxAgeMs) return undefined;
    return this.snapshot;
  }

  getHealth(): TipFloorHealth {
    const ageMs = this.snapshot === undefined ? Number.POSITIVE_INFINITY : Date.now() - this.snapshot.observedAt;
    return {
      hasSnapshot: this.snapshot !== undefined,
      stale: ageMs > this.options.maxAgeMs,
      source: this.snapshot?.source,
      ageMs,
      updatesSeen: this.updatesSeen,
      wsConnected: this.socket?.readyState === WebSocket.OPEN,
      wsReconnects: this.wsReconnects,
    };
  }

  private ingest(parsed: { percentiles: TipPercentiles; sampledAt: string | undefined }, source: TipFloorSource): void {
    const sampleMs = parsed.sampledAt !== undefined ? Date.parse(parsed.sampledAt) : Number.NaN;
    // Reject a sample that is not newer than what's cached: a 30s REST backstop
    // can return the SAME or an OLDER row than a just-arrived WS push. Writing it
    // would regress the floor AND reset observedAt — masking the staleness. Only
    // ingest when server time advances (or is absent and we can't order).
    if (Number.isFinite(sampleMs) && sampleMs <= this.lastSampleMs) return;
    if (Number.isFinite(sampleMs)) this.lastSampleMs = sampleMs;

    const baselineLamports = Math.max(parsed.percentiles.p75, this.config.floorLamports);
    this.snapshot = {
      percentiles: parsed.percentiles,
      baselineLamports,
      floorLamports: this.config.floorLamports,
      sampledAt: parsed.sampledAt,
      observedAt: Date.now(),
      source,
    };
    this.updatesSeen += 1;
    this.bus.emit('tipFloor', this.snapshot);
  }

  private async refreshRest(): Promise<void> {
    if (this.stopped) return;
    try {
      const res = await fetch(this.config.restUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parsePayload(await res.json());
      if (!parsed) {
        logger.warn({ url: this.config.restUrl }, 'tip-floor REST returned unparseable payload');
        return;
      }
      this.ingest(parsed, 'rest');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'tip-floor REST refresh failed');
    }
  }

  private openSocket(): void {
    if (this.stopped) return;
    this.lastWsMessageAt = Date.now();
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.config.wsUrl);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'tip-floor WS construct failed');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.reconnectAttempt = 0;
      logger.info({ url: this.config.wsUrl }, 'tip-floor WS open');
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (socket !== this.socket) return;
      this.lastWsMessageAt = Date.now();
      const text = typeof event.data === 'string' ? event.data : undefined;
      if (text === undefined) return;
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return;
      }
      const parsed = parsePayload(payload);
      if (parsed) this.ingest(parsed, 'ws');
    });
    socket.addEventListener('error', () => {
      if (socket !== this.socket) return;
      logger.warn('tip-floor WS error');
    });
    socket.addEventListener('close', () => {
      if (socket !== this.socket) return;
      this.scheduleReconnect();
    });
  }

  private closeSocket(): void {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket.close();
    } catch {
      // already closing/closed — nothing to do
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.closeSocket();
    this.wsReconnects += 1;
    const delay = Math.min(
      this.options.wsReconnectBaseMs * 2 ** this.reconnectAttempt,
      this.options.wsReconnectMaxMs,
    );
    this.reconnectAttempt += 1;
    logger.warn({ delay, attempt: this.reconnectAttempt }, 'tip-floor WS reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }

  private tickWatchdog(): void {
    if (this.stopped || this.reconnectTimer) return;
    if (Date.now() - this.lastWsMessageAt > this.options.wsSilenceMs) {
      logger.warn('tip-floor WS silent — forcing rebuild');
      this.scheduleReconnect();
    }
  }
}
