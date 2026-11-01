import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { browserChannel } from '../daemon/browser.js';
import { daemonStatus, stopDaemon } from '../daemon/client.js';
import { cleanStaleStates } from '../daemon/state.js';
import { errorMessage } from '../errors.js';
import { daemonsDir, projectPaths, toPosix } from '../paths.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do about a failed check. */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  status: 'passed' | 'failed';
  checks: Check[];
  /** What `--fix` changed. */
  fixed: string[];
}

export interface DoctorDeps {
  /** Where Playwright expects its Chromium. */
  chromiumPath(): Promise<string>;
  /** Downloads Chromium (`playwright install chromium`). Returns whether it succeeded. */
  install(): Promise<boolean>;
}

const MIN_NODE_MAJOR = 22;

/** Runs the Playwright CLI that ships with reproflow, so the browser revision always matches. */
function installChromium(): Promise<boolean> {
  const require = createRequire(import.meta.url);
  let command = 'npx';
  let args = ['playwright', 'install', 'chromium'];
  try {
    const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
    if (existsSync(cli)) {
      command = process.execPath;
      args = [cli, 'install', 'chromium'];
    }
  } catch {}
  return new Promise((resolve) => {
    // Progress goes to stderr so stdout stays a clean digest.
    const child = spawn(command, args, { stdio: ['ignore', 2, 2], shell: command === 'npx' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

const defaultDeps: DoctorDeps = {
  async chromiumPath() {
    const { chromium } = await import('playwright');
    return chromium.executablePath();
  },
  install: installChromium,
};

async function canWrite(dir: string): Promise<string | null> {
  const probe = join(dir, `.doctor-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * Checks the Node version, Playwright and its Chromium, daemon health and write permissions.
 * With `fix`, installs a missing Chromium and restarts an unresponsive daemon.
 */
export async function runDoctor(
  root: string,
  options: { fix: boolean },
  deps: DoctorDeps = defaultDeps,
): Promise<DoctorReport> {
  const checks: Check[] = [];
  const fixed: string[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node',
    ok: major >= MIN_NODE_MAJOR,
    detail: `Node.js ${process.versions.node}`,
    ...(major >= MIN_NODE_MAJOR ? {} : { fix: `Install Node.js ${MIN_NODE_MAJOR} or newer.` }),
  });

  try {
    const manifest = createRequire(import.meta.url)('playwright/package.json') as {
      version: string;
    };
    checks.push({ name: 'playwright', ok: true, detail: `playwright ${manifest.version}` });
  } catch {
    checks.push({
      name: 'playwright',
      ok: false,
      detail: 'the playwright package cannot be loaded',
      fix: 'Reinstall reproflow: `npm install -g reproflow`.',
    });
  }

  const channel = browserChannel();
  if (channel) {
    checks.push({
      name: 'chromium',
      ok: true,
      detail: `driving the installed "${channel}" browser (REPROFLOW_BROWSER_CHANNEL); not checked`,
    });
  } else {
    let path = await deps.chromiumPath().catch(() => '');
    if (!path || !existsSync(path)) {
      if (options.fix && (await deps.install())) {
        fixed.push('installed Playwright Chromium');
        path = await deps.chromiumPath().catch(() => '');
      }
    }
    const present = Boolean(path) && existsSync(path);
    checks.push({
      name: 'chromium',
      ok: present,
      detail: present ? `Chromium at ${toPosix(path)}` : 'Playwright Chromium is not installed',
      ...(present
        ? {}
        : { fix: 'Run `reproflow doctor --fix` (or `npx playwright install chromium`).' }),
    });
  }

  const staleRemoved = cleanStaleStates();
  if (staleRemoved.length > 0)
    fixed.push(`removed ${staleRemoved.length} stale daemon state file(s)`);
  let daemon: Check;
  try {
    const status = await daemonStatus(root);
    daemon = {
      name: 'daemon',
      ok: true,
      detail: status
        ? `running: pid ${status.pid}, profile ${status.profile}, ${status.headed ? 'headed' : 'headless'}, ${status.pages.length} tab(s)`
        : 'not running (one starts when a command needs a browser)',
    };
  } catch (error) {
    if (options.fix) {
      await stopDaemon(root).catch(() => false);
      fixed.push('stopped an unresponsive daemon');
      daemon = {
        name: 'daemon',
        ok: true,
        detail: 'stopped an unresponsive daemon; a new one starts on demand',
      };
    } else {
      daemon = {
        name: 'daemon',
        ok: false,
        detail: `the daemon does not answer: ${errorMessage(error)}`,
        fix: 'Run `reproflow session stop`, or `reproflow doctor --fix`.',
      };
    }
  }
  checks.push(daemon);

  for (const [name, dir] of [
    ['write: project', projectPaths(root).dir],
    ['write: home', daemonsDir()],
  ] as const) {
    const problem = await canWrite(dir);
    checks.push({
      name,
      ok: problem === null,
      detail:
        problem === null
          ? `can write to ${toPosix(dir)}`
          : `cannot write to ${toPosix(dir)}: ${problem}`,
      ...(problem === null
        ? {}
        : { fix: 'Fix the folder permissions, or set REPROFLOW_HOME to a writable folder.' }),
    });
  }

  const ok = checks.every((check) => check.ok);
  return { ok, status: ok ? 'passed' : 'failed', checks, fixed };
}
