# reproflow build plan

Resume a fresh session with: **"Continue the build from PLAN.md"**.

Rules for every phase: run `npm run typecheck`, `npm run lint` and `npm test`; fix every failure;
update README.md; then one commit named `phase N: <summary>`.

Decisions that deviate from or interpret the brief live in [DECISIONS.md](DECISIONS.md).

## Phase 1 - Scaffold

- [x] package.json (bin, scripts build/dev/typecheck/lint/test/demo), tsconfig, biome, vitest, tsup
- [x] CLI skeleton with `--help` and `--version`, one file per command in `src/cli/`
- [x] Shop test app (`test/fixtures/shop-app`)
- [x] PLAN.md, DECISIONS.md, LICENSE, README stub
- [x] typecheck, lint, test green; commit `phase 1`

## Phase 2 - Daemon, profiles, session, login, `do` (also: collectors, step engine, flow step schema)

- [x] Project root + `~/.reproflow` paths (`REPROFLOW_HOME` override)
- [x] Daemon: 127.0.0.1 random port, bearer token, 0600 state file, JSON-RPC `POST /rpc`
- [x] Persistent Chromium context per profile, 1280x800, headless by default
- [x] Idle shutdown (30 min), stale state cleanup, `session start|stop|status`
- [x] Daemon client: auto-start, restart on profile/headed change
- [x] `login <url>` (headed, wait for Enter)
- [x] Locator shorthand parser + Playwright mapping
- [x] All `do` actions + `.reproflow/session.jsonl`
- [x] Unit tests: locator parsing; integration: daemon lifecycle, `do` actions, switch-tab

## Phase 3 - Evidence, capture, digest

- [x] Per-page collectors (console error/warning, pageerror, requestfailed, status >= 400), ring of 200 (landed in phase 2)
- [x] Evidence bundle writer + run folders + keep last 50
- [x] Digest builder, 2,000-character truncation, text renderer
- [x] `capture [--full-page] [--locator]`
- [x] Secret masking
- [x] Unit tests: truncation, masking; integration: capture writes every file

## Phase 4 - Flows and `run`

- [x] Zod flow schema (landed in phase 2 with the step engine)
- [x] JSON Schema export to `schema/flow.schema.json`
- [x] Loader with YAML paths, templating, param resolution
- [x] `list`, `describe`
- [x] Step executor, host allowlist, auth_expired detection, error codes
- [x] Locator candidates (Levenshtein over the aria snapshot)
- [x] `run` with `--headed`, `--trace`, `--keep-going`
- [x] Integration: pass/fail with bug on/off, candidates, auth_expired

## Phase 5 - Recorder, init, stats

- [x] `save --from-session` (params, secrets, base_url, role+name preference, expect_url)
- [x] `init` (flows dir, example, .gitignore, SKILL.md x2, AGENTS.md/CLAUDE.md note)
- [x] `stats` + `.reproflow/stats.jsonl`
- [x] Integration: saved flow passes

## Phase 6 - Plugin, doctor, docs, CI

- [ ] Claude Code plugin + PreToolUse hook + root marketplace file (read the official docs first)
- [ ] `doctor [--fix]`
- [ ] README: 60-second quickstart + full command reference
- [ ] `.github/workflows/ci.yml` (ubuntu, macos, windows; Node 22)
- [ ] `npm pack --dry-run` check
- [ ] `npm run demo`

## Phase 7 - MCP (only if 1-6 fully green)

- [ ] `reproflow mcp` over stdio with reproflow_list/run/capture/save

## Definition of done

- [ ] build, typecheck, lint, test pass
- [ ] `npm run demo` shows a failing digest (< 2,000 chars, console error + 500) then a passing one
- [ ] README documents every command with an example and its JSON output
- [ ] REPORT.md written
