// A tiny framework-free shop used by reproflow's tests and demo.
//
//   node test/fixtures/shop-app/server.mjs        (PORT, SHOP_BUG=1, SHOP_PASSWORD optional)
//
// Design notes:
// - Protected pages redirect to /login without the session cookie.
// - Adding to cart *replaces* the cart contents instead of accumulating, so a saved flow
//   replays to the same total every time.
// - SHOP_BUG=1 makes /api/cart return 500; /cart then logs "TypeError: price is undefined"
//   and shows a $0.00 total.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEMO_EMAIL = 'demo@example.com';
export const DEMO_PASSWORD = process.env.SHOP_PASSWORD ?? 'correct-horse-9';

const CATALOG = {
  'TSHIRT-M': { name: 'T-Shirt (M)', price: 2500 },
  'TSHIRT-L': { name: 'T-Shirt (L)', price: 2500 },
  'HOODIE-L': { name: 'Hoodie (L)', price: 4500 },
};

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(title, body, script = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
<main>
${body}
</main>
${script ? `<script>${script}</script>` : ''}
</body></html>`;
}

const nav = `<nav>
  <a href="/">Home</a>
  <a href="/cart">Cart</a>
  <a href="/help" target="_blank">Help (new tab)</a>
</nav>`;

function loginPage(next, error) {
  return layout(
    'Sign in - Shop',
    `<h1>Sign in</h1>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/login">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <p><label for="email">Email</label> <input id="email" name="email" type="email" autocomplete="off"></p>
  <p><label for="password">Password</label> <input id="password" name="password" type="password" autocomplete="off"></p>
  <button type="submit">Sign in</button>
</form>`,
  );
}

function productPage(sku, product) {
  return layout(
    `${product.name} - Shop`,
    `${nav}
<h1>${escapeHtml(product.name)}</h1>
<p>Price: ${money(product.price)}</p>
<p><label for="qty">Quantity</label> <input id="qty" type="number" value="1" min="1"></p>
<button id="add" type="button">Add to cart</button>
<p role="status" aria-label="Cart notice" id="notice"></p>`,
    `document.getElementById('add').addEventListener('click', async () => {
  const qty = Number(document.getElementById('qty').value) || 1;
  const res = await fetch('/api/cart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: ${JSON.stringify(sku)}, qty }),
  });
  document.getElementById('notice').textContent = res.ok ? 'Added to cart' : 'Could not add';
});`,
  );
}

const cartPage = layout(
  'Cart - Shop',
  `${nav}
<h1>Cart</h1>
<ul id="items"></ul>
<div role="status" aria-label="Total" id="total">Loading...</div>`,
  `fetch('/api/cart')
  .then((res) => {
    if (res.status === 500) {
      console.error('TypeError: price is undefined');
      return null;
    }
    return res.ok ? res.json() : null;
  })
  .then((cart) => {
    const total = document.getElementById('total');
    if (!cart) {
      total.textContent = '$0.00';
      return;
    }
    const items = document.getElementById('items');
    for (const item of cart.items) {
      const li = document.createElement('li');
      li.textContent = item.name + ' x ' + item.qty;
      items.appendChild(li);
    }
    total.textContent = '$' + (cart.total / 100).toFixed(2);
  });`,
);

const helpPage = layout('Help - Shop', '<h1>Help</h1><p>Contact support@example.com.</p>');

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export async function startShopApp({ port = 0, bug = process.env.SHOP_BUG === '1' } = {}) {
  let bugOn = bug;
  /** @type {Map<string, Map<string, number>>} session token -> (sku -> qty) */
  const sessions = new Map();

  const sessionOf = (req) => {
    const match = /(?:^|;\s*)shop_session=([^;]+)/.exec(req.headers.cookie ?? '');
    return match && sessions.has(match[1]) ? sessions.get(match[1]) : null;
  };
  const html = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const redirect = (res, location, headers = {}) => {
    res.writeHead(302, { location, ...headers });
    res.end();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://shop.local');
    const path = url.pathname;
    const cart = sessionOf(req);

    if (path === '/favicon.ico') return void res.writeHead(204).end();
    if (path === '/help') return html(res, 200, helpPage);
    // Redirects to a different host name (127.0.0.2), to exercise a flow's host allowlist.
    if (path === '/offsite') return redirect(res, `http://127.0.0.2:${boundPort}/help`);

    if (path === '/login' && req.method === 'GET') {
      return html(res, 200, loginPage(url.searchParams.get('next') ?? '/', ''));
    }
    if (path === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const next = form.get('next') ?? '/';
      if (form.get('email') !== DEMO_EMAIL || form.get('password') !== DEMO_PASSWORD) {
        return html(res, 401, loginPage(next, 'Invalid email or password'));
      }
      const token = randomBytes(16).toString('hex');
      sessions.set(token, new Map());
      return redirect(res, next.startsWith('/') ? next : '/', {
        'set-cookie': `shop_session=${token}; HttpOnly; Path=/`,
      });
    }
    if (path === '/logout') {
      return redirect(res, '/login', { 'set-cookie': 'shop_session=; Max-Age=0; Path=/' });
    }

    // Everything below needs a session.
    if (!cart) {
      if (path.startsWith('/api/')) return json(res, 401, { error: 'not signed in' });
      return redirect(res, `/login?next=${encodeURIComponent(path)}`);
    }

    if (path === '/') {
      return html(
        res,
        200,
        layout(
          'Shop',
          `${nav}<h1>Shop</h1><ul><li><a href="/products/TSHIRT-M">T-Shirt (M)</a></li><li><a href="/products/HOODIE-L">Hoodie (L)</a></li></ul><p><a href="http://127.0.0.2:${boundPort}/help">External docs</a></p>`,
        ),
      );
    }
    const product = /^\/products\/([\w-]+)$/.exec(path);
    if (product) {
      const sku = product[1];
      return CATALOG[sku]
        ? html(res, 200, productPage(sku, CATALOG[sku]))
        : html(res, 404, layout('Not found', '<h1>Unknown product</h1>'));
    }
    if (path === '/cart') return html(res, 200, cartPage);

    if (path === '/api/cart' && req.method === 'GET') {
      if (bugOn) return json(res, 500, { error: 'price is undefined' });
      const items = [...cart].map(([sku, qty]) => ({
        sku,
        name: CATALOG[sku].name,
        price: CATALOG[sku].price,
        qty,
      }));
      return json(res, 200, { items, total: items.reduce((n, i) => n + i.price * i.qty, 0) });
    }
    if (path === '/api/cart' && req.method === 'POST') {
      await sleep(300 + Math.random() * 500);
      let body = {};
      try {
        body = JSON.parse(await readBody(req));
      } catch {}
      if (!CATALOG[body.sku]) return json(res, 400, { error: 'unknown sku' });
      // Replace, don't accumulate, so replaying a saved flow always ends at the same total.
      cart.clear();
      cart.set(body.sku, Math.max(1, Math.floor(Number(body.qty) || 1)));
      return json(res, 200, { ok: true });
    }

    return html(res, 404, layout('Not found', '<h1>Not found</h1>'));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    setBug(on) {
      bugOn = on;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startShopApp({ port: Number(process.env.PORT ?? 3000) });
  console.log(
    `shop-app listening on ${app.url} (bug ${process.env.SHOP_BUG === '1' ? 'on' : 'off'})`,
  );
}
