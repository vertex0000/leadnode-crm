// Nodevers — store-sync: the client pastes THEIR website's API key in Nodevers → Connections; this function pulls orders, products and stock.
//   Shopify (Admin API access token), WooCommerce (consumer key + secret), any website (custom JSON API + field matching),
//   Amazon Seller Central (SP-API: LWA client id + secret + refresh token — orders, items, FBA stock),
//   Meta Ads (ad account id + access token with ads_read — daily spend per campaign → ad_spend, used for net profit).
//   Actions (signed-in owner / admin): list · test · save · sync · delete.   Every 15 min (pg_cron, header x-cron-secret): cron.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "store-sync" → paste → Deploy → turn OFF "Enforce JWT verification".
// Two ways to connect (Admin Console → Settings → Connect methods, SQL 20):
//   A "own"  — the client's own app keys (Shopify Dev Dashboard client ID + secret, or an old shpat_ token; Amazon private app; Meta system user token).
//   B "app"  — one click "Connect with Shopify / Amazon / Facebook" through the platform's approved app (off until approved). Secrets for B only:
//              SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET · AMAZON_LWA_CLIENT_ID + AMAZON_LWA_CLIENT_SECRET (+ AMAZON_APP_ID) · META_APP_ID + META_APP_SECRET.
// No secrets are needed for option A. Needs 10_connections_alerts.sql (20_connect_methods.sql for option B).
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const ALLOW_HTTP = Deno.env.get('STORE_ALLOW_HTTP') === '1';           // local tests only
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const cut = (v: unknown, n: number) => String(v ?? '').slice(0, n);
const num = (v: unknown) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[^\d.-]/g, '')); return isFinite(n) ? Math.abs(n) : null; };
const dateOf = (v: unknown) => { const s = String(v ?? ''); if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s); return isNaN(+d) ? s.slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d); } const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; const n = Number(s); if (n > 1e9) return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(n > 1e12 ? n : n * 1000)); return today(); };
const STATUS: [RegExp, string][] = [[/deliver|complete|fulfilled/i, 'Delivered'], [/rto|return.?to.?origin|undeliver/i, 'RTO'], [/refund/i, 'Refunded'], [/return/i, 'Returned'], [/exchang/i, 'Exchange'], [/cancel|void|fail/i, 'Cancelled'], [/ship|transit|dispatch|partial/i, 'Shipped'], [/process|unfulfilled|on.?hold|pack/i, 'Processing'], [/confirm/i, 'Confirmed'], [/cod|cash/i, 'COD'], [/paid/i, 'Paid'], [/pending|new|placed|open/i, 'New']];
const statusOf = (s: unknown, fallback = 'New') => (STATUS.find(([re]) => re.test(String(s ?? ''))) ?? [0, fallback])[1] as string;

