import type { Command } from 'commander';
import { daemonStatus, ensureDaemon, stopDaemon } from '../daemon/client.js';
import type { DaemonStatus } from '../daemon/protocol.js';
import { findProjectRoot } from '../paths.js';
import { printResult, runCommand } from './output.js';

function digestOf(status: DaemonStatus): Record<string, unknown> {
  return {
    ok: true,
    status: 'running',
    pid: status.pid,
    profile: status.profile,
    headed: status.headed,
    started_at: status.startedAt,
    tabs: status.pages.map((page) => ({ index: page.index, url: page.url, active: page.active })),
  };
}

const describeRunning = (status: DaemonStatus): string =>
  `running: pid ${status.pid}, profile ${status.profile}, ${status.headed ? 'headed' : 'headless'}, ${status.pages.length} tab(s)`;

export function registerSession(program: Command): void {
  const session = program.command('session').description('manage the background browser daemon');

  session
    .command('start')
    .description(
      'start the daemon and its persistent Chromium (or switch it to --headed / --profile)',
    )
    .option('--headed', 'show the browser window')
    .option('--profile <name>', 'browser profile (default: "default")')
    .action((opts: { headed?: boolean; profile?: string }, command: Command) =>
      runCommand(command, async () => {
        const handle = await ensureDaemon(findProjectRoot(), opts);
        const status = await handle.call<DaemonStatus>('status');
        printResult(command, digestOf(status), () => describeRunning(status));
        return 0;
      }),
    );

  session
    .command('stop')
    .description('stop the daemon now')
    .action((_opts: unknown, command: Command) =>
      runCommand(command, async () => {
        const wasRunning = await stopDaemon(findProjectRoot());
        printResult(command, { ok: true, status: 'stopped', was_running: wasRunning }, () =>
          wasRunning ? 'stopped' : 'no session was running',
        );
        return 0;
      }),
    );

  session
    .command('status')
    .description('show whether the daemon is running')
    .action((_opts: unknown, command: Command) =>
      runCommand(command, async () => {
        const status = await daemonStatus(findProjectRoot());
        if (!status) {
          printResult(command, { ok: true, status: 'stopped' }, () => 'stopped');
        } else {
          printResult(command, digestOf(status), () => describeRunning(status));
        }
        return 0;
      }),
    );
}
