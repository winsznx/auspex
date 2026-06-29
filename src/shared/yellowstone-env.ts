export type YellowstoneEndpointClass =
  | 'missing'
  | 'placeholder'
  | 'json-rpc'
  | 'plausible'
  | 'unusual';

export interface YellowstoneConfigReadiness {
  usable: boolean;
  endpointClass: YellowstoneEndpointClass;
  reason: string;
}

const PLACEHOLDER_RE = /\b(your-|example|placeholder|changeme|change-me|todo|xxx)\b/i;

const KNOWN_JSON_RPC_HOST_RE = [
  /(^|\.)mainnet\.helius-rpc\.com$/i,
  /(^|\.)solana-mainnet\.quiknode\.pro$/i,
  /(^|\.)solana-mainnet\.g\.alchemy\.com$/i,
  /(^|\.)api\.mainnet-beta\.solana\.com$/i,
  /(^|\.)rpcpool\.com$/i,
  /(^|\.)rpc\.ankr\.com$/i,
];

export function classifyYellowstoneEndpoint(raw: string | undefined): YellowstoneEndpointClass {
  if (!raw) return 'missing';
  if (PLACEHOLDER_RE.test(raw)) return 'placeholder';

  try {
    const url = new URL(raw);
    if (KNOWN_JSON_RPC_HOST_RE.some((re) => re.test(url.hostname))) return 'json-rpc';
    if (url.protocol === 'http:' || url.protocol === 'https:') return 'plausible';
    return 'unusual';
  } catch {
    return 'unusual';
  }
}

export function yellowstoneReadiness(endpoint: string | undefined, xToken: string | undefined): YellowstoneConfigReadiness {
  if (!endpoint || !xToken) {
    return {
      usable: false,
      endpointClass: endpoint ? classifyYellowstoneEndpoint(endpoint) : 'missing',
      reason: 'YELLOWSTONE_GRPC_ENDPOINT and YELLOWSTONE_X_TOKEN are both required',
    };
  }

  const endpointClass = classifyYellowstoneEndpoint(endpoint);
  if (endpointClass === 'placeholder') {
    return {
      usable: false,
      endpointClass,
      reason: 'endpoint is still a placeholder',
    };
  }
  if (endpointClass === 'json-rpc') {
    return {
      usable: false,
      endpointClass,
      reason: 'endpoint looks like a standard Solana JSON-RPC URL, not Dragon\'s Mouth gRPC',
    };
  }
  if (PLACEHOLDER_RE.test(xToken)) {
    return {
      usable: false,
      endpointClass,
      reason: 'x-token is still a placeholder',
    };
  }

  return {
    usable: endpointClass === 'plausible' || endpointClass === 'unusual',
    endpointClass,
    reason: endpointClass === 'plausible'
      ? 'shape looks plausible for Dragon\'s Mouth gRPC; live connect decides'
      : 'unusual endpoint shape; live connect decides',
  };
}
