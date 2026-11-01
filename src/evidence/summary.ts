import type { EvidenceEvent } from './collectors.js';

/** How many entries each digest list keeps. */
export const DIGEST_LIST_MAX = 5;

export interface EventSummary {
  console_errors: string[];
  page_errors: string[];
  failed_requests: string[];
}

/** Same-origin URLs print as path + query; they are shorter and read better next to "GET". */
function shortUrl(url: string, pageUrl: string): string {
  try {
    const target = new URL(url);
    return target.origin === new URL(pageUrl).origin ? target.pathname + target.search : url;
  } catch {
    return url;
  }
}

const isFavicon = (url: string): boolean => /\/favicon\.ico(\?|$)/.test(url);

const unique = (items: string[]): string[] => [...new Set(items)];

/**
 * Reduces raw events to the digest lists: console errors, uncaught page errors and failed requests
 * ("METHOD url -> status"). Noise that never helps a debugging agent is left out here and kept in
 * the .jsonl files: favicon misses, aborted requests, and Chromium's "Failed to load resource"
 * console line (it repeats the failed request).
 */
export function summarizeEvents(
  events: readonly EvidenceEvent[],
  pageUrl: string,
  limit: number = DIGEST_LIST_MAX,
): EventSummary {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failed: string[] = [];
  for (const event of events) {
    if (event.kind === 'console') {
      if (event.level === 'error' && !event.text.startsWith('Failed to load resource')) {
        consoleErrors.push(event.text);
      }
    } else if (event.kind === 'pageerror') {
      pageErrors.push(`${event.name}: ${event.message}`);
    } else if (event.kind === 'response') {
      if (!isFavicon(event.url)) {
        failed.push(`${event.method} ${shortUrl(event.url, pageUrl)} -> ${event.status}`);
      }
    } else if (!isFavicon(event.url) && !event.failure.includes('ERR_ABORTED')) {
      failed.push(`${event.method} ${shortUrl(event.url, pageUrl)} -> ${event.failure}`);
    }
  }
  return {
    console_errors: unique(consoleErrors).slice(0, limit),
    page_errors: unique(pageErrors).slice(0, limit),
    failed_requests: unique(failed).slice(0, limit),
  };
}
