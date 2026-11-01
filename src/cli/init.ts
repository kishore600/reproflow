import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('set up the current project: flows folder, .gitignore, agent skill and notes')
    .action(() => runCommand(async () => notImplemented('init', 5)));
}
