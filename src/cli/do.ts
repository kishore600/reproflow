import type { Command } from 'commander';
import { ensureDaemon } from '../daemon/client.js';
import type { DoParams, MiniDigest } from '../daemon/protocol.js';
import { LocatorSyntaxError, parseLocator } from '../engine/locators.js';
import type { NormalizedStep, WaitState } from '../engine/steps.js';
import { exitCodeFor, ReproflowError } from '../errors.js';
import { expandTemplate, hasTemplate, REF_SYNTAX } from '../flows/templating.js';
import { findProjectRoot } from '../paths.js';
import { type ExitCode, fail, printResult, runCommand } from './output.js';

const ACTIONS = [
  'goto',
  'click',
  'fill',
  'press',
  'scroll-to',
  'switch-tab',
  'screenshot',
  'wait-for',
];
const WAIT_STATES: WaitState[] = ['visible', 'hidden', 'attached', 'detached'];

interface DoOptions {
  fullPage?: boolean;
  locator?: string;
  state?: string;
  timeout?: string;
}

class UsageError extends Error {}

/** Expands `{{env.NAME}}` from this process's environment (the daemon's env may differ). */
function expandEnv(text: string): string {
  return expandTemplate(text, (ref) => {
    if (!REF_SYNTAX.test(ref) || !ref.startsWith('env.')) {
      throw new UsageError(`only {{env.NAME}} templates work in \`do\` values, got {{${ref}}}`);
    }
    const value = process.env[ref.slice(4)];
    if (value === undefined) {
      throw new ReproflowError(
        'param_missing',
        `environment variable ${ref.slice(4)} is not set`,
        `Set ${ref.slice(4)} and retry.`,
      );
    }
    return value;
  });
}

function buildDoParams(action: string, args: string[], opts: DoOptions): DoParams {
  const timeoutMs = opts.timeout === undefined ? undefined : Number(opts.timeout);
  if (timeoutMs !== undefined && !(timeoutMs > 0))
    throw new UsageError('--timeout must be a positive number of milliseconds');
  const need = (count: number, usage: string): void => {
    if (args.length < count) throw new UsageError(`usage: reproflow do ${action} ${usage}`);
  };
  const joined = (): string => args.join(' ');
  const base = { timeoutMs };

  let step: NormalizedStep;
  let secrets: string[] | undefined;
  let logValue: string | undefined;

  switch (action) {
    case 'goto':
      need(1, '<url>');
      step = { ...base, type: 'goto', url: joined() };
      break;
    case 'click':
      need(1, '<locator>');
      step = { ...base, type: 'click', target: parseLocator(joined()) };
      break;
    case 'scroll-to':
      need(1, '<locator>');
      step = { ...base, type: 'scroll_to', target: parseLocator(joined()) };
      break;
    case 'fill': {
      need(2, '<locator> <value>');
      const [locator, ...rest] = args;
      const raw = rest.join(' ');
      const value = expandEnv(raw);
      if (hasTemplate(raw)) {
        secrets = [value];
        logValue = raw;
      }
      step = { ...base, type: 'fill', target: parseLocator(locator), value };
      break;
    }
    case 'press':
      need(1, '<key>');
      step = { ...base, type: 'press', key: args[0] };
      break;
    case 'switch-tab':
      need(1, '<index|url-substring|title-substring>');
      step = { ...base, type: 'switch_tab', tab: joined() };
      break;
    case 'screenshot':
      step = {
        ...base,
        type: 'screenshot',
        path: '',
        fullPage: Boolean(opts.fullPage),
        target: opts.locator ? parseLocator(opts.locator) : undefined,
      };
      break;
    case 'wait-for': {
      need(1, '<locator> [--state visible|hidden] [--timeout ms]');
      const state = (opts.state ?? 'visible') as WaitState;
      if (!WAIT_STATES.includes(state))
        throw new UsageError(`--state must be one of ${WAIT_STATES.join(', ')}`);
      step = { ...base, type: 'wait_for', target: parseLocator(joined()), state };
      break;
    }
    default:
      throw new UsageError(`unknown action "${action}"; use one of: ${ACTIONS.join(', ')}`);
  }
  return { action, step, secrets, logValue };
}

function describeDo(digest: MiniDigest): string {
  const lines = [`${digest.ok ? '✔' : '✖'} ${digest.action}`, `  ${digest.url}  ${digest.title}`];
  if (digest.error)
    lines.push(`  ${digest.error.code}: ${digest.error.message}`, `  hint: ${digest.error.hint}`);
  const screenshot = digest.evidence?.screenshot;
  if (typeof screenshot === 'string') lines.push(`  screenshot: ${screenshot}`);
  return lines.join('\n');
}

export function registerDo(program: Command): void {
  program
    .command('do')
    .description('run one browser action in the current session and log it for `save`')
    .argument('<action>', ACTIONS.join(' | '))
    .argument('[args...]', 'action arguments')
    .option('--full-page', 'screenshot: capture the full page')
    .option('--locator <locator>', 'screenshot: capture one element')
    .option('--state <state>', 'wait-for: visible (default), hidden, attached or detached')
    .option('--timeout <ms>', 'action timeout in milliseconds (default 10000)')
    .addHelpText(
      'after',
      `
Locators: role=button[name="Add to cart"] | label="Email" | text="Cart" | placeholder="Search"
          | testid=checkout | css=.cart-total | "Cart" (bare quoted string means text)
          Append " >> nth=1" to pick the second match, " >> exact" for an exact match.

Examples:
  reproflow do goto http://localhost:3000/products/TSHIRT-M
  reproflow do click 'role=button[name="Add to cart"]'
  reproflow do fill 'label="Email"' me@example.com
  reproflow do fill 'label="Password"' '{{env.SHOP_PASSWORD}}'
  reproflow do switch-tab help`,
    )
    .action((action: string, args: string[], opts: DoOptions, command: Command) =>
      runCommand(command, async (): Promise<ExitCode> => {
        let params: DoParams;
        try {
          params = buildDoParams(action, args, opts);
        } catch (error) {
          if (error instanceof UsageError || error instanceof LocatorSyntaxError) {
            return fail(error.message);
          }
          throw error;
        }
        const handle = await ensureDaemon(findProjectRoot());
        const digest = await handle.call<MiniDigest>('do', params);
        printResult(command, digest, () => describeDo(digest));
        return digest.ok ? 0 : exitCodeFor(digest.error?.code ?? 'assertion_failed');
      }),
    );
}
