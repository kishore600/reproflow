import type { Command } from 'commander';
import { loadFlow } from '../flows/load.js';
import { findProjectRoot } from '../paths.js';
import { printResult, runCommand } from './output.js';

export function registerDescribe(program: Command): void {
  program
    .command('describe')
    .description('print one flow in full as JSON')
    .argument('<flow>', 'flow name (see `reproflow list`)')
    .action((name: string, _opts: unknown, command: Command) =>
      runCommand(command, async () => {
        const { flow } = await loadFlow(findProjectRoot(), name);
        printResult(command, flow, () => JSON.stringify(flow, null, 2));
        return 0;
      }),
    );
}
