// Nodevers — alerts: sends store alerts (new order, cancelled / RTO, low stock, out of stock, daily summary) by email and / or WhatsApp,
// to the numbers and emails the client saved in Connections → Store alerts.
//   flush / cron (called by the database, header x-cron-secret) · test (signed-in member).
// Email goes through the workspace's own Brevo sender; WhatsApp through its own number with the approved template "nodevers_alert".
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "alerts" → paste → Deploy → turn OFF "Enforce JWT verification".
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const GRAPH = Deno.env.get('WA_GRAPH_URL') ?? 'https://graph.facebook.com/v21.0';
const BREVO = Deno.env.get('BREVO_URL') ?? 'https://api.brevo.com/v3';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const inr = (n: unknown) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const istDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const istHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const DEF: Record<string, string> = { new_order: 'both', cancel: 'both', low_stock: 'email', out_stock: 'both', daily: 'email' };

async function cfgOf(ws: string) {
  const { data } = await db.from('settings').select('key,value').eq('workspace_id', ws).in('key', ['storeAlertsJson', 'brandName']);
  const m = Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
  let c: any = {}; try { c = JSON.parse(m.storeAlertsJson || '{}'); } catch { /* empty */ }
  let brand = m.brandName; if (!brand) { const { data: w } = await db.from('workspaces').select('name').eq('id', ws).maybeSingle(); brand = w?.name || 'your store'; }
  return { emails: (c.emails ?? []).filter((e: string) => /@/.test(e)).slice(0, 5), phones: (c.phones ?? []).map((p: string) => String(p).replace(/\D/g, '')).filter((p: string) => p.length >= 11).slice(0, 5), rules: c.rules ?? {}, brand: String(brand).slice(0, 60) };
}
const chOf = (cfg: any, kind: string) => (cfg.rules[kind]?.ch ?? DEF[kind] ?? 'off') as string;

