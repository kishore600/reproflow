import { mkdir } from 'node:fs/promises';
import { errorMessage, ReproflowError } from '../errors.js';
import { profileDir } from '../paths.js';
import { browserChannel, forceHeadless, VIEWPORT } from './browser.js';
import { stopDaemonsUsingProfile } from './client.js';
import { persistCookies, restoreCookies } from './cookies.js';

export interface LoginOptions {
  url: string;
  profile: string;
  /** Resolves when the user is done signing in (presses Enter). */
  waitForEnter(): Promise<void>;
  log(message: string): void;
}

/**
 * Opens a headed browser on the profile, lets the user sign in, then closes it so the profile
 * (cookies included) is saved. Any daemon holding the profile is stopped first; it restarts on demand.
 */
export async function runLogin(options: LoginOptions): Promise<void> {
  const { url, profile, log } = options;
  const profilePath = profileDir(profile);
  await mkdir(profilePath, { recursive: true });
  const stopped = await stopDaemonsUsingProfile(profile);
  if (stopped > 0)
    log(`Stopped ${stopped} running session(s) that were using profile "${profile}".`);

  const { chromium } = await import('playwright');
  const headless = forceHeadless();
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: browserChannel(),
      headless,
      viewport: headless ? VIEWPORT : null,
    });
  } catch (error) {
    const missing = /Executable doesn't exist/i.test(errorMessage(error));
    throw new ReproflowError(
      'browser_unavailable',
      missing
        ? 'Playwright Chromium is not installed'
        : `the browser failed to start: ${errorMessage(error).split('\n')[0]}`,
      missing
        ? 'Run `reproflow doctor --fix` to install it.'
        : 'Close any other reproflow session using this profile, or pass --profile <name>.',
    );
  }

  await restoreCookies(context, profilePath);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((error) => {
    log(`Could not load ${url}: ${errorMessage(error).split('\n')[0]}`);
  });

  log(`A browser is open at ${url}.`);
  log('Sign in there, then come back to this terminal and press Enter.');
  log(`reproflow keeps the login in profile "${profile}".`);

  // Closing the window early must not lose the login, so save cookies while waiting.
  const saver = setInterval(() => void persistCookies(context, profilePath), 2_000);
  const closed = new Promise<void>((resolve) => context.once('close', () => resolve()));
  await Promise.race([options.waitForEnter(), closed]);
  clearInterval(saver);
  await persistCookies(context, profilePath);
  await context.close().catch(() => {});
}
