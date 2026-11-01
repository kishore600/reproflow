import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SKILL_MD } from '../../src/integrations/skill.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(repo, ...parts), 'utf8');
const json = <T>(...parts: string[]): T => JSON.parse(read(...parts)) as T;

interface Manifest {
  name: string;
}
interface Marketplace {
  name: string;
  owner: { name: string };
  plugins: { name: string; source: string }[];
}
interface HooksFile {
  hooks: {
    PreToolUse: { matcher: string; hooks: { type: string; command: string; args: string[] }[] }[];
  };
}
interface HookOutput {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
}
const HOOK = join(repo, 'plugin', 'scripts', 'warn-browser-scripts.mjs');

describe('Claude Code plugin files', () => {
  it('ships the same SKILL.md as `reproflow init`', () => {
    expect(read('plugin', 'skills', 'reproflow', 'SKILL.md')).toBe(SKILL_MD);
  });

  it('has a manifest whose name matches the marketplace entry', () => {
    const manifest = json<Manifest>('plugin', '.claude-plugin', 'plugin.json');
    const marketplace = json<Marketplace>('.claude-plugin', 'marketplace.json');
    expect(manifest.name).toBe('reproflow');
    expect(marketplace.name).toBeTruthy();
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({ name: manifest.name, source: './plugin' });
    expect(existsSync(join(repo, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('wires a PreToolUse hook on Bash to a script that exists', () => {
    const { hooks } = json<HooksFile>('plugin', 'hooks', 'hooks.json');
    expect(hooks.PreToolUse).toHaveLength(1);
    const [entry] = hooks.PreToolUse;
    expect(entry.matcher).toBe('Bash');
    const [hook] = entry.hooks;
    expect(hook).toMatchObject({ type: 'command', command: 'node' });
    const script = String(hook.args[0]).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/, join(repo, 'plugin'));
    expect(existsSync(script)).toBe(true);
  });
});

interface HookRun {
  status: number | null;
  out: string;
  parsed: HookOutput | null;
}

function runHook(payload: unknown, cwd: string = repo): HookRun {
  const result = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    out: result.stdout,
    parsed: result.stdout.trim() ? (JSON.parse(result.stdout) as HookOutput) : null,
  };
}

const bash = (command: string, cwd?: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  ...(cwd ? { cwd } : {}),
});

describe('PreToolUse hook', () => {
  it.each([
    ['npm install playwright', 'Playwright'],
    ['npm i -D @playwright/test', 'Playwright'],
    ['pnpm add playwright-core', 'Playwright'],
    ['yarn add selenium-webdriver', 'Selenium'],
    ['pip install selenium', 'Selenium'],
    ['pip3 install requests pyautogui', 'pyautogui'],
    ['python3 -m pip install playwright', 'Playwright'],
    ['uv pip install pyautogui', 'pyautogui'],
    ['npx playwright install chromium', 'Playwright'],
    ['cd app && npm install --save-dev playwright && npm test', 'Playwright'],
    ['python -c "import selenium; print(1)"', 'Selenium'],
    ['node -e "require(\'playwright\').chromium.launch()"', 'Playwright'],
    ["python - <<'EOF'\nfrom selenium import webdriver\nEOF", 'Selenium'],
  ])('warns for: %s', (command, label) => {
    const run = runHook(bash(command));
    expect(run.status).toBe(0);
    expect(run.parsed?.systemMessage).toContain(label);
    expect(run.parsed?.systemMessage).toContain('reproflow');
    expect(run.parsed?.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse' });
    expect(run.parsed?.hookSpecificOutput?.additionalContext).toContain('reproflow');
  });

  it('suggests the matching reproflow command', () => {
    expect(runHook(bash('npm i playwright')).parsed?.systemMessage).toContain('reproflow list');
    expect(runHook(bash('pip install pyautogui')).parsed?.systemMessage).toContain(
      'reproflow do click',
    );
    expect(runHook(bash('pip install selenium')).parsed?.systemMessage).toContain(
      'reproflow run <flow>',
    );
  });

  it('never blocks: no permission decision, always exit 0', () => {
    const run = runHook(bash('npm install playwright'));
    expect(run.status).toBe(0);
    expect(JSON.stringify(run.parsed)).not.toContain('permissionDecision');
    expect(JSON.stringify(run.parsed)).not.toContain('deny');
  });

  it.each([
    'npm install lodash',
    'pip install requests',
    'npm test',
    'git status',
    'ls -la',
    'reproflow run repro-cart-total',
    'reproflow do click \'role=button[name="Add to cart"]\'',
    'npm install -g reproflow',
    'echo "playwright is great"',
  ])('stays silent for: %s', (command) => {
    const run = runHook(bash(command));
    expect(run.status).toBe(0);
    expect(run.out).toBe('');
  });

  it('ignores other tools, malformed input and empty input, still exiting 0', () => {
    for (const payload of [
      { tool_name: 'Read', tool_input: { command: 'npm install playwright' } },
      { tool_name: 'Bash', tool_input: {} },
      'not json',
      '',
    ]) {
      const run = runHook(payload);
      expect(run.status).toBe(0);
      expect(run.out).toBe('');
    }
  });

  describe('scripts', () => {
    let dir: string;
    beforeAll(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'reproflow-hook-')));
      writeFileSync(
        join(dir, 'scrape.mjs'),
        "import { chromium } from 'playwright';\nawait chromium.launch();\n",
      );
      writeFileSync(join(dir, 'scrape.cjs'), "const { chromium } = require('playwright');\n");
      writeFileSync(
        join(dir, 'drive.py'),
        'from selenium import webdriver\ndriver = webdriver.Chrome()\n',
      );
      writeFileSync(join(dir, 'click.py'), 'import pyautogui\npyautogui.click(10, 10)\n');
      writeFileSync(join(dir, 'plain.mjs'), "console.log('hi');\n");
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it.each([
      ['node scrape.mjs', 'Playwright'],
      ['node scrape.cjs', 'Playwright'],
      ['python drive.py', 'Selenium'],
      ['python3 click.py', 'pyautogui'],
      ['cd . && node ./scrape.mjs --headed', 'Playwright'],
    ])('warns when a new script that imports a browser driver is run: %s', (command, label) => {
      const run = runHook(bash(command, dir), dir);
      expect(run.parsed?.systemMessage).toContain(label);
    });

    it('stays silent for new scripts that import nothing of the sort, or missing files', () => {
      expect(runHook(bash('node plain.mjs', dir), dir).out).toBe('');
      expect(runHook(bash('node nope.mjs', dir), dir).out).toBe('');
    });

    it('stays silent for a script that git already tracks, and warns when it is untracked', () => {
      const git = (...args: string[]) =>
        spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
          cwd: dir,
          encoding: 'utf8',
        });
      expect(git('init', '-q').status).toBe(0);
      git('add', 'scrape.mjs');
      expect(git('commit', '-q', '-m', 'add').status).toBe(0);
      expect(runHook(bash('node scrape.mjs', dir), dir).out).toBe('');
      // drive.py was never added, so inside this repo it is a new script.
      expect(runHook(bash('python drive.py', dir), dir).parsed?.systemMessage).toContain(
        'Selenium',
      );
    });
  });
});
