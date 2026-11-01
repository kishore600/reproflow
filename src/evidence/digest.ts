import type { Candidate } from '../engine/candidates.js';
import type { ErrorInfo } from '../errors.js';
import { truncate } from '../util.js';

/** Hard cap on the characters of any digest printed to stdout. */
export const DIGEST_LIMIT = 2000;
/** List entries are cut to this many characters before anything is dropped. */
export const ENTRY_LIMIT = 300;

export type RunStatus = 'passed' | 'failed' | 'error';

export interface FailedStep {
  n: number;
  type: string;
  target: string;
  expected: string | null;
  actual: string | null;
}

export interface EvidenceSummary {
  dir: string;
  screenshot: string | null;
  snapshot: string | null;
  url: string;
  title: string;
  console_errors: string[];
  page_errors: string[];
  failed_requests: string[];
}

export interface RunDigest {
  ok: boolean;
  status: RunStatus;
  flow: string | null;
  params: Record<string, unknown>;
  duration_ms: number;
  steps_total: number;
  steps_passed: number;
  failed_step: FailedStep | null;
  error: ErrorInfo | null;
  /** Only present for locator_not_found. */
  candidates?: Candidate[];
  evidence: EvidenceSummary | null;
  next: string;
  truncated: boolean;
}

export interface DigestInput {
  flow: string | null;
  status: RunStatus;
  params?: Record<string, unknown>;
  durationMs: number;
  stepsTotal: number;
  stepsPassed: number;
  failedStep?: FailedStep | null;
  error?: ErrorInfo | null;
  candidates?: Candidate[];
  evidence?: EvidenceSummary | null;
  next?: string;
}

/** One short sentence telling the agent what to do with this result. */
export function nextStep(args: {
  status: RunStatus;
  kind: 'run' | 'capture';
  error?: ErrorInfo | null;
  candidates?: Candidate[];
}): string {
  const { status, kind, error, candidates } = args;
  if (status === 'passed') {
    return kind === 'run'
      ? 'Flow passed. Nothing more to check.'
      : 'Open the screenshot or snapshot only if this digest is not enough.';
  }
  switch (error?.code) {
    case 'locator_not_found':
      return candidates?.length
        ? `Retry with ${candidates[0].locator}, or check snapshot.aria.yml.`
        : 'Check snapshot.aria.yml for the right locator.';
    case 'assertion_failed':
      return 'Check console_errors and failed_requests, fix the app, then rerun this flow.';
    case 'host_not_allowed':
      return 'Add the host to allowed_hosts if this navigation is intended.';
    case 'navigation_timeout':
      return 'Make sure the app is running and reachable, then rerun.';
    default:
      return error?.hint ?? 'See error for details.';
  }
}

export function exitCodeForDigest(digest: { status: RunStatus }): 0 | 1 | 2 {
  return digest.status === 'passed' ? 0 : digest.status === 'failed' ? 1 : 2;
}

const size = (value: unknown): number => JSON.stringify(value).length;

type Json = Record<string, unknown>;

/** Every array in a JSON-like value, in document order. */
function collectArrays(value: unknown, into: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    into.push(value);
    for (const item of value) collectArrays(item, into);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectArrays(item, into);
  }
  return into;
}

/** Shortens every string longer than `max`, except values under the `keep` keys (file paths). */
function shortenStrings(value: unknown, max: number, keep: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return truncate(value, max);
  if (Array.isArray(value)) return value.map((item) => shortenStrings(item, max, keep));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        keep.has(key) ? item : shortenStrings(item, max, keep),
      ]),
    );
  }
  return value;
}

const PATH_KEYS = new Set(['dir', 'screenshot', 'snapshot']);

/** Last resort: just enough for an agent to know what happened and where the evidence is. */
function minimal(digest: Json): Json {
  const error = digest.error as { code?: string; message?: string } | null | undefined;
  const evidence = digest.evidence as { dir?: unknown } | null | undefined;
  const out: Json = { ok: digest.ok };
  for (const key of ['status', 'action', 'flow'] as const)
    if (key in digest) out[key] = digest[key];
  if (error) out.error = { code: error.code, message: truncate(String(error.message ?? ''), 120) };
  if (typeof evidence?.dir === 'string') out.evidence = { dir: evidence.dir };
  out.truncated = true;
  return out;
}

