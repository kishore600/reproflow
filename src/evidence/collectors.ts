import type { Page, Request } from 'playwright';

/** Events kept per page. Older ones fall off the front. */
export const RING_SIZE = 200;

/** Request types that count as "in flight" when waiting for a page to settle. */
const SETTLE_TYPES = new Set(['document', 'xhr', 'fetch', 'script', 'stylesheet']);

interface EventBase {
  /** Monotonic across all pages of a session, so runs can ask for "events since I started". */
  seq: number;
  ts: string;
}

export type EvidenceEvent = EventBase &
  (
    | { kind: 'console'; level: 'error' | 'warning'; text: string; location?: string }
    | { kind: 'pageerror'; name: string; message: string; stack?: string }
    | { kind: 'requestfailed'; method: string; url: string; failure: string; resourceType: string }
    | { kind: 'response'; method: string; url: string; status: number; resourceType: string }
  );

type NewEvent = EvidenceEvent extends infer E
  ? E extends EventBase
    ? Omit<E, keyof EventBase>
    : never
  : never;

/** Watches one page: console, page errors, failed requests, HTTP >= 400, and in-flight requests. */
export class PageWatcher {
  readonly events: EvidenceEvent[] = [];
  private readonly pending = new Set<Request>();

  constructor(
    readonly page: Page,
    private readonly nextSeq: () => number,
  ) {
    page.on('console', (message) => {
      const type = message.type();
      if (type !== 'error' && type !== 'warning') return;
      const { url, lineNumber } = message.location();
      this.push({
        kind: 'console',
        level: type,
        text: message.text(),
        location: url ? `${url}:${lineNumber}` : undefined,
      });
    });
    page.on('pageerror', (error) => {
      this.push({
        kind: 'pageerror',
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
    });
    page.on('request', (request) => {
      if (SETTLE_TYPES.has(request.resourceType())) this.pending.add(request);
    });
    page.on('requestfinished', (request) => {
      this.pending.delete(request);
    });
    page.on('requestfailed', (request) => {
      this.pending.delete(request);
      this.push({
        kind: 'requestfailed',
        method: request.method(),
        url: request.url(),
        failure: request.failure()?.errorText ?? 'failed',
        resourceType: request.resourceType(),
      });
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      const request = response.request();
      this.push({
        kind: 'response',
        method: request.method(),
        url: response.url(),
        status: response.status(),
        resourceType: request.resourceType(),
      });
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  eventsSince(seq: number): EvidenceEvent[] {
    return this.events.filter((event) => event.seq > seq);
  }

  private push(event: NewEvent): void {
    this.events.push({
      ...event,
      seq: this.nextSeq(),
      ts: new Date().toISOString(),
    } as EvidenceEvent);
    if (this.events.length > RING_SIZE) this.events.shift();
  }
}
