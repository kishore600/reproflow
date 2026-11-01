import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

/** Hidden entry point the CLI spawns, detached, to host the browser daemon. */
export function registerDaemonRun(program: Command): void {
  program
    .command('daemon-run', { hidden: true })
    .option('--project <root>')
    .option('--profile <name>')
    .option('--headed')
    .action(() => runCommand(async () => notImplemented('daemon-run', 2)));
}
