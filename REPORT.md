# reproflow v0.1.0: build report

## What was built

An open-source CLI (`reproflow`, Node >= 22, TypeScript strict, ESM, one npm package) that gives AI
coding agents a real Chromium that stays open in a background daemon with a saved login, one-call
debug evidence, and saved YAML flows that replay with no AI calls. Every command prints a compact JSON
digest of at most 2,000 characters, with paths to screenshots and logs on disk.

| Phase | Delivered                                                                                                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Scaffold (tsup, vitest, biome, strict tsconfig), CLI skeleton, framework-free shop test app, PLAN/DECISIONS/LICENSE                                                                                                          |
| 2     | Daemon (127.0.0.1, random port, 32-byte bearer token, `0600` state file, JSON-RPC, idle shutdown, stale-state cleanup), profiles, `session`, `login`, all `do` actions, `.reproflow/session.jsonl`, locator shorthand parser |
| 3     | Per-page collectors (ring of 200), evidence bundle and run folders (last 50 kept), digest builder with the 2,000-character truncation, `capture`, secret masking                                                             |
| 4     | Zod flow schema + JSON Schema export, YAML-path validation errors, `list`, `describe`, `run`, the ten error codes, Levenshtein locator candidates, host allowlist, `auth_expired` detection                                  |
| 5     | `save --from-session` recorder, `init` (+ SKILL.md, AGENTS.md/CLAUDE.md note), `stats`                                                                                                                                       |
| 6     | Claude Code plugin (skill, non-blocking PreToolUse hook) and root marketplace, `doctor [--fix]`, README (quickstart + full reference), CI matrix, `npm pack` check, `npm run demo`                                           |
| 7     | `reproflow mcp` over stdio with `reproflow_list`, `reproflow_run`, `reproflow_capture`, `reproflow_save`                                                                                                                     |

### Definition of done

- `npm run build`, `npm run typecheck`, `npm run lint` and `npm test` pass: 28 test files, 291 tests
  (unit tests plus integration tests that drive the built CLI against the shop app in headless
  Chromium; the digest-size property test alone runs 300 randomized digests).
- `npm run demo` prints a failing digest of 1,170 characters that names
  `TypeError: price is undefined` and `GET /api/cart -> 500`, then a passing one, and exits non-zero
  if either expectation is missed.
- The README documents every command with an example and its JSON output.
- `claude plugin validate` passes for both the plugin and the marketplace file.

## Decisions taken

All of them, with reasons, are in [DECISIONS.md](DECISIONS.md). The ones most likely to matter:

- **The brief's repository was not its own git repo** (the folder sat inside an unrelated `Documents`
  repository), so `reproflow/` got its own `git init`.
- **Session cookies survive daemon restarts.** Chromium drops cookies without an expiry on exit, which
  would have lost most logins whenever the daemon stopped. The daemon keeps them in
  `<profile>/reproflow-cookies.json` (`0600`) and restores them at launch.
- **Actions settle before returning.** After a click or key press the engine waits (max 5 s) for
  in-flight requests to drain, so "Add to cart, then open the cart" does not race the request. Without
  it the recorded session logs stale URLs.
- **Digests use absolute, forward-slash paths and same-origin requests as `GET /api/cart -> 500`.**
- **Failed `do` actions get the same evidence and candidates as failed runs.**
- **The error-code list is closed**, so some codes are reused: any navigation failure is
  `navigation_timeout`; a non-actionable element is `assertion_failed`; an ambiguous locator is
  `locator_not_found`.
- **Params and `{{env.X}}` values are resolved by the CLI**, not the daemon, and all of them are
  masked.
- **`doctor --fix` runs the Playwright CLI bundled with reproflow** rather than `npx playwright`, so
  the browser revision always matches.
