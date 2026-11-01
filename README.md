# reproflow

Saved, replayable browser flows and one-call debug evidence for AI coding agents
(Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI).

Instead of writing a throwaway Playwright, Selenium or pyautogui script every time, an agent runs
short CLI commands against a real Chromium that stays open in a background daemon with a saved
login. It can capture debug evidence in one call, save a sequence of steps as a named YAML flow in
the repo, and replay that flow later with zero AI calls. Every command prints a compact JSON digest
(at most 2,000 characters) with paths to screenshots and logs on disk.

## 60-second quickstart

```bash
npm install -g reproflow          # Node.js 22 or newer
reproflow doctor --fix            # checks everything; installs Playwright Chromium if it is missing

cd your-web-project
reproflow init                    # flows folder, agent skill, AGENTS.md / CLAUDE.md note
reproflow login http://localhost:3000/login   # once, only if the app needs a login

reproflow do goto http://localhost:3000/products/TSHIRT-M
reproflow do click 'role=button[name="Add to cart"]'
reproflow capture                 # one call: screenshot, aria snapshot, console, network
reproflow save repro-cart-total --from-session
reproflow run repro-cart-total    # replay: no AI, one JSON digest
```

Want to see it work before pointing it at your app? From a clone of this repository:

```bash
npm install && npx playwright install chromium
npm run demo
```

The demo starts a small shop app with a bug, records and saves a flow, runs it (it fails, and the
digest names the console error and the `GET /api/cart -> 500`), fixes the bug and runs the same flow
again (it passes). Everything happens in a temp folder.

## Install

1. **The CLI**: `npm install -g reproflow`, or run it from a project with `npx reproflow`. It needs
   Node.js 22 or newer.
2. **A browser**: `reproflow doctor --fix` downloads Playwright's Chromium (about 200 MB). Where that
   download is blocked, set `REPROFLOW_BROWSER_CHANNEL=chrome` (or `msedge`) to drive a browser you
   already have installed.
3. **Tell your agent about it**, either or both:

