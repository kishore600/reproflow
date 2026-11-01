# Decisions

Choices made where the brief was silent or ambiguous. Newest sections at the bottom.

## Repository

- **Own git repo.** The working folder sat inside a larger unrelated git repository (`Documents`),
  so `reproflow/` got its own `git init -b main`. The brief says "this empty git repository", and
  an open-source CLI wants its own history.
- **Commit trailers.** No `Co-Authored-By` trailer is added to commits (standing user preference).

## Tooling

- **Runtime dependencies** (one line each, as required):
  - `playwright`: Chromium automation via `launchPersistentContext`.
  - `commander`: CLI parsing.
  - `yaml`: parse flows (with line numbers) and write recorded flows.
  - `zod` (v4): flow validation and JSON Schema export.
  - `fastest-levenshtein`: locator candidate ranking.
- **Dev dependencies:** `typescript`, `tsup`, `vitest`, `@biomejs/biome`, `@types/node` (pinned to 22 to
  match the engine). Phase 7 adds `@modelcontextprotocol/sdk`.
- **Single bundle, no code splitting** (`tsup` `splitting: false`). The CLI spawns itself
  (`daemon-run`, a hidden command) as the daemon, so one file must be runnable by plain `node`.
- **Playwright is imported lazily** (only the daemon and `login` load it) to keep `reproflow list`
  and friends fast.
- **Shop fixture is plain JS** (`server.mjs` + `server.d.mts`) so the demo script and tests can run it
  with plain `node`, with no TypeScript runner.
- **Integration tests drive the built CLI** (`dist/cli/index.js`) in real child processes, like an
  agent would. `test/global-setup.ts` rebuilds it once per test run.

## Daemon and browser (phase 2)

- **JSON-RPC 2.0 over `POST /rpc`.** The brief says "JSON-RPC style"; real 2.0 envelopes cost nothing
  and give clients a standard error shape. Errors carry reproflow's `code` and `hint` in `error.data`.
  The server also checks the `Host` header (only `127.0.0.1`/`localhost`) as defence in depth.
- **Mutating methods run one at a time** (`do`, `capture`, `run`); `ping`, `status`, `shutdown` do not
  wait. Two agents sharing a project therefore cannot interleave steps on the same page.
- **Restart rules.** An explicit `--profile` that differs from the running daemon's, or `--headed`
  against a headless daemon, restarts it. Omitting a flag never changes a running daemon, so an
  agent's plain `session start` cannot close a window the user opened with `--headed`.
- **`login` stops every daemon holding the profile** (any project), because Chromium locks the
  profile folder. They restart on demand.
- **Session-cookie jar.** Chromium discards cookies without an expiry when it exits, which would lose
  most logins whenever the daemon stops (30 idle minutes, `session stop`, `login`). The daemon saves
  its cookies to `<profile>/reproflow-cookies.json` (mode 0600) after every action and at shutdown,
  and restores them at launch. Cookies that were already persistent are unaffected. This file holds
  the same secrets as the profile's own cookie database.
- **The active tab is sticky.** A tab opened by `target=_blank` does not take over; use
  `do switch-tab` (index, URL substring or title substring; indices are 0-based).
- **Actions settle before returning.** After click, press, check, uncheck and select the engine
  waits (max 5 s) until no document/xhr/fetch/script/stylesheet request has been in flight for
  150 ms. Without this, "click Add to cart, then click Cart" races the request, and the session log
  would record stale URLs. It is a quiet-period check, not Playwright's `networkidle`, so a hanging
  long-poll costs 5 s at worst.
- **Environment overrides** (all optional, none documented as stable API except the first three):
  `REPROFLOW_HOME` (state folder), `REPROFLOW_BROWSER_CHANNEL` (`chrome`, `msedge`: drive an installed
  browser where the Playwright download is blocked), `REPROFLOW_FORCE_HEADLESS=1` (ignore `--headed`;
  CI and tests), `REPROFLOW_IDLE_MS` (idle shutdown), `REPROFLOW_CLI_ENTRY` (script the CLI spawns as
  the daemon).
