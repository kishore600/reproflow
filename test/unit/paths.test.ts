import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daemonKey, findProjectRoot, profileDir, projectPaths } from '../../src/paths.js';

let sandbox: string;
const previousHome = process.env.REPROFLOW_HOME;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'reproflow-paths-')));
  process.env.REPROFLOW_HOME = join(sandbox, 'home', '.reproflow');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.REPROFLOW_HOME;
  else process.env.REPROFLOW_HOME = previousHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('findProjectRoot', () => {
  it('finds the nearest folder with .git', () => {
    const project = join(sandbox, 'app');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(project, 'src', 'deep'), { recursive: true });
    expect(findProjectRoot(join(project, 'src', 'deep'))).toBe(project);
  });

  it('prefers the nearest marker, .reproflow or .git', () => {
    const outer = join(sandbox, 'outer');
    const inner = join(outer, 'packages', 'web');
    mkdirSync(join(outer, '.git'), { recursive: true });
    mkdirSync(join(inner, 'src'), { recursive: true });
    expect(findProjectRoot(join(inner, 'src'))).toBe(outer);
    mkdirSync(join(inner, '.reproflow'), { recursive: true });
    expect(findProjectRoot(join(inner, 'src'))).toBe(inner);
  });

  it('does not mistake the global ~/.reproflow for a project', () => {
    mkdirSync(process.env.REPROFLOW_HOME as string, { recursive: true });
    const lonely = join(sandbox, 'home', 'projects', 'scratch');
    mkdirSync(lonely, { recursive: true });
    expect(findProjectRoot(lonely)).toBe(lonely);
  });

  it('falls back to the starting folder', () => {
    const lonely = join(sandbox, 'nowhere');
    mkdirSync(lonely);
    expect(findProjectRoot(lonely)).toBe(lonely);
  });
});

describe('paths', () => {
  it('derives a stable sha1 daemon key', () => {
    expect(daemonKey(sandbox)).toMatch(/^[0-9a-f]{40}$/);
    expect(daemonKey(sandbox)).toBe(daemonKey(sandbox));
    expect(daemonKey(sandbox)).not.toBe(daemonKey(join(sandbox, 'other')));
  });

  it('rejects profile names that could escape the profiles folder', () => {
    expect(profileDir('work')).toContain(join('profiles', 'work'));
    expect(() => profileDir('../evil')).toThrow(/invalid profile name/);
    expect(() => profileDir('a/b')).toThrow(/invalid profile name/);
  });

  it('lays out project files under .reproflow', () => {
    const paths = projectPaths(sandbox);
    expect(paths.flows).toBe(join(sandbox, '.reproflow', 'flows'));
    expect(paths.session).toBe(join(sandbox, '.reproflow', 'session.jsonl'));
  });
});