async function sendEmail(ws: string, to: string[], subject: string, lines: string[]) {
  if (!to.length) return 'no emails';
  const { data: ea } = await db.from('email_accounts').select('*').eq('workspace_id', ws).maybeSingle();
  if (!ea) return 'email not connected';
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">${lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('')}<p style="margin:16px 0 0;color:#888;font-size:12px">Sent by Nodevers · change alerts in Connections → Store alerts</p></div>`;
  const r = await fetch(`${BREVO}/smtp/email`, { method: 'POST', headers: { 'api-key': ea.api_key, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: ea.from_email, name: ea.from_name || 'Nodevers alerts' }, to: to.map((email) => ({ email })), subject: subject.slice(0, 150), htmlContent: html }) }).catch(() => null);
  return r && r.ok ? 'email ok' : `email failed${r ? ' ' + r.status : ''}`;
}
async function sendWa(ws: string, to: string[], brand: string, text: string) {
  if (!to.length) return 'no numbers';
  const { data: acc } = await db.from('wa_accounts').select('*').eq('workspace_id', ws).maybeSingle();
  if (!acc) return 'whatsapp not connected';
  const p = (s: string) => s.replace(/[\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').slice(0, 1000);   // template values: no new lines
  const out: string[] = [];
  for (const num of to) {
    const r = await fetch(`${GRAPH}/${acc.phone_number_id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${acc.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: num, type: 'template', template: { name: 'nodevers_alert', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: p(brand) }, { type: 'text', text: p(text) }] }] } }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    out.push(r && r.ok ? 'wa ok' : `wa failed: ${(j as any)?.error?.message ?? 'no answer'}`.slice(0, 120));
  }
  return out.join('; ');
}
async function deliver(ws: string, cfg: any, kind: string, subject: string, lines: string[]) {
  const ch = kind === 'test' ? 'both' : chOf(cfg, kind), res: string[] = [];
  if (ch === 'off') return 'off';
  if (ch === 'email' || ch === 'both') res.push(await sendEmail(ws, cfg.emails, subject, lines));
  if (ch === 'whatsapp' || ch === 'both') res.push(await sendWa(ws, cfg.phones, cfg.brand, lines.join(' · ')));
  return res.join(' | ');
}
const orderLine = (p: any) => `${p.ext_id || p.order_id} · ${p.items || 'order'} · ${inr(p.amount)} · ${p.channel || ''}${p.customer ? ' · ' + p.customer : ''}${p.state ? ', ' + p.state : ''}`;

async function flush(onlyWs?: string) {
  let q = db.from('alert_queue').select('*').is('sent_at', null).neq('kind', 'daily').order('id').limit(500);
  if (onlyWs) q = q.eq('workspace_id', onlyWs);
  const { data: rows } = await q; if (!rows?.length) return { sent: 0 };
  const byWs = new Map<string, any[]>(); rows.forEach((r: any) => (byWs.get(r.workspace_id) ?? byWs.set(r.workspace_id, []).get(r.workspace_id)!).push(r));
  let sent = 0;
  for (const [ws, list] of byWs) {
    // claim the rows first so two runs never send twice
    const ids = list.map((r) => r.id); const { data: claimed } = await db.from('alert_queue').update({ sent_at: new Date().toISOString(), result: 'sending' }).in('id', ids).is('sent_at', null).select('id');
    const mine = new Set((claimed ?? []).map((r: any) => r.id)), L = list.filter((r) => mine.has(r.id)); if (!L.length) continue;
    const cfg = await cfgOf(ws), results = new Map<number, string>();
    const min = Number(cfg.rules.new_order?.min || 0);
    const newO = L.filter((r) => r.kind === 'new_order'), bigO = newO.filter((r) => Number(r.payload?.amount || 0) >= min);
    newO.filter((r) => !bigO.includes(r)).forEach((r) => results.set(r.id, 'below minimum'));
    if (bigO.length) { const tot = bigO.reduce((a, r) => a + Number(r.payload?.amount || 0), 0);
      const res = bigO.length <= 3 ? (await Promise.all(bigO.map((r) => deliver(ws, cfg, 'new_order', `🛒 New order ${r.payload.ext_id || r.payload.order_id} · ${inr(r.payload.amount)}`, [`🛒 New order for ${cfg.brand}`, orderLine(r.payload), r.payload.payment ? `Payment: ${r.payload.payment}` : ''].filter(Boolean))))).join(' / ')
        : await deliver(ws, cfg, 'new_order', `🛒 ${bigO.length} new orders · ${inr(tot)}`, [`🛒 ${bigO.length} new orders for ${cfg.brand} — ${inr(tot)} in total`, ...bigO.slice(0, 5).map((r) => orderLine(r.payload)), bigO.length > 5 ? `…and ${bigO.length - 5} more in Nodevers → Orders` : ''].filter(Boolean));
      bigO.forEach((r) => results.set(r.id, res)); sent += bigO.length; }
    const can = L.filter((r) => r.kind === 'cancel');
    if (can.length) { const res = await deliver(ws, cfg, 'cancel', `↩ ${can.length === 1 ? `Order ${can[0].payload.ext_id || can[0].payload.order_id} ${can[0].payload.status}` : `${can.length} orders cancelled / returned`}`,
      [`↩ ${can.length === 1 ? 'An order' : can.length + ' orders'} came back for ${cfg.brand}`, ...can.slice(0, 6).map((r) => `${r.payload.ext_id || r.payload.order_id} · ${r.payload.status} · ${r.payload.items || ''} · ${inr(r.payload.amount)}${r.payload.reason ? ' · ' + r.payload.reason : ''}`)]);
      can.forEach((r) => results.set(r.id, res)); sent += can.length; }
    for (const kind of ['out_stock', 'low_stock']) { const st = L.filter((r) => r.kind === kind); if (!st.length) continue;
      const res = await deliver(ws, cfg, kind, kind === 'out_stock' ? `⛔ Out of stock: ${st.map((r) => r.payload.name || r.payload.sku).slice(0, 3).join(', ')}` : `📦 Low stock: ${st.length} product${st.length > 1 ? 's' : ''}`,
        [kind === 'out_stock' ? `⛔ Out of stock at ${cfg.brand}:` : `📦 Low stock at ${cfg.brand}:`, ...st.slice(0, 10).map((r) => `${r.payload.name || r.payload.sku} (${r.payload.sku}) — ${r.payload.stock} left${r.payload.reorder != null ? `, reorder at ${r.payload.reorder}` : ''}`), 'Reorder now from Nodevers → Inventory.']);
      st.forEach((r) => results.set(r.id, res)); sent += st.length; }
    for (const r of L) await db.from('alert_queue').update({ result: (results.get(r.id) ?? 'skipped').slice(0, 300) }).eq('id', r.id);
  }
  return { sent };
}
async function daily() {
  const hour = istHour(), day = istDate(), out: any[] = [];
  const { data: rows } = await db.from('settings').select('workspace_id,value').eq('key', 'storeAlertsJson').limit(1000);
  for (const r of rows ?? []) {
    let c: any = {}; try { c = JSON.parse(r.value); } catch { continue; }
    const rule = c.rules?.daily ?? { ch: 'email' }; if ((rule.ch ?? 'email') === 'off' || hour < Number(rule.hour ?? 20)) continue;
    const ins = await db.from('alert_queue').insert({ workspace_id: r.workspace_id, kind: 'daily', ref: '', day, sent_at: new Date().toISOString(), result: 'sending' }).select('id').maybeSingle();
    if (ins.error || !ins.data) continue;                                     // already sent today
    const ws = r.workspace_id, cfg = await cfgOf(ws);
    const { data: o } = await db.from('orders').select('amount,net_profit,status,product_name,items,qty').eq('workspace_id', ws).eq('order_date', day).neq('status', 'Cart');
    const live = (o ?? []).filter((x: any) => !['Cancelled', 'Refunded', 'RTO', 'Returned'].includes(x.status));
    const rev = live.reduce((a: number, x: any) => a + Number(x.amount || 0), 0), pr = (o ?? []).reduce((a: number, x: any) => a + Number(x.net_profit || 0), 0);
    const top = new Map<string, number>(); live.forEach((x: any) => { const k = x.product_name || x.items || '—'; top.set(k, (top.get(k) || 0) + Number(x.amount || 0)); });
    const best = [...top.entries()].sort((a, b) => b[1] - a[1])[0];
    const { count: low } = await db.from('products').select('sku', { count: 'exact', head: true }).eq('workspace_id', ws).eq('active', true).lte('stock', 0);
    const { count: leads } = await db.from('leads').select('lead_id', { count: 'exact', head: true }).eq('workspace_id', ws).gte('created_at', day + 'T00:00:00+05:30');
    const lines = [`📊 Today at ${cfg.brand} (${day})`, `Orders: ${live.length} · Revenue: ${inr(rev)} · Net profit: ${inr(pr)}`, best ? `Top product: ${best[0]} (${inr(best[1])})` : 'No orders yet today', `Returned / cancelled: ${(o ?? []).length - live.length} · Out of stock: ${low ?? 0} · New leads: ${leads ?? 0}`];
    const res = await deliver(ws, cfg, 'daily', `📊 ${cfg.brand} today: ${live.length} orders · ${inr(rev)}`, lines);
    await db.from('alert_queue').update({ result: res.slice(0, 300) }).eq('id', ins.data.id); out.push({ ws, res });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === 'flush' || b.action === 'cron') {
      const { data: sec } = await db.from('app_config').select('value').eq('key', 'cron_secret').maybeSingle();
      if (!sec?.value || req.headers.get('x-cron-secret') !== sec.value) return json({ error: 'Forbidden' }, 403);
      const f = await flush(); const d = b.action === 'cron' ? await daily() : [];
      return json({ ok: true, ...f, daily: d.length });
    }
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const ws = String(b.workspace_id ?? '');
    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m || !['owner', 'admin', 'member'].includes(m.role)) return json({ error: 'Not a member of this workspace.' }, 403);
    db.from('app_config').upsert({ key: 'functions_url', value: `${SB_URL.replace(/\/+$/, '')}/functions/v1` }, { onConflict: 'key' }).then(() => null, () => null);
    if (b.action === 'test') {
      const cfg = await cfgOf(ws); if (!cfg.emails.length && !cfg.phones.length) return json({ error: 'Add an email or WhatsApp number and save first.' }, 400);
      const res = await deliver(ws, cfg, 'test', `✅ Test alert from ${cfg.brand}`, [`✅ Test alert for ${cfg.brand}`, 'Your Nodevers store alerts are working.']);
      const bad = /failed|not connected/.test(res);
      return json(bad ? { error: 'Some alerts could not be sent: ' + res } : { ok: true, message: 'Test alert sent — ' + res }, bad ? 400 : 200);
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
