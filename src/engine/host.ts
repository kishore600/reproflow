/** Hosts every flow may visit without listing them. */
const ALWAYS_ALLOWED = ['localhost', '127.0.0.1', '[::1]'];

/**
 * True when `url` may be navigated to under a flow's `allowed_hosts`.
 * Entries are bare hostnames (no port); `*.example.com` matches any subdomain.
 */
export function isHostAllowed(url: string, allowedHosts: readonly string[] = []): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'about:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return [...ALWAYS_ALLOWED, ...allowedHosts.map((rule) => rule.toLowerCase())].some((rule) =>
    rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule,
  );
}
