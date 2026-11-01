import type { Command } from 'commander';
import { saveFlow } from '../flows/save.js';
import { findProjectRoot } from '../paths.js';
import { fail, printResult, runCommand } from './output.js';

interface SaveOptions {
  fromSession?: boolean;
  last?: string;
  description?: string;
  force?: boolean;
}

export function registerSave(program: Command): void {
  program
    .command('save')
    .description('save the recorded `reproflow do` session as a named flow')
    .argument('<name>', 'flow name, e.g. repro-cart-total')
    .option('--from-session', 'build the flow from .reproflow/session.jsonl (required)')
    .option('--last <n>', 'use exactly the last n successful actions')
    .option('--description <text>', 'one line shown by `reproflow list`')
    .option('--force', 'overwrite an existing flow')
    .addHelpText(
      'after',
      `
Deterministic, no AI. Takes the successful actions since the last goto to a new origin (at most 50),
turns typed values into params, never saves password values (they become secret params that read
an environment variable), makes URLs relative to base_url, prefers role+name locators, and ends with
an expect_url for the last page.

Example:
  reproflow save repro-cart-total --from-session --description "Add a product and check the cart"`,
    )
    .action((name: string, opts: SaveOptions, command: Command) =>
      runCommand(command, async () => {
        if (!opts.fromSession) {
          return fail('save needs --from-session (the only supported source in this version)');
        }
        const result = await saveFlow(findProjectRoot(), {
          name,
          description: opts.description,
          last: opts.last === undefined ? undefined : Number(opts.last),
          force: opts.force,
        });
        printResult(command, result, () =>
          [`saved ${result.path}  (${result.steps} steps)`, `next: ${result.next}`].join('\n'),
        );
        return 0;
      }),
    );
}
