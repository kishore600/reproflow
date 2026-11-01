// npm run demo: a full reproflow session against the bundled shop app, with nothing to set up.
//
//   1. start the shop app with its bug on (/api/cart returns 500)
//   2. reproflow init, sign in, record "add to cart" with `do`, save it as a flow
//   3. add an assertion, run the flow: it fails, and the digest names the console error and the 500
//   4. turn the bug off and run the same flow: it passes
//
// Everything lives in a temp folder, including the browser profile. Exits non-zero if any
// expectation above is not met, so it doubles as a smoke test.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const { startShopApp, DEMO_PASSWORD, DEMO_EMAIL } = await import(
  pathToFileURL(join(repo, 'test', 'fixtures', 'shop-app', 'server.mjs')).href
);

const shop = await startShopApp({ bug: true });
const root = realpathSync(mkdtempSync(join(tmpdir(), 'reproflow-demo-')));
const project = join(root, 'shop-project');
mkdirSync(join(project, '.git'), { recursive: true });
const env = { ...process.env, REPROFLOW_HOME: join(root, 'home'), SHOP_PASSWORD: DEMO_PASSWORD };

const heading = (text) => console.log(`\n\u001b[1m== ${text}\u001b[0m`);

/** Runs the built CLI the way an agent would (stdout is a pipe, so it prints JSON). */
function reproflow(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repo, 'dist', 'cli', 'index.js'), ...args], {
      cwd: project,
      env,
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
      const out = stdout.trim();
      const shown = args.map((arg) => (/[\s"{]/.test(arg) ? `'${arg}'` : arg)).join(' ');
      console.log(`$ reproflow ${shown}`);
      if (out) console.log(`${out}\n  (exit ${code}, ${out.length} characters)`);
      else console.log(`  (exit ${code})`);
      if (stderr.trim()) console.log(stderr.trim());
      resolve({ code, out });
    });
  });
}

function expect(condition, message) {
  if (!condition) throw new Error(`demo expectation failed: ${message}`);
}

try {
  console.log(`shop app: ${shop.url} (bug on: GET /api/cart answers 500)`);

  heading('1. Set the project up for agents');
  await reproflow('init');

  heading('2. Sign in once, then record the steps with `do`');
  await reproflow('do', 'goto', `${shop.url}/login`);
  await reproflow('do', 'fill', 'label="Email"', DEMO_EMAIL);
  await reproflow('do', 'fill', 'label="Password"', '{{env.SHOP_PASSWORD}}');
  await reproflow('do', 'click', 'role=button[name="Sign in"]');
  await reproflow('do', 'goto', `${shop.url}/products/TSHIRT-M`);
  await reproflow('do', 'click', 'role=button[name="Add to cart"]');
  await reproflow('do', 'click', 'role=link[name="Cart"]');
  await reproflow('do', 'wait-for', 'role=status[name="Total"]');

  heading('3. Save the last four actions as a flow');
  const saved = await reproflow(
    'save',
    'repro-cart-total',
    '--from-session',
    '--last',
    '4',
    '--description',
    'Add a product and check the cart total',
  );
  expect(saved.code === 0, 'save should succeed');

  // The recorder pins the URL; an agent (or you) adds the assertion that matters.
  const file = join(project, '.reproflow', 'flows', 'repro-cart-total.yaml');
  const recorded = readFileSync(file, 'utf8');
  const assertion =
    '  - expect_text: {target: {role: status, name: Total}, text: "$25.00"}\n    timeout_ms: 2000\n';
  expect(
    recorded.includes('  - expect_url: /cart'),
    'the recorded flow should end with expect_url',
  );
  writeFileSync(
    file,
    recorded.replace('  - expect_url: /cart', `${assertion}  - expect_url: /cart`),
  );
  console.log(
    `\n--- .reproflow/flows/repro-cart-total.yaml (with the assertion added) ---\n${readFileSync(file, 'utf8')}`,
  );

  await reproflow('list');

  heading('4. Run it with the bug on: it fails, and the digest says why');
  const failing = await reproflow('run', 'repro-cart-total');
  expect(failing.code === 1, 'the run should fail with exit code 1');
  expect(failing.out.length <= 2000, 'the failing digest should fit in 2,000 characters');
  expect(
    failing.out.includes('TypeError: price is undefined'),
    'the digest should name the console error',
  );
  expect(failing.out.includes('GET /api/cart -> 500'), 'the digest should name the 500 response');

  heading('5. Fix the bug and run the very same flow again: it passes');
  shop.setBug(false);
  const passing = await reproflow('run', 'repro-cart-total');
  expect(passing.code === 0, 'the run should pass with exit code 0');
  expect(passing.out.length <= 2000, 'the passing digest should fit in 2,000 characters');

  heading('6. What it saved');
  await reproflow('stats');

  console.log(
    '\nDemo OK: failed with the bug on (console error + 500 in the digest), passed once it was fixed.',
  );
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await reproflow('session', 'stop').catch(() => {});
  await shop.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
