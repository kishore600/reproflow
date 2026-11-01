import { ReproflowError } from '../errors.js';
import { MASK } from '../evidence/mask.js';
import type { Flow, ParamSpec } from './schema.js';
import { REF_SYNTAX, templateRefs, walkStrings } from './templating.js';

export type ParamValue = string | number | boolean;

export interface ResolvedParams {
  /** Every declared param, coerced to its type. */
  values: Record<string, ParamValue>;
  /** Names of params flagged `secret`. */
  secretNames: string[];
  /** `values` with secrets replaced by "***", safe to print. */
  masked: Record<string, ParamValue>;
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

function coerce(name: string, spec: ParamSpec, raw: string | number | boolean): ParamValue {
  if (spec.type === 'string') return String(raw);
  if (spec.type === 'number') {
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (String(raw).trim() === '' || !Number.isFinite(value)) {
      throw new ReproflowError('flow_invalid', `param ${name}: expected a number, got "${raw}"`);
    }
    return value;
  }
  if (typeof raw === 'boolean') return raw;
  const word = String(raw).trim().toLowerCase();
  if (TRUE.has(word)) return true;
  if (FALSE.has(word)) return false;
  throw new ReproflowError('flow_invalid', `param ${name}: expected true or false, got "${raw}"`);
}

/**
 * Resolves a flow's params from, in order: `--name=value` overrides, the param's `env` variable,
 * then its `default`. A param without a default is required unless it says `required: false`.
 * Throws `param_missing` (nothing to run with) or `flow_invalid` (unknown name, wrong type).
 */
export function resolveParams(
  flow: Flow,
  overrides: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedParams {
  const declared = flow.params ?? {};
  const unknown = Object.keys(overrides).filter((name) => !(name in declared));
  if (unknown.length > 0) {
    const known = Object.keys(declared).join(', ') || 'none';
    throw new ReproflowError(
      'flow_invalid',
      `unknown param${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (this flow takes: ${known})`,
      'Check `reproflow describe <flow>` for the param names.',
    );
  }

  const values: Record<string, ParamValue> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(declared)) {
    const fromEnv = spec.env ? env[spec.env] : undefined;
    const raw = overrides[name] ?? fromEnv ?? spec.default;
    if (raw === undefined) {
      if (spec.required ?? true) missing.push(name);
      else values[name] = spec.type === 'string' ? '' : spec.type === 'number' ? 0 : false;
      continue;
    }
    values[name] = coerce(name, spec, raw);
  }
  if (missing.length > 0) {
    const how = missing.map((name) => {
      const spec = declared[name];
      return spec.env ? `--${name}=<value> or set ${spec.env}` : `--${name}=<value>`;
    });
    throw new ReproflowError(
      'param_missing',
      `missing param${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      `Pass ${how.join('; ')}.`,
    );
  }

  const secretNames = Object.entries(declared)
    .filter(([, spec]) => spec.secret)
    .map(([name]) => name);
  const masked = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      secretNames.includes(name) ? MASK : value,
    ]),
  );
  return { values, secretNames, masked };
}

/** Names of the environment variables a flow reads through `{{env.NAME}}`. */
export function envRefs(flow: Flow): string[] {
  const names = new Set<string>();
  const collect = (text: string): void => {
    for (const ref of templateRefs(text)) {
      if (REF_SYNTAX.test(ref) && ref.startsWith('env.')) names.add(ref.slice(4));
    }
  };
  walkStrings(flow.steps, collect);
  if (flow.base_url) collect(flow.base_url);
  return [...names];
}

/** Reads {@link envRefs} from the CLI's environment, or throws `param_missing`. */
export function resolveEnv(
  flow: Flow,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of envRefs(flow)) {
    const value = env[name];
    if (value === undefined) missing.push(name);
    else values[name] = value;
  }
  if (missing.length > 0) {
    throw new ReproflowError(
      'param_missing',
      `environment variable${missing.length > 1 ? 's' : ''} not set: ${missing.join(', ')}`,
      `Set ${missing.join(', ')} and retry.`,
    );
  }
  return values;
}

/** Parses `--name=value` / `--name value` tokens left over after commander took its own options. */
export function parseParamTokens(tokens: readonly string[]): {
  params: Record<string, string>;
  stray: string[];
} {
  const params: Record<string, string> = {};
  const stray: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('--')) {
      stray.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals !== -1) {
      params[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      params[token.slice(2)] = next;
      i++;
    } else {
      params[token.slice(2)] = 'true';
    }
  }
  return { params, stray };
}