**Claude Code plugin.** The repository is a plugin marketplace
([`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)) holding one plugin in
[`plugin/`](plugin). In Claude Code:

```text
/plugin marketplace add <owner>/reproflow
/plugin install reproflow@reproflow
```

or from your shell, which also works for a local checkout:

```bash
claude plugin marketplace add <owner>/reproflow      # or ./path/to/reproflow
claude plugin install reproflow@reproflow
```

(Replace `<owner>/reproflow` with the GitHub path of the repository.) The plugin adds:

- the **reproflow skill**, the same text `reproflow init` writes (it needs the CLI on `PATH`);
- a **PreToolUse hook on Bash** that _warns, and never blocks_, when a command installs Playwright,
  Selenium or pyautogui (`npm i playwright`, `pip install selenium`, `npx playwright install` ...),
  or runs a new script (not tracked by git) or inline code that imports them. The warning names the
  matching reproflow command, for example `reproflow list` / `reproflow run <flow>` for a Playwright
  script, or `reproflow do click 'role=button[name="..."]'` for pyautogui. Try it without installing:
  `claude --plugin-dir ./plugin`.

**Any agent, through the repository.** `reproflow init` writes the skill to
`.agents/skills/reproflow/SKILL.md` and `.claude/skills/reproflow/SKILL.md` and a one-line note to
`AGENTS.md` and `CLAUDE.md`, which agents that follow those conventions read on startup.

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

## Command reference

| Command                      | What it does                                 |
| ---------------------------- | -------------------------------------------- |
| `init`                       | set the project up for agents (idempotent)   |
| `doctor [--fix]`             | check Node, Chromium, daemon and permissions |
| `session start               | stop                                         | status` | manage the browser daemon |
| `login <url>`                | sign in by hand; the profile keeps it        |
| `do <action>`                | run one action and log it                    |
| `capture`                    | one-call debug evidence                      |
| `list`, `describe <flow>`    | what flows exist                             |
| `run <flow>`                 | replay a flow with no AI                     |
| `save <name> --from-session` | record a flow from the session               |
| `stats`                      | totals and estimated tokens avoided          |

Every command prints JSON when stdout is not a TTY or `--json` is passed, and readable text
otherwise. Exit codes: `0` success or passed, `1` a check failed, `2` usage, setup or browser error.

### `reproflow doctor [--fix]`

Prints a pass/fail list: the Node version, the Playwright package, Playwright Chromium (or the browser
channel you set), the project's daemon, and write access to `.reproflow/` and `~/.reproflow/`.
`--fix` downloads Chromium when it is missing (it runs the Playwright CLI bundled with reproflow, the
equivalent of `npx playwright install chromium`, so the browser revision always matches) and stops a
stuck daemon. Exit code `1` if any check fails.

```console
$ reproflow doctor
{"ok":true,"status":"passed","checks":[{"name":"node","ok":true,"detail":"Node.js 22.17.1"},{"name":"playwright","ok":true,"detail":"playwright 1.64.1"},{"name":"chromium","ok":true,"detail":"Chromium at C:/Users/me/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe"},{"name":"daemon","ok":true,"detail":"not running (one starts when a command needs a browser)"},{"name":"write: project","ok":true,"detail":"can write to /work/shop/.reproflow"},{"name":"write: home","ok":true,"detail":"can write to /home/me/.reproflow/daemons"}],"fixed":[]}
```

### `reproflow session start|stop|status [--headed] [--profile <name>]`

```console
$ reproflow session start
{"ok":true,"status":"running","pid":14816,"profile":"default","headed":false,"started_at":"2026-11-01T06:39:23.734Z","tabs":[{"index":0,"url":"about:blank","active":true}]}
$ reproflow session status
{"ok":true,"status":"running","pid":14816,"profile":"default","headed":false,"started_at":"2026-11-01T06:39:23.734Z","tabs":[{"index":0,"url":"http://localhost:3000/cart","active":true}]}
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

### `reproflow list`

Compact JSON, about 25 tokens per flow. Params are `name:type`, with `*` marking a required one.
Run it before anything else.

```console
$ reproflow list
{"flows":[{"name":"repro-cart-total","description":"Add a product and check the cart total","params":["sku:string","total:string","password:string"]}]}
```

A flow that does not parse shows as `{"name":"...","error":"..."}` so one typo does not hide the rest.

### `reproflow describe <flow>`

The whole flow as JSON (the parsed YAML), including every step.

```console
$ reproflow describe repro-cart-total
{"name":"repro-cart-total","description":"Add a product and check the cart total","base_url":"http://localhost:3000","allowed_hosts":["localhost","127.0.0.1"],"params":{"sku":{"type":"string","default":"TSHIRT-M"},"total":{"type":"string","default":"$25.00"},"password":{"type":"string","required":false,"secret":true,"env":"SHOP_PASSWORD"}},"steps":[{"goto":"/products/{{sku}}"},{"click":{"role":"button","name":"Add to cart"}},{"click":{"role":"link","name":"Cart"}},{"expect_text":{"target":{"role":"status","name":"Total"},"text":"{{total}}"},"timeout_ms":3000}],"on_fail":"capture"}
```

### `reproflow run <flow> [--<param>=<value> ...] [--headed] [--trace] [--keep-going]`

Replays a flow with no AI calls. It stops at the first failed step unless `--keep-going` is given.
`--trace` adds a Playwright `trace.zip` to the run folder (open it with `npx playwright show-trace`).
Exit code `0` passed, `1` a step failed, `2` the flow could not run.

```console
$ reproflow run repro-cart-total
{"ok":true,"status":"passed","flow":"repro-cart-total","params":{"sku":"TSHIRT-M","total":"$25.00","password":"***"},"duration_ms":1398,"steps_total":4,"steps_passed":4,"failed_step":null,"error":null,"evidence":{"dir":"/work/shop/.reproflow/runs/20261101-123347-repro-cart-total","screenshot":null,"snapshot":null,"url":"http://localhost:3000/cart","title":"Cart - Shop","console_errors":[],"page_errors":[],"failed_requests":[]},"next":"Flow passed. Nothing more to check.","truncated":false}
```

When the app is broken, the digest says what failed and why:

```console
$ reproflow run repro-cart-total
{"ok":false,"status":"failed","flow":"repro-cart-total","params":{"sku":"TSHIRT-M","total":"$25.00","password":"***"},"duration_ms":4508,"steps_total":4,"steps_passed":3,"failed_step":{"n":4,"type":"expect_text","target":"role=status[name=\"Total\"]","expected":"$25.00","actual":"$0.00"},"error":{"code":"assertion_failed","message":"Expected role=status[name=\"Total\"] to contain \"$25.00\" but got \"$0.00\"","hint":"Compare expected and actual, then check console_errors and failed_requests."},"evidence":{"dir":"/work/shop/.reproflow/runs/20261101-123349-repro-cart-total","screenshot":"/work/shop/.reproflow/runs/20261101-123349-repro-cart-total/screenshot.png","snapshot":"/work/shop/.reproflow/runs/20261101-123349-repro-cart-total/snapshot.aria.yml","url":"http://localhost:3000/cart","title":"Cart - Shop","console_errors":["TypeError: price is undefined"],"page_errors":[],"failed_requests":["GET /api/cart -> 500"]},"next":"Check console_errors and failed_requests, fix the app, then rerun this flow.","truncated":false}
```

A locator that does not match comes back with ranked candidates (Levenshtein similarity against the
page's accessibility snapshot):

```console
$ reproflow run typo
{"ok":false,"status":"failed","flow":"typo","params":{},"duration_ms":994,"steps_total":2,"steps_passed":1,"failed_step":{"n":2,"type":"click","target":"role=button[name=\"Add to cat\"]","expected":null,"actual":null},"error":{"code":"locator_not_found","message":"No element found for role=button[name=\"Add to cat\"]","hint":"Try a candidate locator, or look in snapshot.aria.yml for the right one."},"candidates":[{"locator":"role=button[name=\"Add to cart\"]","role":"button","name":"Add to cart","score":0.94}],"evidence":{"dir":"...","screenshot":"...","snapshot":"...","url":"http://127.0.0.1:3000/products/TSHIRT-M","title":"T-Shirt (M) - Shop","console_errors":[],"page_errors":[],"failed_requests":[]},"next":"Retry with role=button[name=\"Add to cart\"], or check snapshot.aria.yml.","truncated":false}
```

Problems before any step runs (`status: "error"`, exit code 2) use the same shape:

```console
$ reproflow run nope
{"ok":false,"status":"error","flow":"nope","params":{},"duration_ms":22,"steps_total":0,"steps_passed":0,"failed_step":null,"error":{"code":"flow_not_found","message":"no flow named \"nope\" in .reproflow/flows/","hint":"Saved flows: repro-cart-total. Run `reproflow list` for details."},"evidence":null,"next":"Saved flows: repro-cart-total. Run `reproflow list` for details.","truncated":false}
```

`auth_expired` means the page landed on a URL matching `/login|signin|auth/i` (or showed a password
field) in a step that did not expect it. Ask the user to run `reproflow login <url>`.

### `reproflow save <name> --from-session [--last <n>] [--description <text>] [--force]`

Saves what you did with `reproflow do` as `.reproflow/flows/<name>.yaml`. It is deterministic: no AI.

- It uses the successful actions since the last `goto` to a new origin (at most 50), or exactly the
  last `n` with `--last`. Failed actions and screenshots are skipped.
- Values typed into `fill` steps become params named from the field's label (`Email` becomes
  `email`, `Quantity` becomes `quantity`); a number input gives a `number` param.
- **Passwords are never written.** A value typed into a password field becomes a `secret` param
  that reads `<FLOW>_PASSWORD` from the environment (or the variable you named in an
  `{{env.NAME}}` template).
- `base_url` is the first `goto`'s origin and later `goto`s are relative; the hosts visited go into
  `allowed_hosts`.
- Each locator is the one the action used, upgraded to role + name when that identifies exactly one
  element.
- The flow ends with an `expect_url` for the last page.
- It refuses to overwrite an existing flow without `--force`.

```console
$ reproflow save cart --from-session --description "Add two shirts and open the cart"
{"ok":true,"status":"saved","flow":"cart","path":"/work/shop/.reproflow/flows/cart.yaml","steps":6,"params":["quantity"],"next":"Run it with `reproflow run cart`."}
```

```yaml
# Recorded by reproflow from `reproflow do` actions on 2026-11-01.
# Edit freely, then run:  reproflow run cart
name: cart
description: Add two shirts and open the cart
base_url: http://localhost:3000
allowed_hosts: [localhost, 127.0.0.1]
params:
  quantity: { type: number, default: 2 }
steps:
  - goto: /products/TSHIRT-M
  - fill:
      target: { role: spinbutton, name: Quantity }
      value: "{{quantity}}"
  - click: { role: button, name: Add to cart }
  - click: { role: link, name: Cart }
  - wait_for: { role: status, name: Total }
  - expect_url: /cart
on_fail: capture
```

### `reproflow init`

Sets the current project up for agents, and is safe to run again.

```console
$ reproflow init
{"ok":true,"status":"initialized","root":"/work/shop","created":[".reproflow/flows/example.yaml",".gitignore",".agents/skills/reproflow/SKILL.md",".claude/skills/reproflow/SKILL.md","AGENTS.md","CLAUDE.md"],"updated":[],"unchanged":[],"next":"Run `reproflow list`. Record your own flow with `reproflow do ...` then `reproflow save <name> --from-session`."}
```

It creates `.reproflow/flows/` with `example.yaml`, adds `.reproflow/runs/`,
`.reproflow/session.jsonl` and `.reproflow/stats.jsonl` to `.gitignore`, writes the same
`SKILL.md` to `.agents/skills/reproflow/` and `.claude/skills/reproflow/`, and puts this note between
`<!-- reproflow:start -->` and `<!-- reproflow:end -->` in `AGENTS.md` and `CLAUDE.md` (creating them
if missing, keeping everything else, never duplicating the block):

> Browser checks: use the reproflow CLI. Run `reproflow list` first. Never write Playwright, Selenium
> or pyautogui scripts for routine browser steps.

`init` rewrites the two `SKILL.md` files and the note block to the current text, so keep your own
skills under other names. It never overwrites `example.yaml`.

### `reproflow stats [--since <days>] [--tokens-per-step <n>]`

Totals from `.reproflow/stats.jsonl`, where every run and capture appends
`{ts, flow, status, duration_ms, steps, digest_chars}`.

```console
$ reproflow stats
{"ok":true,"runs":12,"passed":9,"failed":3,"errors":0,"pass_rate":0.75,"median_duration_ms":1480,"top_failing_flows":[{"flow":"repro-cart-total","failures":3,"runs":8}],"tokens_avoided_estimate":41610,"tokens_per_step":3800,"estimate_note":"estimate, not a measurement: sum over runs of steps x 3800 - digest chars / 4"}
```

`tokens_avoided_estimate` is an **estimate**: for each run, `steps x 3,800 - digest characters / 4`
(never below zero), summed. 3,800 is a rough cost for the screenshot, page dump and reasoning an agent
spends per browser step; change it with `--tokens-per-step`, `REPROFLOW_TOKENS_PER_STEP` or
`"tokens_per_step"` in `.reproflow/config.json`.

### `reproflow mcp`

An MCP server over stdio, for agents and clients that prefer tools to a CLI. It works on the project
it is started in and exposes four tools. Each returns the same digest JSON the CLI prints, as one
text block:

| Tool                | Arguments                                                      | Same as                         |
| ------------------- | -------------------------------------------------------------- | ------------------------------- |
| `reproflow_list`    | none                                                           | `reproflow list`                |
| `reproflow_run`     | `flow`, `params?` (object), `headed?`, `trace?`, `keep_going?` | `reproflow run`                 |
| `reproflow_capture` | `full_page?`, `locator?`                                       | `reproflow capture`             |
| `reproflow_save`    | `name`, `description?`, `last?`, `force?`                      | `reproflow save --from-session` |

```bash
claude mcp add reproflow -- reproflow mcp
```

or, in any client's MCP config:

```json
{ "mcpServers": { "reproflow": { "command": "reproflow", "args": ["mcp"] } } }
```

A failing flow is a normal result (`ok: false`, `status: "failed"`); a tool result is marked
`isError` only when the call could not run (unknown flow, invalid YAML, no browser, a refused save).
`reproflow_run` replays flows; to explore a page step by step use the `reproflow do` CLI, which
records the session that `reproflow_save` turns into a flow.

Calling `reproflow_list` returns (shown here as the tool result a client receives):

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"flows\":[{\"name\":\"repro-cart-total\",\"description\":\"Add a product and check the cart total\",\"params\":[\"sku:string\"]}]}"
    }
  ]
}
```

## Flow file format

Flows live in `.reproflow/flows/<name>.yaml`. A JSON Schema for editors is in
`schema/flow.schema.json`.

```yaml
name: repro-cart-total
description: Add a product and check the cart total
base_url: http://localhost:3000
allowed_hosts: [localhost, 127.0.0.1]
params:
  sku: { type: string, default: TSHIRT-M }
  password: { type: string, secret: true, env: SHOP_PASSWORD }
