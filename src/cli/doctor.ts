import type { Command } from 'commander';
import { runDoctor } from '../integrations/doctor.js';
import { findProjectRoot } from '../paths.js';
import { printResult, runCommand } from './output.js';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('check Node, Playwright Chromium, daemon health and write permissions')
    .option('--fix', 'install Playwright Chromium when it is missing, and restart a stuck daemon')
    .addHelpText(
      'after',
      `
Exit code 0 when every check passes, 1 when one fails.

Examples:
  reproflow doctor
  reproflow doctor --fix`,
    )
    .action((opts: { fix?: boolean }, command: Command) =>
      runCommand(command, async () => {
        const report = await runDoctor(findProjectRoot(), { fix: Boolean(opts.fix) });
        printResult(command, report, () =>
          [
            ...report.checks.map((check) =>
              [
                `${check.ok ? '✔' : '✖'} ${check.name}: ${check.detail}`,
                check.fix ? `    fix: ${check.fix}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            ),
            ...report.fixed.map((change) => `fixed: ${change}`),
            report.ok ? 'all checks passed' : 'some checks failed',
          ].join('\n'),
        );
        return report.ok ? 0 : 1;
      }),
    );
}
