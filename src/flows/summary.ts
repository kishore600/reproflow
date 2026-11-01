import { truncate } from '../util.js';
import { listFlows } from './load.js';
import type { ParamSpec } from './schema.js';

export interface FlowSummary {
  name: string;
  description?: string;
  /** `name:type`, with `*` marking a required param. */
  params?: string[];
  /** Set instead of the fields above when the flow file does not parse. */
  error?: string;
}

export interface FlowList {
  flows: FlowSummary[];
  hint?: string;
}

const isRequired = (spec: ParamSpec): boolean => spec.required ?? spec.default === undefined;

/** The compact listing `reproflow list` and the MCP `reproflow_list` tool both print. */
export async function listFlowSummaries(root: string): Promise<FlowList> {
  const flows = (await listFlows(root)).map(({ id, flow, error }): FlowSummary => {
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
  return flows.length === 0 ? { flows, hint: 'No flows yet. Run `reproflow init`.' } : { flows };
}

/** One line per flow, for terminals. */
export function formatFlowList(list: FlowList): string {
  if (list.flows.length === 0) {
    return 'No flows yet. Run `reproflow init`, or record one with `reproflow do ...` and `reproflow save`.';
  }
  return list.flows
    .map((entry) => {
      if (entry.error) return `${entry.name}  INVALID: ${entry.error}`;
      const params = entry.params?.length ? `  (${entry.params.join(', ')})` : '';
      return `${entry.name}  ${entry.description ?? ''}${params}`.trimEnd();
    })
    .join('\n');
}
