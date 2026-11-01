export const ERROR_CODES = [
  'locator_not_found',
  'assertion_failed',
  'navigation_timeout',
  'auth_expired',
  'host_not_allowed',
  'browser_unavailable',
  'daemon_unavailable',
  'flow_invalid',
  'param_missing',
  'flow_not_found',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  hint: string;
}

const DEFAULT_HINTS: Record<ErrorCode, string> = {
  locator_not_found: 'Try a candidate locator, or look in snapshot.aria.yml for the right one.',
  assertion_failed: 'Compare expected and actual, then check console_errors and failed_requests.',
  navigation_timeout: 'Check that the app is running and the URL is reachable.',
  auth_expired: 'Ask the user to run `reproflow login <url>`.',
  host_not_allowed: 'Add the host to allowed_hosts in the flow if this navigation is intended.',
  browser_unavailable: 'Run `reproflow doctor --fix`.',
  daemon_unavailable: 'Run `reproflow session stop`, then retry.',
  flow_invalid: 'Fix the listed YAML paths, then retry.',
  param_missing: 'Pass --<name>=<value> or set the env var.',
  flow_not_found: 'Run `reproflow list` to see the saved flows.',
};

/** Setup and environment problems exit 2; a step or check that did not pass exits 1. */
export function exitCodeFor(code: ErrorCode): 1 | 2 {
  return [
    'browser_unavailable',
    'daemon_unavailable',
    'flow_invalid',
    'param_missing',
    'flow_not_found',
  ].includes(code)
    ? 2
    : 1;
}

export class ReproflowError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint: string = DEFAULT_HINTS[code],
  ) {
    super(message);
    this.name = 'ReproflowError';
  }

  toInfo(): ErrorInfo {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
