import { type ExitCode, fail } from './output.js';

/** Placeholder action for commands that land in a later build phase. */
export function notImplemented(command: string, phase: number): ExitCode {
  return fail(`\`${command}\` is not implemented yet (planned for phase ${phase})`);
}
