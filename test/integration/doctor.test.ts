import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/integrations/doctor.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.stop());

describe('reproflow doctor', () => {
  it('passes on a healthy machine and lists every check', async () => {
    const result = await h.cli(['doctor']);
    const report = result.json<DoctorReport>();
    expect(result.code).toBe(0);
    expect(report).toMatchObject({ ok: true, status: 'passed' });
    expect(report.checks.map((check) => check.name)).toEqual([
      'node',
      'playwright',
      'chromium',
      'daemon',
      'write: project',
      'write: home',
    ]);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it('sees a running daemon', async () => {
    await h.cli(['session', 'start']);
    const report = (await h.cli(['doctor'])).json<DoctorReport>();
    const daemon = report.checks.find((check) => check.name === 'daemon');
    expect(daemon?.detail).toMatch(/^running: pid \d+, profile default, headless/);
  });

  it('exits 1 and says how to fix a missing Chromium', async () => {
    const result = await h.cli(['doctor'], {
      env: { PLAYWRIGHT_BROWSERS_PATH: `${h.home}/no-browsers`, REPROFLOW_BROWSER_CHANNEL: '' },
    });
    const report = result.json<DoctorReport>();
    expect(result.code).toBe(1);
    expect(report.status).toBe('failed');
    const chromium = report.checks.find((check) => check.name === 'chromium');
    expect(chromium).toMatchObject({ ok: false, detail: 'Playwright Chromium is not installed' });
    expect(chromium?.fix).toContain('doctor --fix');
  });
});
