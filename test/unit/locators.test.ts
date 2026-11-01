import { describe, expect, it } from 'vitest';
import { formatLocator, LocatorSyntaxError, parseLocator } from '../../src/engine/locators.js';
import type { LocatorSpec } from '../../src/flows/schema.js';

describe('parseLocator', () => {
  it.each<[string, LocatorSpec]>([
    ['role=button[name="Add to cart"]', { role: 'button', name: 'Add to cart' }],
    ['role=button', { role: 'button' }],
    ["role=link[name='Cart']", { role: 'link', name: 'Cart' }],
    ['role=button[name=Add to cart]', { role: 'button', name: 'Add to cart' }],
    ['role=status[name="Total"][exact]', { role: 'status', name: 'Total', exact: true }],
    ['role=listitem[nth=2]', { role: 'listitem', nth: 2 }],
    ['label="Email"', { label: 'Email' }],
    ['text="Cart"', { text: 'Cart' }],
    ['placeholder="Search"', { placeholder: 'Search' }],
    ['testid=checkout', { testid: 'checkout' }],
    ['css=.cart-total', { css: '.cart-total' }],
    ['css=div > a[href="/x"]', { css: 'div > a[href="/x"]' }],
    ['"Cart"', { text: 'Cart' }],
    ["'Sign in'", { text: 'Sign in' }],
  ])('parses %s', (input, expected) => {
    expect(parseLocator(input)).toEqual(expected);
  });

  it('reads escapes inside quotes', () => {
    expect(parseLocator('label="Say \\"hi\\""')).toEqual({ label: 'Say "hi"' });
  });

  it('applies nth and exact modifiers', () => {
    expect(parseLocator('role=link[name="Cart"] >> nth=1')).toEqual({
      role: 'link',
      name: 'Cart',
      nth: 1,
    });
    expect(parseLocator('text="Cart" >> exact >> nth=0')).toEqual({
      text: 'Cart',
      exact: true,
      nth: 0,
    });
    expect(parseLocator('css=ul > li >> nth=3')).toEqual({ css: 'ul > li', nth: 3 });
  });

  it.each([
    '',
    '   ',
    'button',
    'name=foo',
    'role=',
    'role=button[name="oops"',
    'role=button[bogus=1]',
    'role=button trailing',
    'label="unterminated',
    'label="a" b',
  ])('rejects %j', (input) => {
    expect(() => parseLocator(input)).toThrow(LocatorSyntaxError);
  });
});

describe('formatLocator', () => {
  const specs: LocatorSpec[] = [
    { role: 'button', name: 'Add to cart' },
    { role: 'button' },
    { role: 'link', name: 'He said "hi"', nth: 1 },
    { label: 'Email', exact: true },
    { text: 'Cart' },
    { placeholder: 'Search' },
    { testid: 'checkout' },
    { css: '.cart-total' },
    { css: 'ul > li', nth: 2 },
  ];

  it.each(specs)('round-trips %j', (spec) => {
    expect(parseLocator(formatLocator(spec))).toEqual(spec);
  });

  it('prints the documented shorthand', () => {
    expect(formatLocator({ role: 'button', name: 'Add to cart' })).toBe(
      'role=button[name="Add to cart"]',
    );
    expect(formatLocator({ testid: 'checkout' })).toBe('testid=checkout');
    expect(formatLocator({ css: '.cart-total' })).toBe('css=.cart-total');
  });
});
