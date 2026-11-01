import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunDigest } from '../../src/evidence/digest.js';
import { parseFlow } from '../../src/flows/load.js';
import { createHarness, DEMO_PASSWORD, type Harness } from '../helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  await h.signIn();
});
afterAll(() => h.stop());

const resetSession = (): void => {
  rmSync(join(h.project, '.reproflow', 'session.jsonl'), { force: true });
};
const flowText = (name: string): string =>
  readFileSync(join(h.project, '.reproflow', 'flows', `${name}.yaml`), 'utf8');
const save = (...args: string[]) => h.cli(['save', ...args]);
const run = async (name: string, ...args: string[]) => {
  const result = await h.cli(['run', name, ...args]);
  return { ...result, digest: result.json<RunDigest>() };
};

describe('save --from-session', () => {
  it('turns a recorded session into a flow that then passes', async () => {
    resetSession();
    await h.act('goto', `${h.shop.url}/products/TSHIRT-M`);
    await h.act('fill', 'label="Quantity"', '2');
    await h.act('click', 'text="Add to cart"');
    await h.act('click', 'role=link[name="Cart"]');
    await h.act('wait-for', 'role=status[name="Total"]');

    const saved = await save(
      'cart',
      '--from-session',
      '--description',
      'Add two shirts and open the cart',
    );
    expect(saved.code).toBe(0);
    expect(saved.json()).toMatchObject({
      ok: true,
      status: 'saved',
      flow: 'cart',
      steps: 6,
      params: ['quantity'],
    });

    const yaml = flowText('cart');
    expect(yaml).toContain(`base_url: ${h.shop.url}`);
    const flow = parseFlow(yaml, 'cart.yaml');
    expect(flow.description).toBe('Add two shirts and open the cart');
    expect(flow.params).toEqual({ quantity: { type: 'number', default: 2 } });
    expect(flow.steps).toEqual([
      { goto: '/products/TSHIRT-M' },
      { fill: { target: { role: 'spinbutton', name: 'Quantity' }, value: '{{quantity}}' } },
      { click: { role: 'button', name: 'Add to cart' } }, // upgraded from text="Add to cart"
      { click: { role: 'link', name: 'Cart' } },
      { wait_for: { role: 'status', name: 'Total' } },
      { expect_url: '/cart' },
    ]);

    const replay = await run('cart');
    expect(replay.code).toBe(0);
    expect(replay.digest).toMatchObject({
      ok: true,
      status: 'passed',
      steps_total: 6,
      steps_passed: 6,
    });

    const withParam = await run('cart', '--quantity=3');
    expect(withParam.digest).toMatchObject({ ok: true, params: { quantity: 3 } });
  });

  it('refuses to overwrite without --force', async () => {
    const refused = await save('cart', '--from-session');
    expect(refused.code).toBe(2);
    expect(refused.json<RunDigest>().error).toMatchObject({ code: 'flow_invalid' });
    expect(refused.json<RunDigest>().error?.message).toContain('already exists');
    const forced = await save('cart', '--from-session', '--force');
    expect(forced.code).toBe(0);
  });

  it('records the last N actions with --last', async () => {
    const result = await save('tail', '--from-session', '--last', '2');
    expect(result.json()).toMatchObject({ status: 'saved', steps: 4 });
    const flow = parseFlow(flowText('tail'), 'tail.yaml');
    expect(flow.steps.map((step) => Object.keys(step)[0])).toEqual([
      'goto', // where the first of the two actions started
      'click',
      'wait_for',
      'expect_url',
    ]);
  });

  it('records a sign-in without ever writing the password, and the flow replays it', async () => {
    resetSession();
    await h.act('goto', `${h.shop.url}/login`);
    await h.act('fill', 'label="Email"', 'demo@example.com');
    // A raw password on the command line: it is masked in the session log because the field is a password.
    const filled = await h.cli(['do', 'fill', 'label="Password"', DEMO_PASSWORD]);
    expect(filled.stdout).not.toContain(DEMO_PASSWORD);
    await h.act('click', 'role=button[name="Sign in"]');

    const saved = await save('pw-login', '--from-session');
    expect(saved.json()).toMatchObject({ status: 'saved', secret_env: ['PW_LOGIN_PASSWORD'] });
    expect(saved.json<{ next: string }>().next).toContain('PW_LOGIN_PASSWORD');

    const yaml = flowText('pw-login');
    expect(yaml).not.toContain(DEMO_PASSWORD);
    expect(yaml).toContain('secret: true');
    expect(yaml).toContain('env: PW_LOGIN_PASSWORD');
    expect(readFileSync(join(h.project, '.reproflow', 'session.jsonl'), 'utf8')).not.toContain(
      DEMO_PASSWORD,
    );

    const missing = await run('pw-login');
    expect(missing.code).toBe(2);
    expect(missing.digest.error?.code).toBe('param_missing');
    expect(missing.digest.error?.hint).toContain('PW_LOGIN_PASSWORD');

    const replay = await h.cli(['run', 'pw-login'], { env: { PW_LOGIN_PASSWORD: DEMO_PASSWORD } });
    expect(replay.code).toBe(0);
    expect(replay.stdout).not.toContain(DEMO_PASSWORD);
    expect(replay.json<RunDigest>()).toMatchObject({ ok: true, params: { password: '***' } });
  });

  it('keeps the env var name when the session used an {{env.NAME}} template', async () => {
    resetSession();
    await h.act('goto', `${h.shop.url}/login`);
    await h.act('fill', 'label="Email"', 'demo@example.com');
    await h.act('fill', 'label="Password"', '{{env.SHOP_PASSWORD}}');
    await h.act('click', 'role=button[name="Sign in"]');
    const saved = await save('env-login', '--from-session');
    expect(saved.json()).toMatchObject({ secret_env: ['SHOP_PASSWORD'] });
    expect(flowText('env-login')).toContain('env: SHOP_PASSWORD');
    const replay = await run('env-login');
    expect(replay.digest).toMatchObject({ ok: true, status: 'passed' });
  });

  it('rejects bad usage with exit code 2', async () => {
    expect((await save('x')).code).toBe(2); // no --from-session
    expect((await save('../evil', '--from-session')).code).toBe(2);
    expect((await save('x', '--from-session', '--last', '0')).code).toBe(2);
    resetSession();
    const empty = await save('empty', '--from-session');
    expect(empty.code).toBe(2);
    expect(empty.json<RunDigest>().error?.message).toContain('no successful actions');
  });
});

