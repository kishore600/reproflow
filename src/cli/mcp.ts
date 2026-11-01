import type { Command } from 'commander';
import { runCommand } from './output.js';
import { notImplemented } from './stub.js';

export function registerMcp(program: Command): void {
  program
    .command('mcp')
    .description('serve reproflow tools over MCP (stdio)')
    .action(() => runCommand(async () => notImplemented('mcp', 7)));
}
