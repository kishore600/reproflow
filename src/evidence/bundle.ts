import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { projectPaths } from '../paths.js';

/** How many run folders are kept; older ones are deleted. */
export const KEEP_RUNS = 50;

const RUN_DIR = /^\d{8}-\d{6}-/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local time as YYYYMMDD-HHmmss. */
export function runTimestamp(date: Date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function slugify(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

/** Creates .reproflow/runs/<YYYYMMDD-HHmmss>-<name>/ (suffixing -2, -3 ... on a clash). */
export async function createRunDir(root: string, name: string): Promise<string> {
  const { runs } = projectPaths(root);
  const base = `${runTimestamp()}-${slugify(name)}`;
  let dir = join(runs, base);
  for (let n = 2; existsSync(dir); n++) dir = join(runs, `${base}-${n}`);
  await mkdir(dir, { recursive: true });
  await pruneRuns(runs);
  return dir;
}

/** Deletes the oldest run folders beyond `keep`. Only touches folders named like run folders. */
export async function pruneRuns(runsDir: string, keep: number = KEEP_RUNS): Promise<string[]> {
  const entries = (await readdir(runsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && RUN_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const doomed = entries.slice(0, Math.max(0, entries.length - keep));
  await Promise.all(
    doomed.map((name) => rm(join(runsDir, name), { recursive: true, force: true }).catch(() => {})),
  );
  return doomed;
}
