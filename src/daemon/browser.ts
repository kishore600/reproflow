import { mkdir } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import type { SessionPort } from '../engine/steps.js';
import { type EvidenceEvent, PageWatcher } from '../evidence/collectors.js';
import { profileDir } from '../paths.js';
import { persistCookies, restoreCookies } from './cookies.js';

export const VIEWPORT = { width: 1280, height: 800 } as const;

const MAX_CLOSED_WATCHERS = 20;

/** Tests and CI set this to keep `--headed` from needing a display. */
export const forceHeadless = (): boolean => process.env.REPROFLOW_FORCE_HEADLESS === '1';

/**
 * Optional Playwright channel (`chrome`, `msedge`, ...) to drive an installed browser instead of
 * the bundled Chromium, e.g. where the Playwright download is blocked.
 */
export const browserChannel = (): string | undefined =>
  process.env.REPROFLOW_BROWSER_CHANNEL || undefined;

/** The persistent Chromium context plus per-page collectors and the "active tab". */
export class BrowserSession implements SessionPort {
  private readonly watchers = new Map<Page, PageWatcher>();
  private readonly closedWatchers: PageWatcher[] = [];
  private active: Page | undefined;
  private seq = 0;

  private constructor(
    readonly context: BrowserContext,
    readonly profilePath: string,
  ) {
    context.on('page', (page) => this.attach(page));
    for (const page of context.pages()) this.attach(page);
  }

  static async launch(options: { profile: string; headed: boolean }): Promise<BrowserSession> {
    const profilePath = profileDir(options.profile);
    await mkdir(profilePath, { recursive: true });
    const { chromium } = await import('playwright');
    const context = await chromium.launchPersistentContext(profilePath, {
      channel: browserChannel(),
      headless: forceHeadless() || !options.headed,
      viewport: VIEWPORT,
    });
    await restoreCookies(context, profilePath);
    const session = new BrowserSession(context, profilePath);
    await session.ensurePage();
    return session;
  }

  private attach(page: Page): void {
    const watcher = new PageWatcher(page, () => ++this.seq);
    this.watchers.set(page, watcher);
    page.on('close', () => {
      this.watchers.delete(page);
      // A popup that closes itself mid-run should still show up in the run's evidence.
      this.closedWatchers.push(watcher);
      if (this.closedWatchers.length > MAX_CLOSED_WATCHERS) this.closedWatchers.shift();
      if (this.active === page) this.active = undefined;
    });
  }

  /** Sequence number of the newest collected event; runs use it to scope their evidence. */
  get lastSeq(): number {
    return this.seq;
  }

  /** Events from every tab (open or recently closed) newer than `seq`, oldest first. */
  eventsSince(seq: number): EvidenceEvent[] {
    return [...this.watchers.values(), ...this.closedWatchers]
      .flatMap((watcher) => watcher.eventsSince(seq))
      .sort((a, b) => a.seq - b.seq);
  }

  pages(): Page[] {
    return this.context.pages().filter((page) => !page.isClosed());
  }

  /** The tab commands act on: the last one switched to, else the newest open one. */
  get page(): Page {
    if (this.active && !this.active.isClosed()) return this.active;
    const open = this.pages();
    const page = open[open.length - 1];
    if (!page) throw new Error('the browser has no open tabs');
    // Stick to it: a tab that opens later (target=_blank) must not silently become the active one.
    this.active = page;
    return page;
  }

  async ensurePage(): Promise<Page> {
    if (this.pages().length === 0) await this.context.newPage();
    return this.page;
  }

  setActive(page: Page): void {
    this.active = page;
  }

  watcher(page: Page): PageWatcher | undefined {
    return this.watchers.get(page);
  }

  persistCookies(): Promise<void> {
    return persistCookies(this.context, this.profilePath);
  }

  async close(): Promise<void> {
    await this.persistCookies();
    await this.context.close().catch(() => {});
  }
}
