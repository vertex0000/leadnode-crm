// Nodevers — track: the website tracking code (t.js), the Shopify customer-events pixel and any website / app send shoppers here.
//   POST /functions/v1/track   body (JSON, sent as text/plain so browsers need no pre-check):
//     { k: <lead capture key>, e: "checkout" | "purchase", id: <checkout / cart id>, phone, email, name, items: [{ sku, name, qty, price }],
//       value, url (link back to the cart), consent (true when the shopper ticked "send me offers"), src ("shopify" for the pixel),
//       order: { id, payment, status } (purchase) }
//   GET  /functions/v1/track?k=<key>&cfg=1  →  { consent: { on, text } }  (the tracking code asks once per page)
// checkout → an abandoned-checkout row (+ the customer profile); purchase → the checkout is recovered and, when the workspace has no store
// connection (Shopify / WooCommerce / own API), the order itself is saved. One profile per phone / email. Speed limit per workspace.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "track" → paste → Deploy → turn OFF "Enforce JWT verification".
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-client-info, apikey, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' };
const json = (o: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json', ...extra } });
const cut = (v: unknown, n: number) => String(v ?? '').slice(0, n);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const cleanPhone = (p: unknown) => { let d = String(p ?? '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1); return /^\d{10,15}$/.test(d) ? d : ''; };
const cleanEmail = (e: unknown) => { const s = String(e ?? '').trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 160 ? s : ''; };
const money = (v: unknown) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
const DEF_CONSENT = 'Send me order updates and offers on WhatsApp';

async function wsOf(key: string) {
  if (!/^[a-f0-9]{20,80}$/i.test(key)) return null;
  const { data } = await db.from('lead_capture_keys').select('workspace_id').eq('key', key).maybeSingle();
  return data?.workspace_id as string | null;
}
async function cfgOf(ws: string) {
  const { data } = await db.from('settings').select('value').eq('workspace_id', ws).eq('key', 'remarketJson').maybeSingle();
  try { return JSON.parse(data?.value ?? '{}') ?? {}; } catch { return {}; }
}
const itemsOf = (b: any) => (Array.isArray(b.items) ? b.items : []).slice(0, 30).map((x: any) => ({ sku: cut(x?.sku ?? x?.item_id ?? x?.id, 80), name: cut(x?.name ?? x?.item_name ?? x?.title, 200), qty: Math.max(1, Math.min(999, Math.round(Number(x?.qty ?? x?.quantity ?? 1)) || 1)), price: money(x?.price) }));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  try {
    if (req.method === 'GET') {                     // settings for the tracking code
      const ws = await wsOf(url.searchParams.get('k') ?? '');
      if (!ws) return json({ error: 'Wrong key' }, 401);
      const c = await cfgOf(ws);
      return json({ ok: true, consent: { on: !!c.consent?.on, text: cut(c.consent?.text || DEF_CONSENT, 160) } }, 200, { 'Cache-Control': 'public, max-age=300' });
    }
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    const raw = await req.text(); if (raw.length > 20000) return json({ error: 'Too big' }, 413);
    let b: any = {}; try { b = JSON.parse(raw || '{}'); } catch { return json({ error: 'Send JSON' }, 400); }
    const ws = await wsOf(String(b.k ?? b.key ?? url.searchParams.get('k') ?? ''));
    if (!ws) return json({ error: 'Wrong or old key — copy the tracking code again from Nodevers → Connections.' }, 401);
    const { data: wst } = await db.rpc('ws_state', { ws }); if (wst === 'locked') return json({ error: 'Workspace paused' }, 402);
    const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const ipKey = 'ip:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + ws)))).slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
    const [{ data: okIp }, { data: okAll }] = await Promise.all([db.rpc('track_hit', { p_ws: ws, p_bucket: ipKey, p_max: 60 }), db.rpc('track_hit', { p_ws: ws, p_bucket: 'all', p_max: 3000 })]);
    if (okIp === false || okAll === false) return json({ error: 'Too many requests — slow down.' }, 429);

    const e = String(b.e ?? b.event ?? ''), phone = cleanPhone(b.phone), email = cleanEmail(b.email), name = cut(String(b.name ?? '').trim(), 120);
    const rawId = String(b.id ?? b.checkout_id ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100), id = rawId ? (b.src === 'shopify' ? 'shopify:' : 'web:') + rawId : '';
    const items = itemsOf(b), value = money(b.value) ?? (items.reduce((a: number, x: any) => a + (x.price ?? 0) * x.qty, 0) || null);
    const consent = b.consent === true ? true : b.consent === false ? false : undefined;
    const link = /^https:\/\/\S+$/.test(String(b.url ?? '')) ? cut(b.url, 1000) : '';

    if (e === 'checkout') {
      if (!id) return json({ error: 'Missing checkout id' }, 400);
      if (!phone && !email) return json({ ok: true, waiting: 'phone or email' });     // nothing to remind with yet
      const row: any = { workspace_id: ws, checkout_id: id, phone, email, channel: 'Website', source: b.src === 'shopify' ? 'Shopify pixel' : 'Website tracking' };
      if (name) row.name = name; if (items.length) { row.items = cut(items.map((x: any) => `${x.qty > 1 ? x.qty + ' × ' : ''}${x.name || x.sku}`).join(', '), 2000); row.skus = items.map((x: any) => x.sku).filter(Boolean); }
      if (value != null) row.amount = value; if (link) row.url = link; if (consent !== undefined) row.consent = consent;
      const { error } = await db.from('checkouts').upsert(row, { onConflict: 'workspace_id,checkout_id' });
      if (error) { console.error('track checkout', error.message); return json({ error: 'Could not save' }, 500); }
      return json({ ok: true });
    }
    if (e === 'purchase') {
      const o = b.order ?? {}, orderId = cut(String(o.id ?? b.order_id ?? b.transaction_id ?? '').replace(/[^\w#.\-\/]/g, ''), 60);
      if (id) await db.from('checkouts').update({ status: 'recovered', order_ref: orderId }).eq('workspace_id', ws).eq('checkout_id', id).eq('status', 'open');
      if (consent === true && (phone || email)) {                                     // ticked "send me offers"
        const { data: lid } = await db.rpc('customer_lead', { p_ws: ws, p_phone: phone, p_email: email, p_name: name, p_city: '', p_state: '', p_source: 'Website', p_stage: 'Won', p_day: today() });
        if (lid) await db.from('leads').update({ mkt_ok: true, mkt_src: 'checkout' }).eq('workspace_id', ws).eq('lead_id', lid).is('mkt_ok', null);
      }
      // the store's own sync brings the order (with its real number) — only websites without a store connection save it from here
      const { data: conn } = await db.from('store_connections').select('platform').eq('workspace_id', ws).in('platform', ['shopify', 'woocommerce', 'custom']).limit(1);
      if (conn?.length || !orderId || (!phone && !email)) return json({ ok: true });
      const pay = cut(o.payment ?? b.payment, 40), status = /cod|cash/i.test(pay) ? 'COD' : /pending|unpaid/i.test(String(o.status ?? '')) ? 'New' : 'Paid';
      const lines = items.length ? items : [{ sku: '', name: 'Website order', qty: 1, price: value }];
      const rows = lines.map((x: any, i: number) => ({ workspace_id: ws, channel: 'Website', source: 'Website tracking', ext_id: cut(lines.length > 1 ? `T-${orderId}-${i + 1}` : `T-${orderId}`, 80), order_ref: orderId,
        order_date: today(), sku: x.sku, product_name: x.name, qty: x.qty, unit_price: x.price, amount: lines.length > 1 ? (x.price != null ? x.price * x.qty : null) : value, status, payment: pay,
        customer_name: name, customer_phone: phone, customer_email: email, items: cut(`${x.qty} × ${x.name || x.sku || 'item'}`, 2000) }));
      const { error } = await db.from('orders').upsert(rows, { onConflict: 'workspace_id,channel,ext_id', ignoreDuplicates: true });
      if (error) { console.error('track purchase', error.message); return json({ error: 'Could not save the order' }, 500); }
      return json({ ok: true, saved: rows.length });
    }
    return json({ error: 'Unknown event — use "checkout" or "purchase".' }, 400);
  } catch (err) {
    console.error('track', err);
    return json({ error: 'Something went wrong' }, 500);
  }
});
