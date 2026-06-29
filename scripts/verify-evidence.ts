/**
 * Judge-facing evidence verifier.
 *
 * Usage:
 *   npm run verify:evidence -- evidence/landing-run-xxx.json
 *   npm run verify:evidence -- evidence/landing-run-xxx.json --strict
 *
 * Read-only. It never signs or submits. It validates the local evidence shape,
 * cross-checks landed bundles against Jito, and checks landed signatures against
 * Solana RPC. Strict mode enforces final-submission minimums.
 */
import { readFileSync } from 'node:fs';
import { Connection } from '@solana/web3.js';
import { jitoBlockEngineUrl, solanaRpcUrl } from '../src/config.ts';
import { redactUrl } from '../src/shared/redact.ts';

type IssueKind = 'PASS' | 'WARN' | 'FAIL';

interface Issue {
  kind: IssueKind;
  subject: string;
  detail: string;
}

interface EvidenceRecord {
  bundleId: string;
  signature: string;
  tipLamports: number;
  tipAccount: string;
  arm: 'ai' | 'baseline';
  submittedAt: number;
  outcome: 'pending' | 'landed' | 'failed' | 'invalid';
  landedSlot: number | null;
  confirmationStatus: string | null;
  err: unknown;
  resolvedAt: number | null;
  pollAttempts: number;
  explorerUrl: string | undefined;
  solscanUrl: string | undefined;
  failureClassification: string | undefined;
}

interface EvidenceFile {
  payer: string | undefined;
  ranAt: string | undefined;
  attempts: number | undefined;
  landedCount: number | undefined;
  failedCount: number | undefined;
  targetLanded: number | undefined;
  spentLamports: number | undefined;
  records: EvidenceRecord[];
}

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseRecord(raw: unknown, index: number): EvidenceRecord {
  if (!isObject(raw)) throw new Error(`record[${index}] is not an object`);
  const arm = raw.arm === 'ai' || raw.arm === 'baseline' ? raw.arm : undefined;
  const outcome =
    raw.outcome === 'pending' || raw.outcome === 'landed' || raw.outcome === 'failed' || raw.outcome === 'invalid'
      ? raw.outcome
      : undefined;
  const bundleId = asString(raw.bundleId);
  const signature = asString(raw.signature);
  const tipAccount = asString(raw.tipAccount);
  const tipLamports = asNumber(raw.tipLamports);
  const submittedAt = asNumber(raw.submittedAt);
  const pollAttempts = asNumber(raw.pollAttempts);
  if (!bundleId || !signature || !tipAccount || !arm || !outcome || tipLamports === undefined || submittedAt === undefined || pollAttempts === undefined) {
    throw new Error(`record[${index}] missing required fields`);
  }
  return {
    bundleId,
    signature,
    tipLamports,
    tipAccount,
    arm,
    submittedAt,
    outcome,
    landedSlot: raw.landedSlot === null ? null : asNumber(raw.landedSlot) ?? null,
    confirmationStatus: raw.confirmationStatus === null ? null : asString(raw.confirmationStatus) ?? null,
    err: raw.err,
    resolvedAt: raw.resolvedAt === null ? null : asNumber(raw.resolvedAt) ?? null,
    pollAttempts,
    explorerUrl: asString(raw.explorerUrl),
    solscanUrl: asString(raw.solscanUrl),
    failureClassification: asString(raw.failureClassification),
  };
}

function parseEvidence(path: string): EvidenceFile {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isObject(raw) || !Array.isArray(raw.records)) throw new Error('evidence file must contain records[]');
  return {
    payer: asString(raw.payer),
    ranAt: asString(raw.ranAt),
    attempts: asNumber(raw.attempts),
    landedCount: asNumber(raw.landedCount),
    failedCount: asNumber(raw.failedCount),
    targetLanded: asNumber(raw.targetLanded),
    spentLamports: asNumber(raw.spentLamports),
    records: raw.records.map((r, i) => parseRecord(r, i)),
  };
}

