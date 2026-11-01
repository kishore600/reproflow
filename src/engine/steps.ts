import type { Locator, Page } from 'playwright';
import { type ErrorCode, errorMessage, ReproflowError } from '../errors.js';
import type { PageWatcher } from '../evidence/collectors.js';
import {
  type LocatorSpec,
  type Step,
  type StepOf,
  type StepType,
  stepTypeOf,
} from '../flows/schema.js';
import { firstLine, sleep } from '../util.js';
import { isHostAllowed } from './host.js';
import { formatLocator, toPlaywright } from './locators.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

/** A URL path that looks like a login page. */
export const AUTH_URL_RE = /login|signin|auth/i;

/** Longest we wait for in-flight requests to drain after an action. */
const SETTLE_MAX_MS = 5_000;

export type WaitState = 'visible' | 'hidden' | 'attached' | 'detached';

export interface StepOptions {
  timeoutMs?: number;
  optional?: boolean;
}

/** A step with templates expanded and defaults applied. `do` actions build these directly. */
export type NormalizedStep = StepOptions &
  (
    | { type: 'goto'; url: string }
    | {
        type:
          | 'click'
          | 'hover'
          | 'check'
          | 'uncheck'
          | 'scroll_to'
          | 'expect_visible'
          | 'expect_hidden';
        target: LocatorSpec;
      }
    | { type: 'fill' | 'select'; target: LocatorSpec; value: string }
    | { type: 'press'; key: string }
    | { type: 'switch_tab'; tab: string | number }
    | { type: 'wait_for'; target: LocatorSpec; state: WaitState }
    | { type: 'expect_text'; target: LocatorSpec; text: string; exact: boolean }
    | { type: 'expect_url'; mode: 'equals' | 'contains' | 'matches'; value: string }
    | { type: 'screenshot'; path: string; fullPage: boolean; target?: LocatorSpec }
    | { type: 'capture'; fullPage: boolean; target?: LocatorSpec }
  );

export interface NormalizeContext {
  expand(text: string): string;
  /** Where a screenshot step with this name writes its file. */
  screenshotPath(name: string | undefined): string;
}

function expandLocator(spec: LocatorSpec, expand: (text: string) => string): LocatorSpec {
  return Object.fromEntries(
    Object.entries(spec).map(([key, value]) => [
      key,
      typeof value === 'string' ? expand(value) : value,
    ]),
  ) as LocatorSpec;
}

export function normalizeStep(step: Step, ctx: NormalizeContext): NormalizedStep {
  const type = stepTypeOf(step as Record<string, unknown>);
  if (!type) throw new ReproflowError('flow_invalid', 'step has no known type key');
  const options: StepOptions = { timeoutMs: step.timeout_ms, optional: step.optional };
  const loc = (spec: LocatorSpec): LocatorSpec => expandLocator(spec, ctx.expand);
  const body = <K extends StepType>(key: K): StepOf<K>[K & keyof StepOf<K>] =>
    (step as StepOf<K>)[key as K & keyof StepOf<K>];

  switch (type) {
    case 'goto':
      return { ...options, type, url: ctx.expand(body('goto') as string) };
    case 'click':
    case 'hover':
    case 'check':
    case 'uncheck':
    case 'scroll_to':
    case 'expect_visible':
    case 'expect_hidden':
      return { ...options, type, target: loc(body(type) as LocatorSpec) };
    case 'fill':
    case 'select': {
      const { target, value } = body(type) as { target: LocatorSpec; value: string };
      return { ...options, type, target: loc(target), value: ctx.expand(value) };
    }
    case 'press':
      return { ...options, type, key: ctx.expand(body('press') as string) };
    case 'switch_tab': {
      const tab = body('switch_tab') as string | number;
      return { ...options, type, tab: typeof tab === 'string' ? ctx.expand(tab) : tab };
    }
    case 'wait_for': {
      const raw = body('wait_for') as LocatorSpec | { target: LocatorSpec; state?: WaitState };
      if ('target' in raw) {
        return { ...options, type, target: loc(raw.target), state: raw.state ?? 'visible' };
      }
      return { ...options, type, target: loc(raw), state: 'visible' };
    }
    case 'expect_text': {
      const raw = body('expect_text') as { target: LocatorSpec; text: string; exact?: boolean };
      return {
        ...options,
        type,
        target: loc(raw.target),
        text: ctx.expand(raw.text),
        exact: raw.exact ?? false,
      };
    }
    case 'expect_url': {
      const raw = body('expect_url') as string | { contains: string } | { matches: string };
      if (typeof raw === 'string')
        return { ...options, type, mode: 'equals', value: ctx.expand(raw) };
      if ('contains' in raw)
        return { ...options, type, mode: 'contains', value: ctx.expand(raw.contains) };
      return { ...options, type, mode: 'matches', value: ctx.expand(raw.matches) };
    }
    case 'screenshot': {
      const raw = body('screenshot') as
        | true
        | { name?: string; full_page?: boolean; target?: LocatorSpec };
      const detail = raw === true ? {} : raw;
      return {
        ...options,
        type,
        path: ctx.screenshotPath(detail.name),
        fullPage: detail.full_page ?? false,
        target: detail.target ? loc(detail.target) : undefined,
      };
    }
    case 'capture': {
      const raw = body('capture') as true | { full_page?: boolean; target?: LocatorSpec };
      const detail = raw === true ? {} : raw;
      return {
        ...options,
        type,
        fullPage: detail.full_page ?? false,
        target: detail.target ? loc(detail.target) : undefined,
      };
    }
  }
}

