// Nodevers — remarket: sends the automatic customer messages that the database queues (SQL 23 + 24, table remarket_jobs) and runs scheduled campaigns:
//   thank you · COD confirmation · pay-online offer for COD · checkout reminder 1 + 2 · viewed-not-bought · shipped · delivered · review · rating (1–5 ⭐)
//   · reorder · win-back · back in stock · ask for referrals · referral reward · scheduled campaigns (table campaign_schedules).
// Settings key "remarketJson" (Campaigns → Auto messages) decides what is on, which approved WhatsApp template / email is used, and whether each
// message goes out by itself or waits for approval ("send": "approve" → it waits in "Waiting for you" until someone sends, edits or skips it).
// Rules: marketing messages only go to people with marketing permission (or, when the client chose "all buyers", everyone who has not said no),
// at most N per person per week, never at night (9 pm – 9 am IST they wait for the morning). Not on WhatsApp / no template → the email instead.
// "paused": true stops everything (messages wait). Order updates that are 3+ days late are not sent.
//   run (every 2 minutes, pg_cron → header x-cron-secret)
//   test (owner / admin: one kind to one lead now) · send_job / skip_job (a waiting message) · send_custom (your own message for one customer)
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
const istDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

/** what each kind is: marketing needs permission + counts for the weekly cap; the others are about something the person did */
const KIND: Record<string, { mkt: boolean; label: string }> = {
  thanks: { mkt: false, label: 'Thank you' }, cod: { mkt: false, label: 'COD confirmation' }, cod_prepaid: { mkt: false, label: 'Pay online offer' },
  shipped: { mkt: false, label: 'Shipped' }, delivered: { mkt: false, label: 'Delivered' }, review: { mkt: false, label: 'Review request' }, rating: { mkt: false, label: 'Rating request' },
  abandon1: { mkt: true, label: 'Checkout reminder' }, abandon2: { mkt: true, label: 'Checkout reminder 2' }, browse: { mkt: true, label: 'Viewed, not bought' },
  reorder: { mkt: true, label: 'Reorder reminder' }, winback: { mkt: true, label: 'Win-back' }, backstock: { mkt: true, label: 'Back in stock' },
  ref_ask: { mkt: true, label: 'Refer a friend' }, ref_reward: { mkt: false, label: 'Referral reward' }, campaign: { mkt: true, label: 'Campaign' },
};
const ORDER_KINDS = ['thanks', 'cod', 'cod_prepaid', 'shipped', 'delivered', 'review', 'rating', 'reorder', 'ref_ask'];
const LATE_KINDS = ['thanks', 'cod', 'cod_prepaid', 'shipped', 'delivered', 'abandon1'];
const istHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));
/** next 10:00 IST */
function nextMorning() { const d = new Date(Date.now() + 5.5 * 3600e3); if (d.getUTCHours() >= 10) d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(10, 0, 0, 0); return new Date(d.getTime() - 5.5 * 3600e3).toISOString(); }

