import { describe, expect, it } from 'vitest';
import { flowExpectsLogin } from '../../src/engine/run-flow.js';
import { absoluteUrl, describeStep, normalizeStep } from '../../src/engine/steps.js';
import { parseFlow } from '../../src/flows/load.js';
import type { Step } from '../../src/flows/schema.js';

const ctx = {
  expand: (text: string): string => text.replaceAll('{{sku}}', 'TSHIRT-M'),
  screenshotPath: (name: string | undefined): string => `/runs/${name ?? 'shot'}.png`,
};

describe('normalizeStep', () => {
  it('expands templates in goto, fill and locators', () => {
    expect(normalizeStep({ goto: '/p/{{sku}}' }, ctx)).toMatchObject({
      type: 'goto',
      url: '/p/TSHIRT-M',
    });
    expect(
      normalizeStep({ fill: { target: { label: 'SKU {{sku}}' }, value: '{{sku}}' } }, ctx),
    ).toMatchObject({ type: 'fill', target: { label: 'SKU TSHIRT-M' }, value: 'TSHIRT-M' });
  });

  it('applies defaults and carries timeout and optional', () => {
    const step = normalizeStep(
      {
        expect_text: { target: { css: '.t' }, text: 'x' },
        timeout_ms: 500,
        optional: true,
      } as Step,
      ctx,
    );
    expect(step).toEqual({
      type: 'expect_text',
      target: { css: '.t' },
      text: 'x',
      exact: false,
      timeoutMs: 500,
      optional: true,
    });
    expect(normalizeStep({ wait_for: { role: 'status' } }, ctx)).toMatchObject({
      state: 'visible',
    });
    expect(
      normalizeStep({ wait_for: { target: { role: 'status' }, state: 'hidden' } }, ctx),
    ).toMatchObject({
      state: 'hidden',
    });
  });

  it('turns every expect_url form into a mode and value', () => {
    expect(normalizeStep({ expect_url: '/cart' }, ctx)).toMatchObject({
      mode: 'equals',
      value: '/cart',
    });
    expect(normalizeStep({ expect_url: { contains: 'car' } }, ctx)).toMatchObject({
      mode: 'contains',
    });
    expect(normalizeStep({ expect_url: { matches: '^/c' } }, ctx)).toMatchObject({
      mode: 'matches',
    });
  });

  it('routes screenshot output through the caller', () => {
    expect(normalizeStep({ screenshot: { name: 'cart', full_page: true } }, ctx)).toMatchObject({
      type: 'screenshot',
      path: '/runs/cart.png',
      fullPage: true,
    });
    expect(normalizeStep({ screenshot: true }, ctx)).toMatchObject({ path: '/runs/shot.png' });
  });

  it('describes steps for digests', () => {
    expect(describeStep(normalizeStep({ click: { role: 'button', name: 'Add' } }, ctx))).toBe(
      'role=button[name="Add"]',
    );
    expect(describeStep(normalizeStep({ goto: '/x' }, ctx))).toBe('/x');
    expect(describeStep(normalizeStep({ press: 'Enter' }, ctx))).toBe('Enter');
  });
});

describe('absoluteUrl', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['localhost:3000/x', 'http://localhost:3000/x'],
    ['example.com/pricing', 'http://example.com/pricing'],
    ['about:blank', 'about:blank'],
    ['/cart', null],
    ['?page=2', null],
    ['#top', null],
    ['cart', null],
  ])('%s', (input, expected) => {
    expect(absoluteUrl(input)).toBe(expected);
  });
});

describe('flowExpectsLogin', () => {
  const flowOf = (steps: string, params = ''): ReturnType<typeof parseFlow> =>
    parseFlow(`name: t\nbase_url: http://localhost:3000\n${params}steps:\n${steps}`, 't.yaml');

  it('is true for flows that visit a login page', () => {
    expect(flowExpectsLogin(flowOf('  - goto: /login\n'))).toBe(true);
    expect(flowExpectsLogin(flowOf('  - goto: /account/signin\n'))).toBe(true);
  });

  it('is true for flows that fill a password field or a secret param', () => {
    expect(flowExpectsLogin(flowOf('  - fill: {target: {label: Password}, value: x}\n'))).toBe(
      true,
    );
    expect(
      flowExpectsLogin(
        flowOf(
          '  - fill: {target: {css: "#k"}, value: "{{pw}}"}\n',
          'params:\n  pw: {type: string, secret: true, env: PW}\n',
        ),
      ),
    ).toBe(true);
  });

  it('is false for ordinary flows', () => {
    expect(
      flowExpectsLogin(flowOf('  - goto: /cart\n  - click: {role: button, name: Buy}\n')),
    ).toBe(false);
  });
});
