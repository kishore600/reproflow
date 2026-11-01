import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunDigest } from '../../src/evidence/digest.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  await h.signIn();
});
afterAll(() => h.stop());

const capture = async (...args: string[]) => {
  const result = await h.cli(['capture', ...args]);
  return { ...result, digest: result.json<RunDigest>() };
};

const files = (dir: string): string[] => readdirSync(dir).sort();

describe('capture', () => {
  it('writes every evidence file and prints a compact digest', async () => {
    await h.act('goto', '/cart');
    await h.act('wait-for', 'role=status[name="Total"]');
    const { digest, code, stdout } = await capture();

    expect(code).toBe(0);
    expect(stdout.trim().length).toBeLessThanOrEqual(2000);
    expect(digest).toMatchObject({
      ok: true,
      status: 'passed',
      flow: null,
      params: {},
      steps_total: 0,
      steps_passed: 0,
      failed_step: null,
      error: null,
      truncated: false,
    });
    const evidence = digest.evidence;
    if (!evidence) throw new Error('capture returned no evidence');
    expect(evidence.url).toBe(`${h.shop.url}/cart`);
    expect(evidence.title).toBe('Cart - Shop');
    expect(evidence.dir).toMatch(/\/\.reproflow\/runs\/\d{8}-\d{6}-capture$/);
    expect(evidence.dir).not.toContain('\\');

    expect(files(evidence.dir)).toEqual([
      'console.jsonl',
      'network.jsonl',
      'page-errors.jsonl',
      'run.json',
      'screenshot.png',
      'snapshot.aria.yml',
    ]);
    expect(evidence.screenshot).toBe(`${evidence.dir}/screenshot.png`);
    expect(evidence.snapshot).toBe(`${evidence.dir}/snapshot.aria.yml`);
    expect(statSync(`${evidence.dir}/screenshot.png`).size).toBeGreaterThan(500);
    expect(readFileSync(`${evidence.dir}/snapshot.aria.yml`, 'utf8')).toContain('status "Total"');

    const run = JSON.parse(readFileSync(`${evidence.dir}/run.json`, 'utf8'));
    expect(run).toMatchObject({ kind: 'capture', digest: { ok: true } });
  });

  it('adds element.png with --locator', async () => {
    const { digest } = await capture('--locator', 'role=status[name="Total"]');
    const dir = digest.evidence?.dir ?? '';
    expect(digest.ok).toBe(true);
    expect(files(dir)).toContain('element.png');
    expect(statSync(`${dir}/element.png`).size).toBeGreaterThan(100);
  });

  it('captures the full page with --full-page', async () => {
    const { digest } = await capture('--full-page');
    expect(digest.ok).toBe(true);
    expect(existsSync(digest.evidence?.screenshot ?? '')).toBe(true);
  });

  it('puts the console error and the 500 in the digest when the app is broken', async () => {
    h.shop.setBug(true);
    await h.act('goto', '/cart');
    const total = await h.act('wait-for', 'role=status[name="Total"]');
    expect(total.digest.ok).toBe(true);
    h.shop.setBug(false);

    const { digest, stdout } = await capture();
    expect(stdout.trim().length).toBeLessThanOrEqual(2000);
    expect(digest.evidence?.console_errors).toContain('TypeError: price is undefined');
    expect(digest.evidence?.failed_requests).toContain('GET /api/cart -> 500');

    const dir = digest.evidence?.dir ?? '';
    const consoleLog = readFileSync(`${dir}/console.jsonl`, 'utf8');
    expect(consoleLog).toContain('TypeError: price is undefined');
    const network = readFileSync(`${dir}/network.jsonl`, 'utf8');
    expect(network).toContain('"status":500');
    const run = JSON.parse(readFileSync(`${dir}/run.json`, 'utf8'));
    expect(run.evidence.failed_requests).toContain('GET /api/cart -> 500');
  });

  it('fails with ranked candidates when --locator matches nothing', async () => {
    const { digest, code } = await capture('--locator', 'role=status[name="Totl"]');
    expect(code).toBe(1);
    expect(digest).toMatchObject({
      ok: false,
      status: 'failed',
      error: { code: 'locator_not_found' },
    });
    expect(digest.candidates?.[0]).toMatchObject({ locator: 'role=status[name="Total"]' });
    expect(digest.next).toContain('role=status[name="Total"]');
    // The bundle is still written, just without element.png.
    expect(files(digest.evidence?.dir ?? '')).not.toContain('element.png');
  });

  it('gives a failed do action the same evidence, with candidates', async () => {
    await h.act('goto', '/products/TSHIRT-M');
    const miss = await h.act('click', 'role=button[name="Add to cat"]', '--timeout', '500');
    expect(miss.code).toBe(1);
    const digest = miss.digest as unknown as RunDigest & { candidates: { locator: string }[] };
    expect(digest.error?.code).toBe('locator_not_found');
    expect(digest.candidates[0].locator).toBe('role=button[name="Add to cart"]');
    expect(files(digest.evidence?.dir ?? '')).toContain('snapshot.aria.yml');
    expect(miss.stdout.trim().length).toBeLessThanOrEqual(2000);
  });

  it('masks secrets in the snapshot, logs and run.json', async () => {
    await h.act('goto', '/login');
    const secret = 'zq9-very-secret-value';
    const filled = await h.cli(['do', 'fill', 'label="Email"', '{{env.TYPED_SECRET}}'], {
      env: { TYPED_SECRET: secret },
    });
    expect(filled.stdout).not.toContain(secret);

    const { digest } = await capture();
    const dir = digest.evidence?.dir ?? '';
    for (const name of readdirSync(dir).filter((file) => !file.endsWith('.png'))) {
      expect(readFileSync(join(dir, name), 'utf8')).not.toContain(secret);
    }
    expect(readFileSync(`${dir}/snapshot.aria.yml`, 'utf8')).toContain('***');
    expect(readFileSync(`${h.project}/.reproflow/session.jsonl`, 'utf8')).not.toContain(secret);
  });

  it('keeps only the newest 50 run folders', async () => {
    const runs = join(h.project, '.reproflow', 'runs');
    for (let i = 0; i < 55; i++) {
      mkdirSync(join(runs, `20200101-0000${String(i).padStart(2, '0')}-old`), { recursive: true });
    }
    await capture();
    const left = readdirSync(runs).filter((name) => /^\d{8}-\d{6}-/.test(name));
    expect(left).toHaveLength(50);
    expect(left).not.toContain('20200101-000000-old');
  });
});
