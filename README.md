# reproflow

Saved, replayable browser flows and one-call debug evidence for AI coding agents
(Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI).

Instead of writing a throwaway Playwright, Selenium or pyautogui script every time, an agent runs
short CLI commands against a real Chromium that stays open in a background daemon with a saved
login. It can capture debug evidence in one call, save a sequence of steps as a named YAML flow in
the repo, and replay that flow later with zero AI calls. Every command prints a compact JSON digest
(at most 2,000 characters) with paths to screenshots and logs on disk.

> Status: under construction. This README grows with each build phase; see [PLAN.md](PLAN.md).
> Documented so far: sessions, login, the `do` actions, `capture` and the digest.

## Concepts

- **Project root**: the nearest folder containing `.reproflow/` or `.git/`.
- **Daemon**: one per project root. Holds a persistent Chromium (1280x800, headless by default) and
  starts automatically when a command needs a browser. It listens on `127.0.0.1` only, requires a
  random bearer token (kept in a `0600` state file under `~/.reproflow/daemons/`) and shuts itself
  down after 30 idle minutes.
- **Profile**: a Chromium user-data folder at `~/.reproflow/profiles/<name>/` (default `default`).
  It holds your logins.
- **Session log**: `.reproflow/session.jsonl`. Every `reproflow do` action appends one line.
- **Digest**: the compact JSON every command prints. Exit codes: `0` success or passed, `1` a check
  failed, `2` usage, setup or browser error.

Output is JSON when stdout is not a TTY (which is what an agent sees) or when `--json` is passed, and
readable text otherwise.

## Command reference (so far)

### `reproflow session start|stop|status [--headed] [--profile <name>]`

```console
$ reproflow session start
{"ok":true,"status":"running","pid":14816,"profile":"default","headed":false,"started_at":"2026-11-01T06:39:23.734Z","tabs":[{"index":0,"url":"about:blank","active":true}]}
$ reproflow session status
$ reproflow session stop
{"ok":true,"status":"stopped","was_running":true}
```

`start` is idempotent. `--headed` (show the window) or a different `--profile` restarts a running
daemon; leaving a flag out never changes it. You rarely need `start`: any command that needs a
browser starts the daemon for you.

### `reproflow login <url> [--profile <name>]`

Opens a **headed** browser at the URL, then waits. Sign in by hand, come back to the terminal and
press Enter. The profile keeps the login, so later headless runs are signed in.

```console
$ reproflow login http://localhost:3000/login
A browser is open at http://localhost:3000/login.
Sign in there, then come back to this terminal and press Enter.
reproflow keeps the login in profile "default".
{"ok":true,"status":"saved","profile":"default","url":"http://localhost:3000/login"}
```

Session cookies (those without an expiry) are saved with the profile too, so they survive the
daemon restarting.

### `reproflow do <action> [args]`

Runs one action in the current session and appends it to `.reproflow/session.jsonl`, which
`reproflow save --from-session` turns into a flow. Each action prints a mini digest.

| Action       | Arguments                                                                       |
| ------------ | ------------------------------------------------------------------------------- |
| `goto`       | `<url>`: absolute URL, `host:port`, or a path resolved against the current page |
| `click`      | `<locator>`                                                                     |
| `fill`       | `<locator> <value>`                                                             |
| `press`      | `<key>`, e.g. `Enter`, `Control+A`                                              |
| `scroll-to`  | `<locator>`                                                                     |
| `switch-tab` | `<index \| url-substring \| title-substring>` (0-based)                         |
| `screenshot` | `[--full-page] [--locator <locator>]`                                           |
| `wait-for`   | `<locator> [--state visible\|hidden\|attached\|detached] [--timeout ms]`        |

Every action accepts `--timeout <ms>` (default 10000).

**Locators.** In flow files a locator is an object (`{role: button, name: Add to cart}`); on the
command line it is a shorthand string:

| Shorthand                         | Playwright                                     |
| --------------------------------- | ---------------------------------------------- |
| `role=button[name="Add to cart"]` | `getByRole('button', { name: 'Add to cart' })` |
| `label="Email"`                   | `getByLabel('Email')`                          |
| `text="Cart"` or just `"Cart"`    | `getByText('Cart')`                            |
| `placeholder="Search"`            | `getByPlaceholder('Search')`                   |
| `testid=checkout`                 | `getByTestId('checkout')`                      |
| `css=.cart-total`                 | `locator('.cart-total')`                       |

Append ` >> nth=1` to take the second match or ` >> exact` for an exact (not substring) match.
Prefer role and label locators.

