import { describe, expect, it } from 'vitest';
import { parseAriaNodes, rankCandidates } from '../../src/engine/candidates.js';

const SNAPSHOT = `
- navigation:
  - link "Home":
    - /url: /
  - link "Cart":
    - /url: /cart
  - link "Help (new tab)":
    - /url: /help
- heading "T-Shirt (M)" [level=1]
- paragraph: "Price: $25.00"
- text: Price $25.00
- spinbutton "Quantity": "1"
- button "Add to cart"
- status "Cart notice"
- button "Add to cart [disabled]" [disabled]
`;

describe('parseAriaNodes', () => {
  it('reads roles and accessible names, skipping unnamed structure and /url lines', () => {
    const nodes = parseAriaNodes(SNAPSHOT);
    expect(nodes).toContainEqual({ role: 'link', name: 'Cart' });
    expect(nodes).toContainEqual({ role: 'heading', name: 'T-Shirt (M)' });
    expect(nodes).toContainEqual({ role: 'spinbutton', name: 'Quantity' });
    expect(nodes).toContainEqual({ role: 'text', name: 'Price $25.00' });
    expect(nodes.some((node) => node.role === 'navigation')).toBe(false);
    expect(nodes.some((node) => node.name.startsWith('/'))).toBe(false);
  });
});

describe('rankCandidates', () => {
  const nodes = parseAriaNodes(SNAPSHOT);

  it('puts the closest name first and rounds scores to 2 decimals', () => {
    const ranked = rankCandidates({ role: 'button', name: 'Add to cat' }, nodes);
    expect(ranked[0]).toMatchObject({ locator: 'role=button[name="Add to cart"]', role: 'button' });
    expect(ranked[0].score).toBeGreaterThan(0.8);
    expect(String(ranked[0].score)).toMatch(/^\d(\.\d{1,2})?$/);
  });

  it('prefers the right role when names are equally close', () => {
    const ranked = rankCandidates({ role: 'link', name: 'Cart' }, nodes);
    expect(ranked[0].locator).toBe('role=link[name="Cart"]');
    expect(ranked.length).toBeLessThanOrEqual(3);
  });

  it('is sorted by score, descending, with at most 3 entries', () => {
    const ranked = rankCandidates({ role: 'button', name: 'Add to cart' }, nodes);
    const scores = ranked.map((candidate) => candidate.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(ranked.length).toBeLessThanOrEqual(3);
  });

  it('ranks by name alone for label, text, placeholder and testid locators', () => {
    expect(rankCandidates({ label: 'Quantiy' }, nodes)[0]).toMatchObject({ name: 'Quantity' });
    expect(rankCandidates({ text: 'Help' }, nodes)[0].name).toBe('Help (new tab)');
  });

  it('turns bare text nodes into text locators', () => {
    const ranked = rankCandidates({ text: 'Price $25.0' }, nodes);
    expect(ranked[0].locator).toBe('text="Price $25.00"');
  });

  it('offers nothing for CSS locators or when nothing is similar', () => {
    expect(rankCandidates({ css: '.nope' }, nodes)).toEqual([]);
    expect(
      rankCandidates({ role: 'button', name: 'zzzzzzzzzzzzzzzz' }, [
        { role: 'link', name: 'Home' },
      ]),
    ).toEqual([]);
  });

  it('lists each role+name once', () => {
    const ranked = rankCandidates({ role: 'button', name: 'Add to cart' }, [...nodes, ...nodes]);
    expect(new Set(ranked.map((candidate) => candidate.locator)).size).toBe(ranked.length);
  });
});
