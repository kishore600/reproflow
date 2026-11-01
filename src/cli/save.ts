import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { ReproflowError } from '../errors.js';
import { isValidFlowName } from '../flows/load.js';
import { recordFlow } from '../flows/recorder.js';
import { readSessionLog } from '../flows/session-log.js';
import { findProjectRoot, projectPaths, toPosix } from '../paths.js';
import { fail, printResult, runCommand } from './output.js';

interface SaveOptions {
  fromSession?: boolean;
  last?: string;
  description?: string;
  force?: boolean;
}

export function registerSave(program: Command): void {
  program
    .command('save')
    .description('save the recorded `reproflow do` session as a named flow')
    .argument('<name>', 'flow name, e.g. repro-cart-total')
    .option('--from-session', 'build the flow from .reproflow/session.jsonl (required)')
    .option('--last <n>', 'use exactly the last n successful actions')
    .option('--description <text>', 'one line shown by `reproflow list`')
    .option('--force', 'overwrite an existing flow')
    .addHelpText(
      'after',
      `
Deterministic, no AI. Takes the successful actions since the last goto to a new origin (at most 50),
turns typed values into params, never saves password values (they become secret params that read
an environment variable), makes URLs relative to base_url, prefers role+name locators, and ends with
an expect_url for the last page.

Example:
  reproflow save repro-cart-total --from-session --description "Add a product and check the cart"`,
    )
    .action((name: string, opts: SaveOptions, command: Command) =>
      runCommand(command, async () => {
        if (!opts.fromSession) {
          return fail('save needs --from-session (the only supported source in this version)');
        }
        if (!isValidFlowName(name)) {
          return fail(`"${name}" is not a valid flow name (letters, digits, ".", "_" and "-")`);
        }
        const last = opts.last === undefined ? undefined : Number(opts.last);
        if (last !== undefined && !(Number.isInteger(last) && last > 0)) {
          return fail('--last must be a positive whole number');
        }

        const root = findProjectRoot();
        const { flows } = projectPaths(root);
        const file = join(flows, `${name}.yaml`);
        if (existsSync(file) && !opts.force) {
          throw new ReproflowError(
            'flow_invalid',
            `flow "${name}" already exists`,
            'Pass --force to overwrite it, or pick another name.',
          );
        }

        const recording = recordFlow(await readSessionLog(root), {
          name,
          description: opts.description,
          last,
        });
        await mkdir(flows, { recursive: true });
        await writeFile(file, recording.yaml);

        const env = recording.secrets.map((secret) => secret.env);
        const digest = {
          ok: true,
          status: 'saved',
          flow: name,
          path: toPosix(file),
          steps: recording.flow.steps.length,
          params: Object.keys(recording.flow.params ?? {}),
          ...(env.length ? { secret_env: env } : {}),
          next: `Run it with \`reproflow run ${name}\`${env.length ? ` (set ${env.join(', ')} first)` : ''}.`,
        };
        printResult(command, digest, () =>
          [`saved ${digest.path}  (${digest.steps} steps)`, `next: ${digest.next}`].join('\n'),
        );
        return 0;
      }),
    );
}
