import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { runCli } from '../helpers/cli.js';

const cwd = process.cwd();

describe('cli skeleton', () => {
  it('prints the version', async () => {
    const result = await runCli(['--version'], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('lists every command in --help', async () => {
    const result = await runCli(['--help'], { cwd });
    expect(result.code).toBe(0);
    for (const name of [
      'init',
      'doctor',
      'session',
      'login',
      'do',
      'capture',
      'list',
      'describe',
      'run',
      'save',
      'stats',
      'mcp',
    ]) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${name}\\b`, 'm'));
    }
    expect(result.stdout).not.toContain('daemon-run');
  });

  it('exits 2 on unknown commands', async () => {
    const result = await runCli(['nope'], { cwd });
    expect(result.code).toBe(2);
  });
});
