import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('check Node, Playwright Chromium, daemon health and write permissions')
    .option('--fix', 'install Playwright Chromium when it is missing')
    .action(() => runCommand(async () => notImplemented('doctor', 6)));
}