steps:
  - goto: /products/{{sku}}
  - click: { role: button, name: Add to cart }
  - click: { role: link, name: Cart }
  - expect_text: { target: { role: status, name: Total }, text: "$25.00" }
on_fail: capture
```

- **`base_url`**: relative `goto` URLs resolve against it. **`allowed_hosts`**: hostnames a run may
  navigate to (`*.example.com` matches subdomains). `localhost` and `127.0.0.1` are always allowed.
  A navigation to any other host fails with `host_not_allowed`: a `goto`, a link click or a form post
  is blocked before any request is sent; a redirect to another host cannot be intercepted by
  Playwright, so it is caught as soon as the browser requests it.
- **`params`**: `type` is `string`, `number` or `boolean`. A value comes from `--name=value`, then the
  param's `env` variable, then its `default`. A param with no default is required unless it says
  `required: false`. `secret: true` params are masked everywhere and may not have a default.
- **Templating**: `{{param}}` and `{{env.NAME}}` work in any string of a step and in `base_url`. An
  unknown name is a `flow_invalid` error. Values read through `{{env.NAME}}` are treated as secrets.
- **Locators** are objects with one of `role` (+ `name`), `label`, `text`, `placeholder`, `testid`
  or `css`, plus optional `exact: true` and `nth: <int>`.
- **Every step** may set `timeout_ms` (default 10000) and `optional: true` (a failure is skipped).
- **`on_fail`**: `capture` (default) writes the evidence bundle when a step fails; `none` skips the
  screenshot and snapshot (logs and `run.json` are still written).

| Step                                              | Shape                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `goto`                                            | `goto: /path` or a full URL                                                                |
| `click`, `hover`, `check`, `uncheck`, `scroll_to` | `click: <locator>`                                                                         |
| `fill`                                            | `fill: {target: <locator>, value: text}`                                                   |
| `select`                                          | `select: {target: <locator>, value: option value or label}`                                |
| `press`                                           | `press: Enter`                                                                             |
| `switch_tab`                                      | `switch_tab: 1` (0-based index) or `switch_tab: help` (URL or title substring)             |
| `wait_for`                                        | `wait_for: <locator>` or `{target: <locator>, state: visible\|hidden\|attached\|detached}` |
| `expect_text`                                     | `expect_text: {target: <locator>, text: "...", exact: false}`                              |
| `expect_visible`, `expect_hidden`                 | `expect_visible: <locator>`                                                                |
| `expect_url`                                      | `expect_url: /cart` (path + query must match), `{contains: cart}` or `{matches: "^/c"}`    |
| `screenshot`                                      | `screenshot: true` or `{name, full_page, target}`; saved in the run folder                 |
| `capture`                                         | `capture: true` or `{full_page, target}`; a full evidence bundle in `capture-<n>/`         |

Validation reports every problem with its YAML path and line, for example
`steps[0].click (line 5): Unrecognized key: "rol"`.

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

## Security

- The daemon listens on `127.0.0.1` only, on a random port, and answers only requests that carry its
  random 32-byte bearer token. The token lives in `~/.reproflow/daemons/<sha1 of project root>.json`,
  created with mode `0600` (best effort on Windows), and is never printed.
- Secret values are never printed or stored: not in digests, `session.jsonl`, `run.json`, the
  `.jsonl` logs or the aria snapshot. That covers secret params, `{{env.NAME}}` values and anything
  typed into a password field. Screenshots cannot be masked.
- A flow may only navigate to `localhost`, `127.0.0.1` and its `allowed_hosts`.
- reproflow makes no network calls of its own: only the pages you test, and the Playwright browser
  download that `reproflow doctor --fix` starts. There is no telemetry and no AI call inside it.
- Your browser profile (`~/.reproflow/profiles/<name>/`) holds your logins, like any browser profile.
  Session cookies are also kept in `reproflow-cookies.json` inside it (mode `0600`) so a login
  survives the daemon restarting.

## Troubleshooting

| Symptom                                             | Fix                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `browser_unavailable`: Chromium is not installed    | `reproflow doctor --fix`                                                                                                     |
| `browser_unavailable`: the profile is in use        | another project's session holds it: `reproflow session stop` there, or use `--profile <name>`                                |
| `daemon_unavailable`                                | `reproflow session stop`, then retry; `reproflow doctor --fix` clears a stuck daemon                                         |
| `auth_expired`                                      | `reproflow login <url>`                                                                                                      |
| `host_not_allowed`                                  | add the host to the flow's `allowed_hosts` if the navigation is intended                                                     |
| `do goto /cart` becomes `C:/Program Files/Git/cart` | Git Bash rewrites leading `/`: use a full URL or `MSYS_NO_PATHCONV=1`                                                        |
| a flow passes locally and fails in CI               | CI has a fresh profile: sign in there first (`login`, or a flow that signs in with a secret param read from the environment) |

Run state lives in `.reproflow/` (flows are meant to be committed; `runs/`, `session.jsonl` and
`stats.jsonl` are git-ignored by `init`) and in `~/.reproflow/` (daemons and browser profiles;
`REPROFLOW_HOME` moves it).

## Development

```bash
npm install
npx playwright install chromium
npm run build        # bundles the CLI and regenerates schema/flow.schema.json
npm run typecheck && npm run lint && npm test
npm run demo         # the end-to-end walkthrough from the quickstart
```

Requires Node.js >= 22. The integration tests drive the built CLI against `test/fixtures/shop-app`
with a headless Chromium. Where the Playwright browser download is blocked, set
`REPROFLOW_BROWSER_CHANNEL=chrome` (or `msedge`) and the tests use that browser instead.

CI (`.github/workflows/ci.yml`) runs build, typecheck, lint and the tests on Ubuntu, macOS and
Windows with Node 22, then `npm pack --dry-run`. Design choices are in [DECISIONS.md](DECISIONS.md) and
the build log in [PLAN.md](PLAN.md).

## License

MIT
