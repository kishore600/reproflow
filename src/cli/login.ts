import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { runLogin } from '../daemon/login.js';
import { absoluteUrl } from '../engine/steps.js';
import { fail, printResult, runCommand } from './output.js';

/** Resolves on Enter, or when stdin closes (so piped runs never hang). */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin });
    lines.once('line', () => {
      lines.close();
      resolve();
    });
    lines.once('close', resolve);
  });
}

export function registerLogin(program: Command): void {
  program
    .command('login')
    .description('open a headed browser so you can sign in; the profile keeps the login')
    .argument('<url>', 'page to open, e.g. http://localhost:3000/login')
    .option('--profile <name>', 'browser profile (default: "default")')
    .addHelpText('after', '\nPress Enter in this terminal when you have signed in.')
    .action((rawUrl: string, opts: { profile?: string }, command: Command) =>
      runCommand(command, async () => {
        const url = absoluteUrl(rawUrl);
        if (!url) return fail(`login needs a full URL, got "${rawUrl}"`);
        const profile = opts.profile ?? 'default';
        await runLogin({
          url,
          profile,
          waitForEnter,
          log: (message) => process.stderr.write(`${message}\n`),
        });
        printResult(
          command,
          { ok: true, status: 'saved', profile, url },
          () => `saved login in profile "${profile}"`,
        );
        return 0;
      }),
    );
}
