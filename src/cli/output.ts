import type { Command } from 'commander';
import { errorMessage, ReproflowError } from '../errors.js';

/** 0 = success or passed, 1 = a check failed, 2 = usage, setup or browser error. */
export type ExitCode = 0 | 1 | 2;

/** JSON when stdout is not a TTY or --json is passed, readable text otherwise. */
export function wantsJson(command: Command): boolean {
  return Boolean(command.optsWithGlobals().json) || !process.stdout.isTTY;
}

export function printResult(command: Command, data: unknown, text: () => string): void {
  process.stdout.write(`${wantsJson(command) ? JSON.stringify(data) : text()}\n`);
}

export function fail(message: string): ExitCode {
  process.stderr.write(`reproflow: ${message}\n`);
  return 2;
}

/** Prints a setup/runtime error as a digest (`status: "error"`) and returns exit code 2. */
export function reportError(
  command: Command,
  error: unknown,
  extra: Record<string, unknown> = {},
): ExitCode {
  if (!(error instanceof ReproflowError)) return fail(errorMessage(error));
  const digest = { ok: false, status: 'error', ...extra, error: error.toInfo() };
  printResult(command, digest, () => `✖ ${error.code}: ${error.message}\n  hint: ${error.hint}`);
  return 2;
}

type Handler = () => Promise<ExitCode>;

/**
 * Runs a command handler and turns its result into the process exit code.
 * Pass the command so a ReproflowError can be printed as a digest.
 */
export function runCommand(handler: Handler): Promise<void>;
export function runCommand(command: Command, handler: Handler): Promise<void>;
export async function runCommand(first: Command | Handler, second?: Handler): Promise<void> {
  const command = typeof first === 'function' ? undefined : first;
  const handler = typeof first === 'function' ? first : second;
  try {
    process.exitCode = await (handler as Handler)();
  } catch (error) {
    process.exitCode = command ? reportError(command, error) : fail(errorMessage(error));
  }
}
