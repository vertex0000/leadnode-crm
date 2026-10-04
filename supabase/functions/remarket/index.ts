// Nodevers — remarket: sends the automatic customer messages that the database queues (SQL 23, table remarket_jobs):
//   thank you · COD confirmation · checkout reminder 1 + 2 · shipped · delivered · review request · reorder reminder · win-back · back in stock.
// Settings key "remarketJson" (Leads → Customers → Auto messages) decides what is on, which approved WhatsApp template and which email is used.
// Rules: marketing messages (checkout reminders, reorder, win-back, back in stock) only go to people with marketing permission
// (or, when the client chose "all buyers", to everyone who has not said no), at most N per person per week, never at night (9 pm – 9 am IST
// they wait for the morning). Not on WhatsApp / no template → the email is sent instead (when email is connected and written).
//   run  (every 2 minutes, pg_cron → header x-cron-secret) · test (signed-in owner / admin: send one kind to one lead now).
// Sends through the "wa-send" and "email" functions (action "system"). No secrets of its own.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "remarket" → paste → Deploy → turn OFF "Enforce JWT verification".
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const inr = (n: unknown) => (n === null || n === undefined || n === '' || !isFinite(Number(n))) ? '' : '₹' + Math.round(Number(n)).toLocaleString('en-IN');
const okEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const DEAD = ['Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned'];
const NIGHT_RULE = Deno.env.get('REMARKET_NO_NIGHT') !== '1';                      // local tests only switch it off

/** what each kind is: marketing needs permission + counts for the weekly cap; utility is about an order the person made */
const KIND: Record<string, { mkt: boolean; label: string }> = {
  thanks: { mkt: false, label: 'Thank you' }, cod: { mkt: false, label: 'COD confirmation' }, shipped: { mkt: false, label: 'Shipped' }, delivered: { mkt: false, label: 'Delivered' },
  review: { mkt: false, label: 'Review request' }, abandon1: { mkt: true, label: 'Checkout reminder' }, abandon2: { mkt: true, label: 'Checkout reminder 2' },
  reorder: { mkt: true, label: 'Reorder reminder' }, winback: { mkt: true, label: 'Win-back' }, backstock: { mkt: true, label: 'Back in stock' },
};
const istHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));
/** next 10:00 IST */
function nextMorning() { const d = new Date(Date.now() + 5.5 * 3600e3); if (d.getUTCHours() >= 10) d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(10, 0, 0, 0); return new Date(d.getTime() - 5.5 * 3600e3).toISOString(); }

