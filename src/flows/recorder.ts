import { Document, isPair, isScalar, isSeq, visit } from 'yaml';
import { LocatorSyntaxError, parseLocator } from '../engine/locators.js';
import { absoluteUrl } from '../engine/steps.js';
import { ReproflowError } from '../errors.js';
import { parseFlow } from './load.js';
import type { Flow, LocatorSpec, ParamSpec, Step } from './schema.js';
import type { SessionEntry } from './session-log.js';
import { hasTemplate, templateRefs } from './templating.js';

/** `do` actions a flow can replay; screenshots and failures are not recorded. */
const RECORDABLE = new Set([
  'goto',
  'click',
  'fill',
  'press',
  'scroll-to',
  'switch-tab',
  'wait-for',
]);

/** Most actions a recording keeps when it picks the range itself. */
export const MAX_RECORDED_ACTIONS = 50;

/** Roles an aria snapshot reports for things that are not meaningful locators. */
const WEAK_ROLES = new Set(['generic', 'text', 'none', 'presentation', 'document', 'group']);

export interface RecordOptions {
  name: string;
  description?: string;
  /** Use exactly the last N successful actions instead of "since the last new-origin goto". */
  last?: number;
  now?: Date;
}

export interface Recording {
  flow: Flow;
  /** The file content, with a header comment. */
  yaml: string;
  /** Secret params and the environment variable each one reads. */
  secrets: { param: string; env: string }[];
  actions: number;
}

interface Indexed {
  entry: SessionEntry;
  /** Position in the full session log. */
  index: number;
}

function originOf(url: string | undefined): string | undefined {
  try {
    const origin = url ? new URL(url).origin : undefined;
    return origin && origin !== 'null' ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** The successful, replayable actions to record. */
function pickActions(entries: readonly SessionEntry[], last: number | undefined): Indexed[] {
  const actions = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.ok && RECORDABLE.has(entry.action));
  if (last !== undefined) return actions.slice(-last);

  // Everything since the last goto that moved to a new origin (the first goto always counts).
  let start = 0;
  actions.forEach(({ entry, index }, position) => {
    if (entry.action !== 'goto') return;
    const origin = originOf(entry.url);
    const before = index > 0 ? originOf(entries[index - 1].url) : undefined;
    if (origin && origin !== before) start = position;
  });
  return actions.slice(start).slice(-MAX_RECORDED_ACTIONS);
}

/** "Email address" -> email_address; always a valid param name. */
function paramSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return 'value';
  return /^[a-z_]/.test(slug) ? slug.slice(0, 40) : `p_${slug.slice(0, 38)}`;
}

const envToken = (text: string): string =>
  text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'FLOW';

/** `{{env.NAME}}` with nothing else around it -> NAME. */
function envOfTemplate(value: string | null): string | undefined {
  if (!value || !hasTemplate(value)) return undefined;
  const ref = templateRefs(value)[0];
  return ref?.startsWith('env.') ? ref.slice(4) : undefined;
}

function locatorText(spec: LocatorSpec): string | undefined {
  if ('label' in spec) return spec.label;
  if ('placeholder' in spec) return spec.placeholder;
  if ('text' in spec) return spec.text;
  if ('role' in spec) return spec.name;
  return undefined;
}

/** The locator the action used, upgraded to role + name when that identifies the same element. */
function locatorFor(entry: SessionEntry): LocatorSpec {
  let original: LocatorSpec;
  try {
    original = parseLocator(entry.target ?? '');
  } catch (error) {
    if (error instanceof LocatorSyntaxError) {
      throw new ReproflowError(
        'flow_invalid',
        `session entry has a locator that cannot be replayed: ${entry.target}`,
      );
    }
    throw error;
  }
  const { el } = entry;
  if (el?.unique && el.role && el.name && !WEAK_ROLES.has(el.role) && !('role' in original)) {
    return { role: el.role, name: el.name.length > 120 ? el.name.slice(0, 120) : el.name };
  }
  return original;
}

