import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Global state folder. `REPROFLOW_HOME` overrides it (tests and the demo use a temp folder). */
export function reproflowHome(): string {
  const override = process.env.REPROFLOW_HOME;
  return override ? resolve(override) : join(homedir(), '.reproflow');
}

export const daemonsDir = (): string => join(reproflowHome(), 'daemons');
export const profilesDir = (): string => join(reproflowHome(), 'profiles');

export function profileDir(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`invalid profile name "${name}" (use letters, digits, ".", "_" or "-")`);
  }
  return join(profilesDir(), name);
}

/** Nearest folder containing .reproflow/ or .git/; falls back to `cwd`. */
export function findProjectRoot(cwd: string = process.cwd()): string {
  const globalState = resolve(reproflowHome());
  let dir = resolve(cwd);
  for (;;) {
    const marker = join(dir, '.reproflow');
    const isProjectState = existsSync(marker) && resolve(marker) !== globalState;
    if (isProjectState || existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

function canonicalRoot(root: string): string {
  let real = root;
  try {
    real = realpathSync.native(root);
  } catch {}
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** Daemon state files are named after the sha1 of the project root. */
export function daemonKey(root: string): string {
  return createHash('sha1').update(canonicalRoot(root)).digest('hex');
}

export const daemonStatePath = (root: string): string =>
  join(daemonsDir(), `${daemonKey(root)}.json`);
export const daemonLogPath = (root: string): string => join(daemonsDir(), `${daemonKey(root)}.log`);

export interface ProjectPaths {
  root: string;
  dir: string;
  flows: string;
  runs: string;
  session: string;
  stats: string;
  config: string;
}

export function projectPaths(root: string): ProjectPaths {
  const dir = join(root, '.reproflow');
  return {
    root,
    dir,
    flows: join(dir, 'flows'),
    runs: join(dir, 'runs'),
    session: join(dir, 'session.jsonl'),
    stats: join(dir, 'stats.jsonl'),
    config: join(dir, 'config.json'),
  };
}

/** Paths in digests use forward slashes on every platform so JSON stays short and portable. */
export const toPosix = (p: string): string => p.replaceAll('\\', '/');
