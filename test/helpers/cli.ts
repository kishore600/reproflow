import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI_ENTRY = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON (throws if it is not JSON). */
  json<T = Record<string, unknown>>(): T;
}

/** Runs the bundled CLI the way an agent would: a fresh process per command, stdout piped. */
export function runCli(
  args: string[],
  options: { cwd: string; env?: Record<string, string>; input?: string },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        json: <T>() => JSON.parse(stdout) as T,
      });
    });
    child.stdin.end(options.input ?? '');
  });
}
