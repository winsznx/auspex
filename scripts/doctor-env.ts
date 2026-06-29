/**
 * Safe environment doctor. Prints only variable presence and redacted endpoint
 * shape, then runs read-only connectivity checks. Never prints private keys,
 * tokens, query strings, or full RPC URLs.
 */
import '../src/shared/load-env.ts';
import Client, { CommitmentLevel, type SubscribeRequest } from '@triton-one/yellowstone-grpc';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { redactUrl } from '../src/shared/redact.ts';
import { yellowstoneReadiness } from '../src/shared/yellowstone-env.ts';
import { optionalEnv } from '../src/config.ts';

const CHECK_TIMEOUT_MS = 12_000;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function endpointShape(raw: string | undefined): string {
  if (!raw) return 'missing';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname && url.pathname !== '/' ? '/...' : ''}`;
  } catch {
    const firstSlash = raw.indexOf('/');
    return firstSlash > 0 ? `${raw.slice(0, firstSlash)}/...` : raw;
  }
}

async function withTimeout<T>(label: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
    });
    const value = await Promise.race([fn(), timeout]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkRpc(): Promise<void> {
  const rpcUrl = env('SOLANA_RPC_URL');
  if (!rpcUrl) {
    console.log('[FAIL] SOLANA_RPC_URL missing');
    return;
  }
  const result = await withTimeout('rpc', async () => {
    const conn = new Connection(rpcUrl, 'confirmed');
    const slot = await conn.getSlot('confirmed');
    return { slot };
  });
  if (result.ok) {
    console.log(`[PASS] SOLANA_RPC_URL ${redactUrl(rpcUrl)} slot=${result.value.slot}`);
  } else {
    console.log(`[FAIL] SOLANA_RPC_URL ${redactUrl(rpcUrl)} ${result.err}`);
  }
}

async function checkWallet(): Promise<void> {
  const secret = env('HOT_WALLET_SECRET_KEY');
  const rpcUrl = env('SOLANA_RPC_URL');
  if (!secret || !rpcUrl) {
    console.log('[FAIL] wallet check needs HOT_WALLET_SECRET_KEY and SOLANA_RPC_URL');
    return;
  }
  const result = await withTimeout('wallet', async () => {
    const keypair = Keypair.fromSecretKey(bs58.decode(secret));
    const conn = new Connection(rpcUrl, 'confirmed');
    const lamports = await conn.getBalance(keypair.publicKey, 'confirmed');
    return { pubkey: keypair.publicKey.toBase58(), sol: lamports / LAMPORTS_PER_SOL };
  });
  if (result.ok) {
    console.log(`[PASS] HOT_WALLET_SECRET_KEY pubkey=${result.value.pubkey.slice(0, 8)}... balance=${result.value.sol.toFixed(4)} SOL`);
  } else {
    console.log(`[FAIL] HOT_WALLET_SECRET_KEY ${result.err}`);
  }
}

async function checkYellowstone(): Promise<void> {
  const endpoint = env('YELLOWSTONE_GRPC_ENDPOINT');
  const token = env('YELLOWSTONE_X_TOKEN');
  const readiness = yellowstoneReadiness(endpoint, token);
  console.log(`[INFO] YELLOWSTONE_GRPC_ENDPOINT shape=${endpointShape(endpoint)} classification=${readiness.endpointClass}`);
  console.log(`[INFO] Yellowstone readiness=${readiness.usable ? 'usable' : 'not-ready'} reason=${readiness.reason}`);
  console.log(`[INFO] YELLOWSTONE_X_TOKEN ${token ? 'present' : 'missing'}`);
  if (!readiness.usable) {
    console.log(`[FAIL] Yellowstone gRPC not checked: ${readiness.reason}`);
    return;
  }
  if (!endpoint || !token) return;

  const result = await withTimeout('yellowstone', async () => {
    const client = new Client(endpoint, token, undefined, { enabled: true, slotRetention: 150 });
    await client.connect();
    const request: SubscribeRequest = {
      accounts: {},
      slots: { doctor: { filterByCommitment: false } },
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
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connected but no slot update arrived')), 8_000);
        stream.once('data', () => {
          clearTimeout(timer);
          resolve();
        });
        stream.once('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } finally {
      stream.destroy();
    }
  });
  console.log(result.ok ? '[PASS] Yellowstone gRPC connected and streamed a slot update' : `[FAIL] Yellowstone gRPC ${result.err}`);
}

async function checkGroq(): Promise<void> {
  const apiKey = env('GROQ_API_KEY');
  if (!apiKey) {
    console.log('[FAIL] GROQ_API_KEY missing');
    return;
  }
  const baseUrl = optionalEnv('GROQ_BASE_URL', 'https://api.groq.com/openai/v1')!.replace(/\/+$/, '');
  const result = await withTimeout('groq', async () => {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = (await res.json().catch(() => ({}))) as { data?: unknown[]; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    return { count: Array.isArray(body.data) ? body.data.length : 0 };
  });
  if (result.ok) {
    console.log(`[PASS] GROQ_API_KEY authenticated · models=${result.value.count}`);
  } else {
    console.log(`[FAIL] GROQ_API_KEY ${result.err}`);
  }
}

async function main(): Promise<void> {
  console.log('\n=== Auspex Env Doctor ===\n');
  for (const name of [
    'SOLANA_RPC_URL',
    'YELLOWSTONE_GRPC_ENDPOINT',
    'YELLOWSTONE_X_TOKEN',
    'JITO_BLOCK_ENGINE_URL',
    'HOT_WALLET_SECRET_KEY',
    'HELIUS_RPC_URL',
    'GROQ_API_KEY',
  ]) {
    const value = env(name);
    const printable = name.endsWith('URL') || name.endsWith('ENDPOINT') ? endpointShape(value) : value ? 'present' : 'missing';
    console.log(`${name.padEnd(28)} ${printable}`);
  }
  console.log('');
  await checkRpc();
  await checkWallet();
  await checkYellowstone();
  await checkGroq();
  console.log('\nEnv doctor complete. No SOL moved.\n');
}

main().catch((err) => {
  console.error(`doctor:env failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
