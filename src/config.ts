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