async function jitoRpc<T>(baseUrl: string, method: string, params: unknown[]): Promise<T | undefined> {
  const res = await fetch(`${baseUrl}/api/v1/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body = (await res.json()) as RpcResponse<T>;
  if (body.error) throw new Error(`${method} RPC error ${body.error.code}: ${body.error.message}`);
  return body.result;
}

function add(issues: Issue[], kind: IssueKind, subject: string, detail: string): void {
  issues.push({ kind, subject, detail });
}

async function verifyLandedRecord(
  record: EvidenceRecord,
  connection: Connection,
  blockEngineUrl: string,
  issues: Issue[],
): Promise<void> {
  const result = await jitoRpc<{ value?: Array<{ bundle_id?: string; transactions?: string[]; slot?: number; confirmation_status?: string; err?: unknown } | null> }>(
    blockEngineUrl,
    'getBundleStatuses',
    [[record.bundleId]],
  );
  const status = result?.value?.[0];
  if (!status) {
    add(issues, 'FAIL', record.bundleId, 'landed record is missing from getBundleStatuses');
    return;
  }

  if (status.slot !== record.landedSlot) {
    add(issues, 'FAIL', record.bundleId, `landed slot mismatch: evidence=${record.landedSlot} jito=${status.slot}`);
  } else {
    add(issues, 'PASS', record.bundleId, `Jito landed slot ${status.slot}`);
  }

  if (Array.isArray(status.transactions) && status.transactions.includes(record.signature)) {
    add(issues, 'PASS', record.signature, 'signature is included in Jito bundle status');
  } else {
    add(issues, 'FAIL', record.signature, 'signature not found in Jito bundle transactions');
  }

  const sigStatus = await connection.getSignatureStatuses([record.signature], { searchTransactionHistory: true });
  const sig = sigStatus.value[0];
  if (!sig) {
    add(issues, 'FAIL', record.signature, 'Solana RPC did not find landed signature');
    return;
  }
  if (record.landedSlot !== null && sig.slot !== record.landedSlot) {
    add(issues, 'FAIL', record.signature, `signature slot mismatch: evidence=${record.landedSlot} rpc=${sig.slot}`);
  } else {
    add(issues, 'PASS', record.signature, `Solana signature slot ${sig.slot}, confirmation=${sig.confirmationStatus ?? 'unknown'}`);
  }
}

function verifyLocalShape(evidence: EvidenceFile, strict: boolean, issues: Issue[]): void {
  const landed = evidence.records.filter((r) => r.outcome === 'landed');
  const failed = evidence.records.filter((r) => r.outcome === 'failed' || r.outcome === 'invalid');
  const ai = evidence.records.filter((r) => r.arm === 'ai');
  const baseline = evidence.records.filter((r) => r.arm === 'baseline');

  add(issues, evidence.records.length > 0 ? 'PASS' : 'FAIL', 'records', `${evidence.records.length} records`);
  add(issues, landed.length > 0 ? 'PASS' : 'WARN', 'landed-count', `${landed.length} landed records`);
  add(issues, failed.length > 0 ? 'PASS' : 'WARN', 'failure-count', `${failed.length} failed/invalid records`);

  if (strict) {
    add(issues, evidence.records.length >= 10 ? 'PASS' : 'FAIL', 'strict:min-records', `${evidence.records.length}/10 records`);
    add(issues, failed.length >= 2 ? 'PASS' : 'FAIL', 'strict:min-failures', `${failed.length}/2 failures`);
    add(issues, ai.length > 0 && baseline.length > 0 ? 'PASS' : 'FAIL', 'strict:ab-arms', `ai=${ai.length} baseline=${baseline.length}`);
  }

  for (const record of evidence.records) {
    if (record.tipLamports < 1000) add(issues, 'FAIL', record.bundleId, `tip below Jito minimum: ${record.tipLamports}`);
    if (record.outcome === 'landed' && record.landedSlot === null) add(issues, 'FAIL', record.bundleId, 'landed record has null landedSlot');
    if (record.outcome !== 'landed' && strict && !record.failureClassification) {
      add(issues, 'WARN', record.bundleId, 'failure record has no failureClassification yet');
    }
    const expectedExplorer = `https://explorer.jito.wtf/bundle/${record.bundleId}`;
    const expectedSolscan = `https://solscan.io/tx/${record.signature}`;
    if (record.explorerUrl && record.explorerUrl !== expectedExplorer) add(issues, 'WARN', record.bundleId, 'explorerUrl does not match bundleId');
    if (record.solscanUrl && record.solscanUrl !== expectedSolscan) add(issues, 'WARN', record.signature, 'solscanUrl does not match signature');
  }
}

async function main(): Promise<void> {
  const path = process.argv[2];
  const strict = process.argv.includes('--strict');
  if (!path) {
    console.error('Usage: npm run verify:evidence -- evidence/run.json [--strict]');
    process.exit(1);
  }

  const evidence = parseEvidence(path);
  const blockEngineUrl = jitoBlockEngineUrl();
  const rpcUrl = solanaRpcUrl();
  const connection = new Connection(rpcUrl, 'confirmed');
  const issues: Issue[] = [];

  console.log('\n=== Auspex Evidence Verifier ===');
  console.log(`file=${path}`);
  console.log(`rpc=${redactUrl(rpcUrl)} blockEngine=${redactUrl(blockEngineUrl)} strict=${strict}`);
  console.log(`ranAt=${evidence.ranAt ?? '?'} payer=${evidence.payer ? `${evidence.payer.slice(0, 8)}...` : '?'}`);

  verifyLocalShape(evidence, strict, issues);

  for (const record of evidence.records) {
    if (record.outcome === 'landed') {
      try {
        await verifyLandedRecord(record, connection, blockEngineUrl, issues);
      } catch (err) {
        add(issues, 'FAIL', record.bundleId, err instanceof Error ? err.message : String(err));
      }
    }
  }

  for (const issue of issues) {
    console.log(`[${issue.kind}] ${issue.subject.padEnd(44)} ${issue.detail}`);
  }

  const fails = issues.filter((i) => i.kind === 'FAIL').length;
  const warns = issues.filter((i) => i.kind === 'WARN').length;
  console.log(`\nVerifier result: ${fails === 0 ? 'GREEN' : 'RED'} (${fails} fail, ${warns} warn)\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify:evidence failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
