import { describe, expect, it } from 'vitest';
import type { EvidenceEvent } from '../../src/evidence/collectors.js';
import { summarizeEvents } from '../../src/evidence/summary.js';

let seq = 0;
const at = { ts: '2026-11-01T00:00:00.000Z' };
const response = (url: string, status: number, method = 'GET'): EvidenceEvent => ({
  kind: 'response',
  method,
  url,
  status,
  resourceType: 'fetch',
  seq: ++seq,
  ...at,
});
const failed = (url: string, failure: string): EvidenceEvent => ({
  kind: 'requestfailed',
  method: 'GET',
  url,
  failure,
  resourceType: 'fetch',
  seq: ++seq,
  ...at,
});
const logged = (level: 'error' | 'warning', text: string): EvidenceEvent => ({
  kind: 'console',
  level,
  text,
  seq: ++seq,
  ...at,
});

describe('summarizeEvents', () => {
  const page = 'http://127.0.0.1:3000/cart';

  it('prints same-origin requests as METHOD path -> status', () => {
    const summary = summarizeEvents([response('http://127.0.0.1:3000/api/cart?x=1', 500)], page);
    expect(summary.failed_requests).toEqual(['GET /api/cart?x=1 -> 500']);
  });

  it('keeps the full URL for other origins', () => {
    const summary = summarizeEvents([response('https://cdn.example.com/a.js', 404)], page);
    expect(summary.failed_requests).toEqual(['GET https://cdn.example.com/a.js -> 404']);
  });

  it('keeps console errors, drops warnings and the duplicate "Failed to load resource" line', () => {
    const summary = summarizeEvents(
      [
        logged('warning', 'deprecated'),
        logged('error', 'Failed to load resource: the server responded with a status of 500'),
        logged('error', 'TypeError: price is undefined'),
      ],
      page,
    );
    expect(summary.console_errors).toEqual(['TypeError: price is undefined']);
  });

  it('formats page errors as name: message', () => {
    const summary = summarizeEvents(
      [
        {
          kind: 'pageerror',
          name: 'ReferenceError',
          message: 'x is not defined',
          seq: ++seq,
          ...at,
        },
      ],
      page,
    );
    expect(summary.page_errors).toEqual(['ReferenceError: x is not defined']);
  });

  it('ignores favicon misses and aborted requests, but reports other network failures', () => {
    const summary = summarizeEvents(
      [
        response('http://127.0.0.1:3000/favicon.ico', 404),
        failed('http://127.0.0.1:3000/api/slow', 'net::ERR_ABORTED'),
        failed('http://127.0.0.1:3000/api/down', 'net::ERR_CONNECTION_REFUSED'),
      ],
      page,
    );
    expect(summary.failed_requests).toEqual(['GET /api/down -> net::ERR_CONNECTION_REFUSED']);
  });

  it('dedupes and caps each list at 5 (or the given limit)', () => {
    const many = Array.from({ length: 9 }, (_, i) => response(`http://127.0.0.1:3000/a/${i}`, 500));
    expect(summarizeEvents([...many, ...many], page).failed_requests).toHaveLength(5);
    expect(summarizeEvents(many, page, Number.POSITIVE_INFINITY).failed_requests).toHaveLength(9);
  });
});
