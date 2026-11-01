import { describe, expect, it } from 'vitest';
import {
  expandTemplate,
  hasTemplate,
  REF_SYNTAX,
  templateRefs,
  walkStrings,
} from '../../src/flows/templating.js';

describe('templating', () => {
  it('finds param and env references', () => {
    expect(templateRefs('/p/{{sku}}?k={{ env.API_KEY }}')).toEqual(['sku', 'env.API_KEY']);
    expect(hasTemplate('plain')).toBe(false);
  });

  it('expands each reference with the resolver', () => {
    const out = expandTemplate('/p/{{sku}}/{{env.X}}', (ref) => (ref === 'sku' ? 'A' : 'B'));
    expect(out).toBe('/p/A/B');
  });

  it('validates reference syntax', () => {
    for (const ok of ['sku', 'env.SHOP_PASSWORD', '_x1']) expect(REF_SYNTAX.test(ok)).toBe(true);
    for (const bad of ['', '1a', 'a-b', 'env.', 'env.a.b'])
      expect(REF_SYNTAX.test(bad)).toBe(false);
  });

  it('walks every string with its path', () => {
    const seen: string[] = [];
    walkStrings({ a: ['x', { b: 'y' }], c: 1 }, (text, path) =>
      seen.push(`${path.join('.')}=${text}`),
    );
    expect(seen).toEqual(['a.0=x', 'a.1.b=y']);
  });
});
