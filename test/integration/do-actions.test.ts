import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, DEMO_PASSWORD, type Harness } from '../helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.stop());

describe('do actions against the shop app', () => {
  it('reports auth_expired when a protected page redirects to /login', async () => {
    const { digest, code } = await h.act('goto', `${h.shop.url}/cart`);
    expect(code).toBe(1);
    expect(digest.ok).toBe(false);
    expect(digest.error.code).toBe('auth_expired');
    expect(digest.error.hint).toContain('reproflow login');
    expect(digest.url).toContain('/login');
  });

  it('signs in with fill (password via an env template) and click', async () => {
    await h.signIn();
    const { digest } = await h.act('wait-for', 'role=heading[name="Shop"]');
    expect(digest).toMatchObject({ ok: true, title: 'Shop' });
    expect(digest.url).toBe(`${h.shop.url}/`);
  });

  it('resolves relative gotos against the current page', async () => {
    const { digest } = await h.act('goto', '/products/TSHIRT-M');
    expect(digest).toMatchObject({ ok: true, url: `${h.shop.url}/products/TSHIRT-M` });
  });

  it('waits for the add-to-cart request before the next action', async () => {
    await h.act('fill', 'label="Quantity"', '1');
    const click = await h.act('click', 'role=button[name="Add to cart"]');
    expect(click.digest.ok).toBe(true);
    // The click only returns once the 300-800 ms POST finished, so the notice is already there.
    const notice = await h.act('wait-for', 'role=status[name="Cart notice"]', '--timeout', '3000');
    expect(notice.digest.ok).toBe(true);
  });

  it('navigates by link and finds the total', async () => {
    await h.act('click', 'role=link[name="Cart"]');
    const total = await h.act('wait-for', 'role=status[name="Total"]');
    expect(total.digest).toMatchObject({ ok: true, url: `${h.shop.url}/cart` });
  });

  it('takes screenshots (page and element) into a run folder', async () => {
    const page = await h.act('screenshot');
    expect(page.digest.evidence.screenshot).toMatch(
      /\/\.reproflow\/runs\/\d{8}-\d{6}-do-screenshot\/screenshot\.png$/,
    );
    expect(existsSync(page.digest.evidence.screenshot)).toBe(true);

    const element = await h.act('screenshot', '--locator', 'role=status[name="Total"]');
    expect(element.digest.evidence.screenshot).toMatch(/element\.png$/);
    expect(existsSync(element.digest.evidence.screenshot)).toBe(true);
  });

  it('presses keys and scrolls to elements', async () => {
    expect((await h.act('scroll-to', 'role=status[name="Total"]')).digest.ok).toBe(true);
    expect((await h.act('press', 'Tab')).digest.ok).toBe(true);
  });

  it('switches tabs by url substring, title substring and index', async () => {
    await h.act('goto', '/');
    const open = await h.act('click', 'role=link[name="Help (new tab)"]');
    expect(open.digest.ok).toBe(true);
    // The click opened a second tab but the active tab did not change.
    expect(open.digest.url).toBe(`${h.shop.url}/`);

    const byUrl = await h.act('switch-tab', '/help');
    expect(byUrl.digest).toMatchObject({
      ok: true,
      url: `${h.shop.url}/help`,
      title: 'Help - Shop',
    });

    const heading = await h.act('wait-for', 'role=heading[name="Help"]');
    expect(heading.digest.ok).toBe(true);

    const byIndex = await h.act('switch-tab', '0');
    expect(byIndex.digest.url).toBe(`${h.shop.url}/`);

    const byTitle = await h.act('switch-tab', 'help - shop');
    expect(byTitle.digest.url).toBe(`${h.shop.url}/help`);

    const status = (await h.cli(['session', 'status'])).json<{ tabs: unknown[] }>();
    expect(status.tabs).toHaveLength(2);

    const missing = await h.act('switch-tab', 'no-such-tab', '--timeout', '500');
    expect(missing.code).toBe(1);
    expect(missing.digest.error.code).toBe('assertion_failed');
  });

  it('fails with locator_not_found for a missing element', async () => {
    await h.act('switch-tab', '0');
    const { digest, code } = await h.act('click', 'role=button[name="Nope"]', '--timeout', '800');
    expect(code).toBe(1);
    expect(digest.error.code).toBe('locator_not_found');
  });

  it('fails with navigation_timeout when nothing is listening', async () => {
    const { digest, code } = await h.act('goto', 'http://127.0.0.1:9/', '--timeout', '3000');
    expect(code).toBe(1);
    expect(digest.error.code).toBe('navigation_timeout');
  });

  it('exits 2 on usage errors without touching the browser', async () => {
    const missing = await h.cli(['do', 'click']);
    expect(missing.code).toBe(2);
    const unknown = await h.cli(['do', 'dance']);
    expect(unknown.code).toBe(2);
    const badLocator = await h.cli(['do', 'click', 'button']);
    expect(badLocator.code).toBe(2);
    expect(badLocator.stderr).toContain('unrecognised locator');
  });

  it('logs every action and never writes the password', () => {
    const log = h.readJsonl('.reproflow/session.jsonl');
    const raw = readFileSync(`${h.project}/.reproflow/session.jsonl`, 'utf8');
    expect(raw).not.toContain(DEMO_PASSWORD);

    const password = log.find((e) => e.action === 'fill' && e.target === 'label="Password"');
    expect(password).toMatchObject({ value: '{{env.SHOP_PASSWORD}}', ok: true });
    expect(password?.el).toMatchObject({ type: 'password', role: 'textbox', name: 'Password' });

    const email = log.find((e) => e.action === 'fill' && e.target === 'label="Email"');
    expect(email).toMatchObject({
      value: 'demo@example.com',
      el: { label: 'Email', type: 'email' },
    });

    const add = log.find((e) => e.target === 'role=button[name="Add to cart"]');
    expect(add).toMatchObject({
      action: 'click',
      ok: true,
      el: { role: 'button', name: 'Add to cart', unique: true },
    });

    expect(log.some((e) => e.action === 'click' && e.ok === false)).toBe(true);
    expect(log.every((e) => typeof e.ts === 'string' && typeof e.url === 'string')).toBe(true);
  });

  it('keeps the login across a daemon restart (session cookie jar)', async () => {
    await h.cli(['session', 'stop']);
    const { digest } = await h.act('goto', `${h.shop.url}/cart`);
    expect(digest.ok).toBe(true);
    expect(digest.url).toBe(`${h.shop.url}/cart`);
  });

  it('login opens the profile, waits for Enter and saves', async () => {
    const result = await h.cli(['login', `${h.shop.url}/login`, '--profile', 'work'], {
      input: '\n',
    });
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ ok: true, status: 'saved', profile: 'work' });
    expect(result.stderr).toContain('press Enter');
  });
});
