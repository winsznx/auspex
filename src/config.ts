/**
 * Typed env loader. Reads `.env` (via dotenv) and validates on access — never
 * hardcodes a value. `requireEnv` fails fast with a clear message; component
 * config getters pull only what that component needs.
 */
import 'dotenv/config';

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function requireEnv(name: string): string {
  const value = read(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name} (set it in .env / Railway service variables)`);
  }
  return value;
}

export function optionalEnv(name: string, fallback?: string): string | undefined {
  return read(name) ?? fallback;
}

export interface YellowstoneConfig {
  endpoint: string;
  xToken: string;
}

export function yellowstoneConfig(): YellowstoneConfig {
  return {
    endpoint: requireEnv('YELLOWSTONE_GRPC_ENDPOINT'),
    xToken: requireEnv('YELLOWSTONE_X_TOKEN'),
  };
}

export function solanaRpcUrl(): string {
  return requireEnv('SOLANA_RPC_URL');
}

const DEFAULT_KOBE_VALIDATORS_URL = 'https://kobe.mainnet.jito.network/api/v1/validators';

export function kobeValidatorsUrl(): string {
  return optionalEnv('KOBE_VALIDATORS_URL', DEFAULT_KOBE_VALIDATORS_URL)!;
}

export interface TipFloorConfig {
  restUrl: string;
  wsUrl: string;
  /** Lower bound for the baseline tip; Jito rejects bundles tipping <1000 lamports. */
  floorLamports: number;
}

const DEFAULT_TIP_FLOOR_REST = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
const DEFAULT_TIP_STREAM_WS = 'wss://bundles.jito.wtf/api/v1/bundles/tip_stream';
const JITO_MIN_TIP_LAMPORTS = 1000;

export function tipFloorConfig(): TipFloorConfig {
  const floorRaw = optionalEnv('JITO_TIP_FLOOR_LAMPORTS');
  const floorLamports = floorRaw !== undefined ? Number(floorRaw) : JITO_MIN_TIP_LAMPORTS;
  if (!Number.isInteger(floorLamports) || floorLamports < JITO_MIN_TIP_LAMPORTS) {
    throw new Error(
      `JITO_TIP_FLOOR_LAMPORTS must be an integer ≥ ${JITO_MIN_TIP_LAMPORTS} (Jito min tip); got ${floorRaw}`,
    );
  }
  return {
    restUrl: optionalEnv('JITO_TIP_FLOOR_URL', DEFAULT_TIP_FLOOR_REST)!,
    wsUrl: optionalEnv('JITO_TIP_STREAM_URL', DEFAULT_TIP_STREAM_WS)!,
    floorLamports,
  };
}
