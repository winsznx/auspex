/** Redact endpoint URLs before logging; RPC providers often put API keys in paths or query strings. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/...`;
  } catch {
    return raw.length > 12 ? `${raw.slice(0, 8)}...` : '[redacted]';
  }
}
