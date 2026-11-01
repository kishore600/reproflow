import type { Locator, Page } from 'playwright';
import type { LocatorSpec } from '../flows/schema.js';

export class LocatorSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocatorSyntaxError';
  }
}

type AriaRole = Parameters<Page['getByRole']>[0];

const KIND = /^(role|label|text|placeholder|testid|css)=([\s\S]*)$/;
const MODIFIER = /\s+>>\s+(nth=(\d+)|exact)\s*$/;

/** Reads a quoted string starting at `start`; returns the value and the index after the quote. */
function readQuoted(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  let value = '';
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && i + 1 < source.length) {
      value += source[i + 1];
      i++;
    } else if (char === quote) {
      return { value, end: i + 1 };
    } else {
      value += char;
    }
  }
  throw new LocatorSyntaxError(`unterminated quote in locator ${source}`);
}

const isQuote = (char: string | undefined): boolean => char === '"' || char === "'";

/** A value is either quoted (`"Add to cart"`) or bare (`.cart-total`). */
function readValue(source: string): string {
  const text = source.trim();
  if (!isQuote(text[0])) return text;
  const { value, end } = readQuoted(text, 0);
  if (text.slice(end).trim()) throw new LocatorSyntaxError(`unexpected text after quote: ${text}`);
  return value;
}

type RoleSpec = Extract<LocatorSpec, { role: string }>;

/** `button`, `button[name="Add to cart"]`, `button[name=Add to cart]`, `button[exact][nth=1]`. */
function parseRole(rest: string): RoleSpec {
  const head = /^[A-Za-z][A-Za-z0-9-]*/.exec(rest.trim());
  if (!head) throw new LocatorSyntaxError(`role locator needs a role name: role=${rest}`);
  const source = rest.trim();
  const spec: RoleSpec = { role: head[0] };
  let pos = head[0].length;
  while (source[pos] === '[') {
    const close = (from: number): number => {
      const end = source.indexOf(']', from);
      if (end === -1) throw new LocatorSyntaxError(`missing "]" in role=${rest}`);
      return end;
    };
    pos++;
    const equals = source.indexOf('=', pos);
    const bracketEnd = close(pos);
    let key: string;
    let value: string | undefined;
    if (equals === -1 || equals > bracketEnd) {
      key = source.slice(pos, bracketEnd).trim();
      pos = bracketEnd + 1;
    } else {
      key = source.slice(pos, equals).trim();
      pos = equals + 1;
      if (isQuote(source[pos])) {
        const quoted = readQuoted(source, pos);
        value = quoted.value;
        pos = quoted.end;
        if (source[pos] !== ']') throw new LocatorSyntaxError(`missing "]" in role=${rest}`);
        pos++;
      } else {
        const end = close(pos);
        value = source.slice(pos, end).trim();
        pos = end + 1;
      }
    }
    if (key === 'name' && value !== undefined) spec.name = value;
    else if (key === 'exact') spec.exact = value !== 'false';
    else if (key === 'nth' && value !== undefined && /^\d+$/.test(value)) spec.nth = Number(value);
    else throw new LocatorSyntaxError(`unknown role attribute "${key}" in role=${rest}`);
  }
  if (source.slice(pos).trim()) {
    throw new LocatorSyntaxError(`unexpected text after role in role=${rest}`);
  }
  return spec;
}

/**
 * Parses the CLI shorthand: `role=button[name="Add to cart"]`, `label="Email"`, `text="Cart"`,
 * `placeholder="Search"`, `testid=checkout`, `css=.cart-total`, or a bare quoted string (text).
 * Append ` >> nth=1` and/or ` >> exact` to pick the nth match or require an exact match.
 */
export function parseLocator(input: string): LocatorSpec {
  let body = input.trim();
  if (!body) throw new LocatorSyntaxError('empty locator');

  let nth: number | undefined;
  let exact: boolean | undefined;
  for (let match = MODIFIER.exec(body); match; match = MODIFIER.exec(body)) {
    if (match[2] !== undefined) nth = Number(match[2]);
    else exact = true;
    body = body.slice(0, match.index);
  }

  let spec: LocatorSpec;
  if (isQuote(body[0])) {
    spec = { text: readValue(body) };
  } else {
    const kind = KIND.exec(body);
    if (!kind) {
      throw new LocatorSyntaxError(
        `unrecognised locator ${JSON.stringify(input)}; use role=..., label=..., text=..., placeholder=..., testid=..., css=... or a quoted string`,
      );
    }
    const [, name, rest] = kind;
    if (name === 'role') spec = parseRole(rest);
    else spec = { [name]: readValue(rest) } as unknown as LocatorSpec;
  }
  if (nth !== undefined) spec.nth = nth;
  if (exact) spec.exact = true;
  return spec;
}

const quote = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

const needsQuote = (value: string): boolean =>
  value !== value.trim() || isQuote(value[0]) || MODIFIER.test(value);

const bareOrQuoted = (value: string): string => (needsQuote(value) ? quote(value) : value);

/** Inverse of {@link parseLocator}; used in digests, logs and recorded flows. */
export function formatLocator(spec: LocatorSpec): string {
  let text: string;
  if ('role' in spec)
    text = `role=${spec.role}${spec.name === undefined ? '' : `[name=${quote(spec.name)}]`}`;
  else if ('label' in spec) text = `label=${quote(spec.label)}`;
  else if ('text' in spec) text = `text=${quote(spec.text)}`;
  else if ('placeholder' in spec) text = `placeholder=${quote(spec.placeholder)}`;
  else if ('testid' in spec) text = `testid=${bareOrQuoted(spec.testid)}`;
  else text = `css=${bareOrQuoted(spec.css)}`;
  if (spec.exact) text += ' >> exact';
  if (spec.nth !== undefined) text += ` >> nth=${spec.nth}`;
  return text;
}

/** The first element a locator matches, or undefined when there is none. */
export async function resolveElement(page: Page, spec: LocatorSpec): Promise<Locator | undefined> {
  const locator = toPlaywright(page, spec);
  return (await locator.count().catch(() => 0)) > 0 ? locator.first() : undefined;
}

export function toPlaywright(page: Page, spec: LocatorSpec): Locator {
  let locator: Locator;
  if ('role' in spec) {
    locator = page.getByRole(spec.role as AriaRole, { name: spec.name, exact: spec.exact });
  } else if ('label' in spec) {
    locator = page.getByLabel(spec.label, { exact: spec.exact });
  } else if ('text' in spec) {
    locator = page.getByText(spec.text, { exact: spec.exact });
  } else if ('placeholder' in spec) {
    locator = page.getByPlaceholder(spec.placeholder, { exact: spec.exact });
  } else if ('testid' in spec) {
    locator = page.getByTestId(spec.testid);
  } else {
    locator = page.locator(spec.css);
  }
  return spec.nth === undefined ? locator : locator.nth(spec.nth);
}
