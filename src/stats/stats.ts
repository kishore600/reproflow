import { appendFile, mkdir, readFile } from 'node:fs/promises';
import type { RunDigest, RunStatus } from '../evidence/digest.js';
import { projectPaths } from '../paths.js';

/** Rough size of the screenshots, DOM dumps and reasoning an agent spends per browser step. */
export const DEFAULT_TOKENS_PER_STEP = 3_800;

export interface StatEntry {
  ts: string;
  flow: string | null;
  status: RunStatus;
  duration_ms: number;
  /** Steps that actually ran (the failing one included). */
  steps: number;
  /** Length of the digest that was printed. */
  digest_chars: number;
}

/** Entry for a finished run or capture, from the digest it printed. */
export function statFromDigest(digest: RunDigest, ts: Date = new Date()): StatEntry {
  const ran =
    digest.status === 'passed'
      ? digest.steps_total
      : digest.steps_passed + (digest.failed_step ? 1 : 0);
  return {
    ts: ts.toISOString(),
    flow: digest.flow,
    status: digest.status,
    duration_ms: digest.duration_ms,
    steps: ran,
    digest_chars: JSON.stringify(digest).length,
  };
}

export async function appendStat(root: string, entry: StatEntry): Promise<void> {
  const { dir, stats } = projectPaths(root);
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(stats, `${JSON.stringify(entry)}\n`);
  } catch {
    // Stats are a convenience; never fail a run because they could not be written.
  }
}

export async function readStats(root: string): Promise<StatEntry[]> {
  const text = await readFile(projectPaths(root).stats, 'utf8').catch(() => '');
  const entries: StatEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as StatEntry);
    } catch {}
  }
  return entries;
}

/** `--tokens-per-step`, then REPROFLOW_TOKENS_PER_STEP, then .reproflow/config.json, then 3,800. */
export async function tokensPerStep(root: string, flag?: string): Promise<number> {
  const valid = (value: unknown): number | undefined => {
    const n = Number(value);
    return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const fromFile = async (): Promise<number | undefined> => {
    try {
      const config = JSON.parse(await readFile(projectPaths(root).config, 'utf8')) as {
        tokens_per_step?: unknown;
      };
      return valid(config.tokens_per_step);
    } catch {
      return undefined;
    }
  };
  return (
    valid(flag) ??
    valid(process.env.REPROFLOW_TOKENS_PER_STEP) ??
    (await fromFile()) ??
    DEFAULT_TOKENS_PER_STEP
  );
}

export interface StatsSummary {
  runs: number;
  passed: number;
  failed: number;
  errors: number;
  /** passed / runs, 0..1 (0 when there are no runs). */
  pass_rate: number;
  median_duration_ms: number;
  top_failing_flows: { flow: string; failures: number; runs: number }[];
  tokens_avoided_estimate: number;
  tokens_per_step: number;
  /** Always says this is an estimate, and how it is computed. */
  estimate_note: string;
  since_days?: number;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

export function summarizeStats(
  entries: readonly StatEntry[],
  options: { tokensPerStep: number; sinceDays?: number; now?: Date },
): StatsSummary {
  const now = (options.now ?? new Date()).getTime();
  const cutoff = options.sinceDays === undefined ? -Infinity : now - options.sinceDays * 86_400_000;
  const used = entries.filter((entry) => Date.parse(entry.ts) >= cutoff);

  const byFlow = new Map<string, { failures: number; runs: number }>();
  for (const entry of used) {
    if (entry.flow === null) continue;
    const row = byFlow.get(entry.flow) ?? { failures: 0, runs: 0 };
    row.runs++;
    if (entry.status !== 'passed') row.failures++;
    byFlow.set(entry.flow, row);
  }

  // Each run replaces `steps` agent-driven browser steps, minus the cost of reading its digest.
  const avoided = used.reduce(
    (total, entry) =>
      total + Math.max(0, entry.steps * options.tokensPerStep - entry.digest_chars / 4),
    0,
  );
  const passed = used.filter((entry) => entry.status === 'passed').length;
  return {
    runs: used.length,
    passed,
    failed: used.filter((entry) => entry.status === 'failed').length,
    errors: used.filter((entry) => entry.status === 'error').length,
    pass_rate: used.length ? Math.round((passed / used.length) * 1000) / 1000 : 0,
    median_duration_ms: median(used.map((entry) => entry.duration_ms)),
    top_failing_flows: [...byFlow.entries()]
      .filter(([, row]) => row.failures > 0)
      .map(([flow, row]) => ({ flow, ...row }))
      .sort(
        (a, b) =>
          b.failures - a.failures ||
          b.failures / b.runs - a.failures / a.runs ||
          a.flow.localeCompare(b.flow),
      )
      .slice(0, 5),
    tokens_avoided_estimate: Math.round(avoided),
    tokens_per_step: options.tokensPerStep,
    estimate_note: `estimate, not a measurement: sum over runs of steps x ${options.tokensPerStep} - digest chars / 4`,
    ...(options.sinceDays === undefined ? {} : { since_days: options.sinceDays }),
  };
}
