import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { projectPaths, toPosix } from '../paths.js';
import type { EvidenceEvent } from './collectors.js';
import type { EvidenceSummary } from './digest.js';
import { maskDeep, maskText } from './mask.js';
import { summarizeEvents } from './summary.js';

/** How many run folders are kept; older ones are deleted. */
export const KEEP_RUNS = 50;

const RUN_DIR = /^\d{8}-\d{6}-/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local time as YYYYMMDD-HHmmss. */
export function runTimestamp(date: Date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function slugify(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

/** Creates .reproflow/runs/<YYYYMMDD-HHmmss>-<name>/ (suffixing -2, -3 ... on a clash). */
export async function createRunDir(root: string, name: string): Promise<string> {
  const { runs } = projectPaths(root);
  const base = `${runTimestamp()}-${slugify(name)}`;
  let dir = join(runs, base);
  for (let n = 2; existsSync(dir); n++) dir = join(runs, `${base}-${n}`);
  await mkdir(dir, { recursive: true });
  await pruneRuns(runs);
  return dir;
}

/** Deletes the oldest run folders beyond `keep`. Only touches folders named like run folders. */
export async function pruneRuns(runsDir: string, keep: number = KEEP_RUNS): Promise<string[]> {
  const entries = (await readdir(runsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && RUN_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const doomed = entries.slice(0, Math.max(0, entries.length - keep));
  await Promise.all(
    doomed.map((name) => rm(join(runsDir, name), { recursive: true, force: true }).catch(() => {})),
  );
  return doomed;
}

export interface BundleOptions {
  page: Page;
  dir: string;
  /** Events to write out and summarise (already scoped by the caller). */
  events: readonly EvidenceEvent[];
  secrets: readonly string[];
  fullPage?: boolean;
  /** When given, also write element.png cropped to it. */
  element?: Locator;
}

export interface Bundle {
  /** Digest-ready summary (lists capped at 5). */
  summary: EvidenceSummary;
  /** Same lists, uncapped, for run.json. */
  full: Pick<EvidenceSummary, 'console_errors' | 'page_errors' | 'failed_requests'>;
  elementPath: string | null;
}

const jsonl = (rows: readonly unknown[], secrets: readonly string[]): string =>
  rows.map((row) => JSON.stringify(maskDeep(row, secrets))).join('\n') + (rows.length ? '\n' : '');

/** Runs `work`, returning null instead of throwing: one missing file must not lose the rest. */
async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

/**
 * Writes the evidence bundle into `dir`: screenshot.png, snapshot.aria.yml, console.jsonl,
 * page-errors.jsonl and network.jsonl (element.png too when `element` is given). The three
 * .jsonl files are always written, empty when nothing happened.
 */
export async function writeBundle(options: BundleOptions): Promise<Bundle> {
  const { page, dir, events, secrets } = options;
  await mkdir(dir, { recursive: true });

  const screenshotPath = join(dir, 'screenshot.png');
  const shot = await attempt(() =>
    page.screenshot({ path: screenshotPath, fullPage: options.fullPage ?? false, timeout: 5_000 }),
  );

  let elementPath: string | null = null;
  const { element } = options;
  if (element) {
    const path = join(dir, 'element.png');
    const wrote = await attempt(() => element.screenshot({ path, timeout: 3_000 }));
    if (wrote) elementPath = path;
  }

  const snapshotPath = join(dir, 'snapshot.aria.yml');
  const aria = await attempt(() => page.locator('body').ariaSnapshot({ timeout: 5_000 }));
  if (aria !== null) await writeFile(snapshotPath, `${maskText(aria, secrets)}\n`);

  const consoleRows = events.filter((event) => event.kind === 'console');
  const pageErrorRows = events.filter((event) => event.kind === 'pageerror');
  const networkRows = events.filter(
    (event) => event.kind === 'requestfailed' || event.kind === 'response',
  );
  await Promise.all([
    writeFile(join(dir, 'console.jsonl'), jsonl(consoleRows, secrets)),
    writeFile(join(dir, 'page-errors.jsonl'), jsonl(pageErrorRows, secrets)),
    writeFile(join(dir, 'network.jsonl'), jsonl(networkRows, secrets)),
  ]);

  const url = page.url();
  const title = await page.title().catch(() => '');
  const lists = maskDeep(summarizeEvents(events, url), secrets);
  const full = maskDeep(summarizeEvents(events, url, Number.POSITIVE_INFINITY), secrets);
  return {
    summary: {
      dir: toPosix(dir),
      screenshot: shot ? toPosix(screenshotPath) : null,
      snapshot: aria !== null ? toPosix(snapshotPath) : null,
      url,
      title: maskText(title, secrets),
      ...lists,
    },
    full,
    elementPath: elementPath ? toPosix(elementPath) : null,
  };
}

/** run.json: the full, unabridged result of a run, with secrets masked. */
export async function writeRunJson(
  dir: string,
  result: unknown,
  secrets: readonly string[],
): Promise<void> {
  await writeFile(join(dir, 'run.json'), `${JSON.stringify(maskDeep(result, secrets), null, 2)}\n`);
}
