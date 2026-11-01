import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerList(program: Command): void {
  program
    .command('list')
    .description('list saved flows with their params')
    .action(() => runCommand(async () => notImplemented('list', 4)));
}