describe('stats', () => {
  it('summarises the runs so far, labelling the token figure as an estimate', async () => {
    const result = await h.cli(['stats']);
    const stats = result.json<Record<string, number | string | unknown[]>>();
    expect(result.code).toBe(0);
    expect(stats.runs).toBeGreaterThanOrEqual(5);
    expect(stats.passed).toBeGreaterThanOrEqual(4);
    expect(stats.pass_rate).toBeGreaterThan(0);
    expect(stats.median_duration_ms).toBeGreaterThan(0);
    expect(stats.tokens_avoided_estimate).toBeGreaterThan(10_000);
    expect(stats.tokens_per_step).toBe(3800);
    expect(String(stats.estimate_note)).toMatch(/^estimate/);
  });

  it('takes the per-step cost from a flag, the environment or config.json', async () => {
    const base = (await h.cli(['stats'])).json<{ tokens_avoided_estimate: number }>()
      .tokens_avoided_estimate;
    const flagged = (await h.cli(['stats', '--tokens-per-step', '1900'])).json<{
      tokens_per_step: number;
      tokens_avoided_estimate: number;
    }>();
    expect(flagged.tokens_per_step).toBe(1900);
    expect(flagged.tokens_avoided_estimate).toBeLessThan(base);

    const fromEnv = await h.cli(['stats'], { env: { REPROFLOW_TOKENS_PER_STEP: '1000' } });
    expect(fromEnv.json<{ tokens_per_step: number }>().tokens_per_step).toBe(1000);
  });

  it('counts failed runs and ranks failing flows', async () => {
    writeFileSync(
      join(h.project, '.reproflow', 'flows', 'failing.yaml'),
      `name: failing
base_url: ${h.shop.url}
steps:
  - goto: /
  - click: {role: button, name: There is no such button}
    timeout_ms: 300
`,
    );
    expect((await run('failing')).code).toBe(1);
    expect((await run('failing')).code).toBe(1);
    const stats = (await h.cli(['stats'])).json<{
      failed: number;
      top_failing_flows: { flow: string; failures: number; runs: number }[];
    }>();
    expect(stats.failed).toBeGreaterThanOrEqual(2);
    expect(stats.top_failing_flows[0]).toEqual({ flow: 'failing', failures: 2, runs: 2 });
    const since = (await h.cli(['stats', '--since', '1'])).json<{
      runs: number;
      since_days: number;
    }>();
    expect(since.since_days).toBe(1);
    expect(since.runs).toBeGreaterThan(0);
  });
});
