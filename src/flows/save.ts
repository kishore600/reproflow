import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReproflowError } from '../errors.js';
import { projectPaths, toPosix } from '../paths.js';
import { isValidFlowName } from './load.js';
import { recordFlow } from './recorder.js';
import { readSessionLog } from './session-log.js';

export interface SaveOptions {
  name: string;
  description?: string;
  /** Use exactly the last N successful actions. */
  last?: number;
  force?: boolean;
}

export interface SaveResult {
  ok: true;
  status: 'saved';
  flow: string;
  path: string;
  steps: number;
  params: string[];
  /** Environment variables the saved flow reads its secrets from. */
  secret_env?: string[];
  next: string;
}

/**
 * Records the `reproflow do` session as `.reproflow/flows/<name>.yaml`.
 * Throws `flow_invalid` for a bad name, an existing flow (without `force`) or an empty session.
 */
export async function saveFlow(root: string, options: SaveOptions): Promise<SaveResult> {
  const { name, last } = options;
  if (!isValidFlowName(name)) {
    throw new ReproflowError(
      'flow_invalid',
      `"${name}" is not a valid flow name`,
      'Use letters, digits, ".", "_" and "-".',
    );
  }
  if (last !== undefined && !(Number.isInteger(last) && last > 0)) {
    throw new ReproflowError('flow_invalid', '--last must be a positive whole number');
  }

  const { flows } = projectPaths(root);
  const file = join(flows, `${name}.yaml`);
  if (existsSync(file) && !options.force) {
    throw new ReproflowError(
      'flow_invalid',
      `flow "${name}" already exists`,
      'Pass --force to overwrite it, or pick another name.',
    );
  }

  const recording = recordFlow(await readSessionLog(root), {
    name,
    description: options.description,
    last,
  });
  await mkdir(flows, { recursive: true });
  await writeFile(file, recording.yaml);

  const env = recording.secrets.map((secret) => secret.env);
  return {
    ok: true,
    status: 'saved',
    flow: name,
    path: toPosix(file),
    steps: recording.flow.steps.length,
    params: Object.keys(recording.flow.params ?? {}),
    ...(env.length ? { secret_env: env } : {}),
    next: `Run it with \`reproflow run ${name}\`${env.length ? ` (set ${env.join(', ')} first)` : ''}.`,
  };
}
