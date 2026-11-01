import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { type Candidate, candidatesFor } from '../engine/candidates.js';
import { formatLocator, toPlaywright } from '../engine/locators.js';
import { describeStep, executeStep, type NormalizedStep, StepFailure } from '../engine/steps.js';
import { errorMessage, ReproflowError } from '../errors.js';
import { createRunDir, writeBundle, writeRunJson } from '../evidence/bundle.js';
import { buildDigest, fitDigest } from '../evidence/digest.js';
import { MASK, maskDeep } from '../evidence/mask.js';
import type { LocatorSpec } from '../flows/schema.js';
import { appendSessionEntry, type ElementMeta } from '../flows/session-log.js';
import { toPosix } from '../paths.js';
import type { BrowserSession } from './browser.js';
import type { CaptureParams, DaemonInfo, DaemonStatus, DoParams, MiniDigest } from './protocol.js';

export interface HandlerDeps {
  session: BrowserSession;
  project: string;
  info: DaemonInfo;
  /** Secret values seen so far (password fields, env templates); masked in everything written. */
  secrets: Set<string>;
  shutdown(): void;
}

export type Handler = (params: unknown) => Promise<unknown>;

/** Which RPC methods mutate the page and so run one at a time. */
export const SERIAL_METHODS = new Set(['do', 'capture', 'run']);

