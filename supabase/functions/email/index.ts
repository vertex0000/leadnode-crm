// Nodevers — email: connect an email provider (Brevo, Resend, SendGrid, Mailgun, Postmark, Zoho ZeptoMail, Mailjet), send test / bulk emails to leads, handle unsubscribe.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "email" → paste → Deploy → turn OFF "Enforce JWT verification".
import { createClient } from 'npm:@supabase/supabase-js@2';

const BREVO = Deno.env.get('BREVO_URL') ?? 'https://api.brevo.com/v3';
const URLS = { resend: Deno.env.get('RESEND_URL') ?? 'https://api.resend.com', sendgrid: Deno.env.get('SENDGRID_URL') ?? 'https://api.sendgrid.com/v3', postmark: Deno.env.get('POSTMARK_URL') ?? 'https://api.postmarkapp.com',
  mailjet: Deno.env.get('MAILJET_URL') ?? 'https://api.mailjet.com', mailgun_us: Deno.env.get('MAILGUN_URL') ?? 'https://api.mailgun.net/v3', mailgun_eu: Deno.env.get('MAILGUN_EU_URL') ?? 'https://api.eu.mailgun.net/v3',
  zepto_in: Deno.env.get('ZEPTO_URL') ?? 'https://api.zeptomail.in/v1.1', zepto_com: Deno.env.get('ZEPTO_COM_URL') ?? 'https://api.zeptomail.com/v1.1' };
const PROVIDERS = ['brevo', 'resend', 'sendgrid', 'mailgun', 'postmark', 'zeptomail', 'mailjet'];
const SITE = Deno.env.get('SITE_URL') ?? 'https://vertex0000.github.io/leadnode-crm';
const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const UNSUB_SECRET = Deno.env.get('UNSUB_SECRET') || SERVICE;
const FN_URL = (Deno.env.get('SUPABASE_URL') ?? '') + '/functions/v1/email';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const okEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
async function hmac(s: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(UNSUB_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(s)))).map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function unsubToken(ws: string, lead: string) { const raw = `${ws}:${lead}`; return `${b64u(raw)}.${await hmac(raw)}`; }
async function readToken(t: string) {
  const [p, sig] = String(t || '').split('.'); if (!p || !sig) return null;
  let raw = ''; try { raw = unb64u(p); } catch { return null; }
  if ((await hmac(raw)) !== sig) return null;
  const [ws, lead] = raw.split(':'); return ws && lead ? { ws, lead } : null;
}
async function unsubscribe(t: string) {
  const x = await readToken(t); if (!x) return { ok: false, error: 'This unsubscribe link is not valid.' };
  await db.from('leads').update({ email_opt_out: true }).eq('workspace_id', x.ws).eq('lead_id', x.lead);
  const { data: w } = await db.from('workspaces').select('name').eq('id', x.ws).maybeSingle();
  await db.from('activities').insert({ workspace_id: x.ws, lead_id: x.lead, type: 'Email Unsubscribed', details: 'Clicked unsubscribe', done_by: 'Customer' });
  return { ok: true, business: w?.name ?? '' };
}