/** Short human label for a step's target, used in digests and logs. */
export function describeStep(step: NormalizedStep): string {
  switch (step.type) {
    case 'goto':
      return step.url;
    case 'press':
      return step.key;
    case 'switch_tab':
      return String(step.tab);
    case 'expect_url':
      return step.value;
    case 'screenshot':
    case 'capture':
      return step.target ? formatLocator(step.target) : 'page';
    default:
      return formatLocator(step.target);
  }
}

/** A failed step, with enough detail to build a digest. */
export class StepFailure extends ReproflowError {
  expected?: string;
  actual?: string;
  locator?: LocatorSpec;

  constructor(
    code: ErrorCode,
    message: string,
    extra: { hint?: string; expected?: string; actual?: string; locator?: LocatorSpec } = {},
  ) {
    super(code, message, extra.hint);
    this.name = 'StepFailure';
    this.expected = extra.expected;
    this.actual = extra.actual;
    this.locator = extra.locator;
  }
}

/** What the engine needs from the browser: the active page and its siblings. */
export interface SessionPort {
  readonly page: Page;
  pages(): Page[];
  setActive(page: Page): void;
  watcher(page: Page): PageWatcher | undefined;
}

export interface StepEnv {
  session: SessionPort;
  baseUrl?: string;
  /** When set, every `goto` is checked against it (flow runs). `do` actions leave it unset. */
  allowedHosts?: readonly string[];
  /** The flow itself signs in, so login pages and password fields are expected. */
  expectsLogin?: boolean;
  /** Returns the URL of a navigation the host allowlist blocked, if any. */
  blockedNavigation?: () => string | undefined;
  capture?: (options: { fullPage: boolean; target?: LocatorSpec }) => Promise<void>;
}

export interface StepOutput {
  screenshot?: string;
}

const NAVIGATING = new Set<StepType>([
  'goto',
  'click',
  'press',
  'switch_tab',
  'check',
  'uncheck',
  'select',
]);

const urlPath = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
};

const originOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
};

/** `https://x` and `localhost:3000/a` become absolute URLs; paths like `/a` return null. */
export function absoluteUrl(raw: string): string | null {
  if (/^(https?|file|about|data):/i.test(raw)) return raw;
  const relative = /^[/?#]/.test(raw) || !/[.:]|^localhost$/i.test(raw.split('/')[0]);
  return relative ? null : `http://${raw}`;
}

/** Resolves a goto target: an absolute URL, or a path against base_url / the current page. */
export function resolveUrl(raw: string, env: StepEnv, page: Page): string {
  const absolute = absoluteUrl(raw);
  if (absolute) return absolute;
  const base = env.baseUrl ?? (/^https?:/i.test(page.url()) ? page.url() : undefined);
  if (!base) {
    throw new StepFailure('flow_invalid', `relative URL ${raw} needs a base_url or an open page`, {
      hint: 'Use an absolute URL, or set base_url in the flow.',
    });
  }
  return new URL(raw, base).href;
}

/**
 * Waits until the page has no in-flight document/xhr/fetch/script/stylesheet requests for a short
 * quiet period, so the next step does not race an add-to-cart style request.
 */
export async function settle(watcher: PageWatcher | undefined, maxMs: number): Promise<void> {
  if (!watcher) return;
  const deadline = Date.now() + Math.min(maxMs, SETTLE_MAX_MS);
  await sleep(60);
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    if (watcher.pendingCount === 0) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 150) return;
    } else {
      quietSince = null;
    }
    await sleep(25);
  }
}

