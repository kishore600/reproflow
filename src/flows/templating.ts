/** `{{param}}` and `{{env.NAME}}`. */
const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export const REF_SYNTAX = /^(env\.)?[A-Za-z_][A-Za-z0-9_]*$/;

/** Every `{{ref}}` in the text, trimmed. */
export function templateRefs(text: string): string[] {
  return [...text.matchAll(TEMPLATE)].map((match) => match[1]);
}

export const hasTemplate = (text: string): boolean => templateRefs(text).length > 0;

export function expandTemplate(text: string, resolve: (ref: string) => string): string {
  return text.replace(TEMPLATE, (_whole, ref: string) => resolve(ref));
}

/** Calls `visit(text, path)` for every string inside a JSON-like value. */
export function walkStrings(
  value: unknown,
  visit: (text: string, path: (string | number)[]) => void,
  path: (string | number)[] = [],
): void {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) walkStrings(item, visit, [...path, i]);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walkStrings(item, visit, [...path, key]);
  }
}
