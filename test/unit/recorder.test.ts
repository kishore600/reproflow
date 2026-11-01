import { describe, expect, it } from 'vitest';
import { ReproflowError } from '../../src/errors.js';
import { parseFlow } from '../../src/flows/load.js';
import { MAX_RECORDED_ACTIONS, recordFlow } from '../../src/flows/recorder.js';
import type { ElementMeta, SessionEntry } from '../../src/flows/session-log.js';

const SHOP = 'http://localhost:3000';

function entry(
  action: string,
  target: string | null,
  url: string,
  extra: Partial<SessionEntry> = {},
): SessionEntry {
  return { ts: '2026-11-01T00:00:00.000Z', action, target, value: null, url, ok: true, ...extra };
}

const fill = (
  target: string,
  value: string,
  el: ElementMeta,
  url = `${SHOP}/login`,
): SessionEntry => entry('fill', target, url, { value, el });

const record = (entries: SessionEntry[], extra: { name?: string; last?: number } = {}) =>
  recordFlow(entries, {
    name: extra.name ?? 'cart',
    last: extra.last,
    now: new Date('2026-11-01'),
  });

const cartSession = (): SessionEntry[] => [
  entry('goto', `${SHOP}/products/TSHIRT-M`, `${SHOP}/products/TSHIRT-M`),
  entry('click', 'text="Add to cart"', `${SHOP}/products/TSHIRT-M`, {
    el: { role: 'button', name: 'Add to cart', unique: true },
  }),
  entry('click', 'role=link[name="Cart"]', `${SHOP}/cart`, {
    el: { role: 'link', name: 'Cart', unique: true },
  }),
];

