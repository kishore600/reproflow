import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import type { ZodIssue } from 'zod';
import { absoluteUrl } from '../engine/steps.js';
import { ReproflowError } from '../errors.js';
import { projectPaths } from '../paths.js';
import { type Flow, FlowSchema, STEP_TYPES, type StepType, stepTypeOf } from './schema.js';
import { REF_SYNTAX, templateRefs, walkStrings } from './templating.js';

export interface FlowIssue {
  /** Dotted YAML path, e.g. `steps[2].click.role`. */
  path: string;
  message: string;
  /** 1-based line in the YAML file, when it could be found. */
  line?: number;
}

/** `flow_invalid`, carrying every issue with its YAML path. */
export class FlowInvalidError extends ReproflowError {
  constructor(
    readonly file: string,
    readonly issues: FlowIssue[],
  ) {
    const shown = issues.slice(0, 4).map(describeIssue).join('; ');
    const more = issues.length > 4 ? `; and ${issues.length - 4} more` : '';
    super(
      'flow_invalid',
      `${file}: ${issues.length} issue${issues.length === 1 ? '' : 's'}: ${shown}${more}`,
    );
    this.name = 'FlowInvalidError';
  }
}

export const describeIssue = (issue: FlowIssue): string =>
  `${issue.path || '(file)'}${issue.line ? ` (line ${issue.line})` : ''}: ${issue.message}`;

const FLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const isValidFlowName = (name: string): boolean => FLOW_NAME.test(name);

export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

type Located = { path: PropertyKey[]; message: string };

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

function isStepPath(path: readonly PropertyKey[]): boolean {
  return path.length === 2 && path[0] === 'steps' && typeof path[1] === 'number';
}

/**
 * Zod reports a union mismatch as one opaque issue holding every branch's errors. Pick the branch
 * the author most plausibly meant (fewest issues) and report its problems at their real paths.
 */
function flatten(issues: readonly ZodIssue[], root: unknown, base: PropertyKey[] = []): Located[] {
  const out: Located[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    if (issue.code !== 'invalid_union') {
      out.push({ path, message: issue.message });
      continue;
    }
    const input = valueAt(root, path);
    if (
      isStepPath(path) &&
      input &&
      typeof input === 'object' &&
      !stepTypeOf(input as Record<string, unknown>)
    ) {
      const found = Object.keys(input).join(', ') || 'none';
      out.push({
        path,
        message: `unknown step (found keys: ${found}); a step needs exactly one of: ${STEP_TYPES.join(', ')}`,
      });
      continue;
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      out.push({
        path,
        message: `expected an object, got ${Array.isArray(input) ? 'a list' : typeof input}`,
      });
      continue;
    }
    const branches = issue.errors as ZodIssue[][];
    const best = branches.reduce((a, b) => (b.length < a.length ? b : a));
    out.push(...flatten(best, root, path));
  }
  return out;
}

/** Walks the document to the node at `path` (or its nearest parent) and returns its line. */
function lineOf(
  doc: ReturnType<typeof parseDocument>,
  lines: LineCounter,
  path: readonly PropertyKey[],
): number | undefined {
  for (let end = path.length; end >= 0; end--) {
    const node = doc.getIn(path.slice(0, end) as (string | number)[], true) as
      | { range?: number[] }
      | undefined;
    if (node?.range) return lines.linePos(node.range[0]).line;
  }
  return undefined;
}

