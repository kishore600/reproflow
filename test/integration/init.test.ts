import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_NOTE, SKILL_MD } from '../../src/integrations/skill.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.stop());

const read = (file: string): string => readFileSync(join(h.project, file), 'utf8');

describe('reproflow init', () => {
  it('sets the project up and prints what it did', async () => {
    writeFileSync(join(h.project, 'AGENTS.md'), '# House rules\n\nPrefer small PRs.\n');
    const result = await h.cli(['init']);
    expect(result.code).toBe(0);
    const digest = result.json<{ status: string; created: string[]; updated: string[] }>();
    expect(digest.status).toBe('initialized');
    expect(digest.created).toEqual(
      expect.arrayContaining([
        '.reproflow/flows/example.yaml',
        '.agents/skills/reproflow/SKILL.md',
        '.claude/skills/reproflow/SKILL.md',
        'CLAUDE.md',
        '.gitignore',
      ]),
    );
    expect(digest.updated).toEqual(['AGENTS.md']);

    expect(read('.claude/skills/reproflow/SKILL.md')).toBe(SKILL_MD);
    expect(read('.agents/skills/reproflow/SKILL.md')).toBe(SKILL_MD);
    expect(read('AGENTS.md')).toContain('Prefer small PRs.');
    expect(read('AGENTS.md')).toContain(AGENT_NOTE);
    expect(read('CLAUDE.md')).toContain(AGENT_NOTE);
    for (const entry of ['.reproflow/runs/', '.reproflow/session.jsonl']) {
      expect(read('.gitignore')).toContain(entry);
    }
  });

  it('is idempotent', async () => {
    const before = ['AGENTS.md', 'CLAUDE.md', '.gitignore'].map(read);
    const second = await h.cli(['init']);
    expect(second.json<{ created: string[]; updated: string[] }>()).toMatchObject({
      created: [],
      updated: [],
    });
    expect(['AGENTS.md', 'CLAUDE.md', '.gitignore'].map(read)).toEqual(before);
    expect(read('AGENTS.md').match(/reproflow:start/g)).toHaveLength(1);
  });

  it('leaves a flow that `reproflow list` can read', async () => {
    const list = (await h.cli(['list'])).json<{ flows: { name: string; params?: string[] }[] }>();
    expect(list.flows).toEqual([
      expect.objectContaining({ name: 'example', params: ['path:string'] }),
    ]);
    expect(existsSync(join(h.project, '.reproflow', 'flows', 'example.yaml'))).toBe(true);
  });
});