/** blocks links to the server's own network (localhost, private ranges, metadata) */
function safeUrl(raw: string): URL {
  let u: URL; try { u = new URL(raw); } catch { throw new Error('That link is not valid.'); }
  if (u.protocol !== 'https:' && !(ALLOW_HTTP && u.protocol === 'http:')) throw new Error('The link must start with https://');
  const h = u.hostname.toLowerCase();
  if (!ALLOW_HTTP && (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '[::1]' || /^\[?(fc|fd|fe80)/i.test(h) || /supabase\.(co|in)$/.test(h))) throw new Error('That link points to a private address.');
  return u;
}
async function getJSON(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(safeUrl(url), { headers: { Accept: 'application/json', 'User-Agent': 'Nodevers/1.0', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(20000) }).catch((e) => { throw new Error('Could not reach the website: ' + (e?.message ?? e)); });
  const len = Number(r.headers.get('content-length') ?? 0); if (len > 15e6) throw new Error('The answer from the website is too big.');
  const text = await r.text(); if (text.length > 15e6) throw new Error('The answer from the website is too big.');
  if (r.status === 401 || r.status === 403) throw new Error(`The website refused the key (${r.status}). Check it has read access.`);
  if (r.status === 404) throw new Error('Nothing found at that link (404). Check the address.');
  if (!r.ok) throw new Error(`The website answered ${r.status}.`);
  try { return { data: JSON.parse(text), headers: r.headers }; } catch { throw new Error('The website did not answer with JSON — check the link.'); }
}
const pick = (o: any, path: string) => { if (!path) return undefined; let v = o; for (const k of path.split('.')) { if (v == null) return undefined; v = Array.isArray(v) && /^\d+$/.test(k) ? v[+k] : v[k]; } return v; };
/** all leaf paths of an object (for field matching), arrays → first item */
function paths(o: any, pre = '', out: string[] = [], depth = 0): string[] {
  if (depth > 4 || o == null || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o).slice(0, 80)) { const p = pre ? `${pre}.${k}` : k;
    if (Array.isArray(v)) { if (v.length && typeof v[0] === 'object') paths(v[0], p + '.0', out, depth + 1); else out.push(p); }
    else if (v && typeof v === 'object') paths(v, p, out, depth + 1); else out.push(p); }
  return out;
}
/** finds the list of records inside an API answer: [..], {data:[..]}, {orders:[..]}, {result:{items:[..]}} */
function findList(d: any, want = ''): { list: any[]; path: string } {
  if (want) { const v = pick(d, want); if (Array.isArray(v)) return { list: v, path: want }; }
  if (Array.isArray(d)) return { list: d, path: '' };
  for (const k of ['orders', 'data', 'items', 'results', 'result', 'products', 'records', 'rows']) { const v = d?.[k]; if (Array.isArray(v)) return { list: v, path: k }; if (v && typeof v === 'object') for (const k2 of ['orders', 'data', 'items', 'products', 'records']) if (Array.isArray(v[k2])) return { list: v[k2], path: `${k}.${k2}` }; }
  throw new Error('Could not find a list of records in the answer. Ask your developer to return a JSON list.');
}

// ---------------- platform adapters → rows for public.orders / public.products ----------------
type Ctx = { cfg: any; sec: any; since: string | null; ws?: string };
type Got = { orders: any[]; products: any[]; updates?: { id: string; status: string }[]; ads?: any[]; insights?: any[]; checkouts?: any[] };
/** the buyer's phone / email (SQL 23: one customer profile per phone or email, WhatsApp / email remarketing) */
const phoneOf = (...v: unknown[]) => { for (const x of v) { const d = String(x ?? '').replace(/\D/g, ''); if (d.length >= 10) return cut(d, 20); } return ''; };
const pinOf = (...v: unknown[]) => cut(String(v.find((x) => x !== undefined && x !== null && String(x).trim() !== '') ?? '').replace(/[^A-Za-z0-9-]/g, ''), 12);
const emailOf = (...v: unknown[]) => { for (const x of v) { const e = String(x ?? '').trim().toLowerCase(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return cut(e, 160); } return ''; };
const shopBase = (cfg: any) => `https://${String(cfg.store_url).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/admin/api/2026-07`;
const SHOP_BASE_OVERRIDE = Deno.env.get('SHOPIFY_BASE');                 // local tests
const SHOP_OAUTH_OVERRIDE = Deno.env.get('SHOPIFY_OAUTH_BASE');          // local tests
const shopOauth = (shop: string) => `${SHOP_OAUTH_OVERRIDE || 'https://' + shop}/admin/oauth/access_token`;
/** Shopify apps made in the Dev Dashboard (since 2026 the only way): client ID + secret → a 24-hour token (client credentials grant) */
async function shopifyToken(cfg: any, sec: any) {
  if (sec.token) return String(sec.token);                               // old custom app (shpat_…) or "Connect with Shopify"
  if (!sec.client_id || !sec.client_secret) throw new Error('Paste the Client ID and Client secret of your Shopify app.');
  const r = await fetch(shopOauth(String(cfg.store_url)), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: sec.client_id, client_secret: sec.client_secret }), signal: AbortSignal.timeout(20000) }).catch(() => null);
  const j: any = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok || !j.access_token) throw new Error('Shopify did not accept the Client ID / secret' + (j.error_description ? ` (${j.error_description})` : '') + ' — check them, and that the app is installed on this store (Dev Dashboard → your app → Install).');
  return String(j.access_token);
}
async function shopify(ctx: Ctx, limitPages = 8) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(String(ctx.cfg.store_url || '')) && !SHOP_BASE_OVERRIDE) throw new Error('Store link should look like yourstore.myshopify.com');
  const base = SHOP_BASE_OVERRIDE || shopBase(ctx.cfg), H = { 'X-Shopify-Access-Token': await shopifyToken(ctx.cfg, ctx.sec) };
  const orders: any[] = [], products: any[] = [];
  let url: string | null = `${base}/orders.json?status=any&limit=250${ctx.since ? '&updated_at_min=' + encodeURIComponent(ctx.since) : '&created_at_min=' + encodeURIComponent(new Date(Date.now() - 90 * 864e5).toISOString())}`;
  for (let i = 0; url && i < limitPages; i++) {
    const { data, headers } = await getJSON(url, H);
    for (const o of data.orders ?? []) {
      const items = o.line_items ?? [], ship = num(o.total_shipping_price_set?.shop_money?.amount ?? o.shipping_lines?.reduce?.((a: number, s: any) => a + Number(s.price || 0), 0)), gw = (o.payment_gateway_names ?? []).join(', ');
      const delivered = (o.fulfillments ?? []).some((f: any) => f.shipment_status === 'delivered');
      const st = o.cancelled_at ? 'Cancelled' : /refunded/.test(o.financial_status) ? 'Refunded' : delivered ? 'Delivered' : o.fulfillment_status === 'fulfilled' ? 'Shipped' : o.financial_status === 'paid' ? 'Paid' : /cash|cod/i.test(gw) ? 'COD' : 'New';
      const who = { customer_phone: phoneOf(o.phone, o.shipping_address?.phone, o.billing_address?.phone, o.customer?.phone, o.customer?.default_address?.phone), customer_email: emailOf(o.email, o.contact_email, o.customer?.email), order_ref: cut(o.name || o.id, 80), coupon: cut(o.discount_codes?.[0]?.code, 60), pincode: pinOf(o.shipping_address?.zip, o.billing_address?.zip) };
      items.forEach((li: any, k: number) => {
        const disc = (li.discount_allocations ?? []).reduce((a: number, d: any) => a + Number(d.amount || 0), 0), qty = Number(li.quantity || 1), unit = num(li.price);
        orders.push({ ext_id: cut(items.length > 1 ? `${o.name || o.id}-${k + 1}` : (o.name || o.id), 80), order_date: dateOf(o.created_at), sku: cut(li.sku, 80), product_name: cut(li.title + (li.variant_title ? ' · ' + li.variant_title : ''), 200), qty,
          unit_price: unit, amount: unit != null ? Math.max(0, unit * qty - disc) : null, shipping_fee: k === 0 ? ship : null, status: st, payment: cut(gw, 40),
          customer_name: cut([o.shipping_address?.first_name, o.shipping_address?.last_name].filter(Boolean).join(' ') || o.customer?.first_name || '', 120), customer_state: cut(o.shipping_address?.province, 60), customer_city: cut(o.shipping_address?.city, 60),
          tracking_url: cut(o.fulfillments?.[0]?.tracking_url, 500), courier: cut(o.fulfillments?.[0]?.tracking_company, 60), ...who });
      });
    }
    const link = headers.get('link') ?? ''; const m = link.match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null;
  }
  url = `${base}/products.json?limit=250`;
  for (let i = 0; url && i < 4; i++) {
    const { data, headers } = await getJSON(url, H);
    for (const p of data.products ?? []) for (const v of p.variants ?? []) {
      const sku = String(v.sku || '').trim(); if (!sku) continue;
      products.push({ sku: cut(sku, 80), name: cut(p.title + (v.title && v.title !== 'Default Title' ? ' · ' + v.title : ''), 200), category: cut(p.product_type, 80), price: num(v.price), stock: v.inventory_quantity ?? null, image_url: cut(p.image?.src, 500), website_url: '' });
    }
    const link = headers.get('link') ?? ''; const m = link.match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null;
  }
  // abandoned checkouts of the last 7 days (people who gave their phone / email but did not pay) — skipped quietly if the app can not read them
  const checkouts: any[] = [];
  try {
    url = `${base}/checkouts.json?limit=250&updated_at_min=${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}`;
    for (let i = 0; url && i < 4; i++) {
      const { data, headers } = await getJSON(url, H);
      for (const c of data.checkouts ?? []) {
        const phone = phoneOf(c.phone, c.shipping_address?.phone, c.billing_address?.phone, c.customer?.phone), email = emailOf(c.email, c.customer?.email);
        if (!c.token || (!phone && !email)) continue;
        const li = c.line_items ?? [];
        checkouts.push({ checkout_id: cut('shopify:' + c.token, 120), name: cut([c.shipping_address?.first_name || c.customer?.first_name, c.shipping_address?.last_name || c.customer?.last_name].filter(Boolean).join(' '), 120), phone, email,
          items: cut(li.map((l: any) => `${Number(l.quantity || 1) > 1 ? l.quantity + ' × ' : ''}${l.title}${l.variant_title ? ' · ' + l.variant_title : ''}`).join(', '), 2000), skus: li.map((l: any) => cut(l.sku, 80)).filter(Boolean).slice(0, 30),
          amount: num(c.total_price), url: /^https:\/\//.test(String(c.abandoned_checkout_url ?? '')) ? cut(c.abandoned_checkout_url, 1000) : '', completed: !!c.completed_at, created_at: c.created_at });
      }
      const link = headers.get('link') ?? ''; const m = link.match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null;
    }
  } catch (e) { console.log('shopify checkouts skipped:', (e as Error).message); }
  return { orders, products, checkouts };
}
const WOO_ST: Record<string, string> = { pending: 'New', processing: 'Processing', 'on-hold': 'New', completed: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded', failed: 'Cancelled', shipped: 'Shipped' };
async function woocommerce(ctx: Ctx, limitPages = 10) {
  const site = String(ctx.cfg.site_url || '').replace(/\/+$/, ''); safeUrl(site);
  const H = { Authorization: 'Basic ' + btoa(`${ctx.sec.key || ''}:${ctx.sec.secret || ''}`) };
  const orders: any[] = [], products: any[] = [];
  const after = ctx.since ? `&modified_after=${encodeURIComponent(ctx.since.slice(0, 19))}` : `&after=${encodeURIComponent(new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 19))}`;
  for (let page = 1; page <= limitPages; page++) {
    const { data } = await getJSON(`${site}/wp-json/wc/v3/orders?per_page=100&page=${page}&orderby=date&order=desc${after}`, H);
    if (!Array.isArray(data)) throw new Error('Unexpected answer from WooCommerce.');
    for (const o of data) {
      const items = o.line_items ?? [], cod = /cod|cash/i.test(o.payment_method || '') && o.status === 'processing';
      items.forEach((li: any, k: number) => orders.push({ ext_id: cut(items.length > 1 ? `${o.number || o.id}-${k + 1}` : String(o.number || o.id), 80), order_date: dateOf(o.date_created_gmt ? o.date_created_gmt + 'Z' : o.date_created), sku: cut(li.sku, 80), product_name: cut(li.name, 200),
        qty: Number(li.quantity || 1), unit_price: num(li.price), amount: num(li.total), shipping_fee: k === 0 ? num(o.shipping_total) : null, status: cod ? 'COD' : (WOO_ST[o.status] ?? statusOf(o.status)), payment: cut(o.payment_method_title, 40),
        customer_name: cut([o.shipping?.first_name || o.billing?.first_name, o.shipping?.last_name || o.billing?.last_name].filter(Boolean).join(' '), 120), customer_state: cut(o.shipping?.state || o.billing?.state, 60), customer_city: cut(o.shipping?.city || o.billing?.city, 60),
        customer_phone: phoneOf(o.billing?.phone, o.shipping?.phone), customer_email: emailOf(o.billing?.email), order_ref: cut(o.number || o.id, 80), coupon: cut(o.coupon_lines?.[0]?.code, 60), pincode: pinOf(o.shipping?.postcode, o.billing?.postcode) }));
    }
    if (data.length < 100) break;
  }
  for (let page = 1; page <= 5; page++) {
    const { data } = await getJSON(`${site}/wp-json/wc/v3/products?per_page=100&page=${page}`, H);
    if (!Array.isArray(data)) break;
    for (const p of data) { const sku = String(p.sku || '').trim(); if (!sku) continue; products.push({ sku: cut(sku, 80), name: cut(p.name, 200), category: cut(p.categories?.[0]?.name, 80), price: num(p.price || p.regular_price), stock: p.manage_stock ? p.stock_quantity : null, image_url: cut(p.images?.[0]?.src, 500), website_url: cut(p.permalink, 500) }); }
    if (data.length < 100) break;
  }
  return { orders, products };
}
function customHeaders(cfg: any, sec: any, url: string) {
  const H: Record<string, string> = {}; let u = url;
  if (cfg.auth === 'bearer' && sec.key) H.Authorization = 'Bearer ' + sec.key;
  else if (cfg.auth === 'header' && sec.key) H[String(cfg.auth_name || 'x-api-key').replace(/[^A-Za-z0-9-]/g, '') || 'x-api-key'] = sec.key;
  else if (cfg.auth === 'query' && sec.key) u += (u.includes('?') ? '&' : '?') + encodeURIComponent(cfg.auth_name || 'key') + '=' + encodeURIComponent(sec.key);
  return { H, u };
}
async function custom(ctx: Ctx) {
  const { cfg, sec } = ctx, m = cfg.map ?? {}, pm = cfg.pmap ?? {};
  if (!m.extId) throw new Error('Match at least the Order ID field (Test connection first).');
  const { H, u } = customHeaders(cfg, sec, cfg.orders_url), { data } = await getJSON(u, H), { list } = findList(data, cfg.list_path);
  const orders = list.slice(0, 5000).map((o: any) => {
    const g = (f: string) => m[f] ? pick(o, m[f]) : undefined;
    return { ext_id: cut(g('extId'), 80), order_date: dateOf(g('orderDate')), sku: cut(g('sku'), 80), product_name: cut(g('productName'), 200), qty: Math.max(1, Math.round(Number(num(g('qty')) ?? 1) || 1)), unit_price: num(g('unitPrice')), amount: num(g('amount')),
      status: statusOf(g('status'), 'Delivered'), payment: cut(g('payment'), 40), customer_name: cut(g('customerName'), 120), customer_state: cut(g('customerState'), 60), customer_city: cut(g('customerCity'), 60),
      shipping_fee: num(g('shippingFee')), marketplace_fee: num(g('marketplaceFee')), courier: cut(g('courier'), 60), tracking_url: /^https?:\/\//.test(String(g('trackingUrl') ?? '')) ? cut(g('trackingUrl'), 500) : '',
      customer_phone: phoneOf(g('customerPhone')), customer_email: emailOf(g('customerEmail')), coupon: cut(g('coupon'), 60), pincode: pinOf(g('pincode')) };
  }).filter((o: any) => o.ext_id);
  let products: any[] = [];
  if (cfg.products_url && pm.sku) {
    const p = customHeaders(cfg, sec, cfg.products_url), r = await getJSON(p.u, p.H), pl = findList(r.data, cfg.plist_path).list;
    products = pl.slice(0, 5000).map((x: any) => ({ sku: cut(pick(x, pm.sku), 80), name: cut(pick(x, pm.name), 200), category: cut(pick(x, pm.category), 80), price: num(pick(x, pm.price)), cost: pm.cost ? num(pick(x, pm.cost)) : undefined, stock: pm.stock ? num(pick(x, pm.stock)) : null })).filter((p: any) => p.sku);
  }
  return { orders, products };
}
// ---------------- Amazon Seller Central (SP-API) ----------------
// The client makes a private SP-API app in Seller Central (Apps & Services → Develop apps), authorises it for their own account
// and pastes the LWA client id, client secret and refresh token. No AWS keys are needed (Amazon dropped request signing in 2023).
const AMZ_MKT: Record<string, [string, 'na' | 'eu' | 'fe']> = {
  A21TBJUM6AAA2I: ['Amazon.in (India)', 'eu'], A2VIGQ35RCS4UG: ['Amazon.ae (UAE)', 'eu'], A17E79C6D8DWNP: ['Amazon.sa (Saudi Arabia)', 'eu'], A1F83G8C2ARO7P: ['Amazon.co.uk', 'eu'],
  A1PA6795UKMFR9: ['Amazon.de', 'eu'], ATVPDKIKX0DER: ['Amazon.com (US)', 'na'], A2EUQ1WTGCTBG2: ['Amazon.ca', 'na'], A39IBJ37TRP1C6: ['Amazon.com.au', 'fe'], A19VAU5U5O7RUS: ['Amazon.sg', 'fe'] };
const AMZ_HOST = { na: 'https://sellingpartnerapi-na.amazon.com', eu: 'https://sellingpartnerapi-eu.amazon.com', fe: 'https://sellingpartnerapi-fe.amazon.com' };
const AMZ_BASE = Deno.env.get('AMAZON_SP_BASE');                                  // local tests
const LWA_URL = Deno.env.get('AMAZON_LWA_URL') ?? 'https://api.amazon.com/auth/o2/token';
const AMZ_ST: Record<string, string> = { Pending: 'New', PendingAvailability: 'New', Unshipped: 'Confirmed', InvoiceUnconfirmed: 'Confirmed', PartiallyShipped: 'Shipped', Shipped: 'Shipped', Canceled: 'Cancelled', Unfulfillable: 'Cancelled' };
const AMZ_PLAT = { id: Deno.env.get('AMAZON_LWA_CLIENT_ID') ?? '', secret: Deno.env.get('AMAZON_LWA_CLIENT_SECRET') ?? '' };   // "Connect with Amazon" (option B)
async function amzToken(sec0: any) {
  const sec = sec0.app && !sec0.client_id ? { ...sec0, client_id: AMZ_PLAT.id, client_secret: AMZ_PLAT.secret } : sec0;
  if (sec0.app && (!sec.client_id || !sec.client_secret)) throw new Error('Connect with Amazon is not set up on the server (AMAZON_LWA_CLIENT_ID / SECRET). Please tell the Nodevers team.');
  if (!sec.client_id || !sec.client_secret || !sec.refresh_token) throw new Error('Paste the LWA client ID, client secret and refresh token.');
  const r = await fetch(LWA_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sec.refresh_token, client_id: sec.client_id, client_secret: sec.client_secret }), signal: AbortSignal.timeout(20000) }).catch(() => null);
  const j: any = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok || !j.access_token) throw new Error('Amazon did not accept the keys' + (j.error_description ? ` (${j.error_description})` : '') + ' — check the client ID, secret and refresh token.');
  return String(j.access_token);
}
async function amzGet(base: string, path: string, tok: string, soft = false): Promise<any> {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(base + path, { headers: { 'x-amz-access-token': tok, Accept: 'application/json', 'User-Agent': 'Nodevers/1.0 (Language=TypeScript)' }, signal: AbortSignal.timeout(25000) }).catch(() => null);
    if (!r) throw new Error('Amazon did not answer — try again in a minute.');
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 2000 * (i + 1))); continue; }
    const j: any = await r.json().catch(() => ({}));
    if (r.ok) return j;
    if (soft) return null;
    const msg = j?.errors?.[0]?.message ?? r.status;
    if (r.status === 403) throw new Error(`Amazon refused access (${msg}) — the app needs the Orders role (and Inventory for FBA) and the refresh token must be for this seller account.`);
    throw new Error('Amazon: ' + msg);
  }
  if (soft) return null; throw new Error('Amazon is busy (too many requests) — the next sync will continue.');
}
async function amazon(ctx: Ctx) {
  const mkt = AMZ_MKT[ctx.cfg.marketplace] ? String(ctx.cfg.marketplace) : 'A21TBJUM6AAA2I', base = AMZ_BASE || AMZ_HOST[AMZ_MKT[mkt][1]];
  const tok = await amzToken(ctx.sec), orders: any[] = [], products: any[] = [], updates: { id: string; status: string }[] = [];
  const after = new Date(Math.min(Date.now() - 3 * 60e3, ctx.since ? new Date(ctx.since).getTime() : Date.now() - 60 * 864e5)).toISOString();
  const list: any[] = []; let next = '';
  for (let page = 0; page < 6; page++) {
    const q = next ? `NextToken=${encodeURIComponent(next)}&MarketplaceIds=${mkt}` : `MarketplaceIds=${mkt}&LastUpdatedAfter=${encodeURIComponent(after)}&MaxResultsPerPage=100`;
    const j = await amzGet(base, `/orders/v0/orders?${q}`, tok); list.push(...(j?.payload?.Orders ?? [])); next = j?.payload?.NextToken ?? ''; if (!next) break;
  }
  // orders we already have only need their status; new ones need their items (Amazon allows ~1 item call per second)
  const ids = list.map((o) => String(o.AmazonOrderId)), known = new Set<string>();
  for (let i = 0; i < ids.length && ctx.ws; i += 100) {
    const { data } = await db.from('orders').select('ext_id').eq('workspace_id', ctx.ws).eq('channel', 'Amazon').in('ext_id', ids.slice(i, i + 100).flatMap((id) => [id, id + '-1']));
    (data ?? []).forEach((r: any) => known.add(String(r.ext_id).replace(/-1$/, '')));
  }
  let itemCalls = 0;
  for (const o of list) {
    const id = String(o.AmazonOrderId), st = AMZ_ST[o.OrderStatus] ?? statusOf(o.OrderStatus), cod = /cod/i.test(String(o.PaymentMethod ?? '')), status = cod && (st === 'New' || st === 'Confirmed') ? 'COD' : st;
    if (known.has(id)) { updates.push({ id, status }); continue; }
    if (itemCalls >= 40) continue;                     // the rest come in the next sync
    itemCalls++;
    const items = (await amzGet(base, `/orders/v0/orders/${encodeURIComponent(id)}/orderItems`, tok))?.payload?.OrderItems ?? [];
    items.forEach((li: any, k: number) => {
      const qty = Math.max(1, Number(li.QuantityOrdered || 1)), amt = num(li.ItemPrice?.Amount);
      orders.push({ ext_id: cut(items.length > 1 ? `${id}-${k + 1}` : id, 80), order_date: dateOf(o.PurchaseDate), sku: cut(li.SellerSKU, 80), product_name: cut(li.Title, 200), qty,
        unit_price: amt != null ? Math.round(amt / qty * 100) / 100 : null, amount: amt, shipping_fee: null, status, payment: cut(cod ? 'COD' : o.PaymentMethod === 'Other' ? 'Prepaid' : o.PaymentMethod, 40),
        customer_name: cut(o.BuyerInfo?.BuyerName ?? '', 120), customer_state: cut(o.ShippingAddress?.StateOrRegion, 60), customer_city: cut(o.ShippingAddress?.City, 60),
        courier: o.FulfillmentChannel === 'AFN' ? 'Amazon FBA' : cut(o.ShipServiceLevel, 60), stock_skip: o.FulfillmentChannel === 'AFN' });      // FBA orders leave Amazon's stock, not yours
    });
  }
  if (ctx.cfg.fba !== false) {                           // FBA stock (needs the Inventory role — skipped quietly without it)
    let nt = '';
    for (let page = 0; page < 5; page++) {
      const j = await amzGet(base, `/fba/inventory/v1/summaries?details=false&granularityType=Marketplace&granularityId=${mkt}&marketplaceIds=${mkt}${nt ? '&nextToken=' + encodeURIComponent(nt) : ''}`, tok, true);
      if (!j) break; (j.payload?.inventorySummaries ?? []).forEach((x: any) => { if (x.sellerSku) products.push({ sku: cut(x.sellerSku, 80), name: cut(x.productName, 200), fba_stock: Math.max(0, Number(x.totalQuantity ?? x.inventoryDetails?.fulfillableQuantity ?? 0)) }); });
      nt = j.pagination?.nextToken ?? ''; if (!nt) break;
    }
  }
  return { orders, products, updates };
}

