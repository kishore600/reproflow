import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerSession(program: Command): void {
  const session = program.command('session').description('manage the background browser daemon');
  session
    .command('start')
    .description('start the daemon and its persistent Chromium')
    .option('--headed', 'show the browser window')
    .option('--profile <name>', 'browser profile')
    .action(() => runCommand(async () => notImplemented('session start', 2)));
  session
    .command('stop')
    .description('stop the daemon now')
    .action(() => runCommand(async () => notImplemented('session stop', 2)));
  session
    .command('status')
    .description('show whether the daemon is running')
    .action(() => runCommand(async () => notImplemented('session status', 2)));
}