interface AuthSnapshot {
  url: string;
  onAuthUrl: boolean;
  password: boolean;
}

async function hasVisiblePassword(page: Page): Promise<boolean> {
  try {
    return (await page.locator('input[type="password"]:visible').count()) > 0;
  } catch {
    return false;
  }
}

async function authSnapshot(page: Page): Promise<AuthSnapshot> {
  const url = page.url();
  return {
    url,
    onAuthUrl: AUTH_URL_RE.test(urlPath(url)),
    password: await hasVisiblePassword(page),
  };
}

function authExpired(env: StepEnv, page: Page, why: string): StepFailure {
  const origin = originOf(env.baseUrl) ?? originOf(page.url()) ?? '<url>';
  return new StepFailure('auth_expired', why, {
    hint: `Ask the user to run \`reproflow login ${origin}\`.`,
  });
}

/** After a navigating step succeeded: did it land somewhere that wants a login? */
async function authAfterSuccess(
  step: NormalizedStep,
  env: StepEnv,
  before: AuthSnapshot,
): Promise<StepFailure | null> {
  if (env.expectsLogin || !NAVIGATING.has(step.type)) return null;
  const page = env.session.page;
  const url = page.url();
  if (step.type === 'goto') {
    // A goto is a fresh navigation: what the tab showed before (say, the login page a previous run
    // ended on) does not excuse landing on one now, unless the flow asked for a login URL.
    if (AUTH_URL_RE.test(urlPath(step.url))) return null;
    if (AUTH_URL_RE.test(urlPath(url))) {
      return authExpired(env, page, `Landed on ${url}, which looks like a login page`);
    }
    return (await hasVisiblePassword(page))
      ? authExpired(env, page, `A password field is visible on ${url}`)
      : null;
  }
  if (AUTH_URL_RE.test(urlPath(url))) {
    return before.onAuthUrl
      ? null
      : authExpired(env, page, `Landed on ${url}, which looks like a login page`);
  }
  if (url !== before.url && !before.password && (await hasVisiblePassword(page))) {
    return authExpired(env, page, `A password field is visible on ${url}`);
  }
  return null;
}

/** After any failure: if the step started somewhere normal and now sits on a login page, say so. */
async function authAfterFailure(env: StepEnv, before: AuthSnapshot): Promise<StepFailure | null> {
  if (env.expectsLogin || before.onAuthUrl || before.password) return null;
  const page = env.session.page;
  if (AUTH_URL_RE.test(urlPath(page.url()))) {
    return authExpired(env, page, `Landed on ${page.url()}, which looks like a login page`);
  }
  if (await hasVisiblePassword(page)) {
    return authExpired(env, page, `A password field is visible on ${page.url()}`);
  }
  return null;
}

/** The most informative "why not" line of a Playwright call log. */
function actionabilityReason(message: string, timeoutMs: number): string {
  const lines = message.split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim());
  const reason = [...lines]
    .reverse()
    .find((line) =>
      /not (visible|enabled|stable|editable|checked)|intercepts pointer events|outside of the viewport|detached/i.test(
        line,
      ),
    );
  return reason ?? `timed out after ${timeoutMs}ms`;
}