/**
 * Makes a digest fit in `limit` characters (compact JSON), in this order: cut each list entry to
 * 300 characters, drop list entries (from the longest list), shorten strings, and finally fall back
 * to a minimal digest. Sets `truncated: true` whenever anything was cut. Never exceeds the limit.
 */
export function fitDigest<T extends object>(input: T, limit: number = DIGEST_LIMIT): T {
  if (size(input) <= limit) return input;
  const digest = structuredClone(input) as Json;
  digest.truncated = true;
  const done = (): boolean => size(digest) <= limit;

  for (const list of collectArrays(digest)) {
    list.forEach((item, i) => {
      if (typeof item === 'string') list[i] = truncate(item, ENTRY_LIMIT);
    });
  }
  if (done()) return digest as T;

  for (;;) {
    const lists = collectArrays(digest).filter((list) => list.length > 0);
    if (lists.length === 0) break;
    // Longest list loses an entry first; on a tie the later one (usually the less important).
    const longest = lists.reduce((best, list) => (list.length >= best.length ? list : best));
    longest.pop();
    if (done()) return digest as T;
  }

  let shortened: unknown = digest;
  for (const max of [200, 120, 80, 50, 30]) {
    shortened = shortenStrings(shortened, max, PATH_KEYS);
    if (size(shortened) <= limit) return shortened as T;
  }

  const fallback = minimal(digest);
  if (size(fallback) <= limit) return fallback as T;
  return { ok: digest.ok, truncated: true } as unknown as T;
}

export function buildDigest(input: DigestInput): RunDigest {
  const digest: RunDigest = {
    ok: input.status === 'passed',
    status: input.status,
    flow: input.flow,
    params: input.params ?? {},
    duration_ms: Math.round(input.durationMs),
    steps_total: input.stepsTotal,
    steps_passed: input.stepsPassed,
    failed_step: input.failedStep ?? null,
    error: input.error ?? null,
    ...(input.candidates?.length ? { candidates: input.candidates } : {}),
    evidence: input.evidence ?? null,
    next:
      input.next ??
      nextStep({
        status: input.status,
        kind: input.flow ? 'run' : 'capture',
        error: input.error,
        candidates: input.candidates,
      }),
    truncated: false,
  };
  return fitDigest(digest);
}

/** Readable rendering of a digest for terminals. */
export function formatDigestText(digest: RunDigest): string {
  const icon = digest.status === 'passed' ? '✔' : '✖';
  const name = digest.flow ?? 'capture';
  const lines = [
    digest.flow !== null || digest.steps_total > 0
      ? `${icon} ${digest.status}  ${name}  ${digest.steps_passed}/${digest.steps_total} steps  ${(digest.duration_ms / 1000).toFixed(1)}s`
      : `${icon} ${digest.status}  ${name}  ${(digest.duration_ms / 1000).toFixed(1)}s`,
  ];
  const step = digest.failed_step;
  if (step) {
    lines.push(`  step ${step.n}: ${step.type} ${step.target}`);
    if (step.expected !== null) lines.push(`    expected: ${step.expected}`);
    if (step.actual !== null) lines.push(`    actual:   ${step.actual}`);
  }
  if (digest.error) lines.push(`  ${digest.error.code}: ${digest.error.message}`);
  for (const candidate of digest.candidates ?? []) {
    lines.push(`  maybe: ${candidate.locator}  (${candidate.score})`);
  }
  const evidence = digest.evidence;
  if (evidence) {
    for (const message of evidence.console_errors) lines.push(`  console: ${message}`);
    for (const message of evidence.page_errors) lines.push(`  page error: ${message}`);
    for (const request of evidence.failed_requests) lines.push(`  network: ${request}`);
    lines.push(`  evidence: ${evidence.dir}`);
  }
  lines.push(`  next: ${digest.next}`);
  if (digest.truncated) lines.push('  (digest truncated; see run.json for the full result)');
  return lines.join('\n');
}