async function cfgOf(ws: string) {
  const { data } = await db.from('settings').select('key,value').eq('workspace_id', ws).in('key', ['remarketJson', 'brandName']);
  const m = Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
  let c: any = {}; try { c = JSON.parse(m.remarketJson || '{}') ?? {}; } catch { /* empty */ }
  let brand = m.brandName; if (!brand) { const { data: w } = await db.from('workspaces').select('name').eq('id', ws).maybeSingle(); brand = w?.name || ''; }
  return { ...c, auto: c.auto ?? {}, referral: c.referral ?? {}, brand: String(brand || '').slice(0, 60) };
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
const withRef = (link: string, code: string) => !link || !code ? link : link + (link.includes('?') ? '&' : '?') + 'ref=' + encodeURIComponent(code);

/** everything a message may need: {{first_name}} {{order_id}} {{amount}} {{items}} {{product}} {{tracking_url}} {{checkout_url}} {{coupon}} {{link}} {{shop}}
 *  {{pay_link}} {{pay_amount}} {{discount}} · {{ref_code}} {{ref_link}} {{friend_offer}} {{reward}} {{reward_code}} {{friend}} */
async function contextOf(ws: string, job: any, lead: any, rule: any, cfg: any) {
  const shop = String(cfg.shopUrl ?? ''), R = cfg.referral ?? {};
  const v: Record<string, string> = { first_name: String(lead.name ?? '').split(' ')[0] || 'there', name: String(lead.name ?? ''), shop: cfg.brand || '', coupon: String(rule.coupon ?? ''),
    link: String(rule.url || shop), ref_code: String(lead.ref_code ?? ''), friend_offer: String(R.friendOffer ?? ''), reward: String(R.reward ?? ''), reward_code: String(R.rewardCode ?? '') };
  v.ref_link = withRef(String(R.link || shop), v.ref_code);
  let lines: any[] = [], checkout: any = null, extra: any = {};
  const p = job.payload ?? {};
  if (ORDER_KINDS.includes(job.kind) && (p.order_ref || p.order_id)) {
    const ref = String(p.order_ref ?? job.ref);
    ({ data: lines } = await db.from('orders').select('order_id, order_ref, ext_id, status, payment, amount, items, product_name, qty, tracking_url, courier, order_date, created_at, sku, rto_risk').eq('workspace_id', ws).eq('lead_id', lead.lead_id).or(`order_ref.eq.${JSON.stringify(ref)},order_id.eq.${JSON.stringify(String(p.order_id ?? ref))}`).limit(50));
    lines = lines ?? [];
    const live = lines.filter((o) => !DEAD.includes(o.status)), total = live.reduce((a, o) => a + Number(o.amount || 0), 0) || Number(lines[0]?.amount || 0);
    v.order_id = ref; v.amount = inr(total);
    v.items = live.map((o) => o.product_name ? `${o.qty > 1 ? o.qty + ' × ' : ''}${o.product_name}` : o.items).filter(Boolean).join(', ').slice(0, 300);
    v.tracking_url = String(lines.find((o) => o.tracking_url)?.tracking_url ?? ''); v.courier = String(lines.find((o) => o.courier)?.courier ?? '');
    v.product = String(p.product ?? live[0]?.product_name ?? live[0]?.items ?? '');
    if (job.kind === 'cod_prepaid') {      // pay online now (optional discount)
      const off = Math.max(0, Number(rule.off) || 0), cut = rule.offType === 'pct' ? Math.round(total * Math.min(off, 90) / 100) : Math.min(off, total), pay = Math.max(0, total - cut);
      v.discount = cut ? (rule.offType === 'pct' ? `${Math.min(off, 90)}%` : inr(cut)) : ''; v.pay_amount = inr(pay);
      v.pay_link = String(rule.url ?? '').replace(/\{\{\s*amount\s*\}\}/gi, String(pay)).replace(/\{\{\s*order_id\s*\}\}/gi, encodeURIComponent(ref)) || shop;
      extra = { total, pay };
    }
  } else if (job.kind.startsWith('abandon')) {
    ({ data: checkout } = await db.from('checkouts').select('*').eq('workspace_id', ws).eq('checkout_id', String(p.checkout_id ?? job.ref)).maybeSingle());
    if (checkout) { v.items = String(checkout.items ?? '').slice(0, 300); v.amount = inr(checkout.amount); v.checkout_url = String(checkout.url || v.link || ''); v.product = String(checkout.items ?? '').split(',')[0].replace(/^\d+\s*×\s*/, ''); }
  } else if (job.kind === 'backstock' || job.kind === 'browse') { v.product = String(p.product ?? p.sku ?? ''); if (p.url) v.link = String(p.url); if (p.price) v.amount = inr(p.price); }
  else if (job.kind === 'winback') { v.product = String(lead.last_product ?? ''); }
  else if (job.kind === 'ref_reward' && p.friend_id) { const { data: f } = await db.from('leads').select('name').eq('workspace_id', ws).eq('lead_id', String(p.friend_id)).maybeSingle(); v.friend = String(f?.name ?? 'your friend').split(' ')[0]; }
  if (!v.checkout_url) v.checkout_url = v.link;
  return { v, lines, checkout, extra };
}
const fillVars = (s: unknown, v: Record<string, string>) => String(s ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k.toLowerCase() in v ? v[k.toLowerCase()] : m));