// ---------------- Meta Ads: daily spend per campaign → ad_spend (net profit, ROAS, Ads Manager) ----------------
const GRAPH = (Deno.env.get('META_GRAPH_URL') ?? 'https://graph.facebook.com/v25.0').replace(/\/+$/, '');
const LEAD_ACT = ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped', 'offsite_conversion.fb_pixel_lead'], BUY_ACT = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'];
const actSum = (arr: any[] | undefined, types: string[]) => { const hit = (arr ?? []).filter((a) => types.includes(a.action_type)); if (!hit.length) return null; return Math.max(...types.map((t) => hit.filter((a) => a.action_type === t).reduce((s, a) => s + Number(a.value || 0), 0))); };
async function metaGet(url: string, token: string) {
  const r = await fetch(safeUrl(url), { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) }).catch(() => null);
  if (!r) throw new Error('Meta did not answer — try again in a minute.');
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) { const e = j?.error ?? {}; throw new Error(e.code === 190 ? 'Meta did not accept the access token — make a new one with ads_read.' : e.code === 100 || e.code === 803 ? 'Meta could not find that ad account — check the ID and that the token has access to it.' : e.code === 10 || e.code === 200 ? 'The token has no permission to read ads (ads_read).' : 'Meta: ' + (e.message ?? r.status)); }
  return j;
}
async function metaAds(ctx: Ctx) {
  const acct = String(ctx.cfg.ad_account || '').replace(/^act_/i, '').trim();
  if (!/^\d{5,25}$/.test(acct)) throw new Error('The ad account ID is the number in Ads Manager (e.g. 1234567890), with or without act_.');
  if (!ctx.sec.token) throw new Error('Paste the access token (System user token with ads_read).');
  const d = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(t));
  const since = d(ctx.since ? new Date(ctx.since).getTime() - 3 * 864e5 : Date.now() - 90 * 864e5), until = d(Date.now()), range = encodeURIComponent(JSON.stringify({ since, until }));
  const nums = (x: any) => ({ spend: Number(x.spend || 0), impressions: x.impressions != null ? Math.round(Number(x.impressions)) : null, clicks: x.clicks != null ? Math.round(Number(x.clicks)) : null, leads: actSum(x.actions, LEAD_ACT), purchases: actSum(x.actions, BUY_ACT), revenue: actSum(x.action_values, BUY_ACT) });
  const ads: any[] = [], insights: any[] = [];
  let url: string | null = `${GRAPH}/act_${acct}/insights?level=campaign&time_increment=1&limit=500&fields=campaign_name,campaign_id,spend,impressions,clicks,actions,action_values&time_range=${range}`;
  for (let page = 0; url && page < 20; page++) { const j = await metaGet(url, ctx.sec.token); for (const x of j.data ?? []) ads.push({ day: String(x.date_start).slice(0, 10), campaign: cut(x.campaign_name || 'Campaign', 200), campaign_id: cut(x.campaign_id, 40), ...nums(x) }); url = j.paging?.next ?? null; }
  // ad sets and ads (creatives) — for the AI Advisor; the last 30 days are enough, and a failure here never stops the spend sync
  const since30 = d(Math.max(new Date(since).getTime(), Date.now() - 30 * 864e5)), r30 = encodeURIComponent(JSON.stringify({ since: since30, until }));
  for (const level of ['adset', 'ad'] as const) {
    try {
      let u: string | null = `${GRAPH}/act_${acct}/insights?level=${level}&time_increment=1&limit=500&fields=campaign_name,campaign_id,adset_name,adset_id${level === 'ad' ? ',ad_name,ad_id' : ''},spend,impressions,clicks,actions,action_values&time_range=${r30}`;
      for (let page = 0; u && page < 20; page++) { const j = await metaGet(u, ctx.sec.token);
        for (const x of j.data ?? []) { const id = level === 'ad' ? x.ad_id : x.adset_id; if (!id) continue;
          insights.push({ day: String(x.date_start).slice(0, 10), level, ext_id: cut(id, 40), name: cut(level === 'ad' ? x.ad_name : x.adset_name, 300), campaign: cut(x.campaign_name, 300), campaign_id: cut(x.campaign_id, 40), adset: cut(x.adset_name, 300), adset_id: cut(x.adset_id, 40), ...nums(x) }); }
        u = j.paging?.next ?? null; }
    } catch (e) { console.error('meta ' + level + ' insights', (e as Error).message); }
  }
  return { orders: [], products: [], ads, insights };
}

