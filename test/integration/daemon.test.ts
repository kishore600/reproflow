import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPidAlive } from '../../src/daemon/state.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.stop());

function rpc(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers, agent: false },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  });
}

describe('daemon lifecycle', () => {
  it('reports stopped before anything starts', async () => {
    const result = await h.cli(['session', 'status']);
    expect(result.code).toBe(0);
    expect(result.json()).toEqual({ ok: true, status: 'stopped' });
  });

  it('starts automatically on the first command that needs a browser', async () => {
    const { digest, code } = await h.act('goto', `${h.shop.url}/help`);
    expect(code).toBe(0);
    expect(digest).toMatchObject({ ok: true, action: 'goto', title: 'Help - Shop' });
    expect(existsSync(h.stateFile)).toBe(true);
  });

  it('writes a state file with pid, port, a 32-byte token, profile and start time', () => {
    const state = JSON.parse(readFileSync(h.stateFile, 'utf8'));
    expect(state).toMatchObject({ profile: 'default', headed: false });
    expect(Number.isInteger(state.pid)).toBe(true);
    expect(state.port).toBeGreaterThan(0);
    expect(state.token).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(state.startedAt))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(h.stateFile).mode & 0o777).toBe(0o600);
    }
  });

  it('shows the running session and its tabs', async () => {
    const result = await h.cli(['session', 'status']);
    expect(result.json()).toMatchObject({
      ok: true,
      status: 'running',
      profile: 'default',
      headed: false,
      tabs: [{ index: 0, active: true }],
    });
  });

  it('never prints the token', async () => {
    const { token } = JSON.parse(readFileSync(h.stateFile, 'utf8'));
    const result = await h.cli(['session', 'status']);
    expect(result.stdout).not.toContain(token);
  });

  it('rejects requests without the right bearer token', async () => {
    const state = JSON.parse(readFileSync(h.stateFile, 'utf8'));
    expect(await rpc(state.port, {})).toBe(401);
    expect(await rpc(state.port, { authorization: 'Bearer nope' })).toBe(401);
    expect(await rpc(state.port, { authorization: `Bearer ${state.token}` })).toBe(200);
  });

  it('keeps the same daemon across commands', async () => {
    const before = JSON.parse(readFileSync(h.stateFile, 'utf8')).pid;
    await h.act('goto', `${h.shop.url}/login`);
    expect(JSON.parse(readFileSync(h.stateFile, 'utf8')).pid).toBe(before);
  });

  it('stops cleanly and removes its state file', async () => {
    const { pid } = JSON.parse(readFileSync(h.stateFile, 'utf8'));
    const result = await h.cli(['session', 'stop']);
    expect(result.json()).toEqual({ ok: true, status: 'stopped', was_running: true });
    expect(existsSync(h.stateFile)).toBe(false);
    expect(isPidAlive(pid)).toBe(false);
    expect((await h.cli(['session', 'stop'])).json()).toMatchObject({ was_running: false });
  });

  it('cleans up a state file whose pid is dead and starts fresh', async () => {
    writeFileSync(
      h.stateFile,
      JSON.stringify({
        pid: 2_000_000_000,
        port: 1,
        token: 'x'.repeat(64),
        profile: 'default',
        startedAt: new Date().toISOString(),
        headed: false,
        project: h.project,
      }),
    );
    expect((await h.cli(['session', 'status'])).json()).toEqual({ ok: true, status: 'stopped' });
    expect(existsSync(h.stateFile)).toBe(false);

    const started = await h.cli(['session', 'start']);
    expect(started.code).toBe(0);
    expect(started.json()).toMatchObject({ status: 'running', profile: 'default' });
  });

  it('restarts when a different profile is requested', async () => {
    const first = JSON.parse(readFileSync(h.stateFile, 'utf8')).pid;
    const result = await h.cli(['session', 'start', '--profile', 'other']);
    expect(result.json()).toMatchObject({ status: 'running', profile: 'other' });
    expect(JSON.parse(readFileSync(h.stateFile, 'utf8')).pid).not.toBe(first);
    expect(isPidAlive(first)).toBe(false);
  });

  it('stops itself after the idle timeout', async () => {
    await h.cli(['session', 'stop']);
    const result = await h.cli(['session', 'start'], { env: { REPROFLOW_IDLE_MS: '1500' } });
    const { pid } = result.json<{ pid: number }>();
    const deadline = Date.now() + 15_000;
    while (isPidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(isPidAlive(pid)).toBe(false);
    expect(existsSync(h.stateFile)).toBe(false);
  });
});