/** is the message still right to send? (the order may be cancelled, the checkout recovered…) */
async function stillDue(ws: string, job: any, lead: any, rule: any, x: { lines: any[]; checkout: any; extra: any }) {
  const st = x.lines.map((o) => o.status), any = (a: string[]) => st.some((s) => a.includes(s)), p = job.payload ?? {};
  switch (job.kind) {
    case 'thanks': return x.lines.length && !st.every((s) => DEAD.includes(s)) ? '' : 'order cancelled';
    case 'cod': return any(['COD', 'New', 'Processing', 'Confirmed']) ? '' : 'order no longer COD / pending';
    case 'cod_prepaid': {
      if (!any(['COD', 'New', 'Processing', 'Confirmed']) || any(['Paid'])) return 'order paid, shipped or cancelled';
      if (Number(rule.min) > 0 && (x.extra.total ?? 0) < Number(rule.min)) return `order below ${inr(rule.min)}`;
      const risk = Math.max(0, ...x.lines.map((o) => Number(o.rto_risk ?? 0)));
      if (rule.risk === 'high' && risk < 60) return 'RTO risk not high'; if (rule.risk === 'medium' && risk < 30) return 'RTO risk low';
      return '';
    }
    case 'shipped': return any(['Shipped', 'Delivered']) ? '' : 'order not shipped';
    case 'delivered': case 'review': case 'ref_ask': return any(['Delivered']) && !any(['Returned', 'RTO', 'Refunded']) ? '' : 'order not delivered or returned';
    case 'rating': {
      if (!any(['Delivered']) || any(['Returned', 'RTO', 'Refunded'])) return 'order not delivered or returned';
      const { count } = await db.from('feedback').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('lead_id', lead.lead_id).gte('created_at', new Date(Date.now() - 14 * 864e5).toISOString());
      return count ? 'already rated' : '';
    }
    case 'reorder': { const t = Math.max(...x.lines.map((o) => new Date(o.created_at).getTime())); return x.lines.length && (!lead.last_order_at || new Date(lead.last_order_at).getTime() <= t + 2 * 864e5) ? '' : 'already ordered again'; }
    case 'abandon1': return x.checkout?.status === 'open' ? '' : 'checkout recovered or closed';
    case 'abandon2': return x.checkout?.status === 'open' && (x.checkout.reminders ?? 0) < 2 ? '' : 'checkout recovered or closed';
    case 'browse': {
      const since = String(p.viewed_at ?? job.created_at);
      if (lead.last_order_at && lead.last_order_at > since) return 'ordered after viewing';
      const { count: ck } = await db.from('checkouts').select('checkout_id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('lead_id', lead.lead_id).gte('created_at', since);
      if (ck) return 'started a checkout (the checkout reminder takes over)';
      const { count: rec } = await db.from('remarket_jobs').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('lead_id', lead.lead_id).eq('kind', 'browse').like('result', 'sent%').gte('done_at', new Date(Date.now() - 7 * 864e5).toISOString());
      return rec ? 'already reminded this week' : '';
    }
    case 'winback': return Number(lead.orders_count) > 0 && (!p.last || String(lead.last_order_at ?? '').slice(0, 10) === String(p.last).slice(0, 10)) ? '' : 'ordered again';
    case 'ref_reward': { const { data: r } = await db.from('referrals').select('status').eq('workspace_id', ws).eq('friend_id', String(p.friend_id ?? '')).maybeSingle(); return r?.status === 'ordered' ? '' : 'reward already given'; }
    case 'backstock': return '';
  }
  return '';
}
async function tplRow(ws: string, name: string) { const { data } = await db.from('templates').select('body, category').eq('workspace_id', ws).eq('template_name', name).maybeSingle(); return data; }
const preview = (t: any, name: string, params: string[]) => t?.body ? String(t.body).replace(/\{\{(\d+)\}\}/g, (_m, n) => params[Number(n) - 1] ?? '') : `Template: ${name}`;
const LEAD_COLS = 'lead_id, name, phone, email, business_name, city, wa_status, wa_opt_out, email_opt_out, mkt_ok, mkt_win_at, mkt_win_n, orders_count, last_order_at, last_product, ref_code';

/** the shared checks for marketing messages: permission (client's choice) + weekly limit */
function mktBlock(cfg: any, lead: any, onlyYes = false) {
  const mode = cfg.mode === 'buyers' ? 'buyers' : 'optin';
  if (lead.mkt_ok === false || lead.wa_opt_out) return 'no marketing permission';
  if (!(lead.mkt_ok === true || (mode === 'buyers' && !onlyYes))) return 'no marketing permission';
  const cap = Number.isFinite(Number(cfg.cap)) && cfg.cap !== '' && cfg.cap !== null ? Number(cfg.cap) : 2;
  if (cap > 0 && lead.mkt_win_at && Date.now() - new Date(lead.mkt_win_at).getTime() < 7 * 864e5 && Number(lead.mkt_win_n) >= cap) return `weekly limit (${cap}) reached`;
  return '';
}

/** one queued message → 'sent · whatsapp' | 'sent · email' | 'skipped · …' | 'failed · …' | 'later' | 'hold' */
async function one(ws: string, cfg: any, job: any, ctx: any, b: { secret: string; url: string }, opt: { test?: boolean; approved?: boolean } = {}): Promise<{ result: string; channel?: string; runAt?: string }> {
  const meta = KIND[job.kind], rule = cfg.auto?.[job.kind] ?? {}, test = !!opt.test, auto = !test && !opt.approved;
  if (!meta || job.kind === 'campaign') return { result: 'skipped · unknown kind' };
  if (!test && rule.on !== true && !opt.approved) return { result: 'skipped · switched off' };
  if (auto && LATE_KINDS.includes(job.kind) && job.created_at && Date.now() - new Date(job.created_at).getTime() > 3 * 864e5) return { result: 'skipped · too late (more than 3 days)' };
  const { data: lead } = await db.from('leads').select(LEAD_COLS).eq('workspace_id', ws).eq('lead_id', job.lead_id).maybeSingle();
  if (!lead) return { result: 'skipped · customer deleted' };
  const x = await contextOf(ws, job, lead, rule, cfg);
  if (!test) { const why = await stillDue(ws, job, lead, rule, x); if (why) return { result: 'skipped · ' + why }; }
  if (meta.mkt && !test) {
    const why = mktBlock(cfg, lead); if (why) return { result: 'skipped · ' + why };
    const h = istHour(); if (auto && NIGHT_RULE && (h < 9 || h >= 21)) return { result: 'later', runAt: nextMorning() };
  }
  if (auto && rule.send === 'approve') return { result: 'hold' };        // waits in "Waiting for you"
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
    const t = await tplRow(ws, String(rule.tpl));
    const r = await call(b, 'wa-send', { workspace_id: ws, lead_id: lead.lead_id, template: String(rule.tpl), language: String(rule.lang || 'en'), params, preview: preview(t, String(rule.tpl), params), by, label: meta.label });
    if (r.ok) return { result: 'sent · whatsapp', channel: 'whatsapp' };
    if (r.code === '131026') { await db.from('leads').update({ wa_status: 'off', wa_checked_at: new Date().toISOString() }).eq('workspace_id', ws).eq('lead_id', lead.lead_id); why.push('not on WhatsApp'); }
    else if (!rule.email?.on) return { result: 'failed · ' + (r.error || 'WhatsApp error').slice(0, 200) };
    else why.push(r.error || 'WhatsApp error');
  }
  // 2. Email (when written) — as the fallback
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

/** your own message for one customer (from "Waiting for you" → Edit, or Checkouts / Customers → Message): a template, free text (24 h window) or an email */
async function sendCustom(ws: string, cfg: any, job: any, ctx: any, b: { secret: string; url: string }, c: any, who = '') {
  const meta = KIND[job.kind] ?? { mkt: false, label: 'Message' }, rule = cfg.auto?.[job.kind] ?? {}, own = !KIND[job.kind];
  const { data: lead } = await db.from('leads').select(LEAD_COLS).eq('workspace_id', ws).eq('lead_id', job.lead_id).maybeSingle();
  if (!lead) return { result: 'skipped · customer deleted' };
  const x = await contextOf(ws, job, lead, Object.assign({}, rule, c.coupon ? { coupon: c.coupon } : {}), cfg), by = meta.mkt ? 'Remarketing' : 'Auto message', label = own ? 'Message' : (meta.label + ' (custom)').slice(0, 40);
  const send: any = own ? { by_name: who || 'Team' } : { by };        // your own message: in the journey under your name (not counted for the weekly limit)
  if (meta.mkt && lead.mkt_ok === false && c.channel !== 'email') return { result: 'skipped · said no to offers' };
  if (c.channel === 'email') {
    if (!ctx.email) return { result: 'skipped · email not connected' };
    if (!okEmail(String(lead.email ?? '')) || lead.email_opt_out) return { result: 'skipped · no email or unsubscribed' };
    const body = fillVars(c.body, x.v); if (!body.trim()) return { result: 'skipped · empty email' };
    const r = await call(b, 'email', { workspace_id: ws, lead_id: lead.lead_id, subject: fillVars(c.subject || meta.label, x.v), body, ...send, label });
    return r.ok ? { result: 'sent · email (custom)', channel: 'email' } : { result: 'failed · ' + (r.error || 'email error').slice(0, 200) };
  }
  if (!ctx.wa) return { result: 'skipped · WhatsApp not connected' };
  if (lead.wa_opt_out) return { result: 'skipped · said STOP on WhatsApp' };
  if (!/^\d{10,15}$/.test(String(lead.phone ?? '').replace(/\D/g, ''))) return { result: 'skipped · no phone' };
  let r;
  if (c.channel === 'text') { const text = fillVars(c.text, x.v).trim(); if (!text) return { result: 'skipped · empty message' }; r = await call(b, 'wa-send', { workspace_id: ws, lead_id: lead.lead_id, text, ...send, label }); }
  else {
    if (!c.tpl) return { result: 'skipped · pick a template' };
    const params = (Array.isArray(c.params) ? c.params : []).map((p: unknown) => fillVars(p, x.v) || '-'), t = await tplRow(ws, String(c.tpl));
    r = await call(b, 'wa-send', { workspace_id: ws, lead_id: lead.lead_id, template: String(c.tpl), language: String(c.lang || 'en'), params, preview: preview(t, String(c.tpl), params), ...send, label });
  }
  if (r.ok) return { result: 'sent · whatsapp (custom)', channel: 'whatsapp' };
  if (r.code === '131026') await db.from('leads').update({ wa_status: 'off', wa_checked_at: new Date().toISOString() }).eq('workspace_id', ws).eq('lead_id', lead.lead_id);
  return { result: 'failed · ' + (r.code === '131047' ? 'more than 24 hours since they last wrote — send a template instead' : r.error || 'WhatsApp error').slice(0, 200) };
}

/** a scheduled campaign: one person */
const VAR_OF = (v: any, l: any, s: any) => v?.src === 'first' ? String(l.name ?? '').split(' ')[0] : v?.src === 'name' ? String(l.name ?? '') : v?.src === 'business' ? String(l.business_name || l.name || '') : v?.src === 'city' ? String(l.city ?? '') : v?.src === 'coupon' ? String(s.coupon ?? '') : String(v?.text ?? '');
async function campaignOne(ws: string, cfg: any, job: any, ctx: any, b: { secret: string; url: string }, sched: any, tpl: any) {
  if (!sched) return { result: 'skipped · schedule deleted' };
  const bid = String(job.payload?.broadcast_id ?? ''), a = sched.audience ?? {};
  const { data: lead } = await db.from('leads').select(LEAD_COLS).eq('workspace_id', ws).eq('lead_id', job.lead_id).maybeSingle();
  if (!lead) return { result: 'skipped · lead deleted' };
  if (sched.channel === 'email') {
    if (!ctx.email) return { result: 'skipped · email not connected' };
    if (!okEmail(String(lead.email ?? '')) || lead.email_opt_out) return { result: 'skipped · no email or unsubscribed' };
    const v = { first_name: String(lead.name ?? '').split(' ')[0] || 'there', name: String(lead.name ?? ''), business: String(lead.business_name ?? ''), city: String(lead.city ?? ''), coupon: String(sched.coupon ?? '') };
    const r = await call(b, 'email', { workspace_id: ws, lead_id: lead.lead_id, subject: fillVars(sched.subject, v), body: fillVars(sched.body, v), by: 'Remarketing', label: String(job.payload?.name ?? sched.name).slice(0, 120) });
    return r.ok ? { result: 'sent · email', channel: 'email' } : { result: 'failed · ' + (r.error || 'email error').slice(0, 200) };
  }
  if (!ctx.wa) return { result: 'skipped · WhatsApp not connected' };
  if (!/^\d{10,15}$/.test(String(lead.phone ?? '').replace(/\D/g, ''))) return { result: 'skipped · no phone' };
  if (lead.wa_opt_out) return { result: 'skipped · said STOP' };
  if (lead.wa_status === 'off' || lead.wa_status === 'invalid' || (a.waOn && lead.wa_status !== 'on')) return { result: 'skipped · not on WhatsApp' };
  const mkt = !tpl || !/utility|authentication/i.test(String(tpl.category ?? ''));
  if (mkt) { const why = mktBlock(Object.assign({}, cfg, { mode: 'buyers' }), lead, !!a.mktOnly); if (why) return { result: 'skipped · ' + why }; }   // campaigns: everyone who has not said no (or only yes)
  const n = (String(tpl?.body ?? '').match(/\{\{\d+\}\}/g) ?? []).length, vars = Array.isArray(sched.vars) ? sched.vars : [];
  const params = Array.from({ length: n }, (_, k) => VAR_OF(vars[k], lead, sched) || '-');
  const r = await call(b, 'wa-send', { workspace_id: ws, lead_id: lead.lead_id, template: sched.tpl, language: sched.lang || 'en', params, preview: preview(tpl, sched.tpl, params), by: mkt ? 'Remarketing' : 'Auto message', label: 'Campaign', broadcast_id: bid });
  if (r.ok) return { result: 'sent · whatsapp', channel: 'whatsapp' };
  if (r.code === '131026') await db.from('leads').update({ wa_status: 'off', wa_checked_at: new Date().toISOString() }).eq('workspace_id', ws).eq('lead_id', lead.lead_id);
  return { result: 'failed · ' + (r.error || 'WhatsApp error').slice(0, 200) };
}

/** one schedule → a broadcast (history + stats) + one job per person. Claimed first, so two runs never start it twice. */
async function startOne(s: any, now: string, force = false) {
  if (force && s.last_run_at && Date.now() - new Date(s.last_run_at).getTime() < 60e3) return -1;           // "Send now" twice in a minute
  const q = db.from('campaign_schedules').update({ last_run_at: now, runs: Number(s.runs ?? 0) + 1 }).eq('id', s.id);
  const { data: claimed } = await (force ? (s.last_run_at ? q.eq('last_run_at', s.last_run_at) : q.is('last_run_at', null)) : q.eq('next_run_at', s.next_run_at)).select('id');
  if (!claimed?.length) return -1;
  const ws = s.workspace_id;
  const { data: wst } = await db.rpc('ws_state', { ws }); const { data: feat } = await db.rpc('ws_feature', { ws, k: 'campaigns' });
  if (wst === 'locked' || feat === false) { await db.from('campaign_schedules').update({ last_count: 0 }).eq('id', s.id); return 0; }
  const { data: ids } = await db.rpc('campaign_audience', { p_ws: ws, a: s.audience ?? {} });
  const list = (ids ?? []).map((x: any) => typeof x === 'string' ? x : x.campaign_audience).filter(Boolean);
  const t = s.channel === 'whatsapp' ? await tplRow(ws, s.tpl) : null, name = `${s.name || 'Scheduled campaign'} · ${istDate()}`.slice(0, 120);
  const { data: bc } = await db.from('broadcasts').insert({ workspace_id: ws, name, channel: s.channel, template: s.channel === 'whatsapp' ? s.tpl : '', subject: s.subject || '', body: s.channel === 'email' ? s.body || '' : String(t?.body ?? ''),
    audience_filter: JSON.stringify(Object.assign({}, s.audience ?? {}, { schedule_id: s.id }, s.coupon ? { coupon: s.coupon } : {})), contacts: list.length, status: list.length ? 'Sending' : 'Sent', sent_at: now }).select('broadcast_id').single();
  const rows = list.map((lid: string) => ({ workspace_id: ws, lead_id: lid, kind: 'campaign', ref: `sc${s.id}:${now.slice(0, 16)}:${lid}`, run_at: now, payload: { schedule_id: s.id, broadcast_id: bc?.broadcast_id ?? '', name } }));
  for (let i = 0; i < rows.length; i += 500) await db.from('remarket_jobs').upsert(rows.slice(i, i + 500), { onConflict: 'workspace_id,kind,ref', ignoreDuplicates: true });
  await db.from('campaign_schedules').update({ last_count: list.length }).eq('id', s.id);
  return list.length;
}
async function startSchedules() {
  const now = new Date().toISOString(); let started = 0;
  const { data: due } = await db.from('campaign_schedules').select('*').eq('active', true).lte('next_run_at', now).order('next_run_at').limit(10);
  for (const s of due ?? []) if ((await startOne(s, now)) >= 0) started++;
  return started;
}

async function run() {
  const b = await base(), started = await startSchedules(), now = new Date().toISOString();
  const { data: due } = await db.from('remarket_jobs').select('id').is('done_at', null).lte('run_at', now).order('run_at').limit(150);
  if (!due?.length) return { sent: 0, schedules: started };
  const { data: jobs } = await db.from('remarket_jobs').update({ done_at: now, result: 'sending' }).in('id', due.map((j: any) => j.id)).is('done_at', null).select('*');   // claim first: two runs never send twice
  const byWs = new Map<string, any[]>(); (jobs ?? []).forEach((j: any) => (byWs.get(j.workspace_id) ?? byWs.set(j.workspace_id, []).get(j.workspace_id)!).push(j));
  let sent = 0;
  for (const [ws, list] of byWs) {
    const { data: wst } = await db.rpc('ws_state', { ws });
    const { data: feat } = await db.rpc('ws_feature', { ws, k: 'campaigns' });
    const cfg = await cfgOf(ws);
    if (cfg.paused) { await db.from('remarket_jobs').update({ done_at: null, result: 'paused', run_at: new Date(Date.now() + 30 * 60e3).toISOString() }).in('id', list.map((j) => j.id)); continue; }
    const [{ data: wa }, { data: ea }] = await Promise.all([db.from('wa_accounts').select('workspace_id').eq('workspace_id', ws).maybeSingle(), db.from('email_accounts').select('workspace_id').eq('workspace_id', ws).maybeSingle()]);
    const ctx = { wa: !!wa, email: !!ea }, scheds = new Map<string, any>(), tpls = new Map<string, any>(), touched = new Set<string>();
    for (const j of list) {
      let out: { result: string; channel?: string; runAt?: string };
      try {
        if (wst === 'locked') out = { result: 'skipped · plan ended (view-only)' };
        else if (feat === false && KIND[j.kind]?.mkt) out = { result: 'skipped · campaigns not in the plan' };
        else if (j.kind === 'campaign') {
          const sid = String(j.payload?.schedule_id ?? '');
          if (!scheds.has(sid)) { const { data: s } = await db.from('campaign_schedules').select('*').eq('id', sid).maybeSingle(); scheds.set(sid, s); if (s?.tpl && !tpls.has(s.tpl)) tpls.set(s.tpl, await tplRow(ws, s.tpl)); }
          const s = scheds.get(sid); out = await campaignOne(ws, cfg, j, ctx, b, s, s ? tpls.get(s.tpl) : null); if (j.payload?.broadcast_id) touched.add(String(j.payload.broadcast_id));
        } else out = await one(ws, cfg, j, ctx, b);
      } catch (e) { out = { result: 'failed · ' + String((e as Error)?.message ?? e).slice(0, 200) }; }
      if (out.result === 'later') { await db.from('remarket_jobs').update({ done_at: null, result: 'waiting for the morning', run_at: out.runAt }).eq('id', j.id); continue; }
      if (out.result === 'hold') { await db.from('remarket_jobs').update({ done_at: null, result: 'hold · waiting for you', run_at: 'infinity', payload: { ...(j.payload ?? {}), held_at: now } }).eq('id', j.id); continue; }
      await db.from('remarket_jobs').update({ result: out.result.slice(0, 300), channel: out.channel ?? '' }).eq('id', j.id);
      if (out.result.startsWith('sent')) { sent++; await afterSent(ws, j); }
    }
    for (const bid of touched) {     // the campaign's numbers in Broadcast → History
      const q = () => db.from('remarket_jobs').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('kind', 'campaign').eq('payload->>broadcast_id', bid);
      const [{ count: s }, { count: f }, { count: w }] = await Promise.all([q().like('result', 'sent%'), q().like('result', 'failed%'), q().is('done_at', null)]);
      await db.from('broadcasts').update({ sent: s ?? 0, failed: f ?? 0, status: w ? 'Sending' : 'Sent' }).eq('workspace_id', ws).eq('broadcast_id', bid);
    }
  }
  return { sent, done: jobs?.length ?? 0, schedules: started };
}
/** bookkeeping after a message went out */
async function afterSent(ws: string, j: any) {
  if (j.kind.startsWith('abandon')) { const id = String(j.payload?.checkout_id ?? j.ref); const { data: c } = await db.from('checkouts').select('reminders').eq('workspace_id', ws).eq('checkout_id', id).maybeSingle();
    await db.from('checkouts').update({ reminders: Number(c?.reminders ?? 0) + 1, last_reminded_at: new Date().toISOString() }).eq('workspace_id', ws).eq('checkout_id', id); }
  if (j.kind === 'ref_reward' && j.payload?.friend_id) await db.from('referrals').update({ status: 'rewarded', rewarded_at: new Date().toISOString() }).eq('workspace_id', ws).eq('friend_id', String(j.payload.friend_id)).eq('status', 'ordered');
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
    if (!m || !['owner', 'admin', 'member'].includes(m.role)) return json({ error: 'You do not have permission to send messages here.' }, 403);
    const admin = m.role === 'owner' || m.role === 'admin';
    const { data: wst } = await db.rpc('ws_state', { ws }); if (wst === 'locked') return json({ error: 'Your plan has ended — this workspace is view-only.' }, 402);
    // team members: their WhatsApp switch + only leads in their area
    const { data: ax } = await db.rpc('member_access', { p_ws: ws, p_uid: u.user.id });
    const full = admin || !ax || ax.scope === 'all';
    if (!admin && ax?.perms?.whatsapp === false) return json({ error: 'Your access does not include WhatsApp — ask the owner.' }, 403);
    const who = String(ax?.name || u.user.user_metadata?.full_name || u.user.user_metadata?.name || String(u.user.email ?? '').split('@')[0] || 'Team').slice(0, 60);
    const canSee = async (id: string) => { if (full) return true; const { data } = await db.rpc('visible_lead_ids', { p_ws: ws, p_uid: u.user.id, p_ids: [id] }); return (data ?? []).length > 0; };
    const cfg = await cfgOf(ws), b = await base();
    const [{ data: wa }, { data: ea }] = await Promise.all([db.from('wa_accounts').select('workspace_id').eq('workspace_id', ws).maybeSingle(), db.from('email_accounts').select('workspace_id').eq('workspace_id', ws).maybeSingle()]);
    const ctx = { wa: !!wa, email: !!ea };
    const reply = (out: { result: string }) => json(out.result.startsWith('sent') ? { ok: true, result: out.result, message: out.result.replace(/^sent · /, 'Sent on ') } : { error: out.result.replace(/^(skipped|failed) · /, 'Not sent: ') }, out.result.startsWith('sent') ? 200 : 400);

    if (body.action === 'test') {         // send one kind to one lead now (ignores permission, weekly limit and night hours — it is your own test)
      if (!admin) return json({ error: 'Only the owner or an admin can do this.' }, 403);
      const kind = String(body.kind ?? ''), leadId = String(body.lead_id ?? '');
      if (!KIND[kind] || kind === 'campaign') return json({ error: 'Pick a message.' }, 400);
      if (body.rule && typeof body.rule === 'object') cfg.auto[kind] = body.rule;
      const { data: o } = await db.from('orders').select('order_id, order_ref, sku, product_name').eq('workspace_id', ws).eq('lead_id', leadId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const { data: c } = await db.from('checkouts').select('checkout_id').eq('workspace_id', ws).eq('lead_id', leadId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const job = { kind, lead_id: leadId, ref: o?.order_ref || o?.order_id || c?.checkout_id || 'test', payload: { order_ref: o?.order_ref || o?.order_id, order_id: o?.order_id, checkout_id: c?.checkout_id, sku: o?.sku, product: o?.product_name, friend_id: leadId } };
      const out = await one(ws, cfg, job, ctx, b, { test: true });
      return json(out.result.startsWith('sent') ? { ok: true, message: `Test ${out.result.replace('sent · ', 'sent on ')}` } : { error: out.result.replace(/^(skipped|failed) · /, 'Not sent: ') }, out.result.startsWith('sent') ? 200 : 400);
    }
    if (body.action === 'send_job' || body.action === 'skip_job') {      // a message waiting for approval
      const { data: j } = await db.from('remarket_jobs').select('*').eq('workspace_id', ws).eq('id', Number(body.job_id)).maybeSingle();
      if (!j || j.done_at) return json({ error: 'This message was already handled.' }, 409);
      if (j.lead_id && !(await canSee(j.lead_id))) return json({ error: 'Lead not found' }, 404);
      const { data: claimed } = await db.from('remarket_jobs').update({ done_at: new Date().toISOString(), result: 'sending' }).eq('id', j.id).is('done_at', null).select('id');
      if (!claimed?.length) return json({ error: 'This message was already handled.' }, 409);
      if (body.action === 'skip_job') { await db.from('remarket_jobs').update({ result: 'skipped · by you' }).eq('id', j.id); return json({ ok: true, message: 'Skipped' }); }
      let out: { result: string; channel?: string };
      try { out = body.custom && typeof body.custom === 'object' ? await sendCustom(ws, cfg, j, ctx, b, body.custom, who) : await one(ws, cfg, j, ctx, b, { approved: true }); }
      catch (e) { out = { result: 'failed · ' + String((e as Error)?.message ?? e).slice(0, 200) }; }
      if (out.result === 'hold' || out.result === 'later') out = { result: 'failed · could not send now' };
      await db.from('remarket_jobs').update({ result: out.result.slice(0, 300), channel: out.channel ?? '' }).eq('id', j.id);
      if (out.result.startsWith('sent')) await afterSent(ws, j);
      return reply(out);
    }
    if (body.action === 'send_custom') {        // your own message to one customer, with the same values ({{first_name}}, {{checkout_url}}…)
      const kind = KIND[String(body.kind)] && body.kind !== 'campaign' ? String(body.kind) : 'custom', leadId = String(body.lead_id ?? '');
      if (!leadId || !(await canSee(leadId))) return json({ error: 'Lead not found' }, 404);
      const ref = String(body.ref ?? '').slice(0, 120), job: any = { kind, lead_id: leadId, ref, payload: ORDER_KINDS.includes(kind) ? { order_ref: ref, order_id: ref } : kind.startsWith('abandon') ? { checkout_id: ref } : {} };
      const out = await sendCustom(ws, cfg, job, ctx, b, body.custom ?? {}, who);
      if (out.result.startsWith('sent') && kind !== 'custom') {   // kept in the log (and in Results) like any auto message
        await db.from('remarket_jobs').insert({ workspace_id: ws, lead_id: leadId, kind, ref: `custom:${Date.now()}:${leadId}`, run_at: new Date().toISOString(), done_at: new Date().toISOString(), payload: { ...job.payload, by: who }, channel: out.channel ?? '', result: out.result });
        if (kind.startsWith('abandon') && ref) await afterSent(ws, { kind, payload: { checkout_id: ref }, ref });
      }
      return reply(out);
    }
    if (body.action === 'run_schedule') {        // Broadcast → Scheduled → Send now (does not change the schedule's own times)
      if (!admin && ax?.perms?.broadcast === false) return json({ error: 'Your access does not include campaigns.' }, 403);
      const { data: s } = await db.from('campaign_schedules').select('*').eq('workspace_id', ws).eq('id', Number(body.id)).maybeSingle();
      if (!s) return json({ error: 'Schedule not found — refresh the page.' }, 400);
      const n = await startOne(s, new Date().toISOString(), true);
      if (n < 0) return json({ error: 'It was just started — wait a minute.' }, 409);
      if (n === 0) return json({ ok: true, count: 0, message: 'Nobody matches this audience right now — nothing to send' });
      const r = await run(); return json({ ok: true, count: n, message: `Started for ${n} — ${r.sent} sent so far, the rest go out in the next minutes` });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
