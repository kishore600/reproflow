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
