import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerDescribe(program: Command): void {
  program
    .command('describe')
    .description('print one flow in full as JSON')
    .argument('<flow>', 'flow name')
    .action(() => runCommand(async () => notImplemented('describe', 4)));
}
