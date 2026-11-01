import { ensureDaemon } from '../daemon/client.js';
import { ReproflowError } from '../errors.js';
import { buildDigest, type RunDigest } from '../evidence/digest.js';
import { type LoadedFlow, loadFlow } from '../flows/load.js';
import { resolveEnv, resolveParams } from '../flows/params.js';
import { appendStat, statFromDigest } from '../stats/stats.js';
import type { RunRequest } from './run-flow.js';

export interface RunFlowOptions {
  headed?: boolean;
  trace?: boolean;
  keepGoing?: boolean;
}

/** A digest for a run that never got to execute a step (bad flow, missing param, no browser). */
export function errorDigest(
  flow: string | null,
  error: ReproflowError,
  stepsTotal: number,
  durationMs: number,
): RunDigest {
  return buildDigest({
    flow,
    status: 'error',
    durationMs,
    stepsTotal,
    stepsPassed: 0,
    error: error.toInfo(),
    next: error.hint,
  });
}

/**
 * Loads, validates and replays a saved flow, always returning a digest: setup problems (unknown
 * flow, invalid YAML, missing param, no daemon or browser) come back as `status: "error"`.
 * Shared by `reproflow run` and the MCP server.
 */
export async function runFlowCommand(
  root: string,
  name: string,
  overrides: Record<string, string>,
  options: RunFlowOptions = {},
): Promise<RunDigest> {
  const started = Date.now();
  let loaded: LoadedFlow | undefined;
  try {
    loaded = await loadFlow(root, name);
    const resolved = resolveParams(loaded.flow, overrides);
    const env = resolveEnv(loaded.flow);
    const handle = await ensureDaemon(root, { headed: options.headed });
    const request: RunRequest = {
      id: loaded.id,
      flow: loaded.flow,
      params: resolved.values,
      secretNames: resolved.secretNames,
      env,
      options: { trace: options.trace, keepGoing: options.keepGoing },
    };
    return await handle.call<RunDigest>('run', request);
  } catch (error) {
    if (!(error instanceof ReproflowError)) throw error;
    const digest = errorDigest(name, error, loaded?.flow.steps.length ?? 0, Date.now() - started);
    if (error.code !== 'flow_not_found') await appendStat(root, statFromDigest(digest));
    return digest;
  }
}