- **Error-code reuse.** The code list in the brief is closed, so: any navigation failure (refused
  connection, DNS, timeout) is `navigation_timeout`; an element that exists but cannot be acted on
  (disabled, covered) is `assertion_failed` with the Playwright reason as `actual`; a locator matching
  several elements (strict mode) is `locator_not_found` with a hint to add `nth`; a missing tab is
  `assertion_failed`.
- **Login detection** (`auth_expired`) compares the page before and after a step, so typing into a
  login form while _recording_ a login (`do fill`, `do click "Sign in"`) never trips it.
- **`do` value templates.** `do fill <locator> '{{env.NAME}}'` is expanded by the CLI from its own
  environment (the daemon's may differ), masked in every output, and written to `session.jsonl`
  as the template, not the secret. A value typed into a password field is masked even without a
  template.
- **Locator shorthand extras.** `[name=Add to cart]` (unquoted) is accepted for shells that eat the
  quotes; ` >> nth=N` and ` >> exact` suffixes carry the optional `nth`/`exact`.
- **Paths in digests** are absolute with forward slashes on every platform (valid on Windows, no
  doubled backslashes in JSON).
- **Git Bash on Windows rewrites arguments that start with `/`** (`do goto /cart` becomes
  `C:/Program Files/Git/cart`). Use `MSYS_NO_PATHCONV=1` or a full URL there; documented in the README.

## Evidence and digests (phase 3)

- **Digest lists show the earliest 5 unique entries**, not the latest: the first error on a page is
  usually the cause, later ones its fallout. The full, uncapped lists are in `run.json`.
- **Noise stays out of the digest, in the files.** Favicon misses, `ERR_ABORTED` requests (a page
  navigating away from an in-flight fetch) and Chromium's own "Failed to load resource" console line
  (it repeats the failed request) are left out of `console_errors` / `failed_requests`, but they
  stay in `console.jsonl` and `network.jsonl`.
- **Same-origin requests print as `GET /api/cart -> 500`** (path and query, no origin). Other origins
  keep the full URL.
- **Truncation order** (applies to every digest, including `do`): cut each list entry to 300
  characters; then drop entries from whichever list is longest; then shorten strings (file paths are
  never shortened); then fall back to `{ok, status, error, evidence.dir, truncated}`. It is
  property-tested to never exceed 2,000 characters. `run.json` always keeps everything.
- **A failed `do` action gets the same evidence as a failed run** (bundle, `element.png` when its
  locator resolves, ranked candidates), in a `<ts>-do-<action>` run folder. Passing `do` actions
  write nothing, which keeps the session fast.
- **Capture scope.** `capture` writes the active tab's whole 200-event ring buffer: the error that
  broke the page is usually from an earlier action, not from the capture itself.
- **Locator candidates** come from the page's aria snapshot. Score = 0.7 x name similarity + 0.3 x
  role match for role locators, name similarity alone for label/text/placeholder/testid locators
  (similarity is 1 - Levenshtein / longest, floored at 0.75 when one name contains the other).
  Scores under 0.3 are dropped; the top 3 are kept. CSS locators get none (they carry no text).
- **Secrets are tracked per daemon**, not per command: any value typed into a password field or given
  as an `{{env.X}}` template is masked in every digest, log, snapshot and `run.json` the daemon
  writes afterwards. Screenshots cannot be masked; that limitation is in the README.

## Flows and `run` (phase 4)

- **Flow identity is the file name**, not the `name:` field. `reproflow run repro-cart-total` reads
  `repro-cart-total.yaml` (or `.yml`); the digest's `flow` is that id.
- **`required` defaults to true when a param has no default** (and no `required: false`). A param
  that is neither required nor defaulted resolves to `""`, `0` or `false`.
- **Params and `{{env.X}}` are resolved by the CLI**, not the daemon (whose environment may differ),
  and sent over the authenticated socket. Every `{{env.X}}` value counts as a secret, so it is masked
  even if it was only a path. Secret params may not carry a default in YAML.
- **Validation order.** Zod validates the shape first; template names, relative URLs without a
  `base_url`, bad `allowed_hosts` entries and secret defaults are checked only once the shape is
  valid. A union mismatch is reported against the closest branch, at its real path and line.
- **`allowed_hosts` does not imply the `base_url` host.** The brief lists them separately; a flow
  whose `base_url` host is missing fails with `host_not_allowed` and a hint that names the host.
- **Host enforcement has one gap, by Playwright's design.** Route handlers are never called for the
  hops of a redirect, so a redirect from an allowed host to a disallowed one cannot be blocked
  before the request goes out. It is detected from the request event and fails the step; at most
  one request reaches the other host. Navigations the page starts itself are aborted with `aborted`
  (not `blockedbyclient`, which would replace the tab with a Chromium error page). Intercepting
  redirects by fetching them from Node was rejected: it bypasses the browser's trust store, which
  breaks locally trusted HTTPS dev certificates.
- **auth_expired for `goto`** ignores what the tab showed before: a fresh `goto` that lands on a
  login URL is expired even if the previous run left the tab on `/login`. Other steps only count a
  _transition_ onto a login page. Flows that sign in themselves (they `goto` a login URL, or fill a
  password field or a secret param) skip detection.
- **A passing run writes `run.json` and the three `.jsonl` logs only**; screenshot and snapshot come
  with failures (`on_fail: capture`) and `capture` steps. Evidence for a pass is still in the
  digest: URL, title and any console errors the page logged.
- **Optional steps** that fail are recorded as `skipped` in `run.json` and do not count as passed.
- **JSON Schema** is generated by a hidden `reproflow schema --out` command that `npm run build` runs;
  a test checks the committed `schema/flow.schema.json` matches the code.

## Recorder, init and stats (phase 5)

- **`wait-for`'s state is logged** (as the session entry's `value`) so the recorder can keep
  `state: hidden`. Session entries also carry the element facts (`role`, `name`, `label`,
  `type`, `unique`) that the daemon learns before an action, because the page may have navigated
  by the time the action returns.