/** Checks the rules a schema cannot express: template names, relative URLs, secret defaults. */
function semanticIssues(flow: Flow): Located[] {
  const issues: Located[] = [];
  const params = flow.params ?? {};

  for (const [name, spec] of Object.entries(params)) {
    if (spec.secret && spec.default !== undefined) {
      issues.push({
        path: ['params', name, 'default'],
        message: 'a secret param must not have a default; read it from env instead',
      });
    }
    if (spec.default !== undefined && typeof spec.default !== spec.type) {
      issues.push({ path: ['params', name, 'default'], message: `default must be a ${spec.type}` });
    }
  }

  const check = (text: string, path: (string | number)[]): void => {
    for (const ref of templateRefs(text)) {
      if (!REF_SYNTAX.test(ref)) {
        issues.push({ path, message: `bad template {{${ref}}}; use {{param}} or {{env.NAME}}` });
      } else if (!ref.startsWith('env.') && !(ref in params)) {
        const known = Object.keys(params).join(', ') || 'none declared';
        issues.push({ path, message: `unknown param "${ref}" in {{${ref}}} (params: ${known})` });
      }
    }
  };
  walkStrings(flow.steps, (text, path) => check(text, ['steps', ...path]));
  if (flow.base_url) check(flow.base_url, ['base_url']);

  flow.steps.forEach((step, index) => {
    const type = stepTypeOf(step as Record<string, unknown>) as StepType;
    const raw = (step as Record<string, unknown>)[type];
    if (type === 'goto' && typeof raw === 'string' && !flow.base_url && !absoluteUrl(raw)) {
      issues.push({ path: ['steps', index, 'goto'], message: 'a relative URL needs base_url' });
    }
  });

  flow.allowed_hosts?.forEach((host, index) => {
    if (/[/:]/.test(host.replace(/^\[|\]$/g, '')) && !host.startsWith('[')) {
      issues.push({
        path: ['allowed_hosts', index],
        message: 'use a bare hostname, without scheme, port or path',
      });
    }
  });
  return issues;
}

/** Parses and validates flow YAML. Throws {@link FlowInvalidError} listing every issue. */
export function parseFlow(text: string, file: string): Flow {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  if (doc.errors.length > 0) {
    throw new FlowInvalidError(
      file,
      doc.errors.map((error) => ({
        path: '',
        message: error.message.split('\n')[0],
        line: error.linePos?.[0]?.line,
      })),
    );
  }
  const raw = doc.toJS();
  const parsed = FlowSchema.safeParse(raw);
  const located = parsed.success ? semanticIssues(parsed.data) : flatten(parsed.error.issues, raw);
  if (located.length > 0) {
    throw new FlowInvalidError(
      file,
      located.map(({ path, message }) => ({
        path: formatPath(path),
        message,
        line: lineOf(doc, lines, path),
      })),
    );
  }
  return (parsed as { data: Flow }).data;
}

export interface LoadedFlow {
  /** File name without extension; what you pass to `reproflow run`. */
  id: string;
  file: string;
  flow: Flow;
}

async function flowFile(root: string, name: string): Promise<string | null> {
  const { flows } = projectPaths(root);
  for (const extension of ['.yaml', '.yml']) {
    const file = join(flows, `${name}${extension}`);
    try {
      await readFile(file);
      return file;
    } catch {}
  }
  return null;
}

export async function loadFlow(root: string, name: string): Promise<LoadedFlow> {
  if (!isValidFlowName(name)) {
    throw new ReproflowError('flow_not_found', `"${name}" is not a valid flow name`);
  }
  const file = await flowFile(root, name);
  if (!file) {
    const known = (await listFlows(root)).map((entry) => entry.id);
    const hint = known.length
      ? `Saved flows: ${known.join(', ')}. Run \`reproflow list\` for details.`
      : 'No flows saved yet. Record one with `reproflow do ...` then `reproflow save <name> --from-session`.';
    throw new ReproflowError(
      'flow_not_found',
      `no flow named "${name}" in .reproflow/flows/`,
      hint,
    );
  }
  const flow = parseFlow(await readFile(file, 'utf8'), `${name}.yaml`);
  return { id: name, file, flow };
}

export interface ListedFlow {
  id: string;
  /** Present when the flow parsed. */
  flow?: Flow;
  /** Present when it did not. */
  error?: string;
}

export async function listFlows(root: string): Promise<ListedFlow[]> {
  const { flows } = projectPaths(root);
  const names = (await readdir(flows).catch(() => [] as string[]))
    .filter((file) => /\.ya?ml$/.test(file))
    .sort();
  const listed: ListedFlow[] = [];
  for (const file of names) {
    const id = file.replace(/\.ya?ml$/, '');
    try {
      listed.push({ id, flow: parseFlow(await readFile(join(flows, file), 'utf8'), file) });
    } catch (error) {
      listed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return listed;
}
