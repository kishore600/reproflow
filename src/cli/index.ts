import { Command, CommanderError } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { registerCapture } from './capture.js';
import { registerDaemonRun } from './daemon-run.js';
import { registerDescribe } from './describe.js';
import { registerDo } from './do.js';
import { registerDoctor } from './doctor.js';
import { registerInit } from './init.js';
import { registerList } from './list.js';
import { registerLogin } from './login.js';
import { registerMcp } from './mcp.js';
import { registerRun } from './run.js';
import { registerSave } from './save.js';
import { registerSchema } from './schema.js';
import { registerSession } from './session.js';
import { registerStats } from './stats.js';

export function buildProgram(): Command {
  const program = new Command('reproflow')
    .description(
      'Saved, replayable browser flows and one-call debug evidence for AI coding agents.',
    )
    .version(pkg.version, '-v, --version', 'print the version')
    .option('--json', 'print JSON even when stdout is a TTY')
    .showHelpAfterError('(run with --help for usage)')
    .addHelpText(
      'after',
      `
Every command prints a compact JSON digest when stdout is not a TTY (or with --json).
Exit codes: 0 success or passed, 1 a check failed, 2 usage, setup or browser error.

Start with: reproflow init, then reproflow list.`,
    );

  registerInit(program);
  registerDoctor(program);
  registerSession(program);
  registerLogin(program);
  registerDo(program);
  registerCapture(program);
  registerList(program);
  registerDescribe(program);
  registerRun(program);
  registerSave(program);
  registerStats(program);
  registerMcp(program);
  registerSchema(program);
  registerDaemonRun(program);
  return program;
}

async function main(): Promise<void> {
  const program = buildProgram().exitOverride();
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      const informational =
        error.code === 'commander.helpDisplayed' || error.code === 'commander.version';
      process.exitCode = informational ? 0 : 2;
      return;
    }
    throw error;
  }
}

await main();