- **Extras beyond the brief**, each small: `.reproflow/stats.jsonl` in `.gitignore`; a hidden
  `reproflow schema` command that writes the JSON Schema during `npm run build`; the
  `REPROFLOW_HOME`, `REPROFLOW_BROWSER_CHANNEL`, `REPROFLOW_FORCE_HEADLESS` and `REPROFLOW_IDLE_MS`
  overrides (the first two are documented and useful to users; the others exist for CI and tests).

## Known limitations

- **What was verified, and where.** Everything above ran on Windows 11 with Node 22.17 and Playwright
  1.64 (Chromium 1248). The CI workflow covers Ubuntu, macOS and Windows but **has not run**: there is
  no remote. macOS and Linux behaviour is untested, in particular the `0600` state-file mode, which
  the tests check only on POSIX.
- **Headed mode is only tested through its plumbing.** `login` and `--headed` are exercised with
  `REPROFLOW_FORCE_HEADLESS=1` (the tests have no one to sign in and no display), so the visible
  window path has not been seen working by a test.
- **The plugin was validated, not installed.** `claude plugin validate` passes and the hook is tested
  as a black box with Claude Code's documented stdin and output shapes, but it has not run inside a
  live Claude Code session, and the marketplace has not been added from a public repository. The hook
  is heuristic: it can miss an unusual install command and can warn on text that merely looks like an
  import.
- **Redirects to a disallowed host cannot be blocked in advance.** Playwright does not call route
  handlers for redirect hops, so the redirect is caught when the browser requests the other host; at
  most one request leaves. Navigations the page starts itself (links, forms, `goto`) are blocked
  before any request. See DECISIONS.md for why intercepting redirects from Node was rejected.
- **Screenshots cannot be masked.** Text artifacts are; a secret shown on screen is in the PNG.
- **One browser per project.** Runs, captures and `do` actions are serialized per daemon; the profile
  folder can be held by one daemon at a time; `sessionStorage` is not persisted across daemon
  restarts (cookies and `localStorage` are).
- **Locators do not reach into iframes**, and candidate ranking reads the top frame's aria snapshot
  only.
- **Narrow step vocabulary.** There is no file upload, drag and drop, dialog handling or multi-select,
  and `do` has no `select`, `check` or `hover` (flows do); a recorded click on a checkbox is a `click`.
- **Chromium only**, as scoped. No Firefox, WebKit, cloud browsers, desktop automation or self-healing.
- **The token estimate is a constant, not a measurement** (3,800 per step, configurable, always
  labelled an estimate).
- **Git Bash on Windows rewrites arguments that start with `/`** (`do goto /cart`); the README
  documents the workaround.
- **The Chromium download is about 200 MB** and took roughly 40 minutes on the connection used for
  this build; `REPROFLOW_BROWSER_CHANNEL` (an installed Chrome or Edge) is the escape hatch, and most
  of the integration tests were first run that way.

## Suggested next steps

1. **Publish**: create the public repository, fill in `repository` and `homepage` in the manifests,
   run CI on all three platforms, fix whatever macOS and Linux turn up, then `npm publish`.
2. **Try the plugin in a real Claude Code session** and tune the hook's patterns from what it
   actually sees.
3. **Close the redirect gap**: a CDP `Fetch` session per tab can pause redirect hops, at the cost of
   sharing the Fetch domain with Playwright.
4. **More steps and locators**: `do select|check|hover`, iframes (`frame:` locators), file upload,
   dialogs, waits on network responses.
5. **Flow reuse**: `include:`/`call:` for shared sign-in sequences, and a `reproflow flows lint`
   that validates every flow offline.
6. **CI recipe**: a small GitHub Action that restores a profile or signs in from secrets, runs chosen
   flows and uploads `.reproflow/runs/` on failure.
7. **Richer evidence**: HAR export, an aria-snapshot diff against the last passing run, and a
   `reproflow trace` shortcut for `trace.zip`.
8. **Secrets**: read secret params from the OS keychain as well as the environment.
9. **Measure instead of estimate**: record real agent token usage where an agent exposes it, and fall
   back to the constant only when it does not.
