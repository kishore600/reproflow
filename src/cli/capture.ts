import type { Command } from 'commander';
import type { CaptureParams } from '../daemon/protocol.js';
import { captureCommand } from '../engine/commands.js';
import { LocatorSyntaxError, parseLocator } from '../engine/locators.js';
import { exitCodeForDigest, formatDigestText } from '../evidence/digest.js';
import { findProjectRoot } from '../paths.js';
import { fail, printResult, runCommand } from './output.js';

export function registerCapture(program: Command): void {
  program
    .command('capture')
    .description('write an evidence bundle for the current page and print the digest')
    .option('--full-page', 'capture the full page, not just the viewport')
    .option('--locator <locator>', 'also crop element.png to this element')
    .addHelpText(
      'after',
      `
Writes .reproflow/runs/<timestamp>-capture/ with screenshot.png, snapshot.aria.yml, console.jsonl,
page-errors.jsonl, network.jsonl and run.json (plus element.png with --locator).

Example:
  reproflow capture --locator 'role=status[name="Total"]'`,
    )
    .action((opts: { fullPage?: boolean; locator?: string }, command: Command) =>
      runCommand(command, async () => {
        const params: CaptureParams = { fullPage: opts.fullPage };
        if (opts.locator) {
          try {
            params.locator = parseLocator(opts.locator);
          } catch (error) {
            if (error instanceof LocatorSyntaxError) return fail(error.message);
            throw error;
          }
        }
        const digest = await captureCommand(findProjectRoot(), params);
        printResult(command, digest, () => formatDigestText(digest));
        return exitCodeForDigest(digest);
      }),
    );
}
