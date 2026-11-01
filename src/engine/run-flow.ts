import { join } from 'node:path';
import type { BrowserContext, Page, Request, Route } from 'playwright';
import { errorMessage } from '../errors.js';
import {
  type Bundle,
  createRunDir,
  slugify,
  writeBundle,
  writeRunJson,
} from '../evidence/bundle.js';
import type { EvidenceEvent } from '../evidence/collectors.js';
import {
  buildDigest,
  type FailedStep,
  type RunDigest,
  type RunStatus,
} from '../evidence/digest.js';
import { maskDeep } from '../evidence/mask.js';
import type { ParamValue } from '../flows/params.js';
import type { Flow } from '../flows/schema.js';
import { stepTypeOf } from '../flows/schema.js';
import { expandTemplate } from '../flows/templating.js';
import { toPosix } from '../paths.js';
import { type Candidate, candidatesFor } from './candidates.js';
import { isHostAllowed } from './host.js';
import { resolveElement } from './locators.js';
import {
  AUTH_URL_RE,
  describeStep,
  executeStep,
  type NormalizedStep,
  normalizeStep,
  type SessionPort,
  type StepEnv,
  StepFailure,
} from './steps.js';

/** What a flow run needs from the daemon's browser. */
export interface RunSession extends SessionPort {
  readonly context: BrowserContext;
  readonly lastSeq: number;
  eventsSince(seq: number): EvidenceEvent[];
  ensurePage(): Promise<Page>;
  persistCookies(): Promise<void>;
}

export interface RunRequest {
  /** Flow id (file name without extension); names the run folder. */
  id: string;
  flow: Flow;
  /** Resolved, coerced param values (secrets included; they never leave the daemon unmasked). */
  params: Record<string, ParamValue>;
  secretNames: string[];
  /** Values of every `{{env.NAME}}` the flow reads, taken from the CLI's environment. */
  env: Record<string, string>;
  options: { trace?: boolean; keepGoing?: boolean };
}

export interface RunDeps {
  session: RunSession;
  project: string;
  /** Daemon-wide secret registry; the run adds its own secrets before writing anything. */
  secrets: Set<string>;
}

interface StepRecord {
  n: number;
  type: string;
  target: string;
  status: 'passed' | 'failed' | 'skipped';
  duration_ms: number;
  error?: { code: string; message: string };
}

const PASSWORD_HINT = /pass(word|wd)?/i;

/**
 * True when the flow signs in itself: it visits a login URL, or fills a password-looking field or a
 * secret param. Login pages and password fields are then expected rather than "auth expired".
 */
export function flowExpectsLogin(flow: Flow): boolean {
  const secretParams = Object.entries(flow.params ?? {})
    .filter(([, spec]) => spec.secret)
    .map(([name]) => name);
  return flow.steps.some((step) => {
    const raw = step as Record<string, unknown>;
    const type = stepTypeOf(raw);
    if (type === 'goto') return AUTH_URL_RE.test(String(raw.goto));
    if (type !== 'fill') return false;
    const { target, value } = raw.fill as { target: Record<string, unknown>; value: string };
    const mentionsSecret = secretParams.some((name) =>
      new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(value),
    );
    return (
      mentionsSecret ||
      Object.values(target).some((v) => typeof v === 'string' && PASSWORD_HINT.test(v))
    );
  });
}

const isTopLevelNavigation = (request: Request): boolean =>
  request.isNavigationRequest() && request.frame().parentFrame() === null;

/**
 * Enforces `allowed_hosts` on top-level navigations for the duration of a run. Iframes and
 * sub-resources are not restricted.
 *
 * - A navigation the page starts itself (link click, form post, `location = ...`, `goto`) to a
 *   disallowed host is aborted before any request is sent.
 * - Playwright cannot intercept the hops of a redirect, so a redirect to a disallowed host is only
 *   noticed when the browser issues that request; the step then fails with host_not_allowed. At most
 *   one request reaches the disallowed host.
 */
async function guardNavigation(context: BrowserContext, allowedHosts: readonly string[]) {
  let blocked: string | undefined;
  const route = async (pending: Route): Promise<void> => {
    const request = pending.request();
    if (isTopLevelNavigation(request) && !isHostAllowed(request.url(), allowedHosts)) {
      blocked ??= request.url();
      // "aborted" cancels like a user would: the tab stays on the page it was on. Other error codes
      // would replace it with a Chromium error page.
      await pending.abort('aborted');
      return;
    }
    await pending.continue();
  };
  const onRequest = (request: Request): void => {
    if (isTopLevelNavigation(request) && !isHostAllowed(request.url(), allowedHosts)) {
      blocked ??= request.url();
    }
  };
  await context.route('**/*', route);
  context.on('request', onRequest);
  return {
    /** The blocked URL since the last call, if any. */
    take(): string | undefined {
      const url = blocked;
      blocked = undefined;
      return url;
    },
    async dispose(): Promise<void> {
      context.off('request', onRequest);
      await context.unroute('**/*', route).catch(() => {});
    },
  };
}

async function startTrace(context: BrowserContext): Promise<void> {
  await context.tracing.stop().catch(() => {});
  await context.tracing.start({ screenshots: true, snapshots: true });
}

