import { describe, expect, it } from 'vitest';
import {
  buildDigest,
  DIGEST_LIMIT,
  ENTRY_LIMIT,
  exitCodeForDigest,
  fitDigest,
  formatDigestText,
  type RunDigest,
} from '../../src/evidence/digest.js';

const long = (n: number, char = 'x'): string => char.repeat(n);
const size = (value: unknown): number => JSON.stringify(value).length;

function sample(overrides: Partial<RunDigest> = {}): RunDigest {
  return buildDigest({
    flow: 'repro-cart-total',
    status: 'failed',
    params: { sku: 'TSHIRT-M', password: '***' },
    durationMs: 1234.4,
    stepsTotal: 4,
    stepsPassed: 3,
    failedStep: {
      n: 4,
      type: 'expect_text',
      target: 'role=status[name="Total"]',
      expected: '$25.00',
      actual: '$0.00',
    },
    error: {
      code: 'assertion_failed',
      message: 'Expected role=status[name="Total"] to contain "$25.00" but got "$0.00"',
      hint: 'Compare expected and actual.',
    },
    evidence: {
      dir: '/p/.reproflow/runs/20261101-120000-repro-cart-total',
      screenshot: '/p/.reproflow/runs/20261101-120000-repro-cart-total/screenshot.png',
      snapshot: '/p/.reproflow/runs/20261101-120000-repro-cart-total/snapshot.aria.yml',
      url: 'http://localhost:3000/cart',
      title: 'Cart - Shop',
      console_errors: ['TypeError: price is undefined'],
      page_errors: [],
      failed_requests: ['GET /api/cart -> 500'],
    },
    ...overrides,
  });
}

describe('buildDigest', () => {
  it('has every documented field and is untruncated when small', () => {
    const digest = sample();
    expect(Object.keys(digest)).toEqual([
      'ok',
      'status',
      'flow',
      'params',
      'duration_ms',
      'steps_total',
      'steps_passed',
      'failed_step',
      'error',
      'evidence',
      'next',
      'truncated',
    ]);
    expect(digest).toMatchObject({ ok: false, duration_ms: 1234, truncated: false });
    expect(size(digest)).toBeLessThan(DIGEST_LIMIT);
  });

  it('adds candidates only when there are some', () => {
    expect(sample()).not.toHaveProperty('candidates');
    const withCandidates = sample({
      candidates: [
        {
          locator: 'role=button[name="Add to cart"]',
          role: 'button',
          name: 'Add to cart',
          score: 0.9,
        },
      ],
    });
    expect(withCandidates.candidates).toHaveLength(1);
  });

  it('maps status to exit codes', () => {
    expect(exitCodeForDigest({ status: 'passed' })).toBe(0);
    expect(exitCodeForDigest({ status: 'failed' })).toBe(1);
    expect(exitCodeForDigest({ status: 'error' })).toBe(2);
  });
});

