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
