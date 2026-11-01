import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRunDir,
  KEEP_RUNS,
  pruneRuns,
  runTimestamp,
  slugify,
} from '../../src/evidence/bundle.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'reproflow-bundle-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('run folders', () => {
  it('formats local timestamps as YYYYMMDD-HHmmss', () => {
    expect(runTimestamp(new Date(2026, 10, 1, 9, 5, 7))).toBe('20261101-090507');
  });

  it('slugifies names for folder use', () => {
    expect(slugify('repro cart/total!')).toBe('repro-cart-total');
    expect(slugify('///')).toBe('run');
  });

  it('creates .reproflow/runs/<timestamp>-<name> and never reuses a folder', async () => {
    const first = await createRunDir(root, 'capture');
    const second = await createRunDir(root, 'capture');
    expect(first).toMatch(/[\\/]\.reproflow[\\/]runs[\\/]\d{8}-\d{6}-capture$/);
    expect(second).not.toBe(first);
    expect(existsSync(first) && existsSync(second)).toBe(true);
  });

  it('keeps only the newest 50 run folders and leaves other entries alone', async () => {
    const runs = join(root, '.reproflow', 'runs');
    mkdirSync(runs, { recursive: true });
    for (let i = 0; i < 55; i++) {
      mkdirSync(join(runs, `20200101-0000${String(i).padStart(2, '0')}-flow`));
    }
    mkdirSync(join(runs, 'notes'));
    const doomed = await pruneRuns(runs);
    expect(doomed).toHaveLength(5);
    expect(doomed[0]).toBe('20200101-000000-flow');
    const left = readdirSync(runs);
    expect(left.filter((name) => /^\d{8}-/.test(name))).toHaveLength(KEEP_RUNS);
    expect(left).toContain('notes');
    expect(left).toContain('20200101-000054-flow');
    expect(left).not.toContain('20200101-000004-flow');
  });

  it('prunes automatically when a run folder is created', async () => {
    const runs = join(root, '.reproflow', 'runs');
    mkdirSync(runs, { recursive: true });
    for (let i = 0; i < 52; i++)
      mkdirSync(join(runs, `20200101-0000${String(i).padStart(2, '0')}-old`));
    await createRunDir(root, 'new');
    expect(readdirSync(runs)).toHaveLength(KEEP_RUNS);
  });
});
