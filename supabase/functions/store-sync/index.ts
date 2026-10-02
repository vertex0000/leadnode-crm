// Nodevers — store-sync: the client pastes THEIR website's API key in Nodevers → Connections; this function pulls orders, products and stock.
//   Shopify (Admin API access token), WooCommerce (consumer key + secret), any website (custom JSON API + field matching).
//   Actions (signed-in owner / admin): list · test · save · sync · delete.   Every 15 min (pg_cron, header x-cron-secret): cron.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "store-sync" → paste → Deploy → turn OFF "Enforce JWT verification".
// No secrets to add. Needs 10_connections_alerts.sql.
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
type Ctx = { cfg: any; sec: any; since: string | null };
const shopBase = (cfg: any) => `https://${String(cfg.store_url).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/admin/api/2024-10`;
const SHOP_BASE_OVERRIDE = Deno.env.get('SHOPIFY_BASE');                 // local tests
async function shopify(ctx: Ctx, limitPages = 8) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(String(ctx.cfg.store_url || '')) && !SHOP_BASE_OVERRIDE) throw new Error('Store link should look like yourstore.myshopify.com');
  const base = SHOP_BASE_OVERRIDE || shopBase(ctx.cfg), H = { 'X-Shopify-Access-Token': String(ctx.sec.token || '') };
  const orders: any[] = [], products: any[] = [];
  let url: string | null = `${base}/orders.json?status=any&limit=250${ctx.since ? '&updated_at_min=' + encodeURIComponent(ctx.since) : '&created_at_min=' + encodeURIComponent(new Date(Date.now() - 90 * 864e5).toISOString())}`;
  for (let i = 0; url && i < limitPages; i++) {
    const { data, headers } = await getJSON(url, H);
    for (const o of data.orders ?? []) {
      const items = o.line_items ?? [], ship = num(o.total_shipping_price_set?.shop_money?.amount ?? o.shipping_lines?.reduce?.((a: number, s: any) => a + Number(s.price || 0), 0)), gw = (o.payment_gateway_names ?? []).join(', ');
      const st = o.cancelled_at ? 'Cancelled' : /refunded/.test(o.financial_status) ? 'Refunded' : o.fulfillment_status === 'fulfilled' ? 'Shipped' : o.financial_status === 'paid' ? 'Paid' : /cash|cod/i.test(gw) ? 'COD' : 'New';
      items.forEach((li: any, k: number) => {
        const disc = (li.discount_allocations ?? []).reduce((a: number, d: any) => a + Number(d.amount || 0), 0), qty = Number(li.quantity || 1), unit = num(li.price);
        orders.push({ ext_id: cut(items.length > 1 ? `${o.name || o.id}-${k + 1}` : (o.name || o.id), 80), order_date: dateOf(o.created_at), sku: cut(li.sku, 80), product_name: cut(li.title + (li.variant_title ? ' · ' + li.variant_title : ''), 200), qty,
          unit_price: unit, amount: unit != null ? Math.max(0, unit * qty - disc) : null, shipping_fee: k === 0 ? ship : null, status: st, payment: cut(gw, 40),
          customer_name: cut([o.shipping_address?.first_name, o.shipping_address?.last_name].filter(Boolean).join(' ') || o.customer?.first_name || '', 120), customer_state: cut(o.shipping_address?.province, 60), customer_city: cut(o.shipping_address?.city, 60),
          tracking_url: cut(o.fulfillments?.[0]?.tracking_url, 500), courier: cut(o.fulfillments?.[0]?.tracking_company, 60) });
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
  return { orders, products };
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
        customer_name: cut([o.shipping?.first_name || o.billing?.first_name, o.shipping?.last_name || o.billing?.last_name].filter(Boolean).join(' '), 120), customer_state: cut(o.shipping?.state || o.billing?.state, 60), customer_city: cut(o.shipping?.city || o.billing?.city, 60) }));
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
      shipping_fee: num(g('shippingFee')), marketplace_fee: num(g('marketplaceFee')), courier: cut(g('courier'), 60), tracking_url: /^https?:\/\//.test(String(g('trackingUrl') ?? '')) ? cut(g('trackingUrl'), 500) : '' };
  }).filter((o: any) => o.ext_id);
  let products: any[] = [];
  if (cfg.products_url && pm.sku) {
    const p = customHeaders(cfg, sec, cfg.products_url), r = await getJSON(p.u, p.H), pl = findList(r.data, cfg.plist_path).list;
    products = pl.slice(0, 5000).map((x: any) => ({ sku: cut(pick(x, pm.sku), 80), name: cut(pick(x, pm.name), 200), category: cut(pick(x, pm.category), 80), price: num(pick(x, pm.price)), cost: pm.cost ? num(pick(x, pm.cost)) : undefined, stock: pm.stock ? num(pick(x, pm.stock)) : null })).filter((p: any) => p.sku);
  }
  return { orders, products };
}
const ADAPT: Record<string, (c: Ctx) => Promise<{ orders: any[]; products: any[] }>> = { shopify, woocommerce, custom };
const SOURCE: Record<string, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce', custom: 'Website API' };

