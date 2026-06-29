/**
 * C8 contract: the AI owns exactly one operational decision, the bid policy.
 *
 * A bid policy returns either BID with a bounded tip, or NO_BID when current
 * conditions make submission uneconomical. NO_BID is the disciplined way to
 * express "hold" without giving the agent a second owned decision.
 */
export type BidAction = 'BID' | 'NO_BID';

export type NetworkRegime =
  | 'normal'
  | 'auction_pressure_high'
  | 'consensus_lag'
  | 'leader_risk'
  | 'blockhash_risk'
  | 'unknown';

export interface TipPolicyObservations {
  p50TipLamports: number;
  p75TipLamports: number;
  p95TipLamports: number;
  processedConfirmedDeltaMs: number | undefined;
  slotsToNextJitoLeader: number | undefined;
  leaderSkipped: boolean;
  recentAiLandingRate: number | undefined;
  recentBaselineLandingRate: number | undefined;
}

export interface TipPolicyDecision {
  timestamp: string;
  policyVersion: string;
  strategy: 'ai';
  regime: NetworkRegime;
  action: BidAction;
  /** Present only when action=BID. */
  tipLamports: number | undefined;
  /** Human-readable bounded rule, e.g. "min(max(p75 * 1.2, floor), cap)". */
  rule: string;
  maxTipLamports: number;
  confidence: number;
  observations: TipPolicyObservations;
  rationale: string;
}

export function validateTipPolicyDecision(decision: TipPolicyDecision): string[] {
  const errors: string[] = [];
  if (decision.strategy !== 'ai') errors.push('strategy must be ai');
  if (decision.action === 'BID') {
    if (!Number.isInteger(decision.tipLamports) || decision.tipLamports === undefined || decision.tipLamports < 1000) {
      errors.push('BID requires integer tipLamports >= 1000');
    }
    if (decision.tipLamports !== undefined && decision.tipLamports > decision.maxTipLamports) {
      errors.push('tipLamports exceeds maxTipLamports');
    }
  }
  if (decision.action === 'NO_BID' && decision.tipLamports !== undefined) {
    errors.push('NO_BID must not carry tipLamports');
  }
  if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    errors.push('confidence must be between 0 and 1');
  }
  if (!decision.rationale.trim()) errors.push('rationale is required');
  return errors;
}
