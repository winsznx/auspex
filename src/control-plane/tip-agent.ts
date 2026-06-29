import { optionalEnv } from '../config.ts';
import {
  type NetworkRegime,
  type TipPolicyDecision,
  type TipPolicyObservations,
  validateTipPolicyDecision,
} from './tip-policy.ts';

export interface TipAgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTipLamports: number;
}

interface GroqChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

const REGIMES = new Set<NetworkRegime>([
  'normal',
  'auction_pressure_high',
  'consensus_lag',
  'leader_risk',
  'blockhash_risk',
  'unknown',
]);

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_MAX_TIP_LAMPORTS = 100_000;

export function tipAgentConfig(): TipAgentConfig | undefined {
  const apiKey = optionalEnv('GROQ_API_KEY');
  if (!apiKey) return undefined;
  const rawMax = optionalEnv('TIP_AGENT_MAX_TIP_LAMPORTS');
  const maxTipLamports = rawMax === undefined ? DEFAULT_MAX_TIP_LAMPORTS : Number(rawMax);
  if (!Number.isInteger(maxTipLamports) || maxTipLamports < 1000) {
    throw new Error(`TIP_AGENT_MAX_TIP_LAMPORTS must be an integer >= 1000; got ${rawMax}`);
  }
  return {
    apiKey,
    baseUrl: optionalEnv('GROQ_BASE_URL', DEFAULT_BASE_URL)!,
    model: optionalEnv('TIP_AGENT_MODEL', DEFAULT_MODEL)!,
    maxTipLamports,
  };
}

export async function decideTipPolicy(
  observations: TipPolicyObservations,
  config = tipAgentConfig(),
): Promise<TipPolicyDecision | undefined> {
  if (!config) return undefined;

  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const raw = await callGroq(config, observations, lastError);
    const decision = normalizeDecision(raw, config, observations);
    const errors = validateTipPolicyDecision(decision);
    if (errors.length === 0) return decision;
    lastError = errors.join('; ');
  }
  throw new Error(`tip agent returned invalid policy: ${lastError}`);
}

async function callGroq(
  config: TipAgentConfig,
  observations: TipPolicyObservations,
  previousError: string,
): Promise<unknown> {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are the Auspex C8 tip-intelligence agent. You own exactly one decision: return BID with a bounded Jito tip, or NO_BID. Do not decide routing, signing, submission, or retries. Respond only with JSON.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Choose a bid policy for the next Jito bundle window.',
            constraints: {
              schema: {
                regime:
                  'normal | auction_pressure_high | consensus_lag | leader_risk | blockhash_risk | unknown',
                action: 'BID | NO_BID',
                tipLamports: 'integer >= 1000 and <= maxTipLamports when action=BID; null when action=NO_BID',
                rule: 'short human-readable bounded rule',
                confidence: 'number from 0 to 1',
                rationale: 'one concise sentence grounded in observations',
              },
              maxTipLamports: config.maxTipLamports,
              minTipLamports: 1000,
              noBidGuidance:
                'Use NO_BID if the next Jito window is too far/unknown, latency is unhealthy, or p95 pressure exceeds the cap.',
              bidGuidance:
                'When conditions are normal, prefer a tip near p75; increase toward p95 only under pressure, never above the cap.',
            },
            observations,
            previousValidationError: previousError || undefined,
          }),
        },
      ],
    }),
  });

  const body = (await res.json().catch(() => ({}))) as GroqChatResponse;
  if (!res.ok) {
    throw new Error(body.error?.message ?? `Groq chat completion failed with HTTP ${res.status}`);
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq response did not include message content');
  return JSON.parse(content);
}

function normalizeDecision(
  raw: unknown,
  config: TipAgentConfig,
  observations: TipPolicyObservations,
): TipPolicyDecision {
  if (!raw || typeof raw !== 'object') throw new Error('tip agent response is not an object');
  const input = raw as Record<string, unknown>;
  const regime = typeof input.regime === 'string' && REGIMES.has(input.regime as NetworkRegime)
    ? (input.regime as NetworkRegime)
    : 'unknown';
  const action = input.action === 'NO_BID' ? 'NO_BID' : 'BID';
  const rawTip = input.tipLamports;
  const tipLamports = action === 'BID' && typeof rawTip === 'number' ? Math.round(rawTip) : undefined;
  return {
    timestamp: new Date().toISOString(),
    policyVersion: `groq:${config.model}`,
    strategy: 'ai',
    regime,
    action,
    tipLamports,
    rule: typeof input.rule === 'string' ? input.rule : 'model-selected bounded tip policy',
    maxTipLamports: config.maxTipLamports,
    confidence: typeof input.confidence === 'number' ? input.confidence : 0,
    observations,
    rationale: typeof input.rationale === 'string' ? input.rationale : '',
  };
}
