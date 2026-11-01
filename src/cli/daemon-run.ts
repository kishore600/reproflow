import type { Command } from 'commander';
import { runDaemon } from '../daemon/server.js';
import { fail } from './output.js';

/** Hidden entry point the CLI spawns, detached, to host the browser daemon. */
export function registerDaemonRun(program: Command): void {
  program
    .command('daemon-run', { hidden: true })
    .requiredOption('--project <root>')
    .option('--profile <name>', 'browser profile', 'default')
    .option('--headed')
    .action(async (opts: { project: string; profile: string; headed?: boolean }) => {
      try {
        await runDaemon({
          project: opts.project,
          profile: opts.profile,
          headed: Boolean(opts.headed),
        });
      } catch (error) {
        process.exitCode = fail(error instanceof Error ? error.message : String(error));
      }
    });
}
