import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { projectPaths } from '../paths.js';

/** What the daemon learned about the element an action used; the recorder reads this. */
export interface ElementMeta {
  role?: string;
  /** Accessible name from the aria snapshot. */
  name?: string;
  label?: string;
  placeholder?: string;
  /** `type` attribute, e.g. "password" or "number". */
  type?: string;
  /** True when role+name resolves to exactly one element on the page. */
  unique?: boolean;
}

export interface SessionEntry {
  ts: string;
  action: string;
  target: string | null;
  value: string | null;
  url: string;
  ok: boolean;
  el?: ElementMeta;
}

export async function appendSessionEntry(root: string, entry: SessionEntry): Promise<void> {
  const { dir, session } = projectPaths(root);
  await mkdir(dir, { recursive: true });
  await appendFile(session, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function readSessionLog(root: string): Promise<SessionEntry[]> {
  const text = await readFile(projectPaths(root).session, 'utf8').catch(() => '');
  const entries: SessionEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Skip a torn line rather than losing the whole session.
    }
  }
  return entries;
}
