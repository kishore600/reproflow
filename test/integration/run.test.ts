import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunDigest } from '../../src/evidence/digest.js';
import { createHarness, DEMO_EMAIL, DEMO_PASSWORD, type Harness } from '../helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  mkdirSync(join(h.project, '.reproflow', 'flows'), { recursive: true });
});
afterAll(() => h.stop());

function writeFlow(name: string, yaml: string): void {
  writeFileSync(join(h.project, '.reproflow', 'flows', `${name}.yaml`), yaml);
}

async function run(...args: string[]) {
  const result = await h.cli(['run', ...args]);
  return { ...result, digest: result.json<RunDigest>() };
}

const head = (): string => `base_url: ${h.shop.url}
allowed_hosts: [localhost, 127.0.0.1]`;

const CART_FLOW = (): string => `name: repro-cart-total
description: Add a product and check the cart total
${head()}
params:
  sku: {type: string, default: TSHIRT-M}
  total: {type: string, default: "$25.00"}
steps:
  - goto: /products/{{sku}}
  - click: {role: button, name: Add to cart}
  - click: {role: link, name: Cart}
  - expect_text: {target: {role: status, name: Total}, text: "{{total}}"}
    timeout_ms: 1500
on_fail: capture
`;

const evidenceDir = (digest: RunDigest): string => digest.evidence?.dir ?? '';
const files = (dir: string): string[] => readdirSync(dir).sort();

describe('run: errors before the browser is involved', () => {
  it('flow_not_found lists the saved flows', async () => {
    writeFlow('repro-cart-total', CART_FLOW());
    const { digest, code } = await run('nope');
    expect(code).toBe(2);
    expect(digest).toMatchObject({
      ok: false,
      status: 'error',
      flow: 'nope',
      error: { code: 'flow_not_found' },
    });
    expect(digest.error?.hint).toContain('repro-cart-total');
  });

  it('flow_invalid names every YAML path and line', async () => {
    writeFlow(
      'bad',
      `name: bad
${head()}
steps:
  - click: {rol: button}
  - goto: /p/{{nope}}
`,
    );
    const { digest, code } = await run('bad');
    expect(code).toBe(2);
    expect(digest.error?.code).toBe('flow_invalid');
    expect(digest.error?.message).toContain('steps[0].click');
    expect(digest.error?.message).toContain('(line 5)');
    expect(digest.steps_passed).toBe(0);
  });

  it('flow_invalid catches unknown template params', async () => {
    writeFlow(
      'bad-param',
      `name: bad-param
${head()}
steps:
  - goto: /p/{{nope}}
`,
    );
    const { digest, code } = await run('bad-param');
    expect(code).toBe(2);
    expect(digest.error?.message).toContain('steps[0].goto (line 5)');
    expect(digest.error?.message).toContain('unknown param "nope"');
  });

  it('param_missing says how to pass it', async () => {
    writeFlow(
      'needs-secret',
      `name: needs-secret
${head()}
params:
  api_key: {type: string, secret: true, env: RF_TEST_MISSING_KEY}
steps:
  - goto: /login
`,
    );
    const { digest, code } = await run('needs-secret');
    expect(code).toBe(2);
    expect(digest.error).toMatchObject({
      code: 'param_missing',
      message: 'missing param: api_key',
    });
    expect(digest.error?.hint).toContain('RF_TEST_MISSING_KEY');
  });

  it('rejects params the flow does not declare, and stray words', async () => {
    const unknown = await run('repro-cart-total', '--skuu=1');
    expect(unknown.code).toBe(2);
    expect(unknown.digest.error?.message).toContain('unknown param: skuu');
    const stray = await h.cli(['run', 'repro-cart-total', 'oops']);
    expect(stray.code).toBe(2);
    expect(stray.stderr).toContain('unexpected argument');
  });
});