const ADAPT: Record<string, (c: Ctx) => Promise<Got>> = { shopify, woocommerce, custom, amazon, meta_ads: metaAds };
const SOURCE: Record<string, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce', custom: 'Website API', amazon: 'Amazon SP-API' };
const CHANNEL: Record<string, string> = { amazon: 'Amazon' };
const featureOf = (platform: string) => platform === 'meta_ads' ? 'ads' : 'store';

async function store(ws: string, platform: string, got: Got, cfg: any = {}) {
  let np = 0, no = 0, na = 0;
  if (platform === 'amazon' && got.products.length) {          // Amazon: only the FBA stock of products you already have; new SKUs are added with their Amazon name
    const skus = got.products.map((p) => p.sku), have = new Set<string>();
    for (let i = 0; i < skus.length; i += 200) { const { data } = await db.from('products').select('sku').eq('workspace_id', ws).in('sku', skus.slice(i, i + 200)); (data ?? []).forEach((r: any) => have.add(r.sku)); }
    for (const p of got.products) { if (have.has(p.sku)) await db.from('products').update({ fba_stock: p.fba_stock }).eq('workspace_id', ws).eq('sku', p.sku); else await db.from('products').insert({ workspace_id: ws, sku: p.sku, name: p.name || p.sku, fba_stock: p.fba_stock, stock: 0 }); np++; }
    got = { ...got, products: [] };
  }
  if (got.products.length) {
    const seen = new Set<string>(), rows = got.products.filter((p) => !seen.has(p.sku) && seen.add(p.sku)).map((p) => { const r: any = { workspace_id: ws, sku: p.sku, name: p.name || p.sku }; for (const k of ['category', 'price', 'image_url', 'website_url']) if (p[k] !== undefined && p[k] !== null && p[k] !== '') r[k] = p[k]; if (p.cost != null) r.cost = p.cost; if (p.stock != null) r.stock = Math.round(Number(p.stock)); return r; });
    // upsert in groups that share the same columns (so missing values never wipe what the client typed)
    const groups = new Map<string, any[]>(); rows.forEach((r) => { const k = Object.keys(r).sort().join(','); (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); });
    for (const g of groups.values()) for (let i = 0; i < g.length; i += 500) { const { error, count } = await db.from('products').upsert(g.slice(i, i + 500), { onConflict: 'workspace_id,sku', count: 'exact' }); if (error) throw new Error('Saving products: ' + error.message); np += count ?? 0; }
  }
  if (got.orders.length) {
    const TXT = ['sku', 'product_name', 'payment', 'customer_name', 'customer_state', 'customer_city', 'courier', 'tracking_url', 'customer_phone', 'customer_email', 'order_ref', 'coupon', 'pincode'];
    const seen = new Set<string>(), rows = got.orders.filter((o) => o.ext_id && !seen.has(o.ext_id) && seen.add(o.ext_id)).map((o) => { const r: any = { workspace_id: ws, channel: CHANNEL[platform] ?? 'Website', source: SOURCE[platform], stock_skip: stockSkip(platform, cfg) }; for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v === '' && !TXT.includes(k) ? null : v; return r; });
    // lead_id is not sent: the database links each order to its customer (by phone / email) and a sync never unlinks it
    let cols = ['workspace_id', 'channel', 'source', 'stock_skip', 'ext_id', 'order_date', 'sku', 'product_name', 'qty', 'unit_price', 'amount', 'shipping_fee', 'marketplace_fee', 'status', 'payment', 'customer_name', 'customer_state', 'customer_city', 'courier', 'tracking_url', 'customer_phone', 'customer_email', 'order_ref', 'coupon', 'pincode'];
    const normOf = () => rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? (['qty'].includes(c) ? 1 : TXT.includes(c) ? '' : c === 'status' ? 'New' : null)])));
    let norm = normOf();
    for (let i = 0; i < norm.length; i += 500) {
      let { error, count } = await db.from('orders').upsert(norm.slice(i, i + 500), { onConflict: 'workspace_id,channel,ext_id', count: 'exact' });
      if (error && /pincode/.test(error.message)) { cols = cols.filter((c) => c !== 'pincode'); norm = normOf(); ({ error, count } = await db.from('orders').upsert(norm.slice(i, i + 500), { onConflict: 'workspace_id,channel,ext_id', count: 'exact' })); }   // before the 24 update
      if (error && /customer_phone|customer_email|order_ref|coupon/.test(error.message)) { cols = cols.filter((c) => !['customer_phone', 'customer_email', 'order_ref', 'coupon'].includes(c)); norm = normOf(); ({ error, count } = await db.from('orders').upsert(norm.slice(i, i + 500), { onConflict: 'workspace_id,channel,ext_id', count: 'exact' })); }   // before the 23 update
      if (error) throw new Error('Saving orders: ' + error.message); no += count ?? 0;
    }
  }
  if (got.checkouts?.length) {                                  // abandoned checkouts (SQL 23) — the status (open / recovered) is never overwritten
    const open = got.checkouts.filter((c) => !c.completed), done = got.checkouts.filter((c) => c.completed).map((c) => c.checkout_id);
    const rows = open.map(({ completed: _c, created_at, ...c }) => ({ workspace_id: ws, ...c, channel: 'Website', source: SOURCE[platform] ?? 'Website', created_at: created_at && !isNaN(+new Date(created_at)) ? new Date(created_at).toISOString() : new Date().toISOString() }));
    for (let i = 0; i < rows.length; i += 200) { const { error } = await db.from('checkouts').upsert(rows.slice(i, i + 200), { onConflict: 'workspace_id,checkout_id' }); if (error) { console.log('checkouts', error.message); break; } }
    if (done.length) await db.from('checkouts').update({ status: 'recovered' }).eq('workspace_id', ws).eq('status', 'open').in('checkout_id', done.slice(0, 500)).then(() => null, () => null);
  }
  for (const u of got.updates ?? []) {                          // status changes of orders we already have (Amazon)
    const { count } = await db.from('orders').update({ status: u.status }, { count: 'exact' }).eq('workspace_id', ws).eq('channel', CHANNEL[platform] ?? 'Website').neq('status', u.status).or(`ext_id.eq.${u.id},ext_id.like.${u.id}-*`);
    no += count ?? 0;
  }
  if (got.ads?.length) {                                        // Meta Ads spend → the same table as imported / typed spend, so profit and ROAS just work
    let rows: any[] = got.ads.map((a) => ({ workspace_id: ws, day: a.day, platform: 'Meta', campaign: a.campaign, campaign_id: a.campaign_id ?? '', spend: Math.round(a.spend * 100) / 100, impressions: a.impressions, clicks: a.clicks, leads: a.leads, purchases: a.purchases, revenue: a.revenue, source: 'Meta API' }));
    for (let i = 0; i < rows.length; i += 500) {
      let { error, count } = await db.from('ad_spend').upsert(rows.slice(i, i + 500), { onConflict: 'workspace_id,day,platform,campaign', count: 'exact' });
      if (error && /campaign_id/.test(error.message)) { rows = rows.map(({ campaign_id: _c, ...r }) => r); ({ error, count } = await db.from('ad_spend').upsert(rows.slice(i, i + 500), { onConflict: 'workspace_id,day,platform,campaign', count: 'exact' })); }   // before the 18 update
      if (error) throw new Error('Saving ad spend: ' + error.message); na += count ?? 0;
    }
  }
  if (got.insights?.length) {                                   // ad sets / ads for the AI Advisor (needs 18_ai_advisor.sql — skipped quietly before it)
    const rows = got.insights.map((x) => ({ workspace_id: ws, ...x, spend: Math.round(x.spend * 100) / 100, updated_at: new Date().toISOString() }));
    for (let i = 0; i < rows.length; i += 500) { const { error } = await db.from('ad_insights').upsert(rows.slice(i, i + 500), { onConflict: 'workspace_id,day,level,ext_id' }); if (error) { console.error('ad_insights', error.message); break; } }
  }
  return { orders: no, products: np, ads: na };
}
/** orders whose stock is kept by the store itself (Shopify / WooCommerce / your API with stock / Amazon FBA) do not change your stock again */
const stockSkip = (platform: string, cfg: any) => platform === 'shopify' || platform === 'woocommerce' || (platform === 'custom' && !!(cfg?.products_url && cfg?.pmap?.stock));
async function syncOne(row: any) {
  const startedAt = new Date().toISOString();
  try {
    const got = await ADAPT[row.platform]({ cfg: row.config ?? {}, sec: row.secret ?? {}, since: row.sync_cursor ? new Date(new Date(row.sync_cursor).getTime() - 3600e3).toISOString() : null, ws: row.workspace_id });
    const r = await store(row.workspace_id, row.platform, got, row.config ?? {});
    await db.from('store_connections').update({ last_sync_at: startedAt, sync_cursor: startedAt, last_status: 'ok', last_error: '', last_count: r.orders + r.products + r.ads, updated_at: startedAt }).eq('workspace_id', row.workspace_id).eq('platform', row.platform);
    return r;
  } catch (e) {
    await db.from('store_connections').update({ last_sync_at: startedAt, last_status: 'error', last_error: cut((e as Error).message, 300), updated_at: startedAt }).eq('workspace_id', row.workspace_id).eq('platform', row.platform);
    throw e;
  }
}
// ---------------- two ways to connect (Admin Console → Settings → Connect methods) ----------------
const CONN_KEY: Record<string, string> = { shopify: 'shopify', amazon: 'amazon', meta_ads: 'ads' };
const METHOD_DEF: Record<string, any> = { shopify: { a: { on: true, name: 'Own Shopify app' }, b: { on: false, name: 'Connect with Shopify' } }, amazon: { a: { on: true, name: 'Own Amazon developer app' }, b: { on: false, name: 'Connect with Amazon' } }, ads: { a: { on: true, name: 'Access token' }, b: { on: false, name: 'Connect with Facebook' } }, wa: { a: { on: true }, b: { on: false } } };
async function methods(k: string) {
  const { data } = await db.from('platform_settings').select('value').eq('key', 'connectModesJson').maybeSingle();
  let c: any = {}; try { c = JSON.parse(data?.value ?? '{}') ?? {}; } catch { /* default */ }
  const d = METHOD_DEF[k] ?? { a: { on: true, name: 'Own app' }, b: { on: false, name: 'One click' } }, x = c?.[k] ?? {};
  return { a: { ...d.a, ...(x.a ?? {}) }, b: { ...d.b, ...(x.b ?? {}) } };
}
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const randomState = () => 'st' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
const SC_HOST: Record<string, string> = { A21TBJUM6AAA2I: 'https://sellercentral.amazon.in', A2VIGQ35RCS4UG: 'https://sellercentral.amazon.ae', A17E79C6D8DWNP: 'https://sellercentral.amazon.sa', A1F83G8C2ARO7P: 'https://sellercentral.amazon.co.uk',
  A1PA6795UKMFR9: 'https://sellercentral.amazon.de', ATVPDKIKX0DER: 'https://sellercentral.amazon.com', A2EUQ1WTGCTBG2: 'https://sellercentral.amazon.ca', A39IBJ37TRP1C6: 'https://sellercentral.amazon.com.au', A19VAU5U5O7RUS: 'https://sellercentral.amazon.sg' };
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const shopOf = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
async function hmacHex(secret: string, text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))).map((x) => x.toString(16).padStart(2, '0')).join('');
}
const metaAppId = async (M: any) => env('META_APP_ID') || String(M.b.appId ?? '').trim() || String((await methods('wa')).b.appId ?? '').trim();

