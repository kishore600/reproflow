import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_EMAIL,
  DEMO_PASSWORD,
  type ShopApp,
  startShopApp,
} from '../fixtures/shop-app/server.mjs';

let shop: ShopApp;

beforeAll(async () => {
  shop = await startShopApp();
});
afterAll(() => shop.close());

async function login(): Promise<string> {
  const res = await fetch(`${shop.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: DEMO_EMAIL, password: DEMO_PASSWORD, next: '/cart' }),
  });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/cart');
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

describe('shop-app fixture', () => {
  it('redirects protected pages to /login without the cookie', async () => {
    const res = await fetch(`${shop.url}/cart`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?next=%2Fcart');
  });

  it('rejects a wrong password', async () => {
    const res = await fetch(`${shop.url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: DEMO_EMAIL, password: 'nope' }),
    });
    expect(res.status).toBe(401);
  });

  it('totals $25.00 for one TSHIRT-M and fails with 500 when the bug is on', async () => {
    const cookie = await login();
    const headers = { cookie, 'content-type': 'application/json' };
    const add = await fetch(`${shop.url}/api/cart`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sku: 'TSHIRT-M', qty: 1 }),
    });
    expect(add.status).toBe(200);

    const ok = await fetch(`${shop.url}/api/cart`, { headers });
    expect(await ok.json()).toMatchObject({ total: 2500 });

    shop.setBug(true);
    const broken = await fetch(`${shop.url}/api/cart`, { headers });
    expect(broken.status).toBe(500);
    shop.setBug(false);
  });

  it('serves /help publicly for the new-tab link', async () => {
    const res = await fetch(`${shop.url}/help`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Help - Shop</title>');
  });
});
