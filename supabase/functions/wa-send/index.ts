// Nodevers — wa-send: send a WhatsApp text or template from the CRM (one lead, or a broadcast batch), log it in the lead's journey.
// Deploy: Supabase → Edge Functions → wa-send → Code → replace all → Deploy. "Enforce JWT verification" stays OFF.
import { createClient } from 'npm:@supabase/supabase-js@2';

const GRAPH = Deno.env.get('WA_GRAPH_URL') ?? 'https://graph.facebook.com/v21.0';
const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());   // YYYY-MM-DD
const cleanPhone = (p: unknown) => { let d = String(p ?? '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d; };
const FRIENDLY: Record<string, string> = {
  '131047': 'More than 24 hours have passed since this customer last messaged you. Send an approved template instead.',
  '131026': 'This number is not on WhatsApp or cannot receive messages.',
  '132001': 'This template does not exist or is not approved yet.',
  '131042': 'Add a payment method in WhatsApp Manager to send templates.',
  '131048': 'Spam limit reached — too many people blocked or ignored these messages. Pause and try later.',
  '131056': 'Too many messages to this number in a short time. Try again later.',
  '130472': 'Meta did not deliver this marketing message (user part of an experiment or limited marketing).',
  '190': 'The WhatsApp access token has expired. Reconnect WhatsApp in the Inbox.',
};

function templatePayload(to: string, name: string, language: string, params: unknown[]) {
  const p = (params ?? []).map((t) => ({ type: 'text', text: String(t ?? '').slice(0, 1000) || '-' }));
  return { messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: language || 'en' }, ...(p.length ? { components: [{ type: 'body', parameters: p }] } : {}) } };
}
async function graphSend(acc: any, payload: unknown) {
  const r = await fetch(`${GRAPH}/${acc.phone_number_id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${acc.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const out = await r.json();
  if (!r.ok) { const code = String(out?.error?.code ?? ''); return { ok: false, code, error: FRIENDLY[code] ?? ('WhatsApp error: ' + (out?.error?.message ?? r.status)) }; }
  return { ok: true, code: '', id: out?.messages?.[0]?.id ?? null };
}
async function logSent(ws: string, leadId: string | null, to: string, type: string, text: string, wamid: string | null, by: string, broadcastId: string | null, journeyText: string, sentBy: string | null = null) {
  await db.from('messages').insert({ workspace_id: ws, lead_id: leadId, phone: to, direction: 'out', type, text, status: 'sent', whatsapp_msg_id: wamid, ...(broadcastId ? { broadcast_id: broadcastId } : {}), ...(sentBy !== null ? { sent_by: sentBy } : {}) });
  if (leadId) {
    await db.from('activities').insert({ workspace_id: ws, lead_id: leadId, type: 'WhatsApp Sent', details: journeyText.slice(0, 300), done_by: by });
    await db.from('leads').update({ last_contact: today() }).eq('workspace_id', ws).eq('lead_id', leadId);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json();
    const ws = String(b.workspace_id ?? '');
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m || m.role === 'client') return json({ error: 'You do not have permission to send messages here.' }, 403);

    // Team access (07 update): switches set by the owner + which leads this person may reach
    const { data: ax } = await db.rpc('member_access', { p_ws: ws, p_uid: u.user.id });
    const full = m.role === 'owner' || m.role === 'admin' || !ax || ax.scope === 'all';
    const perm = (k: string) => m.role === 'owner' || m.role === 'admin' || !ax || ax?.perms?.[k] !== false;
    const visible = async (ids: string[]) => { if (full) return new Set(ids); const { data } = await db.rpc('visible_lead_ids', { p_ws: ws, p_uid: u.user.id, p_ids: ids }); return new Set((data ?? []).map((x: any) => typeof x === 'string' ? x : x.visible_lead_ids)); };

    const { data: acc } = await db.from('wa_accounts').select('*').eq('workspace_id', ws).maybeSingle();
    if (!acc) return json({ error: 'Connect your WhatsApp number first (WhatsApp → Inbox → Connect WhatsApp).' }, 400);
    const by = String(ax?.name || b.by || '');
    const sentBy = ax ? by : null;   // column exists once the 07 update is installed

    // ---- Broadcast batch: { bulk: [{ lead_id, params, preview }], template, language, broadcast_id } ----
    if (Array.isArray(b.bulk)) {
      if (!perm('broadcast')) return json({ error: 'Your access does not include bulk broadcasts — ask the owner.' }, 403);
      if (!b.template) return json({ error: 'Pick an approved template' }, 400);
      const items = b.bulk.slice(0, 50), ids = items.map((x: any) => String(x.lead_id)), ok = await visible(ids);
      const { data: leads, error } = await db.from('leads').select('lead_id, phone, wa_opt_out').eq('workspace_id', ws).in('lead_id', ids);
      if (error) return json({ error: /wa_opt_out/.test(error.message) ? 'Run the database update 03_broadcast_email.sql first.' : error.message }, 500);
      const byId = new Map((leads ?? []).map((l: any) => [l.lead_id, l]));
      const results = [];
      let stop = '';
      for (const it of items) {
        const l: any = byId.get(String(it.lead_id));
        if (stop) { results.push({ lead_id: it.lead_id, ok: false, error: stop }); continue; }
        if (!l || !ok.has(l.lead_id)) { results.push({ lead_id: it.lead_id, ok: false, error: 'Lead not found' }); continue; }
        if (l.wa_opt_out) { results.push({ lead_id: it.lead_id, ok: false, skipped: true, error: 'Opted out (said STOP)' }); continue; }
        const to = cleanPhone(l.phone);
        if (!/^\d{8,15}$/.test(to)) { results.push({ lead_id: it.lead_id, ok: false, error: 'No valid phone' }); continue; }
        const r = await graphSend(acc, templatePayload(to, String(b.template), String(b.language || 'en'), it.params ?? []));
        if (!r.ok) { if (['190', '131042', '132001', '131048'].includes(r.code)) stop = r.error; results.push({ lead_id: it.lead_id, ok: false, error: r.error, code: r.code }); continue; }
        const text = String(it.preview || `Template: ${b.template}`);
        await logSent(ws, l.lead_id, to, 'template', text, r.id, by, b.broadcast_id ? String(b.broadcast_id) : null, `Broadcast: ${text}`, sentBy);
        results.push({ lead_id: it.lead_id, ok: true, id: r.id });
      }
      return json({ ok: true, results, stopped: stop || null });
    }

    // ---- Single message ----
    if (!perm('whatsapp')) return json({ error: 'Your access does not include WhatsApp chats — ask the owner.' }, 403);
    let leadId: string | null = b.lead_id ? String(b.lead_id) : null, to = cleanPhone(b.phone);
    if (leadId && !(await visible([leadId])).has(leadId)) return json({ error: 'Lead not found' }, 404);
    if (!leadId && !full) return json({ error: 'Pick a lead from your area to message.' }, 403);
    if (leadId) { const { data: l } = await db.from('leads').select('phone').eq('workspace_id', ws).eq('lead_id', leadId).maybeSingle(); if (!l) return json({ error: 'Lead not found' }, 404); to = cleanPhone(l.phone); }
    if (!/^\d{8,15}$/.test(to)) return json({ error: 'This lead has no valid phone number.' }, 400);

    let payload: unknown, logText: string, type: string;
    if (b.template) {
      payload = templatePayload(to, String(b.template), String(b.language || 'en'), Array.isArray(b.params) ? b.params : []);
      logText = String(b.preview || `Template: ${b.template}`); type = 'template';
    } else {
      const text = String(b.text ?? '').trim(); if (!text) return json({ error: 'Type a message' }, 400);
      payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4096), preview_url: true } };
      logText = text; type = 'text';
    }
    const r = await graphSend(acc, payload);
    if (!r.ok) return json({ error: r.error, code: r.code }, 400);
    if (!leadId) { const { data: l } = await db.from('leads').select('lead_id').eq('workspace_id', ws).eq('phone', to).limit(1).maybeSingle(); leadId = l?.lead_id ?? null; }
    await logSent(ws, leadId, to, type, logText, r.id, by, null, logText, sentBy);
    return json({ ok: true, id: r.id, lead_id: leadId });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
