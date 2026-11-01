import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Check, type DoctorDeps, runDoctor } from '../../src/integrations/doctor.js';

let sandbox: string;
let project: string;
const saved = { home: process.env.REPROFLOW_HOME, channel: process.env.REPROFLOW_BROWSER_CHANNEL };

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'reproflow-doctor-')));
  project = join(sandbox, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  process.env.REPROFLOW_HOME = join(sandbox, 'home');
  delete process.env.REPROFLOW_BROWSER_CHANNEL;
});

afterEach(() => {
  for (const [key, value] of [
    ['REPROFLOW_HOME', saved.home],
    ['REPROFLOW_BROWSER_CHANNEL', saved.channel],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

const find = (checks: Check[], name: string) => checks.find((check) => check.name === name);

describe('runDoctor', () => {
  it('passes when Chromium is present, and needs no daemon', async () => {
    const chromium = join(sandbox, 'chrome');
    writeFileSync(chromium, '');
    const report = await runDoctor(
      project,
      { fix: false },
      { chromiumPath: async () => chromium, install: async () => false },
    );
    expect(report.ok).toBe(true);
    expect(report.status).toBe('passed');
    expect(report.checks.map((check) => check.name)).toEqual([
      'node',
      'playwright',
      'chromium',
      'daemon',
      'write: project',
      'write: home',
    ]);
    expect(find(report.checks, 'daemon')?.detail).toContain('not running');
    expect(existsSync(join(project, '.reproflow'))).toBe(true);
  });

  it('fails with a fix hint when Chromium is missing, and does not install without --fix', async () => {
    let installs = 0;
    const deps: DoctorDeps = {
      chromiumPath: async () => join(sandbox, 'missing-chrome'),
      install: async () => {
        installs++;
        return true;
      },
    };
    const report = await runDoctor(project, { fix: false }, deps);
    expect(report.ok).toBe(false);
    expect(find(report.checks, 'chromium')).toMatchObject({ ok: false });
    expect(find(report.checks, 'chromium')?.fix).toContain('reproflow doctor --fix');
    expect(installs).toBe(0);
  });

  it('installs Chromium with --fix and re-checks', async () => {
    const chromium = join(sandbox, 'chrome');
    let installs = 0;
    const deps: DoctorDeps = {
      chromiumPath: async () => chromium,
      install: async () => {
        installs++;
        writeFileSync(chromium, '');
        return true;
      },
    };
    const report = await runDoctor(project, { fix: true }, deps);
    expect(installs).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.fixed).toContain('installed Playwright Chromium');
  });

  it('stays failed when the installer fails', async () => {
    const report = await runDoctor(
      project,
      { fix: true },
      {
        chromiumPath: async () => join(sandbox, 'missing-chrome'),
        install: async () => false,
      },
    );
    expect(report.ok).toBe(false);
    expect(report.fixed).toEqual([]);
  });

  it('does not check Chromium when an installed browser channel is configured', async () => {
    process.env.REPROFLOW_BROWSER_CHANNEL = 'chrome';
    const report = await runDoctor(
      project,
      { fix: false },
      {
        chromiumPath: async () => join(sandbox, 'missing-chrome'),
        install: async () => false,
      },
    );
    expect(find(report.checks, 'chromium')).toMatchObject({ ok: true });
    expect(find(report.checks, 'chromium')?.detail).toContain('chrome');
  });

  it('reports an unwritable home folder', async () => {
    writeFileSync(join(sandbox, 'blocker'), 'a file where a folder should be');
    process.env.REPROFLOW_HOME = join(sandbox, 'blocker');
    const chromium = join(sandbox, 'chrome');
    writeFileSync(chromium, '');
    const report = await runDoctor(
      project,
      { fix: false },
      { chromiumPath: async () => chromium, install: async () => false },
    );
    expect(find(report.checks, 'write: home')).toMatchObject({ ok: false });
    expect(find(report.checks, 'write: home')?.fix).toContain('REPROFLOW_HOME');
    expect(report.ok).toBe(false);
  });

  it('cleans up state files of dead daemons and says so', async () => {
    const daemons = join(sandbox, 'home', 'daemons');
    mkdirSync(daemons, { recursive: true });
    writeFileSync(
      join(daemons, 'deadbeef.json'),
      JSON.stringify({
        pid: 2_000_000_000,
        port: 1,
        token: 'x',
        profile: 'default',
        startedAt: '',
        headed: false,
        project: '/gone',
      }),
    );
    const chromium = join(sandbox, 'chrome');
    writeFileSync(chromium, '');
    const report = await runDoctor(
      project,
      { fix: false },
      { chromiumPath: async () => chromium, install: async () => false },
    );
    expect(report.fixed).toContain('removed 1 stale daemon state file(s)');
    expect(existsSync(join(daemons, 'deadbeef.json'))).toBe(false);
  });
});