/** option B, step 1: where to send the client to approve (Shopify / Amazon / Facebook), with a one-time state */
async function oauthStart(ws: string, uid: string, platform: string, b: any) {
  const key = CONN_KEY[platform]; if (!key) return json({ error: 'This connection has no one-click option.' }, 400);
  const M = await methods(key); if (!M.b.on) return json({ error: `“${M.b.name}” is switched off. Use “${M.a.name}” instead.` }, 403);
  const redirect = String(b.redirect_uri ?? '').split('#')[0].split('?')[0];
  if (!/^https:\/\/[^\s]+$/.test(redirect) && !(ALLOW_HTTP && /^http:\/\/[^\s]+$/.test(redirect))) return json({ error: 'Open Nodevers from its https:// address and try again.' }, 400);
  const state = randomState(), notReady = (what: string) => json({ error: `${M.b.name} is not set up on the server yet (${what}). Please tell the Nodevers team.` }, 500);
  let url = '', extra: any = {};
  if (platform === 'shopify') {
    const shop = shopOf(b.shop); if (!SHOP_RE.test(shop)) return json({ error: 'Type your store link like yourstore.myshopify.com' }, 400);
    const cid = env('SHOPIFY_CLIENT_ID') || String(M.b.clientId ?? '').trim(); if (!cid || !env('SHOPIFY_CLIENT_SECRET')) return notReady('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET');
    url = `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({ client_id: cid, scope: 'read_orders,read_products,read_inventory', redirect_uri: redirect, state }); extra = { shop };
  } else if (platform === 'amazon') {
    const mk = AMZ_MKT[b.marketplace] ? String(b.marketplace) : 'A21TBJUM6AAA2I', appId = env('AMAZON_APP_ID') || String(M.b.appId ?? '').trim();
    if (!appId || !AMZ_PLAT.id || !AMZ_PLAT.secret) return notReady('AMAZON_APP_ID / AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET');
    url = `${SC_HOST[mk]}/apps/authorize/consent?` + new URLSearchParams({ application_id: appId, state, redirect_uri: redirect, ...(M.b.beta ? { version: 'beta' } : {}) }); extra = { marketplace: mk, fba: b.fba !== false };
  } else {
    const appId = await metaAppId(M), cfgId = String(M.b.configId ?? '').trim(); if (!appId || !env('META_APP_SECRET')) return notReady('META_APP_ID / META_APP_SECRET');
    url = `https://www.facebook.com/v25.0/dialog/oauth?` + new URLSearchParams({ client_id: appId, redirect_uri: redirect, state, response_type: 'code', ...(cfgId ? { config_id: cfgId } : { scope: 'ads_read' }) });
  }
  await db.from('oauth_states').delete().lt('created_at', new Date(Date.now() - 864e5).toISOString());
  const { error } = await db.from('oauth_states').insert({ state, workspace_id: ws, user_id: uid, platform, redirect_uri: redirect, extra });
  if (error) return json({ error: 'Run 20_connect_methods.sql in Supabase first (' + error.message + ').' }, 500);
  return json({ ok: true, url });
}

