/**
 * Day-0 gate verifier (Build sequence prompt 0).
 *
 * Hits every Section-8 external dependency LIVE and prints pass/fail.
 * NO MOCKS — every check is a real network call against mainnet infra.
 *
 * Run:  npm run verify:day0
 *
 * This is an honest, runnable skeleton. The dynamic-workflow research +
 * implementation agents extend it (Yellowstone live-stream check, wallet
 * balance decode) per .claude/agents and CLAUDE.md. It must reach ALL GREEN
 * before Phase-1 (C1+) build begins.
 */
import 'dotenv/config';
import Client, {
  CommitmentLevel,
  type SubscribeRequest,
  type SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

type Check = { name: string; pass: boolean; detail: string };

const MIN_WALLET_SOL = 0.05;

const env = (k: string) => process.env[k]?.trim() || '';

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; err?: string }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, value };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e instanceof Error ? e.message : String(e) };
  }
}

async function checkEnvPresent(): Promise<Check[]> {
  const required = [
    'YELLOWSTONE_GRPC_ENDPOINT',
    'YELLOWSTONE_X_TOKEN',
    'SOLANA_RPC_URL',
    'JITO_BLOCK_ENGINE_URL',
    'HOT_WALLET_SECRET_KEY',
  ];
  return required.map((k) => ({
    name: `env:${k}`,
    pass: env(k).length > 0,
    detail: env(k).length > 0 ? 'present' : 'MISSING — set in .env / Railway variables',
  }));
}

