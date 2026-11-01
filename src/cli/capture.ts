import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerCapture(program: Command): void {
  program
    .command('capture')
    .description('write an evidence bundle for the current page and print the digest')
    .option('--full-page', 'capture the full page')
    .option('--locator <locator>', 'also capture one element')
    .action(() => runCommand(async () => notImplemented('capture', 3)));
}