describe('run: against the shop app', () => {
  it('detects auth_expired when the profile is not signed in', async () => {
    const { digest, code } = await run('repro-cart-total');
    expect(code).toBe(1);
    expect(digest).toMatchObject({
      ok: false,
      status: 'failed',
      failed_step: { n: 1, type: 'goto' },
    });
    expect(digest.error?.code).toBe('auth_expired');
    expect(digest.error?.message).toContain('/login');
    expect(digest.error?.hint).toContain(`reproflow login ${h.shop.url}`);
    expect(digest.next).toContain('reproflow login');
    expect(digest.steps_passed).toBe(0);
  });

  it('still detects auth_expired when the tab is already sitting on the login page', async () => {
    // The previous run left the tab on /login; a fresh goto landing there again is still expired.
    const again = await run('repro-cart-total');
    expect(again.code).toBe(1);
    expect(again.digest.error?.code).toBe('auth_expired');
    expect(again.digest.failed_step).toMatchObject({ n: 1, type: 'goto' });
  });

  it('passes with the bug off', async () => {
    await h.signIn();
    const { digest, code, stdout } = await run('repro-cart-total');
    expect(code).toBe(0);
    expect(stdout.trim().length).toBeLessThanOrEqual(2000);
    expect(digest).toMatchObject({
      ok: true,
      status: 'passed',
      flow: 'repro-cart-total',
      params: { sku: 'TSHIRT-M', total: '$25.00' },
      steps_total: 4,
      steps_passed: 4,
      failed_step: null,
      error: null,
      truncated: false,
    });
    expect(digest.duration_ms).toBeGreaterThan(0);
    const dir = evidenceDir(digest);
    expect(dir).toMatch(/\/\.reproflow\/runs\/\d{8}-\d{6}-repro-cart-total$/);
    // A pass keeps the logs and run.json, not the screenshots.
    expect(files(dir)).toEqual(['console.jsonl', 'network.jsonl', 'page-errors.jsonl', 'run.json']);
    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(runJson).toMatchObject({ kind: 'flow', status: 'passed' });
    expect(runJson.steps.map((s: { status: string }) => s.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
    ]);
  });

  it('takes params as --name=value', async () => {
    const { digest } = await run('repro-cart-total', '--sku=HOODIE-L', '--total=$45.00');
    expect(digest).toMatchObject({ ok: true, params: { sku: 'HOODIE-L', total: '$45.00' } });
    const spaced = await run('repro-cart-total', '--sku', 'TSHIRT-L');
    expect(spaced.digest.ok).toBe(true);
  });

  it('fails with the bug on, naming the console error and the 500', async () => {
    h.shop.setBug(true);
    const { digest, code, stdout } = await run('repro-cart-total');
    h.shop.setBug(false);

    expect(code).toBe(1);
    expect(stdout.trim().length).toBeLessThanOrEqual(2000);
    expect(digest).toMatchObject({
      ok: false,
      status: 'failed',
      steps_total: 4,
      steps_passed: 3,
      failed_step: {
        n: 4,
        type: 'expect_text',
        target: 'role=status[name="Total"]',
        expected: '$25.00',
        actual: '$0.00',
      },
      error: { code: 'assertion_failed' },
    });
    expect(digest.evidence?.console_errors).toContain('TypeError: price is undefined');
    expect(digest.evidence?.failed_requests).toContain('GET /api/cart -> 500');
    expect(digest.evidence?.url).toBe(`${h.shop.url}/cart`);
    expect(stdout).toContain('GET /api/cart -> 500');
    expect(stdout).toContain('TypeError: price is undefined');

    const dir = evidenceDir(digest);
    expect(files(dir)).toEqual([
      'console.jsonl',
      'element.png',
      'network.jsonl',
      'page-errors.jsonl',
      'run.json',
      'screenshot.png',
      'snapshot.aria.yml',
    ]);
    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(runJson.steps.at(-1)).toMatchObject({
      n: 4,
      status: 'failed',
      error: { code: 'assertion_failed' },
    });
  });

  it('passes again once the bug is fixed (same flow, same params)', async () => {
    const { digest } = await run('repro-cart-total');
    expect(digest).toMatchObject({ ok: true, status: 'passed' });
  });

  it('returns ranked candidates for locator_not_found', async () => {
    writeFlow(
      'typo',
      `name: typo
${head()}
steps:
  - goto: /products/TSHIRT-M
  - click: {role: button, name: Add to cat}
    timeout_ms: 800
`,
    );
    const { digest, code } = await run('typo');
    expect(code).toBe(1);
    expect(digest.error?.code).toBe('locator_not_found');
    expect(digest.failed_step).toMatchObject({
      n: 2,
      type: 'click',
      target: 'role=button[name="Add to cat"]',
    });
    expect(digest.candidates?.length).toBeGreaterThan(0);
    expect(digest.candidates?.length).toBeLessThanOrEqual(3);
    expect(digest.candidates?.[0]).toMatchObject({
      locator: 'role=button[name="Add to cart"]',
      role: 'button',
      name: 'Add to cart',
    });
    const scores = (digest.candidates ?? []).map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(digest.next).toContain('role=button[name="Add to cart"]');
    // No element to crop, so no element.png.
    expect(files(evidenceDir(digest))).not.toContain('element.png');
  });

  it('blocks a click that navigates to a disallowed host before any request is sent', async () => {
    writeFlow(
      'offsite-click',
      `name: offsite-click
${head()}
steps:
  - goto: /
  - click: {role: link, name: External docs}
`,
    );
    const { digest, code } = await run('offsite-click');
    expect(code).toBe(1);
    expect(digest.failed_step).toMatchObject({ n: 2, type: 'click' });
    expect(digest.error).toMatchObject({ code: 'host_not_allowed' });
    expect(digest.error?.message).toContain('127.0.0.2');
    // The navigation was aborted, so the tab is still on the shop home page.
    expect(digest.evidence?.url).toBe(`${h.shop.url}/`);
  });

  it('enforces allowed_hosts on goto and on redirects', async () => {
    writeFlow(
      'offsite-goto',
      `name: offsite-goto
${head()}
steps:
  - goto: https://example.com/
`,
    );
    const direct = await run('offsite-goto');
    expect(direct.code).toBe(1);
    expect(direct.digest.error?.code).toBe('host_not_allowed');
    expect(direct.digest.error?.message).toContain('example.com');
    expect(direct.digest.error?.hint).toContain('allowed_hosts');

    writeFlow(
      'offsite-redirect',
      `name: offsite-redirect
${head()}
steps:
  - goto: /offsite
`,
    );
    const redirect = await run('offsite-redirect');
    expect(redirect.code).toBe(1);
    expect(redirect.digest.error?.code).toBe('host_not_allowed');
    expect(redirect.digest.error?.message).toContain('127.0.0.2');

    writeFlow(
      'offsite-allowed',
      `name: offsite-allowed
base_url: ${h.shop.url}
allowed_hosts: [localhost, 127.0.0.1, 127.0.0.2]
steps:
  - goto: /offsite
    timeout_ms: 2000
`,
    );
    const allowed = await run('offsite-allowed');
    // Allowed now, so the guard lets it through (nothing listens on 127.0.0.2: a different failure).
    expect(allowed.digest.error?.code).not.toBe('host_not_allowed');
  });

  it('with --keep-going runs every step and reports the first failure', async () => {
    writeFlow(
      'two-failures',
      `name: two-failures
${head()}
steps:
  - goto: /products/TSHIRT-M
  - click: {role: button, name: Nope one}
    timeout_ms: 500
  - click: {role: button, name: Add to cart}
  - click: {role: button, name: Nope two}
    timeout_ms: 500
`,
    );
    const stop = await run('two-failures');
    expect(stop.digest).toMatchObject({ steps_passed: 1, failed_step: { n: 2 } });
    const keep = await run('two-failures', '--keep-going');
    expect(keep.code).toBe(1);
    expect(keep.digest).toMatchObject({ steps_total: 4, steps_passed: 2, failed_step: { n: 2 } });
    const runJson = JSON.parse(readFileSync(join(evidenceDir(keep.digest), 'run.json'), 'utf8'));
    expect(runJson.steps.map((s: { status: string }) => s.status)).toEqual([
      'passed',
      'failed',
      'passed',
      'failed',
    ]);
  });

  it('skips a failed optional step and keeps going', async () => {
    writeFlow(
      'optional',
      `name: optional
${head()}
steps:
  - goto: /products/TSHIRT-M
  - click: {role: button, name: Dismiss cookie banner}
    optional: true
    timeout_ms: 400
  - expect_visible: {role: button, name: Add to cart}
`,
    );
    const { digest, code } = await run('optional');
    expect(code).toBe(0);
    expect(digest).toMatchObject({ ok: true, steps_total: 3, steps_passed: 2, failed_step: null });
    const runJson = JSON.parse(readFileSync(join(evidenceDir(digest), 'run.json'), 'utf8'));
    expect(runJson.steps[1]).toMatchObject({
      status: 'skipped',
      error: { code: 'locator_not_found' },
    });
  });

  it('writes trace.zip with --trace', async () => {
    const { digest } = await run('repro-cart-total', '--trace');
    expect(digest.ok).toBe(true);
    expect(existsSync(join(evidenceDir(digest), 'trace.zip'))).toBe(true);
    const without = await run('repro-cart-total');
    expect(existsSync(join(evidenceDir(without.digest), 'trace.zip'))).toBe(false);
  });

  it('supports screenshot and capture steps, and on_fail: none', async () => {
    writeFlow(
      'shots',
      `name: shots
${head()}
steps:
  - goto: /cart
  - screenshot: {name: cart}
  - capture: true
  - expect_text: {target: {css: body}, text: this text is not on the page}
    timeout_ms: 300
on_fail: none
`,
    );
    const { digest } = await run('shots');
    const dir = evidenceDir(digest);
    expect(digest.error?.code).toBe('assertion_failed');
    expect(files(dir)).toEqual(
      expect.arrayContaining(['step-2-cart.png', 'capture-3', 'run.json', 'console.jsonl']),
    );
    expect(files(join(dir, 'capture-3'))).toContain('snapshot.aria.yml');
    // on_fail: none means no failure screenshot or snapshot at the top level.
    expect(files(dir)).not.toContain('screenshot.png');
    expect(digest.evidence?.screenshot).toBeNull();
  });

  it('signs in with a secret param and never writes the secret anywhere', async () => {
    writeFlow(
      'login',
      `name: login
${head()}
params:
  email: {type: string, default: ${DEMO_EMAIL}}
  password: {type: string, secret: true, env: RF_TEST_PASSWORD}
steps:
  - goto: /login
  - fill: {target: {label: Email}, value: "{{email}}"}
  - fill: {target: {label: Password}, value: "{{password}}"}
  - click: {role: button, name: Sign in}
  - expect_url: /
    timeout_ms: 1500
`,
    );
    const good = await h.cli(['run', 'login'], { env: { RF_TEST_PASSWORD: DEMO_PASSWORD } });
    const goodDigest = good.json<RunDigest>();
    expect(goodDigest).toMatchObject({ ok: true, params: { password: '***' } });

    const wrong = 'definitely-wrong-pw-123';
    const bad = await h.cli(['run', 'login', `--password=${wrong}`]);
    const badDigest = bad.json<RunDigest>();
    expect(bad.code).toBe(1);
    expect(badDigest.failed_step?.type).toBe('expect_url');
    expect(badDigest.error?.code).toBe('assertion_failed');
    expect(badDigest.params).toMatchObject({ password: '***' });

    for (const secret of [DEMO_PASSWORD, wrong]) {
      expect(good.stdout + bad.stdout).not.toContain(secret);
      for (const dir of [evidenceDir(goodDigest), evidenceDir(badDigest)]) {
        for (const name of readdirSync(dir).filter((file) => !/\.(png|zip)$/.test(file))) {
          expect(readFileSync(join(dir, name), 'utf8')).not.toContain(secret);
        }
      }
      expect(readFileSync(join(h.project, '.reproflow', 'session.jsonl'), 'utf8')).not.toContain(
        secret,
      );
    }
  });
});

