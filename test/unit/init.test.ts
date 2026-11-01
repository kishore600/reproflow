import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { performInit } from '../../src/integrations/init.js';
import {
  AGENT_NOTE,
  GITIGNORE_ENTRIES,
  mergeGitignore,
  NOTE_END,
  NOTE_START,
  SKILL_MD,
  upsertNote,
} from '../../src/integrations/skill.js';

describe('SKILL.md', () => {
  it('is exactly the text the brief specifies', () => {
    expect(SKILL_MD).toBe(`---
name: reproflow
description: Run saved browser flows and capture debug evidence for this project's web app. Use before writing any Playwright, Selenium or pyautogui script.
---
1. Run \`reproflow list\` and pick a flow that matches the task.
2. Run it: \`reproflow run <name> --<param>=<value>\`. Read the JSON digest.
3. Open screenshot or snapshot files only if the digest is not enough.
4. No matching flow? Reproduce with \`reproflow do <action>\` steps, then \`reproflow save <name> --from-session\`.
5. After fixing code, rerun the same flow to verify the fix.
6. If you get auth_expired, ask the user to run \`reproflow login <url>\`.
`);
  });
});

describe('upsertNote', () => {
  const block = `${NOTE_START}\n${AGENT_NOTE}\n${NOTE_END}`;

  it('creates the block for a missing or empty file', () => {
    expect(upsertNote(null)).toBe(`${block}\n`);
    expect(upsertNote('  \n')).toBe(`${block}\n`);
  });

  it('appends after existing content without touching it', () => {
    const out = upsertNote('# Project\n\nBe nice.\n');
    expect(out).toBe(`# Project\n\nBe nice.\n\n${block}\n`);
  });

  it('is idempotent: a second pass changes nothing and never duplicates the note', () => {
    const once = upsertNote('# Project\n');
    expect(upsertNote(once)).toBe(once);
    expect(once.split(AGENT_NOTE)).toHaveLength(2);
  });

  it('replaces an outdated block in place, keeping text on both sides', () => {
    const stale = `before\n${NOTE_START}\nold note\n${NOTE_END}\nafter\n`;
    expect(upsertNote(stale)).toBe(`before\n${block}\nafter\n`);
  });

  it('keeps CRLF files CRLF', () => {
    const out = upsertNote('# Project\r\n');
    expect(out).toBe(`# Project\r\n\r\n${NOTE_START}\r\n${AGENT_NOTE}\r\n${NOTE_END}\r\n`);
  });
});

describe('mergeGitignore', () => {
  it('creates a new file with the reproflow entries', () => {
    expect(mergeGitignore(null)).toBe(`# reproflow\n${GITIGNORE_ENTRIES.join('\n')}\n`);
  });

  it('keeps existing lines and adds only what is missing', () => {
    const out = mergeGitignore('node_modules/\n.reproflow/runs/\n');
    expect(out.startsWith('node_modules/\n.reproflow/runs/\n')).toBe(true);
    expect(out).toContain('.reproflow/session.jsonl');
    expect(out).toContain('.reproflow/stats.jsonl');
    expect(out.match(/\.reproflow\/runs\//g)).toHaveLength(1);
  });

  it('treats a leading slash as the same entry, and leaves a complete file alone', () => {
    const complete = '/.reproflow/runs/\n.reproflow/session.jsonl\n.reproflow/stats.jsonl\n';
    expect(mergeGitignore(complete)).toBe(complete);
  });
});

describe('performInit', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'reproflow-init-')));
    mkdirSync(join(root, '.git'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

  it('creates everything on a clean project', async () => {
    const report = await performInit(root);
    expect(report.created.sort()).toEqual(
      [
        '.agents/skills/reproflow/SKILL.md',
        '.claude/skills/reproflow/SKILL.md',
        '.gitignore',
        '.reproflow/flows/example.yaml',
        'AGENTS.md',
        'CLAUDE.md',
      ].sort(),
    );
    expect(report.updated).toEqual([]);
    expect(read('.claude', 'skills', 'reproflow', 'SKILL.md')).toBe(SKILL_MD);
    expect(read('.agents', 'skills', 'reproflow', 'SKILL.md')).toBe(SKILL_MD);
    expect(read('AGENTS.md')).toContain(AGENT_NOTE);
    expect(read('CLAUDE.md')).toContain(AGENT_NOTE);
    expect(read('.gitignore')).toContain('.reproflow/runs/');
    expect(read('.reproflow', 'flows', 'example.yaml')).toContain('name: example');
  });

  it('is idempotent and never duplicates the note', async () => {
    await performInit(root);
    const before = ['AGENTS.md', 'CLAUDE.md', '.gitignore'].map((file) => read(file));
    const second = await performInit(root);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toHaveLength(6);
    expect(['AGENTS.md', 'CLAUDE.md', '.gitignore'].map((file) => read(file))).toEqual(before);
    expect(read('AGENTS.md').split(NOTE_START)).toHaveLength(2);
  });

  it('keeps what is already in AGENTS.md, CLAUDE.md, .gitignore and an edited example flow', async () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n\nUse tabs.\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# Claude\n');
    writeFileSync(join(root, '.gitignore'), 'dist/\nnode_modules/\n');
    mkdirSync(join(root, '.reproflow', 'flows'), { recursive: true });
    writeFileSync(join(root, '.reproflow', 'flows', 'example.yaml'), 'name: mine\n');

    const report = await performInit(root);
    expect(report.updated.sort()).toEqual(['.gitignore', 'AGENTS.md', 'CLAUDE.md']);
    expect(report.unchanged).toContain('.reproflow/flows/example.yaml');
    expect(read('AGENTS.md').startsWith('# Agents\n\nUse tabs.\n')).toBe(true);
    expect(read('AGENTS.md')).toContain(AGENT_NOTE);
    expect(read('.gitignore').startsWith('dist/\nnode_modules/\n')).toBe(true);
    expect(read('.reproflow', 'flows', 'example.yaml')).toBe('name: mine\n');
    expect(existsSync(join(root, '.reproflow', 'runs'))).toBe(false);
  });
});