async function toFailure(
  error: unknown,
  step: NormalizedStep,
  env: StepEnv,
  before: AuthSnapshot,
  locator: Locator | undefined,
): Promise<StepFailure> {
  const auth = await authAfterFailure(env, before);
  if (auth) return auth;
  if (error instanceof StepFailure) return error;

  const message = errorMessage(error);
  const summary = firstLine(message);
  const timeout = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const blocked = env.blockedNavigation?.();
  if (blocked) return hostNotAllowed(blocked);
  if (/has been closed|Target closed|Browser closed/i.test(message)) {
    return new StepFailure('browser_unavailable', summary);
  }
  if (step.type === 'goto') return new StepFailure('navigation_timeout', summary);

  const target = 'target' in step ? step.target : undefined;
  if (locator && target) {
    const strict = /strict mode violation.*resolved to (\d+) elements/s.exec(message);
    if (strict) {
      return new StepFailure(
        'locator_not_found',
        `${formatLocator(target)} matched ${strict[1]} elements; narrow it or add nth`,
        { locator: target, hint: 'Add `nth: 0` (or `>> nth=0`) or use a more specific locator.' },
      );
    }
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      return new StepFailure('locator_not_found', `No element found for ${formatLocator(target)}`, {
        locator: target,
      });
    }
    if (
      step.type === 'expect_visible' ||
      step.type === 'expect_hidden' ||
      step.type === 'wait_for'
    ) {
      const visible = await locator
        .first()
        .isVisible()
        .catch(() => false);
      const wanted =
        step.type === 'expect_hidden'
          ? 'hidden'
          : step.type === 'wait_for'
            ? step.state
            : 'visible';
      return new StepFailure(
        'assertion_failed',
        `Expected ${formatLocator(target)} to be ${wanted}`,
        {
          expected: wanted,
          actual: visible ? 'visible' : 'hidden',
          locator: target,
        },
      );
    }
    const reason = actionabilityReason(message, timeout);
    return new StepFailure(
      'assertion_failed',
      `${step.type} on ${formatLocator(target)} failed: ${reason}`,
      { expected: `${step.type} succeeds`, actual: reason, locator: target },
    );
  }
  return new StepFailure('assertion_failed', summary);
}

function hostNotAllowed(url: string): StepFailure {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {}
  return new StepFailure('host_not_allowed', `Navigation to ${host} is not allowed (${url})`, {
    hint: `Add ${host} to allowed_hosts in the flow if this navigation is intended.`,
  });
}

async function findTab(
  session: SessionPort,
  tab: string | number,
  timeoutMs: number,
): Promise<Page> {
  const wanted = String(tab);
  const deadline = Date.now() + Math.min(timeoutMs, 3_000);
  for (;;) {
    const pages = session.pages();
    if (/^\d+$/.test(wanted) && pages[Number(wanted)]) return pages[Number(wanted)];
    const needle = wanted.toLowerCase();
    const byUrl = pages.find((page) => page.url().toLowerCase().includes(needle));
    if (byUrl) return byUrl;
    for (const page of pages) {
      const title = await page.title().catch(() => '');
      if (title.toLowerCase().includes(needle)) return page;
    }
    if (Date.now() >= deadline) {
      const open = pages.map((page, index) => `${index}: ${page.url()}`).join(' | ');
      throw new StepFailure('assertion_failed', `No open tab matches "${wanted}"`, {
        expected: `a tab matching ${wanted}`,
        actual: open,
        hint: 'Use a tab index, or part of its URL or title.',
      });
    }
    await sleep(100);
  }
}

async function readText(locator: Locator): Promise<string> {
  const text = await locator.first().evaluate((element) => {
    const tag = element.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return (element as HTMLInputElement).value;
    }
    // innerText is the rendered text a user sees (hidden text excluded), unlike textContent.
    // biome-ignore lint/performance/useDomNodeTextContent: rendered text is what assertions mean
    return (element as HTMLElement).innerText ?? element.textContent ?? '';
  });
  return text.replace(/\s+/g, ' ').trim();
}

function urlMatches(
  step: Extract<NormalizedStep, { type: 'expect_url' }>,
  current: string,
  baseUrl?: string,
): boolean {
  if (step.mode === 'contains') return current.includes(step.value);
  if (step.mode === 'matches') return new RegExp(step.value).test(current);
  const now = new URL(current);
  if (step.value.startsWith('/')) return now.pathname + now.search === step.value;
  const expected = new URL(step.value, baseUrl ?? current);
  return (
    `${expected.origin}${expected.pathname}${expected.search}` ===
    `${now.origin}${now.pathname}${now.search}`
  );
}

