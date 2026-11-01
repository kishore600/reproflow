/**
 * The skill every supported agent reads. Written verbatim to .agents/skills/reproflow/SKILL.md and
 * .claude/skills/reproflow/SKILL.md by `reproflow init`, and shipped in the Claude Code plugin
 * (plugin/skills/reproflow/SKILL.md, kept identical by a test).
 */
export const SKILL_MD = `---
name: reproflow
description: Run saved browser flows and capture debug evidence for this project's web app. Use before writing any Playwright, Selenium or pyautogui script.
---
1. Run \`reproflow list\` and pick a flow that matches the task.
2. Run it: \`reproflow run <name> --<param>=<value>\`. Read the JSON digest.
3. Open screenshot or snapshot files only if the digest is not enough.
4. No matching flow? Reproduce with \`reproflow do <action>\` steps, then \`reproflow save <name> --from-session\`.
5. After fixing code, rerun the same flow to verify the fix.
6. If you get auth_expired, ask the user to run \`reproflow login <url>\`.
`;

export const AGENT_NOTE =
  'Browser checks: use the reproflow CLI. Run `reproflow list` first. Never write Playwright, Selenium or pyautogui scripts for routine browser steps.';

export const NOTE_START = '<!-- reproflow:start -->';
export const NOTE_END = '<!-- reproflow:end -->';

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/**
 * Puts the note between the reproflow markers: replaces an existing block in place, otherwise
 * appends one. Never duplicates it, and keeps everything else (and the file's line endings).
 */
export function upsertNote(existing: string | null): string {
  const eol = existing ? eolOf(existing) : '\n';
  const block = [NOTE_START, AGENT_NOTE, NOTE_END].join(eol);
  if (existing === null || existing.trim() === '') return `${block}${eol}`;
  const start = existing.indexOf(NOTE_START);
  const end = existing.indexOf(NOTE_END, start);
  if (start !== -1 && end !== -1) {
    return existing.slice(0, start) + block + existing.slice(end + NOTE_END.length);
  }
  return `${existing.replace(/\s*$/, '')}${eol}${eol}${block}${eol}`;
}

/** What `init` keeps out of git: run folders, the session log and stats. */
export const GITIGNORE_ENTRIES = [
  '.reproflow/runs/',
  '.reproflow/session.jsonl',
  '.reproflow/stats.jsonl',
];

/** Appends any missing entry (a leading "/" on an existing line is treated as the same entry). */
export function mergeGitignore(existing: string | null): string {
  const eol = existing ? eolOf(existing) : '\n';
  const have = new Set(
    (existing ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, ''))
      .filter(Boolean),
  );
  const missing = GITIGNORE_ENTRIES.filter((entry) => !have.has(entry));
  if (missing.length === 0 && existing !== null) return existing;
  const body = existing ? `${existing.replace(/\s*$/, '')}${eol}${eol}` : '';
  return `${body}# reproflow${eol}${missing.join(eol)}${eol}`;
}