describe('list and describe', () => {
  it('lists flows compactly with typed params', async () => {
    const result = await h.cli(['list']);
    const { flows } = result.json<{ flows: Record<string, unknown>[] }>();
    const cart = flows.find((flow) => flow.name === 'repro-cart-total');
    expect(cart).toEqual({
      name: 'repro-cart-total',
      description: 'Add a product and check the cart total',
      params: ['sku:string', 'total:string'],
    });
    expect(flows.find((flow) => flow.name === 'login')?.params).toEqual([
      'email:string',
      'password:string*',
    ]);
    const bad = flows.find((flow) => flow.name === 'bad');
    expect(bad?.error).toContain('flow_invalid'.length ? 'bad.yaml' : '');
    // Small enough to be cheap for an agent to read: about 20-35 tokens (~4 chars each) per flow.
    expect(JSON.stringify(cart).length / 4).toBeLessThan(35);
  });

  it('describes a flow as JSON', async () => {
    const result = await h.cli(['describe', 'repro-cart-total']);
    const flow = result.json<{ name: string; steps: unknown[]; params: Record<string, unknown> }>();
    expect(result.code).toBe(0);
    expect(flow.name).toBe('repro-cart-total');
    expect(flow.steps).toHaveLength(4);
    expect(flow.params).toHaveProperty('sku');
  });

  it('describe reports flow_not_found and flow_invalid', async () => {
    const missing = await h.cli(['describe', 'nope']);
    expect(missing.code).toBe(2);
    expect(missing.json<RunDigest>().error?.code).toBe('flow_not_found');
    const invalid = await h.cli(['describe', 'bad']);
    expect(invalid.code).toBe(2);
    expect(invalid.json<RunDigest>().error?.code).toBe('flow_invalid');
  });
});
