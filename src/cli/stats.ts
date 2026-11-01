import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerStats(program: Command): void {
  program
    .command('stats')
    .description('run totals, pass rate, top failing flows and estimated tokens avoided')
    .option('--since <days>', 'only count runs from the last n days')
    .action(() => runCommand(async () => notImplemented('stats', 5)));
}
