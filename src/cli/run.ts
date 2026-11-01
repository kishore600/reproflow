import type { Command } from 'commander';
import { runFlowCommand } from '../engine/commands.js';
import { exitCodeForDigest, formatDigestText } from '../evidence/digest.js';
import { parseParamTokens } from '../flows/params.js';
import { findProjectRoot } from '../paths.js';
import { fail, printResult, runCommand } from './output.js';

interface RunOptions {
  headed?: boolean;
  trace?: boolean;
  keepGoing?: boolean;
}

export function registerRun(program: Command): void {
  program
    .command('run')
    .description('replay a saved flow with no AI calls and print the digest')
    .argument('<flow>', 'flow name (see `reproflow list`)')
    .argument('[params...]', 'flow params as --name=value')
    .option('--headed', 'show the browser window')
    .option('--trace', 'record a Playwright trace.zip in the run folder')
    .option('--keep-going', 'continue after a failed step (default: stop at the first)')
    .allowUnknownOption()
    .addHelpText(
      'after',
      `
Exit codes: 0 passed, 1 a step failed, 2 the flow could not run (invalid, missing param, no browser).
The names headed, trace, keep-going and json are reserved; they cannot be flow params.

Examples:
  reproflow run repro-cart-total
  reproflow run repro-cart-total --sku=HOODIE-L --headed --trace`,
    )
    .action((flowName: string, tokens: string[], opts: RunOptions, command: Command) =>
      runCommand(command, async () => {
        const { params, stray } = parseParamTokens(tokens);
        if (stray.length > 0) {
          return fail(
            `unexpected argument${stray.length > 1 ? 's' : ''}: ${stray.join(' ')} (pass flow params as --name=value)`,
          );
        }
        const digest = await runFlowCommand(findProjectRoot(), flowName, params, opts);
        printResult(command, digest, () => formatDigestText(digest));
        return exitCodeForDigest(digest);
      }),
    );
}
