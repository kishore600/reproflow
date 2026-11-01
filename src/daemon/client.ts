import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { type ErrorCode, errorMessage, ReproflowError } from '../errors.js';
import { daemonLogPath, daemonsDir } from '../paths.js';
import { sleep } from '../util.js';
import { forceHeadless } from './browser.js';
import type { DaemonStatus } from './protocol.js';
import {
  cleanStaleStates,
  type DaemonState,
  isPidAlive,
  listDaemonStates,
  readDaemonState,
  removeDaemonState,
} from './state.js';

const STARTUP_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;

export interface DaemonHandle {
  state: DaemonState;
  call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

interface RpcReply {
  result?: unknown;
  error?: { code: number; message: string; data?: { code?: ErrorCode; hint?: string } };
}

function post(state: DaemonState, body: unknown, timeoutMs?: number): Promise<RpcReply> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: state.port,
        path: '/rpc',
        method: 'POST',
        agent: false,
        headers: {
          authorization: `Bearer ${state.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`daemon answered HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as RpcReply);
          } catch {
            reject(new Error('daemon sent invalid JSON'));
          }
        });
      },
    );
    if (timeoutMs)
      req.setTimeout(timeoutMs, () => req.destroy(new Error('daemon request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

function handleFor(state: DaemonState): DaemonHandle {
  let nextId = 1;
  return {
    state,
    async call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      let reply: RpcReply;
      try {
        reply = await post(state, { jsonrpc: '2.0', id: nextId++, method, params }, timeoutMs);
      } catch (error) {
        throw new ReproflowError(
          'daemon_unavailable',
          `could not reach the daemon: ${errorMessage(error)}`,
        );
      }
      if (reply.error) {
        throw new ReproflowError(
          reply.error.data?.code ?? 'daemon_unavailable',
          reply.error.message,
          reply.error.data?.hint,
        );
      }
      return reply.result as T;
    },
  };
}

async function responds(state: DaemonState): Promise<boolean> {
  try {
    await handleFor(state).call('ping', undefined, 2_000);
    return true;
  } catch {
    return false;
  }
}

/** The project's running daemon, or null. Removes state files left by dead or unreachable daemons. */
async function liveState(root: string): Promise<DaemonState | null> {
  const state = readDaemonState(root);
  if (!state) return null;
  if (isPidAlive(state.pid) && (await responds(state))) return state;
  removeDaemonState(root);
  return null;
}

export interface ConnectOptions {
  /** Start a daemon when none is running. */
  start: boolean;
  /** Only a profile that is asked for explicitly can force a restart. */
  profile?: string;
  headed?: boolean;
}

function needsRestart(state: DaemonState, options: ConnectOptions): boolean {
  if (options.profile && options.profile !== state.profile) return true;
  return options.headed === true && !state.headed && !forceHeadless();
}

function startupError(logPath: string): ReproflowError {
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const line = log.split('\n').find((entry) => entry.startsWith('{"startupError"'));
  const reason = line ? (JSON.parse(line) as { startupError: string }).startupError : '';
  if (!reason) {
    const tail = log.trim().split('\n').slice(-3).join(' | ');
    return new ReproflowError(
      'daemon_unavailable',
      `the daemon exited during startup${tail ? `: ${tail}` : ''}`,
    );
  }
  const summary =
    reason
      .split('\n')
      .find((text) => text.trim())
      ?.trim() ?? reason;
  if (/Executable doesn't exist|playwright install/i.test(reason)) {
    return new ReproflowError(
      'browser_unavailable',
      'Playwright Chromium is not installed',
      'Run `reproflow doctor --fix` to install it.',
    );
  }
  return new ReproflowError(
    'browser_unavailable',
    `the browser failed to start: ${summary}`,
    'The profile may be open in another reproflow session; run `reproflow session stop` there or pass --profile <name>.',
  );
}

async function startDaemon(root: string, profile: string, headed: boolean): Promise<DaemonState> {
  mkdirSync(daemonsDir(), { recursive: true });
  const logPath = daemonLogPath(root);
  const log = openSync(logPath, 'w');
  const entry = process.env.REPROFLOW_CLI_ENTRY ?? fileURLToPath(import.meta.url);
  const args = [entry, 'daemon-run', '--project', root, '--profile', profile];
  if (headed) args.push('--headed');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  closeSync(log);
  child.unref();
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readDaemonState(root);
    if (state && state.pid === child.pid && (await responds(state))) return state;
    if (exited) throw startupError(logPath);
    await sleep(100);
  }
  throw new ReproflowError('daemon_unavailable', 'the daemon did not become ready in time');
}

/**
 * Connects to the project's daemon, starting (or restarting) it when allowed.
 * Returns null only when `start` is false and nothing is running.
 */
export async function connectDaemon(
  root: string,
  options: ConnectOptions,
): Promise<DaemonHandle | null> {
  cleanStaleStates();
  let state = await liveState(root);
  if (state && needsRestart(state, options)) {
    await stopDaemon(root);
    state = null;
  }
  if (!state && options.start) {
    state = await startDaemon(root, options.profile ?? 'default', options.headed ?? false);
  }
  return state ? handleFor(state) : null;
}

/** Like connectDaemon with start: true, but never null. */
export async function ensureDaemon(
  root: string,
  options: Omit<ConnectOptions, 'start'> = {},
): Promise<DaemonHandle> {
  const handle = await connectDaemon(root, { ...options, start: true });
  if (!handle) throw new ReproflowError('daemon_unavailable', 'the daemon is not running');
  return handle;
}

async function stopState(state: DaemonState): Promise<void> {
  try {
    await handleFor(state).call('shutdown', undefined, 5_000);
  } catch {
    // Already gone, or about to be.
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isPidAlive(state.pid) && Date.now() < deadline) await sleep(50);
  if (isPidAlive(state.pid)) {
    try {
      process.kill(state.pid);
    } catch {}
    for (let i = 0; i < 60 && isPidAlive(state.pid); i++) await sleep(50);
  }
}

/** Stops the project's daemon. Returns false when none was running. */
export async function stopDaemon(root: string): Promise<boolean> {
  const state = await liveState(root);
  if (!state) return false;
  await stopState(state);
  removeDaemonState(root);
  return true;
}

/** Stops every reachable daemon that holds  (login needs the profile to itself). */
export async function stopDaemonsUsingProfile(profile: string): Promise<number> {
  let stopped = 0;
  for (const state of listDaemonStates()) {
    if (state.profile !== profile || !isPidAlive(state.pid) || !(await responds(state))) continue;
    await stopState(state);
    removeDaemonState(state.project);
    stopped++;
  }
  return stopped;
}

export async function daemonStatus(root: string): Promise<DaemonStatus | null> {
  const handle = await connectDaemon(root, { start: false });
  return handle ? handle.call<DaemonStatus>('status', undefined, 5_000) : null;
}
