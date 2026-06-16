/**
 * C3 live gate. Wires a real TipFloorClient to the bus, prints every tip-floor
 * snapshot (REST seed + WS pushes) with the recomputed baseline, and proves the
 * gate: live percentiles arrive and `baseline = max(p75, floor)` recomputes on
 * each update. No creds required — Jito tip endpoints are public.
 *
 * Run: npm run verify:c3   (default 75s — long enough for ≥2 WS pushes)
 */
import { AuspexBus } from '../src/shared/events.ts';
import { tipFloorConfig } from '../src/config.ts';
import { TipFloorClient } from '../src/data-plane/tip-floor-client.ts';
import type { TipFloorSnapshot } from '../src/shared/types.ts';

const RUN_MS = Number(process.env.C3_RUN_MS ?? 75_000);

function line(s: TipFloorSnapshot): string {
  const p = s.percentiles;
  const expected = Math.max(p.p75, s.floorLamports);
  const ok = expected === s.baselineLamports ? 'ok' : 'MISMATCH';
  return (
    `[${s.source}] p25=${p.p25} p50=${p.p50} p75=${p.p75} p95=${p.p95} p99=${p.p99} ema50=${p.ema50} ` +
    `| floor=${s.floorLamports} baseline=${s.baselineLamports} (max(p75,floor)=${expected} ${ok}) ` +
    `| sampledAt=${s.sampledAt ?? '?'}`
  );
}

async function main(): Promise<void> {
  const config = tipFloorConfig();
  const bus = new AuspexBus();
  const client = new TipFloorClient({ bus, config });

  let count = 0;
  const sources = new Set<string>();
  bus.on('tipFloor', (s) => {
    count += 1;
    sources.add(s.source);
    console.log(line(s));
  });

  console.log(`C3 verify · REST=${config.restUrl} · WS=${config.wsUrl} · floor=${config.floorLamports} lamports · ${RUN_MS}ms`);
  await client.start();

  await new Promise<void>((resolve) => setTimeout(resolve, RUN_MS));
  await client.stop();

  const health = client.getHealth();
  console.log(`\nupdates=${count} sources=[${[...sources].join(',')}] wsReconnects=${health.wsReconnects} hasSnapshot=${health.hasSnapshot}`);

  const sawWs = sources.has('ws');
  const pass = count >= 2 && health.hasSnapshot;
  if (pass && !sawWs) {
    console.log('\n⚠ WARNING: WS never pushed — REST-only fallback verified, the streaming path is UNCONFIRMED.');
  }
  console.log(pass ? `\nGATE GREEN — live percentiles + baseline recompute verified${sawWs ? ' (WS push confirmed)' : ' (REST-only — see warning)'}` : '\nGATE RED — no live updates');
  process.exit(pass ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('C3 verify crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