describe('fitDigest', () => {
  it('returns small digests untouched', () => {
    const digest = { ok: true, list: ['a'] };
    expect(fitDigest(digest)).toBe(digest);
  });

  it('cuts each list entry to 300 characters first, keeping every entry', () => {
    const digest = {
      ok: false,
      evidence: { console_errors: [long(900, 'a'), long(900, 'b')] },
      truncated: false,
    };
    const fitted = fitDigest(digest, 800);
    expect(fitted.evidence.console_errors).toHaveLength(2);
    expect(fitted.evidence.console_errors.every((entry) => entry.length <= ENTRY_LIMIT)).toBe(true);
    expect(fitted.truncated).toBe(true);
    expect(size(fitted)).toBeLessThanOrEqual(800);
  });

  it('drops list entries from the longest list when cutting is not enough', () => {
    const entries = (prefix: string): string[] =>
      Array.from({ length: 5 }, (_, i) => `${prefix}${i}${long(280)}`);
    const digest = {
      ok: false,
      evidence: {
        console_errors: entries('c'),
        failed_requests: entries('f'),
        page_errors: entries('p'),
      },
      truncated: false,
    };
    const fitted = fitDigest(digest, 1500);
    const kept = Object.values(fitted.evidence).flat().length;
    expect(kept).toBeLessThan(15);
    expect(kept).toBeGreaterThan(0);
    expect(size(fitted)).toBeLessThanOrEqual(1500);
    expect(fitted.truncated).toBe(true);
  });

  it('shortens strings once every list is empty, but keeps file paths intact', () => {
    const dir = `/p/.reproflow/runs/20261101-120000-x`;
    const digest = {
      ok: false,
      error: { code: 'assertion_failed', message: long(5000), hint: long(5000) },
      evidence: { dir, screenshot: `${dir}/screenshot.png`, console_errors: [] },
      next: long(3000),
      truncated: false,
    };
    const fitted = fitDigest(digest);
    expect(size(fitted)).toBeLessThanOrEqual(DIGEST_LIMIT);
    expect(fitted.evidence.dir).toBe(dir);
    expect(fitted.evidence.screenshot).toBe(`${dir}/screenshot.png`);
    expect(fitted.error.message.length).toBeLessThan(5000);
    expect(fitted.truncated).toBe(true);
  });

  it('falls back to a minimal digest when even shortened strings do not fit', () => {
    const digest = {
      ok: false,
      status: 'failed',
      flow: 'x',
      params: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`param_${i}`, long(40)])),
      error: { code: 'flow_invalid', message: long(900), hint: 'h' },
      evidence: { dir: '/p/runs/r' },
      truncated: false,
    };
    const fitted = fitDigest(digest) as unknown as Record<string, unknown>;
    expect(size(fitted)).toBeLessThanOrEqual(DIGEST_LIMIT);
    expect(fitted).toMatchObject({ ok: false, status: 'failed', truncated: true });
    expect(fitted.params).toBeUndefined();
  });

  it('never exceeds 2,000 characters and always emits valid JSON, however nasty the input', () => {
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const text = (): string => {
      const chars = ['a', 'é', '"', '\\', '\n', '😀', '/', ' '];
      return Array.from(
        { length: Math.floor(random() ** 3 * 4000) },
        () => chars[Math.floor(random() * chars.length)],
      ).join('');
    };
    const list = (): string[] => Array.from({ length: Math.floor(random() * 12) }, text);

    for (let round = 0; round < 300; round++) {
      const digest = buildDigest({
        flow: round % 2 ? text().slice(0, 300) : null,
        status: (['passed', 'failed', 'error'] as const)[round % 3],
        params: Object.fromEntries(list().map((value, i) => [`p${i}`, value])),
        durationMs: random() * 1e6,
        stepsTotal: 50,
        stepsPassed: 7,
        failedStep: { n: 3, type: text(), target: text(), expected: text(), actual: text() },
        error: { code: 'assertion_failed', message: text(), hint: text() },
        candidates: Array.from({ length: 3 }, () => ({
          locator: text(),
          role: 'button',
          name: text(),
          score: 0.5,
        })),
        evidence: {
          dir: `/proj/.reproflow/runs/20261101-120000-${round}`,
          screenshot: '/proj/.reproflow/runs/x/screenshot.png',
          snapshot: '/proj/.reproflow/runs/x/snapshot.aria.yml',
          url: text(),
          title: text(),
          console_errors: list(),
          page_errors: list(),
          failed_requests: list(),
        },
        next: text(),
      });
      const printed = JSON.stringify(digest);
      expect(printed.length).toBeLessThanOrEqual(DIGEST_LIMIT);
      expect(JSON.parse(printed)).toBeTruthy();
    }
  });
});

describe('formatDigestText', () => {
  it('renders the failing step, console errors and requests for humans', () => {
    const text = formatDigestText(sample());
    expect(text).toContain('✖ failed  repro-cart-total  3/4 steps  1.2s');
    expect(text).toContain('expected: $25.00');
    expect(text).toContain('actual:   $0.00');
    expect(text).toContain('console: TypeError: price is undefined');
    expect(text).toContain('network: GET /api/cart -> 500');
  });

  it('renders a capture without step counts', () => {
    const text = formatDigestText(
      buildDigest({ flow: null, status: 'passed', durationMs: 400, stepsTotal: 0, stepsPassed: 0 }),
    );
    expect(text.split('\n')[0]).toBe('✔ passed  capture  0.4s');
  });
});