/** option B, step 2: the client comes back with a code → keys are fetched and saved on the server, then the first sync runs */
async function oauthFinish(user: any, b: any) {
  const state = String(b.state ?? ''), P = b.params && typeof b.params === 'object' ? b.params : {};
  if (state.length < 20) return json({ error: 'The login link is not complete — press Connect again.' }, 400);
  const { data: st } = await db.from('oauth_states').select('*').eq('state', state).maybeSingle();
  if (!st) return json({ error: 'This login link was already used or has expired — press Connect again.' }, 400);
  await db.from('oauth_states').delete().eq('state', state);
  if (st.user_id !== user.id) return json({ error: 'Please finish the connection with the same Nodevers login you started it with.' }, 403);
  if (Date.now() - new Date(st.created_at).getTime() > 30 * 6e4) return json({ error: 'The login took too long — press Connect again.' }, 400);
  const ws = st.workspace_id, platform = st.platform;
  const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', user.id).maybeSingle();
  if (!m || !['owner', 'admin'].includes(m.role)) return json({ error: 'Only the owner or an admin can change store connections.' }, 403);
  const M = await methods(CONN_KEY[platform]); if (!M.b.on) return json({ error: `“${M.b.name}” is switched off.` }, 403);
  if (P.error || P.error_description) return json({ error: 'Not connected — ' + cut(P.error_description || P.error_reason || P.error, 200) }, 400);
  const config: any = { method: 'app', sync_minutes: platform === 'meta_ads' ? 360 : platform === 'amazon' ? 60 : 15 }, secret: any = {};
  let accounts: any[] | undefined;
  if (platform === 'shopify') {
    const shop = shopOf(P.shop), csec = env('SHOPIFY_CLIENT_SECRET'), cid = env('SHOPIFY_CLIENT_ID') || String(M.b.clientId ?? '').trim();
    if (!SHOP_RE.test(shop) || shop !== st.extra?.shop) return json({ error: 'Shopify sent back a different store — press Connect again.' }, 400);
    const msg = Object.keys(P).filter((k) => k !== 'hmac' && k !== 'signature').sort().map((k) => `${k}=${P[k]}`).join('&');
    if (!P.hmac || (await hmacHex(csec, msg)) !== String(P.hmac).toLowerCase()) return json({ error: 'Shopify’s answer could not be checked — press Connect again.' }, 400);
    const r = await fetch(shopOauth(shop), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ client_id: cid, client_secret: csec, code: String(P.code ?? '') }), signal: AbortSignal.timeout(20000) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok || !j.access_token) return json({ error: 'Shopify did not give access' + (j.error_description ? ` (${j.error_description})` : '') + ' — press Connect again.' }, 400);
    config.store_url = shop; config.shop_auth = 'token'; secret.token = String(j.access_token);
  } else if (platform === 'amazon') {
    const r = await fetch(LWA_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: String(P.spapi_oauth_code ?? ''), client_id: AMZ_PLAT.id, client_secret: AMZ_PLAT.secret, redirect_uri: st.redirect_uri }), signal: AbortSignal.timeout(20000) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok || !j.refresh_token) return json({ error: 'Amazon did not give access' + (j.error_description ? ` (${j.error_description})` : '') + ' — press Connect again.' }, 400);
    const mk = AMZ_MKT[st.extra?.marketplace] ? st.extra.marketplace : 'A21TBJUM6AAA2I';
    Object.assign(config, { marketplace: mk, marketplace_name: AMZ_MKT[mk][0], fba: st.extra?.fba !== false, seller_id: cut(String(P.selling_partner_id ?? '').replace(/[^A-Za-z0-9]/g, ''), 30) });
    secret.refresh_token = String(j.refresh_token); secret.app = '1';
  } else {
    const appId = await metaAppId(M);
    const r = await fetch(`${GRAPH}/oauth/access_token?` + new URLSearchParams({ client_id: appId, client_secret: env('META_APP_SECRET'), redirect_uri: st.redirect_uri, code: String(P.code ?? '') }), { signal: AbortSignal.timeout(20000) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok || !j.access_token) return json({ error: 'Facebook did not give access' + (j?.error?.message ? ` (${j.error.message})` : '') + ' — press Connect again.' }, 400);
    secret.token = String(j.access_token);
    const a = await metaGet(`${GRAPH}/me/adaccounts?fields=account_id,name&limit=100`, secret.token).catch(() => ({ data: [] }));
    accounts = (a.data ?? []).map((x: any) => ({ id: cut(String(x.account_id ?? '').replace(/\D/g, ''), 25), name: cut(x.name, 120) })).filter((x: any) => x.id).slice(0, 50);
    if (!accounts!.length) return json({ error: 'No ad account was shared — press Connect again and tick your ad account.' }, 400);
    config.ad_account = accounts![0].id; config.accounts = accounts;
  }
  const { data: on } = await db.rpc('ws_feature', { ws, k: featureOf(platform) }); if (on === false) return json({ error: (platform === 'meta_ads' ? 'Ads Manager is' : 'The Store is') + ' not part of your plan.' }, 402);
  const now = new Date().toISOString();
  const { data: cur } = await db.from('store_connections').select('workspace_id').eq('workspace_id', ws).eq('platform', platform).maybeSingle();
  const { error } = await db.from('store_connections').upsert({ workspace_id: ws, platform, config, secret, updated_at: now, ...(cur ? {} : { created_at: now, sync_cursor: null }) }, { onConflict: 'workspace_id,platform' });
  if (error) return json({ error: error.message }, 500);
  const { data: row } = await db.from('store_connections').select('*').eq('workspace_id', ws).eq('platform', platform).single();
  try { const r = await syncOne(row); return json({ ok: true, platform, workspace_id: ws, accounts, ...r }); } catch (e) { return json({ ok: true, platform, workspace_id: ws, accounts, warning: (e as Error).message }); }
}