async function checkJitoTipFloor(): Promise<Check> {
  const url = env('JITO_TIP_FLOOR_URL') || 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
  const r = await timed(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  const p = r.ok && Array.isArray(r.value) ? r.value[0] : (r.value as any);
  return {
    name: 'jito:tip_floor',
    pass: r.ok && p != null,
    detail: r.ok
      ? `ok ${r.ms}ms · p50=${p?.landed_tips_50th_percentile ?? '?'} p75=${p?.landed_tips_75th_percentile ?? '?'} p95=${p?.landed_tips_95th_percentile ?? '?'}`
      : `FAIL ${r.err}`,
  };
}

async function checkJitoTipAccounts(): Promise<Check> {
  const base = env('JITO_BLOCK_ENGINE_URL') || 'https://ny.mainnet.block-engine.jito.wtf';
  const r = await timed(async () => {
    const res = await fetch(`${base}/api/v1/getTipAccounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  const accounts = (r.value as any)?.result;
  return {
    name: 'jito:getTipAccounts',
    pass: r.ok && Array.isArray(accounts) && accounts.length > 0,
    detail: r.ok ? `ok ${r.ms}ms · ${accounts?.length ?? 0} tip accounts` : `FAIL ${r.err}`,
  };
}

async function checkSolanaRpc(): Promise<Check> {
  const url = env('SOLANA_RPC_URL');
  if (!url) return { name: 'rpc:getHealth', pass: false, detail: 'SOLANA_RPC_URL missing' };
  const r = await timed(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  return {
    name: 'rpc:getHealth',
    pass: r.ok && (r.value as any)?.result === 'ok',
    detail: r.ok ? `ok ${r.ms}ms · result=${(r.value as any)?.result}` : `FAIL ${r.err}`,
  };
}

async function checkBlockhashConfirmed(): Promise<Check> {
  const url = env('SOLANA_RPC_URL');
  if (!url) return { name: 'rpc:getLatestBlockhash(confirmed)', pass: false, detail: 'SOLANA_RPC_URL missing' };
  const r = await timed(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash',
        params: [{ commitment: 'confirmed' }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  const bh = (r.value as any)?.result?.value?.blockhash;
  return {
    name: 'rpc:getLatestBlockhash(confirmed)',
    pass: r.ok && typeof bh === 'string',
    detail: r.ok ? `ok ${r.ms}ms · blockhash=${bh?.slice(0, 8)}…` : `FAIL ${r.err}`,
  };
}

async function checkYellowstoneSlots(): Promise<Check> {
  const endpoint = env('YELLOWSTONE_GRPC_ENDPOINT');
  const xToken = env('YELLOWSTONE_X_TOKEN');
  if (!endpoint || !xToken) {
    return { name: 'yellowstone:slots', pass: false, detail: 'YELLOWSTONE_GRPC_ENDPOINT/X_TOKEN missing' };
  }
  const r = await timed(async () => {
    const client = new Client(endpoint, xToken, undefined, { enabled: true, slotRetention: 150 });
    const request: SubscribeRequest = {
      accounts: {},
      slots: { day0: { filterByCommitment: false } },
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
    };
    const stream = await client.subscribe(request);
    try {
      return await new Promise<{ first: number; last: number; count: number; statuses: Set<number> }>(
        (resolve, reject) => {
          const seen: number[] = [];
          const statuses = new Set<number>();
          const timer = setTimeout(() => reject(new Error('no advancing slots within 12s')), 12_000);
          stream.on('data', (update: SubscribeUpdate) => {
            const s = update.slot;
            if (!s) return;
            statuses.add(s.status);
            const slot = Number(s.slot);
            if (!seen.includes(slot)) seen.push(slot);
            const first = seen[0];
            const last = seen[seen.length - 1];
            if (seen.length >= 3 && first !== undefined && last !== undefined && last > first) {
              clearTimeout(timer);
              resolve({ first, last, count: seen.length, statuses });
            }
          });
          stream.on('error', (e: Error) => {
            clearTimeout(timer);
            reject(e);
          });
        },
      );
    } finally {
      stream.destroy();
    }
  });
  if (!r.ok) return { name: 'yellowstone:slots', pass: false, detail: `FAIL ${r.err}` };
  const v = r.value!;
  return {
    name: 'yellowstone:slots',
    pass: v.last > v.first,
    detail: `ok ${r.ms}ms · slots ${v.first}→${v.last} (${v.count} seen) · statuses=${[...v.statuses].sort().join(',')}`,
  };
}

async function checkWalletBalance(): Promise<Check> {
  const secret = env('HOT_WALLET_SECRET_KEY');
  const url = env('SOLANA_RPC_URL');
  if (!secret) return { name: 'wallet:getBalance', pass: false, detail: 'HOT_WALLET_SECRET_KEY missing' };
  if (!url) return { name: 'wallet:getBalance', pass: false, detail: 'SOLANA_RPC_URL missing' };
  const r = await timed(async () => {
    const keypair = Keypair.fromSecretKey(bs58.decode(secret));
    const pubkey = keypair.publicKey.toBase58();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getBalance',
        params: [pubkey, { commitment: 'confirmed' }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: { value?: number } };
    const lamports = body.result?.value;
    if (typeof lamports !== 'number') throw new Error('no balance in RPC response');
    return { pubkey, lamports };
  });
  if (!r.ok) return { name: 'wallet:getBalance', pass: false, detail: `FAIL ${r.err}` };
  const sol = r.value!.lamports / LAMPORTS_PER_SOL;
  return {
    name: 'wallet:getBalance',
    pass: sol >= MIN_WALLET_SOL,
    detail: `${r.value!.pubkey.slice(0, 8)}… ${sol.toFixed(4)} SOL ${sol >= MIN_WALLET_SOL ? `(≥${MIN_WALLET_SOL})` : `(< ${MIN_WALLET_SOL} — FUND IT)`}`,
  };
}

async function main() {
  console.log('\n=== Auspex Day-0 Gate ===\n');
  const checks: Check[] = [
    ...(await checkEnvPresent()),
    await checkJitoTipFloor(),
    await checkJitoTipAccounts(),
    await checkSolanaRpc(),
    await checkBlockhashConfirmed(),
    await checkWalletBalance(),
    await checkYellowstoneSlots(),
  ];

  let green = 0;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (c.pass) green++;
    console.log(`[${tag}] ${c.name.padEnd(38)} ${c.detail}`);
  }
  const allGreen = green === checks.length;
  console.log(`\n${green}/${checks.length} green. Gate: ${allGreen ? 'OPEN — proceed to C1' : 'CLOSED — do not advance'}\n`);
  process.exit(allGreen ? 0 : 1);
}

main();
