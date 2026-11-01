export const MASK = '***';

/** Every spelling of a secret that could show up in output: raw and URL-encoded. */
function variants(secrets: readonly string[]): string[] {
  const all = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    all.add(secret);
    all.add(encodeURIComponent(secret));
  }
  return [...all].sort((a, b) => b.length - a.length);
}

export function maskText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of variants(secrets)) out = out.split(secret).join(MASK);
  return out;
}

/** Masks secrets in every string of a JSON-like value (object keys are left alone). */
export function maskDeep<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  const list = variants(secrets);
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let out = input;
      for (const secret of list) out = out.split(secret).join(MASK);
      return out;
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, v]) => [key, walk(v)]));
    }
    return input;
  };
  return walk(value) as T;
}
