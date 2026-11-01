import { describe, expect, it } from 'vitest';
import { MASK, maskDeep, maskText } from '../../src/evidence/mask.js';

describe('maskText', () => {
  it('replaces every occurrence of each secret', () => {
    expect(maskText('pw=hunter2 and again hunter2', ['hunter2'])).toBe(
      `pw=${MASK} and again ${MASK}`,
    );
  });

  it('also masks the URL-encoded spelling', () => {
    expect(maskText('GET /x?p=a%20b%26c', ['a b&c'])).toBe(`GET /x?p=${MASK}`);
  });

  it('masks longer secrets first so a prefix secret cannot expose the rest', () => {
    expect(maskText('token-abcdef', ['token', 'token-abcdef'])).toBe(MASK);
  });

  it('ignores empty secrets', () => {
    expect(maskText('unchanged', [''])).toBe('unchanged');
  });
});

describe('maskDeep', () => {
  it('masks strings nested in objects and arrays and leaves other values alone', () => {
    const value = { a: 'x hunter2', list: ['hunter2', 3, null], deep: { ok: true, s: 'hunter2!' } };
    expect(maskDeep(value, ['hunter2'])).toEqual({
      a: `x ${MASK}`,
      list: [MASK, 3, null],
      deep: { ok: true, s: `${MASK}!` },
    });
  });

  it('returns the input untouched when there are no secrets', () => {
    const value = { a: 'b' };
    expect(maskDeep(value, [])).toBe(value);
  });
});