describe('recordFlow', () => {
  it('records gotos relative to base_url, prefers role+name, and ends with expect_url', () => {
    const { flow } = record(cartSession());
    expect(flow.base_url).toBe(SHOP);
    expect(flow.allowed_hosts).toEqual(['localhost', '127.0.0.1']);
    expect(flow.on_fail).toBe('capture');
    expect(flow.steps).toEqual([
      { goto: '/products/TSHIRT-M' },
      { click: { role: 'button', name: 'Add to cart' } }, // upgraded from text="Add to cart"
      { click: { role: 'link', name: 'Cart' } },
      { expect_url: '/cart' },
    ]);
  });

  it('keeps the original locator when role+name is not unique, or the action already used a role', () => {
    const { flow } = record([
      entry('goto', `${SHOP}/`, `${SHOP}/`),
      entry('click', 'css=.buy', `${SHOP}/`, {
        el: { role: 'button', name: 'Buy', unique: false },
      }),
      entry('click', 'css=.help', `${SHOP}/`, {
        el: { role: 'generic', name: 'Help', unique: true },
      }),
      entry('click', 'role=button[name="Save"] >> nth=1', `${SHOP}/`, {
        el: { role: 'button', name: 'Save', unique: true },
      }),
    ]);
    expect(flow.steps.slice(1, 4)).toEqual([
      { click: { css: '.buy' } },
      { click: { css: '.help' } },
      { click: { role: 'button', name: 'Save', nth: 1 } },
    ]);
  });

  it('turns typed values into params named from the field label', () => {
    const { flow } = record([
      entry('goto', `${SHOP}/products/TSHIRT-M`, `${SHOP}/products/TSHIRT-M`),
      fill('label="Quantity"', '2', {
        type: 'number',
        label: 'Quantity',
        role: 'spinbutton',
        name: 'Quantity',
        unique: true,
      }),
      fill('placeholder="Gift note"', 'Happy birthday', { type: 'text', placeholder: 'Gift note' }),
      fill('label="Quantity"', '3', {
        type: 'number',
        label: 'Quantity',
        role: 'spinbutton',
        name: 'Quantity',
        unique: true,
      }),
      fill('css=#zip', '02139', { type: 'text' }),
    ]);
    expect(flow.params).toEqual({
      quantity: { type: 'number', default: 2 },
      gift_note: { type: 'string', default: 'Happy birthday' },
      quantity_2: { type: 'number', default: 3 },
      value: { type: 'string', default: '02139' }, // no label to name it from
    });
    expect(flow.steps[1]).toEqual({
      fill: { target: { role: 'spinbutton', name: 'Quantity' }, value: '{{quantity}}' },
    });
  });

  it('never writes a password: it becomes a secret param reading <FLOW>_PASSWORD', () => {
    const recording = record(
      [
        entry('goto', `${SHOP}/login`, `${SHOP}/login`),
        fill('label="Email"', 'demo@example.com', {
          type: 'email',
          label: 'Email',
          role: 'textbox',
          name: 'Email',
          unique: true,
        }),
        // The daemon logs "***" (or the env template) for password fields, never the real value.
        fill('label="Password"', '***', {
          type: 'password',
          label: 'Password',
          role: 'textbox',
          name: 'Password',
          unique: true,
        }),
        entry('click', 'role=button[name="Sign in"]', `${SHOP}/`, {
          el: { role: 'button', name: 'Sign in', unique: true },
        }),
      ],
      { name: 'repro-login' },
    );
    expect(recording.flow.params?.password).toEqual({
      type: 'string',
      secret: true,
      env: 'REPRO_LOGIN_PASSWORD',
    });
    expect(recording.flow.params?.email).toEqual({ type: 'string', default: 'demo@example.com' });
    expect(recording.secrets).toEqual([{ param: 'password', env: 'REPRO_LOGIN_PASSWORD' }]);
    expect(recording.yaml).not.toContain('***');
    expect(recording.yaml).toContain('env: REPRO_LOGIN_PASSWORD');
    expect(recording.yaml).toContain('{{password}}');
    expect(recording.yaml).toContain('# Secrets are never saved. Set REPRO_LOGIN_PASSWORD');
  });

  it('keeps the env var a {{env.NAME}} template named, and treats that field as secret', () => {
    const { flow, yaml } = record([
      entry('goto', `${SHOP}/settings`, `${SHOP}/settings`),
      fill(
        'label="API key"',
        '{{env.SHOP_API_KEY}}',
        { type: 'text', label: 'API key' },
        `${SHOP}/settings`,
      ),
    ]);
    expect(flow.params?.api_key).toEqual({ type: 'string', secret: true, env: 'SHOP_API_KEY' });
    expect(yaml).not.toContain('{{env.');
  });

  it('starts at the last goto to a new origin', () => {
    const { flow } = record([
      entry('goto', 'https://example.com/docs', 'https://example.com/docs'),
      entry('click', 'text="Pricing"', 'https://example.com/pricing'),
      entry('goto', `${SHOP}/a`, `${SHOP}/a`),
      entry('click', 'text="One"', `${SHOP}/b`),
      entry('goto', `${SHOP}/c`, `${SHOP}/c`), // same origin as before: not a new origin
      entry('click', 'text="Two"', `${SHOP}/d`),
    ]);
    expect(flow.base_url).toBe(SHOP);
    expect(flow.steps).toEqual([
      { goto: '/a' },
      { click: { text: 'One' } },
      { goto: '/c' },
      { click: { text: 'Two' } },
      { expect_url: '/d' },
    ]);
  });

  it('allows the hosts the recording visits and absolutizes cross-origin gotos', () => {
    const { flow } = record([
      entry('goto', 'https://staging.example.com/app', 'https://staging.example.com/app'),
      entry('goto', 'https://sso.example.org/in', 'https://sso.example.org/in'),
    ]);
    // sso.example.org is the last new origin, so it alone is recorded.
    expect(flow.base_url).toBe('https://sso.example.org');
    expect(flow.allowed_hosts).toEqual(['localhost', '127.0.0.1', 'sso.example.org']);

    const mixed = record(
      [
        entry('goto', `${SHOP}/a`, `${SHOP}/a`),
        entry('goto', 'https://pay.example.com/checkout', `${SHOP}/a`),
      ],
      { last: 2 },
    );
    expect(mixed.flow.steps[1]).toEqual({ goto: 'https://pay.example.com/checkout' });
    expect(mixed.flow.allowed_hosts).toContain('pay.example.com');
  });

  it('resolves a typed relative goto against the page it was typed on', () => {
    const { flow } = record([
      entry('goto', `${SHOP}/`, `${SHOP}/`),
      entry('goto', '/cart', `${SHOP}/cart`),
    ]);
    expect(flow.steps.slice(0, 2)).toEqual([{ goto: '/' }, { goto: '/cart' }]);
  });

  it('honours --last and begins at the page that action ran on', () => {
    const entries = [
      ...cartSession(),
      entry('click', 'text="Pay"', `${SHOP}/pay`, {
        el: { role: 'button', name: 'Pay', unique: true },
      }),
    ];
    const { flow, actions } = record(entries, { last: 2 });
    expect(actions).toBe(2);
    expect(flow.steps).toEqual([
      { goto: '/products/TSHIRT-M' }, // where the click on "Cart" started
      { click: { role: 'link', name: 'Cart' } },
      { click: { role: 'button', name: 'Pay' } },
      { expect_url: '/pay' },
    ]);
  });

  it('skips failed actions and screenshots, and caps an automatic range at 50 actions', () => {
    const noisy = [
      entry('goto', `${SHOP}/`, `${SHOP}/`),
      entry('click', 'text="Nope"', `${SHOP}/`, { ok: false }),
      entry('screenshot', null, `${SHOP}/`),
      entry('click', 'text="Real"', `${SHOP}/next`),
    ];
    expect(record(noisy).flow.steps).toEqual([
      { goto: '/' },
      { click: { text: 'Real' } },
      { expect_url: '/next' },
    ]);

    const many = [
      entry('goto', `${SHOP}/`, `${SHOP}/`),
      ...Array.from({ length: 80 }, (_, i) =>
        entry('press', 'Tab', `${SHOP}/`, { value: String(i) }),
      ),
    ];
    const capped = record(many);
    expect(capped.actions).toBe(MAX_RECORDED_ACTIONS);
    expect(capped.flow.steps[0]).toEqual({ goto: '/' }); // begins at the page the first kept action ran on
  });

  it('records tabs, keys, scrolling and non-default wait states', () => {
    const { flow } = record([
      entry('goto', `${SHOP}/`, `${SHOP}/`),
      entry('press', 'Enter', `${SHOP}/`),
      entry('scroll-to', 'css=footer', `${SHOP}/`),
      entry('wait-for', 'css=.spinner', `${SHOP}/`, { value: 'hidden' }),
      entry('wait-for', 'role=status', `${SHOP}/`, { value: 'visible' }),
      entry('switch-tab', '1', `${SHOP}/help`),
      entry('switch-tab', 'help', `${SHOP}/help`),
    ]);
    expect(flow.steps.slice(1, 7)).toEqual([
      { press: 'Enter' },
      { scroll_to: { css: 'footer' } },
      { wait_for: { target: { css: '.spinner' }, state: 'hidden' } },
      { wait_for: { role: 'status' } },
      { switch_tab: 1 },
      { switch_tab: 'help' },
    ]);
  });

  it('writes YAML that its own validator accepts, with a header and one-line maps', () => {
    const { yaml } = record(cartSession());
    expect(
      yaml.startsWith('# Recorded by reproflow from `reproflow do` actions on 2026-11-01.'),
    ).toBe(true);
    expect(yaml).toContain('# Edit freely, then run:  reproflow run cart');
    expect(yaml).toContain('allowed_hosts: [localhost, 127.0.0.1]');
    expect(yaml).toContain('- click: {role: button, name: Add to cart}');
    expect(yaml).toContain('- expect_url: /cart');
    expect(parseFlow(yaml, 'cart.yaml').steps).toHaveLength(4);
  });

  it('refuses to record nothing', () => {
    for (const entries of [
      [],
      [entry('click', 'text="x"', SHOP, { ok: false })],
      [entry('screenshot', null, SHOP)],
    ]) {
      expect(() => record(entries)).toThrow(ReproflowError);
    }
  });
});
