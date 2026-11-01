#!/usr/bin/env node
// PreToolUse hook for the Bash tool. It never blocks: it exits 0 and, when a command looks like the
// start of a throwaway browser script, prints a warning for the user (systemMessage) and a hint for
// Claude (additionalContext) naming the matching reproflow command.
//
// Matches:
//   - installs:  npm/pnpm/yarn/bun add|install, pip/pipx/uv/poetry install|add, npx playwright install
//                of playwright, selenium or pyautogui
//   - scripts:   `node|python|npx tsx|... <file>` where <file> is new (untracked or just written)
//                and imports one of them, and inline code (`python -c`, heredocs) that does
//
// Claude Code passes the tool call as JSON on stdin: { tool_name, tool_input: { command }, cwd, ... }.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const TOOLS = {
  playwright: {
    label: 'Playwright',
    hint: 'reproflow already drives a real Chromium that stays open with your saved login. Run `reproflow list`, then `reproflow run <flow>`, or explore with `reproflow do goto <url>` and `reproflow capture`, instead of writing a Playwright script.',
  },
  selenium: {
    label: 'Selenium',
    hint: 'reproflow already drives a real Chromium that stays open with your saved login. Run `reproflow list`, then `reproflow run <flow>`, or explore with `reproflow do goto <url>` and `reproflow capture`, instead of writing a Selenium script.',
  },
  pyautogui: {
    label: 'pyautogui',
    hint: 'pyautogui clicks screen coordinates. For a web page use `reproflow do click \'role=button[name="..."]\'` (locators, not pixels) and `reproflow capture` for debug evidence; `reproflow save <name> --from-session` keeps the steps for replay.',
  },
};

const NAMES =
  '(?:playwright|@playwright/test|playwright-core|selenium|selenium-webdriver|pyautogui)';
const INSTALL = new RegExp(
  [
    `\\b(?:npm|pnpm|yarn|bun)\\s+(?:i|install|add)\\b[^\\n;&|]*\\b${NAMES}\\b`,
    `\\b(?:pip3?|pipx|uv(?:\\s+pip)?|poetry|conda)\\s+(?:install|add)\\b[^\\n;&|]*\\b${NAMES}\\b`,
    `\\bpython3?\\s+-m\\s+pip\\s+install\\b[^\\n;&|]*\\b${NAMES}\\b`,
    `\\b(?:npx|pnpm\\s+exec|yarn)\\s+playwright\\s+install\\b`,
  ].join('|'),
  'i',
);

const IMPORT = new RegExp(
  [
    `\\bfrom\\s+['"]${NAMES}(?:/[^'"]*)?['"]`,
    `\\brequire\\(\\s*['"]${NAMES}(?:/[^'"]*)?['"]\\s*\\)`,
    `\\bimport\\s+['"]${NAMES}['"]`,
    `(?:^|[\\s"';(])(?:from|import)\\s+(?:selenium|pyautogui|playwright)\\b`,
  ].join('|'),
  'im',
);

const RUNNER =
  /\b(?:node|nodejs|deno\s+run|bun(?:\s+run)?|tsx|ts-node|npx\s+tsx|npx\s+ts-node|python3?|py)\s+(?:-[A-Za-z-]+\s+)*([^\s;&|<>]+\.(?:m?js|cjs|ts|mts|py))\b/gi;

function toolOf(text) {
  const lower = text.toLowerCase();
  if (lower.includes('pyautogui')) return 'pyautogui';
  if (lower.includes('selenium')) return 'selenium';
  return 'playwright';
}

/** A script is "new" when git does not track it, or (outside git) it was written in the last 15 minutes. */
function isNew(file, cwd) {
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], {
    cwd,
    stdio: 'ignore',
  });
  if (tracked.error) {
    return Date.now() - statSync(file).mtimeMs < 15 * 60 * 1000;
  }
  return tracked.status !== 0;
}

/** Returns the tool a command should be warned about, or null. */
function analyze(command, cwd = process.cwd()) {
  if (INSTALL.test(command)) return toolOf(command.match(INSTALL)?.[0] ?? command);

  // Inline code: python -c "import selenium ...", node -e "require('playwright')", heredocs.
  if (/\b(?:python3?|node|nodejs|deno|bun|tsx)\b/i.test(command) && IMPORT.test(command)) {
    return toolOf(command.match(IMPORT)?.[0] ?? command);
  }

  for (const match of command.matchAll(RUNNER)) {
    const file = isAbsolute(match[1]) ? match[1] : resolve(cwd, match[1]);
    try {
      if (!existsSync(file) || statSync(file).size > 512 * 1024) continue;
      const source = readFileSync(file, 'utf8');
      if (IMPORT.test(source) && isNew(file, cwd))
        return toolOf(source.match(IMPORT)?.[0] ?? source);
    } catch {
      // Unreadable file: not our business, never fail the hook.
    }
  }
  return null;
}

function warningFor(tool) {
  const { label, hint } = TOOLS[tool];
  return {
    systemMessage: `reproflow: this looks like a throwaway ${label} script. ${hint}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `reproflow is installed for this project. ${hint} Continue only if reproflow cannot do this step.`,
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const input = JSON.parse(await readStdin());
  const command = input?.tool_input?.command;
  if (input?.tool_name === 'Bash' && typeof command === 'string') {
    const tool = analyze(command, typeof input.cwd === 'string' ? input.cwd : process.cwd());
    if (tool) process.stdout.write(`${JSON.stringify(warningFor(tool))}\n`);
  }
} catch {
  // A malformed payload must never break the tool call.
}
process.exit(0);
