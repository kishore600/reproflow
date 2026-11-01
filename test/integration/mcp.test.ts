import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunDigest } from '../../src/evidence/digest.js';
import { CLI_ENTRY } from '../helpers/cli.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let client: Client;

beforeAll(async () => {
  h = await createHarness();
  await h.signIn();
  mkdirSync(join(h.project, '.reproflow', 'flows'), { recursive: true });
  writeFileSync(
    join(h.project, '.reproflow', 'flows', 'repro-cart-total.yaml'),
    `name: repro-cart-total
description: Add a product and check the cart total
base_url: ${h.shop.url}
params:
  sku: {type: string, default: TSHIRT-M}
steps:
  - goto: /products/{{sku}}
  - click: {role: button, name: Add to cart}
  - click: {role: link, name: Cart}
  - expect_text: {target: {role: status, name: Total}, text: "$25.00"}
    timeout_ms: 1500
`,
  );

  client = new Client({ name: 'reproflow-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, 'mcp'],
      cwd: h.project,
      env: { ...(process.env as Record<string, string>), ...h.env },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await h.stop();
});

interface ToolText {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call<T = RunDigest>(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolText;
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return {
    isError: result.isError ?? false,
    text: result.content[0].text,
    json: JSON.parse(result.content[0].text) as T,
  };
}

describe('reproflow mcp', () => {
  it('offers exactly the four tools, with descriptions and input schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'reproflow_capture',
      'reproflow_list',
      'reproflow_run',
      'reproflow_save',
    ]);
    expect(tools.every((tool) => (tool.description ?? '').length > 40)).toBe(true);
    const run = tools.find((tool) => tool.name === 'reproflow_run');
    expect(run?.inputSchema.required).toEqual(['flow']);
    expect(Object.keys(run?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['flow', 'params', 'headed', 'trace', 'keep_going']),
    );
  });

  it('reproflow_list returns the same JSON as `reproflow list`', async () => {
    const { json, text, isError } = await call<{ flows: { name: string }[] }>('reproflow_list');
    expect(isError).toBe(false);
    expect(json.flows.map((flow) => flow.name)).toEqual(['repro-cart-total']);
    expect(text).toBe((await h.cli(['list'])).stdout.trim());
  });

  it('reproflow_run passes with the bug off', async () => {
    const { json, isError, text } = await call('reproflow_run', { flow: 'repro-cart-total' });
    expect(isError).toBe(false);
    expect(json).toMatchObject({ ok: true, status: 'passed', steps_total: 4, steps_passed: 4 });
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('reproflow_run fails with the bug on and carries the same digest as the CLI', async () => {
    h.shop.setBug(true);
    const viaMcp = await call('reproflow_run', { flow: 'repro-cart-total' });
    const viaCli = JSON.parse((await h.cli(['run', 'repro-cart-total'])).stdout) as RunDigest;
    h.shop.setBug(false);

    expect(viaMcp.isError).toBe(false); // a failing flow is a result, not a tool failure
    expect(viaMcp.text.length).toBeLessThanOrEqual(2000);
    expect(viaMcp.json).toMatchObject({
      ok: false,
      status: 'failed',
      error: { code: 'assertion_failed' },
    });
    expect(viaMcp.json.evidence?.console_errors).toContain('TypeError: price is undefined');
    expect(viaMcp.json.evidence?.failed_requests).toContain('GET /api/cart -> 500');
    expect(viaMcp.json.failed_step).toEqual(viaCli.failed_step);
    expect(Object.keys(viaMcp.json)).toEqual(Object.keys(viaCli));
  });

  it('reproflow_run takes params', async () => {
    const { json } = await call('reproflow_run', {
      flow: 'repro-cart-total',
      params: { sku: 'HOODIE-L' },
    });
    expect(json.params).toEqual({ sku: 'HOODIE-L' });
    expect(json.status).toBe('failed'); // the cart holds a $45.00 hoodie, the flow expects $25.00
  });

  it('reports a flow that cannot run as an error result with the digest shape', async () => {
    const { json, isError } = await call('reproflow_run', { flow: 'nope' });
    expect(isError).toBe(true);
    expect(json).toMatchObject({
      ok: false,
      status: 'error',
      flow: 'nope',
      error: { code: 'flow_not_found' },
    });
  });

  it('reproflow_capture writes the evidence bundle', async () => {
    const { json } = await call('reproflow_capture', { full_page: true });
    expect(json).toMatchObject({ ok: true, status: 'passed', flow: null });
    expect(json.evidence?.screenshot).toMatch(/screenshot\.png$/);
    const missing = await call('reproflow_capture', { locator: 'role=status[name="Totl"]' });
    expect(missing.json.error?.code).toBe('locator_not_found');
    expect(missing.json.candidates?.[0]?.locator).toBe('role=status[name="Total"]');
    const bad = await call('reproflow_capture', { locator: 'nonsense' });
    expect(bad.isError).toBe(true);
  });

  it('reproflow_save records the session and refuses to overwrite without force', async () => {
    await h.act('goto', `${h.shop.url}/products/TSHIRT-M`);
    await h.act('click', 'role=button[name="Add to cart"]');
    const saved = await call<{ status: string; flow: string; steps: number }>('reproflow_save', {
      name: 'from-mcp',
      description: 'Saved through MCP',
      last: 2,
    });
    expect(saved.isError).toBe(false);
    expect(saved.json).toMatchObject({ ok: true, status: 'saved', flow: 'from-mcp', steps: 3 });
    expect(readFileSync(join(h.project, '.reproflow', 'flows', 'from-mcp.yaml'), 'utf8')).toContain(
      'description: Saved through MCP',
    );

    const again = await call<RunDigest>('reproflow_save', { name: 'from-mcp' });
    expect(again.isError).toBe(true);
    expect(again.json.error?.message).toContain('already exists');
    const forced = await call('reproflow_save', { name: 'from-mcp', force: true });
    expect(forced.isError).toBe(false);
  });

  it('keeps stdout clean: the CLI works alongside the running server and --help is documented', async () => {
    const help = await h.cli(['mcp', '--help']);
    expect(help.code).toBe(0);
    for (const tool of ['reproflow_list', 'reproflow_run', 'reproflow_capture', 'reproflow_save']) {
      expect(help.stdout).toContain(tool);
    }
  });
});
