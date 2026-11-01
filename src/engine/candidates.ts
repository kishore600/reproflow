import { distance } from 'fastest-levenshtein';
import type { Page } from 'playwright';
import type { LocatorSpec } from '../flows/schema.js';
import { truncate } from '../util.js';
import { formatLocator } from './locators.js';

export interface Candidate {
  /** Shorthand you can paste into `reproflow do` or turn into a flow step. */
  locator: string;
  role: string;
  name: string;
  score: number;
}

export interface AriaNode {
  role: string;
  name: string;
}

const MAX_CANDIDATES = 3;
const MIN_SCORE = 0.3;
const NAME_LIMIT = 80;

/** `- button "Add to cart"`, `- link "Cart":`, `- heading "Cart" [level=1]`, `- text: Some words`. */
const ARIA_LINE =
  /^-\s+([a-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s*\[[^\]]*\])*\s*(?::\s*(.*))?$/;

function unescapeName(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** Named elements (and bare text) from a Playwright aria snapshot. */
export function parseAriaNodes(snapshot: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  for (const line of snapshot.split('\n')) {
    const match = ARIA_LINE.exec(line.trim());
    if (!match) continue;
    const [, role, quoted, rest] = match;
    const name = quoted !== undefined ? unescapeName(quoted) : role === 'text' ? (rest ?? '') : '';
    if (name.trim()) nodes.push({ role, name: name.trim() });
  }
  return nodes;
}

function similarity(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 0;
  let score = 1 - distance(left, right) / longest;
  // "Add to cart" vs "Add to cart (2)": containment is a strong hint Levenshtein undersells.
  if (left && right && (left.includes(right) || right.includes(left)))
    score = Math.max(score, 0.75);
  return score;
}

/** The name-ish text a locator is looking for, and the role it requires (if any). */
function wantedOf(spec: LocatorSpec): { name: string; role?: string } | null {
  if ('role' in spec) return { name: spec.name ?? '', role: spec.role };
  if ('label' in spec) return { name: spec.label };
  if ('text' in spec) return { name: spec.text };
  if ('placeholder' in spec) return { name: spec.placeholder };
  if ('testid' in spec) return { name: spec.testid };
  return null; // CSS selectors carry no text to compare
}

function locatorFor(node: AriaNode): string {
  const name = truncate(node.name, NAME_LIMIT);
  return formatLocator(node.role === 'text' ? { text: name } : { role: node.role, name });
}

/**
 * Ranks page elements by how close they are to what a failed locator asked for, using Levenshtein
 * similarity on the accessible name (70%) and a role match (30%) for role locators.
 */
export function rankCandidates(
  spec: LocatorSpec,
  nodes: readonly AriaNode[],
  limit: number = MAX_CANDIDATES,
): Candidate[] {
  const wanted = wantedOf(spec);
  if (!wanted) return [];
  const seen = new Set<string>();
  const scored: Candidate[] = [];
  for (const node of nodes) {
    const key = `${node.role}\u0000${node.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let score: number;
    if (wanted.role !== undefined) {
      const roleMatch = node.role === wanted.role ? 1 : 0;
      score = wanted.name
        ? 0.7 * similarity(wanted.name, node.name) + 0.3 * roleMatch
        : 0.5 * roleMatch;
    } else {
      score = similarity(wanted.name, node.name);
    }
    if (score >= MIN_SCORE) {
      scored.push({
        locator: locatorFor(node),
        role: node.role,
        name: truncate(node.name, NAME_LIMIT),
        score: Math.round(score * 100) / 100,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Candidates from the live page; empty when the page cannot be snapshotted. */
export async function candidatesFor(page: Page, spec: LocatorSpec): Promise<Candidate[]> {
  try {
    const snapshot = await page.locator('body').ariaSnapshot({ timeout: 3_000 });
    return rankCandidates(spec, parseAriaNodes(snapshot));
  } catch {
    return [];
  }
}
