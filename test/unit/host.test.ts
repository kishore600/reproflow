import { describe, expect, it } from 'vitest';
import { isHostAllowed } from '../../src/engine/host.js';

describe('isHostAllowed', () => {
  it('always allows localhost and 127.0.0.1, on any port', () => {
    expect(isHostAllowed('http://localhost:3000/x')).toBe(true);
    expect(isHostAllowed('http://127.0.0.1:8080/')).toBe(true);
    expect(isHostAllowed('http://[::1]:3000/')).toBe(true);
  });

  it('allows listed hosts and nothing else', () => {
    const allowed = ['staging.example.com'];
    expect(isHostAllowed('https://staging.example.com/a', allowed)).toBe(true);
    expect(isHostAllowed('https://STAGING.example.com/a', allowed)).toBe(true);
    expect(isHostAllowed('https://example.com/', allowed)).toBe(false);
    expect(isHostAllowed('https://evil.test/?u=staging.example.com', allowed)).toBe(false);
  });

  it('supports *.suffix wildcards for subdomains only', () => {
    expect(isHostAllowed('https://a.example.com/', ['*.example.com'])).toBe(true);
    expect(isHostAllowed('https://example.com/', ['*.example.com'])).toBe(false);
    expect(isHostAllowed('https://badexample.com/', ['*.example.com'])).toBe(false);
  });

  it('rejects non-http schemes except about:', () => {
    expect(isHostAllowed('about:blank')).toBe(true);
    expect(isHostAllowed('file:///etc/passwd')).toBe(false);
    expect(isHostAllowed('javascript:alert(1)')).toBe(false);
    expect(isHostAllowed('not a url')).toBe(false);
  });
});
