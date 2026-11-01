import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerSave(program: Command): void {
  program
    .command('save')
    .description('save the recorded session as a named flow')
    .argument('<name>', 'flow name')
    .option('--from-session', 'build the flow from the session log')
    .option('--last <n>', 'only use the last n successful actions')
    .option('--description <text>', 'flow description')
    .option('--force', 'overwrite an existing flow')
    .action(() => runCommand(async () => notImplemented('save', 5)));
}