/** Block style, except maps and lists of plain values, which read better on one line. */
function toYaml(flow: Flow): string {
  const doc = new Document(flow);
  visit(doc, {
    Map(_key, node, path) {
      // Steps stay one per line (`- goto: /cart`); only the maps inside them go inline.
      const parent = path[path.length - 1];
      const grandparent = path[path.length - 2];
      const isStep =
        isSeq(parent) &&
        isPair(grandparent) &&
        isScalar(grandparent.key) &&
        grandparent.key.value === 'steps';
      if (!isStep && node.items.every((pair) => isScalar(pair.value))) node.flow = true;
    },
    Seq(_key, node) {
      if (node.items.every((item) => isScalar(item))) node.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/**
 * Turns a `do` session into a flow, deterministically (no AI):
 *
 * - values typed into `fill` steps become params named from the field's label;
 * - a password field's value is never written: it becomes a secret param reading `<FLOW>_PASSWORD`;
 * - `base_url` is the first goto's origin and later gotos are relative;
 * - the locator the action used is kept, upgraded to role + name when that is unique;
 * - a final `expect_url` pins the last URL.
 */
export function recordFlow(entries: readonly SessionEntry[], options: RecordOptions): Recording {
  const picked = pickActions(entries, options.last);
  if (picked.length === 0) {
    throw new ReproflowError(
      'flow_invalid',
      'the session has no successful actions to save',
      'Run `reproflow do goto <url>` and a few more actions first.',
    );
  }

  // A recording must start on a page. If the range starts mid-session, begin where it left off.
  const first = picked[0];
  const startUrl =
    first.entry.action === 'goto'
      ? undefined
      : first.index > 0
        ? entries[first.index - 1].url
        : first.entry.url;
  const needsGoto = startUrl !== undefined && /^https?:/i.test(startUrl);

  // Absolute URL of every goto, in order (typed relative URLs resolve against the page before them).
  let previousUrl = startUrl ?? '';
  const gotoUrls: string[] = needsGoto ? [startUrl as string] : [];
  const absolute = new Map<Indexed, string>();
  for (const item of picked) {
    if (item.entry.action === 'goto') {
      const typed = item.entry.target ?? item.entry.url;
      let url = absoluteUrl(typed);
      if (!url) {
        try {
          url = new URL(typed, previousUrl || item.entry.url).href;
        } catch {
          url = item.entry.url;
        }
      }
      absolute.set(item, url);
      gotoUrls.push(url);
    }
    previousUrl = item.entry.url;
  }

  const baseOrigin = originOf(gotoUrls.find((url) => originOf(url)));
  const relative = (url: string): string => {
    try {
      const parsed = new URL(url);
      return parsed.origin === baseOrigin ? parsed.pathname + parsed.search + parsed.hash : url;
    } catch {
      return url;
    }
  };

  const prefix = envToken(options.name);
  const params: Record<string, ParamSpec> = {};
  const secrets: { param: string; env: string }[] = [];
  const uniqueParam = (base: string): string => {
    let name = base;
    for (let n = 2; name in params; n++) name = `${base}_${n}`;
    return name;
  };

  const steps: Step[] = [];
  if (needsGoto) steps.push({ goto: relative(startUrl as string) });
  for (const item of picked) {
    const { entry } = item;
    switch (entry.action) {
      case 'goto':
        steps.push({ goto: relative(absolute.get(item) as string) });
        break;
      case 'click':
        steps.push({ click: locatorFor(entry) });
        break;
      case 'scroll-to':
        steps.push({ scroll_to: locatorFor(entry) });
        break;
      case 'press':
        steps.push({ press: entry.target ?? '' });
        break;
      case 'switch-tab': {
        const tab = entry.target ?? '0';
        steps.push({ switch_tab: /^\d+$/.test(tab) ? Number(tab) : tab });
        break;
      }
      case 'wait-for': {
        const target = locatorFor(entry);
        const state = entry.value;
        steps.push({
          wait_for:
            state === 'hidden' || state === 'attached' || state === 'detached'
              ? { target, state }
              : target,
        });
        break;
      }
      case 'fill': {
        const target = locatorFor(entry);
        const label =
          entry.el?.label ??
          entry.el?.name ??
          entry.el?.placeholder ??
          locatorText(target) ??
          'value';
        const name = uniqueParam(paramSlug(label));
        const templateEnv = envOfTemplate(entry.value);
        if (entry.el?.type === 'password' || templateEnv) {
          const env =
            templateEnv ?? `${prefix}_${name === 'password' ? 'PASSWORD' : envToken(name)}`;
          params[name] = { type: 'string', secret: true, env };
          secrets.push({ param: name, env });
        } else {
          const text = entry.value ?? '';
          const numeric =
            entry.el?.type === 'number' && text.trim() !== '' && Number.isFinite(Number(text));
          params[name] = numeric
            ? { type: 'number', default: Number(text) }
            : { type: 'string', default: text };
        }
        steps.push({ fill: { target, value: `{{${name}}}` } });
        break;
      }
    }
  }

  const lastUrl = picked[picked.length - 1].entry.url;
  let endsAt: string | undefined;
  if (/^https?:/i.test(lastUrl)) {
    const parsed = new URL(lastUrl);
    endsAt =
      parsed.origin === baseOrigin
        ? parsed.pathname + parsed.search
        : `${parsed.origin}${parsed.pathname}${parsed.search}`;
    steps.push({ expect_url: endsAt });
  }

  const hosts = new Set(['localhost', '127.0.0.1']);
  for (const url of gotoUrls) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {}
  }
  const flow: Flow = {
    name: options.name,
    description: options.description ?? `Recorded flow${endsAt ? ` ending at ${endsAt}` : ''}`,
    ...(baseOrigin ? { base_url: baseOrigin } : {}),
    allowed_hosts: [...hosts],
    ...(Object.keys(params).length ? { params } : {}),
    steps,
    on_fail: 'capture',
  };

  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  const header = [
    `# Recorded by reproflow from \`reproflow do\` actions on ${date}.`,
    `# Edit freely, then run:  reproflow run ${options.name}`,
    ...(secrets.length
      ? [
          `# Secrets are never saved. Set ${secrets.map((s) => s.env).join(', ')} in the environment.`,
        ]
      : []),
  ].join('\n');
  const yaml = `${header}\n${toYaml(flow)}`;

  // The recorder must never write a flow that its own validator rejects.
  parseFlow(yaml, `${options.name}.yaml`);
  return { flow, yaml, secrets, actions: picked.length };
}