async function cfgOf(ws: string) {
  const { data } = await db.from('settings').select('key,value').eq('workspace_id', ws).in('key', ['remarketJson', 'brandName']);
  const m = Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
  let c: any = {}; try { c = JSON.parse(m.remarketJson || '{}') ?? {}; } catch { /* empty */ }
  let brand = m.brandName; if (!brand) { const { data: w } = await db.from('workspaces').select('name').eq('id', ws).maybeSingle(); brand = w?.name || ''; }
  return { ...c, auto: c.auto ?? {}, brand: String(brand || '').slice(0, 60) };
}
async function base() {
  const { data } = await db.from('app_config').select('key,value').in('key', ['cron_secret', 'functions_url']);
  const m = Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
  return { secret: String(m.cron_secret ?? ''), url: String(m.functions_url || `${SB_URL.replace(/\/+$/, '')}/functions/v1`).replace(/\/+$/, '') };
}
async function call(b: { secret: string; url: string }, fn: string, body: any) {
  const r = await fetch(`${b.url}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': b.secret }, body: JSON.stringify({ action: 'system', ...body }), signal: AbortSignal.timeout(25000) }).catch(() => null);
  const j: any = r ? await r.json().catch(() => ({})) : {}; return { ok: !!j.ok, skipped: !!j.skipped, code: String(j.code ?? ''), error: String(j.error ?? (r ? '' : 'no answer')) };
}

/** everything a message may need: {{first_name}} {{order_id}} {{amount}} {{items}} {{tracking_url}} {{checkout_url}} {{product}} {{coupon}} {{link}} {{shop}} */
async function contextOf(ws: string, job: any, lead: any, rule: any, cfg: any) {
  const v: Record<string, string> = { first_name: String(lead.name ?? '').split(' ')[0] || 'there', name: String(lead.name ?? ''), shop: cfg.brand || '', coupon: String(rule.coupon ?? ''), link: String(rule.url ?? cfg.shopUrl ?? '') };
  let lines: any[] = [], checkout: any = null;
  const p = job.payload ?? {};
  if (['thanks', 'cod', 'shipped', 'delivered', 'review', 'reorder'].includes(job.kind)) {
    const ref = String(p.order_ref ?? job.ref);
    ({ data: lines } = await db.from('orders').select('order_id, order_ref, ext_id, status, payment, amount, items, product_name, qty, tracking_url, courier, order_date, created_at, sku').eq('workspace_id', ws).eq('lead_id', lead.lead_id).or(`order_ref.eq.${JSON.stringify(ref)},order_id.eq.${JSON.stringify(String(p.order_id ?? ref))}`).limit(50));
    lines = lines ?? [];
    const live = lines.filter((o) => !DEAD.includes(o.status));
    v.order_id = ref; v.amount = inr(live.reduce((a, o) => a + Number(o.amount || 0), 0)) || inr(lines[0]?.amount);
    v.items = live.map((o) => o.product_name ? `${o.qty > 1 ? o.qty + ' × ' : ''}${o.product_name}` : o.items).filter(Boolean).join(', ').slice(0, 300);
    v.tracking_url = String(lines.find((o) => o.tracking_url)?.tracking_url ?? ''); v.courier = String(lines.find((o) => o.courier)?.courier ?? '');
    v.product = String(p.product ?? live[0]?.product_name ?? live[0]?.items ?? '');
  } else if (job.kind.startsWith('abandon')) {
    ({ data: checkout } = await db.from('checkouts').select('*').eq('workspace_id', ws).eq('checkout_id', String(p.checkout_id ?? job.ref)).maybeSingle());
    if (checkout) { v.items = String(checkout.items ?? '').slice(0, 300); v.amount = inr(checkout.amount); v.checkout_url = String(checkout.url || v.link || ''); v.product = String(checkout.items ?? '').split(',')[0].replace(/^\d+\s*×\s*/, ''); }
  } else if (job.kind === 'backstock') { v.product = String(p.product ?? p.sku ?? ''); if (p.url) v.link = String(p.url); }
  else if (job.kind === 'winback') { v.product = String(lead.last_product ?? ''); }
  if (!v.checkout_url) v.checkout_url = v.link;
  return { v, lines, checkout };
}
const fillVars = (s: unknown, v: Record<string, string>) => String(s ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k.toLowerCase() in v ? v[k.toLowerCase()] : m));

/** is the message still right to send? (the order may be cancelled, the checkout recovered…) */
function stillDue(job: any, lead: any, x: { lines: any[]; checkout: any }) {
  const st = x.lines.map((o) => o.status), any = (a: string[]) => st.some((s) => a.includes(s));
  switch (job.kind) {
    case 'thanks': return x.lines.length && !st.every((s) => DEAD.includes(s)) ? '' : 'order cancelled';
    case 'cod': return any(['COD', 'New', 'Processing', 'Confirmed']) ? '' : 'order no longer COD / pending';
    case 'shipped': return any(['Shipped', 'Delivered']) ? '' : 'order not shipped';
    case 'delivered': case 'review': return any(['Delivered']) && !any(['Returned', 'RTO', 'Refunded']) ? '' : 'order not delivered or returned';
    case 'reorder': { const t = Math.max(...x.lines.map((o) => new Date(o.created_at).getTime())); return x.lines.length && (!lead.last_order_at || new Date(lead.last_order_at).getTime() <= t + 2 * 864e5) ? '' : 'already ordered again'; }
    case 'abandon1': return x.checkout?.status === 'open' ? '' : 'checkout recovered or closed';
    case 'abandon2': return x.checkout?.status === 'open' && (x.checkout.reminders ?? 0) < 2 ? '' : 'checkout recovered or closed';
    case 'winback': return Number(lead.orders_count) > 0 && (!job.payload?.last || String(lead.last_order_at ?? '').slice(0, 10) === String(job.payload.last).slice(0, 10)) ? '' : 'ordered again';
    case 'backstock': return '';
  }
  return '';
}
async function tplPreview(ws: string, name: string, params: string[]) {
  const { data } = await db.from('templates').select('body').eq('workspace_id', ws).eq('template_name', name).maybeSingle();
  return data?.body ? String(data.body).replace(/\{\{(\d+)\}\}/g, (_m, n) => params[Number(n) - 1] ?? '') : `Template: ${name}`;
}

/** one queued message → 'sent · whatsapp' | 'sent · email' | 'skipped · …' | 'failed · …' | 'later' */
async function one(ws: string, cfg: any, job: any, ctx: any, b: { secret: string; url: string }, test = false): Promise<{ result: string; channel?: string; runAt?: string }> {
  const meta = KIND[job.kind], rule = cfg.auto?.[job.kind] ?? {};
  if (!meta) return { result: 'skipped · unknown kind' };
  if (!test && rule.on !== true) return { result: 'skipped · switched off' };
  const { data: lead } = await db.from('leads').select('lead_id, name, phone, email, wa_status, wa_opt_out, email_opt_out, mkt_ok, mkt_win_at, mkt_win_n, orders_count, last_order_at, last_product').eq('workspace_id', ws).eq('lead_id', job.lead_id).maybeSingle();
  if (!lead) return { result: 'skipped · customer deleted' };
  const x = await contextOf(ws, job, lead, rule, cfg);
  if (!test) { const why = stillDue(job, lead, x); if (why) return { result: 'skipped · ' + why }; }
  if (meta.mkt && !test) {
    const mode = cfg.mode === 'buyers' ? 'buyers' : 'optin';
    if (!(lead.mkt_ok === true || (mode === 'buyers' && lead.mkt_ok !== false))) return { result: 'skipped · no marketing permission' };
    const cap = Number.isFinite(Number(cfg.cap)) ? Number(cfg.cap) : 2;
    if (cap > 0 && lead.mkt_win_at && Date.now() - new Date(lead.mkt_win_at).getTime() < 7 * 864e5 && Number(lead.mkt_win_n) >= cap) return { result: `skipped · weekly limit (${cap}) reached` };
    const h = istHour(); if (NIGHT_RULE && (h < 9 || h >= 21)) return { result: 'later', runAt: nextMorning() };
  }
  const by = meta.mkt ? 'Remarketing' : 'Auto message', why: string[] = [];
  // 1. WhatsApp (approved template)
  const phoneOk = /^\d{10,15}$/.test(String(lead.phone ?? '').replace(/\D/g, ''));
  if (!rule.tpl) why.push('no WhatsApp template chosen');
  else if (!ctx.wa) why.push('WhatsApp not connected');
  else if (!phoneOk) why.push('no phone');
  else if (lead.wa_opt_out) why.push('said STOP on WhatsApp');
  else if (lead.wa_status === 'off' || lead.wa_status === 'invalid') why.push('not on WhatsApp');
  else {
    const params = (Array.isArray(rule.params) ? rule.params : []).map((p: unknown) => fillVars(p, x.v) || '-');
    const r = await call(b, 'wa-send', { workspace_id: ws, lead_id: lead.lead_id, template: String(rule.tpl), language: String(rule.lang || 'en'), params, preview: await tplPreview(ws, String(rule.tpl), params), by, label: meta.label });
    if (r.ok) return { result: 'sent · whatsapp', channel: 'whatsapp' };
    if (r.code === '131026') { await db.from('leads').update({ wa_status: 'off', wa_checked_at: new Date().toISOString() }).eq('workspace_id', ws).eq('lead_id', lead.lead_id); why.push('not on WhatsApp'); }
    else if (!rule.email?.on) return { result: 'failed · ' + (r.error || 'WhatsApp error').slice(0, 200) };
    else why.push(r.error || 'WhatsApp error');
  }
  // 2. Email (when written) — as the fallback, or always when the email is on and WhatsApp could not be used
  const em = rule.email ?? {};
  if (em.on && String(em.body ?? '').trim()) {
    if (!ctx.email) why.push('email not connected');
    else if (!okEmail(String(lead.email ?? ''))) why.push('no email');
    else if (lead.email_opt_out) why.push('unsubscribed from email');
    else {
      const r = await call(b, 'email', { workspace_id: ws, lead_id: lead.lead_id, subject: fillVars(em.subject || meta.label, x.v), body: fillVars(em.body, x.v), by, label: meta.label });
      if (r.ok) return { result: 'sent · email', channel: 'email' };
      return { result: 'failed · ' + (r.error || 'email error').slice(0, 200) };
    }
  }
  return { result: 'skipped · ' + (why.join(', ') || 'nothing to send') };
}

async function run() {
  const now = new Date().toISOString(), b = await base();
  const { data: due } = await db.from('remarket_jobs').select('id').is('done_at', null).lte('run_at', now).order('run_at').limit(150);
  if (!due?.length) return { sent: 0 };
  const { data: jobs } = await db.from('remarket_jobs').update({ done_at: now, result: 'sending' }).in('id', due.map((j: any) => j.id)).is('done_at', null).select('*');   // claim first: two runs never send twice
  const byWs = new Map<string, any[]>(); (jobs ?? []).forEach((j: any) => (byWs.get(j.workspace_id) ?? byWs.set(j.workspace_id, []).get(j.workspace_id)!).push(j));
  let sent = 0;
  for (const [ws, list] of byWs) {
    const { data: wst } = await db.rpc('ws_state', { ws });
    const { data: feat } = await db.rpc('ws_feature', { ws, k: 'campaigns' });
    const cfg = await cfgOf(ws);
    const [{ data: wa }, { data: ea }] = await Promise.all([db.from('wa_accounts').select('workspace_id').eq('workspace_id', ws).maybeSingle(), db.from('email_accounts').select('workspace_id').eq('workspace_id', ws).maybeSingle()]);
    const ctx = { wa: !!wa, email: !!ea };
    for (const j of list) {
      let out: { result: string; channel?: string; runAt?: string };
      try { out = wst === 'locked' ? { result: 'skipped · plan ended (view-only)' } : feat === false && KIND[j.kind]?.mkt ? { result: 'skipped · campaigns not in the plan' } : await one(ws, cfg, j, ctx, b); }
      catch (e) { out = { result: 'failed · ' + String((e as Error)?.message ?? e).slice(0, 200) }; }
      if (out.result === 'later') { await db.from('remarket_jobs').update({ done_at: null, result: 'waiting for the morning', run_at: out.runAt }).eq('id', j.id); continue; }
      await db.from('remarket_jobs').update({ result: out.result.slice(0, 300), channel: out.channel ?? '' }).eq('id', j.id);
      if (out.result.startsWith('sent')) {
        sent++;
        if (j.kind.startsWith('abandon')) { const { data: c } = await db.from('checkouts').select('reminders').eq('workspace_id', ws).eq('checkout_id', String(j.payload?.checkout_id ?? j.ref)).maybeSingle();
          await db.from('checkouts').update({ reminders: Number(c?.reminders ?? 0) + 1, last_reminded_at: new Date().toISOString() }).eq('workspace_id', ws).eq('checkout_id', String(j.payload?.checkout_id ?? j.ref)); }
      }
    }
  }
  return { sent, done: jobs?.length ?? 0 };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === 'run') {
      const { data: sec } = await db.from('app_config').select('value').eq('key', 'cron_secret').maybeSingle();
      if (!sec?.value || req.headers.get('x-cron-secret') !== sec.value) return json({ error: 'Forbidden' }, 403);
      return json({ ok: true, ...(await run()) });
    }
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const ws = String(body.workspace_id ?? '');
    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m || !['owner', 'admin'].includes(m.role)) return json({ error: 'Only the owner or an admin can do this.' }, 403);
    if (body.action === 'test') {         // send one kind to one lead now (ignores permission, weekly limit and night hours — it is your own test)
      const kind = String(body.kind ?? ''), leadId = String(body.lead_id ?? '');
      if (!KIND[kind]) return json({ error: 'Pick a message.' }, 400);
      const { data: wst } = await db.rpc('ws_state', { ws }); if (wst === 'locked') return json({ error: 'Your plan has ended — this workspace is view-only.' }, 402);
      const cfg = await cfgOf(ws); if (body.rule && typeof body.rule === 'object') cfg.auto[kind] = body.rule;
      const { data: o } = await db.from('orders').select('order_id, order_ref, sku, product_name').eq('workspace_id', ws).eq('lead_id', leadId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const { data: c } = await db.from('checkouts').select('checkout_id').eq('workspace_id', ws).eq('lead_id', leadId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const job = { kind, lead_id: leadId, ref: o?.order_ref || o?.order_id || c?.checkout_id || 'test', payload: { order_ref: o?.order_ref || o?.order_id, order_id: o?.order_id, checkout_id: c?.checkout_id, sku: o?.sku, product: o?.product_name } };
      const [{ data: wa }, { data: ea }] = await Promise.all([db.from('wa_accounts').select('workspace_id').eq('workspace_id', ws).maybeSingle(), db.from('email_accounts').select('workspace_id').eq('workspace_id', ws).maybeSingle()]);
      const out = await one(ws, cfg, job, { wa: !!wa, email: !!ea }, await base(), true);
      return json(out.result.startsWith('sent') ? { ok: true, message: `Test ${out.result.replace('sent · ', 'sent on ')}` } : { error: out.result.replace(/^(skipped|failed) · /, 'Not sent: ') }, out.result.startsWith('sent') ? 200 : 400);
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