function publicRow(r: any) { const cfg = { ...(r.config ?? {}) }; return { connected: true, config: cfg, last_sync_at: r.last_sync_at, last_status: r.last_status, last_error: r.last_error, last_count: r.last_count }; }
async function rememberUrl() { await db.from('app_config').upsert({ key: 'functions_url', value: `${SB_URL.replace(/\/+$/, '')}/functions/v1` }, { onConflict: 'key' }); }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    // ---- scheduled run ----
    if (b.action === 'cron') {
      const { data: sec } = await db.from('app_config').select('value').eq('key', 'cron_secret').maybeSingle();
      if (!sec?.value || req.headers.get('x-cron-secret') !== sec.value) return json({ error: 'Forbidden' }, 403);
      const { data: rows } = await db.from('store_connections').select('*').limit(200);
      const locked = new Set<string>(); for (const w of [...new Set((rows ?? []).map((r: any) => r.workspace_id))]) { const { data: s } = await db.rpc('ws_state', { ws: w }); if (s === 'locked') locked.add(w as string); else for (const k of ['store', 'ads']) { const { data: on } = await db.rpc('ws_feature', { ws: w, k }); if (on === false) locked.add(w + '|' + k); } }
      const due = (rows ?? []).filter((r: any) => { if (locked.has(r.workspace_id) || locked.has(r.workspace_id + '|' + featureOf(r.platform))) return false; const mins = Number(r.config?.sync_minutes ?? 15); if (!mins) return false; return !r.last_sync_at || Date.now() - new Date(r.last_sync_at).getTime() >= (mins - 2) * 6e4; });
      const out: any[] = []; for (const r of due.slice(0, 25)) { try { out.push({ ws: r.workspace_id, platform: r.platform, ...(await syncOne(r)) }); } catch (e) { out.push({ ws: r.workspace_id, platform: r.platform, error: (e as Error).message }); } }
      return json({ ok: true, synced: out.length, out });
    }
    // ---- signed-in owner / admin ----
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    if (b.action === 'oauth_finish') return await oauthFinish(u.user, b);
    const ws = String(b.workspace_id ?? '');
    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m) return json({ error: 'Not a member of this workspace.' }, 403);
    rememberUrl().catch(() => null);
    if (b.action === 'list') { const { data } = await db.from('store_connections').select('*').eq('workspace_id', ws); return json({ ok: true, connections: Object.fromEntries((data ?? []).map((r: any) => [r.platform, publicRow(r)])) }); }
    if (!['owner', 'admin'].includes(m.role)) return json({ error: 'Only the owner or an admin can change store connections.' }, 403);
    const platform = String(b.platform ?? ''); if (!ADAPT[platform]) return json({ error: 'Unknown platform.' }, 400);
    { const { data: on } = await db.rpc('ws_feature', { ws, k: featureOf(platform) }); if (on === false) return json({ error: (platform === 'meta_ads' ? 'Ads Manager is' : 'The Store is') + ' not part of your plan. Upgrade in Settings → Plan & billing.' }, 402); }
    const { data: cur } = await db.from('store_connections').select('*').eq('workspace_id', ws).eq('platform', platform).maybeSingle();
    if (b.action === 'delete') { await db.from('store_connections').delete().eq('workspace_id', ws).eq('platform', platform); return json({ ok: true }); }
    if (b.action === 'oauth_start') return await oauthStart(ws, u.user.id, platform, b);
    if (b.action === 'sync') { if (!cur) return json({ error: 'Connect it first.' }, 400); const { data: wst } = await db.rpc('ws_state', { ws }); if (wst === 'locked') return json({ error: 'Your plan has ended — this workspace is view-only. Renew it in Settings → Plan & billing.' }, 402);  return json({ ok: true, ...(await syncOne(cur)) }); }
    const cfgIn = (b.config && typeof b.config === 'object') ? b.config : {};
    const config: any = { sync_minutes: [0, 15, 60, 360, 1440].includes(Number(cfgIn.sync_minutes)) ? Number(cfgIn.sync_minutes) : 15 };
    if (platform === 'shopify') config.store_url = cut(String(cfgIn.store_url ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), 120);
    if (platform === 'woocommerce') config.site_url = cut(String(cfgIn.site_url ?? '').replace(/\/+$/, ''), 300);
    if (platform === 'amazon') { config.marketplace = AMZ_MKT[cfgIn.marketplace] ? String(cfgIn.marketplace) : 'A21TBJUM6AAA2I'; config.marketplace_name = AMZ_MKT[config.marketplace][0]; config.fba = cfgIn.fba !== false; config.seller_id = cut(String(cfgIn.seller_id ?? '').replace(/[^A-Za-z0-9]/g, ''), 30); }
    if (platform === 'meta_ads') { config.ad_account = cut(String(cfgIn.ad_account ?? '').replace(/^act_/i, '').replace(/\D/g, ''), 25); if (![0, 15, 60, 360, 1440].includes(Number(cfgIn.sync_minutes))) config.sync_minutes = 360; }
    if (platform === 'custom') { for (const k of ['orders_url', 'products_url']) config[k] = cut(cfgIn[k], 500); config.auth = ['bearer', 'header', 'query', 'none'].includes(cfgIn.auth) ? cfgIn.auth : 'bearer'; config.auth_name = cut(cfgIn.auth_name, 60);
      for (const k of ['map', 'pmap']) config[k] = Object.fromEntries(Object.entries(cfgIn[k] ?? {}).filter(([, v]) => typeof v === 'string' && (v as string).length <= 200).slice(0, 40));
      for (const k of ['keys', 'pkeys']) config[k] = (Array.isArray(cfgIn[k]) ? cfgIn[k] : []).map(String).slice(0, 200); config.list_path = cut(cfgIn.list_path, 120); config.plist_path = cut(cfgIn.plist_path, 120); }
    const secIn = b.secret && typeof b.secret === 'object' ? b.secret : null;
    const pasted = Object.fromEntries(Object.entries(secIn ?? {}).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => [k, cut(v, 1500)]));
    // own keys pasted (or a new connection) → option A; otherwise keep how it was connected (A or B)
    const curMethod = cur ? String(cur.config?.method || 'own') : '', method = Object.keys(pasted).length || !cur ? 'own' : curMethod;
    if (CONN_KEY[platform] && method === 'own' && curMethod !== 'own') { const M = await methods(CONN_KEY[platform]); if (!M.a.on) return json({ error: `“${M.a.name}” is switched off. Use “${M.b.name}” instead.` }, 403); }
    config.method = method;
    if (platform === 'meta_ads' && method === 'app' && Array.isArray(cur?.config?.accounts)) config.accounts = cur.config.accounts;
    const secret: any = { ...(cur && curMethod === method ? (cur.secret ?? {}) : {}), ...pasted };   // paste one key to change just that one
    if (platform === 'shopify' && pasted.client_id) delete secret.token;                             // moved to a Dev Dashboard app
    if (platform === 'shopify' && pasted.token) { delete secret.client_id; delete secret.client_secret; }
    if (platform === 'shopify' && !secret.token && !(secret.client_id && secret.client_secret)) return json({ error: 'Paste the Client ID and Client secret of your Shopify app.' }, 400);
    if (platform === 'shopify') config.shop_auth = secret.token ? 'token' : 'client';
    if (platform === 'woocommerce' && (!secret.key || !secret.secret)) return json({ error: 'Paste the consumer key and consumer secret.' }, 400);
    if (platform === 'custom' && !config.orders_url) return json({ error: 'Paste the orders API link.' }, 400);
    if (platform === 'amazon' && method !== 'app' && (!secret.client_id || !secret.client_secret || !secret.refresh_token)) return json({ error: 'Paste the LWA client ID, client secret and refresh token.' }, 400);
    if (platform === 'meta_ads' && !config.ad_account) return json({ error: 'Paste your ad account ID.' }, 400);
    if (platform === 'meta_ads' && !secret.token) return json({ error: 'Paste the access token.' }, 400);
    if (platform === 'custom' && config.auth !== 'none' && !secret.key) return json({ error: 'Paste the API key (or choose “No key”).' }, 400);
    // ---- test: read a little and report ----
    if (b.action === 'test' || (platform === 'custom' && !config.map?.extId)) {
      if (platform === 'custom') {
        const { H, u: url } = customHeaders(config, secret, config.orders_url), { data } = await getJSON(url, H), { list, path } = findList(data, config.list_path);
        if (!list.length) return json({ error: 'The API answered, but the list is empty — create a test order first.' }, 400);
        const keys = paths(list[0]); let pk: string[] | undefined, ppath: string | undefined;
        if (config.products_url) { const p = customHeaders(config, secret, config.products_url), r = await getJSON(p.u, p.H), pl = findList(r.data, config.plist_path); if (pl.list.length) { pk = paths(pl.list[0]); ppath = pl.path; } }
        return json({ ok: true, message: `Found ${list.length} orders${pk ? ' and products' : ''} — now match the fields below and press Connect.`, keys, list_path: path, pkeys: pk, plist_path: ppath, sample: JSON.stringify(list[0]).slice(0, 160) });
      }
      const got = await ADAPT[platform]({ cfg: config, sec: secret, since: new Date(Date.now() - 30 * 864e5).toISOString(), ws });
      if (platform === 'meta_ads') { const spend = (got.ads ?? []).reduce((s2, a) => s2 + a.spend, 0), camps = new Set((got.ads ?? []).map((a) => a.campaign)).size; return json({ ok: true, message: `Connected — ${camps} campaigns, ₹${Math.round(spend).toLocaleString('en-IN')} spent in the last 30 days.` }); }
      if (platform === 'amazon') return json({ ok: true, message: `Connected to ${AMZ_MKT[config.marketplace][0]} — ${got.orders.length} new order lines and ${(got.updates ?? []).length} order updates (last 30 days), ${got.products.length} FBA products.` });
      return json({ ok: true, message: `Connected — ${got.orders.length} order lines (last 30 days) and ${got.products.length} products found.` });
    }
    // ---- save + first sync ----
    const now = new Date().toISOString();
    const { error } = await db.from('store_connections').upsert({ workspace_id: ws, platform, config, secret, updated_at: now, ...(cur ? {} : { created_at: now, sync_cursor: null }) }, { onConflict: 'workspace_id,platform' });
    if (error) return json({ error: error.message }, 500);
    const { data: row } = await db.from('store_connections').select('*').eq('workspace_id', ws).eq('platform', platform).single();
    try { const r = await syncOne(row); return json({ ok: true, ...r }); } catch (e) { return json({ ok: true, warning: (e as Error).message }); }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
