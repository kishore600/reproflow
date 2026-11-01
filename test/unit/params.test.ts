import { describe, expect, it } from 'vitest';
import type { ReproflowError } from '../../src/errors.js';
import { parseFlow } from '../../src/flows/load.js';
import { envRefs, parseParamTokens, resolveEnv, resolveParams } from '../../src/flows/params.js';

const flow = parseFlow(
  `
name: t
base_url: http://localhost:3000
params:
  sku: {type: string, default: TSHIRT-M}
  qty: {type: number, default: 1}
  gift: {type: boolean, default: false}
  password: {type: string, secret: true, env: SHOP_PASSWORD}
  note: {type: string, required: false}
steps:
  - goto: /p/{{sku}}?k={{env.API_KEY}}
  - fill: {target: {label: Key}, value: "{{env.OTHER}}"}
`,
  't.yaml',
);

function error(run: () => unknown): ReproflowError {
  try {
    run();
  } catch (caught) {
    return caught as ReproflowError;
  }
  throw new Error('expected a throw');
}

describe('resolveParams', () => {
  it('uses defaults, then env, then --overrides', () => {
    const base = resolveParams(flow, {}, { SHOP_PASSWORD: 'from-env' });
    expect(base.values).toEqual({
      sku: 'TSHIRT-M',
      qty: 1,
      gift: false,
      password: 'from-env',
      note: '',
    });

    const overridden = resolveParams(
      flow,
      { sku: 'HOODIE-L', password: 'cli' },
      { SHOP_PASSWORD: 'from-env' },
    );
    expect(overridden.values).toMatchObject({ sku: 'HOODIE-L', password: 'cli' });
  });

  it('coerces number and boolean params', () => {
    const resolved = resolveParams(flow, { qty: '3', gift: 'yes' }, { SHOP_PASSWORD: 'x' });
    expect(resolved.values).toMatchObject({ qty: 3, gift: true });
    expect(error(() => resolveParams(flow, { qty: 'many' }, { SHOP_PASSWORD: 'x' })).code).toBe(
      'flow_invalid',
    );
    expect(
      error(() => resolveParams(flow, { gift: 'maybe' }, { SHOP_PASSWORD: 'x' })).message,
    ).toMatch(/true or false/);
  });

  it('masks secrets in the printable copy and names them', () => {
    const resolved = resolveParams(flow, {}, { SHOP_PASSWORD: 'hunter2' });
    expect(resolved.secretNames).toEqual(['password']);
    expect(resolved.masked.password).toBe('***');
    expect(resolved.masked.sku).toBe('TSHIRT-M');
    expect(JSON.stringify(resolved.masked)).not.toContain('hunter2');
  });

  it('throws param_missing with a hint naming the flag and the env var', () => {
    const missing = error(() => resolveParams(flow, {}, {}));
    expect(missing.code).toBe('param_missing');
    expect(missing.message).toBe('missing param: password');
    expect(missing.hint).toBe('Pass --password=<value> or set SHOP_PASSWORD.');
  });

  it('throws flow_invalid for params the flow does not declare', () => {
    const unknown = error(() => resolveParams(flow, { skuu: 'x' }, { SHOP_PASSWORD: 'x' }));
    expect(unknown.code).toBe('flow_invalid');
    expect(unknown.message).toContain('unknown param: skuu');
    expect(unknown.message).toContain('sku');
  });
});

describe('environment references', () => {
  it('finds every {{env.NAME}} in steps', () => {
    expect(envRefs(flow).sort()).toEqual(['API_KEY', 'OTHER']);
  });

  it('reads them from the environment or throws param_missing', () => {
    expect(resolveEnv(flow, { API_KEY: 'a', OTHER: 'b' })).toEqual({ API_KEY: 'a', OTHER: 'b' });
    const missing = error(() => resolveEnv(flow, { API_KEY: 'a' }));
    expect(missing.code).toBe('param_missing');
    expect(missing.message).toContain('OTHER');
  });
});

describe('parseParamTokens', () => {
  it('reads --name=value and --name value', () => {
    expect(parseParamTokens(['--sku=A', '--qty', '3', '--gift'])).toEqual({
      params: { sku: 'A', qty: '3', gift: 'true' },
      stray: [],
    });
  });

  it('keeps "=" inside values and reports stray words', () => {
    expect(parseParamTokens(['--q=a=b', 'oops'])).toEqual({
      params: { q: 'a=b' },
      stray: ['oops'],
    });
  });
});