- **Role + name replaces the locator only when it is unique** on the page at record time; a
  non-unique role+name would make the saved flow fail with a strict-mode error. Roles that carry no
  meaning (`generic`, `text`, `group` ...) are never promoted.
- **Secret env var names.** A password field's variable is `<FLOW>_PASSWORD` where `<FLOW>` is the
  flow name upper-cased with non-alphanumerics as `_` (`pw-login` gives `PW_LOGIN_PASSWORD`). If the
  session used an `{{env.NAME}}` template, `NAME` is kept instead, so the saved flow reads the
  variable the agent already had.
- **Recording range.** "Since the last goto to a new origin" compares the origin a `goto` landed on
  with the origin of the previous log entry; the first goto of a session always counts. If the range
  starts on a non-`goto` (`--last`, or the 50-action cap), a `goto` to the page that action ran on
  is prepended so the flow can start from a cold browser.
- **`init` adds `.reproflow/stats.jsonl` to `.gitignore`** as well as the two entries the brief
  names: stats are per-machine noise that would otherwise churn in every commit.
- **`init` refreshes managed text** (the two `SKILL.md` files and the marked note) so upgrades reach
  existing projects; it never touches `example.yaml` once it exists. `SKILL.md` files are excluded
  from Biome so the text stays byte-exact.
- **Stats rows.** `steps` is the number of steps that ran (all of them for a pass, the failing one
  included for a failure); `digest_chars` is the printed digest's length. A run that never reached a
  browser (invalid flow, missing param) logs `steps: 0`, so it avoids no tokens. `flow_not_found` is
  not logged because there is no flow to attribute it to. Top failing flows rank by failures, then by
  failure rate, then by name.