/**
 * Runs one step against the active page. Throws {@link StepFailure} (never a raw Playwright error).
 */
export async function executeStep(step: NormalizedStep, env: StepEnv): Promise<StepOutput> {
  const timeout = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const page = env.session.page;
  const before = await authSnapshot(page);
  const output: StepOutput = {};
  const target = 'target' in step ? step.target : undefined;
  const locator = target ? toPlaywright(page, target) : undefined;
  const need = (): Locator => {
    if (!locator) throw new Error(`${step.type} needs a target`);
    return locator;
  };
  const afterAction = (): Promise<void> => settle(env.session.watcher(page), timeout);

  try {
    switch (step.type) {
      case 'goto': {
        const url = resolveUrl(step.url, env, page);
        if (env.allowedHosts && !isHostAllowed(url, env.allowedHosts)) throw hostNotAllowed(url);
        await page.goto(url, { timeout, waitUntil: 'load' });
        break;
      }
      case 'click':
        await need().click({ timeout });
        await afterAction();
        break;
      case 'hover':
        await need().hover({ timeout });
        break;
      case 'check':
        await need().check({ timeout });
        await afterAction();
        break;
      case 'uncheck':
        await need().uncheck({ timeout });
        await afterAction();
        break;
      case 'scroll_to':
        await need().scrollIntoViewIfNeeded({ timeout });
        break;
      case 'fill':
        await need().fill(step.value, { timeout });
        break;
      case 'select':
        await need().selectOption(step.value, { timeout });
        await afterAction();
        break;
      case 'press':
        await page.keyboard.press(step.key);
        await afterAction();
        break;
      case 'switch_tab': {
        const tab = await findTab(env.session, step.tab, timeout);
        env.session.setActive(tab);
        await tab.bringToFront();
        await tab.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
        break;
      }
      case 'wait_for':
        await need().first().waitFor({ state: step.state, timeout });
        break;
      case 'expect_visible':
        await need().first().waitFor({ state: 'visible', timeout });
        break;
      case 'expect_hidden':
        await need().first().waitFor({ state: 'hidden', timeout });
        break;
      case 'expect_text': {
        const deadline = Date.now() + timeout;
        let actual: string | null = null;
        for (;;) {
          if ((await need().count()) > 0) {
            actual = await readText(need()).catch(() => null);
            if (
              actual !== null &&
              (step.exact ? actual === step.text : actual.includes(step.text))
            ) {
              break;
            }
          }
          if (Date.now() >= deadline) {
            if (actual === null) {
              throw new StepFailure(
                'locator_not_found',
                `No element found for ${formatLocator(step.target)}`,
                {
                  locator: step.target,
                },
              );
            }
            throw new StepFailure(
              'assertion_failed',
              `Expected ${formatLocator(step.target)} to ${step.exact ? 'equal' : 'contain'} "${step.text}" but got "${actual}"`,
              { expected: step.text, actual, locator: step.target },
            );
          }
          await sleep(100);
        }
        break;
      }
      case 'expect_url': {
        const deadline = Date.now() + timeout;
        for (;;) {
          if (urlMatches(step, page.url(), env.baseUrl)) break;
          if (Date.now() >= deadline) {
            throw new StepFailure('assertion_failed', `Expected URL ${step.mode} ${step.value}`, {
              expected: `${step.mode} ${step.value}`,
              actual: page.url(),
            });
          }
          await sleep(100);
        }
        break;
      }
      case 'screenshot': {
        if (locator) await locator.first().screenshot({ path: step.path, timeout });
        else await page.screenshot({ path: step.path, fullPage: step.fullPage, timeout });
        output.screenshot = step.path;
        break;
      }
      case 'capture':
        await env.capture?.({ fullPage: step.fullPage, target: step.target });
        break;
    }
    // A click or redirect can trigger a navigation the allowlist blocked without the action failing.
    const blocked = env.blockedNavigation?.();
    if (blocked) throw hostNotAllowed(blocked);
  } catch (error) {
    throw await toFailure(error, step, env, before, locator);
  }

  const auth = await authAfterSuccess(step, env, before);
  if (auth) throw auth;
  return output;
}
