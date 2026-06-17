/**
 * Auspex process entrypoint — boots the two logical planes as one process.
 *
 * Today it wires the BUILT data-plane components onto a single AuspexBus and
 * runs them live: C1 slot/commitment source (Yellowstone gRPC if configured,
 * else the free RPC-WebSocket fallback), C2 leader-window tracking, C3 tip-floor
 * + baseline, and C4's bundle constructor (initialized read-only — it loads tip
 * accounts but builds/submits nothing).
 *
 * The submission path (C5 submit → C12 evidence) and the control plane (C8/C9)
 * are wired in here as they land. Until then the evidence / A/B / fault-injection
 * modes report honestly that they need the funded submission path, rather than
 * exiting 0 as if they had run.
 */
import 'dotenv/config';
import { AuspexBus } from './shared/events.ts';
import { logger } from './shared/logger.ts';
import {
  solanaRpcUrl,
  kobeValidatorsUrl,
  tipFloorConfig,
  jitoBlockEngineUrl,
  yellowstoneConfig,
  optionalEnv,
} from './config.ts';
import type { LeaderWindowEvent, SlotSource } from './shared/types.ts';
import { WebSocketSlotSource } from './data-plane/ws-slot-source.ts';
import { StreamIngestor } from './data-plane/stream-ingestor.ts';
import { LeaderWindowTracker } from './data-plane/leader-window-tracker.ts';
import { TipFloorClient } from './data-plane/tip-floor-client.ts';
import { BundleBuilder } from './data-plane/bundle-builder.ts';
import { loadHotWallet } from './shared/wallet.ts';

const HEARTBEAT_MS = 10_000;

interface CliArgs {
  mode: string | undefined;
  inject: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  let mode: string | undefined;
  let inject: string | undefined;
  for (const arg of argv) {
    const modeMatch = /^--mode=(.+)$/.exec(arg);
    if (modeMatch) mode = modeMatch[1];
    const injectMatch = /^--inject=(.+)$/.exec(arg);
    if (injectMatch) inject = injectMatch[1];
  }
  return { mode, inject };
}

async function startSlotSource(bus: AuspexBus, rpcUrl: string): Promise<{ source: SlotSource; kind: string }> {
  const hasYellowstone =
    optionalEnv('YELLOWSTONE_GRPC_ENDPOINT') !== undefined && optionalEnv('YELLOWSTONE_X_TOKEN') !== undefined;
  if (hasYellowstone) {
    const primary = new StreamIngestor({ bus, config: yellowstoneConfig() });
    try {
      await primary.start();
      return { source: primary, kind: 'yellowstone-grpc' };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Yellowstone gRPC source failed to start — falling back to the RPC-WebSocket source',
      );
      await primary.stop().catch(() => undefined);
    }
  }
  const fallback = new WebSocketSlotSource({ bus, rpcUrl });
  await fallback.start();
  return { source: fallback, kind: 'rpc-websocket' };
}

async function initBundleBuilder(rpcUrl: string): Promise<BundleBuilder | undefined> {
  try {
    const payer = loadHotWallet();
    const builder = new BundleBuilder({ rpcUrl, blockEngineUrl: jitoBlockEngineUrl(), payer });
    await builder.init();
    return builder;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'C4 bundle builder not initialized (missing wallet / block engine?) — data plane continues without it',
    );
    return undefined;
  }
}

function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    let shuttingDown = false;
    const handle = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'shutting down — stopping data plane');
      void cleanup().finally(() => resolve());
    };
    process.once('SIGINT', handle);
    process.once('SIGTERM', handle);
  });
}

async function runDataPlane(): Promise<void> {
  const rpcUrl = solanaRpcUrl();
  const bus = new AuspexBus();

  let latestWindow: LeaderWindowEvent | undefined;
  let inJitoWindow = false;

  bus.on('error', (err) => logger.error({ err: err.message }, 'bus error'));
  bus.on('tipFloor', (snap) =>
    logger.info(
      { source: snap.source, p75: snap.percentiles.p75, baseline: snap.baselineLamports, floor: snap.floorLamports },
      'tip-floor update',
    ),
  );
  bus.on('leaderWindow', (event) => {
    latestWindow = event;
    if (event.inJitoWindow !== inJitoWindow) {
      inJitoWindow = event.inJitoWindow;
      logger.info(
        {
          slot: event.currentSlot,
          epoch: event.epoch,
          leader: event.leaderIdentity?.slice(0, 8),
          nextJitoSlot: event.nextJitoWindowSlot,
        },
        event.inJitoWindow ? 'entered Jito leader window' : 'left Jito leader window',
      );
    }
  });
  bus.on('leaderSkip', (event) =>
    logger.warn(
      { slot: event.slot, windowStart: event.windowStartSlot, wasJito: event.wasJitoWindow },
      'leader skipped slot',
    ),
  );

  const tracker = new LeaderWindowTracker({ bus, rpcUrl, kobeUrl: kobeValidatorsUrl() });
  const tipClient = new TipFloorClient({ bus, config: tipFloorConfig() });

  await tracker.start();
  const { source, kind } = await startSlotSource(bus, rpcUrl);
  await tipClient.start();
  const builder = await initBundleBuilder(rpcUrl);

  logger.info(
    { slotSource: kind, components: ['C1', 'C2', 'C3', builder ? 'C4' : 'C4(uninit)'] },
    'Auspex data plane up — built components wired on one process (no submit; C5+ needs a funded wallet)',
  );

  const heartbeat = setInterval(() => {
    const state = source.getState();
    const snapshot = tipClient.getSnapshot();
    logger.info(
      {
        slotPhase: state.phase,
        watermarks: state.watermarks,
        updates: state.updatesSeen,
        currentSlot: latestWindow?.currentSlot,
        inJitoWindow: latestWindow?.inJitoWindow ?? false,
        slotsToJito: latestWindow?.slotsToNextJitoWindow,
        tipBaseline: snapshot?.baselineLamports ?? 'stale/none',
        c4TipAccounts: builder?.tipAccountCount ?? 0,
      },
      'heartbeat',
    );
  }, HEARTBEAT_MS);

  await waitForShutdown(async () => {
    clearInterval(heartbeat);
    await tipClient.stop();
    await source.stop();
    await tracker.stop();
  });
}

async function main(): Promise<void> {
  const { mode, inject } = parseArgs(process.argv.slice(2));

  if (inject !== undefined || (mode !== undefined && mode !== 'data')) {
    logger.error(
      { mode, inject },
      'this mode needs the submission path (C5 submit → C12 evidence) + a funded hot wallet — not wired yet. Run with no mode to start the live data plane (C1–C4).',
    );
    process.exit(1);
  }

  await runDataPlane();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal');
  process.exit(1);
});
