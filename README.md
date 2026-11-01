# reproflow

Saved, replayable browser flows and one-call debug evidence for AI coding agents
(Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI).

Instead of writing a throwaway Playwright, Selenium or pyautogui script every time, an agent runs
short CLI commands against a real Chromium that stays open in a background daemon with a saved
login. It can capture debug evidence in one call, save a sequence of steps as a named YAML flow in
the repo, and replay that flow later with zero AI calls. Every command prints a compact JSON digest
(at most 2,000 characters) with paths to screenshots and logs on disk.

> Status: under construction. This README grows with each build phase; see [PLAN.md](PLAN.md).

## Development

```bash
npm install
npx playwright install chromium
npm run build
npm run typecheck && npm run lint && npm test
```

Requires Node.js >= 22.