const fill = (tpl: string, l: any) => String(tpl).replace(/\{\{\s*(first_name|name|business|city|email)\s*\}\}/gi, (_m, k) => {
  const key = String(k).toLowerCase();
  if (key === 'first_name') return String(l.name ?? '').split(' ')[0] || 'there';
  if (key === 'business') return l.business_name || '';
  return String(l[key] ?? '');
});
function toHtml(body: string) {
  if (/<\s*(p|div|br|table|h\d|a)\b/i.test(body)) return body;                          // already HTML
  return body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join('');
}
function wrap(inner: string, from: string, unsub: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f8;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#16181d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="100%" style="max-width:600px;background:#ffffff;border-radius:12px;padding:28px;font-size:15px;line-height:1.6" cellpadding="0" cellspacing="0"><tr><td>${inner}</td></tr></table>
<p style="font-size:12px;color:#8a8f9c;margin:14px 0 0">You received this email from ${esc(from)}.${unsub ? ` <a href="${unsub}" style="color:#8a8f9c">Unsubscribe</a>` : ''}</p></td></tr></table></body></html>`;
}
/** Send one email through the workspace's provider */
async function brevoSend(acc: any, to: { email: string; name: string }, subject: string, html: string, unsubUrl: string, oneClick: string) {
  const prov = String(acc.provider || 'brevo'), x = acc.extra ?? {}, from = acc.from_email, fromName = acc.from_name || acc.from_email;
  const unsubH: Record<string, string> = unsubUrl ? { 'List-Unsubscribe': `<${oneClick}>, <${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
  const done = async (r: Response | null, idOf: (j: any) => string | undefined, errOf: (j: any) => string | undefined) => { if (!r) return { ok: false, error: `Could not reach ${prov}` }; const j: any = await r.json().catch(() => ({})); return r.ok ? { ok: true, id: idOf(j) } : { ok: false, error: errOf(j) || `${prov} error ${r.status}` }; };
  const go = (url: string, init: RequestInit) => fetch(url, init).catch(() => null);
  if (prov === 'resend') return done(await go(`${URLS.resend}/emails`, { method: 'POST', headers: { Authorization: `Bearer ${acc.api_key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to.email], subject, html, reply_to: from, headers: unsubH }) }), (j) => j.id, (j) => j.message);
  if (prov === 'sendgrid') return done(await go(`${URLS.sendgrid}/mail/send`, { method: 'POST', headers: { Authorization: `Bearer ${acc.api_key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ personalizations: [{ to: [{ email: to.email, ...(to.name ? { name: to.name } : {}) }] }], from: { email: from, name: fromName }, reply_to: { email: from }, subject, content: [{ type: 'text/html', value: html }], ...(unsubUrl ? { headers: unsubH } : {}) }) }), () => undefined, (j) => j?.errors?.[0]?.message);
  if (prov === 'postmark') return done(await go(`${URLS.postmark}/email`, { method: 'POST', headers: { 'X-Postmark-Server-Token': acc.api_key, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ From: `${fromName} <${from}>`, To: to.email, Subject: subject, HtmlBody: html, ReplyTo: from, MessageStream: x.stream || 'outbound', Headers: Object.entries(unsubH).map(([Name, Value]) => ({ Name, Value })) }) }), (j) => j.MessageID, (j) => j.Message);
  if (prov === 'mailjet') return done(await go(`${URLS.mailjet}/v3.1/send`, { method: 'POST', headers: { Authorization: 'Basic ' + btoa(`${acc.api_key}:${x.secret ?? ''}`), 'Content-Type': 'application/json' }, body: JSON.stringify({ Messages: [{ From: { Email: from, Name: fromName }, To: [{ Email: to.email, Name: to.name || '' }], Subject: subject, HTMLPart: html, ...(unsubUrl ? { Headers: unsubH } : {}) }] }) }), (j) => j?.Messages?.[0]?.To?.[0]?.MessageID, (j) => j?.Messages?.[0]?.Errors?.[0]?.ErrorMessage || j?.ErrorMessage);
  if (prov === 'zeptomail') return done(await go(`${x.region === 'com' ? URLS.zepto_com : URLS.zepto_in}/email`, { method: 'POST', headers: { Authorization: String(acc.api_key).startsWith('Zoho-enczapikey') ? acc.api_key : `Zoho-enczapikey ${acc.api_key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ from: { address: from, name: fromName }, to: [{ email_address: { address: to.email, name: to.name || '' } }], subject, htmlbody: html, reply_to: [{ address: from, name: fromName }] }) }), (j) => j?.request_id, (j) => j?.error?.details?.[0]?.message || j?.error?.message || j?.message);
  if (prov === 'mailgun') {
    const f = new FormData(); f.set('from', `${fromName} <${from}>`); f.set('to', to.name ? `${to.name} <${to.email}>` : to.email); f.set('subject', subject); f.set('html', html); f.set('h:Reply-To', from); Object.entries(unsubH).forEach(([k, v]) => f.set('h:' + k, v));
    return done(await go(`${x.region === 'eu' ? URLS.mailgun_eu : URLS.mailgun_us}/${x.domain}/messages`, { method: 'POST', headers: { Authorization: 'Basic ' + btoa(`api:${acc.api_key}`) }, body: f }), (j) => j.id, (j) => j.message);
  }
  const r = await fetch(`${BREVO}/smtp/email`, {
    method: 'POST', headers: { 'api-key': acc.api_key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: acc.from_email, name: acc.from_name || acc.from_email }, replyTo: { email: acc.from_email, name: acc.from_name || acc.from_email }, to: [to], subject, htmlContent: html, tags: ['nodevers'],
      ...(unsubUrl ? { headers: unsubH } : {}) }),
  });
  const out = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, id: out.messageId } : { ok: false, error: out.message || `Brevo error ${r.status}` };
}
/** Check the key + sender when connecting. Returns an error text, or '' when fine. */
async function verifyProvider(prov: string, key: string, from: string, x: any): Promise<{ error?: string; name?: string }> {
  const get = (url: string, headers: Record<string, string>) => fetch(url, { headers: { Accept: 'application/json', ...headers } }).catch(() => null);
  if (prov === 'brevo') {
    const acc = await get(`${BREVO}/account`, { 'api-key': key }); if (!acc?.ok) return { error: 'Brevo did not accept this API key.' };
    const s = await get(`${BREVO}/senders`, { 'api-key': key }); const senders = s?.ok ? ((await s.json()).senders ?? []) : [];
    const sender = senders.find((y: any) => String(y.email).toLowerCase() === from);
    if (!sender) return { error: `${from} is not a sender in your Brevo account. Add and verify it in Brevo → Senders, Domains & Dedicated IPs → Senders.` };
    if (sender.active === false) return { error: `${from} is added in Brevo but not verified yet — click the link Brevo emailed you.` };
    return { name: sender.name };
  }
  if (prov === 'resend') {
    const r = await get(`${URLS.resend}/domains`, { Authorization: `Bearer ${key}` }); if (!r) return { error: 'Could not reach Resend.' };
    if (r.status === 401 || r.status === 403) { const j: any = await r.json().catch(() => ({})); if (/restricted/i.test(j.message ?? '')) return {}; return { error: 'Resend did not accept this API key.' }; }
    const doms = ((await r.json().catch(() => ({}))).data ?? []), d = from.split('@')[1], hit = doms.find((y: any) => String(y.name).toLowerCase() === d);
    if (!hit) return { error: `The domain ${d} is not added in Resend. Resend → Domains → Add domain, add the DNS records, then try again.` };
    if (hit.status && hit.status !== 'verified') return { error: `${d} is added in Resend but not verified yet (status: ${hit.status}). Finish the DNS records first.` };
    return {};
  }
  if (prov === 'sendgrid') { const r = await get(`${URLS.sendgrid}/scopes`, { Authorization: `Bearer ${key}` }); if (!r?.ok) return { error: 'SendGrid did not accept this API key.' }; const sc = (await r.json().catch(() => ({}))).scopes ?? []; if (sc.length && !sc.includes('mail.send')) return { error: 'This SendGrid key has no "Mail Send" permission — create a key with Mail Send access.' }; return {}; }
  if (prov === 'postmark') { const r = await get(`${URLS.postmark}/server`, { 'X-Postmark-Server-Token': key }); return r?.ok ? {} : { error: 'Postmark did not accept this Server API token.' }; }
  if (prov === 'mailjet') { if (!x.secret) return { error: 'Paste the Mailjet Secret key too.' }; const r = await get(`${URLS.mailjet}/v3/REST/sender?Email=${encodeURIComponent(from)}`, { Authorization: 'Basic ' + btoa(`${key}:${x.secret}`) }); if (!r?.ok) return { error: 'Mailjet did not accept the API key / secret.' }; const d = (await r.json().catch(() => ({}))).Data ?? []; if (!d.length) return { error: `${from} is not a sender in Mailjet — add it in Mailjet → Account settings → Sender addresses.` }; if (d[0].Status && d[0].Status !== 'Active') return { error: `${from} is not active in Mailjet yet (status ${d[0].Status}).` }; return {}; }
  if (prov === 'mailgun') { if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(x.domain ?? '')) return { error: 'Enter your Mailgun sending domain (e.g. mg.yourbusiness.com).' }; const r = await get(`${x.region === 'eu' ? URLS.mailgun_eu : URLS.mailgun_us}/domains/${x.domain}`, { Authorization: 'Basic ' + btoa(`api:${key}`) }); if (!r?.ok) return { error: r?.status === 404 ? `Mailgun has no domain ${x.domain} in this ${x.region === 'eu' ? 'EU' : 'US'} region.` : 'Mailgun did not accept this API key.' }; return {}; }
  if (prov === 'zeptomail') return {};      // ZeptoMail has no "check key" call — press "Send test" after connecting
  return { error: 'Unknown provider' };
}

/** Auto welcome email to one lead. Only the server can call this (header x-cron-secret). */
async function systemSend(req: Request, b: any) {
  const { data: sec } = await db.from('app_config').select('value').eq('key', 'cron_secret').maybeSingle();
  if (!sec?.value || req.headers.get('x-cron-secret') !== sec.value) return json({ error: 'Forbidden' }, 403);
  const ws = String(b.workspace_id ?? ''), leadId = String(b.lead_id ?? '');
  const { data: wst } = await db.rpc('ws_state', { ws }); if (wst === 'locked') return json({ ok: false, error: 'workspace is view-only' });
  const { data: acc } = await db.from('email_accounts').select('*').eq('workspace_id', ws).maybeSingle(); if (!acc) return json({ ok: false, error: 'Email not connected' });
  if (b.to_email) {                                   // a note to the team (Automation → Notify team) — no lead, no unsubscribe link
    const to = String(b.to_email).trim(); if (!okEmail(to)) return json({ ok: false, error: 'Team email is not valid' });
    const r = await brevoSend(acc, { email: to, name: '' }, String(b.subject || 'Nodevers').slice(0, 150), wrap(toHtml(String(b.body || '')), acc.from_name || acc.from_email, ''), '', '');
    return json(r.ok ? { ok: true } : { ok: false, error: r.error });
  }
  const { data: l } = await db.from('leads').select('lead_id, name, email, business_name, city, email_opt_out').eq('workspace_id', ws).eq('lead_id', leadId).maybeSingle();
  if (!l) return json({ ok: false, error: 'Lead not found' }); if (l.email_opt_out) return json({ ok: false, skipped: true, error: 'Unsubscribed' });
  if (!okEmail(String(l.email ?? ''))) return json({ ok: false, skipped: true, error: 'No email' });
  const subject = fill(String(b.subject || 'Thanks for your enquiry'), l).slice(0, 150), body = fill(String(b.body || ''), l);
  if (!body.trim()) return json({ ok: false, error: 'Empty email' });
  const fromLabel = acc.from_name || acc.from_email, t = await unsubToken(ws, l.lead_id), page = `${SITE}/unsubscribe.html?u=${encodeURIComponent(t)}`, oneClick = `${FN_URL}?u=${encodeURIComponent(t)}`;
  const r = await brevoSend(acc, { email: l.email, name: l.name || '' }, subject, wrap(toHtml(body), fromLabel, page), page, oneClick);
  const by = ['Auto message', 'Remarketing'].includes(String(b.by)) ? String(b.by) : 'Auto welcome', label = String(b.label || 'Welcome').slice(0, 40);   // auto messages (remarket) say which one
  if (r.ok) await db.from('activities').insert({ workspace_id: ws, lead_id: l.lead_id, type: 'Email Sent', details: label + ': ' + subject, done_by: by });
  return json(r.ok ? { ok: true } : { ok: false, error: r.error });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  // One-click unsubscribe from email apps (POST …/email?u=TOKEN)
  if (url.searchParams.get('u')) { const r = await unsubscribe(url.searchParams.get('u')!); return json(r, r.ok ? 200 : 400); }
  try {
    const b = await req.json();
    if (b.action === 'system') return await systemSend(req, b);     // auto welcome email, called by the "alerts" function
    if (b.action === 'unsub') { const r = await unsubscribe(String(b.u ?? '')); return json(r, r.ok ? 200 : 400); }

    const ws = String(b.workspace_id ?? '');
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m || m.role === 'client') return json({ error: 'You do not have permission here.' }, 403);
    const admin = m.role === 'owner' || m.role === 'admin';
    if (b.action === 'send' || b.action === 'test') { const { data: wst } = await db.rpc('ws_state', { ws }); if (wst === 'locked') return json({ error: 'Your plan has ended — this workspace is view-only. Renew it in Settings → Plan & billing.' }, 402); }

    if (b.action === 'connect') {
      if (!admin) return json({ error: 'Only the owner or an admin can connect email.' }, 403);
      const prov = PROVIDERS.includes(String(b.provider)) ? String(b.provider) : 'brevo';
      const key = String(b.api_key ?? '').trim(), from = String(b.from_email ?? '').trim().toLowerCase(), name = String(b.from_name ?? '').trim().slice(0, 80);
      const x: Record<string, string> = {}; if (b.secret) x.secret = String(b.secret).trim(); if (b.domain) x.domain = String(b.domain).trim().toLowerCase(); if (b.region) x.region = String(b.region).trim().toLowerCase(); if (b.stream) x.stream = String(b.stream).trim();
      if (key.length < 16) return json({ error: 'Paste the API key from your email provider.' }, 400);
      if (!okEmail(from)) return json({ error: 'Enter the sender email (verified with your provider).' }, 400);
      const v = await verifyProvider(prov, key, from, x); if (v.error) return json({ error: v.error }, 400);
      const up = await db.from('email_accounts').upsert({ workspace_id: ws, provider: prov, api_key: key, extra: x, from_email: from, from_name: name || v.name || '', updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' });
      if (up.error) return json({ error: /email_accounts|extra/.test(up.error.message) ? 'Run the database update 13_automation_engine.sql first.' : up.error.message }, 500);
      return json({ connected: true, provider: prov, from_email: from, from_name: name || v.name || '' });
    }
    if (b.action === 'disconnect') { if (!admin) return json({ error: 'Only the owner or an admin can do this.' }, 403); await db.from('email_accounts').delete().eq('workspace_id', ws); return json({ connected: false }); }

    const { data: acc } = await db.from('email_accounts').select('*').eq('workspace_id', ws).maybeSingle();
    if (!acc) return json({ error: 'Connect your email sender first (Broadcast → Email → Connect).' }, 400);
    const { data: w } = await db.from('workspaces').select('name').eq('id', ws).maybeSingle();
    const fromLabel = acc.from_name || w?.name || acc.from_email;
    const subject = String(b.subject ?? '').trim().slice(0, 200), body = String(b.body ?? '');
    if (!subject || !body.trim()) return json({ error: 'Add a subject and a message.' }, 400);

    if (b.action === 'test') {
      const to = String(b.to ?? u.user.email ?? '').trim();
      if (!okEmail(to)) return json({ error: 'Enter an email for the test.' }, 400);
      const sample = { name: 'Aarav Mehta', business_name: 'Brew & Bites Cafe', city: 'Mumbai', email: to };
      const r = await brevoSend(acc, { email: to, name: 'Test' }, '[Test] ' + fill(subject, sample), wrap(toHtml(fill(body, sample)), fromLabel, ''), '', '');
      return r.ok ? json({ ok: true }) : json({ error: r.error }, 400);
    }

    if (b.action === 'send') {
      const { data: ax } = await db.rpc('member_access', { p_ws: ws, p_uid: u.user.id });
      const perm = (k: string) => admin || !ax || ax?.perms?.[k] !== false;
      if (!perm('email') || (Array.isArray(b.lead_ids) && b.lead_ids.length > 1 && !perm('broadcast'))) return json({ error: 'Your access does not include sending these emails — ask the owner.' }, 403);
      if (Array.isArray(b.lead_ids) && b.lead_ids.length > 1) { const { data: camp } = await db.rpc('ws_feature', { ws, k: 'campaigns' }); if (camp === false) return json({ error: 'Email campaigns are not part of your plan. Upgrade in Settings → Plan & billing.' }, 402); }
      let ids = (Array.isArray(b.lead_ids) ? b.lead_ids : []).slice(0, 50).map(String);
      if (!admin && ax && ax.scope !== 'all') { const { data: vis } = await db.rpc('visible_lead_ids', { p_ws: ws, p_uid: u.user.id, p_ids: ids }); const ok = new Set((vis ?? []).map((x: any) => typeof x === 'string' ? x : x.visible_lead_ids)); ids = ids.filter((i) => ok.has(i)); }
      if (ax?.name) b.by = ax.name;
      const { data: leads, error } = await db.from('leads').select('lead_id, name, email, business_name, city, email_opt_out').eq('workspace_id', ws).in('lead_id', ids);
      if (error) return json({ error: /email/.test(error.message) ? 'Run the database update 03_broadcast_email.sql first.' : error.message }, 500);
      const results = [];
      for (const l of leads ?? []) {
        if (l.email_opt_out) { results.push({ lead_id: l.lead_id, ok: false, skipped: true, error: 'Unsubscribed' }); continue; }
        if (!okEmail(String(l.email ?? ''))) { results.push({ lead_id: l.lead_id, ok: false, skipped: true, error: 'No email' }); continue; }
        const t = await unsubToken(ws, l.lead_id), page = `${SITE}/unsubscribe.html?u=${encodeURIComponent(t)}`, oneClick = `${FN_URL}?u=${encodeURIComponent(t)}`;
        const r = await brevoSend(acc, { email: l.email, name: l.name || '' }, fill(subject, l), wrap(toHtml(fill(body, l)), fromLabel, page), page, oneClick);
        if (r.ok) await db.from('activities').insert({ workspace_id: ws, lead_id: l.lead_id, type: 'Email Sent', details: (b.broadcast_name ? `${b.broadcast_name}: ` : '') + fill(subject, l), done_by: String(b.by ?? '') });
        results.push({ lead_id: l.lead_id, ok: r.ok, error: r.ok ? undefined : r.error });
        if (!r.ok && /key|unauthori|credit|quota|limit/i.test(r.error ?? '')) { ids.length = 0; break; }
      }
      return json({ ok: true, results });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