/**
 * Replays a flow on the daemon's browser: no AI, no retries. Stops at the first failed step unless
 * `keepGoing`. Writes the run folder (run.json always; the evidence bundle on failure) and returns
 * the digest.
 */
export async function runFlow(deps: RunDeps, request: RunRequest): Promise<RunDigest> {
  const started = Date.now();
  const { session, project } = deps;
  const { flow, id } = request;
  await session.ensurePage();
  const runDir = await createRunDir(project, id);
  const startSeq = session.lastSeq;

  for (const name of request.secretNames) deps.secrets.add(String(request.params[name]));
  for (const value of Object.values(request.env)) deps.secrets.add(value);
  const secrets = [...deps.secrets];

  const expand = (text: string): string =>
    expandTemplate(text, (ref) =>
      ref.startsWith('env.')
        ? (request.env[ref.slice(4)] ?? '')
        : String(request.params[ref] ?? ''),
    );

  const guard = await guardNavigation(session.context, flow.allowed_hosts ?? []);
  if (request.options.trace) await startTrace(session.context);

  let currentStep = 0;
  const env: StepEnv = {
    session,
    baseUrl: flow.base_url ? expand(flow.base_url) : undefined,
    allowedHosts: flow.allowed_hosts ?? [],
    expectsLogin: flowExpectsLogin(flow),
    blockedNavigation: guard.take,
    capture: async ({ fullPage, target }) => {
      const page = session.page;
      await writeBundle({
        page,
        dir: join(runDir, `capture-${currentStep}`),
        events: session.eventsSince(startSeq),
        secrets,
        fullPage,
        element: target ? await resolveElement(page, target) : undefined,
      });
    },
  };

  const records: StepRecord[] = [];
  let passed = 0;
  let failure: StepFailure | undefined;
  let failedStep: FailedStep | null = null;
  let failureBundle: Bundle | undefined;
  let candidates: Candidate[] | undefined;

  try {
    for (const [index, raw] of flow.steps.entries()) {
      currentStep = index + 1;
      const step: NormalizedStep = normalizeStep(raw, {
        expand,
        screenshotPath: (name) =>
          join(runDir, `step-${currentStep}-${slugify(name ?? 'screenshot')}.png`),
      });
      const record: StepRecord = {
        n: currentStep,
        type: step.type,
        target: describeStep(step),
        status: 'passed',
        duration_ms: 0,
      };
      const stepStarted = Date.now();
      try {
        await executeStep(step, env);
        passed++;
      } catch (error) {
        const caught =
          error instanceof StepFailure
            ? error
            : new StepFailure('assertion_failed', errorMessage(error));
        record.error = { code: caught.code, message: caught.message };
        if (step.optional) {
          record.status = 'skipped';
        } else {
          record.status = 'failed';
          if (!failure) {
            failure = caught;
            failedStep = {
              n: currentStep,
              type: step.type,
              target: describeStep(step),
              expected: caught.expected ?? null,
              actual: caught.actual ?? null,
            };
            const page = session.page;
            failureBundle = await writeBundle({
              page,
              dir: runDir,
              events: session.eventsSince(startSeq),
              secrets,
              element: caught.locator ? await resolveElement(page, caught.locator) : undefined,
              visuals: flow.on_fail !== 'none',
            });
            if (caught.code === 'locator_not_found' && caught.locator) {
              candidates = await candidatesFor(page, caught.locator);
            }
          }
        }
      }
      record.duration_ms = Date.now() - stepStarted;
      records.push(record);
      if (failure && !request.options.keepGoing) break;
    }
  } finally {
    await guard.dispose();
    if (request.options.trace) {
      await session.context.tracing.stop({ path: join(runDir, 'trace.zip') }).catch(() => {});
    }
  }

  const bundle =
    failureBundle ??
    (await writeBundle({
      page: session.page,
      dir: runDir,
      events: session.eventsSince(startSeq),
      secrets,
      visuals: false,
    }));
  const status: RunStatus = !failure
    ? 'passed'
    : failure.code === 'browser_unavailable'
      ? 'error'
      : 'failed';
  const durationMs = Date.now() - started;

  const digest = buildDigest(
    maskDeep(
      {
        flow: id,
        status,
        params: Object.fromEntries(
          Object.entries(request.params).map(([name, value]) => [
            name,
            request.secretNames.includes(name) ? '***' : value,
          ]),
        ),
        durationMs,
        stepsTotal: flow.steps.length,
        stepsPassed: passed,
        failedStep,
        error: failure?.toInfo() ?? null,
        candidates,
        evidence: bundle.summary,
      },
      secrets,
    ),
  );

  await writeRunJson(
    runDir,
    {
      kind: 'flow',
      flow: id,
      ts: new Date(started).toISOString(),
      status,
      duration_ms: durationMs,
      run_dir: toPosix(runDir),
      options: request.options,
      params: digest.params,
      steps: records,
      failed_step: failedStep,
      error: failure?.toInfo() ?? null,
      candidates: candidates ?? [],
      evidence: { ...bundle.summary, ...bundle.full },
      digest,
    },
    secrets,
  );
  await session.persistCookies();
  return digest;
}