```console
$ reproflow do goto http://localhost:3000/login
{"ok":true,"action":"goto","url":"http://localhost:3000/login","title":"Sign in - Shop"}
$ reproflow do fill 'label="Email"' demo@example.com
$ reproflow do fill 'label="Password"' '{{env.SHOP_PASSWORD}}'
$ reproflow do click 'role=button[name="Sign in"]'
{"ok":true,"action":"click","url":"http://localhost:3000/","title":"Shop"}
$ reproflow do click 'role=button[name="Nope"]' --timeout 500
{"ok":false,"action":"click","url":"http://localhost:3000/","title":"Shop","error":{"code":"locator_not_found","message":"No element found for role=button[name=\"Nope\"]","hint":"Try a candidate locator, or look in snapshot.aria.yml for the right one."}}
```

**Passwords.** Never put a real password on the command line if you can avoid it: run
`reproflow login` instead. When you must script a sign-in, pass `'{{env.NAME}}'`: the CLI expands it
from its own environment, the value is masked in every output, and `session.jsonl` stores the
template, not the secret. A value typed into a password field is masked even without a template.

**Windows + Git Bash** rewrites arguments that start with `/` (`do goto /cart` becomes
`C:/Program Files/Git/cart`). Use a full URL, or run with `MSYS_NO_PATHCONV=1`.

### `reproflow capture [--full-page] [--locator <locator>]`

Writes an evidence bundle for the current tab and prints the digest. Run it right after reproducing
a bug: the daemon keeps the last 200 console, page-error and network events of each tab, so the error
that broke the page is in the bundle even if it happened a few actions ago.

```console
$ reproflow capture
{"ok":true,"status":"passed","flow":null,"params":{},"duration_ms":412,"steps_total":0,"steps_passed":0,"failed_step":null,"error":null,"evidence":{"dir":"/proj/.reproflow/runs/20261101-120301-capture","screenshot":"/proj/.reproflow/runs/20261101-120301-capture/screenshot.png","snapshot":"/proj/.reproflow/runs/20261101-120301-capture/snapshot.aria.yml","url":"http://localhost:3000/cart","title":"Cart - Shop","console_errors":["TypeError: price is undefined"],"page_errors":[],"failed_requests":["GET /api/cart -> 500"]},"next":"Open the screenshot or snapshot only if this digest is not enough.","truncated":false}
```

`--locator` also writes `element.png`, cropped to that element. If it matches nothing, the digest has
`status: "failed"`, `error.code: "locator_not_found"` and up to 3 ranked `candidates` (exit code 1).

## The digest

Every command that runs browser steps prints one JSON object of at most 2,000 characters:

| Field                                        | Meaning                                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`, `status`                               | `passed`, `failed` (a check or step failed) or `error` (setup problem)                                                                                                |
| `flow`, `params`                             | flow name (`null` for `capture`) and the params used; secrets are `"***"`                                                                                             |
| `duration_ms`, `steps_total`, `steps_passed` |                                                                                                                                                                       |
| `failed_step`                                | `{n, type, target, expected, actual}` or `null`                                                                                                                       |
| `error`                                      | `{code, message, hint}` or `null`                                                                                                                                     |
| `candidates`                                 | up to 3 `{locator, role, name, score}`, only for `locator_not_found`                                                                                                  |
| `evidence`                                   | `{dir, screenshot, snapshot, url, title, console_errors, page_errors, failed_requests}`; lists hold at most 5 entries, `failed_requests` read `METHOD path -> status` |
| `next`                                       | one sentence on what to do next                                                                                                                                       |
| `truncated`                                  | `true` if the 2,000-character limit forced anything to be cut                                                                                                         |

When a digest is too long, each list entry is cut to 300 characters, then entries are dropped, then
strings are shortened. The complete result is always in `run.json` in the run folder.

**Error codes:** `locator_not_found`, `assertion_failed`, `navigation_timeout`, `auth_expired`,
`host_not_allowed`, `browser_unavailable`, `daemon_unavailable`, `flow_invalid`, `param_missing`,
`flow_not_found`.

**Evidence folder** `.reproflow/runs/<YYYYMMDD-HHmmss>-<name>/`: `screenshot.png` (viewport),
`element.png` (a failed or requested element), `snapshot.aria.yml`, `console.jsonl`,
`page-errors.jsonl`, `network.jsonl` (failed requests and responses with status >= 400) and `run.json`.
Only the newest 50 run folders are kept.

Secrets are masked in digests, logs, snapshots and `run.json`. **Screenshots cannot be masked**, so
do not run flows that display a secret on screen if the evidence folder leaves your machine.

## Development

```bash
npm install
npx playwright install chromium
npm run build
npm run typecheck && npm run lint && npm test
```

Requires Node.js >= 22. Where the Playwright browser download is blocked, set
`REPROFLOW_BROWSER_CHANNEL=chrome` (or `msedge`) to drive an installed browser instead; the tests
honour it too.