async function store(ws: string, platform: string, got: { orders: any[]; products: any[] }) {
  let np = 0, no = 0;
  if (got.products.length) {
    const seen = new Set<string>(), rows = got.products.filter((p) => !seen.has(p.sku) && seen.add(p.sku)).map((p) => { const r: any = { workspace_id: ws, sku: p.sku, name: p.name || p.sku }; for (const k of ['category', 'price', 'image_url', 'website_url']) if (p[k] !== undefined && p[k] !== null && p[k] !== '') r[k] = p[k]; if (p.cost != null) r.cost = p.cost; if (p.stock != null) r.stock = Math.round(Number(p.stock)); return r; });
    // upsert in groups that share the same columns (so missing values never wipe what the client typed)
    const groups = new Map<string, any[]>(); rows.forEach((r) => { const k = Object.keys(r).sort().join(','); (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); });
    for (const g of groups.values()) for (let i = 0; i < g.length; i += 500) { const { error, count } = await db.from('products').upsert(g.slice(i, i + 500), { onConflict: 'workspace_id,sku', count: 'exact' }); if (error) throw new Error('Saving products: ' + error.message); np += count ?? 0; }
  }
  if (got.orders.length) {
    const seen = new Set<string>(), rows = got.orders.filter((o) => o.ext_id && !seen.has(o.ext_id) && seen.add(o.ext_id)).map((o) => { const r: any = { workspace_id: ws, channel: 'Website', source: SOURCE[platform], lead_id: null }; for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v === '' && !['sku', 'product_name', 'payment', 'customer_name', 'customer_state', 'customer_city', 'courier', 'tracking_url'].includes(k) ? null : v; return r; });
    const cols = ['workspace_id', 'channel', 'source', 'lead_id', 'ext_id', 'order_date', 'sku', 'product_name', 'qty', 'unit_price', 'amount', 'shipping_fee', 'marketplace_fee', 'status', 'payment', 'customer_name', 'customer_state', 'customer_city', 'courier', 'tracking_url'];
    const norm = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? (['qty'].includes(c) ? 1 : ['sku', 'product_name', 'payment', 'customer_name', 'customer_state', 'customer_city', 'courier', 'tracking_url'].includes(c) ? '' : c === 'status' ? 'New' : null)])));
    for (let i = 0; i < norm.length; i += 500) { const { error, count } = await db.from('orders').upsert(norm.slice(i, i + 500), { onConflict: 'workspace_id,channel,ext_id', count: 'exact' }); if (error) throw new Error('Saving orders: ' + error.message); no += count ?? 0; }
  }
  return { orders: no, products: np };
}
async function syncOne(row: any) {
  const startedAt = new Date().toISOString();
  try {
    const got = await ADAPT[row.platform]({ cfg: row.config ?? {}, sec: row.secret ?? {}, since: row.sync_cursor ? new Date(new Date(row.sync_cursor).getTime() - 3600e3).toISOString() : null });
    const r = await store(row.workspace_id, row.platform, got);
    await db.from('store_connections').update({ last_sync_at: startedAt, sync_cursor: startedAt, last_status: 'ok', last_error: '', last_count: r.orders + r.products, updated_at: startedAt }).eq('workspace_id', row.workspace_id).eq('platform', row.platform);
    return r;
  } catch (e) {
    await db.from('store_connections').update({ last_sync_at: startedAt, last_status: 'error', last_error: cut((e as Error).message, 300), updated_at: startedAt }).eq('workspace_id', row.workspace_id).eq('platform', row.platform);
    throw e;
  }
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
      const locked = new Set<string>(); for (const w of [...new Set((rows ?? []).map((r: any) => r.workspace_id))]) { const { data: s } = await db.rpc('ws_state', { ws: w }); if (s === 'locked') locked.add(w as string); else { const { data: on } = await db.rpc('ws_feature', { ws: w, k: 'store' }); if (on === false) locked.add(w as string); } }
      const due = (rows ?? []).filter((r: any) => { if (locked.has(r.workspace_id)) return false; const mins = Number(r.config?.sync_minutes ?? 15); if (!mins) return false; return !r.last_sync_at || Date.now() - new Date(r.last_sync_at).getTime() >= (mins - 2) * 6e4; });
      const out: any[] = []; for (const r of due.slice(0, 25)) { try { out.push({ ws: r.workspace_id, platform: r.platform, ...(await syncOne(r)) }); } catch (e) { out.push({ ws: r.workspace_id, platform: r.platform, error: (e as Error).message }); } }
      return json({ ok: true, synced: out.length, out });
    }
    // ---- signed-in owner / admin ----
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const ws = String(b.workspace_id ?? '');
    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m) return json({ error: 'Not a member of this workspace.' }, 403);
    { const { data: on } = await db.rpc('ws_feature', { ws, k: 'store' }); if (on === false) return json({ error: 'The Store is not part of your plan. Upgrade in Settings → Plan & billing.' }, 402); }
    rememberUrl().catch(() => null);
    if (b.action === 'list') { const { data } = await db.from('store_connections').select('*').eq('workspace_id', ws); return json({ ok: true, connections: Object.fromEntries((data ?? []).map((r: any) => [r.platform, publicRow(r)])) }); }
    if (!['owner', 'admin'].includes(m.role)) return json({ error: 'Only the owner or an admin can change store connections.' }, 403);
    const platform = String(b.platform ?? ''); if (!ADAPT[platform]) return json({ error: 'Unknown platform.' }, 400);
    const { data: cur } = await db.from('store_connections').select('*').eq('workspace_id', ws).eq('platform', platform).maybeSingle();
    if (b.action === 'delete') { await db.from('store_connections').delete().eq('workspace_id', ws).eq('platform', platform); return json({ ok: true }); }
    if (b.action === 'sync') { if (!cur) return json({ error: 'Connect it first.' }, 400); const { data: wst } = await db.rpc('ws_state', { ws }); if (wst === 'locked') return json({ error: 'Your plan has ended — this workspace is view-only. Renew it in Settings → Plan & billing.' }, 402);  return json({ ok: true, ...(await syncOne(cur)) }); }
    const cfgIn = (b.config && typeof b.config === 'object') ? b.config : {};
    const config: any = { sync_minutes: [0, 15, 60, 360, 1440].includes(Number(cfgIn.sync_minutes)) ? Number(cfgIn.sync_minutes) : 15 };
    if (platform === 'shopify') config.store_url = cut(String(cfgIn.store_url ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), 120);
    if (platform === 'woocommerce') config.site_url = cut(String(cfgIn.site_url ?? '').replace(/\/+$/, ''), 300);
    if (platform === 'custom') { for (const k of ['orders_url', 'products_url']) config[k] = cut(cfgIn[k], 500); config.auth = ['bearer', 'header', 'query', 'none'].includes(cfgIn.auth) ? cfgIn.auth : 'bearer'; config.auth_name = cut(cfgIn.auth_name, 60);
      for (const k of ['map', 'pmap']) config[k] = Object.fromEntries(Object.entries(cfgIn[k] ?? {}).filter(([, v]) => typeof v === 'string' && (v as string).length <= 200).slice(0, 40));
      for (const k of ['keys', 'pkeys']) config[k] = (Array.isArray(cfgIn[k]) ? cfgIn[k] : []).map(String).slice(0, 200); config.list_path = cut(cfgIn.list_path, 120); config.plist_path = cut(cfgIn.plist_path, 120); }
    const secIn = b.secret && typeof b.secret === 'object' ? b.secret : null;
    const secret = secIn ? Object.fromEntries(Object.entries(secIn).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => [k, cut(v, 500)])) : (cur?.secret ?? {});
    if (platform === 'shopify' && !secret.token) return json({ error: 'Paste the Admin API access token.' }, 400);
    if (platform === 'woocommerce' && (!secret.key || !secret.secret)) return json({ error: 'Paste the consumer key and consumer secret.' }, 400);
    if (platform === 'custom' && !config.orders_url) return json({ error: 'Paste the orders API link.' }, 400);
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
      const got = await ADAPT[platform]({ cfg: config, sec: secret, since: new Date(Date.now() - 30 * 864e5).toISOString() }, );
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
