import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonKey } from '../../src/paths.js';
import {
  DEMO_EMAIL,
  DEMO_PASSWORD,
  type ShopApp,
  startShopApp,
} from '../fixtures/shop-app/server.mjs';
import { type CliResult, runCli } from './cli.js';

export { DEMO_EMAIL, DEMO_PASSWORD };

/** Loose view of any digest the CLI prints; tests assert on the fields they care about. */
export interface TestDigest {
  ok: boolean;
  status: string;
  action: string;
  url: string;
  title: string;
  error: { code: string; message: string; hint: string };
  evidence: { screenshot: string; dir: string };
}

export interface SessionRow {
  action: string;
  target: string | null;
  value: string | null;
  ok: boolean;
  url: string;
  ts: string;
  el?: Record<string, unknown>;
}

export interface Harness {
  shop: ShopApp;
  /** Project folder every CLI call runs in (it has a .git marker). */
  project: string;
  /** Isolated REPROFLOW_HOME. */
  home: string;
  stateFile: string;
  /** The environment every CLI call gets (REPROFLOW_HOME, headless, the shop password). */
  env: Record<string, string>;
  cli(
    args: string[],
    options?: { input?: string; env?: Record<string, string> },
  ): Promise<CliResult>;
  /** `reproflow do ...`, returning the parsed mini digest alongside the exit code. */
  act(...args: string[]): Promise<CliResult & { digest: TestDigest }>;
  /** Signs in through `do` actions (the password goes through an env template). */
  signIn(): Promise<void>;
  readJsonl(file: string): SessionRow[];
  stop(): Promise<void>;
}

/** A project folder, an isolated REPROFLOW_HOME, and a shop app, all in temp dirs/ports. */
export async function createHarness(options: { bug?: boolean } = {}): Promise<Harness> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'reproflow-int-')));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(join(project, '.git'), { recursive: true });
  const shop = await startShopApp({ bug: options.bug ?? false });
  const env: Record<string, string> = {
    REPROFLOW_HOME: home,
    REPROFLOW_FORCE_HEADLESS: '1',
    SHOP_PASSWORD: DEMO_PASSWORD,
  };

  const cli: Harness['cli'] = (args, extra = {}) =>
    runCli(args, { cwd: project, env: { ...env, ...extra.env }, input: extra.input });

  const harness: Harness = {
    shop,
    project,
    home,
    stateFile: join(home, 'daemons', `${daemonKey(project)}.json`),
    env,
    cli,
    async act(...args) {
      const result = await cli(['do', ...args]);
      return Object.assign(result, { digest: result.json<TestDigest>() });
    },
    async signIn() {
      await harness.act('goto', `${shop.url}/login`);
      await harness.act('fill', 'label="Email"', DEMO_EMAIL);
      await harness.act('fill', 'label="Password"', '{{env.SHOP_PASSWORD}}');
      await harness.act('click', 'role=button[name="Sign in"]');
    },
    readJsonl: (file) =>
      readFileSync(join(project, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    async stop() {
      await cli(['session', 'stop']).catch(() => {});
      await shop.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
  };
  return harness;
}
