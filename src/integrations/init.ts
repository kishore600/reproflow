import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { packageRoot, projectPaths, toPosix } from '../paths.js';
import { mergeGitignore, SKILL_MD, upsertNote } from './skill.js';

export interface InitReport {
  /** Paths relative to the project root, with forward slashes. */
  created: string[];
  updated: string[];
  unchanged: string[];
}

/** Writes `content` unless the file already has exactly that content. */
async function writeManaged(
  root: string,
  file: string,
  content: string,
  report: InitReport,
): Promise<void> {
  const shown = toPosix(relative(root, file));
  const existing = await readFile(file, 'utf8').catch(() => null);
  if (existing === content) {
    report.unchanged.push(shown);
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  (existing === null ? report.created : report.updated).push(shown);
}

/**
 * Sets a project up for agents. Idempotent: running it twice changes nothing the second time.
 * Creates .reproflow/flows/ with an example, adds run state to .gitignore, writes the reproflow
 * skill for Claude Code and other agents, and adds the one-line note to AGENTS.md and CLAUDE.md.
 */
export async function performInit(root: string): Promise<InitReport> {
  const report: InitReport = { created: [], updated: [], unchanged: [] };
  const { flows } = projectPaths(root);
  await mkdir(flows, { recursive: true });

  // The example is only ever created, so edits to it survive a second `init`.
  const example = join(flows, 'example.yaml');
  const shown = toPosix(relative(root, example));
  if (existsSync(example)) {
    report.unchanged.push(shown);
  } else {
    await copyFile(join(packageRoot(), 'examples', 'flows', 'example.yaml'), example);
    report.created.push(shown);
  }

  const gitignore = join(root, '.gitignore');
  await writeManaged(
    root,
    gitignore,
    mergeGitignore(await readFile(gitignore, 'utf8').catch(() => null)),
    report,
  );

  await writeManaged(
    root,
    join(root, '.agents', 'skills', 'reproflow', 'SKILL.md'),
    SKILL_MD,
    report,
  );
  await writeManaged(
    root,
    join(root, '.claude', 'skills', 'reproflow', 'SKILL.md'),
    SKILL_MD,
    report,
  );

  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = join(root, name);
    await writeManaged(
      root,
      file,
      upsertNote(await readFile(file, 'utf8').catch(() => null)),
      report,
    );
  }
  return report;
}
