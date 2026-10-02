// Nodevers — email: connect a Brevo account, send test / bulk emails to leads, handle unsubscribe.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "email" → paste → Deploy → turn OFF "Enforce JWT verification".
import { createClient } from 'npm:@supabase/supabase-js@2';

const BREVO = Deno.env.get('BREVO_URL') ?? 'https://api.brevo.com/v3';
const SITE = Deno.env.get('SITE_URL') ?? 'https://vertex0000.github.io/leadnode-crm';
const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const UNSUB_SECRET = Deno.env.get('UNSUB_SECRET') || SERVICE;
const FN_URL = (Deno.env.get('SUPABASE_URL') ?? '') + '/functions/v1/email';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
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
async function brevoSend(acc: any, to: { email: string; name: string }, subject: string, html: string, unsubUrl: string, oneClick: string) {
  const r = await fetch(`${BREVO}/smtp/email`, {
    method: 'POST', headers: { 'api-key': acc.api_key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: acc.from_email, name: acc.from_name || acc.from_email }, replyTo: { email: acc.from_email, name: acc.from_name || acc.from_email }, to: [to], subject, htmlContent: html, tags: ['nodevers'],
      ...(unsubUrl ? { headers: { 'List-Unsubscribe': `<${oneClick}>, <${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}) }),
  });
  const out = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, id: out.messageId } : { ok: false, error: out.message || `Brevo error ${r.status}` };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  // One-click unsubscribe from email apps (POST …/email?u=TOKEN)
  if (url.searchParams.get('u')) { const r = await unsubscribe(url.searchParams.get('u')!); return json(r, r.ok ? 200 : 400); }
  try {
    const b = await req.json();
    if (b.action === 'unsub') { const r = await unsubscribe(String(b.u ?? '')); return json(r, r.ok ? 200 : 400); }

    const ws = String(b.workspace_id ?? '');
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m || m.role === 'client') return json({ error: 'You do not have permission here.' }, 403);
    const admin = m.role === 'owner' || m.role === 'admin';

    if (b.action === 'connect') {
      if (!admin) return json({ error: 'Only the owner or an admin can connect email.' }, 403);
      const key = String(b.api_key ?? '').trim(), from = String(b.from_email ?? '').trim().toLowerCase(), name = String(b.from_name ?? '').trim().slice(0, 80);
      if (key.length < 20) return json({ error: 'Paste the Brevo API key (starts with xkeysib-).' }, 400);
      if (!okEmail(from)) return json({ error: 'Enter the sender email you verified in Brevo.' }, 400);
      const acc = await fetch(`${BREVO}/account`, { headers: { 'api-key': key, accept: 'application/json' } });
      if (!acc.ok) return json({ error: 'Brevo did not accept this API key.' }, 400);
      const s = await fetch(`${BREVO}/senders`, { headers: { 'api-key': key, accept: 'application/json' } });
      const senders = s.ok ? ((await s.json()).senders ?? []) : [];
      const sender = senders.find((x: any) => String(x.email).toLowerCase() === from);
      if (!sender) return json({ error: `${from} is not a sender in your Brevo account. Add and verify it in Brevo → Senders, Domains & Dedicated IPs → Senders.` }, 400);
      if (sender.active === false) return json({ error: `${from} is added in Brevo but not verified yet — click the link Brevo emailed you.` }, 400);
      const up = await db.from('email_accounts').upsert({ workspace_id: ws, provider: 'brevo', api_key: key, from_email: from, from_name: name || sender.name || '', updated_at: new Date().toISOString() }, { onConflict: 'workspace_id' });
      if (up.error) return json({ error: /email_accounts/.test(up.error.message) ? 'Run the database update 03_broadcast_email.sql first.' : up.error.message }, 500);
      return json({ connected: true, from_email: from, from_name: name || sender.name || '' });
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
