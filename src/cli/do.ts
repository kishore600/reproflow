import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerDo(program: Command): void {
  program
    .command('do')
    .description('run one browser action in the current session and log it')
    .argument(
      '<action>',
      'goto | click | fill | press | scroll-to | switch-tab | screenshot | wait-for',
    )
    .argument('[args...]', 'action arguments')
    .option('--full-page', 'screenshot: capture the full page')
    .option('--locator <locator>', 'screenshot: capture one element')
    .option('--state <state>', 'wait-for: visible or hidden')
    .option('--timeout <ms>', 'action timeout in milliseconds')
    .action(() => runCommand(async () => notImplemented('do', 2)));
}
