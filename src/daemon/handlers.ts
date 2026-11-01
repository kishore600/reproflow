import { join } from 'node:path';
import type { Page } from 'playwright';
import { toPlaywright } from '../engine/locators.js';
import { describeStep, executeStep, type NormalizedStep, StepFailure } from '../engine/steps.js';
import { errorMessage } from '../errors.js';
import { createRunDir } from '../evidence/bundle.js';
import { MASK, maskDeep } from '../evidence/mask.js';
import type { LocatorSpec } from '../flows/schema.js';
import { appendSessionEntry, type ElementMeta } from '../flows/session-log.js';
import { toPosix } from '../paths.js';
import type { BrowserSession } from './browser.js';
import type { DaemonInfo, DaemonStatus, DoParams, MiniDigest } from './protocol.js';

export interface HandlerDeps {
  session: BrowserSession;
  project: string;
  info: DaemonInfo;
  shutdown(): void;
}

export type Handler = (params: unknown) => Promise<unknown>;

/** Which RPC methods mutate the page and so run one at a time. */
export const SERIAL_METHODS = new Set(['do', 'capture', 'run']);

const ARIA_LINE = /^-\s+([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?/;

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
  const secrets = [...(params.secrets ?? [])];
  let step: NormalizedStep = params.step;
  await session.ensurePage();

  let el: ElementMeta | undefined;
  if (step.type === 'click' || step.type === 'fill')
    el = await describeElement(session.page, step.target);

  let value: string | null = params.logValue ?? null;
  if (step.type === 'fill') {
    if (el?.type === 'password') secrets.push(step.value);
    value = params.logValue ?? (el?.type === 'password' ? MASK : step.value);
  }

  let evidence: Record<string, unknown> | undefined;
  if (step.type === 'screenshot' && !step.path) {
    const dir = await createRunDir(project, 'do-screenshot');
    step = { ...step, path: join(dir, step.target ? 'element.png' : 'screenshot.png') };
  }

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
  const digest: MiniDigest = {
    ok: !failure,
    action,
    url: page.url(),
    title: await page.title().catch(() => ''),
    ...(failure ? { error: failure.toInfo() } : {}),
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
  };
}