## Plugin, doctor, CI and demo (phase 6)

- **Plugin layout follows the current docs** (read before writing, and checked with
  `claude plugin validate`): the marketplace file is `.claude-plugin/marketplace.json` at the
  repository root and lists one plugin with `"source": "./plugin"`; the plugin root is `plugin/`
  (`.claude-plugin/plugin.json`, `skills/reproflow/SKILL.md`, `hooks/hooks.json`,
  `scripts/warn-browser-scripts.mjs`). Marketplace, plugin and entry are all named `reproflow`
  (the entry and manifest names must match). Install id: `reproflow@reproflow`.
- **The hook is exec-form** (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/..."]`),
  so paths with spaces need no quoting and Windows needs no shell. Node is a given: reproflow itself
  needs it. The hook prints `systemMessage` (for the user) and `additionalContext` (for Claude),
  never a `permissionDecision`, and always exits 0, even on malformed input.
- **What the hook calls "a new script"**: git does not track the file, or, outside git, it was written
  in the last 15 minutes. Inline code (`python -c`, `node -e`, heredocs) is checked in the command
  text itself. The plugin skill is byte-identical to `reproflow init`'s (a test checks it).
- **The plugin does not install the CLI** (a plugin cannot run `npm install -g` safely); the README
  and the plugin description say the CLI must be on `PATH`. No `repository`/`homepage` is set in
  the manifests because the repository has no public URL yet; the README uses `<owner>/reproflow`.
- **`doctor --fix` runs the Playwright CLI bundled with reproflow** (`node .../playwright/cli.js
  install chromium`) instead of `npx playwright install chromium`: same command, but `npx` from a
  different directory can resolve another Playwright version and download a browser revision
  reproflow cannot use. It falls back to `npx` if the bundled CLI is missing. Installer output goes
  to stderr so stdout stays a clean digest. A configured `REPROFLOW_BROWSER_CHANNEL` skips the
  Chromium check.
- **`doctor` is a check, so a failure exits 1**, not 2.
- **CI** installs Chromium with `npx playwright install --with-deps chromium` (the flag installs Linux
  libraries and does nothing on macOS and Windows), then build, typecheck, lint, tests and
  `npm pack --dry-run`. `npm run build` runs in `prepack` so a published package always has a fresh
  `dist/`. A test runs `npm pack --dry-run --json` and checks the file list.
- **The demo adds the assertion itself.** The recorder pins the URL but cannot know which total
  matters, so `npm run demo` edits the saved YAML to add the `expect_text` step, as an agent or a
  person would. It exits non-zero if the failing digest is over 2,000 characters or misses the console
  error or the 500, so it works as a smoke test.

## MCP (phase 7)

- **One implementation, two front ends.** `list`, `run`, `capture` and `save` live in plain
  functions (`listFlowSummaries`, `runFlowCommand`, `captureCommand`, `saveFlow`) that the CLI and
  the MCP tools both call, so the digests cannot drift apart. A test compares them.
- **Dependency:** `@modelcontextprotocol/sdk`: the stdio server and (in tests) client. It is imported
  lazily, so `reproflow list` and friends do not load it.
- **Result shape.** A tool returns one text block holding the digest JSON. `isError` is set only for
  `status: "error"` (the call could not run); a flow that ran and failed is a result the agent must
  read, not a tool failure. `structuredContent` is not used: the digest has no fixed output schema
  (lists shrink to fit 2,000 characters).
- **Scope.** `reproflow_run` and `reproflow_save` are the four tools the brief names; there is no
  `do` tool. Exploring step by step stays with the CLI, which records the session `reproflow_save`
  needs.
- **stdout belongs to the protocol.** The server prints nothing else: the daemon's output goes to its
  log file, and every command function returns data instead of printing.
- **Refactor side effect:** `save` refusals (bad name, existing flow, empty session) are now
  `flow_invalid` digests with exit code 2 in the CLI too, not bare stderr messages.
