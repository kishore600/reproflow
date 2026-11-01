import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerRun(program: Command): void {
  program
    .command('run')
    .description('replay a saved flow with no AI calls')
    .argument('<flow>', 'flow name')
    .argument('[params...]', 'flow params as --name=value')
    .option('--headed', 'show the browser window')
    .option('--trace', 'record a Playwright trace.zip')
    .option('--keep-going', 'continue after a failed step')
    .allowUnknownOption()
    .action(() => runCommand(async () => notImplemented('run', 4)));
}
