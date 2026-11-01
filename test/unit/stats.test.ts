import { describe, expect, it } from 'vitest';
import { buildDigest } from '../../src/evidence/digest.js';
import { type StatEntry, statFromDigest, summarizeStats } from '../../src/stats/stats.js';

const NOW = new Date('2026-11-10T12:00:00Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const stat = (extra: Partial<StatEntry>): StatEntry => ({
  ts: daysAgo(0),
  flow: 'cart',
  status: 'passed',
  duration_ms: 1000,
  steps: 4,
  digest_chars: 400,
  ...extra,
});

describe('summarizeStats', () => {
  const entries = [
    stat({ duration_ms: 1000 }),
    stat({ duration_ms: 3000, status: 'failed', steps: 3 }),
    stat({ flow: 'login', duration_ms: 2000, status: 'failed' }),
    stat({ flow: 'login', duration_ms: 500, status: 'failed', ts: daysAgo(20) }),
    stat({ flow: 'cart', status: 'error', steps: 0, duration_ms: 20 }),
    stat({ flow: null, duration_ms: 400, steps: 0, digest_chars: 600 }),
  ];

  it('counts runs, pass rate and the median duration', () => {
    const summary = summarizeStats(entries, { tokensPerStep: 3800, now: NOW });
    expect(summary).toMatchObject({
      runs: 6,
      passed: 2,
      failed: 3,
      errors: 1,
      median_duration_ms: 750,
    });
    expect(summary.pass_rate).toBeCloseTo(0.333, 3);
  });

  it('ranks the top failing flows and ignores captures', () => {
    const summary = summarizeStats(entries, { tokensPerStep: 3800, now: NOW });
    expect(summary.top_failing_flows).toEqual([
      { flow: 'login', failures: 2, runs: 2 },
      { flow: 'cart', failures: 2, runs: 3 },
    ]);
  });

  it('estimates tokens avoided as steps x tokens-per-step minus digest chars / 4, per run', () => {
    const summary = summarizeStats(
      [stat({ steps: 4, digest_chars: 400 }), stat({ steps: 0, digest_chars: 800 })],
      {
        tokensPerStep: 3800,
        now: NOW,
      },
    );
    // 4 * 3800 - 400 / 4 = 15100; a run with no steps cannot go negative.
    expect(summary.tokens_avoided_estimate).toBe(15_100);
    expect(summary.tokens_per_step).toBe(3800);
    expect(summary.estimate_note).toMatch(/^estimate/);
  });

  it('makes the per-step cost configurable', () => {
    const summary = summarizeStats([stat({ steps: 2, digest_chars: 0 })], {
      tokensPerStep: 1000,
      now: NOW,
    });
    expect(summary.tokens_avoided_estimate).toBe(2000);
  });

  it('filters by --since days', () => {
    const summary = summarizeStats(entries, { tokensPerStep: 3800, sinceDays: 7, now: NOW });
    expect(summary.runs).toBe(5);
    expect(summary.since_days).toBe(7);
  });

  it('copes with no runs', () => {
    expect(summarizeStats([], { tokensPerStep: 3800, now: NOW })).toMatchObject({
      runs: 0,
      pass_rate: 0,
      median_duration_ms: 0,
      top_failing_flows: [],
      tokens_avoided_estimate: 0,
    });
  });
});

describe('statFromDigest', () => {
  it('counts every step of a pass, and the failing step of a failure', () => {
    const passed = buildDigest({
      flow: 'cart',
      status: 'passed',
      durationMs: 900,
      stepsTotal: 4,
      stepsPassed: 4,
    });
    expect(statFromDigest(passed)).toMatchObject({
      flow: 'cart',
      status: 'passed',
      duration_ms: 900,
      steps: 4,
    });
    const failed = buildDigest({
      flow: 'cart',
      status: 'failed',
      durationMs: 900,
      stepsTotal: 4,
      stepsPassed: 2,
      failedStep: { n: 3, type: 'click', target: 'x', expected: null, actual: null },
    });
    expect(statFromDigest(failed).steps).toBe(3);
    expect(statFromDigest(failed).digest_chars).toBe(JSON.stringify(failed).length);
  });
});
