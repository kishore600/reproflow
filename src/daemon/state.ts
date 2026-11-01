import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { daemonStatePath, daemonsDir } from '../paths.js';

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
  profile: string;
  startedAt: string;
  headed: boolean;
  project: string;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseState(text: string): DaemonState | null {
  try {
    const value = JSON.parse(text) as Partial<DaemonState>;
    const valid =
      Number.isInteger(value.pid) &&
      Number.isInteger(value.port) &&
      typeof value.token === 'string' &&
      typeof value.profile === 'string';
    return valid ? (value as DaemonState) : null;
  } catch {
    return null;
  }
}

export function readDaemonState(root: string): DaemonState | null {
  const file = daemonStatePath(root);
  if (!existsSync(file)) return null;
  return parseState(readFileSync(file, 'utf8'));
}

/** Written with mode 0600; the chmod is best effort (Windows ignores POSIX modes). */
export function writeDaemonState(root: string, state: DaemonState): void {
  mkdirSync(daemonsDir(), { recursive: true });
  const file = daemonStatePath(root);
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

export function removeDaemonState(root: string, onlyPid?: number): void {
  const current = readDaemonState(root);
  if (onlyPid !== undefined && current && current.pid !== onlyPid) return;
  rmSync(daemonStatePath(root), { force: true });
}

/** Every parseable state file, alive or not. */
export function listDaemonStates(): DaemonState[] {
  const dir = daemonsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => parseState(readFileSync(join(dir, name), 'utf8')) ?? []);
}

/** Removes state files (and logs) whose daemon process is gone. Returns the removed state files. */
export function cleanStaleStates(): string[] {
  const dir = daemonsDir();
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    const state = parseState(readFileSync(file, 'utf8'));
    if (state && isPidAlive(state.pid)) continue;
    rmSync(file, { force: true });
    rmSync(file.replace(/\.json$/, '.log'), { force: true });
    removed.push(name);
  }
  return removed;
}
