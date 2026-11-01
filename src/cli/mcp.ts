import type { Command } from 'commander';
import { findProjectRoot } from '../paths.js';
import { runCommand } from './output.js';

export function registerMcp(program: Command): void {
  program
    .command('mcp')
    .description('serve reproflow over MCP (stdio) for agents that prefer tools to a CLI')
    .addHelpText(
      'after',
      `
Tools (each returns the same digest JSON as the CLI):
  reproflow_list     list saved flows
  reproflow_run      replay a flow
  reproflow_capture  write an evidence bundle for the current page
  reproflow_save     save the recorded session as a flow

The server works on the project it is started in. Register it with your client, for example:
  claude mcp add reproflow -- reproflow mcp
or in an MCP config file:
  {"mcpServers": {"reproflow": {"command": "reproflow", "args": ["mcp"]}}}`,
    )
    .action((_opts: unknown, command: Command) =>
      runCommand(command, async () => {
        const { serveStdio } = await import('../mcp/server.js');
        await serveStdio(findProjectRoot());
        return 0;
      }),
    );
}
