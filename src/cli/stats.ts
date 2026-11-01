import type { Command } from 'commander';
import { findProjectRoot } from '../paths.js';
import { readStats, summarizeStats, tokensPerStep } from '../stats/stats.js';
import { fail, printResult, runCommand } from './output.js';

export function registerStats(program: Command): void {
  program
    .command('stats')
    .description(
      'run totals, pass rate, median duration, top failing flows, tokens avoided (estimate)',
    )
    .option('--since <days>', 'only count runs from the last n days')
    .option('--tokens-per-step <n>', 'tokens an agent would spend per browser step (default 3800)')
    .addHelpText(
      'after',
      `
Reads .reproflow/stats.jsonl. The tokens figure is an estimate, not a measurement:
sum over runs of (steps x tokens-per-step - digest characters / 4). Set the per-step cost with
--tokens-per-step, REPROFLOW_TOKENS_PER_STEP, or "tokens_per_step" in .reproflow/config.json.`,
    )
    .action((opts: { since?: string; tokensPerStep?: string }, command: Command) =>
      runCommand(command, async () => {
        const sinceDays = opts.since === undefined ? undefined : Number(opts.since);
        if (sinceDays !== undefined && !(sinceDays >= 0))
          return fail('--since must be a number of days');
        const root = findProjectRoot();
        const perStep = await tokensPerStep(root, opts.tokensPerStep);
        const summary = summarizeStats(await readStats(root), {
          tokensPerStep: perStep,
          sinceDays,
        });
        printResult(command, { ok: true, ...summary }, () =>
          [
            `${summary.runs} runs: ${summary.passed} passed, ${summary.failed} failed, ${summary.errors} errors (${Math.round(summary.pass_rate * 100)}% pass)`,
            `median duration ${(summary.median_duration_ms / 1000).toFixed(1)}s`,
            ...summary.top_failing_flows.map(
              (row) => `  failing: ${row.flow}  ${row.failures}/${row.runs} runs`,
            ),
            `~${summary.tokens_avoided_estimate.toLocaleString('en-US')} tokens avoided (${summary.estimate_note})`,
          ].join('\n'),
        );
        return 0;
      }),
    );
}
