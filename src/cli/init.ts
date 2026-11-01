import type { Command } from 'commander';
import { performInit } from '../integrations/init.js';
import { findProjectRoot } from '../paths.js';
import { printResult, runCommand } from './output.js';

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('set up the current project for AI agents (safe to run again)')
    .addHelpText(
      'after',
      `
Creates .reproflow/flows/ with an example flow, adds run state to .gitignore, writes the reproflow
skill to .agents/skills/ and .claude/skills/, and adds a one-line note to AGENTS.md and CLAUDE.md
(between <!-- reproflow:start --> and <!-- reproflow:end -->). Existing content is kept.`,
    )
    .action((_opts: unknown, command: Command) =>
      runCommand(command, async () => {
        const root = findProjectRoot();
        const report = await performInit(root);
        const digest = {
          ok: true,
          status: 'initialized',
          root: root.replaceAll('\\', '/'),
          ...report,
          next: 'Run `reproflow list`. Record your own flow with `reproflow do ...` then `reproflow save <name> --from-session`.',
        };
        printResult(command, digest, () =>
          [
            `initialized ${digest.root}`,
            ...report.created.map((file) => `  created   ${file}`),
            ...report.updated.map((file) => `  updated   ${file}`),
            ...report.unchanged.map((file) => `  unchanged ${file}`),
            `next: ${digest.next}`,
          ].join('\n'),
        );
        return 0;
      }),
    );
}
