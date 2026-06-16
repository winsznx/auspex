/**
 * The in-process event bus — the spine between the hot data plane and the warm
 * control plane. A thin typed wrapper over Node's EventEmitter so producers and
 * consumers share one checked event map. One process, two logical planes.
 */
import { EventEmitter } from 'node:events';
import type {
  SlotUpdate,
  Watermarks,
  LagSample,
  IngestorHealth,
  TipFloorSnapshot,
  LeaderWindowEvent,
  LeaderSkipEvent,
} from './types.ts';

export interface AuspexEventMap {
  slot: [SlotUpdate];
  watermark: [Watermarks];
  lag: [LagSample];
  health: [IngestorHealth];
  tipFloor: [TipFloorSnapshot];
  leaderWindow: [LeaderWindowEvent];
  leaderSkip: [LeaderSkipEvent];
  error: [Error];
}

type EventName = keyof AuspexEventMap;

export class AuspexBus {
  private readonly emitter = new EventEmitter();

  constructor(maxListeners = 50) {
    this.emitter.setMaxListeners(maxListeners);
    // Node's EventEmitter throws if 'error' is emitted with zero listeners.
    // Register a floor listener so a producer can never crash the process by
    // surfacing an error before a consumer has subscribed.
    this.emitter.on('error', () => {});
  }

  on<E extends EventName>(event: E, handler: (...args: AuspexEventMap[E]) => void): this {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return this;
  }

  off<E extends EventName>(event: E, handler: (...args: AuspexEventMap[E]) => void): this {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
    return this;
  }

  emit<E extends EventName>(event: E, ...args: AuspexEventMap[E]): boolean {
    return this.emitter.emit(event, ...args);
  }
}
