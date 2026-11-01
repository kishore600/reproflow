import type { Command } from 'commander';

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

/** Runs a command handler and turns its result into the process exit code. */
export async function runCommand(handler: () => Promise<ExitCode>): Promise<void> {
  try {
    process.exitCode = await handler();
  } catch (error) {
    process.exitCode = fail(error instanceof Error ? error.message : String(error));
  }
}
