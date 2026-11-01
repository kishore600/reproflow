import type { Command } from 'commander';
import { listFlows } from '../flows/load.js';
import type { ParamSpec } from '../flows/schema.js';
import { findProjectRoot } from '../paths.js';
import { truncate } from '../util.js';
import { printResult, runCommand } from './output.js';

const isRequired = (spec: ParamSpec): boolean => spec.required ?? spec.default === undefined;

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
        const entries = await listFlows(findProjectRoot());
        const flows = entries.map(({ id, flow, error }) => {
          if (!flow) return { name: id, error: truncate(error ?? 'invalid flow', 200) };
          const params = Object.entries(flow.params ?? {}).map(
            ([name, spec]) => `${name}:${spec.type}${isRequired(spec) ? '*' : ''}`,
          );
          return {
            name: id,
            ...(flow.description ? { description: truncate(flow.description, 120) } : {}),
            ...(params.length ? { params } : {}),
          };
        });
        const note = flows.length === 0 ? { hint: 'No flows yet. Run `reproflow init`.' } : {};
        printResult(command, { flows, ...note }, () =>
          flows.length === 0
            ? 'No flows yet. Run `reproflow init`, or record one with `reproflow do ...` and `reproflow save`.'
            : flows
                .map((entry) => {
                  if ('error' in entry) return `${entry.name}  INVALID: ${entry.error}`;
                  const params = entry.params?.length ? `  (${entry.params.join(', ')})` : '';
                  return `${entry.name}  ${entry.description ?? ''}${params}`.trimEnd();
                })
                .join('\n'),
        );
        return 0;
      }),
    );
}