const ARIA_LINE = /^-\s+([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?/;

/** The first element a locator matches, or undefined when there is none. */
export async function resolveElement(page: Page, spec: LocatorSpec): Promise<Locator | undefined> {
  const locator = toPlaywright(page, spec);
  return (await locator.count().catch(() => 0)) > 0 ? locator.first() : undefined;
}

/** Role, accessible name, label and input type of the element a click/fill is about to use. */
export async function describeElement(
  page: Page,
  target: LocatorSpec,
): Promise<ElementMeta | undefined> {
  try {
    const locator = toPlaywright(page, target);
    if ((await locator.count()) !== 1) return undefined;
    const [attrs, snapshot] = await Promise.all([
      locator.evaluate((node) => {
        const input = node as HTMLInputElement;
        const labels = input.labels ? Array.from(input.labels) : [];
        return {
          type: input.type || undefined,
          label: (labels[0]?.textContent ?? '').trim() || undefined,
          placeholder: node.getAttribute('placeholder') ?? undefined,
        };
      }),
      locator.ariaSnapshot({ timeout: 1_000 }),
    ]);
    const meta: ElementMeta = { ...attrs };
    const line = ARIA_LINE.exec(snapshot.trim().split('\n')[0] ?? '');
    if (line) {
      meta.role = line[1];
      if (line[2] !== undefined) {
        try {
          meta.name = JSON.parse(`"${line[2]}"`) as string;
        } catch {
          meta.name = line[2];
        }
      }
    }
    if (meta.role && meta.name) {
      const matches = await page
        .getByRole(meta.role as Parameters<Page['getByRole']>[0], { name: meta.name })
        .count();
      meta.unique = matches === 1;
    }
    return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
  } catch {
    return undefined;
  }
}

async function handleDo(deps: HandlerDeps, params: DoParams): Promise<MiniDigest> {
  const { session, project } = deps;
  const { action } = params;
  for (const secret of params.secrets ?? []) deps.secrets.add(secret);
  let step: NormalizedStep = params.step;
  await session.ensurePage();

  let el: ElementMeta | undefined;
  if (step.type === 'click' || step.type === 'fill') {
    el = await describeElement(session.page, step.target);
  }

  let value: string | null = params.logValue ?? null;
  if (step.type === 'fill') {
    if (el?.type === 'password') deps.secrets.add(step.value);
    value = params.logValue ?? (el?.type === 'password' ? MASK : step.value);
  }

  if (step.type === 'screenshot' && !step.path) {
    const dir = await createRunDir(project, 'do-screenshot');
    step = { ...step, path: join(dir, step.target ? 'element.png' : 'screenshot.png') };
  }

  let evidence: MiniDigest['evidence'];
  let failure: StepFailure | undefined;
  try {
    const output = await executeStep(step, { session });
    if (output.screenshot) evidence = { screenshot: toPosix(output.screenshot) };
  } catch (error) {
    failure =
      error instanceof StepFailure
        ? error
        : new StepFailure('assertion_failed', errorMessage(error));
  }

  const page = session.page;
  const secrets = [...deps.secrets];
  let candidates: Candidate[] | undefined;
  if (failure && failure.code !== 'browser_unavailable') {
    const dir = await createRunDir(project, `do-${action}`);
    const element = failure.locator ? await resolveElement(page, failure.locator) : undefined;
    const bundle = await writeBundle({
      page,
      dir,
      events: session.watcher(page)?.events ?? [],
      secrets,
      element,
    });
    evidence = bundle.summary;
    if (failure.code === 'locator_not_found' && failure.locator) {
      candidates = await candidatesFor(page, failure.locator);
    }
    await writeRunJson(
      dir,
      {
        kind: 'do',
        action,
        ok: false,
        target: describeStep(step),
        error: failure.toInfo(),
        candidates,
        evidence: { ...bundle.summary, ...bundle.full },
      },
      secrets,
    );
  }

  const digest: MiniDigest = {
    ok: !failure,
    action,
    url: page.url(),
    title: await page.title().catch(() => ''),
    ...(failure ? { error: failure.toInfo() } : {}),
    ...(candidates?.length ? { candidates } : {}),
    ...(evidence ? { evidence } : {}),
  };

  await appendSessionEntry(project, {
    ts: new Date().toISOString(),
    action,
    target: describeStep(step),
    value,
    url: page.url(),
    ok: !failure,
    ...(el ? { el } : {}),
  });
  await session.persistCookies();
  return fitDigest(maskDeep(digest, secrets));
}

async function handleCapture(deps: HandlerDeps, params: CaptureParams) {
  const started = Date.now();
  const { session, project } = deps;
  await session.ensurePage();
  const page = session.page;
  const secrets = [...deps.secrets];
  const dir = await createRunDir(project, 'capture');

  let element: Locator | undefined;
  let error: ReproflowError | null = null;
  let candidates: Candidate[] | undefined;
  if (params.locator) {
    element = await resolveElement(page, params.locator);
    if (!element) {
      error = new ReproflowError(
        'locator_not_found',
        `No element found for ${formatLocator(params.locator)}`,
      );
      candidates = await candidatesFor(page, params.locator);
    }
  }

  const bundle = await writeBundle({
    page,
    dir,
    events: session.watcher(page)?.events ?? [],
    secrets,
    fullPage: params.fullPage,
    element,
  });
  const digest = buildDigest({
    flow: null,
    status: error ? 'failed' : 'passed',
    durationMs: Date.now() - started,
    stepsTotal: 0,
    stepsPassed: 0,
    error: error?.toInfo() ?? null,
    candidates,
    evidence: bundle.summary,
  });
  await writeRunJson(
    dir,
    {
      kind: 'capture',
      ts: new Date(started).toISOString(),
      locator: params.locator ? formatLocator(params.locator) : null,
      digest,
      evidence: { ...bundle.summary, ...bundle.full, element: bundle.elementPath },
    },
    secrets,
  );
  return maskDeep(digest, secrets);
}

export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  return {
    ping: async () => deps.info,
    status: async (): Promise<DaemonStatus> => {
      const active = deps.session.page;
      const pages = await Promise.all(
        deps.session.pages().map(async (page, index) => ({
          index,
          url: page.url(),
          title: await page.title().catch(() => ''),
          active: page === active,
        })),
      );
      return { ...deps.info, pages };
    },
    shutdown: async () => {
      setImmediate(deps.shutdown);
      return { ok: true };
    },
    do: (params) => handleDo(deps, params as DoParams),
    capture: (params) => handleCapture(deps, params as CaptureParams),
  };
}
