import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';

/**
 * Chromium drops session cookies (no Expires) when it exits, which would lose most logins whenever
 * the daemon restarts. The jar keeps them in the profile folder (mode 0600) and puts them back at
 * launch.
 */
const JAR = 'reproflow-cookies.json';

const lastSaved = new Map<string, string>();

type Cookies = Parameters<BrowserContext['addCookies']>[0];

export async function restoreCookies(context: BrowserContext, profileDir: string): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(join(profileDir, JAR), 'utf8')) as Cookies;
    const now = Date.now() / 1000;
    const live = saved.filter(
      (cookie) => cookie.expires === undefined || cookie.expires === -1 || cookie.expires > now,
    );
    if (live.length > 0) await context.addCookies(live);
  } catch {
    // No jar yet, or it is unreadable; a missing login is not fatal.
  }
}

export async function persistCookies(context: BrowserContext, profileDir: string): Promise<void> {
  try {
    const json = JSON.stringify(await context.cookies());
    if (lastSaved.get(profileDir) === json) return;
    await writeFile(join(profileDir, JAR), json, { mode: 0o600 });
    lastSaved.set(profileDir, json);
  } catch {
    // The browser may already be closing.
  }
}
