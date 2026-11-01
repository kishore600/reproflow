import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { captureCommand, runFlowCommand } from '../engine/commands.js';
import { LocatorSyntaxError, parseLocator } from '../engine/locators.js';
import { ReproflowError } from '../errors.js';
import { saveFlow } from '../flows/save.js';
import { listFlowSummaries } from '../flows/summary.js';

/** A tool result carrying the digest as JSON text, exactly what the CLI prints. */
function reply(payload: object, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorReply(error: unknown) {
  if (error instanceof ReproflowError || error instanceof LocatorSyntaxError) {
    const info =
      error instanceof ReproflowError
        ? error.toInfo()
        : { code: 'flow_invalid', message: error.message, hint: 'Fix the locator syntax.' };
    return reply({ ok: false, status: 'error', error: info }, true);
  }
  throw error;
}

const paramValue = z.union([z.string(), z.number(), z.boolean()]);

/**
 * The reproflow tools over MCP: the same operations and the same digest JSON as the CLI.
 * `root` is the project the server was started in. The SDK is imported lazily so plain CLI
 * commands never pay for it.
 */
export async function createServer(root: string): Promise<McpServer> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'reproflow', version: pkg.version });

  server.registerTool(
    'reproflow_list',
    {
      title: 'List saved browser flows',
      description:
        'Lists the saved browser flows in this project: name, description and params ("name:type", "*" = required). Call this before writing any Playwright, Selenium or pyautogui script.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => reply(await listFlowSummaries(root)),
  );

  server.registerTool(
    'reproflow_run',
    {
      title: 'Replay a saved browser flow',
      description:
        "Replays a saved flow in the project's persistent Chromium with no AI calls and returns a JSON digest (status, failed step, console errors, failed requests, paths to a screenshot and aria snapshot). Rerun the same flow after a fix to verify it.",
      inputSchema: {
        flow: z.string().describe('Flow name from reproflow_list'),
        params: z
          .record(z.string(), paramValue)
          .optional()
          .describe('Flow params, e.g. {"sku": "HOODIE-L"}'),
        headed: z.boolean().optional().describe('Show the browser window'),
        trace: z.boolean().optional().describe('Also record a Playwright trace.zip'),
        keep_going: z.boolean().optional().describe('Continue after a failed step'),
      },
    },
    async ({ flow, params, headed, trace, keep_going }) => {
      const overrides = Object.fromEntries(
        Object.entries(params ?? {}).map(([name, value]) => [name, String(value)]),
      );
      const digest = await runFlowCommand(root, flow, overrides, {
        headed,
        trace,
        keepGoing: keep_going,
      });
      return reply(digest, digest.status === 'error');
    },
  );

  server.registerTool(
    'reproflow_capture',
    {
      title: 'Capture debug evidence from the current page',
      description:
        "Writes an evidence bundle for the browser's current tab (screenshot, aria snapshot, console, page errors, failed requests) and returns the JSON digest. Use it right after reproducing a bug.",
      inputSchema: {
        full_page: z.boolean().optional().describe('Screenshot the whole page'),
        locator: z
          .string()
          .optional()
          .describe('Also crop element.png to this element, e.g. role=status[name="Total"]'),
      },
    },
    async ({ full_page, locator }) => {
      try {
        const digest = await captureCommand(root, {
          fullPage: full_page,
          locator: locator ? parseLocator(locator) : undefined,
        });
        return reply(digest, digest.status === 'error');
      } catch (error) {
        return errorReply(error);
      }
    },
  );

  server.registerTool(
    'reproflow_save',
    {
      title: 'Save the recorded session as a flow',
      description:
        'Saves what was done with `reproflow do` as a named flow in .reproflow/flows/ (deterministic: typed values become params, passwords become secret params, URLs become relative). Refuses to overwrite unless force is true.',
      inputSchema: {
        name: z.string().describe('Flow name, e.g. repro-cart-total'),
        description: z.string().optional().describe('One line shown by reproflow_list'),
        last: z.number().int().positive().optional().describe('Use only the last N actions'),
        force: z.boolean().optional().describe('Overwrite an existing flow'),
      },
    },
    async ({ name, description, last, force }) => {
      try {
        return reply(await saveFlow(root, { name, description, last, force }));
      } catch (error) {
        return errorReply(error);
      }
    },
  );

  return server;
}

/** Serves the tools on stdin/stdout until the client disconnects. Nothing else may write to stdout. */
export async function serveStdio(root: string): Promise<void> {
  const server = await createServer(root);
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await server.connect(new StdioServerTransport());
}
