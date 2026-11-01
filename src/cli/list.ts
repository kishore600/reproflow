import type { Command } from 'commander';
import { formatFlowList, listFlowSummaries } from '../flows/summary.js';
import { findProjectRoot } from '../paths.js';
import { printResult, runCommand } from './output.js';

export function registerList(program: Command): void {
  program
    .command('list')
    .description('list saved flows with their params (run this first)')
    .addHelpText(
      'after',
      `
Prints compact JSON. Each flow has a name, a description and params as "name:type"
("*" marks a required param). Use \`reproflow describe <flow>\` for the full steps.`,
    )
    .action((_opts: unknown, command: Command) =>
      runCommand(command, async () => {
        const list = await listFlowSummaries(findProjectRoot());
        printResult(command, list, () => formatFlowList(list));
        return 0;
      }),
    );
}
