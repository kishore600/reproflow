import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../..', import.meta.url));

interface Packed {
  name: string;
  version: string;
  files: { path: string }[];
}

describe('npm pack --dry-run', () => {
  const output = execSync('npm pack --dry-run --json', {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [packed] = JSON.parse(output) as Packed[];
  const files = packed.files.map((file) => file.path.replaceAll('\\', '/'));

  it('contains everything a user needs', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'package.json',
        'README.md',
        'LICENSE',
        'dist/cli/index.js',
        'schema/flow.schema.json',
        'examples/flows/example.yaml',
        'examples/flows/repro-cart-total.yaml',
        '.claude-plugin/marketplace.json',
        'plugin/.claude-plugin/plugin.json',
        'plugin/hooks/hooks.json',
        'plugin/scripts/warn-browser-scripts.mjs',
        'plugin/skills/reproflow/SKILL.md',
      ]),
    );
  });

  it('leaves out sources, tests and project state', () => {
    for (const path of files) {
      expect(path).not.toMatch(/^(src|test|scripts|node_modules|\.reproflow|\.github)\//);
      expect(path).not.toMatch(/(^|\/)(PLAN|DECISIONS|REPORT)\.md$/);
    }
  });

  it('is the reproflow package with a runnable bin', () => {
    expect(packed.name).toBe('reproflow');
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
      engines: { node: string };
    };
    expect(manifest.bin).toEqual({ reproflow: 'dist/cli/index.js' });
    expect(manifest.engines.node).toBe('>=22');
    expect(
      readFileSync(join(repo, 'dist', 'cli', 'index.js'), 'utf8').startsWith('#!/usr/bin/env node'),
    ).toBe(true);
  });

  it('has a small footprint (no source maps or stray folders)', () => {
    expect(files.some((path) => path.endsWith('.map'))).toBe(false);
    expect(files.length).toBeLessThan(40);
  });
});
