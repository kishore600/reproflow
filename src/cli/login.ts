import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerLogin(program: Command): void {
  program
    .command('login')
    .description('open a headed browser so you can sign in; the profile keeps the login')
    .argument('<url>', 'page to open')
    .option('--profile <name>', 'browser profile')
    .action(() => runCommand(async () => notImplemented('login', 2)));
}
